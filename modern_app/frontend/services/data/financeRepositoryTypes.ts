import type { Categoria, Movimiento, MoveType, GastoFijo, Presupuesto, MetaAhorro } from "../../types/domain";
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

export interface FinanceRepository {
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
