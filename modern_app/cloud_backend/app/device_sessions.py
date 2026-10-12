"""Shared desktop/mobile authorization using the frozen Device Proof V1.

No provider refresh tokens, OTP plaintext or private keys are stored here.
Mutations serialize per user (PostgreSQL row lock / SQLite write transaction).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import os
import logging
import secrets
import struct
import unicodedata
from uuid import UUID, uuid4

from fastapi import Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from .auth import create_access_token, decode_access_token, get_jwt_secret, get_access_token_expires_in
from .db import connect
from .device_verification import (
    DeviceProofFields, DeviceProofPurpose, DeviceVerificationMode, base64url_decode,
    base64url_encode, build_device_proof_message, parse_device_verification_mode, verify_device_proof,
)
from .security import enforce_rate_limit


_logger = logging.getLogger("scisonomics.cloud.devices")


PURPOSES = {"device_enrollment": DeviceProofPurpose.DEVICE_ENROLLMENT,
            "device_authentication": DeviceProofPurpose.DEVICE_AUTHENTICATION,
            "refresh": DeviceProofPurpose.REFRESH, "device_rename": DeviceProofPurpose.DEVICE_RENAME,
            "device_revoke": DeviceProofPurpose.DEVICE_REVOKE}


def enforced() -> bool:
    return parse_device_verification_mode(os.getenv("SCISONOMICS_DEVICE_VERIFICATION_MODE")) == DeviceVerificationMode.ENFORCE


def error(code: str, message: str, status: int = 401):
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def require_enforced():
    if not enforced():
        raise error("device_verification_unavailable", "La verificación de dispositivos no está habilitada en el servidor.", 503)


def now():
    return datetime.now(timezone.utc)


def stamp():
    return now().isoformat(timespec="seconds")


def uid(value: str) -> bytes:
    parsed = UUID(value)
    if str(parsed) != value or parsed.int == 0:
        raise ValueError("invalid_uuid")
    return parsed.bytes


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def code_hash(user_id, challenge_id, code):
    return hmac.new(get_jwt_secret().encode(), f"device-otp-v1:{user_id}:{challenge_id}:{code}".encode(), hashlib.sha256).hexdigest()


def normalize_name(value):
    value = unicodedata.normalize("NFC", value.strip())
    if not 1 <= len(value) <= 64 or any(unicodedata.category(c).startswith("C") for c in value) or len(value.encode()) > 128:
        raise error("invalid_device_name", "Usá un nombre de dispositivo de hasta 64 caracteres.", 422)
    return value


def lock(conn, user_id):
    if conn.engine == "sqlite":
        conn.execute("BEGIN IMMEDIATE")
    else:
        conn.execute("SELECT id FROM users WHERE id = ? FOR UPDATE", (user_id,))


def binding(conn, user_id):
    row = conn.execute("SELECT device_key_namespace FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None or not row["device_key_namespace"]:
        raise error("device_binding_missing", "No se pudo preparar la identidad de la cuenta.", 503)
    return row["device_key_namespace"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Identity(Strict):
    formatVersion: int = Field(ge=1, le=1)
    deviceId: str = Field(min_length=36, max_length=36)
    publicKey: str = Field(min_length=43, max_length=43)
    publicKeyHash: str = Field(min_length=43, max_length=43)

    def key(self):
        try:
            uid(self.deviceId)
            key = base64url_decode(self.publicKey, expected_length=32)
            if not hmac.compare_digest(hashlib.sha256(key).digest(), base64url_decode(self.publicKeyHash, expected_length=32)):
                raise ValueError()
            return key
        except ValueError:
            raise error("invalid_device_identity", "La identidad del dispositivo no es válida.", 422) from None


class Login(Strict):
    identity: Identity
    name: str = Field(min_length=1, max_length=128)
    platform: str = Field(pattern=r"^(windows|desktop|android|ios)$")


class Continuation(Strict):
    verificationId: str = Field(min_length=36, max_length=36)
    verificationToken: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class Challenge(Strict):
    challengeId: str = Field(min_length=36, max_length=36)
    nonce: str = Field(min_length=43, max_length=43)
    issuedAt: int
    expiresAt: int
    familyId: str | None = Field(default=None, max_length=36)
    targetDeviceId: str | None = Field(default=None, max_length=36)
    requestHash: str | None = Field(default=None, max_length=43)


class Signature(Identity):
    signature: str = Field(min_length=86, max_length=86)


class Complete(Strict):
    challenge: Challenge
    proof: Signature
    verificationId: str | None = Field(default=None, max_length=36)
    verificationToken: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{43}$")
    code: str | None = Field(default=None, pattern=r"^[0-9]{6}$")
    name: str | None = Field(default=None, max_length=128)
    confirmCurrent: bool = False


class Refresh(Strict):
    deviceId: str = Field(min_length=36, max_length=36)
    familyId: str = Field(min_length=36, max_length=36)


class Management(Refresh):
    purpose: str = Field(pattern=r"^device_(rename|revoke)$")
    targetDeviceId: str = Field(min_length=36, max_length=36)
    name: str | None = Field(default=None, max_length=128)


def active_family(conn, user_id, device_id, family_id):
    row = conn.execute("""SELECT d.*, f.id AS family_id, f.revoked_at AS family_revoked,
        f.expires_at AS family_expires, f.compromised_at AS compromised
        FROM trusted_devices d JOIN refresh_token_families f ON f.trusted_device_id = d.id AND f.user_id = d.user_id
        WHERE d.user_id = ? AND d.device_id = ? AND f.id = ?""", (user_id, device_id, family_id)).fetchone()
    if row is None or row["status"] != "trusted" or row["family_revoked"] or row["compromised"] or datetime.fromisoformat(row["family_expires"]) <= now():
        raise error("device_revoked", "Este dispositivo ya no está autorizado. Volvé a iniciar sesión y verificá tu correo.")
    return row


def authorize_access(token: str):
    try:
        payload = decode_access_token(token)
        if payload.get("type") != "access" or payload.get("device_authorized") is not True:
            raise ValueError()
        with connect() as conn:
            active_family(conn, payload["sub"], payload["device_id"], payload["family_id"])
        return payload
    except (ValueError, KeyError):
        raise error("device_verification_required", "Verificá este dispositivo antes de usar tu cuenta.") from None


def proof_challenge(conn, user_id, identity, purpose, *, device=None, family_id=None, target=None, request_hash=None):
    raw_binding = base64url_decode(binding(conn, user_id), expected_length=32)
    nonce, challenge_id, issued = secrets.token_bytes(32), str(uuid4()), int(now().timestamp())
    conn.execute("""INSERT INTO device_proof_challenges
        (id,user_id,trusted_device_id,account_binding_hash,device_id,public_key_hash,purpose,nonce_hash,
         issued_at,expires_at,refresh_family_id,target_device_id,request_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (challenge_id,user_id,device["id"] if device else None,
        hashlib.sha256(raw_binding).digest(),identity.deviceId,hashlib.sha256(identity.key()).digest(),purpose,
        hashlib.sha256(nonce).digest(),issued,issued+120,family_id,target,request_hash,stamp()))
    return {"challengeId": challenge_id,"nonce": base64url_encode(nonce),"issuedAt": issued,"expiresAt": issued+120,
            "familyId": family_id,"targetDeviceId": target,"requestHash": base64url_encode(request_hash) if request_hash else None}


