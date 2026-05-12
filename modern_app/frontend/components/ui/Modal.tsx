"use client";

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function Modal({ open, title, children, onClose }: { open: boolean; title: string; children: React.ReactNode; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => {
      modalRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open || !mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.18 }}
        className="card max-h-[90vh] w-full max-w-xl overflow-y-auto p-5 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
          <button className="btn-secondary" onClick={onClose} aria-label="Cerrar modal">Cerrar</button>
        </div>
        {children}
      </motion.div>
    </div>,
    document.body,
  );
}
