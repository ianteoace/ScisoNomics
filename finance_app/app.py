from __future__ import annotations

import tkinter as tk
from tkinter import messagebox

from .backup import create_backup_if_exists
from .db import Database
from .paths import ensure_app_data_layout, get_backup_dir
from .services import FinanceService
from .ui.main_window import MainWindow


def run() -> None:
    ensure_app_data_layout()
    db = Database()
    create_backup_if_exists(db.db_path, get_backup_dir(), keep_last=10)
    db.init_db()
    service = FinanceService(db)

    root = tk.Tk()
    root.title("Registro de Finanzas Personales")
    root.geometry("980x620")

    def handle_tk_exception(exc_type, exc_value, _exc_traceback):
        messagebox.showerror("Error inesperado", f"Ocurrio un error:\n{exc_value}")

    root.report_callback_exception = handle_tk_exception

    MainWindow(root, service)
    root.mainloop()
