import { DeviceVerificationRequiredError } from "./deviceAuthorization";
import { createSupabaseAuthClient, getSupabaseProjectUrl } from "../lib/supabase";
import { getRuntimePlatformSync } from "./platform";
import { CloudAuthRequestError } from "./cloudAuth";
import { completeGoogleSupabaseSignIn, disposeUnusedSupabaseClient, isSupabaseCloudAuthConfigured } from "./supabaseCloudAuth";
import { isSupabaseSecureStorageAvailable } from "./supabaseTokenStorage";
import { GOOGLE_OAUTH_TTL_MS, GOOGLE_PKCE_STORAGE_KEY, parseSupabaseOAuthCallback, SUPABASE_GOOGLE_CALLBACK } from "./supabaseOAuthCallback";
import { deletePendingGoogleOAuth, loadPendingGoogleOAuth, savePendingGoogleOAuth } from "./supabaseOAuthStorage";
import { createGoogleOAuthTrace, type GoogleOAuthDiagnosticEvent, type GoogleOAuthDiagnosticContext } from "./googleOAuthDiagnostics";

type Client = ReturnType<typeof createSupabaseAuthClient>;
export type GoogleOAuthState = { status: "idle" | "opening" | "waiting" | "processing" | "succeeded" | "error"; message?: string; ownerId?: string; diagnosticCode?: GoogleOAuthDiagnosticEvent };
const IDLE: GoogleOAuthState = { status: "idle" };
let state = IDLE;
const subscribers = new Set<() => void>();
type Attempt = { client: Client; storageKey: string; storage: Map<string, string>; remember: boolean; expiresAt: number; ready: boolean; timer?: ReturnType<typeof setTimeout> };
let attempt: Attempt | null = null;
let callbackBusy = false;
const consumedCodes = new Set<string>(); // SHA-256 only; never keep callback URLs/codes.

export const getGoogleOAuthState = () => state;
export const getGoogleOAuthServerState = () => IDLE;
export function subscribeGoogleOAuth(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; }
function publish(next: GoogleOAuthState) { state = next; subscribers.forEach((listener) => listener()); }
export function dismissGoogleOAuthNotice() { if (!attempt && !callbackBusy) publish(IDLE); }

function makeAttempt(remember: boolean, expiresAt = Date.now() + GOOGLE_OAUTH_TTL_MS, values: Record<string, string> = {}, storageKey = `${GOOGLE_PKCE_STORAGE_KEY}-${crypto.randomUUID()}`): Attempt {
  const storage = new Map(Object.entries(values));
  const client = createSupabaseAuthClient({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  }, storageKey);
  return { client, storageKey, storage, remember, expiresAt, ready: false };
}

function armTimeout(current: Attempt) {
  current.timer = setTimeout(() => {
    if (attempt === current && !callbackBusy) void cancelGoogleSupabaseSignIn("El inicio de sesión con Google venció. Volvé a intentarlo.", "oauth_pending_expired");
  }, Math.max(0, current.expiresAt - Date.now()));
}

async function release(current: Attempt | null) {
  if (current?.timer) clearTimeout(current.timer);
  try { await deletePendingGoogleOAuth(); }
  finally { if (current) await disposeUnusedSupabaseClient(current.client); }
}

export async function cancelGoogleSupabaseSignIn(message?: string, diagnosticCode?: GoogleOAuthDiagnosticEvent) {
  // Once code exchange starts it cannot safely be interrupted or replaced.
  if (callbackBusy) return;
  const current = attempt;
  attempt = null;
  try {
    await release(current);
    publish(message ? { status: "error", message, ...(getRuntimePlatformSync() === "android" && diagnosticCode ? { diagnosticCode } : {}) } : IDLE);
  } catch { publish({ status: "error", message: "No pudimos limpiar el intento seguro de Google. Volvé a intentar." }); }
}

export async function signInWithGoogleSupabase(options: { remember?: boolean } = {}) {
  if (getRuntimePlatformSync() === "ios") throw new CloudAuthRequestError(
    "Google todavía no está disponible en iOS.", { code: "supabase_oauth_mobile_pending" });
  if (!isSupabaseSecureStorageAvailable()) throw new CloudAuthRequestError("El acceso con Google requiere almacenamiento seguro en la aplicación.", { code: "supabase_oauth_desktop_required" });
  if (!isSupabaseCloudAuthConfigured()) throw new CloudAuthRequestError("El servicio de cuenta no está configurado. Podés seguir en modo local.", { code: "supabase_not_configured" });
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) throw new CloudAuthRequestError("Este entorno no permite iniciar Google con PKCE seguro. Usá la app de escritorio actualizada.", { code: "supabase_pkce_unavailable" });
  if (attempt || callbackBusy || ["opening", "waiting", "processing"].includes(state.status)) throw new CloudAuthRequestError("Ya hay un inicio de sesión con Google en curso.", { code: "supabase_oauth_pending" });
  publish({ status: "opening" });
  const current = makeAttempt(options.remember ?? true);
  attempt = current;
  try {
    const { data, error } = await current.client.auth.signInWithOAuth({ provider: "google", options: {
      redirectTo: SUPABASE_GOOGLE_CALLBACK, skipBrowserRedirect: true,
      queryParams: { prompt: "select_account" },
    } });
    if (attempt !== current) return;
    if (error || !data.url) throw new Error("oauth_start_failed");
    const url = new URL(data.url);
    const project = new URL(getSupabaseProjectUrl());
    if (url.origin !== project.origin || url.pathname !== `${project.pathname.replace(/\/$/, "")}/auth/v1/authorize`
      || url.username || url.password || url.hash || url.searchParams.get("provider") !== "google"
      || url.searchParams.get("redirect_to") !== SUPABASE_GOOGLE_CALLBACK
      || ["provider", "redirect_to", "code_challenge_method", "code_challenge"].some((key) => url.searchParams.getAll(key).length !== 1)
      || url.searchParams.get("code_challenge_method") !== "s256" || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") || "")) throw new Error("oauth_url_invalid");
    // Snapshot before exchange: only SDK-generated PKCE verifier keys exist.
    // Access/refresh/provider tokens are never copied to this native entry.
    await savePendingGoogleOAuth({ expiresAt: current.expiresAt, remember: current.remember, storageKey: current.storageKey, storage: Object.fromEntries(current.storage) });
    if (attempt !== current) return;
    current.ready = true;
    armTimeout(current);
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    if (attempt !== current) return;
    await openUrl(data.url);
    if (attempt === current && !callbackBusy) publish({ status: "waiting" });
  } catch (failure) {
    if (attempt !== current) return;
    attempt = null;
    try { await release(current); } catch { /* No secrets or native errors reach logs/UI. */ }
    publish({ status: "error", message: failure instanceof CloudAuthRequestError ? failure.message
      : "No pudimos abrir Google. Volvé a intentar más tarde." });
  }
}

