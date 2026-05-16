"use client";

import { useEffect, useState } from "react";

import { useToast } from "../../hooks/useToast";
import {
  clearStoredToken,
  cloudAuth,
  getStoredToken,
  getTokenStorageMode,
  isCloudAuthConfigured,
  setStoredToken,
  type CloudUser,
} from "../../services/cloudAuth";
import { getLastManualSyncAt, runManualSync } from "../../services/cloudSync";

type Mode = "login" | "register";

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-sky-400 dark:border-slate-700 dark:bg-slate-900";

export function AccountPanel({ showHeader = true }: { showHeader?: boolean }) {
  const configured = isCloudAuthConfigured();
  const { showError, showSuccess } = useToast();
  const [mode, setMode] = useState<Mode>("login");
  const [loadingSession, setLoadingSession] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [remember, setRemember] = useState(true);
  const [tokenMode, setTokenMode] = useState<"persistent" | "session" | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("Sin sincronizar");
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState("");
  const [user, setUser] = useState<CloudUser | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");

  function clearAuthForms() {
    setLoginEmail("");
    setLoginPassword("");
    setDisplayName("");
    setRegisterEmail("");
    setRegisterPassword("");
    setRepeatPassword("");
  }

  useEffect(() => {
    let cancelled = false;
    async function loadSession() {
      setLastSyncAt(getLastManualSyncAt());
      if (!configured) {
        setLoadingSession(false);
        return;
      }
      const token = getStoredToken();
      if (!token) {
        setLoadingSession(false);
        return;
      }
      try {
        const currentUser = await cloudAuth.me(token);
        if (!cancelled) {
          setUser(currentUser);
          setTokenMode(getTokenStorageMode());
        }
      } catch (error) {
        console.error("No se pudo validar la sesion cloud:", error);
        clearStoredToken();
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    }
    loadSession();
    return () => {
      cancelled = true;
    };
  }, [configured]);

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || submitting) return;
    setSubmitting(true);
    try {
      const response = await cloudAuth.login({ email: loginEmail, password: loginPassword });
      setStoredToken(response.access_token, remember);
      setTokenMode(remember ? "persistent" : "session");
      setUser(response.user);
      clearAuthForms();
      showSuccess("Sesion iniciada.");
    } catch (error) {
      console.error("Error iniciando sesion:", error);
      showError(error instanceof Error ? error.message : "No se pudo iniciar sesion.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegister(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || submitting) return;
    if (registerPassword !== repeatPassword) {
      showError("Las contrasenas no coinciden.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await cloudAuth.register({
        display_name: displayName || null,
        email: registerEmail,
        password: registerPassword,
      });
      setStoredToken(response.access_token, true);
      setTokenMode("persistent");
      setUser(response.user);
      clearAuthForms();
      showSuccess("Cuenta creada.");
    } catch (error) {
      console.error("Error creando cuenta:", error);
      showError(error instanceof Error ? error.message : "No se pudo crear la cuenta.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    const token = getStoredToken();
    await cloudAuth.logout(token);
    clearStoredToken();
    setTokenMode(null);
    setUser(null);
    clearAuthForms();
    showSuccess("Sesion cerrada.");
  }

  async function handleManualSync() {
    const token = getStoredToken();
    if (!token || syncing) return;
    setSyncing(true);
    setSyncMessage("Sincronizando tus datos...");
    setSyncSummary("");
    try {
      const result = await runManualSync(token, user?.email);
      setLastSyncAt(result.syncedAt);
      setSyncMessage("Sincronizacion completada");
      const uploadedTotal = Object.values(result.uploaded).reduce((sum, value) => sum + Number(value || 0), 0);
      const appliedTotal = Object.values(result.applied).reduce((sum, value) => sum + Number(value || 0), 0);
      setSyncSummary(
        `Confirmados en la nube: ${uploadedTotal}. Cambios remotos aplicados: ${appliedTotal}.`,
      );
      showSuccess("Sincronizacion completada correctamente.");
    } catch (error) {
      console.error("Error sincronizando:", error);
      setSyncMessage("Error al sincronizar");
      showError("No se pudo sincronizar. Revisa tu conexion e intenta nuevamente.");
    } finally {
      setSyncing(false);
    }
  }

  async function handleGoogleLogin() {
    if (!configured) {
      showError("El servicio de cuenta no esta configurado en este entorno.");
      return;
    }
    try {
      const result = await cloudAuth.googleStart();
      if (!result.configured || !result.authorization_url) {
        showError(result.message || "El inicio con Google todavia no esta configurado en este entorno.");
        return;
      }
      window.location.href = result.authorization_url;
    } catch (error) {
      console.error("Error iniciando Google OAuth:", error);
      showError("El inicio con Google todavia no esta configurado en este entorno.");
    }
  }

  return (
    <section className="space-y-4">
      {showHeader ? (
        <header className="card p-5">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Cuenta opcional</p>
          <h2 className="mt-2 text-2xl font-bold">Cuenta</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
            Podes usar ScisoNomics sin cuenta. Tus datos siguen guardandose localmente y la sincronizacion manual esta disponible solo si inicias sesion.
          </p>
        </header>
      ) : null}

      {!configured ? (
        <section className="card border-amber-400/40 bg-amber-500/10 p-5">
          <h3 className="text-lg font-semibold text-amber-900 dark:text-amber-100">Servicio de cuenta no configurado</h3>
          <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
            El servicio de cuenta no esta configurado en este entorno. La app sigue funcionando en modo local y tus datos continuan guardandose en este dispositivo.
          </p>
        </section>
      ) : null}

      {loadingSession ? (
        <section className="card p-5">
          <p className="text-sm text-slate-500 dark:text-slate-400">Verificando sesion...</p>
        </section>
      ) : user ? (
        <section className="card p-6">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Cuenta</p>
          <h3 className="mt-2 text-2xl font-semibold">Sesion iniciada</h3>
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/60">
            <p className="text-sm text-slate-500 dark:text-slate-400">Usuario</p>
            <p className="mt-1 font-semibold">{user.display_name || user.email}</p>
            {user.display_name ? <p className="text-sm text-slate-500 dark:text-slate-400">{user.email}</p> : null}
            {tokenMode === "persistent" ? <p className="mt-2 text-xs text-sky-700 dark:text-sky-300">Recordarme activado</p> : null}
          </div>
          <p className="mt-4 rounded-xl border border-sky-400/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-900 dark:text-sky-100">
            La sincronizacion cloud esta en etapa inicial y es manual. Tus datos siguen guardandose localmente en este dispositivo.
          </p>
          {configured ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950/40">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold">Sincronizacion manual</p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {syncMessage}
                    {lastSyncAt ? ` · Ultima sincronizacion: ${new Date(lastSyncAt).toLocaleString()}` : ""}
                  </p>
                  {syncSummary ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{syncSummary}</p> : null}
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    Esta version sincroniza manualmente categorias, movimientos, metas, gastos programados, gastos fijos y presupuestos. Los borrados tambien se sincronizan de forma segura.
                  </p>
                </div>
                <button className="btn" onClick={handleManualSync} disabled={syncing}>
                  {syncing ? "Sincronizando..." : "Sincronizar ahora"}
                </button>
              </div>
            </div>
          ) : null}
          <div className="mt-5 flex justify-end">
            <button className="btn-secondary" onClick={handleLogout}>Cerrar sesion</button>
          </div>
        </section>
      ) : (
        <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="card p-6 lg:p-8">
            {mode === "login" ? (
              <>
                <div className="text-center">
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">ScisoNomics</p>
                  <h3 className="mt-2 text-3xl font-bold">Inicia sesion en ScisoNomics</h3>
                  <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500 dark:text-slate-400">
                    Podes usar ScisoNomics sin cuenta. En futuras versiones, una cuenta te permitira respaldar y sincronizar tus datos entre dispositivos.
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
                    Correo electronico
                    <input className={`${inputClass} mt-1`} type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} required disabled={!configured} />
                  </label>
                  <label className="block text-sm">
                    Contrasena
                    <input className={`${inputClass} mt-1`} type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required disabled={!configured} />
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
                    <span className="text-slate-400">Olvidaste tu contrasena? Proximamente</span>
                  </div>
                  <button className="btn w-full justify-center" type="submit" disabled={!configured || submitting}>
                    {submitting ? "Ingresando..." : "Iniciar sesion"}
                  </button>
                </form>

                <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  No tenes una cuenta?{" "}
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
                    La cuenta no activa sincronizacion de datos financieros. Tus movimientos siguen guardandose localmente.
                  </p>
                </div>

                <form className="mt-6 space-y-4" onSubmit={handleRegister}>
                  <label className="block text-sm">
                    Nombre opcional
                    <input className={`${inputClass} mt-1`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={!configured} />
                  </label>
                  <label className="block text-sm">
                    Correo electronico
                    <input className={`${inputClass} mt-1`} type="email" value={registerEmail} onChange={(event) => setRegisterEmail(event.target.value)} required disabled={!configured} />
                  </label>
                  <label className="block text-sm">
                    Contrasena
                    <input className={`${inputClass} mt-1`} type="password" value={registerPassword} onChange={(event) => setRegisterPassword(event.target.value)} minLength={8} required disabled={!configured} />
                  </label>
                  <label className="block text-sm">
                    Repetir contrasena
                    <input className={`${inputClass} mt-1`} type="password" value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} minLength={8} required disabled={!configured} />
                  </label>
                  <button className="btn w-full justify-center" type="submit" disabled={!configured || submitting}>
                    {submitting ? "Creando..." : "Crear cuenta"}
                  </button>
                </form>

                <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  Ya tenes cuenta?{" "}
                  <button className="font-semibold text-sky-600 hover:underline dark:text-sky-300" type="button" onClick={() => setMode("login")}>
                    Inicia sesion.
                  </button>
                </p>
              </>
            )}
          </div>

          <aside className="card p-6">
            <h3 className="text-lg font-semibold">Modo local-first</h3>
            <div className="mt-4 space-y-3 text-sm text-slate-600 dark:text-slate-300">
              <p>La cuenta es opcional.</p>
              <p>Tus datos siguen guardandose localmente en este equipo.</p>
              <p>La sincronizacion es manual y solo se ejecuta cuando tocas Sincronizar ahora.</p>
              <p>No se suben movimientos, categorias, presupuestos, metas ni gastos a la nube.</p>
            </div>
          </aside>
        </section>
      )}
    </section>
  );
}
