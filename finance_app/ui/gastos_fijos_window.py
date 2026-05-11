from __future__ import annotations

from tkinter import Toplevel, ttk, StringVar, IntVar, messagebox

from ..services import GastoFijoInput, FinanceService
from .formatting import format_currency, parse_amount
from .theme import COLORS, apply_theme


class GastosFijosWindow(Toplevel):
    def __init__(self, master, service: FinanceService, on_updated) -> None:
        super().__init__(master)
        self.title("Gastos fijos")
        self.geometry("820x420")
        apply_theme(self)
        self.configure(bg=COLORS["bg_app"])
        self.service = service
        self.on_updated = on_updated
        self.selected_id: int | None = None

        self.descripcion_var = StringVar()
        self.monto_var = StringVar()
        self.dia_var = StringVar(value="1")
        self.activo_var = IntVar(value=1)

        self._build()
        self._load_categories()
        self.refresh()
        self._update_buttons_state()

        self.grab_set()
        self.transient(master)

    def _build(self) -> None:
        root = ttk.Frame(self, style="App.TFrame", padding=10)
        root.pack(fill="both", expand=True)

        top = ttk.LabelFrame(root, text="Formulario", style="Panel.TLabelframe")
        top.pack(fill="x", pady=(0, 10))

        ttk.Label(top, text="Categoría").grid(row=0, column=0, padx=6, pady=6, sticky="w")
        self.cat_box = ttk.Combobox(top, state="readonly", width=25)
        self.cat_box.grid(row=0, column=1, padx=6, pady=6, sticky="w")

        ttk.Label(top, text="Descripción").grid(row=0, column=2, padx=6, pady=6, sticky="w")
        ttk.Entry(top, textvariable=self.descripcion_var, width=28).grid(row=0, column=3, padx=6, pady=6)

        ttk.Label(top, text="Monto ($)").grid(row=1, column=0, padx=6, pady=6, sticky="w")
        ttk.Entry(top, textvariable=self.monto_var, width=18).grid(row=1, column=1, padx=6, pady=6, sticky="w")

        ttk.Label(top, text="Día de vencimiento").grid(row=1, column=2, padx=6, pady=6, sticky="w")
        ttk.Entry(top, textvariable=self.dia_var, width=10).grid(row=1, column=3, padx=6, pady=6, sticky="w")

        ttk.Checkbutton(top, text="Activo", variable=self.activo_var).grid(row=2, column=0, padx=6, pady=6, sticky="w")

        buttons = ttk.Frame(top, style="App.TFrame")
        buttons.grid(row=2, column=3, sticky="e", padx=6, pady=6)
        ttk.Button(buttons, text="Nuevo", command=self._clear).grid(row=0, column=0, padx=4)
        ttk.Button(buttons, text="Guardar", command=self._save).grid(row=0, column=1, padx=4)
        self.delete_btn = ttk.Button(buttons, text="Eliminar", command=self._delete)
        self.delete_btn.grid(row=0, column=2, padx=4)

        self.tree = ttk.Treeview(
            root,
            columns=("id", "categoria", "descripcion", "monto", "dia", "activo"),
            show="headings",
            height=12,
        )
        self.tree.pack(fill="both", expand=True)

        for col, text, width in [
            ("id", "ID", 50),
            ("categoria", "Categoría", 170),
            ("descripcion", "Descripción", 220),
            ("monto", "Monto", 100),
            ("dia", "Dia", 70),
            ("activo", "Activo", 80),
        ]:
            self.tree.heading(col, text=text)
            self.tree.column(col, width=width, anchor="center")
        self.tree.tag_configure("par", background=COLORS["table_even"])
        self.tree.tag_configure("impar", background=COLORS["table_odd"])

        self.tree.bind("<<TreeviewSelect>>", self._on_select)

    def _load_categories(self) -> None:
        self.categories = self.service.list_categorias("gasto")
        self.cat_box["values"] = [cat["nombre"] for cat in self.categories]
        if self.categories:
            self.cat_box.current(0)

    def refresh(self) -> None:
        for row in self.tree.get_children():
            self.tree.delete(row)

        for idx, row in enumerate(self.service.list_gastos_fijos()):
            self.tree.insert(
                "",
                "end",
                values=(
                    row["id"],
                    row["categoria"],
                    row["descripcion"],
                    format_currency(row["monto"]),
                    row["dia_vencimiento"],
                    "Sí" if row["activo"] else "No",
                ),
                tags=("par" if idx % 2 == 0 else "impar",),
            )

    def _on_select(self, _event=None) -> None:
        selected = self.tree.selection()
        if not selected:
            self.selected_id = None
            self._update_buttons_state()
            return
        item = self.tree.item(selected[0], "values")
        gasto_id = int(item[0])
        row = self.service.get_gasto_fijo(gasto_id)
        if not row:
            return

        self.selected_id = gasto_id
        self.descripcion_var.set(row["descripcion"])
        self.monto_var.set(format_currency(row["monto"]))
        self.dia_var.set(str(row["dia_vencimiento"]))
        self.activo_var.set(int(row["activo"]))

        for idx, cat in enumerate(self.categories):
            if cat["id"] == row["categoria_id"]:
                self.cat_box.current(idx)
                break
        self._update_buttons_state()

    def _save(self) -> None:
        try:
            cat_name = self.cat_box.get().strip()
            if not cat_name:
                raise ValueError("La categoría es obligatoria.")
            cat = next(c for c in self.categories if c["nombre"] == cat_name)

            descripcion = self.descripcion_var.get().strip()
            if not descripcion:
                raise ValueError("La descripción es obligatoria.")

            monto = parse_amount(self.monto_var.get())
            if monto <= 0:
                raise ValueError("El monto debe ser mayor a 0.")

            dia_text = self.dia_var.get().strip()
            if not dia_text:
                raise ValueError("El día de vencimiento es obligatorio.")
            dia = int(dia_text)
            if dia < 1 or dia > 31:
                raise ValueError("El día de vencimiento debe estar entre 1 y 31.")

            data = GastoFijoInput(
                categoria_id=int(cat["id"]),
                descripcion=descripcion,
                monto=monto,
                dia_vencimiento=dia,
                activo=int(self.activo_var.get()),
            )

            if self.selected_id:
                self.service.update_gasto_fijo(self.selected_id, data)
                messagebox.showinfo("Éxito", "Gasto fijo actualizado correctamente.")
            else:
                self.service.create_gasto_fijo(data)
                messagebox.showinfo("Éxito", "Gasto fijo creado correctamente.")

            self._clear()
            self.refresh()
            self.on_updated()
        except ValueError as exc:
            messagebox.showerror("Validación", str(exc))
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo guardar: {exc}")

    def _delete(self) -> None:
        if not self.selected_id:
            messagebox.showwarning("Atención", "Selecciona un gasto fijo para eliminar.")
            return
        if not messagebox.askyesno("Confirmar", "¿Deseas eliminar el gasto fijo?"):
            return

        self.service.delete_gasto_fijo(self.selected_id)
        messagebox.showinfo("Éxito", "Gasto fijo eliminado correctamente.")
        self._clear()
        self.refresh()
        self.on_updated()

    def _clear(self) -> None:
        self.selected_id = None
        self.descripcion_var.set("")
        self.monto_var.set("")
        self.dia_var.set("1")
        self.activo_var.set(1)
        if self.categories:
            self.cat_box.current(0)
        self.tree.selection_remove(self.tree.selection())
        self._update_buttons_state()

    def _update_buttons_state(self) -> None:
        state = "normal" if self.selected_id else "disabled"
        self.delete_btn.configure(state=state)

