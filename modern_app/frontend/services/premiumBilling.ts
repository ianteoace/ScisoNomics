import { getActiveAccount, getActiveCloudSessionAsync, getActiveOwnerId } from "./cloudAuth";

const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");

export type PremiumSubscription = {
  status: "none" | "creating" | "uncertain" | "pending" | "authorized" | "paused" | "canceled";
  subscription_id: string | null;
  amount: string | null;
  next_payment_date: string | null;
  paid_until: string | null;
  checkout_url: string | null;
  can_cancel: boolean;
};

async function billingRequest<T>(path: string, method: "GET" | "POST", ownerId: string, body?: object): Promise<T> {
  if (!CLOUD_API_URL || ownerId === "local" || getActiveOwnerId() !== ownerId || getActiveAccount()?.user.id !== ownerId) {
    throw new Error("Seleccioná una cuenta cloud activa para gestionar Premium.");
  }
  const session = await getActiveCloudSessionAsync();
  if (!session?.token || getActiveOwnerId() !== ownerId || session.user.id !== ownerId) {
    throw new Error("La sesión cloud no está disponible. Iniciá sesión otra vez.");
  }
  let response: Response;
  try {
    response = await fetch(`${CLOUD_API_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${session.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
  } catch {
    throw new Error("No se pudo conectar con el servicio de pagos. Probá otra vez.");
  }
  if (getActiveOwnerId() !== ownerId) throw new Error("Cambió la cuenta activa. Volvé a intentar.");
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = typeof body?.detail?.code === "string" ? body.detail.code : "";
    if (code === "subscription_already_exists") throw new Error("Ya hay una suscripción en curso para esta cuenta.");
    if (code === "already_premium") throw new Error("Esta cuenta ya tiene Premium activo.");
    if (code === "subscription_creation_unconfirmed") throw new Error("Estamos verificando el alta anterior. Contactá a soporte antes de volver a suscribirte.");
    if (code === "subscription_not_found" || code === "subscription_not_pending") throw new Error("Esta suscripción ya no está pendiente. Verificá su estado.");
    if (code === "invalid_card_token") throw new Error("No se pudo validar la tarjeta. Volvé a ingresarla.");
    if (code === "mercadopago_not_configured" || code === "billing_price_not_configured") throw new Error("Los pagos todavía no están disponibles.");
    throw new Error("No se pudo verificar la suscripción. Probá otra vez más tarde.");
  }
  return await response.json() as T;
}

export async function getPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription", "GET", ownerId);
}

export async function startPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription", "POST", ownerId);
}

export async function authorizePremiumSubscription(ownerId: string, subscriptionId: string, cardTokenId: string): Promise<PremiumSubscription> {
  if (!/^[0-9a-fA-F-]{36}$/.test(subscriptionId) || !/^[A-Za-z0-9_-]{8,200}$/.test(cardTokenId)) {
    throw new Error("No se pudo validar la tarjeta. Volvé a ingresarla.");
  }
  return billingRequest(`/billing/subscription/${subscriptionId}/authorize`, "POST", ownerId, { card_token_id: cardTokenId });
}

export async function refreshPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription/refresh", "POST", ownerId);
}

export async function cancelPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription/cancel", "POST", ownerId);
}
