from __future__ import annotations

import json

from .paths import ensure_app_data_layout, get_config_path

CONFIG_PATH = get_config_path()


def load_filters(default_month: int, default_year: int) -> tuple[int, int, str]:
    ensure_app_data_layout()
    if not CONFIG_PATH.exists():
        return default_month, default_year, "todos"
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        month = int(data.get("month", default_month))
        year = int(data.get("year", default_year))
        move_type = str(data.get("move_type", "todos")).lower()
        if move_type not in ("todos", "ingreso", "gasto"):
            move_type = "todos"
        if 1 <= month <= 12:
            return month, year, move_type
    except Exception:
        pass
    return default_month, default_year, "todos"


def save_filters(month: int, year: int, move_type: str = "todos") -> None:
    ensure_app_data_layout()
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"month": int(month), "year": int(year), "move_type": move_type}
    CONFIG_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
