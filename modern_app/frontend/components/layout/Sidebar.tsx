"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, CalendarClock, ChevronLeft, ChevronRight, CreditCard, Flag, LayoutDashboard, List, Settings, Tags, Wallet } from "lucide-react";
import { motion } from "framer-motion";

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

  return (
    <aside className="sticky top-0 h-screen border-r p-3" style={{ borderColor: "rgb(var(--line))", background: "rgb(var(--panel))" }}>
      <div className="mb-4 flex items-center justify-between px-2">
        {!collapsed ? <h1 className="text-lg font-extrabold" style={{ color: "rgb(var(--aqua))" }}>Finanzas</h1> : null}
        <button className="btn-secondary p-2" onClick={onToggle} aria-label={collapsed ? "Expandir menu lateral" : "Colapsar menu lateral"}>
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
      <nav className="space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || !!pathname?.startsWith(`${item.href}/`);
          return (
            <motion.div key={item.href} whileHover={{ x: 2 }}>
              <Link
                href={item.href}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition"
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
