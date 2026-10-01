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
  payment_status?: "approved" | "rejected" | "pending" | "in_process" | "canceled" | null;
  payment_status_detail?: "cc_rejected_high_risk" | null;
};

export function canContinuePremium(subscription: PremiumSubscription | null, premiumActive: boolean): boolean {
  return !premiumActive && (!subscription || ["none", "creating", "canceled"].includes(subscription.status) || (subscription.status === "pending" && Boolean(subscription.checkout_url)));
}

export function premiumStatusMessage(subscription: PremiumSubscription, premiumActive: boolean): string {
  if (premiumActive) return "Premium activado.";
  if (subscription.status === "canceled") return "La suscripción fue cancelada.";
  if (subscription.payment_status === "rejected") {
    return subscription.payment_status_detail === "cc_rejected_high_risk"
      ? "El pago fue rechazado por una validación de seguridad de Mercado Pago. Probá más tarde o con otro medio de pago."
      : "El pago fue rechazado por Mercado Pago. Probá otro medio de pago.";
  }
  switch (subscription.status) {
    case "creating": return "Continuá con Mercado Pago para completar el alta.";
    case "uncertain": return "Estamos verificando el alta. No intentes crear otra suscripción; contactá a soporte si persiste.";
    case "pending": return "Completá el pago en Mercado Pago.";
    case "authorized": return "Suscripción autorizada. Esperando confirmación del cobro.";
    case "paused": return "La suscripción está pausada en Mercado Pago.";
    default: return "Todavía no hay una suscripción activa.";
  }
}

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
    if (code === "mercadopago_not_configured" || code === "billing_price_not_configured") throw new Error("Los pagos todavía no están disponibles.");
    throw new Error("No se pudo verificar la suscripción. Probá otra vez más tarde.");
  }
  const result = await response.json() as T;
  if (getActiveOwnerId() !== ownerId) throw new Error("Cambió la cuenta activa. Volvé a intentar.");
  return result;
}

export async function getPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription", "GET", ownerId);
}

export async function startPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription", "POST", ownerId);
}

function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Reserve the browser tab during the click, before awaiting the backend response.
export function preparePremiumCheckoutWindow(): Window | null {
  if (typeof window === "undefined" || isDesktop()) return null;
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

export async function openPremiumCheckout(ownerId: string, subscription: PremiumSubscription, tab: Window | null = null): Promise<void> {
  try {
    if (ownerId === "local" || getActiveOwnerId() !== ownerId || getActiveAccount()?.user.id !== ownerId) throw new Error("Cambió la cuenta activa. Volvé a intentar.");
    const raw = subscription.checkout_url || "";
    const url = new URL(raw);
    if (subscription.status !== "pending" || raw !== raw.trim() || /[\\\s]/.test(raw)
      || url.protocol !== "https:" || !["www.mercadopago.com.ar", "www.mercadopago.com"].includes(url.host)
      || url.username || url.password || url.pathname !== "/subscriptions/checkout" || url.hash
      || url.searchParams.getAll("preapproval_id").length !== 1 || !/^[A-Za-z0-9_-]{1,100}$/.test(url.searchParams.get("preapproval_id") || "")
      || url.searchParams.has("preapproval_plan_id")) throw new Error("invalid_checkout");
    if (isDesktop()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      if (getActiveOwnerId() !== ownerId) throw new Error("account_changed");
      await openUrl(raw);
    } else {
      const checkoutTab = tab || preparePremiumCheckoutWindow();
      if (checkoutTab) {
        checkoutTab.opener = null;
        checkoutTab.location.replace(raw);
      } else {
        window.location.assign(raw);
      }
    }
  } catch {
    tab?.close();
    throw new Error("No se pudo abrir el checkout de Mercado Pago. Verificá la cuenta activa y probá otra vez.");
  }
}

export async function refreshPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription/refresh", "POST", ownerId);
}

export async function cancelPremiumSubscription(ownerId: string): Promise<PremiumSubscription> {
  return billingRequest("/billing/subscription/cancel", "POST", ownerId);
}
