from __future__ import annotations

import logging
import shutil
import threading
from pathlib import Path

from finance_app.db import Database
from finance_app.paths import ensure_app_data_layout, get_backup_dir, get_data_dir, get_logs_dir
from finance_app.services import FinanceService

from .settings import MAIN_DATA_DIR, ORIGINAL_DB_PATH, WEB_DB_PATH

_LAST_INIT_STATUS: dict[str, object] = {}
_DB_INSTANCE: Database | None = None
_DB_INIT_LOCK = threading.Lock()
_DB_INIT_DONE = False
_DB_INIT_ERROR: str | None = None
_DB_INITIALIZING = False
_LOGGER = logging.getLogger("scisonomics.backend")


def ensure_app_data_initialized() -> Database:
    global _DB_INSTANCE, _DB_INIT_DONE, _DB_INIT_ERROR, _DB_INITIALIZING
    if _DB_INIT_DONE and _DB_INSTANCE is not None:
        return _DB_INSTANCE

    if _DB_INITIALIZING:
        _LOGGER.info("[db] waiting for initialization lock")

    with _DB_INIT_LOCK:
        if _DB_INIT_DONE and _DB_INSTANCE is not None:
            _LOGGER.info("[db] initialization already done")
            return _DB_INSTANCE

        _DB_INITIALIZING = True
        _DB_INIT_ERROR = None
        try:
            _LOGGER.info("[db] initialization start")
            ensure_app_data_layout()
            created_now = not WEB_DB_PATH.exists()
            if not WEB_DB_PATH.exists():
                try:
                    if ORIGINAL_DB_PATH.exists():
                        MAIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(ORIGINAL_DB_PATH, WEB_DB_PATH)
                except OSError:
                    # Si copiar fallback falla, continuamos con DB limpia.
                    pass
            MAIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
            db = Database(db_path=WEB_DB_PATH)
            _LOGGER.info("[db] path: %s", db.db_path)
            db.init_db()
            _update_init_status(db, created_now=created_now)
            _DB_INSTANCE = db
            _DB_INIT_DONE = True
            _DB_INIT_ERROR = None
            _LOGGER.info("[db] initialization ready")
            return db
        except Exception as exc:
            _DB_INIT_ERROR = str(exc)
            _DB_INIT_DONE = False
            _LOGGER.exception("[db] initialization failed: %s", exc)
            raise
        finally:
            _DB_INITIALIZING = False


def get_last_init_status() -> dict[str, object]:
    status = dict(_LAST_INIT_STATUS)
    status.update(
        {
            "database_ready": bool(_DB_INIT_DONE and _DB_INSTANCE is not None),
            "initializing": _DB_INITIALIZING,
            "database_error": _DB_INIT_ERROR,
            "db_path": str(status.get("db_path", WEB_DB_PATH)),
        }
    )
    return status


def get_database_readiness() -> dict[str, object]:
    return get_last_init_status()


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
