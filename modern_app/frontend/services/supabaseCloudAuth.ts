import type { AuthError, Session } from "@supabase/supabase-js";
import { createSupabaseAuthClient, isSupabaseAuthConfigured } from "../lib/supabase";
import {
  addOrUpdateAccount, cloudAuth, CloudAuthRequestError, getActiveOwnerId,
  getStoredAccounts, getValidAccessToken, isCloudAuthConfigured, removeAccount,
  type CloudUser, type StoredCloudSession,
} from "./cloudAuth";
import { deleteSupabaseRefreshToken, isSupabaseSecureStorageAvailable, loadSupabaseRefreshToken, saveSupabaseRefreshToken } from "./supabaseTokenStorage";

type SupabaseIdentityClient = ReturnType<typeof createSupabaseAuthClient>;
type MemorySession = { client: SupabaseIdentityClient; session: Session | null; refreshToken: string; persistent: boolean };
const sessions = new Map<string, MemorySession>();
const refreshes = new Map<string, Promise<StoredCloudSession | null>>();

export type SupabaseSignUpResult =
  | { status: "verification_required"; email: string }
  | { status: "signed_in"; user: CloudUser };

export function isSupabaseCloudAuthConfigured() {
  return isSupabaseAuthConfigured() && isCloudAuthConfigured();
}

function newClient() {
  if (!isSupabaseCloudAuthConfigured()) {
    throw new CloudAuthRequestError("Supabase no está configurado en este entorno. Podés seguir usando el modo local o el acceso anterior.", { code: "supabase_not_configured" });
  }
  return createSupabaseAuthClient();
}

async function withClient<T>(action: (client: SupabaseIdentityClient) => Promise<T>): Promise<T> {
  const client = newClient();
  try {
    return await action(client);
  } finally {
    if (![...sessions.values()].some((entry) => entry.client === client)) await client.auth.dispose();
  }
}

function providerError(error: AuthError, operation?: "verify_email" | "resend_signup"): CloudAuthRequestError {
  const code = error.code || (error.status === 429 ? "over_request_rate_limit" : "supabase_auth_failed");
  const messages: Record<string, string> = {
    invalid_credentials: "Email o contraseña incorrectos.",
    email_not_confirmed: "Confirmá tu correo en Supabase antes de iniciar sesión.",
    weak_password: "La contraseña no cumple los requisitos de seguridad.",
    otp_expired: "El código es inválido o venció. Revisalo o pedí uno nuevo.",
    over_email_send_rate_limit: "El reenvío de códigos está temporalmente bloqueado. Esperá unos minutos antes de pedir otro.",
    over_request_rate_limit: operation === "resend_signup"
      ? "El reenvío de códigos está temporalmente bloqueado por demasiadas solicitudes. Esperá unos minutos."
      : "Demasiados intentos. Esperá unos minutos antes de volver a intentar.",
  };
  if (operation === "verify_email") messages.validation_failed = "Código inválido. Ingresá los dígitos del código recibido por correo.";
  const retryable = !error.status || error.status >= 500 || error.status === 429;
  return new CloudAuthRequestError(messages[code] || (retryable
    ? "No pudimos conectar con Supabase. Intentá nuevamente."
    : "No se pudo completar la autenticación con Supabase."), {
    code, statusCode: error.status || null, kind: retryable ? "network" : "auth",
  });
}

async function resolveInternalUser(accessToken: string, bootstrap = false) {
  try {
    const user = bootstrap ? await cloudAuth.supabaseBootstrap(accessToken) : await cloudAuth.me(accessToken);
    if (!user?.id || user.id === "local") {
      throw new CloudAuthRequestError("El servidor no devolvió una cuenta interna válida.", { code: "internal_identity_invalid", kind: "auth" });
    }
    return user;
  } catch (error) {
    if (error instanceof CloudAuthRequestError && error.code === "internal_account_required") {
      throw new CloudAuthRequestError("No pudimos completar el alta interna de ScisoNomics. Intentá nuevamente o continuá en modo local.", {
        code: error.code, statusCode: error.statusCode, kind: "auth",
      });
    }
    throw error;
  }
}

function expiresAt(session: Session) {
  return new Date((session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in) * 1000).toISOString();
}

async function storeSession(user: CloudUser, session: Session, makeActive: boolean, persistent = false) {
  await addOrUpdateAccount({ user, tokens: {
    accessToken: session.access_token, expiresAt: expiresAt(session), tokenType: session.token_type || "bearer",
    // Refresh tokens never enter cloudAuth, sessionStorage or localStorage.
  } }, { authProvider: "supabase", remember: persistent, makeActive, externalPersistenceVerified: persistent });
}

