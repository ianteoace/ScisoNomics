"use client";

import { canContinuePremium, premiumStatusMessage, type PremiumSubscription } from "../../services/premiumBilling";
import { canAutoRefreshPremium } from "../../services/premiumAutoRefresh";

export function PremiumSubscriptionDetails({ subscription, premiumActive }: {
  subscription: PremiumSubscription | null; premiumActive: boolean;
}) {
  if (!subscription || subscription.status === "none") return null;
  const renewal = subscription.next_payment_date ? new Date(subscription.next_payment_date) : null;
  const showRenewal = premiumActive && subscription.status === "authorized" && renewal && Number.isFinite(renewal.getTime()) && renewal.getTime() > Date.now();
  return (
    <div className="mt-3 space-y-2 text-sm text-slate-300">
      <p>Estado: {premiumActive ? "Activo" : "Free"}</p>
      <p>{premiumActive && subscription.status !== "canceled" ? "Premium activo." : premiumStatusMessage(subscription, premiumActive)}</p>
      {showRenewal ? <p>Próxima renovación: {renewal.toLocaleDateString("es-AR")}</p> : null}
      <p className="text-slate-400">Para cancelar o administrar tu suscripción, hacelo desde tu cuenta de Mercado Pago.</p>
    </div>
  );
}

export function PremiumVerificationFallback({ subscription, premiumActive, local, busy, onVerify }: {
  subscription: PremiumSubscription | null; premiumActive: boolean; local: boolean; busy: boolean; onVerify: () => void;
}) {
  if (local || premiumActive || !canAutoRefreshPremium(subscription)) return null;
  return <button className="text-xs text-slate-400 underline underline-offset-4 hover:text-slate-200 disabled:opacity-50" type="button" disabled={busy} onClick={onVerify}>Verificar nuevamente</button>;
}

export function PremiumCheckout({ subscription, premiumActive, local, busy, onContinue }: {
  subscription: PremiumSubscription | null;
  premiumActive: boolean;
  local: boolean;
  busy: boolean;
  onContinue: () => void;
}) {
  const amount = subscription?.amount ? Number(subscription.amount) : null;
  return (
    <div className="space-y-2">
      {amount !== null && Number.isFinite(amount) && amount > 0 ? (
        <p className="text-sm font-semibold text-slate-200">{new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(amount)} / mes</p>
      ) : null}
      {!local && canContinuePremium(subscription, premiumActive) ? (
        <button className="btn" type="button" disabled={busy} onClick={onContinue}>Continuar con Mercado Pago</button>
      ) : null}
      {!premiumActive && !local ? (
        <p className="max-w-sm text-xs text-slate-400">Pago seguro procesado por Mercado Pago. Podrás elegir los medios de pago disponibles en Mercado Pago.</p>
      ) : null}
    </div>
  );
}
