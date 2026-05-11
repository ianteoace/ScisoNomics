from __future__ import annotations

from datetime import date, datetime
from tkinter import Toplevel, ttk, StringVar, IntVar, messagebox

from ..services import MovimientoInput, FinanceService
from .formatting import parse_amount
from .theme import COLORS, apply_theme


class MovimientoDialog(Toplevel):
    def __init__(
        self,
        master,
        service: FinanceService,
        on_saved,
        movimiento: dict | None = None,
    ) -> None:
        super().__init__(master)
        self.title("Agregar movimiento" if movimiento is None else "Editar movimiento")
        self.resizable(False, False)
        apply_theme(self)
        self.configure(bg=COLORS["bg_app"])
        self.service = service
        self.on_saved = on_saved
        self.movimiento = movimiento

        self.tipo_var = StringVar(value=(movimiento["tipo"] if movimiento else "gasto"))
        self.fecha_var = StringVar(value=(movimiento["fecha"] if movimiento else date.today().isoformat()))
        self.descripcion_var = StringVar(value=(movimiento["descripcion"] if movimiento else ""))
        self.monto_var = StringVar(value=(str(movimiento["monto"]) if movimiento else ""))
        self.categoria_id_var = IntVar(value=(movimiento["categoria_id"] if movimiento else 0))

        self._build()
        self._load_categories()

        self.grab_set()
        self.transient(master)

    def _build(self) -> None:
        frame = ttk.Frame(self, padding=12)
        frame.grid(row=0, column=0, sticky="nsew")

        ttk.Label(frame, text="Tipo").grid(row=0, column=0, sticky="w")
        type_box = ttk.Combobox(
            frame,
            textvariable=self.tipo_var,
            values=["ingreso", "gasto"],
            state="readonly",
            width=20,
        )
        type_box.grid(row=0, column=1, sticky="ew", padx=(8, 0), pady=4)
        type_box.bind("<<ComboboxSelected>>", lambda _e: self._load_categories())

        ttk.Label(frame, text="Fecha (YYYY-MM-DD)").grid(row=1, column=0, sticky="w")
        ttk.Entry(frame, textvariable=self.fecha_var, width=24).grid(row=1, column=1, sticky="ew", padx=(8, 0), pady=4)

        ttk.Label(frame, text="Categoría").grid(row=2, column=0, sticky="w")
        self.category_box = ttk.Combobox(frame, state="readonly", width=24)
        self.category_box.grid(row=2, column=1, sticky="ew", padx=(8, 0), pady=4)

        ttk.Label(frame, text="Descripción").grid(row=3, column=0, sticky="w")
        ttk.Entry(frame, textvariable=self.descripcion_var, width=24).grid(row=3, column=1, sticky="ew", padx=(8, 0), pady=4)

        ttk.Label(frame, text="Monto ($)").grid(row=4, column=0, sticky="w")
        ttk.Entry(frame, textvariable=self.monto_var, width=24).grid(row=4, column=1, sticky="ew", padx=(8, 0), pady=4)

        buttons = ttk.Frame(frame)
        buttons.grid(row=5, column=0, columnspan=2, sticky="e", pady=(10, 0))
        ttk.Button(buttons, text="Guardar", command=self._save).grid(row=0, column=0, padx=(0, 8))
        ttk.Button(buttons, text="Cancelar", command=self.destroy).grid(row=0, column=1)

    def _load_categories(self) -> None:
        categories = self.service.list_categorias(self.tipo_var.get())
        self._categories = categories
        names = [cat["nombre"] for cat in categories]
        self.category_box["values"] = names

        selected_index = 0
        if self.movimiento:
            for idx, cat in enumerate(categories):
                if cat["id"] == self.movimiento["categoria_id"]:
                    selected_index = idx
                    break
        if names:
            self.category_box.current(selected_index)

    def _save(self) -> None:
        try:
            fecha = self.fecha_var.get().strip()
            if not fecha:
                raise ValueError("La fecha es obligatoria.")
            try:
                datetime.strptime(fecha, "%Y-%m-%d")
            except ValueError:
                raise ValueError("La fecha debe tener formato YYYY-MM-DD.")

            tipo = self.tipo_var.get().strip()
            if tipo not in ("ingreso", "gasto"):
                raise ValueError("El tipo debe ser ingreso o gasto.")

            selected_name = self.category_box.get().strip()
            if not selected_name:
                raise ValueError("La categoría es obligatoria.")
            selected = next(cat for cat in self._categories if cat["nombre"] == selected_name)

            monto = parse_amount(self.monto_var.get())
            if monto <= 0:
                raise ValueError("El monto debe ser mayor a 0.")

            data = MovimientoInput(
                fecha=fecha,
                tipo=tipo,
                categoria_id=int(selected["id"]),
                descripcion=self.descripcion_var.get().strip(),
                monto=monto,
            )

            if self.movimiento:
                self.service.update_movimiento(self.movimiento["id"], data)
                messagebox.showinfo("Éxito", "Movimiento actualizado correctamente.")
            else:
                self.service.create_movimiento(data)
                messagebox.showinfo("Éxito", "Movimiento creado correctamente.")

            self.on_saved()
            self.destroy()
        except StopIteration:
            messagebox.showerror("Validación", "Selecciona una categoría válida.")
        except ValueError as exc:
            messagebox.showerror("Validación", str(exc))
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo guardar: {exc}")

