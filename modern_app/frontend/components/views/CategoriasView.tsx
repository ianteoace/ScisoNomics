"use client";

import { useMemo, useState } from "react";

import type { Categoria } from "../../types/domain";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { LoadingSkeleton } from "../ui/LoadingSkeleton";
import { Modal } from "../ui/Modal";
import { SectionHeader } from "../ui/SectionHeader";

export function CategoriasView({
  categories,
  loading,
  onCreate,
  onUpdate,
  onDelete,
}: {
  categories: Categoria[];
  loading: boolean;
  onCreate: (payload: any) => Promise<void>;
  onUpdate: (id: number, payload: any) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Categoria | null>(null);
  const [nombre, setNombre] = useState("");
  const [tipo, setTipo] = useState<"ingreso" | "gasto" | "ahorro" | "inversion">("gasto");

  const ingresos = useMemo(() => categories.filter((c) => c.tipo === "ingreso"), [categories]);
  const gastos = useMemo(() => categories.filter((c) => c.tipo === "gasto"), [categories]);
  const ahorros = useMemo(() => categories.filter((c) => c.tipo === "ahorro"), [categories]);
  const inversiones = useMemo(() => categories.filter((c) => c.tipo === "inversion"), [categories]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) return;
    const payload = { nombre: nombre.trim(), tipo };
    if (selected) await onUpdate(selected.id, payload);
    else await onCreate(payload);
    clear();
    setOpen(false);
  }

  function clear() {
    setSelected(null);
    setNombre("");
    setTipo("gasto");
  }

  function openCreate() {
    clear();
    setOpen(true);
  }

  function openEdit(c: Categoria) {
    setSelected(c);
    setNombre(c.nombre);
    setTipo(c.tipo);
    setOpen(true);
  }

  return (
    <section className="card p-5">
      <SectionHeader title="Categorias" subtitle="Separadas por tipo de movimiento" right={<button className="btn" onClick={openCreate}>Nueva categoria</button>} />

      {loading ? <LoadingSkeleton rows={8} /> : null}
      {categories.length === 0 && !loading ? <EmptyState title="Sin categorias" hint="Crea categorias para empezar." ctaLabel="Nueva categoria" onAction={openCreate} /> : null}

      <div className={`grid grid-cols-1 gap-4 md:grid-cols-2 ${loading ? "hidden" : ""}`}>
        <div className="space-y-4">
          <CategoryList title="Ingresos" rows={ingresos} onEdit={openEdit} onDelete={onDelete} />
          <CategoryList title="Ahorro" rows={ahorros} onEdit={openEdit} onDelete={onDelete} />
        </div>
        <div className="space-y-4">
          <CategoryList title="Gastos" rows={gastos} onEdit={openEdit} onDelete={onDelete} />
          <CategoryList title="Inversion" rows={inversiones} onEdit={openEdit} onDelete={onDelete} />
        </div>
      </div>

      <Modal open={open} title={selected ? "Editar categoria" : "Nueva categoria"} onClose={() => setOpen(false)}>
        <form onSubmit={submit} className="grid gap-2">
          <label className="text-xs text-slate-400">Nombre</label>
          <input className="input" placeholder="Nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} required />
          <label className="text-xs text-slate-400">Tipo</label>
          <select className="input" value={tipo} onChange={(e) => setTipo(e.target.value as any)} required>
            <option value="ingreso">Ingreso</option>
            <option value="gasto">Gasto</option>
            <option value="ahorro">Ahorro</option>
            <option value="inversion">Inversion</option>
          </select>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancelar</button>
            <button className="btn" type="submit">{selected ? "Guardar cambios" : "Crear categoria"}</button>
          </div>
        </form>
      </Modal>
    </section>
  );
}

function CategoryList({ title, rows, onEdit, onDelete }: { title: string; rows: Categoria[]; onEdit: (c: Categoria) => void; onDelete: (id: number) => Promise<void> }) {
  return (
    <article className="min-w-0 self-start rounded-xl border border-line p-3 transition-colors duration-200 bg-[rgb(var(--panel))]">
      <h4 className="mb-2 text-sm font-semibold text-[rgb(var(--text))]">{title}</h4>
      {rows.length === 0 ? <p className="text-xs text-[rgb(var(--muted))]">Sin categorias</p> : null}
      <div className="space-y-2">
        {rows.map((c) => (
          <div key={c.id} className="min-w-0 rounded-lg border border-line/70 p-2 text-sm bg-[rgb(var(--card))]">
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 truncate">
                <Badge>{c.nombre}</Badge>
              </span>
              <div className="flex flex-wrap gap-2 sm:justify-end"><button className="btn-secondary" onClick={() => onEdit(c)}>Editar</button><button className="btn-secondary" onClick={() => onDelete(c.id)}>Eliminar</button></div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
