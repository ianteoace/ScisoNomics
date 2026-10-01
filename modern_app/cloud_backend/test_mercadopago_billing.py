from __future__ import annotations

import hashlib
import hmac
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
import httpx

from modern_app.cloud_backend import test_supabase_auth as fixtures
from modern_app.cloud_backend.app import db, mercadopago_billing as mp, security
from modern_app.cloud_backend.app.auth import create_access_token
from modern_app.cloud_backend.test_supabase_auth import INTERNAL_ID


PROVIDER_ID = "provider-123"


class MercadoPagoBillingTests(unittest.TestCase):
    insert_user = fixtures.DualAuthTests.insert_user

    def setUp(self):
        fixtures.DualAuthTests.setUp(self)
        with security._LOCK:
            security._ATTEMPTS.clear()

    def auth(self):
        return {"Authorization": f"Bearer {create_access_token(INTERNAL_ID)}"}

    def configured(self, *, token="secret-test-token", test_payer=""):
        env = patch.dict(os.environ, {
            "SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN": token,
            "SCISONOMICS_MERCADOPAGO_TEST_PAYER_EMAIL": test_payer,
            "SCISONOMICS_MERCADOPAGO_MONTHLY_AMOUNT_ARS": "4500.00",
            "SCISONOMICS_MERCADOPAGO_WEBHOOK_SECRET": "webhook-test-secret",
            "SCISONOMICS_PUBLIC_API_URL": "https://cloud.example.test",
        })
        env.start()
        self.addCleanup(env.stop)

    def start(self, *, expected_payer="legacy@example.com"):
        def create(method, path, **kwargs):
            self.assertEqual((method, path), ("POST", "/preapproval"))
            payload = kwargs["payload"]
            self.assertEqual(payload["payer_email"], expected_payer)
            self.assertEqual(payload["status"], "pending")
            self.assertTrue(payload["external_reference"].startswith(f"scisonomics:{INTERNAL_ID}:"))
            return {"id": PROVIDER_ID, "external_reference": payload["external_reference"],
                    "init_point": f"https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id={PROVIDER_ID}"}
        with patch.object(mp, "request", side_effect=create) as mocked:
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(mocked.call_count, 1)
        return response.json()

    def provider(self, status="authorized", next_date=None, reference=None):
        with db.connect() as conn:
            row = conn.execute("SELECT external_reference FROM billing_subscriptions WHERE user_id = ?", (INTERNAL_ID,)).fetchone()
        return {"id": PROVIDER_ID, "external_reference": reference if reference is not None else row["external_reference"],
                "preapproval_plan_id": None, "status": status, "next_payment_date": next_date,
                "auto_recurring": {"transaction_amount": "4500.00", "currency_id": "ARS"}}

    def invoice(self, status="approved"):
        return {"id": 123, "preapproval_id": PROVIDER_ID, "currency_id": "ARS", "transaction_amount": "4500.00",
                "debit_date": datetime.now(timezone.utc).isoformat(), "payment": {"status": status}}

    def webhook(self, topic, data_id, event_id=100):
        ts = "1700000000"
        request_id = "request-123"
        message = f"id:{data_id.lower()};request-id:{request_id};ts:{ts};".encode()
        signature = hmac.new(b"webhook-test-secret", message, hashlib.sha256).hexdigest()
        return self.client.post(f"/billing/webhooks/mercadopago?data.id={data_id}",
                                headers={"x-request-id": request_id, "x-signature": f"ts={ts},v1={signature}"},
                                json={"id": event_id, "type": topic, "data": {"id": data_id}})

    def test_creation_is_authenticated_and_idempotent(self):
        self.insert_user()
        self.configured()
        self.assertEqual(self.client.post("/billing/subscription").status_code, 401)
        first = self.start()
        second = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json(), first)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM billing_subscriptions").fetchone()["n"], 1)

    def test_test_token_uses_test_payer_and_internal_owner_reference(self):
        self.insert_user()
        self.configured(token="TEST-seller-token", test_payer="buyer@test.example")
        self.start(expected_payer="buyer@test.example")
        with db.connect() as conn:
            row = conn.execute("SELECT user_id,external_reference FROM billing_subscriptions").fetchone()
        self.assertEqual(row["user_id"], INTERNAL_ID)
        self.assertTrue(row["external_reference"].startswith(f"scisonomics:{INTERNAL_ID}:"))
        self.assertNotIn("buyer@test.example", row["external_reference"])

    def test_test_token_requires_valid_test_payer_before_creating_intent(self):
        self.insert_user()
        self.configured(token="TEST-seller-token")
        for email in ("", "not-an-email", "bad..dots@example.com", "buyer@example.com\nBearer TEST-secret"):
            with self.subTest(email=email), patch.dict(os.environ, {"SCISONOMICS_MERCADOPAGO_TEST_PAYER_EMAIL": email}), patch.object(mp, "request") as create:
                response = self.client.post("/billing/subscription", headers=self.auth())
                self.assertEqual(response.status_code, 503, response.text)
                self.assertEqual(response.json()["detail"]["code"], "mercadopago_test_payer_not_configured")
                create.assert_not_called()
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM billing_subscriptions").fetchone()["n"], 0)

    def test_non_test_token_uses_real_email_even_if_test_payer_is_set(self):
        self.insert_user()
        self.configured(token="APP_USR-seller-token", test_payer="buyer@test.example")
        self.start(expected_payer="legacy@example.com")

    def test_card_token_authorizes_pending_subscription_without_granting_premium(self):
        self.insert_user()
        self.configured()
        started = self.start()
        subscription_id = started["subscription_id"]
        self.assertEqual(started["amount"], "4500.00")
        provider = self.provider(status="authorized")
        with patch.object(mp, "request", return_value={"id": PROVIDER_ID}) as update, patch.object(mp, "get_subscription", return_value=provider):
            response = self.client.post(f"/billing/subscription/{subscription_id}/authorize", headers=self.auth(), json={"card_token_id": "cardtoken12345678"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "authorized")
        update.assert_called_once_with(
    "PUT",
    f"/preapproval/{PROVIDER_ID}",
    payload={
        "card_token_id": "cardtoken12345678",
        "status": "authorized",
    },
)
        with db.connect() as conn:
            user = conn.execute("SELECT id,plan,subscription_status,billing_source FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()
            row = conn.execute("SELECT user_id,status,paid_until,external_reference FROM billing_subscriptions WHERE id = ?", (subscription_id,)).fetchone()
        self.assertEqual(tuple(user), (INTERNAL_ID, "free", "active", None))
        self.assertEqual((row["user_id"], row["status"], row["paid_until"]), (INTERNAL_ID, "authorized", None))
        self.assertTrue(row["external_reference"].startswith(f"scisonomics:{INTERNAL_ID}:"))

    def test_card_authorization_rejects_missing_token_and_other_owner(self):
        self.insert_user()
        self.insert_user("other-owner", "other@example.com")
        self.configured()
        subscription_id = self.start()["subscription_id"]
        with patch.object(mp, "request") as update:
            missing = self.client.post(f"/billing/subscription/{subscription_id}/authorize", headers=self.auth(), json={})
            other = self.client.post(f"/billing/subscription/{subscription_id}/authorize", headers={"Authorization": f"Bearer {create_access_token('other-owner')}"}, json={"card_token_id": "cardtoken12345678"})
        self.assertEqual(missing.status_code, 422)
        self.assertEqual(missing.json()["detail"]["code"], "invalid_card_token")
        self.assertEqual(other.status_code, 404)
        self.assertEqual(other.json()["detail"]["code"], "subscription_not_found")
        update.assert_not_called()

    def test_card_authorization_provider_error_hides_card_token(self):
        self.insert_user()
        self.configured()
        subscription_id = self.start()["subscription_id"]
        token = "cardtokenabcdef"
        provider_error = httpx.Response(400, json={"error": "invalid_card_token", "message": f"Card token {token} rejected"})
        with patch.object(mp.httpx, "request", return_value=provider_error), self.assertLogs(mp.__name__, level="WARNING") as captured:
            response = self.client.post(f"/billing/subscription/{subscription_id}/authorize", headers=self.auth(), json={"card_token_id": token})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn(token, response.text + " ".join(captured.output))
        self.assertIn("status_code=400", captured.output[0])
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT status FROM billing_subscriptions WHERE id = ?", (subscription_id,)).fetchone()["status"], "pending")

    def test_card_authorization_rejects_mismatched_provider_reference(self):
        self.insert_user()
        self.configured()
        subscription_id = self.start()["subscription_id"]
        wrong = self.provider(status="authorized", reference="scisonomics:other-owner:other-intent")
        with patch.object(mp, "request", return_value={"id": PROVIDER_ID}), patch.object(mp, "get_subscription", return_value=wrong):
            response = self.client.post(f"/billing/subscription/{subscription_id}/authorize", headers=self.auth(), json={"card_token_id": "cardtoken12345678"})
        self.assertEqual(response.status_code, 409)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT status FROM billing_subscriptions WHERE id = ?", (subscription_id,)).fetchone()["status"], "pending")

    def test_provider_error_logs_only_sanitized_diagnostic(self):
        self.insert_user()
        self.configured(token="TEST-seller-token", test_payer="buyer@test.example")
        provider_error = httpx.Response(400, json={
            "error": "invalid_payer_email",
            "message": "Payer buyer@test.example rejected for TEST-seller-token",
            "details": {"password": "sensitive-value"},
        })
        with patch.object(mp.httpx, "request", return_value=provider_error), self.assertLogs(mp.__name__, level="WARNING") as captured:
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 502, response.text)
        self.assertEqual(response.json()["detail"]["code"], "mercadopago_request_failed")
        self.assertIn("status_code=400", captured.output[0])
        self.assertIn("code=invalid_payer_email", captured.output[0])
        self.assertIn("message=unavailable", captured.output[0])
        for secret in ("TEST-seller-token", "buyer@test.example", "sensitive-value"):
            self.assertNotIn(secret, " ".join(captured.output) + response.text)

    def test_provider_error_logs_safe_message_without_response_body(self):
        self.configured()
        provider_error = httpx.Response(422, json={"error": "invalid_payer_email", "message": "Invalid payer email", "details": {"token": "secret-test-token"}})
        with patch.object(mp.httpx, "request", return_value=provider_error), self.assertLogs(mp.__name__, level="WARNING") as captured:
            with self.assertRaises(mp.MercadoPagoError) as error:
                mp.request("POST", "/preapproval", payload={})
        self.assertEqual(error.exception.code, "mercadopago_request_failed")
        self.assertIn("status_code=422", captured.output[0])
        self.assertIn("message=Invalid payer email", captured.output[0])
        self.assertNotIn("secret-test-token", " ".join(captured.output))

    def test_provider_client_timeout_and_bad_response_hide_secret(self):
        self.configured()
        with patch.object(mp.httpx, "request", side_effect=httpx.ReadTimeout("secret-test-token")):
            with self.assertRaises(mp.MercadoPagoError) as error:
                mp.request("GET", "/preapproval/provider-123")
        self.assertEqual(error.exception.code, "mercadopago_timeout")
        self.assertNotIn("secret-test-token", str(error.exception))
        with patch.object(mp.httpx, "request", return_value=httpx.Response(200, content=b"invalid")):
            with self.assertRaises(mp.MercadoPagoError) as error:
                mp.request("GET", "/preapproval/provider-123")
        self.assertEqual(error.exception.code, "mercadopago_invalid_response")

    def test_timeout_keeps_uncertain_intent_and_does_not_retry(self):
        self.insert_user()
        self.configured()
        with patch.object(mp, "request", side_effect=mp.MercadoPagoError("mercadopago_timeout", 503)) as create:
            self.assertEqual(self.client.post("/billing/subscription", headers=self.auth()).status_code, 503)
            self.assertEqual(self.client.post("/billing/subscription", headers=self.auth()).status_code, 409)
            self.assertEqual(create.call_count, 1)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT status FROM billing_subscriptions").fetchone()["status"], "uncertain")

    def test_invalid_response_does_not_expose_token(self):
        self.insert_user()
        self.configured()
        with patch.object(mp, "request", return_value={"id": PROVIDER_ID, "external_reference": "wrong", "init_point": "https://evil.test/"}):
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("secret-test-token", response.text)

    def test_approved_invoice_grants_internal_owner_and_cancellation_keeps_paid_period(self):
        self.insert_user()
        self.configured()
        self.start()
        next_date = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        with patch.object(mp, "get_authorized_payment", return_value=self.invoice()), patch.object(mp, "get_subscription", return_value=self.provider(next_date=next_date)):
            first = self.webhook("subscription_authorized_payment", "123")
            second = self.webhook("subscription_authorized_payment", "123")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        with db.connect() as conn:
            user = conn.execute("SELECT id,plan,billing_source,subscription_expires_at FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()
            self.assertEqual(user["id"], INTERNAL_ID)
            self.assertEqual(user["plan"], "premium")
            self.assertEqual(user["billing_source"], "mercadopago")
            self.assertIsNotNone(user["subscription_expires_at"])
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM billing_webhook_events").fetchone()["n"], 1)
        with patch.object(mp, "cancel_subscription", return_value={"status": "canceled"}), patch.object(mp, "request", return_value={"results": []}), patch.object(mp, "get_subscription", return_value=self.provider(status="canceled")):
            canceled = self.client.post("/billing/subscription/cancel", headers=self.auth())
        self.assertEqual(canceled.status_code, 200, canceled.text)
        self.assertEqual(canceled.json()["status"], "canceled")
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "premium")

    def test_pending_or_failed_payment_never_grants_premium(self):
        self.insert_user()
        self.configured()
        self.start()
        with patch.object(mp, "get_authorized_payment", return_value=self.invoice(status="rejected")), patch.object(mp, "get_subscription", return_value=self.provider(next_date=(datetime.now(timezone.utc) + timedelta(days=30)).isoformat())):
            response = self.webhook("subscription_authorized_payment", "123")
        self.assertEqual(response.status_code, 200, response.text)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "free")

    def test_manual_premium_is_not_overwritten(self):
        self.insert_user()
        self.configured()
        self.start()
        with db.connect() as conn:
            conn.execute("UPDATE users SET plan = 'premium', subscription_status = 'active', subscription_expires_at = '2030-01-01T00:00:00Z' WHERE id = ?", (INTERNAL_ID,))
        with patch.object(mp, "get_subscription", return_value=self.provider(status="canceled")):
            response = self.webhook("subscription_preapproval", PROVIDER_ID)
        self.assertEqual(response.status_code, 200, response.text)
        with db.connect() as conn:
            row = conn.execute("SELECT plan,subscription_status,subscription_expires_at,billing_source FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()
            self.assertEqual(tuple(row), ("premium", "active", "2030-01-01T00:00:00Z", None))

    def test_manual_premium_cannot_start_duplicate_paid_subscription(self):
        self.insert_user()
        self.configured()
        with db.connect() as conn:
            conn.execute("UPDATE users SET plan = 'premium', subscription_status = 'active', subscription_expires_at = '2030-01-01T00:00:00Z' WHERE id = ?", (INTERNAL_ID,))
        with patch.object(mp, "request") as create:
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "already_premium")
        create.assert_not_called()

    def test_webhook_signature_and_owner_checks(self):
        self.insert_user()
        self.configured()
        self.start()
        rejected = self.client.post(f"/billing/webhooks/mercadopago?data.id={PROVIDER_ID}", json={"id": 1, "type": "subscription_preapproval", "data": {"id": PROVIDER_ID}})
        self.assertEqual(rejected.status_code, 401)
        with patch.object(mp, "get_subscription", return_value=self.provider(reference="scisonomics:other-user:unknown")):
            conflict = self.webhook("subscription_preapproval", PROVIDER_ID)
        self.assertEqual(conflict.status_code, 409)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "free")

    def test_schema_is_idempotent_and_expired_provider_premium_becomes_free(self):
        self.insert_user()
        db.init_db()
        with db.connect() as conn:
            conn.execute("UPDATE users SET plan = 'premium', billing_source = 'mercadopago', subscription_expires_at = '2020-01-01T00:00:00Z' WHERE id = ?", (INTERNAL_ID,))
        with patch.object(self.main, "create_entitlement_token", return_value="test-only-entitlement"):
            response = self.client.get("/billing/entitlements", headers=self.auth())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["plan"], "free")
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "free")


if __name__ == "__main__":
    unittest.main()
