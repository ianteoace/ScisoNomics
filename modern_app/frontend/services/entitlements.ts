import { getActiveAccount, getActiveCloudSessionAsync, getActiveOwnerId } from "./cloudAuth";
import { API_URL, getLocalRequestHeaders } from "./http";

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
  const cached = entitlementsCache.get(ownerId);
  if (cached) return cached;
  const stored = readStoredEntitlements()[ownerId];
  if (stored) {
    entitlementsCache.set(ownerId, stored);
    return stored;
  }
  return DEFAULT_ENTITLEMENTS;
}

async function cacheLocalEntitlements(entitlements: BillingEntitlements, ownerId: string) {
  try {
    await fetch(`${API_URL}/billing/entitlements/cache`, {
      method: "POST",
      headers: await getLocalRequestHeaders({ "Content-Type": "application/json" }, ownerId),
      body: JSON.stringify(entitlements),
    });
  } catch {
    // El cache local mejora enforcement, pero la UI debe degradar a Free si falla.
  }
}

export async function loadEntitlements(options: { force?: boolean; ownerId?: string } = {}): Promise<BillingEntitlements> {
  const ownerId = options.ownerId || getActiveOwnerId();
  if (!options.force) {
    const cached = entitlementsCache.get(ownerId);
    if (cached) return cached;
  }
  if (ownerId === "local") return DEFAULT_ENTITLEMENTS;
  const account = getActiveAccount();
  if (!account || account.user.id !== ownerId) return getCachedEntitlements(ownerId);
  const session = await getActiveCloudSessionAsync();
  if (!session?.token || !CLOUD_API_URL) return getCachedEntitlements(ownerId);

  try {
    const response = await fetch(`${CLOUD_API_URL}/billing/entitlements`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const entitlements = normalizeEntitlements(await response.json());
    setCachedEntitlements(ownerId, entitlements);
    void cacheLocalEntitlements(entitlements, ownerId);
    return entitlements;
  } catch {
    return getCachedEntitlements(ownerId);
  }
}

export function canUseFeature(featureKey: PremiumFeatureKey, entitlements?: BillingEntitlements | null): boolean {
  const source = entitlements || getCachedEntitlements();
  return Boolean(source.features[featureKey]);
}
