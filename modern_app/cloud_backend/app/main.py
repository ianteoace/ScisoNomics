from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import socket
import smtplib
import time
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen
from uuid import uuid4
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse

from .auth import (
    create_entitlement_token,
    create_access_token,
    create_email_verification_token,
    create_refresh_token,
    decode_access_token,
    decode_email_verification_token,
    get_access_token_expires_in,
    get_jwt_secret,
    get_refresh_token_expiration_days,
    hash_password,
    hash_refresh_token,
    password_needs_rehash,
    validate_entitlements_signing_config,
    verify_password,
)
from .db import connect, get_database_engine, init_db
from .schemas import (
    AdminBillingEntitlementsUpdateIn,
    BillingEntitlementsOut,
    BillingFeaturesOut,
    AuthResponse,
    EmailVerificationRequiredOut,
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    RegisterRequest,
    ResendEmailVerificationRequest,
    UserOut,
    VerifyEmailRequest,
)
from .security import client_ip, enforce_rate_limit, request_body_limit_bytes, reset_rate_limit, sync_max_records


app = FastAPI(title="ScisoNomics Cloud Auth API", version="3.2.0")
_logger = logging.getLogger("scisonomics.cloud")
SYNC_CONTRACT_VERSION = "3.1.0"
CLOUD_SCHEMA_VERSION = "cloud-sync-v1"
CLOUD_SCHEMA_REVISION = 2
_CLOUD_DB_STATE: dict[str, Any] = {
    "ok": False,
    "status": "initializing",
    "code": "db_initializing",
    "message": "La base cloud se está preparando.",
    "checked": False,
    "repairable": False,
    "error_type": None,
}


def allowed_origins() -> list[str]:
    raw = os.getenv("SCISONOMICS_ALLOWED_ORIGINS", "").strip()
    env = os.getenv("SCISONOMICS_ENV", "development").strip().lower()
    if not raw:
        if env == "production":
            raise RuntimeError("SCISONOMICS_ALLOWED_ORIGINS es obligatorio en produccion.")
        return ["http://127.0.0.1:3000", "http://localhost:3000", "tauri://localhost", "https://tauri.localhost"]
    if raw == "*":
        if env == "production":
            raise RuntimeError("SCISONOMICS_ALLOWED_ORIGINS no puede ser '*' en produccion.")
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]

_allowed_origins = allowed_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=_allowed_origins != ["*"],
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-Scisonomics-Owner-Id",
        "X-Scisonomics-Device-Id",
        "X-Scisonomics-Device-Name",
    ],
)


@app.middleware("http")
async def security_limits_middleware(request: Request, call_next):
    if request.method in {"POST", "PUT", "PATCH"}:
        content_length = request.headers.get("content-length", "").strip()
        if not content_length:
            return JSONResponse(status_code=411, content={"detail": "Content-Length requerido."})
        try:
            if int(content_length) < 0:
                raise ValueError
            if int(content_length) > request_body_limit_bytes():
                return JSONResponse(status_code=413, content={"detail": "Solicitud demasiado grande."})
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Content-Length invalido."})
    return await call_next(request)


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
VERIFICATION_CODE_RE = re.compile(r"^\d{6}$")


@app.on_event("startup")
def startup() -> None:
    get_jwt_secret()
    validate_entitlements_signing_config()
    _refresh_cloud_db_state(run_init=True)


def _cloud_capabilities() -> dict[str, Any]:
    return {
        "sync_tables": list(SYNC_TABLES),
        "incremental_pull": True,
        "server_revisions": True,
        "tags_sync": True,
        "movimiento_tags_sync": True,
        "tombstones": True,
        "sync_cursor": True,
    }


def _refresh_cloud_db_state(*, run_init: bool) -> dict[str, Any]:
    global _CLOUD_DB_STATE
    if run_init:
        try:
            init_db()
            _CLOUD_DB_STATE = {
                "ok": True,
                "status": "ready",
                "code": "db_ready",
                "message": "La base cloud está lista.",
                "checked": True,
                "repairable": False,
                "error_type": None,
            }
        except Exception as exc:
            _logger.exception("[cloud-db] initialization failed error_type=%s", type(exc).__name__)
            _CLOUD_DB_STATE = {
                "ok": False,
                "status": "migration_failed",
                "code": "db_migration_failed",
                "message": "La base cloud no está lista.",
                "checked": True,
                "repairable": False,
                "error_type": type(exc).__name__,
            }
    return dict(_CLOUD_DB_STATE)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _security_audit(
    conn,
    event_type: str,
    *,
    outcome: str,
    actor_id: str | None = None,
    target_id: str | None = None,
    source_ip: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO security_audit_log (event_type, actor_id, target_id, source_ip, outcome, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_type[:80],
            actor_id,
            target_id,
            source_ip,
            outcome[:32],
            json.dumps(details or {}, separators=(",", ":"), sort_keys=True)[:2000],
            now_iso(),
        ),
    )


def normalize_email(email: str) -> str:
    return email.strip().lower()


def mask_email(email: str) -> str:
    normalized = normalize_email(email)
    if "@" not in normalized:
        return "***"
    local, domain = normalized.split("@", 1)
    if not local:
        return f"***@{domain}"
    # Conservar contexto minimo para soporte sin registrar el email completo.
    return f"{local[:3]}***@{domain}"


def short_identifier(value: str) -> str:
    clean = str(value or "").strip()
    if len(clean) <= 8:
        return "***"
    return f"{clean[:4]}...{clean[-4:]}"


def _env_int(name: str, default: int, minimum: int) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def email_verification_ttl_seconds() -> int:
    return _env_int("SCISONOMICS_EMAIL_VERIFICATION_TTL_MINUTES", 10, 1) * 60


def email_verification_resend_seconds() -> int:
    return _env_int("SCISONOMICS_EMAIL_RESEND_SECONDS", 60, 10)


def email_verification_max_resends_per_hour() -> int:
    return _env_int("SCISONOMICS_EMAIL_MAX_RESENDS_PER_HOUR", 5, 1)


def _seconds_until(value: str | None, *, default: int = 0) -> int:
    target = parse_sync_datetime(value)
    if target is None:
        return default
    return max(0, int((target - datetime.now(timezone.utc)).total_seconds()))


def _email_verification_error(status_code: int, code: str, message: str, **extra: Any) -> HTTPException:
    detail = {"code": code, "message": message, **extra}
    return HTTPException(status_code=status_code, detail=detail)


def _generate_verification_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _hash_verification_code(user_id: str, purpose: str, code: str) -> str:
    secret = get_jwt_secret().encode("utf-8")
    message = f"{user_id}:{purpose}:{code}".encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def _email_provider() -> str:
    provider = os.getenv("SCISONOMICS_EMAIL_PROVIDER", "").strip().lower()
    if provider:
        return provider
    return "console" if os.getenv("SCISONOMICS_ENV", "development").strip().lower() != "production" else ""


class EmailDeliveryError(RuntimeError):
    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


def _smtp_timeout(name: str, default: int) -> int:
    return _env_int(name, default, 1)


def _set_smtp_operation_timeout(smtp: smtplib.SMTP, *, deadline: float, operation_timeout: int) -> None:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise EmailDeliveryError("timeout")
    if smtp.sock is not None:
        smtp.sock.settimeout(min(float(operation_timeout), remaining))


def send_verification_email(email: str, code: str) -> None:
    provider = _email_provider()
    sender = os.getenv("SCISONOMICS_EMAIL_FROM", "").strip()
    ttl_minutes = _env_int("SCISONOMICS_EMAIL_VERIFICATION_TTL_MINUTES", 10, 1)
    body = (
        "ScisoNomics\n\n"
        f"Tu codigo de verificacion es: {code}\n\n"
        f"Este codigo vence en {ttl_minutes} minutos. Si no creaste una cuenta, podes ignorar este mensaje.\n\n"
        "Soporte: scisoftwareco@gmail.com"
    )

    if provider in {"console", "memory", "fake"}:
        if os.getenv("SCISONOMICS_ENV", "development").strip().lower() == "production":
            raise RuntimeError("Proveedor de email dev-only deshabilitado en produccion.")
        _DEV_EMAIL_OUTBOX.append({"email": email, "code": code, "body": body})
        return

    if provider == "smtp":
        host = os.getenv("SCISONOMICS_SMTP_HOST", "").strip()
        port = _env_int("SCISONOMICS_SMTP_PORT", 587, 1)
        username = os.getenv("SCISONOMICS_SMTP_USERNAME", "").strip()
        password = os.getenv("SCISONOMICS_SMTP_PASSWORD", "")
        use_tls = os.getenv("SCISONOMICS_SMTP_USE_TLS", "true").strip().lower() not in {"0", "false", "no", "off"}
        if not host or not sender:
            raise EmailDeliveryError("configuration")
        connect_timeout = _smtp_timeout("SCISONOMICS_SMTP_CONNECT_TIMEOUT_SECONDS", 8)
        operation_timeout = _smtp_timeout("SCISONOMICS_SMTP_OPERATION_TIMEOUT_SECONDS", 10)
        total_timeout = _smtp_timeout("SCISONOMICS_SMTP_TOTAL_TIMEOUT_SECONDS", 20)
        deadline = time.monotonic() + total_timeout
        message = EmailMessage()
        message["Subject"] = "Tu codigo de verificacion de ScisoNomics"
        message["From"] = sender
        message["To"] = email
        message.set_content(body)
        try:
            with smtplib.SMTP(host, port, timeout=min(connect_timeout, total_timeout)) as smtp:
                if use_tls:
                    _set_smtp_operation_timeout(smtp, deadline=deadline, operation_timeout=operation_timeout)
                    smtp.starttls()
                if username or password:
                    _set_smtp_operation_timeout(smtp, deadline=deadline, operation_timeout=operation_timeout)
                    smtp.login(username, password)
                _set_smtp_operation_timeout(smtp, deadline=deadline, operation_timeout=operation_timeout)
                smtp.send_message(message)
        except EmailDeliveryError:
            raise
        except smtplib.SMTPAuthenticationError as exc:
            raise EmailDeliveryError("authentication") from exc
        except (socket.timeout, TimeoutError) as exc:
            raise EmailDeliveryError("timeout") from exc
        except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError) as exc:
            raise EmailDeliveryError("rejected") from exc
        except (smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected, ConnectionError, OSError) as exc:
            raise EmailDeliveryError("connection") from exc
        except smtplib.SMTPException as exc:
            raise EmailDeliveryError("protocol") from exc
        return

    raise EmailDeliveryError("configuration")


