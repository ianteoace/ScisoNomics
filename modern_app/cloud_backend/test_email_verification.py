from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import smtplib
import socket
import tempfile
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient


os.environ["SCISONOMICS_ENV"] = "development"
os.environ["SCISONOMICS_JWT_SECRET"] = "email-tests-secret-with-at-least-thirty-two-characters"
os.environ["SCISONOMICS_ALLOWED_ORIGINS"] = "http://127.0.0.1:3000"

from modern_app.cloud_backend.app import main as cloud_main
from modern_app.cloud_backend.app.db import connect, init_db


PASSWORD = "correct horse battery staple"


class _FakeSocket:
    def __init__(self) -> None:
        self.timeouts: list[float] = []

    def settimeout(self, value: float) -> None:
        self.timeouts.append(value)


class SuccessfulSMTP:
    instances: list["SuccessfulSMTP"] = []
    delay_seconds = 0.0

    def __init__(self, host: str, port: int, timeout: float) -> None:
        self.host = host
        self.port = port
        self.connect_timeout = timeout
        self.sock = _FakeSocket()
        self.messages = 0
        type(self).instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def starttls(self) -> None:
        return None

    def login(self, username: str, password: str) -> None:
        return None

    def send_message(self, message) -> None:
        if self.delay_seconds:
            time.sleep(self.delay_seconds)
        self.messages += 1


class TimeoutSMTP(SuccessfulSMTP):
    instances: list["TimeoutSMTP"] = []

    def send_message(self, message) -> None:
        raise socket.timeout("simulated timeout")


class AuthenticationFailureSMTP(SuccessfulSMTP):
    instances: list["AuthenticationFailureSMTP"] = []

    def login(self, username: str, password: str) -> None:
        raise smtplib.SMTPAuthenticationError(535, b"simulated authentication failure")


class EmailVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory(prefix="scisonomics-email-tests-", ignore_cleanup_errors=True)
        self.db_path = Path(self.tmpdir.name) / "cloud.db"
        os.environ.update(
            {
                "SCISONOMICS_CLOUD_DATABASE_URL": f"sqlite:///{self.db_path.as_posix()}",
                "SCISONOMICS_EMAIL_PROVIDER": "smtp",
                "SCISONOMICS_EMAIL_FROM": "sender@example.com",
                "SCISONOMICS_SMTP_HOST": "smtp.test.invalid",
                "SCISONOMICS_SMTP_PORT": "587",
                "SCISONOMICS_SMTP_USERNAME": "",
                "SCISONOMICS_SMTP_PASSWORD": "",
                "SCISONOMICS_SMTP_USE_TLS": "false",
                "SCISONOMICS_SMTP_CONNECT_TIMEOUT_SECONDS": "2",
                "SCISONOMICS_SMTP_OPERATION_TIMEOUT_SECONDS": "3",
                "SCISONOMICS_SMTP_TOTAL_TIMEOUT_SECONDS": "4",
                "SCISONOMICS_EMAIL_RESEND_SECONDS": "60",
                "SCISONOMICS_EMAIL_MAX_RESENDS_PER_HOUR": "5",
                "SCISONOMICS_CHECK_BREACHED_PASSWORDS": "false",
            }
        )
        SuccessfulSMTP.instances.clear()
        TimeoutSMTP.instances.clear()
        AuthenticationFailureSMTP.instances.clear()
        init_db()
        self.client = TestClient(cloud_main.app)

    def tearDown(self) -> None:
        self.client.close()
        self.tmpdir.cleanup()

    def _email(self, prefix: str) -> str:
        return f"{prefix}-{uuid4().hex[:10]}@example.com"

    def _register(self, email: str, password: str = PASSWORD):
        return self.client.post(
            "/auth/register",
            json={"email": email, "password": password, "display_name": "Email Test"},
        )

    def _user(self, email: str):
        with connect() as conn:
            return conn.execute(
                "SELECT id, email_verified FROM users WHERE email = ?",
                (email,),
            ).fetchone()

    def test_new_unverified_account_and_successful_delivery(self) -> None:
        email = self._email("new")
        with patch.object(cloud_main.smtplib, "SMTP", SuccessfulSMTP):
            response = self._register(email)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "verification_required")
        self.assertNotIn("access_token", response.json())
        self.assertEqual(self._user(email)["email_verified"], 0)
        self.assertEqual(SuccessfulSMTP.instances[-1].messages, 1)
        self.assertEqual(SuccessfulSMTP.instances[-1].connect_timeout, 2)
        self.assertTrue(SuccessfulSMTP.instances[-1].sock.timeouts)

    def test_slow_smtp_blocks_register_but_completes(self) -> None:
        email = self._email("slow")
        SuccessfulSMTP.delay_seconds = 0.08
        try:
            started = time.monotonic()
            with patch.object(cloud_main.smtplib, "SMTP", SuccessfulSMTP):
                response = self._register(email)
            elapsed = time.monotonic() - started
        finally:
            SuccessfulSMTP.delay_seconds = 0.0
        self.assertEqual(response.status_code, 200, response.text)
        self.assertGreaterEqual(elapsed, 0.07)

    def test_smtp_timeout_is_safe_and_account_remains_unverified(self) -> None:
        email = self._email("timeout")
        with patch.object(cloud_main.smtplib, "SMTP", TimeoutSMTP):
            response = self._register(email)
        self.assertEqual(response.status_code, 503, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "email_delivery_failed")
        self.assertEqual(detail["verification"]["status"], "verification_required")
        self.assertNotIn("timeout", detail["message"].lower())
        self.assertEqual(self._user(email)["email_verified"], 0)
        with patch.object(cloud_main.smtplib, "SMTP", SuccessfulSMTP):
            recovery = self.client.post("/auth/login", json={"email": email, "password": PASSWORD})
        self.assertEqual(recovery.status_code, 200, recovery.text)
        self.assertEqual(recovery.json()["status"], "verification_required")
        self.assertEqual(len(SuccessfulSMTP.instances), 0)

    def test_smtp_authentication_failure_is_classified_but_not_exposed(self) -> None:
        email = self._email("auth")
        os.environ["SCISONOMICS_SMTP_USERNAME"] = "configured-user"
        os.environ["SCISONOMICS_SMTP_PASSWORD"] = "configured-password"
        with patch.object(cloud_main.smtplib, "SMTP", AuthenticationFailureSMTP):
            with self.assertRaises(cloud_main.EmailDeliveryError) as raised:
                cloud_main.send_verification_email(email, "123456")
            response = self._register(email)
        self.assertEqual(raised.exception.kind, "authentication")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["detail"]["code"], "email_delivery_failed")
        self.assertNotIn("authentication", response.text.lower())
        self.assertEqual(self._user(email)["email_verified"], 0)

    def test_second_registration_is_idempotent_and_wrong_password_is_generic(self) -> None:
        email = self._email("repeat")
        with patch.object(cloud_main.smtplib, "SMTP", SuccessfulSMTP):
            first = self._register(email)
            sent_after_first = len(SuccessfulSMTP.instances)
            repeated = self._register(email)
            wrong = self._register(email, "different secure password")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(repeated.json()["status"], "verification_required")
        self.assertGreater(repeated.json()["resend_available_in"], 0)
        self.assertEqual(len(SuccessfulSMTP.instances), sent_after_first)
        self.assertEqual(wrong.status_code, 401, wrong.text)
        self.assertEqual(wrong.json()["detail"], "No se pudo continuar con el registro.")

    def test_unverified_login_returns_verification_required(self) -> None:
        email = self._email("login")
        with patch.object(cloud_main.smtplib, "SMTP", SuccessfulSMTP):
            self.assertEqual(self._register(email).status_code, 200)
            response = self.client.post("/auth/login", json={"email": email, "password": PASSWORD})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "verification_required")
        self.assertNotIn("access_token", response.json())
        self.assertEqual(len(SuccessfulSMTP.instances), 1)

    def test_resend_enforces_cooldown_then_delivers(self) -> None:
        email = self._email("resend")
        with patch.object(cloud_main.smtplib, "SMTP", SuccessfulSMTP):
            registered = self._register(email)
            token = registered.json()["verification_token"]
            too_soon = self.client.post(
                "/auth/resend-email-verification",
                json={"verification_token": token},
            )
            self.assertEqual(too_soon.status_code, 429, too_soon.text)
            user = self._user(email)
            old = (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat(timespec="seconds")
            with connect() as conn:
                conn.execute(
                    "UPDATE email_verification_codes SET last_sent_at = ? WHERE user_id = ? AND invalidated_at IS NULL",
                    (old, user["id"]),
                )
            resent = self.client.post(
                "/auth/resend-email-verification",
                json={"verification_token": token},
            )
        self.assertEqual(resent.status_code, 200, resent.text)
        self.assertEqual(resent.json()["status"], "verification_required")
        self.assertEqual(len(SuccessfulSMTP.instances), 2)


if __name__ == "__main__":
    unittest.main()
