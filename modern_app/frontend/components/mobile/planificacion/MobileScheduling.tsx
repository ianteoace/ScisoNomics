"use client";

import { useState } from "react";
import type { GastoProgramado } from "../../../types/domain";
import type { SchedulingSummary } from "../../../services/data/financeRepositoryTypes";
import { getLocalDateInputValue } from "../../../lib/date";
import { money } from "../../../lib/format";
import { formatMobileDate } from "../mobileUi";
import { PlanningActions } from "../MobilePlanningUI";

export function MobileScheduling({ rows, summary, onCreate, onEdit, onDelete, onPay }: {
  rows: GastoProgramado[]; summary: SchedulingSummary; onCreate: () => void;
  onEdit: (row: GastoProgramado) => void; onDelete: (row: GastoProgramado) => void; onPay: (row: GastoProgramado) => void;
}) {
  const [state, setState] = useState("todos");
  const filtered = rows.filter((row) => state === "todos" || row.estado === state);
  const today = getLocalDateInputValue();
  return <section aria-label="Listado de planificación" className="grid min-w-0 gap-4">
    <button className="btn min-h-12 w-full" onClick={onCreate}>Crear planificación</button>
    <p className="text-sm text-slate-300">Planificar no cambia tu saldo. Marcar pagado registra un gasto real con fecha de hoy.</p>
    <div className="card grid gap-2 p-4 text-sm" aria-label="Resumen de planificación">
      <p>Vencidos: <strong>{money(summary.total_vencido)}</strong></p>
      <p>Pendientes próximos 30 días: <strong>{money(summary.total_pendiente_30_dias)}</strong></p>
      <p>Pagados con vencimiento este mes: <strong>{money(summary.total_pagado_mes)}</strong></p>
      <p>Balance proyectado del mes elegido: <strong>{money(summary.balance_proyectado_mes)}</strong></p>
      <p className="text-xs text-slate-400">Proyección de ingresos menos gastos reales y pendientes del mes. No es tu saldo actual.</p>
    </div>
    <label className="grid gap-2 text-sm">Estado<select className="input min-h-12" value={state} onChange={(e) => setState(e.target.value)}>
      <option value="todos">Todos</option><option value="pendiente">Pendientes</option><option value="pagado">Pagados</option><option value="cancelado">Cancelados</option>
    </select></label>
    {!filtered.length ? <p className="text-sm text-slate-300">No hay gastos programados en este estado. Creá una planificación para organizar tus vencimientos.</p> : null}
    <ul aria-label="Gastos programados guardados" className="grid gap-4">
      {filtered.map((row) => <li key={row.id} className="card grid min-w-0 gap-3 break-words p-4">
        <h2 className="text-lg font-semibold">{row.descripcion}</h2>
        <p className="text-sm text-slate-300">{row.categoria}</p>
        <p>Monto estimado: <strong>{money(row.monto_estimado)}</strong></p>
        <p>Vencimiento: {formatMobileDate(row.fecha_vencimiento)}</p>
        <p>Estado: {row.estado === "pagado" ? "Pagado" : row.estado === "cancelado" ? "Cancelado" : row.fecha_vencimiento < today ? "Pendiente · Vencido" : row.fecha_vencimiento === today ? "Pendiente · Vence hoy" : "Pendiente"}</p>
        <p>Recurrencia: {row.es_recurrente ? row.frecuencia === "semanal" ? "Semanal" : row.frecuencia === "anual" ? "Anual" : "Mensual" : "Sin recurrencia"}</p>
        <PlanningActions name={`planificación ${row.descripcion}`} onEdit={() => onEdit(row)} onDelete={() => onDelete(row)} />
        {row.estado === "pendiente" ? <button className="btn-secondary min-h-12" aria-label={`Marcar pagado ${row.descripcion}`} onClick={() => onPay(row)}>Marcar pagado</button> : null}
      </li>)}
    </ul>
  </section>;
}
