"use client";

import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useToast } from "../../hooks/useToast";
import {
  DEFAULT_REMEMBER_CLOUD_ACCOUNT,
  clearAllAccounts,
  clearActiveAccountSession,
  cloudAuth,
  getActiveAccount,
  getActiveCloudAuthState,
  getAuthUIState,
  getActiveCloudSessionAsync,
  getActiveOwnerId,
  getCloudAuthTokens,
  getStoredAccounts,
  isEmailVerificationRequiredResponse,
  isCloudAuthConfigured,
  logoutAccount,
  removeAccount,
  switchActiveOwner,
  addOrUpdateAccount,
  type CloudSessionAvailability,
  type EmailVerificationRequiredResponse,
  type StoredCloudAccount,
  type CloudUser,
} from "../../services/cloudAuth";
import {
  getLastAutoSyncAt,
  getLastManualSyncAt,
  getLastSyncError,
  getCloudDevices,
  getLocalSessionContext,
  getSyncConflicts,
  getSyncHistory,
  getSyncOverview,
  clearAutoSyncPreference,
  isAutoSyncEnabled,
  isSyncInFlight,
  runManualSync,
  claimLocalData,
  setAutoSyncEnabled,
  SYNC_STATE_CHANGED_EVENT,
  type CloudDevice,
  type SyncConflictItem,
  type SyncHistoryItem,
  type SyncOverview,
} from "../../services/cloudSync";
import { PasswordInput } from "../ui/PasswordInput";

type Mode = "login" | "register";
type PendingVerification = EmailVerificationRequiredResponse & { source: Mode };

const inputClass =
  "w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400";

