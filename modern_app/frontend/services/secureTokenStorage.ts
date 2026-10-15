import { getRuntimePlatformSync } from "./platform";

export type SecureTokenStorage = {
  backend: "desktop" | "android-keystore";
  save(accountId: string, token: string): Promise<{ ok: boolean; roundtrip: boolean }>;
  load(accountId: string): Promise<{ found: boolean; token: string | null; error_code?: string | null }>;
  delete(accountId: string): Promise<{ ok: boolean }>;
};

export function getSecureTokenStorage(): SecureTokenStorage {
  const platform = getRuntimePlatformSync();
  if (typeof window === "undefined") throw new Error("secure_storage_not_available");
  const runtime = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown; isTauri?: boolean };
  if (!runtime.__TAURI_INTERNALS__ && !runtime.__TAURI__ && !runtime.isTauri) throw new Error("secure_storage_not_available");
  if (platform === "ios") throw new Error("secure_storage_not_supported");
  const android = platform === "android";
  const invoke = async <T>(action: "save" | "load" | "delete", accountId: string, token?: string): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    const command = android ? `plugin:mobile-secure-storage|${action}` : `${action}_persistent_supabase_refresh_token`;
    return invoke<T>(command, { accountId, ...(token === undefined ? {} : { token }) });
  };
  return {
    backend: android ? "android-keystore" : "desktop",
    save: (id, token) => invoke("save", id, token),
    load: (id) => invoke("load", id),
    delete: (id) => invoke("delete", id),
  };
}
