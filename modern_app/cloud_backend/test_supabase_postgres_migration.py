"""External-auth rollout rehearsal on explicitly marked loopback PostgreSQL.

Never uses DATABASE_URL or SCISONOMICS_CLOUD_DATABASE_URL from the caller.
Each test creates/drops only its own schema in a dedicated local test database.
The actual pre-Supabase schema/code comes from repository commit 9b0743a.
See RAILWAY_AUTH_ROLLOUT.md for the local setup and production checklist.
"""

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import re
import subprocess
import sys
from threading import Barrier
import types
import unittest
from unittest.mock import patch
from urllib.parse import urlencode, urlsplit, urlunsplit
from uuid import uuid4

import httpx
import psycopg

from modern_app.cloud_backend.app import db, supabase_auth
from modern_app.cloud_backend.app.auth import hash_password


ROOT = Path(__file__).resolve().parents[2]
BASELINE = "9b0743a"
URL_ENV = "SCISONOMICS_AUTH_TEST_POSTGRES_URL"
MARKER_ENV = "SCISONOMICS_AUTH_TEST_MARKER"
HISTORICAL_ID = "fbfca732-c4d1-47be-95e5-75aa3142726f"
EMAIL = "sciso123@gmail.com"
SUB = "11111111-1111-4111-8111-111111111111"
OTHER_SUB = "22222222-2222-4222-8222-222222222222"
STAMP = "2026-01-01T00:00:00Z"
PASSWORD = "isolated rehearsal password"


def validate_local_target(url: str, marker: str) -> None:
    """Fail closed before any schema DDL; reject URI connection overrides."""
    parsed = urlsplit(url)
    if (parsed.scheme not in {"postgres", "postgresql"}
            or parsed.hostname != "127.0.0.1" or parsed.query or parsed.fragment
            or not re.fullmatch(r"/scisonomics_auth_migration_test(?:_[a-z0-9]+)?", parsed.path)
            or not re.fullmatch(r"[a-f0-9]{32}", marker)):
        raise RuntimeError("auth_test_requires_marked_loopback_database")
    try:
        with psycopg.connect(url, hostaddr="127.0.0.1", connect_timeout=5,
                             options="-c search_path=public") as conn:
            identity = conn.execute("SELECT current_database(), host(inet_server_addr())").fetchone()
            exists = conn.execute("SELECT to_regclass('public.scisonomics_auth_test_marker')").fetchone()[0]
            matches = exists is not None and conn.execute(
                "SELECT EXISTS (SELECT 1 FROM public.scisonomics_auth_test_marker "
                "WHERE marker = %s AND purpose = 'external_auth_migration')", (marker,)
            ).fetchone()[0]
            if identity != (parsed.path[1:], "127.0.0.1") or not matches:
                raise RuntimeError("marker_mismatch")
    except Exception:
        raise RuntimeError("auth_test_local_database_validation_failed") from None


