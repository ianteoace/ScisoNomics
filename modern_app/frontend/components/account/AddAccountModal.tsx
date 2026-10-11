"use client";

import { useState } from "react";
import { useToast } from "../../hooks/useToast";
import { Modal } from "../ui/Modal";
import { SupabaseAccountForm } from "./SupabaseAccountForm";
import { getRuntimePlatformSync } from "../../services/platform";
import { MobileDialog } from "../mobile/MobileDialog";

export function AddAccountModal({ open, onClose, onAccountAdded, title = "Iniciar sesión" }: {
  open: boolean;
  onClose: () => void;
  onAccountAdded?: () => void;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const { showSuccess } = useToast();

  const platform = getRuntimePlatformSync();
  const mobile = platform === "android" || platform === "ios";
  const form = open ? <SupabaseAccountForm allowGoogle={!mobile} onBusyChange={setBusy} onAuthenticated={() => {
        setBusy(false);
        onClose();
        onAccountAdded?.();
        showSuccess("Cuenta agregada.");
      }} /> : null;
  if (mobile) return open ? <MobileDialog title={title} busy={busy} onClose={() => { if (!busy) onClose(); }}>{form}</MobileDialog> : null;
  return <Modal open={open} title={title} onClose={() => { if (!busy) onClose(); }} size="md">{form}</Modal>;
}
