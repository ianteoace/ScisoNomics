from __future__ import annotations

from datetime import date, datetime
from tkinter import Toplevel, ttk, StringVar, IntVar, messagebox

from ..services import FinanceService, GastoProgramadoInput
from .formatting import parse_amount
from .theme import COLORS, apply_theme


class GastoProgramadoDialog(Toplevel):
    def __init__(self, master, service: FinanceService, on_saved, gasto: dict | None = None) -> None:
        super().__init__(master)
        self.title("Agregar gasto programado" if gasto is None else "Editar gasto programado")
        self.resizable(False, False)
        apply_theme(self)
        self.configure(bg=COLORS["bg_app"])
        self.service = service
        self.on_saved = on_saved
        self.gasto = gasto

        self.descripcion_var = StringVar(value=(gasto["descripcion"] if gasto else ""))
        self.monto_var = StringVar(value=(str(gasto["monto_estimado"]) if gasto else ""))
        self.fecha_var = StringVar(value=(gasto["fecha_vencimiento"] if gasto else date.today().isoformat()))
        self.estado_var = StringVar(value=(gasto["estado"] if gasto else "pendiente"))
        self.recurrente_var = IntVar(value=(int(gasto["es_recurrente"]) if gasto else 0))
        self.frecuencia_var = StringVar(value=(gasto["frecuencia"] if gasto and gasto["frecuencia"] else ""))

        self._build()
        self._load_categories()
        self._toggle_frecuencia()

        self.grab_set()
        self.transient(master)

    def _build(self) -> None:
        frame = ttk.Frame(self, padding=12)
        frame.grid(row=0, column=0, sticky="nsew")

        ttk.Label(frame, text="Descripción").grid(row=0, column=0, sticky="w")
        ttk.Entry(frame, textvariable=self.descripcion_var, width=28).grid(row=0, column=1, sticky="ew", padx=(8, 0), pady=4)

        ttk.Label(frame, text="Categoría").grid(row=1, column=0, sticky="w")
        self.cat_box = ttk.Combobox(frame, state="readonly", width=26)
        self.cat_box.grid(row=1, column=1, sticky="ew", padx=(8, 0), pady=4)

        ttk.Label(frame, text="Monto estimado ($)").grid(row=2, column=0, sticky="w")
        ttk.Entry(frame, textvariable=self.monto_var, width=28).grid(row=2, column=1, sticky="ew", padx=(8, 0), pady=4)

        ttk.Label(frame, text="Fecha vencimiento (YYYY-MM-DD)").grid(row=3, column=0, sticky="w")
        ttk.Entry(frame, textvariable=self.fecha_var, width=28).grid(row=3, column=1, sticky="ew", padx=(8, 0), pady=4)

        ttk.Label(frame, text="Estado").grid(row=4, column=0, sticky="w")
        ttk.Combobox(
            frame,
            textvariable=self.estado_var,
            values=["pendiente", "pagado", "cancelado"],
            state="readonly",
            width=26,
        ).grid(row=4, column=1, sticky="ew", padx=(8, 0), pady=4)

        ttk.Checkbutton(
            frame,
            text="Recurrente",
            variable=self.recurrente_var,
            command=self._toggle_frecuencia,
        ).grid(row=5, column=0, sticky="w", pady=4)

        ttk.Label(frame, text="Frecuencia").grid(row=6, column=0, sticky="w")
        self.frecuencia_box = ttk.Combobox(
            frame,
            textvariable=self.frecuencia_var,
            values=["mensual", "semanal", "anual"],
            state="readonly",
            width=26,
        )
        self.frecuencia_box.grid(row=6, column=1, sticky="ew", padx=(8, 0), pady=4)

        buttons = ttk.Frame(frame)
        buttons.grid(row=7, column=0, columnspan=2, sticky="e", pady=(10, 0))
        ttk.Button(buttons, text="Guardar", command=self._save).grid(row=0, column=0, padx=(0, 8))
        ttk.Button(buttons, text="Cancelar", command=self.destroy).grid(row=0, column=1)

    def _toggle_frecuencia(self) -> None:
        state = "readonly" if self.recurrente_var.get() == 1 else "disabled"
        self.frecuencia_box.configure(state=state)
        if state == "disabled":
            self.frecuencia_var.set("")

    def _load_categories(self) -> None:
        self.categories = self.service.list_categorias("gasto")
        self.cat_box["values"] = [c["nombre"] for c in self.categories]
        if not self.categories:
            return

        selected_index = 0
        if self.gasto:
            for idx, cat in enumerate(self.categories):
                if cat["id"] == self.gasto["categoria_id"]:
                    selected_index = idx
                    break
        self.cat_box.current(selected_index)

    def _save(self) -> None:
        try:
            descripcion = self.descripcion_var.get().strip()
            if not descripcion:
                raise ValueError("La descripción es obligatoria.")

            cat_name = self.cat_box.get().strip()
            if not cat_name:
                raise ValueError("La categoría es obligatoria.")
            cat = next(c for c in self.categories if c["nombre"] == cat_name)

            monto = parse_amount(self.monto_var.get())
            if monto <= 0:
                raise ValueError("El monto estimado debe ser mayor a 0.")

            fecha = self.fecha_var.get().strip()
            if not fecha:
                raise ValueError("La fecha de vencimiento es obligatoria.")
            try:
                datetime.strptime(fecha, "%Y-%m-%d")
            except ValueError as exc:
                raise ValueError("La fecha debe tener formato YYYY-MM-DD.") from exc

            estado = self.estado_var.get().strip()
            if estado not in ("pendiente", "pagado", "cancelado"):
                raise ValueError("El estado es obligatorio.")

            recurrente = int(self.recurrente_var.get())
            frecuencia = self.frecuencia_var.get().strip() or None
            if recurrente == 1 and frecuencia not in ("mensual", "semanal", "anual"):
                raise ValueError("La frecuencia es obligatoria si el gasto es recurrente.")

            data = GastoProgramadoInput(
                descripcion=descripcion,
                categoria_id=int(cat["id"]),
                monto_estimado=monto,
                fecha_vencimiento=fecha,
                estado=estado,
                es_recurrente=recurrente,
                frecuencia=frecuencia,
            )

            if self.gasto:
                self.service.update_gasto_programado(self.gasto["id"], data)
                messagebox.showinfo("Éxito", "Gasto programado actualizado correctamente.")
            else:
                self.service.create_gasto_programado(data)
                messagebox.showinfo("Éxito", "Gasto programado creado correctamente.")

            self.on_saved()
            self.destroy()
        except StopIteration:
            messagebox.showerror("Validación", "Selecciona una categoría válida.")
        except ValueError as exc:
            messagebox.showerror("Validación", str(exc))
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo guardar: {exc}")