_DEV_EMAIL_OUTBOX: list[dict[str, str]] = []


def _create_signup_verification(conn, *, user_id: str, email: str, now: str) -> EmailVerificationRequiredOut:
    code = _generate_verification_code()
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=email_verification_ttl_seconds())).isoformat(timespec="seconds")
    conn.execute(
        """
        UPDATE email_verification_codes
        SET invalidated_at = COALESCE(invalidated_at, ?)
        WHERE user_id = ? AND purpose = 'signup' AND consumed_at IS NULL AND invalidated_at IS NULL
        """,
        (now, user_id),
    )
    conn.execute(
        """
        INSERT INTO email_verification_codes
            (user_id, purpose, code_hash, expires_at, attempts, max_attempts, consumed_at, created_at, last_sent_at, invalidated_at)
        VALUES (?, 'signup', ?, ?, 0, 5, NULL, ?, ?, NULL)
        """,
        (user_id, _hash_verification_code(user_id, "signup", code), expires_at, now, "1970-01-01T00:00:00+00:00"),
    )
    # La cuenta y el codigo deben sobrevivir aunque SMTP falle o el cliente se desconecte.
    conn.commit()
    response = _verification_required_response(
        user_id=user_id,
        email=email,
        expires_at=expires_at,
        resend_available_in=0,
    )
    send_started = time.monotonic()
    _logger.info("[email-verification] email send start user=%s", short_identifier(user_id))
    try:
        send_verification_email(email, code)
    except EmailDeliveryError as exc:
        _logger.warning(
            "[email-verification] email send failure user=%s kind=%s duration_ms=%d",
            short_identifier(user_id),
            exc.kind,
            int((time.monotonic() - send_started) * 1000),
        )
        raise _email_verification_error(
            503,
            "email_delivery_failed",
            "La cuenta quedo creada, pero no pudimos enviar el codigo de verificacion.",
            verification=response.model_dump(),
        ) from exc
    except Exception as exc:
        _logger.warning(
            "[email-verification] email send failure user=%s kind=unexpected duration_ms=%d",
            short_identifier(user_id),
            int((time.monotonic() - send_started) * 1000),
        )
        raise _email_verification_error(
            503,
            "email_delivery_failed",
            "La cuenta quedo creada, pero no pudimos enviar el codigo de verificacion.",
            verification=response.model_dump(),
        ) from exc
    sent_at = now_iso()
    conn.execute(
        "UPDATE email_verification_codes SET last_sent_at = ? WHERE user_id = ? AND purpose = 'signup' AND invalidated_at IS NULL",
        (sent_at, user_id),
    )
    conn.commit()
    _logger.info(
        "[email-verification] email send success user=%s duration_ms=%d",
        short_identifier(user_id),
        int((time.monotonic() - send_started) * 1000),
    )
    return _verification_required_response(user_id=user_id, email=email, expires_at=expires_at)


def _verification_required_response(
    *,
    user_id: str,
    email: str,
    expires_at: str | None = None,
    resend_available_in: int | None = None,
) -> EmailVerificationRequiredOut:
    return EmailVerificationRequiredOut(
        email=mask_email(email),
        verification_token=create_email_verification_token(user_id, purpose="signup"),
        verification_expires_in=_seconds_until(expires_at, default=email_verification_ttl_seconds()),
        resend_available_in=email_verification_resend_seconds() if resend_available_in is None else max(0, resend_available_in),
    )


def _resend_wait_seconds(code_row) -> int:
    if code_row is None:
        return 0
    last_sent = parse_sync_datetime(code_row["last_sent_at"])
    if last_sent is None:
        return 0
    elapsed = (datetime.now(timezone.utc) - last_sent).total_seconds()
    return max(0, email_verification_resend_seconds() - int(elapsed))


def _active_signup_code(conn, user_id: str):
    return conn.execute(
        """
        SELECT id, user_id, purpose, code_hash, expires_at, attempts, max_attempts, consumed_at, created_at, last_sent_at, invalidated_at
        FROM email_verification_codes
        WHERE user_id = ? AND purpose = 'signup' AND consumed_at IS NULL AND invalidated_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        """,
        (user_id,),
    ).fetchone()


def _resend_limit_reached(conn, user_id: str) -> bool:
    window_start = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec="seconds")
    row = conn.execute(
        """
        SELECT COUNT(*) AS total
        FROM email_verification_codes
        WHERE user_id = ? AND purpose = 'signup' AND created_at >= ?
        """,
        (user_id, window_start),
    ).fetchone()
    # La primera generacion no es un reenvio; se permiten N reenvios adicionales.
    return int(row["total"] or 0) >= (email_verification_max_resends_per_hour() + 1)


def _continue_unverified_verification(conn, user_row, *, now: str) -> EmailVerificationRequiredOut:
    code_row = _active_signup_code(conn, user_row["id"])
    if code_row is not None and _seconds_until(code_row["expires_at"]) > 0:
        wait = _resend_wait_seconds(code_row)
        if wait > 0:
            return _verification_required_response(
                user_id=user_row["id"],
                email=user_row["email"],
                expires_at=code_row["expires_at"],
                resend_available_in=wait,
            )
    if _resend_limit_reached(conn, user_row["id"]):
        raise _email_verification_error(
            429,
            "verification_resend_limit_exceeded",
            "Pediste demasiados codigos. Intenta mas tarde.",
        )
    return _create_signup_verification(conn, user_id=user_row["id"], email=user_row["email"], now=now)


def _verification_user_from_token(conn, verification_token: str):
    try:
        payload = decode_email_verification_token(verification_token, purpose="signup")
    except ValueError as exc:
        raise _email_verification_error(401, "verification_token_invalid", "La verificacion vencio o no es valida.") from exc
    user_id = str(payload.get("sub") or "").strip()
    if not user_id:
        raise _email_verification_error(401, "verification_token_invalid", "La verificacion vencio o no es valida.")
    row = conn.execute(
        "SELECT id, email, display_name, created_at, updated_at, email_verified, email_verified_at FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if row is None:
        raise _email_verification_error(401, "verification_token_invalid", "La verificacion vencio o no es valida.")
    return row


def _email_is_verified(row) -> bool:
    try:
        return bool(row["email_verified"])
    except Exception:
        return True


def _issue_auth_response(
    conn,
    user: UserOut,
    *,
    now: str,
    rotate_from_hash: str | None = None,
    device_id: str | None = None,
    device_name: str | None = None,
) -> AuthResponse:
    refresh_token = create_refresh_token()
    refresh_token_id = str(uuid4())
    refresh_token_hash = hash_refresh_token(refresh_token)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=get_refresh_token_expiration_days())).isoformat(timespec="seconds")
    parent_token_id = None
    family_id = refresh_token_id
    if rotate_from_hash:
        previous = conn.execute(
            "SELECT id, family_id FROM cloud_refresh_tokens WHERE token_hash = ? LIMIT 1",
            (rotate_from_hash,),
        ).fetchone()
        if previous:
            parent_token_id = previous["id"]
            family_id = str(previous["family_id"] or previous["id"])
        conn.execute(
            """
            UPDATE cloud_refresh_tokens
            SET revoked_at = COALESCE(revoked_at, ?), last_used_at = ?
            WHERE token_hash = ?
            """,
            (now, now, rotate_from_hash),
        )
    conn.execute(
        """
        INSERT INTO cloud_refresh_tokens (
            id, user_id, token_hash, created_at, expires_at, revoked_at, last_used_at,
            device_id, device_name, family_id, parent_token_id, compromised_at
        )
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)
        """,
        (refresh_token_id, user.id, refresh_token_hash, now, expires_at, now, device_id, device_name, family_id, parent_token_id),
    )
    access_token = create_access_token(user.id)
    return AuthResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        token_type="bearer",
        expires_in=get_access_token_expires_in(),
        token=access_token,
        user=user,
    )


