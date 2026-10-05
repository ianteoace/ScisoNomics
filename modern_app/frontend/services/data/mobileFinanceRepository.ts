import type { Categoria, Movimiento, MoveType } from "../../types/domain";
import type { CreateCategoria, CreateMovimiento, FinancePeriod, FinanceRepository, FinanceMovimiento } from "./financeRepositoryTypes";
import { getMobileDatabase } from "./mobileDatabase";
import { calculateFinanceSummary } from "./financeSummary";

import { LOCAL_OWNER, boundedText, validateDate, validateAmount, validatePeriod, validateId, newSyncId, write, requireChanged } from "./mobileRepositorySupport";
import { mobilePlanningRepository } from "./mobilePlanningRepository";
import { mobileSchedulingRepository } from "./mobileSchedulingRepository";
import { groupCalendarMovements } from "./financeCalendar";
import { mobileAnalyticsRepository } from "./mobileAnalyticsRepository";
const moveTypes: readonly string[] = ["ingreso", "gasto", "ahorro", "inversion"];
function validateType(tipo: string): asserts tipo is MoveType {
  if (!moveTypes.includes(tipo)) throw new Error("Elegí un tipo de movimiento válido.");
}
export function validateCategoria(input: CreateCategoria): CreateCategoria {
  validateType(input.tipo);
  const nombre = boundedText(input.nombre, 120, "El nombre");
  if (!nombre) throw new Error("El nombre de la categoría es obligatorio.");
  return { nombre, tipo: input.tipo };
}
export function validateMovimiento(input: CreateMovimiento): CreateMovimiento {
  validateType(input.tipo);
  validateDate(input.fecha);
  validateAmount(input.monto);
  if (input.meta_id != null) validateId(input.meta_id);
  if (!Number.isSafeInteger(input.categoria_id) || input.categoria_id <= 0) {
    throw new Error("Elegí una categoría existente.");
  }
  return { ...input, descripcion: boundedText(input.descripcion, 500, "La descripción"), nota: boundedText(input.nota ?? "", 4000, "La nota") };
}
export function mapCategoria(row: Categoria): Categoria {
  return { id: Number(row.id), nombre: row.nombre, tipo: row.tipo };
}
type MovimientoRow = Omit<Movimiento, "descripcion"> & { descripcion: string | null; categoria_id: number };
export function mapMovimiento(row: MovimientoRow): FinanceMovimiento {
  return {
    id: Number(row.id), fecha: row.fecha, tipo: row.tipo, categoria: row.categoria,
    descripcion: row.descripcion ?? "", monto: Number(row.monto), saldo_acumulado: Number(row.saldo_acumulado),
    meta_id: row.meta_id ?? null, nota: row.nota ?? "", categoria_id: Number(row.categoria_id),
  };
}
export const mobileFinanceRepository: FinanceRepository = {
  ...mobileAnalyticsRepository,
  ...mobilePlanningRepository,
  ...mobileSchedulingRepository,
  async getCalendar(period) { return groupCalendarMovements(await this.listMovimientos(period)); },
  async listCategorias(tipo) {
    if (tipo !== undefined) validateType(tipo);
    const database = await getMobileDatabase();
    try {
      const rows = await database.select<Categoria[]>(
        `SELECT id, nombre, tipo FROM categorias
         WHERE owner_user_id = $1 AND (deleted_at IS NULL OR deleted_at = '')
           AND ($2 IS NULL OR tipo = $2) ORDER BY tipo, nombre`, [LOCAL_OWNER, tipo ?? null],
      );
      return rows.map(mapCategoria);
    } catch { throw new Error("No se pudieron cargar las categorías."); }
  },
  async createCategoria(input) {
    const { nombre, tipo } = validateCategoria(input);
    const database = await getMobileDatabase();
    const existing = await database.select<{ id: number }[]>(
      "SELECT id FROM categorias WHERE owner_user_id = $1 AND nombre = $2 AND tipo = $3", [LOCAL_OWNER, nombre, tipo],
    ).catch(() => { throw new Error("No se pudo comprobar la categoría."); });
    if (existing.length) throw new Error("Ya existe una categoría con ese nombre y tipo.");
    await write(
      "INSERT INTO categorias (nombre, tipo, owner_user_id, sync_id) VALUES ($1, $2, $3, $4)",
      [nombre, tipo, LOCAL_OWNER, newSyncId()], "No se pudo guardar la categoría. Revisá si ya existe y reintentá.",
    );
  },
  async listMovimientos(period) {
    validatePeriod(period);
    const database = await getMobileDatabase();
    const start = `${String(period.year).padStart(4, "0")}-${String(period.month).padStart(2, "0")}-01`;
    try {
      const rows = await database.select<MovimientoRow[]>(
        `WITH active AS (
           SELECT m.id, m.fecha, m.tipo, m.categoria_id, c.nombre AS categoria, m.descripcion, m.monto, m.nota, m.meta_id,
             SUM(CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE -m.monto END)
               OVER (ORDER BY m.fecha, m.id ROWS UNBOUNDED PRECEDING) AS saldo_acumulado
           FROM movimientos m JOIN categorias c ON c.id = m.categoria_id AND c.owner_user_id = m.owner_user_id
           WHERE m.owner_user_id = $1 AND (m.deleted_at IS NULL OR m.deleted_at = '')
         ) SELECT * FROM active WHERE fecha >= $2 AND fecha < date($2, '+1 month') ORDER BY fecha DESC, id DESC`,
        [LOCAL_OWNER, start],
      );
      return rows.map(mapMovimiento);
    } catch { throw new Error("No se pudieron cargar los movimientos."); }
  },
  async createMovimiento(input) {
    const clean = validateMovimiento(input);
    const database = await getMobileDatabase();
    const categories = await database.select<{ id: number }[]>(
      "SELECT id FROM categorias WHERE id = $1 AND owner_user_id = $2 AND (deleted_at IS NULL OR deleted_at = '')",
      [clean.categoria_id, LOCAL_OWNER],
    ).catch(() => { throw new Error("No se pudo comprobar la categoría."); });
    if (!categories.length) throw new Error("La categoría seleccionada no existe o no está disponible.");
    await requireChanged(
      `INSERT INTO movimientos (fecha, tipo, categoria_id, descripcion, monto, nota, owner_user_id, sync_id, meta_id)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9 FROM categorias
       WHERE id = $3 AND owner_user_id = $7 AND (deleted_at IS NULL OR deleted_at = '')
       AND ($9 IS NULL OR EXISTS (SELECT 1 FROM metas_ahorro WHERE id = $9 AND owner_user_id = $7 AND (deleted_at IS NULL OR deleted_at = '')))`,
      [clean.fecha, clean.tipo, clean.categoria_id, clean.descripcion, clean.monto, clean.nota, LOCAL_OWNER, newSyncId(), clean.meta_id ?? null],
      "No se pudo guardar el movimiento. Revisá la categoría y reintentá.",
    );
  },
  async updateMovimiento(id, input) {
    validateId(id);
    const clean = validateMovimiento(input);
    await requireChanged(
      `UPDATE movimientos SET fecha = $1, tipo = $2, categoria_id = $3, descripcion = $4, monto = $5, nota = $6, meta_id = $9,
        updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
       WHERE id = $7 AND owner_user_id = $8 AND (deleted_at IS NULL OR deleted_at = '')
       AND EXISTS (SELECT 1 FROM categorias WHERE id = $3 AND owner_user_id = $8 AND (deleted_at IS NULL OR deleted_at = ''))
       AND ($9 IS NULL OR EXISTS (SELECT 1 FROM metas_ahorro WHERE id = $9 AND owner_user_id = $8 AND (deleted_at IS NULL OR deleted_at = '')))`,
      [clean.fecha, clean.tipo, clean.categoria_id, clean.descripcion, clean.monto, clean.nota, id, LOCAL_OWNER, clean.meta_id ?? null],
      "No se pudo actualizar el movimiento. Revisá que el movimiento y la categoría sigan disponibles.",
    );
  },
  async deleteMovimiento(id) {
    validateId(id);
    await requireChanged(
      `UPDATE movimientos SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
       WHERE id = $1 AND owner_user_id = $2 AND (deleted_at IS NULL OR deleted_at = '')`,
      [id, LOCAL_OWNER], "No se pudo eliminar el movimiento. Puede que ya no esté disponible.",
    );
  },
  async updateCategoria(id, input) {
    validateId(id);
    const clean = validateCategoria(input);
    await requireChanged(
      `UPDATE categorias SET nombre = $1, tipo = $2, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
       WHERE id = $3 AND owner_user_id = $4 AND (deleted_at IS NULL OR deleted_at = '')`,
      [clean.nombre, clean.tipo, id, LOCAL_OWNER], "No se pudo actualizar la categoría. Revisá si ya existe ese nombre y tipo.",
    );
  },
  async deleteCategoria(id) {
    validateId(id);
    const result = await write(
      `UPDATE categorias SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
       WHERE id = $1 AND owner_user_id = $2 AND (deleted_at IS NULL OR deleted_at = '')
       AND NOT EXISTS (SELECT 1 FROM movimientos WHERE categoria_id = $1 AND owner_user_id = $2 AND (deleted_at IS NULL OR deleted_at = ''))`,
      [id, LOCAL_OWNER], "No se pudo eliminar la categoría.",
    );
    if (result.rowsAffected !== 1) throw new Error("No se pudo eliminar la categoría: tiene movimientos asociados o ya no está disponible.");
  },
  async getSummary(period) {
    validatePeriod(period);
    const database = await getMobileDatabase();
    const start = `${String(period.year).padStart(4, "0")}-${String(period.month).padStart(2, "0")}-01`;
    try {
      const rows = await database.select<{ tipo: MoveType; cents: number; opening: number }[]>(
        `SELECT tipo,
          SUM(CASE WHEN fecha >= $2 THEN ROUND(monto * 100) ELSE 0 END) AS cents,
          SUM(CASE WHEN fecha < $2 THEN (CASE WHEN tipo = 'ingreso' THEN 1 ELSE -1 END) * ROUND(monto * 100) ELSE 0 END) AS opening
         FROM movimientos WHERE owner_user_id = $1 AND (deleted_at IS NULL OR deleted_at = '')
          AND fecha < date($2, '+1 month') GROUP BY tipo`, [LOCAL_OWNER, start],
      );
      return calculateFinanceSummary(rows.map((row) => ({ tipo: row.tipo, monto: Number(row.cents) / 100 })),
        rows.reduce((sum, row) => sum + Number(row.opening), 0) / 100);
    } catch { throw new Error("No se pudo cargar el resumen del mes."); }
  },
};
