import { api } from "../api";
import type { FinanceRepository } from "./financeRepositoryTypes";

// Keep the existing HTTP, ownership and sync notifications in api.ts.
export const desktopFinanceRepository: FinanceRepository = {
  listCategorias: (tipo) => api.categorias(tipo),
  async createCategoria(input) { await api.createCategoria(input); },
  async listMovimientos({ month, year }) {
    return (await api.movimientos(month, year, "todos", "")).rows;
  },
  async createMovimiento(input) { await api.createMovimiento(input); },
};
