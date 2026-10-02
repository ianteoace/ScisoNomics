"""Validate user-selected backups before reading or replacing application data."""
from contextlib import contextmanager
from pathlib import Path
import os
import stat

from .secure_backup import MAGIC, MAX_BACKUP_BYTES, NONCE_SIZE, SALT_SIZE

SQLITE_MAGIC = b"SQLite format 3\0"


def _is_link(info) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400  # Windows reparse point
    )


@contextmanager
def open_restore_source(source: Path, *, allow_encrypted: bool = False):
    source = Path(source)
    if not source.is_absolute():
        raise ValueError("Debes seleccionar una copia con una ruta absoluta.")
    if os.name == "nt" and any(":" in part for part in source.parts[1:]):
        raise ValueError("La ruta de la copia seleccionada no es valida.")
    allowed = {".db", ".sciso-backup"} if allow_encrypted else {".db"}
    if source.suffix.lower() not in allowed:
        raise ValueError("El formato de la copia seleccionada no es compatible.")
    try:
        for component in (source, *source.parents):
            if _is_link(component.lstat()):
                raise ValueError("Selecciona una copia directa, sin enlaces ni redirecciones.")
        expected = source.stat()
        if not stat.S_ISREG(expected.st_mode):
            raise ValueError("Debes seleccionar un archivo regular de copia de seguridad.")
        if not 0 < expected.st_size <= MAX_BACKUP_BYTES:
            raise ValueError("La copia esta vacia o supera el limite de 1 GiB.")
        source = source.resolve(strict=True)
        fd = os.open(source, os.O_RDONLY | getattr(os, "O_BINARY", 0)
                     | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError as exc:
        raise ValueError("La copia seleccionada no existe.") from exc
    except OSError as exc:
        raise ValueError("No se puede acceder a la copia seleccionada.") from exc
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or _is_link(info)
                or (info.st_dev, info.st_ino) != (expected.st_dev, expected.st_ino)
                or info.st_size != expected.st_size):
            raise ValueError("La copia seleccionada cambio. Seleccionala nuevamente.")
        header = handle.read(len(MAGIC))
        if source.suffix.lower() == ".db" and header.startswith(SQLITE_MAGIC):
            kind = "sqlite"
        elif (allow_encrypted and source.suffix.lower() == ".sciso-backup"
              and header == MAGIC and info.st_size > len(MAGIC) + SALT_SIZE + NONCE_SIZE + 16):
            kind = "encrypted"
        else:
            raise ValueError("El archivo no es una copia valida de ScisoNomics.")
        handle.seek(0)
        yield handle, kind


def copy_restore_source(source: Path, destination: Path, *, allow_encrypted: bool = False) -> str:
    with open_restore_source(source, allow_encrypted=allow_encrypted) as (handle, kind):
        with destination.open("wb") as output:
            total = 0
            while block := handle.read(1024 * 1024):
                total += len(block)
                if total > MAX_BACKUP_BYTES:
                    raise ValueError("La copia supera el limite de 1 GiB.")
                output.write(block)
        return kind
