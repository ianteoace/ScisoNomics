"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  completePasswordRecovery, isSupabaseCloudAuthConfigured, requestPasswordReset,
  resendSignupVerification, signInWithPassword, signUpWithPassword, verifyEmailCode,
} from "../../services/supabaseCloudAuth";
import { PasswordInput } from "../ui/PasswordInput";
import { isSupabaseSecureStorageAvailable } from "../../services/supabaseTokenStorage";
import { CloudAuthRequestError } from "../../services/cloudAuth";

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
  const needsNewPassword = mode === "register" || (mode === "recovery" && recoverySent);
  const needsPassword = mode === "login" || needsNewPassword;
  const verifyingSignup = mode === "verification_required";
  const needsCode = verifyingSignup || (mode === "recovery" && recoverySent);
  const resendWait = Math.max(0, Math.ceil((resendAvailableAt - clockNow) / 1000));

  useEffect(() => {
    if (!verifyingSignup || resendWait <= 0) return;
    const timer = window.setTimeout(() => setClockNow(Date.now()), 1000);
    return () => window.clearTimeout(timer);
  }, [verifyingSignup, resendWait, resendAvailableAt, clockNow]);

  function startResendCooldown() {
    const now = Date.now();
    setClockNow(now);
    setResendAvailableAt(now + RESEND_COOLDOWN_SECONDS * 1000);
  }

  function changeMode(next: Mode) {
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

  async function run(action: () => Promise<void>) {
    if (busy || !configured) return;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo completar la acción. Intentá nuevamente.");
    } finally {
      setBusy(false);
      onBusyChange(false);
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
          setNotice("Si existe una cuenta, recibirás un correo de recuperación. Usá su código para cambiar la contraseña acá. Los enlaces de recuperación todavía no se abren dentro de esta app.");
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
        {mode === "register" ? "Creá tu acceso con Supabase. Al confirmar tu correo, ScisoNomics creará tu cuenta interna o vinculará tu cuenta anterior con el mismo email."
          : verifyingSignup ? "Correo pendiente de verificación. Ingresá el código de Supabase para completar el alta de tu cuenta de ScisoNomics."
            : mode === "recovery" ? "Recuperá tu contraseña de Supabase mediante un código por correo."
              : "Ingresá con Supabase para activar tu cuenta de ScisoNomics en este dispositivo."}
      </p>
      {!configured ? <p role="status" className="text-sm text-amber-700 dark:text-amber-200">Supabase no está configurado. Podés usar el acceso anterior o continuar en modo local.</p> : null}
      {notice ? <p role="status" className="text-sm text-sky-700 dark:text-sky-200">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-200">{error}</p> : null}
      <label className="block text-sm">Email
        <input className={inputClass} type="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); if (verifyingSignup) setCode(""); }} required disabled={busy || !configured || (verifyingSignup && verificationEmail !== null) || (mode === "recovery" && recoverySent)} />
      </label>
      {mode === "register" ? <label className="block text-sm">Nombre opcional
        <input className={inputClass} autoComplete="name" maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={busy || !configured} />
      </label> : null}
      {needsCode ? <label className="block text-sm">Código del correo
        <input className={inputClass} autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} minLength={verifyingSignup ? 6 : undefined} maxLength={verifyingSignup ? 10 : 128} pattern={verifyingSignup ? "[0-9]{6,10}" : undefined} title={verifyingSignup ? "Ingresá los dígitos del código recibido por correo." : undefined} required disabled={busy || !configured} />
      </label> : null}
      {needsPassword ? <label className="block text-sm">{needsNewPassword ? "Nueva contraseña" : "Contraseña"}
        <PasswordInput className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={needsNewPassword ? "new-password" : "current-password"} minLength={needsNewPassword ? 12 : undefined} required disabled={busy || !configured} />
      </label> : null}
      {needsNewPassword ? <label className="block text-sm">Repetir contraseña
        <PasswordInput className={inputClass} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} autoComplete="new-password" minLength={12} required disabled={busy || !configured} />
      </label> : null}
      {mode !== "recovery" && secureStorageAvailable ? <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} />
        Recordar esta cuenta en el almacenamiento seguro de este dispositivo
      </label> : null}
      <p className="text-xs text-slate-500 dark:text-slate-400">{secureStorageAvailable && remember ? "El acceso se restaura al iniciar la app. El refresh token se guarda en el almacenamiento seguro del sistema."
        : "Esta sesión es temporal y no se recuerda al cerrar la app."}</p>
      <button className="btn w-full justify-center" type="submit" disabled={busy || !configured}>
        {busy ? "Procesando..." : mode === "register" ? "Registrarse con Supabase" : verifyingSignup ? "Confirmar código" : mode === "recovery" ? recoverySent ? "Cambiar contraseña" : "Enviar correo de recuperación" : "Ingresar con Supabase"}
      </button>
      {verifyingSignup ? <>
        <button className="btn-secondary w-full justify-center" type="button" disabled={busy || !configured || resendWait > 0 || !(verificationEmail || email).trim()} onClick={resendCode}>
          {resendWait > 0 ? `Reenviar código en ${resendWait}s` : "Reenviar código"}
        </button>
        {verificationEmail ? <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={busy} onClick={() => changeMode("register")}>Usar otro email</button> : null}
      </> : null}
      <div className="flex flex-wrap gap-3 text-sm">
        <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={busy} onClick={() => changeMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "Crear acceso Supabase" : "Volver al login"}</button>
        {mode === "login" ? <>
          <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={busy} onClick={() => changeMode("verification_required")}>Confirmar correo con código</button>
          <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={busy} onClick={() => changeMode("recovery")}>Olvidé mi contraseña</button>
        </> : null}
      </div>
    </form>
  );
}
