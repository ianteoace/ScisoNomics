import { AuthClient, type SupportedStorage } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export function isSupabaseAuthConfigured() {
  if (!supabaseUrl || !supabasePublishableKey?.startsWith("sb_publishable_")) return false;
  try {
    const url = new URL(supabaseUrl);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch {
    return false;
  }
}

let clientNumber = 0;

export function getSupabaseProjectUrl() {
  if (!isSupabaseAuthConfigured()) throw new Error("Supabase no está configurado.");
  return new URL(supabaseUrl!.replace(/\/$/, "")).href.replace(/\/$/, "");
}

// Each account/attempt gets an isolated in-memory SDK session. Creating the
// client lazily keeps local mode and static builds working without auth.
export function createSupabaseAuthClient(oauthStorage?: SupportedStorage, oauthStorageKey?: string) {
  if (!isSupabaseAuthConfigured()) {
    throw new Error("Falta configurar Supabase con una URL y publishable key válidas.");
  }
  // Supabase is only our identity provider. Avoid creating unused realtime
  // clients (and their browser listeners) for each authentication attempt.
  return { auth: new AuthClient({
    url: `${supabaseUrl!.replace(/\/$/, "")}/auth/v1`,
    headers: { apikey: supabasePublishableKey! },
    // The OAuth adapter is memory-only. The SDK needs persistSession=true to
    // honor a custom adapter; only its pending PKCE snapshot goes to WinCred.
    persistSession: Boolean(oauthStorage),
    storage: oauthStorage,
    flowType: "pkce",
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storageKey: oauthStorage ? oauthStorageKey ?? `scisonomics-supabase-google-pkce-${crypto.randomUUID()}` : `scisonomics-supabase-memory-${++clientNumber}`,
    fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) }),
  }) };
}
