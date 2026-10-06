import { invoke } from "@tauri-apps/api/core";
import { CloudAuthRequestError, cloudRequest, getActiveOwnerId } from "../cloudAuth";
import { getSession } from "../supabaseCloudAuth";
import { getRuntimePlatformSync } from "../platform";
import { getMobileDatabase } from "./mobileDatabase";
import { validateDate } from "./mobileRepositorySupport";

// Consumes the existing /sync/pull protocol. No desktop local API or push.
const unsupported = ["tags", "movimiento_tags", "metas_ahorro", "gastos_programados", "gastos_fijos", "presupuestos"] as const;
type Row = Record<string, unknown>;
type Change = { sync_id: string; created_at: string; updated_at: string; deleted_at: string | null;
  remote_updated_at: string; last_modified_device_id: string; tipo: string };
type Category = Change & { nombre: string };
type Movement = Change & { categoria_sync_id: string; fecha: string; descripcion: string; monto: number };
export type PullResult = { ownerId: string; cursorBefore: string | null; cursorAfter: string;
  categoriesApplied: number; movementsApplied: number; ignoredCount: number };
export type CloudSnapshot = { cursor: string | null; categories: { nombre: string; tipo: string }[];
  movements: { sync_id: string; fecha: string; tipo: string; categoria: string; descripcion: string; monto: number }[] };

