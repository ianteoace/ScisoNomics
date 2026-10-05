"use client";

import { useState } from "react";
import type { AnnualStatsResponse } from "../../../types/domain";
import type { FinanceMonthlyReport } from "../../../services/data/financeRepositoryTypes";
import { money, monthName, yearOptions } from "../../../lib/format";
import { useMobileAnalytics } from "../useMobileAnalytics";
import { AnalyticsMetrics, AnalyticsPeriod, AnalyticsState, MobileTrendChart } from "../analytics/MobileAnalyticsUI";
import { formatMobileDate } from "../mobileUi";

export function MobileReport() {
  const [tab,setTab]=useState<"monthly"|"annual">("monthly");
  const [period,setPeriod]=useState(()=>{const now=new Date();return {month:now.getMonth()+1,year:now.getFullYear()};});
  const [year,setYear]=useState(()=>new Date().getFullYear());
  const {data,loading,error,reload}=useMobileAnalytics(tab,tab==='monthly'?period:{month:1,year});
  return <section className="grid min-w-0 gap-5" aria-label="Reporte financiero">
    <div className="grid grid-cols-2 gap-3" aria-label="Tipo de reporte">{([['monthly','Mensual'],['annual','Anual']] as const).map(([key,label])=><button key={key} className="btn-secondary min-h-12" aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</div>
    {tab==='monthly'?<AnalyticsPeriod period={period} onChange={setPeriod}/>:<label className="grid min-w-0 gap-2 text-sm">Año del reporte anual<select className="input min-h-12 min-w-0" value={year} onChange={e=>setYear(Number(e.target.value))}>{yearOptions(new Date().getFullYear(),[year]).map(y=><option key={y} value={y}>{y}</option>)}</select></label>}
    <AnalyticsState loading={loading} error={error} onRetry={reload}/>
    {!loading && data?.monthly ? <MonthlyReportContent report={data.monthly}/> : null}
    {!loading && data?.annual ? <AnnualReportContent report={data.annual}/> : null}
  </section>;
}
export function MonthlyReportContent({report:r}:{report:FinanceMonthlyReport}) {
  return <div className="grid min-w-0 gap-5" aria-label="Reporte mensual">
    <h2 className="font-semibold">Resumen de {monthName(r.month)} {r.year}</h2>
    <p className="text-sm text-slate-300">El balance operativo corresponde a ingresos menos gastos de este mes. El saldo acumulado se consulta en Inicio.</p>
    <AnalyticsMetrics values={[{label:"Ingresos",value:money(r.ingresos)},{label:"Gastos",value:money(r.gastos)},{label:"Ahorro",value:money(r.ahorro)},{label:"Inversiones",value:money(r.inversiones)},{label:"Balance operativo",value:money(r.balance_operativo)},{label:"Disponible luego de ahorro",value:money(r.disponible_luego_ahorro)}]}/>
    <section className="card grid min-w-0 gap-3 p-4"><h2 className="font-semibold">Top categorías</h2>{!r.top_categorias.length?<p className="text-sm text-slate-300">Sin datos de categorías para este mes.</p>:<ul className="grid gap-3">{r.top_categorias.map(c=><li key={c.categoria_id ?? c.categoria} className="min-w-0 break-words rounded-lg border border-slate-600 p-3"><p>{c.categoria}</p><strong>{money(c.total)}</strong></li>)}</ul>}</section>
    <section className="card grid min-w-0 gap-3 p-4"><h2 className="font-semibold">Top movimientos</h2>{!r.top_movimientos.length?<p className="text-sm text-slate-300">Sin gastos destacados para este mes.</p>:<ul className="grid gap-3">{r.top_movimientos.map(m=><li key={m.id} className="min-w-0 break-words rounded-lg border border-slate-600 p-3"><p>{m.descripcion || "Sin descripción"}</p><strong>{money(m.monto)}</strong><p className="text-sm text-slate-300">{formatMobileDate(m.fecha)} · {m.categoria}</p></li>)}</ul>}</section>
    <MobileTrendChart title="Últimos 6 meses" rows={r.evolucion_ultimos_6_meses.map(m=>({label:`${monthName(m.mes)} ${m.anio}`,ingresos:m.ingreso,gastos:m.gasto}))}/>
    <section className="card grid min-w-0 gap-3 p-4"><h2 className="font-semibold">Presupuestos excedidos</h2>{!r.presupuestos_excedidos.length?<p className="text-sm text-slate-300">No hay presupuestos excedidos en este mes.</p>:<ul className="grid gap-3">{r.presupuestos_excedidos.map(b=><li key={b.id} className="min-w-0 break-words rounded-lg border border-slate-600 p-3"><p>{b.categoria}</p><p>Límite: {money(b.monto_presupuestado)}</p><p>Gastado: {money(b.monto_gastado)}</p><p>Restante: {money(b.monto_disponible)} · {b.porcentaje_usado.toFixed(1)}%</p></li>)}</ul>}</section>
    <section className="card grid min-w-0 gap-3 p-4"><h2 className="font-semibold">Metas activas</h2>{!r.metas.length?<p className="text-sm text-slate-300">No hay metas activas.</p>:<ul className="grid gap-3">{r.metas.map(g=><li key={g.id} className="min-w-0 break-words rounded-lg border border-slate-600 p-3"><p>{g.nombre}</p><p>Ahorrado: {money(g.monto_ahorrado)}</p><p>Objetivo: {money(g.monto_objetivo)} · {g.porcentaje_completado.toFixed(1)}%</p></li>)}</ul>}</section>
  </div>;
}
export function AnnualReportContent({report:r}:{report:AnnualStatsResponse}) {
  if(!r.totals.movimientos)return <p className="text-sm text-slate-300">No hay datos suficientes para generar el reporte anual.</p>;
  return <div className="grid min-w-0 gap-5" aria-label="Reporte anual"><h2 className="font-semibold">Resumen financiero de {r.year}</h2>
    <AnalyticsMetrics values={[{label:"Ingresos del año",value:money(r.totals.ingresos)},{label:"Gastos del año",value:money(r.totals.gastos)},{label:"Ahorros del año",value:money(r.totals.ahorros)},{label:"Inversiones del año",value:money(r.totals.inversiones)},{label:"Balance anual",value:money(r.totals.balance)},{label:"Promedio mensual ingresos",value:money(r.promedios_mensuales.ingresos)},{label:"Promedio mensual gastos",value:money(r.promedios_mensuales.gastos)},{label:"Movimientos del año",value:String(r.totals.movimientos)}]}/>
    <AnalyticsMetrics values={[{label:"Mes con mayor ingreso",value:`${monthName(r.mes_mayor_ingreso?.mes ?? 1)} · ${money(r.mes_mayor_ingreso?.ingresos ?? 0)}`},{label:"Mes con mayor gasto",value:`${monthName(r.mes_mayor_gasto?.mes ?? 1)} · ${money(r.mes_mayor_gasto?.gastos ?? 0)}`},{label:"Categoría con mayor gasto",value:`${r.categoria_mayor_gasto?.categoria ?? "Sin categoría"} · ${money(r.categoria_mayor_gasto?.total ?? 0)}`}]} />
    <section className="grid min-w-0 gap-3"><h2 className="font-semibold">Resumen por mes</h2><ul className="grid gap-3">{r.monthly.map(m=><li key={m.mes} className="card min-w-0 break-words p-4 text-sm"><h3 className="mb-2 font-semibold">{monthName(m.mes)}</h3><p>Ingresos: {money(m.ingresos)}</p><p>Gastos: {money(m.gastos)}</p><p>Ahorros: {money(m.ahorros)}</p><p>Inversiones: {money(m.inversiones)}</p><p>Balance: {money(m.balance)}</p></li>)}</ul></section>
  </div>;
}