async function acceptSession(client: SupabaseIdentityClient, session: Session | null, remember = isSupabaseSecureStorageAvailable()): Promise<CloudUser> {
  if (!session?.access_token || !session.refresh_token) {
    throw new CloudAuthRequestError("Supabase no devolvió una sesión válida.", { code: "supabase_session_missing", kind: "auth" });
  }
  const user = await resolveInternalUser(session.access_token, true);
  // Until bootstrap completes, the token stays in memory. No temporary native
  // key based on sub is needed, and failures cannot leave such an entry behind.
  // Only the backend's users.id indexes accounts. The provider's subject stays
  // inside its memory session and is never an owner or storage key.
  const previous = sessions.get(user.id);
  const entry = { client, session, refreshToken: session.refresh_token, persistent: remember };
  sessions.set(user.id, entry);
  try {
    if (remember) await saveSupabaseRefreshToken(user.id, session.refresh_token);
    else {
      const deleted = await deleteSupabaseRefreshToken(user.id);
      if (!deleted.ok) throw new CloudAuthRequestError("No pudimos quitar la sesión Supabase recordada. Intentá nuevamente.", { code: "supabase_secure_storage_failed" });
    }
    if (sessions.get(user.id) !== entry) throw new CloudAuthRequestError("Este acceso fue reemplazado. Volvé a iniciar sesión.", { code: "supabase_login_replaced", kind: "auth" });
    await storeSession(user, session, true, remember);
  } catch (failure) {
    if (sessions.get(user.id) === entry) {
      if (previous) sessions.set(user.id, previous); else sessions.delete(user.id);
    }
    throw failure;
  }
  if (previous) await previous.client.auth.dispose();
  return user;
}

export async function signInWithPassword(email: string, password: string, options: { remember?: boolean } = {}) {
  return withClient(async (client) => {
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw providerError(error);
    return acceptSession(client, data.session, options.remember);
  });
}

export async function completeGoogleSupabaseSignIn(client: SupabaseIdentityClient, code: string, remember: boolean) {
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error) throw providerError(error);
  if (!data.session?.user.email || !data.session.user.email_confirmed_at) {
    throw new CloudAuthRequestError("Google no devolvió un email confirmado. Volvé a iniciar sesión.", { code: "supabase_email_unconfirmed", kind: "auth" });
  }
  return acceptSession(client, data.session, remember);
}

export async function disposeUnusedSupabaseClient(client: SupabaseIdentityClient) {
  if (![...sessions.values()].some((entry) => entry.client === client)) await client.auth.dispose();
}

export async function signUpWithPassword(email: string, password: string, displayName?: string, options: { remember?: boolean } = {}): Promise<SupabaseSignUpResult> {
  return withClient(async (client): Promise<SupabaseSignUpResult> => {
    const normalizedEmail = email.trim();
    const { data, error } = await client.auth.signUp({
      email: normalizedEmail, password, options: { data: { display_name: displayName?.trim() || undefined } },
    });
    if (error) throw providerError(error);
    if (!data.session) return { status: "verification_required", email: normalizedEmail };
    return { status: "signed_in", user: await acceptSession(client, data.session, options.remember) };
  });
}

export async function resendSignupVerification(email: string) {
  return withClient(async (client) => {
    const { error } = await client.auth.resend({ type: "signup", email: email.trim() });
    if (error) throw providerError(error, "resend_signup");
  });
}

export async function verifyEmailCode(email: string, token: string, options: { remember?: boolean } = {}) {
  const code = token.trim();
  if (!/^[0-9]{6,10}$/.test(code)) throw new CloudAuthRequestError(
    "Código inválido. Ingresá los dígitos del código recibido por correo.", { code: "invalid_otp", kind: "auth" });
  return withClient(async (client) => {
    const { data, error } = await client.auth.verifyOtp({ email: email.trim(), token: code, type: "email" });
    if (error) throw providerError(error, "verify_email");
    return acceptSession(client, data.session, options.remember);
  });
}

export async function requestPasswordReset(email: string) {
  return withClient(async (client) => {
    const { error } = await client.auth.resetPasswordForEmail(email.trim());
    if (error) throw providerError(error);
  });
}

export async function completePasswordRecovery(email: string, token: string, password: string) {
  return withClient(async (client) => {
    const { error: verificationError } = await client.auth.verifyOtp({ email: email.trim(), token: token.trim(), type: "recovery" });
    if (verificationError) throw providerError(verificationError);
    const { error } = await client.auth.updateUser({ password });
    if (error) throw providerError(error);
    // Recovery changes credentials, never a financial owner; resolve /auth/me at login.
    await client.auth.signOut({ scope: "local" });
  });
}

