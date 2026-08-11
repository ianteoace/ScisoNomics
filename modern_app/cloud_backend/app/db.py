from __future__ import annotations

import logging
import os
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any


_logger = logging.getLogger("scisonomics.cloud.db")
# ASCII "SCISONOM" as an int64. Reserved for ScisoNomics cloud schema migrations.
POSTGRES_INIT_ADVISORY_LOCK_KEY = 0x534349534F4E4F4D
POSTGRES_MIGRATION_LOCK_TIMEOUT_MS = 15_000
POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS = 120_000
DEVICE_KEY_NAMESPACE_RETRIES = 5


def get_database_url() -> str:
    return (
        os.getenv("SCISONOMICS_CLOUD_DATABASE_URL", "").strip()
        or os.getenv("DATABASE_URL", "").strip()
        or "sqlite:///./modern_app/cloud_backend/scisonomics_cloud_dev.db"
    )


def get_database_engine() -> str:
    url = get_database_url()
    if url.startswith("sqlite:///"):
        return "sqlite"
    if url.startswith(("postgresql://", "postgres://")):
        return "postgresql"
    raise RuntimeError("SCISONOMICS_CLOUD_DATABASE_URL/DATABASE_URL debe ser sqlite:/// o postgresql://.")


def get_database_path() -> Path:
    url = get_database_url()
    if not url.startswith("sqlite:///"):
        raise RuntimeError("La ruta de archivo solo existe para SQLite.")
    raw_path = url.replace("sqlite:///", "", 1)
    path = Path(raw_path)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path.expanduser().resolve()


def _postgres_url() -> str:
    url = get_database_url()
    if url.startswith("postgres://"):
        return "postgresql://" + url.removeprefix("postgres://")
    return url


def _convert_placeholders(sql: str) -> str:
    return sql.replace("?", "%s")


class CloudConnection:
    def __init__(self) -> None:
        self.engine = get_database_engine()
        self._conn: Any = None

    def __enter__(self) -> "CloudConnection":
        if self.engine == "sqlite":
            db_path = get_database_path()
            db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            self._conn = conn
            return self

        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise RuntimeError("Falta instalar psycopg[binary] para usar PostgreSQL.") from exc

        self._conn = psycopg.connect(_postgres_url(), row_factory=dict_row)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._conn is None:
            return
        try:
            if exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()
        finally:
            self._conn.close()

    def execute(self, sql: str, params: tuple[Any, ...] | list[Any] = ()):
        if self._conn is None:
            raise RuntimeError("Conexion cloud no inicializada.")
        if self.engine == "postgresql":
            sql = _convert_placeholders(sql)
        return self._conn.execute(sql, params)

    def commit(self) -> None:
        if self._conn is None:
            raise RuntimeError("Conexion cloud no inicializada.")
        self._conn.commit()


def connect() -> CloudConnection:
    return CloudConnection()


def init_db() -> None:
    engine = get_database_engine()
    started = time.monotonic()
    _logger.info("[cloud-db-migration] start engine=%s", engine)
    try:
        if engine == "postgresql":
            _init_postgres()
        else:
            _init_sqlite()
    except Exception as exc:
        duration_ms = round((time.monotonic() - started) * 1000)
        _logger.error(
            "[cloud-db-migration] failed engine=%s duration_ms=%s error_type=%s",
            engine,
            duration_ms,
            type(exc).__name__,
        )
        raise
    duration_ms = round((time.monotonic() - started) * 1000)
    _logger.info("[cloud-db-migration] finish engine=%s duration_ms=%s", engine, duration_ms)


SYNC_CLOUD_TABLES = (
    "cloud_categorias",
    "cloud_movimientos",
    "cloud_metas_ahorro",
    "cloud_gastos_programados",
    "cloud_gastos_fijos",
    "cloud_presupuestos",
    "cloud_tags",
    "cloud_movimiento_tags",
)

