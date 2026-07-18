from __future__ import annotations

from collections import defaultdict, deque
import os
import threading
import time
from typing import Deque

from fastapi import HTTPException, Request


_LOCK = threading.Lock()
_ATTEMPTS: dict[str, Deque[float]] = defaultdict(deque)


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def client_ip(request: Request) -> str:
    direct = request.client.host if request.client else "unknown"
    trusted = {
        value.strip()
        for value in os.getenv("SCISONOMICS_TRUSTED_PROXY_IPS", "").split(",")
        if value.strip()
    }
    if direct in trusted:
        forwarded = request.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
        if forwarded:
            return forwarded[:64]
    return str(direct)[:64]


def enforce_rate_limit(
    request: Request,
    scope: str,
    *,
    identity: str = "",
    limit: int | None = None,
    window_seconds: int | None = None,
) -> None:
    resolved_limit = limit or _env_int("SCISONOMICS_RATE_LIMIT_REQUESTS", 10)
    resolved_window = window_seconds or _env_int("SCISONOMICS_RATE_LIMIT_WINDOW_SECONDS", 60)
    key = f"{scope}:{client_ip(request)}:{identity.strip().lower()[:160]}"
    now = time.monotonic()
    cutoff = now - resolved_window
    with _LOCK:
        attempts = _ATTEMPTS[key]
        while attempts and attempts[0] <= cutoff:
            attempts.popleft()
        if len(attempts) >= resolved_limit:
            retry_after = max(1, int(resolved_window - (now - attempts[0])))
            raise HTTPException(
                status_code=429,
                detail="Demasiados intentos. Espera un momento y volve a intentar.",
                headers={"Retry-After": str(retry_after)},
            )
        attempts.append(now)


def reset_rate_limit(scope: str, request: Request, *, identity: str = "") -> None:
    key = f"{scope}:{client_ip(request)}:{identity.strip().lower()[:160]}"
    with _LOCK:
        _ATTEMPTS.pop(key, None)


def request_body_limit_bytes() -> int:
    return _env_int("SCISONOMICS_MAX_REQUEST_BODY_BYTES", 2 * 1024 * 1024, 1024)


def sync_max_records() -> int:
    return _env_int("SCISONOMICS_SYNC_MAX_RECORDS", 1000, 1)