export class MobilePullError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) { super(message, options); }
}
function invalid(): never { throw new MobilePullError("invalid_payload", "La respuesta cloud no es válida. No se avanzó la sincronización."); }
function owner(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(value) || value === "local") {
    throw new MobilePullError("invalid_owner", "La cuenta no tiene un identificador interno válido.");
  }
  return value;
}
function text(value: unknown, max: number, required = true): string {
  if (value == null && !required) return "";
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) invalid();
  return value;
}
// Keep microseconds: cloud revisions must not be rounded to JavaScript milliseconds.
function timestamp(value: unknown): string {
  const raw = text(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/.test(raw)) invalid();
  const normalized = raw.replace(" ", "T");
  const instant = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`);
  if (!Number.isFinite(instant)) invalid();
  const fraction = (raw.match(/\.(\d+)/)?.[1] || "").padEnd(6, "0");
  return `${new Date(instant).toISOString().slice(0, 19)}.${fraction}Z`;
}
function common(row: Row): Change {
  const tipo = text(row.tipo, 20);
  if (!["ingreso", "gasto", "ahorro", "inversion"].includes(tipo)) invalid();
  return { sync_id: text(row.sync_id, 120), tipo, created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at), deleted_at: row.deleted_at ? timestamp(row.deleted_at) : null,
    remote_updated_at: timestamp(row.remote_updated_at), last_modified_device_id: text(row.last_modified_device_id, 120, false) };
}
function changes(value: unknown): Row[] {
  if (!Array.isArray(value) || value.length > 50000 || value.some(row => !row || typeof row !== "object" || Array.isArray(row))) invalid();
  return value;
}
function newest<T extends Change>(rows: T[]): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) {
    const previous = unique.get(row.sync_id);
    if (!previous || row.remote_updated_at > previous.remote_updated_at
      || (row.remote_updated_at === previous.remote_updated_at && row.last_modified_device_id > previous.last_modified_device_id)) unique.set(row.sync_id, row);
    else if (row.remote_updated_at === previous.remote_updated_at && row.last_modified_device_id === previous.last_modified_device_id
      && JSON.stringify(row) !== JSON.stringify(previous)) invalid();
  }
  return [...unique.values()];
}
function parse(payload: unknown) {
  if (!payload || typeof payload !== "object") invalid();
  const p = payload as Row;
  if (p.ok !== true) invalid();
  const cursor = text(p.cursor, 64); timestamp(cursor);
  const categories = newest(changes(p.categorias).map(row => ({ ...common(row), nombre: text(row.nombre, 120).trim() })));
  const movements = newest(changes(p.movimientos).map(row => {
    const base = common(row), fecha = text(row.fecha, 10);
    try { validateDate(fecha); } catch (error) { throw new MobilePullError("invalid_date", "Un movimiento cloud tiene una fecha inválida.", { cause: error }); }
    if (typeof row.monto !== "number" || !Number.isFinite(row.monto) || row.monto <= 0) invalid();
    // Server-local categoria_id is deliberately ignored: resolve by sync identity.
    return { ...base, fecha, monto: row.monto, categoria_sync_id: text(row.categoria_sync_id, 120), descripcion: text(row.descripcion, 500, false) };
  }));
  if ([...categories, ...movements].some(row => row.remote_updated_at > timestamp(cursor))) invalid();
  const ignored = Object.fromEntries(unsupported.map(key => [key, Array.isArray(p[key]) ? p[key].length : 0]));
  return { cursor, categories, movements, ignored };
}

export async function getMobilePullCursor(ownerId: string): Promise<string | null> {
  owner(ownerId);
  const db = await getMobileDatabase();
  const rows = await db.select<{ cursor: string }[]>("SELECT cursor FROM mobile_pull_state WHERE owner_user_id=$1 AND supported_entities_version=1", [ownerId]);
  return rows[0]?.cursor ?? null;
}
function revisionWins(table: string) {
  // Same revision + device tie-break as desktop _remote_is_newer.
  return `${table}.last_remote_updated_at IS NULL OR excluded.last_remote_updated_at > ${table}.last_remote_updated_at
    OR (excluded.last_remote_updated_at = ${table}.last_remote_updated_at AND excluded.last_remote_device_id > COALESCE(${table}.last_remote_device_id,''))`;
}

export async function applyMobilePull(ownerId: string, payload: unknown, expectedCursor: string | null): Promise<PullResult> {
  owner(ownerId);
  const batch = parse(payload), now = new Date().toISOString();
  if (expectedCursor && timestamp(batch.cursor) < timestamp(expectedCursor)) invalid();
  await getMobileDatabase();
  const metadata = "created_at,updated_at,deleted_at,sync_status,last_synced_at,last_remote_updated_at,last_remote_device_id";
  const sourceMeta = "json_extract(j.value,'$.created_at'),json_extract(j.value,'$.updated_at'),json_extract(j.value,'$.deleted_at'),'synced',$3,json_extract(j.value,'$.remote_updated_at'),json_extract(j.value,'$.last_modified_device_id')";
  const updateMeta = "updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,sync_status='synced',last_synced_at=excluded.last_synced_at,last_remote_updated_at=excluded.last_remote_updated_at,last_remote_device_id=excluded.last_remote_device_id";
  const statements = [
    // CAS plus expected_rows rejects another writer; any later failure rolls this back.
    { sql: `INSERT INTO mobile_pull_state(owner_user_id,cursor,updated_at)
        SELECT $1,$2,$3 WHERE $4 IS NULL OR EXISTS(SELECT 1 FROM mobile_pull_state WHERE owner_user_id=$1 AND cursor=$4)
        ON CONFLICT(owner_user_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at
        WHERE mobile_pull_state.cursor=$4`, values: [ownerId, batch.cursor, now, expectedCursor], expected_rows: 1 },
    { sql: `INSERT INTO categorias(owner_user_id,sync_id,nombre,tipo,${metadata})
        SELECT $1,json_extract(j.value,'$.sync_id'),json_extract(j.value,'$.nombre'),json_extract(j.value,'$.tipo'),${sourceMeta}
        FROM json_each($2) j WHERE true
        ON CONFLICT(owner_user_id,sync_id) DO UPDATE SET nombre=excluded.nombre,tipo=excluded.tipo,${updateMeta}
        WHERE ${revisionWins("categorias")}`, values: [ownerId, JSON.stringify(batch.categories), now] },
    { sql: `INSERT INTO movimientos(owner_user_id,sync_id,fecha,tipo,categoria_id,descripcion,monto,${metadata})
        SELECT $1,json_extract(j.value,'$.sync_id'),json_extract(j.value,'$.fecha'),json_extract(j.value,'$.tipo'),
        (SELECT c.id FROM categorias c WHERE c.owner_user_id=$1 AND c.sync_id=json_extract(j.value,'$.categoria_sync_id')),
        json_extract(j.value,'$.descripcion'),json_extract(j.value,'$.monto'),${sourceMeta}
        FROM json_each($2) j WHERE true
        ON CONFLICT(owner_user_id,sync_id) DO UPDATE SET fecha=excluded.fecha,tipo=excluded.tipo,categoria_id=excluded.categoria_id,
          descripcion=excluded.descripcion,monto=excluded.monto,${updateMeta}
        WHERE ${revisionWins("movimientos")}`, values: [ownerId, JSON.stringify(batch.movements), now] },
  ];
  let applied: number[];
  try { applied = await invoke<number[]>("mobile_sql_transaction", { statements }); }
  catch (error) { throw new MobilePullError("apply_failed", "No se pudo aplicar el lote cloud: conflicto local, categoría faltante o cambio simultáneo. Se conservaron los datos y el cursor anterior.", { cause: error }); }
  const ignoredCount = Object.values(batch.ignored).reduce((sum, count) => sum + count, 0);
  if (process.env.NODE_ENV === "development") console.info("[mobile-pull]", { categoriesApplied: applied[1], movementsApplied: applied[2], ignored: batch.ignored });
  return { ownerId, cursorBefore: expectedCursor, cursorAfter: batch.cursor, categoriesApplied: applied[1], movementsApplied: applied[2], ignoredCount };
}

export async function readMobileCloudSnapshot(ownerId: string): Promise<CloudSnapshot> {
  owner(ownerId);
  const db = await getMobileDatabase();
  const [cursor, categories, movements] = await Promise.all([
    getMobilePullCursor(ownerId),
    db.select<CloudSnapshot["categories"]>("SELECT nombre,tipo FROM categorias WHERE owner_user_id=$1 AND deleted_at IS NULL ORDER BY tipo,nombre", [ownerId]),
    db.select<CloudSnapshot["movements"]>(`SELECT m.sync_id,m.fecha,m.tipo,c.nombre AS categoria,m.descripcion,m.monto FROM movimientos m
      JOIN categorias c ON c.id=m.categoria_id AND c.owner_user_id=m.owner_user_id
      WHERE m.owner_user_id=$1 AND m.deleted_at IS NULL ORDER BY m.fecha DESC,m.id DESC`, [ownerId]),
  ]);
  return { cursor, categories, movements };
}

const inFlight = new Map<string, Promise<PullResult>>();
export function pullMobileCloudNow(ownerId: string): Promise<PullResult> {
  if (inFlight.has(ownerId)) return inFlight.get(ownerId)!;
  const request = pull(ownerId).finally(() => inFlight.delete(ownerId));
  inFlight.set(ownerId, request);
  return request;
}
async function pull(ownerId: string) {
  owner(ownerId);
  if (getRuntimePlatformSync() !== "android") throw new MobilePullError("unsupported_platform", "La descarga cloud está disponible en Android.");
  const session = await getSession(ownerId);
  if (!session || session.authProvider !== "supabase" || session.user.id !== ownerId || getActiveOwnerId() !== ownerId) {
    throw new MobilePullError("session_required", "Iniciá sesión y autorizá este dispositivo antes de sincronizar.");
  }
  // getSession returns the device grant after existing trusted-device authorization.
  // Cloud revalidates trusted/family on /sync/pull; no parallel authorization here.
  const cursor = await getMobilePullCursor(ownerId);
  let payload: unknown;
  try { payload = await cloudRequest<unknown>(`/sync/pull${cursor ? `?since=${encodeURIComponent(cursor)}` : ""}`, { headers: { Authorization: `Bearer ${session.token}` } }, 45000); }
  catch (error) {
    const code = error instanceof CloudAuthRequestError && error.kind === "auth" ? "authorization_failed" : "pull_failed";
    throw new MobilePullError(code, code === "authorization_failed" ? "La cuenta o el dispositivo ya no está autorizado. Volvé a verificar la sesión." : "No se pudo descargar desde cloud. Reintentá cuando tengas conexión.", { cause: error });
  }
  if (getActiveOwnerId() !== ownerId) throw new MobilePullError("owner_changed", "La cuenta cambió durante la descarga. No se aplicaron los datos.");
  return applyMobilePull(ownerId, payload, cursor);
}