export async function getSession(ownerId = getActiveOwnerId()): Promise<StoredCloudSession | null> {
  if (!getStoredAccounts().some((account) => account.user.id === ownerId && account.authProvider === "supabase")) return null;
  return getValidAccessToken(ownerId);
}

async function refreshAccount(ownerId: string): Promise<StoredCloudSession | null> {
  const account = getStoredAccounts().find((item) => item.user.id === ownerId && item.authProvider === "supabase");
  if (!account) return null;
  let entry = sessions.get(ownerId);
  if (!entry) {
    if (account.storage !== "persistent") return null;
    entry = { client: newClient(), session: null, refreshToken: "", persistent: true };
    sessions.set(ownerId, entry);
    try {
      const token = await loadSupabaseRefreshToken(ownerId);
      if (sessions.get(ownerId) !== entry) return null;
      if (!token) { forgetSession(ownerId); return null; }
      entry.refreshToken = token;
    } catch (error) { if (sessions.get(ownerId) === entry) forgetSession(ownerId); throw error; }
  }
  const { data, error } = await entry.client.auth.refreshSession({ refresh_token: entry.refreshToken });
  if (sessions.get(ownerId) !== entry) return null;
  if (error) throw providerError(error);
  if (!data.session || (entry.session && data.session.user.id !== entry.session.user.id)) {
    throw new CloudAuthRequestError("La identidad de la sesión cambió. Volvé a iniciar sesión.", { kind: "auth", code: "internal_identity_mismatch" });
  }
  // Preserve rotated refresh tokens across transient backend failures.
  entry.session = data.session;
  entry.refreshToken = data.session.refresh_token;
  // Save rotation before calling the backend: a transient /auth/me failure
  // must not leave a stale one-use refresh token on disk.
  if (entry.persistent) await saveSupabaseRefreshToken(ownerId, entry.refreshToken);
  if (sessions.get(ownerId) !== entry) return null;
  let user: CloudUser;
  try {
    user = await resolveInternalUser(data.session.access_token);
  } catch (failure) {
    if (sessions.get(ownerId) !== entry) return null;
    throw failure;
  }
  if (user.id !== ownerId) {
    throw new CloudAuthRequestError("La sesión no corresponde a esta cuenta de ScisoNomics.", { kind: "auth", code: "internal_identity_mismatch" });
  }
  if (sessions.get(ownerId) !== entry || !getStoredAccounts().some((account) => account.user.id === ownerId && account.authProvider === "supabase")) return null;
  await storeSession(user, data.session, false, entry.persistent);
  const updatedAccount = getStoredAccounts().find((item) => item.user.id === ownerId)!;
  return { ...updatedAccount, token: data.session.access_token, tokenType: data.session.token_type, expiresAt: expiresAt(data.session) };
}

export function refreshSession(ownerId = getActiveOwnerId()): Promise<StoredCloudSession | null> {
  if (!refreshes.has(ownerId)) refreshes.set(ownerId, refreshAccount(ownerId).finally(() => refreshes.delete(ownerId)));
  return refreshes.get(ownerId)!;
}

export function forgetSession(ownerId: string) {
  const entry = sessions.get(ownerId);
  sessions.delete(ownerId);
  if (entry) void entry.client.auth.dispose().catch(() => {});
}

export async function deleteSavedSession(ownerId: string) {
  forgetSession(ownerId);
  return deleteSupabaseRefreshToken(ownerId);
}

export async function hydrateStoredSessions() {
  let restored = false;
  for (const account of getStoredAccounts()) {
    if (account.authProvider !== "supabase" || account.storage !== "persistent" || sessions.has(account.user.id)) continue;
    try { restored = Boolean(await refreshSession(account.user.id)) || restored; }
    catch { /* State is evaluated by getValidAccessToken; local mode stays usable. */ }
  }
  return restored;
}

export async function signOut(ownerId = getActiveOwnerId()) {
  const account = getStoredAccounts().find((item) => item.user.id === ownerId);
  if (account?.authProvider !== "supabase") return { ok: true };
  const entry = sessions.get(ownerId);
  sessions.delete(ownerId);
  let remoteRevoked = false;
  try {
    if (entry) {
      const { error } = await entry.client.auth.signOut({ scope: "local" });
      remoteRevoked = Boolean(entry.session) && !error;
    }
  } catch {
    // Local logout works offline. Never log provider errors or sessions.
  }
  if (entry) await entry.client.auth.dispose();
  if (sessions.has(ownerId) || getStoredAccounts().find((item) => item.user.id === ownerId)?.authProvider !== "supabase") return { ok: true, remoteRevoked };
  const result = await removeAccount(ownerId);
  return { ...result, remoteRevoked };
}
