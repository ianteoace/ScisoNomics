import type { StoredCloudAccount, StoredAuthState } from "./cloudAuth";
import { getRuntimePlatformSync } from "./platform";

export const MOBILE_RECOVERY_CHANGED = "scisonomics:mobile-recovery-changed";
const KEY = "scisonomics_mobile_account_recovery_v1";
let storageFailed = false;
export type RecoverySource = { ownerId: string; email: string; environment: string | null; status: "pending" | "empty" | "migrated" | "separate"; account?: StoredCloudAccount };
type State = { version: 1; sources: RecoverySource[] };
export const normalizeRecoveryEmail = (value: string) => value.trim().toLowerCase();
export function currentCloudEnvironment() {
  const api = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");
  const identity = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  return api && identity ? `${api}|${identity}` : "";
}
export function mobileRecoveryEnabled() {
  return typeof window !== "undefined" && ["android", "ios"].includes(getRuntimePlatformSync())
    && process.env.NEXT_PUBLIC_SCISONOMICS_MOBILE_ACCOUNT_RECOVERY === "1";
}
function read(): State {
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return { version: 1, sources: [] };
  const state = JSON.parse(raw) as State;
  if (state.version !== 1 || !Array.isArray(state.sources) || state.sources.some(s => !s || typeof s.ownerId !== "string"
    || typeof s.email !== "string" || !["pending", "empty", "migrated", "separate"].includes(s.status))) throw new Error("recovery_state_invalid");
  return state;
}
function write(state: State) {
  window.localStorage.setItem(KEY, JSON.stringify(state));
  window.dispatchEvent(new Event(MOBILE_RECOVERY_CHANGED));
}
export function recoverySources(): RecoverySource[] {
  return mobileRecoveryEnabled() ? read().sources : [];
}
// Called synchronously BEFORE auth hydration. Archive first; if storage fails,
// callers get local mode and sync stays blocked. Never archive tokens or grants.
export function quarantineMobileAccounts(state: StoredAuthState): StoredAuthState {
  if (!mobileRecoveryEnabled()) return state;
  const scope = currentCloudEnvironment();
  if (!scope) return { activeOwnerId: "local", accounts: [] };
  const archive = read();
  const visible = state.accounts.filter(account => {
    if (account.authProvider !== "supabase" || account.authEnvironment === scope) return true;
    if (!archive.sources.some(source => source.ownerId === account.user.id)) archive.sources.push({
      ownerId: account.user.id, email: normalizeRecoveryEmail(account.user.email), environment: account.authEnvironment || null, status: "pending",
      account: { authProvider: "supabase", authEnvironment: account.authEnvironment, storage: account.storage,
        addedAt: account.addedAt, lastUsedAt: account.lastUsedAt, user: { id: account.user.id, email: account.user.email,
          display_name: account.user.display_name, created_at: account.user.created_at, updated_at: account.user.updated_at } },
    });
    return false;
  });
  if (archive.sources.length !== read().sources.length) write(archive);
  storageFailed = false;
  return { accounts: visible, activeOwnerId: visible.some(a => a.user.id === state.activeOwnerId) ? state.activeOwnerId : "local" };
}
export function finishRecoverySource(ownerId: string, status: RecoverySource["status"]) {
  const state = read(), source = state.sources.find(s => s.ownerId === ownerId);
  if (!source) throw new Error("recovery_source_missing");
  source.status = status; write(state);
}
export function isMobileRecoveryBlocked() {
  if (!mobileRecoveryEnabled()) return false;
  try { return storageFailed || !currentCloudEnvironment() || read().sources.some(s => s.status === "pending"); }
  catch { return true; }
}
export function blockMobileRecoveryStorage() { if (mobileRecoveryEnabled()) storageFailed = true; }
export function assertMobileRecoveryMetadataWritable() {
  if (mobileRecoveryEnabled() && storageFailed) throw new Error("No pudimos conservar la sesión anterior. No se reemplazó su información. Reintentá sin borrar los datos de la app.");
}
export function assertMobileRecoverySyncAllowed() {
  if (isMobileRecoveryBlocked()) throw new Error("Revisá primero los datos de la sesión anterior. No se sincronizó ningún dato.");
}
