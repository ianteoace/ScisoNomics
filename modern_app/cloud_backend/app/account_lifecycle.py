"""Account-close guards shared only by operations that can race deletion."""
from __future__ import annotations

import hashlib
import re
from fastapi import HTTPException


def reference(value: str) -> str:
    return hashlib.sha256(("scisonomics-account-close-v1:" + value).encode()).hexdigest()


def identity_reference(provider: str, subject: str) -> str:
    return reference(provider + ":" + subject)


def closed():
    return HTTPException(410, detail={"code": "account_deleted", "message": "La cuenta fue eliminada. Este acceso ya no puede utilizarse."})


def reject_deleted_identity(conn, provider: str, subject: str):
    if conn.execute("SELECT 1 FROM deleted_account_identities WHERE identity_hash = ?", (identity_reference(provider, subject),)).fetchone():
        raise closed()


def deleted_user(conn, user_id: str) -> bool:
    return conn.execute("SELECT 1 FROM account_deletion_requests WHERE user_ref = ? AND completed_at IS NOT NULL", (reference(user_id),)).fetchone() is not None


def minimized_actor(conn, identifier):
    if not identifier: return identifier
    row=conn.execute("SELECT id FROM account_deletion_requests WHERE user_ref=? AND completed_at IS NOT NULL LIMIT 1", (reference(identifier),)).fetchone()
    return "deleted:"+row["id"] if row else identifier


def minimized_details(details):
    if not isinstance(details, dict):
        return {}
    return {key: value for key, value in details.items()
        if key in {"provider", "purpose", "status", "code", "topic", "action"}
        and isinstance(value, str) and re.fullmatch(r"[a-z_]{1,80}", value)}


def lock_active_user(conn, user_id: str):
    if conn.engine == "sqlite" and not conn._conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    suffix = " FOR UPDATE" if conn.engine == "postgresql" else ""
    row = conn.execute("SELECT * FROM users WHERE id = ?" + suffix, (user_id,)).fetchone()
    if row is None:
        raise closed()
    return row


def ensure_schema(conn):
    binary = "BLOB" if conn.engine == "sqlite" else "BYTEA"
    conn.execute(f"""CREATE TABLE IF NOT EXISTS account_deletion_requests (
        id TEXT PRIMARY KEY, user_id TEXT, user_ref TEXT NOT NULL, device_id TEXT NOT NULL,
        family_id TEXT NOT NULL, capability_hash TEXT NOT NULL, public_key {binary},
        account_binding {binary}, nonce_hash {binary}, issued_at BIGINT, expires_at BIGINT,
        request_hash {binary}, otp_hash TEXT, otp_expires_at BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, invalidated_at TEXT, completed_at TEXT,
        completion_hash TEXT, actor_token_hash TEXT, receipt_expires_at BIGINT,
        external_subject TEXT, external_status TEXT NOT NULL DEFAULT 'not_applicable',
        external_error TEXT, external_attempt_at BIGINT, billing_retained INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_account_deletion_user ON account_deletion_requests(user_id, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_account_deletion_reference ON account_deletion_requests(user_ref)")
    conn.execute("""CREATE TABLE IF NOT EXISTS deleted_account_identities (
        identity_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, deletion_ref TEXT NOT NULL, created_at TEXT NOT NULL
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS retained_billing_subscriptions (
        id TEXT PRIMARY KEY, deletion_ref TEXT NOT NULL, provider TEXT NOT NULL,
        provider_subscription_id TEXT, external_reference_hash TEXT NOT NULL UNIQUE,
        commercial_record TEXT NOT NULL, archived_at TEXT NOT NULL
    )""")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_retained_billing_provider ON retained_billing_subscriptions(provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL")