def verify_proof(conn, user_id, payload, expected_purpose):
    row = conn.execute("SELECT * FROM device_proof_challenges WHERE id = ? AND user_id = ?", (payload.challenge.challengeId,user_id)).fetchone()
    if row is None or row["purpose"] != expected_purpose or row["consumed_at"] or row["invalidated_at"] or row["expires_at"] <= int(now().timestamp()):
        raise error("device_proof_expired", "La verificación venció o ya fue utilizada. Intentá nuevamente.")
    try:
        c, p = payload.challenge, payload.proof
        key = p.key()
        nonce = base64url_decode(c.nonce, expected_length=32)
        raw_binding = base64url_decode(binding(conn,user_id),expected_length=32)
        if (p.deviceId != row["device_id"] or c.issuedAt != row["issued_at"] or c.expiresAt != row["expires_at"]
            or c.familyId != row["refresh_family_id"] or c.targetDeviceId != row["target_device_id"]
            or c.requestHash != (base64url_encode(bytes(row["request_hash"])) if row["request_hash"] else None)
            or not hmac.compare_digest(hashlib.sha256(nonce).digest(),bytes(row["nonce_hash"]))
            or not hmac.compare_digest(hashlib.sha256(raw_binding).digest(),bytes(row["account_binding_hash"]))
            or not hmac.compare_digest(hashlib.sha256(key).digest(),bytes(row["public_key_hash"]))):
            raise ValueError()
        fields = DeviceProofFields(PURPOSES[expected_purpose],raw_binding,uid(row["device_id"]),bytes(row["public_key_hash"]),
            uid(row["id"]),nonce,row["issued_at"],row["expires_at"],
            uid(row["refresh_family_id"]) if row["refresh_family_id"] else None,
            uid(row["target_device_id"]) if row["target_device_id"] else None,
            bytes(row["request_hash"]) if row["request_hash"] else None)
        if not verify_device_proof(key,base64url_decode(p.signature,expected_length=64),build_device_proof_message(fields)):
            raise ValueError()
    except ValueError:
        raise error("device_proof_invalid", "No se pudo verificar este dispositivo.") from None
    if conn.execute("UPDATE device_proof_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND invalidated_at IS NULL", (stamp(),row["id"])).rowcount != 1:
        raise error("device_proof_used", "Esta verificación ya fue utilizada.")
    return row


