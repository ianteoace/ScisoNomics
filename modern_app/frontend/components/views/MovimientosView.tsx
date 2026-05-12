"use client";

import { useEffect, useMemo, useState } from "react";

import { getLocalDateInputValue } from "../../lib/date";
import { money } from "../../lib/format";
import type { Categoria, MetaAhorro, Movimiento } from "../../types/domain";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { LoadingSkeleton } from "../ui/LoadingSkeleton";
import { Modal } from "../ui/Modal";
import { SectionHeader } from "../ui/SectionHeader";

type Props = {
  rows: Movimiento[];
  categories: Categoria[];
  metas: MetaAhorro[];
  loading: boolean;
  openCreateSignal?: number;
  onCreate: (payload: any) => Promise<void>;
  onUpdate: (id: number, payload: any) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
};

export function MovimientosView({ rows, categories, metas, loading, openCreateSignal = 0, onCreate, onUpdate, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Movimiento | null>(null);
  const [form, setForm] = useState({
    fecha: getLocalDateInputValue(),
    tipo: "gasto",
    categoria_id: null as number | null,
    descripcion: "",
    monto: "",
    meta_id: null as number | null,
    nota: "",
      tag_ids: [] as number[],
  });

  const filteredCategories = useMemo(
    () => categories.filter((c) => {
      if (!c.tipo) return true;
      if (form.tipo === "ahorro") return c.tipo === "ahorro" || c.nombre.toLowerCase().includes("ahorro");
      if (form.tipo === "inversion") return c.tipo === "inversion" || c.nombre.toLowerCase().includes("inversion");
      return c.tipo === form.tipo;
    }),
    [categories, form.tipo],
  );

  useEffect(() => {
    if (!form.categoria_id) return;
    if (!filteredCategories.some((c) => c.id === form.categoria_id)) {
      setForm((prev) => ({ ...prev, categoria_id: null }));
    }
  }, [form.categoria_id, filteredCategories]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!filteredCategories.length) throw new Error("No hay categorías para este tipo. Creá una categoría primero.");
    const categoriaId = Number(form.categoria_id);
    if (!categoriaId || Number.isNaN(categoriaId) || !filteredCategories.some((c) => c.id === categoriaId)) {
      throw new Error("Seleccioná una categoría.");
    }
    const parsedMetaId = Number(form.meta_id);
    const normalizedMetaId = form.tipo === "ahorro" && parsedMetaId > 0 && !Number.isNaN(parsedMetaId) ? parsedMetaId : null;
    const payload = { ...form, categoria_id: categoriaId, monto: Number(form.monto), meta_id: normalizedMetaId };
    if (editing) await onUpdate(editing.id, payload);
    else await onCreate(payload);
    setOpen(false);
    setEditing(null);
    setForm({ fecha: getLocalDateInputValue(), tipo: "gasto", categoria_id: null, descripcion: "", monto: "", meta_id: null, nota: "", tag_ids: [] });
  }

  function startCreate() {
    setEditing(null);
    setForm({ fecha: getLocalDateInputValue(), tipo: "gasto", categoria_id: null, descripcion: "", monto: "", meta_id: null, nota: "", tag_ids: [] });
    setOpen(true);
  }

  function startEdit(row: Movimiento) {
    const cat = categories.find((c) => c.nombre === row.categoria && (c.tipo === row.tipo || !c.tipo));
    setEditing(row);
    setForm({
      fecha: row.fecha,
      tipo: row.tipo,
      categoria_id: cat?.id || null,
      descripcion: row.descripcion || "",
      monto: String(row.monto),
      meta_id: row.meta_id || null,
      nota: row.nota || "",
      tag_ids: (row.tags || []).map((t) => t.id),
    });
    setOpen(true);
  }

  useEffect(() => {
    if (!openCreateSignal) return;
    startCreate();
  }, [openCreateSignal]);

  return (
    <section className="card p-5">
      <SectionHeader
        title="Movimientos"
        subtitle="Registro historico con saldo acumulado"
        right={<button className="btn" onClick={startCreate}>Nuevo movimiento</button>}
      />

      {loading ? <LoadingSkeleton rows={7} /> : null}

      {rows.length === 0 && !loading ? (
        <EmptyState
          title="Todavia no tenes movimientos"
          hint="Agrega tu primer ingreso o gasto para empezar a analizar tus finanzas."
          ctaLabel="Crear movimiento"
          onAction={startCreate}
        />
      ) : null}

      {rows.length > 0 && !loading ? (
        <div className="table-wrap">
          <table className="table-modern w-full text-sm">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Categoria</th>
                <th>Descripcion</th>
                <th className="text-right">Monto</th>
                <th className="text-right">Saldo acumulado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line/70">
                  <td>{r.fecha}</td>
                  <td><Badge tone={r.tipo === "ingreso" || r.tipo === "ahorro" ? "income" : "expense"}>{r.tipo}</Badge></td>
                  <td><Badge>{r.categoria}</Badge></td>
                  <td>{r.descripcion}</td>
                  <td className={`text-right font-semibold ${r.tipo === "ingreso" || r.tipo === "ahorro" ? "text-emerald-400" : "text-rose-400"}`}>{money(r.monto)}</td>
                  <td className="text-right tabular-nums">{money(r.saldo_acumulado)}</td>
                  <td>
                    <div className="flex justify-end gap-2">
                      <button className="btn-secondary" onClick={() => startEdit(r)}>Editar</button>
                      <button className="btn-secondary" onClick={() => onDelete(r.id)}>Eliminar</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Modal open={open} title={editing ? "Editar movimiento" : "Nuevo movimiento"} onClose={() => setOpen(false)}>
        <form className="grid gap-2" onSubmit={submit}>
          <label className="text-xs text-slate-400">Fecha</label>
          <input className="input" type="date" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} required />
          <label className="text-xs text-slate-400">Tipo</label>
          <select className="input" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value, categoria_id: null })}>
            <option value="ingreso">Ingreso</option>
            <option value="gasto">Gasto</option>
            <option value="ahorro">Ahorro</option>
            <option value="inversion">Inversión</option>
          </select>
          <label className="text-xs text-slate-400">Categoria</label>
          <select className="input" value={form.categoria_id ?? ""} onChange={(e) => setForm({ ...form, categoria_id: e.target.value ? Number(e.target.value) : null })} required>
            <option value="">Seleccioná categoría</option>
            {filteredCategories.map((c) => (
              <option key={c.id} value={c.id}>{c.nombre}</option>
            ))}
          </select>
          {!filteredCategories.length ? <p className="text-xs text-amber-400">No hay categorías para este tipo. Creá una categoría primero.</p> : null}
          <label className="text-xs text-slate-400">Descripcion</label>
          <input className="input" value={form.descripcion} placeholder="Descripcion" onChange={(e) => setForm({ ...form, descripcion: e.target.value })} />
          <label className="text-xs text-slate-400">Monto</label>
          <input className="input" type="number" step="0.01" min="0.01" value={form.monto} placeholder="Monto" onChange={(e) => setForm({ ...form, monto: e.target.value })} required />
          {form.tipo === "ahorro" ? (
            <>
              <label className="text-xs text-slate-400">Meta de ahorro (opcional)</label>
              <select className="input" value={form.meta_id ?? ""} onChange={(e) => setForm({ ...form, meta_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Sin meta</option>
                {metas.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
              </select>
            </>
          ) : null}
          <label className="text-xs text-slate-400">Nota</label>
          <input className="input" value={form.nota} placeholder="Nota opcional" onChange={(e) => setForm({ ...form, nota: e.target.value })} />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancelar</button>
            <button className="btn" type="submit">Guardar</button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
