"use client";

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { ErrorState } from "../../../components/ui/ErrorState";
import { MovimientosView } from "../../../components/views/MovimientosView";
import { useDebounce } from "../../../hooks/useDebounce";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { monthName, yearOptions } from "../../../lib/format";
import { api } from "../../../services/api";
import type { Categoria, MetaAhorro, Movimiento, MovimientosResponse } from "../../../types/domain";

export default function MovimientosPage() {
  const { month, setMonth, year, setYear, search, setSaldoActual } = useDashboardUi();
  const debounced = useDebounce(search, 280);
  const { showError, showSuccess } = useToast();

  const [tipo, setTipo] = useState("todos");
  const [categoria, setCategoria] = useState("");
  const [minMonto, setMinMonto] = useState("");
  const [maxMonto, setMaxMonto] = useState("");
  const [movimientos, setMovimientos] = useState<MovimientosResponse | null>(null);
  const [categories, setCategories] = useState<Categoria[]>([]);
  const [metas, setMetas] = useState<MetaAhorro[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; message: string; action: (() => Promise<void>) | null }>({ open: false, title: "", message: "", action: null });
  const currentYear = new Date().getFullYear();

  const filteredCategories = useMemo(() => {
    if (tipo === "todos") return categories;
    return categories.filter((c) => {
      if (!c.tipo) return true;
      if (tipo === "ahorro") return c.tipo === "ahorro" || c.tipo === "ingreso" || c.nombre.toLowerCase().includes("ahorro");
      if (tipo === "inversion") return c.tipo === "inversion" || c.nombre.toLowerCase().includes("inversion");
      return c.tipo === tipo;
    });
  }, [categories, tipo]);

  async function load() {
    setLoading(true);
    const [m, c, ms] = await Promise.all([
      api.movimientos(month, year, tipo, debounced, categoria, minMonto ? Number(minMonto) : undefined, maxMonto ? Number(maxMonto) : undefined),
      api.categorias("todos"),
      api.metas(),
    ]);
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
  }, [month, year, tipo, debounced, categoria, minMonto, maxMonto]);

  useEffect(() => {
    if (categoria && !filteredCategories.some((c) => c.nombre === categoria)) setCategoria("");
  }, [categoria, filteredCategories]);

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
      const { blob } = await api.exportExcel(month, year);
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      const datePart = getExportDatePart();
      const suggestedName = `ScisoNomics_reporte_${datePart}.xlsx`;

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

  function getExportDatePart() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  const rows: Movimiento[] = movimientos?.rows || [];

  return (
    <div className="space-y-4">
      <div className="panel grid gap-2 p-3 md:grid-cols-4">
        <select className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>{Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}</select>
        <select className="input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {yearOptions(currentYear, [year, ...rows.map((r) => Number(r.fecha.slice(0, 4)))]).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select className="input" value={tipo} onChange={(e) => setTipo(e.target.value)}><option value="todos">Todos</option><option value="ingreso">Ingresos</option><option value="gasto">Gastos</option><option value="ahorro">Ahorro</option><option value="inversion">Inversión</option></select>
        <select className="input" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
          <option value="">Todas las categorias</option>
          {filteredCategories.map((c) => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
        </select>
        <input className="input" placeholder="Monto mínimo" value={minMonto} onChange={(e) => setMinMonto(e.target.value)} />
        <input className="input" placeholder="Monto máximo" value={maxMonto} onChange={(e) => setMaxMonto(e.target.value)} />
        <button className="btn-secondary" onClick={() => { setCategoria(""); setMinMonto(""); setMaxMonto(""); setTipo("todos"); }}>Limpiar filtros</button>
        <button className="btn-secondary text-center" onClick={handleExportExcel}>Exportar reporte a Excel</button>
      </div>
      {loadError ? <ErrorState title="No se pudieron cargar movimientos" description={loadError} onRetry={() => load().catch((e: any) => showError(e.message))} /> : null}

      <MovimientosView
        rows={rows}
        categories={categories}
        loading={loading}
        metas={metas}
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
