"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { MetaAhorro } from "../../../types/domain";
import type { CreateMeta } from "../../../services/data/financeRepositoryTypes";
import { validateMeta } from "../../../services/data/mobilePlanningRepository";
import { parseCurrencyInput } from "../../../lib/format";
import { PlanningForm } from "../MobilePlanningUI";

export function MobileGoalForm({ row, busy, error, onClose, onSave }: {
  row?: MetaAhorro; busy: boolean; error: string; onClose: () => void; onSave: (input: CreateMeta) => Promise<boolean>;
}) {
  const [name, setName] = useState(row?.nombre ?? "");
  const [target, setTarget] = useState(row ? String(row.monto_objetivo).replace(".", ",") : "");
  const [initial, setInitial] = useState(row ? String(row.monto_inicial).replace(".", ",") : "");
  const [date, setDate] = useState(row?.fecha_objetivo ?? "");
  const [description, setDescription] = useState(row?.descripcion ?? "");
  const [state, setState] = useState<MetaAhorro["estado"]>(row?.estado ?? "activa");
  const [validationError, setValidationError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setValidationError("");
    try {
      if (await onSave(validateMeta({ nombre: name, monto_objetivo: parseCurrencyInput(target), monto_inicial: initial.trim() ? parseCurrencyInput(initial) : 0,
        fecha_objetivo: date || null, descripcion: description, estado: state }))) onClose();
    } catch (e) { setValidationError(e instanceof Error ? e.message : "Revisá los campos de la meta."); }
  }
  return <PlanningForm title={row ? "Editar meta" : "Crear meta"} busy={busy} error={validationError || error} onClose={onClose} onSubmit={submit} saveLabel="Guardar meta">
    <label className="grid gap-2 text-sm">Nombre<input className="input min-h-12" autoFocus required maxLength={160} value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Monto objetivo<input className="input min-h-12" inputMode="decimal" required placeholder="0,00" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Monto inicial (opcional)<input className="input min-h-12" inputMode="decimal" placeholder="0,00" value={initial} onChange={(e) => setInitial(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Fecha objetivo (opcional)<input className="input min-h-12" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Descripción (opcional)<textarea className="input min-h-20" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
    <label className="grid gap-2 text-sm">Estado<select className="input min-h-12" value={state} onChange={(e) => setState(e.target.value as MetaAhorro["estado"])}><option value="activa">Activa</option><option value="pausada">Pausada</option><option value="completada">Completada</option></select></label>
  </PlanningForm>;
}
