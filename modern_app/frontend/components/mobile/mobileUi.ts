import type { Categoria, MoveType } from "../../types/domain";

export const movementTypes: { value: MoveType; label: string }[] = [
  { value: "ingreso", label: "Ingreso" }, { value: "gasto", label: "Gasto" },
  { value: "ahorro", label: "Ahorro" }, { value: "inversion", label: "Inversión" },
];
export function typeLabel(tipo: MoveType) {
  return movementTypes.find((item) => item.value === tipo)?.label ?? tipo;
}
// Same category choices as the desktop movement form, including legacy names.
export function compatibleCategories(categories: Categoria[], tipo: MoveType) {
  return categories.filter((category) => category.tipo === tipo
    || (tipo === "ahorro" && category.nombre.toLowerCase().includes("ahorro"))
    || (tipo === "inversion" && category.nombre.toLowerCase().includes("inversion")));
}
export function formatMobileDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  // Local noon avoids UTC shifting a stored calendar date to the previous day.
  return new Intl.DateTimeFormat("es-AR").format(new Date(year, month - 1, day, 12));
}
