from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import os
import unittest
from threading import Barrier
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from modern_app.cloud_backend import test_supabase_auth as fixtures
from modern_app.cloud_backend.app import db, security


class GoogleLegacyAuthTests(unittest.TestCase):
    insert_user = fixtures.DualAuthTests.insert_user

    def setUp(self):
        fixtures.DualAuthTests.setUp(self)
        with security._LOCK:
            security._ATTEMPTS.clear()
        env = patch.dict(os.environ, {
            "SCISONOMICS_GOOGLE_CLIENT_ID": "test-client",
            "SCISONOMICS_GOOGLE_CLIENT_SECRET": "test-secret",
            "SCISONOMICS_GOOGLE_REDIRECT_URI": "https://cloud.example.test/auth/google/callback",
        })
        env.start()
        self.addCleanup(env.stop)

    def assert_no_store(self, response):
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertEqual(response.headers.get("pragma"), "no-cache")

    def start(self):
        response = self.client.post("/auth/google/start")
        self.assertEqual(response.status_code, 200, response.text)
        self.assert_no_store(response)
        request_id = response.json()["login_request_id"]
        self.assertRegex(request_id, r"^[A-Za-z0-9_-]{43}$")
        self.assertEqual(parse_qs(urlparse(response.json()["auth_url"]).query)["state"], [request_id])
        return request_id

    def status(self, request_id):
        response = self.client.post("/auth/google/status", json={"login_request_id": request_id})
        self.assertEqual(response.request.url.path, "/auth/google/status")
        self.assertEqual(response.request.url.query, b"")
        self.assertNotIn(request_id, str(response.request.url))
        self.assert_no_store(response)
        return response

    def complete(self):
        request_id = self.start()
        with patch.object(self.main, "_exchange_google_code", return_value={
            "sub": "google-test-sub", "email": "google@example.com",
            "name": "Google Test", "email_verified": True,
        }) as exchange:
            callback = self.client.get("/auth/google/callback", params={"state": request_id, "code": "test-code"})
        self.assertEqual(callback.status_code, 200, callback.text)
        exchange.assert_called_once_with("test-code", "test-client", "test-secret", "https://cloud.example.test/auth/google/callback")
        self.assert_no_store(callback)
        return request_id

    def test_pending_post_and_random_request_id_with_current_ttl(self):
        with patch.object(self.main, "datetime", wraps=datetime) as clock:
            clock.now.return_value = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
            first, second = self.start(), self.start()
            self.assertNotEqual(first, second)
            response = self.status(first)
        self.assertEqual(response.json(), {"status": "pending"})
        with db.connect() as conn:
            row = conn.execute("SELECT created_at, expires_at FROM google_login_requests WHERE login_request_id = ?", (first,)).fetchone()
        self.assertEqual(datetime.fromisoformat(row["expires_at"]) - datetime.fromisoformat(row["created_at"]), timedelta(minutes=10))

    def test_completed_post_returns_session_only_once(self):
        request_id = self.complete()
        response = self.status(request_id)
        self.assertEqual(response.json()["status"], "completed")
        self.assertIn("access_token", response.json())
        self.assertIn("refresh_token", response.json())
        consumed = self.status(request_id)
        self.assertEqual(consumed.json()["status"], "consumed")
        self.assertNotIn("access_token", consumed.json())
        self.assertNotIn("refresh_token", consumed.json())
        self.assertNotIn(request_id, consumed.text)

    def test_concurrent_consumption_delivers_only_one_session(self):
        request_id = self.complete()
        barrier = Barrier(2)
        def consume():
            barrier.wait(timeout=10)
            return self.status(request_id).json()
        with patch.object(self.main, "init_db"), ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: consume(), range(2)))
        self.assertEqual(sorted(result["status"] for result in results), ["completed", "consumed"])
        self.assertEqual(sum("refresh_token" in result for result in results), 1)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM cloud_refresh_tokens").fetchone()["n"], 1)

    def test_invalid_request_ids_are_rejected_without_echoing_input(self):
        for value in ("secret-invalid-id", "A" * 42, "A" * 44, "!" * 43, 123, None):
            with self.subTest(value=value):
                response = self.client.post("/auth/google/status", json={"login_request_id": value})
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json(), {"detail": "Solicitud de Google invalida."})
                self.assert_no_store(response)
        for body in ({}, {"login_request_id": "A" * 43, "token": "secret-test-token"}):
            response = self.client.post("/auth/google/status", json=body)
            self.assertEqual(response.status_code, 422)
            self.assertNotIn("secret-test-token", response.text)

    def test_expired_and_unknown_requests_do_not_issue_tokens(self):
        request_id = self.complete()
        expired = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        with db.connect() as conn:
            conn.execute("UPDATE google_login_requests SET expires_at = ? WHERE login_request_id = ?", (expired, request_id))
        for value in (request_id, "A" * 43):
            response = self.status(value)
            self.assertEqual(response.json()["status"], "expired")
            self.assertNotIn(value, response.text)
            self.assertNotIn("refresh_token", response.json())

    def test_callback_rejects_unknown_state_without_exchange(self):
        with patch.object(self.main, "_exchange_google_code") as exchange:
            response = self.client.get("/auth/google/callback", params={"state": "unknown-test-state", "code": "test-code"})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("unknown-test-state", response.text)
        exchange.assert_not_called()
        self.assert_no_store(response)

    def test_legacy_get_is_hidden_deprecated_and_compatible(self):
        request_id = self.complete()
        route = next(route for route in self.main.app.routes if route.path == "/auth/google/status/{login_request_id}")
        self.assertTrue(route.deprecated)
        self.assertFalse(route.include_in_schema)
        paths = self.main.app.openapi()["paths"]
        self.assertNotIn(route.path, paths)
        self.assertIn("post", paths["/auth/google/status"])
        response = self.client.get(f"/auth/google/status/{request_id}")
        self.assertEqual(response.json()["status"], "completed")
        self.assert_no_store(response)
        self.assertEqual(self.status(request_id).json()["status"], "consumed")

    def test_login_and_refresh_sessions_have_no_store(self):
        self.insert_user()
        with patch.object(self.main, "verify_password", return_value=True), patch.object(self.main, "password_needs_rehash", return_value=False):
            login = self.client.post("/auth/login", json={"email": "legacy@example.com", "password": "test-password"})
        self.assertEqual(login.status_code, 200, login.text)
        self.assertIn("access_token", login.json())
        self.assert_no_store(login)
        refresh = self.client.post("/auth/refresh", json={"refresh_token": login.json()["refresh_token"]})
        self.assertEqual(refresh.status_code, 200, refresh.text)
        self.assertIn("refresh_token", refresh.json())
        self.assert_no_store(refresh)

    def test_verification_required_and_successful_verification_have_no_store(self):
        with patch.object(self.main, "_reject_breached_password"), patch.object(self.main, "send_verification_email", return_value=(200, "test-delivery")) as send:
            registered = self.client.post("/auth/register", json={"email": "new@example.com", "password": "correct horse battery staple"})
        self.assertEqual(registered.status_code, 200, registered.text)
        self.assertIn("verification_token", registered.json())
        self.assert_no_store(registered)
        login = self.client.post("/auth/login", json={"email": "new@example.com", "password": "correct horse battery staple"})
        self.assertEqual(login.json()["status"], "verification_required")
        self.assert_no_store(login)
        verified = self.client.post("/auth/verify-email", json={"verification_token": registered.json()["verification_token"], "code": send.call_args.args[1]})
        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertIn("access_token", verified.json())
        self.assert_no_store(verified)

    def test_error_with_verification_token_also_has_no_store(self):
        with patch.object(self.main, "_reject_breached_password"), patch.object(self.main, "send_verification_email", side_effect=self.main.EmailDeliveryError("timeout")):
            response = self.client.post("/auth/register", json={"email": "failed@example.com", "password": "correct horse battery staple"})
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("verification_token", response.json()["detail"]["verification"])
        self.assert_no_store(response)

    def test_resend_verification_token_has_no_store(self):
        with patch.object(self.main, "_reject_breached_password"), patch.object(self.main, "send_verification_email", return_value=(200, "test-delivery")):
            registered = self.client.post("/auth/register", json={"email": "resend@example.com", "password": "correct horse battery staple"})
            self.assertEqual(registered.status_code, 200, registered.text)
            old = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
            with db.connect() as conn:
                conn.execute("UPDATE email_verification_codes SET last_sent_at = ?", (old,))
            response = self.client.post("/auth/resend-email-verification", json={"verification_token": registered.json()["verification_token"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("verification_token", response.json())
        self.assert_no_store(response)

    def test_public_health_response_is_not_modified_by_auth_no_store(self):
        self.assertNotIn("cache-control", self.client.get("/health").headers)

    def test_auth_validation_errors_do_not_echo_tokens(self):
        token = "short-secret-test-token"
        for path, body in (
            ("/auth/refresh", {"refresh_token": token}),
            ("/auth/verify-email", {"verification_token": token, "code": "123456"}),
            ("/auth/resend-email-verification", {"verification_token": token}),
        ):
            with self.subTest(path=path):
                response = self.client.post(path, json=body)
                self.assertEqual(response.status_code, 422)
                self.assertNotIn(token, response.text)
                self.assert_no_store(response)


if __name__ == "__main__":
    unittest.main()
