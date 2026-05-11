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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [s, m] = await Promise.all([api.stats(month, year), api.movimientos(month, year, "todos", debounced)]);
        if (cancelled) return;
        setStats(s);
        setRows(m.rows);
        setSaldoActual(m.rows.length ? m.rows[0].saldo_acumulado : 0);
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
  }, [month, year, debounced, setSaldoActual, showError]);

  return (
    <div className="space-y-4">
      <div className="panel grid gap-2 p-3 md:grid-cols-3">
        <select className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </select>
        <select className="input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {yearOptions(new Date().getFullYear(), [year, ...rows.map((r) => Number(r.fecha.slice(0, 4)))]).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      {loadError ? <ErrorState title="No se pudieron cargar los datos." description={loadError} onRetry={() => window.location.reload()} /> : null}
      <EstadisticasView stats={stats} monthRows={rows} loading={loading} />
    </div>
  );
}
