"use client";

import { useMemo, useState } from "react";

import { money, parseCurrencyInput } from "../../lib/format";
import type { Categoria, GastoFijo } from "../../types/domain";
import { useToast } from "../../hooks/useToast";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { Modal } from "../ui/Modal";
import { SectionHeader } from "../ui/SectionHeader";

export function GastosFijosView({
  rows,
  categories,
  loading,
  canEdit = true,
  onCreate,
  onUpdate,
  onDelete,
}: {
  rows: GastoFijo[];
  categories: Categoria[];
  loading?: boolean;
  canEdit?: boolean;
  onCreate: (payload: any) => Promise<void>;
  onUpdate: (id: number, payload: any) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const { showError } = useToast();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<GastoFijo | null>(null);
  const [form, setForm] = useState({ categoria_id: 0, descripcion: "", monto: "", dia_vencimiento: "1", activo: 1 });

  const gastoCategories = useMemo(() => categories.filter((c) => c.tipo === "gasto"), [categories]);
  const enrichedRows = useMemo(() => rows.map((r) => ({ ...r, ...getFixedExpenseStatus(r) })), [rows]);
  const sortedRows = useMemo(() => {
    const statusRank: Record<string, number> = { vencido: 0, proximo: 1, pendiente: 2, inactivo: 3 };
    return [...enrichedRows].sort((a, b) => {
      const rankDiff = statusRank[a.statusKey] - statusRank[b.statusKey];
      if (rankDiff !== 0) return rankDiff;
      return a.dia_vencimiento - b.dia_vencimiento;
    });
  }, [enrichedRows]);
  const resumen = useMemo(() => {
    const activos = enrichedRows.filter((r) => r.activo === 1);
    const totalMensual = activos.reduce((acc, r) => acc + Number(r.monto || 0), 0);
    const proximosCount = activos.filter((r) => r.statusKey === "proximo").length;
    const proximo = sortedRows.find((r) => r.activo === 1) || null;
    return {
      totalMensual,
      activosCount: activos.length,
      proximosCount,
      proximo,
    };
  }, [enrichedRows, sortedRows]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.descripcion.trim()) return showError("Ingresa una descripcion.");
    if (!form.categoria_id) return showError("Selecciona una categoria.");
    const montoNumber = parseCurrencyInput(form.monto);
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
    <section className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric title="Total mensual (activos)" value={money(resumen.totalMensual)} tone="text-rose-300" />
        <Metric title="Gastos fijos activos" value={String(resumen.activosCount)} />
        <Metric
          title="Próximo gasto fijo"
          value={resumen.proximo ? `${resumen.proximo.descripcion} · Día ${resumen.proximo.dia_vencimiento}` : "-"}
          tone={resumen.proximo?.statusTone || "text-slate-100"}
        />
        <Metric title="Próximos a vencer" value={String(resumen.proximosCount)} tone="text-amber-300" />
      </div>

      <section className="card p-5">
      <SectionHeader title="Gastos fijos" subtitle="Plantillas mensuales de egresos" right={canEdit ? <button className="btn" onClick={openCreate}>Crear gasto fijo</button> : undefined} />

      {!loading && rows.length === 0 ? <EmptyState title="No hay gastos fijos cargados." hint={canEdit ? "Creá tu primer gasto fijo mensual." : "No tenés gastos fijos guardados para esta cuenta."} ctaLabel={canEdit ? "Crear gasto fijo" : undefined} onAction={canEdit ? openCreate : undefined} /> : null}

      <div className={`grid gap-3 lg:grid-cols-2 ${loading ? "hidden" : ""}`}>
        {sortedRows.map((r) => (
          <article key={r.id} className="rounded-xl border border-line p-4 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold">{r.descripcion}</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">{r.categoria || "Sin categoría"}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                <Badge tone={r.statusBadgeTone as any}>{r.statusLabel}</Badge>
                <Badge tone={r.activo ? "income" : "neutral"}>{r.activo ? "Activo" : "Inactivo"}</Badge>
              </div>
            </div>
            <p className="text-sm">Monto: <strong className="text-rose-300">{money(r.monto)}</strong></p>
            <p className="text-sm">Vencimiento: <strong>Día {r.dia_vencimiento}</strong> de cada mes</p>
            <p className="text-sm">Frecuencia: <strong>{(r as any).frecuencia || "Mensual"}</strong></p>
            <p className={`text-xs ${r.statusTone}`}>{r.statusDescription}</p>
            {canEdit ? (
              <div className="pt-1 flex justify-end gap-2">
                <button className="btn-secondary" onClick={() => openEdit(r)}>Editar</button>
                <button className="btn-secondary" onClick={() => toggle(r)}>{r.activo ? "Desactivar" : "Activar"}</button>
                <button className="btn-secondary" onClick={() => onDelete(r.id)}>Eliminar</button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      </section>

      <Modal open={canEdit && open} title={selected ? "Editar gasto fijo" : "Crear gasto fijo"} onClose={() => setOpen(false)}>
        <form className="grid gap-2" onSubmit={submit}>
          <label className="text-xs text-slate-400">Categoria</label>
          <select className="input" value={form.categoria_id} onChange={(e) => setForm({ ...form, categoria_id: Number(e.target.value) })} required>
            <option value={0}>Selecciona categoria</option>{gastoCategories.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
          <label className="text-xs text-slate-400">Descripcion</label>
          <input className="input" placeholder="Descripcion" value={form.descripcion} onChange={(e) => setForm({ ...form, descripcion: e.target.value })} required />
          <label className="text-xs text-slate-400">Monto</label>
          <input className="input" type="text" inputMode="decimal" placeholder="Ej: 500.000,50" value={form.monto} onChange={(e) => setForm({ ...form, monto: e.target.value })} required />
          <label className="text-xs text-slate-400">Dia de vencimiento</label>
          <input className="input" type="text" inputMode="numeric" pattern="[0-9]*" placeholder="Dia (1-31)" value={form.dia_vencimiento} onChange={(e) => setForm({ ...form, dia_vencimiento: e.target.value.replace(/\D/g, "") })} required />
          <p className="text-xs text-slate-400">Si el dia no existe en un mes (por ejemplo 31), se usa el ultimo dia de ese mes.</p>
          <div className="mt-2 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancelar</button><button className="btn" type="submit">{selected ? "Guardar cambios" : "Crear gasto fijo"}</button></div>
        </form>
      </Modal>
    </section>
  );
}

function getFixedExpenseStatus(row: GastoFijo) {
  if (!row.activo) {
    return {
      statusKey: "inactivo",
      statusLabel: "Pendiente",
      statusDescription: "Gasto inactivo.",
      statusBadgeTone: "neutral",
      statusTone: "text-slate-400",
    };
  }

  const today = new Date();
  const currentDay = today.getDate();
  const dueDay = Number(row.dia_vencimiento || 1);
  const diff = dueDay - currentDay;
  const dayLabel = (n: number) => `${n} día${n === 1 ? "" : "s"}`;
  if (dueDay < currentDay) {
    const daysLate = Math.abs(diff);
    return {
      statusKey: "vencido",
      statusLabel: "Vencido",
      statusDescription: `Venció hace ${dayLabel(daysLate)}.`,
      statusBadgeTone: "expense",
      statusTone: "text-rose-300",
    };
  }
  if (diff === 0) {
    return {
      statusKey: "proximo",
      statusLabel: "Próximo",
      statusDescription: "Vence hoy.",
      statusBadgeTone: "warn",
      statusTone: "text-amber-300",
    };
  }
  if (diff <= 7) {
    return {
      statusKey: "proximo",
      statusLabel: "Próximo",
      statusDescription: `Vence en ${dayLabel(diff)}.`,
      statusBadgeTone: "warn",
      statusTone: "text-amber-300",
    };
  }
  return {
    statusKey: "pendiente",
    statusLabel: "Pendiente",
    statusDescription: `Faltan ${dayLabel(diff)} para vencer.`,
    statusBadgeTone: "income",
    statusTone: "text-emerald-300",
  };
}

function Metric({ title, value, tone = "text-slate-100" }: { title: string; value: string; tone?: string }) {
  return (
    <article className="card p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</p>
      <p className={`mt-1 text-lg font-semibold ${tone}`}>{value}</p>
    </article>
  );
}
