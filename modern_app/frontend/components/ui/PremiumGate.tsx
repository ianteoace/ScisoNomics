"use client";

import type { ReactNode } from "react";

export function PremiumGate({
  enabled,
  title = "Esta función es parte de ScisoNomics Premium",
  description = "Actualizá a Premium para usar Presupuestos, Metas, Gastos fijos y Planificación.",
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
      <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 shadow-lg shadow-amber-950/20">
        <p className="text-sm font-semibold text-amber-100">{title}</p>
        <p className="mt-1 text-sm text-amber-200/90">{description}</p>
        <button className="btn mt-3" type="button" onClick={onUpgrade}>
          {actionLabel}
        </button>
      </div>
      {children ? (
        <div className="relative overflow-hidden rounded-3xl">
          <div className="pointer-events-none select-none blur-sm opacity-40 saturate-50" aria-hidden="true">
            {children}
          </div>
          <div className="absolute inset-0 bg-slate-950/35" aria-hidden="true" />
        </div>
      ) : (
        <div className="rounded-3xl border border-line bg-slate-950/30 p-10 text-center text-sm text-slate-400">
          Esta vista se habilita con ScisoNomics Premium.
        </div>
      )}
    </div>
  );
}
