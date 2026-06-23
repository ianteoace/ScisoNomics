"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { monthName, money, yearOptions } from "../../lib/format";
import type { GastoFijo, GastoProgramado, MetaAhorro, Movimiento, Presupuesto, StatsResponse } from "../../types/domain";
import { ClientOnly } from "../ui/ClientOnly";
import { EmptyState } from "../ui/EmptyState";
import { LoadingGrid, LoadingSkeleton } from "../ui/LoadingSkeleton";
import { MetricCard } from "../ui/MetricCard";
import { SectionHeader } from "../ui/SectionHeader";

export function DashboardView({
  summary,
  previous,
  stats,
  upcoming,
  resumenPotente,
  presupuestos,
  gastosFijos,
  metas,
  recentMovements,
  month,
  year,
  onMonthChange,
  onYearChange,
  saldoActual,
  onQuickNewMovement,
  onQuickMovements,
  onQuickStats,
  onQuickExport,
  onQuickBackup,
  loading,
}: {
  summary: { saldo_inicial: number; ingreso: number; gasto: number; balance_final: number };
  previous: { ingreso: number; gasto: number } | null;
  stats: StatsResponse | null;
  upcoming: GastoProgramado[];
  resumenPotente: any;
  presupuestos: Presupuesto[];
  gastosFijos: GastoFijo[];
  metas: MetaAhorro[];
  recentMovements: Movimiento[];
  month: number;
  year: number;
  onMonthChange: (v: number) => void;
  onYearChange: (v: number) => void;
  saldoActual: number;
  onQuickNewMovement: () => void;
  onQuickMovements: () => void;
  onQuickStats: () => void;
  onQuickExport: () => Promise<void>;
  onQuickBackup: () => Promise<void>;
  loading: boolean;
}) {
  const incomeVar = previous && previous.ingreso ? ((summary.ingreso - previous.ingreso) / previous.ingreso) * 100 : null;
  const expenseVar = previous && previous.gasto ? ((summary.gasto - previous.gasto) / previous.gasto) * 100 : null;

  const ahorroMes = Number(resumenPotente?.ahorro_mes || 0);
  const inversionesMes = Number(resumenPotente?.inversiones_mes || 0);
  const balanceMes = Number(resumenPotente?.balance_mensual ?? summary.balance_final);

  const presupuestoComprometido = presupuestos.length
    ? [...presupuestos].sort((a, b) => Number(b.porcentaje_usado || 0) - Number(a.porcentaje_usado || 0))[0]
    : null;

  const proximoGastoFijo = (() => {
    const activos = gastosFijos.filter((g) => g.activo === 1);
    if (!activos.length) return null;
    const today = new Date().getDate();
    return [...activos].sort((a, b) => {
      const deltaA = a.dia_vencimiento >= today ? a.dia_vencimiento - today : 31 - today + a.dia_vencimiento;
      const deltaB = b.dia_vencimiento >= today ? b.dia_vencimiento - today : 31 - today + b.dia_vencimiento;
      return deltaA - deltaB;
    })[0];
  })();

  const metaMasAvanzada = metas.length
    ? [...metas].sort((a, b) => Number(b.porcentaje_completado || 0) - Number(a.porcentaje_completado || 0))[0]
    : null;
  const presupuestosEnAlerta = presupuestos.filter((p) => Number(p.porcentaje_usado || 0) >= 70);
  const gastosProgramadosCercanos = upcoming.slice(0, 3);
  const metasCercanas = metas.filter((m) => Number(m.porcentaje_completado || 0) >= 75 && Number(m.porcentaje_completado || 0) < 100).slice(0, 3);

  const barData = [
    { name: "Ingresos", value: summary.ingreso },
    { name: "Gastos", value: summary.gasto },
  ];
  const showWelcome =
    !loading &&
    recentMovements.length === 0 &&
    upcoming.length === 0 &&
    presupuestos.length === 0 &&
    gastosFijos.length === 0 &&
    metas.length === 0 &&
    Number(summary.ingreso || 0) === 0 &&
    Number(summary.gasto || 0) === 0;

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-3xl border border-line bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.20),transparent_32%),linear-gradient(135deg,rgba(15,23,42,0.96),rgba(2,6,23,0.92))] p-5 text-white shadow-2xl shadow-slate-950/20 dark:border-slate-800 md:p-7">
        <div className="relative z-10 grid gap-5 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-cyan-200/80">Inicio</p>
            <h2 className="mt-2 text-3xl font-black tracking-tight md:text-4xl">Resumen financiero</h2>
            <p className="mt-2 max-w-2xl text-sm text-slate-300">
              Vista rápida de tu mes, saldos, actividad reciente y puntos que necesitan atención.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <select className="input border-white/20 bg-white/10 text-white" value={month} onChange={(e) => onMonthChange(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
            </select>
            <select className="input border-white/20 bg-white/10 text-white" value={year} onChange={(e) => onYearChange(Number(e.target.value))}>
              {yearOptions(new Date().getFullYear(), [year]).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
      </section>

      {showWelcome ? (
        <section className="relative overflow-hidden rounded-3xl border border-cyan-400/20 bg-slate-950/70 p-5 shadow-xl shadow-cyan-950/10 md:p-6">
          <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-cyan-400/10 blur-3xl" />
          <div className="relative z-10">
            <p className="text-xs uppercase tracking-[0.22em] text-cyan-300">Primeros pasos</p>
            <h3 className="mt-2 text-2xl font-black">Bienvenido a ScisoNomics</h3>
            <p className="mt-2 max-w-2xl text-sm text-slate-300">
              Podés empezar en modo local o agregar una cuenta para sincronizar. Tus datos principales se guardan en este dispositivo.
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button className="btn" onClick={onQuickNewMovement}>Registrar primer movimiento</button>
              <button className="btn-secondary" onClick={() => window.dispatchEvent(new Event("scisonomics:open-add-account-modal"))}>Agregar cuenta</button>
              <button className="btn-secondary" onClick={() => onQuickBackup().catch(() => undefined)}>Crear backup</button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="relative overflow-hidden rounded-3xl border border-cyan-300/10 bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950/80 p-5 shadow-sm shadow-cyan-900/5 md:p-6">
          <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-cyan-400/20 blur-3xl dark:bg-cyan-300/10" />
          <div className="pointer-events-none absolute -bottom-24 left-1/3 h-48 w-72 rounded-full bg-sky-500/10 blur-3xl dark:bg-sky-400/10" />
          <div className="relative z-10">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-300">Saldo actual</p>
            <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-4xl font-black tracking-tight text-cyan-100 md:text-5xl">{money(saldoActual)}</p>
                <p className="mt-2 text-sm text-slate-300">Saldo del mes anterior: {money(summary.saldo_inicial)}</p>
              </div>
              <div className={`rounded-2xl border px-4 py-3 text-sm font-semibold shadow-sm backdrop-blur ${balanceMes >= 0 ? "border-emerald-500/20 bg-emerald-500/15 text-emerald-200" : "border-amber-500/20 bg-amber-500/15 text-amber-200"}`}>
                Balance del mes: {money(balanceMes)}
              </div>
            </div>
          </div>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">Sincronización</p>
          <p className="mt-2 text-lg font-semibold">Estado local-first</p>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Tus datos se guardan localmente. Si activaste sincronización automática, ScisoNomics también consulta cambios remotos en segundo plano.
          </p>
        </div>
      </section>

      {loading ? (
        <LoadingGrid items={8} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard title="Saldo del mes anterior" value={money(summary.saldo_inicial)} tone="default" />
          <MetricCard title="Saldo actual" value={money(saldoActual)} tone="accent" />
          <MetricCard highlightOnHover title="Ingresos del mes" value={money(summary.ingreso)} tone="income" helper={incomeVar === null ? "Mes anterior: -" : `Mes anterior: ${incomeVar >= 0 ? "+" : ""}${incomeVar.toFixed(1)}%`} />
          <MetricCard highlightOnHover title="Gastos del mes" value={money(summary.gasto)} tone="expense" helper={expenseVar === null ? "Mes anterior: -" : `Mes anterior: ${expenseVar >= 0 ? "+" : ""}${expenseVar.toFixed(1)}%`} />
          <MetricCard title="Balance del mes" value={money(balanceMes)} tone={balanceMes >= 0 ? "income" : "warn"} />
          <MetricCard title="Ahorros del mes" value={money(ahorroMes)} tone="accent" />
          <MetricCard title="Inversiones del mes" value={money(inversionesMes)} tone="accent" />
        </div>
      )}

      <section className="card p-4">
        <SectionHeader title="Indicadores útiles" subtitle="Puntos clave para decidir rápido" />
        {loading ? (
          <LoadingSkeleton rows={4} />
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-line p-3 text-sm">
              <p className="text-slate-500 dark:text-slate-400">Presupuesto más comprometido</p>
              {presupuestoComprometido ? (
                <>
                  <p className="mt-1 font-semibold">{presupuestoComprometido.categoria}</p>
                  <p>{presupuestoComprometido.porcentaje_usado.toFixed(1)}% - {money(presupuestoComprometido.monto_gastado)} / {money(presupuestoComprometido.monto_presupuestado)}</p>
                </>
              ) : <p className="mt-1">Sin presupuestos cargados.</p>}
            </div>
            <div className="rounded-xl border border-line p-3 text-sm">
              <p className="text-slate-500 dark:text-slate-400">Próximo gasto fijo</p>
              {proximoGastoFijo ? (
                <>
                  <p className="mt-1 font-semibold">{proximoGastoFijo.descripcion}</p>
                  <p>{money(proximoGastoFijo.monto)} - Día {proximoGastoFijo.dia_vencimiento}</p>
                </>
              ) : <p className="mt-1">Sin gastos fijos activos.</p>}
            </div>
            <div className="rounded-xl border border-line p-3 text-sm">
              <p className="text-slate-500 dark:text-slate-400">Meta más avanzada</p>
              {metaMasAvanzada ? (
                <>
                  <p className="mt-1 font-semibold">{metaMasAvanzada.nombre}</p>
                  <p>{Number(metaMasAvanzada.porcentaje_completado || 0).toFixed(1)}% - {money(metaMasAvanzada.monto_ahorrado)} / {money(metaMasAvanzada.monto_objetivo)}</p>
                </>
              ) : <p className="mt-1">Sin metas de ahorro.</p>}
            </div>
          </div>
        )}
      </section>

      <section className="card p-4">
        <SectionHeader title="Accesos rápidos" subtitle="Acciones frecuentes" />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <button className="btn" onClick={onQuickNewMovement}>Nuevo ingreso/gasto</button>
          <button className="btn-secondary" onClick={onQuickMovements}>Ver movimientos</button>
          <button className="btn-secondary" onClick={onQuickStats}>Ver estadísticas</button>
          <button className="btn-secondary" onClick={() => onQuickExport().catch(() => undefined)}>Exportar reporte</button>
          <button className="btn-secondary" onClick={() => onQuickBackup().catch(() => undefined)}>Crear copia de seguridad</button>
        </div>
      </section>

      <section className="card p-4">
        <SectionHeader title="Alertas financieras" subtitle="Puntos para revisar este mes" />
        {loading ? (
          <LoadingSkeleton rows={4} />
        ) : presupuestosEnAlerta.length === 0 && gastosProgramadosCercanos.length === 0 && metasCercanas.length === 0 ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
            Sin alertas importantes para este periodo.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-line p-3">
              <p className="font-semibold">Presupuestos</p>
              {presupuestosEnAlerta.length === 0 ? <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Sin limites comprometidos.</p> : null}
              {presupuestosEnAlerta.slice(0, 3).map((p) => (
                <p key={p.id} className="mt-2 text-sm text-amber-700 dark:text-amber-300">{p.categoria}: {p.porcentaje_usado.toFixed(1)}% usado</p>
              ))}
            </div>
            <div className="rounded-2xl border border-line p-3">
              <p className="font-semibold">Gastos programados</p>
              {gastosProgramadosCercanos.length === 0 ? <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Sin vencimientos cercanos.</p> : null}
              {gastosProgramadosCercanos.map((g) => (
                <p key={g.id} className="mt-2 text-sm text-slate-600 dark:text-slate-300">{g.descripcion}: {money(g.monto_estimado)}</p>
              ))}
            </div>
            <div className="rounded-2xl border border-line p-3">
              <p className="font-semibold">Metas</p>
              {metasCercanas.length === 0 ? <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Sin metas cerca del objetivo.</p> : null}
              {metasCercanas.map((m) => (
                <p key={m.id} className="mt-2 text-sm text-cyan-700 dark:text-cyan-300">{m.nombre}: {Number(m.porcentaje_completado || 0).toFixed(1)}%</p>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <section className="card p-5 transition-colors duration-200 hover:border-slate-300 dark:hover:border-white/40 xl:col-span-2">
          <SectionHeader title="Ingresos vs gastos" subtitle="Comparativa rápida del mes" />
          <div className="h-64">
            {loading ? (
              <div className="h-full w-full animate-pulse rounded-lg border border-slate-800 bg-slate-900" />
            ) : (
              <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800/40" />}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData}>
                    <XAxis dataKey="name" stroke="#95bfb8" />
                    <YAxis stroke="#95bfb8" />
                    <Tooltip
                      cursor={false}
                      formatter={(v: number) => [money(v), "valor"]}
                      contentStyle={{ borderRadius: 12, border: "1px solid rgb(var(--line))", background: "rgb(var(--card))" }}
                      itemStyle={{ color: "rgb(var(--text))" }}
                      labelStyle={{ color: "rgb(var(--text))" }}
                    />
                    <Bar dataKey="value" radius={10}>
                      {barData.map((entry) => (
                        <Cell key={entry.name} fill={entry.name === "Gastos" ? "rgb(var(--expense))" : "rgb(var(--income))"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ClientOnly>
            )}
          </div>
        </section>

        <section className="card p-5 transition-colors duration-200 hover:border-slate-300 dark:hover:border-white/40">
          <SectionHeader title="Próximos gastos" subtitle="Pendientes cercanos" />
          {loading ? (
            <LoadingSkeleton rows={5} />
          ) : (
            <div className="space-y-2">
              {upcoming.length === 0 ? <p className="text-sm text-slate-400">Sin vencimientos cercanos.</p> : null}
              {upcoming.slice(0, 8).map((item) => (
                <div key={item.id} className="rounded-xl border p-2.5 text-sm" style={{ borderColor: "rgb(var(--line))" }}>
                  <div className="flex justify-between gap-2"><span className="font-medium">{item.descripcion}</span><span className="font-semibold text-rose-300">{money(item.monto_estimado)}</span></div>
                  <div className="text-xs text-slate-400">{item.fecha_vencimiento} - {item.estado}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {!loading && stats ? (
        <div className="card p-4 text-sm text-slate-700 dark:text-slate-300">
          Balance proyectado del mes: <span className="font-semibold text-cyan-700 dark:text-cyan-300">{money(stats.planificacion.balance_proyectado_mes)}</span>
          <span className="ml-3">Disponible luego de ahorro: <strong>{money(resumenPotente?.disponible_luego_ahorro || 0)}</strong></span>
          {resumenPotente?.categoria_mayor_gasto ? <span className="ml-3">Mayor gasto: <strong>{resumenPotente.categoria_mayor_gasto.categoria}</strong></span> : null}
          <span className="ml-3">Saldo actual: <strong>{money(saldoActual)}</strong></span>
        </div>
      ) : null}

      <section className="card p-4">
        <SectionHeader title="Actividad reciente" subtitle="Últimos 5 movimientos" />
        {loading ? (
          <LoadingSkeleton rows={5} />
        ) : recentMovements.length === 0 ? (
          <EmptyState title="No hay movimientos recientes." hint="Carga un movimiento para comenzar." />
        ) : (
          <div className="space-y-2">
            {recentMovements.map((mov) => (
              <div key={mov.id} className="rounded-lg border border-line p-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{mov.descripcion || "Sin descripción"}</span>
                  <strong className={mov.tipo === "ingreso" ? "text-emerald-300" : "text-rose-300"}>{money(mov.monto)}</strong>
                </div>
                <div className="text-xs text-slate-400">{mov.fecha} - {mov.categoria} - {mov.tipo}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