export async function handleSupabaseGoogleCallback(raw: string, origin: GoogleOAuthDiagnosticContext["origin"] = "onOpenUrl"): Promise<boolean> {
  // Unrelated deep links are ignored, never navigated or opened.
  if (!raw.startsWith("scisonomics://auth/")) return false;
  const expiredInMemory = state.diagnosticCode === "oauth_pending_expired";
  const trace = createGoogleOAuthTrace({ origin, mode: attempt || consumedCodes.size > 0 || expiredInMemory ? "warm" : "cold" });
  if (callbackBusy) return true;
  let callback: ReturnType<typeof parseSupabaseOAuthCallback>;
  try { callback = parseSupabaseOAuthCallback(raw); }
  catch {
    trace.fail("oauth_callback_invalid");
    await cancelGoogleSupabaseSignIn("El retorno de Google no incluye un código válido. Volvé a iniciar sesión.", trace.failure);
    return true;
  }
  callbackBusy = true; // Claimed synchronously before any await/getCurrent duplicate.
  let current: Attempt | null = null;
  try {
    if ("code" in callback) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(callback.code));
      const fingerprint = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      if (consumedCodes.has(fingerprint)) return true;
      if (consumedCodes.size >= 64) consumedCodes.delete(consumedCodes.values().next().value!);
      consumedCodes.add(fingerprint);
    }
    current = attempt;
    if (!current) {
      if (!isSupabaseCloudAuthConfigured()) {
        trace.fail("oauth_pending_invalid", { code: "supabase_not_configured" });
        throw new Error("not_configured");
      }
      const saved = await loadPendingGoogleOAuth(trace, expiredInMemory);
      if (saved) { current = makeAttempt(saved.remember, saved.expiresAt, saved.storage, saved.storageKey); current.ready = true; attempt = current; }
    }
    if (!current?.ready || current.expiresAt <= Date.now()) {
      if (!trace.failure) trace.fail(current && current.expiresAt <= Date.now() ? "oauth_pending_expired" : "oauth_pending_missing");
      throw new Error("no_pending_pkce");
    }
    if ("denied" in callback) { trace.fail("oauth_callback_invalid"); throw new Error("oauth_denied"); }
    publish({ status: "processing" });
    if (current.timer) clearTimeout(current.timer);
    // Consume secure pending state BEFORE exchange: a restart/replay cannot
    // reuse it. PKCE and Google's state are validated by Supabase, not the UI.
    await trace.step("oauth_pending_delete_failed", () => deletePendingGoogleOAuth());
    const user = await completeGoogleSupabaseSignIn(current.client, callback.code, current.remember, trace);
    attempt = null;
    publish({ status: "succeeded", ownerId: user.id });
  } catch (failure) {
    attempt = null;
    try { await release(current); } catch { /* Cleanup never falls back to browser storage. */ }
    if (failure instanceof DeviceVerificationRequiredError) { publish(IDLE); return true; }
    if (!trace.failure) trace.fail("oauth_pending_invalid", failure);
    publish({ status: "error", message: failure instanceof CloudAuthRequestError ? failure.message
      : "No pudimos completar Google. El acceso se canceló, venció o no tiene un intento PKCE pendiente. Volvé a iniciar sesión.",
      ...(getRuntimePlatformSync() === "android" ? { diagnosticCode: trace.failure } : {}) });
  } finally {
    callbackBusy = false;
  }
  return true;
}

type DeepLinkAdapter = { getCurrent: () => Promise<string[] | null>; onOpenUrl: (handler: (urls: string[]) => void) => Promise<() => void> };
export async function connectSupabaseGoogleDeepLinks(adapter?: DeepLinkAdapter): Promise<() => void> {
  if (!isSupabaseSecureStorageAvailable()) return () => {};
  const plugin = adapter ?? await import("@tauri-apps/plugin-deep-link");
  const handle = (urls: string[], origin: GoogleOAuthDiagnosticContext["origin"]) => { for (const url of urls) void handleSupabaseGoogleCallback(url, origin); };
  // Subscribe first so a callback between listener registration/getCurrent
  // cannot be lost. Duplicate events are claimed above.
  const unlisten = await plugin.onOpenUrl((urls) => handle(urls, "onOpenUrl"));
  try { const urls = await plugin.getCurrent(); if (urls) handle(urls, "getCurrent"); }
  catch { unlisten(); throw new Error("supabase_deep_link_unavailable"); }
  return unlisten;
}
