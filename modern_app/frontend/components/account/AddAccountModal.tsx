"use client";

import { useState } from "react";

import { useToast } from "../../hooks/useToast";
import { addOrUpdateAccount, cloudAuth, getStoredAccounts, isCloudAuthConfigured } from "../../services/cloudAuth";
import { Modal } from "../ui/Modal";
import { PasswordInput } from "../ui/PasswordInput";

const inputClass =
  "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-sky-400 dark:border-slate-700 dark:bg-slate-900";

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
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function resetForm() {
    setMode("login");
    setEmail("");
    setPassword("");
    setDisplayName("");
    setRepeatPassword("");
    setRemember(true);
    setError("");
  }

  function closeModal() {
    if (submitting) return;
    resetForm();
    onClose();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || submitting) return;
    if (mode === "register" && password !== repeatPassword) {
      setError("Las contrasenas no coinciden.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const accountsBefore = getStoredAccounts();
      const response =
        mode === "register"
          ? await cloudAuth.register({ email, password, display_name: displayName || null })
          : await cloudAuth.login({ email, password });
      const existed = accountsBefore.some((account) => account.user.id === response.user.id);
      addOrUpdateAccount({ token: response.access_token, user: response.user }, { remember: mode === "register" ? true : remember, makeActive: true });
      resetForm();
      onClose();
      onAccountAdded?.();
      showSuccess(mode === "register" ? "Cuenta creada y agregada correctamente." : existed ? "Cuenta actualizada y activada." : "Cuenta agregada correctamente.");
    } catch (err) {
      console.error("No se pudo agregar la cuenta:", err);
      const message = err instanceof Error ? err.message : "";
      const friendly =
        message.toLowerCase().includes("fetch") || message.toLowerCase().includes("conectar")
          ? "No pudimos conectar con el servidor. Intenta nuevamente."
          : message || "Email o contrasena incorrectos.";
      setError(friendly);
      showError(friendly);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} title={mode === "register" ? "Crear cuenta" : "Agregar cuenta"} onClose={closeModal} size="md">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {mode === "register"
            ? "Crea una cuenta opcional para usarla en este dispositivo y cambiar rapidamente entre cuentas."
            : "La cuenta se guardara en este dispositivo para que puedas cambiar rapidamente entre cuentas."}
        </p>
        {!configured ? (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            El servicio de cuenta no esta configurado en este entorno.
          </div>
        ) : null}
        {error ? (
          <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-200">
            {error}
          </div>
        ) : null}
        {mode === "register" ? (
          <label className="block text-sm">
            Nombre opcional
            <input
              className={inputClass}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
              disabled={!configured || submitting}
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
            disabled={!configured || submitting}
          />
        </label>
        <label className="block text-sm">
          Contrasena
          <PasswordInput
            className={inputClass}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            disabled={!configured || submitting}
          />
        </label>
        {mode === "register" ? (
          <label className="block text-sm">
            Repetir contrasena
            <PasswordInput
              className={inputClass}
              value={repeatPassword}
              onChange={(event) => setRepeatPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              disabled={!configured || submitting}
            />
          </label>
        ) : null}
        <label className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            disabled={submitting}
          />
          Recordar esta cuenta en este dispositivo
        </label>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {mode === "login" ? "No tenes una cuenta? " : "Ya tenes una cuenta? "}
          <button
            className="font-semibold text-sky-600 hover:underline dark:text-sky-300"
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
            disabled={submitting}
          >
            {mode === "login" ? "Registrate ahora." : "Inicia sesion."}
          </button>
        </p>
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <button className="btn-secondary" type="button" onClick={closeModal} disabled={submitting}>
            Cancelar
          </button>
          <button className="btn" type="submit" disabled={!configured || submitting}>
            {submitting ? "Procesando..." : mode === "register" ? "Crear cuenta y agregar" : "Iniciar sesion y agregar cuenta"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
