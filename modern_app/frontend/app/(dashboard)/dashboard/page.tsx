"use client";

import { useEffect, useState } from "react";

import { ErrorState } from "../../../components/ui/ErrorState";
import { DashboardView } from "../../../components/views/DashboardView";
import { useDebounce } from "../../../hooks/useDebounce";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import type { GastoProgramado, MovimientosResponse, Presupuesto, StatsResponse } from "../../../types/domain";

export default function DashboardPage() {
  const { month, setMonth, year, setYear, search, saldoActual, setSaldoActual } = useDashboardUi();
  const debounced = useDebounce(search, 280);
  const { showError } = useToast();

  const [movimientos, setMovimientos] = useState<MovimientosResponse | null>(null);
  const [previous, setPrevious] = useState<{ ingreso: number; gasto: number } | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [planificacion, setPlanificacion] = useState<GastoProgramado[]>([]);
  const [presupuestos, setPresupuestos] = useState<Presupuesto[]>([]);
  const [resumenPotente, setResumenPotente] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [m, s, gp, rp, p] = await Promise.all([
          api.movimientos(month, year, "todos", debounced, ""),
          api.stats(month, year),
          api.gastosProgramados("todos"),
          api.resumenMensual(month, year),
          api.presupuestos(month, year),
        ]);
        if (cancelled) return;
        setMovimientos(m);
        setStats(s);
        setPlanificacion(gp);
        setResumenPotente(rp);
        setPresupuestos(p);
        setSaldoActual(m.rows.length ? m.rows[0].saldo_acumulado : 0);
        setError("");

        const prevMonth = month === 1 ? 12 : month - 1;
        const prevYear = month === 1 ? year - 1 : year;
        const prev = await api.movimientos(prevMonth, prevYear, "todos", "", "");
        if (!cancelled) setPrevious({ ingreso: prev.summary.ingreso, gasto: prev.summary.gasto });
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || "No se pudieron cargar datos");
          showError(err.message || "No se pudieron cargar datos");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [month, year, debounced, setSaldoActual, showError]);

  if (error) return <ErrorState title="Error al cargar inicio" description={error} onRetry={() => window.location.reload()} />;

  return (
    <DashboardView
      loading={loading}
      summary={movimientos?.summary || { saldo_inicial: 0, ingreso: 0, gasto: 0, balance_final: 0 }}
      previous={previous}
      stats={stats}
      upcoming={planificacion.filter((r) => r.estado === "pendiente")}
      resumenPotente={resumenPotente}
      presupuestos={presupuestos}
      month={month}
      year={year}
      saldoActual={saldoActual}
      onMonthChange={setMonth}
      onYearChange={setYear}
    />
  );
}