def _extract_device_context(request: Request) -> tuple[str | None, str | None]:
    device_id = request.headers.get("X-Scisonomics-Device-Id", "").strip() or None
    device_name = request.headers.get("X-Scisonomics-Device-Name", "").strip() or None
    return device_id, device_name


def _lookup_refresh_token(conn, refresh_token: str):
    token_hash = hash_refresh_token(refresh_token)
    row = conn.execute(
        """
        SELECT id, user_id, token_hash, created_at, expires_at, revoked_at, last_used_at,
               device_id, device_name, family_id, parent_token_id, compromised_at
        FROM cloud_refresh_tokens
        WHERE token_hash = ?
        LIMIT 1
        """,
        (token_hash,),
    ).fetchone()
    return row, token_hash


def _validate_refresh_token_row(row, *, now: str):
    if row is None:
        raise HTTPException(status_code=401, detail="Refresh token invalido.")
    if row["revoked_at"]:
        raise HTTPException(status_code=401, detail="Refresh token revocado.")
    expires_at = parse_sync_datetime(row["expires_at"])
    if not expires_at or expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="Refresh token expirado.")
    return row


def validate_credentials(email: str, password: str) -> str:
    normalized_email = normalize_email(email)
    if not EMAIL_RE.match(normalized_email):
        raise HTTPException(status_code=422, detail="Ingresa un email valido.")
    if len(password) < 12 or len(password) > 256:
        raise HTTPException(status_code=422, detail="La contrasena debe tener entre 12 y 256 caracteres.")
    compact = re.sub(r"[^a-z0-9]", "", password.lower())
    weak_passwords = {"password", "password123", "contrasena", "contrasena123", "scisonomics", "123456789012", "qwertyuiop12"}
    if compact in weak_passwords or compact == normalized_email.split("@", 1)[0]:
        raise HTTPException(status_code=422, detail="Elegi una contrasena menos predecible.")
    return normalized_email


def _reject_breached_password(password: str) -> None:
    env = os.getenv("SCISONOMICS_CHECK_BREACHED_PASSWORDS", "").strip().lower()
    enabled = env in {"1", "true", "yes", "on"} or (
        not env and os.getenv("SCISONOMICS_ENV", "development").strip().lower() == "production"
    )
    if not enabled:
        return
    digest = hashlib.sha1(password.encode("utf-8")).hexdigest().upper()
    prefix, suffix = digest[:5], digest[5:]
    request = UrlRequest(
        f"https://api.pwnedpasswords.com/range/{prefix}",
        headers={"User-Agent": "ScisoNomics-Security", "Add-Padding": "true"},
        method="GET",
    )
    try:
        with urlopen(request, timeout=4) as response:
            result = response.read().decode("utf-8", errors="replace")
    except Exception as exc:
        _logger.warning("No se pudo consultar passwords filtradas. error_type=%s", type(exc).__name__)
        return
    for line in result.splitlines():
        candidate = line.split(":", 1)[0].strip().upper()
        if candidate and hmac.compare_digest(candidate, suffix):
            raise HTTPException(status_code=422, detail="Esa contrasena aparece en filtraciones conocidas. Elegi otra.")


def _require_debug_endpoints_enabled() -> None:
    enabled = os.getenv("SCISONOMICS_ENABLE_DEBUG_ENDPOINTS", "").strip().lower() in {"1", "true", "yes", "on"}
    if not enabled:
        raise HTTPException(status_code=404, detail="Not Found")


def _admin_billing_enabled() -> bool:
    return os.getenv("SCISONOMICS_ENABLE_ADMIN_BILLING", "").strip().lower() in {"1", "true", "yes", "on"}


def _load_json_secret_map(name: str) -> dict[str, str]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=503, detail=f"Configuracion administrativa invalida: {name}.") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=503, detail=f"Configuracion administrativa invalida: {name}.")
    return {str(key).strip(): str(value).strip() for key, value in parsed.items() if str(key).strip() and str(value).strip()}


def _valid_totp(secret: str, provided: str | None) -> bool:
    code = str(provided or "").strip()
    normalized = secret.strip().replace(" ", "").upper()
    if not re.fullmatch(r"\d{6}", code) or not normalized:
        return False
    try:
        key = base64.b32decode(normalized + "=" * (-len(normalized) % 8))
    except Exception:
        return False
    counter = int(time.time()) // 30
    for drift in (-1, 0, 1):
        digest = hmac.new(key, (counter + drift).to_bytes(8, "big"), hashlib.sha1).digest()
        offset = digest[-1] & 0x0F
        value = (int.from_bytes(digest[offset:offset + 4], "big") & 0x7FFFFFFF) % 1_000_000
        if secrets.compare_digest(f"{value:06d}", code):
            return True
    return False


def _require_admin_billing_access(admin_id: str | None, admin_token: str | None, admin_totp: str | None) -> str:
    if not _admin_billing_enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    identity = str(admin_id or "").strip()
    token_map = _load_json_secret_map("SCISONOMICS_ADMIN_TOKENS_JSON")
    totp_map = _load_json_secret_map("SCISONOMICS_ADMIN_TOTP_SECRETS_JSON")
    expected = token_map.get(identity, "") if identity else ""
    if not token_map and os.getenv("SCISONOMICS_ENV", "development").strip().lower() != "production":
        identity = identity or "legacy-admin"
        expected = os.getenv("SCISONOMICS_ADMIN_TOKEN", "").strip()
    provided = str(admin_token or "").strip()
    if not identity or not expected:
        raise HTTPException(status_code=503, detail="Admin billing token no configurado.")
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=403, detail="Acceso administrativo inválido.")
    totp_secret = totp_map.get(identity, "")
    production = os.getenv("SCISONOMICS_ENV", "development").strip().lower() == "production"
    if production and not totp_secret:
        raise HTTPException(status_code=503, detail="MFA administrativo no configurado.")
    if totp_secret and not _valid_totp(totp_secret, admin_totp):
        raise HTTPException(status_code=403, detail="Segundo factor administrativo invalido.")
    return identity


