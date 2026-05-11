"use client";

import { createContext, useContext, useMemo, useState } from "react";

type DashboardUiState = {
  month: number;
  setMonth: (v: number) => void;
  year: number;
  setYear: (v: number) => void;
  search: string;
  setSearch: (v: string) => void;
  saldoActual: number;
  setSaldoActual: (v: number) => void;
};

const DashboardUiContext = createContext<DashboardUiState | null>(null);

export function DashboardUiProvider({ children }: { children: React.ReactNode }) {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [search, setSearch] = useState("");
  const [saldoActual, setSaldoActual] = useState(0);

  const value = useMemo(
    () => ({ month, setMonth, year, setYear, search, setSearch, saldoActual, setSaldoActual }),
    [month, year, search, saldoActual],
  );

  return <DashboardUiContext.Provider value={value}>{children}</DashboardUiContext.Provider>;
}

export function useDashboardUi() {
  const ctx = useContext(DashboardUiContext);
  if (!ctx) throw new Error("useDashboardUi must be used inside DashboardUiProvider");
  return ctx;
}
