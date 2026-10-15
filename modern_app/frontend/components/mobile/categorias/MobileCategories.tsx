"use client";

import { useState } from "react";
import type { Categoria } from "../../../types/domain";
import { movementTypes, typeLabel } from "../mobileUi";

export function MobileCategories({ rows, onCreate, onEdit, onDelete }: {
  rows: Categoria[]; onCreate: () => void; onEdit: (row: Categoria) => void; onDelete: (row: Categoria) => void;
}) {
  const [tipo, setTipo] = useState("todos");
  const visible = rows.filter((row) => tipo === "todos" || row.tipo === tipo);
  return <section aria-label="Listado de categorías">
    <button className="btn min-h-12 w-full" onClick={onCreate}>Crear categoría</button>
    <label className="mb-5 mt-4 grid gap-2 text-sm">Filtrar categorías por tipo<select className="input min-h-12" value={tipo} onChange={(event) => setTipo(event.target.value)}><option value="todos">Todos</option>{movementTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
    {!rows.length ? <p className="card p-5 text-slate-300">Creá una categoría para empezar a registrar tus movimientos.</p> : !visible.length ? <p className="card p-5 text-slate-300">No hay categorías de este tipo.</p> : null}
    <ul className="grid gap-3" aria-label="Categorías guardadas">{visible.map((row) => <li key={row.id} className="card min-w-0 p-4">
      <h2 className="break-words font-semibold">{row.nombre}</h2><p className="mt-1 text-sm text-slate-300">{typeLabel(row.tipo)}</p>
      <div className="mt-3 flex flex-wrap gap-2"><button className="btn-secondary min-h-11" aria-label={`Editar categoría ${row.nombre}`} onClick={() => onEdit(row)}>Editar</button><button className="btn-secondary min-h-11" aria-label={`Eliminar categoría ${row.nombre}`} onClick={() => onDelete(row)}>Eliminar</button></div>
    </li>)}</ul>
  </section>;
}