def row_to_user(row) -> UserOut:
    return UserOut(
        id=row["id"],
        email=row["email"],
        display_name=row["display_name"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _normalize_plan(value: Any) -> str:
    plan = str(value or "").strip().lower()
    return "premium" if plan == "premium" else "free"


def _normalize_subscription_status(value: Any) -> str:
    status = str(value or "").strip().lower()
    if status in {"active", "trialing", "past_due", "canceled", "expired"}:
        return status
    return "active"


def _billing_features_for_plan(plan: str, status: str, expires_at: datetime | None = None) -> BillingFeaturesOut:
    premium_enabled = plan == "premium" and status in {"active", "trialing"}
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        premium_enabled = False
    return BillingFeaturesOut(
        budgets=premium_enabled,
        saving_goals=premium_enabled,
        fixed_expenses=premium_enabled,
        planning=premium_enabled,
    )


def _entitlements_from_user_row(row) -> BillingEntitlementsOut:
    user_id = str(row["id"] or "").strip()
    if not user_id:
        raise RuntimeError("El usuario no tiene un identificador valido para emitir entitlements.")
    plan = _normalize_plan(row["plan"] if "plan" in row.keys() else None)
    status = _normalize_subscription_status(row["subscription_status"] if "subscription_status" in row.keys() else None)
    expires_at = row["subscription_expires_at"] if "subscription_expires_at" in row.keys() else None
    normalized_expires_at = str(expires_at).strip() if expires_at is not None else ""
    subscription_expiration = parse_sync_datetime(normalized_expires_at) if normalized_expires_at else None
    now = datetime.now(timezone.utc).replace(microsecond=0)
    try:
        lifetime_seconds = max(300, min(int(os.getenv("SCISONOMICS_ENTITLEMENTS_EXPIRE_SECONDS", "86400")), 86400))
    except ValueError:
        lifetime_seconds = 86400
    token_expiration = now + timedelta(seconds=lifetime_seconds)
    if subscription_expiration is not None and subscription_expiration < token_expiration:
        token_expiration = subscription_expiration
    features = _billing_features_for_plan(plan, status, subscription_expiration)
    claims = {
        "type": "scisonomics_entitlement",
        "user_id": user_id,
        "plan": plan,
        "status": status,
        "features": features.model_dump(),
        "subscription_expires_at": normalized_expires_at or None,
        "iat": int(now.timestamp()),
        "exp": int(token_expiration.timestamp()),
    }
    return BillingEntitlementsOut(
        user_id=user_id,
        plan=plan,
        status=status,
        features=features,
        expires_at=normalized_expires_at or None,
        issued_at=now.isoformat(),
        valid_until=token_expiration.isoformat(),
        entitlement_token=create_entitlement_token(claims),
    )


def _admin_update_user_entitlements(
    conn,
    *,
    email: str,
    plan: str,
    subscription_status: str,
    subscription_expires_at: str | None,
    now: str,
):
    normalized_email = normalize_email(email)
    if not EMAIL_RE.match(normalized_email):
        raise HTTPException(status_code=422, detail="Ingresa un email valido.")
    normalized_plan = _normalize_plan(plan)
    normalized_status = _normalize_subscription_status(subscription_status)
    expires_at = str(subscription_expires_at or "").strip() or None
    if expires_at and parse_sync_datetime(expires_at) is None:
        raise HTTPException(status_code=422, detail="subscription_expires_at invalido.")

    row = conn.execute(
        """
        SELECT id, email, plan, subscription_status, subscription_expires_at
        FROM users
        WHERE LOWER(TRIM(email)) = ?
        LIMIT 1
        """,
        (normalized_email,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Usuario no encontrado.")

    conn.execute(
        """
        UPDATE users
        SET plan = ?, subscription_status = ?, subscription_expires_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (normalized_plan, normalized_status, expires_at, now, row["id"]),
    )
    updated = conn.execute(
        """
        SELECT id, email, plan, subscription_status, subscription_expires_at
        FROM users
        WHERE id = ?
        """,
        (row["id"],),
    ).fetchone()
    return updated


def _google_config() -> tuple[str, str, str]:
    client_id = os.getenv("SCISONOMICS_GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.getenv("SCISONOMICS_GOOGLE_CLIENT_SECRET", "").strip()
    redirect_uri = os.getenv("SCISONOMICS_GOOGLE_REDIRECT_URI", "").strip()
    if not client_id or not client_secret or not redirect_uri:
        raise HTTPException(status_code=503, detail="Google Login no esta configurado.")
    return client_id, client_secret, redirect_uri


def _cleanup_google_login_requests(conn, now: str) -> None:
    conn.execute("DELETE FROM google_login_requests WHERE expires_at < ?", (now,))


def _http_json(url: str, *, method: str = "GET", data: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> dict[str, Any]:
    encoded = None
    request_headers = dict(headers or {})
    if data is not None:
        encoded = urlencode(data).encode("utf-8")
        request_headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = UrlRequest(url, data=encoded, headers=request_headers, method=method)
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def _exchange_google_code(code: str, client_id: str, client_secret: str, redirect_uri: str) -> dict[str, Any]:
    token_response = _http_json(
        "https://oauth2.googleapis.com/token",
        method="POST",
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
    )
    access_token = token_response.get("access_token")
    if not access_token:
        raise HTTPException(status_code=400, detail="Google no devolvio un token valido.")
    return _http_json(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
    )


def _find_user_by_normalized_email(conn, email: str):
    normalized = normalize_email(email)
    return conn.execute(
        """
        SELECT id, email, display_name, created_at, updated_at, google_sub
        FROM users
        WHERE LOWER(TRIM(email)) = ?
        ORDER BY CASE WHEN password_hash IS NOT NULL AND password_hash <> '' THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1
        """,
        (normalized,),
    ).fetchone()


def _find_or_create_google_user(conn, profile: dict[str, Any], now: str) -> UserOut:
    google_sub = str(profile.get("sub") or "").strip()
    original_email = str(profile.get("email") or "")
    email = normalize_email(original_email)
    display_name = str(profile.get("name") or "").strip() or None
    avatar_url = str(profile.get("picture") or "").strip() or None
    google_email_verified = bool(profile.get("email_verified", True))
    if not google_sub or not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Google no devolvio un perfil valido.")
    _logger.info("[google-auth] callback profile google_sub=%s email=%s", short_identifier(google_sub), mask_email(email))

    google_row = conn.execute(
        "SELECT id, email, display_name, created_at, updated_at, google_sub FROM users WHERE google_sub = ?",
        (google_sub,),
    ).fetchone()
    email_row = _find_user_by_normalized_email(conn, email)
    if google_row and email_row and google_row["id"] != email_row["id"]:
        _logger.info(
            "[google-auth] google_sub=%s email=%s found_by_google_sub=%s found_by_email=%s action=relink_existing_email user_id=%s duplicate_user_id=%s",
            short_identifier(google_sub),
            mask_email(email),
            True,
            True,
            short_identifier(email_row["id"]),
            short_identifier(google_row["id"]),
        )
        conn.execute(
            """
            UPDATE users
            SET google_sub = NULL, updated_at = ?
            WHERE id = ?
            """,
            (now, google_row["id"]),
        )
        conn.execute(
            """
            UPDATE users
            SET email = ?, google_sub = ?, display_name = COALESCE(display_name, ?), avatar_url = ?, auth_provider = 'google',
                email_verified = CASE WHEN ? THEN 1 ELSE COALESCE(email_verified, 0) END,
                email_verified_at = CASE WHEN ? THEN COALESCE(email_verified_at, ?) ELSE email_verified_at END,
                updated_at = ?
            WHERE id = ?
            """,
            (email, google_sub, display_name, avatar_url, google_email_verified, google_email_verified, now, now, email_row["id"]),
        )
        updated = conn.execute("SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?", (email_row["id"],)).fetchone()
        return row_to_user(updated)

    if google_row:
        _logger.info(
            "[google-auth] google_sub=%s email=%s found_by_google_sub=%s found_by_email=%s action=use_google_sub user_id=%s",
            short_identifier(google_sub),
            mask_email(email),
            True,
            bool(email_row),
            short_identifier(google_row["id"]),
        )
        conn.execute(
            """
            UPDATE users
            SET email = ?, display_name = COALESCE(?, display_name), avatar_url = ?, auth_provider = 'google',
                email_verified = CASE WHEN ? THEN 1 ELSE COALESCE(email_verified, 0) END,
                email_verified_at = CASE WHEN ? THEN COALESCE(email_verified_at, ?) ELSE email_verified_at END,
                updated_at = ?
            WHERE id = ?
            """,
            (email, display_name, avatar_url, google_email_verified, google_email_verified, now, now, google_row["id"]),
        )
        updated = conn.execute("SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?", (google_row["id"],)).fetchone()
        return row_to_user(updated)

    if email_row:
        _logger.info(
            "[google-auth] google_sub=%s email=%s found_by_google_sub=%s found_by_email=%s action=link_existing_email user_id=%s",
            short_identifier(google_sub),
            mask_email(email),
            False,
            True,
            short_identifier(email_row["id"]),
        )
        conn.execute(
            """
            UPDATE users
            SET email = ?, google_sub = ?, display_name = COALESCE(display_name, ?), avatar_url = ?, auth_provider = 'google',
                email_verified = CASE WHEN ? THEN 1 ELSE COALESCE(email_verified, 0) END,
                email_verified_at = CASE WHEN ? THEN COALESCE(email_verified_at, ?) ELSE email_verified_at END,
                updated_at = ?
            WHERE id = ?
            """,
            (email, google_sub, display_name, avatar_url, google_email_verified, google_email_verified, now, now, email_row["id"]),
        )
        updated = conn.execute("SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?", (email_row["id"],)).fetchone()
        return row_to_user(updated)

    user_id = str(uuid4())
    _logger.info(
        "[google-auth] google_sub=%s email=%s found_by_google_sub=%s found_by_email=%s action=create_new_user user_id=%s",
        short_identifier(google_sub),
        mask_email(email),
        False,
        False,
        short_identifier(user_id),
    )
    conn.execute(
        """
        INSERT INTO users (id, email, password_hash, display_name, google_sub, avatar_url, auth_provider, email_verified, email_verified_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'google', ?, ?, ?, ?)
        """,
        (user_id, email, "", display_name, google_sub, avatar_url, 1 if google_email_verified else 0, now if google_email_verified else None, now, now),
    )
    created = conn.execute("SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?", (user_id,)).fetchone()
    return row_to_user(created)


def parse_sync_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return ensure_utc_aware(datetime.fromisoformat(str(value).replace("Z", "+00:00")))
    except ValueError:
        try:
            return ensure_utc_aware(datetime.strptime(str(value), "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            return None


def ensure_utc_aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


SYNC_TABLES = ("categorias", "tags", "metas_ahorro", "gastos_programados", "gastos_fijos", "presupuestos", "movimientos", "movimiento_tags")

SYNC_CONFIG: dict[str, dict[str, Any]] = {
    "categorias": {
        "table": "cloud_categorias",
        "required": ("nombre", "tipo"),
        "fields": ("nombre", "tipo", "color", "icono"),
        "order": "nombre",
    },
    "movimientos": {
        "table": "cloud_movimientos",
        "required": ("tipo", "fecha"),
        "fields": ("tipo", "monto", "descripcion", "categoria_id", "categoria_sync_id", "fecha"),
        "order": "fecha DESC, id DESC",
    },
    "metas_ahorro": {
        "table": "cloud_metas_ahorro",
        "required": ("nombre",),
        "fields": ("nombre", "monto_objetivo", "monto_inicial", "fecha_objetivo", "descripcion", "estado"),
        "order": "created_at DESC, id DESC",
    },
    "gastos_programados": {
        "table": "cloud_gastos_programados",
        "required": ("descripcion",),
        "fields": ("descripcion", "categoria_sync_id", "monto_estimado", "fecha_vencimiento", "estado", "es_recurrente", "frecuencia"),
        "order": "fecha_vencimiento ASC, id DESC",
    },
    "gastos_fijos": {
        "table": "cloud_gastos_fijos",
        "required": ("descripcion",),
        "fields": ("descripcion", "categoria_sync_id", "monto", "dia_vencimiento", "activo"),
        "order": "dia_vencimiento ASC, id DESC",
    },
    "presupuestos": {
        "table": "cloud_presupuestos",
        "required": ("mes", "anio"),
        "fields": ("categoria_sync_id", "mes", "anio", "monto"),
        "order": "anio DESC, mes DESC, id DESC",
    },
    "tags": {
        "table": "cloud_tags",
        "required": ("nombre",),
        "fields": ("nombre", "color"),
        "order": "nombre, id DESC",
    },
    "movimiento_tags": {
        "table": "cloud_movimiento_tags",
        "required": ("movimiento_sync_id", "tag_sync_id"),
        "fields": ("movimiento_sync_id", "tag_sync_id"),
        "order": "id DESC",
    },
}

RejectedSyncItem = dict[str, str]


def _valid_sync_item(item: dict[str, Any], config: dict[str, Any]) -> bool:
    sync_id = str(item.get("sync_id") or "").strip()
    if not sync_id:
        return False
    return all(item.get(field) not in (None, "") for field in config["required"])


def _is_non_negative_sync_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value)) and float(value) >= 0


def _valid_simple_sync_semantics(key: str, item: dict[str, Any]) -> bool:
    if key == "presupuestos":
        mes = item.get("mes")
        anio = item.get("anio")
        return (
            isinstance(mes, int) and not isinstance(mes, bool) and 1 <= mes <= 12
            and isinstance(anio, int) and not isinstance(anio, bool) and 2000 <= anio <= 2100
            and _is_non_negative_sync_number(item.get("monto"))
        )
    if key == "gastos_fijos":
        activo = item.get("activo")
        dia = item.get("dia_vencimiento")
        return (
            type(activo) in (int, bool) and activo in (0, 1, False, True)
            and (dia is None or (isinstance(dia, int) and not isinstance(dia, bool) and 1 <= dia <= 31))
            and _is_non_negative_sync_number(item.get("monto"))
        )
    if key == "gastos_programados":
        recurrente = item.get("es_recurrente")
        return (
            item.get("estado") in {"pendiente", "pagado", "cancelado"}
            and item.get("frecuencia") in {None, "mensual", "semanal", "anual"}
            and type(recurrente) in (int, bool) and recurrente in (0, 1, False, True)
            and _is_non_negative_sync_number(item.get("monto_estimado"))
        )
    if key == "metas_ahorro":
        current_field = "monto_actual" if "monto_actual" in item else "monto_inicial"
        return (
            item.get("estado") in {"activa", "completada", "pausada"}
            and _is_non_negative_sync_number(item.get("monto_objetivo"))
            and _is_non_negative_sync_number(item.get(current_field, 0))
        )
    return True


def _rejected_item(entity: str, sync_id: str | None, code: str, message: str) -> RejectedSyncItem:
    return {
        "entity": entity,
        "sync_id": str(sync_id or "").strip(),
        "code": code,
        "message": message,
    }


def _push_table(
    conn,
    user_id: str,
    key: str,
    items: list[dict[str, Any]],
    now: str,
    device_id: str | None,
    device_name: str | None,
) -> tuple[list[str], list[RejectedSyncItem], int]:
    config = SYNC_CONFIG[key]
    table = config["table"]
    fields = list(config["fields"])
    accepted: list[str] = []
    rejected: list[RejectedSyncItem] = []
    conflicts = 0

    for item in items:
        if not isinstance(item, dict):
            rejected.append(_rejected_item(key, None, "invalid_payload", "Registro invalido."))
            continue
        if not _valid_sync_item(item, config) or not _valid_simple_sync_semantics(key, item):
            rejected.append(_rejected_item(key, item.get("sync_id"), "invalid_payload", "Registro invalido."))
            continue
        sync_id = str(item.get("sync_id") or "").strip()
        existing = conn.execute(
            f"SELECT remote_updated_at, last_modified_device_id FROM {table} WHERE user_id = ? AND sync_id = ?",
            (user_id, sync_id),
        ).fetchone()

        # Old clients omit the baseline and keep full-pull compatibility. New clients
        # use the cloud revision to avoid overwriting changes from another device.
        baseline = str(item.get("last_remote_updated_at") or "").strip()
        current_revision = str(existing["remote_updated_at"] or "").strip() if existing else ""
        current_device = str(existing["last_modified_device_id"] or "").strip() if existing else ""
        if existing and baseline and baseline != current_revision and current_device != str(device_id or ""):
            conflicts += 1
            rejected.append(_rejected_item(key, sync_id, "conflict_remote_newer", "El registro fue actualizado por otro dispositivo."))
            continue
        last_modified_at = now
        base_columns = [
            "user_id", "sync_id", *fields, "created_at", "updated_at", "deleted_at", "sync_status", "remote_updated_at",
            "last_modified_device_id", "last_modified_device_name", "last_modified_at",
        ]
        placeholders = ", ".join(["?"] * len(base_columns))
        update_assignments = ", ".join(
            [
                *(f"{field} = excluded.{field}" for field in fields),
                f"created_at = COALESCE({table}.created_at, excluded.created_at)",
                "updated_at = excluded.updated_at",
                "deleted_at = excluded.deleted_at",
                "sync_status = excluded.sync_status",
                "remote_updated_at = excluded.remote_updated_at",
                "last_modified_device_id = excluded.last_modified_device_id",
                "last_modified_device_name = excluded.last_modified_device_name",
                "last_modified_at = excluded.last_modified_at",
            ]
        )
        values = [
            user_id,
            sync_id,
            *(item.get(field) for field in fields),
            item.get("created_at") or now,
            item.get("updated_at") or now,
            item.get("deleted_at"),
            item.get("sync_status") or "synced",
            now,
            device_id,
            device_name,
            last_modified_at,
        ]
        conn.execute(
            f"""
            INSERT INTO {table} ({", ".join(base_columns)})
            VALUES ({placeholders})
            ON CONFLICT(user_id, sync_id) DO UPDATE SET {update_assignments}
            """,
            tuple(values),
        )
        saved = conn.execute(
            f"SELECT 1 FROM {table} WHERE user_id = ? AND sync_id = ?",
            (user_id, sync_id),
        ).fetchone()
        if saved:
            accepted.append(sync_id)
        else:
            rejected.append(_rejected_item(key, sync_id, "save_failed", "No se pudo guardar el registro en cloud."))

    return accepted, rejected, conflicts


def _pull_table(conn, user_id: str, key: str, since: str | None = None, until: str | None = None) -> list[dict[str, Any]]:
    config = SYNC_CONFIG[key]
    table = config["table"]
    fields = ", ".join([
        *config["fields"],
        "created_at",
        "updated_at",
        "deleted_at",
        "sync_status",
        "remote_updated_at",
        "last_modified_device_id",
        "last_modified_device_name",
        "last_modified_at",
    ])
    where = ["user_id = ?"]
    params: list[Any] = [user_id]
    if since:
        where.append("remote_updated_at > ?")
        params.append(since)
    if until:
        where.append("remote_updated_at <= ?")
        params.append(until)
    return [
        dict(row)
        for row in conn.execute(
            f"""
            SELECT sync_id, {fields}
            FROM {table}
            WHERE {" AND ".join(where)}
            ORDER BY {config["order"]}
            """,
            tuple(params),
        ).fetchall()
    ]


def _upsert_device(conn, user_id: str, device_id: Any, device_name: Any, now: str) -> None:
    clean_device_id = str(device_id or "").strip()
    if not clean_device_id:
        return
    clean_device_name = str(device_name or "Este dispositivo").strip()[:120] or "Este dispositivo"
    conn.execute(
        """
        INSERT INTO cloud_devices (user_id, device_id, device_name, created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, device_id) DO UPDATE SET
            device_name = excluded.device_name,
            updated_at = excluded.updated_at,
            last_seen_at = excluded.last_seen_at
        """,
        (user_id, clean_device_id, clean_device_name, now, now, now),
    )


def _payload_counts(payload: dict[str, Any]) -> dict[str, int]:
    return {table: len(payload.get(table, []) or []) for table in SYNC_TABLES}


def _validate_sync_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="Payload de sincronizacion invalido.")
    allowed_keys = set(SYNC_TABLES) | {"device_id", "device_name"}
    unknown = set(payload) - allowed_keys
    if unknown:
        raise HTTPException(status_code=422, detail="El payload de sincronizacion contiene campos no permitidos.")
    device_id = str(payload.get("device_id") or "")
    device_name = str(payload.get("device_name") or "")
    if len(device_id) > 160 or len(device_name) > 120:
        raise HTTPException(status_code=422, detail="Identificacion de dispositivo invalida.")
    total = 0
    maximum = sync_max_records()
    for table in SYNC_TABLES:
        items = payload.get(table, [])
        if items is None:
            items = []
            payload[table] = items
        if not isinstance(items, list):
            raise HTTPException(status_code=422, detail=f"La tabla {table} debe ser una lista.")
        total += len(items)
        if len(items) > maximum or total > maximum:
            raise HTTPException(status_code=413, detail=f"La sincronizacion supera el limite de {maximum} registros.")
        for item in items:
            if not isinstance(item, dict) or len(item) > 32:
                raise HTTPException(status_code=422, detail=f"Registro invalido en {table}.")
            sync_id = str(item.get("sync_id") or "")
            if len(sync_id) > 160:
                raise HTTPException(status_code=422, detail=f"Identificador invalido en {table}.")
            for value in item.values():
                if isinstance(value, str) and len(value) > 10_000:
                    raise HTTPException(status_code=422, detail=f"Texto demasiado largo en {table}.")
    return payload


def get_current_user(authorization: str | None = Header(default=None)) -> UserOut:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sesion no valida.")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = decode_access_token(token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Sesion no valida.")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Sesion no valida.")
    with connect() as conn:
        row = conn.execute(
            "SELECT id, email, display_name, created_at, updated_at, email_verified FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="Usuario no encontrado.")
    if not _email_is_verified(row):
        raise HTTPException(status_code=403, detail={"code": "email_verification_required", "message": "Confirma tu email para continuar."})
    return row_to_user(row)


@app.get("/health")
def health():
    database = get_database_engine()
    db_state = _refresh_cloud_db_state(run_init=False)
    return {
        "ok": True,
        "service": "scisonomics-cloud-auth",
        "database": database,
        "version": app.version,
        "schema_version": CLOUD_SCHEMA_VERSION,
        "sync_contract_version": SYNC_CONTRACT_VERSION,
        "cloud_schema_revision": CLOUD_SCHEMA_REVISION,
        "db_status": {
            "status": db_state["status"],
            "code": db_state["code"],
            "checked": db_state["checked"],
            "ready": db_state["ok"],
        },
        "capabilities": _cloud_capabilities(),
    }


@app.get("/ready")
def ready():
    db_state = _refresh_cloud_db_state(run_init=True)
    return {
        "ok": bool(db_state["ok"]),
        "service": "scisonomics-cloud-auth",
        "status": db_state["status"],
        "code": db_state["code"],
        "message": db_state["message"],
        "checked": db_state["checked"],
        "repairable": db_state["repairable"],
        "version": app.version,
        "schema_version": CLOUD_SCHEMA_VERSION,
        "sync_contract_version": SYNC_CONTRACT_VERSION,
        "cloud_schema_revision": CLOUD_SCHEMA_REVISION,
        "capabilities": _cloud_capabilities(),
    }


@app.post("/auth/register", response_model=AuthResponse | EmailVerificationRequiredOut)
def register(payload: RegisterRequest, request: Request):
    started = time.monotonic()
    outcome = "failed"
    enforce_rate_limit(request, "auth-register", identity=normalize_email(payload.email), limit=5, window_seconds=3600)
    email = validate_credentials(payload.email, payload.password)
    _reject_breached_password(payload.password)
    _logger.info("[auth-register] register start email=%s", mask_email(email))
    try:
        with connect() as conn:
            existing = conn.execute(
                "SELECT id, email, password_hash, email_verified FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 1",
                (email,),
            ).fetchone()
            if existing is not None:
                valid_unverified = (
                    not _email_is_verified(existing)
                    and bool(existing["password_hash"])
                    and verify_password(payload.password, existing["password_hash"])
                )
                if not valid_unverified:
                    raise HTTPException(status_code=401, detail="No se pudo continuar con el registro.")
                if password_needs_rehash(existing["password_hash"]):
                    conn.execute(
                        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                        (hash_password(payload.password), now_iso(), existing["id"]),
                    )
                _logger.info("[auth-register] user existing unverified user=%s", short_identifier(existing["id"]))
                outcome = "existing_unverified"
                return _continue_unverified_verification(conn, existing, now=now_iso())

            user_id = str(uuid4())
            timestamp = now_iso()
            display_name = payload.display_name.strip() if payload.display_name else None
            conn.execute(
                """
                INSERT INTO users (id, email, password_hash, display_name, email_verified, email_verified_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
                """,
                (user_id, email, hash_password(payload.password), display_name, timestamp, timestamp),
            )
            _logger.info("[auth-register] user created user=%s", short_identifier(user_id))
            outcome = "created_unverified"
            return _create_signup_verification(conn, user_id=user_id, email=email, now=timestamp)
    except Exception as exc:
        message = str(exc).lower()
        if "unique" in message or "duplicate key" in message:
            raise HTTPException(status_code=401, detail="No se pudo continuar con el registro.") from exc
        raise
    finally:
        _logger.info(
            "[auth-register] total duration outcome=%s duration_ms=%d",
            outcome,
            int((time.monotonic() - started) * 1000),
        )


@app.post("/auth/login", response_model=AuthResponse | EmailVerificationRequiredOut)
def login(payload: LoginRequest, request: Request):
    email = normalize_email(payload.email)
    enforce_rate_limit(request, "auth-login", identity=email, limit=8, window_seconds=300)
    with connect() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash, display_name, created_at, updated_at, email_verified FROM users WHERE LOWER(TRIM(email)) = ?",
            (email,),
        ).fetchone()

    if row is None or not row["password_hash"] or not verify_password(payload.password, row["password_hash"]):
        with connect() as conn:
            _security_audit(conn, "auth.login", outcome="denied", source_ip=client_ip(request), details={"email": mask_email(email)})
        raise HTTPException(status_code=401, detail="Email o contrasena incorrectos.")

    if password_needs_rehash(row["password_hash"]):
        with connect() as conn:
            conn.execute("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", (hash_password(payload.password), now_iso(), row["id"]))

    if not _email_is_verified(row):
        with connect() as conn:
            code_row = _active_signup_code(conn, row["id"])
            if code_row is not None and _seconds_until(code_row["expires_at"]) > 0:
                return _verification_required_response(
                    user_id=row["id"],
                    email=row["email"],
                    expires_at=code_row["expires_at"],
                    resend_available_in=_resend_wait_seconds(code_row),
                )
            return _verification_required_response(
                user_id=row["id"],
                email=row["email"],
                resend_available_in=0,
            )

    user = row_to_user(row)
    device_id, device_name = _extract_device_context(request)
    with connect() as conn:
        response = _issue_auth_response(conn, user, now=now_iso(), device_id=device_id, device_name=device_name)
        _security_audit(conn, "auth.login", outcome="success", actor_id=user.id, source_ip=client_ip(request))
    reset_rate_limit("auth-login", request, identity=email)
    return response


@app.post("/auth/verify-email", response_model=AuthResponse)
def verify_email(payload: VerifyEmailRequest, request: Request):
    enforce_rate_limit(request, "auth-verify-email", identity=payload.verification_token[-24:], limit=8, window_seconds=600)
    raw_code = str(payload.code or "").strip()
    code = re.sub(r"\D", "", raw_code)
    if not VERIFICATION_CODE_RE.match(code):
        raise _email_verification_error(422, "invalid_verification_code", "Ingresa el codigo de 6 digitos.")
    now = now_iso()
    device_id, device_name = _extract_device_context(request)
    with connect() as conn:
        user_row = _verification_user_from_token(conn, payload.verification_token)
        if _email_is_verified(user_row):
            raise _email_verification_error(409, "email_already_verified", "El email ya fue verificado.")
        code_row = _active_signup_code(conn, user_row["id"])
        if code_row is None:
            raise _email_verification_error(410, "verification_code_expired", "El codigo vencio. Pedi uno nuevo.")
        if _seconds_until(code_row["expires_at"]) <= 0:
            conn.execute("UPDATE email_verification_codes SET invalidated_at = COALESCE(invalidated_at, ?) WHERE id = ?", (now, code_row["id"]))
            conn.commit()
            raise _email_verification_error(410, "verification_code_expired", "El codigo vencio. Pedi uno nuevo.")
        attempts = int(code_row["attempts"] or 0)
        max_attempts = int(code_row["max_attempts"] or 5)
        if attempts >= max_attempts:
            conn.execute("UPDATE email_verification_codes SET invalidated_at = COALESCE(invalidated_at, ?) WHERE id = ?", (now, code_row["id"]))
            conn.commit()
            raise _email_verification_error(429, "verification_attempts_exceeded", "Se agotaron los intentos. Pedi un codigo nuevo.")
        expected_hash = str(code_row["code_hash"] or "")
        received_hash = _hash_verification_code(user_row["id"], "signup", code)
        if not hmac.compare_digest(expected_hash, received_hash):
            next_attempts = attempts + 1
            invalidated_at = now if next_attempts >= max_attempts else None
            conn.execute(
                "UPDATE email_verification_codes SET attempts = ?, invalidated_at = COALESCE(invalidated_at, ?) WHERE id = ?",
                (next_attempts, invalidated_at, code_row["id"]),
            )
            conn.commit()
            if next_attempts >= max_attempts:
                raise _email_verification_error(429, "verification_attempts_exceeded", "Se agotaron los intentos. Pedi un codigo nuevo.")
            raise _email_verification_error(
                400,
                "invalid_verification_code",
                "El codigo no es correcto.",
                attempts_remaining=max(0, max_attempts - next_attempts),
            )
        conn.execute("UPDATE email_verification_codes SET consumed_at = ? WHERE id = ?", (now, code_row["id"]))
        conn.execute("UPDATE users SET email_verified = 1, email_verified_at = ?, updated_at = ? WHERE id = ?", (now, now, user_row["id"]))
        updated = conn.execute("SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?", (user_row["id"],)).fetchone()
        return _issue_auth_response(conn, row_to_user(updated), now=now, device_id=device_id, device_name=device_name)


@app.post("/auth/resend-email-verification", response_model=EmailVerificationRequiredOut)
def resend_email_verification(payload: ResendEmailVerificationRequest, request: Request):
    enforce_rate_limit(request, "auth-resend-email", identity=payload.verification_token[-24:], limit=5, window_seconds=3600)
    now = now_iso()
    with connect() as conn:
        user_row = _verification_user_from_token(conn, payload.verification_token)
        if _email_is_verified(user_row):
            raise _email_verification_error(409, "email_already_verified", "El email ya fue verificado.")
        code_row = _active_signup_code(conn, user_row["id"])
        if code_row is not None:
            wait = _resend_wait_seconds(code_row)
            if wait > 0:
                raise _email_verification_error(429, "verification_resend_too_soon", "Espera antes de pedir otro codigo.", retry_after=wait)
        if _resend_limit_reached(conn, user_row["id"]):
            raise _email_verification_error(429, "verification_resend_limit_exceeded", "Pediste demasiados codigos. Intenta mas tarde.")
        return _create_signup_verification(conn, user_id=user_row["id"], email=user_row["email"], now=now)


@app.get("/auth/me")
def me(user: UserOut = Depends(get_current_user)):
    return {"ok": True, "user_id": user.id, **user.dict()}


@app.get("/billing/entitlements", response_model=BillingEntitlementsOut)
def billing_entitlements(user: UserOut = Depends(get_current_user)):
    with connect() as conn:
        row = conn.execute(
            "SELECT id, plan, subscription_status, subscription_expires_at FROM users WHERE id = ?",
            (user.id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Usuario no encontrado.")
    return _entitlements_from_user_row(row)


@app.post("/admin/billing/entitlements/by-email", response_model=BillingEntitlementsOut)
def admin_set_billing_entitlements_by_email(
    payload: AdminBillingEntitlementsUpdateIn,
    request: Request,
    x_scisonomics_admin_id: str | None = Header(default=None),
    x_scisonomics_admin_token: str | None = Header(default=None),
    x_scisonomics_admin_totp: str | None = Header(default=None),
):
    enforce_rate_limit(request, "admin-billing", limit=10, window_seconds=300)
    admin_id = _require_admin_billing_access(x_scisonomics_admin_id, x_scisonomics_admin_token, x_scisonomics_admin_totp)
    now = now_iso()
    with connect() as conn:
        updated = _admin_update_user_entitlements(
            conn,
            email=payload.email,
            plan=payload.plan,
            subscription_status=payload.subscription_status,
            subscription_expires_at=payload.subscription_expires_at,
            now=now,
        )
        _security_audit(
            conn,
            "admin.billing_update",
            outcome="success",
            actor_id=admin_id,
            target_id=updated["id"],
            source_ip=client_ip(request),
            details={"plan": _normalize_plan(payload.plan), "status": _normalize_subscription_status(payload.subscription_status)},
        )
    _logger.info(
        "[admin-billing] updated email=%s plan=%s status=%s",
        mask_email(payload.email),
        _normalize_plan(payload.plan),
        _normalize_subscription_status(payload.subscription_status),
    )
    return _entitlements_from_user_row(updated)


@app.post("/auth/refresh", response_model=AuthResponse)
def refresh_session(payload: RefreshRequest, request: Request):
    refresh_token = str(payload.refresh_token or "").strip()
    if not refresh_token:
        raise HTTPException(status_code=422, detail="Refresh token requerido.")
    enforce_rate_limit(request, "auth-refresh", identity=hash_refresh_token(refresh_token)[:24], limit=20, window_seconds=300)
    now = now_iso()
    device_id, device_name = _extract_device_context(request)
    with connect() as conn:
        row, token_hash = _lookup_refresh_token(conn, refresh_token)
        if row is not None and row["revoked_at"]:
            family_id = str(row["family_id"] or row["id"])
            conn.execute(
                """
                UPDATE cloud_refresh_tokens
                SET revoked_at = COALESCE(revoked_at, ?), compromised_at = COALESCE(compromised_at, ?)
                WHERE family_id = ?
                """,
                (now, now, family_id),
            )
            _security_audit(
                conn,
                "auth.refresh_reuse",
                outcome="family_revoked",
                actor_id=row["user_id"],
                source_ip=client_ip(request),
                details={"family_id": family_id[:12]},
            )
            conn.commit()
            raise HTTPException(status_code=401, detail="La sesion fue revocada por seguridad. Inicia sesion nuevamente.")
        row = _validate_refresh_token_row(row, now=now)
        user_row = conn.execute(
            "SELECT id, email, display_name, created_at, updated_at, email_verified FROM users WHERE id = ?",
            (row["user_id"],),
        ).fetchone()
        if not user_row:
            raise HTTPException(status_code=401, detail="Usuario no encontrado.")
        if not _email_is_verified(user_row):
            raise HTTPException(status_code=403, detail={"code": "email_verification_required", "message": "Confirma tu email para continuar."})
        user = row_to_user(user_row)
        response = _issue_auth_response(
            conn,
            user,
            now=now,
            rotate_from_hash=token_hash,
            device_id=device_id or row["device_id"],
            device_name=device_name or row["device_name"],
        )
        _logger.info("[auth-refresh] success user_id=%s", short_identifier(user.id))
        return response


@app.post("/auth/logout")
def logout(payload: LogoutRequest):
    refresh_token = str(payload.refresh_token or "").strip()
    if not refresh_token:
        raise HTTPException(status_code=422, detail="Refresh token requerido.")
    now = now_iso()
    with connect() as conn:
        row, token_hash = _lookup_refresh_token(conn, refresh_token)
        if row:
            conn.execute(
                """
                UPDATE cloud_refresh_tokens
                SET revoked_at = COALESCE(revoked_at, ?), last_used_at = ?
                WHERE token_hash = ?
                """,
                (now, now, token_hash),
            )
            _logger.info("[auth-logout] revoked user_id=%s", short_identifier(row["user_id"]))
    return {"ok": True}


@app.get("/sync/health")
def sync_health(user: UserOut = Depends(get_current_user)):
    return {"ok": True, "service": "sync", "sync_ready": True, "user_id": user.id}


@app.post("/sync/push")
async def sync_push(payload: dict[str, Any], request: Request, user: UserOut = Depends(get_current_user)):
    enforce_rate_limit(request, "sync-push", identity=user.id, limit=30, window_seconds=60)
    payload = _validate_sync_payload(payload)
    received = _payload_counts(payload)
    try:
        init_db()
        accepted = {table: [] for table in SYNC_TABLES}
        ignored = {table: 0 for table in SYNC_TABLES}
        conflicts = {table: 0 for table in SYNC_TABLES}
        rejected: list[RejectedSyncItem] = []
        now = now_iso()
        device_id = str(payload.get("device_id") or "").strip() or None
        device_name = str(payload.get("device_name") or "").strip() or None

        with connect() as conn:
            _upsert_device(conn, user.id, device_id, device_name, now)
            for table in SYNC_TABLES:
                items = payload.get(table, []) or []
                table_accepted, table_rejected, table_conflicts = _push_table(conn, user.id, table, items, now, device_id, device_name)
                accepted[table] = table_accepted
                ignored[table] = len(table_rejected)
                conflicts[table] = table_conflicts
                rejected.extend(table_rejected)

        counts = {}
        for table in SYNC_TABLES:
            counts[f"{table}_received"] = received[table]
            counts[f"{table}_saved"] = len(accepted[table])
        if any(received[table] != len(accepted[table]) + ignored[table] for table in SYNC_TABLES):
            raise HTTPException(status_code=500, detail="No se pudo confirmar el guardado de los datos en cloud.")
        if rejected:
            rejected_summary: dict[str, int] = {}
            for item in rejected:
                key = f"{item['entity']}:{item['code']}"
                rejected_summary[key] = rejected_summary.get(key, 0) + 1
            _logger.warning(
                "[sync-push] rejected user_id=%s rejected_count=%s summary=%s",
                short_identifier(user.id),
                len(rejected),
                rejected_summary,
            )
        return {
            "ok": True,
            "accepted": accepted,
            "rejected": rejected,
            "ignored": ignored,
            "conflicts": conflicts,
            "counts": counts,
            "device": {"device_id": device_id, "last_seen_at": now},
        }
    except HTTPException:
        raise
    except Exception as exc:
        _logger.exception(
            "[sync-push] failed user_id=%s counts=%s error_type=%s",
            short_identifier(user.id),
            received,
            type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="No se pudo guardar la sincronizacion en cloud.") from exc


@app.get("/sync/pull")
def sync_pull(since: str | None = Query(default=None), user: UserOut = Depends(get_current_user)):
    try:
        init_db()
        cursor = now_iso()
        with connect() as conn:
            payload = {table: _pull_table(conn, user.id, table, since, cursor) for table in SYNC_TABLES}
        return {"ok": True, "cursor": cursor, "incremental": bool(since), **payload}
    except Exception as exc:
        _logger.exception(
            "[sync-pull] failed user_id=%s incremental=%s error_type=%s",
            short_identifier(user.id),
            bool(since),
            type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="No se pudo leer la sincronizacion desde cloud.") from exc


@app.get("/sync/debug-counts", dependencies=[Depends(_require_debug_endpoints_enabled)])
def sync_debug_counts(user: UserOut = Depends(get_current_user)):
    _require_debug_endpoints_enabled()
    init_db()
    with connect() as conn:
        counts: dict[str, int] = {}
        deleted: dict[str, int] = {}
        for table in SYNC_TABLES:
            cloud_table = SYNC_CONFIG[table]["table"]
            row = conn.execute(f"SELECT COUNT(*) AS total FROM {cloud_table} WHERE user_id = ?", (user.id,)).fetchone()
            deleted_row = conn.execute(
                f"SELECT COUNT(*) AS total FROM {cloud_table} WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at <> ''",
                (user.id,),
            ).fetchone()
            counts[table] = int(row["total"] if isinstance(row, dict) else row[0])
            deleted[table] = int(deleted_row["total"] if isinstance(deleted_row, dict) else deleted_row[0])
    return {"ok": True, "user_id": user.id, **counts, "deleted": deleted}


@app.get("/sync/devices")
def sync_devices(user: UserOut = Depends(get_current_user)):
    init_db()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT device_id, device_name, created_at, updated_at, last_seen_at
            FROM cloud_devices
            WHERE user_id = ?
            ORDER BY last_seen_at DESC
            """,
            (user.id,),
        ).fetchall()
    return {"ok": True, "devices": [dict(row) for row in rows]}


@app.post("/auth/google/start")
def google_start(request: Request):
    enforce_rate_limit(request, "auth-google-start", limit=10, window_seconds=600)
    client_id, _, redirect_uri = _google_config()
    init_db()
    login_request_id = secrets.token_urlsafe(32)
    now = now_iso()
    expires_at = (datetime.now(timezone.utc).replace(microsecond=0) + timedelta(minutes=10)).isoformat()
    with connect() as conn:
        _cleanup_google_login_requests(conn, now)
        conn.execute(
            """
            INSERT INTO google_login_requests (login_request_id, status, created_at, updated_at, expires_at)
            VALUES (?, 'pending', ?, ?, ?)
            """,
            (login_request_id, now, now, expires_at),
        )
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "prompt": "select_account",
            "state": login_request_id,
        }
    )
    return {
        "configured": True,
        "login_request_id": login_request_id,
        "auth_url": f"https://accounts.google.com/o/oauth2/v2/auth?{query}",
    }


@app.get("/auth/google/status/{login_request_id}")
def google_status(login_request_id: str, request: Request):
    init_db()
    now = now_iso()
    device_id, device_name = _extract_device_context(request)
    with connect() as conn:
        _cleanup_google_login_requests(conn, now)
        row = conn.execute(
            """
            SELECT login_request_id, status, user_id, error_message, expires_at
            FROM google_login_requests
            WHERE login_request_id = ?
            """,
            (login_request_id,),
        ).fetchone()
        if not row:
            return {"status": "expired", "message": "La solicitud de Google expiro. Intenta nuevamente."}
        if row["status"] == "pending":
            return {"status": "pending"}
        if row["status"] == "error":
            return {"status": "error", "message": row["error_message"] or "No se pudo completar Google Login."}
        if row["status"] == "consumed":
            return {"status": "consumed", "message": "Esta solicitud de Google Login ya fue utilizada. Intenta nuevamente."}
        user_row = conn.execute(
            "SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?",
            (row["user_id"],),
        ).fetchone()
        if not user_row:
            return {"status": "error", "message": "No se pudo recuperar la sesion de Google."}
        user = row_to_user(user_row)
        response = _issue_auth_response(conn, user, now=now, device_id=device_id, device_name=device_name)
        conn.execute(
            """
            UPDATE google_login_requests
            SET status = 'consumed', updated_at = ?
            WHERE login_request_id = ?
            """,
            (now, login_request_id),
        )
        return {"status": "completed", **response.model_dump()}


@app.get("/auth/google/callback", response_class=HTMLResponse)
def google_callback(code: str = Query(default=""), state: str = Query(default=""), error: str = Query(default="")):
    init_db()
    now = now_iso()
    if not state:
        raise HTTPException(status_code=400, detail="Solicitud de Google invalida.")
    try:
        client_id, client_secret, redirect_uri = _google_config()
        with connect() as conn:
            row = conn.execute(
                "SELECT login_request_id, status, expires_at FROM google_login_requests WHERE login_request_id = ?",
                (state,),
            ).fetchone()
            if not row or row["expires_at"] < now:
                raise HTTPException(status_code=400, detail="La solicitud de Google expiro.")
            if error:
                conn.execute(
                    "UPDATE google_login_requests SET status = 'error', error_message = ?, updated_at = ? WHERE login_request_id = ?",
                    ("Google Login fue cancelado o rechazado.", now, state),
                )
                return _google_result_page(False, "Google Login fue cancelado. Ya podes cerrar esta ventana.")
            if not code:
                raise HTTPException(status_code=400, detail="Google no devolvio codigo de autorizacion.")

        profile = _exchange_google_code(code, client_id, client_secret, redirect_uri)
        with connect() as conn:
            user = _find_or_create_google_user(conn, profile, now)
            conn.execute(
                """
                UPDATE google_login_requests
                SET status = 'completed', user_id = ?, updated_at = ?
                WHERE login_request_id = ?
                """,
                (user.id, now, state),
            )
        return _google_result_page(True, "Login completado. Ya podes volver a ScisoNomics.")
    except HTTPException as exc:
        with connect() as conn:
            conn.execute(
                "UPDATE google_login_requests SET status = 'error', error_message = ?, updated_at = ? WHERE login_request_id = ?",
                (str(exc.detail), now, state),
            )
        raise
    except Exception:
        with connect() as conn:
            conn.execute(
                "UPDATE google_login_requests SET status = 'error', error_message = ?, updated_at = ? WHERE login_request_id = ?",
                ("No se pudo completar Google Login.", now, state),
            )
        return _google_result_page(False, "No se pudo completar Google Login. Volve a ScisoNomics e intenta nuevamente.")


def _google_result_page(ok: bool, message: str) -> HTMLResponse:
    color = "#0f766e" if ok else "#b45309"
    return HTMLResponse(
        f"""
        <!doctype html>
        <html lang="es">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>ScisoNomics Google Login</title>
            <style>
              body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }}
              main {{ max-width: 520px; margin: 24px; padding: 28px; border: 1px solid rgba(148,163,184,.24); border-radius: 24px; background: rgba(15,23,42,.86); box-shadow: 0 24px 80px rgba(0,0,0,.32); }}
              .badge {{ display: inline-block; color: white; background: {color}; border-radius: 999px; padding: 6px 12px; font-size: 13px; font-weight: 700; }}
              h1 {{ margin: 18px 0 8px; font-size: 28px; }}
              p {{ color: #cbd5e1; line-height: 1.6; }}
            </style>
          </head>
          <body>
            <main>
              <span class="badge">ScisoNomics</span>
              <h1>{'Cuenta conectada' if ok else 'No se pudo conectar'}</h1>
              <p>{message}</p>
            </main>
          </body>
        </html>
        """
    )
