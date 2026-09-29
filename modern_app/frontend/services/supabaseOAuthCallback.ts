import { CloudAuthRequestError } from "./cloudAuth";

export const SUPABASE_GOOGLE_CALLBACK = "scisonomics://auth/callback";
export const GOOGLE_PKCE_STORAGE_KEY = "scisonomics-supabase-google-pkce";
export const GOOGLE_OAUTH_TTL_MS = 5 * 60 * 1000;

export function parseSupabaseOAuthCallback(raw: string): { code: string } | { denied: true } {
  const invalid = () => new CloudAuthRequestError("El retorno de Google no es válido. Volvé a iniciar sesión.", { code: "supabase_oauth_callback_invalid", kind: "auth" });
  if (raw.length > 4096 || !raw.startsWith(`${SUPABASE_GOOGLE_CALLBACK}?`) || /[\s\\]/.test(raw)) throw invalid();
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid(); }
  if (url.protocol !== "scisonomics:" || url.hostname !== "auth" || url.pathname !== "/callback"
    || url.username || url.password || url.port || url.hash) throw invalid();
  const allowed = new Set(["code", "error", "error_code", "error_description"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw invalid();
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error")) {
    if (code || !url.searchParams.get("error")) throw invalid();
    return { denied: true };
  }
  if (!code || !/^[A-Za-z0-9_-]{1,1024}$/.test(code)
    || url.searchParams.has("error_code") || url.searchParams.has("error_description")) throw invalid();
  return { code };
}
