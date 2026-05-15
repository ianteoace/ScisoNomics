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
