import {
  beginDeviceLogin, completeDeviceEnrollment, resendDeviceEnrollment, restoreDeviceGrant,
  rememberDeviceGrant, forgetDeviceGrant, DeviceVerificationRequiredError,
  type DeviceContext, type DeviceGrant, type Enrollment,
} from "./deviceAuthorization";
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
type PendingDevice = { client: SupabaseIdentityClient; session: Session; user: CloudUser; remember: boolean; context: DeviceContext; enrollment: Enrollment; timer?: ReturnType<typeof setTimeout> };
let pendingDevice: PendingDevice | null = null;
let completingDevice = false;
const deviceListeners = new Set<() => void>();
const NO_DEVICE = { required: false as boolean, resendAt: 0, expiresAt: 0, completionVersion: 0, completedOwnerId: "" };
let deviceState = NO_DEVICE;
export const getPendingDeviceState = () => deviceState;
export const getPendingDeviceServerState = () => NO_DEVICE;
export function subscribePendingDevice(listener: () => void) { deviceListeners.add(listener); return () => { deviceListeners.delete(listener); }; }
function publishPendingDevice(value: PendingDevice | null) {
  deviceState = value ? { required: true, resendAt: Date.now() + value.enrollment.resendAvailableIn * 1000, expiresAt: Date.now() + value.enrollment.expiresIn * 1000, completionVersion: deviceState.completionVersion, completedOwnerId: "" } : { ...NO_DEVICE, completionVersion: deviceState.completionVersion };
  deviceListeners.forEach((listener) => listener());
}
export async function cancelDeviceVerification() {
  const value = pendingDevice;
  pendingDevice = null;
  if (value?.timer) clearTimeout(value.timer);
  publishPendingDevice(null);
  if (value) await disposeUnusedSupabaseClient(value.client);
}
export async function resendDeviceVerification() {
  const value = pendingDevice;
  if (!value || completingDevice) return;
  value.enrollment = await resendDeviceEnrollment(value.session.access_token, value.enrollment);
  if (pendingDevice !== value) return;
  if (value.timer) clearTimeout(value.timer);
  publishPendingDevice(value);
  value.timer = setTimeout(() => { if (pendingDevice === value) void cancelDeviceVerification(); }, value.enrollment.expiresIn * 1000);
}
export async function verifyNewDeviceCode(code: string) {
  const value = pendingDevice;
  if (!value || completingDevice) throw new DeviceVerificationRequiredError();
  completingDevice = true;
  try {
    const grant = await completeDeviceEnrollment(value.session.access_token, value.context, value.enrollment, code);
    if (pendingDevice !== value) throw new DeviceVerificationRequiredError();
    const user = await acceptAuthorizedSession(value.client, value.session, grant, value.remember);
    if (value.timer) clearTimeout(value.timer);
    pendingDevice = null;
    deviceState = { ...NO_DEVICE, completionVersion: deviceState.completionVersion + 1, completedOwnerId: user.id };
    deviceListeners.forEach((listener) => listener());
    return user;
  } finally { completingDevice = false; }
}

export type SupabaseSignUpResult =
  | { status: "account_exists" }
  | { status: "verification_required"; email: string }
  | { status: "generic_signup_error" }
  | { status: "signed_in"; user: CloudUser };

export function isSupabaseCloudAuthConfigured() {
  return isSupabaseAuthConfigured() && isCloudAuthConfigured();
}

function newClient() {
  if (!isSupabaseCloudAuthConfigured()) {
    throw new CloudAuthRequestError("El servicio de cuenta no está configurado. Podés seguir en modo local.", { code: "supabase_not_configured" });
  }
  return createSupabaseAuthClient();
}

async function withClient<T>(action: (client: SupabaseIdentityClient) => Promise<T>): Promise<T> {
  const client = newClient();
  try {
    return await action(client);
  } finally {
    if (pendingDevice?.client !== client && ![...sessions.values()].some((entry) => entry.client === client)) await client.auth.dispose();
  }
}

