import type { GastoFijo, MetaAhorro, Presupuesto } from "../../types/domain";
import type { CreateGastoFijo, CreateMeta, CreatePresupuesto, FinanceRepository } from "./financeRepositoryTypes";
import { getMobileDatabase } from "./mobileDatabase";
import { LOCAL_OWNER, boundedText, newSyncId, requireChanged, validateAmount, validateDate, validateId, validatePeriod } from "./mobileRepositorySupport";

export function validateGastoFijo(input: CreateGastoFijo): CreateGastoFijo {
  validateId(input.categoria_id); validateAmount(input.monto);
  const descripcion = boundedText(input.descripcion, 500, "La descripción");
  if (!descripcion) throw new Error("La descripción es obligatoria.");
  if (!Number.isInteger(input.dia_vencimiento) || input.dia_vencimiento < 1 || input.dia_vencimiento > 31) throw new Error("El día de vencimiento debe estar entre 1 y 31.");
  if (input.activo !== 0 && input.activo !== 1) throw new Error("Elegí un estado activo o inactivo.");
  return { ...input, descripcion };
}
export function validatePresupuesto(input: CreatePresupuesto): CreatePresupuesto {
  validateId(input.categoria_id); validateAmount(input.monto); validatePeriod({ month: input.mes, year: input.anio });
  return input;
}
export function validateMeta(input: CreateMeta): CreateMeta {
  const nombre = boundedText(input.nombre, 160, "El nombre");
  if (!nombre) throw new Error("El nombre de la meta es obligatorio.");
  validateAmount(input.monto_objetivo); validateAmount(input.monto_inicial, true);
  if (!["activa", "pausada", "completada"].includes(input.estado)) throw new Error("Elegí un estado válido.");
  const fecha_objetivo = input.fecha_objetivo || null;
  if (fecha_objetivo) validateDate(fecha_objetivo);
  return { ...input, nombre, fecha_objetivo, descripcion: boundedText(input.descripcion, 2000, "La descripción") };
}
type PlanningMethods = Pick<FinanceRepository,
  "listGastosFijos" | "createGastoFijo" | "updateGastoFijo" | "deleteGastoFijo" |
  "listPresupuestos" | "createPresupuesto" | "updatePresupuesto" | "deletePresupuesto" |
  "listMetas" | "createMeta" | "updateMeta" | "deleteMeta">;

