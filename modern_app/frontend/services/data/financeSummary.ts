import type { Movimiento } from "../../types/domain";

export function calculateFinanceSummary(rows: Pick<Movimiento, "tipo" | "monto">[]) {
  let ingresos = 0, gastos = 0;
  for (const row of rows) {
    if (row.tipo === "ingreso") ingresos += Math.round(row.monto * 100);
    if (row.tipo === "gasto") gastos += Math.round(row.monto * 100);
  }
  // Same operating balance as desktop: savings/investments are separate types.
  return { ingresos: ingresos / 100, gastos: gastos / 100, balance: (ingresos - gastos) / 100 };
}
