"""No staging/network calls. Fresh test keys, public vectors and isolated SQLite."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import loadtest as h
import secret_store as store


class HarnessTests(unittest.TestCase):
    def test_frozen_rust_python_vectors_use_identical_message_and_signature(self):
        fixture = json.loads((store.REPO / 'docs/device-verification/v1/fixtures/ed25519-proof-v1.json').read_text(encoding='utf-8'))
        common = fixture['common']
        private = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(fixture['test_key']['private_key_seed_hex']))
        public = {'formatVersion': 1, 'deviceId': str(UUID(bytes=bytes.fromhex(common['device_id_hex']))),
                  'publicKey': h.base64url_encode(bytes.fromhex(fixture['test_key']['public_key_hex'])),
                  'publicKeyHash': h.base64url_encode(bytes.fromhex(fixture['test_key']['public_key_hash_hex']))}
        for vector in fixture['vectors'][:3]:
            challenge = {'challengeId': str(UUID(bytes=bytes.fromhex(common['challenge_id_hex']))),
                         'nonce': h.base64url_encode(bytes.fromhex(common['nonce_hex'])),
                         'issuedAt': common['issued_at'], 'expiresAt': common['expires_at'],
                         'familyId': str(UUID(bytes=bytes.fromhex(common['family_id_hex']))) if vector['family_present'] else None,
                         'targetDeviceId': None, 'requestHash': None}
            with patch.object(h.time, 'time', return_value=common['issued_at']):
                proof = h.proof(private, public, h.base64url_encode(bytes.fromhex(common['account_binding_hex'])), challenge, vector['purpose'])
            self.assertEqual(h.base64url_decode(proof['signature'], expected_length=64).hex(), vector['signature_hex'])

    def test_config_refuses_production_and_admin_keys(self):
        cfg = {'kind': h.TYPE + ':config', 'BASE_URL': h.BASE, 'SUPABASE_URL': h.SUPABASE,
               'QA_EMAIL': 'qa@example.test', 'QA_PASSWORD': 'fake-only', 'QA_CONFIRMED': '1',
               'SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_test_only',
               'STATE_DIR': str(Path(tempfile.gettempdir()) / 'ScisoNomicsLoadTest-unit')}
        with patch.dict(os.environ, {}, clear=True), patch.object(h, 'read', return_value=cfg):
            self.assertEqual(h.load_config('fake-dpapi')['BASE_URL'], h.BASE)
            for field, value in [('BASE_URL', 'https://production.example.test'), ('SUPABASE_URL', 'https://another.supabase.co'),
                                 ('SUPABASE_PUBLISHABLE_KEY', 'sb_secret_never_allowed'), ('QA_CONFIRMED', '0'),
                                 ('STATE_DIR', str(store.REPO / 'ScisoNomicsLoadTest'))]:
                with self.subTest(field=field), patch.dict(cfg, {field: value}):
                    with self.assertRaises((h.SafeError, ValueError)):
                        h.load_config('fake-dpapi')

    def test_api_rejects_write_endpoints_and_redirect_without_echo(self):
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(302, headers={'Location': 'https://secret.example.test'}, json={'secret': 'do-not-echo'}))) as client:
            for path in ('/sync/push', '/account/delete/complete', '/billing/google-play/validate'):
                with self.assertRaises(h.SafeError):
                    h.api(client, path, 'private-token', {})
            for path in h.READS.values():
                with self.assertRaises(h.SafeError) as result:
                    h.api(client, path, 'private-token', {})
                self.assertEqual(str(result.exception), 'load_write_not_allowed')
            with self.assertRaises(h.SafeError) as result:
                h.api(client, '/sync/health', 'private-token')
            self.assertEqual(str(result.exception), 'setup_http_302')

    def test_metrics_percentiles_statuses_and_sustained_abort(self):
        samples = [('health', status, n, error, 'test', 1) for n, status, error in
                   [(100, 200, None), (200, 401, None), (300, 429, None), (400, 503, None), (500, 0, 'timeout')]]
        result = h.summarize(samples, 2)
        self.assertEqual(result['requests'], 5)
        self.assertEqual(result['rps'], 2.5)
        self.assertEqual(result['p50_ms'], 300)
        self.assertEqual(result['p95_ms'], 480)
        self.assertEqual(result['timeouts'], 1)
        self.assertEqual(result['rate_5xx'], .2)
        self.assertFalse(h.thresholds(result))
        metrics = h.Metrics()
        tick = time.monotonic()
        for _ in range(10):
            metrics.begin(); metrics.end('health', 200, 3500, None, 'warmup')
        self.assertIsNone(metrics.unsafe(tick))
        # Keep the rolling window populated while the slow condition persists.
        for offset in (5, 10):
            with patch.object(h.time, 'monotonic', return_value=tick + offset):
                metrics.begin(); metrics.end('health', 200, 3500, None, 'warmup')
            if offset == 10:
                # ten current samples required for p95; refill the current window.
                for _ in range(10):
                    with patch.object(h.time, 'monotonic', return_value=tick + offset):
                        metrics.begin(); metrics.end('health', 200, 3500, None, 'warmup')
                self.assertEqual(metrics.unsafe(tick + offset), 'p95_over_3s_sustained_10s')

    def test_closed_loop_profile_max_50_and_reports_never_contain_tokens(self):
        profile = tuple((name, vus, .12) for name, vus, _ in h.PROFILE)
        with contextlib.redirect_stdout(io.StringIO()):
            report = h.run_load({'grant': {'access_token': 'sensitive-token'}, 'cursor': 'private-cursor'},
                                requester=lambda endpoint: (200, None), profile=profile, think=.005)
        self.assertEqual(len(report['stages']), 5)
        self.assertLessEqual(report['peak_concurrent_requests'], 50)
        self.assertLessEqual(report['max_vus_reached'], 50)
        self.assertTrue(report['thresholds_passed'])
        self.assertNotIn('sensitive-token', json.dumps(report))
        self.assertNotIn('private-cursor', json.dumps(report))
        with self.assertRaises(h.SafeError):
            h.run_load({'grant': {}}, requester=lambda endpoint: (200, None), profile=(('bad', 51, .1),))

    def test_no_escalation_after_auth_throttle_timeout_or_5xx(self):
        for status, error in [(401, None), (403, None), (429, None), (503, None), (0, 'timeout')]:
            with self.subTest(status=status), contextlib.redirect_stdout(io.StringIO()):
                report = h.run_load({'grant': {'access_token': 'synthetic-token'}}, requester=lambda endpoint: (status, error),
                                    profile=(('warmup', 5, .25), ('next', 50, .1)), think=.01)
                self.assertFalse(report['thresholds_passed'])
                self.assertEqual(len(report['stages']), 1)
                self.assertLessEqual(report['max_vus_reached'], 5)

    def test_grant_binds_internal_owner_device_family_and_account_namespace(self):
        device, family = str(uuid4()), str(uuid4())
        def token(overrides):
            body = {'type': 'access', 'device_authorized': True, 'sub': 'internal-owner', 'device_id': device, 'family_id': family, **overrides}
            import base64
            return 'test.' + base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip('=') + '.synthetic-signature'
        grant = {'user': {'id': 'internal-owner'}, 'accountBinding': 'namespace', 'deviceId': device, 'familyId': family, 'access_token': token({})}
        h.validate_grant(grant, 'internal-owner', 'namespace', {'deviceId': device})
        for change in ({'sub': 'supabase-sub'}, {'device_id': str(uuid4())}, {'family_id': str(uuid4())}, {'device_authorized': False}):
            with self.subTest(change=change), patch.dict(grant, {'access_token': token(change)}):
                with self.assertRaises(h.SafeError):
                    h.validate_grant(grant, 'internal-owner', 'namespace', {'deviceId': device})

    @unittest.skipUnless(os.name == 'nt', 'CurrentUser DPAPI is Windows-only')
    def test_dpapi_roundtrip_keeps_private_material_out_of_files(self):
        with tempfile.TemporaryDirectory(prefix='ScisoNomicsLoadTest-test-') as folder:
            path = Path(folder) / 'private.dpapi'
            store.save(path, {'secret': 'not-plaintext-in-file'})
            self.assertNotIn(b'not-plaintext-in-file', path.read_bytes())
            self.assertEqual(store.read(path), {'secret': 'not-plaintext-in-file'})
            path.write_bytes(path.read_bytes()[:-5] + b'xxxxx')
            with self.assertRaises(ValueError):
                store.read(path)


class BackendContractTests(unittest.TestCase):
    def test_real_enrollment_replay_and_readonly_grant_in_isolated_backend(self):
        from modern_app.cloud_backend import test_supabase_auth as f
        from modern_app.cloud_backend.app import main
        fixture = f.DualAuthTests(unittest.TestLoader().getTestCaseNames(f.DualAuthTests)[0])
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.insert_user(provider_id=f.SUB)
        f.cloud_db.init_db()  # Same namespace backfill as the existing device suite.
        with patch.dict(os.environ, {'SCISONOMICS_DEVICE_VERIFICATION_MODE': 'enforce', 'SCISONOMICS_EMAIL_PROVIDER': 'memory'}):
            main._DEV_EMAIL_OUTBOX.clear(); self.addCleanup(main._DEV_EMAIL_OUTBOX.clear)
            private = Ed25519PrivateKey.generate(); raw = private.public_key().public_bytes_raw()
            public = {'formatVersion': 1, 'deviceId': str(uuid4()), 'publicKey': h.base64url_encode(raw),
                      'publicKeyHash': h.base64url_encode(hashlib.sha256(raw).digest())}
            headers = {'Authorization': 'Bearer test-supabase-token'}
            context = fixture.client.get('/auth/devices/context', headers=headers).json()
            pending = fixture.client.post('/auth/devices/login', headers=headers,
                                          json={'identity': public, 'name': 'Load test synthetic', 'platform': 'windows'}).json()
            continuation = {k: pending[k] for k in ('verificationId', 'verificationToken')}
            challenge = fixture.client.post('/auth/devices/enrollment/challenge', headers=headers, json=continuation).json()
            body = {**continuation, 'code': main._DEV_EMAIL_OUTBOX[-1]['code'], 'challenge': challenge,
                    'proof': h.proof(private, public, context['accountBinding'], challenge, 1)}
            first = fixture.client.post('/auth/devices/enrollment/complete', headers=headers, json=body)
            self.assertEqual(first.status_code, 200)
            grant = h.validate_grant(first.json(), f.INTERNAL_ID, context['accountBinding'], public)
            self.assertEqual(fixture.client.get('/sync/health', headers=headers).status_code, 401)
            self.assertEqual(fixture.client.post('/auth/devices/enrollment/complete', headers=headers, json=body).status_code, 401)
            authorized = {'Authorization': 'Bearer ' + grant['access_token']}
            for path in h.READS.values():
                self.assertEqual(fixture.client.get(path, headers=authorized).status_code, 200)
            pull = fixture.client.get('/sync/pull', headers=authorized).json()
            self.assertTrue(fixture.client.get('/sync/pull', headers=authorized, params={'since': pull['cursor']}).json()['incremental'])


if __name__ == '__main__':
    unittest.main()
