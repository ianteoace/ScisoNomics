import { parseLocalizedNumber } from "./numericInput";
export const APP_LOCALE = "es-AR";
export function formatDateTime(value?: string | null) {
  if (!value) return "Sin registrar";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Fecha no disponible" : new Intl.DateTimeFormat(APP_LOCALE, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
export function formatDate(value?: string | null) {
  if (!value) return "Sin registrar";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? "Fecha no disponible" : new Intl.DateTimeFormat(APP_LOCALE, { dateStyle: "long" }).format(date);
}
export function money(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2,
  }).format(value || 0);
}

export const parseCurrencyInput = parseLocalizedNumber;

export function monthName(month: number) {
  const names = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  return names[month - 1] || String(month);
}

export function yearOptions(currentYear: number, extraYears: number[] = []) {
  const base = Array.from({ length: 8 }, (_, i) => currentYear - 5 + i);
  const unique = new Set<number>([...base, ...extraYears.filter((y) => Number.isFinite(y))]);
  return Array.from(unique).sort((a, b) => b - a);
}
