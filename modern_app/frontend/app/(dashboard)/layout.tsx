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
    text: "En Inicio vas a ver un resumen rapido de tu mes: ingresos, gastos, balance, ultimos movimientos y accesos directos a las funciones principales.",
  },
  movimientos: {
    key: "scisonomics_onboarding_movimientos_seen",
    match: (pathname: string) => pathname.startsWith("/movimientos"),
    title: "Movimientos",
    text: "Aca podes registrar ingresos, gastos, ahorros e inversiones. Tambien podes filtrar tus movimientos por fechas, tipo, categoria, monto y orden.",
  },
  presupuestos: {
    key: "scisonomics_onboarding_presupuestos_seen",
    match: (pathname: string) => pathname.startsWith("/presupuestos"),
    title: "Presupuestos",
    text: "Los presupuestos te ayudan a comparar cuanto gastaste contra el limite definido para cada categoria.",
  },
  metas: {
    key: "scisonomics_onboarding_metas_seen",
    match: (pathname: string) => pathname.startsWith("/metas"),
    title: "Metas de ahorro",
    text: "En esta seccion podes seguir tus objetivos de ahorro, ver el progreso alcanzado y cuanto falta para completarlos.",
  },
  gastosFijos: {
    key: "scisonomics_onboarding_gastos_fijos_seen",
    match: (pathname: string) => pathname.startsWith("/gastos-fijos"),
    title: "Gastos fijos",
    text: "Aca podes controlar gastos recurrentes, proximos vencimientos y compromisos mensuales.",
  },
  planificacion: {
    key: "scisonomics_onboarding_planificacion_seen",
    match: (pathname: string) => pathname.startsWith("/planificacion"),
    title: "Planificacion",
    text: "En Planificacion podes organizar movimientos o compromisos futuros para anticiparte a tus gastos, ingresos y objetivos financieros.",
  },
  calendario: {
    key: "scisonomics_onboarding_calendario_seen",
    match: (pathname: string) => pathname.startsWith("/calendario"),
    title: "Calendario",
    text: "En Calendario podes visualizar tus movimientos organizados por fecha para entender mejor cuando registraste ingresos, gastos, ahorros o inversiones.",
  },
  estadisticas: {
    key: "scisonomics_onboarding_estadisticas_seen",
    match: (pathname: string) => pathname.startsWith("/estadisticas"),
    title: "Estadisticas",
    text: "En Estadisticas podes analizar tus ingresos, gastos y balance por distintos periodos.",
  },
  reporteMensual: {
    key: "scisonomics_onboarding_reporte_mensual_seen",
    match: (pathname: string) => pathname.startsWith("/reporte-mensual") || pathname.startsWith("/reporte"),
    title: "Reporte",
    text: "En Reporte podes consultar informes mensuales o anuales de tus ingresos, gastos y balance. Tambien podes exportar la informacion cuando lo necesites.",
  },
  configuracion: {
    key: "scisonomics_onboarding_configuracion_seen",
    match: (pathname: string) => pathname.startsWith("/configuracion"),
    title: "Configuracion y copias de seguridad",
    text: "Desde Configuracion podes administrar copias de seguridad, volver a ver las guias y acceder a tu cuenta opcional. Tus datos siguen guardandose localmente y la sincronizacion inicial es manual.",
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
