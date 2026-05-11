"use client";

import { Modal } from "./Modal";

export function ConfirmDialog({
  open,
  title,
  message,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <p className="mb-4 text-sm text-slate-300">{message}</p>
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onCancel}>Cancelar</button>
        <button className="btn" onClick={onConfirm}>Confirmar</button>
      </div>
    </Modal>
  );
}
