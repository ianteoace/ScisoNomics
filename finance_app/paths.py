from __future__ import annotations

import os
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path

APP_FOLDER_NAME = "RegistroFinanzas"
BACKEND_LOGS_FOLDER_NAME = "ScisoNomics"


def get_app_data_dir() -> Path:
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        return Path(local_appdata) / APP_FOLDER_NAME
    return Path.home() / "AppData" / "Local" / APP_FOLDER_NAME


def get_data_dir() -> Path:
    return get_app_data_dir() / "data"


def get_db_path() -> Path:
    return get_data_dir() / "finanzas.db"


def get_config_path() -> Path:
    return get_data_dir() / "config.json"


def get_backup_dir() -> Path:
    return get_app_data_dir() / "backups"


def get_logs_dir() -> Path:
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        return Path(local_appdata) / BACKEND_LOGS_FOLDER_NAME / "logs"
    return Path.home() / "AppData" / "Local" / BACKEND_LOGS_FOLDER_NAME / "logs"


def ensure_app_data_layout() -> None:
    app_dir = get_app_data_dir()
    data_dir = get_data_dir()
    logs_dir = get_logs_dir()
    app_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
    get_backup_dir().mkdir(parents=True, exist_ok=True)
    try:
        logs_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        # No frenar el arranque si no se puede crear logs.
        pass
    _migrate_best_legacy_db(
        new_db_path=get_db_path(),
        candidates=[
            Path.cwd() / "data" / "finanzas.db",
            Path.cwd() / "dist" / "data" / "finanzas.db",
        ],
    )
    _migrate_legacy_file(Path.cwd() / "data" / "config.json", get_config_path())


def _migrate_legacy_file(old_path: Path, new_path: Path) -> None:
    if new_path.exists() or not old_path.exists():
        return
    new_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(old_path, new_path)


def _migrate_best_legacy_db(new_db_path: Path, candidates: list[Path]) -> None:
    # La DB oficial nunca debe ser reemplazada automaticamente.
    if new_db_path.exists():
        return

    existing_candidates = [path for path in candidates if path.exists()]
    if not existing_candidates:
        return

    best_source = _pick_db_with_more_movements(existing_candidates)
    if best_source is None:
        # Si existen DBs anteriores pero ninguna puede leerse, no crear una DB
        # vacia: ocultaria datos recuperables y haria parecer que se perdieron.
        found = ", ".join(f"{path.parent.name}/{path.name}" for path in existing_candidates)
        _append_layout_log(f"legacy_db_migration_failed reason=no_readable_candidate files={found}")
        raise RuntimeError(
            "Encontramos bases de datos anteriores pero no pudimos leerlas "
            f"({found}). No se creo una base nueva. Revisa esos archivos o restaura una copia de seguridad."
        )

    new_db_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copy2(best_source, new_db_path)
    except OSError as exc:
        # Fallar de forma explicita evita continuar con una DB nueva cuando la
        # copia legacy existe pero Windows no permite migrarla.
        raise RuntimeError(
            "Encontramos una base de datos anterior pero no pudimos copiarla "
            f"({best_source.parent.name}/{best_source.name}). Cerra ScisoNomics y volve a intentar."
        ) from exc
    _append_layout_log(f"legacy_db_migrated source_file={best_source.name} source_parent={best_source.parent.name}")


def _pick_db_with_more_movements(paths: list[Path]) -> Path | None:
    ranked: list[tuple[int, float, Path]] = []
    for path in paths:
        if not path.exists():
            continue
        count = _safe_count_movimientos(path)
        if count is None:
            continue
        ranked.append((count, path.stat().st_mtime, path))

    if not ranked:
        return None
    ranked.sort(reverse=True)
    return ranked[0][2]


def _safe_count_movimientos(db_path: Path) -> int | None:
    try:
        with closing(sqlite3.connect(db_path)) as conn:
            row = conn.execute("SELECT COUNT(*) FROM movimientos").fetchone()
        return int(row[0]) if row else 0
    except Exception:
        return None


def _append_layout_log(message: str) -> None:
    try:
        log_dir = get_logs_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with (log_dir / "backend-startup.log").open("a", encoding="utf-8") as fh:
            fh.write(f"{stamp} [paths] {message}\n")
    except OSError:
        pass
