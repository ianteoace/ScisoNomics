"use client";

import { useEffect, useState } from "react";
import type { AnnualStatsResponse, StatsResponse } from "../../types/domain";
import type { FinanceMonthlyReport, FinanceMovimiento, FinancePeriod } from "../../services/data/financeRepositoryTypes";
import { getFinanceRepository } from "../../services/data/financeRepository";

type Result = { statistics?: StatsResponse; rows?: FinanceMovimiento[]; monthly?: FinanceMonthlyReport; annual?: AnnualStatsResponse };
export function useMobileAnalytics(kind: "statistics" | "monthly" | "annual", { month, year }: FinancePeriod) {
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setData(null);
    void getFinanceRepository().then(async (repository) => {
      let result: Result;
      if (kind === "statistics") {
        const [statistics, rows] = await Promise.all([repository.getStatistics({ month, year }), repository.listMovimientos({ month, year })]);
        result = { statistics, rows };
      } else if (kind === "monthly") result = { monthly: await repository.getMonthlyReport({ month, year }) };
      else result = { annual: await repository.getAnnualStatistics(year) };
      if (active) setData(result);
    }).catch(() => { if (active) setError("No se pudo cargar el análisis. Podés reintentar sin modificar tus datos."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [kind, month, year, revision]);
  return { data, loading, error, reload: () => setRevision((r) => r + 1) };
}
