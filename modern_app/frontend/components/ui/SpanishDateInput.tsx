"use client";
import { useEffect, useState } from "react";
import { monthName } from "../../lib/format";

type Props = { value: string; onChange(value: string): void; disabled?: boolean; required?: boolean; label?: string; className?: string };
export function SpanishDateInput({ value, onChange, disabled, required, label = "Fecha", className = "input" }: Props) {
  const today = new Date();
  const [y, m, d] = value.split("-").map(Number);
  const year = y || today.getFullYear(), month = m || today.getMonth() + 1, day = d || today.getDate();
  const [draftYear, setDraftYear] = useState(value ? String(year) : "");
  useEffect(() => { setDraftYear(value ? String(year) : ""); }, [value, year]);
  const days = new Date(year, month, 0).getDate();
  function emit(nextYear: number, nextMonth: number, nextDay: number) {
    const limit = new Date(nextYear, nextMonth, 0).getDate();
    onChange(`${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(Math.min(nextDay, limit)).padStart(2, "0")}`);
  }
  return <span role="group" aria-label={label} className="grid min-w-0 gap-2">
    <span className="flex min-w-0 flex-wrap gap-2">
      <select aria-label={`${label}: día`} className={`${className} min-w-0 flex-[1_1_3.5rem]`} value={value ? day : ""} disabled={disabled} required={required} onChange={e => emit(year, month, Number(e.target.value))}>
        {!value ? <option value="">Día</option> : null}{Array.from({ length: days }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
      </select>
      <select aria-label={`${label}: mes`} className={`${className} min-w-0 flex-[2_1_7.5rem]`} value={value ? month : ""} disabled={disabled} required={required} onChange={e => emit(year, Number(e.target.value), day)}>
        {!value ? <option value="">Mes</option> : null}{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{monthName(i + 1)}</option>)}
      </select>
      <input aria-label={`${label}: año`} className={`${className} min-w-0 flex-[1_1_5.5rem]`} type="number" inputMode="numeric" min={1000} max={9999} placeholder="Año" value={draftYear} disabled={disabled} required={required || !!value}
        onChange={e => { setDraftYear(e.target.value); const next = Number(e.target.value); if (/^\d{4}$/.test(e.target.value) && next >= 1000) emit(next, month, day); }} />
    </span>
    {!required && value ? <button type="button" className="justify-self-start text-xs text-slate-400 underline" disabled={disabled} onClick={() => onChange("")}>Quitar fecha</button> : null}
  </span>;
}

export function SpanishMonthInput({ value, onChange, disabled, required, label = "Período", className = "input" }: Props) {
  const now = new Date();
  const [y, m] = value.split("-").map(Number);
  const year = y || now.getFullYear(), month = m || now.getMonth() + 1;
  const [draftYear, setDraftYear] = useState(String(year));
  useEffect(() => { setDraftYear(String(year)); }, [year]);
  return <span role="group" aria-label={label} className="flex min-w-0 flex-wrap gap-2">
    <select aria-label={`${label}: mes`} className={`${className} min-w-0 flex-[2_1_7.5rem]`} disabled={disabled} required={required} value={month} onChange={e => onChange(`${year}-${e.target.value.padStart(2, "0")}`)}>
      {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{monthName(i + 1)}</option>)}
    </select>
    <input aria-label={`${label}: año`} className={`${className} min-w-0 flex-[1_1_5.5rem]`} type="number" inputMode="numeric" min={1000} max={9999} required value={draftYear} disabled={disabled}
      onChange={e => { setDraftYear(e.target.value); if (/^\d{4}$/.test(e.target.value) && Number(e.target.value) >= 1000) onChange(`${e.target.value}-${String(month).padStart(2, "0")}`); }} />
  </span>;
}
