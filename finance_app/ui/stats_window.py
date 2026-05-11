from __future__ import annotations

from pathlib import Path
import tkinter as tk
from tkinter import Toplevel, filedialog, messagebox, ttk

from ..exporter import export_to_xlsx
from ..services import FinanceService
from .formatting import format_currency
from .theme import COLORS, apply_theme


class StatsWindow(Toplevel):
    def __init__(self, master, service: FinanceService, month: int, year: int, move_type: str = "todos") -> None:
        super().__init__(master)
        self.service = service
        self.move_type = move_type
        self.month_var = tk.IntVar(value=month)
        self.year_var = tk.IntVar(value=year)

        self.selected_category_id: int | None = None
        self.selected_category_name: str = ""
        self.pie_rows: list[dict] = []
        self.pie_wedges = []
        self.canvas = None

        self.title("Estadisticas")
        self.geometry("1180x700")
        self.minsize(980, 620)

        try:
            from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
            from matplotlib.figure import Figure

            self._FigureCanvasTkAgg = FigureCanvasTkAgg
            self._Figure = Figure
        except Exception:
            messagebox.showinfo(
                "Matplotlib no disponible",
                "Para ver estadisticas, instala matplotlib con:\npip install matplotlib",
            )
            self.destroy()
            return

        self._build_style()
        self._build_ui()
        self._refresh_all(reset_selection=True)

        self.transient(master)
        self.grab_set()

    def _build_style(self) -> None:
        apply_theme(self)
        style = ttk.Style(self)
        self.configure(bg=COLORS["bg_app"])
        style.configure("StatsRoot.TFrame", background=COLORS["bg_app"])
        style.configure("StatsPanel.TLabelframe", background=COLORS["bg_panel"], borderwidth=1, relief="solid")
        style.configure(
            "StatsPanel.TLabelframe.Label",
            background=COLORS["bg_panel"],
            foreground=COLORS["fg_main"],
            font=("Segoe UI", 10, "bold"),
        )
        style.configure("StatsLabel.TLabel", background=COLORS["bg_panel"], foreground=COLORS["fg_soft"], font=("Segoe UI", 10))
        style.configure("StatsValue.TLabel", background=COLORS["bg_panel"], font=("Segoe UI", 10, "bold"), foreground=COLORS["accent_aqua"])
        style.configure("StatsHint.TLabel", background=COLORS["bg_panel"], foreground=COLORS["fg_soft"], font=("Segoe UI", 9))
        style.configure(
            "Stats.Treeview",
            rowheight=26,
            font=("Segoe UI", 10),
            background=COLORS["table_odd"],
            fieldbackground=COLORS["table_odd"],
            foreground=COLORS["fg_main"],
        )
        style.map("Stats.Treeview", background=[("selected", COLORS["table_selected"])], foreground=[("selected", COLORS["fg_main"])])
        style.configure("Stats.Treeview.Heading", font=("Segoe UI", 10, "bold"), background=COLORS["bg_card"], foreground=COLORS["accent_orange"])

    def _build_ui(self) -> None:
        root = ttk.Frame(self, style="StatsRoot.TFrame", padding=12)
        root.pack(fill="both", expand=True)

        filters = ttk.LabelFrame(root, text="Filtros", style="StatsPanel.TLabelframe", padding=10)
        filters.pack(fill="x", pady=(0, 8))

        ttk.Label(filters, text="Mes").grid(row=0, column=0, padx=(0, 6), sticky="w")
        month_box = ttk.Combobox(filters, textvariable=self.month_var, width=6, state="readonly")
        month_box["values"] = tuple(range(1, 13))
        month_box.grid(row=0, column=1, padx=(0, 10), sticky="w")

        ttk.Label(filters, text="Ano").grid(row=0, column=2, padx=(0, 6), sticky="w")
        current_year = self.year_var.get()
        year_box = ttk.Combobox(filters, textvariable=self.year_var, width=8, state="readonly")
        year_box["values"] = tuple(range(current_year - 8, current_year + 3))
        year_box.grid(row=0, column=3, padx=(0, 10), sticky="w")

        ttk.Button(filters, text="Actualizar", command=lambda: self._refresh_all(reset_selection=True)).grid(
            row=0,
            column=4,
            padx=(4, 8),
        )
        ttk.Button(filters, text="Exportar detalle", command=self._export_detail).grid(row=0, column=5, padx=(0, 4))

        month_box.bind("<<ComboboxSelected>>", lambda _e: self._refresh_all(reset_selection=True))
        year_box.bind("<<ComboboxSelected>>", lambda _e: self._refresh_all(reset_selection=True))

        content = ttk.Panedwindow(root, orient="horizontal")
        content.pack(fill="both", expand=True)

        charts_frame = ttk.Frame(content, style="StatsRoot.TFrame", padding=(0, 4, 8, 0))
        detail_frame = ttk.LabelFrame(content, text="Detalle de categoria", style="StatsPanel.TLabelframe", padding=10)
        content.add(charts_frame, weight=3)
        content.add(detail_frame, weight=2)

        self.figure = self._Figure(figsize=(10, 6), dpi=100)
        self.figure.patch.set_facecolor(COLORS["bg_app"])
        self.ax_pie = self.figure.add_subplot(221)
        self.ax_bar = self.figure.add_subplot(222)
        self.ax_line = self.figure.add_subplot(212)

        self.canvas = self._FigureCanvasTkAgg(self.figure, master=charts_frame)
        self.canvas.get_tk_widget().configure(background=COLORS["bg_app"], highlightthickness=0)
        self.canvas.get_tk_widget().pack(fill="both", expand=True)

        self.canvas.mpl_connect("pick_event", self._on_pie_pick)

        self.detail_category_var = tk.StringVar(value="-")
        self.detail_total_var = tk.StringVar(value="$ 0,00")
        self.detail_percent_var = tk.StringVar(value="0.0%")
        self.detail_count_var = tk.StringVar(value="0")

        ttk.Label(detail_frame, text="Categoria:", style="StatsLabel.TLabel").grid(row=0, column=0, sticky="w", pady=(0, 6))
        ttk.Label(detail_frame, textvariable=self.detail_category_var, style="StatsValue.TLabel").grid(
            row=0, column=1, sticky="w", pady=(0, 6)
        )
        ttk.Label(detail_frame, text="Total:", style="StatsLabel.TLabel").grid(row=1, column=0, sticky="w", pady=(0, 6))
        ttk.Label(detail_frame, textvariable=self.detail_total_var, style="StatsValue.TLabel").grid(
            row=1, column=1, sticky="w", pady=(0, 6)
        )
        ttk.Label(detail_frame, text="Porcentaje:", style="StatsLabel.TLabel").grid(row=2, column=0, sticky="w", pady=(0, 6))
        ttk.Label(detail_frame, textvariable=self.detail_percent_var, style="StatsValue.TLabel").grid(
            row=2, column=1, sticky="w", pady=(0, 6)
        )
        ttk.Label(detail_frame, text="Movimientos:", style="StatsLabel.TLabel").grid(row=3, column=0, sticky="w", pady=(0, 8))
        ttk.Label(detail_frame, textvariable=self.detail_count_var, style="StatsValue.TLabel").grid(
            row=3, column=1, sticky="w", pady=(0, 8)
        )

        columns = ("fecha", "descripcion", "monto")
        self.detail_tree = ttk.Treeview(detail_frame, columns=columns, show="headings", height=15, style="Stats.Treeview")
        self.detail_tree.heading("fecha", text="Fecha")
        self.detail_tree.heading("descripcion", text="Descripcion")
        self.detail_tree.heading("monto", text="Monto")
        self.detail_tree.column("fecha", width=105, anchor="center")
        self.detail_tree.column("descripcion", width=320, anchor="w", stretch=True)
        self.detail_tree.column("monto", width=130, anchor="e")

        yscroll = ttk.Scrollbar(detail_frame, orient="vertical", command=self.detail_tree.yview)
        self.detail_tree.configure(yscrollcommand=yscroll.set)
        self.detail_tree.grid(row=4, column=0, columnspan=2, sticky="nsew")
        yscroll.grid(row=4, column=2, sticky="ns")

        self.detail_empty = ttk.Label(
            detail_frame,
            text="Selecciona una porcion del grafico para ver el detalle.",
            style="StatsHint.TLabel",
        )
        self.detail_empty.grid(row=5, column=0, columnspan=2, sticky="w", pady=(8, 0))

        detail_frame.columnconfigure(1, weight=1)
        detail_frame.rowconfigure(4, weight=1)

    def _refresh_all(self, reset_selection: bool = False) -> None:
        if reset_selection:
            self.selected_category_id = None
            self.selected_category_name = ""
        self._draw_expense_pie()
        self._draw_month_bar()
        self._draw_balance_trend()
        self.figure.tight_layout(pad=2.2)
        self.canvas.draw_idle()
        if reset_selection:
            self._clear_detail()

    def _draw_expense_pie(self) -> None:
        ax = self.ax_pie
        ax.clear()
        ax.set_facecolor(COLORS["bg_panel"])

        self.pie_rows = self.service.get_expenses_by_category(self.month_var.get(), self.year_var.get(), "gasto")
        if not self.pie_rows:
            ax.text(0.5, 0.5, "Sin gastos en este periodo", ha="center", va="center", color=COLORS["fg_main"])
            ax.set_title(f"Gastos por categoria ({self.month_var.get():02d}/{self.year_var.get()})")
            self.pie_wedges = []
            return

        labels = [str(row["categoria"]) for row in self.pie_rows]
        values = [float(row["total"]) for row in self.pie_rows]
        total = sum(values)

        selected_index = -1
        if self.selected_category_id is not None:
            for idx, row in enumerate(self.pie_rows):
                if int(row["categoria_id"]) == self.selected_category_id:
                    selected_index = idx
                    break

        explode = [0.0] * len(values)
        if selected_index >= 0:
            explode[selected_index] = 0.1

        show_inside_pct = len(values) <= 6
        autopct = "%1.0f%%" if show_inside_pct else None

        palette = [
            "#00bcd4",
            "#ff7043",
            "#7e57c2",
            "#66bb6a",
            "#ec407a",
            "#26a69a",
            "#ffca28",
            "#42a5f5",
            "#ab47bc",
            "#8d6e63",
            "#26c6da",
            "#ff8a65",
            "#9ccc65",
            "#5c6bc0",
            "#ef5350",
            "#29b6f6",
        ]
        colors = [palette[i % len(palette)] for i in range(len(values))]

        wedges, _, autotexts = ax.pie(
            values,
            labels=labels if len(values) <= 8 else None,
            autopct=autopct,
            startangle=90,
            explode=explode,
            pctdistance=0.74,
            colors=colors,
            shadow=selected_index >= 0,
            wedgeprops={"linewidth": 1, "edgecolor": COLORS["bg_panel"]},
        )

        for wedge in wedges:
            # Compatibilidad entre versiones: algunos Wedge no exponen set_pickradius.
            wedge.set_picker(6)

        legend_labels = labels
        if len(values) > 8:
            ax.legend(
                wedges,
                legend_labels,
                title="Categorias",
                loc="center left",
                bbox_to_anchor=(1.02, 0.5),
                fontsize=8,
            )

        for text in autotexts:
            text.set_fontsize(8)
            text.set_color(COLORS["pie_pct_text"])

        ax.set_title(
            f"Gastos por categoria ({self.month_var.get():02d}/{self.year_var.get()})",
            fontsize=11,
            pad=10,
            color=COLORS["fg_main"],
        )
        ax.axis("equal")
        self.pie_wedges = wedges

        if selected_index >= 0 and total > 0:
            row = self.pie_rows[selected_index]
            self._load_category_detail(int(row["categoria_id"]), row["categoria"], float(row["total"]), total)

    def _draw_month_bar(self) -> None:
        ax = self.ax_bar
        ax.clear()
        ax.set_facecolor(COLORS["bg_panel"])
        summary = self.service.get_month_summary(
            self.month_var.get(),
            self.year_var.get(),
            None if self.move_type == "todos" else self.move_type,
        )
        labels = ["Ingresos", "Gastos"]
        values = [summary["ingreso"], summary["gasto"]]
        colors = [COLORS["income_green"], COLORS["expense_red"]]
        bars = ax.bar(labels, values, color=colors)
        ax.bar_label(bars, labels=[format_currency(v) for v in values], padding=3, fontsize=8, color=COLORS["fg_main"])
        ax.set_title(f"Ingresos vs gastos ({self.month_var.get():02d}/{self.year_var.get()})", fontsize=11, pad=10, color=COLORS["fg_main"])
        ax.grid(axis="y", alpha=0.22, color=COLORS["grid_line"])
        ax.tick_params(axis="x", colors=COLORS["fg_main"])
        ax.tick_params(axis="y", colors=COLORS["fg_main"])
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.spines["left"].set_color(COLORS["axis_line"])
        ax.spines["bottom"].set_color(COLORS["axis_line"])

    def _draw_balance_trend(self) -> None:
        ax = self.ax_line
        ax.clear()
        ax.set_facecolor(COLORS["bg_panel"])
        trend = self.service.get_monthly_trend(self.year_var.get())
        months = [row["mes"] for row in trend]
        balances = [row["ingresos"] - row["gastos"] for row in trend]
        ax.plot(months, balances, color=COLORS["accent_aqua"], linewidth=2, marker="o", markersize=4)
        ax.axhline(0, color=COLORS["accent_orange"], linewidth=1, linestyle="--")
        ax.set_title(f"Evolucion mensual del balance ({self.year_var.get()})", fontsize=11, pad=10, color=COLORS["fg_main"])
        ax.set_xlabel("Mes", color=COLORS["fg_main"])
        ax.set_xticks(months)
        ax.tick_params(axis="x", colors=COLORS["fg_main"])
        ax.tick_params(axis="y", colors=COLORS["fg_main"])
        ax.grid(alpha=0.22, color=COLORS["grid_line"])
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.spines["left"].set_color(COLORS["axis_line"])
        ax.spines["bottom"].set_color(COLORS["axis_line"])

    def _on_pie_pick(self, event) -> None:
        wedge = event.artist
        if wedge not in self.pie_wedges:
            return

        index = self.pie_wedges.index(wedge)
        row = self.pie_rows[index]
        self.selected_category_id = int(row["categoria_id"])
        self.selected_category_name = str(row["categoria"])

        self._draw_expense_pie()
        self.figure.tight_layout(pad=2.2)
        self.canvas.draw_idle()

    def _load_category_detail(self, category_id: int, category_name: str, category_total: float, total_expenses: float) -> None:
        movements = self.service.get_expense_movements_by_category(self.month_var.get(), self.year_var.get(), category_id)

        for item in self.detail_tree.get_children():
            self.detail_tree.delete(item)

        running_total = 0.0
        for idx, row in enumerate(movements):
            amount = float(row["monto"])
            description = str(row.get("descripcion") or "").strip() or category_name
            running_total += amount
            self.detail_tree.insert(
                "",
                "end",
                values=(row["fecha"], description, format_currency(amount)),
                tags=("par" if idx % 2 == 0 else "impar",),
            )

        self.detail_tree.insert(
            "",
            "end",
            values=("", "TOTAL", format_currency(running_total)),
            tags=("total",),
        )
        self.detail_tree.tag_configure("par", background=COLORS["table_even"])
        self.detail_tree.tag_configure("impar", background=COLORS["table_odd"])
        self.detail_tree.tag_configure("total", background=COLORS["chart_total_bg"], foreground=COLORS["accent_orange"])

        percent = (category_total / total_expenses * 100.0) if total_expenses > 0 else 0.0
        self.detail_category_var.set(category_name)
        self.detail_total_var.set(format_currency(category_total))
        self.detail_percent_var.set(f"{percent:.1f}%")
        self.detail_count_var.set(str(len(movements)))
        self.detail_empty.configure(text="")

    def _clear_detail(self) -> None:
        self.detail_category_var.set("-")
        self.detail_total_var.set("$ 0,00")
        self.detail_percent_var.set("0.0%")
        self.detail_count_var.set("0")
        for item in self.detail_tree.get_children():
            self.detail_tree.delete(item)
        self.detail_empty.configure(text="Selecciona una porcion del grafico para ver el detalle.")

    def _export_detail(self) -> None:
        if self.selected_category_id is None:
            messagebox.showwarning("Exportar detalle", "Seleccioná una categoría para exportar el detalle.")
            return

        rows = self.service.get_expense_movements_by_category(
            self.month_var.get(),
            self.year_var.get(),
            self.selected_category_id,
        )
        if not rows:
            messagebox.showinfo("Exportar detalle", "No hay movimientos para exportar en esa categoria.")
            return

        safe_name = "".join(ch for ch in self.selected_category_name if ch.isalnum() or ch in ("_", "-", " ")).strip()
        safe_name = safe_name.replace(" ", "_") or "categoria"
        default_name = f"detalle_categoria_{safe_name}_{self.month_var.get():02d}_{self.year_var.get()}.xlsx"
        path_str = filedialog.asksaveasfilename(
            title="Exportar detalle de categoria",
            defaultextension=".xlsx",
            initialfile=default_name,
            filetypes=[("Excel", "*.xlsx")],
        )
        if not path_str:
            return

        export_rows = [
            {
                "fecha": row["fecha"],
                "tipo": "gasto",
                "categoria": row.get("categoria", self.selected_category_name),
                "descripcion": str(row.get("descripcion") or "").strip() or self.selected_category_name,
                "monto": row["monto"],
            }
            for row in rows
        ]

        try:
            output = export_to_xlsx(export_rows, Path(path_str))
            messagebox.showinfo("Exportacion", f"Detalle exportado en:\n{output}")
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo exportar el detalle: {exc}")
