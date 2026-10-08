import { getActiveAccount, getActiveCloudSessionAsync, getActiveOwnerId, handleDeletedAccountResponse } from "./cloudAuth";
import { API_URL, getLocalRequestHeaders } from "./http";
import { getRuntimePlatformSync } from "./platform";
import { verifyEntitlementToken } from "./signedEntitlements";

export type PremiumFeatureKey = "budgets" | "saving_goals" | "fixed_expenses" | "planning";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "expired";
export type PlanType = "free" | "premium";

export type BillingEntitlements = {
  plan: PlanType;
  status: SubscriptionStatus;
  features: Record<PremiumFeatureKey, boolean>;
  expires_at: string | null;
};

const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");
const ENTITLEMENTS_STORAGE_KEY = "scisonomics_entitlements_by_owner_v1";
const SIGNED_STORAGE_KEY = "scisonomics_signed_entitlements_by_owner_v1";
const signedExpiry = new Map<string, number>();
export const ENTITLEMENTS_CHANGED_EVENT = "scisonomics:entitlements-changed";
const mobileRuntime = () => ["android", "ios"].includes(getRuntimePlatformSync());
export const entitlementValidUntil = (ownerId:string) => signedExpiry.get(ownerId)||0;
const DEFAULT_ENTITLEMENTS: BillingEntitlements = {
  plan: "free",
  status: "active",
  features: {
    budgets: false,
    saving_goals: false,
    fixed_expenses: false,
    planning: false,
  },
  expires_at: null,
};

const entitlementsCache = new Map<string, BillingEntitlements>();
const entitlementsRequestVersion = new Map<string, number>();

function normalizeEntitlements(raw: unknown): BillingEntitlements {
  const source = raw && typeof raw === "object" ? raw as Record<string, any> : {};
  const featureSource = source.features && typeof source.features === "object" ? source.features as Record<string, any> : {};
  return {
    plan: source.plan === "premium" ? "premium" : "free",
    status: ["active", "trialing", "past_due", "canceled", "expired"].includes(String(source.status || ""))
      ? source.status
      : "active",
    features: {
      budgets: Boolean(featureSource.budgets),
      saving_goals: Boolean(featureSource.saving_goals),
      fixed_expenses: Boolean(featureSource.fixed_expenses),
      planning: Boolean(featureSource.planning),
    },
    expires_at: typeof source.expires_at === "string" && source.expires_at.trim() ? source.expires_at : null,
  };
}

function readStoredEntitlements(): Record<string, BillingEntitlements> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ENTITLEMENTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const normalized: Record<string, BillingEntitlements> = {};
    for (const [ownerId, value] of Object.entries(parsed)) normalized[ownerId] = normalizeEntitlements(value);
    return normalized;
  } catch {
    return {};
  }
}

function writeStoredEntitlements(next: Record<string, BillingEntitlements>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENTITLEMENTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // La persistencia de entitlements no debe bloquear la UI.
  }
}

function setCachedEntitlements(ownerId: string, entitlements: BillingEntitlements) {
  const normalized = normalizeEntitlements(entitlements);
  entitlementsCache.set(ownerId, normalized);
  const stored = readStoredEntitlements();
  stored[ownerId] = normalized;
  writeStoredEntitlements(stored);
}

export function getCachedEntitlements(ownerId = getActiveOwnerId()): BillingEntitlements {
  if (mobileRuntime()) {
    return (signedExpiry.get(ownerId) || 0) > Date.now() ? entitlementsCache.get(ownerId) || DEFAULT_ENTITLEMENTS : DEFAULT_ENTITLEMENTS;
  }
  const cached = entitlementsCache.get(ownerId);
  if (cached) return cached;
  const stored = readStoredEntitlements()[ownerId];
  if (stored) {
    entitlementsCache.set(ownerId, stored);
    return stored;
  }
  return DEFAULT_ENTITLEMENTS;
}

