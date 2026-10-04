import type { GastoProgramado } from "../../types/domain";
import type { CreateGastoProgramado, FinanceRepository, SchedulingSummary } from "./financeRepositoryTypes";
import { getLocalDateInputValue } from "../../lib/date";
import { getMobileDatabase } from "./mobileDatabase";
import { LOCAL_OWNER, boundedText, newSyncId, requireChanged, validateAmount, validateDate, validateId, validatePeriod } from "./mobileRepositorySupport";

export function validateGastoProgramado(input: CreateGastoProgramado): CreateGastoProgramado {
  const descripcion = boundedText(input.descripcion, 500, "La descripción");
  if (!descripcion) throw new Error("La descripción es obligatoria.");
  validateId(input.categoria_id); validateAmount(input.monto_estimado); validateDate(input.fecha_vencimiento);
  if (!["pendiente", "pagado", "cancelado"].includes(input.estado)) throw new Error("Elegí un estado válido.");
  if (input.es_recurrente !== 0 && input.es_recurrente !== 1) throw new Error("Elegí si el gasto es recurrente.");
  if (input.es_recurrente && !["mensual", "semanal", "anual"].includes(input.frecuencia ?? "")) throw new Error("Elegí una frecuencia válida.");
  return { ...input, descripcion, frecuencia: input.es_recurrente ? input.frecuencia : null };
}
const active = "(deleted_at IS NULL OR deleted_at = '')";
const activeCategory = `EXISTS (SELECT 1 FROM categorias c WHERE c.id = gp.categoria_id AND c.owner_user_id = gp.owner_user_id AND (c.deleted_at IS NULL OR c.deleted_at = ''))`;
const due = `CASE frecuencia WHEN 'semanal' THEN date(fecha_vencimiento, '+7 days')
  WHEN 'mensual' THEN strftime('%Y-%m-', date(fecha_vencimiento, 'start of month', '+1 month')) || printf('%02d',
    min(CAST(strftime('%d',fecha_vencimiento) AS INTEGER), CAST(strftime('%d',date(fecha_vencimiento,'start of month','+2 months','-1 day')) AS INTEGER)))
  WHEN 'anual' THEN strftime('%Y-%m-', date(fecha_vencimiento, 'start of month', '+12 months')) || printf('%02d',
    min(CAST(strftime('%d',fecha_vencimiento) AS INTEGER), CAST(strftime('%d',date(fecha_vencimiento,'start of month','+13 months','-1 day')) AS INTEGER))) END`;

