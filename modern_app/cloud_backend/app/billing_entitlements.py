"""One projection of provider evidence; users is a cache, never provider history."""
from datetime import datetime, timezone
from hashlib import sha256
from uuid import uuid4
from fastapi import HTTPException
from . import account_lifecycle


GOOGLE_ACCESS_STATES = {"active", "canceled", "grace"}
INFINITE_DATE = datetime.max.replace(tzinfo=timezone.utc)


def date(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def preserve_manual_grants(conn, user_id=None):
    # Adopts historical manual Premium exactly once, before another provider can
    # overwrite the projection. No assumption that a missing expiry means paid MP.
    suffix=" AND id=?" if user_id is not None else ""
    users = conn.execute("SELECT * FROM users WHERE plan='premium' AND COALESCE(billing_source,'manual')='manual'"+suffix,
                         (user_id,) if user_id is not None else ()).fetchall()
    for user in sorted(users,key=lambda item:item["id"]):
        try: account_lifecycle.lock_active_user(conn,user["id"])
        except HTTPException as exc:
            if exc.status_code==410:continue
            raise
        conn.execute("""INSERT INTO billing_subscriptions
            (id,user_id,provider,status,external_reference,paid_until,created_at,updated_at)
            VALUES(?,?,'manual',?,?,?,?,?) ON CONFLICT(external_reference) DO NOTHING""",
            (str(uuid4()),user["id"],user["subscription_status"],manual_reference(user["id"]),
             user["subscription_expires_at"],user["created_at"],user["updated_at"]))


def manual_reference(user_id):
    return "manual:"+sha256(("scisonomics-manual-grant-v1:"+user_id).encode()).hexdigest()


def set_manual_grant(conn, user_id, plan, status, expiry, now):
    conn.execute("""INSERT INTO billing_subscriptions
        (id,user_id,provider,status,external_reference,paid_until,created_at,updated_at)
        VALUES(?,?,'manual',?,?,?, ?,?) ON CONFLICT(external_reference) DO UPDATE SET
        status=excluded.status,paid_until=excluded.paid_until,updated_at=excluded.updated_at""",
        (str(uuid4()),user_id,status if plan=="premium" else "expired",
         manual_reference(user_id),expiry,now,now))


def project(conn, user_id, *, now):
    tick = datetime.now(timezone.utc)
    user = account_lifecycle.lock_active_user(conn,user_id)
    preserve_manual_grants(conn,user_id)
    rows = conn.execute("SELECT * FROM billing_subscriptions WHERE user_id=?", (user_id,)).fetchall()
    candidates = []
    for row in rows:
        provider, expiry = row["provider"], date(row["paid_until"])
        if provider == "manual":
            eligible = row["status"] in {"active", "trialing"} and (not row["paid_until"] or expiry is not None)
        elif provider == "mercadopago":
            eligible = expiry is not None
        elif provider == "google_play":
            eligible = (row["status"] in GOOGLE_ACCESS_STATES and bool(row["acknowledged"])
                        and not row["superseded"] and expiry is not None)
        else:
            eligible = False  # Future providers must add verified evidence rules.
        if eligible and (expiry is None or expiry > tick):
            candidates.append((expiry or INFINITE_DATE, provider, row))
    if candidates:
        _, source, winner = max(candidates, key=lambda item: (item[0], item[1]))
        plan, status, expiry = "premium", "active", winner["paid_until"]
        if source == "manual" and winner["status"] == "trialing":
            status = "trialing"
        if source == "manual" and user["billing_source"] is None:
            source = None  # Preserve historical manual records' nullable source.
    else:
        plan, expiry = "free", None
        source = user["billing_source"] or "manual"
        status = "canceled" if any(r["status"]=="canceled" for r in rows) else "expired"
        if not rows:
            return  # Preserve existing Free accounts' compatibility defaults.
    if (user["plan"],user["subscription_status"],user["subscription_expires_at"],user["billing_source"]) != (plan,status,expiry,source):
        conn.execute("UPDATE users SET plan=?,subscription_status=?,subscription_expires_at=?,billing_source=?,updated_at=? WHERE id=?",
                     (plan,status,expiry,source,now,user_id))
