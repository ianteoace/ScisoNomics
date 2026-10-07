"use client";

import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";
import { getLocalDateInputValue } from "../../../lib/date";
import { parseCurrencyInput } from "../../../lib/format";
import type { Categoria, MoveType, MetaAhorro } from "../../../types/domain";
import type { CreateMovimiento, FinanceMovimiento } from "../../../services/data/financeRepositoryTypes";
import { validateMovimiento } from "../../../services/data/mobileFinanceRepository";
import { compatibleCategories, movementTypes } from "../mobileUi";
import { MobileDialog } from "../MobileDialog";

export function MobileMovementForm({ categories, goals = [], movement, busy, error, onClose, onSave, cloudContext = false }: {
  categories: Categoria[]; goals?: MetaAhorro[]; movement?: FinanceMovimiento; busy: boolean; error: string;
  onClose: () => void; onSave: (input: CreateMovimiento) => Promise<boolean>; cloudContext?: boolean;
}) {
  const [tipo, setTipo] = useState<MoveType>(movement?.tipo ?? "gasto");
  const [monto, setMonto] = useState(movement ? String(movement.monto).replace(".", ",") : "");
  const [descripcion, setDescripcion] = useState(movement?.descripcion ?? "");
  const [fecha, setFecha] = useState(movement?.fecha ?? getLocalDateInputValue());
  const [nota, setNota] = useState(movement?.nota ?? "");
  const [categoryId, setCategoryId] = useState(String(movement?.categoria_id ?? categories.find((category) => category.nombre === movement?.categoria && category.tipo === movement?.tipo)?.id ?? ""));
  const [metaId, setMetaId] = useState(String(movement?.meta_id ?? ""));
  const [validationError, setValidationError] = useState("");
  const available = compatibleCategories(categories, tipo);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setValidationError("");
    try {
      if (!available.some((category) => category.id === Number(categoryId))) throw new Error("Elegí una categoría disponible para este tipo.");
      const input = validateMovimiento({ tipo, monto: parseCurrencyInput(monto), descripcion, fecha, categoria_id: Number(categoryId), nota: cloudContext ? "" : nota, meta_id: !cloudContext && tipo === "ahorro" && metaId ? Number(metaId) : null });
      if (input.meta_id && !goals.some((g) => g.id === input.meta_id)) throw new Error("Elegí una meta disponible.");
      if (await onSave(input)) onClose();
    } catch (error) { setValidationError(error instanceof Error ? error.message : "Revisá los campos del movimiento."); }
  }
  return <MobileDialog title={movement ? "Editar movimiento" : "Agregar movimiento"} onClose={onClose} busy={busy}>
    <form onSubmit={submit} className="grid gap-4">
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <label className="grid gap-2 text-sm">Tipo de movimiento<select className="input min-h-12" autoFocus value={tipo} onChange={(event) => { setTipo(event.target.value as MoveType); setCategoryId(""); setMetaId(""); }}>{movementTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
        <label className="grid gap-2 text-sm">Monto<input className="input min-h-12" inputMode="decimal" value={monto} required onChange={(event) => setMonto(event.target.value)} placeholder="0,00" /></label>
        <label className="grid gap-2 text-sm">Descripción<input className="input min-h-12" value={descripcion} maxLength={500} onChange={(event) => setDescripcion(event.target.value)} /></label>
        <label className="grid gap-2 text-sm">Fecha<input className="input min-h-12" type="date" required value={fecha} onChange={(event) => setFecha(event.target.value)} /></label>
        <label className="grid gap-2 text-sm">Categoría<select className="input min-h-12" value={categoryId} required onChange={(event) => setCategoryId(event.target.value)}><option value="">Elegí una categoría</option>{available.map((category) => <option key={category.id} value={category.id}>{category.nombre}</option>)}</select></label>
        {!available.length ? <p className="text-sm text-amber-200">Creá una categoría de este tipo antes de guardar. {!cloudContext ? <Link className="underline" href="/categorias" prefetch={false} onClick={onClose}>Ir a Categorías</Link> : null}</p> : null}
        {!cloudContext && tipo === "ahorro" ? <label className="grid gap-2 text-sm">Meta de ahorro (opcional)<select className="input min-h-12" value={metaId} onChange={(e) => setMetaId(e.target.value)}><option value="">Sin asignar</option>{goals.map((g) => <option key={g.id} value={g.id}>{g.nombre}</option>)}</select></label> : null}
        {!cloudContext ? <label className="grid gap-2 text-sm">Nota (opcional)<textarea className="input min-h-24 resize-y" value={nota} maxLength={4000} rows={3} onChange={(event) => setNota(event.target.value)} /></label> : null}
        {validationError || error ? <p role="alert" className="break-words text-sm text-red-300">{validationError || error}</p> : null}
        <button className="btn min-h-12 w-full" type="submit" disabled={!available.length}>{busy ? "Guardando…" : "Guardar movimiento"}</button>
        <button className="btn-secondary min-h-12 w-full" type="button" onClick={onClose}>Cancelar</button>
      </fieldset>
    </form>
  </MobileDialog>;
}
