from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from finance_app.db import Database
from modern_app.cloud_backend.app.auth import create_access_token, decode_access_token
from modern_app.cloud_backend.app import db as cloud_db
from modern_app.cloud_backend.app import main as cloud_main
from modern_app.cloud_backend.app.device_verification import (
    DEVICE_PROOF_LENGTH,
    DeviceProofFields,
    DeviceProofPurpose,
    DeviceVerificationMode,
    base64url_decode,
    base64url_encode,
    build_device_proof_message,
    parse_device_proof_message,
    parse_device_verification_mode,
    verify_device_proof,
)


ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = ROOT / "docs" / "device-verification" / "v1" / "fixtures" / "ed25519-proof-v1.json"


def _fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _fields_for_vector(data: dict, vector: dict) -> DeviceProofFields:
    common = data["common"]
    return DeviceProofFields(
        purpose=DeviceProofPurpose(vector["purpose"]),
        account_binding=bytes.fromhex(common["account_binding_hex"]),
        device_id=bytes.fromhex(common["device_id_hex"]),
        public_key_hash=bytes.fromhex(data["test_key"]["public_key_hash_hex"]),
        challenge_id=bytes.fromhex(common["challenge_id_hex"]),
        nonce=bytes.fromhex(common["nonce_hex"]),
        issued_at=common["issued_at"],
        expires_at=common["expires_at"],
        family_id=bytes.fromhex(common["family_id_hex"]) if vector["family_present"] else None,
        target_device_id=bytes.fromhex(common["target_device_id_hex"]) if vector["target_present"] else None,
        request_hash=bytes.fromhex(common["rename_request_hash_hex"]) if vector["request_hash_present"] else None,
    )


