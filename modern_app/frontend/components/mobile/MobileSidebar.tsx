"use client";

import Link from "next/link";
import { LayoutDashboard, List, Tags, CreditCard, Wallet, Flag } from "lucide-react";
import { MobileDialog } from "./MobileDialog";

// Add future implemented modules here; never link to desktop-only pages.
export const mobileSections = [
  { href: "/dashboard", label: "Inicio", icon: LayoutDashboard, premium: false, feature: null },
  { href: "/movimientos", label: "Movimientos", icon: List, premium: false, feature: null },
  { href: "/categorias", label: "Categorías", icon: Tags, premium: false, feature: null },
  { href: "/gastos-fijos", label: "Gastos fijos", icon: CreditCard, premium: true, feature: "fixed_expenses" },
  { href: "/presupuestos", label: "Presupuestos", icon: Wallet, premium: true, feature: "budgets" },
  { href: "/metas", label: "Metas", icon: Flag, premium: true, feature: "saving_goals" },
] as const;

export function MobileSidebar({ pathname, onClose }: { pathname: string; onClose: () => void }) {
  return <MobileDialog id="mobile-sidebar" title="ScisoNomics" drawer onClose={onClose}>
    <p className="mb-5 text-sm text-slate-400">Tus finanzas en este dispositivo</p>
    <nav aria-label="Secciones de ScisoNomics" className="grid gap-2">
      {mobileSections.map(({ href, label, icon: Icon }) => <Link key={href} href={href} prefetch={false} onClick={onClose}
        aria-current={pathname === href ? "page" : undefined}
        className={`flex min-h-12 items-center gap-3 rounded-xl px-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 ${pathname === href ? "bg-cyan-900/40 text-cyan-100" : "text-slate-200 hover:bg-slate-800"}`}>
        <Icon size={21} aria-hidden="true" /><span>{label}</span>
      </Link>)}
    </nav>
  </MobileDialog>;
}
