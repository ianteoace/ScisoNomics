from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import json
import unittest
from uuid import UUID
from unittest.mock import patch

import httpx

from modern_app.cloud_backend import test_supabase_auth as fixtures
from modern_app.cloud_backend.test_supabase_auth import SUB, OTHER_SUB, INTERNAL_ID, STAMP, provider_user
from modern_app.cloud_backend.app import db
from modern_app.cloud_backend.app.auth import hash_password, create_access_token


class BootstrapTests(unittest.TestCase):
    # Reuse only fixture methods, not the previous suite's inherited test cases.
    setUp = fixtures.DualAuthTests.setUp
    insert_user = fixtures.DualAuthTests.insert_user
    provider_id_for = fixtures.DualAuthTests.provider_id_for
    assert_response_error = fixtures.DualAuthTests.assert_response_error

    def bootstrap(self, body=None, token="test-supabase-token"):
        return self.client.post("/auth/supabase/bootstrap", json=body or {}, headers={"Authorization": f"Bearer {token}"})

    def test_new_internal_user_has_no_password_and_distinct_id(self):
        self.get.return_value = httpx.Response(200, json=provider_user(
            email=" NEW@Example.COM ", user_metadata={"display_name": "  Nueva\n Cuenta  ", "plan": "premium", "user_id": SUB}))
        response = self.bootstrap()
        self.assertEqual(response.status_code, 200, response.text)
        user = response.json()
        UUID(user["id"])
        self.assertNotEqual(user["id"], SUB)
        self.assertEqual(user["email"], "new@example.com")
        self.assertEqual(user["display_name"], "Nueva Cuenta")
        with db.connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
            self.assertEqual(row["password_hash"], "")
            self.assertEqual(row["password_auth_enabled"], 0)
            self.assertEqual(row["auth_provider"], "supabase")
            self.assertEqual(row["auth_provider_id"], SUB)
            self.assertEqual(row["email_verified"], 1)
            self.assertEqual(row["email_verified_at"], STAMP)
            self.assertEqual(row["plan"], "free")
            self.assertEqual(row["subscription_status"], "active")
            self.assertTrue(row["device_key_namespace"])
        login = self.client.post("/auth/login", json={"email": user["email"], "password": "anything"})
        self.assertEqual(login.status_code, 401)

    def test_idempotent_bootstrap_keeps_identity_even_after_email_change(self):
        first = self.bootstrap().json()
        self.get.return_value = httpx.Response(200, json=provider_user(email="new-email@example.com"))
        second = self.bootstrap()
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json(), first)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM security_audit_log").fetchone()["n"], 1)

    def test_link_preserves_legacy_password_verification_and_plan(self):
        self.insert_user(email=" LEGACY@Example.COM ", verified=0)
        password = hash_password("my real legacy password")
        with db.connect() as conn:
            conn.execute("UPDATE users SET password_hash = ?, plan = 'premium' WHERE id = ?", (password, INTERNAL_ID))
        response = self.bootstrap()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], INTERNAL_ID)
        with db.connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()
            self.assertEqual(row["password_hash"], password)
            self.assertEqual(row["password_auth_enabled"], 1)
            self.assertEqual(row["email_verified"], 0)
            self.assertEqual(row["plan"], "premium")

    def test_email_already_linked_to_other_subject_is_409(self):
        self.insert_user(provider_id=OTHER_SUB)
        self.assert_response_error(self.bootstrap(), 409, "auth_provider_conflict")
        self.assertEqual(self.provider_id_for(), OTHER_SUB)

    def test_ambiguous_normalized_email_is_409(self):
        self.insert_user()
        self.insert_user(user_id="second", email=" Legacy@Example.com ")
        self.assert_response_error(self.bootstrap(), 409, "auth_email_ambiguous")
        self.assertIsNone(self.provider_id_for())

    def test_existing_subject_never_moves_to_another_owner(self):
        self.insert_user(user_id="subject-owner", email="old@example.com", provider_id=SUB)
        self.insert_user()
        response = self.bootstrap()
        self.assertEqual(response.json()["id"], "subject-owner")
        self.assertIsNone(self.provider_id_for())

    def test_body_cannot_supply_any_identity_or_privilege(self):
        for name in ("user_id", "email", "auth_provider_id", "plan", "display_name"):
            response = self.bootstrap({name: "client-value"})
            self.assertEqual(response.status_code, 422, response.text)
        self.get.assert_not_called()

    def test_invalid_missing_legacy_and_unconfirmed_tokens_cannot_bootstrap(self):
        self.get.return_value = httpx.Response(401, json={})
        self.assert_response_error(self.bootstrap(), 401, "invalid_supabase_token")
        self.assertEqual(self.bootstrap(token=create_access_token(INTERNAL_ID)).status_code, 401)
        self.assertEqual(self.client.post("/auth/supabase/bootstrap", json={}).status_code, 401)
        self.get.return_value = httpx.Response(200, json=provider_user(email_confirmed_at=None, user_metadata={"email_verified": True}))
        self.assert_response_error(self.bootstrap(), 403, "email_verification_required")
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"], 0)

    def test_audit_contains_no_token_email_or_metadata(self):
        with self.assertLogs("scisonomics.cloud.auth", level="INFO") as captured:
            user = self.bootstrap().json()
        with db.connect() as conn:
            entries = [dict(row) for row in conn.execute("SELECT * FROM security_audit_log").fetchall()]
        text = json.dumps(entries) + " ".join(captured.output)
        self.assertNotIn("legacy@example.com", text)
        self.assertNotIn("test-supabase-token", text)
        self.assertNotIn(SUB, text)
        self.assertEqual(entries[0]["event_type"], "supabase_account_created")
        self.assertEqual(entries[0]["target_id"], user["id"])

    def test_simultaneous_sqlite_bootstrap_has_one_internal_owner(self):
        barrier = Barrier(4)
        def action(_):
            barrier.wait(timeout=10)
            return self.bootstrap()
        with ThreadPoolExecutor(max_workers=4) as pool:
            responses = list(pool.map(action, range(4)))
        self.assertTrue(all(response.status_code == 200 for response in responses), [r.text for r in responses])
        self.assertEqual(len({r.json()["id"] for r in responses}), 1)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"], 1)

    def test_additive_schema_is_idempotent_and_keeps_existing_password(self):
        self.insert_user()
        db.init_db()
        db.init_db()
        with db.connect() as conn:
            row = conn.execute("SELECT id, password_hash, password_auth_enabled FROM users").fetchone()
            self.assertEqual(row["id"], INTERNAL_ID)
            self.assertEqual(row["password_hash"], "test-only-unused-hash")
            self.assertEqual(row["password_auth_enabled"], 1)

    def test_competing_subjects_for_same_email_create_one_account_and_one_conflict(self):
        barrier = Barrier(2)
        def remote(_url, **kwargs):
            token = kwargs["headers"]["Authorization"]
            return httpx.Response(200, json=provider_user(id=SUB if token.endswith("one") else OTHER_SUB))
        self.get.side_effect = remote
        def action(token):
            barrier.wait(timeout=10)
            return self.bootstrap(token=token)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(action, ["one", "two"]))
        self.assertEqual(sorted(r.status_code for r in responses), [200, 409])
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"], 1)

    def test_user_creation_and_audit_are_one_transaction(self):
        with patch("modern_app.cloud_backend.app.supabase_bootstrap.audit_link", side_effect=RuntimeError("audit unavailable")):
            with self.assertRaises(RuntimeError):
                self.bootstrap()
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"], 0)


if __name__ == "__main__":
    unittest.main()
