"use client";

import { useEffect, useState } from "react";

import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorState } from "../../../components/ui/ErrorState";
import { LoadingGrid, LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { money, monthName, yearOptions } from "../../../lib/format";
import { api } from "../../../services/api";

export default function ReporteMensualPage() {
  const { month, setMonth, year, setYear } = useDashboardUi();
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const { showError } = useToast();

  useEffect(() => {
    setLoading(true);
    api.reporteMensual(month, year).then((data) => {
      setReport(data);
      setUnavailable(false);
      setLoadError("");
    }).catch((e: any) => {
      setUnavailable(true);
      setLoadError(e.message || "No se pudieron cargar los datos.");
      showError(e.message || "Error al cargar reporte mensual");
    }).finally(() => setLoading(false));
  }, [month, year, showError]);

  return (
    <section className="space-y-4">
      <header className="card p-5">
        <p className="text-xs uppercase tracking-widest text-muted">Reporte mensual</p>
        <h2 className="text-2xl font-bold">Resumen de {monthName(month)} {year}</h2>
      </header>

      <div className="panel grid gap-2 p-3 md:grid-cols-2">
        <select className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>{Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}</select>
        <select className="input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {yearOptions(new Date().getFullYear(), [year]).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {loadError && !loading ? <ErrorState title="No se pudieron cargar los datos." description={loadError} /> : null}
      {unavailable && !loading ? <EmptyState title="Sección no disponible" hint="Esta sección requiere un backend actualizado." /> : null}
      {loading ? (
        <div className="space-y-4">
          <LoadingGrid items={6} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" />
          <LoadingSkeleton rows={8} />
        </div>
      ) : report ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <article className="card p-4"><p className="text-xs text-muted">Ingresos</p><p className="text-xl font-bold text-emerald-400">{money(report.ingresos ?? 0)}</p></article>
            <article className="card p-4"><p className="text-xs text-muted">Gastos</p><p className="text-xl font-bold text-rose-400">{money(report.gastos ?? 0)}</p></article>
            <article className="card p-4"><p className="text-xs text-muted">Ahorro</p><p className="text-xl font-bold">{money(report.ahorro ?? 0)}</p></article>
            <article className="card p-4"><p className="text-xs text-muted">Inversiones</p><p className="text-xl font-bold">{money(report.inversiones ?? 0)}</p></article>
            <article className="card p-4"><p className="text-xs text-muted">Balance operativo</p><p className="text-xl font-bold">{money(report.balance_operativo ?? 0)}</p></article>
            <article className="card p-4"><p className="text-xs text-muted">Disponible luego de ahorro</p><p className="text-xl font-bold">{money(report.disponible_luego_ahorro ?? 0)}</p></article>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="card p-4">
              <h3 className="mb-2 text-sm font-semibold">Top categorías</h3>
              {!Array.isArray(report.top_categorias) || report.top_categorias.length === 0 ? <EmptyState title="Sin datos de categorías" hint="No hay información para este período." /> : null}
              <div className="space-y-2 text-sm">
                {(report.top_categorias || []).slice(0, 6).map((c: any, i: number) => <div key={`${c.categoria}-${i}`} className="flex items-center justify-between rounded-lg border border-line p-2"><span>{c.categoria || "Sin categoría"}</span><strong>{money(c.total || 0)}</strong></div>)}
              </div>
            </section>

            <section className="card p-4">
              <h3 className="mb-2 text-sm font-semibold">Top movimientos</h3>
              {!Array.isArray(report.top_movimientos) || report.top_movimientos.length === 0 ? <EmptyState title="Sin movimientos destacados" hint="No hay datos para este período." /> : null}
              <div className="space-y-2 text-sm">
                {(report.top_movimientos || []).slice(0, 6).map((m: any, i: number) => <div key={`${m.id || i}`} className="rounded-lg border border-line p-2"><div className="flex items-center justify-between"><span>{m.descripcion || "Sin descripción"}</span><strong>{money(m.monto || 0)}</strong></div><p className="text-xs text-muted">{m.fecha || "-"} · {m.categoria || "Sin categoría"}</p></div>)}
              </div>
            </section>
          </div>
        </div>
      ) : !unavailable ? <EmptyState title="Sin datos para este mes" hint="No se encontraron movimientos o agregados para el período seleccionado." /> : null}
    </section>
  );
}
