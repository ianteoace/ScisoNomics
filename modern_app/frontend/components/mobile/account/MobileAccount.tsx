"use client";

import { useState } from "react";
import { AccountDevices } from "../../account/AccountDevices";
import { SupabaseAccountForm } from "../../account/SupabaseAccountForm";
import { deleteSavedSession, signOut } from "../../../services/supabaseCloudAuth";
import { useMobileAccount } from "./MobileAccountProvider";
import { MobileCloudPull } from "./MobileCloudPull";

export function MobileAccount() {
  const { session, checking, error, refresh } = useMobileAccount();
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [cleanupOwner, setCleanupOwner] = useState<string | null>(null);

  async function logout() {
    if (!session || busy) return;
    setBusy(true); setActionError("");
    try {
      const result = await signOut(session.user.id);
      if (!result.ok) {
        setCleanupOwner(session.user.id);
        setActionError("La cuenta se desconectó, pero no pudimos borrar por completo la sesión guardada. Reintentá el borrado.");
      }
      await refresh();
    } catch { setActionError("No pudimos cerrar la sesión. Intentá nuevamente."); }
    finally { setBusy(false); }
  }

  return <div className="grid min-w-0 gap-3">
    <p className="text-sm">Tus finanzas locales siguen separadas de tu cuenta. Conectar una cuenta no cambia su propietario.</p>
    {checking ? <p role="status">Comprobando cuenta…</p> : null}
    {session ? <>
      <p className="font-semibold text-emerald-300">Cuenta conectada</p>
      {session.user.display_name ? <p className="break-words">{session.user.display_name}</p> : null}
      <p className="break-all">{session.user.email}</p>
      <AccountDevices key={session.user.id} ownerId={session.user.id} />
      {!checking ? <MobileCloudPull key={`pull:${session.user.id}`} ownerId={session.user.id} /> : null}
      <button className="btn-secondary min-h-12" disabled={busy || checking} onClick={() => { void logout(); }}>{busy ? "Cerrando sesión…" : "Cerrar sesión"}</button>
    </> : <>
      <p className="font-semibold">Modo local</p>
      {formOpen ? <>
        <SupabaseAccountForm allowGoogle={false} onBusyChange={setBusy} onAuthenticated={() => { setFormOpen(false); void refresh(); }} />
        <button className="btn-secondary min-h-12" disabled={busy} onClick={() => setFormOpen(false)}>Continuar en modo local</button>
      </> : <button className="btn min-h-12" disabled={checking || busy} onClick={() => { setActionError(""); setFormOpen(true); }}>Iniciar sesión o crear cuenta</button>}
    </>}
    {error ? <div className="grid gap-2"><p role="alert">{error}</p><button className="btn-secondary min-h-12" disabled={checking || busy} onClick={() => { void refresh(true); }}>Reintentar sesión</button></div> : null}
    {actionError ? <p role="alert">{actionError}</p> : null}
    {cleanupOwner ? <button className="btn-secondary min-h-12" disabled={busy} onClick={() => {
      setBusy(true);
      void deleteSavedSession(cleanupOwner).then((result) => {
        if (result.ok) { setCleanupOwner(null); setActionError(""); }
      }).finally(() => setBusy(false));
    }}>Reintentar borrar sesión</button> : null}
    <p className="text-xs text-slate-400">Google estará disponible próximamente en Mobile.</p>
  </div>;
}
