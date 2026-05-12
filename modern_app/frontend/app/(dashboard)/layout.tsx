"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Toaster } from "sonner";

import { BackendStartupGate } from "../../components/app/BackendStartupGate";
import { Sidebar } from "../../components/layout/Sidebar";
import { Topbar } from "../../components/layout/Topbar";
import { Modal } from "../../components/ui/Modal";
import { DashboardUiProvider } from "../../hooks/useDashboardUi";

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
    text: "Desde Configuración podés crear y restaurar copias de seguridad para proteger tus datos.",
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
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [activeGuide, setActiveGuide] = useState<(typeof SECTION_GUIDE_LIST)[number] | null>(null);

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
    <DashboardUiProvider>
      <BackendStartupGate>
        <div className={`min-h-screen lg:grid ${collapsed ? "lg:grid-cols-[84px_1fr]" : "lg:grid-cols-[250px_1fr]"}`}>
          <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
          <div className="p-4 lg:p-6">
            <Topbar />
            {children}
          </div>
        </div>
        <Modal open={onboardingOpen && !!activeGuide} title={activeGuide?.title || "Guia"} onClose={completeOnboarding}>
          <p className="text-sm text-slate-600 dark:text-slate-300">{activeGuide?.text}</p>
          <div className="mt-6 flex justify-end">
            <button className="btn" onClick={completeOnboarding}>Entendido</button>
          </div>
        </Modal>
      </BackendStartupGate>
      <Toaster richColors position="bottom-right" />
    </DashboardUiProvider>
  );
}
