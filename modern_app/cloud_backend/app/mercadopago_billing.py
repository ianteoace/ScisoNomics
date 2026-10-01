"""Small server-only client for Mercado Pago Subscriptions.

Only provider resource IDs are accepted in paths. Never expose the access token
or a provider response body in an exception returned to callers.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
from decimal import Decimal, InvalidOperation
from urllib.parse import parse_qs, urlparse

import httpx


API_URL = "https://api.mercadopago.com"
RESOURCE_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
TEST_PAYER_EMAIL = re.compile(r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$")
PROVIDER_CODE = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
PROVIDER_MESSAGE = re.compile(r"^[A-Za-z .,;:()/_-]{1,160}$")
_logger = logging.getLogger(__name__)


class MercadoPagoError(Exception):
    def __init__(self, code: str, status_code: int = 502):
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def configured() -> bool:
    return bool(os.getenv("SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN", "").strip())


def monthly_amount() -> str:
    try:
        amount = Decimal(os.getenv("SCISONOMICS_MERCADOPAGO_MONTHLY_AMOUNT_ARS", "").strip())
        if not amount.is_finite() or amount <= 0 or amount.as_tuple().exponent < -2:
            raise InvalidOperation
        return str(amount.quantize(Decimal("0.01")))
    except InvalidOperation:
        raise MercadoPagoError("billing_price_not_configured", 503) from None


def payer_email_for(real_email: str) -> str:
    """Use a test buyer only with TEST credentials; keep the internal owner unchanged."""
    token = os.getenv("SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN", "").strip()
    if not token.startswith("TEST-"):
        return real_email
    email = os.getenv("SCISONOMICS_MERCADOPAGO_TEST_PAYER_EMAIL", "").strip()
    if not TEST_PAYER_EMAIL.fullmatch(email) or len(email) > 254:
        raise MercadoPagoError("mercadopago_test_payer_not_configured", 503)
    return email


def _provider_diagnostic(response: httpx.Response, sensitive_values: tuple[str, ...]) -> tuple[str, str]:
    """Extract only short, strictly allowlisted fields from an error response."""
    try:
        body = response.json() if len(response.content) <= 4096 else None
    except ValueError:
        body = None
    if not isinstance(body, dict):
        return "unavailable", "unavailable"
    code = body.get("error") or body.get("code")
    message = body.get("message")
    safe_code = code if isinstance(code, str) and PROVIDER_CODE.fullmatch(code) and not any(value in code for value in sensitive_values) and not code.startswith(("TEST-", "APP_USR-")) else "unavailable"
    safe_message = message if isinstance(message, str) and PROVIDER_MESSAGE.fullmatch(message) and not any(value in message for value in sensitive_values) and not message.startswith(("TEST-", "APP_USR-")) else "unavailable"
    return safe_code, safe_message


def public_api_url() -> str:
    raw = os.getenv("SCISONOMICS_PUBLIC_API_URL", "").strip().rstrip("/")
    parsed = urlparse(raw)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise MercadoPagoError("public_api_url_not_configured", 503)
    return raw


def webhook_secret() -> str:
    secret = os.getenv("SCISONOMICS_MERCADOPAGO_WEBHOOK_SECRET", "").strip()
    if not secret:
        raise MercadoPagoError("mercadopago_webhook_secret_not_configured", 503)
    return secret


def verify_webhook_signature(*, signature: str, request_id: str, data_id: str) -> bool:
    """Validate the official x-signature manifest using query-string data.id."""
    if (not signature or len(signature) > 300 or not request_id or len(request_id) > 200
            or not RESOURCE_ID.fullmatch(data_id)):
        return False
    parts = dict(part.strip().split("=", 1) for part in signature.split(",") if "=" in part)
    ts, actual = parts.get("ts", ""), parts.get("v1", "")
    if not ts.isdigit() or not re.fullmatch(r"[a-fA-F0-9]{64}", actual):
        return False
    # Mercado Pago's validator normalizes upper-case resource IDs to lower-case.
    manifest = f"id:{data_id.lower()};request-id:{request_id};ts:{ts};"
    expected = hmac.new(webhook_secret().encode(), manifest.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, actual.lower())


def _resource_id(value: str) -> str:
    if not RESOURCE_ID.fullmatch(str(value)):
        raise MercadoPagoError("invalid_provider_resource_id", 422)
    return str(value)


def validate_checkout_url(value: object, provider_id: str) -> str:
    url = str(value or "")
    try:
        parsed = urlparse(url)
        valid = (url == url.strip() and not any(ord(c) < 33 or c == "\\" for c in url)
                 and parsed.scheme == "https" and parsed.netloc in {"www.mercadopago.com.ar", "www.mercadopago.com"}
                 and parsed.path == "/subscriptions/checkout" and not parsed.fragment
                 and parse_qs(parsed.query).get("preapproval_id") == [str(provider_id)]
                 and "preapproval_plan_id" not in parse_qs(parsed.query))
    except ValueError:
        valid = False
    if not valid:
        raise MercadoPagoError("mercadopago_invalid_checkout_url")
    return url


def request(method: str, path: str, *, payload: dict | None = None, params: dict | None = None) -> dict:
    token = os.getenv("SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN", "").strip()
    if not token:
        raise MercadoPagoError("mercadopago_not_configured", 503)
    try:
        response = httpx.request(
            method,
            f"{API_URL}{path}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=payload,
            params=params,
            timeout=httpx.Timeout(10.0, connect=3.0),
        )
    except httpx.TimeoutException:
        raise MercadoPagoError("mercadopago_timeout", 503) from None
    except httpx.RequestError:
        raise MercadoPagoError("mercadopago_unavailable", 503) from None
    if not response.is_success:
        code, message = _provider_diagnostic(response, (token,))
        _logger.warning("Mercado Pago request failed: status_code=%s code=%s message=%s", response.status_code, code, message)
        raise MercadoPagoError("mercadopago_request_failed", 503 if response.status_code >= 500 else 502)
    try:
        result = response.json()
    except ValueError:
        raise MercadoPagoError("mercadopago_invalid_response") from None
    if not isinstance(result, dict):
        raise MercadoPagoError("mercadopago_invalid_response")
    return result


def get_subscription(provider_id: str) -> dict:
    return request("GET", f"/preapproval/{_resource_id(provider_id)}")


def get_authorized_payment(provider_id: str) -> dict:
    return request("GET", f"/authorized_payments/{_resource_id(provider_id)}")


def cancel_subscription(provider_id: str) -> dict:
    return request("PUT", f"/preapproval/{_resource_id(provider_id)}", payload={"status": "canceled"})
