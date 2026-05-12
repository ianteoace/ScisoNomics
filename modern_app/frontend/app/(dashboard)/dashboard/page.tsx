"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";

import { ErrorState } from "../../../components/ui/ErrorState";
import { DashboardView } from "../../../components/views/DashboardView";
import { useDebounce } from "../../../hooks/useDebounce";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import { createSecurityCopyWithSaveDialog } from "../../../services/backupDownload";
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [m, s, gp, rp, p, gf, metasRows] = await Promise.all([
          api.movimientos(month, year, "todos", debounced, ""),
          api.stats(month, year),
          api.gastosProgramados("todos"),
          api.resumenMensual(month, year),
          api.presupuestos(month, year),
          api.gastosFijos(),
          api.metas(),
        ]);
        if (cancelled) return;
        setMovimientos(m);
        setStats(s);
        setPlanificacion(gp);
        setResumenPotente(rp);
        setPresupuestos(p);
        setGastosFijos(gf);
        setMetas(metasRows);
        setSaldoActual(m.rows.length ? m.rows[0].saldo_acumulado : 0);
        setError("");

        const prevMonth = month === 1 ? 12 : month - 1;
        const prevYear = month === 1 ? year - 1 : year;
        const prev = await api.movimientos(prevMonth, prevYear, "todos", "", "");
        if (!cancelled) setPrevious({ ingreso: prev.summary.ingreso, gasto: prev.summary.gasto });
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || "No se pudo cargar el resumen.");
          showError(err.message || "No se pudo cargar el resumen.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, year, debounced, setSaldoActual, showError]);

  async function handleExport() {
    try {
      const { blob } = await api.exportExcel(month, year);
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      const suggestedName = `ScisoNomics_reporte_${year}-${String(month).padStart(2, "0")}.xlsx`;

      if (isTauri) {
        const [{ save }] = await Promise.all([import("@tauri-apps/plugin-dialog")]);
        const selectedPath = await save({
          defaultPath: suggestedName,
          filters: [{ name: "Excel", extensions: ["xlsx"] }],
        });
        if (!selectedPath) return;
        const targetPath = Array.isArray(selectedPath) ? selectedPath[0] : selectedPath;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await invoke("save_binary_file", { path: targetPath, bytes: Array.from(bytes) });
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

  if (error) return <ErrorState title="No se pudo cargar el resumen." description={error} onRetry={() => window.location.reload()} />;

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
