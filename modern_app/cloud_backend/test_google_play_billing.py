"""Strict provider mocks; every mutation uses a new temporary SQLite database."""
import base64,copy,json,os,unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta,timezone
from threading import Event
from unittest.mock import patch,MagicMock
import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from modern_app.cloud_backend import test_supabase_auth as f
from modern_app.cloud_backend.app import db,google_play_api as api,google_play_billing as play,billing_entitlements as effective,security
from modern_app.cloud_backend.app.auth import create_access_token

OWNER=f.INTERNAL_ID
PACKAGE='com.scisoftware.scisonomics'
PRODUCT='scisonomics_premium_monthly'
PLAY_ENV={'SCISONOMICS_GOOGLE_PLAY_BINDING_SECRET':'isolated-test-binding-secret-32-bytes-only',
 'SCISONOMICS_GOOGLE_PLAY_TOKEN_ENCRYPTION_KEY':base64.urlsafe_b64encode(bytes(range(32))).decode(),
 'SCISONOMICS_GOOGLE_PLAY_PACKAGE_NAME':PACKAGE,'SCISONOMICS_GOOGLE_PLAY_PRODUCT_IDS':PRODUCT,
 'SCISONOMICS_GOOGLE_PLAY_BASE_PLAN_IDS':'monthly'}

def purchase(state='ACTIVE',owner=OWNER,days=30,ack=True):
 return {'subscriptionState':'SUBSCRIPTION_STATE_'+state,'acknowledgementState':'ACKNOWLEDGEMENT_STATE_'+('ACKNOWLEDGED' if ack else 'PENDING'),
  'externalAccountIdentifiers':{'obfuscatedExternalAccountId':api.binding(owner)},
  'lineItems':[{'productId':PRODUCT,'expiryTime':(datetime.now(timezone.utc)+timedelta(days=days)).isoformat(),
   'offerDetails':{'basePlanId':'monthly'},'autoRenewingPlan':{'autoRenewEnabled':state!='CANCELED'},'latestSuccessfulOrderId':'GPA.test-order'}]}

