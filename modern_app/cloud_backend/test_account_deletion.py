"""Destructive cases are isolated to a new temporary DB for every test."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from modern_app.cloud_backend import test_device_sessions as d, test_supabase_auth as f
from modern_app.cloud_backend.app import db, main, account_deletion as deletion, account_lifecycle
from modern_app.cloud_backend.app.auth import create_access_token
from modern_app.cloud_backend.app.device_verification import base64url_encode
from modern_app.cloud_backend.app.security import _ATTEMPTS


class AccountDeletionTests(unittest.TestCase):
    setUp = f.DualAuthTests.setUp
    insert_user = f.DualAuthTests.insert_user
    prepare = d.DeviceSessionsTests.prepare
    get_context = d.DeviceSessionsTests.get_context
    headers = d.DeviceSessionsTests.headers
    post = d.DeviceSessionsTests.post
    identity = d.DeviceSessionsTests.identity
    start = d.DeviceSessionsTests.start
    sign = d.DeviceSessionsTests.sign
    enrollment_body = d.DeviceSessionsTests.enrollment_body
    enroll = d.DeviceSessionsTests.enroll
    refresh_body = d.DeviceSessionsTests.refresh_body

    def setup_account(self):
        _ATTEMPTS.clear()
        env=patch.dict(os.environ,{"SCISONOMICS_SUPABASE_SECRET_KEY":""});env.start();self.addCleanup(env.stop)
        self.prepare()
        self.key,self.ident=self.identity()
        self.grant=self.enroll(self.key,self.ident,self.start(self.ident))
        self.token=self.grant['access_token']

    def request_deletion(self):
        response=self.client.post('/account/delete/request',json={},headers=self.headers(self.token))
        self.assertEqual(response.status_code,200,response.text)
        intent=response.json()
        self.code=main._DEV_EMAIL_OUTBOX[-1]['code']
        response=self.client.post('/account/delete/challenge',json={k:intent[k] for k in ('requestId','capability')},headers=self.headers(self.token))
        self.assertEqual(response.status_code,200,response.text)
        challenge=response.json()
        proof={**self.ident,'signature':''}
        value=deletion.devices.Challenge(**challenge)
        signature=deletion.devices.Signature(**{**proof,'signature':'A'*86})
        message=deletion.proof_message(deletion.base64url_decode(self.binding,expected_length=32),signature,value)
        proof['signature']=base64url_encode(self.key.sign(message))
        return {**{k:intent[k] for k in ('requestId','capability')},'confirmation':'ELIMINAR','code':self.code,'challenge':challenge,'proof':proof}

    def complete(self,body,token=None):
        return self.client.post('/account/delete/complete',json=body,headers=self.headers(token or self.token))

    def test_requires_auth_trusted_device_and_exact_confirmation_without_echoing_secrets(self):
        self.setup_account()
        for headers in ({},self.headers('test-supabase-token'),self.headers(create_access_token(f.INTERNAL_ID))):
            self.assertIn(self.client.post('/account/delete/request',json={},headers=headers).status_code,(401,403,410))
        body=self.request_deletion()
        for extra in ({'proof':None},{'user_id':'other-user'},{'confirmation':'si'}):
            response=self.complete({**body,**extra});self.assertEqual(response.status_code,422)
            self.assertNotIn(self.code,response.text);self.assertNotIn(body['proof']['signature'],response.text)
        with db.connect() as conn:conn.execute("UPDATE trusted_devices SET status='revoked'")
        self.assertEqual(self.complete(body).status_code,401)

    def test_expiry_wrong_signature_cross_purpose_and_wrong_otp(self):
        self.setup_account();body=self.request_deletion()
        response=self.complete({**body,'proof':{**body['proof'],'signature':'A'*86}})
        self.assertEqual(response.status_code,401)
        # The frozen V1 signature cannot authorize the deletion domain.
        old={**body['challenge'],'targetDeviceId':self.ident['deviceId'],'requestHash':None}
        proof=self.sign(self.key,self.ident,old,5)
        self.assertEqual(self.complete({**body,'proof':proof}).status_code,401)
        wrong='000000' if self.code!='000000' else '000001'
        for _ in range(5):self.assertEqual(self.complete({**body,'code':wrong}).status_code,400)
        self.assertEqual(self.complete(body).status_code,429)
        with db.connect() as conn:conn.execute('UPDATE account_deletion_requests SET expires_at=0')
        self.assertEqual(self.complete(body).json()['detail']['code'],'deletion_proof_expired')

    def test_atomic_delete_receipt_revocation_barrier_and_other_users_untouched(self):
        self.setup_account();body=self.request_deletion()
        self.insert_user(user_id='other-user',email='other@example.test',provider_id=f.OTHER_SUB)
        with db.connect() as conn:
            conn.execute("INSERT INTO cloud_categorias(user_id,sync_id,nombre,tipo,remote_updated_at) VALUES(?,?,'Propia','gasto',?)",(f.INTERNAL_ID,str(uuid4()),f.STAMP))
            conn.execute("INSERT INTO cloud_categorias(user_id,sync_id,nombre,tipo,remote_updated_at) VALUES('other-user',?,'Otra','gasto',?)",(str(uuid4()),f.STAMP))
            before=dict(conn.execute("SELECT * FROM users WHERE id='other-user'").fetchone())
        response=self.complete(body);self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['external_auth_status'],'pending')
        self.assertEqual(self.complete(body).json(),response.json())
        self.assertEqual(self.complete({**body,'code':'123456' if self.code!='123456' else '654321'}).status_code,401)
        with db.connect() as conn:
            self.assertIsNone(conn.execute('SELECT 1 FROM users WHERE id=?',(f.INTERNAL_ID,)).fetchone())
            for table in (*db.SYNC_CLOUD_TABLES,'cloud_devices','trusted_devices','refresh_token_families','device_proof_challenges','device_verification_challenges','cloud_refresh_tokens','email_verification_codes'):
                self.assertEqual(conn.execute(f'SELECT COUNT(*) n FROM {table} WHERE user_id=?',(f.INTERNAL_ID,)).fetchone()['n'],0,table)
            self.assertEqual(dict(conn.execute("SELECT * FROM users WHERE id='other-user'").fetchone()),before)
            self.assertEqual(conn.execute("SELECT COUNT(*) n FROM cloud_categorias WHERE user_id='other-user'").fetchone()['n'],1)
            self.assertEqual(conn.execute('PRAGMA foreign_key_check').fetchall(),[])
            row=conn.execute('SELECT * FROM account_deletion_requests WHERE id=?',(body['requestId'],)).fetchone()
            for field in ('user_id','public_key','account_binding','nonce_hash','otp_hash','request_hash'):self.assertIsNone(row[field])
            self.assertEqual(conn.execute('SELECT COUNT(*) n FROM security_audit_log WHERE actor_id=? OR target_id=?',(f.INTERNAL_ID,f.INTERNAL_ID)).fetchone()['n'],0)
        for path in ('/auth/me','/sync/pull','/auth/devices'):
            self.assertEqual(self.client.get(path,headers=self.headers(self.token)).status_code,410,path)
        self.assertEqual(self.post('/refresh/challenge',{'deviceId':self.ident['deviceId'],'familyId':self.grant['familyId']}).status_code,410)
        self.assertEqual(self.client.post('/auth/supabase/bootstrap',json={},headers=self.headers()).status_code,410)

    def test_failing_db_rolls_back_account_data_proof_and_billing(self):
        self.setup_account();body=self.request_deletion()
        original=deletion.close_internal
        def fail(conn,*args):
            original(conn,*args)
            raise RuntimeError('synthetic failure')
        with patch.object(deletion,'close_internal',side_effect=fail):
            with self.assertRaises(RuntimeError):self.complete(body)
        with db.connect() as conn:
            self.assertIsNotNone(conn.execute('SELECT 1 FROM users WHERE id=?',(f.INTERNAL_ID,)).fetchone())
            self.assertIsNone(conn.execute('SELECT completed_at FROM account_deletion_requests').fetchone()['completed_at'])
            self.assertEqual(conn.execute('SELECT COUNT(*) n FROM cloud_movimientos').fetchone()['n'],1)
        self.assertEqual(self.complete(body).status_code,200)

    def test_billing_archive_and_security_minimization_never_cancel_provider(self):
        self.setup_account();body=self.request_deletion()
        with db.connect() as conn:
            conn.execute("INSERT INTO billing_subscriptions(id,user_id,provider,provider_subscription_id,status,amount,currency,external_reference,created_at,updated_at) VALUES('sub-test',?,'mercadopago','provider-test','authorized','100','ARS',?,'2026-01-01','2026-01-01')",(f.INTERNAL_ID,'scisonomics:'+f.INTERNAL_ID+':sub-test'))
            conn.execute("INSERT INTO security_audit_log(event_type,actor_id,target_id,outcome,source_ip,details,created_at) VALUES('test',?,?,'success','127.0.0.1',?,'2026-01-01')",(f.INTERNAL_ID,f.INTERNAL_ID,json.dumps({'email':'legacy@example.com','user_id':f.INTERNAL_ID,'provider':'supabase'})))
        with patch.object(main.mp_billing,'request',side_effect=AssertionError('No remote billing mutation')):
            response=self.complete(body);self.assertEqual(response.status_code,200,response.text)
        with db.connect() as conn:
            archive=conn.execute('SELECT * FROM retained_billing_subscriptions').fetchone()
            self.assertNotIn(f.INTERNAL_ID,archive['commercial_record']);self.assertNotIn('checkout_url',archive['commercial_record'])
            self.assertEqual(conn.execute('SELECT COUNT(*) n FROM billing_subscriptions').fetchone()['n'],0)
            entry=conn.execute("SELECT * FROM security_audit_log WHERE event_type='test'").fetchone()
            self.assertIsNone(entry['source_ip']);self.assertEqual(json.loads(entry['details']),{'provider':'supabase'})
            main._security_audit(conn,'test.after_close',outcome='success',actor_id=f.INTERNAL_ID,
                source_ip='127.0.0.1',details={'email':'legacy@example.com','family_id':'fixture','status':'account_deleted'})
            late=conn.execute("SELECT * FROM security_audit_log WHERE event_type='test.after_close'").fetchone()
            self.assertEqual(late['actor_id'],'deleted:'+body['requestId'])
            self.assertIsNone(late['source_ip'])
            self.assertEqual(json.loads(late['details']),{'status':'account_deleted'})
            with patch.object(main.mp_billing,'get_subscription',return_value={'id':'provider-test','external_reference':'scisonomics:'+f.INTERNAL_ID+':sub-test'}):
                self.assertEqual(main.subscriptions.reconcile_subscription(conn,provider_id='provider-test',now='2026-01-01')['status'],'account_deleted')

    def test_supabase_outbox_success_failure_timeout_and_safe_retry(self):
        for response in (httpx.Response(200,json={'id':f.SUB}),httpx.Response(503,json={'secret':'never expose'}),httpx.ReadTimeout('never expose')):
            with self.subTest(response=type(response).__name__):
                # Each subcase uses a separate complete request/DB fixture.
                self.setUp();self.setup_account();body=self.request_deletion()
                with patch.dict(os.environ,{'SCISONOMICS_SUPABASE_SECRET_KEY':'sb_secret_test_only'}),patch.object(deletion.httpx,'request') as remote:
                    if isinstance(response,Exception):remote.side_effect=response
                    else:remote.return_value=response
                    result=self.complete(body);self.assertEqual(result.status_code,200,result.text)
                    self.assertNotIn('secret',result.text);self.assertNotIn('never expose',result.text)
                    self.assertEqual(remote.call_args.kwargs['headers'],{'apikey':'sb_secret_test_only'})
                    self.assertFalse(remote.call_args.kwargs['follow_redirects'])
                    remote.side_effect=None;remote.return_value=httpx.Response(200,json={'id':f.SUB})
                    with db.connect() as conn:conn.execute('UPDATE account_deletion_requests SET external_attempt_at=0')
                    deletion.external_delete(body['requestId'])
                    with db.connect() as conn:
                        row=conn.execute('SELECT external_status,external_subject FROM account_deletion_requests').fetchone()
                        self.assertEqual(tuple(row),('deleted',None))

    def test_invalid_admin_configuration_leaves_recoverable_pending_outbox(self):
        self.setup_account();body=self.request_deletion()
        with patch.dict(os.environ,{'SCISONOMICS_SUPABASE_SECRET_KEY':'sb_secret_test_only',
                'SCISONOMICS_SUPABASE_URL':'https://example.test:invalid'}),patch.object(deletion.httpx,'request') as remote:
            response=self.complete(body)
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.json()['external_auth_status'],'pending')
            remote.assert_not_called()
        with db.connect() as conn:
            row=conn.execute('SELECT external_error,external_subject FROM account_deletion_requests').fetchone()
            self.assertEqual(row['external_error'],'invalid_config')
            self.assertEqual(row['external_subject'],f.SUB)

    def test_concurrent_completions_have_one_effect_and_reusable_receipt(self):
        self.setup_account();body=self.request_deletion()
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses=list(pool.map(lambda _:self.complete(body),range(2)))
        self.assertEqual([r.status_code for r in responses],[200,200])
        with db.connect() as conn:self.assertEqual(conn.execute("SELECT COUNT(*) n FROM security_audit_log WHERE event_type='account.deleted'").fetchone()['n'],1)

    def test_delete_vs_inflight_sync_never_leaves_orphans_or_recreates_data(self):
        self.setup_account();body=self.request_deletion()
        payload={table:[] for table in main.SYNC_TABLES}
        payload.update(device_id=self.ident['deviceId'],device_name='Test device')
        payload['categorias']=[{'sync_id':str(uuid4()),'nombre':'Concurrent fixture','tipo':'gasto','created_at':f.STAMP,'updated_at':f.STAMP}]
        with ThreadPoolExecutor(max_workers=2) as pool:
            close=pool.submit(self.complete,body)
            sync=pool.submit(lambda:self.client.post('/sync/push',json=payload,headers=self.headers(self.token)))
            self.assertEqual(close.result().status_code,200)
            self.assertIn(sync.result().status_code,(200,401,410))
        with db.connect() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) n FROM cloud_categorias').fetchone()['n'],0)
            self.assertEqual(conn.execute('SELECT COUNT(*) n FROM cloud_devices').fetchone()['n'],0)
            self.assertEqual(conn.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_same_account_other_trusted_device_cannot_use_the_intent(self):
        self.setup_account();body=self.request_deletion()
        with db.connect() as conn:conn.execute("UPDATE device_verification_challenges SET last_sent_at='2020-01-01T00:00:00+00:00'")
        key,identity=self.identity();other=self.enroll(key,identity,self.start(identity,'android'))
        response=self.complete(body,other['access_token']);self.assertEqual(response.status_code,401)
        self.assertEqual(response.json()['detail']['code'],'deletion_actor_mismatch')
        self.assertEqual(self.complete(body).status_code,200)
        self.assertEqual(self.client.get('/sync/pull',headers=self.headers(other['access_token'])).status_code,410)

    def test_expired_otp_and_request_rate_limit_are_explicit(self):
        self.setup_account();body=self.request_deletion()
        with db.connect() as conn:conn.execute('UPDATE account_deletion_requests SET otp_expires_at=0')
        self.assertEqual(self.complete(body).json()['detail']['code'],'deletion_otp_expired')
        response=self.client.post('/account/delete/request',json={},headers=self.headers(self.token))
        self.assertEqual(response.status_code,429)
        self.assertEqual(response.json()['detail']['code'],'deletion_resend_cooldown')


if __name__=='__main__':unittest.main()
