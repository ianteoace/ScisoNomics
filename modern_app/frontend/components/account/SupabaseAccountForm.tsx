"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  completePasswordRecovery, isSupabaseCloudAuthConfigured, requestPasswordReset,
  resendSignupVerification, signInWithPassword, signUpWithPassword, verifyEmailCode,
} from "../../services/supabaseCloudAuth";
import { PasswordInput } from "../ui/PasswordInput";
import { isSupabaseSecureStorageAvailable } from "../../services/supabaseTokenStorage";
import { CloudAuthRequestError } from "../../services/cloudAuth";
import {
  cancelGoogleSupabaseSignIn, dismissGoogleOAuthNotice, getGoogleOAuthServerState,
  getGoogleOAuthState, signInWithGoogleSupabase, subscribeGoogleOAuth,
} from "../../services/supabaseGoogleAuth";

type Mode = "login" | "register" | "verification_required" | "recovery";
const RESEND_COOLDOWN_SECONDS = 60;
const inputClass = "mt-1 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-400";

export function SupabaseAccountForm({ onAuthenticated, onBusyChange }: {
  onAuthenticated: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const configured = isSupabaseCloudAuthConfigured();
  const secureStorageAvailable = isSupabaseSecureStorageAvailable();
  const [remember, setRemember] = useState(secureStorageAvailable);
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [clockNow, setClockNow] = useState(0);
  const [password, setPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [recoverySent, setRecoverySent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const google = useSyncExternalStore(subscribeGoogleOAuth, getGoogleOAuthState, getGoogleOAuthServerState);
  const startedGoogleHere = useRef(false);
  const googleBusy = ["opening", "waiting", "processing"].includes(google.status);
  const formBusy = busy || googleBusy;
  useEffect(() => {
    onBusyChange(formBusy);
    return () => onBusyChange(false);
  }, [formBusy, onBusyChange]);
  useEffect(() => {
    if (google.status === "succeeded" && startedGoogleHere.current) {
      startedGoogleHere.current = false;
      onAuthenticated();
    }
  }, [google.status, onAuthenticated]);
  useEffect(() => () => {
    if (startedGoogleHere.current && ["opening", "waiting"].includes(getGoogleOAuthState().status)) void cancelGoogleSupabaseSignIn();
  }, []);
  const needsNewPassword = mode === "register" || (mode === "recovery" && recoverySent);
  const needsPassword = mode === "login" || needsNewPassword;
  const verifyingSignup = mode === "verification_required";
  const needsCode = verifyingSignup || (mode === "recovery" && recoverySent);
  const resendWait = Math.max(0, Math.ceil((resendAvailableAt - clockNow) / 1000));

  useEffect(() => {
    if (!(verifyingSignup || (mode === "recovery" && recoverySent)) || resendWait <= 0) return;
    const timer = window.setTimeout(() => setClockNow(Date.now()), 1000);
    return () => window.clearTimeout(timer);
  }, [verifyingSignup, mode, recoverySent, resendWait, resendAvailableAt, clockNow]);

  function startResendCooldown() {
    const now = Date.now();
    setClockNow(now);
    setResendAvailableAt(now + RESEND_COOLDOWN_SECONDS * 1000);
  }

  function changeMode(next: Mode) {
    dismissGoogleOAuthNotice();
    setMode(next);
    setPassword("");
    setRepeatPassword("");
    setCode("");
    setError("");
    setNotice("");
    setRecoverySent(false);
    setVerificationEmail(null);
    setResendAvailableAt(0);
  }

  function resendCode() {
    if (resendWait > 0) return;
    void run(async () => {
      try {
        await resendSignupVerification(verificationEmail || email);
        setCode("");
        startResendCooldown();
        setNotice("Si corresponde, recibirás un nuevo código por correo. Ingresalo acá para confirmar tu cuenta.");
      } catch (failure) {
        if (failure instanceof CloudAuthRequestError && (failure.statusCode === 429
          || failure.code === "over_email_send_rate_limit" || failure.code === "over_request_rate_limit")) startResendCooldown();
        throw failure;
      }
    });
  }

  function resendRecoveryCode() {
    if (resendWait > 0) return;
    void run(async () => {
      try {
        await requestPasswordReset(email);
        setCode("");
        startResendCooldown();
        setNotice("Si existe una cuenta con ese email, recibirás un nuevo código de recuperación.");
      } catch (failure) {
        if (failure instanceof CloudAuthRequestError && failure.statusCode === 429) startResendCooldown();
        throw failure;
      }
    });
  }

  async function run(action: () => Promise<void>) {
    if (formBusy || !configured) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo completar la acción. Intentá nuevamente.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (needsNewPassword && (password.length < 12 || password !== repeatPassword)) {
      setError(password.length < 12 ? "La contraseña debe tener al menos 12 caracteres." : "Las contraseñas no coinciden.");
      return;
    }
    void run(async () => {
      if (mode === "register") {
        const result = await signUpWithPassword(email, password, displayName, { remember });
        setPassword("");
        setRepeatPassword("");
        if (result.status === "verification_required") {
          setEmail(result.email);
          setVerificationEmail(result.email);
          setCode("");
          setMode("verification_required");
          startResendCooldown();
          setNotice("Revisá tu correo e ingresá el código de confirmación acá. No necesitás abrir un enlace ni salir de ScisoNomics.");
          return;
        }
      } else if (verifyingSignup) {
        await verifyEmailCode(verificationEmail || email, code, { remember });
      } else if (mode === "recovery") {
        if (!recoverySent) {
          await requestPasswordReset(email);
          setRecoverySent(true);
          startResendCooldown();
          setNotice("Si existe una cuenta con ese email, recibirás un código de recuperación. Ingresalo acá para cambiar la contraseña.");
        } else {
          await completePasswordRecovery(email, code, password);
          changeMode("login");
          setNotice("Contraseña actualizada. Iniciá sesión para agregar tu cuenta.");
        }
        return;
      } else {
        await signInWithPassword(email, password, { remember });
      }
      setPassword("");
      setRepeatPassword("");
      setCode("");
      setVerificationEmail(null);
      onAuthenticated();
    });
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {mode === "register" ? "Creá tu cuenta. Confirmarás tu correo con un código dentro de ScisoNomics."
          : verifyingSignup ? "Ingresá el código que enviamos a tu correo para completar el registro."
            : mode === "recovery" ? "Recuperá tu contraseña con un código enviado a tu correo."
              : "Ingresá para acceder a tu cuenta en este dispositivo. También podés seguir en modo local."}
      </p>
      {!configured ? <p role="status" className="text-sm text-amber-700 dark:text-amber-200">El servicio de cuenta no está configurado. Podés continuar en modo local.</p> : null}
      {notice ? <p role="status" className="text-sm text-sky-700 dark:text-sky-200">{notice}</p> : null}
      {error || google.status === "error" ? <p role="alert" className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-200">{error || google.message}</p> : null}
      <label className="block text-sm">Email
        <input className={inputClass} type="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); if (verifyingSignup) setCode(""); }} required disabled={formBusy || !configured || (verifyingSignup && verificationEmail !== null) || (mode === "recovery" && recoverySent)} />
      </label>
      {mode === "register" ? <label className="block text-sm">Nombre opcional
        <input className={inputClass} autoComplete="name" maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={formBusy || !configured} />
      </label> : null}
      {needsCode ? <label className="block text-sm">Código del correo
        <input className={inputClass} autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} minLength={verifyingSignup ? 6 : undefined} maxLength={verifyingSignup ? 10 : 128} pattern={verifyingSignup ? "[0-9]{6,10}" : undefined} title={verifyingSignup ? "Ingresá los dígitos del código recibido por correo." : undefined} required disabled={formBusy || !configured} />
      </label> : null}
      {needsPassword ? <label className="block text-sm">{needsNewPassword ? "Nueva contraseña" : "Contraseña"}
        <PasswordInput className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={needsNewPassword ? "new-password" : "current-password"} minLength={needsNewPassword ? 12 : undefined} required disabled={formBusy || !configured} />
      </label> : null}
      {needsNewPassword ? <label className="block text-sm">Repetir contraseña
        <PasswordInput className={inputClass} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} autoComplete="new-password" minLength={12} required disabled={formBusy || !configured} />
      </label> : null}
      {mode !== "recovery" && secureStorageAvailable ? <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={formBusy} />
        Recordar esta cuenta en el almacenamiento seguro de este dispositivo
      </label> : null}
      <p className="text-xs text-slate-500 dark:text-slate-400">{secureStorageAvailable && remember ? "Tu sesión se restaura al iniciar la app y se guarda de forma segura en este dispositivo."
        : "Esta sesión es temporal y no se recuerda al cerrar la app."}</p>
      <button className="btn w-full justify-center" type="submit" disabled={formBusy || !configured}>
        {busy ? "Procesando..." : mode === "register" ? "Crear cuenta" : verifyingSignup ? "Confirmar código" : mode === "recovery" ? recoverySent ? "Cambiar contraseña" : "Enviar código" : "Iniciar sesión"}
      </button>
      {mode === "login" || mode === "register" ? <>
        <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-[0.18em] text-slate-400" aria-hidden="true">
          <span className="h-px flex-1 bg-slate-700" />o<span className="h-px flex-1 bg-slate-700" />
        </div>
        <button className="btn-secondary w-full justify-center" type="button" disabled={formBusy || !configured || !secureStorageAvailable} onClick={() => {
          startedGoogleHere.current = true;
          setError("");
          setNotice("");
          void signInWithGoogleSupabase({ remember }).catch((failure) => setError(failure instanceof CloudAuthRequestError ? failure.message : "No pudimos iniciar Google. Volvé a intentar."));
        }}>Continuar con Google</button>
        {!secureStorageAvailable ? <p className="text-xs text-slate-500 dark:text-slate-400">El acceso con Google requiere la app de escritorio.</p> : null}
      </> : null}
      {googleBusy ? <p role="status" className="text-sm text-sky-700 dark:text-sky-200">
        {google.status === "opening" ? "Abriendo Google..." : google.status === "waiting" ? "Esperando confirmación..." : "Procesando inicio de sesión..."}
        {google.status !== "processing" ? <button type="button" className="ml-2 font-semibold underline" onClick={() => void cancelGoogleSupabaseSignIn()}>Cancelar</button> : null}
      </p> : null}
      {verifyingSignup ? <>
        <button className="btn-secondary w-full justify-center" type="button" disabled={formBusy || !configured || resendWait > 0 || !(verificationEmail || email).trim()} onClick={resendCode}>
          {resendWait > 0 ? `Reenviar código en ${resendWait}s` : "Reenviar código"}
        </button>
        {verificationEmail ? <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={formBusy} onClick={() => changeMode("register")}>Usar otro email</button> : null}
      </> : null}
      {mode === "recovery" && recoverySent ? (
        <button className="btn-secondary w-full justify-center" type="button" disabled={formBusy || !configured || resendWait > 0} onClick={resendRecoveryCode}>
          {resendWait > 0 ? `Reenviar código en ${resendWait}s` : "Reenviar código"}
        </button>
      ) : null}
      <div className="flex flex-wrap gap-3 text-sm">
        <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={formBusy} onClick={() => changeMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "¿No tenés cuenta? Crear cuenta" : "Volver al inicio de sesión"}</button>
        {mode === "login" ? <>
          <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={formBusy} onClick={() => changeMode("verification_required")}>Confirmar correo con código</button>
          <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={formBusy} onClick={() => changeMode("recovery")}>¿Olvidaste tu contraseña?</button>
        </> : null}
      </div>
    </form>
  );
}
