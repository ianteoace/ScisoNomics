import { invoke } from "@tauri-apps/api/core";
import { getRuntimePlatformSync } from "../platform";
import { getActiveOwnerId, getStoredAccounts } from "../cloudAuth";
import { getSession } from "../supabaseCloudAuth";
import { hasCachedDeviceGrant } from "../deviceAuthorization";
import { currentCloudEnvironment, finishRecoverySource, mobileRecoveryEnabled, normalizeRecoveryEmail, recoverySources, type RecoverySource } from "../mobileRecoveryState";
import { getMobileDatabase } from "./mobileDatabase";

export class MobileRecoveryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new MobileRecoveryError(code, message); }
const validOwner = (id: string) => typeof id === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(id) && id !== "local";
export const MOBILE_RECOVERY_DATA_CHANGED = "scisonomics:mobile-recovery-data-changed";
const ledgerSQL = `CREATE TABLE IF NOT EXISTS mobile_account_recovery (
  source_owner TEXT PRIMARY KEY, target_owner TEXT NOT NULL, environment TEXT NOT NULL,
  categories INTEGER NOT NULL, movements INTEGER NOT NULL, completed_at TEXT NOT NULL,
  CHECK(source_owner <> target_owner AND source_owner <> 'local' AND target_owner <> 'local'))`;
