"use client";

import type { FormEvent, ReactNode } from "react";
import { MobileDialog } from "./MobileDialog";

export function PlanningForm({ title, busy, error, onClose, onSubmit, children, saveLabel }: {
  title: string; busy: boolean; error: string; onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: ReactNode; saveLabel: string;
}) {
  return <MobileDialog title={title} onClose={onClose} busy={busy}>
    <form className="grid gap-4" onSubmit={onSubmit}>
      <fieldset className="grid min-w-0 gap-4" disabled={busy}>
        {children}
        {error ? <p role="alert" className="break-words text-sm text-red-300">{error}</p> : null}
        <button className="btn min-h-12 w-full" type="submit">{busy ? "Guardando…" : saveLabel}</button>
        <button className="btn-secondary min-h-12 w-full" type="button" onClick={onClose}>Cancelar</button>
      </fieldset>
    </form>
  </MobileDialog>;
}
export function PlanningActions({ name, onEdit, onDelete }: { name: string; onEdit: () => void; onDelete: () => void }) {
  return <div className="flex flex-wrap gap-3 pt-2">
    <button className="btn-secondary min-h-11" aria-label={`Editar ${name}`} onClick={onEdit}>Editar</button>
    <button className="btn-secondary min-h-11" aria-label={`Eliminar ${name}`} onClick={onDelete}>Eliminar</button>
  </div>;
}
export function PlanningProgress({ percent, label }: { percent: number; label: string }) {
  const visual = Math.max(0, Math.min(100, percent));
  return <div className="grid gap-2">
    <p className="text-sm">{percent.toFixed(1)}% · {label}</p>
    <div role="progressbar" aria-label="Progreso" aria-valuemin={0} aria-valuemax={100} aria-valuenow={visual} aria-valuetext={`${percent.toFixed(1)}%: ${label}`} className="h-2 overflow-hidden rounded-full bg-slate-700">
      <div className="h-full rounded-full bg-cyan-400" style={{ width: `${visual}%` }} />
    </div>
  </div>;
}
export function budgetState(percent: number) {
  return percent > 100 ? "Superado" : percent === 100 ? "Al límite" : percent >= 70 ? "Cerca del límite" : "En control";
}
export function goalState(percent: number) { return percent >= 100 ? "Cumplida" : percent >= 75 ? "Cerca de completar" : "En progreso"; }
