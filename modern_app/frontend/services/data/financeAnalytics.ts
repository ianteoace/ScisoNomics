import type { AnnualStatsResponse, StatsResponse } from "../../types/domain";
import type { FinanceMonthTotals, FinancePeriod } from "./financeRepositoryTypes";
import type { FinanceSummary } from "./financeSummary";

export function periodStart({ year, month }: FinancePeriod) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}
export function periodEnd(period: FinancePeriod) {
  if (period.year === 9999 && period.month === 12) return "9999-12-32";
  return periodStart(period.month === 12 ? { year: period.year + 1, month: 1 } : { ...period, month: period.month + 1 });
}
export function sixMonthPeriods({ year, month }: FinancePeriod): FinancePeriod[] {
  const end = year * 12 + month - 1;
  return Array.from({ length: 6 }, (_, index) => {
    const value = end - 5 + index;
    return { year: Math.floor(value / 12), month: value % 12 + 1 };
  });
}
export function monthTotals(summary: FinanceSummary): FinanceMonthTotals {
  return { ingreso: summary.ingresos, gasto: summary.gastos, ahorro: summary.ahorros, inversion: summary.inversiones,
    balance: summary.balance, disponible_luego_ahorro: (Math.round(summary.balance * 100) - Math.round(summary.ahorros * 100)) / 100 };
}
export function categoryShares(rows: StatsResponse["expenses_by_category"]) {
  const total = rows.reduce((sum, row) => sum + Math.round(row.total * 100), 0);
  return rows.map((row) => ({ ...row, percent: total > 0 ? Math.round(row.total * 100) / total * 100 : 0 }));
}
export function typeBars(totals: StatsResponse["month_totals"]) {
  const rows = [{ label: "Ingresos", value: totals.ingreso }, { label: "Gastos", value: totals.gasto },
    { label: "Ahorro", value: totals.ahorro ?? 0 }, { label: "Inversión", value: totals.inversion ?? 0 }];
  const max = Math.max(1, ...rows.map(r=>r.value));
  return rows.map(r=>({ ...r, percent: r.value / max * 100 }));
}
export type AnnualMonthRow = Omit<AnnualStatsResponse["monthly"][number], "balance"> & { movimientos: number };
export function buildAnnualStatistics(year: number, rows: AnnualMonthRow[], categories: AnnualStatsResponse["gastos_por_categoria"]): AnnualStatsResponse {
  const monthly = Array.from({ length: 12 }, (_, index) => {
    const row = rows.find((r) => r.mes === index + 1) ?? { mes: index + 1, ingresos: 0, gastos: 0, ahorros: 0, inversiones: 0 };
    return { mes: row.mes, ingresos: row.ingresos, gastos: row.gastos, ahorros: row.ahorros, inversiones: row.inversiones,
      balance: (Math.round(row.ingresos * 100) - Math.round(row.gastos * 100) - Math.round(row.ahorros * 100) - Math.round(row.inversiones * 100)) / 100 };
  });
  const sum = (key: "ingresos" | "gastos" | "ahorros" | "inversiones" | "balance") => monthly.reduce((total, r) => total + Math.round(r[key] * 100), 0) / 100;
  const totals = { ingresos: sum("ingresos"), gastos: sum("gastos"), ahorros: sum("ahorros"), inversiones: sum("inversiones"), balance: sum("balance"), movimientos: rows.reduce((total, r) => total + r.movimientos, 0) };
  // Desktop returns January for all-zero maxima, and the first month for ties.
  const max = (key: "ingresos" | "gastos") => monthly.reduce((winner, r) => r[key] > winner[key] ? r : winner);
  return { year, totals, monthly, gastos_por_categoria: categories, categoria_mayor_gasto: categories[0] ?? null,
    mes_mayor_ingreso: max("ingresos"), mes_mayor_gasto: max("gastos"),
    promedios_mensuales: { ingresos: totals.ingresos / 12, gastos: totals.gastos / 12, balance: totals.balance / 12 } };
}
