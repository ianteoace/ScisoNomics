"use client";

import { money } from "../../../lib/format";
import type { FinanceMovimiento } from "../../../services/data/financeRepositoryTypes";
import { formatMobileDate, typeLabel } from "../mobileUi";

export function MobileMovementList({ rows, onEdit, onDelete }: {
  rows: FinanceMovimiento[]; onEdit: (row: FinanceMovimiento) => void; onDelete?: (row: FinanceMovimiento) => void;
}) {
  return <ul className="grid gap-3" aria-label="Movimientos guardados">{rows.map((row) => <li key={row.id} className="card min-w-0 p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <p className="min-w-0 break-words font-semibold">{row.descripcion || row.categoria}</p>
      <p className={`break-all font-bold tabular-nums ${row.tipo === "ingreso" ? "text-emerald-300" : "text-slate-100"}`}>{row.tipo === "ingreso" ? "+" : "−"}{money(row.monto)}</p>
    </div>
    <p className="mt-2 break-words text-sm text-slate-300">{typeLabel(row.tipo)} · {row.categoria}</p>
    <p className="mt-1 text-xs text-slate-400">{formatMobileDate(row.fecha)}</p>
    {row.nota ? <p className="mt-2 break-words text-sm text-slate-300">{row.nota}</p> : null}
    <div className="mt-3 flex flex-wrap gap-2">
      <button className="btn-secondary min-h-11" aria-label={`Editar movimiento ${row.descripcion || row.categoria}`} onClick={() => onEdit(row)}>Editar</button>
      {onDelete ? <button className="btn-secondary min-h-11" aria-label={`Eliminar movimiento ${row.descripcion || row.categoria}`} onClick={() => onDelete(row)}>Eliminar</button> : null}
    </div>
  </li>)}</ul>;
}
