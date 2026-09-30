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

    def configured(self):
        env = patch.dict(os.environ, {
            "SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN": "secret-test-token",
            "SCISONOMICS_MERCADOPAGO_MONTHLY_AMOUNT_ARS": "4500.00",
            "SCISONOMICS_MERCADOPAGO_WEBHOOK_SECRET": "webhook-test-secret",
            "SCISONOMICS_PUBLIC_API_URL": "https://cloud.example.test",
        })
        env.start()
        self.addCleanup(env.stop)

    def start(self):
        def create(method, path, **kwargs):
            self.assertEqual((method, path), ("POST", "/preapproval"))
            payload = kwargs["payload"]
            self.assertEqual(payload["payer_email"], "legacy@example.com")
            self.assertEqual(payload["status"], "pending")
            self.assertIn(INTERNAL_ID, payload["external_reference"])
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
