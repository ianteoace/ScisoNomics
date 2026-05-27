"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BarChart3, CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, CircleUserRound, CreditCard, Flag, LayoutDashboard, List, Plus, Settings, Tags, Wallet } from "lucide-react";
import { motion } from "framer-motion";

import { AddAccountModal } from "../account/AddAccountModal";
import {
  ACCOUNT_SESSION_CHANGED_EVENT,
  OWNER_CHANGED_EVENT,
  cloudAuth,
  getActiveCloudSession,
  getActiveOwnerId,
  getStoredAccounts,
  isCloudAuthConfigured,
  switchActiveOwner,
  switchToLocalMode,
  type CloudUser,
  type StoredCloudAccount,
} from "../../services/cloudAuth";

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
  const [activeOwnerId, setActiveOwnerId] = useState("local");
  const [accounts, setAccounts] = useState<StoredCloudAccount[]>([]);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAccount() {
      if (!isCloudAuthConfigured()) {
        setAccountUser(null);
        setActiveOwnerId(getActiveOwnerId());
        return;
      }

      const session = getActiveCloudSession();
      setActiveOwnerId(getActiveOwnerId());
      setAccounts(getStoredAccounts());
      if (!session) {
        setAccountUser(null);
        return;
      }

      setAccountUser(session.user);
      try {
        const user = await cloudAuth.me(session.token);
        if (!cancelled) {
          setAccountUser(user);
        }
      } catch (error) {
        console.error("No se pudo cargar la cuenta en el sidebar:", error);
        if (!cancelled) setAccountUser(null);
      }
    }

    loadAccount();
    const openAddAccountModal = () => setAddAccountOpen(true);
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, loadAccount);
    window.addEventListener(OWNER_CHANGED_EVENT, loadAccount);
    window.addEventListener("focus", loadAccount);
    window.addEventListener("scisonomics:open-add-account-modal", openAddAccountModal);
    return () => {
      cancelled = true;
      window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, loadAccount);
      window.removeEventListener(OWNER_CHANGED_EVENT, loadAccount);
      window.removeEventListener("focus", loadAccount);
      window.removeEventListener("scisonomics:open-add-account-modal", openAddAccountModal);
    };
  }, []);

  const accountLabel = activeOwnerId === "local" ? "Modo local" : accountUser?.display_name || accountUser?.email || "Cuenta";
  const accountSubtitle = activeOwnerId === "local" ? "Sin sincronización" : "Cuenta sincronizable";

  useEffect(() => {
    if (!accountMenuOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAccountMenuOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  function openAccountPanel() {
    try {
      window.sessionStorage.setItem("scisonomics_open_account_panel", "1");
      window.dispatchEvent(new Event("scisonomics:open-account-panel"));
    } catch {
      // La cuenta opcional no debe bloquear la navegacion.
    }
    router.push("/configuracion?panel=cuenta");
  }

  function switchSidebarOwner(ownerId: string) {
    if (ownerId === "local") {
      switchToLocalMode();
    } else {
      switchActiveOwner(ownerId);
    }
    setActiveOwnerId(getActiveOwnerId());
    const session = getActiveCloudSession();
    setAccountUser(session?.user || null);
    setAccounts(getStoredAccounts());
    setAccountMenuOpen(false);
  }

  function accountDisplay(account: StoredCloudAccount) {
    return account.user.display_name || account.user.email || "Cuenta";
  }

  return (
    <aside className="sticky top-0 z-40 h-screen border-r p-3" style={{ borderColor: "rgb(var(--line))", background: "rgb(var(--panel))" }}>
      <div className="mb-6 space-y-3 px-1">
        <div className={`flex gap-2 ${collapsed ? "flex-col items-center" : "items-center"}`}>
          <div className="relative min-w-0 flex-1" ref={accountMenuRef}>
            <button
              className={`flex w-full min-w-0 items-center gap-2 rounded-2xl border px-3 py-2 text-left text-sm transition hover:bg-slate-100 dark:hover:bg-slate-800 ${collapsed ? "justify-center px-2" : ""}`}
              style={{ borderColor: "rgb(var(--line))", color: "rgb(var(--muted))" }}
              title={accountLabel}
              onClick={() => setAccountMenuOpen((value) => !value)}
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen}
            >
              <CircleUserRound size={18} className="shrink-0" style={{ color: "rgb(var(--aqua))" }} />
              {!collapsed ? (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-slate-900 dark:text-slate-100">{accountLabel}</span>
                    <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">{accountSubtitle}</span>
                  </span>
                  <ChevronDown size={14} className={`shrink-0 transition ${accountMenuOpen ? "rotate-180" : ""}`} />
                </>
              ) : null}
            </button>
            {accountMenuOpen ? (
              <div
                className={`z-[90] max-h-80 overflow-y-auto rounded-2xl border bg-white p-2 text-sm shadow-xl shadow-slate-950/10 dark:bg-slate-950 dark:shadow-black/30 ${
                  collapsed
                    ? "fixed left-[92px] top-3 w-64"
                    : "absolute left-0 mt-2 w-full min-w-64"
                }`}
                style={{ borderColor: "rgb(var(--line))" }}
                role="menu"
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:bg-slate-100 dark:hover:bg-slate-900"
                  onClick={() => switchSidebarOwner("local")}
                  role="menuitem"
                >
                  <CircleUserRound size={16} className="text-slate-500 dark:text-slate-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-slate-900 dark:text-slate-100">Modo local</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">Sin sincronización</span>
                  </span>
                  {activeOwnerId === "local" ? <Check size={15} className="text-sky-500" /> : null}
                </button>
                {accounts.length > 0 ? <div className="my-2 h-px bg-slate-200 dark:bg-slate-800" /> : null}
                {accounts.map((account) => {
                  const active = activeOwnerId === account.user.id;
                  return (
                    <button
                      key={account.user.id}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:bg-slate-100 dark:hover:bg-slate-900"
                      onClick={() => switchSidebarOwner(account.user.id)}
                      role="menuitem"
                    >
                      <CircleUserRound size={16} className="text-sky-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-900 dark:text-slate-100">{accountDisplay(account)}</span>
                        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{active ? "Cuenta activa" : account.user.email}</span>
                      </span>
                      {active ? <Check size={15} className="text-sky-500" /> : null}
                    </button>
                  );
                })}
                <div className="my-2 h-px bg-slate-200 dark:bg-slate-800" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-medium text-sky-700 transition hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-950/30"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    setAddAccountOpen(true);
                  }}
                  role="menuitem"
                >
                  <Plus size={16} />
                  Agregar cuenta
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    openAccountPanel();
                  }}
                  role="menuitem"
                >
                  <Settings size={16} />
                  Administrar cuentas
                </button>
              </div>
            ) : null}
          </div>
          <button className="btn-secondary p-2" onClick={onToggle} aria-label={collapsed ? "Expandir menu lateral" : "Colapsar menu lateral"}>
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>
      </div>
      <AddAccountModal
        open={addAccountOpen}
        onClose={() => setAddAccountOpen(false)}
        onAccountAdded={() => {
          setAddAccountOpen(false);
          setActiveOwnerId(getActiveOwnerId());
          const session = getActiveCloudSession();
          setAccountUser(session?.user || null);
          setAccounts(getStoredAccounts());
        }}
      />
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
