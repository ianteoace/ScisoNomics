"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorState } from "../../../components/ui/ErrorState";
import { LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { Modal } from "../../../components/ui/Modal";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { money, monthName, yearOptions } from "../../../lib/format";
import { api } from "../../../services/api";
import type { Categoria, Presupuesto } from "../../../types/domain";

export default function PresupuestosPage() {
  const router = useRouter();
  const { month, year } = useDashboardUi();
  const { showError, showSuccess } = useToast();
  const [rows, setRows] = useState<Presupuesto[]>([]);
  const [cats, setCats] = useState<Categoria[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Presupuesto | null>(null);
  const [categoriaId, setCategoriaId] = useState(0);
  const [mes, setMes] = useState(month);
  const [anio, setAnio] = useState(year);
  const [monto, setMonto] = useState("");
  const [confirmId, setConfirmId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    const [p, c] = await Promise.all([api.presupuestos(month, year), api.categorias("gasto")]);
    setRows(Array.isArray(p) ? p : []);
    setCats(Array.isArray(c) ? c : []);
    setLoadError("");
    setLoading(false);
  }

  useEffect(() => {
    load().catch((e: any) => {
      setLoadError(e.message || "No se pudieron cargar los datos.");
      setLoading(false);
      showError(e.message || "No se pudieron cargar presupuestos");
    });
  }, [month, year, showError]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") !== "1") return;
    openCreate();
    router.replace("/presupuestos");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const usedPairs = useMemo(() => new Set(rows.map((r) => `${r.categoria_id}-${r.mes}-${r.anio}`)), [rows]);

  function openCreate() {
    setEditing(null);
    setCategoriaId(0);
    setMes(month);
    setAnio(year);
    setMonto("");
    setOpen(true);
  }

  function openEdit(row: Presupuesto) {
    setEditing(row);
    setCategoriaId(row.categoria_id);
    setMes(row.mes);
    setAnio(row.anio);
    setMonto(String(row.monto_presupuestado));
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!categoriaId) return showError("Selecciona una categoria.");
    if (!mes || !anio) return showError("Selecciona mes y ano.");
    const trimmed = monto.trim();
    if (!trimmed) return showError("Ingresa un monto mayor a 0.");

    const montoNumber = Number(trimmed);
    if (!Number.isFinite(montoNumber) || montoNumber <= 0) return showError("Ingresa un monto mayor a 0.");

    try {
      await api.upsertPresupuesto({ categoria_id: categoriaId, mes, anio, monto: montoNumber });
      showSuccess(editing ? "Presupuesto actualizado" : "Presupuesto creado");
      setOpen(false);
      await load();
    } catch (e: any) {
      showError(e.message || "No se pudo guardar");
    }
  }

  async function remove(id: number) {
    try {
      await api.deletePresupuesto(id);
      showSuccess("Presupuesto eliminado");
      await load();
    } catch (e: any) {
      showError(e.message || "No se pudo eliminar");
    }
  }

  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xl font-bold">Presupuestos por categoria</h2>
        <button className="btn" onClick={openCreate}>Crear presupuesto</button>
      </div>

      {loadError ? <ErrorState title="No se pudieron cargar los datos." description={loadError} onRetry={load} /> : null}
      {loading ? <LoadingSkeleton rows={6} /> : null}
      {rows.length === 0 && !loading ? <EmptyState title="Sin presupuestos" hint="Crea tu primer presupuesto mensual por categoria." ctaLabel="Crear presupuesto" onAction={openCreate} /> : null}

      <div className={`mt-4 space-y-2 ${loading ? "hidden" : ""}`}>
        {rows.map((r) => (
          <div key={r.id} className="rounded-xl border border-line p-3">
            <div className="flex items-center justify-between">
              <strong>{r.categoria}</strong>
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={() => openEdit(r)}>Editar</button>
                <button className="btn-secondary" onClick={() => setConfirmId(r.id)}>Eliminar</button>
              </div>
            </div>
            <p className="text-sm">Periodo: {monthName(r.mes)} {r.anio}</p>
            <p className="text-sm">Presupuestado: {money(r.monto_presupuestado)} · Gastado: {money(r.monto_gastado)} · Disponible: {money(r.monto_disponible)}</p>
            <p className={`text-sm font-semibold ${r.excedido ? "text-rose-300" : "text-emerald-300"}`}>
              {r.porcentaje_usado.toFixed(1)}% usado {r.excedido ? "(excedido)" : ""}
            </p>
          </div>
        ))}
      </div>

      <Modal open={open} title={editing ? "Editar presupuesto" : "Crear presupuesto"} onClose={() => setOpen(false)}>
        <form className="grid gap-2" onSubmit={save}>
          <label className="text-xs text-slate-400">Categoria</label>
          <select className="input" value={categoriaId} onChange={(e) => setCategoriaId(Number(e.target.value))} required>
            <option value={0}>Seleccionar categoria</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
          <label className="text-xs text-slate-400">Mes</label>
          <select className="input" value={mes} onChange={(e) => setMes(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
          <label className="text-xs text-slate-400">Ano</label>
          <select className="input" value={anio} onChange={(e) => setAnio(Number(e.target.value))}>
            {yearOptions(new Date().getFullYear(), [anio, ...rows.map((r) => r.anio)]).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <label className="text-xs text-slate-400">Monto</label>
          <input className="input" type="number" min="0.01" step="0.01" placeholder="Monto mensual" value={monto} onChange={(e) => setMonto(e.target.value)} required />
          {!editing && usedPairs.has(`${categoriaId}-${mes}-${anio}`) ? <p className="text-xs text-amber-300">Ya existe para este periodo. Se actualizara al guardar.</p> : null}
          <div className="mt-2 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancelar</button><button className="btn" type="submit">{editing ? "Guardar cambios" : "Crear presupuesto"}</button></div>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmId !== null}
        title="Eliminar presupuesto"
        message="Esta acción no se puede deshacer."
        onCancel={() => setConfirmId(null)}
        onConfirm={async () => {
          if (confirmId) await remove(confirmId);
          setConfirmId(null);
        }}
      />
    </section>
  );
}
