from __future__ import annotations

from tkinter import StringVar, Toplevel, messagebox, ttk

from ..services import FinanceService
from .theme import COLORS, apply_theme


class CategoriasWindow(Toplevel):
    def __init__(self, master, service: FinanceService, on_updated) -> None:
        super().__init__(master)
        self.service = service
        self.on_updated = on_updated
        self.title("Categorías")
        self.geometry("760x420")
        apply_theme(self)
        self.configure(bg=COLORS["bg_app"])

        self.selected_id: int | None = None
        self.nombre_var = StringVar()
        self.tipo_var = StringVar(value="gasto")

        self._build()
        self.refresh()

        self.transient(master)

    def _build(self) -> None:
        root = ttk.Frame(self, style="App.TFrame", padding=10)
        root.pack(fill="both", expand=True)

        form = ttk.LabelFrame(root, text="Gestión de categorías", style="Panel.TLabelframe", padding=10)
        form.pack(fill="x", pady=(0, 10))

        ttk.Label(form, text="Nombre").grid(row=0, column=0, padx=5, pady=5, sticky="w")
        ttk.Entry(form, textvariable=self.nombre_var, width=26).grid(row=0, column=1, padx=5, pady=5, sticky="w")

        ttk.Label(form, text="Tipo").grid(row=0, column=2, padx=5, pady=5, sticky="w")
        tipo_box = ttk.Combobox(form, textvariable=self.tipo_var, state="readonly", width=12)
        tipo_box["values"] = ("ingreso", "gasto")
        tipo_box.grid(row=0, column=3, padx=5, pady=5, sticky="w")

        buttons = ttk.Frame(form, style="App.TFrame")
        buttons.grid(row=0, column=4, padx=5, pady=5, sticky="e")
        ttk.Button(buttons, text="Nuevo", command=self._clear).grid(row=0, column=0, padx=3)
        ttk.Button(buttons, text="Guardar", command=self._save).grid(row=0, column=1, padx=3)
        self.delete_btn = ttk.Button(buttons, text="Eliminar", command=self._delete)
        self.delete_btn.grid(row=0, column=2, padx=3)

        self.tree = ttk.Treeview(root, columns=("id", "nombre", "tipo"), show="headings", height=14)
        self.tree.pack(fill="both", expand=True)
        self.tree.heading("id", text="ID")
        self.tree.heading("nombre", text="Nombre")
        self.tree.heading("tipo", text="Tipo")
        self.tree.column("id", width=60, anchor="center")
        self.tree.column("nombre", width=420, anchor="w")
        self.tree.column("tipo", width=120, anchor="center")
        self.tree.tag_configure("par", background=COLORS["table_even"])
        self.tree.tag_configure("impar", background=COLORS["table_odd"])

        self.tree.bind("<<TreeviewSelect>>", self._on_select)
        self._update_buttons_state()

    def refresh(self) -> None:
        for item in self.tree.get_children():
            self.tree.delete(item)
        for idx, row in enumerate(self.service.list_categorias()):
            self.tree.insert(
                "",
                "end",
                values=(row["id"], row["nombre"], row["tipo"]),
                tags=("par" if idx % 2 == 0 else "impar",),
            )
        self._update_buttons_state()

    def _on_select(self, _event=None) -> None:
        selected = self.tree.selection()
        if not selected:
            self.selected_id = None
            self._update_buttons_state()
            return

        values = self.tree.item(selected[0], "values")
        self.selected_id = int(values[0])
        self.nombre_var.set(values[1])
        self.tipo_var.set(values[2])
        self._update_buttons_state()

    def _save(self) -> None:
        try:
            nombre = self.nombre_var.get().strip()
            tipo = self.tipo_var.get().strip()
            if self.selected_id:
                self.service.update_categoria(self.selected_id, nombre, tipo)
                messagebox.showinfo("Éxito", "Categoría actualizada correctamente.")
            else:
                self.service.create_categoria(nombre, tipo)
                messagebox.showinfo("Éxito", "Categoría creada correctamente.")
            self._clear()
            self.refresh()
            self.on_updated()
        except ValueError as exc:
            messagebox.showerror("Validación", str(exc))
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo guardar la categoría: {exc}")

    def _delete(self) -> None:
        if not self.selected_id:
            messagebox.showwarning("Atención", "Selecciona una categoría para eliminar.")
            return
        if not messagebox.askyesno("Confirmar eliminación", "¿Deseas eliminar la categoría seleccionada?"):
            return
        try:
            self.service.delete_categoria(self.selected_id)
            messagebox.showinfo("Éxito", "Categoría eliminada correctamente.")
            self._clear()
            self.refresh()
            self.on_updated()
        except ValueError as exc:
            messagebox.showerror("Validación", str(exc))
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo eliminar la categoría: {exc}")

    def _clear(self) -> None:
        self.selected_id = None
        self.nombre_var.set("")
        self.tipo_var.set("gasto")
        self.tree.selection_remove(self.tree.selection())
        self._update_buttons_state()

    def _update_buttons_state(self) -> None:
        self.delete_btn.configure(state="normal" if self.selected_id else "disabled")
