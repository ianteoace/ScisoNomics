import { getActiveAccount, getActiveCloudSessionAsync, getActiveOwnerId } from "./cloudAuth";

const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");

export type PremiumSubscription = {
  status: "none" | "creating" | "uncertain" | "pending" | "authorized" | "paused" | "canceled";
  next_payment_date: string | null;
  paid_until: string | null;
  checkout_url: string | null;
  can_cancel: boolean;
};

function checkoutUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Mercado Pago no devolvió un enlace válido.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Mercado Pago no devolvió un enlace válido."); }
  if (url.protocol !== "https:" || url.username || url.password || !["www.mercadopago.com.ar", "www.mercadopago.com"].includes(url.hostname) || url.pathname !== "/subscriptions/checkout") {
    throw new Error("Mercado Pago no devolvió un enlace válido.");
  }
  return url.toString();
}

async function billingRequest<T>(path: string, method: "GET" | "POST", ownerId: string): Promise<T> {
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
      headers: { Authorization: `Bearer ${session.token}` },
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
    if (code === "mercadopago_not_configured" || code === "billing_price_not_configured") throw new Error("Los pagos todavía no están disponibles.");
    throw new Error("No se pudo verificar la suscripción. Probá otra vez más tarde.");
  }
  return await response.json() as T;
}

export async function getPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription", "GET", ownerId);
}

export async function startPremiumSubscription(ownerId: string): Promise<string> {
  const result = await billingRequest<{ checkout_url: string }>("/billing/subscription", "POST", ownerId);
  return checkoutUrl(result.checkout_url);
}

export async function refreshPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription/refresh", "POST", ownerId);
}

export async function cancelPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription/cancel", "POST", ownerId);
}

export async function openPremiumCheckout(url: string): Promise<void> {
  const safeUrl = checkoutUrl(url);
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(safeUrl);
    return;
  }
  if (typeof window !== "undefined") window.open(safeUrl, "_blank", "noopener,noreferrer");
}
