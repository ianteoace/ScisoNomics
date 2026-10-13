import { getRuntimePlatformSync } from "./platform";

export type QuickEntryType = "income" | "expense";
export type QuickEntry = { id: string; type: QuickEntryType; expiresAt: number };
const TTL = 120_000;
let pending: QuickEntry | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const consuming = new Map<string, Promise<boolean>>();
const completed = new Map<string, number>();
export const quickEntryKind = (type: QuickEntryType): "ingreso" | "gasto" => type === "income" ? "ingreso" : "gasto";
export function parseQuickEntry(value: unknown): QuickEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["id", "type", "remainingMs"].includes(key))
      || typeof row.id !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.id)
      || !["income", "expense"].includes(row.type as string)
      || !Number.isInteger(row.remainingMs) || (row.remainingMs as number) <= 0 || (row.remainingMs as number) > TTL) return null;
  return { id: row.id, type: row.type as QuickEntryType, expiresAt: Date.now() + (row.remainingMs as number) };
}
const notify = () => listeners.forEach(listener => listener());
export const subscribeQuickEntry = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getPendingQuickEntry = () => pending;
export const getQuickEntryServerSnapshot = () => null;
function accept(value: unknown) {
  if (getRuntimePlatformSync() !== "android") return;
  const entry = parseQuickEntry(value);
  for (const [id, expiry] of completed) if (expiry <= Date.now()) completed.delete(id);
  if (!entry || completed.has(entry.id) || pending?.id === entry.id) return;
  if (pending) consuming.delete(pending.id);
  pending = entry; clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => finishQuickEntry(entry.id), Math.max(0, entry.expiresAt - Date.now()));
  notify();
}
export function finishQuickEntry(id: string) {
  consuming.delete(id);
  if (pending?.id !== id) return;
  completed.set(id, pending.expiresAt);
  pending = null; clearTimeout(expiryTimer); notify();
}
async function native<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (getRuntimePlatformSync() !== "android") throw new Error("Los accesos rápidos solo están disponibles en Android.");
  try { const { invoke } = await import("@tauri-apps/api/core"); return await invoke<T>(`plugin:quick-entry|${command}`, args); }
  catch { throw new Error("No pudimos abrir los accesos rápidos. Reintentá desde la aplicación."); }
}
export function startQuickEntryBridge() {
  if (getRuntimePlatformSync() !== "android") return () => {};
  let active = true, stop: (() => void) | undefined;
  void (async () => {
    const { addPluginListener } = await import("@tauri-apps/api/core");
    let revision = 0;
    const listener = await addPluginListener<unknown>("quick-entry", "pending", value => { if (active) { revision++; accept(value); } });
    stop = () => { void native("remove_listener", { event: "pending", channelId: listener.channelId }).catch(() => {}); };
    if (!active) { stop(); return; }
    const observed = revision;
    const result = await native<{ pending: unknown }>("peek_pending");
    if (active && revision === observed) accept(result.pending);
  })().catch(() => { /* Native errors do not block normal startup/local mode. */ });
  return () => { active = false; stop?.(); };
}
export function consumeQuickEntry(id: string): Promise<boolean> {
  if (pending?.id !== id || pending.expiresAt <= Date.now()) return Promise.resolve(false);
  if (!consuming.has(id)) {
    const attempt = native<{ consumed: boolean }>("consume_pending", { id }).then(result => result.consumed === true).catch(() => false);
    consuming.set(id, attempt);
    // Successful acknowledgement survives effect cleanup/StrictMode until the
    // editor opens (or TTL expires). Never acknowledge the same ID twice.
    void attempt.then(success => { if (!success && consuming.get(id) === attempt) consuming.delete(id); });
  }
  return consuming.get(id)!;
}
export const quickEntryInfo = () => native<{ sdk: number }>("get_info");
export async function requestQuickEntryTile(type: QuickEntryType) {
  if (!["income", "expense"].includes(type)) throw new Error("Acceso rápido inválido.");
  const result = await native<{ status: string }>("request_add_tile", { kind: type });
  const messages: Record<string, string> = {
    added: "Acceso rápido agregado.", already_added: "Este acceso rápido ya está agregado.", not_added: "No se agregó el acceso rápido.",
    manual: "Abrí Ajustes rápidos > Editar y agregá Ingreso/Gasto de ScisoNomics.",
    unavailable: "Abrí ScisoNomics en primer plano y reintentá.", error: "Android no pudo agregar el acceso rápido. Podés agregarlo desde Ajustes rápidos > Editar.",
  };
  return messages[result.status] || messages.error;
}