def continuation(conn, user_id, payload):
    row = conn.execute("SELECT * FROM device_verification_challenges WHERE id = ? AND user_id = ?", (payload.verificationId,user_id)).fetchone()
    if row is None or row["consumed_at"] or row["invalidated_at"] or not payload.verificationToken or not hmac.compare_digest(row["verification_token_hash"],digest(payload.verificationToken)):
        raise error("device_verification_expired", "La verificación venció o fue reemplazada. Volvé a iniciar sesión.")
    if not hmac.compare_digest(bytes(row["account_binding_hash"]), hashlib.sha256(base64url_decode(binding(conn,user_id),expected_length=32)).digest()):
        raise error("device_verification_expired", "La identidad de la cuenta cambió. Volvé a iniciar sesión.")
    if datetime.fromisoformat(row["email_expires_at"]) <= now():
        raise error("device_otp_expired", "El código venció. Pedí uno nuevo.")
    if row["attempts"] >= row["max_attempts"]:
        raise error("device_otp_attempts", "Demasiados intentos. Pedí un nuevo código cuando esté disponible.", 429)
    return row


def create_otp(conn, user, identity, name, platform):
    last = conn.execute("SELECT last_sent_at FROM device_verification_challenges WHERE user_id = ? ORDER BY last_sent_at DESC LIMIT 1",(user.id,)).fetchone()
    if last and (now()-datetime.fromisoformat(last["last_sent_at"])).total_seconds() < 60:
        raise error("device_resend_cooldown", "Esperá 60 segundos antes de pedir otro código.",429)
    hour = (now()-timedelta(hours=1)).isoformat(timespec="seconds")
    if conn.execute("SELECT COUNT(*) AS n FROM device_verification_challenges WHERE user_id = ? AND created_at > ?",(user.id,hour)).fetchone()["n"] >= 5:
        raise error("device_email_rate_limit", "Demasiadas solicitudes. Intentá más tarde.",429)
    created, challenge_id, token = stamp(), str(uuid4()), secrets.token_urlsafe(32)
    code = f"{secrets.randbelow(1000000):06d}"
    conn.execute("UPDATE device_verification_challenges SET invalidated_at = ? WHERE user_id = ? AND device_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL",(created,user.id,identity.deviceId))
    conn.execute("UPDATE device_proof_challenges SET invalidated_at = ? WHERE user_id = ? AND device_id = ? AND purpose = 'device_enrollment' AND consumed_at IS NULL",(created,user.id,identity.deviceId))
    key = identity.key()
    conn.execute("""INSERT INTO device_verification_challenges
        (id,user_id,account_binding_hash,device_id,candidate_public_key,candidate_public_key_hash,device_name,
         email_code_hash,verification_token_hash,email_expires_at,attempts,max_attempts,last_sent_at,created_at,updated_at,platform)
        VALUES (?,?,?,?,?,?,?,?,?,?,0,5,?,?,?,?)""",(challenge_id,user.id,
        hashlib.sha256(base64url_decode(binding(conn,user.id),expected_length=32)).digest(),identity.deviceId,key,
        hashlib.sha256(key).digest(),name,code_hash(user.id,challenge_id,code),digest(token),
        (now()+timedelta(minutes=10)).isoformat(timespec="seconds"),created,created,created,platform))
    return {"status":"pending_verification","verificationId":challenge_id,"verificationToken":token,
            "expiresIn":600,"resendAvailableIn":60}, code


