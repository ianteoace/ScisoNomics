"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AccountPanel } from "../../../components/account/AccountPanel";
import { ErrorState } from "../../../components/ui/ErrorState";
import { LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { Modal } from "../../../components/ui/Modal";
import packageJson from "../../../package.json";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import { createEncryptedSecurityCopyWithSaveDialog, createSecurityCopyWithSaveDialog } from "../../../services/backupDownload";
import { ACCOUNT_SESSION_CHANGED_EVENT, OWNER_CHANGED_EVENT, getActiveAccount, getActiveCloudSessionAsync, getActiveOwnerId } from "../../../services/cloudAuth";
import { loadEntitlements, type BillingEntitlements } from "../../../services/entitlements";
import {
  SYNC_STATE_CHANGED_EVENT,
  getLastAutoSyncAt,
  getLastManualSyncAt,
  getLastSyncError,
  getAutoSyncIntervalMs,
  getLocalDbIntegrity,
  createLocalBackup,
  repairLocalDb,
  isAutoSyncEnabled,
  runManualSync,
  setAutoSyncEnabled,
  setAutoSyncIntervalMs,
  type SyncOverview,
  type LocalDbIntegrityResult,
} from "../../../services/cloudSync";
import { API_URL, getLocalRequestHeaders } from "../../../services/http";
import type { BackupState, SettingsInfo } from "../../../types/domain";

const ONBOARDING_REOPEN_EVENT = "scisonomics:open-onboarding-guides";
const RELEASES_URL = "https://github.com/ianteoace/scisonomics/releases";
const ONBOARDING_SECTION_KEYS = [
  "scisonomics_onboarding_inicio_seen",
  "scisonomics_onboarding_movimientos_seen",
  "scisonomics_onboarding_presupuestos_seen",
  "scisonomics_onboarding_metas_seen",
  "scisonomics_onboarding_gastos_fijos_seen",
  "scisonomics_onboarding_planificacion_seen",
  "scisonomics_onboarding_calendario_seen",
  "scisonomics_onboarding_estadisticas_seen",
  "scisonomics_onboarding_reporte_mensual_seen",
  "scisonomics_onboarding_configuracion_seen",
] as const;

const SETTINGS_SECTIONS = [
  { id: "general", label: "General", hint: "Estado y accesos" },
  { id: "cuenta", label: "Cuenta", hint: "Multicuentas" },
  { id: "sync", label: "Sincronización", hint: "Manual y automática" },
  { id: "datos", label: "Datos y backups", hint: "Datos locales y copias" },
  { id: "diagnostico", label: "Datos y seguridad", hint: "Integridad y backups" },
  { id: "actualizaciones", label: "Actualizaciones", hint: "Releases manuales" },
  { id: "acerca", label: "Acerca de", hint: "Versión y novedades" },
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

type AppDiagnostics = {
  ok: boolean;
  version: string;
  database_ready: boolean;
  initializing: boolean;
  database_error?: string | null;
  db_status?: "ready" | "degraded" | "repair_required" | "migration_failed" | "critical";
  db_code?: string;
  repairable?: boolean;
  sync_allowed?: boolean;
  message?: string | null;
  database_path: string;
  data_dir: string;
  backups_path: string;
  logs_path: string;
  db_exists?: boolean;
  frozen?: boolean;
};

const APP_VERSION = packageJson.version;

function versionMajorMinor(value?: string | null) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : null;
}

function areVersionsCompatible(appVersion?: string | null, backendVersion?: string | null) {
  if (!appVersion || !backendVersion) return true;
  return versionMajorMinor(appVersion) === versionMajorMinor(backendVersion);
}

function isSettingsSection(value: string | null): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

function StatusPill({ value }: { value: string }) {
  return (
    <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-xs font-semibold text-cyan-200">
      {value}
    </span>
  );
}

export default function ConfiguracionPage() {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("general");
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [syncOverview, setSyncOverview] = useState<SyncOverview | null>(null);
  const [localIntegrity, setLocalIntegrity] = useState<LocalDbIntegrityResult | null>(null);
  const [backupState, setBackupState] = useState<BackupState | null>(null);
  const [entitlements, setEntitlements] = useState<BillingEntitlements | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [syncingNow, setSyncingNow] = useState(false);
  const [autoSyncEnabled, setAutoSyncEnabledState] = useState(false);
  const [autoSyncIntervalMs, setAutoSyncIntervalMsState] = useState(15 * 60 * 1000);
  const [selectedRestorePath, setSelectedRestorePath] = useState<string | null>(null);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [diagnosticText, setDiagnosticText] = useState<string | null>(null);
  const [checkingLocalIntegrity, setCheckingLocalIntegrity] = useState(false);
  const [creatingLocalBackup, setCreatingLocalBackup] = useState(false);
  const [repairingLocalDb, setRepairingLocalDb] = useState(false);
  const [encryptedBackupOpen, setEncryptedBackupOpen] = useState(false);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupPassphraseConfirm, setBackupPassphraseConfirm] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [creatingEncryptedBackup, setCreatingEncryptedBackup] = useState(false);
  const [windowsProtectionOpen, setWindowsProtectionOpen] = useState(false);
  const [enablingWindowsProtection, setEnablingWindowsProtection] = useState(false);
  const { showError, showSuccess } = useToast();

  function selectSection(section: SettingsSectionId) {
    setActiveSection(section);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("section", section);
    url.searchParams.delete("panel");
    window.history.replaceState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
  }

  async function load() {
    setLoading(true);
    try {
      const settings = await api.settingsInfo();
      setInfo(settings);
      const [diagnosticsResult, overviewResult, integrityResult, backupsResult] = await Promise.all([
        fetch(`${API_URL}/app/diagnostics`, { cache: "no-store", headers: await getLocalRequestHeaders() })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
        fetch(`${API_URL}/sync/overview`, { cache: "no-store", headers: await getLocalRequestHeaders() })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
        getLocalDbIntegrity().catch(() => null),
        api.backups().catch(() => null),
      ]);
      const entitlementsResult = await loadEntitlements({ force: true }).catch(() => null);
      setDiagnostics(diagnosticsResult as AppDiagnostics | null);
      setSyncOverview(overviewResult as SyncOverview | null);
      setLocalIntegrity(integrityResult as LocalDbIntegrityResult | null);
      setBackupState(backupsResult);
      setEntitlements(entitlementsResult);
      setAutoSyncEnabledState(isAutoSyncEnabled());
      setAutoSyncIntervalMsState(getAutoSyncIntervalMs());
      setLoadError("");
    } catch (e: any) {
      setLoadError(e?.message || "No se pudo cargar la configuración.");
      showError(e?.message || "No se pudo cargar la configuración.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("section");
    if (isSettingsSection(requested)) setActiveSection(requested);
    if (params.get("panel") === "cuenta") setActiveSection("cuenta");
    try {
      if (window.sessionStorage.getItem("scisonomics_open_account_panel") === "1") {
        window.sessionStorage.removeItem("scisonomics_open_account_panel");
        setActiveSection("cuenta");
      }
    } catch {
      // La cuenta opcional no debe bloquear Configuracion si sessionStorage falla.
    }
    void load();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = () => void load();
    const openAccountSection = () => selectSection("cuenta");
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, refresh);
    window.addEventListener(OWNER_CHANGED_EVENT, refresh);
    window.addEventListener(SYNC_STATE_CHANGED_EVENT, refresh);
    window.addEventListener("scisonomics:open-account-panel", openAccountSection);
    return () => {
      window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, refresh);
      window.removeEventListener(OWNER_CHANGED_EVENT, refresh);
      window.removeEventListener(SYNC_STATE_CHANGED_EVENT, refresh);
      window.removeEventListener("scisonomics:open-account-panel", openAccountSection);
    };
  }, []);

  async function handleCreateSecurityCopy() {
    try {
      await createSecurityCopyWithSaveDialog();
      showSuccess("Copia de seguridad creada correctamente.");
    } catch (error) {
      console.error("Error creando copia de seguridad:", error);
      showError(error instanceof Error ? error.message : "No se pudo crear la copia de seguridad.");
    }
  }

  async function handleCreateEncryptedSecurityCopy() {
    if (backupPassphrase.length < 12) {
      showError("La clave debe tener al menos 12 caracteres.");
      return;
    }
    if (backupPassphrase !== backupPassphraseConfirm) {
      showError("Las claves no coinciden.");
      return;
    }
    setCreatingEncryptedBackup(true);
    try {
      await createEncryptedSecurityCopyWithSaveDialog(backupPassphrase);
      setEncryptedBackupOpen(false);
      setBackupPassphrase("");
      setBackupPassphraseConfirm("");
      showSuccess("Copia cifrada creada correctamente. Guarda la clave en un lugar seguro.");
    } catch (error) {
      showError(error instanceof Error ? error.message : "No se pudo crear la copia cifrada.");
    } finally {
      setCreatingEncryptedBackup(false);
    }
  }

  async function handleEnableWindowsProtection() {
    setEnablingWindowsProtection(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<boolean>("enable_windows_data_protection");
      setWindowsProtectionOpen(false);
      showSuccess("Windows protegió la base local y los backups con tu cuenta de usuario.");
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error || "No se pudo activar la protección de Windows."));
    } finally {
      setEnablingWindowsProtection(false);
    }
  }

  async function handlePickRestoreFile() {
    try {
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (!isTauri) {
        showError("La restauración de copia de seguridad está disponible solo en la app de escritorio.");
        return;
      }

      const [{ open }] = await Promise.all([import("@tauri-apps/plugin-dialog")]);
      const selected = await open({
        multiple: false,
        filters: [{ name: "Copia de ScisoNomics", extensions: ["db", "sciso-backup"] }],
      });
      if (!selected) return;

      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path || !(path.toLowerCase().endsWith(".db") || path.toLowerCase().endsWith(".sciso-backup"))) {
        showError("Debés seleccionar una copia .db o .sciso-backup válida.");
        return;
      }
      setSelectedRestorePath(path);
    } catch (error) {
      console.error("Error seleccionando copia de seguridad:", error);
      showError("No se pudo seleccionar la copia de seguridad.");
    }
  }

  async function handleConfirmRestore() {
    if (!selectedRestorePath || restoring) return;
    setRestoring(true);
    try {
      const encrypted = selectedRestorePath.toLowerCase().endsWith(".sciso-backup");
      if (encrypted && restorePassphrase.length < 12) {
        showError("Ingresa la clave de la copia cifrada.");
        return;
      }
      await api.restoreBackupFromPath(selectedRestorePath, encrypted ? restorePassphrase : undefined);
      setSelectedRestorePath(null);
      setRestorePassphrase("");
      showSuccess("Copia restaurada correctamente. Reinicia ScisoNomics para aplicar los cambios.");
    } catch (error: any) {
      console.error("Error restaurando copia de seguridad:", error);
      const message = typeof error?.message === "string" ? error.message : "";
      const normalized = message.toLowerCase();
      if (
        normalized.includes("sqlite") ||
        normalized.includes("estructura mínima") ||
        normalized.includes("archivo .db") ||
        normalized.includes("vacía") ||
        normalized.includes("no existe") ||
        normalized.includes("no es un archivo")
      ) {
        showError("No se pudo restaurar la copia de seguridad. Verificá que el archivo sea una copia válida de ScisoNomics.");
      } else if (normalized.includes("base de datos está en uso")) {
        showError("No se pudo restaurar porque tus datos están en uso. Cerrá y volvé a abrir ScisoNomics.");
      } else {
        showError("No se pudo restaurar la copia de seguridad. Intentá nuevamente o elegí otra copia.");
      }
    } finally {
      setRestoring(false);
    }
  }

  async function handleManualSync() {
    const session = await getActiveCloudSessionAsync();
    if (!session) {
      showError("Iniciá sesión para sincronizar.");
      return;
    }
    setSyncingNow(true);
    try {
      const result = await runManualSync(session.user.email);
      await load();
      if (result.rejectedTotal) showError("Algunos datos no pudieron sincronizarse y necesitan revisión.");
      else showSuccess("Sincronización completada.");
    } catch (error) {
      showError(error instanceof Error ? error.message : "No se pudo sincronizar.");
    } finally {
      setSyncingNow(false);
    }
  }

  async function handleReviewLocalData() {
    setCheckingLocalIntegrity(true);
    try {
      const result = await getLocalDbIntegrity();
      setLocalIntegrity(result);
      if (result.status === "healthy") showSuccess("Tus datos locales están correctos.");
      else if (result.status === "warning") showError("Encontramos datos locales que conviene reparar antes de continuar.");
      else showError("Tus datos locales requieren reparación antes de sincronizar.");
    } catch {
      showError("No pudimos revisar tus datos locales. Cerrá y volvé a abrir ScisoNomics.");
    } finally {
      setCheckingLocalIntegrity(false);
    }
  }

  async function handleCreateLocalBackup() {
    setCreatingLocalBackup(true);
    try {
      await createLocalBackup();
      setBackupState(await api.backups());
      showSuccess("Backup creado correctamente.");
    } catch {
      showError("No pudimos crear el backup local. Intenta nuevamente.");
    } finally {
      setCreatingLocalBackup(false);
    }
  }

  async function handleRepairLocalData() {
    setRepairingLocalDb(true);
    try {
      const result = await repairLocalDb();
      setLocalIntegrity(await getLocalDbIntegrity());
      setBackupState(await api.backups());
      if (result.ok && result.unresolved_count === 0) showSuccess("Reparación completada. No se eliminaron datos financieros.");
      else showError("Creamos un backup, pero algunos problemas requieren revisión manual.");
    } catch {
      setLocalIntegrity(await getLocalDbIntegrity().catch(() => null));
      setBackupState(await api.backups().catch(() => null));
      showError("Creamos un backup antes de revisar. Algunos problemas requieren revisión manual.");
    } finally {
      setRepairingLocalDb(false);
    }
  }

  function handleAutoSyncToggle(enabled: boolean) {
    if (activeOwner === "local" || !getActiveAccount()) {
      showError("La sincronización automática requiere una cuenta cloud activa.");
      return;
    }
    setAutoSyncEnabled(enabled);
    setAutoSyncEnabledState(enabled);
    showSuccess(enabled ? "Sincronización automática activada." : "Sincronización automática desactivada.");
  }

  function handleAutoSyncIntervalChange(intervalMs: number) {
    setAutoSyncIntervalMs(intervalMs);
    setAutoSyncIntervalMsState(intervalMs);
    showSuccess("Intervalo de sincronización actualizado.");
  }

  const selectedRestoreName = selectedRestorePath ? selectedRestorePath.split(/[/\\]/).pop() || selectedRestorePath : null;

  function handleReopenOnboarding() {
    if (typeof window === "undefined") return;
    try {
      for (const key of ONBOARDING_SECTION_KEYS) window.localStorage.removeItem(key);
    } catch {
      // La guia no debe bloquear la app si localStorage falla.
    }
    window.dispatchEvent(new Event(ONBOARDING_REOPEN_EVENT));
  }

  async function copyText(text: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      showSuccess(successMessage);
    } catch {
      setDiagnosticText(text);
      showError("No pudimos copiar automáticamente. Te mostramos el texto para copiarlo manualmente.");
    }
  }

  async function handleOpenReleases() {
    if (typeof window === "undefined") return;
    try {
      if ("__TAURI_INTERNALS__" in window) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(RELEASES_URL);
        return;
      }
      window.open(RELEASES_URL, "_blank", "noopener,noreferrer");
    } catch {
      window.open(RELEASES_URL, "_blank", "noopener,noreferrer");
    }
  }

  async function handleOpenFolder(path: string | undefined, label: string) {
    if (!path) {
      showError(`No tenemos la ruta de ${label}.`);
      return;
    }
    try {
      if ("__TAURI_INTERNALS__" in window) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(path);
        return;
      }
      await copyText(path, `Ruta de ${label} copiada.`);
    } catch {
      await copyText(path, `No pudimos abrir la carpeta. Ruta de ${label} copiada.`);
    }
  }

  const activeSession = getActiveAccount();
  const activeOwner = getActiveOwnerId();
  const currentMode = activeOwner === "local" ? "Modo local" : "Cuenta cloud";
  const databasePath = diagnostics?.database_path || info?.db_path;
  const dataPath = diagnostics?.data_dir || info?.data_dir;
  const backupsPath = diagnostics?.backups_path || info?.backups_dir;
  const logsPath = diagnostics?.logs_path || info?.logs_dir;
  const backendLabel = info?.backend_ok || diagnostics?.ok ? "Conectado" : diagnostics?.initializing ? "Preparando" : "Error";
  const repairModeActive = diagnostics?.db_status === "repair_required" || diagnostics?.db_status === "migration_failed" || diagnostics?.db_status === "critical";
  const databaseLabel = diagnostics?.db_status === "ready"
    ? "Lista"
    : diagnostics?.initializing || diagnostics?.db_status === "degraded"
      ? "Preparando"
      : repairModeActive
        ? "Requiere revisión"
        : diagnostics?.database_ready || info?.db_exists
          ? "Lista"
          : "Error";
  const backendVersion = diagnostics?.version || info?.version || "no disponible";
  const backendVersionCompatible = backendVersion === "no disponible" ? null : areVersionsCompatible(APP_VERSION, backendVersion);
  const backendCompatibilityLabel = backendVersionCompatible == null
    ? "Sin verificar"
    : backendVersionCompatible
      ? "Compatible"
      : "Requiere actualización";
  const syncLabel = activeOwner === "local"
    ? "Modo local"
    : autoSyncEnabled
      ? "Sincronización durante el uso activada"
      : "Sincronización al abrir y cerrar";
  const lastSyncLabel = syncOverview?.last_success?.finished_at || getLastAutoSyncAt() || getLastManualSyncAt() || "Sin sincronizaciones registradas";
  const selectedSection = SETTINGS_SECTIONS.find((section) => section.id === activeSection) || SETTINGS_SECTIONS[0];

  function renderGeneralSection() {
    const planLabel = entitlements?.plan === "premium" ? "Premium" : "Free";
    const premiumActive = entitlements?.plan === "premium" && ["active", "trialing"].includes(entitlements?.status || "");
    const subscriptionLabel = entitlements?.status === "trialing"
      ? "Activa"
      : entitlements?.status === "past_due"
        ? "Requiere pago"
        : entitlements?.status === "canceled"
          ? "Cancelada"
          : entitlements?.status === "expired"
            ? "Vencida"
            : entitlements?.plan === "premium"
              ? "Activa"
              : "Sin suscripción";
    const includedFeatures = [
      { key: "budgets", label: "Presupuestos" },
      { key: "saving_goals", label: "Metas de ahorro" },
      { key: "fixed_expenses", label: "Gastos fijos" },
      { key: "planning", label: "Planificación" },
    ].filter((item) => entitlements?.features?.[item.key as keyof BillingEntitlements["features"]]);
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-2xl font-black">General</h3>
          <p className="mt-1 text-sm text-slate-400">Estado general y accesos rápidos.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">App</p>
            <p className="mt-2 text-lg font-semibold">ScisoNomics</p>
            <p className="text-sm text-slate-400">Versión {APP_VERSION}</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Estado</p>
            <p className="mt-2 text-lg font-semibold">{backendLabel}</p>
            <p className="text-sm text-slate-400">Base de datos: {databaseLabel}</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Compatibilidad local</p>
            <p className="mt-2 text-lg font-semibold">{backendCompatibilityLabel}</p>
            <p className="text-sm text-slate-400">Backend {backendVersion}</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Plan</p>
            <p className="mt-2 text-lg font-semibold">{planLabel}</p>
            <p className="text-sm text-slate-400">Estado: {subscriptionLabel}</p>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/30 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="font-semibold">ScisoNomics Premium</p>
              <p className="mt-1 text-sm text-slate-400">
                {premiumActive
                  ? "Tu plan Premium está activo."
                  : "Premium desbloquea Presupuestos, Metas de ahorro, Gastos fijos y Planificación."}
              </p>
              <p className="mt-2 text-sm text-slate-300">
                Funciones incluidas: {includedFeatures.length ? includedFeatures.map((item) => item.label).join(", ") : "solo funciones Free"}
              </p>
              {premiumActive ? (
                <p className="mt-3 inline-flex rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200">
                  Ya sos Premium
                </p>
              ) : null}
            </div>
            {!premiumActive ? (
              <button className="btn" type="button" onClick={() => showError("ScisoNomics Premium todavía se habilita manualmente en esta versión.")}>
                Actualizar a Premium
              </button>
            ) : null}
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/30 p-4">
          <p className="font-semibold">Accesos rápidos</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Link className="btn" href="/movimientos">Registrar movimiento</Link>
            <button className="btn-secondary" type="button" onClick={() => selectSection("datos")}>Ver datos locales</button>
            <button className="btn-secondary" type="button" onClick={() => handleOpenFolder(dataPath, "datos")}>Abrir carpeta de datos</button>
            <button className="btn-secondary" type="button" onClick={() => window.dispatchEvent(new Event("scisonomics:open-add-account-modal"))}>Agregar cuenta</button>
          </div>
        </div>
      </div>
    );
  }

  function renderCuentaSection() {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-2xl font-black">Cuenta</h3>
          <p className="mt-1 text-sm text-slate-400">
            Administra modo local, multicuentas, Google Login y cuentas guardadas en este dispositivo.
          </p>
        </div>
        <AccountPanel showHeader={false} hideSyncCenter />
      </div>
    );
  }

  function renderSyncSection() {
    return (
      <div className="space-y-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-2xl font-black">Sincronización</h3>
            <p className="mt-1 text-sm text-slate-400">La sincronización funciona solo para la cuenta cloud activa.</p>
          </div>
          <button className="btn" type="button" onClick={handleManualSync} disabled={syncingNow || activeOwner === "local"}>
            {syncingNow ? "Sincronizando..." : "Sincronizar ahora"}
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Modo</p>
            <p className="mt-2 text-lg font-semibold">{syncLabel}</p>
            <p className="text-sm text-slate-400">{activeSession?.user.email || "Sin cuenta cloud activa"}</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Última sincronización</p>
            <p className="mt-2 text-sm font-semibold text-slate-200">{lastSyncLabel}</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Pendientes</p>
            <p className="mt-2 text-lg font-semibold">{syncOverview?.pending_total ?? 0}</p>
            <p className="text-sm text-slate-400">Borrados pendientes: {syncOverview?.deleted_pending_total ?? 0}</p>
          </div>
        </div>
        <label className={`flex items-center justify-between gap-4 rounded-2xl border border-line bg-slate-950/30 px-4 py-3 text-sm ${activeOwner === "local" ? "opacity-60" : ""}`}>
          <span>
            <span className="block font-semibold">Sincronización automática mientras usás la app</span>
            <span className="text-xs text-slate-400">
              ScisoNomics siempre intenta sincronizar al abrir y cerrar. Esta opción controla cambios, intervalo y segundo plano mientras usás la aplicación.
            </span>
          </span>
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-slate-600 bg-slate-900"
            checked={autoSyncEnabled}
            onChange={(event) => handleAutoSyncToggle(event.target.checked)}
            disabled={activeOwner === "local" || syncingNow}
          />
        </label>
        <label className={`flex items-center justify-between gap-4 rounded-2xl border border-line bg-slate-950/30 px-4 py-3 text-sm ${activeOwner === "local" || !autoSyncEnabled ? "opacity-60" : ""}`}>
          <span>
            <span className="block font-semibold">Frecuencia de sincronización</span>
            <span className="text-xs text-slate-400">Cada cuánto ScisoNomics intenta actualizar tus datos automáticamente mientras usás la app.</span>
          </span>
          <select
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            value={autoSyncIntervalMs}
            onChange={(event) => handleAutoSyncIntervalChange(Number(event.target.value))}
            disabled={activeOwner === "local" || !autoSyncEnabled || syncingNow}
          >
            <option value={1 * 60 * 1000}>Cada 1 minuto</option>
            <option value={5 * 60 * 1000}>Cada 5 minutos</option>
            <option value={10 * 60 * 1000}>Cada 10 minutos</option>
            <option value={15 * 60 * 1000}>Cada 15 minutos</option>
            <option value={30 * 60 * 1000}>Cada 30 minutos</option>
          </select>
        </label>
        {autoSyncEnabled ? (
          <p className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-100">
            Cuando está activada, ScisoNomics sincroniza tus cambios y consulta cambios remotos de otros dispositivos en segundo plano.
          </p>
        ) : null}
        <div className="rounded-2xl border border-line bg-slate-950/30 p-4">
          <p className="font-semibold">Cambios pendientes por tabla</p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {syncOverview?.tables ? Object.entries(syncOverview.tables).map(([table, value]) => (
              <div key={table} className="rounded-xl border border-line px-3 py-2 text-sm">
                <div className="flex justify-between gap-2">
                  <span>{table}</span>
                  <strong>{value.pending}</strong>
                </div>
                <p className="text-xs text-slate-500">Borrados: {value.deleted_pending} · Falta identificador de sincronización: {value.missing_sync_id}</p>
              </div>
            )) : <p className="text-sm text-slate-400">Sin estado de sincronización disponible.</p>}
          </div>
          {syncOverview?.rejected_total ? (
            <p className="mt-3 text-sm text-amber-300">
              Hay {syncOverview.rejected_total} registros que no pudieron sincronizarse. Último código: {syncOverview.latest_rejection?.code || "invalid_payload"}.
            </p>
          ) : null}
          {getLastSyncError() ? <p className="mt-3 text-sm text-amber-300">Último error: {getLastSyncError()}</p> : null}
        </div>
      </div>
    );
  }

  function renderDatosSection() {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-2xl font-black">Datos y backups</h3>
          <p className="mt-1 text-sm text-slate-400">ScisoNomics guarda tus datos principalmente en tu dispositivo.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Datos locales</p>
            <p className="mt-2 text-lg font-semibold">{databasePath ? "Disponibles" : "No disponibles"}</p>
            <p className="mt-1 text-sm text-slate-400">Tu información principal se guarda en este dispositivo.</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Backups</p>
            <p className="mt-2 text-lg font-semibold">{backupsPath ? "Configurados" : "No disponibles"}</p>
            <p className="mt-1 text-sm text-slate-400">Podés crear y restaurar copias de seguridad locales.</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Registros</p>
            <p className="mt-2 text-lg font-semibold">{logsPath ? "Disponibles para soporte" : "No disponibles"}</p>
            <p className="mt-1 text-sm text-slate-400">Los registros ayudan a soporte si necesitás asistencia.</p>
          </div>
        </div>
        <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Restaurar copia de seguridad reemplaza tus datos actuales por los datos de la copia seleccionada.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button className="btn" onClick={handleCreateSecurityCopy}>Crear copia de seguridad</button>
          <button className="btn-secondary" onClick={() => setEncryptedBackupOpen(true)}>Crear copia cifrada</button>
          <button className="btn-secondary" onClick={() => setWindowsProtectionOpen(true)}>Proteger datos con Windows</button>
          <button className="btn-secondary" onClick={handlePickRestoreFile}>Restaurar copia de seguridad</button>
          <button className="btn-secondary" onClick={() => handleOpenFolder(dataPath, "datos")}>Abrir carpeta de datos</button>
          <button className="btn-secondary" onClick={() => handleOpenFolder(backupsPath, "backups")}>Abrir carpeta de backups</button>
        </div>
        <details className="rounded-2xl border border-line bg-slate-950/20 p-4 text-sm">
          <summary className="cursor-pointer font-semibold text-slate-200">Detalles técnicos</summary>
          <div className="mt-3 space-y-2 text-slate-400">
            <p><span className="text-slate-300">Base de datos local:</span> {databasePath || "No disponible"}</p>
            <p><span className="text-slate-300">Carpeta de datos:</span> {dataPath || "No disponible"}</p>
            <p><span className="text-slate-300">Carpeta de backups:</span> {backupsPath || "No disponible"}</p>
            <p><span className="text-slate-300">Carpeta de registros:</span> {logsPath || "No disponible"}</p>
          </div>
        </details>
      </div>
    );
  }

  function renderDataSecuritySection() {
    const integrityLabel = localIntegrity?.status === "healthy"
      ? "Correcto"
      : localIntegrity?.status === "warning"
        ? "Necesita revisión"
        : localIntegrity?.status === "critical"
          ? "Requiere reparación"
          : repairModeActive
            ? "Requiere reparación"
          : "Sin revisar";
    const integrityTone = localIntegrity?.status === "healthy" ? "text-emerald-300" : localIntegrity || repairModeActive ? "text-amber-300" : "text-slate-300";
    const syncState = localIntegrity?.status === "critical" || repairModeActive
      ? "Necesita atención"
      : syncOverview?.has_pending
        ? "Cambios pendientes"
        : "Sincronizado";
    const integritySummary = localIntegrity?.safe_summary?.[0]
      || diagnostics?.message
      || info?.db_message
      || "Todavía no revisamos tus datos locales.";

    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-2xl font-black">Datos y seguridad</h3>
          <p className="mt-1 text-sm text-slate-400">ScisoNomics revisa tus datos locales para evitar problemas al sincronizar. Antes de reparar, siempre se crea una copia de seguridad.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Estado de datos locales</p>
            <p className={`mt-2 text-lg font-semibold ${integrityTone}`}>{integrityLabel}</p>
            <p className="mt-1 text-sm text-slate-400">{integritySummary}</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Sincronización</p>
            <p className="mt-2 text-lg font-semibold">{syncState}</p>
            <p className="mt-1 text-sm text-slate-400">Última sincronización: {lastSyncLabel}</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Último backup</p>
            <p className="mt-2 text-lg font-semibold">{backupState?.last_backup?.modified_at || "Todavía no creaste un backup"}</p>
            <p className="mt-1 text-sm text-slate-400">Tus backups se guardan localmente.</p>
          </div>
        </div>
        {localIntegrity?.status === "critical" || repairModeActive ? (
          <p className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            {diagnostics?.message || info?.db_message || "ScisoNomics abrió en modo reparación porque tus datos locales necesitan una revisión."}
          </p>
        ) : null}
        {localIntegrity?.status === "warning" ? (
          <p className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            Encontramos detalles reparables en tus datos locales. Podés crear un backup y ejecutar la reparación automática.
          </p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button className="btn" type="button" onClick={handleReviewLocalData} disabled={checkingLocalIntegrity}>
            {checkingLocalIntegrity ? "Revisando..." : "Revisar datos locales"}
          </button>
          <button className="btn-secondary" type="button" onClick={handleCreateLocalBackup} disabled={creatingLocalBackup}>
            {creatingLocalBackup ? "Creando backup..." : "Crear backup"}
          </button>
          {(localIntegrity && localIntegrity.status !== "healthy") || repairModeActive ? (
            <button className="btn-secondary" type="button" onClick={handleRepairLocalData} disabled={repairingLocalDb}>
              {repairingLocalDb ? "Reparando..." : "Reparar datos locales"}
            </button>
          ) : null}
          <button className="btn-secondary" type="button" onClick={() => handleOpenFolder(backupsPath, "backups")}>Abrir carpeta de backups</button>
          <button className="btn-secondary" type="button" onClick={() => handleOpenFolder(logsPath, "logs")}>Abrir carpeta de logs</button>
        </div>
      </div>
    );
  }

  function renderActualizacionesSection() {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-2xl font-black">Actualizaciones</h3>
          <p className="mt-1 text-sm text-slate-400">Las actualizaciones se descargan manualmente desde GitHub Releases.</p>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Versión instalada</p>
          <p className="mt-2 text-3xl font-black text-cyan-100">{APP_VERSION}</p>
          <p className="mt-2 text-sm text-slate-400">No hay auto-updater real en esta versión. ScisoNomics no descarga ni reemplaza ejecutables automáticamente.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button className="btn" type="button" onClick={handleOpenReleases}>Buscar actualizaciones</button>
          <button className="btn-secondary" type="button" onClick={() => copyText(RELEASES_URL, "Link de Releases copiado.")}>Copiar link de Releases</button>
        </div>
      </div>
    );
  }

  function renderAcercaSection() {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-2xl font-black">Acerca de ScisoNomics</h3>
          <p className="mt-1 text-sm text-slate-400">App desktop local-first para finanzas personales.</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4 text-sm">
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">Aplicación</p>
            <div className="mt-3 space-y-1 text-slate-300">
              <p><strong className="text-white">ScisoNomics</strong></p>
              <p>Versión instalada: {APP_VERSION}</p>
              <p>Tipo: Local-first</p>
              <p>Stack: Next.js - Tauri - FastAPI - SQLite</p>
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4 text-sm">
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">Estado actual</p>
            <div className="mt-3 space-y-1 text-slate-300">
              <p>Backend local: <strong>{backendLabel}</strong></p>
              <p>Base de datos: <strong>{databaseLabel}</strong></p>
              <p>Modo: <strong>{currentMode}</strong></p>
              <p>Cuenta activa: <strong>{activeSession?.user.email || "local"}</strong></p>
              <p>Versión backend: <strong>{backendVersion}</strong></p>
              <p>Compatibilidad: <strong>{backendCompatibilityLabel}</strong></p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/30 p-4">
          <p className="font-semibold">Novedades de v{APP_VERSION}</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-300">
            <li>Sincronización confiable al abrir y cerrar la aplicación.</li>
            <li>Sincronización durante el uso configurable por cuenta e intervalo.</li>
            <li>Sincronización reforzada con snapshot de owner por corrida.</li>
            <li>API local protegida con token de sidecar en app instalada.</li>
            <li>Google Login consume el resultado de polling una sola vez.</li>
            <li>Verificación de cuenta más segura ante errores de red.</li>
            <li>Migración legacy de movimientos preservando metadata.</li>
          </ul>
        </div>
        <button className="btn-secondary" type="button" onClick={() => setReleaseNotesOpen(true)}>Ver novedades en modal</button>
      </div>
    );
  }

  function renderActiveSection() {
    if (activeSection === "cuenta") return renderCuentaSection();
    if (activeSection === "sync") return renderSyncSection();
    if (activeSection === "datos") return renderDatosSection();
    if (activeSection === "diagnostico") return renderDataSecuritySection();
    if (activeSection === "actualizaciones") return renderActualizacionesSection();
    if (activeSection === "acerca") return renderAcercaSection();
    return renderGeneralSection();
  }

  return (
    <section className="space-y-4">
      <header className="card overflow-hidden p-0">
        <div className="border-b border-line bg-slate-950/50 px-5 py-4">
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-300">Configuración</p>
          <div className="mt-2 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-3xl font-black">Centro de configuración</h2>
              <p className="mt-1 text-sm text-slate-400">Administrá cuenta, sincronización, datos, seguridad y actualizaciones desde secciones separadas.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusPill value={databaseLabel} />
              <StatusPill value={syncLabel} />
            </div>
          </div>
        </div>
      </header>

      {loading && !info ? <LoadingSkeleton rows={5} /> : null}
      {loadError ? <ErrorState title="No se pudieron cargar los datos de configuración." description={loadError} onRetry={load} /> : null}

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="card h-fit p-3">
          <div className="mb-3 px-2">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Secciones</p>
          </div>
          <nav className="flex gap-2 overflow-x-auto lg:block lg:space-y-1 lg:overflow-visible" aria-label="Secciones de configuración">
            {SETTINGS_SECTIONS.map((section) => {
              const active = section.id === activeSection;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={`min-w-44 rounded-2xl border px-3 py-2 text-left transition lg:w-full ${
                    active
                      ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-100"
                      : "border-transparent text-slate-400 hover:border-line hover:bg-slate-950/40 hover:text-slate-100"
                  }`}
                  onClick={() => selectSection(section.id)}
                >
                  <span className="block text-sm font-semibold">{section.label}</span>
                  <span className="mt-0.5 block text-xs opacity-70">{section.hint}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="card min-h-[520px] p-5">
          <div className="mb-5 border-b border-line pb-4">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Sección activa</p>
              <h3 className="text-lg font-semibold">{selectedSection.label}</h3>
            </div>
          </div>
          {renderActiveSection()}
        </main>
      </div>

      <Modal open={!!selectedRestorePath} title="Restaurar copia de seguridad" onClose={() => setSelectedRestorePath(null)}>
        <p className="mt-1 text-sm text-slate-300">
          Esta accion reemplazara tus datos actuales por los datos de la copia seleccionada.
        </p>
        <p className="mt-2 text-sm text-slate-300">
          Antes de restaurar, ScisoNomics creará automáticamente una copia de seguridad de tus datos actuales.
        </p>
        <p className="mt-2 text-sm text-slate-300">
          Luego deberás reiniciar la aplicación para ver los cambios.
        </p>
        {selectedRestoreName ? (
          <p className="mt-3 rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-200">
            Archivo seleccionado: {selectedRestoreName}
          </p>
        ) : null}
        {selectedRestorePath?.toLowerCase().endsWith(".sciso-backup") ? (
          <label className="mt-4 block text-sm text-slate-300">
            Clave de la copia cifrada
            <input
              className="input mt-2 w-full"
              type="password"
              autoComplete="off"
              value={restorePassphrase}
              onChange={(event) => setRestorePassphrase(event.target.value)}
              maxLength={256}
            />
          </label>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setSelectedRestorePath(null)} disabled={restoring}>
            Cancelar
          </button>
          <button className="btn" onClick={handleConfirmRestore} disabled={restoring}>
            {restoring ? "Restaurando..." : "Restaurar copia"}
          </button>
        </div>
      </Modal>

      <Modal open={encryptedBackupOpen} title="Crear copia cifrada" onClose={() => setEncryptedBackupOpen(false)}>
        <p className="text-sm text-slate-300">
          La copia se cifra antes de salir de ScisoNomics. Sin esta clave no se puede recuperar.
        </p>
        <label className="mt-4 block text-sm text-slate-300">
          Clave (mínimo 12 caracteres)
          <input className="input mt-2 w-full" type="password" autoComplete="new-password" value={backupPassphrase} onChange={(event) => setBackupPassphrase(event.target.value)} maxLength={256} />
        </label>
        <label className="mt-3 block text-sm text-slate-300">
          Repetir clave
          <input className="input mt-2 w-full" type="password" autoComplete="new-password" value={backupPassphraseConfirm} onChange={(event) => setBackupPassphraseConfirm(event.target.value)} maxLength={256} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setEncryptedBackupOpen(false)} disabled={creatingEncryptedBackup}>Cancelar</button>
          <button className="btn" onClick={handleCreateEncryptedSecurityCopy} disabled={creatingEncryptedBackup}>
            {creatingEncryptedBackup ? "Cifrando..." : "Crear copia cifrada"}
          </button>
        </div>
      </Modal>

      <Modal open={windowsProtectionOpen} title="Proteger datos locales con Windows" onClose={() => setWindowsProtectionOpen(false)}>
        <div className="space-y-3 text-sm text-slate-300">
          <p>Windows cifrará la base local y la carpeta de backups mediante EFS, vinculándolas a tu cuenta de usuario.</p>
          <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-amber-200">
            Exportá el certificado de cifrado de Windows y guardalo de forma segura. Si perdés la cuenta o el certificado, los archivos podrían quedar inaccesibles.
          </p>
          <p>Esta protección requiere una unidad NTFS y una edición de Windows compatible. No reemplaza las copias cifradas portables.</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setWindowsProtectionOpen(false)} disabled={enablingWindowsProtection}>Cancelar</button>
          <button className="btn" onClick={handleEnableWindowsProtection} disabled={enablingWindowsProtection}>
            {enablingWindowsProtection ? "Protegiendo..." : "Activar protección"}
          </button>
        </div>
      </Modal>

      <Modal open={releaseNotesOpen} title={`Novedades de ScisoNomics ${APP_VERSION}`} onClose={() => setReleaseNotesOpen(false)}>
        <div className="mt-2 space-y-2 text-sm text-slate-300">
          <p>Esta versión se enfoca en estabilización, seguridad y hardening de sincronización.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>La app intenta sincronizar siempre al abrir y cerrar si hay una cuenta cloud activa.</li>
            <li>La sincronización durante el uso permite elegir un intervalo por cuenta.</li>
            <li>La sincronización usa owner/token congelados durante toda la corrida.</li>
            <li>La app no elimina cuentas guardadas por fallas temporales de conexión.</li>
            <li>El backend local puede requerir token de sidecar para endpoints sensibles.</li>
            <li>Google Login invalida el resultado de polling tras el primer consumo.</li>
            <li>Se redujo PII en logs cloud y se corrigieron mensajes visibles.</li>
          </ul>
        </div>
      </Modal>

      <Modal open={!!diagnosticText} title="Diagnóstico" onClose={() => setDiagnosticText(null)}>
        <p className="text-sm text-slate-300">No pudimos copiar automáticamente. Podés copiar este texto manualmente.</p>
        <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-line bg-slate-950/60 p-3 text-xs text-slate-200">
          {diagnosticText}
        </pre>
      </Modal>
    </section>
  );
}
