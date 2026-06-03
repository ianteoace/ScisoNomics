from __future__ import annotations

import logging
import sqlite3
import threading
from pathlib import Path
from typing import Any

from finance_app.db import Database
from finance_app.paths import ensure_app_data_layout, get_backup_dir, get_data_dir, get_logs_dir
from finance_app.services import FinanceService

from .settings import WEB_DB_PATH

_LAST_INIT_STATUS: dict[str, object] = {}
_DB_INSTANCE: Database | None = None
_DB_INIT_LOCK = threading.Lock()
_DB_INIT_DONE = False
_DB_INIT_ERROR: str | None = None
_DB_INIT_ERROR_TYPE: str | None = None
_DB_INITIALIZING = False
_LOGGER = logging.getLogger("scisonomics.backend")


def ensure_app_data_initialized() -> Database:
    global _DB_INSTANCE, _DB_INIT_DONE, _DB_INIT_ERROR, _DB_INIT_ERROR_TYPE, _DB_INITIALIZING
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
        _DB_INIT_ERROR_TYPE = None
        try:
            _LOGGER.info("[db] initialization start")
            ensure_app_data_layout()
            created_now = not WEB_DB_PATH.exists()
            # La migracion legacy vive en paths.py. No continuar con una DB vacia
            # si una copia alternativa falla: ocultaria datos existentes al usuario.
            db = Database(db_path=WEB_DB_PATH)
            _LOGGER.info("[db] file: %s", Path(db.db_path).name)
            db.init_db()
            _update_init_status(db, created_now=created_now)
            _DB_INSTANCE = db
            _DB_INIT_DONE = True
            _DB_INIT_ERROR = None
            _LOGGER.info("[db] initialization ready")
            return db
        except Exception as exc:
            _DB_INIT_ERROR = str(exc)
            _DB_INIT_ERROR_TYPE = type(exc).__name__
            _DB_INIT_DONE = False
            _LOGGER.exception("[db] initialization failed. error_type=%s", type(exc).__name__)
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
            "database_error_type": _DB_INIT_ERROR_TYPE,
            "db_path": str(status.get("db_path", WEB_DB_PATH)),
        }
    )
    return status


def get_database_readiness(*, ensure_started: bool = False) -> dict[str, object]:
    if ensure_started and not _DB_INIT_DONE and not _DB_INITIALIZING and _DB_INSTANCE is None and _DB_INIT_ERROR is None:
        start_database_initialization()

    status = get_last_init_status()
    if _DB_INIT_DONE and _DB_INSTANCE is not None:
        return {
            **status,
            "ok": True,
            "status": "ready",
            "code": "db_ready",
            "checked": True,
            "database_ready": True,
            "repairable": False,
            "sync_allowed": True,
            "message": "La base de datos local esta lista.",
        }
    if _DB_INITIALIZING:
        return {
            **status,
            "ok": False,
            "status": "degraded",
            "code": "db_initializing",
            "checked": True,
            "database_ready": False,
            "repairable": False,
            "sync_allowed": False,
            "message": "Estamos preparando tu base de datos local.",
        }
    if _DB_INIT_ERROR:
        return {
            **status,
            **_classify_database_error(_DB_INIT_ERROR, _DB_INIT_ERROR_TYPE),
            "checked": True,
            "database_ready": False,
            "ok": False,
        }
    return {
        **status,
        "ok": False,
        "status": "degraded",
        "code": "db_check_pending",
        "checked": False,
        "database_ready": False,
        "repairable": False,
        "sync_allowed": False,
        "message": "El backend local esta iniciando la revision de tus datos.",
    }


def invalidate_app_data_initialized() -> None:
    global _DB_INSTANCE, _DB_INIT_DONE, _DB_INIT_ERROR, _DB_INIT_ERROR_TYPE, _DB_INITIALIZING
    # Restore reemplaza el archivo de forma atomica. Invalidar el singleton obliga a que
    # el siguiente request abra e inicialice la DB restaurada, no el estado anterior.
    with _DB_INIT_LOCK:
        _DB_INSTANCE = None
        _DB_INIT_DONE = False
        _DB_INIT_ERROR = None
        _DB_INIT_ERROR_TYPE = None
        _DB_INITIALIZING = False


def get_service() -> FinanceService:
    db = ensure_app_data_initialized()
    return FinanceService(db)


def start_database_initialization(*, force_retry: bool = False) -> bool:
    if _DB_INIT_DONE or _DB_INITIALIZING:
        return False
    if _DB_INIT_ERROR and not force_retry:
        return False
    thread = threading.Thread(target=_background_database_initialization, name="scisonomics-db-init", daemon=True)
    thread.start()
    return True


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


def _background_database_initialization() -> None:
    try:
        ensure_app_data_initialized()
    except Exception:
        # El error ya queda registrado y clasificado via _DB_INIT_ERROR.
        return


def _extract_issue_table(message: str) -> str | None:
    lowered = message.lower()
    for table in ("tags", "categorias", "presupuestos", "movimientos", "movimiento_tags"):
        if table in lowered:
            return table
    return None


def _classify_database_error(message: str, error_type: str | None) -> dict[str, Any]:
    lowered = (message or "").lower()
    table = _extract_issue_table(message or "")

    if "database disk image is malformed" in lowered or "file is not a database" in lowered:
        return {
            "status": "critical",
            "code": "db_integrity_issue",
            "repairable": False,
            "sync_allowed": False,
            "issue_table": table,
            "error_type": error_type,
            "message": "Encontramos un problema critico en los datos locales. Revisa Datos y seguridad antes de continuar.",
        }
    if "requiere revision manual" in lowered or "requires manual review" in lowered:
        return {
            "status": "migration_failed",
            "code": "db_migration_failed",
            "repairable": False,
            "sync_allowed": False,
            "issue_table": table,
            "error_type": error_type,
            "message": "ScisoNomics abrio en modo reparacion porque una migracion local requiere revision manual.",
        }
    if "unique constraint failed" in lowered or "foreign_key_check" in lowered:
        return {
            "status": "repair_required",
            "code": "db_repair_required" if "unique constraint failed" in lowered else "db_integrity_issue",
            "repairable": True,
            "sync_allowed": False,
            "issue_table": table,
            "error_type": error_type,
            "message": "ScisoNomics abrio en modo reparacion porque tus datos locales necesitan una revision.",
        }
    if error_type in {"IntegrityError", "OperationalError", "DatabaseError"}:
        return {
            "status": "repair_required",
            "code": "db_integrity_issue",
            "repairable": True,
            "sync_allowed": False,
            "issue_table": table,
            "error_type": error_type,
            "message": "ScisoNomics abrio en modo reparacion porque tus datos locales necesitan una revision.",
        }
    return {
        "status": "critical",
        "code": "db_migration_failed",
        "repairable": False,
        "sync_allowed": False,
        "issue_table": table,
        "error_type": error_type,
        "message": "No pudimos preparar los datos locales. Revisa Datos y seguridad antes de continuar.",
    }
