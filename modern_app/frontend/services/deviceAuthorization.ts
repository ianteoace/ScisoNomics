import { CloudAuthRequestError, cloudRequest, type CloudUser } from "./cloudAuth";
import { getRuntimePlatformSync } from "./platform";
import { getSupabaseProjectUrl } from "../lib/supabase";

type Identity = { formatVersion: 1; deviceId: string; publicKey: string; publicKeyHash: string };
type Proof = Identity & { signature: string };
type Challenge = { challengeId: string; nonce: string; issuedAt: number; expiresAt: number;
  familyId: string | null; targetDeviceId: string | null; requestHash: string | null };
export type DeviceGrant = { user: CloudUser; access_token: string; expires_in: number;
  deviceId: string; familyId: string; accountBinding: string };
export type Enrollment = { status: "pending_verification"; verificationId: string;
  verificationToken: string; expiresIn: number; resendAvailableIn: number };
export type DeviceContext = { userId: string; accountBinding: string; identity: Identity };
type Metadata = { version: 1; accountBinding: string; deviceId: string; familyId: string };
export type AccountDevice = { device_id: string; device_name: string; platform: string | null;
  status: "trusted" | "revoked"; created_at: string; last_seen_at: string; revoked_at: string | null; current: boolean };

export class DeviceVerificationRequiredError extends CloudAuthRequestError {
  constructor() { super("Verificá tu correo para autorizar este dispositivo.", { code: "device_verification_required", kind: "auth" }); }
}

const metadata = new Map<string, Metadata>();
function key(owner: string) {
  // Public metadata only. Namespace prevents another project/backend borrowing it.
  return `scisonomics.device.v1:${encodeURIComponent(getSupabaseProjectUrl())}:${encodeURIComponent(process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "")}:${owner}`;
}

async function native<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const platform = getRuntimePlatformSync();
  if (platform === "browser" || platform === "ios") throw new CloudAuthRequestError(
    "La verificación segura de dispositivos no está disponible en esta plataforma. Podés seguir en modo local.",
    { code: "device_storage_unavailable", kind: "auth" });
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, args);
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      const message = typeof error === "string" ? error : "";
      const code = message.includes("not allowed") ? "native_command_denied"
        : /^device_identity_[a-z_]+$/.test(message) ? message : "native_command_failed";
      // Never log the rejection body or invoke arguments (binding/challenge/OTP).
      console.info("[device-auth]", { stage: "native_invoke", command, code });
    }
    throw new CloudAuthRequestError("No pudimos acceder a la identidad segura del dispositivo. Intentá nuevamente.", { code: "device_storage_failed" });
  }
}

