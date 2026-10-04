"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { Categoria, GastoProgramado } from "../../../types/domain";
import type { CreateGastoProgramado } from "../../../services/data/financeRepositoryTypes";
import { validateGastoProgramado } from "../../../services/data/mobileSchedulingRepository";
import { getLocalDateInputValue } from "../../../lib/date";
import { parseCurrencyInput } from "../../../lib/format";
import { PlanningForm } from "../MobilePlanningUI";

export function MobileSchedulingForm({ categories, row, busy, error, onClose, onSave }: {
  categories: Categoria[]; row?: GastoProgramado; busy: boolean; error: string;
  onClose: () => void; onSave: (input: CreateGastoProgramado) => Promise<boolean>;
}) {
  const [description, setDescription] = useState(row?.descripcion ?? "");
  const [category, setCategory] = useState(String(row?.categoria_id ?? ""));
  const [amount, setAmount] = useState(row ? String(row.monto_estimado).replace(".", ",") : "");
  const [date, setDate] = useState(row?.fecha_vencimiento ?? getLocalDateInputValue());
  const [state, setState] = useState<GastoProgramado["estado"]>(row?.estado ?? "pendiente");
  const [recurring, setRecurring] = useState(!!row?.es_recurrente);
  const [frequency, setFrequency] = useState<NonNullable<GastoProgramado["frecuencia"]>>(row?.frecuencia ?? "mensual");
  const [validationError, setValidationError] = useState("");
  const available = categories.filter((c) => c.tipo === "gasto");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setValidationError("");
    try {
      if (!available.some((c) => c.id === Number(category))) throw new Error("Elegí una categoría de gasto disponible.");
      if (await onSave(validateGastoProgramado({ descripcion: description, categoria_id: Number(category), monto_estimado: parseCurrencyInput(amount),
        fecha_vencimiento: date, estado: state, es_recurrente: recurring ? 1 : 0, frecuencia: recurring ? frequency : null }))) onClose();
    } catch (e) { setValidationError(e instanceof Error ? e.message : "Revisá los campos de la planificación."); }
  }
  return <PlanningForm title={row ? "Editar planificación" : "Crear planificación"} busy={busy} error={validationError || error} onClose={onClose} onSubmit={submit} saveLabel="Guardar planificación">
    <label className="grid gap-2 text-sm">Descripción<input className="input min-h-12" autoFocus required maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Categoría<select className="input min-h-12" required value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Elegí una categoría</option>{available.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></label>
    {!available.length ? <p className="text-sm text-amber-200">Primero creá una categoría de gasto en Categorías.</p> : null}
    <label className="grid gap-2 text-sm">Monto estimado<input className="input min-h-12" inputMode="decimal" required placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Fecha de vencimiento<input className="input min-h-12" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Estado<select className="input min-h-12" value={state} onChange={(e) => setState(e.target.value as GastoProgramado["estado"])}><option value="pendiente">Pendiente</option><option value="pagado">Pagado</option><option value="cancelado">Cancelado</option></select></label>
    <p className="text-xs text-slate-300">Cambiar el estado aquí no registra un movimiento. Usá Marcar pagado para registrar el gasto real.</p>
    <label className="flex min-h-12 items-center gap-3 text-sm"><input type="checkbox" className="h-6 w-6" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />Gasto recurrente</label>
    {recurring ? <label className="grid gap-2 text-sm">Frecuencia<select className="input min-h-12" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}><option value="mensual">Mensual</option><option value="semanal">Semanal</option><option value="anual">Anual</option></select></label> : null}
  </PlanningForm>;
}
