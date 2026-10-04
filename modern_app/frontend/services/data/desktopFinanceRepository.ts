import { api } from "../api";
import type { FinanceRepository } from "./financeRepositoryTypes";
import { calculateFinanceSummary } from "./financeSummary";

// Keep the existing HTTP, ownership and sync notifications in api.ts.
export const desktopFinanceRepository: FinanceRepository = {
  listGastosFijos: () => api.gastosFijos(),
  async createGastoFijo(input) { await api.createGastoFijo(input); },
  async updateGastoFijo(id, input) { await api.updateGastoFijo(id, input); },
  async deleteGastoFijo(id) { await api.deleteGastoFijo(id); },
  listPresupuestos: ({ month, year }) => api.presupuestos(month, year),
  async createPresupuesto(input) { await api.upsertPresupuesto(input); },
  // Existing desktop API addresses budgets by category/period, not by id.
  async updatePresupuesto(_id, input) { await api.upsertPresupuesto(input); },
  async deletePresupuesto(id) { await api.deletePresupuesto(id); },
  listMetas: () => api.metas(),
  async createMeta(input) { await api.createMeta(input); },
  async updateMeta(id, input) { await api.updateMeta(id, input); },
  async deleteMeta(id) { await api.deleteMeta(id); },
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
