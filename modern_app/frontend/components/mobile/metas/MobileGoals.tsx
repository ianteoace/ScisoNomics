"use client";

import type { MetaAhorro } from "../../../types/domain";
import { money } from "../../../lib/format";
import { formatMobileDate } from "../mobileUi";
import { goalState, PlanningActions, PlanningProgress } from "../MobilePlanningUI";

export function MobileGoals({ rows, onCreate, onEdit, onDelete }: {
  rows: MetaAhorro[]; onCreate: () => void; onEdit: (row: MetaAhorro) => void; onDelete: (row: MetaAhorro) => void;
}) {
  const states = { activa: "Activa", pausada: "Pausada", completada: "Completada" };
  return <section aria-label="Listado de metas" className="grid gap-4">
    <button className="btn min-h-12" onClick={onCreate}>Crear meta</button>
    <p className="text-sm text-slate-300">El avance incluye el monto inicial y los movimientos de ahorro que asignás a cada meta.</p>
    {!rows.length ? <p className="card p-4 text-slate-300">No tenés metas de ahorro. Creá una para empezar a seguir tu progreso.</p> : null}
    <ul className="grid gap-3" aria-label="Metas guardadas">{rows.map((r) => <li key={r.id} className="card grid gap-3 p-4">
      <h2 className="break-words font-semibold">{r.nombre}</h2>
      {r.descripcion ? <p className="break-words text-sm text-slate-300">{r.descripcion}</p> : null}
      <p className="text-sm">Estado: {states[r.estado]}</p>
      <p className="break-words">Objetivo: <strong>{money(r.monto_objetivo)}</strong></p>
      <p className="break-words">Monto actual: <strong>{money(r.monto_ahorrado)}</strong></p>
      <p className="break-words">Faltante: <strong>{money(r.faltante)}</strong></p>
      {r.fecha_objetivo ? <p className="text-sm">Fecha objetivo: {formatMobileDate(r.fecha_objetivo)}</p> : null}
      <PlanningProgress percent={r.porcentaje_completado} label={goalState(r.porcentaje_completado)} />
      <PlanningActions name={`meta ${r.nombre}`} onEdit={() => onEdit(r)} onDelete={() => onDelete(r)} />
    </li>)}</ul>
  </section>;
}
