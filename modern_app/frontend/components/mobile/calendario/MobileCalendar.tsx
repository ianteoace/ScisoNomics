"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { FinanceCalendarDay, FinancePeriod } from "../../../services/data/financeRepositoryTypes";
import { adjacentPeriod, calendarGrid } from "../../../services/data/financeCalendar";
import { money, monthName } from "../../../lib/format";
import { MobileDialog } from "../MobileDialog";
import { formatMobileDate, typeLabel } from "../mobileUi";

export function MobileCalendar({ period, days, busy, onPeriod }: {
  period: FinancePeriod; days: FinanceCalendarDay[]; busy: boolean; onPeriod: (period: FinancePeriod) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const data = days.find((day) => day.fecha === selected);
  const cells = calendarGrid(period);
  function navigate(delta: -1 | 1) { setSelected(null); onPeriod(adjacentPeriod(period, delta)); }
  return <section aria-label="Calendario financiero" className="grid min-w-0 gap-4">
    <div className="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-2">
      <button className="btn-secondary flex min-h-12 items-center justify-center" aria-label="Mes anterior" disabled={busy || (period.year === 1 && period.month === 1)} onClick={() => navigate(-1)}><ChevronLeft aria-hidden="true" size={20} /></button>
      <h2 className="text-center font-semibold" aria-live="polite">{monthName(period.month)} {period.year}</h2>
      <button className="btn-secondary flex min-h-12 items-center justify-center" aria-label="Mes siguiente" disabled={busy || (period.year === 9999 && period.month === 12)} onClick={() => navigate(1)}><ChevronRight aria-hidden="true" size={20} /></button>
    </div>
    <p className="text-sm text-slate-300">Movimientos reales del mes. Tocá un día para ver el detalle.</p>
    {!days.length ? <p className="text-sm text-slate-300">No hay movimientos en este mes.</p> : null}
    <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-300" aria-hidden="true">{["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((day) => <span key={day}>{day}</span>)}</div>
    <div className="grid grid-cols-7 gap-1" role="group" aria-label="Días del mes">
      {cells.map((cell) => {
        const count = days.find((day) => day.fecha === cell.iso)?.movimientos.length ?? 0;
        return <button key={cell.iso} className={`grid min-h-12 min-w-0 content-center gap-1 rounded-lg border px-0 py-2 text-center text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 ${cell.inMonth ? "border-slate-600" : "border-slate-800 text-slate-400"} ${cell.isToday ? "ring-1 ring-cyan-300" : ""}`}
          aria-label={`${formatMobileDate(cell.iso)}: ${count} movimientos`} aria-current={cell.isToday ? "date" : undefined} disabled={busy || cell.iso.startsWith("0000") || cell.iso.length !== 10} onClick={() => setSelected(cell.iso)}>
          <span>{cell.day}</span><span className={`text-[10px] ${count ? "text-cyan-200" : "text-slate-500"}`}>{count ? `${count} mov.` : "·"}</span>
        </button>;
      })}
    </div>
    {selected ? <MobileDialog title={`Detalle ${formatMobileDate(selected)}`} onClose={() => setSelected(null)}>
      {!data ? <p className="text-slate-300">No hay eventos para este día. Podés agregar un movimiento desde Movimientos.</p> : <div className="grid gap-4">
        <div className="grid gap-2 text-sm">{(["ingreso", "gasto", "ahorro", "inversion"] as const).map((type) => <p key={type}>{typeLabel(type)}: <strong>{money(data.totales[type])}</strong></p>)}
          <p>Balance del día: <strong>{money(data.totales.ingreso - data.totales.gasto - data.totales.ahorro - data.totales.inversion)}</strong></p>
        </div>
        <ul className="grid gap-3" aria-label="Movimientos del día">{data.movimientos.map((row) => <li key={row.id} className="grid min-w-0 gap-2 break-words rounded-xl border border-slate-600 p-3">
          <p>Movimiento · {typeLabel(row.tipo)} · <strong>{money(row.monto)}</strong></p><p>{row.categoria}</p><p>{row.descripcion || "Sin descripción"}</p>{row.nota ? <p className="text-sm text-slate-300">Nota: {row.nota}</p> : null}
        </li>)}</ul>
      </div>}
    </MobileDialog> : null}
  </section>;
}
