from __future__ import annotations

import shutil
from pathlib import Path

from finance_app.db import Database
from finance_app.paths import ensure_app_data_layout, get_backup_dir, get_data_dir, get_logs_dir
from finance_app.services import FinanceService

from .settings import MAIN_DATA_DIR, ORIGINAL_DB_PATH, WEB_DB_PATH

_LAST_INIT_STATUS: dict[str, object] = {}


def ensure_app_data_initialized() -> Database:
    ensure_app_data_layout()
    created_now = not WEB_DB_PATH.exists()
    if WEB_DB_PATH.exists():
        db = Database(db_path=WEB_DB_PATH)
        db.init_db()
        _update_init_status(db, created_now=created_now)
        return db
    try:
        if ORIGINAL_DB_PATH.exists():
            MAIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ORIGINAL_DB_PATH, WEB_DB_PATH)
    except OSError:
        # Si copiar fallback falla, continuamos con DB limpia.
        pass
    MAIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = Database(db_path=WEB_DB_PATH)
    db.init_db()
    _update_init_status(db, created_now=created_now)
    return db


def get_last_init_status() -> dict[str, object]:
    return dict(_LAST_INIT_STATUS)


def get_service() -> FinanceService:
    db = ensure_app_data_initialized()
    return FinanceService(db)


def _update_init_status(db: Database, created_now: bool) -> None:
    db_path = Path(db.db_path)
    db_exists = db_path.exists()
    db_initialized = False
    if db_exists:
        with db.connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('movimientos', 'categorias')"
            ).fetchone()
            db_initialized = bool(row and int(row[0]) >= 2)

    _LAST_INIT_STATUS.clear()
    _LAST_INIT_STATUS.update(
        {
            "db_path": str(db_path),
            "db_exists": db_exists,
            "db_initialized": db_initialized,
            "created_now": created_now,
            "data_dir": str(get_data_dir()),
            "backups_dir": str(get_backup_dir()),
            "logs_dir": str(get_logs_dir()),
        }
    )