class PlayBillingTests(unittest.TestCase):
 insert_user=f.DualAuthTests.insert_user
 def setUp(self):
  f.DualAuthTests.setUp(self);self.insert_user();security._ATTEMPTS.clear()
  env=patch.dict(os.environ,{**PLAY_ENV,'SCISONOMICS_ENTITLEMENTS_PRIVATE_KEY':rsa.generate_private_key(public_exponent=65537,key_size=2048).private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()})
  env.start();self.addCleanup(env.stop)
  self.provider=purchase()
  def get(package,token):
   self.assertEqual(package,PACKAGE);self.assertTrue(token.startswith('purchase-'));return copy.deepcopy(self.provider)
  mocked=patch.object(api,'get_purchase',side_effect=get);self.get_play=mocked.start();self.addCleanup(mocked.stop)
  mocked=patch.object(api,'acknowledge');self.ack=mocked.start();self.addCleanup(mocked.stop)
 def auth(self,owner=OWNER):return {'Authorization':'Bearer '+create_access_token(owner)}
 def validate(self,token='purchase-test',owner=OWNER,**extra):
  return self.client.post('/billing/google-play/validate',json={'purchaseToken':token,'packageName':PACKAGE,'productId':PRODUCT,**extra},headers=self.auth(owner))
 def entitled(self):return self.client.get('/billing/entitlements',headers=self.auth()).json()
 def test_valid_purchase_encrypted_and_internal_entitlement_is_signed(self):
  self.assertEqual(self.validate().status_code,200);value=self.entitled();self.assertEqual(value['plan'],'premium');self.assertTrue(all(value['features'].values()))
  self.assertEqual(value['user_id'],OWNER);self.assertIn('entitlement_token',value)
  with db.connect() as c:
   row=dict(c.execute("SELECT * FROM billing_subscriptions WHERE provider='google_play'").fetchone())
   self.assertNotIn('purchase-test',row['purchase_token_ciphertext']);self.assertEqual(api.decrypt_token(row),'purchase-test')
   self.assertEqual(row['user_id'],OWNER)
  self.ack.assert_not_called()
 def test_legacy_open_index_is_replaced_without_data_loss_or_weakening_mp(self):
  def insert(key,provider):
   with db.connect() as c:c.execute("INSERT INTO billing_subscriptions(id,user_id,provider,status,external_reference,created_at,updated_at) VALUES(?, ?, ?, 'paused', ?, ?, ?)",(key,OWNER,provider,key,f.STAMP,f.STAMP))
  insert('legacy-paused','google_play')
  with db.connect() as c:c.execute("CREATE UNIQUE INDEX idx_billing_one_open_per_user ON billing_subscriptions(user_id,provider) WHERE status IN ('creating','uncertain','pending','authorized','paused')")
  db.init_db();db.init_db();insert('second-paused','google_play')
  with db.connect() as c:self.assertEqual(c.execute("SELECT COUNT(*) n FROM billing_subscriptions WHERE provider='google_play'").fetchone()['n'],2)
  insert('first-mp','mercadopago')
  with self.assertRaises(Exception):insert('second-mp','mercadopago')
 def test_no_auth_and_client_entitlement_fields_are_rejected_without_echo(self):
  self.assertEqual(self.client.post('/billing/google-play/validate',json={'purchaseToken':'secret-token','productId':PRODUCT,'packageName':PACKAGE}).status_code,401)
  response=self.validate(premium=True,user_id='other',expiry='2099-01-01',price=0)
  self.assertEqual(response.status_code,422);self.assertNotIn('purchase-test',response.text);self.get_play.assert_not_called()
 def test_package_product_and_binding_are_not_client_authoritative(self):
  for override in ({'packageName':'com.attacker.app'},{'productId':'arbitrary_product'}):self.assertEqual(self.validate(**override).status_code,422)
  self.get_play.assert_not_called();self.provider['externalAccountIdentifiers']['obfuscatedExternalAccountId']='0'*64
  self.assertEqual(self.validate().status_code,409);self.assertEqual(self.entitled()['plan'],'free')
 def test_purchase_cannot_be_claimed_by_another_user(self):
  self.validate();self.insert_user(user_id='other',email='other@example.test')
  self.assertEqual(self.validate(owner='other').status_code,409)
  with db.connect() as c:self.assertEqual(c.execute("SELECT COUNT(*) n FROM billing_subscriptions WHERE provider='google_play'").fetchone()['n'],1)
 def test_invalid_first_claim_does_not_supersede_the_real_owner_inflight(self):
  self.insert_user(user_id='other',email='other@example.test');started,release=Event(),Event()
  def get(package,token):
   if not started.is_set():started.set();release.wait(10)
   return purchase()
  self.get_play.side_effect=get
  with ThreadPoolExecutor(max_workers=2) as pool:
   valid=pool.submit(play.reconcile_google_play_subscription,'purchase-first-race',user_id=OWNER)
   self.assertTrue(started.wait(5))
   try:
    with self.assertRaises(api.PlayError) as raised:play.reconcile_google_play_subscription('purchase-first-race',user_id='other')
    self.assertEqual(raised.exception.code,'google_play_purchase_not_owned')
   finally:release.set()
   self.assertEqual(valid.result(timeout=10)['status'],'active')
  self.assertEqual(self.entitled()['plan'],'premium')
 def test_idempotent_restore_never_adds_time_or_rows(self):
  first=self.validate().json();second=self.validate().json();self.assertEqual(first,second)
  with db.connect() as c:self.assertEqual(c.execute("SELECT COUNT(*) n FROM billing_subscriptions WHERE provider='google_play'").fetchone()['n'],1)
 def test_all_play_states_follow_provider_period_and_state(self):
  cases=[('ACTIVE',30,True),('CANCELED',30,True),('CANCELED',-1,False),('EXPIRED',30,False),('IN_GRACE_PERIOD',2,True),('ON_HOLD',30,False),('PAUSED',30,False),('PENDING',30,False),('PENDING_PURCHASE_CANCELED',30,False)]
  for state,days,expected in cases:
   with self.subTest(state=state,days=days):
    self.provider=purchase(state,days=days);self.assertEqual(self.validate().status_code,200)
    self.assertEqual(self.entitled()['plan']=='premium',expected)
 def test_canceled_period_stays_valid_when_google_omits_false_renewal_flag(self):
  self.provider=purchase('CANCELED');self.provider['lineItems'][0]['autoRenewingPlan']={}
  response=self.validate();self.assertEqual(response.status_code,200);self.assertFalse(response.json()['autoRenew'])
  self.assertEqual(self.entitled()['plan'],'premium')
 def test_acknowledgement_only_after_validated_evidence_and_before_new_access(self):
  self.provider=purchase(ack=False)
  def acknowledge(package,product,token):
   with db.connect() as c:
    self.assertEqual(c.execute('SELECT plan FROM users WHERE id=?',(OWNER,)).fetchone()['plan'],'free')
    self.assertEqual(c.execute("SELECT acknowledged FROM billing_subscriptions WHERE provider='google_play'").fetchone()['acknowledged'],0)
   self.provider['acknowledgementState']='ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
  self.ack.side_effect=acknowledge
  self.assertEqual(self.validate().status_code,200);self.assertEqual(self.entitled()['plan'],'premium');self.ack.assert_called_once()
 def test_ack_timeout_does_not_grant_and_restore_recovers(self):
  self.provider=purchase(ack=False);self.ack.side_effect=api.PlayError('google_play_provider_unavailable')
  self.assertEqual(self.validate().status_code,503);self.assertEqual(self.entitled()['plan'],'free')
  self.provider['acknowledgementState']='ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
  self.assertEqual(self.validate().status_code,200);self.assertEqual(self.entitled()['plan'],'premium')
 def test_refund_during_ack_does_not_grant(self):
  self.provider=purchase(ack=False)
  self.ack.side_effect=lambda *args:self.provider.update(purchase('EXPIRED',ack=True))
  self.assertEqual(self.validate().status_code,200);self.assertEqual(self.entitled()['plan'],'free')
 def test_out_of_app_resubscription_retains_verified_binding_after_ack(self):
  self.provider=purchase('EXPIRED',days=-1);self.validate('purchase-expired')
  self.provider=purchase(ack=False);identity=self.provider.pop('externalAccountIdentifiers')
  self.provider['outOfAppPurchaseContext']={'expiredExternalAccountIdentifiers':identity,'expiredPurchaseToken':'purchase-expired'}
  def acknowledge(package,product,token,**kwargs):
   self.assertEqual(kwargs['obfuscated_account_id'],api.binding(OWNER))
   self.provider.pop('outOfAppPurchaseContext');self.provider['acknowledgementState']='ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
  self.ack.side_effect=acknowledge
  self.assertEqual(self.validate('purchase-resub').status_code,200);self.assertEqual(self.entitled()['plan'],'premium')
  self.assertEqual(self.validate('purchase-resub').status_code,200);self.ack.assert_called_once()
  self.insert_user(user_id='other',email='other@example.test');self.assertEqual(self.validate('purchase-resub',owner='other').status_code,409)
  self.provider['externalAccountIdentifiers']={'obfuscatedExternalAccountId':'0'*64}
  self.assertEqual(self.validate('purchase-resub').status_code,409)
 def test_unknown_purchase_without_google_identity_is_never_claimed(self):
  self.provider.pop('externalAccountIdentifiers');self.assertEqual(self.validate().status_code,409);self.ack.assert_not_called()
  with db.connect() as c:self.assertEqual(c.execute("SELECT COUNT(*) n FROM billing_subscriptions WHERE provider='google_play'").fetchone()['n'],0)
 def test_provider_timeout_and_malformed_response_fail_closed(self):
  for response in (None,[],{'subscriptionState':'future_state'},{**purchase(),'acknowledgementState':'unknown'}):
   self.get_play.side_effect=None;self.get_play.return_value=response
   self.assertEqual(self.validate().status_code,502);self.assertEqual(self.entitled()['plan'],'free')
  self.get_play.side_effect=api.PlayError('google_play_provider_unavailable')
  self.assertEqual(self.validate().status_code,503);self.assertEqual(self.entitled()['plan'],'free')
 def test_multi_provider_max_and_revoke_preserves_mp(self):
  expiry=(datetime.now(timezone.utc)+timedelta(days=20)).isoformat()
  with db.connect() as c:c.execute("INSERT INTO billing_subscriptions(id,user_id,provider,status,external_reference,paid_until,created_at,updated_at) VALUES('mp',?,'mercadopago','authorized','mp-ref',?,?,?)",(OWNER,expiry,f.STAMP,f.STAMP))
  self.validate();self.assertGreater(self.entitled()['expires_at'],expiry)
  self.provider=purchase('EXPIRED');self.validate();result=self.entitled()
  self.assertEqual(result['plan'],'premium');self.assertEqual(result['expires_at'],expiry)
  with db.connect() as c:self.assertEqual(c.execute('SELECT billing_source FROM users WHERE id=?',(OWNER,)).fetchone()['billing_source'],'mercadopago')
 def test_manual_historical_premium_is_preserved(self):
  with db.connect() as c:c.execute("UPDATE users SET plan='premium',subscription_status='active',subscription_expires_at='2030-01-01T00:00:00Z',billing_source=NULL WHERE id=?",(OWNER,))
  db.init_db();self.validate();self.assertEqual(self.entitled()['expires_at'],'2030-01-01T00:00:00Z')
 def test_old_notification_and_late_http_response_do_not_overwrite(self):
  self.assertEqual(play.reconcile_google_play_subscription('purchase-test',user_id=OWNER,event_ms=200)['status'],'active')
  self.provider=purchase('EXPIRED');self.assertEqual(play.reconcile_google_play_subscription('purchase-test',event_ms=100)['status'],'old_notification')
  self.assertEqual(self.entitled()['plan'],'premium')
  started,release=Event(),Event()
  def get(package,token):
   if not started.is_set():started.set();release.wait(10);return purchase('ACTIVE')
   return purchase('EXPIRED')
  self.get_play.side_effect=get
  with ThreadPoolExecutor(max_workers=2) as pool:
   old=pool.submit(play.reconcile_google_play_subscription,'purchase-test',user_id=OWNER);self.assertTrue(started.wait(5))
   newer=pool.submit(play.reconcile_google_play_subscription,'purchase-test',user_id=OWNER);newer.result(timeout=10);release.set();self.assertEqual(old.result(timeout=10)['status'],'superseded_response')
  self.assertEqual(self.entitled()['plan'],'free')
 def test_linked_purchase_ownership_and_replacement_are_checked(self):
  self.validate('purchase-old');self.provider['linkedPurchaseToken']='purchase-old'
  self.assertEqual(self.validate('purchase-new').status_code,200)
  with db.connect() as c:self.assertEqual(c.execute("SELECT superseded FROM billing_subscriptions WHERE purchase_token_hash=?",(api.token_hash('purchase-old'),)).fetchone()['superseded'],1)
 def test_rtdn_authenticated_notification_queries_google_not_payload(self):
  self.validate();self.provider=purchase('EXPIRED')
  data={'packageName':PACKAGE,'eventTimeMillis':'100','subscriptionNotification':{'notificationType':13,'purchaseToken':'purchase-test'}}
  envelope={'subscription':'projects/test/subscriptions/billing','message':{'messageId':'test-id','data':base64.b64encode(json.dumps(data).encode()).decode()}}
  with patch.object(api,'verify_push',return_value=envelope['subscription']):
   response=self.client.post('/billing/google-play/rtdn',json=envelope,headers={'Authorization':'Bearer test-oidc'})
  self.assertEqual(response.status_code,200);self.assertEqual(self.entitled()['plan'],'free')
  with db.connect() as c:self.assertEqual(c.execute("SELECT status FROM billing_subscriptions WHERE provider='google_play'").fetchone()['status'],'revoked')
 def test_notification_before_client_validation_uses_registered_server_binding(self):
  with db.connect() as c:play.register_binding(c,OWNER,api.binding(OWNER))
  self.assertEqual(play.reconcile_google_play_subscription('purchase-first-rtdn',event_ms=200)['status'],'active')
  self.assertEqual(self.entitled()['plan'],'premium')
 def test_older_notification_cannot_supersede_an_inflight_newer_event(self):
  self.validate();started,release=Event(),Event()
  def get(package,token):started.set();release.wait(10);return purchase('EXPIRED')
  self.get_play.side_effect=get
  with ThreadPoolExecutor(max_workers=2) as pool:
   newer=pool.submit(play.reconcile_google_play_subscription,'purchase-test',event_ms=200)
   self.assertTrue(started.wait(5));self.assertEqual(play.reconcile_google_play_subscription('purchase-test',event_ms=100)['status'],'old_notification')
   release.set();newer.result(timeout=10)
  self.assertEqual(self.entitled()['plan'],'free')