@unittest.skipUnless(os.getenv(URL_ENV), "requires explicitly marked local PostgreSQL")
class PostgreSQLSupabaseMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin_url = os.environ[URL_ENV]
        cls.marker = os.environ.get(MARKER_ENV, "")
        validate_local_target(cls.admin_url, cls.marker)
        cls.sources = {}
        for name in ("db", "main"):
            cls.sources[name] = subprocess.run(
                ["git", "-c", f"safe.directory={ROOT.as_posix()}", "show",
                 f"{BASELINE}:modern_app/cloud_backend/app/{name}.py"],
                cwd=ROOT, capture_output=True, check=True, encoding="utf-8",
            ).stdout
        cls.password_hash = hash_password(PASSWORD)
        with psycopg.connect(cls.admin_url) as conn:
            cls.server_version = conn.execute("SHOW server_version").fetchone()[0]

    def setUp(self):
        validate_local_target(self.admin_url, self.marker)
        self.schema = f"auth_audit_{uuid4().hex}"
        with psycopg.connect(self.admin_url, autocommit=True) as conn:
            conn.execute(f'CREATE SCHEMA "{self.schema}"')
        self.addCleanup(self.drop_schema)
        parsed = urlsplit(self.admin_url)
        schema_url = urlunsplit(parsed._replace(query=urlencode({"options": f"-csearch_path={self.schema}"})))
        environment = patch.dict(os.environ, {
            "PATH": os.environ.get("PATH", ""),
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", "C:/Windows"),
            "TEMP": os.environ.get("TEMP", ""),
            "SCISONOMICS_ENV": "development",
            "SCISONOMICS_CLOUD_DATABASE_URL": schema_url,
            "DATABASE_URL": "",
            "PGHOSTADDR": "127.0.0.1",
            "SCISONOMICS_JWT_SECRET": "isolated-auth-rollout-test-secret",
            "SCISONOMICS_ALLOWED_ORIGINS": "http://127.0.0.1:3000",
            "SCISONOMICS_SUPABASE_URL": "https://auth-test.supabase.co",
            "SCISONOMICS_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test_only",
            "SCISONOMICS_CHECK_BREACHED_PASSWORDS": "false",
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.old_db = self.baseline_module("db")
        self.old_db.init_db()
        self.old_main = self.baseline_module("main")
        self.old_main.init_db = self.old_db.init_db
        from fastapi.testclient import TestClient
        from modern_app.cloud_backend.app import main
        from modern_app.cloud_backend.app import security
        self.main = main
        rate_state = patch.dict(security._ATTEMPTS, {}, clear=True)
        rate_state.start()
        self.addCleanup(rate_state.stop)
        self.old_client = TestClient(self.old_main.app)
        self.client = TestClient(main.app)
        self.addCleanup(self.old_client.close)
        self.addCleanup(self.client.close)
        remote = patch.object(supabase_auth.httpx, "get", return_value=httpx.Response(200, json={
            "id": SUB, "email": EMAIL, "email_confirmed_at": STAMP,
        }))
        self.remote = remote.start()
        self.addCleanup(remote.stop)
        self.seed_history()
        self.original_user = self.user()
        self.original_finances = self.finances()
        self.original_fks = self.foreign_keys()

    def baseline_module(self, name):
        module_name = f"modern_app.cloud_backend.app._auth_audit_baseline_{name}_{self.schema}"
        module = types.ModuleType(module_name)
        module.__package__ = "modern_app.cloud_backend.app"
        module.__file__ = str(ROOT / "modern_app/cloud_backend/app" / f"{name}.py")
        sys.modules[module_name] = module
        self.addCleanup(sys.modules.pop, module_name, None)
        exec(compile(self.sources[name], module.__file__, "exec"), module.__dict__)
        return module

    def drop_schema(self):
        validate_local_target(self.admin_url, self.marker)
        if not re.fullmatch(r"auth_audit_[a-f0-9]{32}", self.schema):
            raise RuntimeError("auth_test_schema_identity_invalid")
        with psycopg.connect(self.admin_url, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA "{self.schema}" CASCADE')

    def seed_history(self):
        with db.connect() as conn:
            conn.execute(
                "INSERT INTO users (id, email, password_hash, display_name, auth_provider, google_sub, "
                "email_verified, email_verified_at, plan, subscription_status, subscription_expires_at, "
                "device_key_namespace, created_at, updated_at) "
                "VALUES (?, ?, ?, 'Historical fixture', 'google', 'legacy-google-sub', 1, ?, "
                "'premium', 'active', '2030-01-01T00:00:00Z', 'synthetic-namespace', ?, ?)",
                (HISTORICAL_ID, EMAIL, self.password_hash, STAMP, STAMP, STAMP),
            )
            fixtures = {
                "cloud_categorias": ("nombre, tipo", "'Category', 'gasto'"),
                "cloud_movimientos": ("tipo, monto, descripcion, fecha, categoria_sync_id", "'gasto', 123.45, 'Synthetic', '2026-01-01', 'cloud_categorias'"),
                "cloud_metas_ahorro": ("nombre, monto_objetivo, monto_inicial", "'Goal', 9000, 1000"),
                "cloud_gastos_programados": ("descripcion, monto_estimado", "'Scheduled', 88.5"),
                "cloud_gastos_fijos": ("descripcion, monto", "'Fixed', 77.25"),
                "cloud_presupuestos": ("mes, anio, monto", "1, 2026, 5000"),
                "cloud_tags": ("nombre, color", "'Tag', '#ffffff'"),
                "cloud_movimiento_tags": ("movimiento_sync_id, tag_sync_id", "'cloud_movimientos', 'cloud_tags'"),
            }
            for table, (columns, values) in fixtures.items():
                conn.execute(
                    f"INSERT INTO {table} (user_id, sync_id, remote_updated_at, {columns}) "
                    f"VALUES (?, ?, ?, {values})", (HISTORICAL_ID, table, STAMP),
                )

    def user(self, user_id=HISTORICAL_ID):
        with db.connect() as conn:
            return dict(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())

    def finances(self):
        with db.connect() as conn:
            return {table: [dict(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()]
                    for table in db.SYNC_CLOUD_TABLES}

    def foreign_keys(self):
        with db.connect() as conn:
            return [dict(row) for row in conn.execute(
                "SELECT c.conname, pg_get_constraintdef(c.oid) AS definition "
                "FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid "
                "JOIN pg_namespace n ON n.oid = t.relnamespace "
                "WHERE n.nspname = current_schema() AND c.contype = 'f' "
                "AND left(t.relname::text, 6) = 'cloud_' ORDER BY c.conname"
            ).fetchall()]

    def assert_history_preserved(self):
        current = self.user()
        for field, value in self.original_user.items():
            if field != "updated_at":
                self.assertEqual(current[field], value, field)
        self.assertEqual(self.finances(), self.original_finances)
        self.assertEqual(self.foreign_keys(), self.original_fks)

    def bootstrap(self, token="fake-supabase-token"):
        return self.client.post("/auth/supabase/bootstrap", json={}, headers={"Authorization": f"Bearer {token}"})

    def test_additive_catalog_defaults_partial_index_and_idempotence(self):
        self.assertNotIn("auth_provider_id", self.original_user)
        self.assertNotIn("password_auth_enabled", self.original_user)
        db.init_db()
        db.init_db()
        self.assert_history_preserved()
        self.assertIsNone(self.user()["auth_provider_id"])
        self.assertEqual(self.user()["password_auth_enabled"], 1)
        with db.connect() as conn:
            columns = {r["column_name"]: dict(r) for r in conn.execute(
                "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'users'"
            ).fetchall()}
            self.assertEqual(columns["auth_provider_id"]["data_type"], "text")
            self.assertEqual(columns["auth_provider_id"]["is_nullable"], "YES")
            self.assertEqual(columns["password_auth_enabled"]["is_nullable"], "NO")
            self.assertEqual(columns["password_auth_enabled"]["column_default"], "1")
            index = conn.execute("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() "
                                 "AND indexname = 'idx_users_auth_provider_id'").fetchone()["indexdef"]
            self.assertIn("UNIQUE", index)
            self.assertIn("IS NOT NULL", index)
            self.assertIn("<> ''", index)

    def test_historical_bootstrap_is_idempotent_and_preserves_premium_and_finances(self):
        db.init_db()
        for _ in range(2):
            response = self.bootstrap()
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["id"], HISTORICAL_ID)
            self.assertNotEqual(response.json()["id"], SUB)
        self.assertEqual(self.user()["auth_provider_id"], SUB)
        self.assert_history_preserved()
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM security_audit_log").fetchone()["n"], 1)
        with patch.object(self.main, "create_entitlement_token", return_value="isolated-test-signature"):
            entitlements = self.client.get("/billing/entitlements", headers={"Authorization": "Bearer fake-supabase-token"})
        self.assertEqual(entitlements.status_code, 200, entitlements.text)
        self.assertEqual(entitlements.json()["user_id"], HISTORICAL_ID)
        self.assertEqual(entitlements.json()["plan"], "premium")
        self.assertEqual(entitlements.json()["status"], "active")
        self.assertEqual(entitlements.json()["expires_at"], "2030-01-01T00:00:00Z")

    def test_normalized_legacy_email_duplicate_fails_closed(self):
        db.init_db()
        with db.connect() as conn:
            conn.execute("INSERT INTO users (id, email, password_hash, created_at, updated_at) "
                         "VALUES ('duplicate', ' SCISO123@GMAIL.COM ', '', ?, ?)", (STAMP, STAMP))
        response = self.bootstrap()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "auth_email_ambiguous")
        self.assertIsNone(self.user()["auth_provider_id"])
        self.assert_history_preserved()

    def test_email_linked_to_other_subject_returns_409(self):
        db.init_db()
        with db.connect() as conn:
            conn.execute("UPDATE users SET auth_provider_id = ? WHERE id = ?", (OTHER_SUB, HISTORICAL_ID))
        response = self.bootstrap()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "auth_provider_conflict")
        self.assertEqual(self.user()["auth_provider_id"], OTHER_SUB)
        self.assert_history_preserved()

    def test_subject_linked_to_test_owner_does_not_move_historical_owner(self):
        db.init_db()
        with db.connect() as conn:
            conn.execute("INSERT INTO users (id, email, password_hash, auth_provider_id, created_at, updated_at) "
                         "VALUES ('test-owner', 'test@example.test', '', ?, ?, ?)", (SUB, STAMP, STAMP))
        response = self.bootstrap()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], "test-owner")
        self.assertIsNone(self.user()["auth_provider_id"])
        self.assert_history_preserved()

    def concurrent_bootstrap(self, tokens):
        barrier = Barrier(len(tokens))
        def action(token):
            barrier.wait(timeout=10)
            return self.bootstrap(token)
        with ThreadPoolExecutor(max_workers=len(tokens)) as pool:
            return list(pool.map(action, tokens))

    def test_simultaneous_same_subject_links_once(self):
        db.init_db()
        responses = self.concurrent_bootstrap(["same"] * 4)
        self.assertEqual([r.status_code for r in responses], [200] * 4)
        self.assertEqual({r.json()["id"] for r in responses}, {HISTORICAL_ID})
        self.assert_history_preserved()
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM security_audit_log").fetchone()["n"], 1)

    def test_competing_subjects_for_same_email_return_one_conflict(self):
        db.init_db()
        def remote(_url, **kwargs):
            subject = SUB if kwargs["headers"]["Authorization"].endswith("one") else OTHER_SUB
            return httpx.Response(200, json={"id": subject, "email": EMAIL, "email_confirmed_at": STAMP})
        self.remote.side_effect = remote
        responses = self.concurrent_bootstrap(["one", "two"])
        self.assertEqual(sorted(r.status_code for r in responses), [200, 409])
        self.assertEqual(next(r.json()["id"] for r in responses if r.status_code == 200), HISTORICAL_ID)
        self.assert_history_preserved()

    def test_concurrent_initializers_are_idempotent(self):
        barrier = Barrier(2)
        def initialize(_):
            barrier.wait(timeout=10)
            db.init_db()
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(initialize, range(2)))
        self.assert_history_preserved()

    def test_legacy_login_refresh_survive_migration_and_link(self):
        before = self.old_client.post("/auth/login", json={"email": EMAIL, "password": PASSWORD})
        self.assertEqual(before.status_code, 200, before.text)
        db.init_db()
        self.assertEqual(self.bootstrap().json()["id"], HISTORICAL_ID)
        for client in (self.client, self.old_client):
            login = client.post("/auth/login", json={"email": EMAIL, "password": PASSWORD})
            self.assertEqual(login.status_code, 200, login.text)
            self.assertEqual(login.json()["user"]["id"], HISTORICAL_ID)
            me = client.get("/auth/me", headers={"Authorization": "Bearer " + login.json()["access_token"]})
            self.assertEqual(me.status_code, 200)
            self.assertEqual(me.json()["id"], HISTORICAL_ID)
        refresh = self.client.post("/auth/refresh", json={"refresh_token": before.json()["refresh_token"]})
        self.assertEqual(refresh.status_code, 200, refresh.text)
        self.assertEqual(refresh.json()["user"]["id"], HISTORICAL_ID)
        self.assertEqual(self.user()["auth_provider_id"], SUB)
        self.assert_history_preserved()

    def test_legacy_google_preserves_google_and_supabase_links(self):
        profile = {"sub": "legacy-google-sub", "email": EMAIL, "name": "Historical fixture", "email_verified": True}
        with db.connect() as conn:
            before = self.old_main._find_or_create_google_user(conn, profile, STAMP)
        self.assertEqual(before.id, HISTORICAL_ID)
        db.init_db()
        self.bootstrap()
        with db.connect() as conn:
            after = self.main._find_or_create_google_user(conn, profile, STAMP)
        self.assertEqual(after.id, HISTORICAL_ID)
        self.assertEqual(self.user()["auth_provider"], "google")
        self.assertEqual(self.user()["google_sub"], "legacy-google-sub")
        self.assertEqual(self.user()["auth_provider_id"], SUB)
        self.assert_history_preserved()

    def test_new_user_is_free_with_separate_internal_id_and_no_password(self):
        db.init_db()
        self.remote.return_value = httpx.Response(200, json={"id": SUB, "email": "new@example.test", "email_confirmed_at": STAMP})
        response = self.bootstrap()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotEqual(response.json()["id"], SUB)
        new = self.user(response.json()["id"])
        self.assertEqual(new["plan"], "free")
        self.assertEqual(new["password_auth_enabled"], 0)
        self.assertEqual(new["password_hash"], "")
        self.assertIsNone(self.user()["auth_provider_id"])
        self.assert_history_preserved()

    def test_auth_ddl_failure_rolls_back_added_columns(self):
        real_ensure = db._ensure_external_auth_schema
        def fail(conn):
            real_ensure(conn)
            raise RuntimeError("injected_auth_ddl_failure")
        with patch.object(db, "_ensure_external_auth_schema", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "injected_auth_ddl_failure"):
                db.init_db()
        self.assertNotIn("auth_provider_id", self.user())
        self.assertNotIn("password_auth_enabled", self.user())
        self.assert_history_preserved()

    def test_existing_sync_backfill_changes_only_missing_revision_metadata(self):
        with db.connect() as conn:
            conn.execute("UPDATE cloud_movimientos SET remote_updated_at = '' WHERE user_id = ?", (HISTORICAL_ID,))
        before = self.finances()
        db.init_db()
        after = self.finances()
        self.assertEqual(after["cloud_movimientos"][0]["remote_updated_at"], "1970-01-01T00:00:00+00:00")
        before["cloud_movimientos"][0]["remote_updated_at"] = "1970-01-01T00:00:00+00:00"
        self.assertEqual(after, before)
        self.assertEqual(self.foreign_keys(), self.original_fks)


class PostgreSQLAuthHarnessGuardTests(unittest.TestCase):
    def test_rejects_remote_missing_marker_other_database_and_connection_overrides(self):
        for url, marker in (
            ("postgresql://u@railway.example/scisonomics_auth_migration_test", "a" * 32),
            ("postgresql://u@127.0.0.1/scisonomics_auth_migration_test", ""),
            ("postgresql://u@127.0.0.1/production", "a" * 32),
            ("postgresql://u@127.0.0.1/scisonomics_auth_migration_test?hostaddr=1.2.3.4", "a" * 32),
        ):
            with self.subTest(url=url), patch.object(psycopg, "connect") as connect:
                with self.assertRaisesRegex(RuntimeError, "auth_test_requires_marked_loopback_database"):
                    validate_local_target(url, marker)
                connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
