"use client";

import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useToast } from "../../hooks/useToast";
import {
  DEFAULT_REMEMBER_CLOUD_ACCOUNT,
  addOrUpdateAccount,
  cloudAuth,
  getCloudAuthTokens,
  getStoredAccounts,
  isCloudAuthConfigured,
  isCloudAuthRequestError,
  isEmailVerificationRequiredResponse,
  type EmailVerificationRequiredResponse,
} from "../../services/cloudAuth";
import { Modal } from "../ui/Modal";
import { PasswordInput } from "../ui/PasswordInput";

const inputClass =
  "mt-1 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400";
type PendingVerification = EmailVerificationRequiredResponse & { source: "login" | "register" };

export function AddAccountModal({
  open,
  onClose,
  onAccountAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAccountAdded?: () => void;
}) {
  const configured = isCloudAuthConfigured();
  const { showError, showSuccess } = useToast();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [remember, setRemember] = useState(DEFAULT_REMEMBER_CLOUD_ACCOUNT);
  const [submitting, setSubmitting] = useState(false);
  const [googleWaiting, setGoogleWaiting] = useState(false);
  const [error, setError] = useState("");
  const [verification, setVerification] = useState<PendingVerification | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [resendAvailableIn, setResendAvailableIn] = useState(0);
  const [showLoginRecovery, setShowLoginRecovery] = useState(false);
  const googleCancelledRef = useRef(false);
  const googlePollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function resetForm() {
    setMode("login");
    setEmail("");
    setPassword("");
    setDisplayName("");
    setRepeatPassword("");
    setRemember(DEFAULT_REMEMBER_CLOUD_ACCOUNT);
    setGoogleWaiting(false);
    setError("");
    setVerification(null);
    setVerificationCode("");
    setResendAvailableIn(0);
    setShowLoginRecovery(false);
  }

  function closeModal() {
    if (submitting) return;
    cancelGooglePolling();
    resetForm();
    onClose();
  }

  function cancelGooglePolling() {
    googleCancelledRef.current = true;
    if (googlePollTimerRef.current) {
      clearTimeout(googlePollTimerRef.current);
      googlePollTimerRef.current = null;
    }
    setGoogleWaiting(false);
  }

  useEffect(() => {
    return () => cancelGooglePolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!verification || resendAvailableIn <= 0) return;
    const timer = window.setTimeout(() => setResendAvailableIn((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [verification, resendAvailableIn]);

  async function completeVerifiedLogin(response: Awaited<ReturnType<typeof cloudAuth.verifyEmail>>) {
    const accountsBefore = getStoredAccounts();
    const existed = accountsBefore.some((account) => account.user.id === response.user.id);
    const stored = await addOrUpdateAccount({ user: response.user, tokens: getCloudAuthTokens(response) }, { remember, makeActive: true });
    resetForm();
    onClose();
    onAccountAdded?.();
    if (remember && !stored.secureResult.storedSecurely) {
      showError("No pudimos guardar la sesión de forma segura. Vas a tener que iniciar sesión nuevamente al abrir la app.");
    }
    showSuccess(verification?.source === "register" ? "Cuenta verificada y agregada correctamente." : existed ? "Cuenta actualizada y activada." : "Cuenta agregada correctamente.");
  }

  async function openExternalUrl(url: string) {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      await openUrl(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function pollGoogleStatus(loginRequestId: string, startedAt: number) {
    if (googleCancelledRef.current) return;
    if (Date.now() - startedAt > 3 * 60 * 1000) {
      setError("No pudimos confirmar el inicio de sesión con Google. Intentá nuevamente.");
      setGoogleWaiting(false);
      return;
    }
    try {
      const status = await cloudAuth.googleStatus(loginRequestId);
      if (googleCancelledRef.current) return;
      if (status.status === "pending") {
        googlePollTimerRef.current = setTimeout(() => void pollGoogleStatus(loginRequestId, startedAt), 2000);
        return;
      }
      if (status.status === "completed") {
        const stored = await addOrUpdateAccount({ user: status.user, tokens: getCloudAuthTokens(status) }, { remember, makeActive: true });
        cancelGooglePolling();
        resetForm();
        onClose();
        onAccountAdded?.();
        if (remember && !stored.secureResult.storedSecurely) {
          showError("No pudimos guardar la sesión de forma segura. Vas a tener que iniciar sesión nuevamente al abrir la app.");
        }
        showSuccess("Cuenta agregada con Google.");
        return;
      }
      setError(status.message || "No se pudo completar Google Login.");
      setGoogleWaiting(false);
    } catch (err) {
      console.error("No se pudo consultar el estado de Google Login:", err);
      setError("No pudimos confirmar el inicio de sesión con Google. Intentá nuevamente.");
      setGoogleWaiting(false);
    }
  }

  async function handleGoogleLogin() {
    if (!configured || submitting || googleWaiting) return;
    setError("");
    console.info("[auth] login submit", JSON.stringify({ mode: "google", remember }));
    googleCancelledRef.current = false;
    setGoogleWaiting(true);
    try {
      const result = await cloudAuth.googleStart();
      await openExternalUrl(result.auth_url);
      void pollGoogleStatus(result.login_request_id, Date.now());
    } catch (err) {
      console.error("No se pudo iniciar Google Login:", err);
      const message = err instanceof Error ? err.message : "Google Login no está configurado.";
      setError(message);
      showError(message);
      setGoogleWaiting(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || submitting || googleWaiting) return;
    if (mode === "register" && password.length < 12) {
      setError("La contraseña debe tener al menos 12 caracteres.");
      return;
    }
    if (mode === "register" && password !== repeatPassword) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setSubmitting(true);
    setError("");
    setShowLoginRecovery(false);
    console.info("[auth] login submit", JSON.stringify({ mode, remember }));
    try {
      const accountsBefore = getStoredAccounts();
      const response =
        mode === "register"
          ? await cloudAuth.register({ email, password, display_name: displayName || null })
          : await cloudAuth.login({ email, password });
      if (isEmailVerificationRequiredResponse(response)) {
        setVerification({ ...response, source: mode });
        setVerificationCode("");
        setResendAvailableIn(response.resend_available_in || 0);
        if (response.resend_available_in > 0) {
          showSuccess("Te enviamos un código de verificación por correo.");
        } else {
          setError("La cuenta está pendiente de verificación. Pedí un nuevo código para continuar.");
        }
        return;
      }
      const existed = accountsBefore.some((account) => account.user.id === response.user.id);
      const stored = await addOrUpdateAccount({ user: response.user, tokens: getCloudAuthTokens(response) }, { remember, makeActive: true });
      resetForm();
      onClose();
      onAccountAdded?.();
      if (remember && !stored.secureResult.storedSecurely) {
        showError("No pudimos guardar la sesión de forma segura. Vas a tener que iniciar sesión nuevamente al abrir la app.");
      }
      showSuccess(mode === "register" ? "Cuenta creada y agregada correctamente." : existed ? "Cuenta actualizada y activada." : "Cuenta agregada correctamente.");
    } catch (err) {
      console.error("No se pudo agregar la cuenta:", err);
      if (isCloudAuthRequestError(err) && err.code === "email_delivery_failed" && err.verification) {
        setVerification({ ...err.verification, source: mode });
        setVerificationCode("");
        setResendAvailableIn(0);
        const deliveryMessage = "La cuenta quedó creada, pero el correo no pudo enviarse. Podés reintentar el envío.";
        setError(deliveryMessage);
        showError(deliveryMessage);
        return;
      }
      if (isCloudAuthRequestError(err) && err.kind === "timeout") {
        const timeoutMessage = "La solicitud tardó demasiado. La cuenta puede haberse creado; podés ir a iniciar sesión para recuperar la verificación.";
        setError(timeoutMessage);
        setShowLoginRecovery(true);
        showError(timeoutMessage);
        return;
      }
      const message = err instanceof Error ? err.message : "";
      const friendly =
        message.toLowerCase().includes("fetch") || message.toLowerCase().includes("conectar")
          ? "No pudimos conectar con el servidor. Intentá nuevamente."
          : message || "Email o contraseña incorrectos.";
      setError(friendly);
      showError(friendly);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!verification || submitting) return;
    const code = verificationCode.replace(/\D/g, "");
    if (code.length !== 6) {
      setError("Ingresá el código de 6 dígitos.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await cloudAuth.verifyEmail({ verification_token: verification.verification_token, code });
      await completeVerifiedLogin(response);
    } catch (err) {
      console.error("No se pudo verificar el email:", err);
      const message = err instanceof Error ? err.message : "No se pudo verificar el código.";
      setError(message);
      showError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendVerificationCode() {
    if (!verification || submitting || resendAvailableIn > 0) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await cloudAuth.resendEmailVerification({ verification_token: verification.verification_token });
      setVerification({ ...response, source: verification.source });
      setVerificationCode("");
      setResendAvailableIn(response.resend_available_in || 60);
      showSuccess("Te enviamos un nuevo código.");
    } catch (err) {
      console.error("No se pudo reenviar el código:", err);
      if (isCloudAuthRequestError(err) && err.code === "email_delivery_failed" && err.verification) {
        setVerification({ ...err.verification, source: verification.source });
        setResendAvailableIn(0);
      }
      const message = err instanceof Error ? err.message : "No se pudo reenviar el código.";
      setError(message);
      showError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} title={verification ? "Confirmá tu correo" : mode === "register" ? "Crear cuenta" : "Agregar cuenta"} onClose={closeModal} size="md">
      <form className="space-y-4" onSubmit={verification ? handleVerifyEmail : handleSubmit}>
        {verification ? (
          <>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Ingresá el código de 6 dígitos que enviamos a {verification.email}.
            </p>
            {error ? (
              <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-200">
                {error}
              </div>
            ) : null}
            <label className="block text-sm">
              Código de verificación
              <input
                className={`${inputClass} text-center text-lg tracking-[0.4em]`}
                inputMode="numeric"
                maxLength={6}
                pattern="[0-9]{6}"
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                required
                disabled={submitting}
              />
            </label>
            <button className="btn-secondary w-full justify-center" type="button" onClick={handleResendVerificationCode} disabled={submitting || resendAvailableIn > 0}>
              {resendAvailableIn > 0 ? `Reenviar código en ${resendAvailableIn}s` : "Reenviar código"}
            </button>
            <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
              <button
                className="btn-secondary"
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
              <button className="btn" type="submit" disabled={submitting || verificationCode.length !== 6}>
                {submitting ? "Confirmando..." : "Confirmar"}
              </button>
            </div>
          </>
        ) : (
          <>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {mode === "register"
            ? "Creá una cuenta opcional para usarla en este dispositivo y cambiar rápidamente entre cuentas."
            : "La cuenta se guardará en este dispositivo para que puedas cambiar rápidamente entre cuentas."}
        </p>
        {!configured ? (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            El servicio de cuenta no está configurado en este entorno.
          </div>
        ) : null}
        {error ? (
          <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-200">
            {error}
          </div>
        ) : null}
        {showLoginRecovery ? (
          <button
            className="btn-secondary w-full justify-center"
            type="button"
            onClick={() => {
              setMode("login");
              setRepeatPassword("");
              setError("");
              setShowLoginRecovery(false);
            }}
          >
            Ir a iniciar sesión
          </button>
        ) : null}
        <button className="btn-secondary w-full justify-center" type="button" onClick={handleGoogleLogin} disabled={!configured || submitting || googleWaiting}>
          {googleWaiting ? "Esperando confirmación de Google..." : "Continuar con Google"}
        </button>
        {googleWaiting ? (
          <div className="rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-800 dark:text-sky-200">
            Esperando confirmación de Google. Completá el login en el navegador externo.
            <button className="ml-2 font-semibold underline" type="button" onClick={cancelGooglePolling}>
              Cancelar
            </button>
          </div>
        ) : null}
        <div className="my-2 flex items-center gap-3 text-xs uppercase tracking-[0.18em] text-slate-400">
          <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          o
          <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        </div>
        {mode === "register" ? (
          <label className="block text-sm">
            Nombre opcional
            <input
              className={inputClass}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
              disabled={!configured || submitting || googleWaiting}
            />
          </label>
        ) : null}
        <label className="block text-sm">
          Email
          <input
            className={inputClass}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
            disabled={!configured || submitting || googleWaiting}
          />
        </label>
        <label className="block text-sm">
          Contraseña
          <PasswordInput
            className={inputClass}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            minLength={mode === "register" ? 12 : undefined}
            required
            disabled={!configured || submitting || googleWaiting}
          />
          {mode === "register" ? (
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">Mínimo 12 caracteres.</span>
          ) : null}
        </label>
        {mode === "register" ? (
          <label className="block text-sm">
            Repetir contraseña
            <PasswordInput
              className={inputClass}
              value={repeatPassword}
              onChange={(event) => setRepeatPassword(event.target.value)}
              autoComplete="new-password"
              minLength={12}
              required
              disabled={!configured || submitting || googleWaiting}
            />
          </label>
        ) : null}
        <label className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            disabled={submitting || googleWaiting}
          />
          Recordar esta cuenta en este dispositivo
        </label>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {mode === "login" ? "No tenés una cuenta? " : "Ya tenés una cuenta? "}
          <button
            className="font-semibold text-sky-600 hover:underline dark:text-sky-300"
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
            disabled={submitting || googleWaiting}
          >
            {mode === "login" ? "Registrate ahora." : "Iniciá sesión."}
          </button>
        </p>
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <button className="btn-secondary" type="button" onClick={closeModal} disabled={submitting}>
            Cancelar
          </button>
          <button className="btn" type="submit" disabled={!configured || submitting || googleWaiting}>
            {submitting ? "Procesando..." : mode === "register" ? "Crear cuenta y agregar" : "Iniciar sesión y agregar cuenta"}
          </button>
        </div>
          </>
        )}
      </form>
    </Modal>
  );
}
