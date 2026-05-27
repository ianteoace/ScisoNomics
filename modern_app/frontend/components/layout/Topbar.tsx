"use client";

import { monthName } from "../../lib/format";
import { useDashboardUi } from "../../hooks/useDashboardUi";

export function Topbar() {
  const { month, year, topbarPeriodLabelOverride } = useDashboardUi();

  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4" style={{ borderColor: "rgb(var(--line))", background: "rgb(var(--panel))" }}>
      <div>
        <p className="text-xs uppercase tracking-widest" style={{ color: "rgb(var(--muted))" }}>Periodo seleccionado</p>
        <h2 className="text-xl font-bold" style={{ color: "rgb(var(--aqua))" }}>
          {topbarPeriodLabelOverride || `${monthName(month)} ${year}`}
        </h2>
      </div>
      <div className="flex-1 text-center">
        <p className="text-xl font-extrabold tracking-tight" style={{ color: "rgb(var(--warn))" }}>ScisoNomics</p>
      </div>
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400">
        Modo oscuro fijo
      </div>
    </header>
  );
}
