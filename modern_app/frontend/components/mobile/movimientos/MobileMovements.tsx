"use client";

import { useState } from "react";
import type { FinanceMovimiento } from "../../../services/data/financeRepositoryTypes";
import { movementTypes } from "../mobileUi";
import { MobileMovementList } from "./MobileMovementList";

export function MobileMovements({ rows, onCreate, onEdit, onDelete }: {
  rows: FinanceMovimiento[]; onCreate: () => void; onEdit: (row: FinanceMovimiento) => void; onDelete: (row: FinanceMovimiento) => void;
}) {
  const [tipo, setTipo] = useState("todos");
  const visible = rows.filter((row) => tipo === "todos" || row.tipo === tipo);
  return <section aria-label="Listado de movimientos">
    <button className="btn min-h-12 w-full" onClick={onCreate}>Agregar movimiento</button>
    <label className="mb-5 mt-4 grid gap-2 text-sm">Filtrar movimientos por tipo<select className="input min-h-12" value={tipo} onChange={(event) => setTipo(event.target.value)}><option value="todos">Todos</option>{movementTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
    {visible.length ? <MobileMovementList rows={visible} onEdit={onEdit} onDelete={onDelete} /> : <p className="card p-5 text-slate-300">No tenés movimientos para este período y tipo.</p>}
  </section>;
}
