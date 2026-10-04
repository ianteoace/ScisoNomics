"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { Categoria, GastoFijo } from "../../../types/domain";
import type { CreateGastoFijo } from "../../../services/data/financeRepositoryTypes";
import { validateGastoFijo } from "../../../services/data/mobilePlanningRepository";
import { parseCurrencyInput } from "../../../lib/format";
import { PlanningForm } from "../MobilePlanningUI";

export function MobileFixedExpenseForm({ categories, row, busy, error, onClose, onSave }: {
  categories: Categoria[]; row?: GastoFijo; busy: boolean; error: string;
  onClose: () => void; onSave: (input: CreateGastoFijo) => Promise<boolean>;
}) {
  const [category, setCategory] = useState(String(row?.categoria_id ?? ""));
  const [description, setDescription] = useState(row?.descripcion ?? "");
  const [amount, setAmount] = useState(row ? String(row.monto).replace(".", ",") : "");
  const [day, setDay] = useState(String(row?.dia_vencimiento ?? 1));
  const [active, setActive] = useState(row?.activo ?? 1);
  const [validationError, setValidationError] = useState("");
  const available = categories.filter((c) => c.tipo === "gasto");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setValidationError("");
    try {
      if (!available.some((c) => c.id === Number(category))) throw new Error("Elegí una categoría de gasto disponible.");
      if (await onSave(validateGastoFijo({ categoria_id: Number(category), descripcion: description, monto: parseCurrencyInput(amount), dia_vencimiento: Number(day), activo: active }))) onClose();
    } catch (e) { setValidationError(e instanceof Error ? e.message : "Revisá los campos del gasto fijo."); }
  }
  return <PlanningForm title={row ? "Editar gasto fijo" : "Crear gasto fijo"} busy={busy} error={validationError || error} onClose={onClose} onSubmit={submit} saveLabel="Guardar gasto fijo">
    <label className="grid gap-2 text-sm">Descripción<input className="input min-h-12" autoFocus required maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Categoría<select className="input min-h-12" required value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Elegí una categoría</option>{available.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></label>
    {!available.length ? <p className="text-sm text-amber-200">Primero creá una categoría de gasto en Categorías.</p> : null}
    <label className="grid gap-2 text-sm">Monto<input className="input min-h-12" inputMode="decimal" required placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Día de vencimiento<input className="input min-h-12" inputMode="numeric" required value={day} onChange={(e) => setDay(e.target.value)} /></label>
    <p className="text-sm text-slate-300">Mensual. Si el día no existe en un mes, corresponde al último día de ese mes.</p>
    <label className="grid gap-2 text-sm">Estado<select className="input min-h-12" value={active} onChange={(e) => setActive(Number(e.target.value))}><option value={1}>Activo</option><option value={0}>Inactivo</option></select></label>
  </PlanningForm>;
}
