from __future__ import annotations

import os
import signal
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import uvicorn

try:
    import psutil
except ImportError:
    psutil = None

_WATCHDOG_MARKER = "watchdog-entrypoint-v1"


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


def _watchdog_log(message: str) -> None:
    try:
        local_appdata = os.environ.get("LOCALAPPDATA")
        logs_dir = (
            Path(local_appdata) / "ScisoNomics" / "logs"
            if local_appdata
            else Path.home() / "AppData" / "Local" / "ScisoNomics" / "logs"
        )
        logs_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with (logs_dir / "watchdog.log").open("a", encoding="utf-8") as fh:
            fh.write(f"{stamp} {message}\n")
    except OSError:
        pass


def _watch_parent(parent_pid: int) -> None:
    while True:
        time.sleep(3)
        if not _parent_is_alive(parent_pid):
            _watchdog_log(f"parent_missing monitored_pid={parent_pid} backend_pid={os.getpid()} action=os._exit")
            os._exit(0)
            return


def _shutdown_on_signal(_signum: int, _frame: object) -> None:
    _watchdog_log(f"signal_shutdown backend_pid={os.getpid()}")
    sys.exit(0)


def _install_signal_handlers() -> None:
    signal.signal(signal.SIGTERM, _shutdown_on_signal)
    sigbreak = getattr(signal, "SIGBREAK", None)
    if sigbreak is not None:
        signal.signal(sigbreak, _shutdown_on_signal)


def _start_parent_watchdog() -> None:
    env_pid = os.environ.get("SCISONOMICS_PARENT_PID", "").strip()
    try:
        parent_pid = int(env_pid) if env_pid else 0
    except ValueError:
        parent_pid = 0
    if not parent_pid:
        parent_pid = os.getppid()
    _watchdog_log(
        f"startup marker={_WATCHDOG_MARKER} frozen={bool(getattr(sys, 'frozen', False))} "
        f"executable={sys.executable} backend_pid={os.getpid()} os_ppid={os.getppid()} "
        f"parent_env_present={bool(env_pid)} monitored_pid={parent_pid}"
    )
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
