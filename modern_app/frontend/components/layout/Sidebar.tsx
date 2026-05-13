"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BarChart3, CalendarClock, ChevronLeft, ChevronRight, CircleUserRound, CreditCard, Flag, LayoutDashboard, List, Settings, Tags, Wallet } from "lucide-react";
import { motion } from "framer-motion";

import { ACCOUNT_SESSION_CHANGED_EVENT, cloudAuth, getStoredToken, isCloudAuthConfigured, type CloudUser } from "../../services/cloudAuth";

const items = [
  { href: "/dashboard", label: "Inicio", icon: LayoutDashboard },
  { href: "/movimientos", label: "Movimientos", icon: List },
  { href: "/categorias", label: "Categorías", icon: Tags },
  { href: "/gastos-fijos", label: "Gastos fijos", icon: CreditCard },
  { href: "/planificacion", label: "Planificación", icon: CalendarClock },
  { href: "/calendario", label: "Calendario", icon: CalendarClock },
  { href: "/presupuestos", label: "Presupuestos", icon: Wallet },
  { href: "/estadisticas", label: "Estadísticas", icon: BarChart3 },
  { href: "/reporte-mensual", label: "Reporte", icon: BarChart3 },
  { href: "/metas", label: "Metas", icon: Flag },
  { href: "/configuracion", label: "Configuración", icon: Settings },
] as const;

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [accountUser, setAccountUser] = useState<CloudUser | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAccount() {
      if (!isCloudAuthConfigured()) {
        setAccountUser(null);
        return;
      }

      const token = getStoredToken();
      if (!token) {
        setAccountUser(null);
        return;
      }

      try {
        const user = await cloudAuth.me(token);
        if (!cancelled) setAccountUser(user);
      } catch (error) {
        console.error("No se pudo cargar la cuenta en el sidebar:", error);
        if (!cancelled) setAccountUser(null);
      }
    }

    loadAccount();
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, loadAccount);
    window.addEventListener("focus", loadAccount);
    return () => {
      cancelled = true;
      window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, loadAccount);
      window.removeEventListener("focus", loadAccount);
    };
  }, []);

  const accountLabel = accountUser?.display_name || accountUser?.email || "Iniciar sesion";

  function openAccountPanel() {
    try {
      window.sessionStorage.setItem("scisonomics_open_account_panel", "1");
      window.dispatchEvent(new Event("scisonomics:open-account-panel"));
    } catch {
      // La cuenta opcional no debe bloquear la navegacion.
    }
    router.push("/configuracion?panel=cuenta");
  }

  return (
    <aside className="sticky top-0 h-screen border-r p-3" style={{ borderColor: "rgb(var(--line))", background: "rgb(var(--panel))" }}>
      <div className="mb-6 space-y-3 px-1">
        <div className={`flex gap-2 ${collapsed ? "flex-col items-center" : "items-center"}`}>
          <button
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-2xl border px-3 py-2 text-left text-sm transition hover:bg-slate-100 dark:hover:bg-slate-800 ${collapsed ? "justify-center px-2" : ""}`}
            style={{ borderColor: "rgb(var(--line))", color: "rgb(var(--muted))" }}
            title={accountLabel}
            onClick={openAccountPanel}
          >
            <CircleUserRound size={18} className="shrink-0" style={{ color: "rgb(var(--aqua))" }} />
            {!collapsed ? <span className="truncate font-semibold">{accountLabel}</span> : null}
          </button>
          <button className="btn-secondary p-2" onClick={onToggle} aria-label={collapsed ? "Expandir menu lateral" : "Colapsar menu lateral"}>
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>
      </div>
      <nav className="space-y-2 pt-2">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || !!pathname?.startsWith(`${item.href}/`);
          return (
            <motion.div key={item.href} whileHover={{ x: 2 }}>
              <Link
                href={item.href}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition"
                style={isActive ? { background: "rgba(56,189,248,.18)", color: "rgb(var(--aqua))" } : { color: "rgb(var(--muted))" }}
                title={item.label}
              >
                <Icon size={16} />
                {!collapsed ? item.label : null}
              </Link>
            </motion.div>
          );
        })}
      </nav>
    </aside>
  );
}
