from __future__ import annotations

import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient


def _configure_env(db_path: Path) -> None:
    os.environ["SCISONOMICS_ENV"] = "development"
    os.environ["SCISONOMICS_CLOUD_DATABASE_URL"] = f"sqlite:///{db_path}"
    os.environ["SCISONOMICS_JWT_SECRET"] = "email-verification-smoke-secret"
    os.environ["SCISONOMICS_EMAIL_PROVIDER"] = "memory"
    os.environ["SCISONOMICS_EMAIL_VERIFICATION_TTL_MINUTES"] = "10"
    os.environ["SCISONOMICS_EMAIL_RESEND_SECONDS"] = "60"
    os.environ["SCISONOMICS_ALLOWED_ORIGINS"] = "http://127.0.0.1:3000"


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _last_code(main_module) -> str:
    _assert(bool(main_module._DEV_EMAIL_OUTBOX), "expected verification email")
    return main_module._DEV_EMAIL_OUTBOX[-1]["code"]


def _register(client: TestClient, email: str = "new@example.com"):
    return client.post(
        "/auth/register",
        json={"email": email, "password": "correct horse battery staple", "display_name": "Test"},
    )


def _login(client: TestClient, email: str, password: str = "correct horse battery staple"):
    return client.post("/auth/login", json={"email": email, "password": password})


def _connect(db_path: Path):
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="scisonomics-cloud-email-", ignore_cleanup_errors=True) as tmpdir:
        db_path = Path(tmpdir) / "cloud.db"
        _configure_env(db_path)

        from app import db as cloud_db
        from app import main as cloud_main

        cloud_db.init_db()

        with TestClient(cloud_main.app) as client:
            response = _register(client)
            _assert(response.status_code == 200, "register should require verification")
            payload = response.json()
            _assert(payload["status"] == "verification_required", "register returned normal session")
            _assert("access_token" not in payload, "register emitted access token before verification")

            with _connect(db_path) as conn:
                user = conn.execute("SELECT id, email_verified FROM users WHERE email = ?", ("new@example.com",)).fetchone()
                code_row = conn.execute("SELECT code_hash FROM email_verification_codes WHERE user_id = ?", (user["id"],)).fetchone()
            _assert(user["email_verified"] == 0, "new user should be unverified")
            _assert(code_row and code_row["code_hash"] != _last_code(cloud_main), "code must be hashed")

            first_code = _last_code(cloud_main)
            wrong_code = "000000" if first_code != "000000" else "999999"
            wrong = client.post("/auth/verify-email", json={"verification_token": payload["verification_token"], "code": wrong_code})
            _assert(wrong.status_code == 400, "wrong code should fail")
            with _connect(db_path) as conn:
                attempts = conn.execute("SELECT attempts FROM email_verification_codes WHERE user_id = ?", (user["id"],)).fetchone()["attempts"]
            _assert(attempts == 1, "wrong code should increment attempts")

            for code in ("111111", "222222", "333333", "444444"):
                if code == first_code:
                    code = "555555"
                client.post("/auth/verify-email", json={"verification_token": payload["verification_token"], "code": code})
            exceeded = client.post("/auth/verify-email", json={"verification_token": payload["verification_token"], "code": _last_code(cloud_main)})
            _assert(exceeded.status_code == 410 or exceeded.status_code == 429, "max attempts should invalidate code")

            login_unverified = _login(client, "new@example.com")
            _assert(login_unverified.status_code == 200, "unverified login should return verification flow")
            login_payload = login_unverified.json()
            _assert(login_payload["status"] == "verification_required", "unverified login should not return session")
            first_resend = client.post("/auth/resend-email-verification", json={"verification_token": login_payload["verification_token"]})
            _assert(first_resend.status_code == 200, "login recovery should allow an explicit resend")
            code = _last_code(cloud_main)

            too_soon = client.post("/auth/resend-email-verification", json={"verification_token": first_resend.json()["verification_token"]})
            _assert(too_soon.status_code == 429, "resend before cooldown should fail")

            with _connect(db_path) as conn:
                conn.execute(
                    "UPDATE email_verification_codes SET last_sent_at = ? WHERE user_id = ? AND invalidated_at IS NULL",
                    ((datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat(timespec="seconds"), user["id"]),
                )
                conn.commit()
            resent = client.post("/auth/resend-email-verification", json={"verification_token": first_resend.json()["verification_token"]})
            _assert(resent.status_code == 200, "resend after cooldown should pass")
            new_code = _last_code(cloud_main)
            _assert(new_code != code, "resend should generate a new code")
            old_code = client.post("/auth/verify-email", json={"verification_token": resent.json()["verification_token"], "code": code})
            _assert(old_code.status_code in (400, 410, 429), "old code should not be reusable after resend")

            verified = client.post("/auth/verify-email", json={"verification_token": resent.json()["verification_token"], "code": new_code})
            _assert(verified.status_code == 200, "correct code should verify email")
            verified_payload = verified.json()
            _assert(bool(verified_payload.get("access_token")), "verified email should receive access token")

            reused = client.post("/auth/verify-email", json={"verification_token": resent.json()["verification_token"], "code": new_code})
            _assert(reused.status_code == 409, "consumed code should not be reusable")

            login_verified = _login(client, "new@example.com")
            _assert(login_verified.status_code == 200 and "access_token" in login_verified.json(), "verified login should return session")

            with cloud_db.connect() as conn:
                cloud_main._find_or_create_google_user(
                    conn,
                    {"sub": "google-sub-1", "email": "google@example.com", "email_verified": True, "name": "Google User"},
                    cloud_main.now_iso(),
                )
            with _connect(db_path) as conn:
                google_user = conn.execute("SELECT email_verified FROM users WHERE email = ?", ("google@example.com",)).fetchone()
            _assert(google_user["email_verified"] == 1, "verified Google email should be trusted")

        # Migration compatibility for legacy users without email verification columns.
        legacy_path = Path(tmpdir) / "legacy.db"
        with sqlite3.connect(str(legacy_path)) as conn:
            conn.execute(
                """
                CREATE TABLE users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    display_name TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES ('legacy', 'legacy@example.com', 'x', 'Legacy', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')"
            )
        _configure_env(legacy_path)
        cloud_db.init_db()
        with _connect(legacy_path) as conn:
            legacy = conn.execute("SELECT email_verified FROM users WHERE id = 'legacy'").fetchone()
        _assert(legacy["email_verified"] == 1, "legacy users should be marked verified")

        # Provider failure should not create a confirmed session.
        failing_path = Path(tmpdir) / "failing.db"
        _configure_env(failing_path)
        os.environ["SCISONOMICS_EMAIL_PROVIDER"] = "smtp"
        os.environ["SCISONOMICS_SMTP_HOST"] = ""
        cloud_db.init_db()
        with TestClient(cloud_main.app) as client:
            failed = _register(client, "fail@example.com")
            _assert(failed.status_code == 503, "email provider failure should fail safely")
        with _connect(failing_path) as conn:
            row = conn.execute("SELECT id FROM users WHERE email = ?", ("fail@example.com",)).fetchone()
        _assert(row is not None, "failed email delivery should preserve the unverified account")

    print("email verification smoke tests OK")


if __name__ == "__main__":
    main()
