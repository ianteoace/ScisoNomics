"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { API_URL } from "../../services/http";
import packageJson from "../../package.json";

type HealthResponse = {
  ok: boolean;
  service?: string;
  version?: string;
  frozen?: boolean;
  error?: string;
  detail?: string;
};

type ReadyResponse = {
  ok: boolean;
  status: "ready" | "degraded" | "repair_required" | "migration_failed" | "critical";
  code?: string;
  version?: string;
  database_ready: boolean;
  checked?: boolean;
  initializing?: boolean;
  repairable?: boolean;
  sync_allowed?: boolean;
  issue_table?: string | null;
  message?: string | null;
};

const MAX_WAIT_MS = 20_000;
const RETRY_MS = 800;
const ATTEMPT_TIMEOUT_MS = 2_500;
const FRONTEND_VERSION = packageJson.version;
const REPAIR_ROUTE = "/configuracion?section=diagnostico";
const LIMITED_READY_STATUSES = new Set<ReadyResponse["status"]>(["degraded", "repair_required", "migration_failed", "critical"]);
const REPAIR_READY_STATUSES = new Set<ReadyResponse["status"]>(["repair_required", "migration_failed", "critical"]);

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function versionMajorMinor(value?: string | null) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : null;
}

function isCompatibleAppVersion(frontendVersion?: string | null, backendVersion?: string | null) {
  if (!frontendVersion || !backendVersion) return true;
  return versionMajorMinor(frontendVersion) === versionMajorMinor(backendVersion);
}

export function BackendStartupGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [errorDescription, setErrorDescription] = useState("");
  const [statusText, setStatusText] = useState("Iniciando ScisoNomics...");
  const [limitedReady, setLimitedReady] = useState<ReadyResponse | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!limitedReady || !REPAIR_READY_STATUSES.has(limitedReady.status)) return;
    if (pathname === "/configuracion") return;
    router.replace(REPAIR_ROUTE);
  }, [limitedReady, pathname, router]);

  useEffect(() => {
    let active = true;

    const run = async () => {
      setReady(false);
      setError(false);
      setErrorDescription("");
      setLimitedReady(null);
      setStatusText("Estamos preparando la aplicación y tus datos locales...");

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
            lastError = raw || "El servicio local no devolvió una respuesta válida.";
          }

          console.info("Startup health response", { attempt, status: response.status, health });

          if (response.ok && health?.ok) {
            if (health?.version && !isCompatibleAppVersion(FRONTEND_VERSION, health.version)) {
              console.error("Backend/frontend version mismatch", { frontendVersion: FRONTEND_VERSION, backendVersion: health.version });
              setErrorDescription(
                "Detectamos una incompatibilidad entre la aplicación y el servicio local. Cerrá ScisoNomics y volvé a abrirla. Si el problema continúa, reinstalá la última versión sin omitir archivos.",
              );
              setError(true);
              return;
            }
            const readyResponse = await fetch(`${API_URL}/ready`, {
              cache: "no-store",
              signal: controller.signal,
            });
            const readyRaw = await readyResponse.text();
            let readiness: ReadyResponse | null = null;
            try {
              readiness = JSON.parse(readyRaw) as ReadyResponse;
            } catch {
              lastError = readyRaw || "El servicio local no devolvió una respuesta válida.";
            }

            console.info("Startup ready response", { attempt, status: readyResponse.status, readiness });

            if (readiness?.version && !isCompatibleAppVersion(FRONTEND_VERSION, readiness.version)) {
              console.error("Backend/frontend version mismatch", { frontendVersion: FRONTEND_VERSION, backendVersion: readiness.version });
              setErrorDescription(
                "Detectamos una incompatibilidad entre la aplicación y el servicio local. Cerrá ScisoNomics y volvé a abrirla. Si el problema continúa, reinstalá la última versión sin omitir archivos.",
              );
              setError(true);
              return;
            }

            if (readiness?.status === "ready" && readiness.database_ready) {
              if (!active) return;
              console.info("Startup ready", { attempt, elapsedMs: Date.now() - startedAt });
              setLimitedReady(null);
              setReady(true);
              return;
            }

            if (readiness?.initializing || readiness?.code === "db_initializing" || readiness?.code === "db_check_pending") {
              setStatusText(readiness?.message || "Estamos preparando tu base de datos local...");
            } else if (readiness && LIMITED_READY_STATUSES.has(readiness.status)) {
              if (!active) return;
              setLimitedReady(readiness);
              setReady(true);
              return;
            } else {
              setStatusText("Estamos preparando los servicios locales...");
            }

            if (readiness?.message) {
              lastError = readiness.message;
            } else if (!readyResponse.ok) {
              lastError = `HTTP ${readyResponse.status}`;
            } else if (readyRaw) {
              lastError = readyRaw;
            }
          } else {
            setStatusText("Estamos preparando los servicios locales...");
          }

          if (health?.error || health?.detail) {
            lastError = `${health.error || ""} ${health.detail || ""}`.trim();
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
      setErrorDescription("No pudimos conectar con el servicio local. Probá reiniciar la app o intentá nuevamente en unos segundos.");
    };

    run().catch((err) => {
      if (!active) return;
      console.error("Startup gate fatal error", err);
      setError(true);
      setErrorDescription("No pudimos iniciar ScisoNomics. Probá reiniciar la app.");
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
            {errorDescription || "No pudimos conectar con el servicio local. Probá reiniciar la app o intentá nuevamente en unos segundos."}
          </p>
          <p className="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            Si estabas actualizando, no elijas omitir archivos del instalador. Cerrá ScisoNomics y scisonomics-backend.exe desde el Administrador de tareas antes de intentar nuevamente.
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
          <p className="mt-3 text-base">Estamos preparando la aplicación y tus datos locales.</p>
          <div className="mx-auto mt-6 h-10 w-10 animate-spin rounded-full border-2 border-slate-500/40 border-t-cyan-400" />
          <p className="mt-4 text-xs text-slate-400">{statusText}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {limitedReady ? (
        <div className="sticky top-0 z-40 border-b border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-semibold">
                {limitedReady.message || "ScisoNomics abrió en modo reparación porque tus datos locales necesitan una revisión."}
              </p>
              <p className="text-xs text-amber-50/80">
                Podés crear un backup, revisar o reparar los datos locales desde Datos y seguridad. La sincronización queda bloqueada hasta resolverlo.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={() => router.replace(REPAIR_ROUTE)}>
                Abrir Datos y seguridad
              </button>
              <button className="btn-secondary" onClick={() => setRetryKey((value) => value + 1)}>
                Reintentar revisión
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {children}
    </>
  );
}
