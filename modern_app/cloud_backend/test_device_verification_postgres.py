from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import sys
import time
import unittest
from contextlib import contextmanager
from unittest.mock import patch
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

import psycopg

from modern_app.cloud_backend.app import db as cloud_db


POSTGRES_TEST_URL_ENV = "SCISONOMICS_TEST_POSTGRES_URL"
POSTGRES_TEST_DESTRUCTIVE_ENV = "SCISONOMICS_DEVICE_TEST_DESTRUCTIVE_OK"
POSTGRES_TEST_DESTRUCTIVE_VALUE = "YES_DROP_EPHEMERAL_DEVICE_TEST_SCHEMAS"
POSTGRES_TEST_MARKER_ENV = "SCISONOMICS_DEVICE_TEST_EPHEMERAL_MARKER"
POSTGRES_TEST_DATABASE_PREFIX = "scisonomics_device_verification_test"
POSTGRES_TEST_MARKER_TABLE = "public.scisonomics_ephemeral_test_marker"
POSTGRES_TEST_MARKER_PURPOSE = "device_verification_phase1"
_MARKER_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_REJECTED_TARGET_TOKENS = ("railway", "rlwy", "production", "prod-db", "render.com", "neon.tech", "supabase")


def _schema_url(base_url: str, schema: str) -> str:
    parsed = urlsplit(base_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["options"] = f"-csearch_path={schema}"
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))


def _validate_ephemeral_postgres_target(database_url: str) -> str:
    if os.getenv(POSTGRES_TEST_DESTRUCTIVE_ENV, "") != POSTGRES_TEST_DESTRUCTIVE_VALUE:
        raise RuntimeError("postgres_test_destructive_acceptance_missing")
    marker = os.getenv(POSTGRES_TEST_MARKER_ENV, "").strip()
    if not _MARKER_RE.fullmatch(marker):
        raise RuntimeError("postgres_test_ephemeral_marker_invalid")
    try:
        parsed = urlsplit(database_url)
        host = (parsed.hostname or "").lower()
    except ValueError:
        raise RuntimeError("postgres_test_target_invalid") from None
    lowered_url = database_url.lower()
    if parsed.scheme not in {"postgresql", "postgres"}:
        raise RuntimeError("postgres_test_target_invalid")
    if host not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("postgres_test_target_not_local")
    if any(token in lowered_url for token in _REJECTED_TARGET_TOKENS):
        raise RuntimeError("postgres_test_target_forbidden")
    database_name = parsed.path.removeprefix("/")
    if not database_name.startswith(POSTGRES_TEST_DATABASE_PREFIX):
        raise RuntimeError("postgres_test_database_not_dedicated")
    try:
        with psycopg.connect(database_url) as conn:
            server_version_num = int(conn.execute("SHOW server_version_num").fetchone()[0])
            server_version = str(conn.execute("SHOW server_version").fetchone()[0])
            current_database = str(conn.execute("SELECT current_database()").fetchone()[0])
            marker_table = conn.execute(
                "SELECT to_regclass(%s)",
                (POSTGRES_TEST_MARKER_TABLE,),
            ).fetchone()[0]
            marker_matches = False
            if marker_table is not None:
                marker_matches = conn.execute(
                    f"SELECT EXISTS (SELECT 1 FROM {POSTGRES_TEST_MARKER_TABLE} WHERE marker = %s AND purpose = %s)",
                    (marker, POSTGRES_TEST_MARKER_PURPOSE),
                ).fetchone()[0]
    except Exception:
        raise RuntimeError("postgres_test_target_validation_failed") from None
    if current_database != database_name:
        raise RuntimeError("postgres_test_database_identity_mismatch")
    if not 160000 <= server_version_num < 170000:
        raise RuntimeError("postgres_test_requires_postgresql_16")
    if not marker_matches:
        raise RuntimeError("postgres_test_ephemeral_marker_missing")
    return server_version


