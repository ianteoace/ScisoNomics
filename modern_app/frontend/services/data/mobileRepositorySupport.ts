import { getMobileDatabase } from "./mobileDatabase";

export const LOCAL_OWNER = "local";
export const newSyncId = () => crypto.randomUUID();
export function boundedText(value: string, maxLength: number, label: string): string {
  if (typeof value !== "string" || value.trim().length > maxLength) throw new Error(`${label} admite hasta ${maxLength} caracteres.`);
  return value.trim();
}
export function validateDate(fecha: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(Date.parse(`${fecha}T00:00:00Z`))
    || new Date(`${fecha}T00:00:00Z`).toISOString().slice(0, 10) !== fecha || fecha.startsWith("0000")) throw new Error("Ingresá una fecha válida.");
}
export function validateAmount(value: number, allowZero = false) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0) || !Number.isSafeInteger(Math.round(value * 100))
    || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw new Error(allowZero
    ? "Ingresá un monto no negativo, con hasta dos decimales." : "Ingresá un monto mayor a cero, con hasta dos decimales.");
}
export function validatePeriod({ month, year }: { month: number; year: number }) {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 1 || year > 9999) throw new Error("Elegí un mes y año válidos.");
}
export function validateId(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Elegí un registro válido.");
}
export async function write(sql: string, bindings: unknown[], message: string) {
  const database = await getMobileDatabase();
  try { return await database.execute(sql, bindings); } catch { throw new Error(message); }
}
export async function requireChanged(sql: string, bindings: unknown[], message: string) {
  const result = await write(sql, bindings, message);
  if (result.rowsAffected !== 1) throw new Error(message);
}