function providerError(error: AuthError, operation?: "verify_email" | "resend_signup"): CloudAuthRequestError {
  const code = error.code || (error.status === 429 ? "over_request_rate_limit" : "supabase_auth_failed");
  const messages: Record<string, string> = {
    invalid_credentials: "Email o contraseña incorrectos.",
    email_not_confirmed: "Confirmá tu correo antes de iniciar sesión.",
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
    ? "No pudimos conectar con el servicio de cuenta. Intentá nuevamente."
    : "No se pudo completar el inicio de sesión."), {
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

async function storeSession(user: CloudUser, session: Session, makeActive: boolean, persistent = false, grant?: DeviceGrant) {
  await addOrUpdateAccount({ user, tokens: {
    accessToken: grant?.access_token || session.access_token, expiresAt: grant ? new Date(Date.now() + grant.expires_in * 1000).toISOString() : expiresAt(session), tokenType: session.token_type || "bearer",
    // Refresh tokens never enter cloudAuth, sessionStorage or localStorage.
  } }, { authProvider: "supabase", remember: persistent, makeActive, externalPersistenceVerified: persistent });
}

async function acceptSession(client: SupabaseIdentityClient, session: Session | null, remember = isSupabaseSecureStorageAvailable()): Promise<CloudUser> {
  if (!session?.access_token || !session.refresh_token) {
    throw new CloudAuthRequestError("No recibimos una sesión válida.", { code: "supabase_session_missing", kind: "auth" });
  }
  const user = await resolveInternalUser(session.access_token, true);
  await cancelDeviceVerification();
  const result = await beginDeviceLogin(session.access_token, user);
  if (result.enrollment) {
    const value: PendingDevice = { client, session, user, remember, context: result.context, enrollment: result.enrollment };
    pendingDevice = value; publishPendingDevice(value);
    value.timer = setTimeout(() => { if (pendingDevice === value) void cancelDeviceVerification(); }, result.enrollment.expiresIn * 1000);
    throw new DeviceVerificationRequiredError();
  }
  return acceptAuthorizedSession(client, session, result.grant!, remember);
}

async function acceptAuthorizedSession(client: SupabaseIdentityClient, session: Session, grant: DeviceGrant, remember: boolean): Promise<CloudUser> {
  const user = grant.user;
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
      if (!deleted.ok) throw new CloudAuthRequestError("No pudimos quitar la sesión recordada. Intentá nuevamente.", { code: "supabase_secure_storage_failed" });
    }
    if (sessions.get(user.id) !== entry) throw new CloudAuthRequestError("Este acceso fue reemplazado. Volvé a iniciar sesión.", { code: "supabase_login_replaced", kind: "auth" });
    rememberDeviceGrant(user.id, grant);
    await storeSession(user, session, true, remember, grant);
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
  if (pendingDevice?.client !== client && ![...sessions.values()].some((entry) => entry.client === client)) await client.auth.dispose();
}

export async function signUpWithPassword(email: string, password: string, displayName?: string, options: { remember?: boolean } = {}): Promise<SupabaseSignUpResult> {
  return withClient(async (client): Promise<SupabaseSignUpResult> => {
    const normalizedEmail = email.trim();
    const { data, error } = await client.auth.signUp({
      email: normalizedEmail, password, options: { data: { display_name: displayName?.trim() || undefined } },
    });
    if (error) {
      // Only a structured provider code can justify the explicit account message.
      if (error.code === "email_exists" || error.code === "user_already_exists") return { status: "account_exists" };
      if (error.code === "weak_password" || error.status === 429 || !error.status || error.status >= 500) throw providerError(error);
      return { status: "generic_signup_error" };
    }
    if (data.session) return { status: "signed_in", user: await acceptSession(client, data.session, options.remember) };
    // With email confirmation, Supabase can return an obfuscated user for an
    // existing email. Empty/missing identities cannot prove what happened;
    // never turn that anti-enumeration response into an "account exists" signal.
    if (!data.user?.identities?.some((identity) => identity.provider === "email")) return { status: "generic_signup_error" };
    return { status: "verification_required", email: normalizedEmail };
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
    const { data, error: verificationError } = await client.auth.verifyOtp({ email: email.trim(), token: token.trim(), type: "recovery" });
    if (verificationError) throw providerError(verificationError);
    if (!data.session?.access_token || data.session.user.email?.trim().toLowerCase() !== email.trim().toLowerCase()) {
      throw new CloudAuthRequestError("El código no confirmó esta cuenta. Pedí uno nuevo e intentá nuevamente.", { code: "recovery_identity_invalid", kind: "auth" });
    }
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
  let grant: DeviceGrant;
  try {
    grant = await restoreDeviceGrant(data.session.access_token, ownerId);
  } catch (failure) {
    if (sessions.get(ownerId) !== entry) return null;
    if (failure instanceof CloudAuthRequestError && ["device_revoked", "device_verification_required", "internal_identity_mismatch", "device_proof_invalid"].includes(failure.code || "")) {
      // Revocation/lost identity cannot retain a restorable refresh token.
      await removeAccount(ownerId);
    }
    throw failure;
  }
  const user = grant.user;
  if (sessions.get(ownerId) !== entry) return null;
  if (entry.persistent) await saveSupabaseRefreshToken(ownerId, entry.refreshToken);
  rememberDeviceGrant(ownerId, grant);
  if (sessions.get(ownerId) !== entry || !getStoredAccounts().some((account) => account.user.id === ownerId && account.authProvider === "supabase")) return null;
  await storeSession(user, data.session, false, entry.persistent, grant);
  const updatedAccount = getStoredAccounts().find((item) => item.user.id === ownerId)!;
  return { ...updatedAccount, token: grant.access_token, tokenType: "bearer", expiresAt: new Date(Date.now() + grant.expires_in * 1000).toISOString() };
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
  forgetDeviceGrant(ownerId);
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
