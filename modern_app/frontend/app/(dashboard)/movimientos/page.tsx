"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";

import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { ErrorState } from "../../../components/ui/ErrorState";
import { MovimientosView } from "../../../components/views/MovimientosView";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { parseCurrencyInput } from "../../../lib/format";
import { api } from "../../../services/api";
import type { Categoria, MetaAhorro, Movimiento, MovimientosResponse } from "../../../types/domain";

export default function MovimientosPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setSaldoActual } = useDashboardUi();
  const { showError, showSuccess } = useToast();

  function getDefaultDateRange() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return {
      desde: `${y}-${m}-01`,
      hasta: `${y}-${m}-${day}`,
    };
  }

  const [tipo, setTipo] = useState("todos");
  const [categoria, setCategoria] = useState("");
  const [minMonto, setMinMonto] = useState("");
  const [maxMonto, setMaxMonto] = useState("");
  const [desde, setDesde] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  });
  const [hasta, setHasta] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [sortBy, setSortBy] = useState("recientes");
  const [movimientos, setMovimientos] = useState<MovimientosResponse | null>(null);
  const [categories, setCategories] = useState<Categoria[]>([]);
  const [metas, setMetas] = useState<MetaAhorro[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [openCreateSignal, setOpenCreateSignal] = useState(0);
  const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; message: string; action: (() => Promise<void>) | null }>({ open: false, title: "", message: "", action: null });

  const filteredCategories = useMemo(() => {
    if (tipo === "todos") return categories;
    return categories.filter((c) => {
      if (!c.tipo) return true;
      if (tipo === "ahorro") return c.tipo === "ahorro" || c.tipo === "ingreso" || c.nombre.toLowerCase().includes("ahorro");
      if (tipo === "inversion") return c.tipo === "inversion" || c.nombre.toLowerCase().includes("inversion");
      return c.tipo === tipo;
    });
  }, [categories, tipo]);
  const invalidRange = useMemo(() => {
    if (!desde || !hasta) return false;
    return desde > hasta;
  }, [desde, hasta]);

  async function load() {
    if (invalidRange) {
      setLoadError("La fecha 'Desde' no puede ser mayor que 'Hasta'.");
      setLoading(false);
      return;
    }
    setLoading(true);
    const periods = listPeriodsBetween(desde, hasta);
    const minParsed = minMonto ? parseCurrencyInput(minMonto) : undefined;
    const maxParsed = maxMonto ? parseCurrencyInput(maxMonto) : undefined;
    const batches = await Promise.all(
      periods.map(({ month, year }) =>
        api.movimientos(month, year, tipo, "", categoria, Number.isFinite(minParsed) ? minParsed : undefined, Number.isFinite(maxParsed) ? maxParsed : undefined),
      ),
    );
    const mergedRows = batches.flatMap((b) => b.rows);
    mergedRows.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id - a.id);
    const m: MovimientosResponse = {
      rows: mergedRows,
      summary: { saldo_inicial: 0, ingreso: 0, gasto: 0, balance_final: 0 },
      visible_count: mergedRows.length,
      visible_total: 0,
    };
    const [c, ms] = await Promise.all([api.categorias("todos"), api.metas()]);
    setMovimientos(m);
    setCategories(c);
    setMetas(ms);
    setSaldoActual(m.rows.length ? m.rows[0].saldo_acumulado : 0);
    setLoadError("");
    setLoading(false);
  }

  useEffect(() => {
    load().catch((e: any) => {
      setLoadError(e.message || "No se pudieron cargar movimientos");
      showError(e.message || "No se pudieron cargar movimientos");
      setLoading(false);
    });
  }, [tipo, categoria, minMonto, maxMonto, desde, hasta, invalidRange]);

  useEffect(() => {
    if (categoria && !filteredCategories.some((c) => c.nombre === categoria)) setCategoria("");
  }, [categoria, filteredCategories]);

  useEffect(() => {
  if (!searchParams) return;

  if (searchParams.get("nuevo") !== "1") return;

  setOpenCreateSignal((prev) => prev + 1);
  router.replace("/movimientos");
}, [router, searchParams]);

  async function wrap(action: () => Promise<void>, msg: string) {
    try {
      await action();
      showSuccess(msg);
      await load();
    } catch (e: any) {
      showError(e.message || "Operacion fallida");
    }
  }

  async function handleExportExcel() {
    try {
      const { blob } = await api.exportExcel(1, new Date().getFullYear(), desde, hasta);
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      const suggestedName = `ScisoNomics_reporte_${desde}_a_${hasta}.xlsx`;

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
        showSuccess("Reporte exportado correctamente.");
        return;
      }

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = suggestedName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      showSuccess("Reporte exportado correctamente.");
    } catch (e: any) {
      console.error("Error exportando Excel:", e);
      showError("No se pudo exportar el reporte.");
    }
  }

  const rows: Movimiento[] = movimientos?.rows || [];
  const visibleRows = useMemo(() => {
    let next = [...rows];
    if (desde) next = next.filter((r) => r.fecha >= desde);
    if (hasta) next = next.filter((r) => r.fecha <= hasta);
    if (sortBy === "antiguos") next.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id - b.id);
    if (sortBy === "recientes") next.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id - a.id);
    if (sortBy === "monto_mayor") next.sort((a, b) => b.monto - a.monto);
    if (sortBy === "monto_menor") next.sort((a, b) => a.monto - b.monto);
    return next;
  }, [rows, desde, hasta, sortBy]);

  return (
    <div className="space-y-4">
      <div className="panel grid gap-2 p-3 md:grid-cols-12">
        <div className="space-y-1 md:col-span-3">
          <label className="text-xs text-slate-500 dark:text-slate-400">Desde</label>
          <input className="input" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </div>
        <div className="space-y-1 md:col-span-3">
          <label className="text-xs text-slate-500 dark:text-slate-400">Hasta</label>
          <input className="input" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </div>
        <select className="input md:col-span-3 md:self-end" value={tipo} onChange={(e) => setTipo(e.target.value)}><option value="todos">Todos</option><option value="ingreso">Ingresos</option><option value="gasto">Gastos</option><option value="ahorro">Ahorro</option><option value="inversion">Inversión</option></select>
        <select className="input md:col-span-3 md:self-end" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
          <option value="">Todas las categorias</option>
          {filteredCategories.map((c) => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
        </select>
        <input className="input md:col-span-3" placeholder="Monto mínimo" value={minMonto} onChange={(e) => setMinMonto(e.target.value)} />
        <input className="input md:col-span-3" placeholder="Monto máximo" value={maxMonto} onChange={(e) => setMaxMonto(e.target.value)} />
        <select className="input md:col-span-3" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="recientes">Más recientes</option>
          <option value="antiguos">Más antiguos</option>
          <option value="monto_mayor">Mayor monto</option>
          <option value="monto_menor">Menor monto</option>
        </select>
        <button
          className="btn-secondary md:col-span-3"
          onClick={() => {
            const defaults = getDefaultDateRange();
            setDesde(defaults.desde);
            setHasta(defaults.hasta);
            setCategoria("");
            setMinMonto("");
            setMaxMonto("");
            setTipo("todos");
            setSortBy("recientes");
          }}
        >
          Limpiar filtros
        </button>
        <button className="btn-secondary text-center md:col-span-3" onClick={handleExportExcel}>Exportar reporte a Excel</button>
      </div>
      {loadError ? <ErrorState title="No se pudieron cargar movimientos" description={loadError} onRetry={() => load().catch((e: any) => showError(e.message))} /> : null}

      <MovimientosView
        rows={visibleRows}
        categories={categories}
        loading={loading}
        metas={metas}
        openCreateSignal={openCreateSignal}
        onCreate={(payload) => wrap(() => api.createMovimiento(payload).then(() => undefined), "Movimiento creado")}
        onUpdate={(id, payload) => wrap(() => api.updateMovimiento(id, payload).then(() => undefined), "Movimiento actualizado")}
        onDelete={(id) => {
          setConfirmState({
            open: true,
            title: "Eliminar movimiento",
            message: "Esta accion no se puede deshacer.",
            action: () => wrap(() => api.deleteMovimiento(id).then(() => undefined), "Movimiento eliminado"),
          });
          return Promise.resolve();
        }}
      />

      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        onCancel={() => setConfirmState({ open: false, title: "", message: "", action: null })}
        onConfirm={async () => {
          if (confirmState.action) await confirmState.action();
          setConfirmState({ open: false, title: "", message: "", action: null });
        }}
      />
    </div>
  );
}

function listPeriodsBetween(desde: string, hasta: string): Array<{ month: number; year: number }> {
  const from = new Date(`${desde}T00:00:00`);
  const to = new Date(`${hasta}T00:00:00`);
  const out: Array<{ month: number; year: number }> = [];
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return out;
  let y = from.getFullYear();
  let m = from.getMonth() + 1;
  while (y < to.getFullYear() || (y === to.getFullYear() && m <= to.getMonth() + 1)) {
    out.push({ month: m, year: y });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
