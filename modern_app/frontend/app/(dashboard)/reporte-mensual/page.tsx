"use client";

import { useEffect, useMemo, useState } from "react";

import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorState } from "../../../components/ui/ErrorState";
import { LoadingGrid, LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { MetricCard } from "../../../components/ui/MetricCard";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { money, monthName, yearOptions } from "../../../lib/format";
import { api } from "../../../services/api";
import type { AnnualStatsResponse } from "../../../types/domain";

type ReportTab = "mensual" | "anual";

export default function ReporteMensualPage() {
  const { month, setMonth, year, setYear } = useDashboardUi();
  const [activeTab, setActiveTab] = useState<ReportTab>("mensual");
  const [report, setReport] = useState<any>(null);
  const [monthlyLoading, setMonthlyLoading] = useState(true);
  const [monthlyError, setMonthlyError] = useState("");
  const [monthlyUnavailable, setMonthlyUnavailable] = useState(false);
  const [annualYear, setAnnualYear] = useState(new Date().getFullYear());
  const [annual, setAnnual] = useState<AnnualStatsResponse | null>(null);
  const [annualLoading, setAnnualLoading] = useState(false);
  const [annualError, setAnnualError] = useState("");
  const { showError } = useToast();

  useEffect(() => {
    let cancelled = false;
    setMonthlyLoading(true);
    api.reporteMensual(month, year).then((data) => {
      if (cancelled) return;
      setReport(data);
      setMonthlyUnavailable(false);
      setMonthlyError("");
    }).catch((e: any) => {
      if (cancelled) return;
      setMonthlyUnavailable(true);
      setMonthlyError(e.message || "No se pudieron cargar los datos.");
      showError(e.message || "Error al cargar reporte mensual");
    }).finally(() => {
      if (!cancelled) setMonthlyLoading(false);
    });
    return () => { cancelled = true; };
  }, [month, year, showError]);

  useEffect(() => {
    if (activeTab !== "anual") return;
    let cancelled = false;
    setAnnualLoading(true);
    api.statsAnual(annualYear).then((data) => {
      if (cancelled) return;
      setAnnual(data);
      setAnnualError("");
    }).catch((e: any) => {
      if (cancelled) return;
      setAnnual(null);
      setAnnualError(e.message || "No se pudo cargar el reporte anual.");
      showError(e.message || "Error al cargar reporte anual");
    }).finally(() => {
      if (!cancelled) setAnnualLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeTab, annualYear, showError]);

  const tabButtonClass = (tab: ReportTab) =>
    `rounded-xl border px-4 py-2 text-sm font-semibold transition ${
      activeTab === tab
        ? "border-cyan-400 bg-cyan-400/15 text-cyan-700 dark:text-cyan-200"
        : "border-line text-muted hover:border-cyan-400/60 hover:text-cyan-700 dark:hover:text-cyan-200"
    }`;

  return (
    <section className="space-y-4">
      <header className="card p-5">
        <p className="text-xs uppercase tracking-widest text-muted">Reporte</p>
        <h2 className="text-2xl font-bold">Reportes financieros</h2>
        <p className="mt-2 text-sm text-muted">Consultá reportes financieros mensuales o anuales y exportá la información cuando lo necesites.</p>
      </header>

      <div className="panel flex flex-col gap-3 p-3 md:flex-row md:items-center md:justify-between">
        <div className="flex gap-2">
          <button className={tabButtonClass("mensual")} onClick={() => setActiveTab("mensual")}>Mensual</button>
          <button className={tabButtonClass("anual")} onClick={() => setActiveTab("anual")}>Anual</button>
        </div>
        <p className="text-sm text-muted">
          {activeTab === "mensual" ? `Reporte mensual: ${monthName(month)} ${year}` : `Reporte anual: ${annualYear}`}
        </p>
      </div>

      {activeTab === "mensual" ? (
        <MonthlyReport
          month={month}
          year={year}
          setMonth={setMonth}
          setYear={setYear}
          report={report}
          loading={monthlyLoading}
          loadError={monthlyError}
          unavailable={monthlyUnavailable}
        />
      ) : (
        <AnnualReport
          annual={annual}
          year={annualYear}
          setYear={setAnnualYear}
          loading={annualLoading}
          loadError={annualError}
        />
      )}
    </section>
  );
}

function MonthlyReport({
  month,
  year,
  setMonth,
  setYear,
  report,
  loading,
  loadError,
  unavailable,
}: {
  month: number;
  year: number;
  setMonth: (month: number) => void;
  setYear: (year: number) => void;
  report: any;
  loading: boolean;
  loadError: string;
  unavailable: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="panel grid gap-2 p-3 md:grid-cols-2">
        <select className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </select>
        <select className="input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {yearOptions(new Date().getFullYear(), [year]).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {loadError && !loading ? <ErrorState title="No se pudieron cargar los datos." description={loadError} /> : null}
      {unavailable && !loading ? <EmptyState title="Sección no disponible" hint="No se pudo cargar la información de este reporte." /> : null}
      {loading ? (
        <div className="space-y-4">
          <LoadingGrid items={6} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" />
          <LoadingSkeleton rows={8} />
        </div>
      ) : report ? (
        <div className="space-y-4">
          <SectionHeader title="Reporte mensual" subtitle={`Resumen de ${monthName(month)} ${year}`} />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <MetricCard title="Ingresos" value={money(report.ingresos ?? 0)} tone="income" />
            <MetricCard title="Gastos" value={money(report.gastos ?? 0)} tone="expense" />
            <MetricCard title="Ahorro" value={money(report.ahorro ?? 0)} />
            <MetricCard title="Inversiones" value={money(report.inversiones ?? 0)} />
            <MetricCard title="Balance operativo" value={money(report.balance_operativo ?? 0)} tone={(report.balance_operativo ?? 0) >= 0 ? "accent" : "warn"} />
            <MetricCard title="Disponible luego de ahorro" value={money(report.disponible_luego_ahorro ?? 0)} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="card p-4">
              <h3 className="mb-2 text-sm font-semibold">Top categorías</h3>
              {!Array.isArray(report.top_categorias) || report.top_categorias.length === 0 ? <EmptyState title="Sin datos de categorías" hint="No hay información para este período." /> : null}
              <div className="space-y-2 text-sm">
                {(report.top_categorias || []).slice(0, 6).map((c: any, i: number) => (
                  <div key={`${c.categoria}-${i}`} className="flex items-center justify-between rounded-lg border border-line p-2">
                    <span>{c.categoria || "Sin categoría"}</span>
                    <strong>{money(c.total || 0)}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="card p-4">
              <h3 className="mb-2 text-sm font-semibold">Top movimientos</h3>
              {!Array.isArray(report.top_movimientos) || report.top_movimientos.length === 0 ? <EmptyState title="Sin movimientos destacados" hint="No hay datos para este período." /> : null}
              <div className="space-y-2 text-sm">
                {(report.top_movimientos || []).slice(0, 6).map((m: any, i: number) => (
                  <div key={`${m.id || i}`} className="rounded-lg border border-line p-2">
                    <div className="flex items-center justify-between">
                      <span>{m.descripcion || "Sin descripción"}</span>
                      <strong>{money(m.monto || 0)}</strong>
                    </div>
                    <p className="text-xs text-muted">{m.fecha || "-"} · {m.categoria || "Sin categoría"}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      ) : !unavailable ? <EmptyState title="Sin datos para este mes" hint="No se encontraron movimientos o agregados para el período seleccionado." /> : null}
    </div>
  );
}

function AnnualReport({
  annual,
  year,
  setYear,
  loading,
  loadError,
}: {
  annual: AnnualStatsResponse | null;
  year: number;
  setYear: (year: number) => void;
  loading: boolean;
  loadError: string;
}) {
  const yearList = useMemo(() => yearOptions(new Date().getFullYear(), [year]), [year]);

  return (
    <div className="space-y-4">
      <div className="panel grid gap-2 p-3 md:grid-cols-2">
        <select className="input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {yearList.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className="rounded-lg border border-line px-3 py-2 text-sm text-slate-600 dark:text-slate-300">
          Año seleccionado: <strong>{year}</strong>
        </div>
      </div>

      {loadError && !loading ? <ErrorState title="No se pudo cargar el reporte anual." description={loadError} /> : null}
      {loading ? (
        <div className="space-y-4">
          <LoadingGrid items={8} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" />
          <LoadingSkeleton rows={10} />
        </div>
      ) : null}
      {!loading && !loadError && (!annual || annual.totals.movimientos === 0) ? (
        <EmptyState title="No hay datos suficientes para generar el reporte anual." hint="Probá con otro año o cargá nuevos movimientos." />
      ) : null}
      {!loading && !loadError && annual && annual.totals.movimientos > 0 ? <AnnualReportContent annual={annual} /> : null}
    </div>
  );
}

function AnnualReportContent({ annual }: { annual: AnnualStatsResponse }) {
  return (
    <div className="space-y-4">
      <SectionHeader title="Reporte anual" subtitle={`Resumen financiero de ${annual.year}`} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Ingresos del año" value={money(annual.totals.ingresos)} tone="income" />
        <MetricCard title="Gastos del año" value={money(annual.totals.gastos)} tone="expense" />
        <MetricCard title="Ahorros del año" value={money(annual.totals.ahorros)} />
        <MetricCard title="Inversiones del año" value={money(annual.totals.inversiones)} />
        <MetricCard title="Balance anual" value={money(annual.totals.balance)} tone={annual.totals.balance >= 0 ? "accent" : "warn"} />
        <MetricCard title="Promedio mensual ingresos" value={money(annual.promedios_mensuales.ingresos)} />
        <MetricCard title="Promedio mensual gastos" value={money(annual.promedios_mensuales.gastos)} />
        <MetricCard title="Movimientos del año" value={String(annual.totals.movimientos)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <article className="card p-4">
          <p className="text-xs uppercase tracking-widest text-muted">Mes con mayor ingreso</p>
          <p className="mt-2 text-xl font-bold">{annual.mes_mayor_ingreso ? monthName(annual.mes_mayor_ingreso.mes) : "-"}</p>
          <p className="text-sm text-muted">{money(annual.mes_mayor_ingreso?.ingresos || 0)}</p>
        </article>
        <article className="card p-4">
          <p className="text-xs uppercase tracking-widest text-muted">Mes con mayor gasto</p>
          <p className="mt-2 text-xl font-bold">{annual.mes_mayor_gasto ? monthName(annual.mes_mayor_gasto.mes) : "-"}</p>
          <p className="text-sm text-muted">{money(annual.mes_mayor_gasto?.gastos || 0)}</p>
        </article>
        <article className="card p-4">
          <p className="text-xs uppercase tracking-widest text-muted">Categoría con mayor gasto</p>
          <p className="mt-2 text-xl font-bold">{annual.categoria_mayor_gasto?.categoria || "-"}</p>
          <p className="text-sm text-muted">{money(annual.categoria_mayor_gasto?.total || 0)}</p>
        </article>
      </div>

      <section className="card overflow-hidden">
        <div className="border-b border-line p-4">
          <h3 className="text-sm font-semibold">Resumen por mes</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-100 text-left text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-900/50 dark:text-slate-400">
              <tr>
                <th className="px-4 py-3">Mes</th>
                <th className="px-4 py-3">Ingresos</th>
                <th className="px-4 py-3">Gastos</th>
                <th className="px-4 py-3">Ahorros</th>
                <th className="px-4 py-3">Inversiones</th>
                <th className="px-4 py-3">Balance</th>
              </tr>
            </thead>
            <tbody>
              {annual.monthly.map((row) => (
                <tr key={row.mes} className="border-t border-line">
                  <td className="px-4 py-3 font-semibold">{monthName(row.mes)}</td>
                  <td className="px-4 py-3 text-emerald-600 dark:text-emerald-300">{money(row.ingresos)}</td>
                  <td className="px-4 py-3 text-rose-600 dark:text-rose-300">{money(row.gastos)}</td>
                  <td className="px-4 py-3">{money(row.ahorros)}</td>
                  <td className="px-4 py-3">{money(row.inversiones)}</td>
                  <td className={`px-4 py-3 font-semibold ${row.balance >= 0 ? "text-cyan-600 dark:text-cyan-300" : "text-amber-600 dark:text-amber-300"}`}>{money(row.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
