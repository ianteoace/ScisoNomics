"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { money, monthName } from "../../lib/format";
import type { AnnualStatsResponse, Movimiento, StatsResponse } from "../../types/domain";
import { EmptyState } from "../ui/EmptyState";
import { LoadingGrid, LoadingSkeleton } from "../ui/LoadingSkeleton";
import { MetricCard } from "../ui/MetricCard";
import { SectionHeader } from "../ui/SectionHeader";
import { ClientOnly } from "../ui/ClientOnly";
import { Modal } from "../ui/Modal";

const palette = ["#00bcd4", "#ff7043", "#7e57c2", "#66bb6a", "#ec407a", "#26a69a", "#ffca28", "#42a5f5", "#ab47bc", "#8d6e63", "#26c6da", "#ef5350"];

export function EstadisticasView({ stats, monthRows, loading, annual }: { stats: StatsResponse | null; monthRows: Movimiento[]; loading: boolean; annual: AnnualStatsResponse | null }) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [hoverCategory, setHoverCategory] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTotal, setModalTotal] = useState(0);

  const activeCategory = selectedCategory || stats?.expenses_by_category?.[0]?.categoria || null;

  const selectedByCategory = useMemo(() => {
    if (!activeCategory) return [];
    return monthRows.filter((r) => r.tipo === "gasto" && r.categoria === activeCategory);
  }, [activeCategory, monthRows]);

  if (loading) {
    return (
      <div className="grid gap-4">
        <LoadingGrid items={4} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" />
        <LoadingSkeleton rows={8} />
      </div>
    );
  }
  if (!stats) return <EmptyState title="Sin estadísticas" hint="No hay datos para este período." ctaLabel="Cambiar filtros" />;
  const hasData = monthRows.length > 0 || stats.expenses_by_category.length > 0 || stats.month_totals.ingreso > 0 || stats.month_totals.gasto > 0;
  if (!hasData) return <EmptyState title="Sin estadísticas para este período" hint="No hay movimientos en el período seleccionado." ctaLabel="Cambiar período" />;

  const barData = [
    { nombre: "Ingresos", total: stats.month_totals.ingreso },
    { nombre: "Gastos", total: stats.month_totals.gasto },
  ];

  return (
    <div className="grid gap-4">
      <SectionHeader title="Estadísticas" subtitle="Análisis visual del período seleccionado" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Ingresos" value={money(stats.month_totals.ingreso)} tone="income" />
        <MetricCard title="Gastos" value={money(stats.month_totals.gasto)} tone="expense" />
        <MetricCard title="Balance" value={money(stats.month_totals.balance)} tone={stats.month_totals.balance >= 0 ? "accent" : "warn"} />
        <MetricCard title="Categorías con gasto" value={String(stats.expenses_by_category.length)} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <section className="card p-4 xl:col-span-1">
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Torta interactiva por categoría</h3>
          <div className="h-72">
            <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800/40" />}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={stats.expenses_by_category}
                    dataKey="total"
                    nameKey="categoria"
                    outerRadius={100}
                    label
                    isAnimationActive={false}
                    onMouseEnter={(entry: any) => setHoverCategory(entry?.categoria || null)}
                    onMouseLeave={() => setHoverCategory(null)}
                    onClick={(entry: any) => {
                      const category = entry?.categoria || null;
                      setSelectedCategory(category);
                      setModalTotal(Number(entry?.total || 0));
                      setModalOpen(true);
                    }}
                  >
                    {stats.expenses_by_category.map((entry, i) => {
                      const active = entry.categoria === hoverCategory;
                      return <Cell key={i} fill={palette[i % palette.length]} style={{ cursor: "pointer" }} stroke={active ? "rgb(var(--text))" : "transparent"} strokeWidth={active ? 2 : 0} opacity={active ? 1 : 0.8} />;
                    })}
                  </Pie>
                  <Tooltip
                    cursor={false}
                    formatter={(v: number) => [money(v), "valor"]}
                    labelFormatter={(label) => `Categoría: ${label}`}
                    contentStyle={{ borderRadius: 12, border: "1px solid rgb(var(--line))", background: "rgb(var(--card))" }}
                    itemStyle={{ color: "rgb(var(--text))" }}
                    labelStyle={{ color: "rgb(var(--text))" }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </ClientOnly>
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Categoría activa: <span className="text-cyan-700 dark:text-cyan-300">{activeCategory || "-"}</span></p>
        </section>

        <section className="card p-4 xl:col-span-2">
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Barras ingresos vs gastos</h3>
          <div className="h-72">
            <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800/40" />}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" />
                <XAxis dataKey="nombre" stroke="rgb(var(--muted))" />
                <YAxis stroke="rgb(var(--muted))" />
                <Tooltip
                  cursor={false}
                  formatter={(v: number) => [money(v), "valor"]}
                  contentStyle={{ borderRadius: 12, border: "1px solid rgb(var(--line))", background: "rgb(var(--card))" }}
                  itemStyle={{ color: "rgb(var(--text))" }}
                  labelStyle={{ color: "rgb(var(--text))" }}
                />
                <Bar dataKey="total" radius={8} isAnimationActive={false}>
                  {barData.map((entry) => <Cell key={entry.nombre} fill={entry.nombre === "Ingresos" ? "rgb(var(--income))" : "rgb(var(--expense))"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ClientOnly>
          </div>
        </section>
      </div>

      <section className="card p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Línea de balance mensual</h3>
        <div className="h-72">
          <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800/40" />}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={stats.trend.map((r) => ({ ...r, balance: r.ingresos - r.gastos }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" />
                <XAxis dataKey="mes" stroke="rgb(var(--muted))" tickFormatter={(m) => monthName(Number(m))} />
                <YAxis stroke="rgb(var(--muted))" />
                <Tooltip
                  formatter={(v: number) => [money(v), "valor"]}
                  labelFormatter={(m) => `Mes: ${monthName(Number(m))}`}
                  contentStyle={{ borderRadius: 12, border: "1px solid rgb(var(--line))", background: "rgb(var(--card))" }}
                  itemStyle={{ color: "rgb(var(--text))" }}
                  labelStyle={{ color: "rgb(var(--text))" }}
                />
                <Line type="monotone" dataKey="balance" stroke="#4ad4c3" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </ClientOnly>
        </div>
      </section>

      {annual ? (
        <>
          <SectionHeader title="Resumen anual" subtitle={`Año ${annual.year}`} />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="Ingresos del año" value={money(annual.totals.ingresos)} tone="income" />
            <MetricCard title="Gastos del año" value={money(annual.totals.gastos)} tone="expense" />
            <MetricCard title="Ahorros del año" value={money(annual.totals.ahorros)} />
            <MetricCard title="Inversiones del año" value={money(annual.totals.inversiones)} />
            <MetricCard title="Balance anual" value={money(annual.totals.balance)} tone={annual.totals.balance >= 0 ? "accent" : "warn"} />
            <MetricCard title="Promedio ingreso mensual" value={money(annual.promedios_mensuales.ingresos)} />
            <MetricCard title="Promedio gasto mensual" value={money(annual.promedios_mensuales.gastos)} />
            <MetricCard title="Movimientos del año" value={String(annual.totals.movimientos)} />
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            <section className="card p-4 xl:col-span-2">
              <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Ingresos vs gastos por mes</h3>
              <div className="h-72">
                <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800/40" />}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={annual.monthly}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" />
                      <XAxis dataKey="mes" stroke="rgb(var(--muted))" tickFormatter={(m) => monthName(Number(m))} />
                      <YAxis stroke="rgb(var(--muted))" />
                      <Tooltip formatter={(v: number) => [money(v), "valor"]} />
                      <Bar dataKey="ingresos" fill="rgb(var(--income))" radius={6} isAnimationActive={false} />
                      <Bar dataKey="gastos" fill="rgb(var(--expense))" radius={6} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </ClientOnly>
              </div>
            </section>
            <section className="card p-4 xl:col-span-1">
              <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Gastos por categoría (año)</h3>
              <div className="h-72">
                <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800/40" />}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={annual.gastos_por_categoria} dataKey="total" nameKey="categoria" outerRadius={95} label isAnimationActive={false}>
                        {annual.gastos_por_categoria.map((entry, i) => <Cell key={`${entry.categoria}-${i}`} fill={palette[i % palette.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v: number) => [money(v), "gasto"]} />
                    </PieChart>
                  </ResponsiveContainer>
                </ClientOnly>
              </div>
            </section>
          </div>
          <section className="card p-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Balance mensual del año</h3>
            <div className="h-72">
              <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800/40" />}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={annual.monthly}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" />
                    <XAxis dataKey="mes" stroke="rgb(var(--muted))" tickFormatter={(m) => monthName(Number(m))} />
                    <YAxis stroke="rgb(var(--muted))" />
                    <Tooltip formatter={(v: number) => [money(v), "balance"]} />
                    <Line type="monotone" dataKey="balance" stroke="#4ad4c3" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ClientOnly>
            </div>
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
              Mes con mayor gasto: <strong>{annual.mes_mayor_gasto ? monthName(annual.mes_mayor_gasto.mes) : "-"}</strong> ·
              Mes con mayor ingreso: <strong>{annual.mes_mayor_ingreso ? monthName(annual.mes_mayor_ingreso.mes) : "-"}</strong> ·
              Categoría con mayor gasto: <strong>{annual.categoria_mayor_gasto?.categoria || "-"}</strong>
            </p>
          </section>
        </>
      ) : null}

      <Modal open={modalOpen} title={`Movimientos: ${activeCategory || "-"}`} onClose={() => setModalOpen(false)}>
        <p className="mb-2 text-sm">Total del período: <strong>{money(modalTotal)}</strong></p>
        {selectedByCategory.length === 0 ? <EmptyState title="Sin movimientos" hint="No hay gastos para esta categoría en el período seleccionado." ctaLabel="Cerrar" /> : null}
        <div className="space-y-2">
          {selectedByCategory.slice(0, 40).map((r) => (
            <div key={r.id} className="rounded-lg border border-line p-2 text-sm">
              <div className="flex items-center justify-between">
                <span>{r.fecha}</span>
                <strong className="text-rose-300">{money(r.monto)}</strong>
              </div>
              <div>{r.descripcion || "Sin descripción"}</div>
              <div className="text-xs text-slate-400">Método/nota: {(r as any).metodo || (r as any).nota || "-"}</div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
