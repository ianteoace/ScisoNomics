"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Categoria, Movimiento, MoveType } from "../../types/domain";
import { getLocalDateInputValue } from "../../lib/date";
import { getFinanceRepository } from "../../services/data/financeRepository";
import { calculateFinanceSummary } from "../../services/data/financeSummary";

const types: { value: MoveType; label: string }[] = [
  { value: "ingreso", label: "Ingreso" }, { value: "gasto", label: "Gasto" },
  { value: "ahorro", label: "Ahorro" }, { value: "inversion", label: "Inversión" },
];
const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 });

export function MobileFinanceDemo() {
  const [period, setPeriod] = useState(() => getLocalDateInputValue().slice(0, 7));
  const [data, setData] = useState<{ categorias: Categoria[]; movimientos: Movimiento[] }>({ categorias: [], movimientos: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [nombre, setNombre] = useState("");
  const [categoryType, setCategoryType] = useState<MoveType>("ingreso");
  const [moveType, setMoveType] = useState<MoveType>("ingreso");
  const [categoriaId, setCategoriaId] = useState("");
  const [monto, setMonto] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [fecha, setFecha] = useState(() => getLocalDateInputValue());
  const generation = useRef(0);
  const mounted = useRef(false);
  const mutationInFlight = useRef(false);

  const reload = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const repository = await getFinanceRepository();
      const [year, month] = period.split("-").map(Number);
      const [categorias, movimientos] = await Promise.all([
        repository.listCategorias(), repository.listMovimientos({ month, year }),
      ]);
      if (mounted.current && request === generation.current) setData({ categorias, movimientos });
    } catch {
      if (mounted.current && request === generation.current) setError("No se pudieron cargar tus datos. Podés reintentar.");
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; generation.current++; };
  }, [reload]);

  async function saveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationInFlight.current) return;
    mutationInFlight.current = true; setSaving(true); setError(""); setNotice("");
    try {
      await (await getFinanceRepository()).createCategoria({ nombre, tipo: categoryType });
      if (!mounted.current) return;
      setNombre(""); setNotice("Categoría guardada en este dispositivo.");
      await reload();
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "No se pudo guardar la categoría.");
    } finally {
      mutationInFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  async function saveMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationInFlight.current) return;
    mutationInFlight.current = true; setSaving(true); setError(""); setNotice("");
    try {
      await (await getFinanceRepository()).createMovimiento({
        fecha, tipo: moveType, categoria_id: Number(categoriaId), descripcion, monto: Number(monto.trim().replace(",", ".")),
      });
      if (!mounted.current) return;
      setMonto(""); setDescripcion(""); setNotice("Movimiento guardado en este dispositivo.");
      if (fecha.slice(0, 7) !== period) setPeriod(fecha.slice(0, 7));
      else await reload();
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "No se pudo guardar el movimiento.");
    } finally {
      mutationInFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  const summary = calculateFinanceSummary(data.movimientos);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-5 px-4 pb-12" style={{ paddingTop: "calc(2.5rem + env(safe-area-inset-top, 0px))" }}>
      <header>
        <h1 className="text-2xl font-bold">ScisoNomics Mobile</h1>
        <p className="mt-2 text-sm text-slate-300">Tus datos se guardan en este dispositivo.</p>
      </header>
      <label className="grid gap-2 text-sm">Mes de los movimientos
        <input className="input min-h-11" type="month" value={period} disabled={saving} onChange={(e) => { if (e.target.value) setPeriod(e.target.value); }} />
      </label>
      <section className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 min-[540px]:grid-cols-3" aria-label="Resumen del mes">
        {([["Ingresos", summary.ingresos], ["Gastos", summary.gastos], ["Balance", summary.balance]] as const).map(([label, amount]) => (
          <div key={label} className={`card min-w-0 p-3 ${label === "Balance" ? "min-[380px]:col-span-2 min-[540px]:col-span-1" : ""}`}>
            <p className="text-sm text-slate-300">{label}</p>
            <p className="mt-1 break-words text-lg font-bold tabular-nums">{loading ? "…" : money.format(amount)}</p>
          </div>
        ))}
      </section>
      <p className="-mt-3 text-xs text-slate-400">Balance del mes: ingresos menos gastos. Ahorros e inversiones se registran por separado.</p>
      {notice ? <p role="status" className="text-sm text-emerald-300">{notice}</p> : null}
      {error ? <div className="panel p-4"><p role="alert" className="text-sm text-red-300">{error}</p><button className="btn-secondary mt-3 min-h-11" disabled={saving || loading} onClick={() => void reload()}>Reintentar carga</button></div> : null}
      <section className="card p-4">
        <h2 className="section-title">Categorías</h2>
        <form className="mt-4 grid gap-3" onSubmit={saveCategory}>
          <fieldset disabled={saving || loading} className="grid min-w-0 gap-3">
            <label className="grid gap-2 text-sm">Nombre
              <input className="input min-h-11" value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={120} required placeholder="Prueba Mobile" />
            </label>
            <label className="grid gap-2 text-sm">Tipo de categoría
              <select className="input min-h-11" value={categoryType} onChange={(e) => setCategoryType(e.target.value as MoveType)}>{types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
            </label>
            <button className="btn min-h-11" type="submit">Crear categoría</button>
          </fieldset>
        </form>
        <ul className="mt-4 grid gap-2 text-sm" aria-label="Categorías guardadas">
          {data.categorias.map((c) => <li key={c.id} className="flex justify-between gap-3 border-t border-slate-700 pt-2"><span className="break-words">{c.nombre}</span><span className="text-slate-400">{types.find((t) => t.value === c.tipo)?.label}</span></li>)}
        </ul>
        {!loading && !data.categorias.length ? <p className="mt-3 text-sm text-slate-400">Creá tu primera categoría para comenzar.</p> : null}
      </section>
      <section className="card p-4">
        <h2 className="section-title">Movimientos</h2>
        <form className="mt-4 grid gap-3" onSubmit={saveMovement}>
          <fieldset disabled={saving || loading || !data.categorias.length} className="grid min-w-0 gap-3">
            <label className="grid gap-2 text-sm">Tipo de movimiento
              <select className="input min-h-11" value={moveType} onChange={(e) => setMoveType(e.target.value as MoveType)}>{types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
            </label>
            <label className="grid gap-2 text-sm">Monto
              <input className="input min-h-11" inputMode="decimal" value={monto} onChange={(e) => setMonto(e.target.value)} required placeholder="10000" />
            </label>
            <label className="grid gap-2 text-sm">Descripción
              <input className="input min-h-11" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} maxLength={500} placeholder="Concepto del movimiento" />
            </label>
            <label className="grid gap-2 text-sm">Fecha
              <input className="input min-h-11" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
            </label>
            <label className="grid gap-2 text-sm">Categoría
              <select className="input min-h-11" value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} required><option value="">Elegí una categoría</option>{data.categorias.map((c) => <option key={c.id} value={c.id}>{c.nombre} · {types.find((t) => t.value === c.tipo)?.label}</option>)}</select>
            </label>
            <button className="btn min-h-11" type="submit">Guardar movimiento</button>
          </fieldset>
        </form>
        <ul className="mt-4 grid gap-3" aria-label="Movimientos guardados">
          {data.movimientos.map((m) => <li key={m.id} className="border-t border-slate-700 pt-3"><div className="flex flex-wrap justify-between gap-2"><span className="break-words font-semibold">{m.descripcion || m.categoria}</span><span className={m.tipo === "ingreso" ? "text-emerald-300" : "text-red-300"}>{m.tipo === "ingreso" ? "+" : "−"}{money.format(m.monto)}</span></div><p className="mt-1 break-words text-xs text-slate-400">{m.fecha} · {m.categoria} · {types.find((t) => t.value === m.tipo)?.label}</p></li>)}
        </ul>
        {!loading && !data.movimientos.length ? <p className="mt-3 text-sm text-slate-400">Todavía no hay movimientos en este mes.</p> : null}
      </section>
    </main>
  );
}
