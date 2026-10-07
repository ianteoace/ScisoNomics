import type { StatsResponse } from "../../types/domain";
import type { FinanceRepository, FinancePeriod, FinanceMonthlyReport, FinanceMonthTotals } from "./financeRepositoryTypes";
import { getMobileDatabase } from "./mobileDatabase";
import { LOCAL_OWNER, validatePeriod } from "./mobileRepositorySupport";
import { periodStart, periodEnd, sixMonthPeriods, monthTotals, buildAnnualStatistics, type AnnualMonthRow } from "./financeAnalytics";
import { calculateFinanceSummary } from "./financeSummary";

const active = "(m.deleted_at IS NULL OR m.deleted_at = '')";
const activeCategory = "(c.deleted_at IS NULL OR c.deleted_at = '')";
const sums = `COALESCE(SUM(CASE WHEN m.tipo='ingreso' THEN ROUND(m.monto*100) ELSE 0 END),0)/100.0 AS ingresos,
  COALESCE(SUM(CASE WHEN m.tipo='gasto' THEN ROUND(m.monto*100) ELSE 0 END),0)/100.0 AS gastos,
  COALESCE(SUM(CASE WHEN m.tipo='ahorro' THEN ROUND(m.monto*100) ELSE 0 END),0)/100.0 AS ahorros,
  COALESCE(SUM(CASE WHEN m.tipo='inversion' THEN ROUND(m.monto*100) ELSE 0 END),0)/100.0 AS inversiones`;
type PeriodRow = AnnualMonthRow & { anio: number };
async function aggregatedMonths(ownerId: string, start: string, end: string, isCurrent: () => boolean) {
  const db = await getMobileDatabase();
  if (!isCurrent()) throw new Error("La cuenta activa cambió.");
  return db.select<PeriodRow[]>(`SELECT CAST(substr(m.fecha,1,4) AS INTEGER) AS anio, CAST(substr(m.fecha,6,2) AS INTEGER) AS mes,
    ${sums}, COUNT(*) AS movimientos FROM movimientos m
    WHERE m.owner_user_id=$1 AND m.fecha >= $2 AND m.fecha < $3 AND ${active}
    GROUP BY substr(m.fecha,1,7) ORDER BY substr(m.fecha,1,7)`, [ownerId, start, end]);
}
async function categories(ownerId: string, start: string, end: string, annual: boolean, isCurrent: () => boolean) {
  const db = await getMobileDatabase();
  if (!isCurrent()) throw new Error("La cuenta activa cambió.");
  return db.select<StatsResponse["expenses_by_category"]>(`SELECT ${annual ? "" : "c.id AS categoria_id,"} c.nombre AS categoria,
    SUM(ROUND(m.monto*100))/100.0 AS total, COUNT(m.id) AS movimientos FROM movimientos m
    JOIN categorias c ON c.id=m.categoria_id AND c.owner_user_id=m.owner_user_id
    WHERE m.owner_user_id=$1 AND m.fecha >= $2 AND m.fecha < $3 AND m.tipo='gasto' AND ${active} AND ${activeCategory}
    GROUP BY ${annual ? "c.nombre" : "c.id,c.nombre"} HAVING total>0 ORDER BY total DESC`, [ownerId, start, end]);
}
const empty: FinanceMonthTotals = { ingreso: 0, gasto: 0, ahorro: 0, inversion: 0, balance: 0, disponible_luego_ahorro: 0 };
function totals(row?: PeriodRow): FinanceMonthTotals {
  if (!row) return { ...empty };
  return monthTotals(calculateFinanceSummary([
    { tipo: "ingreso", monto: row.ingresos }, { tipo: "gasto", monto: row.gastos },
    { tipo: "ahorro", monto: row.ahorros }, { tipo: "inversion", monto: row.inversiones },
  ]));
}