export function forgetAccountEntitlements(ownerId: string) {
  if (ownerId === "local") return;
  entitlementsRequestVersion.set(ownerId, (entitlementsRequestVersion.get(ownerId) || 0) + 1);
  entitlementsCache.delete(ownerId);
  signedExpiry.delete(ownerId);
  try { const stored=JSON.parse(localStorage.getItem(SIGNED_STORAGE_KEY)||"{}");delete stored[ownerId];localStorage.setItem(SIGNED_STORAGE_KEY,JSON.stringify(stored)); } catch { /* Untrusted cache cannot prevent logout. */ }
  const stored = readStoredEntitlements();
  delete stored[ownerId];
  writeStoredEntitlements(stored);
}

async function cacheLocalEntitlements(ownerId: string) {
  try {
    const session = await getActiveCloudSessionAsync();
    if (!session?.token || session.user.id !== ownerId || getActiveOwnerId() !== ownerId) return;
    const headers = await getLocalRequestHeaders({ "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, ownerId);
    if (getActiveOwnerId() !== ownerId) return;
    await fetch(`${API_URL}/billing/entitlements/cache`, {
      method: "POST",
      headers,
      body: JSON.stringify({ refresh: true }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // El cache local mejora enforcement, pero la UI debe degradar a Free si falla.
  }
}

export async function loadEntitlements(options: { force?: boolean; ownerId?: string } = {}): Promise<BillingEntitlements> {
  const ownerId = options.ownerId || getActiveOwnerId();
  if (!options.force) {
    const cached = entitlementsCache.get(ownerId);
    if (cached && (!mobileRuntime() || (signedExpiry.get(ownerId)||0)>Date.now())) return cached;
  }
  if (ownerId === "local") return DEFAULT_ENTITLEMENTS;
  const requestVersion = (entitlementsRequestVersion.get(ownerId) || 0) + 1;
  entitlementsRequestVersion.set(ownerId, requestVersion);
  const isCurrent = () => getActiveOwnerId() === ownerId && entitlementsRequestVersion.get(ownerId) === requestVersion;
  if (mobileRuntime()) {
    try {
      const token=JSON.parse(localStorage.getItem(SIGNED_STORAGE_KEY)||"{}")[ownerId];
      if(token){const verified=await verifyEntitlementToken(token,ownerId);if(isCurrent()){entitlementsCache.set(ownerId,verified.entitlements);signedExpiry.set(ownerId,verified.validUntil);}}
    } catch { if(isCurrent()){signedExpiry.delete(ownerId);entitlementsCache.delete(ownerId);} }
  }
  if (!isCurrent()) return getCachedEntitlements(ownerId);
  const account = getActiveAccount();
  if (!account || account.user.id !== ownerId) return getCachedEntitlements(ownerId);
  const session = await getActiveCloudSessionAsync();
  if (!session?.token || session.user.id !== ownerId || !isCurrent() || !CLOUD_API_URL) return getCachedEntitlements(ownerId);

  try {
    const response = await fetch(`${CLOUD_API_URL}/billing/entitlements`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 410) {
        const closed = await response.json().catch(() => null);
        if (closed?.detail?.code === "account_deleted") await handleDeletedAccountResponse(`Bearer ${session.token}`);
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const payload=await response.json();
    const verified=mobileRuntime()?await verifyEntitlementToken(payload.entitlement_token,ownerId):null;
    const entitlements = verified?.entitlements || normalizeEntitlements(payload);
    if (getActiveOwnerId() !== ownerId || getActiveAccount()?.user.id !== ownerId || entitlementsRequestVersion.get(ownerId) !== requestVersion) return getCachedEntitlements(ownerId);
    if(verified){
      entitlementsCache.set(ownerId,entitlements);signedExpiry.set(ownerId,verified.validUntil);
      try { const stored=JSON.parse(localStorage.getItem(SIGNED_STORAGE_KEY)||"{}");stored[ownerId]=payload.entitlement_token;localStorage.setItem(SIGNED_STORAGE_KEY,JSON.stringify(stored)); } catch { /* Memory only remains bounded by expiry. */ }
    }else{setCachedEntitlements(ownerId, entitlements);await cacheLocalEntitlements(ownerId);}
    if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent(ENTITLEMENTS_CHANGED_EVENT));
    return entitlements;
  } catch {
    return getCachedEntitlements(ownerId);
  }
}

export function canUseFeature(featureKey: PremiumFeatureKey, entitlements?: BillingEntitlements | null): boolean {
  const source = entitlements || getCachedEntitlements();
  return Boolean(source.features[featureKey]);
}
