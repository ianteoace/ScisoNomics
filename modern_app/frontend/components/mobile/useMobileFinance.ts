"use client";

import { useEffect, useRef, useState } from "react";
import { getLocalDateInputValue } from "../../lib/date";
import type { Categoria, GastoFijo, Presupuesto, MetaAhorro, GastoProgramado } from "../../types/domain";
import { assertFinancialContext, LOCAL_FINANCIAL_CONTEXT, type MobileFinancialContext } from "../../services/data/mobileFinancialContext";
import { getFinanceRepository } from "../../services/data/financeRepository";
import type { FinanceRepository, FinanceMovimiento, FinanceCalendarDay, SchedulingSummary } from "../../services/data/financeRepositoryTypes";
import { groupCalendarMovements } from "../../services/data/financeCalendar";
import type { FinanceSummary } from "../../services/data/financeSummary";

export function useMobileFinance(enabled = true, context: MobileFinancialContext = LOCAL_FINANCIAL_CONTEXT) {
  const [period, setPeriod] = useState(() => getLocalDateInputValue().slice(0, 7));
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<{ ownerId: string; categories: Categoria[]; movements: FinanceMovimiento[]; summary: FinanceSummary; fixedExpenses: GastoFijo[]; budgets: Presupuesto[]; goals: MetaAhorro[]; scheduled: GastoProgramado[]; projection: SchedulingSummary; calendar: FinanceCalendarDay[] } | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const saving = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) { setLoading(false); setData(null); return; }
    let active = true;
    setLoading(true); setError(""); setData(null);
    const [year, month] = period.split("-").map(Number);
    void getFinanceRepository(context.ownerId, context.isCurrent).then(async (repository) => {
      if (!active || !context.isCurrent()) return;
      const [categories, movements, summary, fixedExpenses, budgets, goals, scheduled, projection] = await Promise.all([
        repository.listCategorias(), repository.listMovimientos({ month, year }), repository.getSummary({ month, year }),
        repository.listGastosFijos(), repository.listPresupuestos({ month, year }), repository.listMetas(),
        repository.listGastosProgramados(), repository.getSchedulingSummary({ month, year }),
      ]);
      if (active && context.isCurrent()) setData({ ownerId: context.ownerId, categories, movements, summary, fixedExpenses, budgets, goals, scheduled, projection, calendar: groupCalendarMovements(movements) });
    }).catch(() => { if (active && context.isCurrent()) setError("No se pudieron cargar tus datos. Podés reintentar sin borrarlos."); })
      .finally(() => { if (active && context.isCurrent()) setLoading(false); });
    return () => { active = false; };
  }, [enabled, period, revision, context.ownerId]);

  async function mutate(action: (repository: FinanceRepository) => Promise<void>, message: string, nextPeriod?: string) {
    if (saving.current || !mounted.current || !context.isCurrent()) return false;
    saving.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const repository = await getFinanceRepository(context.ownerId, context.isCurrent);
      assertFinancialContext(context);
      if (!mounted.current) return false;
      await action(repository);
      if (!mounted.current || !context.isCurrent()) return false;
      if (nextPeriod) setPeriod(nextPeriod);
      setRevision((value) => value + 1); setNotice(message);
      return true;
    } catch (error) {
      if (mounted.current && context.isCurrent()) setError(error instanceof Error ? error.message : "No se pudo guardar el cambio.");
      return false;
    } finally { saving.current = false; if (mounted.current && context.isCurrent()) setBusy(false); }
  }
  return { period, setPeriod, data: data?.ownerId === context.ownerId && context.isCurrent() ? data : null, loading, busy, error, notice, mutate,
    clearMessages: () => { setError(""); setNotice(""); }, reload: () => setRevision((value) => value + 1) };
}
