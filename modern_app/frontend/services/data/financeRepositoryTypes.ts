import type { Categoria, Movimiento, MoveType } from "../../types/domain";
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
};

export type FinanceMovimiento = Movimiento & { categoria_id?: number };

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
}
