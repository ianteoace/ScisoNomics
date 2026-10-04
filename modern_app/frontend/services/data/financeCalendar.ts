import type { FinanceCalendarDay, FinanceMovimiento, FinancePeriod } from "./financeRepositoryTypes";
import { getLocalDateInputValue } from "../../lib/date";

export function localCalendarDate(year: number, month: number, day: number) {
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(year, month - 1, day);
  return date;
}
export function calendarGrid({ year, month }: FinancePeriod, today = getLocalDateInputValue()) {
  const first = localCalendarDate(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = localCalendarDate(year, month, 1 - offset + index);
    return { iso: getLocalDateInputValue(date), day: date.getDate(), inMonth: date.getMonth() === month - 1,
      isToday: getLocalDateInputValue(date) === today };
  });
}
export function adjacentPeriod({ month, year }: FinancePeriod, delta: -1 | 1): FinancePeriod {
  const date = localCalendarDate(year, month + delta, 1);
  return { month: date.getMonth() + 1, year: date.getFullYear() };
}
export function groupCalendarMovements(rows: FinanceMovimiento[]): FinanceCalendarDay[] {
  const days = new Map<string, FinanceCalendarDay>();
  for (const row of [...rows].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id - b.id)) {
    if (!days.has(row.fecha)) days.set(row.fecha, { fecha: row.fecha, movimientos: [], totales: { ingreso: 0, gasto: 0, ahorro: 0, inversion: 0 } });
    const day = days.get(row.fecha)!;
    day.movimientos.push(row);
    // Desktop calendar's legacy investment category rule affects totals only.
    const type = row.categoria.toLowerCase().includes("invers") ? "inversion" : row.tipo;
    day.totales[type] = (Math.round(day.totales[type] * 100) + Math.round(row.monto * 100)) / 100;
  }
  return [...days.values()];
}
