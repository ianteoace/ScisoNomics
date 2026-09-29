import type { AuthError, Session } from "@supabase/supabase-js";
import { createSupabaseAuthClient, isSupabaseAuthConfigured } from "../lib/supabase";
import {
  addOrUpdateAccount, cloudAuth, CloudAuthRequestError, getActiveOwnerId,
  getStoredAccounts, getValidAccessToken, isCloudAuthConfigured, removeAccount,
  type CloudUser, type StoredCloudSession,
} from "./cloudAuth";

type SupabaseIdentityClient = ReturnType<typeof createSupabaseAuthClient>;
type MemorySession = { client: SupabaseIdentityClient; session: Session };
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

function providerError(error: AuthError): CloudAuthRequestError {
  const code = error.code || "supabase_auth_failed";
  const messages: Record<string, string> = {
    invalid_credentials: "Email o contraseña incorrectos.",
    email_not_confirmed: "Confirmá tu correo en Supabase antes de iniciar sesión.",
    weak_password: "La contraseña no cumple los requisitos de seguridad.",
    otp_expired: "El código venció o no es válido. Pedí uno nuevo.",
    over_email_send_rate_limit: "Esperá unos minutos antes de pedir otro correo.",
    over_request_rate_limit: "Esperá unos minutos antes de volver a intentar.",
  };
  const retryable = !error.status || error.status >= 500 || error.status === 429;
  return new CloudAuthRequestError(messages[code] || (retryable
    ? "No pudimos conectar con Supabase. Intentá nuevamente."
    : "No se pudo completar la autenticación con Supabase."), {
    code, statusCode: error.status || null, kind: retryable ? "network" : "auth",
  });
}

async function resolveInternalUser(accessToken: string) {
  try {
    const user = await cloudAuth.me(accessToken);
    if (!user?.id || user.id === "local") {
      throw new CloudAuthRequestError("El servidor no devolvió una cuenta interna válida.", { code: "internal_identity_invalid", kind: "auth" });
    }
    return user;
  } catch (error) {
    if (error instanceof CloudAuthRequestError && error.code === "internal_account_required") {
      throw new CloudAuthRequestError("Tu identidad de Supabase está confirmada, pero todavía no tiene una cuenta interna de ScisoNomics. El alta interna estará disponible en la siguiente fase. Podés continuar en modo local o con tu cuenta anterior.", {
        code: error.code, statusCode: error.statusCode, kind: "auth",
      });
    }
    throw error;
  }
}

function expiresAt(session: Session) {
  return new Date((session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in) * 1000).toISOString();
}

async function storeSession(user: CloudUser, session: Session, makeActive: boolean) {
  await addOrUpdateAccount({ user, tokens: {
    accessToken: session.access_token, expiresAt: expiresAt(session), tokenType: session.token_type || "bearer",
    // Refresh tokens never enter cloudAuth, sessionStorage or localStorage.
  } }, { authProvider: "supabase", remember: false, makeActive });
}

async function acceptSession(client: SupabaseIdentityClient, session: Session | null): Promise<CloudUser> {
  if (!session?.access_token || !session.refresh_token) {
    throw new CloudAuthRequestError("Supabase no devolvió una sesión válida.", { code: "supabase_session_missing", kind: "auth" });
  }
  const user = await resolveInternalUser(session.access_token);
  // Only the backend's users.id indexes accounts. The provider's subject stays
  // inside its memory session and is never an owner or storage key.
  const previous = sessions.get(user.id);
  sessions.set(user.id, { client, session });
  if (previous) await previous.client.auth.dispose();
  await storeSession(user, session, true);
  return user;
}

export async function signInWithPassword(email: string, password: string) {
  return withClient(async (client) => {
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw providerError(error);
    return acceptSession(client, data.session);
  });
}

export async function signUpWithPassword(email: string, password: string, displayName?: string): Promise<SupabaseSignUpResult> {
  return withClient(async (client): Promise<SupabaseSignUpResult> => {
    const normalizedEmail = email.trim();
    const { data, error } = await client.auth.signUp({
      email: normalizedEmail, password, options: { data: { display_name: displayName?.trim() || undefined } },
    });
    if (error) throw providerError(error);
    if (!data.session) return { status: "verification_required", email: normalizedEmail };
    return { status: "signed_in", user: await acceptSession(client, data.session) };
  });
}

export async function resendSignupVerification(email: string) {
  return withClient(async (client) => {
    const { error } = await client.auth.resend({ type: "signup", email: email.trim() });
    if (error) throw providerError(error);
  });
}

export async function verifyEmailCode(email: string, token: string) {
  return withClient(async (client) => {
    const { data, error } = await client.auth.verifyOtp({ email: email.trim(), token: token.trim(), type: "email" });
    if (error) throw providerError(error);
    return acceptSession(client, data.session);
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
  const entry = sessions.get(ownerId);
  if (!entry || !getStoredAccounts().some((account) => account.user.id === ownerId && account.authProvider === "supabase")) return null;
  const { data, error } = await entry.client.auth.refreshSession({ refresh_token: entry.session.refresh_token });
  if (sessions.get(ownerId) !== entry) return null;
  if (error) throw providerError(error);
  if (!data.session || data.session.user.id !== entry.session.user.id) {
    throw new CloudAuthRequestError("La identidad de la sesión cambió. Volvé a iniciar sesión.", { kind: "auth", code: "internal_identity_mismatch" });
  }
  // Preserve rotated refresh tokens across transient backend failures.
  entry.session = data.session;
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
  await storeSession(user, data.session, false);
  const account = getStoredAccounts().find((item) => item.user.id === ownerId)!;
  return { ...account, token: data.session.access_token, tokenType: data.session.token_type, expiresAt: expiresAt(data.session) };
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

export async function signOut(ownerId = getActiveOwnerId()) {
  const account = getStoredAccounts().find((item) => item.user.id === ownerId);
  if (account?.authProvider !== "supabase") return { ok: true };
  const entry = sessions.get(ownerId);
  sessions.delete(ownerId);
  let remoteRevoked = false;
  try {
    if (entry) {
      const { error } = await entry.client.auth.signOut({ scope: "local" });
      remoteRevoked = !error;
    }
  } catch {
    // Local logout works offline. Never log provider errors or sessions.
  }
  if (entry) await entry.client.auth.dispose();
  if (sessions.has(ownerId) || getStoredAccounts().find((item) => item.user.id === ownerId)?.authProvider !== "supabase") return { ok: true, remoteRevoked };
  const result = await removeAccount(ownerId);
  return { ...result, remoteRevoked };
}
