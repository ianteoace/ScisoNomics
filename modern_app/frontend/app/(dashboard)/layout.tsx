"use client";

import { useEffect, useState } from "react";
import { Toaster } from "sonner";

import { BackendStartupGate } from "../../components/app/BackendStartupGate";
import { Sidebar } from "../../components/layout/Sidebar";
import { Topbar } from "../../components/layout/Topbar";
import { Modal } from "../../components/ui/Modal";
import { DashboardUiProvider } from "../../hooks/useDashboardUi";
import { useToast } from "../../hooks/useToast";
import { api } from "../../services/api";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const { showSuccess } = useToast();

  useEffect(() => {
    if (typeof window !== "undefined" && localStorage.getItem("scisonomics_onboarding_done") !== "1") {
      setOnboardingOpen(true);
    }
  }, []);

  async function seedCategories() {
    const suggested = [
      { nombre: "Comida", tipo: "gasto" },
      { nombre: "Transporte", tipo: "gasto" },
      { nombre: "Servicios", tipo: "gasto" },
      { nombre: "Salud", tipo: "gasto" },
      { nombre: "Ocio", tipo: "gasto" },
      { nombre: "Sueldo", tipo: "ingreso" },
      { nombre: "Ahorro", tipo: "ahorro" },
      { nombre: "Inversion", tipo: "inversion" },
    ] as const;
    await Promise.all(suggested.map((c) => api.createCategoria(c).catch(() => undefined)));
    localStorage.setItem("scisonomics_onboarding_done", "1");
    setOnboardingOpen(false);
    showSuccess("Onboarding completado");
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
      </BackendStartupGate>
      <Modal open={onboardingOpen} title="Bienvenido a ScisoNomics" onClose={() => {}}>
        <p className="text-sm text-slate-300">Configura categorías base para empezar rápido.</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
          {["Comida", "Transporte", "Servicios", "Salud", "Ocio", "Sueldo", "Ahorro", "Inversion"].map((i) => (
            <span key={i} className="rounded-full border border-line px-2 py-1">
              {i}
            </span>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="btn-secondary"
            onClick={() => {
              localStorage.setItem("scisonomics_onboarding_done", "1");
              setOnboardingOpen(false);
            }}
          >
            Omitir
          </button>
          <button className="btn" onClick={seedCategories}>
            Crear categorías sugeridas
          </button>
        </div>
      </Modal>
      <Toaster richColors position="bottom-right" />
    </DashboardUiProvider>
  );
}
