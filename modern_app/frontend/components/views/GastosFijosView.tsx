"use client";

import { useMemo, useState } from "react";

import { money } from "../../lib/format";
import type { Categoria, GastoFijo } from "../../types/domain";
import { useToast } from "../../hooks/useToast";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { Modal } from "../ui/Modal";
import { SectionHeader } from "../ui/SectionHeader";

export function GastosFijosView({
  rows,
  categories,
  onCreate,
  onUpdate,
  onDelete,
}: {
  rows: GastoFijo[];
  categories: Categoria[];
  onCreate: (payload: any) => Promise<void>;
  onUpdate: (id: number, payload: any) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const { showError } = useToast();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<GastoFijo | null>(null);
  const [form, setForm] = useState({ categoria_id: 0, descripcion: "", monto: "", dia_vencimiento: "1", activo: 1 });

  const gastoCategories = useMemo(() => categories.filter((c) => c.tipo === "gasto"), [categories]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.descripcion.trim()) return showError("Ingresa una descripcion.");
    if (!form.categoria_id) return showError("Selecciona una categoria.");
    const montoNumber = Number(form.monto);
    if (!Number.isFinite(montoNumber) || montoNumber <= 0) return showError("Ingresa un monto mayor a 0.");
    const diaNumber = Number(form.dia_vencimiento);
    if (!Number.isFinite(diaNumber) || diaNumber < 1 || diaNumber > 31) {
      return showError("El dia debe estar entre 1 y 31.");
    }

    const payload = { ...form, categoria_id: Number(form.categoria_id), monto: montoNumber, dia_vencimiento: diaNumber, activo: Number(form.activo) };
    if (selected) await onUpdate(selected.id, payload);
    else await onCreate(payload);
    clear();
    setOpen(false);
  }

  function clear() {
    setSelected(null);
    setForm({ categoria_id: 0, descripcion: "", monto: "", dia_vencimiento: "1", activo: 1 });
  }

  function openCreate() {
    clear();
    setOpen(true);
  }

  function openEdit(row: GastoFijo) {
    setSelected(row);
    setForm({ categoria_id: row.categoria_id, descripcion: row.descripcion, monto: String(row.monto), dia_vencimiento: String(row.dia_vencimiento), activo: row.activo });
    setOpen(true);
  }

  async function toggle(row: GastoFijo) {
    await onUpdate(row.id, { ...row, activo: row.activo ? 0 : 1 });
  }

  return (
    <section className="card p-5">
      <SectionHeader title="Gastos fijos" subtitle="Plantillas mensuales de egresos" right={<button className="btn" onClick={openCreate}>Crear gasto fijo</button>} />

      {rows.length === 0 ? <EmptyState title="Sin gastos fijos" hint="Crea tu primer gasto fijo mensual." ctaLabel="Crear gasto fijo" onAction={openCreate} /> : null}

      <div className="table-wrap">
        <table className="table-modern w-full text-sm">
          <thead><tr><th>Categoria</th><th>Descripcion</th><th className="text-right">Monto</th><th>Dia</th><th>Activo</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line/70">
                <td><Badge>{r.categoria}</Badge></td><td>{r.descripcion}</td><td className="text-right text-rose-300">{money(r.monto)}</td><td>{r.dia_vencimiento}</td>
                <td><Badge tone={r.activo ? "income" : "neutral"}>{r.activo ? "Activo" : "Inactivo"}</Badge></td>
                <td className="py-2"><div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => openEdit(r)}>Editar</button><button className="btn-secondary" onClick={() => toggle(r)}>{r.activo ? "Desactivar" : "Activar"}</button><button className="btn-secondary" onClick={() => onDelete(r.id)}>Eliminar</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={selected ? "Editar gasto fijo" : "Crear gasto fijo"} onClose={() => setOpen(false)}>
        <form className="grid gap-2" onSubmit={submit}>
          <label className="text-xs text-slate-400">Categoria</label>
          <select className="input" value={form.categoria_id} onChange={(e) => setForm({ ...form, categoria_id: Number(e.target.value) })} required>
            <option value={0}>Selecciona categoria</option>{gastoCategories.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
          <label className="text-xs text-slate-400">Descripcion</label>
          <input className="input" placeholder="Descripcion" value={form.descripcion} onChange={(e) => setForm({ ...form, descripcion: e.target.value })} required />
          <label className="text-xs text-slate-400">Monto</label>
          <input className="input" type="number" step="0.01" min="0.01" placeholder="Monto" value={form.monto} onChange={(e) => setForm({ ...form, monto: e.target.value })} required />
          <label className="text-xs text-slate-400">Dia de vencimiento</label>
          <input className="input" type="text" inputMode="numeric" pattern="[0-9]*" placeholder="Dia (1-31)" value={form.dia_vencimiento} onChange={(e) => setForm({ ...form, dia_vencimiento: e.target.value.replace(/\D/g, "") })} required />
          <p className="text-xs text-slate-400">Si el dia no existe en un mes (por ejemplo 31), se usa el ultimo dia de ese mes.</p>
          <div className="mt-2 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancelar</button><button className="btn" type="submit">{selected ? "Guardar cambios" : "Crear gasto fijo"}</button></div>
        </form>
      </Modal>
    </section>
  );
}