CLOUD_SYNC_COLUMN_DEFINITIONS: dict[str, dict[str, str]] = {
    "cloud_categorias": {
        "color": "TEXT",
        "icono": "TEXT",
    },
    "cloud_movimientos": {
        "categoria_id": "INTEGER",
        "categoria_sync_id": "TEXT",
    },
    "cloud_metas_ahorro": {
        "monto_objetivo": "DOUBLE PRECISION",
        "monto_inicial": "DOUBLE PRECISION",
        "fecha_objetivo": "TEXT",
        "descripcion": "TEXT",
        "estado": "TEXT",
    },
    "cloud_gastos_programados": {
        "categoria_sync_id": "TEXT",
        "monto_estimado": "DOUBLE PRECISION",
        "fecha_vencimiento": "TEXT",
        "estado": "TEXT",
        "es_recurrente": "INTEGER",
        "frecuencia": "TEXT",
    },
    "cloud_gastos_fijos": {
        "categoria_sync_id": "TEXT",
        "monto": "DOUBLE PRECISION",
        "dia_vencimiento": "INTEGER",
        "activo": "INTEGER",
    },
    "cloud_presupuestos": {
        "categoria_sync_id": "TEXT",
        "mes": "INTEGER",
        "anio": "INTEGER",
        "monto": "DOUBLE PRECISION",
    },
    "cloud_tags": {
        "nombre": "TEXT",
        "color": "TEXT",
    },
    "cloud_movimiento_tags": {
        "movimiento_sync_id": "TEXT",
        "tag_sync_id": "TEXT",
    },
}

COMMON_SYNC_COLUMN_DEFINITIONS = {
    "created_at": "TEXT",
    "updated_at": "TEXT",
    "deleted_at": "TEXT",
    "sync_status": "TEXT",
    "remote_updated_at": "TEXT",
    "last_modified_device_id": "TEXT",
    "last_modified_device_name": "TEXT",
    "last_modified_at": "TEXT",
}


