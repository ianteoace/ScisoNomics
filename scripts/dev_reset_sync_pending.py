from __future__ import annotations

import os
import sqlite3
from pathlib import Path


def get_db_path() -> Path:
    local_appdata = os.environ.get("LOCALAPPDATA")
    if not local_appdata:
        raise RuntimeError("LOCALAPPDATA no esta definido.")
    return Path(local_appdata) / "RegistroFinanzas" / "data" / "finanzas.db"


def main() -> None:
    db_path = get_db_path()
    if not db_path.exists():
        raise FileNotFoundError(f"No existe la DB local: {db_path}")

    with sqlite3.connect(str(db_path)) as conn:
        conn.execute("UPDATE categorias SET sync_status = 'pending', last_synced_at = NULL")
        conn.execute("UPDATE movimientos SET sync_status = 'pending', last_synced_at = NULL")

    print("Estado de sync local reseteado a pending para categorias y movimientos.")
    print(db_path)


if __name__ == "__main__":
    main()
