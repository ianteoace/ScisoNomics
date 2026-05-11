from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn


def _ensure_project_on_path() -> None:
    project_root = Path(__file__).resolve().parents[2]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))


def main() -> None:
    _ensure_project_on_path()
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, log_level="info")


if __name__ == "__main__":
    main()
