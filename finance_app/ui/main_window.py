from __future__ import annotations

from datetime import datetime
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from ..config import load_filters, save_filters
from ..exporter import export_filtered_movimientos, export_monthly_report, export_yearly_report
from ..services import FinanceService
from .categorias_window import CategoriasWindow
from .formatting import format_currency
from .gastos_fijos_window import GastosFijosWindow
from .movimiento_dialog import MovimientoDialog
from .planificacion_window import PlanificacionWindow
from .stats_window import StatsWindow
from .theme import COLORS, apply_theme


TYPE_MAP = {
    "Todos": "todos",
    "Ingresos": "ingreso",
    "Gastos": "gasto",
}


class MainWindow(ttk.Frame):
    def __init__(self, master: tk.Tk, service: FinanceService) -> None:
        super().__init__(master, padding=16)
        self.master = master
        self.service = service

        now = datetime.now()
        month, year, move_type = load_filters(now.month, now.year)
        self.month_var = tk.IntVar(value=month)
        self.year_var = tk.IntVar(value=year)
        self.type_label_var = tk.StringVar(value=self._label_from_type(move_type))

        self.saldo_inicial_var = tk.StringVar(value="0.00")
        self.ingresos_var = tk.StringVar(value="0.00")
        self.gastos_var = tk.StringVar(value="0.00")
        self.balance_final_var = tk.StringVar(value="0.00")
        self.ingresos_comp_var = tk.StringVar(value="Mes anterior: —")
        self.gastos_comp_var = tk.StringVar(value="Mes anterior: —")
        self.search_var = tk.StringVar(value="")
        self.visible_count_var = tk.StringVar(value="Movimientos visibles: 0")
        self.visible_total_var = tk.StringVar(value="Total visible: $ 0,00")
        self.current_rows: list[dict] = []
        self._refresh_job: str | None = None

        self._build_style()
        self.pack(fill="both", expand=True)
        self._build()
        self._bind_instant_filters()
        self.refresh_all()

    def _build_style(self) -> None:
        apply_theme(self.master)
        self.master.configure(bg=COLORS["bg_app"])

    def _build(self) -> None:
        self.configure(style="App.TFrame")

        top_panel = ttk.LabelFrame(self, text="Filtros y acciones", style="Panel.TLabelframe", padding=12)
        top_panel.pack(fill="x", pady=(0, 12))

        ttk.Label(top_panel, text="Mes").grid(row=0, column=0, padx=(0, 6), sticky="w")
        month_box = ttk.Combobox(top_panel, textvariable=self.month_var, width=5, state="readonly")
        month_box["values"] = tuple(range(1, 13))
        month_box.grid(row=0, column=1, padx=(0, 10), sticky="w")

        ttk.Label(top_panel, text="Año").grid(row=0, column=2, padx=(0, 6), sticky="w")
        years = tuple(range(datetime.now().year - 5, datetime.now().year + 6))
        year_box = ttk.Combobox(top_panel, textvariable=self.year_var, width=8, state="readonly")
        year_box["values"] = years
        year_box.grid(row=0, column=3, padx=(0, 10), sticky="w")

        ttk.Label(top_panel, text="Tipo").grid(row=0, column=4, padx=(0, 6), sticky="w")
        self.type_box = ttk.Combobox(top_panel, textvariable=self.type_label_var, width=12, state="readonly")
        self.type_box["values"] = tuple(TYPE_MAP.keys())
        self.type_box.grid(row=0, column=5, padx=(0, 12), sticky="w")

        ttk.Button(top_panel, text="Refrescar", command=self.refresh_all).grid(row=0, column=6, padx=4)
        ttk.Button(top_panel, text="Agregar movimiento", command=self.add_movimiento).grid(row=0, column=7, padx=4)
        self.edit_btn = ttk.Button(top_panel, text="Editar", command=self.edit_movimiento)
        self.edit_btn.grid(row=0, column=8, padx=4)
        self.delete_btn = ttk.Button(top_panel, text="Eliminar", command=self.delete_movimiento)
        self.delete_btn.grid(row=0, column=9, padx=4)

        ttk.Label(top_panel, text="Buscar").grid(row=1, column=0, padx=(0, 6), pady=(10, 0), sticky="w")
        search_entry = ttk.Entry(top_panel, textvariable=self.search_var, width=40)
        search_entry.grid(row=1, column=1, columnspan=5, padx=(0, 10), pady=(10, 0), sticky="w")

        nav = ttk.Frame(top_panel, style="App.TFrame")
        nav.grid(row=2, column=0, columnspan=10, sticky="w", pady=(10, 0))
        ttk.Button(nav, text="Gastos fijos", command=self.open_fixed_expenses).pack(side="left", padx=(0, 6))
        ttk.Button(nav, text="Planificación", command=self.open_planificacion).pack(side="left", padx=(0, 6))
        ttk.Button(nav, text="Categorías", command=self.open_categories).pack(side="left", padx=(0, 6))
        ttk.Button(nav, text="Estadísticas", command=self.open_stats).pack(side="left", padx=(0, 6))
        ttk.Button(nav, text="Aplicar gastos fijos", command=self.apply_fixed_expenses).pack(side="left", padx=(0, 6))
        ttk.Button(nav, text="Exportar filtrado", command=self.export_excel_filtered).pack(side="left", padx=(12, 6))
        ttk.Button(nav, text="Exportar mes", command=self.export_excel_month).pack(side="left", padx=(12, 6))
        ttk.Button(nav, text="Exportar año", command=self.export_excel_year).pack(side="left", padx=(0, 6))

        summary = ttk.LabelFrame(self, text="Resumen", style="Panel.TLabelframe", padding=10)
        summary.pack(fill="x", pady=(0, 12))
        self._build_card(summary, 0, "Saldo inicial", self.saldo_inicial_var, COLORS["accent_aqua"])
        self._build_card(summary, 1, "Ingresos", self.ingresos_var, COLORS["income_green"], self.ingresos_comp_var)
        self._build_card(summary, 2, "Gastos", self.gastos_var, COLORS["expense_red"], self.gastos_comp_var)
        self._build_card(summary, 3, "Balance final", self.balance_final_var, COLORS["accent_orange"])

        table_panel = ttk.LabelFrame(self, text="Movimientos", style="Panel.TLabelframe", padding=8)
        table_panel.pack(fill="both", expand=True)

        columns = ("fecha", "dia_semana", "tipo", "categoria", "descripcion", "monto", "saldo_acumulado")
        self.tree = ttk.Treeview(table_panel, columns=columns, show="headings", height=18)
        yscroll = ttk.Scrollbar(table_panel, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=yscroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        yscroll.pack(side="right", fill="y")

        for col, text, width in [
            ("fecha", "Fecha", 100),
            ("dia_semana", "Día", 90),
            ("tipo", "Tipo", 90),
            ("categoria", "Categoría", 170),
            ("descripcion", "Descripción", 300),
            ("monto", "Monto", 110),
            ("saldo_acumulado", "Saldo acumulado", 130),
        ]:
            self.tree.heading(col, text=text)
            anchor = "e" if col in ("monto", "saldo_acumulado") else "center"
            if col == "descripcion":
                anchor = "w"
            self.tree.column(col, width=width, anchor=anchor)
        self.tree.tag_configure("ingreso", foreground=COLORS["income_green"])
        self.tree.tag_configure("gasto", foreground=COLORS["expense_red"])
        self.tree.tag_configure("par", background=COLORS["table_even"])
        self.tree.tag_configure("impar", background=COLORS["table_odd"])

        self.empty_label = ttk.Label(table_panel, style="Empty.TLabel", text="No hay movimientos con esos filtros. Prueba otro mes, tipo o búsqueda.")
        footer = ttk.Frame(table_panel, style="Card.TFrame", padding=(4, 8, 4, 0))
        footer.pack(fill="x", side="bottom")
        ttk.Label(footer, textvariable=self.visible_count_var, style="Title.TLabel").pack(side="left", padx=(0, 12))
        ttk.Label(footer, textvariable=self.visible_total_var, style="Title.TLabel").pack(side="left")

        self.tree.bind("<Double-1>", lambda _e: self.edit_movimiento())
        self.tree.bind("<Return>", lambda _e: self.edit_movimiento())
        self.tree.bind("<Delete>", lambda _e: self.delete_movimiento())
        self.tree.bind("<<TreeviewSelect>>", self._update_buttons_state)
        self._update_buttons_state()

    def _bind_instant_filters(self) -> None:
        self.search_var.trace_add("write", self._on_filter_change)
        self.month_var.trace_add("write", self._on_filter_change)
        self.year_var.trace_add("write", self._on_filter_change)
        self.type_label_var.trace_add("write", self._on_filter_change)

    def _on_filter_change(self, *_args) -> None:
        self._schedule_refresh()

    def _schedule_refresh(self) -> None:
        if self._refresh_job:
            self.after_cancel(self._refresh_job)
        self._refresh_job = self.after(120, self.refresh_all)

    def _build_card(
        self,
        parent,
        column: int,
        title: str,
        value_var: tk.StringVar,
        color: str,
        subtitle_var: tk.StringVar | None = None,
    ) -> None:
        card = ttk.Frame(parent, style="Card.TFrame", padding=10)
        card.grid(row=0, column=column, padx=8, sticky="ew")
        parent.columnconfigure(column, weight=1)
        ttk.Label(card, text=title, style="Title.TLabel").pack(anchor="w")
        value = ttk.Label(card, textvariable=value_var, style="Value.TLabel")
        value.pack(anchor="w", pady=(4, 0))
        value.configure(foreground=color)
        if subtitle_var is not None:
            ttk.Label(card, textvariable=subtitle_var, style="Title.TLabel").pack(anchor="w", pady=(4, 0))

    def _current_type(self) -> str | None:
        value = TYPE_MAP.get(self.type_label_var.get(), "todos")
        return None if value == "todos" else value

    def _label_from_type(self, move_type: str) -> str:
        for label, value in TYPE_MAP.items():
            if value == move_type:
                return label
        return "Todos"

    def refresh_all(self) -> None:
        try:
            self._refresh_job = None
            save_filters(self.month_var.get(), self.year_var.get(), TYPE_MAP.get(self.type_label_var.get(), "todos"))
            self._load_movimientos()
            self._load_summary()
            self._update_buttons_state()
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo refrescar la vista: {exc}")

    def _load_movimientos(self) -> None:
        for item in self.tree.get_children():
            self.tree.delete(item)

        rows = self.service.list_movimientos(self.month_var.get(), self.year_var.get(), self._current_type())
        search = self.search_var.get().strip().lower()
        if search:
            rows = [
                row
                for row in rows
                if search in str(row.get("descripcion", "")).lower()
                or search in str(row.get("categoria", "")).lower()
                or search in str(row.get("fecha", "")).lower()
            ]

        self.current_rows = rows
        signed_total = 0.0
        for idx, row in enumerate(rows):
            signed_amount = float(row["monto"]) if row["tipo"] == "ingreso" else -float(row["monto"])
            signed_total += signed_amount
            self.tree.insert(
                "",
                "end",
                iid=str(row["id"]),
                values=(
                    row["fecha"],
                    self._weekday_name(int(row.get("dia_semana_num", 0))),
                    row["tipo"],
                    row["categoria"],
                    row["descripcion"],
                    format_currency(row["monto"]),
                    format_currency(row.get("saldo_acumulado", 0.0)),
                ),
                tags=(row["tipo"], "par" if idx % 2 == 0 else "impar"),
            )

        self.visible_count_var.set(f"Movimientos visibles: {len(rows)}")
        self.visible_total_var.set(f"Total visible: {format_currency(signed_total)}")

        if rows:
            self.empty_label.place_forget()
        else:
            self.empty_label.place(relx=0.5, rely=0.5, anchor="center")

    def _load_summary(self) -> None:
        totals = self.service.get_resumen_mensual_con_saldo(self.month_var.get(), self.year_var.get())
        self.saldo_inicial_var.set(format_currency(totals["saldo_inicial"]))
        self.ingresos_var.set(format_currency(totals["ingreso"]))
        self.gastos_var.set(format_currency(totals["gasto"]))
        self.balance_final_var.set(format_currency(totals["balance_final"]))
        self._load_month_comparison()

    def _load_month_comparison(self) -> None:
        current_month = self.month_var.get()
        current_year = self.year_var.get()
        prev_month = current_month - 1
        prev_year = current_year
        if prev_month == 0:
            prev_month = 12
            prev_year -= 1

        current_totals = self.service.get_month_totals(current_month, current_year)
        prev_totals = self.service.get_month_totals(prev_month, prev_year)

        self.ingresos_comp_var.set(
            self._comparison_text(
                float(current_totals["ingreso"]),
                float(prev_totals["ingreso"]),
                "ingresos",
            )
        )
        self.gastos_comp_var.set(
            self._comparison_text(
                float(current_totals["gasto"]),
                float(prev_totals["gasto"]),
                "gastos",
            )
        )

    def _comparison_text(self, current: float, previous: float, label: str) -> str:
        if previous == 0:
            return f"Mes anterior ({label}): —"
        variation = self.service.calculate_variation_percent(current, previous)
        if variation is None:
            return f"Mes anterior ({label}): —"
        sign = "+" if variation >= 0 else ""
        return f"Mes anterior ({label}): {format_currency(previous)} ({sign}{variation:.1f}%)"

    def _selected_id(self) -> int | None:
        selected = self.tree.selection()
        if not selected:
            return None
        return int(selected[0])

    def _weekday_name(self, weekday_number: int) -> str:
        names = {
            0: "Dom",
            1: "Lun",
            2: "Mar",
            3: "Mié",
            4: "Jue",
            5: "Vie",
            6: "Sáb",
        }
        return names.get(weekday_number, "")

    def _update_buttons_state(self, _event=None) -> None:
        state = "normal" if self._selected_id() is not None else "disabled"
        self.edit_btn.configure(state=state)
        self.delete_btn.configure(state=state)

    def add_movimiento(self) -> None:
        MovimientoDialog(self.master, self.service, self.refresh_all)

    def edit_movimiento(self) -> None:
        movement_id = self._selected_id()
        if movement_id is None:
            messagebox.showwarning("Atención", "Selecciona un movimiento para editar.")
            return
        try:
            movement = self.service.get_movimiento(movement_id)
            if movement is None:
                messagebox.showerror("Error", "No se encontró el movimiento seleccionado.")
                return
            MovimientoDialog(self.master, self.service, self.refresh_all, movement)
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo abrir el movimiento: {exc}")

    def delete_movimiento(self) -> None:
        movement_id = self._selected_id()
        if movement_id is None:
            messagebox.showwarning("Atención", "Selecciona un movimiento para eliminar.")
            return
        if not messagebox.askyesno("Confirmar eliminación", "¿Deseas eliminar el movimiento seleccionado?"):
            return
        try:
            self.service.delete_movimiento(movement_id)
            messagebox.showinfo("Éxito", "Movimiento eliminado correctamente.")
            self.refresh_all()
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo eliminar el movimiento: {exc}")

    def open_fixed_expenses(self) -> None:
        GastosFijosWindow(self.master, self.service, self.refresh_all)

    def open_categories(self) -> None:
        CategoriasWindow(self.master, self.service, self.refresh_all)

    def open_planificacion(self) -> None:
        PlanificacionWindow(
            self.master,
            self.service,
            self.month_var.get(),
            self.year_var.get(),
            self.refresh_all,
        )

    def apply_fixed_expenses(self) -> None:
        try:
            inserted = self.service.apply_fixed_expenses_for_month(self.month_var.get(), self.year_var.get())
            self.refresh_all()
            messagebox.showinfo("Gastos fijos", f"Se agregaron {inserted} gastos fijos para el mes.")
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudieron aplicar gastos fijos: {exc}")

    def open_stats(self) -> None:
        StatsWindow(
            self.master,
            self.service,
            self.month_var.get(),
            self.year_var.get(),
            TYPE_MAP.get(self.type_label_var.get(), "todos"),
        )

    def export_excel_month(self) -> None:
        default_name = f"movimientos_{self.year_var.get()}_{self.month_var.get():02d}.xlsx"
        path_str = filedialog.asksaveasfilename(
            title="Exportar movimientos del mes",
            defaultextension=".xlsx",
            initialfile=default_name,
            filetypes=[("Excel", "*.xlsx")],
        )
        if not path_str:
            return
        try:
            output = export_monthly_report(self.service, self.month_var.get(), self.year_var.get(), Path(path_str))
            messagebox.showinfo("Exportación", f"Archivo exportado en:\n{output}")
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo exportar el mes: {exc}")

    def export_excel_year(self) -> None:
        default_name = f"finanzas_{self.year_var.get()}.xlsx"
        path_str = filedialog.asksaveasfilename(
            title="Exportar movimientos del año",
            defaultextension=".xlsx",
            initialfile=default_name,
            filetypes=[("Excel", "*.xlsx")],
        )
        if not path_str:
            return
        try:
            output = export_yearly_report(self.service, self.year_var.get(), Path(path_str))
            messagebox.showinfo("Exportación", f"Archivo exportado en:\n{output}")
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo exportar el año: {exc}")

    def export_excel_filtered(self) -> None:
        default_name = f"finanzas_filtrado_{datetime.now().strftime('%Y%m%d')}.xlsx"
        path_str = filedialog.asksaveasfilename(
            title="Exportar movimientos filtrados",
            defaultextension=".xlsx",
            initialfile=default_name,
            filetypes=[("Excel", "*.xlsx")],
        )
        if not path_str:
            return
        try:
            output = export_filtered_movimientos(self.current_rows, Path(path_str))
            messagebox.showinfo("Exportación", f"Archivo exportado en:\n{output}")
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo exportar el filtrado: {exc}")