class DeviceProofFixtureTests(unittest.TestCase):
    def test_all_frozen_vectors_reconstruct_and_verify(self) -> None:
        data = _fixture()
        public_key = bytes.fromhex(data["test_key"]["public_key_hex"])
        private_key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(data["test_key"]["private_key_seed_hex"]))
        for vector in data["vectors"]:
            with self.subTest(vector=vector["name"]):
                message = build_device_proof_message(_fields_for_vector(data, vector))
                signature = bytes.fromhex(vector["signature_hex"])
                self.assertEqual(len(message), DEVICE_PROOF_LENGTH)
                self.assertEqual(message.hex(), vector["canonical_message_hex"])
                self.assertEqual(private_key.sign(message), signature)
                self.assertTrue(verify_device_proof(public_key, signature, message))
                self.assertEqual(parse_device_proof_message(message), _fields_for_vector(data, vector))

    def test_cross_account_cross_purpose_and_structural_mutations_fail(self) -> None:
        data = _fixture()
        public_key = bytes.fromhex(data["test_key"]["public_key_hex"])
        vector = data["vectors"][0]
        signature = bytes.fromhex(vector["signature_hex"])
        message = bytearray.fromhex(vector["canonical_message_hex"])
        for offset in (25, 26, 58, 74, 106, 122, 154, 162):
            with self.subTest(offset=offset):
                mutated = message.copy()
                mutated[offset] ^= 1
                try:
                    accepted = verify_device_proof(public_key, signature, bytes(mutated))
                except ValueError:
                    accepted = False
                self.assertFalse(accepted)

        invalid_slot = message.copy()
        invalid_slot[171] = 1
        with self.assertRaises(ValueError):
            parse_device_proof_message(bytes(invalid_slot))

    def test_base64url_is_canonical_and_unpadded(self) -> None:
        raw = bytes(range(32))
        encoded = base64url_encode(raw)
        self.assertNotIn("=", encoded)
        self.assertEqual(base64url_decode(encoded, expected_length=32), raw)
        for invalid in (encoded + "=", encoded + "+", "", "abc"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    base64url_decode(invalid, expected_length=32)

    def test_invalid_purpose_combinations_and_ttl_are_rejected(self) -> None:
        data = _fixture()
        vector = data["vectors"][0]
        fields = _fields_for_vector(data, vector)
        with self.assertRaises(ValueError):
            build_device_proof_message(
                DeviceProofFields(**{**fields.__dict__, "family_id": bytes.fromhex(data["common"]["family_id_hex"])})
            )
        with self.assertRaises(ValueError):
            build_device_proof_message(DeviceProofFields(**{**fields.__dict__, "expires_at": fields.issued_at + 121}))


class DeviceVerificationModeTests(unittest.TestCase):
    def test_mode_defaults_to_off(self) -> None:
        self.assertEqual(parse_device_verification_mode(None), DeviceVerificationMode.OFF)
        self.assertEqual(parse_device_verification_mode(""), DeviceVerificationMode.OFF)
        self.assertEqual(parse_device_verification_mode("off"), DeviceVerificationMode.OFF)

    def test_unimplemented_modes_abort_with_stable_code(self) -> None:
        for mode in ("observe", "enforce"):
            with self.subTest(mode=mode):
                with self.assertRaisesRegex(RuntimeError, "^device_mode_not_implemented$"):
                    parse_device_verification_mode(mode)

    def test_invalid_explicit_mode_fails_with_stable_code(self) -> None:
        for mode in ("enabled", "true", "0", "OFF", "Observe", "Enforce", " off "):
            with self.subTest(mode=mode):
                with self.assertRaisesRegex(RuntimeError, "^invalid_device_verification_mode$"):
                    parse_device_verification_mode(mode)

    def test_real_asgi_startup_rejects_unimplemented_modes(self) -> None:
        for mode in ("observe", "enforce"):
            with self.subTest(mode=mode), patch.dict(
                os.environ,
                {"SCISONOMICS_DEVICE_VERIFICATION_MODE": mode},
                clear=False,
            ):
                with self.assertRaisesRegex(RuntimeError, "^device_mode_not_implemented$"):
                    with TestClient(cloud_main.app):
                        pass

    def test_current_access_tokens_remain_without_device_claims(self) -> None:
        old_secret = os.environ.get("SCISONOMICS_JWT_SECRET")
        os.environ["SCISONOMICS_JWT_SECRET"] = "phase1-test-secret-with-at-least-32-characters"
        try:
            payload = decode_access_token(create_access_token("phase1-user"))
        finally:
            if old_secret is None:
                os.environ.pop("SCISONOMICS_JWT_SECRET", None)
            else:
                os.environ["SCISONOMICS_JWT_SECRET"] = old_secret
        self.assertNotIn("tdi", payload)
        self.assertNotIn("fid", payload)

    def test_production_migration_failure_aborts_and_health_is_not_ok(self) -> None:
        previous_state = dict(cloud_main._CLOUD_DB_STATE)
        try:
            with (
                patch.dict(os.environ, {"SCISONOMICS_ENV": "production"}, clear=False),
                patch.object(cloud_main, "init_db", side_effect=RuntimeError("injected")),
            ):
                with self.assertRaisesRegex(RuntimeError, "^db_migration_failed$"):
                    cloud_main._refresh_cloud_db_state(run_init=True)
            response = cloud_main.health()
            self.assertEqual(response.status_code, 503)
            self.assertIn(b'"ok":false', response.body)
        finally:
            cloud_main._CLOUD_DB_STATE = previous_state


class AdditiveMigrationIntegrityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="scisonomics-device-v1-")
        self.db_path = Path(self.tempdir.name) / "synthetic-cloud.db"
        self.old_url = os.environ.get("SCISONOMICS_CLOUD_DATABASE_URL")
        os.environ["SCISONOMICS_CLOUD_DATABASE_URL"] = f"sqlite:///{self.db_path.as_posix()}"

    def tearDown(self) -> None:
        if self.old_url is None:
            os.environ.pop("SCISONOMICS_CLOUD_DATABASE_URL", None)
        else:
            os.environ["SCISONOMICS_CLOUD_DATABASE_URL"] = self.old_url
        self.tempdir.cleanup()

    def _prepare_pre_phase1_database(self) -> tuple[str, dict[str, list[tuple]]]:
        with patch.object(cloud_db, "_ensure_device_verification_schema", lambda _conn: None):
            cloud_db.init_db()
        user_id = str(uuid4())
        stamp = "2026-01-01T00:00:00+00:00"
        with cloud_db.connect() as conn:
            conn.execute(
                "INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (user_id, "synthetic@example.com", "test-only-hash", "Synthetic", stamp, stamp),
            )
            conn.execute(
                "INSERT INTO cloud_categorias (user_id, sync_id, nombre, tipo, remote_updated_at) VALUES (?, 'cat-1', 'Comida', 'gasto', ?)",
                (user_id, stamp),
            )
            conn.execute(
                "INSERT INTO cloud_movimientos (user_id, sync_id, tipo, monto, descripcion, fecha, remote_updated_at) VALUES (?, 'mov-1', 'gasto', 1234.56, 'Synthetic', '2026-01-01', ?)",
                (user_id, stamp),
            )
            conn.execute(
                "INSERT INTO cloud_metas_ahorro (user_id, sync_id, nombre, monto_objetivo, monto_inicial, remote_updated_at) VALUES (?, 'meta-1', 'Meta', 9000, 1000, ?)",
                (user_id, stamp),
            )
            conn.execute(
                "INSERT INTO cloud_gastos_programados (user_id, sync_id, descripcion, monto_estimado, remote_updated_at) VALUES (?, 'gp-1', 'Programado', 88.5, ?)",
                (user_id, stamp),
            )
            conn.execute(
                "INSERT INTO cloud_gastos_fijos (user_id, sync_id, descripcion, monto, remote_updated_at) VALUES (?, 'gf-1', 'Fijo', 77.25, ?)",
                (user_id, stamp),
            )
            conn.execute(
                "INSERT INTO cloud_presupuestos (user_id, sync_id, mes, anio, monto, remote_updated_at) VALUES (?, 'pre-1', 1, 2026, 5000, ?)",
                (user_id, stamp),
            )
            conn.execute(
                "INSERT INTO cloud_tags (user_id, sync_id, nombre, remote_updated_at) VALUES (?, 'tag-1', 'Test', ?)",
                (user_id, stamp),
            )
            conn.execute(
                "INSERT INTO cloud_movimiento_tags (user_id, sync_id, movimiento_sync_id, tag_sync_id, remote_updated_at) VALUES (?, 'mt-1', 'mov-1', 'tag-1', ?)",
                (user_id, stamp),
            )
            conn.execute(
                "INSERT INTO cloud_devices (user_id, device_id, device_name, created_at, updated_at, last_seen_at) VALUES (?, 'legacy-sync-device', 'Legacy', ?, ?, ?)",
                (user_id, stamp, stamp, stamp),
            )
            conn.execute(
                "INSERT INTO cloud_refresh_tokens (id, user_id, token_hash, created_at, expires_at, family_id) VALUES ('legacy-token', ?, 'legacy-hash', ?, ?, 'legacy-family')",
                (user_id, stamp, "2027-01-01T00:00:00+00:00"),
            )
        return user_id, self._financial_snapshot()

    def _financial_snapshot(self) -> dict[str, list[tuple]]:
        result: dict[str, list[tuple]] = {}
        with closing(sqlite3.connect(self.db_path)) as conn:
            for table in cloud_db.SYNC_CLOUD_TABLES:
                columns = [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]
                rows = conn.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
                result[table] = [tuple(row) for row in rows]
                self.assertIn("user_id", columns)
        return result

    def test_migration_is_idempotent_additive_and_preserves_financial_data(self) -> None:
        user_id, before = self._prepare_pre_phase1_database()
        cloud_db.init_db()
        first_namespace: str
        with cloud_db.connect() as conn:
            user = conn.execute("SELECT id, device_key_namespace FROM users WHERE id = ?", (user_id,)).fetchone()
            first_namespace = str(user["device_key_namespace"])
            legacy = conn.execute(
                "SELECT family_id, refresh_token_family_id, trusted_device_id FROM cloud_refresh_tokens WHERE id = 'legacy-token'"
            ).fetchone()
            self.assertEqual(legacy["family_id"], "legacy-family")
            self.assertIsNone(legacy["refresh_token_family_id"])
            self.assertIsNone(legacy["trusted_device_id"])
            for table in (
                "trusted_devices",
                "refresh_token_families",
                "device_verification_challenges",
                "device_proof_challenges",
            ):
                with self.subTest(table=table):
                    self.assertEqual(conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"], 0)
        self.assertEqual(before, self._financial_snapshot())
        self.assertTrue(first_namespace)

        cloud_db.init_db()
        with cloud_db.connect() as conn:
            namespace = conn.execute("SELECT device_key_namespace FROM users WHERE id = ?", (user_id,)).fetchone()[0]
            self.assertEqual(namespace, first_namespace)
            tables = {
                row[0]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
            }
            self.assertTrue(
                {"trusted_devices", "device_verification_challenges", "device_proof_challenges", "refresh_token_families"}.issubset(tables)
            )
        self.assertEqual(before, self._financial_snapshot())

    def test_empty_wip_v1_schema_is_repaired_idempotently_without_losing_legacy_tokens(self) -> None:
        user_id, _ = self._prepare_pre_phase1_database()
        with cloud_db.connect() as conn:
            conn.execute(
                """CREATE TABLE trusted_devices (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
                    public_key BLOB NOT NULL, public_key_hash BLOB NOT NULL, status TEXT NOT NULL,
                    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    UNIQUE(user_id, device_id))"""
            )
            conn.execute(
                """CREATE TABLE refresh_token_families (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, trusted_device_id TEXT NOT NULL,
                    created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
                    FOREIGN KEY (trusted_device_id) REFERENCES trusted_devices(id))"""
            )
            conn.execute(
                """CREATE TABLE device_proof_challenges (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, trusted_device_id TEXT,
                    account_binding_hash BLOB NOT NULL, device_id TEXT NOT NULL,
                    public_key_hash BLOB NOT NULL, purpose TEXT NOT NULL, nonce_hash BLOB NOT NULL,
                    issued_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
                    refresh_family_id TEXT, target_device_id TEXT, created_at TEXT NOT NULL,
                    FOREIGN KEY (trusted_device_id) REFERENCES trusted_devices(id),
                    FOREIGN KEY (refresh_family_id) REFERENCES refresh_token_families(id),
                    FOREIGN KEY (user_id, target_device_id) REFERENCES trusted_devices(user_id, device_id))"""
            )
            cloud_db._ensure_column(
                conn,
                "cloud_refresh_tokens",
                "refresh_token_family_id",
                "TEXT REFERENCES refresh_token_families(id)",
            )
            cloud_db._ensure_column(
                conn,
                "cloud_refresh_tokens",
                "trusted_device_id",
                "TEXT REFERENCES trusted_devices(id)",
            )

        cloud_db.init_db()
        cloud_db.init_db()
        with cloud_db.connect() as conn:
            self.assertEqual(
                conn.execute(
                    "SELECT user_id, family_id, refresh_token_family_id, trusted_device_id "
                    "FROM cloud_refresh_tokens WHERE id = 'legacy-token'"
                ).fetchone()["user_id"],
                user_id,
            )
            self.assertEqual(
                conn.execute("SELECT COUNT(*) AS count FROM trusted_devices").fetchone()["count"],
                0,
            )
            proof_fks = cloud_db._sqlite_foreign_keys(conn, "device_proof_challenges")
            token_fks = cloud_db._sqlite_foreign_keys(conn, "cloud_refresh_tokens")
            self.assertIn(
                (("user_id", "refresh_family_id"), "refresh_token_families", ("user_id", "id")),
                proof_fks,
            )
            self.assertIn(
                (("user_id", "trusted_device_id"), "trusted_devices", ("user_id", "id")),
                token_fks,
            )

    def test_rolling_legacy_insert_is_repaired_on_next_startup(self) -> None:
        user_id, before = self._prepare_pre_phase1_database()
        cloud_db.init_db()
        legacy_user_id = str(uuid4())
        stamp = "2026-01-02T00:00:00+00:00"
        with cloud_db.connect() as conn:
            conn.execute(
                "INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (legacy_user_id, "rolling-legacy@example.com", "legacy-hash", "Rolling legacy", stamp, stamp),
            )
            self.assertEqual(cloud_db.missing_device_key_namespace_count(conn), 1)

        cloud_db.init_db()
        with cloud_db.connect() as conn:
            repaired = conn.execute(
                "SELECT id, device_key_namespace FROM users WHERE id = ?",
                (legacy_user_id,),
            ).fetchone()
            original = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
            self.assertEqual(repaired["id"], legacy_user_id)
            self.assertTrue(repaired["device_key_namespace"])
            self.assertEqual(original["id"], user_id)
            self.assertEqual(cloud_db.missing_device_key_namespace_count(conn), 0)
        self.assertEqual(before, self._financial_snapshot())

    def test_constraints_and_atomic_future_consumption(self) -> None:
        user_id, _ = self._prepare_pre_phase1_database()
        cloud_db.init_db()
        stamp = "2026-01-01T00:00:00+00:00"
        with cloud_db.connect() as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            device_id = str(uuid4())
            conn.execute(
                """INSERT INTO trusted_devices
                   (id, user_id, device_id, public_key, public_key_hash, status, first_seen_at, last_seen_at, created_at, updated_at)
                   VALUES ('td-1', ?, ?, ?, ?, 'trusted', ?, ?, ?, ?)""",
                (user_id, device_id, bytes(32), bytes([1]) * 32, stamp, stamp, stamp, stamp),
            )
            other_user_id = str(uuid4())
            conn.execute(
                "INSERT INTO users (id, email, password_hash, display_name, device_key_namespace, created_at, updated_at) "
                "VALUES (?, 'target-other@example.com', 'hash', 'Other', ?, ?, ?)",
                (other_user_id, "other-namespace", stamp, stamp),
            )
            other_public_device_id = str(uuid4())
            conn.execute(
                """INSERT INTO trusted_devices
                   (id, user_id, device_id, public_key, public_key_hash, status, first_seen_at, last_seen_at, created_at, updated_at)
                   VALUES ('td-other-internal', ?, ?, ?, ?, 'trusted', ?, ?, ?, ?)""",
                (other_user_id, other_public_device_id, bytes([3]) * 32, bytes([4]) * 32, stamp, stamp, stamp, stamp),
            )
            conn.execute(
                "INSERT INTO refresh_token_families (id, user_id, trusted_device_id, created_at, expires_at) "
                "VALUES ('family-1', ?, 'td-1', ?, ?)",
                (user_id, stamp, stamp),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO refresh_token_families (id, user_id, trusted_device_id, created_at, expires_at) "
                    "VALUES ('cross-user-family', ?, 'td-other-internal', ?, ?)",
                    (user_id, stamp, stamp),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """INSERT INTO trusted_devices
                       (id, user_id, device_id, public_key, public_key_hash, status, first_seen_at, last_seen_at, created_at, updated_at)
                       VALUES ('td-2', ?, ?, ?, ?, 'trusted', ?, ?, ?, ?)""",
                    (user_id, str(uuid4()), bytes([2]) * 32, bytes([1]) * 32, stamp, stamp, stamp, stamp),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO refresh_token_families (id, user_id, trusted_device_id, created_at, expires_at) VALUES ('bad-family', ?, NULL, ?, ?)",
                    (user_id, stamp, stamp),
                )
            conn.execute(
                """INSERT INTO device_proof_challenges
                   (id, user_id, account_binding_hash, device_id, public_key_hash, purpose, nonce_hash,
                    issued_at, expires_at, target_device_id, created_at)
                   VALUES ('proof-valid-target', ?, ?, ?, ?, 'device_revoke', ?, ?, ?, ?, ?)""",
                (user_id, bytes([5]) * 32, device_id, bytes([1]) * 32, bytes([6]) * 32, 1767225600, 1767225660, device_id, stamp),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """INSERT INTO device_proof_challenges
                       (id, user_id, account_binding_hash, device_id, public_key_hash, purpose, nonce_hash,
                        issued_at, expires_at, target_device_id, created_at)
                       VALUES ('proof-internal-target', ?, ?, ?, ?, 'device_revoke', ?, ?, ?, 'td-1', ?)""",
                    (user_id, bytes([7]) * 32, device_id, bytes([1]) * 32, bytes([8]) * 32, 1767225600, 1767225660, stamp),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """INSERT INTO device_proof_challenges
                       (id, user_id, account_binding_hash, device_id, public_key_hash, purpose, nonce_hash,
                        issued_at, expires_at, target_device_id, created_at)
                       VALUES ('proof-cross-user-target', ?, ?, ?, ?, 'device_revoke', ?, ?, ?, ?, ?)""",
                    (user_id, bytes([9]) * 32, device_id, bytes([1]) * 32, bytes([10]) * 32, 1767225600, 1767225660, other_public_device_id, stamp),
                )
            for column, value in (
                ("trusted_device_id", "td-other-internal"),
                ("refresh_family_id", "family-other"),
            ):
                if column == "refresh_family_id":
                    conn.execute(
                        "INSERT INTO refresh_token_families (id, user_id, trusted_device_id, created_at, expires_at) "
                        "VALUES ('family-other', ?, 'td-other-internal', ?, ?)",
                        (other_user_id, stamp, stamp),
                    )
                with self.subTest(column=column), self.assertRaises(sqlite3.IntegrityError):
                    conn.execute(
                        f"""INSERT INTO device_proof_challenges
                           (id, user_id, trusted_device_id, account_binding_hash, device_id, public_key_hash,
                            purpose, nonce_hash, issued_at, expires_at, refresh_family_id, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, 'refresh', ?, ?, ?, ?, ?)""",
                        (
                            f"cross-user-{column}", user_id,
                            value if column == "trusted_device_id" else "td-1",
                            bytes([11]) * 32, device_id, bytes([1]) * 32, bytes([12]) * 32,
                            1767225600, 1767225660,
                            value if column == "refresh_family_id" else "family-1", stamp,
                        ),
                    )
            for column, value in (
                ("trusted_device_id", "td-other-internal"),
                ("refresh_token_family_id", "family-other"),
            ):
                with self.subTest(cloud_refresh_column=column), self.assertRaises(sqlite3.IntegrityError):
                    conn.execute(
                        f"UPDATE cloud_refresh_tokens SET {column} = ? WHERE id = 'legacy-token'",
                        (value,),
                    )
            conn.execute(
                """INSERT INTO device_proof_challenges
                   (id, user_id, account_binding_hash, device_id, public_key_hash, purpose, nonce_hash, issued_at, expires_at, created_at)
                   VALUES ('proof-1', ?, ?, ?, ?, 'device_enrollment', ?, ?, ?, ?)""",
                (user_id, bytes(32), device_id, bytes([1]) * 32, hashlib.sha256(b"nonce").digest(), 1767225600, 1767225720, stamp),
            )
            first_cursor = conn.execute(
                "UPDATE device_proof_challenges SET consumed_at = ? WHERE id = 'proof-1' AND consumed_at IS NULL",
                (stamp,),
            )
            first_rowcount = first_cursor.rowcount
            first_cursor.close()
            second_cursor = conn.execute(
                "UPDATE device_proof_challenges SET consumed_at = ? WHERE id = 'proof-1' AND consumed_at IS NULL",
                (stamp,),
            )
            second_rowcount = second_cursor.rowcount
            second_cursor.close()
            self.assertEqual(first_rowcount, 1)
            self.assertEqual(second_rowcount, 0)

    def test_synthetic_offline_database_owner_and_finances_are_unchanged(self) -> None:
        local_path = Path(self.tempdir.name) / "synthetic-offline.db"
        local_db = Database(local_path)
        local_db.init_db()
        with local_db.connect() as conn:
            cursor = conn.execute(
                "INSERT INTO categorias (nombre, tipo, owner_user_id) VALUES ('Synthetic Device V1', 'gasto', 'real-owner-synthetic')"
            )
            category_id = cursor.lastrowid
            conn.execute(
                """INSERT INTO movimientos (fecha, tipo, categoria_id, descripcion, monto, owner_user_id)
                   VALUES ('2026-01-01', 'gasto', ?, 'Integrity sentinel', 4321.09, 'real-owner-synthetic')""",
                (category_id,),
            )
        with local_db.connect() as conn:
            before = [tuple(row) for row in conn.execute(
                "SELECT id, fecha, tipo, categoria_id, descripcion, monto, owner_user_id FROM movimientos WHERE owner_user_id = 'real-owner-synthetic' ORDER BY id"
            ).fetchall()]

        cloud_db.init_db()
        Database(local_path).init_db()

        with local_db.connect() as conn:
            after = [tuple(row) for row in conn.execute(
                "SELECT id, fecha, tipo, categoria_id, descripcion, monto, owner_user_id FROM movimientos WHERE owner_user_id = 'real-owner-synthetic' ORDER BY id"
            ).fetchall()]
            self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(after, before)

    def test_postgresql_branch_uses_bytea_and_additive_nullable_references(self) -> None:
        class Result:
            def __init__(self, *, row=None, rows=None):
                self._row = row
                self._rows = rows or []

            def fetchone(self):
                return self._row

            def fetchall(self):
                return self._rows

        class RecordingPostgresConnection:
            engine = "postgresql"

            def __init__(self):
                self.statements: list[str] = []

            def execute(self, sql, _params=()):
                normalized = " ".join(sql.split())
                self.statements.append(normalized)
                if "SELECT id FROM users" in normalized:
                    return Result(rows=[])
                if "missing_namespace_count" in normalized:
                    return Result(row={"missing_namespace_count": 0})
                return Result(row=None)

        conn = RecordingPostgresConnection()
        cloud_db._ensure_device_verification_schema(conn)  # type: ignore[arg-type]
        ddl = "\n".join(conn.statements)
        self.assertIn("public_key BYTEA NOT NULL", ddl)
        self.assertNotIn(" BLOB", ddl)
        self.assertIn("ADD COLUMN refresh_token_family_id TEXT", ddl)
        self.assertIn("ADD COLUMN trusted_device_id TEXT", ddl)
        self.assertIn("WHERE table_schema = current_schema()", ddl)
        self.assertIn(
            "FOREIGN KEY (user_id, refresh_family_id) REFERENCES refresh_token_families(user_id, id)",
            ddl,
        )
        self.assertIn(
            "FOREIGN KEY (user_id, trusted_device_id) REFERENCES trusted_devices(user_id, id)",
            ddl,
        )
        self.assertIn(
            "FOREIGN KEY (user_id, refresh_token_family_id) REFERENCES refresh_token_families(user_id, id)",
            ddl,
        )
        self.assertIn(
            "FOREIGN KEY (user_id, target_device_id) REFERENCES trusted_devices(user_id, device_id)",
            ddl,
        )

    def _prepare_namespace_backfill(self, namespaces: list[str | None]) -> list[str]:
        with patch.object(cloud_db, "_ensure_device_verification_schema", lambda _conn: None):
            cloud_db.init_db()
        user_ids: list[str] = []
        stamp = "2026-01-01T00:00:00+00:00"
        with cloud_db.connect() as conn:
            cloud_db._ensure_column(conn, "users", "device_key_namespace", "TEXT")
            for index, namespace in enumerate(namespaces):
                user_id = str(uuid4())
                user_ids.append(user_id)
                conn.execute(
                    "INSERT INTO users (id, email, password_hash, display_name, device_key_namespace, created_at, updated_at) "
                    "VALUES (?, ?, 'hash', 'Namespace test', ?, ?, ?)",
                    (user_id, f"namespace-{index}@example.com", namespace, stamp, stamp),
                )
        return user_ids

    def test_namespace_backfill_retries_collision_within_same_batch_before_index(self) -> None:
        user_ids = self._prepare_namespace_backfill([None, None])
        with cloud_db.connect() as conn, patch.object(
            cloud_db.secrets,
            "token_urlsafe",
            side_effect=["same", "same", "second"],
        ):
            cloud_db._assign_missing_device_key_namespaces(conn)
            rows = conn.execute(
                "SELECT id, device_key_namespace FROM users ORDER BY email"
            ).fetchall()
            self.assertEqual({row["device_key_namespace"] for row in rows}, {"same", "second"})
            self.assertEqual({row["id"] for row in rows}, set(user_ids))

    def test_namespace_backfill_retries_existing_value_and_is_idempotent(self) -> None:
        self._prepare_namespace_backfill(["existing", None])
        with cloud_db.connect() as conn, patch.object(
            cloud_db.secrets,
            "token_urlsafe",
            side_effect=["existing", "new-value"],
        ) as generator:
            cloud_db._assign_missing_device_key_namespaces(conn)
            cloud_db._assign_missing_device_key_namespaces(conn)
            self.assertEqual(generator.call_count, 2)
            self.assertEqual(cloud_db.missing_device_key_namespace_count(conn), 0)

    def test_namespace_backfill_succeeds_on_last_allowed_retry(self) -> None:
        self._prepare_namespace_backfill(["taken", None])
        with cloud_db.connect() as conn, patch.object(
            cloud_db.secrets,
            "token_urlsafe",
            side_effect=["taken"] * 5 + ["last-allowed"],
        ) as generator:
            cloud_db._assign_missing_device_key_namespaces(conn)
            self.assertEqual(generator.call_count, 6)
            repaired = conn.execute(
                "SELECT device_key_namespace FROM users WHERE device_key_namespace <> 'taken'"
            ).fetchone()[0]
            self.assertEqual(repaired, "last-allowed")

    def test_namespace_backfill_fails_stably_after_six_collisions(self) -> None:
        self._prepare_namespace_backfill(["taken", None])
        with cloud_db.connect() as conn, patch.object(
            cloud_db.secrets,
            "token_urlsafe",
            side_effect=["taken"] * 6,
        ) as generator:
            with self.assertRaisesRegex(RuntimeError, "^device_key_namespace_retry_exhausted$"):
                cloud_db._assign_missing_device_key_namespaces(conn)
            self.assertEqual(generator.call_count, 6)

    def test_all_zero_account_binding_is_rejected(self) -> None:
        data = _fixture()
        fields = _fields_for_vector(data, data["vectors"][0])
        with self.assertRaisesRegex(ValueError, "account_binding no puede ser cero"):
            build_device_proof_message(DeviceProofFields(**{**fields.__dict__, "account_binding": bytes(32)}))


class OffModeRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="scisonomics-device-off-")
        self.db_path = Path(self.tempdir.name) / "cloud.db"
        self.env = patch.dict(
            os.environ,
            {
                "SCISONOMICS_ENV": "development",
                "SCISONOMICS_JWT_SECRET": "device-off-regression-secret-at-least-32-characters",
                "SCISONOMICS_CLOUD_DATABASE_URL": f"sqlite:///{self.db_path.as_posix()}",
                "SCISONOMICS_DEVICE_VERIFICATION_MODE": "off",
                "SCISONOMICS_EMAIL_PROVIDER": "memory",
                "SCISONOMICS_CHECK_BREACHED_PASSWORDS": "false",
                "SCISONOMICS_GOOGLE_CLIENT_ID": "google-client-test",
                "SCISONOMICS_GOOGLE_CLIENT_SECRET": "google-secret-test",
                "SCISONOMICS_GOOGLE_REDIRECT_URI": "http://127.0.0.1/google/callback",
            },
            clear=False,
        )
        self.env.start()
        cloud_main._DEV_EMAIL_OUTBOX.clear()

    def tearDown(self) -> None:
        cloud_main._DEV_EMAIL_OUTBOX.clear()
        self.env.stop()
        self.tempdir.cleanup()

    def test_real_asgi_startup_and_legacy_auth_refresh_sync_and_google_remain_operational(self) -> None:
        email = f"device-off-{uuid4().hex}@example.test"
        password = "correct horse battery staple"
        with TestClient(cloud_main.app) as client:
            health = client.get("/health")
            self.assertEqual(health.status_code, 200, health.text)
            self.assertTrue(health.json()["ok"])

            registered = client.post(
                "/auth/register",
                json={"email": email, "password": password, "display_name": "Device Off"},
            )
            self.assertEqual(registered.status_code, 200, registered.text)
            verification_token = registered.json()["verification_token"]

            unverified_login = client.post(
                "/auth/login", json={"email": email, "password": password}
            )
            self.assertEqual(unverified_login.status_code, 200, unverified_login.text)
            self.assertIn("verification_token", unverified_login.json())

            code = cloud_main._DEV_EMAIL_OUTBOX[-1]["code"]
            verified = client.post(
                "/auth/verify-email",
                json={"verification_token": verification_token, "code": code},
                headers={"X-Scisonomics-Device-Id": "legacy-device"},
            )
            self.assertEqual(verified.status_code, 200, verified.text)
            auth = verified.json()

            login = client.post("/auth/login", json={"email": email, "password": password})
            self.assertEqual(login.status_code, 200, login.text)
            self.assertIn("access_token", login.json())

            refreshed = client.post(
                "/auth/refresh", json={"refresh_token": auth["refresh_token"]}
            )
            self.assertEqual(refreshed.status_code, 200, refreshed.text)
            access_token = refreshed.json()["access_token"]
            authorization = {"Authorization": f"Bearer {access_token}"}

            sync_payload = {table: [] for table in cloud_main.SYNC_TABLES}
            sync_payload.update(
                {
                    "device_id": "legacy-device",
                    "device_name": "Legacy Off",
                    "categorias": [
                        {"sync_id": "category-off", "nombre": "Off", "tipo": "gasto"}
                    ],
                }
            )
            pushed = client.post("/sync/push", json=sync_payload, headers=authorization)
            self.assertEqual(pushed.status_code, 200, pushed.text)
            self.assertEqual(pushed.json()["accepted"]["categorias"], ["category-off"])
            pulled = client.get("/sync/pull", headers=authorization)
            self.assertEqual(pulled.status_code, 200, pulled.text)
            self.assertEqual(pulled.json()["categorias"][0]["sync_id"], "category-off")

            google_start = client.post("/auth/google/start")
            self.assertEqual(google_start.status_code, 200, google_start.text)
            login_request_id = google_start.json()["login_request_id"]
            with patch.object(
                cloud_main,
                "_exchange_google_code",
                return_value={
                    "sub": f"google-{uuid4().hex}",
                    "email": f"google-{uuid4().hex}@example.test",
                    "name": "Google Off",
                    "email_verified": True,
                },
            ):
                callback = client.get(
                    "/auth/google/callback",
                    params={"code": "test-code", "state": login_request_id},
                )
            self.assertEqual(callback.status_code, 200, callback.text)
            google_status = client.get(f"/auth/google/status/{login_request_id}")
            self.assertEqual(google_status.status_code, 200, google_status.text)
            self.assertEqual(google_status.json()["status"], "completed")
            self.assertIn("access_token", google_status.json())


if __name__ == "__main__":
    unittest.main()
