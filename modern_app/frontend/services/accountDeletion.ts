import { cloudRequest, CloudAuthRequestError, getActiveOwnerId, removeAccount, switchToLocalMode } from "./cloudAuth";
import { getSession, forgetSession } from "./supabaseCloudAuth";
import { deletedIdentityCleanup, signAccountDeletion } from "./deviceAuthorization";
import { forgetAccountEntitlements } from "./entitlements";

export type DeletionIntent = { requestId: string; capability: string; expiresIn: number; resendAvailableIn: number };
export type DeletionResult = { status: "deleted"; external_auth_status: "deleted" | "pending" | "not_applicable"; billing_retained: boolean; cleanupComplete?: boolean };
type Challenge = Parameters<typeof signAccountDeletion>[1];
const cleanupJobs = new Map<string, Promise<boolean>>();

export function forgetDeletedAccount(ownerId: string): Promise<boolean> {
  if (!cleanupJobs.has(ownerId)) {
    const identityCleanup = deletedIdentityCleanup(ownerId);
    // Hide the namespace immediately, even if native cleanup needs a retry.
    if (getActiveOwnerId() === ownerId) switchToLocalMode();
    forgetSession(ownerId);
    forgetAccountEntitlements(ownerId);
    const job = (async () => {
      let ok = true;
      try { ok = (await removeAccount(ownerId)).ok; } catch { ok = false; }
      try { ok = Boolean(await identityCleanup()) && ok; } catch { ok = false; }
      return ok;
    })().finally(() => cleanupJobs.delete(ownerId));
    cleanupJobs.set(ownerId, job);
  }
  return cleanupJobs.get(ownerId)!;
}

async function activeSession(ownerId: string) {
  if (getActiveOwnerId() !== ownerId) throw new CloudAuthRequestError("La cuenta activa cambió. Volvé a abrir la confirmación.", {code:"owner_changed"});
  const session = await getSession(ownerId);
  if (!session || session.user.id !== ownerId || getActiveOwnerId() !== ownerId) throw new CloudAuthRequestError("Iniciá sesión y autorizá este dispositivo antes de eliminar tu cuenta.",{code:"session_required",kind:"auth"});
  return session;
}

export async function requestAccountDeletion(ownerId: string): Promise<DeletionIntent> {
  const session = await activeSession(ownerId);
  return cloudRequest<DeletionIntent>("/account/delete/request",{method:"POST",headers:{Authorization:`Bearer ${session.token}`},body:"{}"});
}

export function accountDeletionOperation(ownerId: string, intent: DeletionIntent) {
  // Retain an exact in-memory request for a lost-response retry after internal
  // deletion. Never put token, OTP, signature or capability in browser storage.
  let submitted: { token: string; body: string } | undefined;
  let running: Promise<DeletionResult> | undefined;
  let completed: DeletionResult | undefined;
  async function complete(code: string, confirmation: string): Promise<DeletionResult> {
    if (completed) return completed;
    if (confirmation !== "ELIMINAR" || !/^[0-9]{6}$/.test(code.trim())) throw new CloudAuthRequestError("Escribí ELIMINAR e ingresá el código de seis dígitos.");
    if (getActiveOwnerId() !== ownerId) throw new CloudAuthRequestError("La cuenta activa cambió. Volvé a abrir la confirmación.",{code:"owner_changed"});
    if (!submitted) {
      const session = await activeSession(ownerId);
      const challenge = await cloudRequest<Challenge>("/account/delete/challenge",{method:"POST",headers:{Authorization:`Bearer ${session.token}`},body:JSON.stringify({requestId:intent.requestId,capability:intent.capability})});
      const proof = await signAccountDeletion(ownerId, challenge);
      if (getActiveOwnerId() !== ownerId) throw new CloudAuthRequestError("La cuenta activa cambió. No se envió la eliminación.",{code:"owner_changed"});
      submitted = {token:session.token,body:JSON.stringify({requestId:intent.requestId,capability:intent.capability,confirmation,code:code.trim(),challenge,proof})};
    }
    let result: DeletionResult;
    try {
      result = await cloudRequest<DeletionResult>("/account/delete/complete",{method:"POST",headers:{Authorization:`Bearer ${submitted.token}`},body:submitted.body});
    } catch (failure) {
      // An explicit rejection did not delete. A connection failure is ambiguous;
      // only the identical request can safely recover its receipt.
      if (failure instanceof CloudAuthRequestError && failure.kind !== "network" && failure.kind !== "timeout") submitted = undefined;
      throw failure;
    }
    if (result?.status !== "deleted" || !["deleted","pending","not_applicable"].includes(result.external_auth_status)) throw new CloudAuthRequestError("No pudimos confirmar el resultado de la eliminación.");
    const cleanupComplete = await forgetDeletedAccount(ownerId);
    completed = {...result,cleanupComplete};
    return completed;
  }
  return { complete(code: string, confirmation: string) {
    if (!running) running = complete(code,confirmation).finally(() => { running=undefined; });
    return running;
  } };
}