def _ensure_column(conn: CloudConnection, table: str, column: str, definition: str) -> None:
    if conn.engine == "sqlite":
        columns = {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        return

    row = conn.execute(
        """
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ? AND column_name = ?
        """,
        (table, column),
    ).fetchone()
    if not row:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _ensure_postgres_foreign_key(
    conn: CloudConnection,
    *,
    table: str,
    constraint: str,
    columns: tuple[str, ...],
    target_table: str,
    target_columns: tuple[str, ...],
    replace_if_table_empty: bool = False,
) -> None:
    if conn.engine != "postgresql":
        return
    row = conn.execute(
        """
        SELECT
            current_schema() AS active_schema,
            target_namespace_record.nspname AS target_schema,
            target_table_record.relname AS target_table,
            array_agg(local_attribute.attname ORDER BY local_key.ordinality) AS local_columns,
            array_agg(target_attribute.attname ORDER BY local_key.ordinality) AS target_columns
        FROM pg_catalog.pg_constraint AS constraint_record
        JOIN pg_catalog.pg_class AS table_record
          ON table_record.oid = constraint_record.conrelid
        JOIN pg_catalog.pg_namespace AS namespace_record
          ON namespace_record.oid = table_record.relnamespace
        JOIN pg_catalog.pg_class AS target_table_record
          ON target_table_record.oid = constraint_record.confrelid
        JOIN pg_catalog.pg_namespace AS target_namespace_record
          ON target_namespace_record.oid = target_table_record.relnamespace
        JOIN unnest(constraint_record.conkey) WITH ORDINALITY AS local_key(attnum, ordinality)
          ON TRUE
        JOIN unnest(constraint_record.confkey) WITH ORDINALITY AS target_key(attnum, ordinality)
          ON target_key.ordinality = local_key.ordinality
        JOIN pg_catalog.pg_attribute AS local_attribute
          ON local_attribute.attrelid = table_record.oid
         AND local_attribute.attnum = local_key.attnum
        JOIN pg_catalog.pg_attribute AS target_attribute
          ON target_attribute.attrelid = target_table_record.oid
         AND target_attribute.attnum = target_key.attnum
        WHERE namespace_record.nspname = current_schema()
          AND table_record.relname = ?
          AND constraint_record.conname = ?
          AND constraint_record.contype = 'f'
        GROUP BY current_schema(), target_namespace_record.nspname, target_table_record.relname
        """,
        (table, constraint),
    ).fetchone()
    if row is not None:
        actual_columns = tuple(str(value) for value in row["local_columns"])
        actual_target_columns = tuple(str(value) for value in row["target_columns"])
        if (
            actual_columns != columns
            or str(row["target_schema"]) != str(row["active_schema"])
            or str(row["target_table"]) != target_table
            or actual_target_columns != target_columns
        ):
            if not replace_if_table_empty:
                raise RuntimeError(f"foreign_key_definition_mismatch:{constraint}")
            has_rows = conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone()
            if has_rows is not None:
                raise RuntimeError(f"foreign_key_definition_mismatch:{constraint}")
            conn.execute(f"ALTER TABLE {table} DROP CONSTRAINT {constraint}")
        else:
            return
    conn.execute(
        f"ALTER TABLE {table} ADD CONSTRAINT {constraint} "
        f"FOREIGN KEY ({', '.join(columns)}) "
        f"REFERENCES {target_table}({', '.join(target_columns)})"
    )


def _sqlite_foreign_keys(conn: CloudConnection, table: str) -> set[tuple[tuple[str, ...], str, tuple[str, ...]]]:
    grouped: dict[int, tuple[str, list[tuple[int, str, str]]]] = {}
    for row in conn.execute(f"PRAGMA foreign_key_list({table})").fetchall():
        foreign_key_id = int(row["id"])
        target_table = str(row["table"])
        grouped.setdefault(foreign_key_id, (target_table, []))[1].append(
            (int(row["seq"]), str(row["from"]), str(row["to"]))
        )
    return {
        (
            tuple(item[1] for item in sorted(columns)),
            target_table,
            tuple(item[2] for item in sorted(columns)),
        )
        for target_table, columns in grouped.values()
    }


def _drop_empty_incompatible_sqlite_v1_tables(conn: CloudConnection) -> None:
    if conn.engine != "sqlite":
        return
    required = {
        "refresh_token_families": {
            (("user_id", "trusted_device_id"), "trusted_devices", ("user_id", "id")),
        },
        "device_proof_challenges": {
            (("user_id", "trusted_device_id"), "trusted_devices", ("user_id", "id")),
            (("user_id", "refresh_family_id"), "refresh_token_families", ("user_id", "id")),
            (("user_id", "target_device_id"), "trusted_devices", ("user_id", "device_id")),
        },
    }
    tables = {
        str(row["name"])
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    }
    incompatible = any(
        table in tables and not expected.issubset(_sqlite_foreign_keys(conn, table))
        for table, expected in required.items()
    )
    if not incompatible:
        return
    for table in ("device_proof_challenges", "refresh_token_families", "trusted_devices"):
        if table in tables:
            count = int(conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"])
            if count:
                raise RuntimeError("device_v1_relationship_repair_requires_empty_tables")
    for table in ("device_proof_challenges", "refresh_token_families", "trusted_devices"):
        conn.execute(f"DROP TABLE IF EXISTS {table}")


def _ensure_sqlite_cloud_refresh_token_v1_foreign_keys(conn: CloudConnection) -> None:
    if conn.engine != "sqlite":
        return
    expected = {
        (("user_id", "refresh_token_family_id"), "refresh_token_families", ("user_id", "id")),
        (("user_id", "trusted_device_id"), "trusted_devices", ("user_id", "id")),
    }
    if expected.issubset(_sqlite_foreign_keys(conn, "cloud_refresh_tokens")):
        return
    conn.execute("ALTER TABLE cloud_refresh_tokens RENAME TO cloud_refresh_tokens_v1_legacy")
    conn.execute(
        """
        CREATE TABLE cloud_refresh_tokens (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            revoked_at TEXT,
            last_used_at TEXT,
            device_id TEXT,
            device_name TEXT,
            family_id TEXT,
            parent_token_id TEXT,
            compromised_at TEXT,
            refresh_token_family_id TEXT,
            trusted_device_id TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (user_id, refresh_token_family_id)
                REFERENCES refresh_token_families(user_id, id),
            FOREIGN KEY (user_id, trusted_device_id)
                REFERENCES trusted_devices(user_id, id)
        )
        """
    )
    columns = (
        "id, user_id, token_hash, created_at, expires_at, revoked_at, last_used_at, "
        "device_id, device_name, family_id, parent_token_id, compromised_at, "
        "refresh_token_family_id, trusted_device_id"
    )
    conn.execute(
        f"INSERT INTO cloud_refresh_tokens ({columns}) "
        f"SELECT {columns} FROM cloud_refresh_tokens_v1_legacy"
    )
    conn.execute("DROP TABLE cloud_refresh_tokens_v1_legacy")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_user ON cloud_refresh_tokens(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_expires ON cloud_refresh_tokens(expires_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_family ON cloud_refresh_tokens(family_id)")


def _ensure_origin_columns(conn: CloudConnection) -> None:
    for table in SYNC_CLOUD_TABLES:
        _ensure_column(conn, table, "last_modified_device_id", "TEXT")
        _ensure_column(conn, table, "last_modified_device_name", "TEXT")
        _ensure_column(conn, table, "last_modified_at", "TEXT")


def _ensure_cloud_sync_schema(conn: CloudConnection, *, backfill: bool = True) -> None:
    for table in SYNC_CLOUD_TABLES:
        for column, definition in COMMON_SYNC_COLUMN_DEFINITIONS.items():
            _ensure_column(conn, table, column, definition)
        for column, definition in CLOUD_SYNC_COLUMN_DEFINITIONS.get(table, {}).items():
            _ensure_column(conn, table, column, definition)
    if backfill:
        _backfill_cloud_sync_timestamps(conn)


def _backfill_cloud_sync_timestamps(conn: CloudConnection) -> None:
    for table in SYNC_CLOUD_TABLES:
        conn.execute(
            f"""
            UPDATE {table}
            SET remote_updated_at = COALESCE(NULLIF(remote_updated_at, ''), NULLIF(updated_at, ''), NULLIF(created_at, ''), ?)
            WHERE remote_updated_at IS NULL OR remote_updated_at = ''
            """,
            ("1970-01-01T00:00:00+00:00",),
        )


def _ensure_google_auth_columns(conn: CloudConnection) -> None:
    _ensure_column(conn, "users", "google_sub", "TEXT")
    _ensure_column(conn, "users", "avatar_url", "TEXT")
    _ensure_column(conn, "users", "auth_provider", "TEXT")
    _ensure_column(conn, "users", "email_verified", "INTEGER")
    _ensure_column(conn, "users", "email_verified_at", "TEXT")
    # Cuentas existentes se consideran verificadas para no bloquear usuarios previos a esta migracion.
    conn.execute("UPDATE users SET email_verified = 1, email_verified_at = COALESCE(email_verified_at, updated_at, created_at) WHERE email_verified IS NULL")
    if conn.engine == "sqlite":
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL AND google_sub <> ''")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_email_normalized ON users(LOWER(TRIM(email)))")
    else:
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL AND google_sub <> ''")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_email_normalized ON users(LOWER(TRIM(email)))")


def _ensure_refresh_token_columns(conn: CloudConnection) -> None:
    _ensure_column(conn, "cloud_refresh_tokens", "device_id", "TEXT")
    _ensure_column(conn, "cloud_refresh_tokens", "device_name", "TEXT")
    _ensure_column(conn, "cloud_refresh_tokens", "family_id", "TEXT")
    _ensure_column(conn, "cloud_refresh_tokens", "parent_token_id", "TEXT")
    _ensure_column(conn, "cloud_refresh_tokens", "compromised_at", "TEXT")
    conn.execute("UPDATE cloud_refresh_tokens SET family_id = COALESCE(NULLIF(family_id, ''), id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_family ON cloud_refresh_tokens(family_id)")


def _ensure_security_audit_schema(conn: CloudConnection) -> None:
    id_type = "INTEGER PRIMARY KEY AUTOINCREMENT" if conn.engine == "sqlite" else "BIGSERIAL PRIMARY KEY"
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS security_audit_log (
            id {id_type},
            event_type TEXT NOT NULL,
            actor_id TEXT,
            target_id TEXT,
            source_ip TEXT,
            outcome TEXT NOT NULL,
            details TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_security_audit_created ON security_audit_log(created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_security_audit_actor ON security_audit_log(actor_id)")


def _ensure_billing_columns(conn: CloudConnection) -> None:
    _ensure_column(conn, "users", "plan", "TEXT")
    _ensure_column(conn, "users", "subscription_status", "TEXT")
    _ensure_column(conn, "users", "subscription_expires_at", "TEXT")
    conn.execute("UPDATE users SET plan = COALESCE(NULLIF(plan, ''), 'free')")
    conn.execute("UPDATE users SET subscription_status = COALESCE(NULLIF(subscription_status, ''), 'active')")


def _ensure_email_verification_schema(conn: CloudConnection) -> None:
    id_type = "INTEGER PRIMARY KEY AUTOINCREMENT" if conn.engine == "sqlite" else "SERIAL PRIMARY KEY"
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS email_verification_codes (
            id {id_type},
            user_id TEXT NOT NULL,
            purpose TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 5,
            consumed_at TEXT,
            created_at TEXT NOT NULL,
            last_sent_at TEXT NOT NULL,
            invalidated_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
        """
    )
    _ensure_column(conn, "email_verification_codes", "invalidated_at", "TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_email_verification_user_purpose ON email_verification_codes(user_id, purpose)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_email_verification_expires ON email_verification_codes(expires_at)")


def _assign_missing_device_key_namespaces(conn: CloudConnection) -> None:
    missing_users = conn.execute(
        "SELECT id FROM users WHERE device_key_namespace IS NULL OR device_key_namespace = ''"
    ).fetchall()
    assigned_during_backfill: set[str] = set()
    for row in missing_users:
        for attempt in range(DEVICE_KEY_NAMESPACE_RETRIES + 1):
            namespace = secrets.token_urlsafe(32)
            persisted = conn.execute(
                "SELECT 1 FROM users WHERE device_key_namespace = ? LIMIT 1",
                (namespace,),
            ).fetchone()
            if namespace in assigned_during_backfill or persisted is not None:
                if attempt == DEVICE_KEY_NAMESPACE_RETRIES:
                    raise RuntimeError("device_key_namespace_retry_exhausted")
                continue
            conn.execute("SAVEPOINT device_namespace_retry")
            try:
                cursor = conn.execute(
                    "UPDATE users SET device_key_namespace = ? WHERE id = ? AND (device_key_namespace IS NULL OR device_key_namespace = '')",
                    (namespace, str(row["id"])),
                )
            except Exception as exc:
                conn.execute("ROLLBACK TO SAVEPOINT device_namespace_retry")
                conn.execute("RELEASE SAVEPOINT device_namespace_retry")
                constraint_name = getattr(getattr(exc, "diag", None), "constraint_name", None)
                is_collision = (
                    constraint_name == "idx_users_device_key_namespace"
                    or "device_key_namespace" in str(exc).lower()
                )
                if not is_collision:
                    raise
                if attempt == DEVICE_KEY_NAMESPACE_RETRIES:
                    raise RuntimeError("device_key_namespace_retry_exhausted") from exc
                continue
            conn.execute("RELEASE SAVEPOINT device_namespace_retry")
            if cursor.rowcount in (-1, 1):
                assigned_during_backfill.add(namespace)
            break


def missing_device_key_namespace_count(conn: CloudConnection | None = None) -> int:
    if conn is None:
        with connect() as owned_conn:
            return missing_device_key_namespace_count(owned_conn)
    row = conn.execute(
        "SELECT COUNT(*) AS missing_namespace_count "
        "FROM users WHERE device_key_namespace IS NULL OR device_key_namespace = ''"
    ).fetchone()
    return int(row["missing_namespace_count"])


def _ensure_device_verification_schema(conn: CloudConnection) -> None:
    binary_type = "BLOB" if conn.engine == "sqlite" else "BYTEA"
    _drop_empty_incompatible_sqlite_v1_tables(conn)
    _ensure_column(conn, "users", "device_key_namespace", "TEXT")
    _assign_missing_device_key_namespaces(conn)
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_device_key_namespace "
        "ON users(device_key_namespace) WHERE device_key_namespace IS NOT NULL"
    )
    if missing_device_key_namespace_count(conn) != 0:
        raise RuntimeError("device_key_namespace_backfill_incomplete")

    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS trusted_devices (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            public_key {binary_type} NOT NULL,
            public_key_hash {binary_type} NOT NULL,
            device_name TEXT,
            status TEXT NOT NULL CHECK (status IN ('observed', 'trusted', 'revoked')),
            trust_source TEXT,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            trusted_at TEXT,
            revoked_at TEXT,
            revocation_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id),
            CHECK (length(public_key) = 32),
            CHECK (length(public_key_hash) = 32),
            UNIQUE(user_id, public_key_hash),
            UNIQUE(user_id, device_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_devices_user_internal_id ON trusted_devices(user_id, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trusted_devices_status ON trusted_devices(user_id, status)")

    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS device_verification_challenges (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            account_binding_hash {binary_type} NOT NULL,
            device_id TEXT NOT NULL,
            candidate_public_key {binary_type} NOT NULL,
            candidate_public_key_hash {binary_type} NOT NULL,
            device_name TEXT,
            email_code_hash TEXT NOT NULL,
            verification_token_hash TEXT NOT NULL,
            email_expires_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 5,
            last_sent_at TEXT NOT NULL,
            consumed_at TEXT,
            invalidated_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id),
            CHECK (length(account_binding_hash) = 32),
            CHECK (length(candidate_public_key) = 32),
            CHECK (length(candidate_public_key_hash) = 32)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_device_verification_user ON device_verification_challenges(user_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_device_verification_expires ON device_verification_challenges(email_expires_at)"
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS refresh_token_families (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            trusted_device_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_used_at TEXT,
            expires_at TEXT NOT NULL,
            revoked_at TEXT,
            compromised_at TEXT,
            revocation_reason TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (user_id, trusted_device_id) REFERENCES trusted_devices(user_id, id),
            UNIQUE(user_id, id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_refresh_families_user ON refresh_token_families(user_id)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_families_user_id ON refresh_token_families(user_id, id)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_refresh_families_device ON refresh_token_families(trusted_device_id)"
    )

    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS device_proof_challenges (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            trusted_device_id TEXT,
            account_binding_hash {binary_type} NOT NULL,
            device_id TEXT NOT NULL,
            public_key_hash {binary_type} NOT NULL,
            purpose TEXT NOT NULL CHECK (purpose IN ('device_enrollment', 'device_authentication', 'refresh', 'device_rename', 'device_revoke')),
            nonce_hash {binary_type} NOT NULL,
            issued_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL,
            refresh_family_id TEXT,
            target_device_id TEXT,
            request_hash {binary_type},
            consumed_at TEXT,
            invalidated_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (user_id, trusted_device_id) REFERENCES trusted_devices(user_id, id),
            CONSTRAINT fk_device_proof_refresh_family
                FOREIGN KEY (user_id, refresh_family_id) REFERENCES refresh_token_families(user_id, id),
            CONSTRAINT fk_device_proof_target_device
                FOREIGN KEY (user_id, target_device_id) REFERENCES trusted_devices(user_id, device_id),
            CHECK (length(account_binding_hash) = 32),
            CHECK (length(public_key_hash) = 32),
            CHECK (length(nonce_hash) = 32),
            CHECK (request_hash IS NULL OR length(request_hash) = 32),
            CHECK (expires_at > issued_at AND expires_at - issued_at <= 120)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_device_proof_user ON device_proof_challenges(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_device_proof_expires ON device_proof_challenges(expires_at)")
    _ensure_postgres_foreign_key(
        conn,
        table="device_proof_challenges",
        constraint="fk_device_proof_refresh_family",
        columns=("user_id", "refresh_family_id"),
        target_table="refresh_token_families",
        target_columns=("user_id", "id"),
        replace_if_table_empty=True,
    )
    _ensure_postgres_foreign_key(
        conn,
        table="device_proof_challenges",
        constraint="fk_device_proof_target_device",
        columns=("user_id", "target_device_id"),
        target_table="trusted_devices",
        target_columns=("user_id", "device_id"),
        replace_if_table_empty=True,
    )

    _ensure_postgres_foreign_key(
        conn,
        table="refresh_token_families",
        constraint="fk_refresh_family_user_trusted_device",
        columns=("user_id", "trusted_device_id"),
        target_table="trusted_devices",
        target_columns=("user_id", "id"),
    )
    _ensure_postgres_foreign_key(
        conn,
        table="device_proof_challenges",
        constraint="fk_device_proof_user_trusted_device",
        columns=("user_id", "trusted_device_id"),
        target_table="trusted_devices",
        target_columns=("user_id", "id"),
    )

    _ensure_column(
        conn,
        "cloud_refresh_tokens",
        "refresh_token_family_id",
        "TEXT",
    )
    _ensure_column(
        conn,
        "cloud_refresh_tokens",
        "trusted_device_id",
        "TEXT",
    )
    _ensure_postgres_foreign_key(
        conn,
        table="cloud_refresh_tokens",
        constraint="fk_cloud_refresh_user_family_v1",
        columns=("user_id", "refresh_token_family_id"),
        target_table="refresh_token_families",
        target_columns=("user_id", "id"),
    )
    _ensure_postgres_foreign_key(
        conn,
        table="cloud_refresh_tokens",
        constraint="fk_cloud_refresh_user_trusted_device_v1",
        columns=("user_id", "trusted_device_id"),
        target_table="trusted_devices",
        target_columns=("user_id", "id"),
    )
    _ensure_sqlite_cloud_refresh_token_v1_foreign_keys(conn)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_v1_family ON cloud_refresh_tokens(refresh_token_family_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_trusted_device ON cloud_refresh_tokens(trusted_device_id)"
    )


def _init_sqlite() -> None:
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                display_name TEXT,
                plan TEXT DEFAULT 'free',
                subscription_status TEXT DEFAULT 'active',
                subscription_expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_categorias (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                sync_id TEXT NOT NULL,
                nombre TEXT NOT NULL,
                tipo TEXT NOT NULL,
                color TEXT,
                icono TEXT,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_categorias_user ON cloud_categorias(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_movimientos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                sync_id TEXT NOT NULL,
                tipo TEXT NOT NULL,
                monto REAL NOT NULL,
                descripcion TEXT,
                categoria_id INTEGER,
                categoria_sync_id TEXT,
                fecha TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_movimientos_user ON cloud_movimientos(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_metas_ahorro (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                sync_id TEXT NOT NULL,
                nombre TEXT NOT NULL,
                monto_objetivo REAL,
                monto_inicial REAL,
                fecha_objetivo TEXT,
                descripcion TEXT,
                estado TEXT,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_metas_ahorro_user ON cloud_metas_ahorro(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_gastos_programados (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                sync_id TEXT NOT NULL,
                descripcion TEXT,
                categoria_sync_id TEXT,
                monto_estimado REAL,
                fecha_vencimiento TEXT,
                estado TEXT,
                es_recurrente INTEGER,
                frecuencia TEXT,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_gastos_programados_user ON cloud_gastos_programados(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_gastos_fijos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                sync_id TEXT NOT NULL,
                descripcion TEXT,
                categoria_sync_id TEXT,
                monto REAL,
                dia_vencimiento INTEGER,
                activo INTEGER,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_gastos_fijos_user ON cloud_gastos_fijos(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_presupuestos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                sync_id TEXT NOT NULL,
                categoria_sync_id TEXT,
                mes INTEGER,
                anio INTEGER,
                monto REAL,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_presupuestos_user ON cloud_presupuestos(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                sync_id TEXT NOT NULL,
                nombre TEXT NOT NULL,
                color TEXT,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_tags_user ON cloud_tags(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_movimiento_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                sync_id TEXT NOT NULL,
                movimiento_sync_id TEXT NOT NULL,
                tag_sync_id TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_movimiento_tags_user ON cloud_movimiento_tags(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                device_name TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(user_id, device_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_devices_user ON cloud_devices(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS google_login_requests (
                login_request_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                user_id TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_google_login_requests_expires ON google_login_requests(expires_at)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_refresh_tokens (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                revoked_at TEXT,
                last_used_at TEXT,
                device_id TEXT,
                device_name TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_user ON cloud_refresh_tokens(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_expires ON cloud_refresh_tokens(expires_at)")
        _ensure_google_auth_columns(conn)
        _ensure_refresh_token_columns(conn)
        _ensure_security_audit_schema(conn)
        _ensure_billing_columns(conn)
        _ensure_email_verification_schema(conn)
        _ensure_device_verification_schema(conn)
        _ensure_cloud_sync_schema(conn)


def _postgres_timeout_ms(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name}_invalid") from exc
    if value < 1_000 or value > 600_000:
        raise RuntimeError(f"{name}_invalid")
    return value


def _configure_postgres_migration_transaction(conn: CloudConnection, *, acquire_lock: bool) -> None:
    lock_timeout_ms = _postgres_timeout_ms(
        "SCISONOMICS_DB_MIGRATION_LOCK_TIMEOUT_MS",
        POSTGRES_MIGRATION_LOCK_TIMEOUT_MS,
    )
    statement_timeout_ms = _postgres_timeout_ms(
        "SCISONOMICS_DB_MIGRATION_STATEMENT_TIMEOUT_MS",
        POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS,
    )
    conn.execute("SELECT set_config('lock_timeout', ?, true)", (f"{lock_timeout_ms}ms",))
    conn.execute("SELECT set_config('statement_timeout', ?, true)", (f"{statement_timeout_ms}ms",))
    if acquire_lock:
        conn.execute("SELECT pg_advisory_xact_lock(?)", (POSTGRES_INIT_ADVISORY_LOCK_KEY,))


def _init_postgres() -> None:
    with connect() as conn:
        _configure_postgres_migration_transaction(conn, acquire_lock=True)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                display_name TEXT,
                plan TEXT DEFAULT 'free',
                subscription_status TEXT DEFAULT 'active',
                subscription_expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_categorias (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                sync_id TEXT NOT NULL,
                nombre TEXT NOT NULL,
                tipo TEXT NOT NULL,
                color TEXT,
                icono TEXT,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_categorias_user ON cloud_categorias(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_movimientos (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                sync_id TEXT NOT NULL,
                tipo TEXT NOT NULL,
                monto DOUBLE PRECISION NOT NULL,
                descripcion TEXT,
                categoria_id INTEGER,
                categoria_sync_id TEXT,
                fecha TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_movimientos_user ON cloud_movimientos(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_metas_ahorro (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                sync_id TEXT NOT NULL,
                nombre TEXT NOT NULL,
                monto_objetivo DOUBLE PRECISION,
                monto_inicial DOUBLE PRECISION,
                fecha_objetivo TEXT,
                descripcion TEXT,
                estado TEXT,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_metas_ahorro_user ON cloud_metas_ahorro(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_gastos_programados (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                sync_id TEXT NOT NULL,
                descripcion TEXT,
                categoria_sync_id TEXT,
                monto_estimado DOUBLE PRECISION,
                fecha_vencimiento TEXT,
                estado TEXT,
                es_recurrente INTEGER,
                frecuencia TEXT,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_gastos_programados_user ON cloud_gastos_programados(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_gastos_fijos (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                sync_id TEXT NOT NULL,
                descripcion TEXT,
                categoria_sync_id TEXT,
                monto DOUBLE PRECISION,
                dia_vencimiento INTEGER,
                activo INTEGER,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_gastos_fijos_user ON cloud_gastos_fijos(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_presupuestos (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                sync_id TEXT NOT NULL,
                categoria_sync_id TEXT,
                mes INTEGER,
                anio INTEGER,
                monto DOUBLE PRECISION,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_presupuestos_user ON cloud_presupuestos(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_tags (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                sync_id TEXT NOT NULL,
                nombre TEXT NOT NULL,
                color TEXT,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_tags_user ON cloud_tags(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_movimiento_tags (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                sync_id TEXT NOT NULL,
                movimiento_sync_id TEXT NOT NULL,
                tag_sync_id TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                sync_status TEXT,
                remote_updated_at TEXT NOT NULL,
                UNIQUE(user_id, sync_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_movimiento_tags_user ON cloud_movimiento_tags(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_devices (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                device_id TEXT NOT NULL,
                device_name TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                UNIQUE(user_id, device_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_devices_user ON cloud_devices(user_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS google_login_requests (
                login_request_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                user_id TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_google_login_requests_expires ON google_login_requests(expires_at)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_refresh_tokens (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                revoked_at TEXT,
                last_used_at TEXT,
                device_id TEXT,
                device_name TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_user ON cloud_refresh_tokens(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_expires ON cloud_refresh_tokens(expires_at)")
        _ensure_google_auth_columns(conn)
        _ensure_refresh_token_columns(conn)
        _ensure_security_audit_schema(conn)
        _ensure_billing_columns(conn)
        _ensure_email_verification_schema(conn)
        _ensure_device_verification_schema(conn)
        # Historical sync timestamp updates can touch many rows. Keep their
        # transaction out of the advisory-locked DDL phase.
        _ensure_cloud_sync_schema(conn, backfill=False)
    with connect() as conn:
        _configure_postgres_migration_transaction(conn, acquire_lock=False)
        _backfill_cloud_sync_timestamps(conn)
