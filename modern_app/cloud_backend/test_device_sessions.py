"""Isolated authorization tests: never use Railway, real mail or real tokens."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import logging
import os
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import httpx

from modern_app.cloud_backend import test_supabase_auth as fixtures
from modern_app.cloud_backend.app import db, main
from modern_app.cloud_backend.app.auth import create_access_token
from modern_app.cloud_backend.app.device_verification import (
    DeviceProofFields, DeviceProofPurpose, base64url_decode, base64url_encode, build_device_proof_message,
)


class DeviceSessionsTests(unittest.TestCase):
    setUp = fixtures.DualAuthTests.setUp
    insert_user = fixtures.DualAuthTests.insert_user

    def prepare(self):
        self.insert_user(provider_id=fixtures.SUB)
        self.mode = patch.dict(os.environ, {"SCISONOMICS_DEVICE_VERIFICATION_MODE":"enforce", "SCISONOMICS_EMAIL_PROVIDER":"memory"})
        self.mode.start(); self.addCleanup(self.mode.stop)
        main._DEV_EMAIL_OUTBOX.clear()
        with db.connect() as conn:
            conn.execute("UPDATE users SET plan = 'premium', subscription_status = 'active', subscription_expires_at = '2030-01-01T00:00:00+00:00' WHERE id = ?",(fixtures.INTERNAL_ID,))
            conn.execute("INSERT INTO cloud_movimientos (user_id,sync_id,tipo,monto,fecha,remote_updated_at) VALUES (?,?,'Ingreso',700,'2026-01-01',?)",(fixtures.INTERNAL_ID,str(uuid4()),fixtures.STAMP))
        db.init_db()  # Simulate additive migration/backfill for a historical account.
        self.binding = self.get_context()["accountBinding"]
        self.addCleanup(main._DEV_EMAIL_OUTBOX.clear)

    def get_context(self):
        r = self.client.get("/auth/devices/context", headers=self.headers())
        self.assertEqual(r.status_code,200,r.text)
        return r.json()

    def headers(self,token=None):
        return {"Authorization":f"Bearer {token or 'test-supabase-token'}"}

    def post(self,path,body,token=None):
        return self.client.post("/auth/devices"+path,json=body,headers=self.headers(token))

    def identity(self):
        key = Ed25519PrivateKey.generate()
        public = key.public_key().public_bytes_raw()
        return key, {"formatVersion":1,"deviceId":str(uuid4()),"publicKey":base64url_encode(public),"publicKeyHash":base64url_encode(hashlib.sha256(public).digest())}

    def start(self,identity,platform="windows"):
        r=self.post("/login",{"identity":identity,"platform":platform,"name":"Equipo de prueba"})
        self.assertEqual(r.status_code,200,r.text)
        return r.json()

    def sign(self,key,identity,challenge,purpose):
        fields=DeviceProofFields(DeviceProofPurpose(purpose),base64url_decode(self.binding,expected_length=32),
            UUID(identity["deviceId"]).bytes,base64url_decode(identity["publicKeyHash"],expected_length=32),
            UUID(challenge["challengeId"]).bytes,base64url_decode(challenge["nonce"],expected_length=32),challenge["issuedAt"],challenge["expiresAt"],
            UUID(challenge["familyId"]).bytes if challenge["familyId"] else None,
            UUID(challenge["targetDeviceId"]).bytes if challenge["targetDeviceId"] else None,
            base64url_decode(challenge["requestHash"],expected_length=32) if challenge["requestHash"] else None)
        return {**identity,"signature":base64url_encode(key.sign(build_device_proof_message(fields)))}

    def enrollment_body(self,key,identity,start,code=None):
        continuation={k:start[k] for k in ("verificationId","verificationToken")}
        r=self.post("/enrollment/challenge",continuation)
        self.assertEqual(r.status_code,200,r.text)
        c=r.json()
        return {**continuation,"code":code or main._DEV_EMAIL_OUTBOX[-1]["code"],"challenge":c,"proof":self.sign(key,identity,c,1)}

    def enroll(self,key,identity,start):
        r=self.post("/enrollment/complete",self.enrollment_body(key,identity,start))
        self.assertEqual(r.status_code,200,r.text)
        return r.json()

    def refresh_body(self,key,identity,grant):
        r=self.post("/refresh/challenge",{"deviceId":identity["deviceId"],"familyId":grant["familyId"]})
        self.assertEqual(r.status_code,200,r.text)
        c=r.json()
        return {"challenge":c,"proof":self.sign(key,identity,c,3)}

    def test_new_device_pending_without_grant_and_raw_tokens_cannot_access_data(self):
        self.prepare(); _,identity=self.identity()
        start=self.start(identity)
        self.assertEqual(start["status"],"pending_verification")
        self.assertNotIn("access_token",start)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM refresh_token_families").fetchone()["n"],0)
            self.assertNotEqual(conn.execute("SELECT email_code_hash FROM device_verification_challenges").fetchone()["email_code_hash"],main._DEV_EMAIL_OUTBOX[-1]["code"])
        for token in ("test-supabase-token",create_access_token(fixtures.INTERNAL_ID)):
            self.assertEqual(self.client.get("/auth/me",headers=self.headers(token)).status_code,401)
        self.assertEqual(self.client.post("/auth/refresh",json={"refresh_token":"test-only"*8}).status_code,401)

    def test_correct_otp_known_login_and_restore_preserve_financial_identity(self):
        self.prepare(); key,identity=self.identity()
        grant=self.enroll(key,identity,self.start(identity))
        self.assertEqual(grant["user"]["id"],fixtures.INTERNAL_ID)
        self.assertNotEqual(grant["user"]["id"],fixtures.SUB)
        self.assertEqual(self.client.get("/auth/me",headers=self.headers(grant["access_token"])).status_code,200)
        known=self.start(identity)
        self.assertEqual(known["status"],"trusted")
        self.assertEqual(len(main._DEV_EMAIL_OUTBOX),1)
        r=self.post("/authentication/complete",{"challenge":known["challenge"],"proof":self.sign(key,identity,known["challenge"],2)})
        self.assertEqual(r.status_code,200,r.text)
        body=self.refresh_body(key,identity,grant)
        restored=self.post("/refresh/complete",body)
        self.assertEqual(restored.status_code,200,restored.text)
        self.assertEqual(self.post("/refresh/complete",body).status_code,401)
        with db.connect() as conn:
            user=conn.execute("SELECT plan,subscription_status,subscription_expires_at FROM users WHERE id = ?",(fixtures.INTERNAL_ID,)).fetchone()
            self.assertEqual(tuple(user[column] for column in ('plan','subscription_status','subscription_expires_at')),('premium','active','2030-01-01T00:00:00+00:00'))
            self.assertEqual(conn.execute("SELECT user_id,monto FROM cloud_movimientos").fetchone()["user_id"],fixtures.INTERNAL_ID)

    def test_wrong_code_five_attempts_and_no_authorization(self):
        self.prepare(); key,identity=self.identity(); start=self.start(identity)
        wrong="000000" if main._DEV_EMAIL_OUTBOX[-1]["code"] != "000000" else "000001"
        body=self.enrollment_body(key,identity,start,wrong)
        for _ in range(5): self.assertEqual(self.post("/enrollment/complete",body).status_code,400)
        self.assertEqual(self.post("/enrollment/complete",body).status_code,429)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT attempts FROM device_verification_challenges").fetchone()["attempts"],5)
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM trusted_devices").fetchone()["n"],0)

    def test_expired_code_and_proof_are_rejected(self):
        self.prepare(); key,identity=self.identity(); start=self.start(identity)
        body=self.enrollment_body(key,identity,start)
        with db.connect() as conn:
            conn.execute("UPDATE device_verification_challenges SET email_expires_at = ?",((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(),))
        r=self.post("/enrollment/complete",body)
        self.assertEqual(r.json()["detail"]["code"],"device_otp_expired")

    def test_resend_cooldown_invalidates_old_code_and_continuation(self):
        self.prepare(); key,identity=self.identity(); start=self.start(identity)
        previous=self.enrollment_body(key,identity,start)
        continuation={k:start[k] for k in ("verificationId","verificationToken")}
        self.assertEqual(self.post("/resend",continuation).status_code,429)
        with db.connect() as conn:
            conn.execute("UPDATE device_verification_challenges SET last_sent_at = ?",((datetime.now(timezone.utc)-timedelta(seconds=61)).isoformat(),))
        r=self.post("/resend",continuation);self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(self.post("/enrollment/complete",previous).status_code,401)
        self.enroll(key,identity,r.json())

    def test_windows_revokes_android_refresh_rejected_relogin_needs_otp(self):
        self.prepare(); a,ia=self.identity(); ga=self.enroll(a,ia,self.start(ia))
        with db.connect() as conn:
            conn.execute("UPDATE device_verification_challenges SET last_sent_at = ?",((datetime.now(timezone.utc)-timedelta(seconds=61)).isoformat(),))
        b,ib=self.identity(); gb=self.enroll(b,ib,self.start(ib,"android"))
        body=self.refresh_body(b,ib,gb)  # Even an already-issued refresh proof is revoked.
        c=self.post("/management/challenge",{"deviceId":ia["deviceId"],"familyId":ga["familyId"],"targetDeviceId":ib["deviceId"],"purpose":"device_revoke"},ga["access_token"]).json()
        r=self.post("/management/complete",{"challenge":c,"proof":self.sign(a,ia,c,5)},ga["access_token"])
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(self.post("/refresh/complete",body).status_code,401)
        self.assertEqual(self.client.get("/auth/me",headers=self.headers(gb["access_token"])).status_code,401)
        with db.connect() as conn:
            conn.execute("UPDATE device_verification_challenges SET last_sent_at = ?",((datetime.now(timezone.utc)-timedelta(seconds=61)).isoformat(),))
        self.assertEqual(self.start(ib,"android")["status"],"pending_verification")
        devices=self.client.get("/auth/devices",headers=self.headers(ga["access_token"])).json()["devices"]
        self.assertEqual([x["status"] for x in devices if x["device_id"]==ib["deviceId"]],["revoked"])

    def test_second_windows_profile_is_new_and_current_revoke_requires_confirmation(self):
        self.prepare(); key,identity=self.identity(); grant=self.enroll(key,identity,self.start(identity))
        c=self.post("/management/challenge",{"deviceId":identity["deviceId"],"familyId":grant["familyId"],"targetDeviceId":identity["deviceId"],"purpose":"device_revoke"},grant["access_token"]).json()
        body={"challenge":c,"proof":self.sign(key,identity,c,5)}
        self.assertEqual(self.post("/management/complete",body,grant["access_token"]).status_code,409)
        self.assertEqual(self.post("/management/complete",{**body,"confirmCurrent":True},grant["access_token"]).status_code,200)
        with db.connect() as conn:
            conn.execute("UPDATE device_verification_challenges SET last_sent_at = ?",((datetime.now(timezone.utc)-timedelta(seconds=61)).isoformat(),))
        _,second=self.identity()
        self.assertEqual(self.start(second)["status"],"pending_verification")

    def test_proof_signature_key_and_cross_purpose_cannot_be_substituted(self):
        self.prepare(); key,identity=self.identity(); start=self.start(identity)
        body=self.enrollment_body(key,identity,start)
        other,_=self.identity()
        body["proof"]=self.sign(other,identity,body["challenge"],1)
        self.assertEqual(self.post("/enrollment/complete",body).status_code,401)
        body["proof"]=self.sign(key,identity,body["challenge"],2)
        self.assertEqual(self.post("/enrollment/complete",body).status_code,401)

    def test_concurrent_enrollment_is_single_use(self):
        self.prepare(); key,identity=self.identity(); body=self.enrollment_body(key,identity,self.start(identity))
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses=list(pool.map(lambda _:self.post("/enrollment/complete",body).status_code,range(2)))
        self.assertEqual(sorted(statuses),[200,401])

    def test_server_off_is_fail_closed_for_device_clients(self):
        self.prepare()
        with patch.dict(os.environ,{"SCISONOMICS_DEVICE_VERIFICATION_MODE":"off"}):
            self.assertEqual(self.client.get("/auth/devices/context",headers=self.headers()).status_code,503)

    def test_no_secrets_in_logs_or_validation_and_email_is_provider_confirmed(self):
        self.prepare()
        self.get.return_value = httpx.Response(200, json=fixtures.provider_user(email="confirmed@example.com"))
        records = []
        class Capture(logging.Handler):
            def emit(self, record): records.append(record.getMessage())
        handler = Capture()
        logger = logging.getLogger("scisonomics.cloud.devices")
        previous_level = logger.level
        logger.setLevel(logging.INFO); logger.addHandler(handler)
        self.addCleanup(logger.removeHandler,handler); self.addCleanup(logger.setLevel,previous_level)
        key,identity = self.identity(); start = self.start(identity)
        code = main._DEV_EMAIL_OUTBOX[-1]["code"]
        self.assertEqual(main._DEV_EMAIL_OUTBOX[-1]["email"],"confirmed@example.com")
        body = self.enrollment_body(key,identity,start)
        grant = self.enroll(key,identity,start)
        self.assertTrue(records)
        secrets = [code,start["verificationToken"],grant["access_token"],body["proof"]["signature"],"test-supabase-token"]
        self.assertTrue(not any(secret in "\n".join(records) for secret in secrets),"Sensitive material detected in logs")
        response = self.post("/enrollment/complete",{**body,"unexpected":"private-test-material"})
        self.assertEqual(response.status_code,422)
        self.assertEqual(response.headers.get("cache-control"),"no-store")
        self.assertTrue(not any(secret in response.text for secret in secrets + ["private-test-material"]),"Sensitive input echoed by validation")
        malformed = self.post("/resend", {"verificationId": start["verificationId"], "verificationToken": "\u00e9" * 43})
        self.assertEqual(malformed.status_code, 422)
        self.assertEqual(malformed.json()["detail"]["code"], "invalid_device_request")

    def test_refresh_proof_expiry_and_rename_are_bound_to_server_values(self):
        self.prepare(); key,identity=self.identity(); grant=self.enroll(key,identity,self.start(identity))
        body=self.refresh_body(key,identity,grant)
        with patch("modern_app.cloud_backend.app.device_sessions.now",return_value=datetime.now(timezone.utc)+timedelta(seconds=121)):
            self.assertEqual(self.post("/refresh/complete",body).status_code,401)
        c=self.post("/management/challenge",{"deviceId":identity["deviceId"],"familyId":grant["familyId"],"targetDeviceId":identity["deviceId"],"purpose":"device_rename","name":" Mi equipo "},grant["access_token"]).json()
        proof=self.sign(key,identity,c,4)
        self.assertEqual(self.post("/management/complete",{"challenge":c,"proof":proof,"name":"Otro nombre"},grant["access_token"]).status_code,401)
        r=self.post("/management/complete",{"challenge":c,"proof":proof,"name":"Mi equipo"},grant["access_token"])
        self.assertEqual(r.status_code,200,r.text)
        listed=self.client.get("/auth/devices",headers=self.headers(grant["access_token"])).json()["devices"]
        self.assertEqual(listed[0]["device_name"],"Mi equipo")

    def test_mail_failure_cannot_authorize_or_leave_a_usable_challenge(self):
        self.prepare(); _,identity=self.identity()
        with patch.object(main,"_email_provider",side_effect=RuntimeError("secret-provider-error")):
            response=self.post("/login",{"identity":identity,"platform":"android","name":"Test"})
        self.assertEqual(response.status_code,503)
        self.assertNotIn("secret-provider-error",response.text)
        with db.connect() as conn:
            self.assertIsNotNone(conn.execute("SELECT invalidated_at FROM device_verification_challenges").fetchone()["invalidated_at"])
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM refresh_token_families").fetchone()["n"],0)

    def test_account_wide_email_limit_survives_new_device_ids(self):
        self.prepare()
        for _ in range(5):
            _,identity=self.identity(); self.start(identity)
            with db.connect() as conn:
                conn.execute("UPDATE device_verification_challenges SET last_sent_at = ?",((datetime.now(timezone.utc)-timedelta(seconds=61)).isoformat(),))
        _,identity=self.identity()
        response=self.post("/login",{"identity":identity,"platform":"windows","name":"Test"})
        self.assertEqual(response.status_code,429)
        self.assertEqual(response.json()["detail"]["code"],"device_email_rate_limit")

    def test_cross_account_refresh_family_and_device_key_alias_are_rejected(self):
        self.prepare(); key,identity=self.identity(); grant=self.enroll(key,identity,self.start(identity))
        aliased={**identity,"deviceId":str(uuid4())}
        self.assertEqual(self.post("/login",{"identity":aliased,"platform":"windows","name":"Alias"}).status_code,409)
        self.insert_user(user_id="another-internal-owner",email="other@example.com",provider_id=fixtures.OTHER_SUB)
        db.init_db()
        self.get.return_value=httpx.Response(200,json=fixtures.provider_user(id=fixtures.OTHER_SUB,email="other@example.com"))
        response=self.post("/refresh/challenge",{"deviceId":identity["deviceId"],"familyId":grant["familyId"]})
        self.assertEqual(response.status_code,401)


if __name__ == "__main__": unittest.main()