type Methods = Pick<FinanceRepository, "listGastosProgramados" | "createGastoProgramado" | "updateGastoProgramado" | "deleteGastoProgramado" | "markGastoProgramadoPaid" | "getSchedulingSummary">;
export const mobileSchedulingRepository: Methods = {
  async listGastosProgramados(state = "todos", days) {
    if (!["todos", "pendiente", "pagado", "cancelado"].includes(state)) throw new Error("Elegí un estado válido.");
    if (days !== undefined && (!Number.isSafeInteger(days) || days <= 0)) throw new Error("Elegí una ventana de días válida.");
    const db = await getMobileDatabase();
    try { return await db.select<GastoProgramado[]>(`SELECT gp.id,gp.descripcion,gp.categoria_id,c.nombre AS categoria,gp.monto_estimado,
      gp.fecha_vencimiento,gp.estado,gp.es_recurrente,gp.frecuencia FROM gastos_programados gp
      JOIN categorias c ON c.id = gp.categoria_id AND c.owner_user_id = gp.owner_user_id
      WHERE gp.owner_user_id = $1 AND (gp.deleted_at IS NULL OR gp.deleted_at = '')
      AND ($2 = 'todos' OR gp.estado = $2) AND ($3 IS NULL OR gp.fecha_vencimiento BETWEEN $4 AND date($4,'+' || $3 || ' days'))
      ORDER BY gp.fecha_vencimiento ASC,gp.id DESC`, [LOCAL_OWNER, state, days ?? null, getLocalDateInputValue()]); }
    catch { throw new Error("No se pudo cargar la planificación."); }
  },
  async createGastoProgramado(input) {
    const c = validateGastoProgramado(input);
    await requireChanged(`INSERT INTO gastos_programados(descripcion,categoria_id,monto_estimado,fecha_vencimiento,estado,es_recurrente,frecuencia,owner_user_id,sync_id)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 FROM categorias WHERE id=$2 AND owner_user_id=$8 AND ${active}`,
      [c.descripcion,c.categoria_id,c.monto_estimado,c.fecha_vencimiento,c.estado,c.es_recurrente,c.frecuencia,LOCAL_OWNER,newSyncId()], "No se pudo guardar la planificación. Revisá la categoría.");
  },
  async updateGastoProgramado(id, input) {
    validateId(id); const c = validateGastoProgramado(input);
    await requireChanged(`UPDATE gastos_programados SET descripcion=$1,categoria_id=$2,monto_estimado=$3,fecha_vencimiento=$4,
      estado=$5,es_recurrente=$6,frecuencia=$7,updated_at=CURRENT_TIMESTAMP,sync_status='pending'
      WHERE id=$8 AND owner_user_id=$9 AND ${active}
      AND EXISTS (SELECT 1 FROM categorias WHERE id=$2 AND owner_user_id=$9 AND ${active})`,
      [c.descripcion,c.categoria_id,c.monto_estimado,c.fecha_vencimiento,c.estado,c.es_recurrente,c.frecuencia,id,LOCAL_OWNER], "No se pudo actualizar la planificación. Revisá la categoría.");
  },
  async deleteGastoProgramado(id) {
    validateId(id); await requireChanged(`UPDATE gastos_programados SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,sync_status='pending'
      WHERE id=$1 AND owner_user_id=$2 AND ${active}`, [id,LOCAL_OWNER], "No se pudo eliminar la planificación.");
  },
  async markGastoProgramadoPaid(id) {
    validateId(id); const db = await getMobileDatabase();
    const rows = await db.select<GastoProgramado[]>(`SELECT * FROM gastos_programados gp WHERE id=$1 AND owner_user_id=$2 AND ${active} AND ${activeCategory}`, [id,LOCAL_OWNER])
      .catch(() => { throw new Error("No se pudo comprobar el gasto programado."); });
    if (!rows.length) throw new Error("El gasto programado no existe o no está disponible.");
    if (rows[0].estado === "pagado") return { changed: false, generated_next: false, is_recurrent: !!rows[0].es_recurrente };
    const today = getLocalDateInputValue(); validateDate(today);
    // Every statement rechecks current state inside the same write transaction.
    // No stale values from the preliminary read are used to create financial data.
    const statements = [
      { sql: `INSERT INTO movimientos(fecha,tipo,categoria_id,descripcion,monto,owner_user_id,sync_id)
          SELECT $1,'gasto',categoria_id,descripcion,monto_estimado,owner_user_id,$4 FROM gastos_programados gp
          WHERE id=$2 AND owner_user_id=$3 AND ${active} AND estado <> 'pagado' AND ${activeCategory}`,
        values: [today,id,LOCAL_OWNER,newSyncId()] },
      { sql: `WITH candidate AS (SELECT gp.*,${due} AS next_due FROM gastos_programados gp
          WHERE id=$1 AND owner_user_id=$2 AND ${active} AND estado <> 'pagado' AND es_recurrente=1 AND ${activeCategory})
          INSERT INTO gastos_programados(descripcion,categoria_id,monto_estimado,fecha_vencimiento,estado,es_recurrente,frecuencia,owner_user_id,sync_id)
          SELECT descripcion,categoria_id,monto_estimado,next_due,'pendiente',1,frecuencia,owner_user_id,$3 FROM candidate n
          WHERE NOT EXISTS (SELECT 1 FROM gastos_programados g WHERE g.owner_user_id=n.owner_user_id AND g.descripcion=n.descripcion
            AND g.categoria_id=n.categoria_id AND g.monto_estimado=n.monto_estimado AND g.fecha_vencimiento=n.next_due AND g.estado='pendiente'
            AND (g.deleted_at IS NULL OR g.deleted_at = ''))`, values: [id,LOCAL_OWNER,newSyncId()] },
      { sql: `UPDATE gastos_programados AS gp SET estado='pagado',updated_at=CURRENT_TIMESTAMP,sync_status='pending'
          WHERE id=$1 AND owner_user_id=$2 AND ${active} AND estado <> 'pagado' AND ${activeCategory}`, values: [id,LOCAL_OWNER] },
    ];
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const changed = await invoke<number[]>("mobile_sql_transaction", { statements });
      return { changed: changed[2] === 1, generated_next: changed[1] === 1, is_recurrent: !!rows[0].es_recurrente };
    } catch { throw new Error("No se pudo registrar el pago. No se guardaron cambios."); }
  },
  async getSchedulingSummary(period) {
    validatePeriod(period); const db = await getMobileDatabase();
    const today = getLocalDateInputValue(), start = `${String(period.year).padStart(4,"0")}-${String(period.month).padStart(2,"0")}-01`;
    try {
      const rows = await db.select<SchedulingSummary[]>(`SELECT
        COALESCE(SUM(CASE WHEN estado='pendiente' AND fecha_vencimiento BETWEEN $2 AND date($2,'+30 days') THEN ROUND(monto_estimado*100) ELSE 0 END),0)/100.0 AS total_pendiente_30_dias,
        COALESCE(SUM(CASE WHEN estado='pendiente' AND fecha_vencimiento<$2 THEN ROUND(monto_estimado*100) ELSE 0 END),0)/100.0 AS total_vencido,
        COALESCE(SUM(CASE WHEN estado='pagado' AND substr(fecha_vencimiento,1,7)=substr($2,1,7) THEN ROUND(monto_estimado*100) ELSE 0 END),0)/100.0 AS total_pagado_mes,
        ((SELECT COALESCE(SUM(CASE tipo WHEN 'ingreso' THEN ROUND(monto*100) WHEN 'gasto' THEN -ROUND(monto*100) ELSE 0 END),0) FROM movimientos
          WHERE owner_user_id=$1 AND ${active} AND substr(fecha,1,7)=substr($3,1,7))
          -COALESCE(SUM(CASE WHEN estado='pendiente' AND substr(fecha_vencimiento,1,7)=substr($3,1,7) THEN ROUND(monto_estimado*100) ELSE 0 END),0))/100.0 AS balance_proyectado_mes
        FROM gastos_programados WHERE owner_user_id=$1 AND ${active}`, [LOCAL_OWNER,today,start]);
      return rows[0];
    } catch { throw new Error("No se pudo cargar la proyección."); }
  },
};
