"use client";

import { useEffect, useState } from "react";

import { API_URL } from "../../services/http";

type HealthResponse = {
  ok: boolean;
  db_exists?: boolean;
  db_initialized?: boolean;
  error?: string;
  detail?: string;
};

const MAX_WAIT_MS = 60_000;
const RETRY_MS = 1_000;

export function BackendStartupGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("Iniciando backend local...");

  useEffect(() => {
    let active = true;

    const run = async () => {
      const startedAt = Date.now();
      let lastError = "Sin respuesta";
      let lastStatus: number | null = null;

      while (active && Date.now() - startedAt < MAX_WAIT_MS) {
        try {
          const response = await fetch(`${API_URL}/health`, { cache: "no-store" });
          lastStatus = response.status;
          const raw = await response.text();
          let health: HealthResponse | null = null;
          try {
            health = JSON.parse(raw) as HealthResponse;
          } catch {
            // body no JSON
          }

          if (response.ok && health?.ok && health.db_exists && health.db_initialized) {
            if (!active) return;
            setReady(true);
            return;
          }

          if (health?.ok && health.db_exists && !health.db_initialized) {
            setStatusText("Preparando base de datos...");
          } else {
            setStatusText("Iniciando backend local...");
          }

          if (health?.error || health?.detail) {
            lastError = `${health.error || ""} ${health.detail || ""}`.trim();
          } else if (!response.ok) {
            lastError = `HTTP ${response.status}`;
          } else {
            lastError = raw || "Health no listo";
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }

        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }

      if (!active) return;
      const waitedMs = Date.now() - startedAt;
      console.error("Startup gate timeout", { waitedMs, lastError, lastStatus });
      setError("No se pudo iniciar el backend local. Cerrá y abrí la app nuevamente. Si continúa, revisá los logs en %LOCALAPPDATA%\\ScisoNomics\\logs.");
    };

    run().catch((err) => {
      if (!active) return;
      console.error("Startup gate fatal error", err);
      setError("No se pudo iniciar el backend local. Cerrá y abrí la app nuevamente. Si continúa, revisá los logs en %LOCALAPPDATA%\\ScisoNomics\\logs.");
    });

    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div className="card w-full max-w-xl p-8 text-center">
          <h1 className="text-2xl font-bold">ScisoNomics</h1>
          <p className="mt-3 text-sm text-rose-300">{error}</p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div className="card w-full max-w-xl p-8 text-center">
          <h1 className="text-3xl font-bold">ScisoNomics</h1>
          <p className="mt-3 text-base">Iniciando tu espacio financiero...</p>
          <p className="mt-2 text-sm text-slate-400">Preparando la base de datos local. Esto puede tardar unos segundos la primera vez.</p>
          <div className="mx-auto mt-6 h-10 w-10 animate-spin rounded-full border-2 border-slate-500/40 border-t-cyan-400" />
          <p className="mt-4 text-xs text-slate-400">{statusText}</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
