"use client";

import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { MobileDialog } from "../mobile/MobileDialog";
import {
  cancelDeviceVerification, getPendingDeviceServerState, getPendingDeviceState,
  resendDeviceVerification, subscribePendingDevice, verifyNewDeviceCode,
} from "../../services/supabaseCloudAuth";

export function DeviceVerificationDialog() {
  const pending = useSyncExternalStore(subscribePendingDevice, getPendingDeviceState, getPendingDeviceServerState);
  // Unmounting the form clears code/error state after completion or cancellation.
  return pending.required ? <DeviceVerificationForm resendAt={pending.resendAt} /> : null;
}

function DeviceVerificationForm({ resendAt }: { resendAt: number }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(Date.now);
  const remaining = Math.max(0, Math.ceil((resendAt - clock) / 1000));
  useEffect(() => {
    if (!remaining) return;
    const timer = setTimeout(() => setClock(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [clock, remaining, resendAt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try { await verifyNewDeviceCode(code); }
    catch (failure) { setCode(""); setError(failure instanceof Error ? failure.message : "No pudimos verificar el código."); }
    finally { setBusy(false); }
  }

  return <MobileDialog title="Verificá este dispositivo" busy={busy} onClose={() => { void cancelDeviceVerification(); }}>
    <form className="grid gap-4" onSubmit={submit}>
      <p className="text-sm">Enviamos un código al correo verificado de tu cuenta. Vence en diez minutos. Tu sesión se guardará después de autorizar este dispositivo.</p>
      <label className="grid gap-2 text-sm">Código de seis dígitos
        <input className="min-h-12 rounded-xl border border-slate-700 bg-slate-900 px-3 text-slate-100" autoFocus
          inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code}
          onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ""))} disabled={busy} />
      </label>
      {error ? <p role="alert" className="text-sm text-rose-300">{error}</p> : null}
      {notice ? <p role="status" className="text-sm">{notice}</p> : null}
      <button className="btn min-h-12" disabled={busy}>{busy ? "Verificando…" : "Autorizar dispositivo"}</button>
      <button className="btn-secondary min-h-12" type="button" disabled={busy || remaining > 0} onClick={() => {
        setBusy(true); setError("");
        void resendDeviceVerification().then(() => { setCode(""); setClock(Date.now()); setNotice("Enviamos un nuevo código. El anterior ya no es válido."); })
          .catch((failure) => setError(failure instanceof Error ? failure.message : "No pudimos reenviar el código."))
          .finally(() => setBusy(false));
      }}>{remaining ? `Reenviar en ${remaining}s` : "Reenviar código"}</button>
      <button className="btn-secondary min-h-12" type="button" disabled={busy} onClick={() => { void cancelDeviceVerification(); }}>Continuar en modo local</button>
    </form>
  </MobileDialog>;
}
