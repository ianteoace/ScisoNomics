"use client";

import { useEffect, useState } from "react";

import { ErrorState } from "../../../components/ui/ErrorState";
import { EstadisticasView } from "../../../components/views/EstadisticasView";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import type { Movimiento, MovimientosResponse, StatsResponse } from "../../../types/domain";

export default function EstadisticasPage() {
  const { setSaldoActual, setTopbarPeriodLabelOverride } = useDashboardUi();
  const { showError } = useToast();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [rows, setRows] = useState<Movimiento[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [periodo, setPeriodo] = useState("mes_actual");
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const now = new Date();
        const { targets, currentMonth, currentYear } = buildTargetsByPeriod(periodo, now);
        let allRows: Movimiento[] = [];
        let statsData: StatsResponse | null = null;
        let usedStatsFallback = false;
        if (periodo === "mes_actual") {
          const { stats, movimientos, statsFallbackUsed } = await loadTargetData({ month: currentMonth, year: currentYear });
          allRows = movimientos.rows;
          statsData = normalizeStatsResponse(stats, movimientos.rows);
          usedStatsFallback = statsFallbackUsed || statsData === null;
        } else {
          const results: Array<{ stats: StatsResponse | null; movimientos: MovimientosResponse; statsFallbackUsed: boolean }> = [];
          for (const target of targets) {
            if (cancelled) return;
            results.push(await loadTargetData(target));
          }
          allRows = results.flatMap((r) => r.movimientos.rows);
          const validStats = results
            .map((r) => normalizeStatsResponse(r.stats, r.movimientos.rows))
            .filter((value): value is StatsResponse => Boolean(value));
          usedStatsFallback = results.some((r) => r.statsFallbackUsed) || validStats.length !== results.length;
          statsData = validStats.length === results.length
            ? mergeStats(validStats)
            : buildStatsFallbackFromRows(allRows);
        }
        if (cancelled) return;
        if (!statsData) {
          statsData = buildStatsFallbackFromRows(allRows);
          usedStatsFallback = true;
        }
        setStats(statsData);
        setRows(allRows);
        setSaldoActual(0);
        setLoadError("");
        if (usedStatsFallback) {
          console.warn("Estadísticas cargadas con fallback local.", {
            periodo,
            rows: allRows.length,
            targets: targets.length,
          });
        }
      } catch (e: any) {
        if (!cancelled) {
          console.error("Error cargando estadísticas", { periodo, error: e });
          setLoadError(e.message || "No se pudieron cargar los datos.");
          showError("No se pudieron cargar las estadísticas. Intentá nuevamente.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [setSaldoActual, showError, periodo, retryNonce]);

  const periodLabel = getPeriodLabel(periodo);

  useEffect(() => {
    setTopbarPeriodLabelOverride(periodLabel);
    return () => setTopbarPeriodLabelOverride(null);
  }, [periodLabel, setTopbarPeriodLabelOverride]);

  return (
    <div className="space-y-4">
      <div className="panel grid gap-2 p-3 md:grid-cols-2">
        <select className="input" value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
          <option value="mes_actual">Mes actual</option>
          <option value="ultimos_3_meses">Últimos 3 meses</option>
          <option value="ultimos_6_meses">Últimos 6 meses</option>
          <option value="anio_actual">Año actual</option>
        </select>
        <div className="rounded-lg border border-line px-3 py-2 text-sm text-slate-600 dark:text-slate-300">
          Período seleccionado: <strong>{periodLabel}</strong>
        </div>
      </div>
      {loadError ? <ErrorState title="No se pudieron cargar los datos." description={loadError} onRetry={() => setRetryNonce((value) => value + 1)} /> : null}
      {!loading && !loadError && shouldShowEmptyStatsState(stats, rows) ? (
        <ErrorState title="No hay movimientos suficientes para generar estadísticas de este período." description="Probá con otro período o cargá nuevos movimientos." />
      ) : null}
      {!loadError ? (
        <EstadisticasView stats={stats} monthRows={rows} loading={loading} />
      ) : null}
    </div>
  );
}

function buildPeriods(month: number, year: number, count: number) {
  const out: Array<{ month: number; year: number }> = [];
  let m = month;
  let y = year;
  for (let i = 0; i < count; i += 1) {
    out.push({ month: m, year: y });
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

function buildYearToDatePeriods(currentMonth: number, currentYear: number) {
  return Array.from({ length: currentMonth }, (_, index) => ({
    month: currentMonth - index,
    year: currentYear,
  }));
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

async function loadTargetData(target: { month: number; year: number }): Promise<{
  stats: StatsResponse | null;
  movimientos: MovimientosResponse;
  statsFallbackUsed: boolean;
}> {
  const movimientos = await retryAsync(
    () => api.movimientos(target.month, target.year, "todos", ""),
    2,
  ).catch((error) => {
    throw createStatsLoadError("movimientos", target, error);
  });

  const stats = await retryAsync(
    () => api.stats(target.month, target.year),
    2,
  ).catch((error) => {
    console.error("Error cargando resumen de estadísticas local", {
      endpoint: "/estadisticas",
      month: target.month,
      year: target.year,
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

  const normalizedStats: StatsResponse = {
    summary,
    month_totals: monthTotals,
    expenses_by_category: expensesByCategory,
    trend,
    planificacion,
  };

  return normalizedStats;
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

function mergeStats(items: StatsResponse[]): StatsResponse {
  const monthTotals = items.reduce(
    (acc, s) => {
      acc.ingreso += s.month_totals.ingreso;
      acc.gasto += s.month_totals.gasto;
      acc.ahorro += Number(s.month_totals.ahorro || 0);
      acc.inversion += Number(s.month_totals.inversion || 0);
      acc.balance += s.month_totals.balance;
      acc.disponible_luego_ahorro += Number(s.month_totals.disponible_luego_ahorro || 0);
      return acc;
    },
    { ingreso: 0, gasto: 0, ahorro: 0, inversion: 0, balance: 0, disponible_luego_ahorro: 0 },
  );

  const byCategory = new Map<string, { categoria: string; total: number; movimientos: number }>();
  for (const s of items) {
    for (const c of s.expenses_by_category) {
      const current = byCategory.get(c.categoria) || { categoria: c.categoria, total: 0, movimientos: 0 };
      current.total += c.total;
      current.movimientos += c.movimientos || 0;
      byCategory.set(c.categoria, current);
    }
  }

  const trend = items.flatMap((s) => s.trend);
  return {
    summary: items[0]?.summary || { saldo_inicial: 0, ingreso: 0, gasto: 0, ahorro: 0, balance_final: 0, balance: 0, disponible_luego_ahorro: 0 },
    month_totals: monthTotals,
    expenses_by_category: Array.from(byCategory.values()).sort((a, b) => b.total - a.total),
    trend,
    planificacion: items[0]?.planificacion || {
      total_pendiente_30_dias: 0,
      total_vencido: 0,
      total_pagado_mes: 0,
      balance_proyectado_mes: 0,
    },
  };
}

function buildTargetsByPeriod(periodo: string, now: Date) {
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  if (periodo === "mes_actual") {
    return { targets: [{ month: currentMonth, year: currentYear }], currentMonth, currentYear };
  }
  if (periodo === "ultimos_3_meses") {
    return { targets: buildPeriods(currentMonth, currentYear, 3), currentMonth, currentYear };
  }
  if (periodo === "ultimos_6_meses") {
    return { targets: buildPeriods(currentMonth, currentYear, 6), currentMonth, currentYear };
  }
  return { targets: buildYearToDatePeriods(currentMonth, currentYear), currentMonth, currentYear };
}

function getPeriodLabel(periodo: string) {
  if (periodo === "mes_actual") return "Mes actual";
  if (periodo === "ultimos_3_meses") return "Últimos 3 meses";
  if (periodo === "ultimos_6_meses") return "Últimos 6 meses";
  if (periodo === "anio_actual") return "Año actual";
  return "Período";
}