export const mobilePlanningRepository: PlanningMethods = {
  async listGastosFijos() {
    const db = await getMobileDatabase();
    try { return await db.select<GastoFijo[]>(`SELECT g.id, g.categoria_id, c.nombre AS categoria, g.descripcion, g.monto, g.dia_vencimiento, g.activo
      FROM gastos_fijos g JOIN categorias c ON c.id = g.categoria_id AND c.owner_user_id = g.owner_user_id
      WHERE g.owner_user_id = $1 AND (g.deleted_at IS NULL OR g.deleted_at = '') ORDER BY g.activo DESC, g.dia_vencimiento, g.id`, [LOCAL_OWNER]); }
    catch { throw new Error("No se pudieron cargar los gastos fijos."); }
  },
  async createGastoFijo(input) {
    const c = validateGastoFijo(input);
    await requireChanged(`INSERT INTO gastos_fijos (categoria_id, descripcion, monto, dia_vencimiento, activo, owner_user_id, sync_id)
      SELECT $1, $2, $3, $4, $5, $6, $7 FROM categorias WHERE id = $1 AND owner_user_id = $6 AND (deleted_at IS NULL OR deleted_at = '')`,
    [c.categoria_id, c.descripcion, c.monto, c.dia_vencimiento, c.activo, LOCAL_OWNER, newSyncId()], "No se pudo guardar el gasto fijo. Revisá la categoría.");
  },
  async updateGastoFijo(id, input) {
    validateId(id); const c = validateGastoFijo(input);
    await requireChanged(`UPDATE gastos_fijos SET categoria_id = $1, descripcion = $2, monto = $3, dia_vencimiento = $4, activo = $5,
      updated_at = CURRENT_TIMESTAMP, sync_status = 'pending' WHERE id = $6 AND owner_user_id = $7 AND (deleted_at IS NULL OR deleted_at = '')
      AND EXISTS (SELECT 1 FROM categorias WHERE id = $1 AND owner_user_id = $7 AND (deleted_at IS NULL OR deleted_at = ''))`,
    [c.categoria_id, c.descripcion, c.monto, c.dia_vencimiento, c.activo, id, LOCAL_OWNER], "No se pudo actualizar el gasto fijo. Revisá la categoría.");
  },
  async deleteGastoFijo(id) {
    validateId(id);
    await requireChanged(`UPDATE gastos_fijos SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
      WHERE id = $1 AND owner_user_id = $2 AND (deleted_at IS NULL OR deleted_at = '')`, [id, LOCAL_OWNER], "No se pudo eliminar el gasto fijo.");
  },
  async listPresupuestos(period) {
    validatePeriod(period); const db = await getMobileDatabase();
    try {
      const rows = await db.select<Omit<Presupuesto, "monto_disponible" | "porcentaje_usado" | "excedido">[]>(`SELECT p.id, p.categoria_id, c.nombre AS categoria, p.mes, p.anio, p.monto AS monto_presupuestado,
        COALESCE(SUM(ROUND(m.monto * 100)), 0) / 100.0 AS monto_gastado FROM presupuestos p
        JOIN categorias c ON c.id = p.categoria_id AND c.owner_user_id = p.owner_user_id
        LEFT JOIN movimientos m ON m.categoria_id = p.categoria_id AND m.owner_user_id = p.owner_user_id AND m.tipo = 'gasto'
          AND CAST(strftime('%m', m.fecha) AS INTEGER) = p.mes AND CAST(strftime('%Y', m.fecha) AS INTEGER) = p.anio
          AND (m.deleted_at IS NULL OR m.deleted_at = '')
        WHERE p.owner_user_id = $1 AND p.mes = $2 AND p.anio = $3 AND (p.deleted_at IS NULL OR p.deleted_at = '')
          AND (c.deleted_at IS NULL OR c.deleted_at = '') GROUP BY p.id ORDER BY c.nombre`, [LOCAL_OWNER, period.month, period.year]);
      return rows.map((r) => ({ ...r, monto_disponible: (Math.round(r.monto_presupuestado * 100) - Math.round(r.monto_gastado * 100)) / 100,
        porcentaje_usado: r.monto_gastado / r.monto_presupuestado * 100, excedido: r.monto_gastado > r.monto_presupuestado }));
    } catch { throw new Error("No se pudieron cargar los presupuestos."); }
  },
  async createPresupuesto(input) {
    const c = validatePresupuesto(input);
    await requireChanged(`INSERT INTO presupuestos (categoria_id, mes, anio, monto, owner_user_id, sync_id)
      SELECT $1, $2, $3, $4, $5, $6 FROM categorias WHERE id = $1 AND owner_user_id = $5 AND (deleted_at IS NULL OR deleted_at = '')
      ON CONFLICT(owner_user_id, categoria_id, mes, anio) DO UPDATE SET monto = excluded.monto, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'`,
    [c.categoria_id, c.mes, c.anio, c.monto, LOCAL_OWNER, newSyncId()], "No se pudo guardar el presupuesto. Revisá la categoría.");
  },
  async updatePresupuesto(id, input) {
    validateId(id); const c = validatePresupuesto(input);
    // Editing a limit keeps the natural key and identity; another period is a new budget.
    await requireChanged(`UPDATE presupuestos SET monto = $1, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
      WHERE id = $2 AND owner_user_id = $3 AND categoria_id = $4 AND mes = $5 AND anio = $6 AND (deleted_at IS NULL OR deleted_at = '')
      AND EXISTS (SELECT 1 FROM categorias WHERE id = $4 AND owner_user_id = $3 AND (deleted_at IS NULL OR deleted_at = ''))`,
    [c.monto, id, LOCAL_OWNER, c.categoria_id, c.mes, c.anio], "No se pudo actualizar el límite. Conservá la categoría y el período del presupuesto.");
  },
  async deletePresupuesto(id) {
    validateId(id);
    await requireChanged(`UPDATE presupuestos SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
      WHERE id = $1 AND owner_user_id = $2 AND (deleted_at IS NULL OR deleted_at = '')`, [id, LOCAL_OWNER], "No se pudo eliminar el presupuesto.");
  },
  async listMetas() {
    const db = await getMobileDatabase();
    try {
      const rows = await db.select<Omit<MetaAhorro, "faltante" | "porcentaje_completado">[]>(`SELECT g.id, g.nombre, g.monto_objetivo, g.monto_inicial, g.fecha_objetivo, g.descripcion, g.estado,
        (ROUND(g.monto_inicial * 100) + COALESCE(SUM(ROUND(m.monto * 100)), 0)) / 100.0 AS monto_ahorrado
        FROM metas_ahorro g LEFT JOIN movimientos m ON m.meta_id = g.id AND m.owner_user_id = g.owner_user_id AND m.tipo = 'ahorro' AND (m.deleted_at IS NULL OR m.deleted_at = '')
        WHERE g.owner_user_id = $1 AND (g.deleted_at IS NULL OR g.deleted_at = '') GROUP BY g.id ORDER BY g.created_at DESC, g.id DESC`, [LOCAL_OWNER]);
      return rows.map((r) => ({ ...r, faltante: Math.max(0, (Math.round(r.monto_objetivo * 100) - Math.round(r.monto_ahorrado * 100)) / 100), porcentaje_completado: r.monto_ahorrado / r.monto_objetivo * 100 }));
    } catch { throw new Error("No se pudieron cargar las metas."); }
  },
  async createMeta(input) {
    const c = validateMeta(input);
    await requireChanged(`INSERT INTO metas_ahorro (nombre, monto_objetivo, monto_inicial, fecha_objetivo, descripcion, estado, owner_user_id, sync_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [c.nombre, c.monto_objetivo, c.monto_inicial, c.fecha_objetivo, c.descripcion, c.estado, LOCAL_OWNER, newSyncId()], "No se pudo guardar la meta.");
  },
  async updateMeta(id, input) {
    validateId(id); const c = validateMeta(input);
    await requireChanged(`UPDATE metas_ahorro SET nombre = $1, monto_objetivo = $2, monto_inicial = $3, fecha_objetivo = $4, descripcion = $5, estado = $6,
      updated_at = CURRENT_TIMESTAMP, sync_status = 'pending' WHERE id = $7 AND owner_user_id = $8 AND (deleted_at IS NULL OR deleted_at = '')`,
    [c.nombre, c.monto_objetivo, c.monto_inicial, c.fecha_objetivo, c.descripcion, c.estado, id, LOCAL_OWNER], "No se pudo actualizar la meta.");
  },
  async deleteMeta(id) {
    validateId(id);
    await requireChanged(`UPDATE metas_ahorro SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
      WHERE id = $1 AND owner_user_id = $2 AND (deleted_at IS NULL OR deleted_at = '')`, [id, LOCAL_OWNER], "No se pudo eliminar la meta.");
  },
};