class PlayTransportTests(unittest.TestCase):
 def test_resubscription_ack_uses_official_obfuscated_account_body(self):
  identity='a'*64
  with patch.object(api,'credentials',return_value=MagicMock()),patch.object(api.httpx,'request',return_value=httpx.Response(204)) as remote:
   api.acknowledge(PACKAGE,PRODUCT,'purchase-resub',obfuscated_account_id=identity)
   self.assertEqual(remote.call_args.kwargs['json'],{'externalAccountIds':{'obfuscatedAccountId':identity}})
   self.assertNotIn(OWNER,json.dumps(remote.call_args.kwargs['json']))
 def test_safe_provider_errors_and_https_scoped_requests(self):
  credential=MagicMock()
  with patch.object(api,'credentials',return_value=credential),patch.object(api.httpx,'request') as remote:
   for status in (400,401,403,404,429,500,503):
    remote.return_value=httpx.Response(status,json={'purchaseToken':'sensitive-never-echo'})
    with self.assertRaises(api.PlayError) as raised:api.get_purchase(PACKAGE,'purchase-test')
    self.assertNotIn('sensitive',str(raised.exception));self.assertFalse(remote.call_args.kwargs['follow_redirects'])
    self.assertTrue(remote.call_args.args[1].startswith(api.PUBLISHER+PACKAGE+'/'))
   remote.side_effect=httpx.ReadTimeout('sensitive-never-echo')
   with self.assertRaises(api.PlayError) as raised:api.get_purchase(PACKAGE,'purchase-test')
   self.assertEqual(raised.exception.code,'google_play_provider_unavailable')
 def test_google_push_exact_audience_and_service_identity(self):
  env={'SCISONOMICS_GOOGLE_PLAY_RTDN_AUDIENCE':'https://example.test/billing/google-play/rtdn','SCISONOMICS_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL':'push@project.iam.gserviceaccount.com','SCISONOMICS_GOOGLE_PLAY_RTDN_SUBSCRIPTION':'projects/test/subscriptions/billing'}
  with patch.dict(os.environ,env),patch.object(api.id_token,'verify_oauth2_token',return_value={'email':env['SCISONOMICS_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL'],'email_verified':True}) as verify:
   self.assertEqual(api.verify_push('Bearer private-test-token'),env['SCISONOMICS_GOOGLE_PLAY_RTDN_SUBSCRIPTION'])
   self.assertEqual(verify.call_args.kwargs['audience'],env['SCISONOMICS_GOOGLE_PLAY_RTDN_AUDIENCE'])
   verify.return_value={'email':'other@project.iam.gserviceaccount.com','email_verified':True}
   with self.assertRaises(api.PlayError):api.verify_push('Bearer private-test-token')
 def test_unconfigured_credentials_and_untrusted_oauth_url_fail_closed(self):
  with patch.dict(os.environ,{'SCISONOMICS_GOOGLE_PLAY_SERVICE_ACCOUNT_FILE':''}):
   with self.assertRaises(api.PlayError):api.credentials()
  with patch.object(api.httpx,'request') as remote:
   with self.assertRaises(api.PlayError):api.Transport()('https://attacker.test/token')
   remote.assert_not_called()

