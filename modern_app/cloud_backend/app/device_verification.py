from __future__ import annotations

import base64
from dataclasses import dataclass
from enum import Enum
import hashlib
import re
import struct
from typing import Final

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


DEVICE_PROOF_MAGIC: Final = b"SCISONOMICS-DEVICE-PROOF"
DEVICE_PROOF_VERSION: Final = 1
DEVICE_PROOF_LENGTH: Final = 237
DEVICE_PROOF_MAX_TTL_SECONDS: Final = 120
_BASE64URL_RE: Final = re.compile(r"^[A-Za-z0-9_-]+$")


class DeviceVerificationMode(str, Enum):
    OFF = "off"
    OBSERVE = "observe"
    ENFORCE = "enforce"


class DeviceProofPurpose(int, Enum):
    DEVICE_ENROLLMENT = 1
    DEVICE_AUTHENTICATION = 2
    REFRESH = 3
    DEVICE_RENAME = 4
    DEVICE_REVOKE = 5


def parse_device_verification_mode(raw: str | None) -> DeviceVerificationMode:
    value = raw or ""
    if not value or value == DeviceVerificationMode.OFF.value:
        return DeviceVerificationMode.OFF
    if value in {DeviceVerificationMode.OBSERVE.value, DeviceVerificationMode.ENFORCE.value}:
        raise RuntimeError("device_mode_not_implemented")
    raise RuntimeError("invalid_device_verification_mode")


def base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def base64url_decode(value: str, *, expected_length: int) -> bytes:
    if not isinstance(value, str) or not value or "=" in value or not _BASE64URL_RE.fullmatch(value):
        raise ValueError("Base64URL invalido.")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))
    except (ValueError, UnicodeEncodeError) as exc:
        raise ValueError("Base64URL invalido.") from exc
    if len(decoded) != expected_length or base64url_encode(decoded) != value:
        raise ValueError("Longitud o representacion Base64URL invalida.")
    return decoded


@dataclass(frozen=True)
class DeviceProofFields:
    purpose: DeviceProofPurpose
    account_binding: bytes
    device_id: bytes
    public_key_hash: bytes
    challenge_id: bytes
    nonce: bytes
    issued_at: int
    expires_at: int
    family_id: bytes | None = None
    target_device_id: bytes | None = None
    request_hash: bytes | None = None


def _require_bytes(name: str, value: bytes, length: int, *, allow_zero: bool = True) -> bytes:
    if not isinstance(value, bytes) or len(value) != length:
        raise ValueError(f"{name} debe medir {length} bytes.")
    if not allow_zero and not any(value):
        raise ValueError(f"{name} no puede ser cero.")
    return value


def _optional_slot(name: str, value: bytes | None, length: int) -> bytes:
    if value is None:
        return b"\x00" + bytes(length)
    return b"\x01" + _require_bytes(name, value, length, allow_zero=False)


def _validate_purpose_fields(fields: DeviceProofFields) -> None:
    expected = {
        DeviceProofPurpose.DEVICE_ENROLLMENT: (False, False, False),
        DeviceProofPurpose.DEVICE_AUTHENTICATION: (False, False, False),
        DeviceProofPurpose.REFRESH: (True, False, False),
        DeviceProofPurpose.DEVICE_RENAME: (True, True, True),
        DeviceProofPurpose.DEVICE_REVOKE: (True, True, False),
    }[fields.purpose]
    actual = (
        fields.family_id is not None,
        fields.target_device_id is not None,
        fields.request_hash is not None,
    )
    if actual != expected:
        raise ValueError("Combinacion de campos invalida para el proposito.")


def build_device_proof_message(fields: DeviceProofFields) -> bytes:
    if not isinstance(fields.purpose, DeviceProofPurpose):
        raise ValueError("Proposito V1 invalido.")
    _validate_purpose_fields(fields)
    if not isinstance(fields.issued_at, int) or not isinstance(fields.expires_at, int):
        raise ValueError("Los timestamps deben ser segundos UTC enteros.")
    if fields.issued_at < 0 or fields.expires_at < 0 or fields.expires_at > 0xFFFFFFFFFFFFFFFF:
        raise ValueError("Timestamp fuera de rango uint64.")
    ttl = fields.expires_at - fields.issued_at
    if ttl < 1 or ttl > DEVICE_PROOF_MAX_TTL_SECONDS:
        raise ValueError("TTL de device proof fuera de rango.")
    message = b"".join(
        (
            DEVICE_PROOF_MAGIC,
            bytes((DEVICE_PROOF_VERSION, fields.purpose.value)),
            _require_bytes("account_binding", fields.account_binding, 32, allow_zero=False),
            _require_bytes("device_id", fields.device_id, 16, allow_zero=False),
            _require_bytes("public_key_hash", fields.public_key_hash, 32),
            _require_bytes("challenge_id", fields.challenge_id, 16, allow_zero=False),
            _require_bytes("nonce", fields.nonce, 32),
            struct.pack(">QQ", fields.issued_at, fields.expires_at),
            _optional_slot("family_id", fields.family_id, 16),
            _optional_slot("target_device_id", fields.target_device_id, 16),
            _optional_slot("request_hash", fields.request_hash, 32),
        )
    )
    if len(message) != DEVICE_PROOF_LENGTH:
        raise AssertionError("Longitud interna inesperada para Device Proof V1.")
    return message


def _parse_slot(message: bytes, flag_offset: int, value_offset: int, length: int) -> bytes | None:
    flag = message[flag_offset]
    value = message[value_offset : value_offset + length]
    if flag == 0:
        if any(value):
            raise ValueError("Slot ausente con relleno no cero.")
        return None
    if flag != 1 or not any(value):
        raise ValueError("Slot opcional invalido.")
    return value


def parse_device_proof_message(message: bytes) -> DeviceProofFields:
    if not isinstance(message, bytes) or len(message) != DEVICE_PROOF_LENGTH:
        raise ValueError("Device Proof V1 debe medir exactamente 237 bytes.")
    if message[0:24] != DEVICE_PROOF_MAGIC or message[24] != DEVICE_PROOF_VERSION:
        raise ValueError("Magic o version de Device Proof invalida.")
    try:
        purpose = DeviceProofPurpose(message[25])
    except ValueError as exc:
        raise ValueError("Proposito V1 invalido.") from exc
    fields = DeviceProofFields(
        purpose=purpose,
        account_binding=message[26:58],
        device_id=message[58:74],
        public_key_hash=message[74:106],
        challenge_id=message[106:122],
        nonce=message[122:154],
        issued_at=struct.unpack(">Q", message[154:162])[0],
        expires_at=struct.unpack(">Q", message[162:170])[0],
        family_id=_parse_slot(message, 170, 171, 16),
        target_device_id=_parse_slot(message, 187, 188, 16),
        request_hash=_parse_slot(message, 204, 205, 32),
    )
    rebuilt = build_device_proof_message(fields)
    if rebuilt != message:
        raise ValueError("Serializacion Device Proof no canonica.")
    return fields


def verify_device_proof(public_key: bytes, signature: bytes, message: bytes) -> bool:
    _require_bytes("public_key", public_key, 32)
    _require_bytes("signature", signature, 64)
    fields = parse_device_proof_message(message)
    if hashlib.sha256(public_key).digest() != fields.public_key_hash:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
    except (InvalidSignature, ValueError):
        return False
    return True
