"use client";

import type { Presupuesto } from "../../../types/domain";
import { money, monthName } from "../../../lib/format";
import { budgetState, PlanningActions, PlanningProgress } from "../MobilePlanningUI";

export function MobileBudgets({ rows, onCreate, onEdit, onDelete }: {
  rows: Presupuesto[]; onCreate: () => void; onEdit: (row: Presupuesto) => void; onDelete: (row: Presupuesto) => void;
}) {
  return <section aria-label="Listado de presupuestos" className="grid gap-4">
    <button className="btn min-h-12" onClick={onCreate}>Crear presupuesto</button>
    {!rows.length ? <p className="card p-4 text-slate-300">No tenés presupuestos para este mes. Definí un límite por categoría de gasto.</p> : null}
    <ul className="grid gap-3" aria-label="Presupuestos guardados">{rows.map((r) => <li key={r.id} className="card grid gap-3 p-4">
      <h2 className="break-words font-semibold">{r.categoria}</h2>
      <p className="text-sm text-slate-300">{monthName(r.mes)} {r.anio}</p>
      <p className="break-words">Presupuestado: <strong>{money(r.monto_presupuestado)}</strong></p>
      <p className="break-words">Consumido: <strong>{money(r.monto_gastado)}</strong></p>
      <p className="break-words">Restante: <strong>{money(r.monto_disponible)}</strong></p>
      <PlanningProgress percent={r.porcentaje_usado} label={budgetState(r.porcentaje_usado)} />
      <PlanningActions name={`presupuesto ${r.categoria}`} onEdit={() => onEdit(r)} onDelete={() => onDelete(r)} />
    </li>)}</ul>
  </section>;
}
