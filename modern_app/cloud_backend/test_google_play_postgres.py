"""Reuses only the guarded local ephemeral cluster, each case in its own schema."""
import unittest,os
from unittest.mock import patch
from modern_app.cloud_backend import test_account_deletion_postgres as pg, test_google_play_billing as cases
from modern_app.cloud_backend.app import db,google_play_billing as play,google_play_api as api

class PlayPostgresTests(unittest.TestCase):
 setUp=pg.PostgreSQLDeletionTests.setUp
 insert_user=cases.PlayBillingTests.insert_user
 def test_additive_columns_binding_and_generation_are_idempotent(self):
  self.insert_user();db.init_db();db.init_db()
  with patch.dict(os.environ,cases.PLAY_ENV),patch.object(api,'get_purchase',return_value=cases.purchase()):
   with db.connect() as c:play.register_binding(c,cases.OWNER,api.binding(cases.OWNER))
   play.reconcile_google_play_subscription('purchase-pg',user_id=cases.OWNER,event_ms=200)
   self.assertEqual(play.reconcile_google_play_subscription('purchase-pg',event_ms=100)['status'],'old_notification')
   with db.connect() as c:
    self.assertEqual(c.execute("SELECT COUNT(*) n FROM billing_subscriptions WHERE provider='google_play'").fetchone()['n'],1)
    self.assertEqual(c.execute('SELECT plan FROM users WHERE id=?',(cases.OWNER,)).fetchone()['plan'],'premium')
 def test_google_purchase_is_preserved_only_in_archive_on_account_delete(self):
  self.setup_account()
  with patch.dict(os.environ,cases.PLAY_ENV),patch.object(api,'get_purchase',return_value=cases.purchase()):
   play.reconcile_google_play_subscription('purchase-pg-close',user_id=cases.OWNER)
   response=self.complete(self.request_deletion());self.assertEqual(response.status_code,200,response.text)
   self.assertEqual(play.reconcile_google_play_subscription('purchase-pg-close',event_ms=200)['status'],'account_deleted')
   with db.connect() as c:
    self.assertEqual(c.execute('SELECT COUNT(*) n FROM users').fetchone()['n'],0)
    self.assertIsNone(c.execute('SELECT user_id FROM google_play_account_bindings').fetchone()['user_id'])
 def test_invalid_first_claim_cannot_interrupt_owner_validation(self):
  self.insert_user()
  def entitled():
   with db.connect() as c:return {'plan':c.execute('SELECT plan FROM users WHERE id=?',(cases.OWNER,)).fetchone()['plan']}
  self.entitled=entitled
  with patch.dict(os.environ,cases.PLAY_ENV),patch.object(api,'get_purchase') as remote:
   self.get_play=remote
   cases.PlayBillingTests.test_invalid_first_claim_does_not_supersede_the_real_owner_inflight(self)
 def test_open_index_migration_preserves_rows_and_mp_constraint(self):
  self.insert_user()
  cases.PlayBillingTests.test_legacy_open_index_is_replaced_without_data_loss_or_weakening_mp(self)

for helper in ('prepare','get_context','headers','post','identity','start','sign','enrollment_body','enroll','refresh_body','setup_account','request_deletion','complete'):
 setattr(PlayPostgresTests,helper,getattr(cases.PlayDeletionTests,helper))

if __name__=='__main__':unittest.main()
