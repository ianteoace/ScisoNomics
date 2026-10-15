"use client";

import { useEffect, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import type { FinancePeriod } from "../../../services/data/financeRepositoryTypes";
import { money, monthName, yearOptions } from "../../../lib/format";

export function AnalyticsPeriod({ period, onChange, statistics = false }: { period: FinancePeriod; onChange: (period: FinancePeriod) => void; statistics?: boolean }) {
  const now = new Date();
  const years = statistics ? Array.from({ length: 7 }, (_, i) => now.getFullYear() + 3 - i) : yearOptions(now.getFullYear(), [period.year]);
  return <div className="grid min-w-0 gap-3">
    <div className="grid grid-cols-2 gap-3">
      <label className="grid min-w-0 gap-2 text-sm">Mes<select className="input min-h-12 min-w-0" value={period.month} onChange={(e) => onChange({ ...period, month: Number(e.target.value) })}>{Array.from({ length: 12 }, (_, i) => <option key={i+1} value={i+1}>{monthName(i+1)}</option>)}</select></label>
      <label className="grid min-w-0 gap-2 text-sm">Año<select className="input min-h-12 min-w-0" value={period.year} onChange={(e) => onChange({ ...period, year: Number(e.target.value) })}>{years.map(y=><option key={y} value={y}>{y}</option>)}</select></label>
    </div>
    <button className="btn-secondary min-h-12" onClick={() => onChange({ month: now.getMonth()+1, year: now.getFullYear() })}>Mes actual</button>
    <p className="text-sm text-slate-300" aria-live="polite">Período seleccionado: {monthName(period.month)} {period.year}</p>
  </div>;
}
export function AnalyticsMetrics({ values }: { values: { label: string; value: string }[] }) {
  return <div className="grid min-w-0 gap-3 sm:grid-cols-2">{values.map(v=><div key={v.label} className="card min-w-0 break-words p-4"><h3 className="text-sm text-slate-300">{v.label}</h3><p className="mt-2 text-xl font-semibold">{v.value}</p></div>)}</div>;
}
export function AnalyticsState({ loading, error, onRetry }: { loading: boolean; error: string; onRetry: () => void }) {
  return <>{loading ? <p role="status" className="text-slate-300">Cargando análisis…</p> : null}{error ? <div className="card grid gap-3 p-4"><p role="alert" className="break-words text-red-300">{error}</p><button className="btn-secondary min-h-12" onClick={onRetry}>Reintentar</button></div> : null}</>;
}
export type TrendPoint = { label: string; ingresos: number; gastos: number };
const axisOptions = { hide: false, mirror: false, reversed: false, allowDataOverflow: false, allowDecimals: true, allowDuplicatedCategory: true, tickCount: 5, scale: "auto" as const };
export function MobileTrendChart({ title, rows }: { title: string; rows: TrendPoint[] }) {
  const hasData = rows.some(r=>r.ingresos>0 || r.gastos>0);
  return <section className="card grid min-w-0 gap-3 p-4" aria-label={title}>
    <h2 className="font-semibold">{title}</h2>
    <p className="text-sm text-slate-300">Ingresos (línea continua) · Gastos (línea punteada)</p>
    {hasData ? <ResponsiveTrendLines title={title} rows={rows} /> : <p className="text-sm text-slate-300">No hay evolución disponible para este período.</p>}
    <details><summary className="flex min-h-12 cursor-pointer items-center rounded-lg border border-slate-600 px-3 focus-visible:outline focus-visible:outline-cyan-300">Ver datos de la evolución</summary>
      <ul className="mt-3 grid gap-3" aria-label="Datos de la evolución">{rows.map(r=><li key={r.label} className="min-w-0 break-words rounded-lg border border-slate-700 p-3 text-sm"><p className="font-semibold">{r.label}</p><p>Ingresos: {money(r.ingresos)}</p><p>Gastos: {money(r.gastos)}</p></li>)}</ul>
    </details>
  </section>;
}

export function ResponsiveTrendLines({ title, rows }: { title: string; rows: TrendPoint[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(0, Math.floor(element.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Explicit dimensions also work with Next's React runtime: Recharts 2's
  // ResponsiveContainer uses an older react-is that rejects its elements.
  return <div ref={container} className="min-w-0 overflow-hidden" style={{ height: 240 }} role="img" aria-label={`${title}: ingresos y gastos; datos completos debajo`}>
    {width > 0 ? <LineChart width={width} height={240} data={rows} accessibilityLayer margin={{ top: 8, right: 8, bottom: 8, left: -15 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
      <XAxis {...axisOptions} xAxisId={0} type="category" orientation="bottom" width={0} height={30} padding={{ left: 0, right: 0 }} dataKey="label" tick={{ fontSize: 10, fill: "#cbd5e1" }} minTickGap={18} />
      <YAxis {...axisOptions} yAxisId={0} type="number" orientation="left" height={0} width={60} domain={[0, "auto"]} padding={{ top: 0, bottom: 0 }} tick={{ fontSize: 10, fill: "#cbd5e1" }} />
      <Tooltip formatter={(v: number, name: string) => [money(v), name === "ingresos" ? "Ingresos" : "Gastos"]} contentStyle={{ background: "#0f172a", border: "1px solid #475569", borderRadius: 12, color: "#f1f5f9" }} wrapperStyle={{ maxWidth: "100%" }} />
      <Line xAxisId={0} yAxisId={0} type="monotone" dataKey="ingresos" stroke="#22c55e" strokeWidth={2} dot={false} isAnimationActive={false} />
      <Line xAxisId={0} yAxisId={0} type="monotone" dataKey="gastos" stroke="#f87171" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
    </LineChart> : null}
  </div>;
}
