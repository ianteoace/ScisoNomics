"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorState } from "../../../components/ui/ErrorState";
import { LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { Modal } from "../../../components/ui/Modal";
import { PremiumGate } from "../../../components/ui/PremiumGate";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { money, monthName, parseCurrencyInput, yearOptions } from "../../../lib/format";
import { api } from "../../../services/api";
import { canUseFeature, loadEntitlements, type BillingEntitlements } from "../../../services/entitlements";
import type { Categoria, Presupuesto } from "../../../types/domain";

export default function PresupuestosPage() {
  const router = useRouter();
  const { month, year } = useDashboardUi();
  const { showError, showSuccess } = useToast();
  const [rows, setRows] = useState<Presupuesto[]>([]);
  const [cats, setCats] = useState<Categoria[]>([]);
  const [entitlements, setEntitlements] = useState<BillingEntitlements | null>(null);
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
    const [p, c, e] = await Promise.all([api.presupuestos(month, year), api.categorias("gasto"), loadEntitlements({ force: true })]);
    setRows(Array.isArray(p) ? p : []);
    setCats(Array.isArray(c) ? c : []);
    setEntitlements(e);
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
  const premiumEnabled = canUseFeature("budgets", entitlements);
  const summary = useMemo(() => {
    if (!rows.length) return null;
    const totalPresupuestado = rows.reduce((acc, r) => acc + Number(r.monto_presupuestado || 0), 0);
    const totalGastado = rows.reduce((acc, r) => acc + Number(r.monto_gastado || 0), 0);
    const totalDisponible = rows.reduce((acc, r) => acc + Number(r.monto_disponible || 0), 0);
    const activos = rows.length;
    const comprometido = [...rows].sort((a, b) => Number(b.porcentaje_usado || 0) - Number(a.porcentaje_usado || 0))[0] || null;
    return { totalPresupuestado, totalGastado, totalDisponible, activos, comprometido };
  }, [rows]);

  function openCreate() {
    if (!premiumEnabled) {
      showError("Esta función está disponible en ScisoNomics Premium.");
      return;
    }
    setEditing(null);
    setCategoriaId(0);
    setMes(month);
    setAnio(year);
    setMonto("");
    setOpen(true);
  }

  function openEdit(row: Presupuesto) {
    if (!premiumEnabled) {
      showError("Esta función está disponible en ScisoNomics Premium.");
      return;
    }
    setEditing(row);
    setCategoriaId(row.categoria_id);
    setMes(row.mes);
    setAnio(row.anio);
    setMonto(String(row.monto_presupuestado));
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!premiumEnabled) return showError("Esta función está disponible en ScisoNomics Premium.");
    if (!categoriaId) return showError("Selecciona una categoria.");
    if (!mes || !anio) return showError("Selecciona mes y ano.");
    const trimmed = monto.trim();
    if (!trimmed) return showError("Ingresa un monto mayor a 0.");

    const montoNumber = parseCurrencyInput(trimmed);
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
    if (!premiumEnabled) return showError("Esta función está disponible en ScisoNomics Premium.");
    try {
      await api.deletePresupuesto(id);
      showSuccess("Presupuesto eliminado");
      await load();
    } catch (e: any) {
      showError(e.message || "No se pudo eliminar");
    }
  }

  return (
    <section className="space-y-4">
      <header className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-bold">Presupuestos por categoría</h2>
          {premiumEnabled ? <button className="btn" onClick={openCreate}>Crear presupuesto</button> : null}
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Seguimiento de gasto vs presupuesto mensual con alertas por categoría.
        </p>
      </header>

      {loading ? (
        <div className="card p-5">
          <LoadingSkeleton rows={4} />
        </div>
      ) : null}

      {!loading && summary ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Metric title="Total presupuestado" value={money(summary.totalPresupuestado)} tone="text-cyan-300" />
          <Metric title="Total gastado" value={money(summary.totalGastado)} tone="text-rose-300" />
          <Metric title="Total disponible" value={money(summary.totalDisponible)} tone={summary.totalDisponible >= 0 ? "text-emerald-300" : "text-rose-300"} />
          <Metric
            title="Más comprometido"
            value={summary.comprometido ? `${summary.comprometido.categoria} (${summary.comprometido.porcentaje_usado.toFixed(1)}%)` : "-"}
            tone={summary.comprometido?.excedido ? "text-rose-300" : "text-amber-300"}
          />
        </div>
      ) : null}

      <PremiumGate
        enabled={premiumEnabled}
        onUpgrade={() => showError("ScisoNomics Premium todavía se habilita manualmente en esta versión.")}
      >
      <section className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Detalle por categoría</h3>
        <span className="text-sm text-slate-500 dark:text-slate-400">{rows.length} presupuesto(s)</span>
      </div>

      {loadError ? <ErrorState title="No se pudieron cargar los datos." description={loadError} onRetry={load} /> : null}
      {rows.length === 0 && !loading ? <EmptyState title="Sin presupuestos" hint={premiumEnabled ? "Creá tu primer presupuesto mensual por categoría." : "No tenés presupuestos guardados para esta cuenta."} ctaLabel={premiumEnabled ? "Crear presupuesto" : undefined} onAction={premiumEnabled ? openCreate : undefined} /> : null}

      <div className={`mt-4 space-y-2 ${loading ? "hidden" : ""}`}>
        {rows.map((r) => (
          <div key={r.id} className="rounded-xl border border-line p-4">
            <div className="flex items-center justify-between">
              <strong>{r.categoria}</strong>
              {premiumEnabled ? (
                <div className="flex gap-2">
                  <button className="btn-secondary" onClick={() => openEdit(r)}>Editar</button>
                  <button className="btn-secondary" onClick={() => setConfirmId(r.id)}>Eliminar</button>
                </div>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Período: {monthName(r.mes)} {r.anio}</p>
            <p className="mt-2 text-sm">Presupuestado: <strong>{money(r.monto_presupuestado)}</strong></p>
            <p className="text-sm">Gastado: <strong>{money(r.monto_gastado)}</strong></p>
            <p className="text-sm">Disponible: <strong className={r.monto_disponible < 0 ? "text-rose-300" : "text-emerald-300"}>{money(r.monto_disponible)}</strong></p>
            <div className="mt-2 h-2 rounded-full bg-slate-200 dark:bg-slate-800">
              <div
                className={`h-2 rounded-full ${getBudgetState(r.porcentaje_usado).barClass}`}
                style={{ width: `${Math.min(100, Math.max(0, r.porcentaje_usado))}%` }}
              />
            </div>
            <p className={`mt-2 text-sm font-semibold ${getBudgetState(r.porcentaje_usado).textClass}`}>
              {r.porcentaje_usado.toFixed(1)}% usado · {getBudgetState(r.porcentaje_usado).label}
            </p>
          </div>
        ))}
      </div>
      </section>
      </PremiumGate>

      <Modal open={premiumEnabled && open} title={editing ? "Editar presupuesto" : "Crear presupuesto"} onClose={() => setOpen(false)}>
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
          <input className="input" type="text" inputMode="decimal" placeholder="Ej: 500.000,50" value={monto} onChange={(e) => setMonto(e.target.value)} required />
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

function getBudgetState(percent: number) {
  if (percent > 100) return { label: "Superado", textClass: "text-rose-300", barClass: "bg-rose-500" };
  if (percent === 100) return { label: "Al límite", textClass: "text-amber-300", barClass: "bg-amber-500" };
  if (percent >= 70) return { label: "Cerca del límite", textClass: "text-amber-300", barClass: "bg-amber-500" };
  return { label: "En control", textClass: "text-emerald-300", barClass: "bg-emerald-500" };
}

function Metric({ title, value, tone = "text-slate-100" }: { title: string; value: string; tone?: string }) {
  return (
    <article className="card p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</p>
      <p className={`mt-1 text-lg font-semibold ${tone}`}>{value}</p>
    </article>
  );
}
