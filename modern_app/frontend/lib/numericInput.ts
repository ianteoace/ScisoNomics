// String-only editing: grouping never rounds or converts the draft to a float.
export function normalizeNumericInput(value: string | number, editing = false): string {
  let raw = String(value).trim().replace(/[\s$]/g, "");
  if (typeof value === "number" || !editing) {
    if (typeof value === "number" && !Number.isFinite(value)) return "";
    const exponent = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(raw);
    if (exponent) {
      const digits = exponent[2] + (exponent[3] || ""), point = exponent[2].length + Number(exponent[4]);
      raw = exponent[1] + (point <= 0 ? "0." + "0".repeat(-point) + digits
        : point >= digits.length ? digits + "0".repeat(point - digits.length) : digits.slice(0, point) + "." + digits.slice(point));
    }
  }
  if (!/^-?[\d.,]*$/.test(raw)) return "";
  const sign = raw.startsWith("-") ? "-" : "";
  const digits = raw.replace(/^-/, "");
  if (!digits) return sign;
  const comma = digits.lastIndexOf(","), dot = digits.lastIndexOf(".");
  let decimal = -1;
  if (typeof value === "number" || /e[+-]?\d+$/i.test(String(value))) decimal = dot;
  else if (editing) decimal = comma;
  else if (comma >= 0 && dot >= 0) decimal = Math.max(comma, dot);
  else if (comma >= 0) decimal = /^\d{1,3}(,\d{3}){2,}$/.test(digits) ? -1 : comma;
  else if (dot >= 0) decimal = /^\d{1,3}(\.\d{3})+$/.test(digits) ? -1 : dot;
  const integer = (decimal < 0 ? digits : digits.slice(0, decimal)).replace(/[.,]/g, "").replace(/^0+(?=\d)/, "");
  const fraction = decimal < 0 ? "" : digits.slice(decimal + 1).replace(/[.,]/g, "");
  return sign + (integer || "0") + (decimal < 0 ? "" : "," + fraction);
}

export function formatNumericInput(value: string | number, editing = false): string {
  const normalized = normalizeNumericInput(value, editing);
  if (!normalized || normalized === "-") return normalized;
  const [integer, fraction] = normalized.split(",");
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (fraction === undefined ? "" : "," + fraction);
}

export function parseLocalizedNumber(value: string): number {
  if (!/\d/.test(value)) return Number.NaN;
  const normalized = normalizeNumericInput(value);
  if (!normalized || normalized === "-") return Number.NaN;
  const parsed = Number(normalized.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function numericCaret(raw: string, formatted: string, caret: number): number {
  // Grouping marks do not count; retain the ordinal of the editable characters.
  const count = raw.slice(0, caret).replace(/\./g, "").length;
  if (!count) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) if (formatted[i] !== "." && ++seen >= count) return i + 1;
  return formatted.length;
}
