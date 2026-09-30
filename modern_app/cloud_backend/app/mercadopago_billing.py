"""Small server-only client for Mercado Pago Subscriptions.

Only provider resource IDs are accepted in paths. Never expose the access token
or a provider response body in an exception returned to callers.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
from urllib.parse import urlparse

import httpx


API_URL = "https://api.mercadopago.com"
RESOURCE_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


class MercadoPagoError(Exception):
    def __init__(self, code: str, status_code: int = 502):
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def configured() -> bool:
    return bool(os.getenv("SCISONOMICS_MERCADOPAGO_ACCESS_TOKEN", "").strip())


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
