"use client";

import { useState } from "react";
import { AccountDevices } from "../../account/AccountDevices";
import { SupabaseAccountForm } from "../../account/SupabaseAccountForm";
import { deleteSavedSession, signOut } from "../../../services/supabaseCloudAuth";
import { useMobileAccount } from "./MobileAccountProvider";
import { MobileCloudPull } from "./MobileCloudPull";
import { AccountDeletionDialog } from "../../account/AccountDeletionDialog";

export function MobileAccount() {
  const { session, financialAccount, financialContext, checking, error, refresh } = useMobileAccount();
  const account = financialAccount;
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [cleanupOwner, setCleanupOwner] = useState<string | null>(null);

  async function logout() {
    if (!account || busy) return;
    setBusy(true); setActionError("");
    try {
      const result = await signOut(account.user.id);
      if (!result.ok) {
        setCleanupOwner(account.user.id);
        setActionError("La cuenta se desconectó, pero no pudimos borrar por completo la sesión guardada. Reintentá el borrado.");
      }
      await refresh();
    } catch { setActionError("No pudimos cerrar la sesión. Intentá nuevamente."); }
    finally { setBusy(false); }
  }

  return <div className="grid min-w-0 gap-3">
    <p className="text-sm">Movimientos, Categorías e Inicio usan la cuenta conectada. Tus datos locales se conservan por separado y no se suben automáticamente.</p>
    {checking ? <p role="status">Comprobando cuenta…</p> : null}
    {account ? <>
      <p className="font-semibold text-emerald-300">Cuenta sincronizada</p>
      {account.user.display_name ? <p className="break-words">{account.user.display_name}</p> : null}
      <p className="break-all">{account.user.email}</p>
      {session ? <AccountDevices key={account.user.id} ownerId={account.user.id} /> : null}
      <MobileCloudPull key={`pull:${financialContext.ownerId}`} ownerId={financialContext.ownerId} isCurrent={financialContext.isCurrent} />
      <button className="btn-secondary min-h-12" disabled={busy || checking} onClick={() => { void logout(); }}>{busy ? "Cerrando sesión…" : "Cerrar sesión"}</button>
      <AccountDeletionDialog key={`delete:${financialContext.ownerId}`} ownerId={financialContext.ownerId} />
    </> : <>
      <p className="font-semibold">Datos locales</p>
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
