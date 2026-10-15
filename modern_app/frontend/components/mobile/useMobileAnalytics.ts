"use client";

import { useEffect, useState } from "react";
import type { AnnualStatsResponse, StatsResponse } from "../../types/domain";
import type { FinanceMonthlyReport, FinanceMovimiento, FinancePeriod } from "../../services/data/financeRepositoryTypes";
import { useMobileAccount } from "./account/MobileAccountProvider";
import { getFinanceRepository } from "../../services/data/financeRepository";

type Result = { statistics?: StatsResponse; rows?: FinanceMovimiento[]; monthly?: FinanceMonthlyReport; annual?: AnnualStatsResponse };
export function useMobileAnalytics(kind: "statistics" | "monthly" | "annual", { month, year }: FinancePeriod) {
  const { financialContext: context } = useMobileAccount();
  const [data, setData] = useState<(Result & { ownerId: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setData(null);
    void getFinanceRepository(context.ownerId, context.isCurrent).then(async (repository) => {
      if (!active || !context.isCurrent()) return;
      let result: Result;
      if (kind === "statistics") {
        const [statistics, rows] = await Promise.all([repository.getStatistics({ month, year }), repository.listMovimientos({ month, year })]);
        result = { statistics, rows };
      } else if (kind === "monthly") result = { monthly: await repository.getMonthlyReport({ month, year }) };
      else result = { annual: await repository.getAnnualStatistics(year) };
      if (active && context.isCurrent()) setData({ ...result, ownerId: context.ownerId });
    }).catch(() => { if (active && context.isCurrent()) setError("No se pudo cargar el análisis. Podés reintentar sin modificar tus datos."); })
      .finally(() => { if (active && context.isCurrent()) setLoading(false); });
    return () => { active = false; };
  }, [kind, month, year, revision, context.ownerId]);
  return { data: data?.ownerId === context.ownerId && context.isCurrent() ? data : null, loading, error, reload: () => setRevision((r) => r + 1) };
}
