from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import httpx
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


class FakeResendClient:
    calls: list[dict] = []
    timeouts: list[httpx.Timeout] = []
    status_code = 200
    response_body: object = {"id": "resend-message-test-id"}
    transport_error: str | None = None

    def __init__(self, *, timeout: httpx.Timeout, follow_redirects: bool) -> None:
        self.timeout = timeout
        self.follow_redirects = follow_redirects
        type(self).timeouts.append(timeout)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def post(self, url: str, *, headers: dict[str, str], json: dict) -> httpx.Response:
        request = httpx.Request("POST", url)
        type(self).calls.append({"url": url, "headers": dict(headers), "json": dict(json)})
        if self.transport_error == "timeout":
            raise httpx.ReadTimeout("simulated timeout", request=request)
        if self.transport_error == "connection":
            raise httpx.ConnectError("simulated connection failure", request=request)
        if self.response_body == "invalid-json":
            return httpx.Response(self.status_code, content=b"not-json", request=request)
        return httpx.Response(self.status_code, json=self.response_body, request=request)

    @classmethod
    def reset(cls) -> None:
        cls.calls.clear()
        cls.timeouts.clear()
        cls.status_code = 200
        cls.response_body = {"id": "resend-message-test-id"}
        cls.transport_error = None


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
        FakeResendClient.reset()
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

    def _use_resend(self) -> None:
        os.environ.update(
            {
                "SCISONOMICS_EMAIL_PROVIDER": "resend",
                "SCISONOMICS_RESEND_API_KEY": "test-only-resend-key",
                "SCISONOMICS_RESEND_API_URL": "https://api.resend.com/emails",
                "SCISONOMICS_EMAIL_FROM": "ScisoNomics <no-reply@scisoftware.com.ar>",
                "SCISONOMICS_EMAIL_REPLY_TO": "scisoftwareco@gmail.com",
                "SCISONOMICS_RESEND_CONNECT_TIMEOUT_SECONDS": "4",
                "SCISONOMICS_RESEND_WRITE_TIMEOUT_SECONDS": "4",
                "SCISONOMICS_RESEND_READ_TIMEOUT_SECONDS": "9",
                "SCISONOMICS_RESEND_TOTAL_TIMEOUT_SECONDS": "18",
            }
        )

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

    def test_resend_https_success_uses_expected_payload_and_timeouts(self) -> None:
        self._use_resend()
        email = self._email("resend-success")
        with patch.object(cloud_main.httpx, "Client", FakeResendClient):
            response = self._register(email)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "verification_required")
        self.assertEqual(len(FakeResendClient.calls), 1)
        call = FakeResendClient.calls[0]
        self.assertEqual(call["url"], "https://api.resend.com/emails")
        self.assertEqual(call["json"]["from"], "ScisoNomics <no-reply@scisoftware.com.ar>")
        self.assertEqual(call["json"]["to"], [email])
        self.assertEqual(call["json"]["reply_to"], "scisoftwareco@gmail.com")
        self.assertIn("html", call["json"])
        self.assertIn("text", call["json"])
        self.assertLessEqual(len(call["headers"]["Idempotency-Key"]), 256)
        timeout = FakeResendClient.timeouts[0]
        self.assertEqual(timeout.connect, 4.0)
        self.assertEqual(timeout.write, 4.0)
        self.assertEqual(timeout.read, 9.0)
        self.assertLessEqual(timeout.pool + timeout.connect + timeout.write + timeout.read, 18)

    def test_resend_success_returns_provider_id(self) -> None:
        self._use_resend()
        with patch.object(cloud_main.httpx, "Client", FakeResendClient):
            status, provider_id = cloud_main.send_verification_email(
                self._email("resend-id"),
                "123456",
                idempotency_key="stable-test-challenge",
            )
        self.assertEqual(status, 200)
        self.assertEqual(provider_id, "resend-message-test-id")

    def test_resend_missing_api_key_is_configuration_failure(self) -> None:
        self._use_resend()
        os.environ["SCISONOMICS_RESEND_API_KEY"] = ""
        email = self._email("resend-config")
        with patch.object(cloud_main.httpx, "Client", FakeResendClient):
            response = self._register(email)
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["detail"]["code"], "email_delivery_failed")
        self.assertEqual(self._user(email)["email_verified"], 0)
        self.assertEqual(FakeResendClient.calls, [])

    def test_resend_http_statuses_are_classified_internally(self) -> None:
        self._use_resend()
        cases = {
            400: "rejected",
            401: "authentication",
            403: "authentication",
            422: "rejected",
            429: "rate_limited",
            500: "provider_unavailable",
            503: "provider_unavailable",
        }
        with patch.object(cloud_main.httpx, "Client", FakeResendClient):
            for status, expected_kind in cases.items():
                with self.subTest(status=status):
                    FakeResendClient.status_code = status
                    FakeResendClient.response_body = {"message": "simulated provider response"}
                    with self.assertRaises(cloud_main.EmailDeliveryError) as raised:
                        cloud_main.send_verification_email(
                            self._email("status"),
                            "123456",
                            idempotency_key="stable-test-challenge",
                        )
                    self.assertEqual(raised.exception.kind, expected_kind)
                    self.assertEqual(raised.exception.status_code, status)

    def test_resend_timeout_connection_and_invalid_response_are_classified(self) -> None:
        self._use_resend()
        with patch.object(cloud_main.httpx, "Client", FakeResendClient):
            for transport_error, expected_kind in (("timeout", "timeout"), ("connection", "connection")):
                with self.subTest(transport_error=transport_error):
                    FakeResendClient.transport_error = transport_error
                    with self.assertRaises(cloud_main.EmailDeliveryError) as raised:
                        cloud_main.send_verification_email(
                            self._email("transport"),
                            "123456",
                            idempotency_key="stable-test-challenge",
                        )
                    self.assertEqual(raised.exception.kind, expected_kind)
            FakeResendClient.transport_error = None
            FakeResendClient.status_code = 200
            FakeResendClient.response_body = "invalid-json"
            with self.assertRaises(cloud_main.EmailDeliveryError) as raised:
                cloud_main.send_verification_email(
                    self._email("protocol"),
                    "123456",
                    idempotency_key="stable-test-challenge",
                )
            self.assertEqual(raised.exception.kind, "protocol")

    def test_resend_idempotency_key_is_stable_for_same_challenge(self) -> None:
        self._use_resend()
        first = cloud_main._verification_delivery_idempotency_key(
            user_id="user-test",
            created_at="2026-07-20T12:00:00+00:00",
            code_hash="hashed-code-test",
        )
        second = cloud_main._verification_delivery_idempotency_key(
            user_id="user-test",
            created_at="2026-07-20T12:00:00+00:00",
            code_hash="hashed-code-test",
        )
        next_challenge = cloud_main._verification_delivery_idempotency_key(
            user_id="user-test",
            created_at="2026-07-20T12:01:00+00:00",
            code_hash="hashed-code-test",
        )
        self.assertEqual(first, second)
        self.assertNotEqual(first, next_challenge)
        self.assertLessEqual(len(first), 256)

    def test_resend_failure_preserves_account_and_later_resend_recovers(self) -> None:
        self._use_resend()
        email = self._email("resend-recovery")
        FakeResendClient.status_code = 503
        FakeResendClient.response_body = {"message": "simulated unavailable"}
        with patch.object(cloud_main.httpx, "Client", FakeResendClient):
            failed = self._register(email)
            first_key = FakeResendClient.calls[-1]["headers"]["Idempotency-Key"]
            self.assertEqual(failed.status_code, 503, failed.text)
            self.assertEqual(failed.json()["detail"]["code"], "email_delivery_failed")
            self.assertEqual(self._user(email)["email_verified"], 0)
            FakeResendClient.status_code = 200
            FakeResendClient.response_body = {"id": "resend-recovery-id"}
            recovered = self.client.post(
                "/auth/resend-email-verification",
                json={"verification_token": failed.json()["detail"]["verification"]["verification_token"]},
            )
        self.assertEqual(recovered.status_code, 200, recovered.text)
        self.assertEqual(recovered.json()["status"], "verification_required")
        second_key = FakeResendClient.calls[-1]["headers"]["Idempotency-Key"]
        self.assertNotEqual(first_key, second_key)


if __name__ == "__main__":
    unittest.main()
