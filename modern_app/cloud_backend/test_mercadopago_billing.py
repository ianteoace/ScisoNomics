from __future__ import annotations

import hashlib
import hmac
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from modern_app.cloud_backend import test_supabase_auth as fixtures
from modern_app.cloud_backend.app import billing_subscriptions as subscriptions, db, mercadopago_billing as mp, security
from modern_app.cloud_backend.app.auth import create_access_token
from modern_app.cloud_backend.test_supabase_auth import INTERNAL_ID

PROVIDER_ID = "provider-123"
CHECKOUT = f"https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id={PROVIDER_ID}"


class MercadoPagoBillingTests(unittest.TestCase):
    insert_user = fixtures.DualAuthTests.insert_user

    def setUp(self):
        fixtures.DualAuthTests.setUp(self)
        with security._LOCK:
            security._ATTEMPTS.clear()
        self.insert_user()
        env = patch.dict(os.environ, {
            "SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY": rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
            ).decode("ascii"),
            "SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN": "APP_USR-test-only",
            "SCISONOMICS_MERCADOPAGO_TEST_PAYER_EMAIL": "",
            "SCISONOMICS_MERCADOPAGO_MONTHLY_AMOUNT_ARS": "4500.00",
            "SCISONOMICS_MERCADOPAGO_WEBHOOK_SECRET": "webhook-test-secret",
            "SCISONOMICS_PUBLIC_API_URL": "https://cloud.example.test",
        })
        env.start()
        self.addCleanup(env.stop)

    def auth(self, owner=INTERNAL_ID):
        return {"Authorization": f"Bearer {create_access_token(owner)}"}

    def provider(self, status="authorized", reference=None):
        with db.connect() as conn:
            row = conn.execute("SELECT external_reference FROM billing_subscriptions WHERE user_id = ?", (INTERNAL_ID,)).fetchone()
        return {"id": PROVIDER_ID, "external_reference": reference or row["external_reference"],
                "status": status, "init_point": CHECKOUT, "payer_email": "",
                "next_payment_date": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
                "auto_recurring": {"transaction_amount": "4500.00", "currency_id": "ARS"}}

    def start(self, payer="legacy@example.com"):
        def create(method, path, **kwargs):
            self.assertEqual((method, path), ("POST", "/preapproval"))
            payload = kwargs["payload"]
            self.assertEqual(set(payload), {"reason", "external_reference", "payer_email", "auto_recurring", "back_url", "status"})
            self.assertEqual(payload["status"], "pending")
            self.assertEqual(payload["payer_email"], payer)
            self.assertEqual(payload["auto_recurring"], {"frequency": 1, "frequency_type": "months", "transaction_amount": 4500.0, "currency_id": "ARS"})
            self.assertEqual(payload["back_url"], "https://cloud.example.test/billing/return")
            self.assertTrue(payload["external_reference"].startswith(f"scisonomics:{INTERNAL_ID}:"))
            with db.connect() as conn:
                row = conn.execute("SELECT status FROM billing_subscriptions").fetchone()
                self.assertEqual(row["status"], "uncertain")
            return self.provider("pending")
        with patch.object(mp, "request", side_effect=create) as mocked:
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 200, response.text)
        mocked.assert_called_once()
        return response.json()

    def invoice(self, status="approved", detail=None):
        return {"id": 123, "preapproval_id": PROVIDER_ID, "currency_id": "ARS", "transaction_amount": "4500.00",
                "debit_date": datetime.now(timezone.utc).isoformat(), "payment": {"status": status, "status_detail": detail}}

    def webhook(self, topic, data_id, event_id=100):
        request_id, ts = "request-123", "1700000000"
        manifest = f"id:{data_id.lower()};request-id:{request_id};ts:{ts};".encode()
        signature = hmac.new(b"webhook-test-secret", manifest, hashlib.sha256).hexdigest()
        return self.client.post(f"/billing/webhooks/mercadopago?data.id={data_id}",
                                headers={"x-request-id": request_id, "x-signature": f"ts={ts},v1={signature}"},
                                json={"id": event_id, "type": topic, "data": {"id": data_id}})

    def test_start_creates_individual_no_plan_checkout_and_no_premium(self):
        self.assertEqual(self.client.post("/billing/subscription").status_code, 401)
        started = self.start()
        self.assertEqual((started["status"], started["checkout_url"], started["amount"]), ("pending", CHECKOUT, "4500.00"))
        with db.connect() as conn:
            row = conn.execute("SELECT * FROM billing_subscriptions").fetchone()
            self.assertEqual(row["provider_subscription_id"], PROVIDER_ID)
            self.assertIsNone(row["provider_plan_id"])
            self.assertEqual(row["user_id"], INTERNAL_ID)
            self.assertEqual(row["external_reference"], f"scisonomics:{INTERNAL_ID}:{row['id']}")
            self.assertIsNotNone(row["last_provider_sync_at"])
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "free")

    def test_duplicate_start_reuses_checkout_without_another_post(self):
        started = self.start()
        with patch.object(mp, "request") as request:
            again = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(again.json(), started)
        request.assert_not_called()

    def test_corrupt_stored_checkout_is_rejected_without_another_post(self):
        self.start()
        with db.connect() as conn:
            conn.execute("UPDATE billing_subscriptions SET checkout_url = 'https://evil.test/'")
        with patch.object(mp, "request") as remote:
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 502)
        remote.assert_not_called()

    def test_another_owner_cannot_read_refresh_or_cancel_this_subscription(self):
        self.start()
        other = "00000000-0000-4000-8000-000000000001"
        self.insert_user(user_id=other, email="other@example.com")
        with patch.object(mp, "request") as remote, patch.object(mp, "cancel_subscription") as cancel:
            state = self.client.get("/billing/subscription", headers=self.auth(other)).json()
            refresh = self.client.post("/billing/subscription/refresh", headers=self.auth(other))
            canceled = self.client.post("/billing/subscription/cancel", headers=self.auth(other))
        self.assertEqual(state["status"], "none")
        self.assertEqual(refresh.json()["status"], "none")
        self.assertEqual(canceled.status_code, 409)
        remote.assert_not_called()
        cancel.assert_not_called()

    def test_in_flight_creation_blocks_a_second_post(self):
        def remote(*args, **kwargs):
            again = self.client.post("/billing/subscription", headers=self.auth())
            self.assertEqual(again.status_code, 409)
            return self.provider("pending")
        with patch.object(mp, "request", side_effect=remote) as request:
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 200, response.text)
        request.assert_called_once()

    def test_test_credentials_require_configured_test_buyer(self):
        with patch.dict(os.environ, {"SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN": "TEST-seller", "SCISONOMICS_MERCADOPAGO_TEST_PAYER_EMAIL": ""}), patch.object(mp, "request") as remote:
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 503)
        remote.assert_not_called()
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM billing_subscriptions").fetchone()["n"], 0)

    def test_test_buyer_does_not_change_internal_reference(self):
        with patch.dict(os.environ, {"SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN": "TEST-seller", "SCISONOMICS_MERCADOPAGO_TEST_PAYER_EMAIL": "buyer@test.example"}):
            self.start("buyer@test.example")

    def test_production_ignores_test_buyer(self):
        with patch.dict(os.environ, {"SCISONOMICS_MERCADOPAGO_TEST_PAYER_EMAIL": "buyer@test.example"}):
            self.start()

    def test_invalid_response_stays_uncertain_and_exposes_no_secrets(self):
        with patch.object(mp, "request", return_value={"id": PROVIDER_ID, "external_reference": "wrong", "status": "pending"}):
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("APP_USR-test-only", response.text)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT status FROM billing_subscriptions").fetchone()["status"], "uncertain")

    def test_invalid_provider_checkout_stays_uncertain(self):
        def remote(*args, **kwargs):
            return {**self.provider("pending"), "init_point": "https://evil.test/"}
        with patch.object(mp, "request", side_effect=remote):
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"]["code"], "mercadopago_invalid_checkout_url")

    def test_checkout_url_allowlist_and_provider_id(self):
        self.assertEqual(mp.validate_checkout_url(CHECKOUT, PROVIDER_ID), CHECKOUT)
        for url in ["http://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=provider-123", "https://www.mercadopago.com.ar.evil.test/subscriptions/checkout?preapproval_id=provider-123", CHECKOUT + "&preapproval_id=other", CHECKOUT + "&preapproval_plan_id=plan", CHECKOUT + "#bad", CHECKOUT.replace(PROVIDER_ID, "other"), CHECKOUT.replace("www.", "user@www."), CHECKOUT + "\\evil", " " + CHECKOUT]:
            with self.subTest(url=url), self.assertRaises(mp.MercadoPagoError):
                mp.validate_checkout_url(url, PROVIDER_ID)

    def test_timeout_never_duplicates_and_webhook_can_recover(self):
        with patch.object(mp, "request", side_effect=mp.MercadoPagoError("mercadopago_timeout", 503)) as remote:
            first = self.client.post("/billing/subscription", headers=self.auth())
            second = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(first.status_code, 503)
        self.assertEqual(second.status_code, 409)
        remote.assert_called_once()
        with patch.object(mp, "get_subscription", return_value=self.provider()), patch.object(mp, "request", return_value={"results": []}):
            recovered = self.webhook("subscription_preapproval", PROVIDER_ID)
        self.assertEqual(recovered.status_code, 200, recovered.text)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT provider_subscription_id,status FROM billing_subscriptions").fetchone()["status"], "authorized")

    def test_authorized_webhook_without_invoice_never_grants_premium(self):
        self.start()
        with patch.object(mp, "get_subscription", return_value=self.provider()), patch.object(mp, "request", return_value={"results": []}):
            response = self.webhook("subscription_preapproval", PROVIDER_ID)
        self.assertEqual(response.status_code, 200)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "free")

    def test_approved_webhook_is_idempotent_and_grants_internal_owner(self):
        self.start()
        with patch.object(mp, "get_authorized_payment", return_value=self.invoice()), patch.object(mp, "get_subscription", return_value=self.provider()):
            first, second = self.webhook("subscription_authorized_payment", "123"), self.webhook("subscription_authorized_payment", "123")
        self.assertEqual((first.status_code, second.status_code), (200, 200))
        with db.connect() as conn:
            user = conn.execute("SELECT id,plan,billing_source,subscription_expires_at FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()
            self.assertEqual((user["id"], user["plan"], user["billing_source"]), (INTERNAL_ID, "premium", "mercadopago"))
            self.assertIsNotNone(user["subscription_expires_at"])
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM billing_webhook_events").fetchone()["n"], 1)

    def test_foreign_invoice_or_wrong_price_cannot_grant_premium(self):
        self.start()
        for i, changes in enumerate([{"preapproval_id": "another-provider"}, {"transaction_amount": "1.00"}, {"currency_id": "USD"}]):
            invoice = {**self.invoice(), **changes}
            with patch.object(mp, "get_authorized_payment", return_value=invoice), patch.object(mp, "get_subscription", return_value=self.provider()):
                response = self.webhook("subscription_authorized_payment", "123", event_id=400+i)
            self.assertEqual(response.status_code, 502 if i == 0 else 409)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "free")

    def test_approved_invoice_does_not_grant_new_period_for_canceled_or_pending(self):
        self.start()
        for i, status in enumerate(["pending", "paused", "cancelled"]):
            with patch.object(mp, "get_authorized_payment", return_value=self.invoice()), patch.object(mp, "get_subscription", return_value=self.provider(status)):
                response = self.webhook("subscription_authorized_payment", "123", event_id=500+i)
            self.assertEqual(response.status_code, 200)
        with db.connect() as conn:
            self.assertIsNone(conn.execute("SELECT paid_until FROM billing_subscriptions").fetchone()["paid_until"])
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "free")

    def test_rejected_and_high_risk_are_visible_without_premium(self):
        self.start()
        for i, detail in enumerate([None, "cc_rejected_high_risk"]):
            with patch.object(mp, "get_authorized_payment", return_value=self.invoice("rejected", detail)), patch.object(mp, "get_subscription", return_value=self.provider()):
                response = self.webhook("subscription_authorized_payment", "123", event_id=200+i)
            self.assertEqual(response.status_code, 200, response.text)
            state = self.client.get("/billing/subscription", headers=self.auth()).json()
            self.assertEqual((state["payment_status"], state["payment_status_detail"]), ("rejected", detail))
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "free")

    def test_refresh_pending_and_rejected_payment(self):
        self.start()
        with patch.object(mp, "get_subscription", return_value=self.provider("pending")), patch.object(mp, "request", return_value={"results": [self.invoice("rejected", "cc_rejected_high_risk")]}):
            response = self.client.post("/billing/subscription/refresh", headers=self.auth())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "pending")
        self.assertEqual(response.json()["payment_status_detail"], "cc_rejected_high_risk")

    def test_canceled_aliases_and_manual_premium_priority(self):
        self.start()
        with db.connect() as conn:
            conn.execute("UPDATE users SET plan = 'premium', subscription_expires_at = '2030-01-01T00:00:00Z' WHERE id = ?", (INTERNAL_ID,))
        for i, status in enumerate(["canceled", "cancelled"]):
            with patch.object(mp, "get_subscription", return_value=self.provider(status)), patch.object(mp, "request", return_value={"results": []}):
                response = self.webhook("subscription_preapproval", PROVIDER_ID, event_id=300+i)
            self.assertEqual(response.status_code, 200)
            state = self.client.get("/billing/subscription", headers=self.auth()).json()
            self.assertEqual(state["status"], "canceled")
        with db.connect() as conn:
            user = conn.execute("SELECT plan,subscription_expires_at,billing_source FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()
            self.assertEqual(tuple(user), ("premium", "2030-01-01T00:00:00Z", None))

    def test_deprecated_client_cancellation_keeps_verified_paid_period(self):
        route = next(route for route in self.main.app.routes if getattr(route, "path", None) == "/billing/subscription/cancel")
        self.assertTrue(route.deprecated)
        self.assertFalse(route.include_in_schema)
        self.start()
        with patch.object(mp, "get_subscription", return_value=self.provider()), patch.object(mp, "request", return_value={"results": [self.invoice()]}):
            self.assertEqual(self.client.post("/billing/subscription/refresh", headers=self.auth()).status_code, 200)
        with patch.object(mp, "cancel_subscription"), patch.object(mp, "get_subscription", return_value=self.provider("cancelled")), patch.object(mp, "request", return_value={"results": []}):
            response = self.client.post("/billing/subscription/cancel", headers=self.auth())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "canceled")
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "premium")

    def test_provider_cancellation_webhook_keeps_paid_period_and_internal_owner(self):
        self.start()
        with patch.object(mp, "get_subscription", return_value=self.provider()), patch.object(mp, "request", return_value={"results": [self.invoice()]}):
            paid = self.client.post("/billing/subscription/refresh", headers=self.auth()).json()["paid_until"]
        for i, status in enumerate(["canceled", "cancelled"]):
            with patch.object(mp, "get_subscription", return_value=self.provider(status)), patch.object(mp, "request", return_value={"results": []}), patch.object(mp, "cancel_subscription") as cancel:
                response = self.webhook("subscription_preapproval", PROVIDER_ID, event_id=700+i)
            self.assertEqual(response.status_code, 200, response.text)
            cancel.assert_not_called()
            state = self.client.get("/billing/subscription", headers=self.auth()).json()
            self.assertEqual((state["status"], state["paid_until"], state["next_payment_date"]), ("canceled", paid, None))
            entitlement = self.client.get("/billing/entitlements", headers=self.auth()).json()
            self.assertEqual((entitlement["plan"], entitlement["status"]), ("premium", "active"))
            self.assertTrue(all(entitlement["features"].values()))
        with db.connect() as conn:
            user = conn.execute("SELECT id,plan,subscription_status,subscription_expires_at,billing_source FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()
            self.assertEqual(tuple(user), (INTERNAL_ID, "premium", "active", paid, "mercadopago"))

    def test_provider_cancellation_without_approved_payment_keeps_free(self):
        self.start()
        with patch.object(mp, "get_subscription", return_value=self.provider("cancelled")), patch.object(mp, "request", return_value={"results": []}):
            response = self.webhook("subscription_preapproval", PROVIDER_ID, event_id=800)
        self.assertEqual(response.status_code, 200)
        state = self.client.get("/billing/subscription", headers=self.auth()).json()
        self.assertEqual(state["status"], "canceled")
        self.assertIsNone(state["paid_until"])
        entitlement = self.client.get("/billing/entitlements", headers=self.auth()).json()
        self.assertEqual(entitlement["plan"], "free")
        self.assertFalse(any(entitlement["features"].values()))

    def test_canceled_paid_period_expires_to_free_on_entitlements_read(self):
        self.start()
        with patch.object(mp, "get_subscription", return_value=self.provider()), patch.object(mp, "request", return_value={"results": [self.invoice()]}):
            paid = self.client.post("/billing/subscription/refresh", headers=self.auth()).json()["paid_until"]
        with patch.object(mp, "get_subscription", return_value=self.provider("canceled")), patch.object(mp, "request", return_value={"results": []}):
            self.assertEqual(self.webhook("subscription_preapproval", PROVIDER_ID, event_id=900).status_code, 200)
        after_expiry = datetime.fromisoformat(paid) + timedelta(seconds=1)
        with patch.object(subscriptions, "datetime", wraps=datetime) as clock:
            clock.now.return_value = after_expiry
            entitlement = self.client.get("/billing/entitlements", headers=self.auth()).json()
        self.assertEqual((entitlement["plan"], entitlement["status"]), ("free", "canceled"))
        self.assertIsNone(entitlement["expires_at"])
        self.assertFalse(any(entitlement["features"].values()))
        with db.connect() as conn:
            user = conn.execute("SELECT plan,subscription_status,subscription_expires_at,billing_source FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()
            self.assertEqual(tuple(user), ("free", "canceled", None, "mercadopago"))
            self.assertEqual(conn.execute("SELECT paid_until FROM billing_subscriptions").fetchone()["paid_until"], paid)

    def test_manual_premium_blocks_new_checkout(self):
        with db.connect() as conn:
            conn.execute("UPDATE users SET plan = 'premium', subscription_expires_at = '2030-01-01T00:00:00Z' WHERE id = ?", (INTERNAL_ID,))
        with patch.object(mp, "request") as remote:
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 409)
        remote.assert_not_called()

    def test_return_does_not_trust_query_or_grant_premium(self):
        response = self.client.get("/billing/return?status=approved&user_id="+INTERNAL_ID)
        self.assertEqual(response.status_code, 200)
        self.assertIn("Estamos verificando tu pago", response.text)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT plan FROM users WHERE id = ?", (INTERNAL_ID,)).fetchone()["plan"], "free")

    def test_webhook_signature_and_reference_ownership(self):
        self.start()
        rejected = self.client.post(f"/billing/webhooks/mercadopago?data.id={PROVIDER_ID}", json={})
        self.assertEqual(rejected.status_code, 401)
        with patch.object(mp, "get_subscription", return_value=self.provider(reference="scisonomics:other:wrong")), patch.object(mp, "request", return_value={"results": []}):
            response = self.webhook("subscription_preapproval", PROVIDER_ID)
        self.assertEqual(response.status_code, 409)

    def test_historical_creating_intent_resumes_with_same_id(self):
        now = datetime.now(timezone.utc).isoformat()
        with db.connect() as conn:
            conn.execute("INSERT INTO billing_subscriptions (id,user_id,provider,status,currency,amount,external_reference,created_at,updated_at) VALUES ('old-intent',?,'mercadopago','creating','ARS','4500.00',?,?,?)", (INTERNAL_ID, f"scisonomics:{INTERNAL_ID}:old-intent", now, now))
        result = self.start()
        self.assertEqual(result["subscription_id"], "old-intent")

    def test_schema_is_idempotent_and_public_price_available(self):
        db.init_db()
        state = self.client.get("/billing/subscription", headers=self.auth()).json()
        self.assertEqual((state["status"], state["amount"]), ("none", "4500.00"))

    def test_invalid_price_or_configuration_makes_no_remote_call(self):
        with patch.dict(os.environ, {"SCISONOMICS_MERCADOPAGO_MONTHLY_AMOUNT_ARS": "NaN"}), patch.object(mp, "request") as remote:
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 503)
        remote.assert_not_called()

    def test_http_errors_log_sanitized_diagnostics(self):
        error = httpx.Response(400, json={"error": "invalid_payer_email", "message": "Payer legacy@example.com rejected for APP_USR-test-only", "details": {"secret": "hidden-value"}})
        with patch.object(mp.httpx, "request", return_value=error), self.assertLogs(mp.__name__, level="WARNING") as logs:
            response = self.client.post("/billing/subscription", headers=self.auth())
        self.assertEqual(response.status_code, 502)
        self.assertIn("status_code=400", logs.output[0])
        self.assertIn("code=invalid_payer_email", logs.output[0])
        for value in ["APP_USR-test-only", "legacy@example.com", "hidden-value"]:
            self.assertNotIn(value, response.text + " ".join(logs.output))


if __name__ == "__main__":
    unittest.main()
