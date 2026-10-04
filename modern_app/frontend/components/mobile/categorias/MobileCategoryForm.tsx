"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { Categoria, MoveType } from "../../../types/domain";
import type { CreateCategoria } from "../../../services/data/financeRepositoryTypes";
import { validateCategoria } from "../../../services/data/mobileFinanceRepository";
import { movementTypes } from "../mobileUi";
import { MobileDialog } from "../MobileDialog";

export function MobileCategoryForm({ category, busy, error, onClose, onSave }: {
  category?: Categoria; busy: boolean; error: string; onClose: () => void; onSave: (input: CreateCategoria) => Promise<boolean>;
}) {
  const [nombre, setNombre] = useState(category?.nombre ?? "");
  const [tipo, setTipo] = useState<MoveType>(category?.tipo ?? "gasto");
  const [validationError, setValidationError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setValidationError("");
    try { if (await onSave(validateCategoria({ nombre, tipo }))) onClose(); }
    catch (error) { setValidationError(error instanceof Error ? error.message : "Revisá los campos de la categoría."); }
  }
  return <MobileDialog title={category ? "Editar categoría" : "Crear categoría"} onClose={onClose} busy={busy}>
    <form className="grid gap-4" onSubmit={submit}>
      <fieldset className="grid min-w-0 gap-4" disabled={busy}>
        <label className="grid gap-2 text-sm">Nombre<input className="input min-h-12" autoFocus required maxLength={120} value={nombre} onChange={(event) => setNombre(event.target.value)} /></label>
        <label className="grid gap-2 text-sm">Tipo de categoría<select className="input min-h-12" value={tipo} onChange={(event) => setTipo(event.target.value as MoveType)}>{movementTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
        {validationError || error ? <p role="alert" className="break-words text-sm text-red-300">{validationError || error}</p> : null}
        <button className="btn min-h-12 w-full" type="submit">{busy ? "Guardando…" : "Guardar categoría"}</button>
        <button className="btn-secondary min-h-12 w-full" type="button" onClick={onClose}>Cancelar</button>
      </fieldset>
    </form>
  </MobileDialog>;
}
