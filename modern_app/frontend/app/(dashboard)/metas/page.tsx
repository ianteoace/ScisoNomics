"use client";

import { useEffect, useMemo, useState } from "react";

import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorState } from "../../../components/ui/ErrorState";
import { LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { Modal } from "../../../components/ui/Modal";
import { useToast } from "../../../hooks/useToast";
import { money, parseCurrencyInput } from "../../../lib/format";
import { api } from "../../../services/api";
import type { MetaAhorro } from "../../../types/domain";

type MetaForm = {
  nombre: string;
  monto_objetivo: string;
  monto_inicial: string;
  fecha_objetivo: string;
  descripcion: string;
  estado: "activa" | "pausada" | "completada";
};

const EMPTY_FORM: MetaForm = {
  nombre: "",
  monto_objetivo: "",
  monto_inicial: "",
  fecha_objetivo: "",
  descripcion: "",
  estado: "activa",
};

export default function MetasPage() {
  const { showError, showSuccess } = useToast();
  const [rows, setRows] = useState<MetaAhorro[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [openForm, setOpenForm] = useState(false);
  const [editing, setEditing] = useState<MetaAhorro | null>(null);
  const [form, setForm] = useState<MetaForm>(EMPTY_FORM);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const title = editing ? "Editar meta" : "Crear meta";

  async function load() {
    setLoading(true);
    try {
      const data = await api.metas();
      setRows(Array.isArray(data) ? data : []);
      setLoadError("");
    } catch (e: any) {
      setLoadError(e.message || "No se pudieron cargar las metas.");
      showError(e.message || "No se pudieron cargar las metas.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const hasRows = useMemo(() => rows.length > 0, [rows]);
  const resumen = useMemo(() => {
    const activas = rows.filter((m) => m.estado === "activa");
    const totalObjetivo = activas.reduce((acc, m) => acc + Number(m.monto_objetivo || 0), 0);
    const totalAhorrado = activas.reduce((acc, m) => acc + Number(m.monto_ahorrado || 0), 0);
    const faltanteTotal = Math.max(0, totalObjetivo - totalAhorrado);
    const metaMasAvanzada = activas.length
      ? [...activas].sort((a, b) => safeProgress(b) - safeProgress(a))[0]
      : null;
    return {
      metasActivas: activas.length,
      totalObjetivo,
      totalAhorrado,
      faltanteTotal,
      metaMasAvanzada,
    };
  }, [rows]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setOpenForm(true);
  }

  function openEdit(meta: MetaAhorro) {
    setEditing(meta);
    setForm({
      nombre: meta.nombre,
      monto_objetivo: String(meta.monto_objetivo),
      monto_inicial: String(meta.monto_inicial || 0),
      fecha_objetivo: meta.fecha_objetivo || "",
      descripcion: meta.descripcion || "",
      estado: meta.estado,
    });
    setOpenForm(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const nombre = form.nombre.trim();
    if (!nombre) {
      showError("El nombre de la meta es obligatorio.");
      return;
    }

    const objetivo = parseCurrencyInput(form.monto_objetivo);
    if (!Number.isFinite(objetivo) || objetivo <= 0) {
      showError("Ingresá un monto objetivo mayor a 0.");
      return;
    }

    const inicialRaw = form.monto_inicial.trim();
    const inicial = inicialRaw ? parseCurrencyInput(inicialRaw) : 0;
    if (!Number.isFinite(inicial) || inicial < 0) {
      showError("El monto inicial no puede ser negativo.");
      return;
    }

    const payload = {
      nombre,
      monto_objetivo: objetivo,
      monto_inicial: inicial,
      fecha_objetivo: form.fecha_objetivo || null,
      descripcion: form.descripcion.trim(),
      estado: form.estado,
    };

    try {
      if (editing) {
        await api.updateMeta(editing.id, payload);
        showSuccess("Meta actualizada");
      } else {
        await api.createMeta(payload);
        showSuccess("Meta creada");
      }
      setOpenForm(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (e: any) {
      showError(e.message || "No se pudo guardar la meta.");
    }
  }

  async function removeMeta() {
    if (!confirmDeleteId) return;
    try {
      await api.deleteMeta(confirmDeleteId);
      showSuccess("Meta eliminada");
      setConfirmDeleteId(null);
      await load();
    } catch (e: any) {
      showError(e.message || "No se pudo eliminar la meta.");
    }
  }

  async function changeState(meta: MetaAhorro, estado: "activa" | "pausada" | "completada") {
    try {
      await api.updateMeta(meta.id, {
        nombre: meta.nombre,
        monto_objetivo: meta.monto_objetivo,
        monto_inicial: meta.monto_inicial,
        fecha_objetivo: meta.fecha_objetivo || null,
        descripcion: meta.descripcion || "",
        estado,
      });
      showSuccess("Estado actualizado");
      await load();
    } catch (e: any) {
      showError(e.message || "No se pudo actualizar el estado.");
    }
  }

  return (
    <section className="space-y-4">
      <header className="card p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-bold">Metas de ahorro</h2>
          <button className="btn" onClick={openCreate}>Crear meta</button>
        </div>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Seguimiento de avance para alcanzar tus objetivos de ahorro.
        </p>
      </header>

      {loading ? (
        <div className="card p-5">
          <LoadingSkeleton rows={5} />
        </div>
      ) : null}

      {!loading && hasRows ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric title="Metas activas" value={String(resumen.metasActivas)} />
          <Metric title="Total objetivo" value={money(resumen.totalObjetivo)} tone="text-cyan-300" />
          <Metric title="Total ahorrado" value={money(resumen.totalAhorrado)} tone="text-emerald-300" />
          <Metric title="Faltante total" value={money(resumen.faltanteTotal)} tone={resumen.faltanteTotal > 0 ? "text-amber-300" : "text-emerald-300"} />
          <Metric
            title="Meta más avanzada"
            value={resumen.metaMasAvanzada ? `${resumen.metaMasAvanzada.nombre} (${safeProgress(resumen.metaMasAvanzada).toFixed(1)}%)` : "-"}
            tone="text-indigo-300"
          />
        </div>
      ) : null}

      <section className="card p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">Detalle de metas</h3>
        <span className="text-sm text-slate-500 dark:text-slate-400">{rows.length} meta(s)</span>
      </div>

      {loadError ? <ErrorState title="No se pudieron cargar las metas." description={loadError} onRetry={load} /> : null}

      {!loading && !hasRows ? (
        <EmptyState
          title="No hay metas de ahorro creadas."
          hint="Creá una meta para empezar a seguir tu progreso."
          ctaLabel="Crear meta"
          onAction={openCreate}
        />
      ) : null}

      {hasRows ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((m) => {
            const rawPct = safeProgress(m);
            const visualPct = Math.max(0, Math.min(100, rawPct));
            const state = getGoalState(rawPct);
            return (
              <article key={m.id} className="rounded-xl border border-line p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold">{m.nombre}</h3>
                    {m.descripcion ? <p className="text-sm text-muted mt-1">{m.descripcion}</p> : null}
                  </div>
                  <span className={`rounded-full border border-line px-2 py-0.5 text-xs uppercase ${state.textClass}`}>{state.label}</span>
                </div>
                <p className="text-sm">Monto actual: <strong>{money(Number(m.monto_ahorrado || 0))}</strong></p>
                <p className="text-sm">Monto objetivo: <strong>{money(Number(m.monto_objetivo || 0))}</strong></p>
                <p className="text-sm">Monto faltante: <strong className={Number(m.faltante || 0) > 0 ? "text-amber-300" : "text-emerald-300"}>{money(Number(m.faltante || 0))}</strong></p>
                {m.fecha_objetivo ? <p className="text-xs text-muted">Fecha objetivo: {m.fecha_objetivo}</p> : null}
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span>Progreso</span>
                    <span>{rawPct.toFixed(1)}%</span>
                  </div>
                  <div className="h-2 rounded bg-slate-700/40">
                    <div className={`h-2 rounded ${state.barClass}`} style={{ width: `${visualPct}%` }} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button className="btn-secondary" onClick={() => openEdit(m)}>Editar</button>
                  <button className="btn-secondary" onClick={() => setConfirmDeleteId(m.id)}>Eliminar</button>
                  {m.estado !== "completada" ? <button className="btn-secondary" onClick={() => changeState(m, "completada")}>Marcar completada</button> : null}
                  {m.estado === "activa" ? <button className="btn-secondary" onClick={() => changeState(m, "pausada")}>Pausar</button> : null}
                  {m.estado === "pausada" ? <button className="btn-secondary" onClick={() => changeState(m, "activa")}>Reactivar</button> : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
      </section>

      <Modal open={openForm} title={title} onClose={() => setOpenForm(false)}>
        <form className="grid gap-2" onSubmit={submit}>
          <label className="text-xs text-muted">Nombre de la meta</label>
          <input className="input" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} required />

          <label className="text-xs text-muted">Monto objetivo</label>
          <input className="input" type="text" inputMode="decimal" placeholder="Ej: 1.250.000" value={form.monto_objetivo} onChange={(e) => setForm({ ...form, monto_objetivo: e.target.value })} required />

          <label className="text-xs text-muted">Monto inicial (opcional)</label>
          <input className="input" type="text" inputMode="decimal" placeholder="Opcional" value={form.monto_inicial} onChange={(e) => setForm({ ...form, monto_inicial: e.target.value })} />

          <label className="text-xs text-muted">Fecha objetivo (opcional)</label>
          <input className="input" type="date" value={form.fecha_objetivo} onChange={(e) => setForm({ ...form, fecha_objetivo: e.target.value })} />

          <label className="text-xs text-muted">Descripción (opcional)</label>
          <textarea className="input min-h-20" value={form.descripcion} onChange={(e) => setForm({ ...form, descripcion: e.target.value })} />

          <label className="text-xs text-muted">Estado</label>
          <select className="input" value={form.estado} onChange={(e) => setForm({ ...form, estado: e.target.value as MetaForm["estado"] })}>
            <option value="activa">Activa</option>
            <option value="pausada">Pausada</option>
            <option value="completada">Completada</option>
          </select>

          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpenForm(false)}>Cancelar</button>
            <button className="btn" type="submit">Guardar</button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Eliminar meta"
        message="Esta acción no se puede deshacer."
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={removeMeta}
      />
    </section>
  );
}

function safeProgress(meta: MetaAhorro) {
  const objetivo = Number(meta.monto_objetivo || 0);
  const actual = Number(meta.monto_ahorrado || 0);
  if (!Number.isFinite(objetivo) || objetivo <= 0 || !Number.isFinite(actual) || actual < 0) return 0;
  return (actual / objetivo) * 100;
}

function getGoalState(progress: number) {
  if (progress >= 100) return { label: "Cumplida", textClass: "text-emerald-300", barClass: "bg-emerald-500" };
  if (progress >= 75) return { label: "Cerca de completar", textClass: "text-amber-300", barClass: "bg-amber-500" };
  return { label: "En progreso", textClass: "text-cyan-300", barClass: "bg-cyan-500" };
}

function Metric({ title, value, tone = "text-slate-100" }: { title: string; value: string; tone?: string }) {
  return (
    <article className="card p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</p>
      <p className={`mt-1 text-lg font-semibold ${tone}`}>{value}</p>
    </article>
  );
}
