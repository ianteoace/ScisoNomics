"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Toaster } from "sonner";

import { BackendStartupGate } from "../../components/app/BackendStartupGate";
import { Sidebar } from "../../components/layout/Sidebar";
import { AutoSyncProvider } from "../../components/sync/AutoSyncProvider";
import { Topbar } from "../../components/layout/Topbar";
import { Modal } from "../../components/ui/Modal";
import { DashboardUiProvider } from "../../hooks/useDashboardUi";
import { ACCOUNT_SESSION_CHANGED_EVENT, OWNER_CHANGED_EVENT, getActiveOwnerId } from "../../services/cloudAuth";

const ONBOARDING_REOPEN_EVENT = "scisonomics:open-onboarding-guides";

const SECTION_GUIDES = {
  inicio: {
    key: "scisonomics_onboarding_inicio_seen",
    match: (pathname: string) => pathname === "/dashboard" || pathname === "/",
    title: "Inicio",
    text: "En Inicio vas a ver un resumen rápido de tu mes: ingresos, gastos, balance, últimos movimientos y accesos directos a las funciones principales.",
  },
  movimientos: {
    key: "scisonomics_onboarding_movimientos_seen",
    match: (pathname: string) => pathname.startsWith("/movimientos"),
    title: "Movimientos",
    text: "Acá podés registrar ingresos, gastos, ahorros e inversiones. También podés filtrar tus movimientos por fechas, tipo, categoría, monto y orden.",
  },
  presupuestos: {
    key: "scisonomics_onboarding_presupuestos_seen",
    match: (pathname: string) => pathname.startsWith("/presupuestos"),
    title: "Presupuestos",
    text: "Los presupuestos te ayudan a comparar cuánto gastaste contra el límite definido para cada categoría.",
  },
  metas: {
    key: "scisonomics_onboarding_metas_seen",
    match: (pathname: string) => pathname.startsWith("/metas"),
    title: "Metas de ahorro",
    text: "En esta sección podés seguir tus objetivos de ahorro, ver el progreso alcanzado y cuánto falta para completarlos.",
  },
  gastosFijos: {
    key: "scisonomics_onboarding_gastos_fijos_seen",
    match: (pathname: string) => pathname.startsWith("/gastos-fijos"),
    title: "Gastos fijos",
    text: "Acá podés controlar gastos recurrentes, próximos vencimientos y compromisos mensuales.",
  },
  planificacion: {
    key: "scisonomics_onboarding_planificacion_seen",
    match: (pathname: string) => pathname.startsWith("/planificacion"),
    title: "Planificación",
    text: "En Planificación podés organizar movimientos o compromisos futuros para anticiparte a tus gastos, ingresos y objetivos financieros.",
  },
  calendario: {
    key: "scisonomics_onboarding_calendario_seen",
    match: (pathname: string) => pathname.startsWith("/calendario"),
    title: "Calendario",
    text: "En Calendario podés visualizar tus movimientos organizados por fecha para entender mejor cuándo registraste ingresos, gastos, ahorros o inversiones.",
  },
  estadisticas: {
    key: "scisonomics_onboarding_estadisticas_seen",
    match: (pathname: string) => pathname.startsWith("/estadisticas"),
    title: "Estadísticas",
    text: "En Estadísticas podés analizar tus ingresos, gastos y balance por distintos períodos.",
  },
  reporteMensual: {
    key: "scisonomics_onboarding_reporte_mensual_seen",
    match: (pathname: string) => pathname.startsWith("/reporte-mensual") || pathname.startsWith("/reporte"),
    title: "Reporte",
    text: "En Reporte podés consultar informes mensuales o anuales de tus ingresos, gastos y balance. También podés exportar la información cuando lo necesites.",
  },
  configuracion: {
    key: "scisonomics_onboarding_configuracion_seen",
    match: (pathname: string) => pathname.startsWith("/configuracion"),
    title: "Configuración y copias de seguridad",
    text: "Desde Configuración podés administrar copias de seguridad, volver a ver las guías y acceder a tu cuenta opcional. Tus datos siguen guardándose localmente y la sincronización inicial es manual.",
  },
} as const;

const SECTION_GUIDE_LIST = Object.values(SECTION_GUIDES);

function getGuideForPath(pathname: string) {
  return SECTION_GUIDE_LIST.find((guide) => guide.match(pathname)) || null;
}

function safeGetLocalStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // La guia no debe bloquear la app si localStorage falla.
  }
}

function resetSectionGuides() {
  try {
    for (const guide of SECTION_GUIDE_LIST) window.localStorage.removeItem(guide.key);
  } catch {
    // La guia no debe bloquear la app si localStorage falla.
  }
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const currentPathname = pathname || "";
  const [collapsed, setCollapsed] = useState(false);
  const [activeOwnerId, setActiveOwnerId] = useState("local");
  const [ownerSwitching, setOwnerSwitching] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [activeGuide, setActiveGuide] = useState<(typeof SECTION_GUIDE_LIST)[number] | null>(null);
  const activeOwnerRef = useRef("local");
  const ownerSwitchTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const clearOwnerSwitchTimers = () => {
      for (const timer of ownerSwitchTimersRef.current) clearTimeout(timer);
      ownerSwitchTimersRef.current = [];
    };
    const applyOwner = (nextOwner: string) => {
      activeOwnerRef.current = nextOwner;
      setActiveOwnerId(nextOwner);
    };
    const refreshOwner = (animated = true) => {
      const nextOwner = getActiveOwnerId();
      if (nextOwner === activeOwnerRef.current) return;
      clearOwnerSwitchTimers();
      if (!animated) {
        setOwnerSwitching(false);
        applyOwner(nextOwner);
        return;
      }
      setOwnerSwitching(true);
      ownerSwitchTimersRef.current.push(
        setTimeout(() => applyOwner(nextOwner), 90),
        setTimeout(() => setOwnerSwitching(false), 260),
      );
    };
    const handleOwnerEvent = () => refreshOwner(true);
    refreshOwner(false);
    window.addEventListener(OWNER_CHANGED_EVENT, handleOwnerEvent);
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, handleOwnerEvent);
    return () => {
      clearOwnerSwitchTimers();
      window.removeEventListener(OWNER_CHANGED_EVENT, handleOwnerEvent);
      window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, handleOwnerEvent);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const guide = getGuideForPath(currentPathname);
    if (!guide) {
      setOnboardingOpen(false);
      setActiveGuide(null);
      return;
    }
    if (safeGetLocalStorage(guide.key) === "1") {
      setOnboardingOpen(false);
      setActiveGuide(null);
      return;
    }
    setActiveGuide(guide);
    setOnboardingOpen(true);
  }, [currentPathname]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const resetGuides = () => {
      resetSectionGuides();
      const guide = getGuideForPath(currentPathname);
      if (guide) {
        setActiveGuide(guide);
        setOnboardingOpen(true);
      }
    };
    window.addEventListener(ONBOARDING_REOPEN_EVENT, resetGuides);
    return () => window.removeEventListener(ONBOARDING_REOPEN_EVENT, resetGuides);
  }, [currentPathname]);

  function completeOnboarding() {
    if (activeGuide) safeSetLocalStorage(activeGuide.key, "1");
    setOnboardingOpen(false);
    setActiveGuide(null);
  }

  return (
    <DashboardUiProvider key={activeOwnerId}>
      <BackendStartupGate>
        <AutoSyncProvider>
          <div className={`min-h-screen lg:grid ${collapsed ? "lg:grid-cols-[84px_1fr]" : "lg:grid-cols-[250px_1fr]"}`}>
            <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
            <div className="p-4 lg:p-6">
              <Topbar />
              <div className="relative">
                <div
                  key={`${activeOwnerId}:${currentPathname}`}
                  className={`transition-all duration-200 ease-out ${ownerSwitching ? "translate-y-1 opacity-0 blur-[1px]" : "translate-y-0 opacity-100 blur-0"}`}
                >
                  {children}
                </div>
                {ownerSwitching ? (
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-10 rounded-2xl border border-sky-400/20 bg-slate-950/65 px-4 py-3 text-sm text-slate-300 shadow-sm backdrop-blur-md">
                    Cambiando cuenta...
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </AutoSyncProvider>
        <Modal open={onboardingOpen && !!activeGuide} title={activeGuide?.title || "Guía"} onClose={completeOnboarding}>
          <p className="text-sm text-slate-300">{activeGuide?.text}</p>
          <div className="mt-6 flex justify-end">
            <button className="btn" onClick={completeOnboarding}>Entendido</button>
          </div>
        </Modal>
      </BackendStartupGate>
      <Toaster richColors position="bottom-right" />
    </DashboardUiProvider>
  );
}
