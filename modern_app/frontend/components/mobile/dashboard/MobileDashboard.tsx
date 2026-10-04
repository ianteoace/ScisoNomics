"use client";

import { money } from "../../../lib/format";
import type { FinanceSummary } from "../../../services/data/financeSummary";
import type { FinanceMovimiento } from "../../../services/data/financeRepositoryTypes";
import { MobileMovementList } from "../movimientos/MobileMovementList";

export function MobileDashboard({ summary, rows, onCreate, onEdit }: {
  summary: FinanceSummary; rows: FinanceMovimiento[]; onCreate: () => void; onEdit: (row: FinanceMovimiento) => void;
}) {
  return <section aria-label="Resumen financiero">
    <div className="card p-5">
      <h2 className="text-sm text-slate-300">Saldo actual</h2><p className="mt-2 break-all text-3xl font-bold tabular-nums text-cyan-100">{money(summary.saldo)}</p>
      <p className="mt-3 break-words text-sm text-slate-300">Saldo del mes anterior: {money(summary.saldoInicial)}</p>
      <button className="btn mt-5 min-h-12 w-full" onClick={onCreate}>Agregar movimiento</button>
    </div>
    <div className="mt-4 grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
      {([["Ingresos", summary.ingresos], ["Gastos", summary.gastos], ["Ahorros", summary.ahorros], ["Inversiones", summary.inversiones]] as const).map(([label, value]) => <div key={label} className="card min-w-0 p-4"><h3 className="text-sm text-slate-300">{label}</h3><p className="mt-2 break-all text-lg font-bold tabular-nums">{money(value)}</p></div>)}
    </div>
    <p className="mt-3 text-sm text-slate-400">Balance del mes: {money(summary.balance)} (ingresos menos gastos).</p>
    <h2 className="mb-3 mt-7 text-xl font-bold">Últimos movimientos</h2>
    {rows.length ? <MobileMovementList rows={rows.slice(0, 5)} onEdit={onEdit} /> : <p className="card p-5 text-slate-300">No tenés movimientos este mes.</p>}
  </section>;
}
