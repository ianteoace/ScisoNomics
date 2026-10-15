"use client";

import { Menu } from "lucide-react";

export function MobileHeader({ title, menuOpen, onOpenMenu }: { title: string; menuOpen: boolean; onOpenMenu: () => void }) {
  return <header className="sticky top-0 z-20 border-b border-slate-700 bg-slate-950/95 px-3 pb-2 backdrop-blur" style={{ paddingTop: "calc(.5rem + env(safe-area-inset-top, 0px))", paddingLeft: "max(.75rem, env(safe-area-inset-left, 0px))", paddingRight: "max(.75rem, env(safe-area-inset-right, 0px))" }}>
    <div className="mx-auto flex min-w-0 max-w-2xl items-center gap-2">
      <button id="mobile-menu-button" data-mobile-icon="" className="btn-secondary flex min-h-11 min-w-11 shrink-0 items-center justify-center" onClick={(event) => { event.currentTarget.focus(); onOpenMenu(); }}
        aria-label="Abrir menú" aria-expanded={menuOpen} aria-controls="mobile-sidebar"><Menu size={22} aria-hidden="true" /></button>
      <div className="min-w-0"><p className="text-xs text-slate-400">ScisoNomics</p><h1 className="break-words text-lg font-bold">{title}</h1></div>
    </div>
  </header>;
}