async function database() {
  if (!["android", "ios"].includes(getRuntimePlatformSync()) || !mobileRecoveryEnabled()) fail("unsupported_platform", "La recuperación sólo está disponible en Mobile.");
  const db = await getMobileDatabase();
  await invoke("mobile_sql_transaction", { statements: [{ sql: ledgerSQL, values: [] }] });
  return db;
}
async function counts(db: Awaited<ReturnType<typeof database>>, owner: string) {
  const [row] = await db.select<{ categories: number; movements: number }[]>(`SELECT
    (SELECT count(*) FROM categorias WHERE owner_user_id=$1) AS categories,
    (SELECT count(*) FROM movimientos WHERE owner_user_id=$1) AS movements`, [owner]);
  return row;
}
// Inventory is safe without login: only counts, never financial row contents.
export async function evaluateRecoveryInventory() {
  const sources = recoverySources().filter(source => source.status === "pending");
  if (!sources.length) return;
  const db = await database();
  for (const source of sources) {
    if (!validOwner(source.ownerId)) fail("invalid_owner", "Los datos anteriores requieren revisión manual.");
    const [done] = await db.select<{ target_owner: string }[]>("SELECT target_owner FROM mobile_account_recovery WHERE source_owner=$1", [source.ownerId]);
    if (done) {
      finishRecoverySource(source.ownerId, "migrated");
      window.dispatchEvent(new CustomEvent(MOBILE_RECOVERY_DATA_CHANGED, { detail: { ownerId: done.target_owner } }));
      continue;
    }
    const data = await counts(db, source.ownerId);
    if (!data.categories && !data.movements) finishRecoverySource(source.ownerId, "empty");
  }
}
async function targetSession(ownerId: string) {
  if (!validOwner(ownerId) || getActiveOwnerId() !== ownerId) fail("invalid_target", "La cuenta activa cambió. Volvé a revisar la recuperación.");
  const session = await getSession(ownerId);
  const account = getStoredAccounts().find(account => account.user.id === ownerId);
  if (!session || session.authProvider !== "supabase" || session.user.id !== ownerId || !session.token
    || getActiveOwnerId() !== ownerId || !hasCachedDeviceGrant(ownerId) || account?.authEnvironment !== currentCloudEnvironment()) {
    fail("session_required", "Iniciá sesión y autorizá el dispositivo antes de recuperar tus datos.");
  }
  return session;
}
export type RecoveryCandidate = { sourceOwner: string; targetOwner: string; categories: number; movements: number; blocked: boolean };
export async function findMobileRecovery(targetOwner: string): Promise<RecoveryCandidate | null> {
  await evaluateRecoveryInventory();
  const session = await targetSession(targetOwner);
  const matching = recoverySources().filter(s => s.status === "pending" && s.ownerId !== targetOwner && s.email === normalizeRecoveryEmail(session.user.email));
  if (matching.length > 1) fail("ambiguous_source", "Hay varias sesiones anteriores con datos. Se requiere revisión manual; no se fusionaron datos.");
  if (!matching.length) return null;
  const db = await database(), data = await counts(db, matching[0].ownerId), target = await counts(db, targetOwner);
  return { sourceOwner: matching[0].ownerId, targetOwner, ...data, blocked: Boolean(target.categories || target.movements) };
}
async function validateSource(sourceOwner: string, targetOwner: string): Promise<RecoverySource> {
  if (!validOwner(sourceOwner) || !validOwner(targetOwner) || sourceOwner === targetOwner) fail("invalid_owner", "Las cuentas de recuperación no son válidas.");
  const session = await targetSession(targetOwner);
  const source = recoverySources().find(s => s.ownerId === sourceOwner);
  if (!source || !source.email || source.email !== normalizeRecoveryEmail(session.user.email)) fail("email_mismatch", "El correo de la sesión anterior no coincide con la cuenta actual.");
  return source;
}
// The existing native transaction runner provides rollback + expected_rows.
// No network is performed within this transaction. Schema v1 composite FKs
// need deferral while categories and movements change owner together.
const inFlight = new Map<string, Promise<{ migrated: boolean; categories: number; movements: number }>>();
export function migrateMobileAccount(sourceOwner: string, targetOwner: string) {
  const key = `${sourceOwner}:${targetOwner}`;
  if (!inFlight.has(key)) inFlight.set(key, migrate(sourceOwner, targetOwner).finally(() => inFlight.delete(key)));
  return inFlight.get(key)!;
}
async function migrate(sourceOwner: string, targetOwner: string) {
  const db = await database();
  const source = await validateSource(sourceOwner, targetOwner);
  const [done] = await db.select<{ target_owner: string }[]>("SELECT target_owner FROM mobile_account_recovery WHERE source_owner=$1", [sourceOwner]);
  if (done) {
    if (done.target_owner !== targetOwner) fail("already_recovered", "Los datos ya fueron recuperados en otra cuenta. Se requiere revisión manual.");
    finishRecoverySource(sourceOwner, "migrated"); return { migrated: false, categories: 0, movements: 0 };
  }
  const data = await counts(db, sourceOwner), target = await counts(db, targetOwner);
  if (!data.categories && !data.movements) { finishRecoverySource(sourceOwner, "empty"); return { migrated: false, ...data }; }
  if (source.status !== "pending") fail("not_pending", "La recuperación ya fue evaluada. No se modificaron datos.");
  if (target.categories || target.movements) fail("target_not_empty", "La cuenta actual ya tiene datos en este dispositivo. Se requiere revisión manual; no se fusionaron datos.");
  const ancillary = ["metas_ahorro", "gastos_fijos", "presupuestos", "gastos_programados"].map(table => `NOT EXISTS(SELECT 1 FROM ${table} WHERE owner_user_id=$1)`).join(" AND ");
  const safeVersions = ["categorias", "movimientos"].map(table => `NOT EXISTS(SELECT 1 FROM ${table} WHERE owner_user_id=$1 AND (typeof(local_change_version)<>'integer' OR local_change_version<0 OR local_change_version>=9007199254740991))`).join(" AND ");
  const statements = [
    { sql: "PRAGMA defer_foreign_keys=ON", values: [] },
    { sql: `INSERT INTO mobile_account_recovery(source_owner,target_owner,environment,categories,movements,completed_at)
      SELECT $1,$2,$3,$4,$5,$6 WHERE
      NOT EXISTS(SELECT 1 FROM categorias WHERE owner_user_id=$2) AND NOT EXISTS(SELECT 1 FROM movimientos WHERE owner_user_id=$2)
      AND ${ancillary} AND ${safeVersions}`, values: [sourceOwner,targetOwner,currentCloudEnvironment(),data.categories,data.movements,new Date().toISOString()], expected_rows: 1 },
    ...["categorias", "movimientos"].map((table, index) => ({ sql: `UPDATE ${table} SET owner_user_id=$2,
      sync_status='pending',last_synced_at=NULL,last_remote_updated_at=NULL,last_remote_device_id=NULL,last_remote_revision=NULL,sync_error_code=NULL,
      local_change_version=local_change_version+1 WHERE owner_user_id=$1`, values: [sourceOwner,targetOwner], expected_rows: index === 0 ? data.categories : data.movements })),
    { sql: "DELETE FROM mobile_pull_state WHERE owner_user_id IN ($1,$2)", values: [sourceOwner,targetOwner] },
    { sql: `UPDATE mobile_account_recovery SET completed_at=completed_at WHERE source_owner=$1 AND target_owner=$2
      AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)`, values: [sourceOwner,targetOwner], expected_rows: 1 },
  ];
  if (getActiveOwnerId() !== targetOwner) fail("owner_changed", "La cuenta cambió. No se modificaron datos.");
  try { await invoke("mobile_sql_transaction", { statements }); }
  catch { fail("transaction_failed", "No se pudo recuperar: la cuenta actual recibió datos, hay relaciones adicionales o cambios simultáneos. Se requiere revisión manual; no se modificaron filas."); }
  // A crash here is healed from SQLite's ledger during inventory on next boot.
  finishRecoverySource(sourceOwner, "migrated");
  window.dispatchEvent(new CustomEvent(MOBILE_RECOVERY_DATA_CHANGED, { detail: { ownerId: targetOwner } }));
  return { migrated: true, ...data };
}
export async function keepMobileRecoverySeparate(sourceOwner: string, targetOwner: string) {
  await validateSource(sourceOwner,targetOwner);
  finishRecoverySource(sourceOwner,"separate"); // Leaves every SQLite row intact.
}
