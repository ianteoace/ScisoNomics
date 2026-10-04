import type { Movimiento } from "../../types/domain";

export type FinanceSummary = { ingresos: number; gastos: number; ahorros: number; inversiones: number; balance: number; saldoInicial: number; saldo: number };

export function calculateFinanceSummary(rows: Pick<Movimiento, "tipo" | "monto">[], saldoInicial = 0): FinanceSummary {
  let ingresos = 0, gastos = 0, ahorros = 0, inversiones = 0;
  for (const row of rows) {
    if (row.tipo === "ingreso") ingresos += Math.round(row.monto * 100);
    if (row.tipo === "gasto") gastos += Math.round(row.monto * 100);
    if (row.tipo === "ahorro") ahorros += Math.round(row.monto * 100);
    if (row.tipo === "inversion") inversiones += Math.round(row.monto * 100);
  }
  // Desktop saldo_actual carries history and debits all three outgoing types.
  return { ingresos: ingresos / 100, gastos: gastos / 100, ahorros: ahorros / 100, inversiones: inversiones / 100,
    balance: (ingresos - gastos) / 100, saldoInicial,
    saldo: (Math.round(saldoInicial * 100) + ingresos - gastos - ahorros - inversiones) / 100 };
}
