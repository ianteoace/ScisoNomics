from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import logging
import sqlite3
from uuid import uuid4

from fastapi import HTTPException
from .db import connect


_logger = logging.getLogger("scisonomics.cloud.auth")
USER_COLUMNS = "id, email, display_name, created_at, updated_at, auth_provider_id"


def conflict(code="auth_provider_conflict"):
    return HTTPException(409, detail={"code": code,
        "message": "La identidad o el email ya tienen otro vinculo. Requiere revision manual."})


def audit_link(conn, user_id: str, event: str) -> None:
    # No tokens, email, provider metadata or financial records in this audit.
    conn.execute(
        "INSERT INTO security_audit_log (event_type, actor_id, target_id, outcome, details, created_at) "
        "VALUES (?, ?, ?, 'success', ?, ?)",
        (event, user_id, user_id, json.dumps({"provider": "supabase"}),
         datetime.now(timezone.utc).isoformat(timespec="microseconds")),
    )


def bootstrap_user(identity: dict, insert_with_namespace):
    subject, email = identity["sub"], identity["email"]
    try:
        with connect() as conn:
            if conn.engine == "sqlite":
                conn.execute("BEGIN IMMEDIATE")
            else:
                conn.execute("SET LOCAL lock_timeout = '5s'")
                conn.execute("SET LOCAL statement_timeout = '15s'")
                # Serialize both identities. Ordered transaction locks release
                # on commit/rollback and do not touch financial/device tables.
                keys = sorted({int.from_bytes(hashlib.sha256(
                    ("scisonomics-supabase-bootstrap:" + value).encode()
                ).digest()[:8], "big", signed=True) for value in (subject, email)})
                for key in keys:
                    conn.execute("SELECT pg_advisory_xact_lock(?)", (key,))
            row = conn.execute(f"SELECT {USER_COLUMNS} FROM users WHERE auth_provider_id = ?", (subject,)).fetchone()
            if row is not None:
                # Provider email changes never move an established link.
                return dict(row)
            rows = conn.execute(f"SELECT {USER_COLUMNS} FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 2", (email,)).fetchall()
            if len(rows) > 1:
                raise conflict("auth_email_ambiguous")
            stamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")
            if rows:
                existing = rows[0]
                if existing["auth_provider_id"] not in (None, "", subject):
                    raise conflict()
                row = conn.execute(
                    f"UPDATE users SET auth_provider_id = ?, updated_at = ? "
                    f"WHERE id = ? AND LOWER(TRIM(email)) = ? "
                    f"AND (auth_provider_id IS NULL OR auth_provider_id = '' OR auth_provider_id = ?) "
                    f"RETURNING {USER_COLUMNS}",
                    (subject, stamp, existing["id"], email, subject),
                ).fetchone()
                if row is None:
                    raise conflict()
                # Preserve legacy verification, credentials and entitlements.
                event = "supabase_account_linked"
            else:
                user_id = str(uuid4())
                while user_id == subject:
                    user_id = str(uuid4())
                insert_with_namespace(conn,
                    "INSERT INTO users (id, email, password_hash, password_auth_enabled, display_name, "
                    "auth_provider_id, auth_provider, email_verified, email_verified_at, plan, "
                    "subscription_status, device_key_namespace, created_at, updated_at) "
                    "VALUES (?, ?, '', 0, ?, ?, 'supabase', 1, ?, 'free', 'active', ?, ?, ?)",
                    lambda namespace: (user_id, email, identity.get("display_name"), subject,
                                       identity["email_confirmed_at"], namespace, stamp, stamp),
                )
                row = conn.execute(f"SELECT {USER_COLUMNS} FROM users WHERE id = ?", (user_id,)).fetchone()
                event = "supabase_account_created"
            audit_link(conn, row["id"], event)
            result = dict(row)
    except Exception as exc:
        constraint = getattr(getattr(exc, "diag", None), "constraint_name", None)
        unique = getattr(exc, "sqlstate", None) == "23505"
        sqlite_unique = isinstance(exc, sqlite3.IntegrityError) and "UNIQUE constraint failed: users." in str(exc)
        if unique or sqlite_unique:
            # /auth/me and legacy signup may race outside our locks. Re-read
            # after rollback; return only the same verified provider identity.
            with connect() as conn:
                row = conn.execute(f"SELECT {USER_COLUMNS} FROM users WHERE auth_provider_id = ?", (subject,)).fetchone()
                if row is not None:
                    return dict(row)
            code = "auth_provider_conflict" if constraint == "idx_users_auth_provider_id" or "users.auth_provider_id" in str(exc) else "auth_email_conflict"
            raise conflict(code) from None
        if getattr(exc, "sqlstate", None) in {"55P03", "57014"} or (
            isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower()
        ):
            raise HTTPException(503, detail={"code": "bootstrap_busy", "message": "El alta esta ocupada. Intenta nuevamente."}) from None
        raise
    _logger.info("[supabase-bootstrap] event=%s user_ref=%s", event,
                 hashlib.sha256(result["id"].encode()).hexdigest()[:12])
    return result
