"use client";

import { useState } from "react";
import { money, monthName } from "../../../lib/format";
import { categoryShares, typeBars } from "../../../services/data/financeAnalytics";
import { useMobileAnalytics } from "../useMobileAnalytics";
import { AnalyticsMetrics, AnalyticsPeriod, AnalyticsState, MobileTrendChart } from "../analytics/MobileAnalyticsUI";
import { MobileDialog } from "../MobileDialog";
import { formatMobileDate } from "../mobileUi";

export function MobileStatistics() {
  const [period, setPeriod] = useState(() => { const now=new Date(); return { month:now.getMonth()+1, year:now.getFullYear() }; });
  const [category, setCategory] = useState<string | null>(null);
  const { data, loading, error, reload } = useMobileAnalytics("statistics", period);
  const stats=data?.statistics, categories=categoryShares(stats?.expenses_by_category ?? []);
  const detail=(data?.rows ?? []).filter(r=>r.tipo==='gasto' && r.categoria===category).slice(0,40);
  return <section className="grid min-w-0 gap-5" aria-label="Estadísticas financieras">
    <AnalyticsPeriod statistics period={period} onChange={(p)=>{setCategory(null);setPeriod(p);}} />
    <AnalyticsState loading={loading} error={error} onRetry={reload} />
    {!loading && stats ? <>
      {!data.rows?.length ? <p className="text-sm text-slate-300">No hay movimientos en el mes seleccionado. Podés consultar la evolución del año.</p> : null}
      <AnalyticsMetrics values={[
        {label:"Ingresos",value:money(stats.month_totals.ingreso)}, {label:"Gastos",value:money(stats.month_totals.gasto)},
        {label:"Balance",value:money(stats.month_totals.balance)}, {label:"Ahorro",value:money(stats.month_totals.ahorro ?? 0)}, {label:"Inversión",value:money(stats.month_totals.inversion ?? 0)},
      ]} />
      <section className="card grid min-w-0 gap-3 p-4" aria-label="Comparación por tipo"><h2 className="font-semibold">Ingresos, gastos, ahorro e inversión</h2>
        {typeBars(stats.month_totals).map(r=><div key={r.label} className="grid min-w-0 gap-2"><p className="break-words text-sm">{r.label}: {money(r.value)}</p><div className="h-3 overflow-hidden rounded-full bg-slate-700" aria-hidden="true"><div className="h-full rounded-full bg-cyan-400" style={{width:`${r.percent}%`}}/></div></div>)}
      </section>
      <section className="card grid min-w-0 gap-3 p-4" aria-label="Gastos por categoría"><h2 className="font-semibold">Gastos por categoría</h2>
        {!categories.length ? <p className="text-sm text-slate-300">No hay gastos por categoría en este período.</p> : categories.map(c=><button key={c.categoria_id ?? c.categoria} className="grid grid-cols-1 min-h-12 min-w-0 gap-2 rounded-lg border border-slate-600 p-3 text-left focus-visible:outline focus-visible:outline-cyan-300" onClick={()=>setCategory(c.categoria)}>
          <span className="break-words font-semibold">{c.categoria}</span><span className="text-sm">{money(c.total)} · {c.percent.toFixed(1)}% · {c.movimientos ?? 0} mov.</span>
          <span className="h-2 overflow-hidden rounded-full bg-slate-700" aria-hidden="true"><span className="block h-full rounded-full bg-cyan-400" style={{width:`${c.percent}%`}} /></span>
        </button>)}
      </section>
      <MobileTrendChart title="Evolución del año" rows={stats.trend.map(r=>({label:monthName(r.mes),ingresos:r.ingresos,gastos:r.gastos}))} />
      <section className="grid min-w-0 gap-3" aria-label="Proyección de planificación"><h2 className="font-semibold">Planificación</h2><p className="text-sm text-slate-300">La proyección se muestra por separado y no modifica los valores reales.</p>
        <AnalyticsMetrics values={[{label:"Vencido",value:money(stats.planificacion.total_vencido)},{label:"Pendiente 30 días",value:money(stats.planificacion.total_pendiente_30_dias)},{label:"Pagado con vencimiento este mes",value:money(stats.planificacion.total_pagado_mes)},{label:"Balance proyectado",value:money(stats.planificacion.balance_proyectado_mes)}]} />
      </section>
    </> : null}
    {category ? <MobileDialog title={`Movimientos: ${category}`} onClose={()=>setCategory(null)}>
      <p className="mb-3 text-sm">Total del período: {money(categories.find(c=>c.categoria===category)?.total ?? 0)}</p>
      <ul className="grid gap-3" aria-label="Gastos de la categoría">{detail.map(r=><li key={r.id} className="min-w-0 break-words rounded-lg border border-slate-600 p-3"><p>Gasto · {money(r.monto)}</p><p>{r.descripcion || "Sin descripción"}</p><p className="text-sm text-slate-300">{formatMobileDate(r.fecha)}</p>{r.nota ? <p className="text-sm">Nota: {r.nota}</p> : null}</li>)}</ul>
    </MobileDialog> : null}
  </section>;
}
