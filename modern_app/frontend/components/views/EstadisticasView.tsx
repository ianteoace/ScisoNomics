"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

import { money, monthName } from "../../lib/format";
import type { Movimiento, StatsResponse } from "../../types/domain";
import { EmptyState } from "../ui/EmptyState";
import { LoadingGrid, LoadingSkeleton } from "../ui/LoadingSkeleton";
import { MetricCard } from "../ui/MetricCard";
import { SectionHeader } from "../ui/SectionHeader";
import { ClientOnly } from "../ui/ClientOnly";
import { Modal } from "../ui/Modal";

const palette = ["#00bcd4", "#ff7043", "#7e57c2", "#66bb6a", "#ec407a", "#26a69a", "#ffca28", "#42a5f5", "#ab47bc", "#8d6e63", "#26c6da", "#ef5350"];
const incomeColor = "#22c55e";
const expenseColor = "#ef4444";
const savingsColor = "#0ea5e9";
const investmentColor = "#a855f7";

export function EstadisticasView({ stats, monthRows, loading }: { stats: StatsResponse | null; monthRows: Movimiento[]; loading: boolean }) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [hoverCategory, setHoverCategory] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTotal, setModalTotal] = useState(0);

  const categoryData = useMemo(
    () => (stats?.expenses_by_category || []).map((item) => ({
      categoria_id: item.categoria_id,
      categoria: item.categoria,
      name: item.categoria,
      total: Number(item.total || 0),
      value: Number(item.total || 0),
      movimientos: Number(item.movimientos || 0),
    })),
    [stats],
  );

  const trendData = useMemo(
    () => (stats?.trend || [])
      .map((item) => ({
        mes: Number(item.mes || 0),
        name: monthName(Number(item.mes || 0)),
        ingresos: Number(item.ingresos || 0),
        gastos: Number(item.gastos || 0),
        balance: Number(item.ingresos || 0) - Number(item.gastos || 0),
      }))
      .sort((a, b) => a.mes - b.mes),
    [stats],
  );

  const activeCategory = selectedCategory || categoryData[0]?.categoria || null;

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
  const totalIngresos = Number(stats.month_totals.ingreso || 0);
  const totalGastos = Number(stats.month_totals.gasto || 0);
  const totalAhorro = Number(stats.month_totals.ahorro || 0);
  const totalInversion = Number(stats.month_totals.inversion || 0);
  const totalBalance = Number(stats.month_totals.balance || 0);
  const totalVencido = Number(stats.planificacion.total_vencido || 0);
  const totalPendiente30Dias = Number(stats.planificacion.total_pendiente_30_dias || 0);
  const totalPagadoMes = Number(stats.planificacion.total_pagado_mes || 0);
  const balanceProyectado = Number(stats.planificacion.balance_proyectado_mes || 0);
  const hasData = monthRows.length > 0
    || totalIngresos > 0
    || totalGastos > 0
    || totalAhorro > 0
    || totalInversion > 0
    || categoryData.length > 0
    || trendData.some((item) => item.ingresos > 0 || item.gastos > 0);
  if (!hasData) return <EmptyState title="Sin estadísticas para este período" hint="No hay movimientos en el período seleccionado." ctaLabel="Cambiar período" />;

  const barData = [
    { nombre: "Ingresos", total: totalIngresos },
    { nombre: "Gastos", total: totalGastos },
    { nombre: "Ahorro", total: totalAhorro },
    { nombre: "Inversión", total: totalInversion },
  ];
  const maxBarValue = Math.max(...barData.map((item) => item.total), 1);
  const totalExpensesByCategory = categoryData.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const hasCategoryChartData = categoryData.some((item) => item.value > 0);
  const hasTrendChartData = trendData.some((item) => item.ingresos > 0 || item.gastos > 0);
  const piePercentLabel = ({ total }: { total?: number }) => {
    if (!totalExpensesByCategory) return "";
    const percent = ((Number(total || 0) / totalExpensesByCategory) * 100).toFixed(1);
    return `${percent}%`;
  };

  return (
    <div className="grid gap-4">
      <SectionHeader title="Estadísticas" subtitle="Análisis visual del período seleccionado" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Ingresos" value={money(totalIngresos)} tone="income" />
        <MetricCard title="Gastos" value={money(totalGastos)} tone="expense" />
        <MetricCard title="Balance" value={money(totalBalance)} tone={totalBalance >= 0 ? "accent" : "warn"} />
        <MetricCard title="Ahorro" value={money(totalAhorro)} />
        <MetricCard title="Inversión" value={money(totalInversion)} />
        <MetricCard title="Vencido" value={money(totalVencido)} tone={totalVencido > 0 ? "warn" : "default"} />
        <MetricCard title="Pendiente 30 días" value={money(totalPendiente30Dias)} />
        <MetricCard title="Balance proyectado" value={money(balanceProyectado)} tone={balanceProyectado >= 0 ? "accent" : "warn"} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <section className="card p-4 xl:col-span-1">
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Gastos por categoría</h3>
          <div className="rounded-lg border border-line p-4">
            {!hasCategoryChartData ? (
              <EmptyState title="Sin gastos por categoría" hint="No hay gastos por categoría en este período." ctaLabel="Cambiar período" />
            ) : (
              <div className="space-y-3">
                {categoryData.map((item, index) => {
                  const active = item.categoria === hoverCategory || item.name === hoverCategory;
                  const percent = piePercentLabel({ total: item.value });
                  return (
                    <button
                      key={item.name}
                      type="button"
                      className={`w-full rounded-lg border p-3 text-left transition ${active ? "border-slate-400 dark:border-slate-500" : "border-line"}`}
                      onMouseEnter={() => setHoverCategory(item.categoria)}
                      onMouseLeave={() => setHoverCategory(null)}
                      onClick={() => {
                        setSelectedCategory(item.categoria);
                        setModalTotal(Number(item.value || 0));
                        setModalOpen(true);
                      }}
                    >
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: palette[index % palette.length] }} />
                          <span className="truncate text-sm">{item.name}</span>
                        </div>
                        <span className="text-xs text-slate-500 dark:text-slate-400">{percent}</span>
                      </div>
                      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                        <span>{money(item.value)}</span>
                        <span>{item.movimientos} mov.</span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-800">
                        <div
                          className="h-2 rounded-full"
                          style={{
                            width: `${Math.max(6, totalExpensesByCategory > 0 ? (item.value / totalExpensesByCategory) * 100 : 0)}%`,
                            backgroundColor: palette[index % palette.length],
                          }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Categoría activa: <span className="text-cyan-700 dark:text-cyan-300">{activeCategory || "-"}</span></p>
        </section>

        <section className="card p-4 xl:col-span-2">
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Barras ingresos vs gastos</h3>
          <div className="rounded-lg border border-line p-4">
            <div className="space-y-4">
              {barData.map((entry) => {
                const color =
                  entry.nombre === "Ingresos"
                    ? incomeColor
                    : entry.nombre === "Gastos"
                      ? expenseColor
                      : entry.nombre === "Ahorro"
                        ? savingsColor
                        : investmentColor;
                return (
                  <div key={entry.nombre}>
                    <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                      <span>{entry.nombre}</span>
                      <span>{money(entry.total)}</span>
                    </div>
                    <div className="h-3 rounded-full bg-slate-200 dark:bg-slate-800">
                      <div
                        className="h-3 rounded-full"
                        style={{
                          width: `${Math.max(6, (entry.total / maxBarValue) * 100)}%`,
                          backgroundColor: color,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>

        <section className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Línea de balance mensual</h3>
          <div className="h-72">
            {!hasTrendChartData ? (
              <EmptyState title="Sin evolución disponible" hint="No hay evolución disponible para este período." ctaLabel="Cambiar período" />
            ) : (
              <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800/40" />}>
                <div className="flex h-full items-center justify-center overflow-x-auto">
                  <LineChart width={640} height={260} data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" />
                    <XAxis dataKey="name" stroke="rgb(var(--muted))" />
                    <YAxis stroke="rgb(var(--muted))" />
                  <Tooltip
                    formatter={(v: number) => [money(v), "valor"]}
                    labelFormatter={(label) => `Mes: ${label}`}
                    contentStyle={{ borderRadius: 12, border: "1px solid rgb(var(--line))", background: "rgb(var(--card))" }}
                    itemStyle={{ color: "rgb(var(--text))" }}
                    labelStyle={{ color: "rgb(var(--text))" }}
                    />
                    <Line type="monotone" dataKey="ingresos" stroke={incomeColor} strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="gastos" stroke={expenseColor} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </div>
              </ClientOnly>
            )}
          </div>
        </section>

      <section className="card p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Planificación</h3>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard title="Vencido" value={money(totalVencido)} tone={totalVencido > 0 ? "warn" : "default"} />
          <MetricCard title="Pendiente 30 días" value={money(totalPendiente30Dias)} />
          <MetricCard title="Pagado del mes" value={money(totalPagadoMes)} />
          <MetricCard title="Balance proyectado" value={money(balanceProyectado)} tone={balanceProyectado >= 0 ? "accent" : "warn"} />
        </div>
      </section>

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
