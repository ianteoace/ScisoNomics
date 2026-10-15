"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CircleUserRound, Plus } from "lucide-react";
import { ACCOUNT_SESSION_CHANGED_EVENT, OWNER_CHANGED_EVENT, getStoredAccounts, switchActiveOwner, switchToLocalMode } from "../../../services/cloudAuth";
import { useMobileAccount } from "./MobileAccountProvider";

export function MobileSidebarAccount({ onClose }: { onClose(): void }) {
  const { session, financialAccount, checking } = useMobileAccount();
  const [accounts, setAccounts] = useState(() => getStoredAccounts());
  useEffect(() => {
    const update = () => setAccounts(getStoredAccounts());
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, update);
    window.addEventListener(OWNER_CHANGED_EVENT, update);
    return () => { window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, update); window.removeEventListener(OWNER_CHANGED_EVENT, update); };
  }, []);
  function open(action: "login" | "add") {
    onClose();
    window.dispatchEvent(new CustomEvent("scisonomics:open-add-account-modal", { detail: { action } }));
  }
  return <section className="mb-5 grid gap-2 rounded-xl border border-slate-700 p-3" aria-label="Cuenta de la sidebar">
    {session ? <><p className="break-words font-semibold">{session.user.display_name || session.user.email}</p><p className="break-all text-xs text-slate-400">{session.user.email}</p></> :
      <button className="btn flex min-h-12 items-center gap-2" disabled={checking} onClick={() => open("login")}><CircleUserRound size={20} />Iniciar sesión</button>}
    {accounts.length > 0 ? <>
      <label className="grid gap-1 text-sm">Cambiar cuenta
        <select className="input min-h-12" disabled={checking} value={financialAccount?.user.id || "local"} onChange={event => {
          if (event.target.value === "local") switchToLocalMode(); else switchActiveOwner(event.target.value);
          onClose();
        }}>
          <option value="local">Modo local</option>
          {accounts.map(account => <option key={account.user.id} value={account.user.id}>{account.user.display_name || account.user.email}</option>)}
        </select>
      </label>
      <button className="btn-secondary flex min-h-12 items-center gap-2" onClick={() => open("add")}><Plus size={18} />Agregar cuenta</button>
    </> : null}
    <Link className="btn-secondary flex min-h-11 items-center justify-center" prefetch={false} href="/configuracion?panel=cuenta" onClick={() => {
      try { window.sessionStorage.setItem("scisonomics_open_account_panel", "1"); } catch { /* The URL also selects Cuenta. */ }
      window.dispatchEvent(new Event("scisonomics:open-account-panel")); onClose();
    }}>Administrar cuentas</Link>
  </section>;
}
