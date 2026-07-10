"use client";

import type { ReactNode } from "react";

export function PremiumGate({
  enabled,
  title = "Esta función forma parte de ScisoNomics Premium",
  description = "Podés ver tus datos existentes, pero para crear o editar necesitás una suscripción Premium.",
  actionLabel = "Actualizar a Premium",
  onUpgrade,
  children,
}: {
  enabled: boolean;
  title?: string;
  description?: string;
  actionLabel?: string;
  onUpgrade?: () => void;
  children?: ReactNode;
}) {
  if (enabled) return <>{children}</>;
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4">
        <p className="text-sm font-semibold text-amber-100">{title}</p>
        <p className="mt-1 text-sm text-amber-200/90">{description}</p>
        <button className="btn mt-3" type="button" onClick={onUpgrade}>
          {actionLabel}
        </button>
      </div>
      {children ? <div>{children}</div> : null}
    </div>
  );
}
