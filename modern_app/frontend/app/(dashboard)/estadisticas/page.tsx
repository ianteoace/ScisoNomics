"use client";

import { useEffect, useMemo, useState } from "react";

import { ErrorState } from "../../../components/ui/ErrorState";
import { EstadisticasView } from "../../../components/views/EstadisticasView";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { monthName } from "../../../lib/format";
import { api } from "../../../services/api";
import type { Movimiento, MovimientosResponse, StatsResponse } from "../../../types/domain";

export default function EstadisticasPage() {
  const now = useMemo(() => new Date(), []);
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const { setSaldoActual, setTopbarPeriodLabelOverride } = useDashboardUi();
  const { showError } = useToast();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [rows, setRows] = useState<Movimiento[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { stats: rawStats, movimientos, statsFallbackUsed } = await loadStatsForPeriod(selectedMonth, selectedYear);
        if (cancelled) return;

        let normalizedStats = normalizeStatsResponse(rawStats, movimientos.rows);
        let usedStatsFallback = statsFallbackUsed || normalizedStats === null;

        if (!normalizedStats) {
          normalizedStats = buildStatsFallbackFromRows(movimientos.rows);
          usedStatsFallback = true;
        }

        setStats(normalizedStats);
        setRows(movimientos.rows);
        setSaldoActual(0);
        setLoadError("");

        if (usedStatsFallback) {
          console.warn("Estadísticas cargadas con fallback local.", {
            month: selectedMonth,
            year: selectedYear,
            rows: movimientos.rows.length,
          });
        }
      } catch (e: any) {
        if (!cancelled) {
          console.error("Error cargando estadísticas", { month: selectedMonth, year: selectedYear, error: e });
          setLoadError(e.message || "No se pudieron cargar los datos.");
          showError("No se pudieron cargar las estadísticas. Intentá nuevamente.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedMonth, selectedYear, retryNonce, setSaldoActual, showError]);

  const periodLabel = `${monthName(selectedMonth)} ${selectedYear}`;
  const yearOptions = getSelectableYears(currentYear);

  useEffect(() => {
    setTopbarPeriodLabelOverride(periodLabel);
    return () => setTopbarPeriodLabelOverride(null);
  }, [periodLabel, setTopbarPeriodLabelOverride]);

  return (
    <div className="space-y-4">
      <div className="panel grid gap-3 p-3 md:grid-cols-[1fr_1fr_auto]">
        <label className="space-y-1 text-sm">
          <span className="text-slate-600 dark:text-slate-300">Mes</span>
          <select className="input" value={selectedMonth} onChange={(e) => setSelectedMonth(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
              <option key={month} value={month}>
                {monthName(month)}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-slate-600 dark:text-slate-300">Año</span>
          <select className="input" value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}>
            {yearOptions.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-end">
          <button
            type="button"
            className="btn-secondary w-full md:w-auto"
            onClick={() => {
              setSelectedMonth(currentMonth);
              setSelectedYear(currentYear);
            }}
          >
            Mes actual
          </button>
        </div>

        <div className="rounded-lg border border-line px-3 py-2 text-sm text-slate-600 dark:text-slate-300 md:col-span-3">
          Período seleccionado: <strong>{periodLabel}</strong>
        </div>
      </div>

      {loadError ? <ErrorState title="No se pudieron cargar los datos." description={loadError} onRetry={() => setRetryNonce((value) => value + 1)} /> : null}
      {!loading && !loadError && shouldShowEmptyStatsState(stats, rows) ? (
        <ErrorState title="No hay movimientos suficientes para generar estadísticas de este período." description="Probá con otro mes o cargá nuevos movimientos." />
      ) : null}
      {!loadError ? (
        <EstadisticasView stats={stats} monthRows={rows} loading={loading} />
      ) : null}
    </div>
  );
}

async function retryAsync<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await delay(350 * (attempt + 1));
    }
  }
  throw lastError;
}

async function loadStatsForPeriod(month: number, year: number): Promise<{
  stats: StatsResponse | null;
  movimientos: MovimientosResponse;
  statsFallbackUsed: boolean;
}> {
  const movimientos = await retryAsync(
    () => api.movimientos(month, year, "todos", ""),
    2,
  ).catch((error) => {
    throw createStatsLoadError("movimientos", { month, year }, error);
  });

  const stats = await retryAsync(
    () => api.stats(month, year),
    2,
  ).catch((error) => {
    console.error("Error cargando resumen de estadísticas local", {
      endpoint: "/estadisticas",
      month,
      year,
      error,
    });
    return null;
  });

  return {
    stats,
    movimientos,
    statsFallbackUsed: stats === null,
  };
}

function createStatsLoadError(request: "movimientos" | "estadisticas", target: { month: number; year: number }, error: unknown) {
  const message = error instanceof Error ? error.message : "No se pudieron cargar los datos del período.";
  return new Error(`[${request}] ${target.month}/${target.year}: ${message}`);
}

function getSelectableYears(currentYear: number) {
  return Array.from({ length: 7 }, (_, index) => currentYear - 3 + index).sort((a, b) => b - a);
}

function normalizeStatsResponse(rawStats: StatsResponse | null, rows: Movimiento[]): StatsResponse | null {
  if (!rawStats) return null;

  const summary = rawStats.summary && typeof rawStats.summary === "object"
    ? {
        saldo_inicial: Number(rawStats.summary.saldo_inicial || 0),
        ingreso: Number(rawStats.summary.ingreso || rawStats.month_totals?.ingreso || 0),
        gasto: Number(rawStats.summary.gasto || rawStats.month_totals?.gasto || 0),
        ahorro: Number(rawStats.summary.ahorro || rawStats.month_totals?.ahorro || 0),
        balance_final: Number(rawStats.summary.balance_final || (rawStats.summary as StatsResponse["summary"] & { balance?: number }).balance || rawStats.month_totals?.balance || 0),
        balance: Number((rawStats.summary as StatsResponse["summary"] & { balance?: number }).balance || rawStats.month_totals?.balance || rawStats.summary.balance_final || 0),
        disponible_luego_ahorro: Number(rawStats.summary.disponible_luego_ahorro || rawStats.month_totals?.disponible_luego_ahorro || 0),
      }
    : null;

  const monthTotals = rawStats.month_totals && typeof rawStats.month_totals === "object"
    ? {
        ingreso: Number(rawStats.month_totals.ingreso || rawStats.summary?.ingreso || 0),
        gasto: Number(rawStats.month_totals.gasto || rawStats.summary?.gasto || 0),
        ahorro: Number(rawStats.month_totals.ahorro || rawStats.summary?.ahorro || 0),
        inversion: Number(rawStats.month_totals.inversion || 0),
        balance: Number(rawStats.month_totals.balance || (rawStats.summary as StatsResponse["summary"] & { balance?: number }).balance || rawStats.summary?.balance_final || 0),
        disponible_luego_ahorro: Number(rawStats.month_totals.disponible_luego_ahorro || rawStats.summary?.disponible_luego_ahorro || 0),
      }
    : null;

  const expensesByCategory = Array.isArray(rawStats.expenses_by_category)
    ? rawStats.expenses_by_category.map((item) => ({
        categoria_id: item.categoria_id,
        categoria: item.categoria || "Sin categoría",
        total: Number(item.total || 0),
        movimientos: Number(item.movimientos || 0),
      }))
    : null;

  const trend = Array.isArray(rawStats.trend)
    ? rawStats.trend.map((item) => ({
        mes: Number(item.mes || 0),
        ingresos: Number(item.ingresos || 0),
        gastos: Number(item.gastos || 0),
      }))
    : null;

  const planificacion = rawStats.planificacion && typeof rawStats.planificacion === "object"
    ? {
        total_pendiente_30_dias: Number(rawStats.planificacion.total_pendiente_30_dias || 0),
        total_vencido: Number(rawStats.planificacion.total_vencido || 0),
        total_pagado_mes: Number(rawStats.planificacion.total_pagado_mes || 0),
        balance_proyectado_mes: Number(rawStats.planificacion.balance_proyectado_mes || monthTotals?.balance || summary?.balance_final || 0),
      }
    : null;

  if (!summary || !monthTotals || !expensesByCategory || !trend || !planificacion) {
    console.error("Respuesta inválida en /estadisticas", { endpoint: "/estadisticas", rawStats });
    return buildStatsFallbackFromRows(rows);
  }

  return {
    summary,
    month_totals: monthTotals,
    expenses_by_category: expensesByCategory,
    trend,
    planificacion,
  };
}

function shouldShowEmptyStatsState(stats: StatsResponse | null, rows: Movimiento[]) {
  if (rows.length > 0) return false;
  if (!stats) return true;
  return stats.month_totals.ingreso <= 0
    && stats.month_totals.gasto <= 0
    && stats.expenses_by_category.length === 0
    && stats.trend.length === 0;
}

function buildStatsFallbackFromRows(rows: Movimiento[]): StatsResponse {
  const ingreso = rows
    .filter((row) => row.tipo === "ingreso")
    .reduce((sum, row) => sum + Number(row.monto || 0), 0);
  const gasto = rows
    .filter((row) => row.tipo === "gasto")
    .reduce((sum, row) => sum + Number(row.monto || 0), 0);

  const expensesByCategoryMap = new Map<string, { categoria: string; total: number; movimientos: number }>();
  const trendMap = new Map<number, { mes: number; ingresos: number; gastos: number }>();

  for (const row of rows) {
    const rowMonth = Number(String(row.fecha || "").slice(5, 7));
    if (rowMonth >= 1 && rowMonth <= 12) {
      const trend = trendMap.get(rowMonth) || { mes: rowMonth, ingresos: 0, gastos: 0 };
      if (row.tipo === "ingreso") trend.ingresos += Number(row.monto || 0);
      if (row.tipo === "gasto") trend.gastos += Number(row.monto || 0);
      trendMap.set(rowMonth, trend);
    }

    if (row.tipo === "gasto") {
      const categoria = row.categoria || "Sin categoría";
      const current = expensesByCategoryMap.get(categoria) || { categoria, total: 0, movimientos: 0 };
      current.total += Number(row.monto || 0);
      current.movimientos += 1;
      expensesByCategoryMap.set(categoria, current);
    }
  }

  return {
    summary: {
      saldo_inicial: 0,
      ingreso,
      gasto,
      ahorro: 0,
      balance_final: ingreso - gasto,
      balance: ingreso - gasto,
      disponible_luego_ahorro: ingreso - gasto,
    },
    month_totals: {
      ingreso,
      gasto,
      ahorro: 0,
      inversion: 0,
      balance: ingreso - gasto,
      disponible_luego_ahorro: ingreso - gasto,
    },
    expenses_by_category: Array.from(expensesByCategoryMap.values()).sort((a, b) => b.total - a.total),
    trend: Array.from(trendMap.values()).sort((a, b) => a.mes - b.mes),
    planificacion: {
      total_pendiente_30_dias: 0,
      total_vencido: 0,
      total_pagado_mes: 0,
      balance_proyectado_mes: ingreso - gasto,
    },
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
