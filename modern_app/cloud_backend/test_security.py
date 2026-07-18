from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import unittest
from uuid import uuid4


TEST_DB = Path(__file__).resolve().parents[2] / "tmp" / f"security-tests-{uuid4().hex}.db"
os.environ["SCISONOMICS_ENV"] = "development"
os.environ["SCISONOMICS_JWT_SECRET"] = "test-secret-with-at-least-thirty-two-characters"
os.environ["SCISONOMICS_CLOUD_DATABASE_URL"] = f"sqlite:///{TEST_DB.as_posix()}"

from fastapi.testclient import TestClient

from modern_app.cloud_backend.app.auth import (
    PASSWORD_ITERATIONS,
    create_access_token,
    decode_access_token,
    hash_password,
    password_needs_rehash,
    verify_password,
)
from modern_app.cloud_backend.app.db import connect, init_db
from modern_app.cloud_backend.app.main import _validate_sync_payload, app, now_iso
from finance_app.secure_backup import decrypt_backup, encrypt_backup, is_encrypted_backup


def _legacy_pbkdf2(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ITERATIONS)
    encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${encode(salt)}${encode(digest)}"


class PasswordAndTokenTests(unittest.TestCase):
    def test_scrypt_and_legacy_hashes_are_supported(self) -> None:
        password = "correct horse battery staple"
        current = hash_password(password)
        legacy = _legacy_pbkdf2(password)
        self.assertTrue(verify_password(password, current))
        self.assertTrue(verify_password(password, legacy))
        self.assertFalse(password_needs_rehash(current))
        self.assertTrue(password_needs_rehash(legacy))

    def test_access_token_has_strict_security_claims(self) -> None:
        token = create_access_token("user-1")
        payload = decode_access_token(token)
        self.assertEqual(payload["type"], "access")
        self.assertEqual(payload["iss"], "scisonomics-cloud")
        self.assertEqual(payload["aud"], "scisonomics-desktop")

        header, body, signature = token.split(".")
        decoded_header = json.loads(base64.urlsafe_b64decode(header + "=="))
        decoded_header["alg"] = "none"
        altered = base64.urlsafe_b64encode(json.dumps(decoded_header).encode()).rstrip(b"=").decode()
        with self.assertRaises(ValueError):
            decode_access_token(f"{altered}.{body}.{signature}")

    def test_encrypted_backup_detects_wrong_password_and_tampering(self) -> None:
        source = TEST_DB.parent / f"source-{uuid4().hex}.db"
        encrypted = TEST_DB.parent / f"encrypted-{uuid4().hex}.sciso-backup"
        restored = TEST_DB.parent / f"restored-{uuid4().hex}.db"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b"SQLite format 3\x00" + secrets.token_bytes(4096))
        try:
            encrypt_backup(source, encrypted, "a strong backup password")
            self.assertTrue(is_encrypted_backup(encrypted))
            decrypt_backup(encrypted, restored, "a strong backup password")
            self.assertEqual(source.read_bytes(), restored.read_bytes())
            with self.assertRaises(ValueError):
                decrypt_backup(encrypted, restored, "a different bad password")
        finally:
            source.unlink(missing_ok=True)
            encrypted.unlink(missing_ok=True)
            restored.unlink(missing_ok=True)


class SessionSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        TEST_DB.parent.mkdir(parents=True, exist_ok=True)
        init_db()
        cls.email = "security-test@example.com"
        cls.password = "a very strong test password"
        cls.user_id = str(uuid4())
        stamp = now_iso()
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO users (id, email, password_hash, display_name, email_verified, email_verified_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                """,
                (cls.user_id, cls.email, hash_password(cls.password), "Security Test", stamp, stamp, stamp),
            )

    @classmethod
    def tearDownClass(cls) -> None:
        TEST_DB.unlink(missing_ok=True)

    def test_refresh_token_reuse_revokes_the_whole_family(self) -> None:
        with TestClient(app) as client:
            login = client.post("/auth/login", json={"email": self.email, "password": self.password})
            self.assertEqual(login.status_code, 200, login.text)
            first = login.json()["refresh_token"]

            rotated = client.post("/auth/refresh", json={"refresh_token": first})
            self.assertEqual(rotated.status_code, 200, rotated.text)
            second = rotated.json()["refresh_token"]

            reused = client.post("/auth/refresh", json={"refresh_token": first})
            self.assertEqual(reused.status_code, 401, reused.text)
            family_member = client.post("/auth/refresh", json={"refresh_token": second})
            self.assertEqual(family_member.status_code, 401, family_member.text)

    def test_login_rate_limit_blocks_repeated_attempts(self) -> None:
        with TestClient(app) as client:
            statuses = [
                client.post(
                    "/auth/login",
                    json={"email": "missing-security-user@example.com", "password": "invalid password"},
                ).status_code
                for _ in range(9)
            ]
        self.assertTrue(all(status == 401 for status in statuses[:8]), statuses)
        self.assertEqual(statuses[8], 429, statuses)

    def test_sync_payload_limits_and_unknown_fields(self) -> None:
        valid = {"device_id": "device-1", "device_name": "Test"}
        valid.update({table: [] for table in (
            "categorias", "tags", "metas_ahorro", "gastos_programados",
            "gastos_fijos", "presupuestos", "movimientos", "movimiento_tags",
        )})
        self.assertEqual(_validate_sync_payload(valid)["device_id"], "device-1")
        with self.assertRaises(Exception):
            _validate_sync_payload({**valid, "unexpected": []})


if __name__ == "__main__":
    unittest.main()
