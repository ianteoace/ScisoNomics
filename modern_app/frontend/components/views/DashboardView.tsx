"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { monthName, money, yearOptions } from "../../lib/format";
import type { GastoProgramado, Presupuesto, StatsResponse } from "../../types/domain";
import { ClientOnly } from "../ui/ClientOnly";
import { EmptyState } from "../ui/EmptyState";
import { LoadingGrid, LoadingSkeleton } from "../ui/LoadingSkeleton";
import { MetricCard } from "../ui/MetricCard";
import { SectionHeader } from "../ui/SectionHeader";

export function DashboardView({
  summary,
  previous,
  stats,
  upcoming,
  resumenPotente,
  presupuestos,
  month,
  year,
  onMonthChange,
  onYearChange,
  saldoActual,
  loading,
}: {
  summary: { saldo_inicial: number; ingreso: number; gasto: number; balance_final: number };
  previous: { ingreso: number; gasto: number } | null;
  stats: StatsResponse | null;
  upcoming: GastoProgramado[];
  resumenPotente: any;
  presupuestos: Presupuesto[];
  month: number;
  year: number;
  onMonthChange: (v: number) => void;
  onYearChange: (v: number) => void;
  saldoActual: number;
  loading: boolean;
}) {
  const incomeVar = previous && previous.ingreso ? ((summary.ingreso - previous.ingreso) / previous.ingreso) * 100 : null;
  const expenseVar = previous && previous.gasto ? ((summary.gasto - previous.gasto) / previous.gasto) * 100 : null;

  const barData = [
    { name: "Ingresos", value: summary.ingreso },
    { name: "Gastos", value: summary.gasto },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader title="Inicio" subtitle={`Vista general del mes: ${monthName(month)} ${year}`} />
      <div className="panel grid gap-2 p-3 md:grid-cols-3">
        <select className="input" value={month} onChange={(e) => onMonthChange(Number(e.target.value))}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </select>
        <select className="input" value={year} onChange={(e) => onYearChange(Number(e.target.value))}>
          {yearOptions(new Date().getFullYear(), [year]).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {loading ? (
        <LoadingGrid items={6} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <MetricCard title="Saldo inicial" value={money(summary.saldo_inicial)} tone="accent" />
          <MetricCard highlightOnHover title="Ingresos del mes" value={money(summary.ingreso)} tone="income" helper={incomeVar === null ? "Mes anterior: -" : `Mes anterior: ${incomeVar >= 0 ? "+" : ""}${incomeVar.toFixed(1)}%`} />
          <MetricCard highlightOnHover title="Gastos del mes" value={money(summary.gasto)} tone="expense" helper={expenseVar === null ? "Mes anterior: -" : `Mes anterior: ${expenseVar >= 0 ? "+" : ""}${expenseVar.toFixed(1)}%`} />
          <MetricCard highlightOnHover title="Ahorro del mes" value={money(resumenPotente?.ahorro_mes || 0)} tone="accent" />
          <MetricCard title="Balance mensual" value={money(resumenPotente?.balance_mensual ?? summary.balance_final)} tone={(resumenPotente?.balance_mensual ?? summary.balance_final) >= 0 ? "income" : "warn"} />
          <article className={`card p-5 transition-colors duration-200 hover:border-slate-300 dark:hover:border-white/40 ${saldoActual >= 0 ? "bg-emerald-50/60 dark:bg-emerald-950/20" : "bg-rose-50/60 dark:bg-rose-950/20"}`}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Saldo actual</p>
            <p className={`mt-2 text-3xl font-black tracking-tight ${saldoActual >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>{money(saldoActual)}</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{saldoActual >= 0 ? "Estado positivo" : "Estado ajustado"}</p>
          </article>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <section className="card p-5 transition-colors duration-200 hover:border-slate-300 dark:hover:border-white/40 xl:col-span-2">
          <SectionHeader title="Ingresos vs gastos" subtitle="Comparativa rápida del mes" />
          <div className="h-64">
            {loading ? (
              <div className="h-full w-full animate-pulse rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900" />
            ) : (
              <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800/40" />}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData}>
                    <XAxis dataKey="name" stroke="#95bfb8" />
                    <YAxis stroke="#95bfb8" />
                    <Tooltip
                      cursor={false}
                      formatter={(v: number) => [money(v), "valor"]}
                      contentStyle={{ borderRadius: 12, border: "1px solid rgb(var(--line))", background: "rgb(var(--card))" }}
                      itemStyle={{ color: "rgb(var(--text))" }}
                      labelStyle={{ color: "rgb(var(--text))" }}
                    />
                    <Bar dataKey="value" radius={10}>
                      {barData.map((entry) => (
                        <Cell key={entry.name} fill={entry.name === "Gastos" ? "rgb(var(--expense))" : "rgb(var(--income))"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ClientOnly>
            )}
          </div>
        </section>

        <section className="card p-5 transition-colors duration-200 hover:border-slate-300 dark:hover:border-white/40">
          <SectionHeader title="Próximos gastos" subtitle="Pendientes cercanos" />
          {loading ? (
            <LoadingSkeleton rows={5} />
          ) : (
            <div className="space-y-2">
              {upcoming.length === 0 ? <p className="text-sm text-slate-400">Sin vencimientos cercanos.</p> : null}
              {upcoming.slice(0, 8).map((item) => (
                <div key={item.id} className="rounded-xl border p-2.5 text-sm" style={{ borderColor: "rgb(var(--line))" }}>
                  <div className="flex justify-between gap-2"><span className="font-medium">{item.descripcion}</span><span className="font-semibold text-rose-300">{money(item.monto_estimado)}</span></div>
                  <div className="text-xs text-slate-400">{item.fecha_vencimiento} · {item.estado}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {!loading && stats ? (
        <div className="card p-4 text-sm text-slate-700 dark:text-slate-300">
          Balance proyectado del mes: <span className="font-semibold text-cyan-700 dark:text-cyan-300">{money(stats.planificacion.balance_proyectado_mes)}</span>
          <span className="ml-3">Disponible luego de ahorro: <strong>{money(resumenPotente?.disponible_luego_ahorro || 0)}</strong></span>
          {resumenPotente?.categoria_mayor_gasto ? <span className="ml-3">Mayor gasto: <strong>{resumenPotente.categoria_mayor_gasto.categoria}</strong></span> : null}
        </div>
      ) : null}
      <section className="card p-4 transition-colors duration-200 hover:border-slate-300 dark:hover:border-white/40">
        <SectionHeader title="Presupuestos y gastos por categoría" subtitle="Consumo por categoría del mes" />
        {loading ? (
          <LoadingSkeleton rows={6} />
        ) : (
          <>
            {presupuestos.length === 0 ? <EmptyState title="Sin presupuestos del mes" hint="No hay presupuestos cargados para este mes." /> : null}
            <div className="grid gap-2 md:grid-cols-2">
              {presupuestos.slice(0, 4).map((p) => <div key={p.id} className="rounded-lg border border-line p-2 text-left text-sm">{p.categoria}: {p.porcentaje_usado.toFixed(1)}% ({money(p.monto_gastado)} / {money(p.monto_presupuestado)})</div>)}
            </div>
            <div className="mt-3 space-y-2">
              {stats?.expenses_by_category.slice(0, 6).map((c) => (
                <div key={c.categoria} className="flex w-full items-center justify-between rounded-lg border border-line p-2 text-left text-sm">
                  <span>{c.categoria}</span>
                  <strong>{money(c.total)}</strong>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
