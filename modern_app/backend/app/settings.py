from __future__ import annotations

from pathlib import Path
from finance_app.paths import get_data_dir, get_db_path

PROJECT_ROOT = Path(__file__).resolve().parents[3]

# Fuente de datos estable para app web/desktop:
# C:\Users\<usuario>\AppData\Local\RegistroFinanzas\data\finanzas.db
MAIN_DATA_DIR = get_data_dir()
WEB_DB_PATH = get_db_path()

# Fallback de migracion inicial desde el repo, solo si la DB de AppData no existe.
PROJECT_DATA_DIR = PROJECT_ROOT / "data"
ORIGINAL_DB_PATH = PROJECT_DATA_DIR / "finanzas.db"
