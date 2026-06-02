from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any


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


def connect() -> CloudConnection:
    return CloudConnection()


def init_db() -> None:
    if get_database_engine() == "postgresql":
        _init_postgres()
    else:
        _init_sqlite()


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
        WHERE table_name = ? AND column_name = ?
        """,
        (table, column),
    ).fetchone()
    if not row:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _ensure_origin_columns(conn: CloudConnection) -> None:
    for table in SYNC_CLOUD_TABLES:
        _ensure_column(conn, table, "last_modified_device_id", "TEXT")
        _ensure_column(conn, table, "last_modified_device_name", "TEXT")
        _ensure_column(conn, table, "last_modified_at", "TEXT")


def _ensure_cloud_sync_schema(conn: CloudConnection) -> None:
    for table in SYNC_CLOUD_TABLES:
        for column, definition in COMMON_SYNC_COLUMN_DEFINITIONS.items():
            _ensure_column(conn, table, column, definition)
        for column, definition in CLOUD_SYNC_COLUMN_DEFINITIONS.get(table, {}).items():
            _ensure_column(conn, table, column, definition)
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
    if conn.engine == "sqlite":
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL AND google_sub <> ''")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_email_normalized ON users(LOWER(TRIM(email)))")
    else:
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL AND google_sub <> ''")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_email_normalized ON users(LOWER(TRIM(email)))")


def _init_sqlite() -> None:
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                display_name TEXT,
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
                access_token TEXT,
                user_id TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_google_login_requests_expires ON google_login_requests(expires_at)")
        _ensure_google_auth_columns(conn)
        _ensure_cloud_sync_schema(conn)


def _init_postgres() -> None:
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                display_name TEXT,
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
                access_token TEXT,
                user_id TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_google_login_requests_expires ON google_login_requests(expires_at)")
        _ensure_google_auth_columns(conn)
        _ensure_cloud_sync_schema(conn)
