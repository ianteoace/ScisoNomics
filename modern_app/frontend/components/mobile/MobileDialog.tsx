"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import styles from "./MobileDialog.module.css";
import { getRuntimePlatformSync } from "../../services/platform";
export const MOBILE_DIALOG_CLOSED_EVENT = "scisonomics:mobile-dialog-closed";

export function MobileDialog({ title, children, onClose, busy = false, drawer = false, id }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; drawer?: boolean; id?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const platform = getRuntimePlatformSync();
  const mobile = platform === "android" || platform === "ios";
  useEffect(() => {
    const dialog = ref.current;
    const viewport = window.visualViewport;
    if (!mobile || !dialog || !viewport) return;
    const resize = () => {
      dialog.style?.setProperty("--mobile-viewport-height", `${viewport.height}px`);
      dialog.style?.setProperty("--mobile-viewport-top", `${viewport.offsetTop}px`);
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => { viewport.removeEventListener("resize", resize); viewport.removeEventListener("scroll", resize); };
  }, [mobile]);
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
      if (mobile) window.dispatchEvent(new Event(MOBILE_DIALOG_CLOSED_EVENT));
    };
  }, []);
  return <dialog ref={ref} id={id} aria-labelledby={titleId} aria-modal="true" data-mobile-ui={mobile ? "" : undefined} className={`${styles.dialog} ${drawer ? styles.drawer : ""} ${mobile ? styles.mobile : ""}`}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className={`${styles.content} ${mobile ? "" : "p-4"}`} style={!mobile && drawer ? { paddingTop: "calc(1rem + env(safe-area-inset-top, 0px))", paddingBottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" } : undefined}>
      <div className={`${styles.header} ${mobile ? "mb-3 gap-2" : "mb-5 gap-3"} flex items-center justify-between`}>
        <h2 id={titleId} className={`min-w-0 break-words ${mobile ? "text-lg" : "text-xl"} font-bold`}>{title}</h2>
        <button data-mobile-icon={mobile ? "" : undefined} className="btn-secondary flex min-h-11 min-w-11 shrink-0 items-center justify-center" aria-label="Cerrar" disabled={busy} onClick={onClose}><X size={20} aria-hidden="true" /></button>
      </div>
      {children}
    </div>
  </dialog>;
}
