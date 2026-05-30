"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AccountPanel } from "../../../components/account/AccountPanel";
import { ErrorState } from "../../../components/ui/ErrorState";
import { LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { Modal } from "../../../components/ui/Modal";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import { createSecurityCopyWithSaveDialog } from "../../../services/backupDownload";
import { ACCOUNT_SESSION_CHANGED_EVENT, OWNER_CHANGED_EVENT, getActiveCloudSession, getActiveOwnerId, isCloudAuthConfigured } from "../../../services/cloudAuth";
import {
  SYNC_STATE_CHANGED_EVENT,
  getCloudApiUrl,
  getLastAutoSyncAt,
  getLastCloudHealthResult,
  getLastCloudSessionTestResult,
  getLastCloudSyncTestResult,
  getLastLocalProtectedTestResult,
  getLastManualSyncAt,
  getLastSyncError,
  getLastSyncErrorDetails,
  getLastSyncAttemptDetails,
  isAutoSyncEnabled,
  runManualSync,
  setAutoSyncEnabled,
  testCloudHealth,
  testCloudSession,
  testCloudSync,
  testLocalProtectedService,
  type CloudHealthResult,
  type CloudSessionTestResult,
  type CloudSyncTestResult,
  type LocalProtectedTestResult,
  type SyncOverview,
} from "../../../services/cloudSync";
import { API_URL, getLocalRequestHeaders } from "../../../services/http";
import type { SettingsInfo } from "../../../types/domain";

const ONBOARDING_REOPEN_EVENT = "scisonomics:open-onboarding-guides";
const RELEASES_URL = "https://github.com/iante/scisonomics/releases";
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
  { id: "sync", label: "Sincronizacion", hint: "Manual y automatica" },
  { id: "datos", label: "Datos y backups", hint: "DB, backups y restore" },
  { id: "diagnostico", label: "Diagnostico", hint: "Salud y logs" },
  { id: "actualizaciones", label: "Actualizaciones", hint: "Releases manuales" },
  { id: "acerca", label: "Acerca de", hint: "Version y novedades" },
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

type AppDiagnostics = {
  ok: boolean;
  version: string;
  appearance: string;
  database_ready: boolean;
  initializing: boolean;
  database_error?: string | null;
  database_path: string;
  data_dir: string;
  backups_path: string;
  logs_path: string;
  db_exists?: boolean;
  frozen?: boolean;
};

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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [syncingNow, setSyncingNow] = useState(false);
  const [autoSyncEnabled, setAutoSyncEnabledState] = useState(false);
  const [selectedRestorePath, setSelectedRestorePath] = useState<string | null>(null);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [diagnosticText, setDiagnosticText] = useState<string | null>(null);
  const [cloudHealth, setCloudHealth] = useState<CloudHealthResult | null>(null);
  const [cloudSessionTest, setCloudSessionTest] = useState<CloudSessionTestResult | null>(null);
  const [cloudSyncTest, setCloudSyncTest] = useState<CloudSyncTestResult | null>(null);
  const [localProtectedTest, setLocalProtectedTest] = useState<LocalProtectedTestResult | null>(null);
  const [testingCloud, setTestingCloud] = useState(false);
  const [testingCloudSession, setTestingCloudSession] = useState(false);
  const [testingCloudSync, setTestingCloudSync] = useState(false);
  const [testingLocalProtected, setTestingLocalProtected] = useState(false);
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
      const [diagnosticsResult, overviewResult] = await Promise.all([
        fetch(`${API_URL}/app/diagnostics`, { cache: "no-store", headers: await getLocalRequestHeaders() })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
        fetch(`${API_URL}/sync/overview`, { cache: "no-store", headers: await getLocalRequestHeaders() })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
      ]);
      setDiagnostics(diagnosticsResult as AppDiagnostics | null);
      setSyncOverview(overviewResult as SyncOverview | null);
      setCloudHealth(getLastCloudHealthResult());
      setCloudSessionTest(getLastCloudSessionTestResult());
      setCloudSyncTest(getLastCloudSyncTestResult());
      setLocalProtectedTest(getLastLocalProtectedTestResult());
      setAutoSyncEnabledState(isAutoSyncEnabled());
      setLoadError("");
    } catch (e: any) {
      setLoadError(e?.message || "No se pudo cargar la configuracion.");
      showError(e?.message || "No se pudo cargar la configuracion.");
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

  async function handlePickRestoreFile() {
    try {
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (!isTauri) {
        showError("La restauracion de copia de seguridad esta disponible solo en la app de escritorio.");
        return;
      }

      const [{ open }] = await Promise.all([import("@tauri-apps/plugin-dialog")]);
      const selected = await open({
        multiple: false,
        filters: [{ name: "Base de datos SQLite", extensions: ["db"] }],
      });
      if (!selected) return;

      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path || !path.toLowerCase().endsWith(".db")) {
        showError("Debes seleccionar un archivo .db valido.");
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
      await api.restoreBackupFromPath(selectedRestorePath);
      setSelectedRestorePath(null);
      showSuccess("Copia restaurada correctamente. Reinicia ScisoNomics para aplicar los cambios.");
    } catch (error: any) {
      console.error("Error restaurando copia de seguridad:", error);
      const message = typeof error?.message === "string" ? error.message : "";
      const normalized = message.toLowerCase();
      if (
        normalized.includes("sqlite") ||
        normalized.includes("estructura minima") ||
        normalized.includes("archivo .db") ||
        normalized.includes("vacia") ||
        normalized.includes("no existe") ||
        normalized.includes("no es un archivo")
      ) {
        showError("No se pudo restaurar la copia de seguridad. Verifica que el archivo sea una copia valida de ScisoNomics.");
      } else if (normalized.includes("base de datos esta en uso")) {
        showError("No se pudo restaurar porque tus datos estan en uso. Cerra y volve a abrir ScisoNomics.");
      } else {
        showError("No se pudo restaurar la copia de seguridad. Intenta nuevamente o elegi otra copia.");
      }
    } finally {
      setRestoring(false);
    }
  }

  async function handleManualSync() {
    const session = getActiveCloudSession();
    if (!session) {
      showError("Inicia sesion para sincronizar.");
      return;
    }
    setSyncingNow(true);
    try {
      await runManualSync(session.token, session.user.email);
      await load();
      showSuccess("Sincronizacion completada.");
    } catch (error) {
      showError(error instanceof Error ? error.message : "No se pudo sincronizar.");
    } finally {
      setSyncingNow(false);
    }
  }

  async function handleTestCloudConnection() {
    setTestingCloud(true);
    try {
      const result = await testCloudHealth();
      setCloudHealth(result);
      if (result.ok) showSuccess(result.version ? `Conexion cloud OK. Version ${result.version}.` : "Conexion cloud OK.");
      else showError(result.user_message);
    } finally {
      setTestingCloud(false);
    }
  }

  async function handleTestCloudSession() {
    setTestingCloudSession(true);
    try {
      const result = await testCloudSession();
      setCloudSessionTest(result);
      if (result.ok) showSuccess("Sesion cloud OK.");
      else showError(result.user_message);
    } finally {
      setTestingCloudSession(false);
    }
  }

  async function handleTestCloudSync() {
    setTestingCloudSync(true);
    try {
      const result = await testCloudSync();
      setCloudSyncTest(result);
      if (result.ok) showSuccess("Sync cloud OK.");
      else showError(result.user_message);
    } finally {
      setTestingCloudSync(false);
    }
  }

  async function handleTestLocalProtected() {
    setTestingLocalProtected(true);
    try {
      const result = await testLocalProtectedService();
      setLocalProtectedTest(result);
      if (result.ok) showSuccess("Servicio local protegido OK.");
      else showError(result.user_message);
    } finally {
      setTestingLocalProtected(false);
    }
  }

  function handleAutoSyncToggle(enabled: boolean) {
    if (activeOwner === "local" || !getActiveCloudSession()) {
      showError("La sincronizacion automatica requiere una cuenta cloud activa.");
      return;
    }
    setAutoSyncEnabled(enabled);
    setAutoSyncEnabledState(enabled);
    showSuccess(enabled ? "Sincronizacion automatica activada." : "Sincronizacion automatica desactivada.");
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
      showError("No pudimos copiar automaticamente. Te mostramos el texto para copiarlo manualmente.");
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

  function buildDiagnosticText() {
    const session = getActiveCloudSession();
    const owner = getActiveOwnerId();
    const mode = owner === "local" ? "local" : "cloud";
    const lastSync = getLastAutoSyncAt() || getLastManualSyncAt() || "sin sincronizaciones registradas";
    const syncError = getLastSyncErrorDetails();
    const health = cloudHealth || getLastCloudHealthResult();
    const sessionTest = cloudSessionTest || getLastCloudSessionTestResult();
    const syncTest = cloudSyncTest || getLastCloudSyncTestResult();
    const syncAttempt = getLastSyncAttemptDetails();
    const localTest = localProtectedTest || getLastLocalProtectedTestResult();
    return [
      "ScisoNomics diagnostico",
      "Version: 3.0.2",
      "Apariencia: modo oscuro fijo",
      `Modo: ${mode}`,
      `Cuenta activa: ${session?.user.email || "local"}`,
      `Owner activo: ${owner}`,
      `Backend local: ${info?.backend_ok || diagnostics?.ok ? "OK" : "Error"}`,
      "Frontend version: 3.0.2",
      `Backend version: ${backendVersion}`,
      `Backend frozen: ${diagnostics?.frozen ? "si" : "no"}`,
      `Frontend/backend mismatch: ${backendVersionMismatch ? "si" : "no"}`,
      "Proceso backend esperado: scisonomics-backend.exe",
      `Base de datos: ${diagnostics?.database_ready || info?.db_exists ? "OK" : diagnostics?.initializing ? "Inicializando" : "Error"}`,
      `DB path: ${diagnostics?.database_path || info?.db_path || "no disponible"}`,
      `Backups path: ${diagnostics?.backups_path || info?.backups_dir || "no disponible"}`,
      `Logs path: ${diagnostics?.logs_path || info?.logs_dir || "no disponible"}`,
      `Cloud configurado: ${isCloudAuthConfigured() ? "si" : "no"}`,
      `Cloud API URL: ${getCloudApiUrl() || "no configurada"}`,
      `Cloud health: ${health ? (health.ok ? "OK" : "Error") : "no probado"}`,
      `Cloud health status code: ${health?.status_code ?? "no disponible"}`,
      `Cloud health version: ${health?.version || "no disponible"}`,
      `Cloud health mensaje tecnico: ${health?.technical_message || "no disponible"}`,
      `Cloud session: ${sessionTest ? (sessionTest.ok ? "OK" : "Error") : "no probada"}`,
      `Cloud session endpoint: ${sessionTest?.endpoint || "no disponible"}`,
      `Cloud session method: ${sessionTest?.method || "no disponible"}`,
      `Cloud session status code: ${sessionTest?.status_code ?? "no disponible"}`,
      `Cloud session tipo: ${sessionTest?.type || "no disponible"}`,
      `Cloud session timestamp: ${sessionTest?.timestamp || "no disponible"}`,
      `Cloud session mensaje tecnico: ${sessionTest?.technical_message || "no disponible"}`,
      `Cloud sync test: ${syncTest ? (syncTest.ok ? "OK" : "Error") : "no probado"}`,
      `Cloud sync test endpoint: ${syncTest?.endpoint || "no disponible"}`,
      `Cloud sync test method: ${syncTest?.method || "no disponible"}`,
      `Cloud sync test status code: ${syncTest?.status_code ?? "no disponible"}`,
      `Cloud sync test tipo: ${syncTest?.type || "no disponible"}`,
      `Cloud sync test timestamp: ${syncTest?.timestamp || "no disponible"}`,
      `Cloud sync test mensaje tecnico: ${syncTest?.technical_message || "no disponible"}`,
      `Local protected test: ${localTest ? (localTest.ok ? "OK" : "Error") : "no probado"}`,
      `Local protected test endpoint: ${localTest?.endpoint || "no disponible"}`,
      `Local protected test status code: ${localTest?.status_code ?? "no disponible"}`,
      `Local protected test token disponible: ${localTest?.security.token_available ?? "no disponible"}`,
      `Local protected test token header agregado: ${localTest?.security.token_header_added ?? "no disponible"}`,
      `Local protected test owner header agregado: ${localTest?.security.owner_header_added ?? "no disponible"}`,
      `Local protected test mensaje tecnico: ${localTest?.technical_message || "no disponible"}`,
      `Sync automatica: ${isAutoSyncEnabled() ? "activada" : "desactivada"}`,
      `Ultima sincronizacion: ${lastSync}`,
      `Ultimo error sync: ${getLastSyncError() || "sin errores recientes"}`,
      `Ultimo error sync timestamp: ${syncError?.timestamp || "no disponible"}`,
      `Ultimo error sync tipo: ${syncError?.type || "no disponible"}`,
      `Ultimo error sync endpoint: ${syncError?.endpoint || "no disponible"}`,
      `Ultimo error sync metodo: ${syncError?.method || "no disponible"}`,
      `Ultimo error sync fase: ${syncError?.phase || "no disponible"}`,
      `Ultimo error sync items: ${syncError?.items_total ?? "no disponible"}`,
      `Ultimo error sync payload bytes aproximados: ${syncError?.payload_bytes ?? "no disponible"}`,
      `Ultimo error sync status code: ${syncError?.status_code ?? "no disponible"}`,
      `Ultimo error sync mensaje tecnico: ${syncError?.technical_message || "no disponible"}`,
      `Ultimo error sync owner: ${syncError?.owner_used || "no disponible"}`,
      `Ultimo error sync razon: ${syncError?.reason || "no disponible"}`,
      `Ultimo error sync body construido: ${syncError?.body_constructed ?? "no disponible"}`,
      `Ultimo error sync conteos pendientes: ${syncError?.pending_counts ? JSON.stringify(syncError.pending_counts) : "no disponible"}`,
      `Ultimo error sync token local disponible: ${syncError?.local_security?.token_available ?? "no disponible"}`,
      `Ultimo error sync token local agregado: ${syncError?.local_security?.token_header_added ?? "no disponible"}`,
      `Ultimo error sync owner local agregado: ${syncError?.local_security?.owner_header_added ?? "no disponible"}`,
      `Ultimo intento sync fase: ${syncAttempt?.phase || "no disponible"}`,
      `Ultimo intento sync endpoint: ${syncAttempt?.endpoint || "no disponible"}`,
      `Ultimo intento sync metodo: ${syncAttempt?.method || "no disponible"}`,
      `Ultimo intento sync status code: ${syncAttempt?.status_code ?? "no disponible"}`,
      `Ultimo intento sync body construido: ${syncAttempt?.body_constructed ?? "no disponible"}`,
      `Ultimo intento sync payload bytes aproximados: ${syncAttempt?.payload_bytes ?? "no disponible"}`,
      `Ultimo intento sync mensaje tecnico: ${syncAttempt?.technical_message || "no disponible"}`,
      `Fecha: ${new Date().toISOString()}`,
    ].join("\n");
  }

  async function handleCopyDiagnostics() {
    await copyText(buildDiagnosticText(), "Diagnostico copiado.");
  }

  const activeSession = getActiveCloudSession();
  const activeOwner = getActiveOwnerId();
  const currentMode = activeOwner === "local" ? "Modo local" : "Cuenta cloud";
  const databasePath = diagnostics?.database_path || info?.db_path;
  const dataPath = diagnostics?.data_dir || info?.data_dir;
  const backupsPath = diagnostics?.backups_path || info?.backups_dir;
  const logsPath = diagnostics?.logs_path || info?.logs_dir;
  const backendLabel = info?.backend_ok || diagnostics?.ok ? "Conectado" : diagnostics?.initializing ? "Preparando" : "Error";
  const databaseLabel = diagnostics?.database_ready || info?.db_exists ? "Lista" : diagnostics?.initializing ? "Inicializando" : "Error";
  const backendVersion = diagnostics?.version || info?.version || "no disponible";
  const backendVersionMismatch = Boolean(diagnostics?.frozen && backendVersion !== "3.0.2");
  const syncLabel = activeOwner === "local"
    ? "Modo local"
    : autoSyncEnabled
      ? "Sync automatica activada"
      : "Sync manual";
  const lastSyncLabel = syncOverview?.last_success?.finished_at || getLastAutoSyncAt() || getLastManualSyncAt() || "Sin sincronizaciones registradas";
  const selectedSection = SETTINGS_SECTIONS.find((section) => section.id === activeSection) || SETTINGS_SECTIONS[0];

  function renderGeneralSection() {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-2xl font-black">General</h3>
          <p className="mt-1 text-sm text-slate-400">Estado general y accesos rapidos.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">App</p>
            <p className="mt-2 text-lg font-semibold">ScisoNomics</p>
            <p className="text-sm text-slate-400">Version 3.0.2</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Apariencia</p>
            <p className="mt-2 text-lg font-semibold">Modo oscuro fijo</p>
            <p className="text-sm text-slate-400">No depende del tema del sistema.</p>
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Estado</p>
            <p className="mt-2 text-lg font-semibold">{backendLabel}</p>
            <p className="text-sm text-slate-400">Base de datos: {databaseLabel}</p>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/30 p-4">
          <p className="font-semibold">Accesos rapidos</p>
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
            <h3 className="text-2xl font-black">Sincronizacion</h3>
            <p className="mt-1 text-sm text-slate-400">La sincronizacion corre solo para la cuenta cloud activa.</p>
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
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Ultima sync</p>
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
            <span className="block font-semibold">Sincronizar automaticamente</span>
            <span className="text-xs text-slate-400">
              Opcional. Solo corre para la cuenta activa; en modo local no se sincroniza con cloud.
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
        {autoSyncEnabled ? (
          <p className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-100">
            Cuando esta activada, ScisoNomics sincroniza tus cambios y consulta cambios remotos de otros dispositivos en segundo plano.
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
                <p className="text-xs text-slate-500">Borrados: {value.deleted_pending} · Missing sync_id: {value.missing_sync_id}</p>
              </div>
            )) : <p className="text-sm text-slate-400">Sin estado de sincronizacion disponible.</p>}
          </div>
          {getLastSyncError() ? <p className="mt-3 text-sm text-amber-300">Ultimo error: {getLastSyncError()}</p> : null}
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
        <div className="rounded-2xl border border-line bg-slate-950/30 p-4 text-sm">
          <p><span className="text-slate-500">DB:</span> {databasePath || "No disponible"}</p>
          <p className="mt-2"><span className="text-slate-500">Carpeta de datos:</span> {dataPath || "No disponible"}</p>
          <p className="mt-2"><span className="text-slate-500">Backups:</span> {backupsPath || "No disponible"}</p>
        </div>
        <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Restaurar copia de seguridad reemplaza tus datos actuales por los datos de la copia seleccionada.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button className="btn" onClick={handleCreateSecurityCopy}>Crear copia de seguridad</button>
          <button className="btn-secondary" onClick={handlePickRestoreFile}>Restaurar copia de seguridad</button>
          <button className="btn-secondary" onClick={() => handleOpenFolder(dataPath, "datos")}>Abrir carpeta de datos</button>
          <button className="btn-secondary" onClick={() => handleOpenFolder(backupsPath, "backups")}>Abrir carpeta de backups</button>
        </div>
      </div>
    );
  }

  function renderDiagnosticoSection() {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-2xl font-black">Diagnostico</h3>
          <p className="mt-1 text-sm text-slate-400">Informacion segura para revisar estado local sin exponer secretos ni datos financieros.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Backend local</p>
            <p className="mt-2 text-lg font-semibold">{backendLabel}</p>
            <p className="text-sm text-slate-400">Base de datos: {databaseLabel}</p>
            <p className="text-sm text-slate-400">Version backend: {backendVersion}</p>
            <p className="text-sm text-slate-400">Backend empaquetado: {diagnostics?.frozen ? "si" : "no"}</p>
            {backendVersionMismatch ? (
              <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                La version del backend no coincide con la app instalada. Cerra ScisoNomics y reinstala sin omitir archivos.
              </p>
            ) : null}
          </div>
          <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Logs</p>
            <p className="mt-2 text-sm text-slate-300">{logsPath || "No disponible"}</p>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Cloud</p>
              <p className="mt-2 text-sm text-slate-300">API URL: {getCloudApiUrl() || "No configurada"}</p>
              <p className="mt-1 text-sm text-slate-300">
                Health: {cloudHealth ? (cloudHealth.ok ? "OK" : "Error") : "No probado"}
                {cloudHealth?.status_code ? ` - HTTP ${cloudHealth.status_code}` : ""}
              </p>
              {cloudHealth?.version ? <p className="mt-1 text-sm text-slate-300">Version cloud: {cloudHealth.version}</p> : null}
              {cloudHealth && !cloudHealth.ok ? <p className="mt-2 text-sm text-amber-300">{cloudHealth.user_message}</p> : null}
            </div>
            <button className="btn-secondary" type="button" onClick={handleTestCloudConnection} disabled={testingCloud}>
              {testingCloud ? "Probando..." : "Probar conexion cloud"}
            </button>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Sesion cloud autenticada</p>
              <p className="mt-2 text-sm text-slate-300">
                Estado: {cloudSessionTest ? (cloudSessionTest.ok ? "OK" : "Error") : "No probada"}
                {cloudSessionTest?.status_code ? ` - HTTP ${cloudSessionTest.status_code}` : ""}
              </p>
              {cloudSessionTest?.endpoint ? <p className="mt-1 text-sm text-slate-300">Endpoint: {cloudSessionTest.endpoint}</p> : null}
              {cloudSessionTest?.timestamp ? <p className="mt-1 text-sm text-slate-400">Timestamp: {cloudSessionTest.timestamp}</p> : null}
              {cloudSessionTest && !cloudSessionTest.ok ? <p className="mt-2 text-sm text-amber-300">{cloudSessionTest.user_message}</p> : null}
              {cloudSessionTest?.technical_message ? <p className="mt-1 text-xs text-slate-500">Detalle seguro: {cloudSessionTest.technical_message}</p> : null}
            </div>
            <button className="btn-secondary" type="button" onClick={handleTestCloudSession} disabled={testingCloudSession}>
              {testingCloudSession ? "Probando..." : "Probar sesion cloud"}
            </button>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Servicio sync cloud autenticado</p>
              <p className="mt-2 text-sm text-slate-300">
                Estado: {cloudSyncTest ? (cloudSyncTest.ok ? "OK" : "Error") : "No probado"}
                {cloudSyncTest?.status_code ? ` - HTTP ${cloudSyncTest.status_code}` : ""}
              </p>
              {cloudSyncTest?.endpoint ? <p className="mt-1 text-sm text-slate-300">Endpoint: {cloudSyncTest.endpoint}</p> : null}
              {cloudSyncTest?.timestamp ? <p className="mt-1 text-sm text-slate-400">Timestamp: {cloudSyncTest.timestamp}</p> : null}
              {cloudSyncTest && !cloudSyncTest.ok ? <p className="mt-2 text-sm text-amber-300">{cloudSyncTest.user_message}</p> : null}
              {cloudSyncTest?.technical_message ? <p className="mt-1 text-xs text-slate-500">Detalle seguro: {cloudSyncTest.technical_message}</p> : null}
            </div>
            <button className="btn-secondary" type="button" onClick={handleTestCloudSync} disabled={testingCloudSync}>
              {testingCloudSync ? "Probando..." : "Probar sync cloud"}
            </button>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/40 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Servicio local protegido</p>
              <p className="mt-2 text-sm text-slate-300">
                Estado: {localProtectedTest ? (localProtectedTest.ok ? "OK" : "Error") : "No probado"}
                {localProtectedTest?.status_code ? ` - HTTP ${localProtectedTest.status_code}` : ""}
              </p>
              {localProtectedTest?.endpoint ? <p className="mt-1 text-sm text-slate-300">Endpoint: {localProtectedTest.endpoint}</p> : null}
              {localProtectedTest ? (
                <p className="mt-1 text-xs text-slate-500">
                  Token disponible: {localProtectedTest.security.token_available ? "si" : "no"} · Header token: {localProtectedTest.security.token_header_added ? "si" : "no"} · Header owner: {localProtectedTest.security.owner_header_added ? "si" : "no"}
                </p>
              ) : null}
              {localProtectedTest && !localProtectedTest.ok ? <p className="mt-2 text-sm text-amber-300">{localProtectedTest.user_message}</p> : null}
              {localProtectedTest?.technical_message ? <p className="mt-1 text-xs text-slate-500">Detalle seguro: {localProtectedTest.technical_message}</p> : null}
            </div>
            <button className="btn-secondary" type="button" onClick={handleTestLocalProtected} disabled={testingLocalProtected}>
              {testingLocalProtected ? "Probando..." : "Probar servicio local protegido"}
            </button>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/30 p-4 text-xs text-slate-300">
          <p>DB path: {databasePath || "No disponible"}</p>
          <p className="mt-2">Backups path: {backupsPath || "No disponible"}</p>
          <p className="mt-2">Logs path: {logsPath || "No disponible"}</p>
          {diagnostics?.database_error ? <p className="mt-3 text-amber-300">Ultimo error local: {diagnostics.database_error}</p> : null}
          {getLastSyncErrorDetails() ? (
            <div className="mt-3 space-y-1 text-amber-200">
              <p>Ultimo error sync tipo: {getLastSyncErrorDetails()?.type}</p>
              <p>Endpoint: {getLastSyncErrorDetails()?.endpoint}</p>
              <p>Metodo: {getLastSyncErrorDetails()?.method || "no disponible"}</p>
              <p>Fase: {getLastSyncErrorDetails()?.phase || "no disponible"}</p>
              <p>Items intentados: {getLastSyncErrorDetails()?.items_total ?? "no disponible"}</p>
              <p>Payload aproximado: {getLastSyncErrorDetails()?.payload_bytes ?? "no disponible"} bytes</p>
              <p>Body construido: {String(getLastSyncErrorDetails()?.body_constructed ?? "no disponible")}</p>
              <p>Owner usado: {getLastSyncErrorDetails()?.owner_used || "no disponible"}</p>
              <p>Razon: {getLastSyncErrorDetails()?.reason || "no disponible"}</p>
              <p>Conteos pendientes: {getLastSyncErrorDetails()?.pending_counts ? JSON.stringify(getLastSyncErrorDetails()?.pending_counts) : "no disponible"}</p>
              <p>Token local disponible: {String(getLastSyncErrorDetails()?.local_security?.token_available ?? "no disponible")}</p>
              <p>Header token local agregado: {String(getLastSyncErrorDetails()?.local_security?.token_header_added ?? "no disponible")}</p>
              <p>Header owner agregado: {String(getLastSyncErrorDetails()?.local_security?.owner_header_added ?? "no disponible")}</p>
              <p>HTTP: {getLastSyncErrorDetails()?.status_code ?? "no disponible"}</p>
              <p>Timestamp: {getLastSyncErrorDetails()?.timestamp}</p>
              <p>Mensaje tecnico seguro: {getLastSyncErrorDetails()?.technical_message}</p>
            </div>
          ) : null}
          {getLastSyncAttemptDetails() ? (
            <div className="mt-3 space-y-1 border-t border-line pt-3 text-slate-400">
              <p>Ultimo intento sync fase: {getLastSyncAttemptDetails()?.phase}</p>
              <p>Endpoint: {getLastSyncAttemptDetails()?.endpoint}</p>
              <p>Metodo: {getLastSyncAttemptDetails()?.method}</p>
              <p>HTTP: {getLastSyncAttemptDetails()?.status_code ?? "no disponible"}</p>
              <p>Body construido: {String(getLastSyncAttemptDetails()?.body_constructed ?? "no disponible")}</p>
              <p>Payload aproximado: {getLastSyncAttemptDetails()?.payload_bytes ?? "no disponible"} bytes</p>
              <p>Mensaje tecnico seguro: {getLastSyncAttemptDetails()?.technical_message}</p>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button className="btn" type="button" onClick={handleCopyDiagnostics}>Copiar diagnostico</button>
          <button className="btn-secondary" type="button" onClick={handleTestCloudConnection} disabled={testingCloud}>
            {testingCloud ? "Probando..." : "Probar conexion cloud"}
          </button>
          <button className="btn-secondary" type="button" onClick={handleTestCloudSession} disabled={testingCloudSession}>
            {testingCloudSession ? "Probando..." : "Probar sesion cloud"}
          </button>
          <button className="btn-secondary" type="button" onClick={handleTestCloudSync} disabled={testingCloudSync}>
            {testingCloudSync ? "Probando..." : "Probar sync cloud"}
          </button>
          <button className="btn-secondary" type="button" onClick={handleTestLocalProtected} disabled={testingLocalProtected}>
            {testingLocalProtected ? "Probando..." : "Probar servicio local protegido"}
          </button>
          <button className="btn-secondary" type="button" onClick={() => handleOpenFolder(logsPath, "logs")}>Abrir carpeta de logs</button>
          <button className="btn-secondary" type="button" onClick={load}>Actualizar estado</button>
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
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Version instalada</p>
          <p className="mt-2 text-3xl font-black text-cyan-100">3.0.2</p>
          <p className="mt-2 text-sm text-slate-400">No hay auto-updater real en esta version. ScisoNomics no descarga ni reemplaza ejecutables automaticamente.</p>
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
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">Aplicacion</p>
            <div className="mt-3 space-y-1 text-slate-300">
              <p><strong className="text-white">ScisoNomics</strong></p>
              <p>Version instalada: 3.0.2</p>
              <p>Tipo: Local-first</p>
              <p>Apariencia: modo oscuro fijo</p>
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
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-slate-950/30 p-4">
          <p className="font-semibold">Novedades de v3.0.2</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-300">
            <li>Sync endurecida con snapshot de owner por corrida.</li>
            <li>API local protegida con token de sidecar en app instalada.</li>
            <li>Google Login consume el resultado de polling una sola vez.</li>
            <li>Verificacion de cuenta mas segura ante errores de red.</li>
            <li>Migracion legacy de movimientos preservando metadata.</li>
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
    if (activeSection === "diagnostico") return renderDiagnosticoSection();
    if (activeSection === "actualizaciones") return renderActualizacionesSection();
    if (activeSection === "acerca") return renderAcercaSection();
    return renderGeneralSection();
  }

  return (
    <section className="space-y-4">
      <header className="card overflow-hidden p-0">
        <div className="border-b border-line bg-slate-950/50 px-5 py-4">
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-300">Configuracion</p>
          <div className="mt-2 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-3xl font-black">Centro de configuracion</h2>
              <p className="mt-1 text-sm text-slate-400">Administra cuenta, sync, datos, diagnostico y actualizaciones desde secciones separadas.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusPill value={databaseLabel} />
              <StatusPill value={syncLabel} />
            </div>
          </div>
        </div>
      </header>

      {loading && !info ? <LoadingSkeleton rows={5} /> : null}
      {loadError ? <ErrorState title="No se pudieron cargar los datos de configuracion." description={loadError} onRetry={load} /> : null}

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="card h-fit p-3">
          <div className="mb-3 px-2">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Secciones</p>
          </div>
          <nav className="flex gap-2 overflow-x-auto lg:block lg:space-y-1 lg:overflow-visible" aria-label="Secciones de configuracion">
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
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Seccion activa</p>
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
          Antes de restaurar, ScisoNomics creara automaticamente una copia de seguridad de tus datos actuales.
        </p>
        <p className="mt-2 text-sm text-slate-300">
          Luego deberas reiniciar la aplicacion para ver los cambios.
        </p>
        {selectedRestoreName ? (
          <p className="mt-3 rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-200">
            Archivo seleccionado: {selectedRestoreName}
          </p>
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

      <Modal open={releaseNotesOpen} title="Novedades de ScisoNomics 3.0.2" onClose={() => setReleaseNotesOpen(false)}>
        <div className="mt-2 space-y-2 text-sm text-slate-300">
          <p>Esta version se enfoca en estabilizacion, seguridad y hardening de sincronizacion.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>La sincronizacion usa owner/token congelados durante toda la corrida.</li>
            <li>La app no elimina cuentas guardadas por fallas temporales de conexion.</li>
            <li>El backend local puede requerir token de sidecar para endpoints sensibles.</li>
            <li>Google Login invalida el resultado de polling tras el primer consumo.</li>
            <li>Se redujo PII en logs cloud y se corrigieron mensajes visibles.</li>
          </ul>
        </div>
      </Modal>

      <Modal open={!!diagnosticText} title="Diagnostico" onClose={() => setDiagnosticText(null)}>
        <p className="text-sm text-slate-300">No pudimos copiar automaticamente. Podes copiar este texto manualmente.</p>
        <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-line bg-slate-950/60 p-3 text-xs text-slate-200">
          {diagnosticText}
        </pre>
      </Modal>
    </section>
  );
}
