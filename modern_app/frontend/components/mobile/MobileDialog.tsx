"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import styles from "./MobileDialog.module.css";

export function MobileDialog({ title, children, onClose, busy = false, drawer = false, id }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; drawer?: boolean; id?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close(); document.body.style.overflow = previousOverflow;
      // React can remove the dialog before native close restores focus.
      const target = previousFocus?.isConnected && previousFocus !== document.body
        ? previousFocus : document.getElementById("mobile-menu-button");
      target?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} id={id} aria-labelledby={titleId} aria-modal="true" className={`${styles.dialog} ${drawer ? styles.drawer : ""}`}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="p-4" style={drawer ? { paddingTop: "calc(1rem + env(safe-area-inset-top, 0px))", paddingBottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" } : undefined}>
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 id={titleId} className="min-w-0 break-words text-xl font-bold">{title}</h2>
        <button className="btn-secondary flex min-h-11 min-w-11 items-center justify-center" aria-label="Cerrar" disabled={busy} onClick={onClose}><X size={20} aria-hidden="true" /></button>
      </div>
      {children}
    </div>
  </dialog>;
}