// Receiver is the complete repository, so existing financial rules stay shared.
export function createMobileAnalyticsRepository(ownerId = LOCAL_OWNER, isCurrent: () => boolean = () => true): Pick<FinanceRepository, "getStatistics" | "getMonthlyReport" | "getAnnualStatistics"> & ThisType<FinanceRepository> {
  return {
  async getStatistics(period) {
    validatePeriod(period);
    try {
      const [summary, planificacion, expenses_by_category, months] = await Promise.all([
        this.getSummary(period), this.getSchedulingSummary(period), categories(ownerId, periodStart(period), periodEnd(period), false, isCurrent),
        aggregatedMonths(ownerId, periodStart({ year: period.year, month: 1 }), periodEnd({ year: period.year, month: 12 }), isCurrent),
      ]);
      return { summary: { saldo_inicial: summary.saldoInicial, ingreso: summary.ingresos, gasto: summary.gastos, ahorro: summary.ahorros,
        balance_final: (Math.round(summary.saldoInicial*100)+Math.round(summary.balance*100))/100,
        balance: summary.balance, disponible_luego_ahorro: monthTotals(summary).disponible_luego_ahorro },
        month_totals: monthTotals(summary), expenses_by_category, planificacion,
        trend: Array.from({ length: 12 }, (_, i) => ({ mes: i+1, ingresos: months.find(r=>r.mes===i+1)?.ingresos ?? 0, gastos: months.find(r=>r.mes===i+1)?.gastos ?? 0 })) };
    } catch { throw new Error("No se pudieron cargar las estadísticas. Podés reintentar."); }
  },
  async getMonthlyReport(period) {
    validatePeriod(period); const db = await getMobileDatabase();
    if (!isCurrent()) throw new Error("La cuenta activa cambió.");
    const start=periodStart(period), end=periodEnd(period), periods=sixMonthPeriods(period);
    try {
      const [summary, byCategory, top, months, budgets, goals, investment] = await Promise.all([
        this.getSummary(period), categories(ownerId,start,end,false,isCurrent),
        db.select<FinanceMonthlyReport["top_movimientos"]>(`SELECT m.id,m.fecha,m.descripcion,m.monto,c.nombre AS categoria FROM movimientos m
          JOIN categorias c ON c.id=m.categoria_id AND c.owner_user_id=m.owner_user_id
          WHERE m.owner_user_id=$1 AND m.fecha >= $2 AND m.fecha < $3 AND m.tipo='gasto' AND ${active}
          ORDER BY m.monto DESC,m.fecha DESC LIMIT 5`,[ownerId,start,end]),
        aggregatedMonths(ownerId, periodStart(periods[0]),end,isCurrent), this.listPresupuestos(period), this.listMetas(),
        db.select<{ total: number }[]>(`SELECT COALESCE(SUM(ROUND(m.monto*100)),0)/100.0 AS total FROM movimientos m
          JOIN categorias c ON c.id=m.categoria_id AND c.owner_user_id=m.owner_user_id
          WHERE m.owner_user_id=$1 AND m.fecha >= $2 AND m.fecha < $3 AND lower(c.nombre) LIKE '%invers%' AND ${active} AND ${activeCategory}`,[ownerId,start,end]),
      ]);
      return { month: period.month, year: period.year, ingresos: summary.ingresos, gastos: summary.gastos, ahorro: summary.ahorros,
        inversiones: investment[0].total, balance_operativo: summary.balance, disponible_luego_ahorro: monthTotals(summary).disponible_luego_ahorro,
        top_categorias: byCategory.slice(0,5), top_movimientos: top,
        evolucion_ultimos_6_meses: periods.map(p=>({ mes:p.month, anio:p.year, ...totals(months.find(r=>r.mes===p.month && r.anio===p.year)) })),
        presupuestos_excedidos: budgets.filter(b=>b.excedido), metas: goals.filter(g=>g.estado==='activa') };
    } catch { throw new Error("No se pudo cargar el reporte mensual. Podés reintentar."); }
  },
  async getAnnualStatistics(year) {
    validatePeriod({ year, month: 1 });
    try {
      const start=periodStart({year,month:1}), end=periodEnd({year,month:12});
      const [rows, byCategory] = await Promise.all([aggregatedMonths(ownerId,start,end,isCurrent),categories(ownerId,start,end,true,isCurrent)]);
      return buildAnnualStatistics(year,rows,byCategory);
    } catch { throw new Error("No se pudo cargar el reporte anual. Podés reintentar."); }
  },
  };
}

export const mobileAnalyticsRepository = createMobileAnalyticsRepository();