def _drop_ephemeral_schema(database_url: str, schema: str) -> None:
    _validate_ephemeral_postgres_target(database_url)
    if not re.fullmatch(r"device_v1_[0-9a-f]{32}", schema):
        raise RuntimeError("postgres_test_schema_identity_invalid")
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f'DROP SCHEMA "{schema}" CASCADE')


def _run_init_process(database_url: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["SCISONOMICS_CLOUD_DATABASE_URL"] = database_url
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [
            sys.executable,
            "-c",
            "from modern_app.cloud_backend.app.db import init_db; init_db()",
        ],
        cwd=str(Path(__file__).resolve().parents[2]),
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )


def _start_init_process(database_url: str) -> subprocess.Popen[str]:
    env = os.environ.copy()
    env["SCISONOMICS_CLOUD_DATABASE_URL"] = database_url
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.Popen(
        [
            sys.executable,
            "-c",
            "from modern_app.cloud_backend.app.db import init_db; init_db()",
        ],
        cwd=str(Path(__file__).resolve().parents[2]),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


@unittest.skipUnless(
    os.getenv(POSTGRES_TEST_URL_ENV, "").startswith(("postgresql://", "postgres://")),
    f"{POSTGRES_TEST_URL_ENV} debe apuntar exclusivamente a PostgreSQL efimero",
)
class PostgreSQLDeviceVerificationMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.admin_url = os.environ[POSTGRES_TEST_URL_ENV]
        cls.server_version = _validate_ephemeral_postgres_target(cls.admin_url)

    def setUp(self) -> None:
        _validate_ephemeral_postgres_target(self.admin_url)
        self.schema = f"device_v1_{uuid4().hex}"
        with psycopg.connect(self.admin_url, autocommit=True) as conn:
            conn.execute(f'CREATE SCHEMA "{self.schema}"')
        self.database_url = _schema_url(self.admin_url, self.schema)
        self.old_url = os.environ.get("SCISONOMICS_CLOUD_DATABASE_URL")
        os.environ["SCISONOMICS_CLOUD_DATABASE_URL"] = self.database_url

    def tearDown(self) -> None:
        if self.old_url is None:
            os.environ.pop("SCISONOMICS_CLOUD_DATABASE_URL", None)
        else:
            os.environ["SCISONOMICS_CLOUD_DATABASE_URL"] = self.old_url
        _drop_ephemeral_schema(self.admin_url, self.schema)

    @contextmanager
    def _connection(self):
        with psycopg.connect(self.database_url, row_factory=psycopg.rows.dict_row) as conn:
            yield conn
            conn.commit()

    def _prepare_legacy_schema(self) -> tuple[str, dict[str, str]]:
        with patch.object(cloud_db, "_ensure_device_verification_schema", lambda _conn: None):
            cloud_db.init_db()
        user_id = str(uuid4())
        stamp = "2026-01-01T00:00:00+00:00"
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
                VALUES (%s, 'legacy@example.test', 'test-hash', 'Legacy', %s, %s)
                """,
                (user_id, stamp, stamp),
            )
            conn.execute(
                """
                INSERT INTO cloud_categorias
                    (user_id, sync_id, nombre, tipo, remote_updated_at)
                VALUES (%s, 'cat-1', 'Comida', 'gasto', %s)
                """,
                (user_id, stamp),
            )
            conn.execute(
                """
                INSERT INTO cloud_metas_ahorro
                    (user_id, sync_id, nombre, monto_objetivo, monto_inicial, remote_updated_at)
                VALUES (%s, 'meta-1', 'Meta', 9000, 1000, %s)
                """,
                (user_id, stamp),
            )
            conn.execute(
                """
                INSERT INTO cloud_gastos_programados
                    (user_id, sync_id, descripcion, monto_estimado, remote_updated_at)
                VALUES (%s, 'gp-1', 'Programado', 88.5, %s)
                """,
                (user_id, stamp),
            )
            conn.execute(
                """
                INSERT INTO cloud_gastos_fijos
                    (user_id, sync_id, descripcion, monto, remote_updated_at)
                VALUES (%s, 'gf-1', 'Fijo', 77.25, %s)
                """,
                (user_id, stamp),
            )
            conn.execute(
                """
                INSERT INTO cloud_presupuestos
                    (user_id, sync_id, mes, anio, monto, remote_updated_at)
                VALUES (%s, 'pre-1', 1, 2026, 5000, %s)
                """,
                (user_id, stamp),
            )
            conn.execute(
                """
                INSERT INTO cloud_tags
                    (user_id, sync_id, nombre, color, remote_updated_at)
                VALUES (%s, 'tag-1', 'Test', '#ffffff', %s)
                """,
                (user_id, stamp),
            )
            conn.execute(
                """
                INSERT INTO cloud_movimiento_tags
                    (user_id, sync_id, movimiento_sync_id, tag_sync_id, remote_updated_at)
                VALUES (%s, 'mt-1', 'mov-1', 'tag-1', %s)
                """,
                (user_id, stamp),
            )
            conn.execute(
                """
                INSERT INTO cloud_movimientos
                    (user_id, sync_id, tipo, monto, descripcion, fecha, remote_updated_at)
                VALUES (%s, 'mov-1', 'gasto', 1234.56, 'Sentinel', '2026-01-01', %s)
                """,
                (user_id, stamp),
            )
        return user_id, self._financial_checksums()

    def _financial_checksums(self) -> dict[str, str]:
        checksums: dict[str, str] = {}
        with self._connection() as conn:
            for table in cloud_db.SYNC_CLOUD_TABLES:
                row = conn.execute(
                    f"""
                    SELECT md5(COALESCE(string_agg(row_to_json(source_row)::text, '|' ORDER BY id), '')) AS checksum
                    FROM {table} AS source_row
                    """
                ).fetchone()
                checksums[table] = str(row["checksum"])
        return checksums

    def test_two_processes_catalog_idempotence_and_rolling_repair(self) -> None:
        self.assertTrue(self.server_version.startswith("16."), self.server_version)
        user_id, checksums_before = self._prepare_legacy_schema()
        lock_owner = psycopg.connect(self.database_url)
        lock_owner.execute(
            "SELECT pg_advisory_xact_lock(%s)",
            (cloud_db.POSTGRES_INIT_ADVISORY_LOCK_KEY,),
        )
        processes = [_start_init_process(self.database_url), _start_init_process(self.database_url)]
        blocked = 0
        try:
            deadline = time.monotonic() + 10
            with psycopg.connect(self.admin_url) as observer:
                while time.monotonic() < deadline:
                    blocked = observer.execute(
                        """
                        SELECT COUNT(*)
                        FROM pg_catalog.pg_stat_activity
                        WHERE datname = current_database()
                          AND query LIKE '%%pg_advisory_xact_lock%%'
                          AND wait_event IS NOT NULL
                        """
                    ).fetchone()[0]
                    if blocked >= 1:
                        break
                    time.sleep(0.05)

            concurrent_legacy_id = str(uuid4())
            stamp = "2026-01-01T12:00:00+00:00"
            with self._connection() as conn:
                conn.execute(
                    """
                    INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
                    VALUES (%s, 'concurrent@example.test', 'legacy-hash', 'Concurrent legacy', %s, %s)
                    """,
                    (concurrent_legacy_id, stamp, stamp),
                )
        finally:
            lock_owner.commit()
            lock_owner.close()
        self.assertGreaterEqual(blocked, 1, "los procesos init_db deben competir por el advisory lock")
        for process in processes:
            stdout, stderr = process.communicate(timeout=90)
            self.assertEqual(process.returncode, 0, f"{stdout}\n{stderr}")

        cloud_db.init_db()
        legacy_rolling_id = str(uuid4())
        stamp = "2026-01-02T00:00:00+00:00"
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
                VALUES (%s, 'rolling@example.test', 'legacy-hash', 'Rolling', %s, %s)
                """,
                (legacy_rolling_id, stamp, stamp),
            )
            self.assertEqual(cloud_db.missing_device_key_namespace_count(conn), 1)

        repaired = _run_init_process(self.database_url)
        self.assertEqual(repaired.returncode, 0, repaired.stderr)
        second = _run_init_process(self.database_url)
        self.assertEqual(second.returncode, 0, second.stderr)

        with self._connection() as conn:
            self.assertEqual(cloud_db.missing_device_key_namespace_count(conn), 0)
            self.assertEqual(
                conn.execute("SELECT id FROM users WHERE id = %s", (user_id,)).fetchone()["id"],
                user_id,
            )
            index_definition = conn.execute(
                """
                SELECT indexdef
                FROM pg_catalog.pg_indexes
                WHERE schemaname = current_schema()
                  AND indexname = 'idx_users_device_key_namespace'
                """
            ).fetchone()["indexdef"]
            self.assertIn("WHERE (device_key_namespace IS NOT NULL)", index_definition)
            foreign_keys = {
                row["conname"]
                for row in conn.execute(
                    """
                    SELECT constraint_record.conname
                    FROM pg_catalog.pg_constraint AS constraint_record
                    JOIN pg_catalog.pg_class AS table_record
                      ON table_record.oid = constraint_record.conrelid
                    JOIN pg_catalog.pg_namespace AS namespace_record
                      ON namespace_record.oid = table_record.relnamespace
                    WHERE namespace_record.nspname = current_schema()
                      AND table_record.relname = 'device_proof_challenges'
                      AND constraint_record.contype = 'f'
                    """
                ).fetchall()
            }
            self.assertTrue(
                {"fk_device_proof_refresh_family", "fk_device_proof_target_device"}.issubset(foreign_keys)
            )
            target_fk = conn.execute(
                """
                SELECT pg_catalog.pg_get_constraintdef(constraint_record.oid) AS definition
                FROM pg_catalog.pg_constraint AS constraint_record
                JOIN pg_catalog.pg_class AS table_record
                  ON table_record.oid = constraint_record.conrelid
                JOIN pg_catalog.pg_namespace AS namespace_record
                  ON namespace_record.oid = table_record.relnamespace
                WHERE namespace_record.nspname = current_schema()
                  AND table_record.relname = 'device_proof_challenges'
                  AND constraint_record.conname = 'fk_device_proof_target_device'
                """
            ).fetchone()["definition"]
            self.assertIn(
                "FOREIGN KEY (user_id, target_device_id) REFERENCES trusted_devices(user_id, device_id)",
                target_fk,
            )
            constraint_types = {
                row["contype"]
                for row in conn.execute(
                    """
                    SELECT DISTINCT constraint_record.contype
                    FROM pg_catalog.pg_constraint AS constraint_record
                    JOIN pg_catalog.pg_class AS table_record
                      ON table_record.oid = constraint_record.conrelid
                    JOIN pg_catalog.pg_namespace AS namespace_record
                      ON namespace_record.oid = table_record.relnamespace
                    WHERE namespace_record.nspname = current_schema()
                      AND table_record.relname IN
                          ('trusted_devices', 'device_proof_challenges', 'refresh_token_families')
                    """
                ).fetchall()
            }
            self.assertTrue({"p", "f", "c", "u"}.issubset(constraint_types))
            indexes = {
                row["indexname"]
                for row in conn.execute(
                    """
                    SELECT indexname
                    FROM pg_catalog.pg_indexes
                    WHERE schemaname = current_schema()
                    """
                ).fetchall()
            }
            self.assertTrue(
                {
                    "idx_users_device_key_namespace",
                    "idx_trusted_devices_user",
                    "idx_device_proof_expires",
                    "idx_refresh_families_device",
                }.issubset(indexes)
            )
        self.assertEqual(self._financial_checksums(), checksums_before)

    def test_failed_migration_rolls_back_ddl(self) -> None:
        self._prepare_legacy_schema()
        original = cloud_db._ensure_device_verification_schema

        def fail_after_device_ddl(conn) -> None:
            original(conn)
            raise RuntimeError("injected_migration_failure")

        with patch.object(cloud_db, "_ensure_device_verification_schema", fail_after_device_ddl):
            with self.assertRaisesRegex(RuntimeError, "injected_migration_failure"):
                cloud_db.init_db()

        with self._connection() as conn:
            column = conn.execute(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'users'
                  AND column_name = 'device_key_namespace'
                """
            ).fetchone()
            self.assertIsNone(column)

    def test_same_name_wrong_foreign_key_definition_is_repaired_while_v1_is_empty(self) -> None:
        self._prepare_legacy_schema()
        cloud_db.init_db()
        with self._connection() as conn:
            conn.execute(
                "ALTER TABLE device_proof_challenges DROP CONSTRAINT fk_device_proof_target_device"
            )
            conn.execute(
                "ALTER TABLE device_proof_challenges ADD CONSTRAINT fk_device_proof_target_device "
                "FOREIGN KEY (target_device_id) REFERENCES trusted_devices(id)"
            )
        cloud_db.init_db()
        with self._connection() as conn:
            definition = conn.execute(
                """
                SELECT pg_catalog.pg_get_constraintdef(constraint_record.oid) AS definition
                FROM pg_catalog.pg_constraint AS constraint_record
                JOIN pg_catalog.pg_class AS table_record
                  ON table_record.oid = constraint_record.conrelid
                JOIN pg_catalog.pg_namespace AS namespace_record
                  ON namespace_record.oid = table_record.relnamespace
                WHERE namespace_record.nspname = current_schema()
                  AND table_record.relname = 'device_proof_challenges'
                  AND constraint_record.conname = 'fk_device_proof_target_device'
                """
            ).fetchone()["definition"]
        self.assertIn(
            "FOREIGN KEY (user_id, target_device_id) REFERENCES trusted_devices(user_id, device_id)",
            definition,
        )


class PostgreSQLHarnessGuardTests(unittest.TestCase):
    class _FakeConnection:
        def __init__(
            self,
            *,
            database="scisonomics_device_verification_test",
            version_num=160009,
            marker_table="scisonomics_ephemeral_test_marker",
            marker_matches=True,
        ) -> None:
            self.database = database
            self.version_num = version_num
            self.marker_table = marker_table
            self.marker_matches = marker_matches

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def execute(self, sql, _params=()):
            normalized = " ".join(sql.split())
            value = None
            if normalized == "SHOW server_version_num":
                value = str(self.version_num)
            elif normalized == "SHOW server_version":
                value = "16.9" if 160000 <= self.version_num < 170000 else "17.0"
            elif normalized == "SELECT current_database()":
                value = self.database
            elif normalized.startswith("SELECT to_regclass"):
                value = self.marker_table
            elif normalized.startswith("SELECT EXISTS"):
                value = self.marker_matches

            class Result:
                def fetchone(self_nonlocal):
                    return (value,)

            return Result()

    def _accepted_environment(self):
        return patch.dict(
            os.environ,
            {
                POSTGRES_TEST_DESTRUCTIVE_ENV: POSTGRES_TEST_DESTRUCTIVE_VALUE,
                POSTGRES_TEST_MARKER_ENV: "explicit-test-marker-1234",
            },
            clear=False,
        )

    def test_rejects_remote_target_before_connecting(self) -> None:
        with (
            patch.dict(
                os.environ,
                {
                    POSTGRES_TEST_DESTRUCTIVE_ENV: POSTGRES_TEST_DESTRUCTIVE_VALUE,
                    POSTGRES_TEST_MARKER_ENV: "explicit-test-marker-1234",
                },
                clear=False,
            ),
            patch.object(psycopg, "connect") as connect_mock,
        ):
            with self.assertRaisesRegex(RuntimeError, "^postgres_test_target_not_local$"):
                _validate_ephemeral_postgres_target(
                    "postgresql://user:secret@example.railway.app/scisonomics_device_verification_test"
                )
            connect_mock.assert_not_called()

    def test_rejects_missing_acceptance_before_connecting(self) -> None:
        with (
            patch.dict(
                os.environ,
                {POSTGRES_TEST_MARKER_ENV: "explicit-test-marker-1234"},
                clear=False,
            ),
            patch.object(psycopg, "connect") as connect_mock,
        ):
            os.environ.pop(POSTGRES_TEST_DESTRUCTIVE_ENV, None)
            with self.assertRaisesRegex(RuntimeError, "^postgres_test_destructive_acceptance_missing$"):
                _validate_ephemeral_postgres_target(
                    "postgresql://localhost/scisonomics_device_verification_test"
                )
            connect_mock.assert_not_called()

    def test_rejects_wrong_database_name_before_connecting(self) -> None:
        with self._accepted_environment(), patch.object(psycopg, "connect") as connect_mock:
            with self.assertRaisesRegex(RuntimeError, "^postgres_test_database_not_dedicated$"):
                _validate_ephemeral_postgres_target("postgresql://localhost/scisonomics_test")
            connect_mock.assert_not_called()

    def test_rejects_missing_marker_value_before_connecting(self) -> None:
        with self._accepted_environment(), patch.object(psycopg, "connect") as connect_mock:
            os.environ.pop(POSTGRES_TEST_MARKER_ENV, None)
            with self.assertRaisesRegex(RuntimeError, "^postgres_test_ephemeral_marker_invalid$"):
                _validate_ephemeral_postgres_target(
                    "postgresql://localhost/scisonomics_device_verification_test"
                )
            connect_mock.assert_not_called()

    def test_rejects_incorrect_database_marker(self) -> None:
        fake = self._FakeConnection(marker_matches=False)
        with self._accepted_environment(), patch.object(psycopg, "connect", return_value=fake):
            with self.assertRaisesRegex(RuntimeError, "^postgres_test_ephemeral_marker_missing$"):
                _validate_ephemeral_postgres_target(
                    "postgresql://localhost/scisonomics_device_verification_test"
                )

    def test_rejects_postgresql_major_other_than_16(self) -> None:
        fake = self._FakeConnection(version_num=170000)
        with self._accepted_environment(), patch.object(psycopg, "connect", return_value=fake):
            with self.assertRaisesRegex(RuntimeError, "^postgres_test_requires_postgresql_16$"):
                _validate_ephemeral_postgres_target(
                    "postgresql://localhost/scisonomics_device_verification_test"
                )

    def test_rejects_invalid_scheme_before_connecting(self) -> None:
        with self._accepted_environment(), patch.object(psycopg, "connect") as connect_mock:
            with self.assertRaisesRegex(RuntimeError, "^postgres_test_target_invalid$"):
                _validate_ephemeral_postgres_target(
                    "sqlite://localhost/scisonomics_device_verification_test"
                )
            connect_mock.assert_not_called()

    def test_rejects_database_identity_mismatch(self) -> None:
        fake = self._FakeConnection(database="scisonomics_device_verification_test_other")
        with self._accepted_environment(), patch.object(psycopg, "connect", return_value=fake):
            with self.assertRaisesRegex(RuntimeError, "^postgres_test_database_identity_mismatch$"):
                _validate_ephemeral_postgres_target(
                    "postgresql://localhost/scisonomics_device_verification_test"
                )

    def test_failed_revalidation_prevents_drop(self) -> None:
        schema = f"device_v1_{uuid4().hex}"
        with (
            patch(
                f"{__name__}._validate_ephemeral_postgres_target",
                side_effect=RuntimeError("revalidation_failed"),
            ),
            patch.object(psycopg, "connect") as connect_mock,
        ):
            with self.assertRaisesRegex(RuntimeError, "^revalidation_failed$"):
                _drop_ephemeral_schema(
                    "postgresql://localhost/scisonomics_device_verification_test", schema
                )
            connect_mock.assert_not_called()
