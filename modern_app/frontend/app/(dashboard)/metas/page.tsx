"use client";

import { useEffect, useMemo, useState } from "react";

import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorState } from "../../../components/ui/ErrorState";
import { LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { Modal } from "../../../components/ui/Modal";
import { useToast } from "../../../hooks/useToast";
import { money } from "../../../lib/format";
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

    const objetivo = Number(form.monto_objetivo.trim());
    if (!Number.isFinite(objetivo) || objetivo <= 0) {
      showError("Ingresá un monto objetivo mayor a 0.");
      return;
    }

    const inicialRaw = form.monto_inicial.trim();
    const inicial = inicialRaw ? Number(inicialRaw) : 0;
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
    <section className="card p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Metas de ahorro</h2>
        <button className="btn" onClick={openCreate}>Crear meta</button>
      </div>

      {loadError ? <ErrorState title="Error al cargar metas" description={loadError} onRetry={load} /> : null}
      {loading ? <LoadingSkeleton rows={6} /> : null}

      {!loading && !hasRows ? (
        <EmptyState
          title="No tenés metas de ahorro todavía"
          hint="Creá una meta para visualizar tu progreso de ahorro."
          ctaLabel="Crear meta"
          onAction={openCreate}
        />
      ) : null}

      {hasRows ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((m) => {
            const pct = Math.max(0, Math.min(100, Number(m.porcentaje_completado || 0)));
            return (
              <article key={m.id} className="rounded-xl border border-line p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold">{m.nombre}</h3>
                    {m.descripcion ? <p className="text-sm text-muted mt-1">{m.descripcion}</p> : null}
                  </div>
                  <span className="rounded-full border border-line px-2 py-0.5 text-xs uppercase">{m.estado}</span>
                </div>
                <p className="text-sm">Objetivo: <strong>{money(m.monto_objetivo)}</strong></p>
                <p className="text-sm">Ahorrado: <strong>{money(m.monto_ahorrado)}</strong></p>
                <p className="text-sm">Faltante: <strong>{money(m.faltante)}</strong></p>
                {m.fecha_objetivo ? <p className="text-xs text-muted">Fecha objetivo: {m.fecha_objetivo}</p> : null}
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span>Progreso</span>
                    <span>{pct.toFixed(1)}%</span>
                  </div>
                  <div className="h-2 rounded bg-slate-700/40">
                    <div className="h-2 rounded bg-emerald-400" style={{ width: `${pct}%` }} />
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

      <Modal open={openForm} title={title} onClose={() => setOpenForm(false)}>
        <form className="grid gap-2" onSubmit={submit}>
          <label className="text-xs text-muted">Nombre de la meta</label>
          <input className="input" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} required />

          <label className="text-xs text-muted">Monto objetivo</label>
          <input className="input" type="number" min="0.01" step="0.01" value={form.monto_objetivo} onChange={(e) => setForm({ ...form, monto_objetivo: e.target.value })} required />

          <label className="text-xs text-muted">Monto inicial (opcional)</label>
          <input className="input" type="number" min="0" step="0.01" value={form.monto_inicial} onChange={(e) => setForm({ ...form, monto_inicial: e.target.value })} />

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
