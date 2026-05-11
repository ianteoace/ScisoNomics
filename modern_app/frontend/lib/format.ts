export function money(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2,
  }).format(value || 0);
}

export function monthName(month: number) {
  const names = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  return names[month - 1] || String(month);
}

export function yearOptions(currentYear: number, extraYears: number[] = []) {
  const base = Array.from({ length: 8 }, (_, i) => currentYear - 5 + i);
  const unique = new Set<number>([...base, ...extraYears.filter((y) => Number.isFinite(y))]);
  return Array.from(unique).sort((a, b) => b - a);
}
