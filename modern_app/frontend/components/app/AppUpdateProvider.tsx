"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";

import { createNativeAppUpdater, type AppUpdater, type AppUpdateState } from "../../services/appUpdater";

export const AppUpdateContext = createContext<AppUpdater | null>(null);
const FALLBACK_STATE: AppUpdateState = { status: "idle", autoCheckEnabled: true, version: null, progress: null, error: null };
const fallbackSnapshot = () => FALLBACK_STATE;
const noSubscription = () => () => undefined;

export function AppUpdateProvider({ children }: { children: React.ReactNode }) {
  const [updater, setUpdater] = useState<AppUpdater | null>(null);

  useEffect(() => {
    const instance = createNativeAppUpdater();
    setUpdater(instance);
    const timer = window.setTimeout(() => { void instance.checkOnStartup(); }, 2500);
    return () => {
      window.clearTimeout(timer);
      void instance.dispose();
    };
  }, []);

  return <AppUpdateContext.Provider value={updater}>{children}</AppUpdateContext.Provider>;
}

export function useAppUpdate() {
  const updater = useContext(AppUpdateContext);
  const state = useSyncExternalStore(updater?.subscribe ?? noSubscription, updater?.getState ?? fallbackSnapshot, fallbackSnapshot);
  return { updater, state };
}

// Feedback belongs to the initiating component, never to the global updater store.
export function useManualUpdateCheck(updater: AppUpdater | null, notify = false) {
  const pathname = usePathname();
  const [feedback, setFeedback] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const inFlight = useRef(false);
  const notification = useRef<string | number | null>(null);
  useEffect(() => {
    active.current = true;
    setFeedback(null);
    return () => {
      active.current = false;
      generation.current++;
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (notification.current !== null) toast.dismiss(notification.current);
    };
  }, [pathname]);
  async function check() {
    if (!updater || inFlight.current) return;
    inFlight.current = true;
    const requestGeneration = generation.current;
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (notification.current !== null) toast.dismiss(notification.current);
    setFeedback(null);
    try {
      const result = await updater.check(true);
      if (!active.current || generation.current !== requestGeneration || !result.message) return;
      setFeedback(result.message);
      if (notify) notification.current = toast.info(result.message, { duration: 4000 });
      timer.current = window.setTimeout(() => { setFeedback(null); timer.current = null; }, 4000);
    } finally {
      inFlight.current = false;
    }
  }
  return { check, feedback };
}

export function AppUpdateBanner() {
  const { updater, state } = useAppUpdate();
  const manual = useManualUpdateCheck(updater, true);
  if (!updater || (!state.version && state.status !== "error")) return null;
  if (!["available", "downloading", "preparing", "installing", "ready", "error"].includes(state.status)) return null;

  const busy = state.status === "downloading" || state.status === "preparing" || state.status === "installing";
  return (
    <div className="mb-4 rounded-2xl border border-cyan-400/30 bg-cyan-950/30 p-4 text-sm text-cyan-50" role="status" aria-live="polite">
      <p className="font-semibold">
        {state.status === "available" ? `Nueva versión disponible: v${state.version}` :
          state.status === "downloading" ? `Descargando v${state.version}${state.progress === null ? "..." : `: ${state.progress}%`}` :
          state.status === "preparing" ? "Verificando y preparando la instalación..." :
          state.status === "installing" ? "Instalando actualización. ScisoNomics se cerrará y volverá a abrir." :
          state.status === "ready" ? "La actualización se instaló. Cerrá y volvé a abrir ScisoNomics." :
          "No se pudo completar la actualización"}
      </p>
      {state.error ? <p className="mt-2 text-amber-200">{state.error}</p> : null}
      {state.status === "available" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn" type="button" onClick={() => { void updater.install(); }}>Actualizar ahora</button>
          <button className="btn-secondary" type="button" onClick={updater.postpone}>Más tarde</button>
        </div>
      ) : null}
      {state.status === "error" && !busy ? (
        <button className="btn-secondary mt-3" type="button" onClick={() => { void manual.check(); }}>Buscar de nuevo</button>
      ) : null}
    </div>
  );
}

export function AppUpdateSettings() {
  const { updater, state } = useAppUpdate();
  const manual = useManualUpdateCheck(updater);
  const busy = state.status === "checking" || state.status === "downloading" || state.status === "preparing" || state.status === "installing" || state.status === "ready";

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-3 rounded-xl border border-line bg-slate-950/30 p-4 text-sm text-slate-200">
        <input type="checkbox" checked={state.autoCheckEnabled} disabled={!updater} onChange={(event) => updater?.setAutoCheckEnabled(event.target.checked)} />
        Buscar actualizaciones automáticamente al iniciar
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn" type="button" disabled={!updater || busy} onClick={() => { void manual.check(); }}>
          {state.status === "checking" ? "Buscando actualizaciones..." : "Buscar ahora"}
        </button>
        {manual.feedback ? <span className="text-sm text-slate-200" role="status">{manual.feedback}</span> : null}
        {state.status === "available" ? <span className="text-sm text-cyan-200">Disponible: v{state.version}</span> : null}
        {state.status === "error" ? <span className="text-sm text-amber-200">{state.error}</span> : null}
      </div>
    </div>
  );
}
