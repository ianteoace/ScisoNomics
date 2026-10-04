import type { Categoria, Movimiento, MoveType } from "../../types/domain";

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

// The first shared contract deliberately covers only these four operations.
export interface FinanceRepository {
  listCategorias(tipo?: MoveType): Promise<Categoria[]>;
  createCategoria(input: CreateCategoria): Promise<void>;
  listMovimientos(period: FinancePeriod): Promise<Movimiento[]>;
  createMovimiento(input: CreateMovimiento): Promise<void>;
}
