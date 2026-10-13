"use client";

import { SpanishMonthInput } from "../../ui/SpanishDateInput";
import { useState } from "react";
import type { FormEvent } from "react";
import type { Categoria, Presupuesto } from "../../../types/domain";
import type { CreatePresupuesto } from "../../../services/data/financeRepositoryTypes";
import { validatePresupuesto } from "../../../services/data/mobilePlanningRepository";
import { parseCurrencyInput } from "../../../lib/format";
import { PlanningForm } from "../MobilePlanningUI";

export function MobileBudgetForm({ categories, rows, row, period, busy, error, onClose, onSave }: {
  categories: Categoria[]; rows: Presupuesto[]; row?: Presupuesto; period: string; busy: boolean; error: string;
  onClose: () => void; onSave: (input: CreatePresupuesto) => Promise<boolean>;
}) {
  const [category, setCategory] = useState(String(row?.categoria_id ?? ""));
  const [selectedPeriod, setSelectedPeriod] = useState(row ? `${row.anio}-${String(row.mes).padStart(2, "0")}` : period);
  const [amount, setAmount] = useState(row ? String(row.monto_presupuestado).replace(".", ",") : "");
  const [validationError, setValidationError] = useState("");
  const available = categories.filter((c) => c.tipo === "gasto");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setValidationError("");
    try {
      if (!available.some((c) => c.id === Number(category))) throw new Error("Elegí una categoría de gasto disponible.");
      const [anio, mes] = selectedPeriod.split("-").map(Number);
      if (await onSave(validatePresupuesto({ categoria_id: Number(category), mes, anio, monto: parseCurrencyInput(amount) }))) onClose();
    } catch (e) { setValidationError(e instanceof Error ? e.message : "Revisá los campos del presupuesto."); }
  }
  const duplicate = rows.some((r) => r.categoria_id === Number(category) && `${r.anio}-${String(r.mes).padStart(2, "0")}` === selectedPeriod);
  return <PlanningForm title={row ? "Editar presupuesto" : "Crear presupuesto"} busy={busy} error={validationError || error} onClose={onClose} onSubmit={submit} saveLabel="Guardar presupuesto">
    <label className="grid gap-1.5 text-sm">Categoría<select className="input min-h-11" autoFocus required disabled={!!row} value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Elegí una categoría</option>{available.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></label>
    {!available.length ? <p className="text-sm text-amber-200">Primero creá una categoría de gasto en Categorías.</p> : null}
    <div className="grid gap-1.5 text-sm"><p>Período</p><SpanishMonthInput label="Período del presupuesto" className="input min-h-11" required disabled={!!row} value={selectedPeriod} onChange={setSelectedPeriod} /></div>
    <label className="grid gap-1.5 text-sm">Monto presupuestado<input className="input min-h-11" inputMode="decimal" required placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
    {row ? <p className="text-sm text-slate-300">Para otra categoría o período, creá otro presupuesto.</p> : duplicate ? <p className="text-sm text-amber-200">Ya existe para este período. Se actualizará el límite al guardar.</p> : null}
  </PlanningForm>;
}