export function deviceRequest<T>(token: string, path: string, body?: unknown): Promise<T> {
  return cloudRequest<T>(`/auth/devices${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 30000);
}

function validGrant(grant: DeviceGrant, context: DeviceContext): DeviceGrant {
  if (grant.user?.id !== context.userId || grant.accountBinding !== context.accountBinding
    || grant.deviceId !== context.identity.deviceId || !grant.access_token || !grant.familyId || grant.expires_in <= 0) {
    throw new CloudAuthRequestError("La autorización no corresponde a esta cuenta y dispositivo.", { code: "internal_identity_mismatch", kind: "auth" });
  }
  return grant;
}

export async function beginDeviceLogin(token: string, user: CloudUser): Promise<{ context: DeviceContext; enrollment?: Enrollment; grant?: DeviceGrant }> {
  const server = await deviceRequest<{ userId: string; accountBinding: string; mode: string }>(token, "/context");
  if (server.userId !== user.id || server.mode !== "enforce") throw new CloudAuthRequestError(
    "El servidor todavía no permite verificar dispositivos de forma segura. Podés seguir en modo local.", { code: "device_verification_unavailable" });
  const { identity } = await native<{ identity: Identity }>("get_or_create_account_device_identity", { accountBinding: server.accountBinding });
  const context = { userId: user.id, accountBinding: server.accountBinding, identity };
  const platform = getRuntimePlatformSync();
  const result = await deviceRequest<Enrollment | { status: "trusted"; challenge: Challenge }>(token, "/login", {
    identity, platform: platform === "desktop" ? "windows" : platform,
    name: platform === "android" ? "ScisoNomics Android" : "ScisoNomics Desktop",
  });
  if (result.status === "pending_verification") return { context, enrollment: result };
  const proof = await native<Proof>("sign_device_authentication_proof", { accountBinding: context.accountBinding, challenge: result.challenge });
  return { context, grant: validGrant(await deviceRequest<DeviceGrant>(token, "/authentication/complete", { challenge: result.challenge, proof }), context) };
}

export async function completeDeviceEnrollment(token: string, context: DeviceContext, enrollment: Enrollment, code: string) {
  if (!/^[0-9]{6}$/.test(code.trim())) throw new CloudAuthRequestError("Ingresá el código de seis dígitos.", { code: "device_otp_invalid" });
  const continuation = { verificationId: enrollment.verificationId, verificationToken: enrollment.verificationToken };
  const challenge = await deviceRequest<Challenge>(token, "/enrollment/challenge", continuation);
  const proof = await native<Proof>("sign_device_enrollment_proof", { accountBinding: context.accountBinding, challenge });
  return validGrant(await deviceRequest<DeviceGrant>(token, "/enrollment/complete", { ...continuation, challenge, proof, code: code.trim() }), context);
}

export async function resendDeviceEnrollment(token: string, enrollment: Enrollment) {
  return deviceRequest<Enrollment>(token, "/resend", { verificationId: enrollment.verificationId, verificationToken: enrollment.verificationToken });
}

export function rememberDeviceGrant(owner: string, grant: DeviceGrant) {
  const value: Metadata = { version: 1, accountBinding: grant.accountBinding, deviceId: grant.deviceId, familyId: grant.familyId };
  // No token, public/private key, OTP, nonce or verification continuation here.
  window.localStorage.setItem(key(owner), JSON.stringify(value));
  metadata.set(owner, value);
}

function readMetadata(owner: string): Metadata {
  let value: Metadata | null;
  try { value = metadata.get(owner) || JSON.parse(window.localStorage.getItem(key(owner)) || "null"); }
  catch { value = null; }
  if (!value || value.version !== 1 || typeof value.accountBinding !== "string" || typeof value.deviceId !== "string" || typeof value.familyId !== "string") {
    throw new CloudAuthRequestError("Volvé a iniciar sesión para verificar este dispositivo.", { code: "device_verification_required", kind: "auth" });
  }
  return value;
}

export function forgetDeviceGrant(owner: string) {
  metadata.delete(owner);
  window.localStorage.removeItem(key(owner));
  // Normal logout keeps the native identity; known devices do not need a new OTP.
}

export async function restoreDeviceGrant(token: string, owner: string) {
  const saved = readMetadata(owner);
  const { identity } = await native<{ identity: Identity }>("get_or_create_account_device_identity", { accountBinding: saved.accountBinding });
  if (identity.deviceId !== saved.deviceId) throw new CloudAuthRequestError("La identidad local cambió. Volvé a iniciar sesión.", { code: "device_verification_required", kind: "auth" });
  const challenge = await deviceRequest<Challenge>(token, "/refresh/challenge", { deviceId: saved.deviceId, familyId: saved.familyId });
  const proof = await native<Proof>("sign_refresh_proof", { accountBinding: saved.accountBinding, challenge });
  return validGrant(await deviceRequest<DeviceGrant>(token, "/refresh/complete", { challenge, proof }), { userId: owner, accountBinding: saved.accountBinding, identity });
}

export async function listAccountDevices(token: string) {
  return (await deviceRequest<{ devices: AccountDevice[] }>(token, "")).devices;
}

export async function manageAccountDevice(token: string, owner: string, targetDeviceId: string, purpose: "device_rename" | "device_revoke", name?: string, confirmCurrent = false) {
  const saved = readMetadata(owner);
  const challenge = await deviceRequest<Challenge>(token, "/management/challenge", { deviceId: saved.deviceId, familyId: saved.familyId, targetDeviceId, purpose, ...(name === undefined ? {} : { name }) });
  const proof = await native<Proof>("sign_device_management_proof", { accountBinding: saved.accountBinding, challenge, purpose });
  return deviceRequest<{ ok: boolean; currentRevoked: boolean }>(token, "/management/complete", { challenge, proof, ...(name === undefined ? {} : { name }), confirmCurrent });
}
