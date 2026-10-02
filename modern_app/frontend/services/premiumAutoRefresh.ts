import { ACCOUNT_SESSION_CHANGED_EVENT, OWNER_CHANGED_EVENT, getActiveAccount, getActiveCloudSessionAsync, getActiveOwnerId } from "./cloudAuth";
import { getCachedEntitlements, loadEntitlements, type BillingEntitlements } from "./entitlements";
import { getPremiumSubscription, premiumStatusMessage, refreshPremiumSubscription, type PremiumSubscription } from "./premiumBilling";

export const PREMIUM_REFRESH_CHANGED_EVENT = "scisonomics:premium-refresh-changed";
export const PREMIUM_ENTITLEMENTS_CHANGED_EVENT = "scisonomics:premium-entitlements-changed";
export type PremiumRefreshState = { ownerId: string; subscription: PremiumSubscription | null; verifying: boolean; message: string };
export const hasActivePremium = (e: BillingEntitlements) => e.plan === "premium" && ["active", "trialing"].includes(e.status);
export const canAutoRefreshPremium = (s: PremiumSubscription | null) => Boolean(s && ["pending", "authorized", "uncertain"].includes(s.status));

type Dependencies = {
  owner: () => string;
  accountOwner: () => string | undefined;
  session: () => Promise<{ token: string; user: { id: string } } | null>;
  cached: (ownerId: string) => BillingEntitlements;
  subscription: (ownerId: string) => Promise<PremiumSubscription>;
  refresh: (ownerId: string) => Promise<PremiumSubscription>;
  entitlements: (ownerId: string) => Promise<BillingEntitlements>;
  publish: (state: PremiumRefreshState, entitlements?: BillingEntitlements) => void;
  now: () => number;
  schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
};

