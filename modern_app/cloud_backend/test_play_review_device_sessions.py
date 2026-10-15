"""Review enrollment exception: temporary SQLite, mocked provider/mail, no real accounts."""
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from modern_app.cloud_backend import test_device_sessions as devices, test_supabase_auth as fixtures
from modern_app.cloud_backend.app import db, device_sessions, main
from modern_app.cloud_backend.app.auth import decode_access_token
from modern_app.cloud_backend.app.security import _ATTEMPTS


ENV = "SCISONOMICS_PLAY_REVIEW_USER_ID"


class PlayReviewConfigurationTests(unittest.TestCase):
    def test_absent_empty_and_exact_canonical_uuid(self):
        review_id = str(uuid4())
        with patch.dict(os.environ):
            os.environ.pop(ENV, None)
            self.assertFalse(device_sessions.is_play_review_user(review_id))
        for configured in ("", "   ", str(uuid4())):
            with self.subTest(configured=configured), patch.dict(os.environ, {ENV: configured}):
                self.assertFalse(device_sessions.is_play_review_user(review_id))
        with patch.dict(os.environ, {ENV: f"  {review_id}  "}):
            self.assertTrue(device_sessions.is_play_review_user(review_id))
            self.assertFalse(device_sessions.is_play_review_user(review_id.upper()))
            self.assertFalse(device_sessions.is_play_review_user(f" {review_id}"))

    def test_invalid_configuration_fails_closed_without_logging_value(self):
        review_id = str(uuid4())
        for configured in ("not-a-uuid", str(uuid4()).upper(), uuid4().hex,
                           "{" + review_id + "}", "00000000-0000-0000-0000-000000000000"):
            with self.subTest(configured=configured), patch.dict(os.environ, {ENV: configured}):
                with self.assertLogs("scisonomics.cloud.devices", level="WARNING") as logs:
                    self.assertFalse(device_sessions.is_play_review_user(configured))
                self.assertNotIn(configured, "\n".join(logs.output))


