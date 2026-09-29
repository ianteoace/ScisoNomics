"use client";

import { useState } from "react";
import { useToast } from "../../hooks/useToast";
import { Modal } from "../ui/Modal";
import { SupabaseAccountForm } from "./SupabaseAccountForm";

export function AddAccountModal({ open, onClose, onAccountAdded }: {
  open: boolean;
  onClose: () => void;
  onAccountAdded?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { showSuccess } = useToast();

  return (
    <Modal open={open} title="Iniciar sesión" onClose={() => { if (!busy) onClose(); }} size="md">
      {open ? <SupabaseAccountForm onBusyChange={setBusy} onAuthenticated={() => {
        setBusy(false);
        onClose();
        onAccountAdded?.();
        showSuccess("Cuenta agregada.");
      }} /> : null}
    </Modal>
  );
}