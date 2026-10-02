"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";

import { ErrorState } from "../../../components/ui/ErrorState";
import { DashboardView } from "../../../components/views/DashboardView";
import { useDebounce } from "../../../hooks/useDebounce";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import { createSecurityCopyWithSaveDialog } from "../../../services/backupDownload";
import { getActiveOwnerId } from "../../../services/cloudAuth";
import { subscribeDashboardRefresh } from "../../../services/dashboardRefresh";
import type { GastoFijo, GastoProgramado, MetaAhorro, Movimiento, MovimientosResponse, Presupuesto, StatsResponse } from "../../../types/domain";

export default function DashboardPage() {
  const router = useRouter();
  const { month, setMonth, year, setYear, search, saldoActual, setSaldoActual } = useDashboardUi();
  const debounced = useDebounce(search, 280);
  const { showError, showSuccess } = useToast();

  const [movimientos, setMovimientos] = useState<MovimientosResponse | null>(null);
  const [previous, setPrevious] = useState<{ ingreso: number; gasto: number } | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [planificacion, setPlanificacion] = useState<GastoProgramado[]>([]);
  const [presupuestos, setPresupuestos] = useState<Presupuesto[]>([]);
  const [gastosFijos, setGastosFijos] = useState<GastoFijo[]>([]);
  const [metas, setMetas] = useState<MetaAhorro[]>([]);
  const [resumenPotente, setResumenPotente] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const requestEpochRef = useRef(0);

  useEffect(() => subscribeDashboardRefresh({
    target: window,
    getOwnerId: getActiveOwnerId,
    onReload: () => setReloadNonce((value) => value + 1),
    onInvalidate: (ownerChanged) => {
      requestEpochRef.current += 1;
      setLoading(true);
      setError("");
      if (!ownerChanged) return;
      setMovimientos(null);
      setPrevious(null);
      setStats(null);
      setPlanificacion([]);
      setPresupuestos([]);
      setGastosFijos([]);
      setMetas([]);
      setResumenPotente(null);
      setSaldoActual(0);
    },
  }), [setSaldoActual]);

  useEffect(() => {
    if (!reloadNonce) return;
    let cancelled = false;
    const requestEpoch = ++requestEpochRef.current;
    const ownerId = getActiveOwnerId();
    const isCurrent = () => !cancelled && requestEpochRef.current === requestEpoch && getActiveOwnerId() === ownerId;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const prevMonth = month === 1 ? 12 : month - 1;
        const prevYear = month === 1 ? year - 1 : year;
        const [m, s, gp, rp, p, gf, metasRows, prev] = await Promise.all([
          api.movimientos(month, year, "todos", debounced, ""),
          api.stats(month, year),
          api.gastosProgramados("todos"),
          api.resumenMensual(month, year),
          api.presupuestos(month, year),
          api.gastosFijos(),
          api.metas(),
          api.movimientos(prevMonth, prevYear, "todos", "", ""),
        ]);
        if (!isCurrent()) return;
        setMovimientos(m);
        setStats(s);
        setPlanificacion(gp);
        setResumenPotente(rp);
        setPresupuestos(p);
        setGastosFijos(gf);
        setMetas(metasRows);
        setPrevious({ ingreso: prev.summary.ingreso, gasto: prev.summary.gasto });
        setSaldoActual(m.rows.length ? m.rows[0].saldo_acumulado : 0);
        setError("");
      } catch (err: any) {
        if (isCurrent()) {
          setError(err.message || "No se pudo cargar el resumen.");
          showError(err.message || "No se pudo cargar el resumen.");
        }
      } finally {
        if (isCurrent()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, year, debounced, setSaldoActual, showError, reloadNonce]);

  async function handleExport() {
    try {
      const { blob } = await api.exportExcel(month, year);
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      const suggestedName = `ScisoNomics_reporte_${year}-${String(month).padStart(2, "0")}.xlsx`;

      if (isTauri) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const saved = await invoke<boolean>("save_binary_file", { fileName: suggestedName, extension: "xlsx", bytes: Array.from(bytes) });
        if (!saved) return;
      } else {
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = suggestedName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectUrl);
      }
      showSuccess("Reporte exportado correctamente.");
    } catch (e: any) {
      showError(e.message || "No se pudo exportar el reporte.");
    }
  }

  async function handleBackup() {
    try {
      await createSecurityCopyWithSaveDialog();
      showSuccess("Copia de seguridad creada correctamente.");
    } catch (e: any) {
      showError(e.message || "No se pudo crear la copia de seguridad.");
    }
  }

  if (error) return <ErrorState title="No se pudo cargar el resumen." description={error} onRetry={() => setReloadNonce((value) => value + 1)} />;

  return (
    <DashboardView
      loading={loading}
      summary={movimientos?.summary || { saldo_inicial: 0, ingreso: 0, gasto: 0, balance_final: 0 }}
      previous={previous}
      stats={stats}
      upcoming={planificacion.filter((r) => r.estado === "pendiente")}
      resumenPotente={resumenPotente}
      presupuestos={presupuestos}
      gastosFijos={gastosFijos}
      metas={metas}
      recentMovements={(movimientos?.rows || []).slice(0, 5) as Movimiento[]}
      month={month}
      year={year}
      saldoActual={saldoActual}
      onMonthChange={setMonth}
      onYearChange={setYear}
      onQuickNewMovement={() => router.push("/movimientos?nuevo=1")}
      onQuickMovements={() => router.push("/movimientos")}
      onQuickStats={() => router.push("/estadisticas")}
      onQuickExport={handleExport}
      onQuickBackup={handleBackup}
    />
  );
}
