import type { BillingEntitlements } from "./entitlements";
import { ENTITLEMENTS_PUBLIC_KEY_PEM } from "./entitlementPublicKey";

const featureKeys = ["budgets", "saving_goals", "fixed_expenses", "planning"] as const;
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_entitlement");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
}

export function entitlementVerifier(publicKey: string) {
  let key: Promise<CryptoKey> | undefined;
  return async (token: string, ownerId: string): Promise<{ entitlements: BillingEntitlements; validUntil: number }> => {
    try {
      if (ownerId === "local" || !ownerId || typeof token !== "string" || token.length > 8192) throw new Error();
      const parts = token.split("."); if (parts.length !== 3) throw new Error();
      const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
      if (header.alg !== "RS256" || header.typ !== "JWT") throw new Error();
      const der = Uint8Array.from(atob(publicKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")), c => c.charCodeAt(0));
      key ??= crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", await key, decode(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]))) throw new Error();
      const claims = JSON.parse(new TextDecoder().decode(decode(parts[1]))), now = Math.floor(Date.now() / 1000);
      if (claims.type !== "scisonomics_entitlement" || claims.user_id !== ownerId
        || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
        || claims.iat > now + 60 || claims.exp <= now || claims.exp <= claims.iat || claims.exp > claims.iat + 86400
        || !["free", "premium"].includes(claims.plan) || !["active", "trialing", "past_due", "canceled", "expired"].includes(claims.status)) throw new Error();
      const expiry = claims.subscription_expires_at;
      if (expiry !== null && (typeof expiry !== "string" || !Number.isFinite(Date.parse(expiry)))) throw new Error();
      const enabled = claims.plan === "premium" && ["active", "trialing"].includes(claims.status) && (!expiry || Date.parse(expiry) > Date.now());
      if (!claims.features || featureKeys.some(k => claims.features[k] !== enabled)) throw new Error();
      return { entitlements: { plan: claims.plan, status: claims.status, features: claims.features, expires_at: expiry }, validUntil: claims.exp * 1000 };
    } catch { throw new Error("No pudimos verificar la licencia de esta cuenta."); }
  };
}
export const verifyEntitlementToken = entitlementVerifier(ENTITLEMENTS_PUBLIC_KEY_PEM);
