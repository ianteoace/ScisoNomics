from __future__ import annotations

import os
import re
from urllib.parse import urlsplit
from uuid import UUID

import httpx


class SupabaseAuthError(ValueError):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(code)
        self.code = code
        self.message = message
        self.status_code = status_code


def _supabase_url() -> str:
    return os.getenv("SCISONOMICS_SUPABASE_URL", "").strip().rstrip("/")


def _supabase_publishable_key() -> str:
    return os.getenv("SCISONOMICS_SUPABASE_PUBLISHABLE_KEY", "").strip()


def supabase_auth_enabled() -> bool:
    # A partial configuration must produce an explicit configuration error.
    # No configuration leaves the legacy-only path unchanged.
    return bool(_supabase_url() or _supabase_publishable_key())


def _supabase_config() -> tuple[str, str]:
    url = _supabase_url()
    publishable_key = _supabase_publishable_key()
    if not url or not publishable_key:
        raise SupabaseAuthError("supabase_auth_not_configured", "Falta configurar Supabase Auth en el backend.", 503)

    try:
        parsed = urlsplit(url)
        # Also validate the port before any request is made.
        parsed.port
        local_http = (
            parsed.scheme == "http"
            and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            and os.getenv("SCISONOMICS_ENV", "development").strip().lower() != "production"
        )
        valid_url = (
            bool(parsed.hostname)
            and (parsed.scheme == "https" or local_http)
            and not parsed.username
            and not parsed.password
            and not parsed.query
            and not parsed.fragment
            and not any(char.isspace() for char in url)
        )
    except ValueError:
        valid_url = False
    # This integration accepts modern publishable keys, never service_role or
    # secret API keys. No Supabase JWT signing secret is needed.
    if not valid_url or not publishable_key.startswith("sb_publishable_") or any(char.isspace() for char in publishable_key):
        raise SupabaseAuthError("supabase_auth_invalid_config", "La configuracion de Supabase Auth no es valida.", 503)
    return url, publishable_key


def verify_supabase_access_token(token: str) -> dict[str, str | None]:
    """Validate with Supabase Auth's GET /auth/v1/user (the getUser API).

    Supabase validates the JWT against the configured project; the returned
    user.id is its subject. Never trust a locally decoded JWT or user_metadata
    for identity or email confirmation. This works across signing key types.
    """
    url, publishable_key = _supabase_config()
    if not token or not token.isascii() or any(char.isspace() for char in token):
        raise SupabaseAuthError("invalid_supabase_token", "Sesion Supabase no valida.", 401)

    try:
        response = httpx.get(
            f"{url}/auth/v1/user",
            headers={
                "apikey": publishable_key,
                "Authorization": f"Bearer {token}",
            },
            timeout=8.0,
            follow_redirects=False,
        )
    except httpx.HTTPError:
        # Do not propagate network exception text, headers, or response bodies.
        raise SupabaseAuthError("supabase_auth_unavailable", "Supabase Auth no esta disponible. Intenta nuevamente.", 503) from None

    if response.status_code in {400, 401, 403, 422}:
        raise SupabaseAuthError("invalid_supabase_token", "Sesion Supabase no valida.", 401)
    if response.status_code != 200:
        raise SupabaseAuthError("supabase_auth_unavailable", "Supabase Auth no esta disponible. Intenta nuevamente.", 503)

    try:
        payload = response.json()
    except ValueError:
        raise SupabaseAuthError("invalid_supabase_response", "Respuesta de Supabase Auth no valida.", 502) from None
    if not isinstance(payload, dict):
        raise SupabaseAuthError("invalid_supabase_response", "Respuesta de Supabase Auth no valida.", 502)

    user_id = payload.get("id")
    email = payload.get("email")
    if not isinstance(user_id, str) or not isinstance(email, str):
        raise SupabaseAuthError("invalid_supabase_user", "La identidad Supabase no tiene un usuario y email validos.", 401)
    try:
        UUID(user_id)
    except ValueError:
        raise SupabaseAuthError("invalid_supabase_user", "La identidad Supabase no tiene un usuario valido.", 401) from None
    email = email.strip().lower()
    if len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or payload.get("is_anonymous") is True:
        raise SupabaseAuthError("invalid_supabase_user", "La identidad Supabase no tiene un email valido.", 401)

    confirmed_at = payload.get("email_confirmed_at")
    if not isinstance(confirmed_at, str) or not confirmed_at.strip():
        raise SupabaseAuthError("email_verification_required", "Confirma tu email en Supabase para continuar.", 403)

    metadata = payload.get("user_metadata")
    display_name = None
    if isinstance(metadata, dict):
        for key in ("display_name", "full_name", "name"):
            value = metadata.get(key)
            if isinstance(value, str) and value.strip():
                # Metadata is only a display label, never an identity or role.
                display_name = " ".join(value.split())[:120]
                break
    return {
        "sub": user_id,
        "email": email,
        "email_confirmed_at": confirmed_at,
        "display_name": display_name,
    }
