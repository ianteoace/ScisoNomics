import { api } from "../api";
import type { FinanceRepository } from "./financeRepositoryTypes";
import { calculateFinanceSummary } from "./financeSummary";

// Keep the existing HTTP, ownership and sync notifications in api.ts.
export const desktopFinanceRepository: FinanceRepository = {
  listCategorias: (tipo) => api.categorias(tipo),
  async createCategoria(input) { await api.createCategoria(input); },
  async updateCategoria(id, input) { await api.updateCategoria(id, input); },
  async deleteCategoria(id) { await api.deleteCategoria(id); },
  async listMovimientos({ month, year }) {
    return (await api.movimientos(month, year, "todos", "")).rows;
  },
  async createMovimiento(input) { await api.createMovimiento(input); },
  async updateMovimiento(id, input) { await api.updateMovimiento(id, input); },
  async deleteMovimiento(id) { await api.deleteMovimiento(id); },
  async getSummary({ month, year }) {
    const response = await api.movimientos(month, year, "todos", "");
    return calculateFinanceSummary(response.rows, response.summary.saldo_inicial);
  },
};
