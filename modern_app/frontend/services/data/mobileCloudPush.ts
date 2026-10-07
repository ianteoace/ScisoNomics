import { invoke } from "@tauri-apps/api/core";
import { cloudRequest, getActiveOwnerId } from "../cloudAuth";
import { listAccountDevices } from "../deviceAuthorization";
import { getMobileDatabase } from "./mobileDatabase";
import { assertMobileCloudOwner, getMobileCloudSession, MobilePullError, normalizeCloudRevision } from "./mobileCloudPull";

const tables = ["categorias", "tags", "metas_ahorro", "gastos_programados", "gastos_fijos", "presupuestos", "movimientos", "movimiento_tags"] as const;
type Entity = "categorias" | "movimientos";
type Change = { sync_id: string; tipo: string; nombre?: string; fecha?: string; descripcion?: string; monto?: number;
  categoria_sync_id?: string; categoria_id?: number; created_at: string; updated_at: string; deleted_at: string | null;
  last_remote_updated_at: string | null; last_remote_revision: string | null; local_change_version: number; sync_error_code: string | null; ack_revision?: string };
type Rejection = { entity: Entity; sync_id: string; code: string };
type Pending = Record<Entity, Change[]>;
export type PushResult = { uploaded: number; rejected: number; conflicts: number; stillPending: number };
export class MobilePushError extends MobilePullError {}
function invalid(): never { throw new MobilePushError("invalid_ack", "Cloud no confirmó correctamente el lote. Los cambios siguen pendientes."); }
export async function getMobileCloudPending(ownerId: string): Promise<Pending> {
  assertMobileCloudOwner(ownerId); const db = await getMobileDatabase();
  const metadata = "sync_id,created_at,updated_at,deleted_at,last_remote_updated_at,last_remote_revision,local_change_version,sync_error_code";
  const pending = "(sync_status IN ('pending','sync_error') OR sync_status IS NULL OR trim(sync_status)='')";
  const [categorias, movimientos] = await Promise.all([
    db.select<Change[]>(`SELECT nombre,tipo,${metadata} FROM categorias WHERE owner_user_id=$1 AND ${pending} ORDER BY id`, [ownerId]),
    db.select<Change[]>(`SELECT m.tipo,m.fecha,m.monto,m.descripcion,m.categoria_id,c.sync_id AS categoria_sync_id,
      ${metadata.split(",").map(field => `m.${field}`).join(",")}
      FROM movimientos m LEFT JOIN categorias c ON c.id=m.categoria_id AND c.owner_user_id=m.owner_user_id
      WHERE m.owner_user_id=$1 AND (m.sync_status IN ('pending','sync_error') OR m.sync_status IS NULL OR trim(m.sync_status)='') ORDER BY m.id`, [ownerId]),
  ]);
  return { categorias, movimientos };
}
function toWire(row: Change, baseline: string | null) {
  // No SQL IDs, owner, version, diagnostics or local-only note/meta sent as identity.
  const common = { sync_id: row.sync_id, tipo: row.tipo, created_at: row.created_at, updated_at: row.updated_at,
    deleted_at: row.deleted_at, sync_status: "pending", last_remote_updated_at: baseline };
  return row.nombre !== undefined ? { ...common, nombre: row.nombre }
    : { ...common, fecha: row.fecha, monto: row.monto, descripcion: row.descripcion, categoria_sync_id: row.categoria_sync_id };
}
function sameChange(row: Change, remote: Record<string, unknown>) {
  const keys = row.nombre !== undefined ? ["nombre","tipo","updated_at","deleted_at"] : ["fecha","tipo","monto","descripcion","categoria_sync_id","updated_at","deleted_at"];
  return keys.every(key => (row[key as keyof Change] ?? null) === (remote[key] ?? null));
}
function parseAck(raw: unknown, sent: Pending, deviceId: string) {
  if (!raw || typeof raw !== "object") invalid();
  const r = raw as { ok?: boolean; accepted?: Record<string, unknown>; rejected?: {entity:string;sync_id:string;code:string}[];
    counts?: Record<string, number>; ignored?: Record<string, number>; conflicts?: Record<string, number>; device?: {device_id:string;last_seen_at:string} };
  if (r.ok !== true || !r.accepted || !Array.isArray(r.rejected) || !r.counts || r.device?.device_id !== deviceId) invalid();
  const rawRevision = r.device.last_seen_at; normalizeCloudRevision(rawRevision);
  const accepted = {} as Record<Entity, Change[]>;
  const rejected: Rejection[] = [];
  for (const table of tables) {
    const rows = table === "categorias" || table === "movimientos" ? sent[table] : [];
    const ids = r.accepted[table]; if (!Array.isArray(ids) || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) invalid();
    const rejects = r.rejected.filter(item => item.entity === table);
    const all = [...ids, ...rejects.map(item => item.sync_id)];
    if (new Set(all).size !== all.length || all.length !== rows.length || all.some(id => !rows.some(row => row.sync_id === id))
      || r.counts[`${table}_received`] !== rows.length || r.counts[`${table}_saved`] !== ids.length || r.ignored?.[table] !== rejects.length) invalid();
    if (table === "categorias" || table === "movimientos") {
      accepted[table] = rows.filter(row => ids.includes(row.sync_id));
      for (const item of rejects) {
        // Preserve only a known non-sensitive diagnostic code, never provider message.
        const code = ["conflict_remote_newer","invalid_payload","save_failed"].includes(item.code) ? item.code : "cloud_rejected";
        rejected.push({ entity: table, sync_id: item.sync_id, code });
      }
    }
  }
  if (r.rejected.some(item => !tables.includes(item.entity as typeof tables[number]))) invalid();
  return { accepted, rejected, rawRevision };
}
async function acknowledge(ownerId: string, accepted: Record<Entity, Change[]>, rejected: Rejection[], sent: Pending, deviceId: string) {
  const now = new Date().toISOString();
  const statements = (["categorias","movimientos"] as const).flatMap(table => {
    const ack = accepted[table].map(row => ({sync_id:row.sync_id,version:row.local_change_version,revision:row.ack_revision,normalized:row.ack_revision ? normalizeCloudRevision(row.ack_revision) : null}));
    const errors = rejected.filter(row => row.entity === table).map(row => ({ ...row,version:sent[table].find(item => item.sync_id === row.sync_id)!.local_change_version }));
    return [
      { sql: `UPDATE ${table} AS t SET sync_status=CASE WHEN EXISTS(SELECT 1 FROM json_each($2) j WHERE t.sync_id=json_extract(j.value,'$.sync_id') AND t.local_change_version=json_extract(j.value,'$.version')) THEN 'synced' ELSE t.sync_status END,
          last_synced_at=$3,last_remote_revision=(SELECT json_extract(j.value,'$.revision') FROM json_each($2) j WHERE t.sync_id=json_extract(j.value,'$.sync_id')),
          last_remote_updated_at=(SELECT json_extract(j.value,'$.normalized') FROM json_each($2) j WHERE t.sync_id=json_extract(j.value,'$.sync_id')),last_remote_device_id=$4,sync_error_code=NULL WHERE t.owner_user_id=$1 AND EXISTS
          (SELECT 1 FROM json_each($2) j WHERE t.sync_id=json_extract(j.value,'$.sync_id') AND t.local_change_version>=json_extract(j.value,'$.version')
            AND (t.last_remote_updated_at IS NULL OR t.last_remote_updated_at<=json_extract(j.value,'$.normalized')))`,
        values: [ownerId,JSON.stringify(ack),now,deviceId] },
      { sql: `UPDATE ${table} AS t SET sync_error_code=(SELECT json_extract(j.value,'$.code') FROM json_each($2) j WHERE t.sync_id=json_extract(j.value,'$.sync_id'))
          WHERE t.owner_user_id=$1 AND EXISTS(SELECT 1 FROM json_each($2) j WHERE t.sync_id=json_extract(j.value,'$.sync_id') AND t.local_change_version=json_extract(j.value,'$.version'))`,
        values: [ownerId,JSON.stringify(errors)] },
    ];
  });
  try { return await invoke<number[]>("mobile_sql_transaction", { statements }); }
  catch (error) { throw new MobilePushError("ack_failed", "Cloud recibió el lote, pero no se pudo confirmar en este dispositivo. Reintentá; se conservan los identificadores y los pendientes.", {cause:error}); }
}
const inFlight = new Map<string, Promise<PushResult>>();
export function pushMobileCloudNow(ownerId: string): Promise<PushResult> {
  if (inFlight.has(ownerId)) return inFlight.get(ownerId)!;
  const request = push(ownerId).finally(() => inFlight.delete(ownerId)); inFlight.set(ownerId, request); return request;
}
async function push(ownerId: string): Promise<PushResult> {
  const session = await getMobileCloudSession(ownerId);
  const pending = await getMobileCloudPending(ownerId);
  if (!pending.categorias.length && !pending.movimientos.length) return { uploaded:0,rejected:0,conflicts:0,stillPending:0 };
  const devices = await listAccountDevices(session.token);
  const current = devices.find(device => device.current && device.status === "trusted");
  if (!current) throw new MobilePushError("device_required", "El dispositivo no está autorizado para subir cambios.");
  // The existing push API protects string baselines. Read current revisions to
  // recover v4 normalized baselines and detect collision/lost-response retries.
  const remote = await cloudRequest<Record<string, unknown>>("/sync/pull", {headers:{Authorization:`Bearer ${session.token}`}},45000);
  if (remote.ok !== true || !Array.isArray(remote.categorias) || !Array.isArray(remote.movimientos)) invalid();
  const sent: Pending = {categorias:[],movimientos:[]}, rejected: Rejection[] = [];
  const wire: Record<Entity, Record<string, unknown>[]> = {categorias:[],movimientos:[]};
  for (const table of ["categorias","movimientos"] as const) for (const row of pending[table]) {
    const existing = (remote[table] as Record<string,unknown>[]).find(item => item.sync_id === row.sync_id);
    let baseline = row.last_remote_revision;
    if (existing) {
      const revision = String(existing.remote_updated_at);
      const matches = row.last_remote_updated_at && normalizeCloudRevision(revision) === row.last_remote_updated_at;
      const retry = existing.last_modified_device_id === current.device_id && sameChange(row, existing);
      if (!matches && !retry) { rejected.push({entity:table,sync_id:row.sync_id,code:"conflict_remote_newer"}); continue; }
      baseline = revision; // Exact server bytes, not the normalized comparison value.
    }
    sent[table].push(row); wire[table].push(table === "categorias" ? {...toWire(row, baseline),color:existing?.color ?? null,icono:existing?.icono ?? null} : toWire(row, baseline));
  }
  // A rejected new category cannot leave its movements referring to absent cloud data.
  for (let i=sent.movimientos.length-1;i>=0;i--) {
    const row = sent.movimientos[i];
    if (rejected.some(item => item.entity === "categorias" && item.sync_id === row.categoria_sync_id)) {
      sent.movimientos.splice(i,1);wire.movimientos.splice(i,1);rejected.push({entity:"movimientos",sync_id:row.sync_id,code:"conflict_remote_newer"});
    }
  }
  if (getActiveOwnerId() !== ownerId) throw new MobilePushError("owner_changed","La cuenta cambió. No se subieron los cambios.");
  const accepted: Record<Entity, Change[]> = {categorias:[],movimientos:[]};
  for (const table of ["categorias","movimientos"] as const) {
    if (table === "movimientos") {
      for (let i=sent.movimientos.length-1;i>=0;i--) if (rejected.some(item=>item.entity==="categorias" && item.sync_id===sent.movimientos[i].categoria_sync_id)) {
        rejected.push({entity:"movimientos",sync_id:sent.movimientos[i].sync_id,code:"category_rejected"});sent.movimientos.splice(i,1);wire.movimientos.splice(i,1);
      }
    }
    if (!sent[table].length) continue;
    if (getActiveOwnerId() !== ownerId) throw new MobilePushError("owner_changed","La cuenta cambió durante el envío. Se conservaron los pendientes.");
    const phase: Pending = {categorias:[],movimientos:[],[table]:sent[table]};
    const payload = { ...Object.fromEntries(tables.map(entity=>[entity,[]])),[table]:wire[table],device_id:current.device_id,device_name:"ScisoNomics Android" };
    let response: unknown;
    try { response = await cloudRequest("/sync/push", {method:"POST",headers:{Authorization:`Bearer ${session.token}`},body:JSON.stringify(payload)},45000); }
    catch (error) { throw new MobilePushError("push_failed","No se confirm? la subida. Los cambios siguen pendientes para reintentar sin duplicarlos.",{cause:error}); }
    const result = parseAck(response,phase,current.device_id);
    accepted[table] = result.accepted[table].map(row=>({...row,ack_revision:result.rawRevision}));
    rejected.push(...result.rejected);
  }
  if (getActiveOwnerId() !== ownerId) throw new MobilePushError("owner_changed","La cuenta cambió después del envío. Se conservaron los pendientes para confirmar al volver a esta cuenta.");
  const changes = await acknowledge(ownerId,accepted,rejected,pending,current.device_id);
  const remaining = await getMobileCloudPending(ownerId);
  const summary = {uploaded:changes[0]+changes[2],rejected:rejected.length,conflicts:rejected.filter(row=>row.code==="conflict_remote_newer").length,stillPending:remaining.categorias.length+remaining.movimientos.length};
  if (process.env.NODE_ENV === "development") console.info("[mobile-push]",summary);
  return summary;
}
