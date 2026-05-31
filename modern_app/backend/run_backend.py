from __future__ import annotations

import os
import signal
import sys
import threading
import time
from pathlib import Path

import uvicorn

try:
    import psutil
except ImportError:
    psutil = None


def _ensure_project_on_path() -> None:
    project_root = Path(__file__).resolve().parents[2]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))


def _parent_is_alive(parent_pid: int) -> bool:
    if psutil is not None:
        return psutil.pid_exists(parent_pid)
    if sys.platform == "win32":
        # En Windows os.kill(pid, 0) no es un probe POSIX seguro: usar una
        # consulta nativa evita terminar accidentalmente el proceso padre.
        import ctypes

        synchronize = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, parent_pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(parent_pid, 0)
        return True
    except OSError:
        return False


def _watch_parent(parent_pid: int) -> None:
    while True:
        time.sleep(3)
        if not _parent_is_alive(parent_pid):
            print("El proceso principal termino; cerrando backend local.", file=sys.stderr)
            os.kill(os.getpid(), signal.SIGTERM)
            return


def _shutdown_on_signal(_signum: int, _frame: object) -> None:
    sys.exit(0)


def _install_signal_handlers() -> None:
    signal.signal(signal.SIGTERM, _shutdown_on_signal)
    sigbreak = getattr(signal, "SIGBREAK", None)
    if sigbreak is not None:
        signal.signal(sigbreak, _shutdown_on_signal)


def _start_parent_watchdog() -> None:
    parent_pid = os.getppid()
    threading.Thread(target=_watch_parent, args=(parent_pid,), daemon=True).start()


def main() -> None:
    _ensure_project_on_path()
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    # main() corre una sola vez: uvicorn no usa reload ni workers en el sidecar.
    _install_signal_handlers()
    _start_parent_watchdog()
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, log_level="info")


if __name__ == "__main__":
    main()