def identity_from_row(row):
    return Identity(formatVersion=1,deviceId=row["device_id"],publicKey=base64url_encode(bytes(row["public_key"])),publicKeyHash=base64url_encode(bytes(row["public_key_hash"])))


def grant(conn,user,device,family_id=None):
    if not family_id:
        family_id = str(uuid4())
        conn.execute("INSERT INTO refresh_token_families (id,user_id,trusted_device_id,created_at,last_used_at,expires_at) VALUES (?,?,?,?,?,?)",
            (family_id,user.id,device["id"],stamp(),stamp(),(now()+timedelta(days=30)).isoformat(timespec="seconds")))
    conn.execute("UPDATE trusted_devices SET last_seen_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",(stamp(),stamp(),device["id"],user.id))
    conn.execute("UPDATE refresh_token_families SET last_used_at = ? WHERE id = ? AND user_id = ?",(stamp(),family_id,user.id))
    ttl = min(900, get_access_token_expires_in())
    return {"user":user.model_dump(),"access_token":create_access_token(user.id,extra={"device_authorized":True,"device_id":device["device_id"],"family_id":family_id,"exp":int(now().timestamp())+ttl}),
            "expires_in":ttl,"familyId":family_id,"deviceId":device["device_id"],"accountBinding":binding(conn,user.id)}


