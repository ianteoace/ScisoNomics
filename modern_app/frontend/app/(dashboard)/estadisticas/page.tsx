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
        if (periodo === "mes_actual") {
          const [s, m] = await loadTargetWithRetry({ month: currentMonth, year: currentYear });
          statsData = s;
          allRows = m.rows;
        } else {
          const results: Array<[StatsResponse, MovimientosResponse]> = [];
          for (const target of targets) {
            if (cancelled) return;
            results.push(await loadTargetWithRetry(target));
          }
          allRows = results.flatMap((r) => r[1].rows);
          statsData = mergeStats(results.map((r) => r[0]));
        }
        if (cancelled) return;
        setStats(statsData);
        setRows(allRows);
        setSaldoActual(0);
        setLoadError("");
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
      {!loading && !loadError && rows.length === 0 ? (
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

async function loadTargetWithRetry(target: { month: number; year: number }) {
  return retryAsync(
    () => Promise.all([
      api.stats(target.month, target.year),
      api.movimientos(target.month, target.year, "todos", ""),
    ]),
    2,
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeStats(items: StatsResponse[]): StatsResponse {
  const monthTotals = items.reduce(
    (acc, s) => {
      acc.ingreso += s.month_totals.ingreso;
      acc.gasto += s.month_totals.gasto;
      acc.balance += s.month_totals.balance;
      return acc;
    },
    { ingreso: 0, gasto: 0, balance: 0 },
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
    summary: items[0]?.summary || { saldo_inicial: 0, ingreso: 0, gasto: 0, balance_final: 0 },
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