// One controller for the app, shared by automatic and manual verification.
export function createPremiumAutoRefresh(d: Dependencies) {
  let state: PremiumRefreshState = { ownerId: d.owner(), subscription: null, verifying: false, message: "" };
  let generation = 0;
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let flightGeneration = -1;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let lastRefresh = -Infinity;
  let checkoutOwner: string | null = null;
  let returnDeadline = 0;
  let busy = false;
  let deferredFocus = false;
  let activation: { ownerId: string; promise: Promise<void> } | null = null;
  const valid = (ownerId: string, version: number) => !disposed && generation === version && d.owner() === ownerId && d.accountOwner() === ownerId;
  const publish = (patch: Partial<PremiumRefreshState>, e?: BillingEntitlements) => { state = { ...state, ...patch }; d.publish(state, e); };
  const stopRetry = () => { if (retry !== null) d.clear(retry); retry = null; };

  async function verify(manual = false, attempt = 0, returned = false): Promise<void> {
    if (inFlight) { if (checkoutOwner === d.owner() || flightGeneration !== generation) deferredFocus = true; return inFlight; }
    const ownerId = d.owner(), version = generation;
    if (!valid(ownerId, version) || ownerId === "local" || !canAutoRefreshPremium(state.subscription) || hasActivePremium(d.cached(ownerId))) return;
    if (busy) { deferredFocus = true; return; }
    if (!manual && attempt === 0 && (retry !== null || (checkoutOwner !== ownerId && d.now() - lastRefresh < 3000))) return;
    stopRetry();
    returned = returned || checkoutOwner === ownerId;
    if (returned && attempt === 0) returnDeadline = d.now() + 10000;
    checkoutOwner = null;
    lastRefresh = d.now();
    flightGeneration = generation;
    inFlight = (async () => {
      try {
        const session = await d.session();
        if (!valid(ownerId, version) || !session?.token || session.user.id !== ownerId) return;
        publish({ verifying: true, message: "Verificando tu pago con Mercado Pago..." });
        let subscription = state.subscription!;
        try {
          subscription = await d.refresh(ownerId);
        } catch {
          // An uncertain creation can lack its remote ID while the webhook recovers it.
          if (subscription.status !== "uncertain") throw new Error("refresh_failed");
        }
        if (!valid(ownerId, version)) return;
        const e = await d.entitlements(ownerId);
        if (!valid(ownerId, version)) return;
        const premium = hasActivePremium(e);
        const pending = ["pending", "authorized"].includes(subscription.status) && !["rejected", "canceled"].includes(subscription.payment_status || "");
        const again = returned && !premium && pending && attempt < 3 && d.now() + 2500 <= returnDeadline;
        publish({ subscription, verifying: false, message: returned && !premium && pending && !again
          ? "El pago todavía se está confirmando. Se actualizará automáticamente cuando vuelvas a esta pantalla o podés verificar nuevamente."
          : premiumStatusMessage(subscription, premium) }, e);
        if (again) retry = d.schedule(() => {
          retry = null;
          if (!valid(ownerId, version)) return;
          if (d.now() <= returnDeadline) void verify(false, attempt + 1, true);
          else publish({ message: "El pago todavía se está confirmando. Podés verificar nuevamente." });
        }, 2500);
      } catch {
        if (valid(ownerId, version)) publish({ verifying: false, message: "No se pudo verificar el pago. Podés verificar nuevamente más tarde." });
      } finally {
        if (valid(ownerId, version) && state.verifying) publish({ verifying: false });
      }
    })();
    try { await inFlight; } finally {
      inFlight = null;
      if (!busy && deferredFocus) { deferredFocus = false; void verify(); }
    }
  }

  async function activate() {
    const ownerId = d.owner();
    if (ownerId !== state.ownerId) {
      generation++;
      activation = null;
      stopRetry();
      checkoutOwner = null;
      lastRefresh = -Infinity;
      publish({ ownerId, subscription: null, verifying: false, message: "" });
    }
    const version = generation;
    if (!valid(ownerId, version) || ownerId === "local" || state.subscription) return;
    if (activation?.ownerId === ownerId) return activation.promise;
    const promise = (async () => {
      try {
        const session = await d.session();
        if (!valid(ownerId, version) || !session?.token || session.user.id !== ownerId) return;
        const subscription = await d.subscription(ownerId);
        if (!valid(ownerId, version)) return;
        publish({ subscription });
        await verify();
      } catch { /* Offline/local mode must remain usable. */ }
    })();
    activation = { ownerId, promise };
    try { await promise; } finally { if (activation?.promise === promise) activation = null; }
  }

  return {
    state: () => state,
    verify,
    activate,
    update(subscription: PremiumSubscription) { if (state.ownerId === d.owner()) publish({ subscription }); },
    checkout(opened: boolean) { checkoutOwner = opened ? d.owner() : null; },
    setBusy(value: boolean) {
      busy = value;
      if (!busy && deferredFocus) { deferredFocus = false; void verify(); }
    },
    attach(win: EventTarget, doc: EventTarget & { visibilityState: string }) {
      disposed = false;
      state = { ...state, verifying: false };
      const focus = () => { if (doc.visibilityState === "visible") void verify(); };
      const account = () => { void activate(); };
      win.addEventListener("focus", focus);
      doc.addEventListener("visibilitychange", focus);
      win.addEventListener(OWNER_CHANGED_EVENT, account);
      win.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, account);
      void activate();
      return () => {
        disposed = true; generation++; activation = null; lastRefresh = -Infinity; stopRetry();
        win.removeEventListener("focus", focus);
        doc.removeEventListener("visibilitychange", focus);
        win.removeEventListener(OWNER_CHANGED_EVENT, account);
        win.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, account);
      };
    },
  };
}

export const premiumAutoRefresh = createPremiumAutoRefresh({
  owner: getActiveOwnerId, accountOwner: () => getActiveAccount()?.user.id,
  session: getActiveCloudSessionAsync, cached: getCachedEntitlements,
  subscription: getPremiumSubscription, refresh: refreshPremiumSubscription,
  entitlements: (ownerId) => loadEntitlements({ force: true, ownerId }),
  publish: (state, entitlements) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(PREMIUM_REFRESH_CHANGED_EVENT, { detail: state }));
    if (entitlements) window.dispatchEvent(new Event(PREMIUM_ENTITLEMENTS_CHANGED_EVENT));
  },
  now: Date.now, schedule: setTimeout, clear: clearTimeout,
});