def register_routes(app, identity_user, current_user, send_email):
    def deliver(user,response,code):
        try:
            send_email(user.email,code,idempotency_key=f"device-verification-{response['verificationId']}",purpose="new_device")
        except Exception:
            _logger.warning("[device-auth] email_delivery_failed user=%s", user.id[:8])
            with connect() as conn:
                conn.execute("UPDATE device_verification_challenges SET invalidated_at = ? WHERE id = ? AND user_id = ?",(stamp(),response["verificationId"],user.id))
            raise error("device_email_unavailable","No pudimos enviar el código. Intentá nuevamente en un minuto.",503) from None
        _logger.info("[device-auth] verification_sent user=%s", user.id[:8])
        return response

    @app.get("/auth/devices/context")
    def context(user=Depends(identity_user)):
        require_enforced()
        with connect() as conn:
            return {"userId":user.id,"accountBinding":binding(conn,user.id),"mode":"enforce"}

    @app.post("/auth/devices/login")
    def login(payload: Login,request: Request,user=Depends(identity_user)):
        require_enforced()
        enforce_rate_limit(request,"device-login",identity=user.id,limit=30,window_seconds=600)
        key, name = payload.identity.key(), normalize_name(payload.name)
        with connect() as conn:
            lock(conn,user.id)
            alias = conn.execute("SELECT device_id FROM trusted_devices WHERE user_id = ? AND public_key_hash = ?",(user.id,hashlib.sha256(key).digest())).fetchone()
            if alias and alias["device_id"] != payload.identity.deviceId:
                raise error("device_key_conflict", "Esta clave ya pertenece a otro dispositivo de la cuenta.", 409)
            device = conn.execute("SELECT * FROM trusted_devices WHERE user_id = ? AND device_id = ?",(user.id,payload.identity.deviceId)).fetchone()
            if device and not hmac.compare_digest(bytes(device["public_key"]),key):
                raise error("device_key_conflict","La clave de este dispositivo cambió. Requiere una identidad nueva.",409)
            if device and device["status"] == "trusted":
                return {"status":"trusted","challenge":proof_challenge(conn,user.id,payload.identity,"device_authentication",device=device)}
            response,code = create_otp(conn,user,payload.identity,name,payload.platform)
        return deliver(user,response,code)

    @app.post("/auth/devices/resend")
    def resend(payload: Continuation,request: Request,user=Depends(identity_user)):
        require_enforced()
        enforce_rate_limit(request,"device-resend",identity=user.id,limit=10,window_seconds=3600)
        with connect() as conn:
            lock(conn,user.id)
            # Expired/exhausted OTPs can be replaced, but not invalidated capabilities.
            row = conn.execute("SELECT * FROM device_verification_challenges WHERE id = ? AND user_id = ?",(payload.verificationId,user.id)).fetchone()
            if row is None or row["consumed_at"] or row["invalidated_at"] or not hmac.compare_digest(row["verification_token_hash"],digest(payload.verificationToken)):
                raise error("device_verification_expired","Volvé a iniciar sesión para pedir otro código.")
            identity = Identity(formatVersion=1,deviceId=row["device_id"],publicKey=base64url_encode(bytes(row["candidate_public_key"])),publicKeyHash=base64url_encode(bytes(row["candidate_public_key_hash"])))
            response,code = create_otp(conn,user,identity,row["device_name"],row["platform"])
        return deliver(user,response,code)

    @app.post("/auth/devices/enrollment/challenge")
    def enrollment_challenge(payload: Continuation,request: Request,user=Depends(identity_user)):
        require_enforced()
        enforce_rate_limit(request,"device-proof",identity=user.id,limit=30,window_seconds=600)
        with connect() as conn:
            lock(conn,user.id)
            row = continuation(conn,user.id,payload)
            identity = Identity(formatVersion=1,deviceId=row["device_id"],publicKey=base64url_encode(bytes(row["candidate_public_key"])),publicKeyHash=base64url_encode(bytes(row["candidate_public_key_hash"])))
            return proof_challenge(conn,user.id,identity,"device_enrollment")

    @app.post("/auth/devices/enrollment/complete")
    def enroll(payload: Complete,request: Request,user=Depends(identity_user)):
        require_enforced()
        enforce_rate_limit(request,"device-otp",identity=user.id,limit=30,window_seconds=600)
        with connect() as conn:
            lock(conn,user.id)
            row = continuation(conn,user.id,payload)
            if not payload.code or not hmac.compare_digest(row["email_code_hash"],code_hash(user.id,row["id"],payload.code)):
                conn.execute("UPDATE device_verification_challenges SET attempts = attempts + 1, updated_at = ? WHERE id = ? AND user_id = ?",(stamp(),row["id"],user.id))
                conn.commit()  # Failed attempts must survive the HTTP error rollback.
                raise error("device_otp_invalid","Código incorrecto. Revisalo e intentá nuevamente.",400)
            if payload.proof.deviceId != row["device_id"] or not hmac.compare_digest(payload.proof.key(),bytes(row["candidate_public_key"])):
                raise error("device_proof_invalid","La verificación no corresponde a este dispositivo.")
            verify_proof(conn,user.id,payload,"device_enrollment")
            created = stamp()
            device = conn.execute("SELECT * FROM trusted_devices WHERE user_id = ? AND device_id = ?",(user.id,row["device_id"])).fetchone()
            if device and not hmac.compare_digest(bytes(device["public_key"]),bytes(row["candidate_public_key"])):
                raise error("device_key_conflict","La identidad del dispositivo cambió.",409)
            if device:
                conn.execute("UPDATE trusted_devices SET status = 'trusted', trusted_at = ?, revoked_at = NULL, revocation_reason = NULL, updated_at = ? WHERE id = ? AND user_id = ?",(created,created,device["id"],user.id))
            else:
                conn.execute("""INSERT INTO trusted_devices
                    (id,user_id,device_id,public_key,public_key_hash,device_name,status,trust_source,first_seen_at,last_seen_at,trusted_at,created_at,updated_at,platform)
                    VALUES (?,?,?,?,?,?,'trusted','email_otp',?,?,?,?,?,?)""",(str(uuid4()),user.id,row["device_id"],row["candidate_public_key"],row["candidate_public_key_hash"],row["device_name"],created,created,created,created,created,row["platform"]))
            conn.execute("UPDATE device_verification_challenges SET consumed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",(created,created,row["id"],user.id))
            device = conn.execute("SELECT * FROM trusted_devices WHERE user_id = ? AND device_id = ?",(user.id,row["device_id"])).fetchone()
            _logger.info("[device-auth] enrolled user=%s device=%s", user.id[:8], device["device_id"][:8])
            return grant(conn,user,device)

    @app.post("/auth/devices/authentication/complete")
    def authenticate(payload: Complete,request: Request,user=Depends(identity_user)):
        require_enforced()
        enforce_rate_limit(request,"device-authentication-complete",identity=user.id,limit=60,window_seconds=600)
        with connect() as conn:
            lock(conn,user.id)
            row = verify_proof(conn,user.id,payload,"device_authentication")
            device = conn.execute("SELECT * FROM trusted_devices WHERE user_id = ? AND device_id = ?",(user.id,row["device_id"])).fetchone()
            if not device or device["status"] != "trusted":
                raise error("device_revoked","Este dispositivo ya no está autorizado.")
            return grant(conn,user,device)

    @app.post("/auth/devices/refresh/challenge")
    def refresh_challenge(payload: Refresh,request: Request,user=Depends(identity_user)):
        require_enforced()
        enforce_rate_limit(request,"device-refresh",identity=user.id,limit=60,window_seconds=600)
        with connect() as conn:
            lock(conn,user.id)
            device = active_family(conn,user.id,payload.deviceId,payload.familyId)
            return proof_challenge(conn,user.id,identity_from_row(device),"refresh",device=device,family_id=payload.familyId)

    @app.post("/auth/devices/refresh/complete")
    def refresh_complete(payload: Complete,request: Request,user=Depends(identity_user)):
        require_enforced()
        enforce_rate_limit(request,"device-refresh-complete",identity=user.id,limit=60,window_seconds=600)
        with connect() as conn:
            lock(conn,user.id)
            device = active_family(conn,user.id,payload.proof.deviceId,payload.challenge.familyId)
            verify_proof(conn,user.id,payload,"refresh")
            return grant(conn,user,device,payload.challenge.familyId)

    @app.get("/auth/devices")
    def devices(user=Depends(current_user),authorization: str = Header()):
        require_enforced()
        claims = authorize_access(authorization.split(" ",1)[1].strip())
        with connect() as conn:
            rows = conn.execute("SELECT device_id,device_name,platform,status,created_at,last_seen_at,revoked_at FROM trusted_devices WHERE user_id = ? ORDER BY created_at",(user.id,)).fetchall()
        return {"devices":[{**dict(row),"current":row["device_id"] == claims["device_id"]} for row in rows]}

    @app.post("/auth/devices/management/challenge")
    def manage_challenge(payload: Management,request: Request,user=Depends(current_user),authorization: str = Header()):
        require_enforced()
        enforce_rate_limit(request,"device-management",identity=user.id,limit=30,window_seconds=600)
        claims = authorize_access(authorization.split(" ",1)[1].strip())
        if claims["device_id"] != payload.deviceId or claims["family_id"] != payload.familyId:
            raise error("device_proof_invalid","La sesión no corresponde a este dispositivo.")
        with connect() as conn:
            lock(conn,user.id)
            device = active_family(conn,user.id,payload.deviceId,payload.familyId)
            if conn.execute("SELECT id FROM trusted_devices WHERE user_id = ? AND device_id = ?",(user.id,payload.targetDeviceId)).fetchone() is None:
                raise error("device_not_found","Dispositivo no encontrado.",404)
            request_hash = None
            if payload.purpose == "device_rename":
                encoded = normalize_name(payload.name or "").encode()
                request_hash = hashlib.sha256(struct.pack(">H",len(encoded))+encoded).digest()
            return proof_challenge(conn,user.id,identity_from_row(device),payload.purpose,device=device,family_id=payload.familyId,target=payload.targetDeviceId,request_hash=request_hash)

    @app.post("/auth/devices/management/complete")
    def manage_complete(payload: Complete,request: Request,user=Depends(current_user),authorization: str = Header()):
        require_enforced()
        enforce_rate_limit(request,"device-management-complete",identity=user.id,limit=30,window_seconds=600)
        claims = authorize_access(authorization.split(" ",1)[1].strip())
        with connect() as conn:
            lock(conn,user.id)
            active_family(conn,user.id,claims["device_id"],claims["family_id"])
            if payload.proof.deviceId != claims["device_id"] or payload.challenge.familyId != claims["family_id"]:
                raise error("device_proof_invalid","La sesión no corresponde a este dispositivo.")
            row = conn.execute("SELECT purpose FROM device_proof_challenges WHERE id = ? AND user_id = ?",(payload.challenge.challengeId,user.id)).fetchone()
            if not row or row["purpose"] not in {"device_rename","device_revoke"}:
                raise error("device_proof_invalid","Verificación no válida.")
            proof = verify_proof(conn,user.id,payload,row["purpose"])
            target = proof["target_device_id"]
            if row["purpose"] == "device_rename":
                name = normalize_name(payload.name or "")
                encoded = name.encode()
                if not hmac.compare_digest(hashlib.sha256(struct.pack(">H",len(encoded))+encoded).digest(),bytes(proof["request_hash"])):
                    raise error("device_proof_invalid","El nombre cambió durante la verificación.")
                conn.execute("UPDATE trusted_devices SET device_name = ?, updated_at = ? WHERE user_id = ? AND device_id = ?",(name,stamp(),user.id,target))
            else:
                if target == claims["device_id"] and not payload.confirmCurrent:
                    raise error("device_confirmation_required","Confirmá la revocación de este dispositivo.",409)
                conn.execute("UPDATE trusted_devices SET status = 'revoked', revoked_at = ?, updated_at = ?, revocation_reason = 'user' WHERE user_id = ? AND device_id = ?",(stamp(),stamp(),user.id,target))
                conn.execute("UPDATE refresh_token_families SET revoked_at = ?, revocation_reason = 'device_revoked' WHERE user_id = ? AND trusted_device_id IN (SELECT id FROM trusted_devices WHERE user_id = ? AND device_id = ?) AND revoked_at IS NULL",(stamp(),user.id,user.id,target))
                conn.execute("UPDATE device_proof_challenges SET invalidated_at = ? WHERE user_id = ? AND device_id = ? AND consumed_at IS NULL",(stamp(),user.id,target))
                conn.execute("UPDATE device_verification_challenges SET invalidated_at = ? WHERE user_id = ? AND device_id = ? AND consumed_at IS NULL",(stamp(),user.id,target))
        _logger.info("[device-auth] %s user=%s device=%s", row["purpose"], user.id[:8], target[:8])
        return {"ok":True,"currentRevoked":row["purpose"] == "device_revoke" and target == claims["device_id"]}
