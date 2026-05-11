from __future__ import annotations

from datetime import date, datetime
from tkinter import Toplevel, ttk, StringVar, messagebox

from ..services import FinanceService
from .formatting import format_currency
from .gasto_programado_dialog import GastoProgramadoDialog
from .theme import COLORS, apply_theme


FILTER_MAP = {
    "Todos": (None, None),
    "Pendientes": ("pendiente", None),
    "Pagados": ("pagado", None),
    "Cancelados": ("cancelado", None),
    "Próximos 7 días": ("pendiente", 7),
    "Próximos 15 días": ("pendiente", 15),
    "Próximos 30 días": ("pendiente", 30),
}


class PlanificacionWindow(Toplevel):
    def __init__(self, master, service: FinanceService, selected_month: int, selected_year: int, on_updated) -> None:
        super().__init__(master)
        self.title("Planificación de gastos")
        self.geometry("1120x620")
        apply_theme(self)
        self.configure(bg=COLORS["bg_app"])
        self.service = service
        self.selected_month = selected_month
        self.selected_year = selected_year
        self.on_updated = on_updated

        self.filter_var = StringVar(value="Todos")
        self.total_pendiente_var = StringVar(value="0.00")
        self.total_vencido_var = StringVar(value="0.00")
        self.total_pagado_mes_var = StringVar(value="0.00")
        self.balance_proyectado_var = StringVar(value="0.00")

        self._build()
        self.refresh()
        self._update_buttons_state()

        self.grab_set()
        self.transient(master)

    def _build(self) -> None:
        root = ttk.Frame(self, style="App.TFrame", padding=10)
        root.pack(fill="both", expand=True)

        top = ttk.LabelFrame(root, text="Filtros y acciones", style="Panel.TLabelframe", padding=8)
        top.pack(fill="x", pady=(0, 10))

        ttk.Label(top, text="Filtro").grid(row=0, column=0, padx=6, pady=6, sticky="w")
        box = ttk.Combobox(top, textvariable=self.filter_var, values=list(FILTER_MAP.keys()), state="readonly", width=20)
        box.grid(row=0, column=1, padx=6, pady=6, sticky="w")
        box.bind("<<ComboboxSelected>>", lambda _e: self.refresh())

        ttk.Button(top, text="Agregar", command=self._add).grid(row=0, column=2, padx=4)
        self.edit_btn = ttk.Button(top, text="Editar", command=self._edit)
        self.edit_btn.grid(row=0, column=3, padx=4)
        self.delete_btn = ttk.Button(top, text="Eliminar", command=self._delete)
        self.delete_btn.grid(row=0, column=4, padx=4)
        self.pay_btn = ttk.Button(top, text="Marcar como pagado", command=self._mark_paid)
        self.pay_btn.grid(row=0, column=5, padx=4)
        ttk.Button(top, text="Refrescar", command=self.refresh).grid(row=0, column=6, padx=4)

        summary = ttk.LabelFrame(root, text="Resumen proyectado", style="Panel.TLabelframe", padding=8)
        summary.pack(fill="x", pady=(0, 10))
        ttk.Label(summary, text="Pendiente próximos 30 días:").grid(row=0, column=0, padx=6, pady=4, sticky="w")
        ttk.Label(summary, textvariable=self.total_pendiente_var).grid(row=0, column=1, padx=6, pady=4, sticky="w")
        ttk.Label(summary, text="Total vencido:").grid(row=0, column=2, padx=6, pady=4, sticky="w")
        ttk.Label(summary, textvariable=self.total_vencido_var).grid(row=0, column=3, padx=6, pady=4, sticky="w")
        ttk.Label(summary, text="Total pagado este mes:").grid(row=1, column=0, padx=6, pady=4, sticky="w")
        ttk.Label(summary, textvariable=self.total_pagado_mes_var).grid(row=1, column=1, padx=6, pady=4, sticky="w")
        ttk.Label(summary, text="Balance proyectado del mes:").grid(row=1, column=2, padx=6, pady=4, sticky="w")
        ttk.Label(summary, textvariable=self.balance_proyectado_var).grid(row=1, column=3, padx=6, pady=4, sticky="w")

        table_frame = ttk.LabelFrame(root, text="Gastos programados", style="Panel.TLabelframe", padding=8)
        table_frame.pack(fill="both", expand=True)

        cols = ("id", "fecha_vencimiento", "categoria", "descripcion", "monto_estimado", "estado", "recurrente", "frecuencia")
        self.tree = ttk.Treeview(table_frame, columns=cols, show="headings", height=16)
        self.tree.pack(side="left", fill="both", expand=True)
        yscroll = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        yscroll.pack(side="right", fill="y")
        self.tree.configure(yscrollcommand=yscroll.set)

        for col, text, width, anchor in [
            ("id", "ID", 50, "center"),
            ("fecha_vencimiento", "Fecha vencimiento", 130, "center"),
            ("categoria", "Categoría", 150, "center"),
            ("descripcion", "Descripción", 280, "w"),
            ("monto_estimado", "Monto estimado", 120, "e"),
            ("estado", "Estado", 100, "center"),
            ("recurrente", "Recurrente", 90, "center"),
            ("frecuencia", "Frecuencia", 100, "center"),
        ]:
            self.tree.heading(col, text=text)
            self.tree.column(col, width=width, anchor=anchor)

        self.tree.tag_configure("vencido", background=COLORS["warn_red_bg"], foreground=COLORS["warn_red_fg"])
        self.tree.tag_configure("hoy", background=COLORS["warn_orange_bg"], foreground=COLORS["warn_orange_fg"])
        self.tree.tag_configure("proximo", background=COLORS["ok_aqua_bg"], foreground=COLORS["ok_aqua_fg"])

        self.tree.bind("<<TreeviewSelect>>", self._update_buttons_state)
        self.tree.bind("<Double-1>", lambda _e: self._edit())

    def _selected_id(self) -> int | None:
        selected = self.tree.selection()
        if not selected:
            return None
        return int(self.tree.item(selected[0], "values")[0])

    def _update_buttons_state(self, _event=None) -> None:
        selected_id = self._selected_id()
        state = "normal" if selected_id is not None else "disabled"
        self.edit_btn.configure(state=state)
        self.delete_btn.configure(state=state)

        pay_state = "disabled"
        if selected_id is not None:
            values = self.tree.item(self.tree.selection()[0], "values")
            if values[5] == "pendiente":
                pay_state = "normal"
        self.pay_btn.configure(state=pay_state)

    def refresh(self) -> None:
        for item in self.tree.get_children():
            self.tree.delete(item)

        estado, dias = FILTER_MAP.get(self.filter_var.get(), (None, None))
        rows = self.service.get_gastos_programados(estado, dias)
        today = date.today()

        for row in rows:
            vencimiento = datetime.strptime(row["fecha_vencimiento"], "%Y-%m-%d").date()
            tags = ()
            if row["estado"] == "pendiente":
                if vencimiento < today:
                    tags = ("vencido",)
                elif vencimiento == today:
                    tags = ("hoy",)
                elif (vencimiento - today).days <= 3:
                    tags = ("proximo",)

            self.tree.insert(
                "",
                "end",
                values=(
                    row["id"],
                    row["fecha_vencimiento"],
                    row["categoria"],
                    row["descripcion"],
                    format_currency(row["monto_estimado"]),
                    row["estado"],
                    "Sí" if row["es_recurrente"] else "No",
                    row["frecuencia"] or "-",
                ),
                tags=tags,
            )

        self._load_summary()
        self._update_buttons_state()

    def _load_summary(self) -> None:
        resumen = self.service.get_planificacion_resumen(self.selected_month, self.selected_year)
        self.total_pendiente_var.set(format_currency(resumen["total_pendiente_30_dias"]))
        self.total_vencido_var.set(format_currency(resumen["total_vencido"]))
        self.total_pagado_mes_var.set(format_currency(resumen["total_pagado_mes"]))
        self.balance_proyectado_var.set(format_currency(resumen["balance_proyectado_mes"]))

    def _add(self) -> None:
        GastoProgramadoDialog(self, self.service, self._after_change)

    def _edit(self) -> None:
        gasto_id = self._selected_id()
        if gasto_id is None:
            messagebox.showwarning("Atención", "Selecciona un gasto programado para editar.")
            return
        gasto = self.service.get_gasto_programado(gasto_id)
        if not gasto:
            messagebox.showerror("Error", "No se encontró el gasto programado seleccionado.")
            return
        GastoProgramadoDialog(self, self.service, self._after_change, gasto)

    def _delete(self) -> None:
        gasto_id = self._selected_id()
        if gasto_id is None:
            messagebox.showwarning("Atención", "Selecciona un gasto programado para eliminar.")
            return
        if not messagebox.askyesno("Confirmar", "¿Deseas eliminar el gasto programado?"):
            return
        self.service.delete_gasto_programado(gasto_id)
        messagebox.showinfo("Éxito", "Gasto programado eliminado correctamente.")
        self._after_change()

    def _mark_paid(self) -> None:
        gasto_id = self._selected_id()
        if gasto_id is None:
            messagebox.showwarning("Atención", "Selecciona un gasto programado para marcar como pagado.")
            return
        try:
            result = self.service.marcar_gasto_programado_pagado(gasto_id)
            if result["changed"]:
                if result["is_recurrent"] and result["generated_next"]:
                    messagebox.showinfo("Éxito", "Gasto marcado como pagado y próximo vencimiento generado.")
                else:
                    messagebox.showinfo("Éxito", "Gasto marcado como pagado.")
            else:
                messagebox.showinfo("Información", "El gasto seleccionado ya estaba pagado.")
            self._after_change()
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo marcar como pagado: {exc}")

    def _after_change(self) -> None:
        self.refresh()
        self.on_updated()
