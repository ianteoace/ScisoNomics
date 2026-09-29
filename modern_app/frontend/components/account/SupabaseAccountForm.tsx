"use client";

import { useState, type FormEvent } from "react";
import {
  completePasswordRecovery, isSupabaseCloudAuthConfigured, requestPasswordReset,
  resendSignupVerification, signInWithPassword, signUpWithPassword, verifyEmailCode,
} from "../../services/supabaseCloudAuth";
import { PasswordInput } from "../ui/PasswordInput";

type Mode = "login" | "register" | "verify" | "recovery";
const inputClass = "mt-1 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-400";

export function SupabaseAccountForm({ onAuthenticated, onBusyChange }: {
  onAuthenticated: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const configured = isSupabaseCloudAuthConfigured();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
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
  const needsCode = mode === "verify" || (mode === "recovery" && recoverySent);

  function changeMode(next: Mode) {
    setMode(next);
    setPassword("");
    setRepeatPassword("");
    setCode("");
    setError("");
    setNotice("");
    setRecoverySent(false);
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
        const result = await signUpWithPassword(email, password, displayName);
        setPassword("");
        setRepeatPassword("");
        if (result.status === "verification_required") {
          setMode("verify");
          setNotice("Revisá tu correo. Si recibiste un enlace, confirmalo y volvé a iniciar sesión. Si incluye un código, podés ingresarlo acá.");
          return;
        }
      } else if (mode === "verify") {
        await verifyEmailCode(email, code);
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
        await signInWithPassword(email, password);
      }
      setPassword("");
      setRepeatPassword("");
      setCode("");
      onAuthenticated();
    });
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {mode === "register" ? "Creá tu acceso con Supabase. Para usar la cuenta cloud necesitás una cuenta previa de ScisoNomics con el mismo email; el alta interna de cuentas nuevas llegará en la siguiente fase."
          : mode === "verify" ? "Confirmá tu correo de Supabase. La verificación no crea una cuenta interna de ScisoNomics."
            : mode === "recovery" ? "Recuperá tu contraseña de Supabase mediante un código por correo."
              : "Ingresá con Supabase para activar tu cuenta de ScisoNomics en este dispositivo."}
      </p>
      {!configured ? <p role="status" className="text-sm text-amber-700 dark:text-amber-200">Supabase no está configurado. Podés usar el acceso anterior o continuar en modo local.</p> : null}
      {notice ? <p role="status" className="text-sm text-sky-700 dark:text-sky-200">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-200">{error}</p> : null}
      <label className="block text-sm">Email
        <input className={inputClass} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={busy || !configured || (mode === "recovery" && recoverySent)} />
      </label>
      {mode === "register" ? <label className="block text-sm">Nombre opcional
        <input className={inputClass} autoComplete="name" maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={busy || !configured} />
      </label> : null}
      {needsCode ? <label className="block text-sm">Código del correo
        <input className={inputClass} autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} maxLength={128} required disabled={busy || !configured} />
      </label> : null}
      {needsPassword ? <label className="block text-sm">{needsNewPassword ? "Nueva contraseña" : "Contraseña"}
        <PasswordInput className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={needsNewPassword ? "new-password" : "current-password"} minLength={needsNewPassword ? 12 : undefined} required disabled={busy || !configured} />
      </label> : null}
      {needsNewPassword ? <label className="block text-sm">Repetir contraseña
        <PasswordInput className={inputClass} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} autoComplete="new-password" minLength={12} required disabled={busy || !configured} />
      </label> : null}
      <p className="text-xs text-slate-500 dark:text-slate-400">Esta sesión no se recuerda al cerrar la app. Podés cambiar entre tus cuentas mientras la sesión esté disponible.</p>
      <button className="btn w-full justify-center" type="submit" disabled={busy || !configured}>
        {busy ? "Procesando..." : mode === "register" ? "Registrarse con Supabase" : mode === "verify" ? "Confirmar código" : mode === "recovery" ? recoverySent ? "Cambiar contraseña" : "Enviar correo de recuperación" : "Ingresar con Supabase"}
      </button>
      {mode === "verify" ? <button className="btn-secondary w-full justify-center" type="button" disabled={busy || !configured} onClick={() => void run(async () => {
        await resendSignupVerification(email);
        setNotice("Si corresponde, recibirás un nuevo correo de confirmación.");
      })}>Reenviar confirmación</button> : null}
      <div className="flex flex-wrap gap-3 text-sm">
        <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={busy} onClick={() => changeMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "Crear acceso Supabase" : "Volver al login"}</button>
        {mode === "login" ? <>
          <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={busy} onClick={() => changeMode("verify")}>Confirmar correo</button>
          <button className="font-semibold text-sky-600 dark:text-sky-300" type="button" disabled={busy} onClick={() => changeMode("recovery")}>Olvidé mi contraseña</button>
        </> : null}
      </div>
    </form>
  );
}
