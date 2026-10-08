"""Only a named loopback test cluster; never accepts the production DB env."""
import os
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, urlunsplit, urlencode
from uuid import uuid4
import httpx
import psycopg
from fastapi.testclient import TestClient

from modern_app.cloud_backend import test_account_deletion as cases, test_supabase_auth as f
from modern_app.cloud_backend.app import db, main, supabase_auth

URL_ENV='SCISONOMICS_ACCOUNT_DELETE_TEST_PG_URL'


@unittest.skipUnless(os.getenv(URL_ENV),'requires explicit isolated PostgreSQL URL')
class PostgreSQLDeletionTests(unittest.TestCase):
    insert_user=cases.AccountDeletionTests.insert_user
    prepare=cases.AccountDeletionTests.prepare
    get_context=cases.AccountDeletionTests.get_context
    headers=cases.AccountDeletionTests.headers
    post=cases.AccountDeletionTests.post
    identity=cases.AccountDeletionTests.identity
    start=cases.AccountDeletionTests.start
    sign=cases.AccountDeletionTests.sign
    enrollment_body=cases.AccountDeletionTests.enrollment_body
    enroll=cases.AccountDeletionTests.enroll
    setup_account=cases.AccountDeletionTests.setup_account
    request_deletion=cases.AccountDeletionTests.request_deletion
    complete=cases.AccountDeletionTests.complete

    def setUp(self):
        url=os.environ[URL_ENV];parsed=urlsplit(url)
        if parsed.hostname!='127.0.0.1' or parsed.port!=65432 or parsed.path!='/scisonomics_account_deletion_test' or parsed.query or parsed.fragment:
            raise RuntimeError('requires dedicated loopback M10A test database')
        with psycopg.connect(url,hostaddr='127.0.0.1') as conn:
            if conn.execute('SELECT current_database(),current_user,host(inet_server_addr())').fetchone()!=('scisonomics_account_deletion_test','scisonomics_m10a','127.0.0.1'):
                raise RuntimeError('test database identity mismatch')
            self.schema='m10a_'+uuid4().hex
            conn.execute(f'CREATE SCHEMA "{self.schema}"')
        def cleanup():
            with psycopg.connect(url) as conn:conn.execute(f'DROP SCHEMA "{self.schema}" CASCADE')
        self.addCleanup(cleanup)
        scoped=urlunsplit(parsed._replace(query=urlencode({'options':'-csearch_path='+self.schema})))
        env=patch.dict(os.environ,{**f.AUTH_ENV,'SCISONOMICS_CLOUD_DATABASE_URL':scoped,'SCISONOMICS_SUPABASE_SECRET_KEY':'','DATABASE_URL':''});env.start();self.addCleanup(env.stop)
        db.init_db();db.init_db()
        self.client=TestClient(main.app);self.addCleanup(self.client.close)
        remote=patch.object(supabase_auth.httpx,'get',return_value=httpx.Response(200,json=f.provider_user()));remote.start();self.addCleanup(remote.stop)

    def test_schema_idempotent_real_fk_delete_and_other_owner_preservation(self):
        self.setup_account();body=self.request_deletion();self.insert_user(user_id='other-user',email='other@example.test')
        with db.connect() as conn:
            conn.execute("INSERT INTO billing_subscriptions(id,user_id,provider,status,external_reference,created_at,updated_at) VALUES('bill',?,'mercadopago','authorized','synthetic-reference','2026-01-01','2026-01-01')",(f.INTERNAL_ID,))
            conn.execute("INSERT INTO cloud_categorias(user_id,sync_id,nombre,tipo,remote_updated_at) VALUES('other-user',?,'Otra','gasto',?)",(str(uuid4()),f.STAMP))
        response=self.complete(body);self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.complete(body).status_code,200)
        with db.connect() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) n FROM users').fetchone()['n'],1)
            self.assertEqual(conn.execute('SELECT COUNT(*) n FROM trusted_devices').fetchone()['n'],0)
            self.assertEqual(conn.execute('SELECT COUNT(*) n FROM retained_billing_subscriptions').fetchone()['n'],1)
            self.assertEqual(conn.execute("SELECT COUNT(*) n FROM cloud_categorias WHERE user_id='other-user'").fetchone()['n'],1)
        self.assertEqual(self.client.get('/sync/pull',headers=self.headers(self.token)).status_code,410)
        self.assertEqual(self.client.post('/auth/supabase/bootstrap',json={},headers=self.headers()).status_code,410)

    test_concurrent_completions_have_one_effect_and_reusable_receipt=cases.AccountDeletionTests.test_concurrent_completions_have_one_effect_and_reusable_receipt
    test_failing_db_rolls_back_account_data_proof_and_billing=cases.AccountDeletionTests.test_failing_db_rolls_back_account_data_proof_and_billing


if __name__=='__main__':unittest.main()
