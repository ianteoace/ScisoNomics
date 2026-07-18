from __future__ import annotations

from pathlib import Path
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt


MAGIC = b"SCISONOMICS_BACKUP_V1\n"
SALT_SIZE = 16
NONCE_SIZE = 12
MAX_BACKUP_BYTES = 1024 * 1024 * 1024


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    clean = str(passphrase or "")
    if len(clean) < 12 or len(clean) > 256:
        raise ValueError("La clave del backup debe tener entre 12 y 256 caracteres.")
    return Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(clean.encode("utf-8"))


def is_encrypted_backup(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(len(MAGIC)) == MAGIC
    except OSError:
        return False


def encrypt_backup(source: Path, destination: Path, passphrase: str) -> Path:
    size = source.stat().st_size
    if size <= 0 or size > MAX_BACKUP_BYTES:
        raise ValueError("El backup esta vacio o supera el tamano permitido.")
    salt = os.urandom(SALT_SIZE)
    nonce = os.urandom(NONCE_SIZE)
    key = _derive_key(passphrase, salt)
    encrypted = AESGCM(key).encrypt(nonce, source.read_bytes(), MAGIC)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(MAGIC + salt + nonce + encrypted)
    return destination


def decrypt_backup(source: Path, destination: Path, passphrase: str) -> Path:
    size = source.stat().st_size
    if size <= len(MAGIC) + SALT_SIZE + NONCE_SIZE or size > MAX_BACKUP_BYTES:
        raise ValueError("El backup cifrado no es valido.")
    payload = source.read_bytes()
    if not payload.startswith(MAGIC):
        raise ValueError("El archivo no es un backup cifrado de ScisoNomics.")
    offset = len(MAGIC)
    salt = payload[offset:offset + SALT_SIZE]
    offset += SALT_SIZE
    nonce = payload[offset:offset + NONCE_SIZE]
    ciphertext = payload[offset + NONCE_SIZE:]
    try:
        clear = AESGCM(_derive_key(passphrase, salt)).decrypt(nonce, ciphertext, MAGIC)
    except Exception as exc:
        raise ValueError("La clave del backup es incorrecta o el archivo fue alterado.") from exc
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(clear)
    return destination
