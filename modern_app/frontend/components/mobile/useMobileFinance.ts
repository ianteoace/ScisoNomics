"use client";

import { useEffect, useRef, useState } from "react";
import { getLocalDateInputValue } from "../../lib/date";
import type { Categoria, GastoFijo, Presupuesto, MetaAhorro, GastoProgramado } from "../../types/domain";
import { getFinanceRepository } from "../../services/data/financeRepository";
import type { FinanceRepository, FinanceMovimiento, FinanceCalendarDay, SchedulingSummary } from "../../services/data/financeRepositoryTypes";
import { groupCalendarMovements } from "../../services/data/financeCalendar";
import type { FinanceSummary } from "../../services/data/financeSummary";

export function useMobileFinance() {
  const [period, setPeriod] = useState(() => getLocalDateInputValue().slice(0, 7));
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<{ categories: Categoria[]; movements: FinanceMovimiento[]; summary: FinanceSummary; fixedExpenses: GastoFijo[]; budgets: Presupuesto[]; goals: MetaAhorro[]; scheduled: GastoProgramado[]; projection: SchedulingSummary; calendar: FinanceCalendarDay[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const saving = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setData(null);
    const [year, month] = period.split("-").map(Number);
    void getFinanceRepository().then(async (repository) => {
      const [categories, movements, summary, fixedExpenses, budgets, goals, scheduled, projection] = await Promise.all([
        repository.listCategorias(), repository.listMovimientos({ month, year }), repository.getSummary({ month, year }),
        repository.listGastosFijos(), repository.listPresupuestos({ month, year }), repository.listMetas(),
        repository.listGastosProgramados(), repository.getSchedulingSummary({ month, year }),
      ]);
      if (active) setData({ categories, movements, summary, fixedExpenses, budgets, goals, scheduled, projection, calendar: groupCalendarMovements(movements) });
    }).catch(() => { if (active) setError("No se pudieron cargar tus datos. Podés reintentar sin borrarlos."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [period, revision]);

  async function mutate(action: (repository: FinanceRepository) => Promise<void>, message: string, nextPeriod?: string) {
    if (saving.current) return false;
    saving.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await action(await getFinanceRepository());
      if (!mounted.current) return false;
      if (nextPeriod) setPeriod(nextPeriod);
      setRevision((value) => value + 1); setNotice(message);
      return true;
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "No se pudo guardar el cambio.");
      return false;
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  return { period, setPeriod, data, loading, busy, error, notice, mutate,
    clearMessages: () => { setError(""); setNotice(""); }, reload: () => setRevision((value) => value + 1) };
}