from modern_app.cloud_backend import test_account_deletion as deletion_fixture

class PlayDeletionTests(unittest.TestCase):
 def test_delete_during_system_reconcile_updates_archive_and_completes_notification(self):
  self.setup_account()
  with patch.dict(os.environ,PLAY_ENV),patch.object(api,'get_purchase',return_value=purchase()):
   play.reconcile_google_play_subscription('purchase-delete-race',user_id=OWNER)
   intent=self.request_deletion();started,release=Event(),Event()
   def provider(*args):started.set();release.wait(10);return purchase('EXPIRED')
   with patch.object(api,'get_purchase',side_effect=provider),ThreadPoolExecutor(max_workers=1) as pool:
    reconciliation=pool.submit(play.reconcile_google_play_subscription,'purchase-delete-race',event_ms=200)
    self.assertTrue(started.wait(5))
    try:self.assertEqual(self.complete(intent).status_code,200)
    finally:release.set()
    self.assertEqual(reconciliation.result(timeout=10)['status'],'account_deleted')
   with db.connect() as c:
    self.assertEqual(c.execute('SELECT COUNT(*) n FROM users').fetchone()['n'],0)
    archived=json.loads(c.execute("SELECT commercial_record FROM retained_billing_subscriptions WHERE provider='google_play'").fetchone()['commercial_record'])
    self.assertEqual(archived['status'],'expired')
 def test_delete_archives_encrypted_purchase_and_later_reconcile_never_recreates_user(self):
  self.setup_account()
  with patch.dict(os.environ,PLAY_ENV),patch.object(api,'get_purchase',return_value=purchase()):
   play.reconcile_google_play_subscription('purchase-delete-test',user_id=OWNER)
   body=self.request_deletion();response=self.complete(body)
   self.assertEqual(response.status_code,200,response.text);self.assertTrue(response.json()['billing_retained'])
   with db.connect() as c:
    row=c.execute("SELECT commercial_record FROM retained_billing_subscriptions WHERE provider='google_play'").fetchone()
    self.assertNotIn('purchase-delete-test',row['commercial_record']);self.assertNotIn(OWNER,row['commercial_record'])
    self.assertEqual(c.execute('SELECT COUNT(*) n FROM users').fetchone()['n'],0)
   with patch.object(api,'get_purchase',return_value=purchase('EXPIRED')):
    self.assertEqual(play.reconcile_google_play_subscription('purchase-delete-test',event_ms=200)['status'],'account_deleted')
   with db.connect() as c:
    self.assertEqual(c.execute('SELECT COUNT(*) n FROM users').fetchone()['n'],0)
    self.assertEqual(json.loads(c.execute("SELECT commercial_record FROM retained_billing_subscriptions WHERE provider='google_play'").fetchone()['commercial_record'])['status'],'expired')
 def test_unclaimed_purchase_arriving_after_delete_is_archived_without_user(self):
  self.setup_account()
  with patch.dict(os.environ,PLAY_ENV),patch.object(api,'get_purchase',return_value=purchase()):
   with db.connect() as c:play.register_binding(c,OWNER,api.binding(OWNER))
   response=self.complete(self.request_deletion());self.assertEqual(response.status_code,200,response.text)
   self.assertEqual(play.reconcile_google_play_subscription('purchase-late-first',event_ms=100)['status'],'account_deleted')
   with db.connect() as c:
    self.assertEqual(c.execute('SELECT COUNT(*) n FROM users').fetchone()['n'],0)
    self.assertIsNone(c.execute('SELECT user_id FROM google_play_account_bindings').fetchone()['user_id'])
    self.assertEqual(c.execute("SELECT COUNT(*) n FROM retained_billing_subscriptions WHERE provider='google_play'").fetchone()['n'],1)

for helper in ('setUp','insert_user','prepare','get_context','headers','post','identity','start','sign','enrollment_body','enroll','refresh_body','setup_account','request_deletion','complete'):
 setattr(PlayDeletionTests,helper,getattr(deletion_fixture.AccountDeletionTests,helper))

if __name__=='__main__':unittest.main()
