from __future__ import annotations

import os
import sqlite3
from pathlib import Path


def get_database_path() -> Path:
    database_url = os.getenv("SCISONOMICS_CLOUD_DATABASE_URL", "").strip()
    if database_url.startswith("sqlite:///"):
        return Path(database_url.replace("sqlite:///", "", 1)).expanduser().resolve()
    if database_url:
        raise RuntimeError("El backend cloud de desarrollo solo soporta sqlite:/// por ahora.")
    return Path(__file__).resolve().parents[1] / "scisonomics_cloud_dev.db"


def connect() -> sqlite3.Connection:
    db_path = get_database_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
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