class PlayReviewDeviceSessionsTests(unittest.TestCase):
    insert_user = fixtures.DualAuthTests.insert_user
    get_context = devices.DeviceSessionsTests.get_context
    post = devices.DeviceSessionsTests.post
    identity = devices.DeviceSessionsTests.identity
    start = devices.DeviceSessionsTests.start
    sign = devices.DeviceSessionsTests.sign
    refresh_body = devices.DeviceSessionsTests.refresh_body

    def setUp(self):
        fixtures.DualAuthTests.setUp(self)
        env = patch.dict(os.environ, {ENV: "", "SCISONOMICS_DEVICE_VERIFICATION_MODE": "enforce",
                                     "SCISONOMICS_EMAIL_PROVIDER": "memory"})
        env.start()
        self.addCleanup(env.stop)
        _ATTEMPTS.clear()
        self.addCleanup(_ATTEMPTS.clear)
        main._DEV_EMAIL_OUTBOX.clear()
        self.addCleanup(main._DEV_EMAIL_OUTBOX.clear)
        self.user_id = str(uuid4())
        self.insert_user(user_id=self.user_id, provider_id=fixtures.SUB)
        db.init_db()
        self.binding = self.get_context()["accountBinding"]

    def headers(self, token=None):
        return {"Authorization": f"Bearer {token or 'test-supabase-token'}"}

    def count(self, table):
        # Table names are fixed by these tests, never supplied by HTTP input.
        with db.connect() as conn:
            return conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]

    def enable_review(self):
        os.environ[ENV] = self.user_id

    def test_absent_configuration_sends_normal_otp(self):
        os.environ.pop(ENV, None)
        _, identity = self.identity()
        self.assertEqual(self.start(identity)["status"], "pending_verification")
        self.assertEqual(len(main._DEV_EMAIL_OUTBOX), 1)
        self.assertEqual(self.count("trusted_devices"), 0)
        self.assertEqual(self.count("refresh_token_families"), 0)

    def test_another_configured_uuid_does_not_exempt_this_user(self):
        os.environ[ENV] = str(uuid4())
        _, identity = self.identity()
        self.assertEqual(self.start(identity)["status"], "pending_verification")
        self.assertEqual(len(main._DEV_EMAIL_OUTBOX), 1)
        self.assertEqual(self.count("trusted_devices"), 0)

    def test_invalid_configuration_never_auto_trusts(self):
        os.environ[ENV] = "invalid-private-configuration"
        _, identity = self.identity()
        with self.assertLogs("scisonomics.cloud.devices", level="WARNING"):
            self.assertEqual(self.start(identity)["status"], "pending_verification")
        self.assertEqual(len(main._DEV_EMAIL_OUTBOX), 1)
        self.assertEqual(self.count("trusted_devices"), 0)

    def test_matching_uuid_grants_normal_session_without_otp_or_challenge(self):
        self.enable_review()
        _, identity = self.identity()
        with self.assertLogs("scisonomics.cloud.devices", level="INFO") as logs:
            grant = self.start(identity, "android")
        self.assertEqual(main._DEV_EMAIL_OUTBOX, [])
        self.assertEqual(self.count("device_verification_challenges"), 0)
        self.assertEqual(self.count("trusted_devices"), 1)
        self.assertEqual(self.count("refresh_token_families"), 1)
        claims = decode_access_token(grant["access_token"])
        self.assertIs(claims["device_authorized"], True)
        self.assertEqual(claims["sub"], self.user_id)
        self.assertEqual(claims["device_id"], grant["deviceId"])
        self.assertEqual(claims["family_id"], grant["familyId"])
        self.assertEqual(grant["user"]["id"], self.user_id)
        self.assertEqual(grant["deviceId"], identity["deviceId"])
        self.assertEqual(device_sessions.authorize_access(grant["access_token"])["sub"], self.user_id)
        self.assertEqual(self.client.get("/auth/me", headers=self.headers(grant["access_token"])).status_code, 200)
        self.assertEqual(self.client.get("/auth/me", headers=self.headers()).status_code, 401)
        with db.connect() as conn:
            device = conn.execute("SELECT * FROM trusted_devices").fetchone()
            family = conn.execute("SELECT * FROM refresh_token_families").fetchone()
            self.assertEqual((device["status"], device["trust_source"], device["platform"]), ("trusted", "play_review", "android"))
            self.assertEqual(family["trusted_device_id"], device["id"])
            self.assertEqual(family["user_id"], self.user_id)
            for field in ("first_seen_at", "last_seen_at", "trusted_at", "created_at", "updated_at"):
                self.assertTrue(device[field])
        output = "\n".join(logs.output)
        self.assertIn("play_review_auto_enrolled", output)
        for secret in (self.user_id, identity["deviceId"], grant["access_token"], grant["user"]["email"]):
            self.assertNotIn(secret, output)

    def test_key_alias_and_key_replacement_still_conflict(self):
        self.enable_review()
        _, identity = self.identity()
        self.start(identity)
        _, other = self.identity()
        for candidate in ({**identity, "deviceId": str(uuid4())}, {**other, "deviceId": identity["deviceId"]}):
            response = self.post("/login", {"identity": candidate, "platform": "android", "name": "QA"})
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["detail"]["code"], "device_key_conflict")
        self.assertEqual(self.count("trusted_devices"), 1)
        self.assertEqual(self.count("refresh_token_families"), 1)

    def test_second_login_requires_existing_proof_without_duplicate_device_or_grant(self):
        self.enable_review()
        key, identity = self.identity()
        self.start(identity)
        known = self.start(identity)
        self.assertEqual(known["status"], "trusted")
        self.assertNotIn("access_token", known)
        self.assertEqual(self.count("trusted_devices"), 1)
        self.assertEqual(self.count("refresh_token_families"), 1)
        body = {"challenge": known["challenge"], "proof": self.sign(key, identity, known["challenge"], 2)}
        self.assertEqual(self.post("/authentication/complete", body).status_code, 200)
        self.assertEqual(self.post("/authentication/complete", body).status_code, 401)
        self.assertEqual(self.count("trusted_devices"), 1)
        self.assertEqual(main._DEV_EMAIL_OUTBOX, [])

    def test_refresh_requires_proof_revocation_blocks_access_and_deletion_still_sends_otp(self):
        self.enable_review()
        key, identity = self.identity()
        grant = self.start(identity)
        body = self.refresh_body(key, identity, grant)
        invalid = {**body, "proof": {**body["proof"], "signature": "A" * 86}}
        self.assertEqual(self.post("/refresh/complete", invalid).status_code, 401)
        self.assertEqual(self.post("/refresh/complete", body).status_code, 200)
        response = self.client.post("/account/delete/request", json={}, headers=self.headers(grant["access_token"]))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(main._DEV_EMAIL_OUTBOX), 1)
        with db.connect() as conn:
            conn.execute("UPDATE trusted_devices SET status = 'revoked' WHERE user_id = ?", (self.user_id,))
        self.assertEqual(self.client.get("/auth/me", headers=self.headers(grant["access_token"])).status_code, 401)

    def test_untrusted_existing_device_updates_in_place(self):
        self.enable_review()
        _, identity = self.identity()
        self.start(identity)
        with db.connect() as conn:
            before = conn.execute("SELECT * FROM trusted_devices").fetchone()
            conn.execute("UPDATE trusted_devices SET status = 'observed', trust_source = NULL")
        self.start(identity, "android")
        self.assertEqual(self.count("trusted_devices"), 1)
        with db.connect() as conn:
            after = conn.execute("SELECT * FROM trusted_devices").fetchone()
            self.assertEqual(after["id"], before["id"])
            self.assertEqual(after["created_at"], before["created_at"])
            self.assertEqual(after["trust_source"], "play_review")
        self.assertEqual(main._DEV_EMAIL_OUTBOX, [])

    def test_revoked_family_stays_revoked_after_review_logs_in_again(self):
        self.enable_review()
        _, identity = self.identity()
        old = self.start(identity)
        with db.connect() as conn:
            conn.execute("UPDATE trusted_devices SET status = 'revoked', revoked_at = ?", (device_sessions.stamp(),))
            conn.execute("UPDATE refresh_token_families SET revoked_at = ?", (device_sessions.stamp(),))
        request = {"deviceId": identity["deviceId"], "familyId": old["familyId"]}
        self.assertEqual(self.post("/refresh/challenge", request).status_code, 401)
        new = self.start(identity)
        self.assertNotEqual(new["familyId"], old["familyId"])
        self.assertEqual(self.count("trusted_devices"), 1)
        self.assertEqual(self.post("/refresh/challenge", request).status_code, 401)
        self.assertEqual(self.client.get("/auth/me", headers=self.headers(old["access_token"])).status_code, 401)
        self.assertEqual(self.client.get("/auth/me", headers=self.headers(new["access_token"])).status_code, 200)
        self.assertEqual(main._DEV_EMAIL_OUTBOX, [])

    def test_other_user_does_not_inherit_bypass_even_with_same_public_key(self):
        self.enable_review()
        _, identity = self.identity()
        self.start(identity)
        self.user_id = str(uuid4())
        self.insert_user(user_id=self.user_id, email="other-qa@example.com", provider_id=fixtures.OTHER_SUB)
        self.get.return_value = httpx.Response(200, json=fixtures.provider_user(id=fixtures.OTHER_SUB, email="other-qa@example.com"))
        db.init_db()
        self.assertEqual(self.start(identity)["status"], "pending_verification")
        self.assertEqual(len(main._DEV_EMAIL_OUTBOX), 1)
        self.assertEqual(self.count("trusted_devices"), 1)

    def test_review_still_requires_valid_supabase_token_and_confirmed_email(self):
        self.enable_review()
        _, identity = self.identity()
        body = {"identity": identity, "platform": "android", "name": "QA"}
        self.get.return_value = httpx.Response(401, json={"message": "test-only-invalid-token"})
        self.assertEqual(self.post("/login", body).status_code, 401)
        self.get.return_value = httpx.Response(200, json=fixtures.provider_user(email_confirmed_at=None))
        self.assertEqual(self.post("/login", body).status_code, 403)
        self.assertEqual(self.count("trusted_devices"), 0)
        self.assertEqual(self.count("refresh_token_families"), 0)

    def test_enforce_authentication_rate_limit_and_input_validation_are_retained(self):
        self.enable_review()
        _, identity = self.identity()
        body = {"identity": identity, "platform": "android", "name": "QA"}
        self.assertEqual(self.client.post("/auth/devices/login", json=body).status_code, 401)
        with patch.dict(os.environ, {"SCISONOMICS_DEVICE_VERIFICATION_MODE": "off"}):
            self.assertEqual(self.post("/login", body).status_code, 503)
        self.assertEqual(self.post("/login", {**body, "name": "   "}).status_code, 422)
        invalid = {**identity, "publicKeyHash": "A" * 43}
        self.assertEqual(self.post("/login", {**body, "identity": invalid}).status_code, 422)
        for _ in range(28):
            self.assertEqual(self.post("/login", body).status_code, 200)
        self.assertEqual(self.post("/login", body).status_code, 429)
        self.assertEqual(self.count("trusted_devices"), 1)


if __name__ == "__main__":
    unittest.main()
