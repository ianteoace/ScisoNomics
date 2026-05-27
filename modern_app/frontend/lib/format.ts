export function money(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2,
  }).format(value || 0);
}

export function parseCurrencyInput(value: string): number {
  const raw = String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/\$/g, "")
    .replace(/[^\d.,-]/g, "");

  if (!raw || raw === "-" || raw === "." || raw === ",") return Number.NaN;

  const sign = raw.startsWith("-") ? "-" : "";
  const unsigned = raw.replace(/-/g, "");
  let normalized = unsigned;

  if (unsigned.includes(",")) {
    const lastComma = unsigned.lastIndexOf(",");
    const integerPart = unsigned.slice(0, lastComma).replace(/[.,]/g, "");
    const decimalPart = unsigned.slice(lastComma + 1).replace(/[^\d]/g, "");
    normalized = `${integerPart || "0"}${decimalPart ? `.${decimalPart}` : ""}`;
  } else {
    const dotMatches = unsigned.match(/\./g) || [];
    if (dotMatches.length > 1) {
      normalized = unsigned.replace(/\./g, "");
    } else if (dotMatches.length === 1) {
      const [integerPart, fractionalPart = ""] = unsigned.split(".");
      normalized = fractionalPart.length === 3
        ? `${integerPart}${fractionalPart}`
        : `${integerPart || "0"}.${fractionalPart}`;
    }
  }

  const parsed = Number(`${sign}${normalized}`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
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
