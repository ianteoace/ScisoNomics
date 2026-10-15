"""Only harness-owned external files, protected by Windows CurrentUser DPAPI."""
import ctypes
import json
import os
from pathlib import Path
from ctypes import wintypes

HEADER = b"SCISONOMICS_LOADTEST_DPAPI_V1\n"
REPO = Path(__file__).resolve().parents[2]


def external(path):
    resolved = Path(path).expanduser().resolve()
    if resolved.is_relative_to(REPO):
        raise ValueError("secret_or_result_path_inside_repo")
    return resolved


def dpapi(data, protect):
    if os.name != "nt":
        raise ValueError("windows_dpapi_required")

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    if protect:
        method = crypt32.CryptProtectData
        method.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.c_void_p,
                           ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        args = [ctypes.byref(source), "ScisoNomics staging loadtest", None, None, None, 1, ctypes.byref(output)]
    else:
        method = crypt32.CryptUnprotectData
        method.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                           ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        args = [ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)]
    method.restype = wintypes.BOOL
    try:
        if not method(*args):
            raise ValueError("dpapi_failed")
        return ctypes.string_at(output.data, output.size)
    finally:
        ctypes.memset(buffer, 0, len(buffer))
        if output.data:
            ctypes.memset(output.data, 0, output.size)
            kernel32.LocalFree(output.data)


def save(path, value):
    path = external(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    protected = HEADER + dpapi(json.dumps(value).encode("utf-8"), True)
    # All callers use fixed filenames in their dedicated harness state directory.
    temporary = path.with_suffix(path.suffix + ".new")
    with temporary.open("xb") as stream:
        stream.write(protected)
    os.replace(temporary, path)


def read(path):
    data = external(path).read_bytes()
    if not data.startswith(HEADER) or len(data) > 131072:
        raise ValueError("not_a_harness_secret_file")
    return json.loads(dpapi(data[len(HEADER):], False))
