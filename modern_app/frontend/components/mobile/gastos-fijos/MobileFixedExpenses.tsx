"use client";

import type { GastoFijo } from "../../../types/domain";
import { money } from "../../../lib/format";
import { PlanningActions } from "../MobilePlanningUI";

export function MobileFixedExpenses({ rows, onCreate, onEdit, onDelete }: {
  rows: GastoFijo[]; onCreate: () => void; onEdit: (row: GastoFijo) => void; onDelete: (row: GastoFijo) => void;
}) {
  return <section aria-label="Listado de gastos fijos" className="grid gap-4">
    <button className="btn min-h-12" onClick={onCreate}>Crear gasto fijo</button>
    <p className="text-sm text-slate-300">Definir un gasto fijo no registra un movimiento. Agregá el gasto en Movimientos cuando corresponda.</p>
    {!rows.length ? <p className="card p-4 text-slate-300">No tenés gastos fijos. Creá una plantilla mensual para organizar tus pagos.</p> : null}
    <ul className="grid gap-3" aria-label="Gastos fijos guardados">{rows.map((row) => <li key={row.id} className="card grid gap-2 p-4">
      <h2 className="break-words font-semibold">{row.descripcion}</h2>
      <p className="break-words text-sm text-slate-300">{row.categoria}</p>
      <p className="break-words text-lg font-bold">{money(row.monto)}</p>
      <p className="text-sm">Mensual · Día {row.dia_vencimiento} · {row.activo ? "Activo" : "Inactivo"}</p>
      <PlanningActions name={`gasto fijo ${row.descripcion}`} onEdit={() => onEdit(row)} onDelete={() => onDelete(row)} />
    </li>)}</ul>
  </section>;
}
