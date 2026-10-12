"""Purpose-specific OTP + native Ed25519 proof; atomic internal close and outbox."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import struct
from uuid import UUID, uuid4
from urllib.parse import urlsplit

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import Header, HTTPException, Request
from pydantic import Field

from . import account_lifecycle as lifecycle, device_sessions as devices
from .auth import get_jwt_secret
from .db import connect, SYNC_CLOUD_TABLES
from .device_verification import base64url_decode, base64url_encode
from .security import enforce_rate_limit

MAGIC = b"SCISONOMICS-ACCOUNT-DELETE-V1\x00"


class Start(devices.Strict):
    pass


class Intent(devices.Strict):
    requestId: str = Field(pattern=r"^[a-f0-9-]{36}$")
    capability: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class Complete(Intent):
    confirmation: str = Field(pattern=r"^ELIMINAR$")
    code: str = Field(pattern=r"^[0-9]{6}$")
    challenge: devices.Challenge
    proof: devices.Signature


def fingerprint(payload):
    return hashlib.sha256(json.dumps(payload.model_dump(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def actor(authorization):
    devices.require_enforced()
    if not authorization or not authorization.lower().startswith("bearer "):
        raise devices.error("session_required", "Iniciá sesión en un dispositivo autorizado.")
    token = authorization.split(" ", 1)[1].strip()
    return token, devices.authorize_access(token)


def completed_receipt(payload, token):
    with connect() as conn:
        row=intent_row(conn,payload)
        if not row["completed_at"]: return None
        token_hash=hashlib.sha256(token.encode()).hexdigest()
        if row["receipt_expires_at"]>int(devices.now().timestamp()) and hmac.compare_digest(row["actor_token_hash"],token_hash) and hmac.compare_digest(row["completion_hash"],fingerprint(payload)):
            return result(conn,row["id"])
        raise devices.error("deletion_proof_used","Esta confirmación ya fue utilizada.")


def intent_row(conn, payload):
    row = conn.execute("SELECT * FROM account_deletion_requests WHERE id = ?", (payload.requestId,)).fetchone()
    if row is None or not hmac.compare_digest(row["capability_hash"], devices.digest(payload.capability)):
        raise devices.error("deletion_request_invalid", "La solicitud no es válida. Iniciá el proceso nuevamente.")
    return row


def check_actor(row, claims):
    if row["user_id"] != claims["sub"] or row["device_id"] != claims["device_id"] or row["family_id"] != claims["family_id"]:
        raise devices.error("deletion_actor_mismatch", "La solicitud pertenece a otra sesión o dispositivo.")


def challenge(conn, row):
    issued = int(devices.now().timestamp())
    if row["invalidated_at"] or row["completed_at"] or row["otp_expires_at"] <= issued or row["attempts"] >= 5:
        raise devices.error("deletion_request_expired", "La confirmación venció. Iniciá el proceso nuevamente.")
    nonce = secrets.token_bytes(32)
    expires = min(issued + 120, row["otp_expires_at"])
    conn.execute("UPDATE account_deletion_requests SET nonce_hash=?,issued_at=?,expires_at=? WHERE id=?", (hashlib.sha256(nonce).digest(), issued, expires, row["id"]))
    return {"challengeId":row["id"], "nonce":base64url_encode(nonce), "issuedAt":issued, "expiresAt":expires,
            "familyId":row["family_id"], "targetDeviceId":None, "requestHash":base64url_encode(bytes(row["request_hash"]))}


def proof_message(binding, proof, value):
    if value.familyId is None or value.targetDeviceId is not None or value.requestHash is None or not 0 <= value.issuedAt < value.expiresAt <= 0xFFFFFFFFFFFFFFFF or value.expiresAt-value.issuedAt > 120:
        raise ValueError("invalid_delete_fields")
    return b"".join((MAGIC, binding, devices.uid(proof.deviceId), base64url_decode(proof.publicKeyHash, expected_length=32),
        devices.uid(value.challengeId), base64url_decode(value.nonce, expected_length=32),
        struct.pack(">QQ", value.issuedAt, value.expiresAt), devices.uid(value.familyId), base64url_decode(value.requestHash, expected_length=32)))


def verify(row, payload):
    c, p = payload.challenge, payload.proof
    if row["invalidated_at"] or row["completed_at"] or row["expires_at"] is None or row["expires_at"] <= int(devices.now().timestamp()):
        raise devices.error("deletion_proof_expired", "La verificación venció. Renovala antes de confirmar.")
    try:
        key = p.key()
        if (c.challengeId != row["id"] or c.familyId != row["family_id"] or c.targetDeviceId is not None
                or c.issuedAt != row["issued_at"] or c.expiresAt != row["expires_at"] or p.deviceId != row["device_id"]
                or not hmac.compare_digest(key, bytes(row["public_key"]))
                or not hmac.compare_digest(hashlib.sha256(base64url_decode(c.nonce, expected_length=32)).digest(),bytes(row["nonce_hash"]))
                or c.requestHash != base64url_encode(bytes(row["request_hash"]))):
            raise ValueError()
        Ed25519PublicKey.from_public_bytes(key).verify(base64url_decode(p.signature,expected_length=64),proof_message(bytes(row["account_binding"]),p,c))
    except (ValueError, TypeError, InvalidSignature):
        raise devices.error("deletion_proof_invalid", "No se pudo verificar la confirmación de este dispositivo.") from None


def audit(conn, event, ref, outcome="success"):
    conn.execute("INSERT INTO security_audit_log(event_type,actor_id,target_id,outcome,details,created_at) VALUES(?,?,?,?,?,?)", (event,ref,ref,outcome,'{"purpose":"delete_account"}',devices.stamp()))


def close_internal(conn, user, row, token, payload):
    user_id, ref, stamp = user["id"], "deleted:"+row["id"], devices.stamp()
    conn.execute("UPDATE google_play_account_bindings SET user_id=NULL,deletion_ref=? WHERE user_id=?",(ref,user_id))
    for provider, subject in (("supabase",user["auth_provider_id"]),("google",user["google_sub"])):
        if subject:
            conn.execute("INSERT INTO deleted_account_identities(identity_hash,provider,deletion_ref,created_at) VALUES(?,?,?,?) ON CONFLICT(identity_hash) DO NOTHING", (lifecycle.identity_reference(provider,subject),provider,ref,stamp))
    billing = conn.execute("SELECT * FROM billing_subscriptions WHERE user_id=?",(user_id,)).fetchall()
    for entry in billing:
        commercial = {k:entry[k] for k in entry.keys() if k not in {"user_id","external_reference","checkout_url"}}
        conn.execute("INSERT INTO retained_billing_subscriptions(id,deletion_ref,provider,provider_subscription_id,external_reference_hash,commercial_record,archived_at) VALUES(?,?,?,?,?,?,?)", (entry["id"],ref,entry["provider"],entry["provider_subscription_id"],lifecycle.reference(entry["external_reference"]),json.dumps(commercial),stamp))
    # Minimize account-linked evidence while preserving event/type/time/outcome.
    records=conn.execute("SELECT id,actor_id,target_id,details FROM security_audit_log WHERE actor_id IN (?,?) OR target_id IN (?,?)",(user_id,"user:"+user_id,user_id,"user:"+user_id)).fetchall()
    for entry in records:
        try: details=json.loads(entry["details"] or "{}")
        except (ValueError,TypeError): details={}
        keep=lifecycle.minimized_details(details)
        conn.execute("UPDATE security_audit_log SET actor_id=?,target_id=?,source_ip=NULL,details=? WHERE id=?",(ref if entry["actor_id"] in (user_id,"user:"+user_id) else entry["actor_id"],ref if entry["target_id"] in (user_id,"user:"+user_id) else entry["target_id"],json.dumps(keep),entry["id"]))
    for table in (*reversed(SYNC_CLOUD_TABLES),"cloud_devices","google_login_requests","cloud_refresh_tokens","device_proof_challenges","device_verification_challenges","email_verification_codes","refresh_token_families","trusted_devices","billing_subscriptions"):
        conn.execute(f"DELETE FROM {table} WHERE user_id=?",(user_id,))
    conn.execute("DELETE FROM account_deletion_requests WHERE user_id=? AND id<>?",(user_id,row["id"]))
    conn.execute("DELETE FROM users WHERE id=?",(user_id,))
    conn.execute("""UPDATE account_deletion_requests SET user_id=NULL,completed_at=?,completion_hash=?,actor_token_hash=?,receipt_expires_at=?,
        public_key=NULL,account_binding=NULL,nonce_hash=NULL,otp_hash=NULL,request_hash=NULL,
        external_subject=?,external_status=?,billing_retained=? WHERE id=? AND completed_at IS NULL""",(stamp,fingerprint(payload),devices.digest(token),int(devices.now().timestamp())+600,user["auth_provider_id"],"pending" if user["auth_provider_id"] else "not_applicable",int(bool(billing)),row["id"]))
    audit(conn,"account.deleted",ref)


def external_delete(request_id):
    """Recoverable server-only outbox. Never run before the internal commit."""
    with connect() as conn:
        row=conn.execute("SELECT * FROM account_deletion_requests WHERE id=?",(request_id,)).fetchone()
        if row is None or not row["completed_at"] or row["external_status"] != "pending": return
        key=os.getenv("SCISONOMICS_SUPABASE_SECRET_KEY","").strip()
        url=os.getenv("SCISONOMICS_SUPABASE_URL","").strip().rstrip("/")
        if not key:
            conn.execute("UPDATE account_deletion_requests SET external_error='not_configured' WHERE id=?",(request_id,));return
        try:
            parsed=urlsplit(url)
            valid_url=(parsed.scheme=="https" and bool(parsed.hostname) and parsed.port in (None,443)
                and not (parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path)
                and not any(character.isspace() for character in url))
        except ValueError:
            valid_url=False
        if not key.startswith("sb_secret_") or not valid_url:
            conn.execute("UPDATE account_deletion_requests SET external_error='invalid_config' WHERE id=?",(request_id,));return
        try: subject=str(UUID(row["external_subject"]))
        except (ValueError,TypeError): return
        tick=int(devices.now().timestamp())
        # Lease permits recovery after a process crash, while bounding concurrency.
        leased=conn.execute("UPDATE account_deletion_requests SET external_attempt_at=? WHERE id=? AND external_status='pending' AND (external_attempt_at IS NULL OR external_attempt_at<?)",(tick,request_id,tick-30)).rowcount
        if not leased:return
    status, failure = "pending", "provider_unavailable"
    try:
        response=httpx.request("DELETE",f"{url}/auth/v1/admin/users/{subject}",json={"should_soft_delete":False},headers={"apikey":key},timeout=8.0,follow_redirects=False)
        if response.status_code==200:
            try:
                body=response.json()
                removed=body.get("user",body)
                if isinstance(removed,dict) and removed.get("id")==subject:status,failure="deleted",None
                else:failure="invalid_response"
            except (ValueError,AttributeError):failure="invalid_response"
        elif response.status_code==404:
            try: missing=response.json().get("code")=="user_not_found"
            except (ValueError,AttributeError): missing=False
            if missing:status,failure="deleted",None
            else:failure="provider_rejected"
        else:failure="provider_rejected"
    except (httpx.HTTPError, httpx.InvalidURL): pass
    with connect() as conn:
        conn.execute("UPDATE account_deletion_requests SET external_status=?,external_error=?,external_subject=CASE WHEN ?='deleted' THEN NULL ELSE external_subject END WHERE id=? AND external_status='pending'",(status,failure,status,request_id))
        audit(conn,"account.external_deletion","deleted:"+request_id,"success" if status=="deleted" else "pending")


def result(conn, request_id):
    row=conn.execute("SELECT external_status,billing_retained FROM account_deletion_requests WHERE id=?",(request_id,)).fetchone()
    return {"status":"deleted","external_auth_status":row["external_status"],"billing_retained":bool(row["billing_retained"])}


def register_routes(app, send_email):
    @app.post("/account/delete/request")
    def start(payload: Start,request: Request,authorization: str|None=Header(default=None)):
        token,claims=actor(authorization)
        enforce_rate_limit(request,"account-delete-request",identity=claims["sub"],limit=5,window_seconds=3600)
        with connect() as conn:
            user=lifecycle.lock_active_user(conn,claims["sub"])
            device=devices.active_family(conn,claims["sub"],claims["device_id"],claims["family_id"])
            last=conn.execute("SELECT created_at FROM account_deletion_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 1",(claims["sub"],)).fetchone()
            if last and (devices.now()-devices.datetime.fromisoformat(last["created_at"])).total_seconds()<60:
                raise devices.error("deletion_resend_cooldown","Esperá un minuto antes de pedir otro código.",429)
            identifier,capability=str(uuid4()),secrets.token_urlsafe(32)
            code=f"{secrets.randbelow(1000000):06d}"
            conn.execute("UPDATE account_deletion_requests SET invalidated_at=? WHERE user_id=? AND completed_at IS NULL",(devices.stamp(),user["id"]))
            conn.execute("""INSERT INTO account_deletion_requests(id,user_id,user_ref,device_id,family_id,capability_hash,public_key,account_binding,request_hash,otp_hash,otp_expires_at,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",(identifier,user["id"],lifecycle.reference(user["id"]),claims["device_id"],claims["family_id"],devices.digest(capability),bytes(device["public_key"]),base64url_decode(user["device_key_namespace"],expected_length=32),hashlib.sha256(("delete_account:"+identifier).encode()).digest(),devices.code_hash(user["id"],"delete_account:"+identifier,code),int(devices.now().timestamp())+300,devices.stamp()))
            audit(conn,"account.delete_requested",user["id"])
            email=user["email"]
        try:send_email(email,code,idempotency_key="account-delete-"+identifier,purpose="delete_account")
        except Exception:
            with connect() as conn:conn.execute("UPDATE account_deletion_requests SET invalidated_at=? WHERE id=?",(devices.stamp(),identifier))
            raise devices.error("deletion_email_unavailable","No pudimos enviar el código. Reintentá en un minuto.",503) from None
        return {"requestId":identifier,"capability":capability,"expiresIn":300,"resendAvailableIn":60}

    @app.post("/account/delete/challenge")
    def renew(payload: Intent,request: Request,authorization: str|None=Header(default=None)):
        _,claims=actor(authorization)
        enforce_rate_limit(request,"account-delete-proof",identity=claims["sub"],limit=20,window_seconds=600)
        with connect() as conn:
            lifecycle.lock_active_user(conn,claims["sub"])
            devices.active_family(conn,claims["sub"],claims["device_id"],claims["family_id"])
            row=intent_row(conn,payload);check_actor(row,claims)
            return challenge(conn,row)

    @app.post("/account/delete/complete")
    def complete(payload: Complete,request: Request,authorization: str|None=Header(default=None)):
        enforce_rate_limit(request,"account-delete-complete",identity=payload.requestId,limit=20,window_seconds=600)
        token=(authorization or "").split(" ",1)[-1].strip()
        # Exact, bounded retry of a completed request returns a receipt only.
        # It cannot grant access, mutate again, or accept a different proof/token.
        receipt=completed_receipt(payload,token)
        if receipt is not None:return receipt
        try:
            token,claims=actor(authorization)
            with connect() as conn:
                if conn.engine=="sqlite":conn.execute("PRAGMA foreign_keys=ON")
                user=lifecycle.lock_active_user(conn,claims["sub"])
                devices.active_family(conn,claims["sub"],claims["device_id"],claims["family_id"])
                row=intent_row(conn,payload);check_actor(row,claims);verify(row,payload)
                if row["otp_expires_at"]<=int(devices.now().timestamp()):raise devices.error("deletion_otp_expired","El código venció. Iniciá el proceso nuevamente.")
                if row["attempts"]>=5:raise devices.error("deletion_otp_attempts","Se agotaron los intentos. Pedí otro código.",429)
                if not hmac.compare_digest(row["otp_hash"],devices.code_hash(user["id"],"delete_account:"+row["id"],payload.code)):
                    conn.execute("UPDATE account_deletion_requests SET attempts=attempts+1 WHERE id=?",(row["id"],));conn.commit()
                    raise devices.error("deletion_otp_invalid","El código no es correcto.",400)
                close_internal(conn,user,row,token,payload)
        except HTTPException:
            # A concurrent identical completion may have won between the read
            # and the lock. Only its exact authenticated receipt is reusable.
            receipt=completed_receipt(payload,token)
            if receipt is not None:return receipt
            raise
        external_delete(payload.requestId)
        with connect() as conn:return result(conn,payload.requestId)
