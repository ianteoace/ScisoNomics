"""Provider-confirmed subscription state and entitlement reconciliation."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from . import mercadopago_billing as mp


OPEN_STATUSES = {"creating", "uncertain", "pending", "authorized", "paused"}
PROVIDER_STATUSES = {"pending", "authorized", "paused", "canceled"}


def _normalize_provider_status(value: Any) -> str:
    status = str(value or "").strip().lower()

    if status == "cancelled":
        return "canceled"

    return status

class BillingConflict(Exception):
    pass


def _parse_date(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else None


def _amount(value: Any) -> str:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise mp.MercadoPagoError("mercadopago_invalid_amount") from None
    if not amount.is_finite() or amount <= 0:
        raise mp.MercadoPagoError("mercadopago_invalid_amount")
    return str(amount.quantize(Decimal("0.01")))


def validate_pending_preapproval(provider: dict, reference: str, amount: str, payer_email: str) -> tuple[str, str]:
    """Validate the individual no-plan checkout before exposing its URL."""
    provider_id = str(provider.get("id") or "")
    recurring = provider.get("auto_recurring")
    returned_email = str(provider.get("payer_email") or "").strip()
    if (not mp.RESOURCE_ID.fullmatch(provider_id)
            or provider.get("external_reference") != reference
            or provider.get("preapproval_plan_id")
            or (returned_email and returned_email.casefold() != payer_email.casefold())
            or provider.get("status") != "pending"
            or not isinstance(recurring, dict)
            or recurring.get("currency_id") != "ARS"
            or _amount(recurring.get("transaction_amount")) != amount):
        raise mp.MercadoPagoError("mercadopago_invalid_response")
    return provider_id, mp.validate_checkout_url(provider.get("init_point"), provider_id)


def _row(conn, user_id: str):
    return conn.execute(
        "SELECT * FROM billing_subscriptions WHERE user_id = ? AND provider = 'mercadopago' ORDER BY created_at DESC LIMIT 1",
        (user_id,),
    ).fetchone()


def public_status(conn, user_id: str) -> dict:
    row = _row(conn, user_id)
    if row is None:
        try:
            amount = mp.monthly_amount()
        except mp.MercadoPagoError:
            amount = None
        return {"status": "none", "subscription_id": None, "amount": amount, "next_payment_date": None, "paid_until": None, "checkout_url": None, "can_cancel": False, "payment_status": None, "payment_status_detail": None}
    return {
        "status": row["status"],
        "subscription_id": row["id"],
        "amount": row["amount"],
        "next_payment_date": row["paid_until"] if row["status"] == "authorized" else None,
        "paid_until": row["paid_until"],
        "checkout_url": row["checkout_url"] if row["status"] == "pending" else None,
        "can_cancel": bool(row["provider_subscription_id"]) and row["status"] in {"pending", "authorized", "paused"},
        "payment_status": row["payment_status"],
        "payment_status_detail": row["payment_status_detail"],
    }


def expire_entitlement_if_due(conn, user_id: str, *, now: str) -> None:
    user = conn.execute(
        "SELECT plan,billing_source,subscription_expires_at FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if user is None or user["billing_source"] != "mercadopago" or user["plan"] != "premium":
        return
    expires = _parse_date(user["subscription_expires_at"])
    if expires is None or expires > datetime.now(timezone.utc):
        return
    latest = _row(conn, user_id)
    status = "canceled" if latest and latest["status"] == "canceled" else "expired"
    conn.execute(
        "UPDATE users SET plan = 'free', subscription_status = ?, subscription_expires_at = NULL, updated_at = ? WHERE id = ? AND billing_source = 'mercadopago'",
        (status, now, user_id),
    )


def _set_effective_entitlement(conn, row, *, now: str) -> None:
    latest = _row(conn, row["user_id"])
    if latest is None or latest["id"] != row["id"]:
        return
    user = conn.execute(
        "SELECT id, plan, subscription_status, subscription_expires_at, billing_source FROM users WHERE id = ?",
        (row["user_id"],),
    ).fetchone()
    if user is None:
        raise BillingConflict("user_missing")
    source = str(user["billing_source"] or "")
    # Existing/manual Premium and subsequent admin grants have priority.
    if source != "mercadopago" and str(user["plan"] or "").lower() == "premium":
        return
    paid_until = _parse_date(row["paid_until"])
    entitled = paid_until is not None and paid_until > datetime.now(timezone.utc)
    if entitled:
        conn.execute(
            "UPDATE users SET plan = 'premium', subscription_status = 'active', subscription_expires_at = ?, billing_source = 'mercadopago', updated_at = ? WHERE id = ?",
            (paid_until.isoformat(), now, row["user_id"]),
        )
    elif source == "mercadopago":
        status = "canceled" if row["status"] == "canceled" else "expired"
        conn.execute(
            "UPDATE users SET plan = 'free', subscription_status = ?, subscription_expires_at = NULL, billing_source = 'mercadopago', updated_at = ? WHERE id = ?",
            (status, now, row["user_id"]),
        )


def reconcile_subscription(conn, *, provider_id: str, now: str, approved_invoice: dict | None = None, payment_invoice: dict | None = None, expected_subscription_id: str | None = None) -> dict:
    """GET the authoritative preapproval; never derive a user from webhook input."""
    provider = mp.get_subscription(provider_id)
    if str(provider.get("id") or "") != provider_id:
        raise mp.MercadoPagoError("mercadopago_id_mismatch")
    reference = str(provider.get("external_reference") or "")
    row = conn.execute("SELECT * FROM billing_subscriptions WHERE provider_subscription_id = ? AND provider = 'mercadopago'", (provider_id,)).fetchone()
    if row is None:
        row = conn.execute("SELECT * FROM billing_subscriptions WHERE external_reference = ? AND provider = 'mercadopago'", (reference,)).fetchone()
    if row is None or (reference and reference != row["external_reference"]) or (expected_subscription_id is not None and row["id"] != expected_subscription_id) or (row["provider_subscription_id"] and row["provider_subscription_id"] != provider_id):
        raise BillingConflict("subscription_not_owned")
    if row["provider_plan_id"] and str(provider.get("preapproval_plan_id") or "") != row["provider_plan_id"]:
        raise BillingConflict("plan_mismatch")
    recurring = provider.get("auto_recurring") or {}
    if not isinstance(recurring, dict) or recurring.get("currency_id") != row["currency"] or _amount(recurring.get("transaction_amount")) != row["amount"]:
        raise BillingConflict("price_mismatch")
    status = _normalize_provider_status(provider.get("status"))
    if status not in PROVIDER_STATUSES:
        raise mp.MercadoPagoError("mercadopago_unknown_status")
    paid_until = _parse_date(row["paid_until"])
    if approved_invoice is not None:
        invoice_payment = approved_invoice.get("payment") or {}
        if (str(approved_invoice.get("preapproval_id") or "") != provider_id
                or not isinstance(invoice_payment, dict)
                or invoice_payment.get("status") != "approved"
                or approved_invoice.get("currency_id") != row["currency"]
                or _amount(approved_invoice.get("transaction_amount")) != row["amount"]):
            raise BillingConflict("invoice_not_approved_for_subscription")
        next_date = _parse_date(provider.get("next_payment_date"))
        debit_date = _parse_date(approved_invoice.get("debit_date"))
        if status == "authorized" and next_date and debit_date and debit_date <= next_date <= debit_date + timedelta(days=35) and (paid_until is None or next_date > paid_until):
            paid_until = next_date
    if payment_invoice is not None:
        payment = payment_invoice.get("payment")
        if (str(payment_invoice.get("preapproval_id") or "") != provider_id
                or not isinstance(payment, dict)
                or payment_invoice.get("currency_id") != row["currency"]
                or _amount(payment_invoice.get("transaction_amount")) != row["amount"]):
            raise BillingConflict("payment_not_for_subscription")
        payment_status = _normalize_provider_status(payment.get("status"))
        if payment_status not in {"approved", "rejected", "pending", "in_process", "canceled"}:
            payment_status = None
        detail = "cc_rejected_high_risk" if payment_status == "rejected" and payment.get("status_detail") == "cc_rejected_high_risk" else None
        payment_at = _parse_date(payment_invoice.get("debit_date"))
        last_payment_at = _parse_date(row["last_payment_at"])
        if payment_status and (last_payment_at is None or (payment_at and payment_at >= last_payment_at)):
            conn.execute("UPDATE billing_subscriptions SET payment_status = ?, payment_status_detail = ?, last_payment_at = ? WHERE id = ?", (payment_status, detail, payment_at.isoformat() if payment_at else None, row["id"]))
    conn.execute(
        """
        UPDATE billing_subscriptions
        SET provider_subscription_id = ?, status = ?, paid_until = ?, updated_at = ?,
            last_provider_sync_at = ?, canceled_at = CASE WHEN ? = 'canceled' THEN COALESCE(canceled_at, ?) ELSE canceled_at END
        WHERE id = ?
        """,
        (provider_id, status, paid_until.isoformat() if paid_until else None, now, now, status, now, row["id"]),
    )
    updated = conn.execute("SELECT * FROM billing_subscriptions WHERE id = ?", (row["id"],)).fetchone()
    _set_effective_entitlement(conn, updated, now=now)
    return public_status(conn, row["user_id"])


def record_approved_invoice(conn, provider_id: str, invoice: dict, *, now: str) -> dict:
    return reconcile_subscription(conn, provider_id=provider_id, now=now, approved_invoice=invoice)


def payment_evidence(provider_id: str) -> tuple[dict | None, dict | None]:
    result = mp.request("GET", "/authorized_payments/search", params={"preapproval_id": provider_id})
    invoices = result.get("results")
    if not isinstance(invoices, list):
        raise mp.MercadoPagoError("mercadopago_invalid_response")
    relevant = [item for item in invoices if isinstance(item, dict)
                and isinstance(item.get("payment"), dict)
                and str(item.get("preapproval_id")) == provider_id]
    def date_key(item):
        return _parse_date(item.get("debit_date")) or datetime.min.replace(tzinfo=timezone.utc)
    approved = [item for item in relevant if item["payment"].get("status") == "approved"]
    return max(approved, key=date_key, default=None), max(relevant, key=date_key, default=None)
