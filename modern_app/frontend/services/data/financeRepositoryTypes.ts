import type { Categoria, Movimiento, MoveType, GastoFijo, Presupuesto, MetaAhorro, GastoProgramado, StatsResponse, AnnualStatsResponse } from "../../types/domain";
import type { FinanceSummary } from "./financeSummary";

export type FinancePeriod = { month: number; year: number };
export type CreateCategoria = { nombre: string; tipo: MoveType };
export type CreateMovimiento = {
  fecha: string;
  tipo: MoveType;
  categoria_id: number;
  descripcion: string;
  monto: number;
  nota?: string;
  meta_id?: number | null;
};

export type FinanceMovimiento = Movimiento & { categoria_id?: number };

export type CreateGastoFijo = Pick<GastoFijo, "categoria_id" | "descripcion" | "monto" | "dia_vencimiento" | "activo">;
export type CreatePresupuesto = { categoria_id: number; mes: number; anio: number; monto: number };
export type CreateMeta = Pick<MetaAhorro, "nombre" | "monto_objetivo" | "monto_inicial" | "estado"> & { fecha_objetivo: string | null; descripcion: string };
export type CreateGastoProgramado = Omit<GastoProgramado, "id" | "categoria">;
export type SchedulingSummary = StatsResponse["planificacion"];
export type FinanceCalendarDay = { fecha: string; movimientos: Pick<FinanceMovimiento, "id" | "fecha" | "tipo" | "categoria" | "descripcion" | "monto" | "nota">[]; totales: Record<MoveType, number> };
export type MarkScheduledPaidResult = { changed: boolean; generated_next?: boolean; is_recurrent?: boolean };
export type FinanceMonthTotals = Required<StatsResponse["month_totals"]>;
export type FinanceMonthlyReport = {
  month: number; year: number; ingresos: number; gastos: number; ahorro: number; inversiones: number;
  balance_operativo: number; disponible_luego_ahorro: number;
  top_categorias: StatsResponse["expenses_by_category"];
  top_movimientos: Pick<FinanceMovimiento, "id" | "fecha" | "descripcion" | "monto" | "categoria">[];
  evolucion_ultimos_6_meses: (FinanceMonthTotals & { mes: number; anio: number })[];
  presupuestos_excedidos: Presupuesto[]; metas: MetaAhorro[];
};

export interface FinanceRepository {
  getStatistics(period: FinancePeriod): Promise<StatsResponse>;
  getMonthlyReport(period: FinancePeriod): Promise<FinanceMonthlyReport>;
  getAnnualStatistics(year: number): Promise<AnnualStatsResponse>;
  listGastosProgramados(state?: GastoProgramado["estado"] | "todos", days?: number): Promise<GastoProgramado[]>;
  createGastoProgramado(input: CreateGastoProgramado): Promise<void>;
  updateGastoProgramado(id: number, input: CreateGastoProgramado): Promise<void>;
  deleteGastoProgramado(id: number): Promise<void>;
  markGastoProgramadoPaid(id: number): Promise<MarkScheduledPaidResult>;
  getSchedulingSummary(period: FinancePeriod): Promise<SchedulingSummary>;
  getCalendar(period: FinancePeriod): Promise<FinanceCalendarDay[]>;
  listCategorias(tipo?: MoveType): Promise<Categoria[]>;
  createCategoria(input: CreateCategoria): Promise<void>;
  updateCategoria(id: number, input: CreateCategoria): Promise<void>;
  deleteCategoria(id: number): Promise<void>;
  listMovimientos(period: FinancePeriod): Promise<FinanceMovimiento[]>;
  createMovimiento(input: CreateMovimiento): Promise<void>;
  updateMovimiento(id: number, input: CreateMovimiento): Promise<void>;
  deleteMovimiento(id: number): Promise<void>;
  getSummary(period: FinancePeriod): Promise<FinanceSummary>;
  listGastosFijos(): Promise<GastoFijo[]>;
  createGastoFijo(input: CreateGastoFijo): Promise<void>;
  updateGastoFijo(id: number, input: CreateGastoFijo): Promise<void>;
  deleteGastoFijo(id: number): Promise<void>;
  listPresupuestos(period: FinancePeriod): Promise<Presupuesto[]>;
  createPresupuesto(input: CreatePresupuesto): Promise<void>;
  updatePresupuesto(id: number, input: CreatePresupuesto): Promise<void>;
  deletePresupuesto(id: number): Promise<void>;
  listMetas(): Promise<MetaAhorro[]>;
  createMeta(input: CreateMeta): Promise<void>;
  updateMeta(id: number, input: CreateMeta): Promise<void>;
  deleteMeta(id: number): Promise<void>;
}
