"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorState } from "../../../components/ui/ErrorState";
import { LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { Modal } from "../../../components/ui/Modal";
import { useToast } from "../../../hooks/useToast";
import { money, monthName, yearOptions } from "../../../lib/format";
import { api } from "../../../services/api";
import { useEffect } from "react";

type CalendarDayApi = {
  fecha: string;
  movimientos: Array<{ id: number; fecha: string; tipo: string; categoria: string; descripcion: string; monto: number; nota?: string }>;
  totales: { ingreso: number; gasto: number; ahorro: number; inversion: number };
};

type GridCell = {
  date: Date;
  iso: string;
  inMonth: boolean;
  isToday: boolean;
  data?: CalendarDayApi;
};

const WEEK_DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function weekdayMondayFirst(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export default function CalendarioPage() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [rows, setRows] = useState<CalendarDayApi[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<GridCell | null>(null);
  const { showError } = useToast();

  async function load() {
    setLoading(true);
    try {
      const data = await api.calendario(month, year);
      setRows(Array.isArray(data) ? data : []);
      setLoadError("");
    } catch (e: any) {
      setLoadError(e.message || "No se pudo cargar el calendario.");
      showError(e.message || "No se pudo cargar el calendario.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [month, year]);

  const mapByDate = useMemo(() => {
    const map = new Map<string, CalendarDayApi>();
    for (const day of rows) map.set(day.fecha, day);
    return map;
  }, [rows]);

  const grid = useMemo(() => {
    const first = new Date(year, month - 1, 1);
    const startOffset = weekdayMondayFirst(first);
    const start = new Date(first);
    start.setDate(first.getDate() - startOffset);

    const cells: GridCell[] = [];
    const todayIso = toIso(new Date());
    for (let i = 0; i < 42; i++) {
      const current = new Date(start);
      current.setDate(start.getDate() + i);
      const iso = toIso(current);
      cells.push({
        date: current,
        iso,
        inMonth: current.getMonth() === month - 1,
        isToday: iso === todayIso,
        data: mapByDate.get(iso),
      });
    }
    return cells;
  }, [month, year, mapByDate]);

  function goPrevMonth() {
    if (month === 1) {
      setMonth(12);
      setYear((y) => y - 1);
      return;
    }
    setMonth((m) => m - 1);
  }

  function goNextMonth() {
    if (month === 12) {
      setMonth(1);
      setYear((y) => y + 1);
      return;
    }
    setMonth((m) => m + 1);
  }

  const selectedData = selected?.data;
  const balanceDia = selectedData
    ? (selectedData.totales.ingreso || 0) - (selectedData.totales.gasto || 0) - (selectedData.totales.ahorro || 0) - (selectedData.totales.inversion || 0)
    : 0;

  return (
    <section className="card p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Calendario financiero</h2>
        <div className="flex items-center gap-2">
          <button className="btn-secondary p-2" onClick={goPrevMonth} aria-label="Mes anterior"><ChevronLeft size={16} /></button>
          <select className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
          <select className="input w-28" value={year} onChange={(e) => setYear(Number(e.target.value) || year)}>
            {yearOptions(new Date().getFullYear(), [year, ...rows.map((r) => Number(r.fecha.slice(0, 4)))]).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="btn-secondary p-2" onClick={goNextMonth} aria-label="Mes siguiente"><ChevronRight size={16} /></button>
        </div>
      </div>

      {loadError ? <ErrorState title="Error al cargar calendario" description={loadError} onRetry={load} /> : null}
      {loading ? <LoadingSkeleton rows={7} /> : null}
      {!loadError && !loading && rows.length === 0 ? <EmptyState title="Sin movimientos en el mes" hint="No hay datos para mostrar en este período." /> : null}

      <div className={`grid grid-cols-7 gap-2 text-xs font-semibold text-muted ${loading ? "hidden" : ""}`}>
        {WEEK_DAYS.map((d) => <div key={d} className="px-2 py-1">{d}</div>)}
      </div>

      <div className={`grid grid-cols-7 gap-2 ${loading ? "hidden" : ""}`}>
        {grid.map((cell) => {
          const totals = cell.data?.totales;
          const hasMovs = !!cell.data && cell.data.movimientos.length > 0;
          return (
            <button
              key={cell.iso}
              className={`min-h-28 rounded-xl border p-2 text-left transition ${cell.inMonth ? "border-line" : "border-line/40 opacity-60"} ${cell.isToday ? "ring-1 ring-aqua" : ""} ${hasMovs ? "bg-slate-800/20" : ""}`}
              onClick={() => setSelected(cell)}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-semibold">{cell.date.getDate()}</span>
                {hasMovs ? <span className="rounded-full bg-aqua/20 px-1.5 text-[10px]">{cell.data?.movimientos.length}</span> : null}
              </div>
              {totals ? (
                <div className="space-y-1 text-[10px]">
                  {totals.ingreso > 0 ? <div className="rounded bg-emerald-500/15 px-1">Ing: {money(totals.ingreso)}</div> : null}
                  {totals.gasto > 0 ? <div className="rounded bg-rose-500/15 px-1">Gas: {money(totals.gasto)}</div> : null}
                  {totals.ahorro > 0 ? <div className="rounded bg-cyan-500/15 px-1">Aho: {money(totals.ahorro)}</div> : null}
                  {totals.inversion > 0 ? <div className="rounded bg-amber-500/15 px-1">Inv: {money(totals.inversion)}</div> : null}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      <Modal open={!!selected} title={selected ? `Detalle ${selected.iso}` : "Detalle del día"} onClose={() => setSelected(null)}>
        {selectedData ? (
          <div className="space-y-3">
            <div className="grid gap-2 md:grid-cols-2 text-sm">
              <div>Ingresos: <strong>{money(selectedData.totales.ingreso)}</strong></div>
              <div>Gastos: <strong>{money(selectedData.totales.gasto)}</strong></div>
              <div>Ahorro: <strong>{money(selectedData.totales.ahorro)}</strong></div>
              <div>Inversiones: <strong>{money(selectedData.totales.inversion)}</strong></div>
              <div>Balance: <strong>{money(balanceDia)}</strong></div>
            </div>

            {selectedData.movimientos.length === 0 ? (
              <EmptyState title="No hay movimientos para este día" hint="Podés agregar uno desde la sección de movimientos." />
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {selectedData.movimientos.map((m) => (
                  <div key={m.id} className="rounded-lg border border-line p-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <strong>{m.tipo}</strong>
                      <span className={m.tipo === "ingreso" ? "text-emerald-300" : "text-rose-300"}>{money(m.monto)}</span>
                    </div>
                    <p>{m.categoria} · {m.descripcion || "Sin descripción"}</p>
                    {m.nota ? <p className="text-xs text-muted">Nota: {m.nota}</p> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <EmptyState title="No hay movimientos para este día" hint="Podés agregar uno desde la sección de movimientos." />
        )}
      </Modal>
    </section>
  );
}
