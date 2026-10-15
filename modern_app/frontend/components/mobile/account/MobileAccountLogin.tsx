"use client";
import { useEffect, useState } from "react";
import { AddAccountModal } from "../../account/AddAccountModal";
import { useMobileAccount } from "./MobileAccountProvider";
import { getStoredAccounts } from "../../../services/cloudAuth";

// Mounted outside the owner-keyed financial shell, so OTP completion survives
// switching from local data to the authenticated internal owner.
export function MobileAccountLogin() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("Iniciar sesión");
  const { refresh } = useMobileAccount();
  useEffect(() => {
    const show = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      setTitle(action === "add" || (!action && getStoredAccounts().length > 0) ? "Agregar cuenta" : "Iniciar sesión");
      setOpen(true);
    };
    window.addEventListener("scisonomics:open-add-account-modal", show);
    return () => window.removeEventListener("scisonomics:open-add-account-modal", show);
  }, []);
  return <AddAccountModal open={open} title={title} onClose={() => setOpen(false)} onAccountAdded={() => { void refresh(); }} />;
}
