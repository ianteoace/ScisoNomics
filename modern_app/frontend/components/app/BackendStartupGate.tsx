"use client";

import { useEffect, useState } from "react";

import { API_URL } from "../../services/http";

type HealthResponse = {
  ok: boolean;
  version?: string;
  frozen?: boolean;
  db_exists?: boolean;
  db_initialized?: boolean;
  database_ready?: boolean;
  initializing?: boolean;
  database_error?: string | null;
  error?: string;
  detail?: string;
};

const MAX_WAIT_MS = 20_000;
const RETRY_MS = 800;
const ATTEMPT_TIMEOUT_MS = 2_500;
const FRONTEND_VERSION = "3.0.2";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBackendReady(health: HealthResponse | null) {
  if (!health?.ok) return false;
  if (health.database_ready === false) return false;
  if (health.db_exists === false) return false;
  if (health.db_initialized === false) return false;
  return true;
}

export function BackendStartupGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [errorDescription, setErrorDescription] = useState("");
  const [statusText, setStatusText] = useState("Iniciando ScisoNomics...");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;

    const run = async () => {
      setReady(false);
      setError(false);
      setErrorDescription("");
      setStatusText("Estamos preparando la aplicacion y tus datos locales...");

      const startedAt = Date.now();
      let lastError = "Sin respuesta";
      let lastStatus: number | null = null;
      let attempt = 0;

      while (active && Date.now() - startedAt < MAX_WAIT_MS) {
        attempt += 1;
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

        try {
          console.info("Startup health attempt", { attempt, url: `${API_URL}/health` });
          const response = await fetch(`${API_URL}/health`, {
            cache: "no-store",
            signal: controller.signal,
          });
          lastStatus = response.status;

          const raw = await response.text();
          let health: HealthResponse | null = null;
          try {
            health = JSON.parse(raw) as HealthResponse;
          } catch {
            lastError = raw || "El servicio local no devolvio una respuesta valida.";
          }

          console.info("Startup health response", { attempt, status: response.status, health });

          if (response.ok && isBackendReady(health)) {
            if (health?.frozen && health.version && health.version !== FRONTEND_VERSION) {
              console.error("Backend/frontend version mismatch", { frontendVersion: FRONTEND_VERSION, backendVersion: health.version });
              setErrorDescription(
                "Detectamos que el servicio local no coincide con la version instalada. Cerra ScisoNomics y volve a abrirla. Si el problema continua, reinstala la ultima version sin omitir archivos.",
              );
              setError(true);
              return;
            }
            if (!active) return;
            console.info("Startup health ready", { attempt, elapsedMs: Date.now() - startedAt });
            setReady(true);
            return;
          }

          if (health?.initializing || health?.database_ready === false || health?.db_initialized === false) {
            setStatusText("Estamos preparando tu base de datos local...");
          } else {
            setStatusText("Estamos preparando los servicios locales...");
          }

          if (health?.database_error || health?.error || health?.detail) {
            lastError = `${health.database_error || ""} ${health.error || ""} ${health.detail || ""}`.trim();
          } else if (!response.ok) {
            lastError = `HTTP ${response.status}`;
          } else if (raw) {
            lastError = raw;
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          console.info("Startup health pending", { attempt, error: lastError });
        } finally {
          window.clearTimeout(timeoutId);
        }

        await wait(RETRY_MS);
      }

      if (!active) return;
      console.error("Startup gate timeout", {
        waitedMs: Date.now() - startedAt,
        attempts: attempt,
        lastError,
        lastStatus,
      });
      setError(true);
      setErrorDescription("No pudimos conectar con el servicio local. Proba reiniciar la app o intenta nuevamente en unos segundos.");
    };

    run().catch((err) => {
      if (!active) return;
      console.error("Startup gate fatal error", err);
      setError(true);
      setErrorDescription("No pudimos iniciar ScisoNomics. Proba reiniciar la app.");
    });

    return () => {
      active = false;
    };
  }, [retryKey]);

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <div className="card w-full max-w-xl p-8 text-center">
          <h1 className="text-2xl font-bold">No se pudo iniciar ScisoNomics.</h1>
          <p className="mt-3 text-sm text-slate-300">
            {errorDescription || "No pudimos conectar con el servicio local. Proba reiniciar la app o intenta nuevamente en unos segundos."}
          </p>
          <p className="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            Si estabas actualizando, no elijas omitir archivos del instalador. Cerra ScisoNomics y scisonomics-backend.exe desde el Administrador de tareas antes de intentar nuevamente.
          </p>
          <button className="btn mt-5" onClick={() => setRetryKey((value) => value + 1)}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <div className="card w-full max-w-xl p-8 text-center">
          <h1 className="text-3xl font-bold">Iniciando ScisoNomics</h1>
          <p className="mt-3 text-base">Estamos preparando la aplicacion y tus datos locales.</p>
          <div className="mx-auto mt-6 h-10 w-10 animate-spin rounded-full border-2 border-slate-500/40 border-t-cyan-400" />
          <p className="mt-4 text-xs text-slate-400">{statusText}</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
