from __future__ import annotations

import os
import shutil
import sqlite3
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
    backup_dir = get_backup_dir()
    logs_dir = get_logs_dir()
    app_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
    backup_dir.mkdir(parents=True, exist_ok=True)
    try:
        logs_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        # No frenar el arranque si no se puede crear logs.
        pass
    _migrate_best_legacy_db(
        new_db_path=get_db_path(),
        backup_dir=backup_dir,
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


def _migrate_best_legacy_db(new_db_path: Path, backup_dir: Path, candidates: list[Path]) -> None:
    existing_candidates = [path for path in candidates if path.exists()]
    if not existing_candidates and new_db_path.exists():
        return

    best_source = _pick_db_with_more_movements([new_db_path, *existing_candidates])
    if best_source is None:
        # Fallback to legacy one-shot migration if schema/read fails.
        _migrate_legacy_file(Path.cwd() / "data" / "finanzas.db", new_db_path)
        return
    if best_source == new_db_path:
        return

    new_db_path.parent.mkdir(parents=True, exist_ok=True)
    if new_db_path.exists():
        _backup_file(new_db_path, backup_dir)
    shutil.copy2(best_source, new_db_path)


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
        with sqlite3.connect(db_path) as conn:
            row = conn.execute("SELECT COUNT(*) FROM movimientos").fetchone()
        return int(row[0]) if row else 0
    except Exception:
        return None


def _backup_file(path: Path, backup_dir: Path) -> None:
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    target = backup_dir / f"finanzas_pre_migracion_{stamp}.db"
    shutil.copy2(path, target)
