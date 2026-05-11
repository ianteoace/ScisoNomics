"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { monthName } from "../../lib/format";
import { useDashboardUi } from "../../hooks/useDashboardUi";

export function Topbar() {
  const { month, year, topbarPeriodLabelOverride } = useDashboardUi();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
      <div className="flex items-center gap-2">
        <button
          className="btn-secondary p-2"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          aria-label="Cambiar tema"
        >
          {mounted && resolvedTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  );
}
