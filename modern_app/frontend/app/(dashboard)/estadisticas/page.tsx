"use client";

import { useEffect, useState } from "react";

import { ErrorState } from "../../../components/ui/ErrorState";
import { EstadisticasView } from "../../../components/views/EstadisticasView";
import { useDebounce } from "../../../hooks/useDebounce";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { monthName, yearOptions } from "../../../lib/format";
import { api } from "../../../services/api";
import type { Movimiento, StatsResponse } from "../../../types/domain";

export default function EstadisticasPage() {
  const { month, setMonth, year, setYear, search, setSaldoActual } = useDashboardUi();
  const debounced = useDebounce(search, 280);
  const { showError } = useToast();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [rows, setRows] = useState<Movimiento[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [periodo, setPeriodo] = useState("mes_actual");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        let statsData: StatsResponse;
        let allRows: Movimiento[] = [];
        if (periodo === "mes_actual") {
          const [s, m] = await Promise.all([api.stats(month, year), api.movimientos(month, year, "todos", debounced)]);
          statsData = s;
          allRows = m.rows;
        } else {
          const range = periodo === "ultimos_3_meses" ? 3 : periodo === "ultimos_6_meses" ? 6 : 12;
          const targets = buildPeriods(month, year, range);
          const results = await Promise.all(targets.map((p) => Promise.all([api.stats(p.month, p.year), api.movimientos(p.month, p.year, "todos", "")])));
          allRows = results.flatMap((r) => r[1].rows);
          statsData = mergeStats(results.map((r) => r[0]));
        }
        if (cancelled) return;
        setStats(statsData);
        setRows(allRows);
        setSaldoActual(allRows.length ? allRows[0].saldo_acumulado : 0);
        setLoadError("");
      } catch (e: any) {
        if (!cancelled) {
          setLoadError(e.message || "No se pudieron cargar los datos.");
          showError(e.message || "No se pudieron cargar estadisticas");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [month, year, debounced, setSaldoActual, showError, periodo]);

  return (
    <div className="space-y-4">
      <div className="panel grid gap-2 p-3 md:grid-cols-4">
        <select className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </select>
        <select className="input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {yearOptions(new Date().getFullYear(), [year, ...rows.map((r) => Number(r.fecha.slice(0, 4)))]).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select className="input" value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
          <option value="mes_actual">Mes actual</option>
          <option value="ultimos_3_meses">Últimos 3 meses</option>
          <option value="ultimos_6_meses">Últimos 6 meses</option>
          <option value="anio_actual">Año actual</option>
        </select>
      </div>
      {loadError ? <ErrorState title="No se pudieron cargar los datos." description={loadError} onRetry={() => window.location.reload()} /> : null}
      <EstadisticasView stats={stats} monthRows={rows} loading={loading} />
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
