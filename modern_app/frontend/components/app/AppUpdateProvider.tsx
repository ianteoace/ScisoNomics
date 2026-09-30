"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";

import { createNativeAppUpdater, type AppUpdater, type AppUpdateState } from "../../services/appUpdater";

const AppUpdateContext = createContext<AppUpdater | null>(null);
const FALLBACK_STATE: AppUpdateState = { status: "idle", autoCheckEnabled: true, version: null, progress: null, error: null };
const fallbackSnapshot = () => FALLBACK_STATE;
const noSubscription = () => () => undefined;

export function AppUpdateProvider({ children }: { children: React.ReactNode }) {
  const [updater, setUpdater] = useState<AppUpdater | null>(null);

  useEffect(() => {
    const instance = createNativeAppUpdater();
    setUpdater(instance);
    const timer = window.setTimeout(() => { void instance.check(); }, 2500);
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

export function AppUpdateBanner() {
  const { updater, state } = useAppUpdate();
  if (!updater || (!state.version && state.status !== "error")) return null;
  if (!["available", "downloading", "preparing", "installing", "error"].includes(state.status)) return null;

  const busy = state.status === "downloading" || state.status === "preparing" || state.status === "installing";
  return (
    <div className="mb-4 rounded-2xl border border-cyan-400/30 bg-cyan-950/30 p-4 text-sm text-cyan-50" role="status" aria-live="polite">
      <p className="font-semibold">
        {state.status === "available" ? `Nueva versión disponible: v${state.version}` :
          state.status === "downloading" ? `Descargando v${state.version}${state.progress === null ? "..." : `: ${state.progress}%`}` :
          state.status === "preparing" ? "Verificando y preparando la instalación..." :
          state.status === "installing" ? "Instalando actualización. ScisoNomics se cerrará y volverá a abrir." :
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
        <button className="btn-secondary mt-3" type="button" onClick={() => { void updater.check(true); }}>Buscar de nuevo</button>
      ) : null}
    </div>
  );
}

export function AppUpdateSettings() {
  const { updater, state } = useAppUpdate();
  const busy = state.status === "checking" || state.status === "downloading" || state.status === "preparing" || state.status === "installing";

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-3 rounded-xl border border-line bg-slate-950/30 p-4 text-sm text-slate-200">
        <input type="checkbox" checked={state.autoCheckEnabled} disabled={!updater} onChange={(event) => updater?.setAutoCheckEnabled(event.target.checked)} />
        Buscar actualizaciones automáticamente al iniciar
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn" type="button" disabled={!updater || busy} onClick={() => { void updater?.check(true); }}>
          {state.status === "checking" ? "Buscando..." : "Buscar ahora"}
        </button>
        {state.status === "up_to_date" ? <span className="text-sm text-emerald-300">Ya tenés la versión más reciente.</span> : null}
        {state.status === "available" ? <span className="text-sm text-cyan-200">Disponible: v{state.version}</span> : null}
        {state.status === "unavailable" ? <span className="text-sm text-slate-400">Disponible en la app instalada de Windows.</span> : null}
        {state.status === "error" ? <span className="text-sm text-amber-200">{state.error}</span> : null}
      </div>
    </div>
  );
}
