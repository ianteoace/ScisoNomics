from __future__ import annotations

from contextlib import closing, contextmanager
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from modern_app.cloud_backend.app import db as cloud_db, supabase_auth
from modern_app.cloud_backend.app.auth import create_access_token, create_email_verification_token


SUB = "11111111-1111-4111-8111-111111111111"
OTHER_SUB = "22222222-2222-4222-8222-222222222222"
INTERNAL_ID = "sciso-internal-42"
STAMP = "2026-01-01T00:00:00+00:00"
AUTH_ENV = {
    "SCISONOMICS_ENV": "development",
    "SCISONOMICS_JWT_SECRET": "isolated-dual-auth-test-secret",
    "SCISONOMICS_ALLOWED_ORIGINS": "http://127.0.0.1:3000",
    "SCISONOMICS_SUPABASE_URL": "https://auth-test.supabase.co",
    "SCISONOMICS_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test_only",
}


def provider_user(**overrides) -> dict:
    return {"id": SUB, "email": "legacy@example.com", "email_confirmed_at": STAMP, **overrides}


class SupabaseTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        env = patch.dict(os.environ, AUTH_ENV)
        env.start()
        self.addCleanup(env.stop)
        transport = patch.object(supabase_auth.httpx, "get", return_value=httpx.Response(200, json=provider_user()))
        self.get = transport.start()
        self.addCleanup(transport.stop)

    def assert_auth_error(self, code: str, status: int) -> None:
        with self.assertRaises(supabase_auth.SupabaseAuthError) as raised:
            supabase_auth.verify_supabase_access_token("test-access-token")
        self.assertEqual(raised.exception.code, code)
        self.assertEqual(raised.exception.status_code, status)
        self.assertNotIn("test-access-token", str(raised.exception))

    def test_remote_validation_uses_publishable_key_and_bearer(self) -> None:
        self.get.return_value = httpx.Response(200, json=provider_user(email="  LEGACY@Example.COM  "))
        identity = supabase_auth.verify_supabase_access_token("test-access-token")
        self.assertEqual(identity["sub"], SUB)
        self.assertEqual(identity["email"], "legacy@example.com")
        url = self.get.call_args.args[0]
        options = self.get.call_args.kwargs
        self.assertEqual(url, "https://auth-test.supabase.co/auth/v1/user")
        self.assertEqual(options["headers"]["apikey"], AUTH_ENV["SCISONOMICS_SUPABASE_PUBLISHABLE_KEY"])
        self.assertEqual(options["headers"]["Authorization"], "Bearer test-access-token")
        self.assertFalse(options["follow_redirects"])
        self.assertGreater(options["timeout"], 0)

    def test_invalid_tokens_are_unauthorized(self) -> None:
        for status in (400, 401, 403, 422):
            with self.subTest(status=status):
                self.get.return_value = httpx.Response(status, json={"message": "test-access-token"})
                self.assert_auth_error("invalid_supabase_token", 401)

    def test_network_errors_are_retryable_without_token_in_error(self) -> None:
        for error in (httpx.ReadTimeout, httpx.ConnectError):
            with self.subTest(error=error):
                self.get.side_effect = error("test-access-token")
                self.assert_auth_error("supabase_auth_unavailable", 503)

    def test_outages_rate_limits_and_redirects_are_not_invalid_sessions(self) -> None:
        for status in (429, 500, 503, 302, 404):
            with self.subTest(status=status):
                self.get.return_value = httpx.Response(status, headers={"Location": "https://elsewhere.invalid"})
                self.assert_auth_error("supabase_auth_unavailable", 503)

    def test_missing_and_partial_configuration_is_explicit(self) -> None:
        for url, key in (("", ""), (AUTH_ENV["SCISONOMICS_SUPABASE_URL"], ""), ("", AUTH_ENV["SCISONOMICS_SUPABASE_PUBLISHABLE_KEY"])):
            with self.subTest(url=url, key_present=bool(key)), patch.dict(os.environ, {
                "SCISONOMICS_SUPABASE_URL": url, "SCISONOMICS_SUPABASE_PUBLISHABLE_KEY": key,
            }):
                self.assert_auth_error("supabase_auth_not_configured", 503)
        self.get.assert_not_called()

    def test_insecure_configuration_and_privileged_keys_are_rejected(self) -> None:
        cases = (
            {"SCISONOMICS_SUPABASE_URL": "http://auth-test.supabase.co"},
            {"SCISONOMICS_SUPABASE_URL": "https://auth-test.supabase.co?query=1"},
            {"SCISONOMICS_SUPABASE_URL": "https://user:password@auth-test.supabase.co"},
            {"SCISONOMICS_SUPABASE_URL": "https://auth-test.supabase.co:bad-port"},
            {"SCISONOMICS_SUPABASE_PUBLISHABLE_KEY": "sb_secret_test_only"},
            {"SCISONOMICS_SUPABASE_PUBLISHABLE_KEY": "service_role"},
            {"SCISONOMICS_ENV": "production", "SCISONOMICS_SUPABASE_URL": "http://127.0.0.1:54321"},
        )
        for config in cases:
            with self.subTest(config=config), patch.dict(os.environ, config):
                self.assert_auth_error("supabase_auth_invalid_config", 503)
        self.get.assert_not_called()

    def test_local_supabase_http_is_supported_in_development(self) -> None:
        with patch.dict(os.environ, {"SCISONOMICS_SUPABASE_URL": "http://127.0.0.1:54321"}):
            self.assertEqual(supabase_auth.verify_supabase_access_token("test-access-token")["sub"], SUB)

    def test_malformed_response_is_explicit(self) -> None:
        for response in (httpx.Response(200, content=b"not-json"), httpx.Response(200, json=[]), httpx.Response(200, json=None)):
            with self.subTest(response=response):
                self.get.return_value = response
                self.assert_auth_error("invalid_supabase_response", 502)

    def test_missing_identity_email_and_anonymous_users_are_rejected(self) -> None:
        for overrides in ({"id": None}, {"id": "not-a-uuid"}, {"email": None}, {"email": "invalid"}, {"is_anonymous": True}):
            with self.subTest(overrides=overrides):
                self.get.return_value = httpx.Response(200, json=provider_user(**overrides))
                self.assert_auth_error("invalid_supabase_user", 401)

    def test_confirmation_only_uses_server_email_confirmed_at(self) -> None:
        for confirmed_at in (None, "", False):
            with self.subTest(confirmed_at=confirmed_at):
                self.get.return_value = httpx.Response(200, json=provider_user(
                    email_confirmed_at=confirmed_at, confirmed_at=STAMP,
                    user_metadata={"email_verified": True},
                ))
                self.assert_auth_error("email_verification_required", 403)


class DualAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="scisonomics-dual-auth-")
        self.addCleanup(temp.cleanup)
        self.db_path = Path(temp.name) / "cloud.db"
        env = patch.dict(os.environ, {
            **AUTH_ENV,
            "SCISONOMICS_CLOUD_DATABASE_URL": f"sqlite:///{self.db_path.as_posix()}",
            "DATABASE_URL": "",
        })
        env.start()
        self.addCleanup(env.stop)
        from modern_app.cloud_backend.app import main
        self.main = main
        cloud_db.init_db()
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        transport = patch.object(supabase_auth.httpx, "get", return_value=httpx.Response(200, json=provider_user()))
        self.get = transport.start()
        self.addCleanup(transport.stop)

    def insert_user(self, user_id=INTERNAL_ID, email="legacy@example.com", provider_id=None, verified=1) -> None:
        with cloud_db.connect() as conn:
            conn.execute(
                "INSERT INTO users (id, email, password_hash, email_verified, auth_provider_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (user_id, email, "test-only-unused-hash", verified, provider_id, STAMP, STAMP),
            )

    def me(self, token="test-supabase-token") -> httpx.Response:
        return self.client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})

    def provider_id_for(self, user_id=INTERNAL_ID):
        with cloud_db.connect() as conn:
            return conn.execute("SELECT auth_provider_id FROM users WHERE id = ?", (user_id,)).fetchone()["auth_provider_id"]

    def assert_response_error(self, response, status, code) -> None:
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(response.json()["detail"]["code"], code)

    def test_legacy_token_still_works_and_does_not_call_supabase(self) -> None:
        self.insert_user(provider_id=SUB)
        response = self.me(create_access_token(INTERNAL_ID))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], INTERNAL_ID)
        self.get.assert_not_called()

    def test_legacy_email_verification_remains_required(self) -> None:
        self.insert_user(verified=0)
        self.assert_response_error(self.me(create_access_token(INTERNAL_ID)), 403, "email_verification_required")
        self.get.assert_not_called()

    def test_valid_legacy_with_wrong_type_or_missing_user_does_not_fall_back(self) -> None:
        self.insert_user()
        for token in (create_email_verification_token(INTERNAL_ID), create_access_token("missing-internal-user")):
            with self.subTest(token_type="legacy"):
                self.assertEqual(self.me(token).status_code, 401)
        self.get.assert_not_called()

    def test_linked_supabase_token_returns_internal_id_without_legacy_verification(self) -> None:
        self.insert_user(provider_id=SUB, verified=0)
        response = self.me()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], INTERNAL_ID)
        self.assertNotEqual(response.json()["id"], SUB)
        self.assertNotIn("auth_provider_id", response.json())
        with cloud_db.connect() as conn:
            self.assertEqual(conn.execute("SELECT email_verified FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["email_verified"], 0)

    def test_first_email_link_is_normalized_and_idempotent(self) -> None:
        self.insert_user(email="  LEGACY@Example.COM  ", verified=0)
        self.get.return_value = httpx.Response(200, json=provider_user(email="  Legacy@EXAMPLE.com  "))
        for _ in range(2):
            response = self.me()
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["id"], INTERNAL_ID)
        self.assertEqual(self.provider_id_for(), SUB)
        # The external confirmation does not silently verify the legacy account.
        self.assert_response_error(self.me(create_access_token(INTERNAL_ID)), 403, "email_verification_required")

    def test_empty_provider_id_can_be_linked(self) -> None:
        self.insert_user(provider_id="")
        self.assertEqual(self.me().status_code, 200)
        self.assertEqual(self.provider_id_for(), SUB)

    def test_email_account_already_linked_to_other_subject_is_conflict(self) -> None:
        self.insert_user(provider_id=OTHER_SUB)
        self.assert_response_error(self.me(), 409, "auth_provider_conflict")
        self.assertEqual(self.provider_id_for(), OTHER_SUB)

    def test_subject_belongs_to_other_user_does_not_reassign_email_owner(self) -> None:
        self.insert_user()
        self.insert_user(user_id="already-linked-user", email="old-email@example.com", provider_id=SUB)
        response = self.me()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "already-linked-user")
        self.assertIsNone(self.provider_id_for())
        self.assertEqual(self.provider_id_for("already-linked-user"), SUB)

    def test_ambiguous_normalized_email_requires_manual_resolution(self) -> None:
        self.insert_user()
        self.insert_user(user_id="duplicate-email-user", email="Legacy@Example.com")
        self.assert_response_error(self.me(), 409, "auth_email_ambiguous")
        self.assertIsNone(self.provider_id_for())

    def test_no_internal_account_does_not_create_one_or_match_id_to_sub(self) -> None:
        self.insert_user(user_id=SUB, email="someone-else@example.com")
        self.assert_response_error(self.me(), 403, "internal_account_required")
        with cloud_db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"], 1)
        self.assertIsNone(self.provider_id_for(SUB))

    def test_invalid_supabase_token_is_unauthorized_without_link(self) -> None:
        self.insert_user()
        self.get.return_value = httpx.Response(401, json={"message": "test-supabase-token"})
        response = self.me()
        self.assert_response_error(response, 401, "invalid_supabase_token")
        self.assertNotIn("test-supabase-token", response.text)
        self.assertIsNone(self.provider_id_for())

    def test_unconfirmed_supabase_email_cannot_access_or_link(self) -> None:
        self.insert_user()
        self.get.return_value = httpx.Response(200, json=provider_user(email_confirmed_at=None, user_metadata={"email_verified": True}))
        self.assert_response_error(self.me(), 403, "email_verification_required")
        self.assertIsNone(self.provider_id_for())
        with cloud_db.connect() as conn:
            conn.execute("UPDATE users SET auth_provider_id = ? WHERE id = ?", (SUB, INTERNAL_ID))
        self.assert_response_error(self.me(), 403, "email_verification_required")

    def test_supabase_disabled_preserves_legacy_and_rejects_external_token(self) -> None:
        self.insert_user()
        with patch.dict(os.environ, {"SCISONOMICS_SUPABASE_URL": "", "SCISONOMICS_SUPABASE_PUBLISHABLE_KEY": ""}):
            self.assertEqual(self.me(create_access_token(INTERNAL_ID)).status_code, 200)
            self.assertEqual(self.me().status_code, 401)
        self.get.assert_not_called()

    def test_partial_config_reports_503_but_valid_legacy_still_works(self) -> None:
        self.insert_user()
        with patch.dict(os.environ, {"SCISONOMICS_SUPABASE_PUBLISHABLE_KEY": ""}):
            self.assertEqual(self.me(create_access_token(INTERNAL_ID)).status_code, 200)
            self.assert_response_error(self.me(), 503, "supabase_auth_not_configured")
        self.get.assert_not_called()

    def test_supabase_outage_does_not_link_or_invalidate_legacy(self) -> None:
        self.insert_user()
        self.get.side_effect = httpx.ConnectError("test-supabase-token")
        response = self.me()
        self.assert_response_error(response, 503, "supabase_auth_unavailable")
        self.assertNotIn("test-supabase-token", response.text)
        self.assertIsNone(self.provider_id_for())
        self.assertEqual(self.me(create_access_token(INTERNAL_ID)).status_code, 200)

    @contextmanager
    def interleave_link(self, action):
        @contextmanager
        def interleaved_connect():
            with cloud_db.connect() as conn:
                execute = conn.execute

                def execute_with_race(sql, params=()):
                    if sql.startswith("UPDATE users SET auth_provider_id = ?"):
                        action()
                    return execute(sql, params)

                with patch.object(conn, "execute", side_effect=execute_with_race):
                    yield conn

        with patch.object(self.main, "connect", side_effect=interleaved_connect):
            yield

    def test_concurrent_subject_assignment_to_other_user_is_conflict(self) -> None:
        self.insert_user()
        self.insert_user(user_id="concurrent-user", email="concurrent@example.com")

        def race():
            with cloud_db.connect() as conn:
                conn.execute("UPDATE users SET auth_provider_id = ? WHERE id = ?", (SUB, "concurrent-user"))

        with self.interleave_link(race):
            self.assert_response_error(self.me(), 409, "auth_provider_conflict")
        self.assertIsNone(self.provider_id_for())
        self.assertEqual(self.provider_id_for("concurrent-user"), SUB)

    def test_concurrent_link_to_different_subject_is_not_overwritten(self) -> None:
        self.insert_user()

        def race():
            with cloud_db.connect() as conn:
                conn.execute("UPDATE users SET auth_provider_id = ? WHERE id = ?", (OTHER_SUB, INTERNAL_ID))

        with self.interleave_link(race):
            self.assert_response_error(self.me(), 409, "auth_provider_conflict")
        self.assertEqual(self.provider_id_for(), OTHER_SUB)

    def test_concurrent_link_to_same_subject_is_idempotent(self) -> None:
        self.insert_user()

        def race():
            with cloud_db.connect() as conn:
                conn.execute("UPDATE users SET auth_provider_id = ? WHERE id = ?", (SUB, INTERNAL_ID))

        with self.interleave_link(race):
            response = self.me()
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["id"], INTERNAL_ID)

    def test_migration_preserves_existing_ids_and_financial_foreign_keys(self) -> None:
        # Use an actual pre-migration schema and a dependent financial row.
        legacy_path = self.db_path.with_name("legacy.db")
        with closing(sqlite3.connect(legacy_path)) as conn, conn:
            conn.execute("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
            conn.execute("INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", (INTERNAL_ID, "legacy@example.com", "test-only-unused-hash", STAMP, STAMP))
            conn.execute("CREATE TABLE existing_financial_records (id INTEGER PRIMARY KEY, user_id TEXT REFERENCES users(id), amount INTEGER)")
            conn.execute("INSERT INTO existing_financial_records (user_id, amount) VALUES (?, 12345)", (INTERNAL_ID,))
            before = conn.execute("PRAGMA foreign_key_list(existing_financial_records)").fetchall()
        with patch.dict(os.environ, {"SCISONOMICS_CLOUD_DATABASE_URL": f"sqlite:///{legacy_path.as_posix()}"}):
            cloud_db.init_db()
            cloud_db.init_db()
            self.assertIsNone(self.provider_id_for())
            response = self.me()
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["id"], INTERNAL_ID)
            with cloud_db.connect() as conn:
                row = conn.execute("SELECT user_id, amount FROM existing_financial_records").fetchone()
                self.assertEqual(row["user_id"], INTERNAL_ID)
                self.assertEqual(row["amount"], 12345)
                after = [tuple(row) for row in conn.execute("PRAGMA foreign_key_list(existing_financial_records)").fetchall()]
                self.assertEqual(before, after)

    def test_unique_index_allows_null_and_empty_but_rejects_duplicate_subject(self) -> None:
        self.insert_user(provider_id=SUB)
        for index, provider_id in enumerate((None, None, "", "")):
            self.insert_user(user_id=f"unlinked-{index}", email=f"unlinked-{index}@example.com", provider_id=provider_id)
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_user(user_id="duplicate-subject", email="duplicate-subject@example.com", provider_id=SUB)
        self.assertEqual(self.provider_id_for(), SUB)


if __name__ == "__main__":
    unittest.main()
