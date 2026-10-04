import type { Categoria, Movimiento, MoveType } from "../../types/domain";
import type { CreateCategoria, CreateMovimiento, FinancePeriod, FinanceRepository } from "./financeRepositoryTypes";
import { getMobileDatabase } from "./mobileDatabase";

const LOCAL_OWNER = "local";
const moveTypes: readonly string[] = ["ingreso", "gasto", "ahorro", "inversion"];
function validateType(tipo: string): asserts tipo is MoveType {
  if (!moveTypes.includes(tipo)) throw new Error("Elegí un tipo de movimiento válido.");
}
function boundedText(value: string, maxLength: number, label: string): string {
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new Error(`${label} admite hasta ${maxLength} caracteres.`);
  }
  return value.trim();
}
function validateDate(fecha: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(Date.parse(`${fecha}T00:00:00Z`))
    || new Date(`${fecha}T00:00:00Z`).toISOString().slice(0, 10) !== fecha || fecha.startsWith("0000")) {
    throw new Error("Ingresá una fecha válida.");
  }
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
  if (!Number.isFinite(input.monto) || input.monto <= 0 || !Number.isSafeInteger(Math.round(input.monto * 100))
    || Math.abs(input.monto * 100 - Math.round(input.monto * 100)) > 0.00001) {
    throw new Error("Ingresá un monto mayor a cero, con hasta dos decimales.");
  }
  if (!Number.isSafeInteger(input.categoria_id) || input.categoria_id <= 0) {
    throw new Error("Elegí una categoría existente.");
  }
  return { ...input, descripcion: boundedText(input.descripcion, 500, "La descripción"), nota: boundedText(input.nota ?? "", 4000, "La nota") };
}
function validatePeriod({ month, year }: FinancePeriod) {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 1 || year > 9999) {
    throw new Error("Elegí un mes y año válidos.");
  }
}
export function mapCategoria(row: Categoria): Categoria {
  return { id: Number(row.id), nombre: row.nombre, tipo: row.tipo };
}
type MovimientoRow = Omit<Movimiento, "descripcion"> & { descripcion: string | null };
export function mapMovimiento(row: MovimientoRow): Movimiento {
  return {
    id: Number(row.id), fecha: row.fecha, tipo: row.tipo, categoria: row.categoria,
    descripcion: row.descripcion ?? "", monto: Number(row.monto), saldo_acumulado: Number(row.saldo_acumulado),
    nota: row.nota ?? "",
  };
}
function newSyncId() {
  return crypto.randomUUID();
}
async function write(sql: string, bindings: unknown[], message: string) {
  const database = await getMobileDatabase();
  try { await database.execute(sql, bindings); }
  catch { throw new Error(message); }
}

export const mobileFinanceRepository: FinanceRepository = {
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
           SELECT m.id, m.fecha, m.tipo, c.nombre AS categoria, m.descripcion, m.monto, m.nota,
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
    await write(
      `INSERT INTO movimientos (fecha, tipo, categoria_id, descripcion, monto, nota, owner_user_id, sync_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [clean.fecha, clean.tipo, clean.categoria_id, clean.descripcion, clean.monto, clean.nota, LOCAL_OWNER, newSyncId()],
      "No se pudo guardar el movimiento. Revisá la categoría y reintentá.",
    );
  },
};
