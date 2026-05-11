from __future__ import annotations

from datetime import datetime
from pathlib import Path


def create_backup_if_exists(db_path: Path, backup_dir: Path, keep_last: int = 10) -> None:
    if not db_path.exists():
        return

    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    target = backup_dir / f"finanzas_{stamp}.db"
    target.write_bytes(db_path.read_bytes())

    backups = sorted(backup_dir.glob("finanzas_*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old_file in backups[keep_last:]:
        old_file.unlink(missing_ok=True)
