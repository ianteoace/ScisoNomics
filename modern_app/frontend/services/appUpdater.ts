import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type AppUpdateStatus = "idle" | "checking" | "available" | "up_to_date" | "downloading" | "preparing" | "installing" | "error" | "unavailable";

export type AppUpdateState = {
  status: AppUpdateStatus;
  autoCheckEnabled: boolean;
  version: string | null;
  progress: number | null;
  error: string | null;
};

type UpdateCandidate = Pick<Update, "version" | "download" | "install" | "close">;

export type AppUpdaterDependencies = {
  supported: () => boolean;
  check: () => Promise<UpdateCandidate | null>;
  prepareInstall: () => Promise<void>;
  restartAfterFailedInstall: () => Promise<void>;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
};

export const AUTO_CHECK_KEY = "scisonomics_auto_update_check_v1";
export const DISMISSED_UPDATE_KEY = "scisonomics_dismissed_update_v1";

function getStoredValue(storage: AppUpdaterDependencies["storage"], key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function setStoredValue(storage: AppUpdaterDependencies["storage"], key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {
    // A storage failure must not block a signed update.
  }
}

export function isPackagedTauriApp() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && process.env.NODE_ENV === "production";
}

export function describeUpdateError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  if (/sincronizacion de cierre|cierre seguro|backend local sigue|cierre.*tardo/i.test(detail)) {
    return "No se pudo cerrar la app de forma segura para actualizar. Tus datos siguen disponibles; intentá de nuevo más tarde.";
  }
  if (/signature|minisign|verify|verification|public key/i.test(detail)) {
    return "La firma de la actualización no es válida. No se instalará el archivo.";
  }
  if (/network|fetch|connect|timeout|timed out|dns|offline|request|http status/i.test(detail)) {
    return "No pudimos conectar con el servidor de actualizaciones. Revisá tu conexión e intentá de nuevo.";
  }
  if (/json|metadata|manifest|semver|version|parse|format|release/i.test(detail)) {
    return "La información de la actualización publicada no es válida. Intentá de nuevo más tarde.";
  }
  return "No pudimos completar la actualización. Intentá de nuevo más tarde.";
}

export function createAppUpdater(dependencies: AppUpdaterDependencies) {
  const listeners = new Set<() => void>();
  let candidate: UpdateCandidate | null = null;
  let checkPromise: Promise<void> | null = null;
  let installPromise: Promise<void> | null = null;
  let state: AppUpdateState = {
    status: "idle",
    autoCheckEnabled: getStoredValue(dependencies.storage, AUTO_CHECK_KEY) !== "false",
    version: null,
    progress: null,
    error: null,
  };

  function publish(patch: Partial<AppUpdateState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }

  async function releaseCandidate() {
    const old = candidate;
    candidate = null;
    if (old) await old.close().catch(() => undefined);
  }

  async function check(manual = false) {
    if (installPromise) return installPromise;
    if (checkPromise) return checkPromise;
    if (!dependencies.supported()) {
      if (manual) publish({ status: "unavailable", error: null });
      return;
    }
    if (!manual && !state.autoCheckEnabled) return;
    checkPromise = (async () => {
      publish({ status: "checking", error: null });
      await releaseCandidate();
      try {
        const found = await dependencies.check();
        if (!found) {
          publish({ status: "up_to_date", version: null });
          return;
        }
        candidate = found;
        const dismissed = getStoredValue(dependencies.storage, DISMISSED_UPDATE_KEY) === found.version;
        publish({ status: dismissed && !manual ? "idle" : "available", version: found.version });
      } catch (error) {
        publish({ status: manual ? "error" : "idle", error: manual ? describeUpdateError(error) : null });
      }
    })().finally(() => { checkPromise = null; });
    return checkPromise;
  }

  function postpone() {
    if (!candidate || state.status !== "available") return;
    setStoredValue(dependencies.storage, DISMISSED_UPDATE_KEY, candidate.version);
    publish({ status: "idle", error: null });
  }

  async function install() {
    if (installPromise) return installPromise;
    if (!candidate || state.status !== "available") return;
    const update = candidate;
    installPromise = (async () => {
      let prepared = false;
      let downloaded = 0;
      let total: number | null = null;
      try {
        publish({ status: "downloading", progress: null, error: null });
        await update.download((event: DownloadEvent) => {
          if (event.event === "Started") total = event.data.contentLength ?? null;
          if (event.event === "Progress") downloaded += event.data.chunkLength;
          if (event.event === "Finished") publish({ progress: 100 });
          else if (total && total > 0) publish({ progress: Math.min(99, Math.round(downloaded * 100 / total)) });
        });
        // The native updater verifies the downloaded signature before download resolves.
        publish({ status: "preparing", progress: 100 });
        await dependencies.prepareInstall();
        prepared = true;
        publish({ status: "installing" });
        await update.install();
      } catch (error) {
        const message = describeUpdateError(error);
        if (prepared) {
          publish({ status: "error", error: `${message} La app se reiniciará para restaurar el backend local.` });
          try {
            await dependencies.restartAfterFailedInstall();
          } catch {
            publish({ status: "error", error: `${message} Cerrá y volvé a abrir ScisoNomics para restaurar el backend local.` });
          }
        } else {
          publish({ status: "error", error: message });
        }
      }
    })().finally(() => { installPromise = null; });
    return installPromise;
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    check,
    install,
    postpone,
    setAutoCheckEnabled(enabled: boolean) {
      setStoredValue(dependencies.storage, AUTO_CHECK_KEY, String(enabled));
      publish({ autoCheckEnabled: enabled });
    },
    async dispose() {
      await releaseCandidate();
      listeners.clear();
    },
  };
}

export function createNativeAppUpdater() {
  let storage: AppUpdaterDependencies["storage"] = null;
  try {
    if (typeof window !== "undefined") storage = window.localStorage;
  } catch {
    // Browser privacy settings may disable localStorage.
  }
  return createAppUpdater({
    supported: isPackagedTauriApp,
    storage,
    check: async () => (await import("@tauri-apps/plugin-updater")).check(),
    prepareInstall: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("prepare_update_install");
    },
    restartAfterFailedInstall: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restart_after_failed_update_install");
    },
  });
}

export type AppUpdater = ReturnType<typeof createAppUpdater>;