export function AccountPanel({ showHeader = true, hideSyncCenter = false }: { showHeader?: boolean; hideSyncCenter?: boolean }) {
  const configured = isCloudAuthConfigured();
  const { showError, showSuccess } = useToast();
  const [mode, setMode] = useState<Mode>("login");
  const [loadingSession, setLoadingSession] = useState(true);
  const [sessionCheckError, setSessionCheckError] = useState("");
  const [sessionAvailability, setSessionAvailability] = useState<CloudSessionAvailability>("none");
  const [submitting, setSubmitting] = useState(false);
  const [remember, setRemember] = useState(DEFAULT_REMEMBER_CLOUD_ACCOUNT);
  const [tokenMode, setTokenMode] = useState<"persistent" | "session" | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("Sin sincronizar");
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastAutoSyncAt, setLastAutoSyncAt] = useState<string | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [autoSyncEnabled, setAutoSyncEnabledState] = useState(false);
  const [syncSummary, setSyncSummary] = useState("");
  const [syncOverview, setSyncOverview] = useState<SyncOverview | null>(null);
  const [syncHistory, setSyncHistory] = useState<SyncHistoryItem[]>([]);
  const [syncConflicts, setSyncConflicts] = useState<SyncConflictItem[]>([]);
  const [cloudDevices, setCloudDevices] = useState<CloudDevice[]>([]);
  const [hasLocalData, setHasLocalData] = useState(false);
  const [claimingLocalData, setClaimingLocalData] = useState(false);
  const [syncCenterLoading, setSyncCenterLoading] = useState(false);
  const [showPending, setShowPending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [showConflicts, setShowConflicts] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [accounts, setAccounts] = useState<StoredCloudAccount[]>([]);
  const [activeOwnerId, setActiveOwnerId] = useState("local");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [verification, setVerification] = useState<PendingVerification | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [resendAvailableIn, setResendAvailableIn] = useState(0);
  const hasCheckedSessionRef = useRef(false);
  const sessionAvailable = sessionAvailability === "active";

  function clearAuthForms() {
    setLoginEmail("");
    setLoginPassword("");
    setDisplayName("");
    setRegisterEmail("");
    setRegisterPassword("");
    setRepeatPassword("");
    setVerificationCode("");
  }

  async function completeVerifiedLogin(response: Awaited<ReturnType<typeof cloudAuth.verifyEmail>>, successMessage: string) {
    const stored = await addOrUpdateAccount({ user: response.user, tokens: getCloudAuthTokens(response) }, { remember, makeActive: true });
    const authState = await getActiveCloudAuthState();
    setTokenMode(authState.account?.storage || null);
    setSessionAvailability(authState.availability);
    setUser(authState.account?.user || response.user);
    setAccounts(getStoredAccounts());
    setActiveOwnerId(response.user.id);
    setSessionCheckError(authState.availability === "active" ? "" : getAuthUIState(authState.availability).message);
    setShowAddAccount(false);
    setVerification(null);
    clearAuthForms();
    if (remember && !stored.secureResult.storedSecurely) {
      showError("No pudimos guardar la sesión de forma segura. Vas a tener que iniciar sesión nuevamente al abrir la app.");
    }
    showSuccess(successMessage);
  }

  function enterVerification(response: EmailVerificationRequiredResponse, source: Mode) {
    setVerification({ ...response, source });
    setVerificationCode("");
    setResendAvailableIn(response.resend_available_in || 0);
    showSuccess("Te enviamos un código de verificación por correo.");
  }

  function refreshAuthState() {
    const currentAccounts = getStoredAccounts();
    const owner = getActiveOwnerId();
    const session = getActiveAccount();
    setAccounts(currentAccounts);
    setActiveOwnerId(owner);
    setUser(session?.user || null);
    setTokenMode(session?.storage || null);
    setSessionAvailability("none");
    setAutoSyncEnabledState(isAutoSyncEnabled());
    if (owner === "local") {
      setSyncOverview(null);
      setSyncHistory([]);
      setSyncConflicts([]);
      setCloudDevices([]);
    }
  }

  useEffect(() => {
    if (hasCheckedSessionRef.current) return;
    hasCheckedSessionRef.current = true;
    let cancelled = false;
    async function loadSession() {
      try {
        if (window.sessionStorage.getItem("scisonomics_account_panel_add") === "1") {
          window.sessionStorage.removeItem("scisonomics_account_panel_add");
          setShowAddAccount(true);
          setMode("login");
        }
      } catch {
        // El panel debe seguir funcionando aunque sessionStorage no este disponible.
      }
      setLoadingSession(true);
      setSessionCheckError("");
      setLastSyncAt(getLastManualSyncAt());
      setLastAutoSyncAt(getLastAutoSyncAt());
      setLastSyncError(getLastSyncError());
      setAutoSyncEnabledState(isAutoSyncEnabled());
      refreshAuthState();
      const authState = await getActiveCloudAuthState();
      if (cancelled) return;
      setUser(authState.account?.user || null);
      setTokenMode(authState.account?.storage || null);
      setSessionAvailability(authState.availability);
      setAccounts(getStoredAccounts());
      setActiveOwnerId(getActiveOwnerId());
      setSessionCheckError(authState.availability === "active" ? "" : getAuthUIState(authState.availability).message);
      setLoadingSession(false);
    }
    loadSession();
    return () => {
      cancelled = true;
    };
  }, [configured]);

  useEffect(() => {
    if (!verification || resendAvailableIn <= 0) return;
    const timer = window.setTimeout(() => setResendAvailableIn((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [verification, resendAvailableIn]);

async function handleClearLocalSession() {
    const activeSession = getActiveAccount();
    if (activeSession?.user.id) clearAutoSyncPreference(activeSession.user.id);
    const cleared = await clearActiveAccountSession();
    setAutoSyncEnabled(false);
    refreshAuthState();
    setLoadingSession(false);
    setSessionCheckError("");
    setSessionAvailability("none");
    setSyncOverview(null);
    setSyncHistory([]);
    setSyncConflicts([]);
    setCloudDevices([]);
    if (cleared.ok) showSuccess("Sesión activa quitada de este dispositivo.");
    else showError("Quitamos la sesión activa, pero no pudimos limpiar por completo la sesión recordada.");
  }

  async function handleRetrySessionCheck() {
    hasCheckedSessionRef.current = false;
    setLoadingSession(true);
    setSessionCheckError("");
    if (!configured) {
      setLoadingSession(false);
      setUser(null);
      setSessionAvailability("none");
      return;
    }
    try {
      const authState = await getActiveCloudAuthState();
      setUser(authState.account?.user || null);
      setTokenMode(authState.account?.storage || null);
      setSessionAvailability(authState.availability);
      setAccounts(getStoredAccounts());
      setActiveOwnerId(getActiveOwnerId());
      setSessionCheckError(authState.availability === "active" ? "" : getAuthUIState(authState.availability).message);
    } catch (error) {
      console.error("No se pudo revalidar la sesión cloud:", error);
      setAutoSyncEnabled(false);
      setUser(null);
      setTokenMode(null);
      setSessionAvailability("unknown_error");
      setSessionCheckError(error instanceof Error ? error.message : "No pudimos verificar la sesión. Podés volver a iniciar sesión.");
    } finally {
      setLoadingSession(false);
      hasCheckedSessionRef.current = true;
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshSyncState = () => {
      setLastSyncAt(getLastManualSyncAt());
      setLastAutoSyncAt(getLastAutoSyncAt());
      setLastSyncError(getLastSyncError());
      setAutoSyncEnabledState(isAutoSyncEnabled());
      setSyncing(isSyncInFlight());
    };
    window.addEventListener(SYNC_STATE_CHANGED_EVENT, refreshSyncState);
    return () => window.removeEventListener(SYNC_STATE_CHANGED_EVENT, refreshSyncState);
  }, []);

  async function refreshSyncCenter() {
    if (!configured || !user) return;
    setSyncCenterLoading(true);
    try {
      const session = await getActiveCloudSessionAsync();
      const [overview, history, conflicts, devices] = await Promise.all([
        getSyncOverview(),
        getSyncHistory(10),
        getSyncConflicts(10),
        session?.token ? getCloudDevices(session.token).catch(() => ({ ok: false, devices: [] })) : Promise.resolve({ ok: false, devices: [] }),
      ]);
      const context = await getLocalSessionContext().catch(() => null);
      setSyncOverview(overview);
      setSyncHistory(history.items || []);
      setSyncConflicts(conflicts.items || []);
      setCloudDevices(devices.devices || []);
      setHasLocalData(Boolean(context?.has_local_data || (context?.local_claimable_total || 0) > 0));
    } catch (error) {
      console.warn("No se pudo cargar el centro de sincronización:", error);
    } finally {
      setSyncCenterLoading(false);
    }
  }

  useEffect(() => {
    refreshSyncCenter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, user?.id]);

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || submitting) return;
    setSubmitting(true);
    console.info("[auth] login submit", JSON.stringify({ mode: "login", remember }));
    try {
      const response = await cloudAuth.login({ email: loginEmail, password: loginPassword });
      if (isEmailVerificationRequiredResponse(response)) {
        enterVerification(response, "login");
        return;
      }
      const stored = await addOrUpdateAccount({ user: response.user, tokens: getCloudAuthTokens(response) }, { remember, makeActive: true });
      const authState = await getActiveCloudAuthState();
      setTokenMode(authState.account?.storage || null);
      setSessionAvailability(authState.availability);
      setUser(authState.account?.user || response.user);
      setAccounts(getStoredAccounts());
      setActiveOwnerId(response.user.id);
      setSessionCheckError(authState.availability === "active" ? "" : getAuthUIState(authState.availability).message);
      setShowAddAccount(false);
      clearAuthForms();
      if (remember && !stored.secureResult.storedSecurely) {
        showError("No pudimos guardar la sesión de forma segura. Vas a tener que iniciar sesión nuevamente al abrir la app.");
      }
      showSuccess("Sesión iniciada.");
    } catch (error) {
      console.error("Error iniciando sesión:", error);
      showError(error instanceof Error ? error.message : "No se pudo iniciar sesión.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegister(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || submitting) return;
    if (registerPassword !== repeatPassword) {
      showError("Las contraseñas no coinciden.");
      return;
    }
    setSubmitting(true);
    console.info("[auth] login submit", JSON.stringify({ mode: "register", remember }));
    try {
      const response = await cloudAuth.register({
        display_name: displayName || null,
        email: registerEmail,
        password: registerPassword,
      });
      if (isEmailVerificationRequiredResponse(response)) {
        enterVerification(response, "register");
        return;
      }
      const stored = await addOrUpdateAccount({ user: response.user, tokens: getCloudAuthTokens(response) }, { remember, makeActive: true });
      const authState = await getActiveCloudAuthState();
      setTokenMode(authState.account?.storage || null);
      setSessionAvailability(authState.availability);
      setUser(authState.account?.user || response.user);
      setAccounts(getStoredAccounts());
      setActiveOwnerId(response.user.id);
      setSessionCheckError(authState.availability === "active" ? "" : getAuthUIState(authState.availability).message);
      setShowAddAccount(false);
      clearAuthForms();
      if (remember && !stored.secureResult.storedSecurely) {
        showError("No pudimos guardar la sesión de forma segura. Vas a tener que iniciar sesión nuevamente al abrir la app.");
      }
      showSuccess("Cuenta creada.");
    } catch (error) {
      console.error("Error creando cuenta:", error);
      showError(error instanceof Error ? error.message : "No se pudo crear la cuenta.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!verification || submitting) return;
    const code = verificationCode.replace(/\D/g, "");
    if (code.length !== 6) {
      showError("Ingresá el código de 6 dígitos.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await cloudAuth.verifyEmail({ verification_token: verification.verification_token, code });
      await completeVerifiedLogin(response, verification.source === "register" ? "Cuenta verificada." : "Sesión iniciada.");
    } catch (error) {
      console.error("Error verificando email:", error);
      showError(error instanceof Error ? error.message : "No se pudo verificar el código.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendVerificationCode() {
    if (!verification || submitting || resendAvailableIn > 0) return;
    setSubmitting(true);
    try {
      const response = await cloudAuth.resendEmailVerification({ verification_token: verification.verification_token });
      setVerification({ ...response, source: verification.source });
      setVerificationCode("");
      setResendAvailableIn(response.resend_available_in || 60);
      showSuccess("Te enviamos un nuevo código.");
    } catch (error) {
      console.error("Error reenviando código:", error);
      showError(error instanceof Error ? error.message : "No se pudo reenviar el código.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    const activeSession = await getActiveCloudSessionAsync();
    let cleanupOk = true;
    if (activeSession?.user.id) {
      const result = await logoutAccount(activeSession.user.id);
      cleanupOk = Boolean(result?.ok);
      clearAutoSyncPreference(activeSession.user.id);
    }
    else {
      const result = await clearActiveAccountSession();
      cleanupOk = Boolean(result?.ok);
    }
    setTokenMode(null);
    setUser(null);
    setSessionAvailability("none");
    setSessionCheckError("");
    setAutoSyncEnabled(false);
    setAutoSyncEnabledState(false);
    setAccounts(getStoredAccounts());
    setActiveOwnerId(getActiveOwnerId());
    setSyncOverview(null);
    setSyncHistory([]);
    setSyncConflicts([]);
    setCloudDevices([]);
    clearAuthForms();
    if (cleanupOk) showSuccess("Sesión cerrada. Tus datos de cuenta no se muestran en modo local.");
    else showError("Cerramos la sesión, pero no pudimos limpiar por completo la sesión recordada.");
  }

  async function handleClaimLocalData() {
    const session = getActiveAccount();
    if (!session?.user.id || claimingLocalData) return;
    setClaimingLocalData(true);
    try {
      const result = await claimLocalData(session.user.id);
      const total = Number(result.claimed_total ?? result.claimable_total ?? Object.values(result.claimed).reduce((sum, value) => sum + Number(value || 0), 0));
      setHasLocalData(false);
      await refreshSyncCenter();
      showSuccess(total > 0 ? `Datos locales asociados a esta cuenta: ${total}.` : "No había datos locales para asociar.");
    } catch (error) {
      console.error("Error asociando datos locales:", error);
      showError("No se pudieron asociar los datos locales a esta cuenta.");
    } finally {
      setClaimingLocalData(false);
    }
  }

  async function handleManualSync() {
    const session = await getActiveCloudSessionAsync();
    if (!session?.token || syncing) {
      showError("Iniciá sesión para sincronizar.");
      return;
    }
    setSyncing(true);
    setSyncMessage("Sincronizando tus datos...");
    setSyncSummary("");
    try {
      const result = await runManualSync(session.user.email);
      setLastSyncAt(result.syncedAt);
      setLastSyncError(result.rejectedTotal ? "Algunos datos no pudieron sincronizarse y necesitan revisión." : null);
      setSyncMessage(result.rejectedTotal ? "Sincronización completada con advertencias" : "Sincronización completada");
      const uploadedTotal = Object.values(result.uploaded).reduce((sum, value) => sum + Number(value || 0), 0);
      const pulledTotal = Object.values(result.pulled || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      setSyncSummary(
        result.rejectedTotal
          ? `Confirmados en la nube: ${uploadedTotal}. Cambios recibidos: ${pulledTotal}. Quedaron ${result.rejectedTotal} registros para revisar.`
          : result.conflictsTotal
          ? `Confirmados en la nube: ${uploadedTotal}. Cambios recibidos: ${pulledTotal}. Se resolvieron ${result.conflictsTotal} cambios entre dispositivos.`
          : `Confirmados en la nube: ${uploadedTotal}. Cambios recibidos: ${pulledTotal}.`,
      );
      await refreshSyncCenter();
      if (result.rejectedTotal) showError("Algunos datos no pudieron sincronizarse y necesitan revisión.");
      else showSuccess("Sincronización completada correctamente.");
    } catch (error) {
      console.error("Error sincronizando:", error);
      setSyncMessage("Error al sincronizar");
      showError(error instanceof Error ? error.message : "No se pudo sincronizar.");
    } finally {
      setSyncing(false);
    }
  }

  function handleAutoSyncToggle(enabled: boolean) {
    setAutoSyncEnabled(enabled);
    setAutoSyncEnabledState(enabled);
    setSyncMessage(enabled ? "Sincronización automática activada" : "Sincronización desactivada");
  }

  async function handleSwitchOwner(ownerId: string) {
    if (ownerId === activeOwnerId) return;
    switchActiveOwner(ownerId);
    setAutoSyncEnabledState(isAutoSyncEnabled());
    setSyncOverview(null);
    setSyncHistory([]);
    setSyncConflicts([]);
    setCloudDevices([]);
    setSyncSummary("");
    refreshAuthState();
    if (ownerId === "local") {
      showSuccess("Modo local activado.");
      return;
    }
    showSuccess("Cuenta activa cambiada.");
    try {
      const authState = await getActiveCloudAuthState();
      setUser(authState.account?.user || null);
      setTokenMode(authState.account?.storage || null);
      setSessionAvailability(authState.availability);
      setAccounts(getStoredAccounts());
      setActiveOwnerId(getActiveOwnerId());
      setSessionCheckError(authState.availability === "active" ? "" : getAuthUIState(authState.availability).message);
    } catch (error) {
      console.error("La cuenta guardada ya no es válida:", error);
      setSessionCheckError("La sesión de esa cuenta venció o no pudo verificarse. Volvé a iniciar sesión.");
      refreshAuthState();
    }
  }

  async function handleRemoveAccount(ownerId: string) {
    clearAutoSyncPreference(ownerId);
    const result = await removeAccount(ownerId);
    refreshAuthState();
    if (result.ok) showSuccess("Cuenta quitada de este dispositivo. Tus datos financieros no se borraron.");
    else showError("Quitamos la cuenta de este dispositivo, pero no pudimos limpiar por completo la sesión recordada.");
  }

  async function handleClearAllAccounts() {
    for (const account of accounts) clearAutoSyncPreference(account.user.id);
    const result = await clearAllAccounts();
    setAutoSyncEnabled(false);
    refreshAuthState();
    if (result.ok) showSuccess("Se quitaron todas las cuentas guardadas. Tus datos financieros no se borraron.");
    else showError("Quitamos las cuentas guardadas, pero no pudimos limpiar por completo algunas sesiones recordadas.");
  }

  function formatDate(value?: string | null) {
    if (!value) return "Sin datos";
    return new Date(value).toLocaleString();
  }

  function tableLabel(table: string) {
    const labels: Record<string, string> = {
      categorias: "Categorias",
      movimientos: "Movimientos",
      metas_ahorro: "Metas",
      gastos_programados: "Gastos programados",
      gastos_fijos: "Gastos fijos",
      presupuestos: "Presupuestos",
    };
    return labels[table] || table;
  }

  function shortDeviceId(value?: string | null) {
    if (!value) return "Sin identificar";
    return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
  }

  function resolutionLabel(value: string) {
    if (value === "kept_local") return "Se conservo local";
    if (value === "applied_remote") return "Se aplico remoto";
    return "Ignorado";
  }

  function historyReasonLabel(item: SyncHistoryItem) {
    const reason = typeof item.details?.reason === "string" ? item.details.reason : "";
    const labels: Record<string, string> = {
      manual: "Manual",
      startup: "Inicio",
      app_start: "Apertura de app",
      app_close: "Cierre de app",
      interval: "Consulta remota",
      focus: "Foco",
      auto_local_change: "Cambio local",
      data_change: "Cambio local",
      auto_remote_pull: "Consulta remota",
    };
    return labels[reason] || (item.mode === "auto" ? "Automática" : "Manual");
  }

  async function handleGoogleLogin() {
    if (!configured || submitting) {
      showError("El servicio de cuenta no está configurado en este entorno.");
      return;
    }
    setSubmitting(true);
    console.info("[auth] login submit", JSON.stringify({ mode: "google", remember }));
    try {
      const result = await cloudAuth.googleStart();
      if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        await openUrl(result.auth_url);
      } else {
        window.open(result.auth_url, "_blank", "noopener,noreferrer");
      }
      const startedAt = Date.now();
      while (Date.now() - startedAt < 3 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const status = await cloudAuth.googleStatus(result.login_request_id);
        if (status.status === "pending") continue;
        if (status.status === "completed") {
          const stored = await addOrUpdateAccount({ user: status.user, tokens: getCloudAuthTokens(status) }, { remember, makeActive: true });
          const authState = await getActiveCloudAuthState();
          setTokenMode(authState.account?.storage || null);
          setSessionAvailability(authState.availability);
          setUser(authState.account?.user || status.user);
          setAccounts(getStoredAccounts());
          setActiveOwnerId(status.user.id);
          setSessionCheckError("");
          setShowAddAccount(false);
          clearAuthForms();
          if (remember && !stored.secureResult.storedSecurely) {
            showError("No pudimos guardar la sesión de forma segura. Vas a tener que iniciar sesión nuevamente al abrir la app.");
          }
          showSuccess("Cuenta agregada con Google.");
          return;
        }
        showError(status.message || "No se pudo completar Google Login.");
        return;
      }
      showError("No pudimos confirmar el inicio de sesión con Google. Intentá nuevamente.");
    } catch (error) {
      console.error("Error iniciando Google OAuth:", error);
      showError(error instanceof Error ? error.message : "El inicio con Google todavía no está configurado en este entorno.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-4">
      {showHeader ? (
        <header className="card p-5">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Cuenta opcional</p>
          <h2 className="mt-2 text-2xl font-bold">Cuenta</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
            Podés usar ScisoNomics sin cuenta. Tus datos siguen guardándose localmente y la sincronización manual está disponible solo si iniciás sesión.
          </p>
        </header>
      ) : null}

      {!configured ? (
        <section className="card border-amber-400/40 bg-amber-500/10 p-5">
          <h3 className="text-lg font-semibold text-amber-900 dark:text-amber-100">Servicio de cuenta no configurado</h3>
          <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
            El servicio de cuenta no está configurado en este entorno. La app sigue funcionando en modo local y tus datos continúan guardándose en este dispositivo.
          </p>
        </section>
      ) : null}

      <section className="card p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">Cuenta activa</p>
            <h3 className="mt-1 text-lg font-semibold">{activeOwnerId === "local" ? "Modo local" : user?.display_name || user?.email || "Cuenta cloud"}</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {activeOwnerId === "local"
                ? "Tus datos quedan en este dispositivo y no se sincronizan."
                : "La UI muestra solo los datos de esta cuenta. La sync corre solo para la cuenta activa."}
            </p>
          </div>
          {accounts.length > 0 ? (
            <button className="btn-secondary" type="button" onClick={handleClearAllAccounts}>
              Quitar todas
            </button>
          ) : null}
        </div>
        <div className="mt-4 grid gap-2">
          <div className={`rounded-xl border p-3 text-sm ${activeOwnerId === "local" ? "border-sky-400/50 bg-sky-500/10" : "border-slate-800"}`}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold">Modo local</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">Datos sin cuenta. No se sincronizan con cloud.</p>
              </div>
              <button className="btn-secondary" type="button" onClick={() => handleSwitchOwner("local")} disabled={activeOwnerId === "local"}>
                {activeOwnerId === "local" ? "Activo" : "Cambiar"}
              </button>
            </div>
          </div>
          {accounts.map((account) => (
            <div key={account.user.id} className={`rounded-xl border p-3 text-sm ${activeOwnerId === account.user.id ? "border-sky-400/50 bg-sky-500/10" : "border-slate-800"}`}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold">{account.user.display_name || account.user.email}</p>
                  {account.user.display_name ? <p className="text-xs text-slate-500 dark:text-slate-400">{account.user.email}</p> : null}
                  <p className="text-xs text-slate-500 dark:text-slate-400">Último uso: {formatDate(account.lastUsedAt)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-secondary" type="button" onClick={() => handleSwitchOwner(account.user.id)} disabled={activeOwnerId === account.user.id}>
                    {activeOwnerId === account.user.id ? "Activa" : "Cambiar"}
                  </button>
                  <button className="btn-secondary" type="button" onClick={() => handleRemoveAccount(account.user.id)}>
                    Quitar
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {configured ? (
          <div className="mt-4">
            <button className="btn-secondary" type="button" onClick={() => setShowAddAccount((value) => !value)}>
              {showAddAccount ? "Cancelar agregado" : "Agregar cuenta"}
            </button>
          </div>
        ) : null}
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Quitar una cuenta de este dispositivo no borra tus datos financieros locales ni los datos sincronizados en la nube. Solo elimina el acceso guardado en esta instalación.
        </p>
      </section>

      {loadingSession ? (
        <section className="card p-5">
          <p className="text-sm text-slate-500 dark:text-slate-400">Verificando sesión...</p>
          <button className="btn-secondary mt-4" type="button" onClick={handleClearLocalSession}>
            Limpiar sesión local
          </button>
        </section>
      ) : sessionCheckError && !user ? (
        <section className="card p-5">
          <h3 className="text-lg font-semibold">No pudimos verificar la sesión</h3>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {sessionCheckError}
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button className="btn-secondary" type="button" onClick={handleRetrySessionCheck}>Reintentar</button>
            <button className="btn" type="button" onClick={handleClearLocalSession}>Limpiar sesión local</button>
          </div>
        </section>
      ) : user && !showAddAccount ? (
        <section className="card p-6">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Cuenta</p>
          <h3 className="mt-2 text-2xl font-semibold">
            {getAuthUIState(sessionAvailability, Boolean(sessionCheckError)).title}
          </h3>
          <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-sm text-slate-500 dark:text-slate-400">Usuario</p>
            <p className="mt-1 font-semibold">{user.display_name || user.email}</p>
            {user.display_name ? <p className="text-sm text-slate-500 dark:text-slate-400">{user.email}</p> : null}
            {tokenMode === "persistent" ? <p className="mt-2 text-xs text-sky-700 dark:text-sky-300">Recordarme activado</p> : null}
          </div>
          {!sessionAvailable && sessionCheckError ? (
            <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
              {sessionCheckError}
            </p>
          ) : null}
          <p className="mt-4 rounded-xl border border-sky-400/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-900 dark:text-sky-100">
            La sincronización cloud es opcional. Tus datos siguen guardándose localmente en este dispositivo.
          </p>
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm">
            <p className="font-semibold">Modo de datos</p>
            <p className="mt-1 text-slate-500 dark:text-slate-400">
              Estás viendo datos de esta cuenta. Los datos locales sin cuenta quedan separados y no se sincronizan automáticamente.
            </p>
            {hasLocalData ? (
              <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-100">
                <p className="font-medium">Hay datos locales sin cuenta en este dispositivo.</p>
                <p className="mt-1">Podés asociarlos a esta cuenta si querés que formen parte de esta sesión y queden pendientes para sincronizar.</p>
                <button className="btn mt-3" type="button" onClick={handleClaimLocalData} disabled={claimingLocalData}>
                  {claimingLocalData ? "Asociando..." : "Asociar datos locales a esta cuenta"}
                </button>
              </div>
            ) : null}
          </div>
          {configured && !hideSyncCenter ? (
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <div className="flex flex-col gap-4">
                <div>
                  <p className="font-semibold">Sincronización</p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {syncing ? "Sincronizando..." : autoSyncEnabled ? "Sincronización automática activada" : syncMessage}
                    {lastSyncAt ? ` · Última sincronización: ${new Date(lastSyncAt).toLocaleString()}` : ""}
                  </p>
                  {syncSummary ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{syncSummary}</p> : null}
                  {lastAutoSyncAt ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Última sincronización automática: {new Date(lastAutoSyncAt).toLocaleString()}</p> : null}
                  {lastSyncError ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Último intento fallido: {lastSyncError}</p> : null}
                  {syncOverview?.sync_error_total ? (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                      Hay {syncOverview.sync_error_total} registros con revisión pendiente.
                      {syncOverview.last_rejection_code ? ` Último código: ${syncOverview.last_rejection_code}.` : ""}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    ScisoNomics puede sincronizar tus datos manualmente o de forma automática si activás esta opción. Cuando está activada, la app intenta sincronizar al abrirse y después de cambios importantes.
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-slate-800 p-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Dispositivo actual</p>
                    <p className="mt-1 text-sm font-semibold">{syncOverview?.device_name || "Este dispositivo"}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{shortDeviceId(syncOverview?.device_id)}</p>
                  </div>
                  <div className="rounded-xl border border-slate-800 p-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Cambios pendientes</p>
                    <p className="mt-1 text-sm font-semibold">{syncOverview ? `${syncOverview.pending_total} pendientes` : "Sin datos"}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {syncOverview?.deleted_pending_total ? `${syncOverview.deleted_pending_total} borrados pendientes` : "Sin borrados pendientes"}
                    </p>
                    {syncOverview?.sync_error_total ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        {syncOverview.sync_error_total} registros necesitan revisión
                      </p>
                    ) : null}
                  </div>
                  <div className="rounded-xl border border-slate-800 p-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Última sync exitosa</p>
                    <p className="mt-1 text-sm font-semibold">{formatDate(syncOverview?.last_success?.finished_at || lastSyncAt || lastAutoSyncAt)}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {syncOverview?.last_success ? `${syncOverview.last_success.mode === "auto" ? "Automática" : "Manual"} - Enviados: ${syncOverview.last_success.pushed_total} - Recibidos: ${syncOverview.last_success.pulled_total}` : "Sin historial"}
                    </p>
                  </div>
                </div>
                <label className="flex items-center justify-between gap-4 rounded-xl border border-slate-800 px-3 py-2 text-sm">
                  <span>
                    <span className="block font-medium">Sincronización automática mientras usas la app</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">La apertura y el cierre intentan sincronizar siempre. Esta opción controla el background.</span>
                  </span>
                  <input
                    type="checkbox"
                    className="h-5 w-5 rounded border-slate-300"
                    checked={autoSyncEnabled}
                    onChange={(event) => handleAutoSyncToggle(event.target.checked)}
                    disabled={syncing}
                  />
                </label>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <button className="btn" onClick={handleManualSync} disabled={syncing}>
                    {syncing ? "Sincronizando..." : "Sincronizar ahora"}
                  </button>
                  <button className="btn-secondary" onClick={refreshSyncCenter} disabled={syncCenterLoading}>
                    {syncCenterLoading ? "Actualizando..." : "Actualizar estado"}
                  </button>
                  <button className="btn-secondary" type="button" onClick={() => setShowPending((value) => !value)}>
                    {showPending ? "Ocultar pendientes" : "Ver pendientes"}
                  </button>
                  <button className="btn-secondary" type="button" onClick={() => setShowHistory((value) => !value)}>
                    {showHistory ? "Ocultar historial" : "Ver historial"}
                  </button>
                  <button className="btn-secondary" type="button" onClick={() => setShowDevices((value) => !value)}>
                    {showDevices ? "Ocultar dispositivos" : "Ver dispositivos"}
                  </button>
                  <button className="btn-secondary" type="button" onClick={() => setShowConflicts((value) => !value)}>
                    {showConflicts ? "Ocultar conflictos" : "Ver conflictos"}
                  </button>
                </div>
                <div className="rounded-xl border border-slate-800 p-3 text-sm">
                  <p className="font-semibold">Multi-dispositivo</p>
                  <p className="mt-1 text-slate-500 dark:text-slate-400">
                    ScisoNomics conserva automáticamente la versión más reciente cuando un dato cambia en más de un dispositivo.
                  </p>
                  {syncOverview?.conflicts_recent ? (
                    <p className="mt-2 text-amber-700 dark:text-amber-300">
                      Se detectaron cambios en más de un dispositivo. Se conservó la versión más reciente.
                    </p>
                  ) : (
                    <p className="mt-2 text-slate-500 dark:text-slate-400">Sin conflictos recientes.</p>
                  )}
                </div>
                {showPending ? (
                  <div className="rounded-xl border border-slate-800 p-3">
                    <p className="font-semibold">Cambios pendientes</p>
                    {syncOverview && syncOverview.pending_total === 0 ? (
                      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Todo está sincronizado en este dispositivo.</p>
                    ) : null}
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      {syncOverview
                        ? Object.entries(syncOverview.tables).map(([table, data]) => (
                            <div key={table} className="rounded-lg bg-slate-900/60 px-3 py-2 text-sm">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium">{tableLabel(table)}</span>
                                <span>{data.pending} pendientes</span>
                              </div>
                              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                                Borrados: {data.deleted_pending} - Con error: {data.sync_error} - Sin sync_id: {data.missing_sync_id}
                              </p>
                            </div>
                          ))
                        : <p className="text-sm text-slate-500 dark:text-slate-400">Actualiza el estado para ver pendientes.</p>}
                    </div>
                  </div>
                ) : null}
                {showDevices ? (
                  <div className="rounded-xl border border-slate-800 p-3">
                    <p className="font-semibold">Dispositivos vinculados</p>
                    {cloudDevices.length === 0 ? (
                      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">No se pudieron cargar dispositivos vinculados o todavía no hay otros dispositivos.</p>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {cloudDevices.map((device) => {
                          const isCurrent = device.device_id === syncOverview?.device_id;
                          return (
                            <div key={device.device_id} className="rounded-lg bg-slate-900/60 px-3 py-2 text-sm">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium">{device.device_name || "Este dispositivo"}</span>
                                {isCurrent ? <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs text-sky-700 dark:text-sky-300">Este dispositivo</span> : null}
                              </div>
                              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                                ID: {shortDeviceId(device.device_id)} - Última actividad: {formatDate(device.last_seen_at)}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
                {showConflicts ? (
                  <div className="rounded-xl border border-slate-800 p-3">
                    <p className="font-semibold">Conflictos y cambios remotos</p>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      Total: {syncOverview?.conflicts_total ?? 0} - Recientes: {syncOverview?.conflicts_recent ?? 0}
                    </p>
                    {syncConflicts.length === 0 ? (
                      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Sin conflictos recientes.</p>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {syncConflicts.map((conflict) => (
                          <div key={conflict.conflict_id} className="rounded-lg bg-slate-900/60 px-3 py-2 text-sm">
                            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                              <span className="font-medium">{tableLabel(conflict.table_name)}</span>
                              <span className="text-amber-700 dark:text-amber-300">{resolutionLabel(conflict.resolution)}</span>
                            </div>
                            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                              Detectado: {formatDate(conflict.detected_at)} - Origen: {conflict.remote_device_name || shortDeviceId(conflict.remote_device_id)}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
                {showHistory ? (
                  <div className="rounded-xl border border-slate-800 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold">Historial reciente</p>
                      <button className="text-sm font-semibold text-sky-600 hover:underline dark:text-sky-300" type="button" onClick={refreshSyncCenter}>
                        Actualizar historial
                      </button>
                    </div>
                    {syncHistory.length === 0 ? (
                      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Todavía no hay sincronizaciones registradas.</p>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {syncHistory.slice(0, 10).map((item) => (
                          <div key={item.sync_id} className="rounded-lg bg-slate-900/60 px-3 py-2 text-sm">
                            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                              <span className="font-medium">{formatDate(item.finished_at || item.started_at)}</span>
                              <span className={item.status === "success" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                                {historyReasonLabel(item)} - {item.status === "success" ? "Exitosa" : item.status === "skipped" ? "Omitida" : "Error"}
                              </span>
                            </div>
                            {item.status === "success" ? (
                              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                                Enviados: {item.pushed_total} - Recibidos: {item.pulled_total} - Borrados: {item.deleted_total} - Conflictos: {item.conflicts_total || 0} - {(item.duration_ms / 1000).toFixed(1)}s
                              </p>
                            ) : (
                              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{item.error_message || "No se pudo sincronizar."}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="mt-5 flex justify-end">
            <button className="btn-secondary" onClick={handleLogout}>Cerrar sesión</button>
          </div>
        </section>
      ) : (
        <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="card p-6 lg:p-8">
            {verification ? (
              <>
                <div className="text-center">
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Verificación de email</p>
                  <h3 className="mt-2 text-3xl font-bold">Confirmá tu correo</h3>
                  <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500 dark:text-slate-400">
                    Ingresá el código de 6 dígitos que enviamos a {verification.email}.
                  </p>
                </div>

                <form className="mt-6 space-y-4" onSubmit={handleVerifyEmail}>
                  <label className="block text-sm">
                    Código de verificación
                    <input
                      className={`${inputClass} mt-1 text-center text-lg tracking-[0.4em]`}
                      inputMode="numeric"
                      maxLength={6}
                      pattern="[0-9]{6}"
                      value={verificationCode}
                      onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                      required
                      disabled={submitting}
                    />
                  </label>
                  <button className="btn w-full justify-center" type="submit" disabled={submitting || verificationCode.length !== 6}>
                    {submitting ? "Confirmando..." : "Confirmar"}
                  </button>
                </form>

                <div className="mt-5 flex flex-col gap-3 text-center text-sm text-slate-500 dark:text-slate-400">
                  <button
                    className="font-semibold text-sky-600 hover:underline disabled:text-slate-400 disabled:no-underline dark:text-sky-300"
                    type="button"
                    onClick={handleResendVerificationCode}
                    disabled={submitting || resendAvailableIn > 0}
                  >
                    {resendAvailableIn > 0 ? `Reenviar código en ${resendAvailableIn}s` : "Reenviar código"}
                  </button>
                  <button
                    className="font-semibold text-slate-600 hover:underline dark:text-slate-300"
                    type="button"
                    onClick={() => {
                      setVerification(null);
                      setVerificationCode("");
                      setMode("login");
                    }}
                    disabled={submitting}
                  >
                    Volver al login
                  </button>
                </div>
              </>
            ) : mode === "login" ? (
              <>
                <div className="text-center">
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">ScisoNomics</p>
                  <h3 className="mt-2 text-3xl font-bold">Iniciá sesión en ScisoNomics</h3>
                  <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500 dark:text-slate-400">
                    Podés usar ScisoNomics sin cuenta. En futuras versiones, una cuenta te permitirá respaldar y sincronizar tus datos entre dispositivos.
                  </p>
                </div>

                <div className="mt-6 grid gap-3">
                  <button className="btn-secondary w-full justify-center" type="button" onClick={handleGoogleLogin}>
                    Continuar con Google
                  </button>
                </div>

                <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-[0.18em] text-slate-400">
                  <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                  o
                  <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                </div>

                <form className="space-y-4" onSubmit={handleLogin}>
                  <label className="block text-sm">
                    Correo electrónico
                    <input className={`${inputClass} mt-1`} type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} required disabled={!configured} />
                  </label>
                  <label className="block text-sm">
                    Contraseña
                    <PasswordInput className={inputClass} value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} autoComplete="current-password" required disabled={!configured} />
                  </label>
                  <div className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300"
                        checked={remember}
                        onChange={(event) => setRemember(event.target.checked)}
                      />
                      Recordarme
                    </label>
                    <span className="text-slate-400">¿Olvidaste tu contraseña? Próximamente</span>
                  </div>
                  <button className="btn w-full justify-center" type="submit" disabled={!configured || submitting}>
                    {submitting ? "Ingresando..." : "Iniciar sesión"}
                  </button>
                </form>

                <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  No tenés una cuenta?{" "}
                  <button className="font-semibold text-sky-600 hover:underline dark:text-sky-300" type="button" onClick={() => setMode("register")}>
                    Registrate ahora.
                  </button>
                </p>
              </>
            ) : (
              <>
                <div className="text-center">
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Cuenta opcional</p>
                  <h3 className="mt-2 text-3xl font-bold">Crear cuenta</h3>
                  <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500 dark:text-slate-400">
                    La cuenta no activa sincronización de datos financieros. Tus movimientos siguen guardándose localmente.
                  </p>
                </div>

                <form className="mt-6 space-y-4" onSubmit={handleRegister}>
                  <label className="block text-sm">
                    Nombre opcional
                    <input className={`${inputClass} mt-1`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={!configured} />
                  </label>
                  <label className="block text-sm">
                    Correo electrónico
                    <input className={`${inputClass} mt-1`} type="email" value={registerEmail} onChange={(event) => setRegisterEmail(event.target.value)} required disabled={!configured} />
                  </label>
                  <label className="block text-sm">
                    Contraseña
                    <PasswordInput className={inputClass} value={registerPassword} onChange={(event) => setRegisterPassword(event.target.value)} autoComplete="new-password" minLength={8} required disabled={!configured} />
                  </label>
                  <label className="block text-sm">
                    Repetir contraseña
                    <PasswordInput className={inputClass} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} autoComplete="new-password" minLength={8} required disabled={!configured} />
                  </label>
                  <button className="btn w-full justify-center" type="submit" disabled={!configured || submitting}>
                    {submitting ? "Creando..." : "Crear cuenta"}
                  </button>
                </form>

                <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  Ya tenés cuenta?{" "}
                  <button className="font-semibold text-sky-600 hover:underline dark:text-sky-300" type="button" onClick={() => setMode("login")}>
                    Iniciá sesión.
                  </button>
                </p>
              </>
            )}
          </div>

          <aside className="card p-6">
            <h3 className="text-lg font-semibold">Modo local-first</h3>
            <div className="mt-4 space-y-3 text-sm text-slate-600 dark:text-slate-300">
              <p>La cuenta es opcional.</p>
              <p>Tus datos siguen guardándose localmente en este equipo.</p>
              <p>La sincronización automática es opcional y puede desactivarse en cualquier momento.</p>
              <p>No se sube la base de datos completa ni se reemplaza el modo local.</p>
            </div>
          </aside>
        </section>
      )}
    </section>
  );
}
