from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


PASSWORD_ITERATIONS = 260_000
SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_MAXMEM = 64 * 1024 * 1024
TOKEN_ALGORITHM = "HS256"
TOKEN_ISSUER = "scisonomics-cloud"
TOKEN_AUDIENCE = "scisonomics-desktop"


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def get_jwt_secret() -> str:
    secret = os.getenv("SCISONOMICS_JWT_SECRET", "").strip()
    env = os.getenv("SCISONOMICS_ENV", "development").strip().lower()
    if env == "production" and not secret:
        raise RuntimeError("SCISONOMICS_JWT_SECRET es obligatorio en produccion.")
    return secret or "dev-only-change-me-before-production"


def get_token_expiration_minutes() -> int:
    raw = os.getenv("SCISONOMICS_ACCESS_TOKEN_EXPIRE_MINUTES", "15")
    try:
        return max(5, int(raw))
    except ValueError:
        return 15


def get_access_token_expires_in() -> int:
    return get_token_expiration_minutes() * 60


def get_email_verification_token_expires_in() -> int:
    raw = os.getenv("SCISONOMICS_EMAIL_VERIFICATION_TOKEN_EXPIRE_MINUTES", "15")
    try:
        return max(5, int(raw)) * 60
    except ValueError:
        return 15 * 60


def get_refresh_token_expiration_days() -> int:
    raw = os.getenv("SCISONOMICS_REFRESH_TOKEN_EXPIRE_DAYS", "30")
    try:
        return max(1, int(raw))
    except ValueError:
        return 30


def create_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    secret = get_jwt_secret().encode("utf-8")
    return hashlib.sha256(secret + token.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32, maxmem=SCRYPT_MAXMEM)
    return "scrypt${n}${r}${p}${salt}${digest}".format(
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        salt=_b64url_encode(salt),
        digest=_b64url_encode(digest),
    )


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        parts = stored_hash.split("$")
        scheme = parts[0]
        if scheme == "scrypt" and len(parts) == 6:
            _, n_raw, r_raw, p_raw, salt_raw, digest_raw = parts
            salt = _b64url_decode(salt_raw)
            expected = _b64url_decode(digest_raw)
            actual = hashlib.scrypt(
                password.encode("utf-8"),
                salt=salt,
                n=int(n_raw),
                r=int(r_raw),
                p=int(p_raw),
                dklen=len(expected),
                maxmem=SCRYPT_MAXMEM,
            )
        elif scheme == "pbkdf2_sha256" and len(parts) == 4:
            _, iterations_raw, salt_raw, digest_raw = parts
            salt = _b64url_decode(salt_raw)
            expected = _b64url_decode(digest_raw)
            actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations_raw))
        else:
            return False
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def password_needs_rehash(stored_hash: str) -> bool:
    return not stored_hash.startswith(f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}$")


def create_access_token(subject: str, extra: dict[str, Any] | None = None) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": now,
        "exp": now + get_access_token_expires_in(),
        "iss": TOKEN_ISSUER,
        "aud": TOKEN_AUDIENCE,
        "type": "access",
        "jti": secrets.token_urlsafe(18),
    }
    if extra:
        payload.update(extra)

    header = {"alg": TOKEN_ALGORITHM, "typ": "JWT"}
    signing_input = ".".join(
        [
            _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8")),
            _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")),
        ]
    )
    signature = hmac.new(get_jwt_secret().encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url_encode(signature)}"


def create_email_verification_token(subject: str, *, purpose: str = "signup") -> str:
    return create_access_token(
        subject,
        {
            "type": "email_verification",
            "purpose": purpose,
            "exp": int(time.time()) + get_email_verification_token_expires_in(),
        },
    )


def decode_access_token(token: str) -> dict[str, Any]:
    try:
        header_raw, payload_raw, signature_raw = token.split(".", 2)
    except ValueError as exc:
        raise ValueError("Token invalido.") from exc

    try:
        header = json.loads(_b64url_decode(header_raw).decode("utf-8"))
    except Exception as exc:
        raise ValueError("Token invalido.") from exc
    if not isinstance(header, dict) or header.get("alg") != TOKEN_ALGORITHM or header.get("typ") != "JWT":
        raise ValueError("Token invalido.")
    signing_input = f"{header_raw}.{payload_raw}"
    expected_signature = hmac.new(get_jwt_secret().encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    try:
        received_signature = _b64url_decode(signature_raw)
    except Exception as exc:
        raise ValueError("Token invalido.") from exc
    if not hmac.compare_digest(expected_signature, received_signature):
        raise ValueError("Token invalido.")

    try:
        payload = json.loads(_b64url_decode(payload_raw).decode("utf-8"))
    except Exception as exc:
        raise ValueError("Token invalido.") from exc
    if not isinstance(payload, dict):
        raise ValueError("Token invalido.")
    now = int(time.time())
    try:
        expires_at = int(payload.get("exp", 0))
        issued_at = int(payload.get("iat", now + 1))
    except (TypeError, ValueError) as exc:
        raise ValueError("Token invalido.") from exc
    if expires_at < now:
        raise ValueError("Sesion expirada.")
    if issued_at > now + 60:
        raise ValueError("Token invalido.")
    if payload.get("iss") != TOKEN_ISSUER or payload.get("aud") != TOKEN_AUDIENCE:
        raise ValueError("Token invalido.")
    if not str(payload.get("sub") or "").strip() or not str(payload.get("jti") or "").strip():
        raise ValueError("Token invalido.")
    return payload


def decode_email_verification_token(token: str, *, purpose: str = "signup") -> dict[str, Any]:
    payload = decode_access_token(token)
    if payload.get("type") != "email_verification" or payload.get("purpose") != purpose:
        raise ValueError("Token de verificacion invalido.")
    return payload


def _entitlements_private_key_pem() -> bytes:
    inline = os.getenv("SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY", "").strip()
    file_path = os.getenv("SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY_FILE", "").strip()
    if inline:
        return inline.replace("\\n", "\n").encode("utf-8")
    if file_path:
        try:
            with open(file_path, "rb") as handle:
                return handle.read()
        except OSError as exc:
            raise RuntimeError("No se pudo leer la clave privada de entitlements.") from exc
    raise RuntimeError("SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY es obligatorio para emitir entitlements.")


def create_entitlement_token(payload: dict[str, Any]) -> str:
    header = {"alg": "RS256", "typ": "JWT"}
    signing_input = ".".join(
        [
            _b64url_encode(json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")),
            _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")),
        ]
    )
    try:
        private_key = serialization.load_pem_private_key(_entitlements_private_key_pem(), password=None)
        signature = private_key.sign(signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    except (TypeError, ValueError) as exc:
        raise RuntimeError("La clave privada de entitlements no es valida.") from exc
    return f"{signing_input}.{_b64url_encode(signature)}"


def validate_entitlements_signing_config() -> None:
    configured = bool(
        os.getenv("SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY", "").strip()
        or os.getenv("SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY_FILE", "").strip()
    )
    if not configured and os.getenv("SCISONOMICS_ENV", "development").strip().lower() != "production":
        return
    try:
        serialization.load_pem_private_key(_entitlements_private_key_pem(), password=None)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("La clave privada de entitlements no es valida.") from exc
