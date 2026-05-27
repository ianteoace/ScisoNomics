"use client";

import { useMemo, useState } from "react";

import { getLocalDateInputValue } from "../../lib/date";
import { money, parseCurrencyInput } from "../../lib/format";
import type { Categoria, GastoProgramado } from "../../types/domain";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { LoadingSkeleton } from "../ui/LoadingSkeleton";
import { Modal } from "../ui/Modal";
import { SectionHeader } from "../ui/SectionHeader";

export function PlanificacionView({
  rows,
  categories,
  loading,
  onCreate,
  onUpdate,
  onDelete,
  onMarkPaid,
}: {
  rows: GastoProgramado[];
  categories: Categoria[];
  loading: boolean;
  onCreate: (payload: any) => Promise<void>;
  onUpdate: (id: number, payload: any) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onMarkPaid: (id: number) => Promise<void>;
}) {
  const [filter, setFilter] = useState("todos");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<GastoProgramado | null>(null);
  const [form, setForm] = useState({ descripcion: "", categoria_id: 0, monto_estimado: "", fecha_vencimiento: getLocalDateInputValue(), estado: "pendiente", es_recurrente: 0, frecuencia: "mensual" });

  const gastoCategories = useMemo(() => categories.filter((c) => c.tipo === "gasto"), [categories]);
  const filtered = useMemo(() => rows.filter((r) => (filter === "todos" ? true : r.estado === filter)), [rows, filter]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.descripcion.trim() || !form.categoria_id) return;
    const montoNumber = parseCurrencyInput(form.monto_estimado);
    if (!Number.isFinite(montoNumber) || montoNumber <= 0) return;

    const payload = {
      ...form,
      categoria_id: Number(form.categoria_id),
      monto_estimado: montoNumber,
      es_recurrente: Number(form.es_recurrente),
      frecuencia: Number(form.es_recurrente) === 1 ? form.frecuencia : null,
    };
    if (selected) await onUpdate(selected.id, payload);
    else await onCreate(payload);
    clear();
    setOpen(false);
  }

  function clear() {
    setSelected(null);
    setForm({ descripcion: "", categoria_id: 0, monto_estimado: "", fecha_vencimiento: getLocalDateInputValue(), estado: "pendiente", es_recurrente: 0, frecuencia: "mensual" });
  }

  function openCreate() {
    clear();
    setOpen(true);
  }

  function openEdit(row: GastoProgramado) {
    setSelected(row);
    setForm({ descripcion: row.descripcion, categoria_id: row.categoria_id, monto_estimado: String(row.monto_estimado), fecha_vencimiento: row.fecha_vencimiento, estado: row.estado, es_recurrente: row.es_recurrente, frecuencia: (row.frecuencia || "mensual") as any });
    setOpen(true);
  }

  function stateClass(row: GastoProgramado) {
    const today = getLocalDateInputValue();
    if (row.estado === "pendiente" && row.fecha_vencimiento < today) return "bg-rose-900/40 text-rose-200";
    if (row.estado === "pendiente" && row.fecha_vencimiento === today) return "bg-amber-900/40 text-amber-200";
    if (row.estado === "pendiente") return "bg-cyan-900/40 text-cyan-200";
    if (row.estado === "pagado") return "bg-emerald-900/40 text-emerald-200";
    return "bg-slate-800 text-slate-200";
  }

  return (
    <section className="card p-5">
      <SectionHeader title="Planificación" subtitle="Control de vencimientos y recurrencias" right={
        <div className="flex items-center gap-2">
          <select className="input w-48" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="todos">Todos</option><option value="pendiente">Pendientes</option><option value="pagado">Pagados</option><option value="cancelado">Cancelados</option>
          </select>
          <button className="btn" onClick={openCreate}>Crear planificacion</button>
        </div>
      } />

      {loading ? <LoadingSkeleton rows={7} /> : null}
      {filtered.length === 0 && !loading ? <EmptyState title="Sin planificacion" hint="Crea tu primer gasto programado." ctaLabel="Crear planificacion" onAction={openCreate} /> : null}

      <div className={`table-wrap ${loading ? "hidden" : ""}`}>
        <table className="table-modern w-full text-sm">
          <thead><tr><th>Vencimiento</th><th>Estado</th><th>Categoria</th><th>Descripcion</th><th className="text-right">Monto</th><th>Recurrencia</th><th /></tr></thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-t border-line/70">
                <td>{r.fecha_vencimiento}</td>
                <td><span className={`rounded-full px-2 py-1 text-xs ${stateClass(r)}`}>{r.estado}</span></td>
                <td><Badge>{r.categoria}</Badge></td><td>{r.descripcion}</td><td className="text-right text-rose-300">{money(r.monto_estimado)}</td>
                <td>{r.es_recurrente ? <Badge tone="warn">{r.frecuencia}</Badge> : "-"}</td>
                <td className="py-2"><div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => openEdit(r)}>Editar</button>{r.estado === "pendiente" ? <button className="btn-secondary" onClick={() => onMarkPaid(r.id)}>Marcar pagado</button> : null}<button className="btn-secondary" onClick={() => onDelete(r.id)}>Eliminar</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={selected ? "Editar planificacion" : "Crear planificacion"} onClose={() => setOpen(false)}>
        <form className="grid gap-2" onSubmit={submit}>
          <label className="text-xs text-slate-400">Descripcion</label>
          <input className="input" placeholder="Descripcion" value={form.descripcion} onChange={(e) => setForm({ ...form, descripcion: e.target.value })} required />
          <label className="text-xs text-slate-400">Categoria</label>
          <select className="input" value={form.categoria_id} onChange={(e) => setForm({ ...form, categoria_id: Number(e.target.value) })} required><option value={0}>Categoria</option>{gastoCategories.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select>
          <label className="text-xs text-slate-400">Monto estimado</label>
          <input className="input" type="text" inputMode="decimal" value={form.monto_estimado} placeholder="Ej: 500.000,50" onChange={(e) => setForm({ ...form, monto_estimado: e.target.value })} required />
          <label className="text-xs text-slate-400">Fecha de vencimiento</label>
          <input className="input" type="date" value={form.fecha_vencimiento} onChange={(e) => setForm({ ...form, fecha_vencimiento: e.target.value })} required />
          <label className="text-xs text-slate-400">Estado</label>
          <select className="input" value={form.estado} onChange={(e) => setForm({ ...form, estado: e.target.value })}><option value="pendiente">Pendiente</option><option value="pagado">Pagado</option><option value="cancelado">Cancelado</option></select>
          <label className="flex items-center gap-2 text-xs"><span>Recurrente</span><input type="checkbox" checked={!!form.es_recurrente} onChange={(e) => setForm({ ...form, es_recurrente: e.target.checked ? 1 : 0 })} /></label>
          {form.es_recurrente ? <select className="input" value={form.frecuencia} onChange={(e) => setForm({ ...form, frecuencia: e.target.value })}><option value="mensual">Mensual</option><option value="semanal">Semanal</option><option value="anual">Anual</option></select> : null}
          <div className="mt-2 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancelar</button><button className="btn" type="submit">{selected ? "Guardar cambios" : "Crear"}</button></div>
        </form>
      </Modal>
    </section>
  );
}
