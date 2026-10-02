import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type AppUpdateStatus = "idle" | "checking" | "available" | "downloading" | "preparing" | "installing" | "ready" | "error";
export type AppUpdateCheckResult = { status: "up_to_date" | "available" | "error" | "unavailable" | "skipped"; message?: string };

export type AppUpdateState = {
  status: AppUpdateStatus;
  autoCheckEnabled: boolean;
  version: string | null;
  progress: number | null;
  error: string | null;
};

type UpdateCandidate = Pick<Update, "currentVersion" | "rawJson" | "version" | "download" | "install" | "close">;

export type AppUpdaterDependencies = {
  supported: () => boolean;
  check: () => Promise<UpdateCandidate | null>;
  prepareInstall: () => Promise<void>;
  restartAfterFailedInstall: () => Promise<void>;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
};

export const AUTO_CHECK_KEY = "scisonomics_auto_update_check_v1";
export const DISMISSED_UPDATE_KEY = "scisonomics_dismissed_update_v1";
export const UPDATE_CHECK_TIMEOUT_MS = 15000;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 300000;

function parseVersion(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match || value.length > 128) throw new Error("invalid manifest version");
  const pre = match[4]?.split(".") || [];
  if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) throw new Error("invalid manifest version");
  return { core: match.slice(1, 4).map((part) => BigInt(part)), pre };
}

export function isNewerAppVersion(remote: string, current: string): boolean {
  const a = parseVersion(remote), b = parseVersion(current);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length && Boolean(b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] !== undefined;
    if (a.pre[i] === b.pre[i]) continue;
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i]);
    if (an !== bn) return !an;
    return an ? BigInt(a.pre[i]) > BigInt(b.pre[i]) : a.pre[i] > b.pre[i];
  }
  return false;
}

function validateCandidate(update: UpdateCandidate) {
  const raw = update.rawJson;
  const platforms = raw?.platforms as Record<string, { url?: unknown; signature?: unknown }> | undefined;
  const platform = platforms?.["windows-x86_64"];
  const expected = `https://github.com/ianteoace/scisonomics/releases/download/${encodeURIComponent(`v${update.version}`)}/${encodeURIComponent(`ScisoNomics_${update.version}_x64-setup.exe`)}`;
  if (raw?.version !== update.version || platform?.url !== expected
    || typeof platform.signature !== "string" || platform.signature.length < 80 || !/^[A-Za-z0-9+/]+={0,2}$/.test(platform.signature)) {
    throw new Error("invalid manifest metadata");
  }
}

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
  let checkPromise: Promise<AppUpdateCheckResult> | null = null;
  let installPromise: Promise<void> | null = null;
  let disposed = false;
  let hasChecked = false;
  let manualRequested = false;
  let state: AppUpdateState = {
    status: "idle",
    autoCheckEnabled: getStoredValue(dependencies.storage, AUTO_CHECK_KEY) !== "false",
    version: null,
    progress: null,
    error: null,
  };

  function publish(patch: Partial<AppUpdateState>) {
    if (disposed) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }

  async function releaseCandidate() {
    const old = candidate;
    candidate = null;
    if (old) await old.close().catch(() => undefined);
  }

  async function check(manual = false): Promise<AppUpdateCheckResult> {
    if (disposed || installPromise || state.status === "ready" || state.status === "installing") return { status: "skipped" };
    if (checkPromise) { manualRequested ||= manual; return checkPromise; }
    if (!dependencies.supported()) {
      return { status: "unavailable", message: "Disponible en la app instalada de Windows." };
    }
    if (!manual && !state.autoCheckEnabled) return { status: "skipped" };
    hasChecked = true;
    manualRequested = manual;
    checkPromise = (async () => {
      publish({ status: "checking", error: null });
      let found: UpdateCandidate | null = null;
      try {
        found = await dependencies.check();
        if (disposed) {
          if (found) await found.close().catch(() => undefined);
          return { status: "skipped" } as AppUpdateCheckResult;
        }
        if (!found || !isNewerAppVersion(found.version, found.currentVersion)) {
          if (found) await found.close().catch(() => undefined);
          await releaseCandidate();
          publish({ status: "idle", version: null, progress: null });
          return { status: "up_to_date", message: "ScisoNomics está actualizado." } as AppUpdateCheckResult;
        }
        validateCandidate(found);
        await releaseCandidate();
        if (disposed) { await found.close().catch(() => undefined); return { status: "skipped" } as AppUpdateCheckResult; }
        candidate = found;
        const dismissed = getStoredValue(dependencies.storage, DISMISSED_UPDATE_KEY) === found.version;
        publish({ status: dismissed && !manualRequested ? "idle" : "available", version: found.version });
        return { status: "available" } as AppUpdateCheckResult;
      } catch (error) {
        if (found && found !== candidate) await found.close().catch(() => undefined);
        publish({ status: candidate ? "available" : "idle", error: null, progress: null });
        return { status: "error", message: describeUpdateError(error) } as AppUpdateCheckResult;
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
    if (disposed || checkPromise || !candidate || state.status !== "available") return;
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
        }, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });
        if (disposed) return;
        // The native updater verifies the downloaded signature before download resolves.
        publish({ status: "preparing", progress: 100 });
        await dependencies.prepareInstall();
        prepared = true;
        if (disposed) { await dependencies.restartAfterFailedInstall(); return; }
        publish({ status: "installing" });
        await update.install();
        publish({ status: "ready" });
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
    checkOnStartup: () => hasChecked ? Promise.resolve<AppUpdateCheckResult>({ status: "skipped" }) : check(),
    install,
    postpone,
    setAutoCheckEnabled(enabled: boolean) {
      setStoredValue(dependencies.storage, AUTO_CHECK_KEY, String(enabled));
      publish({ autoCheckEnabled: enabled });
    },
    async dispose() {
      disposed = true;
      listeners.clear();
      // Do not close a native resource still being used by a check or download.
      await Promise.allSettled([checkPromise, installPromise].filter(Boolean));
      await releaseCandidate();
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
    check: async () => (await import("@tauri-apps/plugin-updater")).check({ timeout: UPDATE_CHECK_TIMEOUT_MS, allowDowngrades: false }),
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
