"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Categoria, GastoFijo, Presupuesto, MetaAhorro } from "../../types/domain";
import type { FinanceMovimiento } from "../../services/data/financeRepositoryTypes";
import { MobileHeader } from "./MobileHeader";
import { MobileSidebar, mobileSections } from "./MobileSidebar";
import { MobileDialog } from "./MobileDialog";
import { useMobileFinance } from "./useMobileFinance";
import { MobileDashboard } from "./dashboard/MobileDashboard";
import { MobileMovements } from "./movimientos/MobileMovements";
import { MobileMovementForm } from "./movimientos/MobileMovementForm";
import { MobileCategories } from "./categorias/MobileCategories";
import { MobileCategoryForm } from "./categorias/MobileCategoryForm";

import { MobileFixedExpenses } from "./gastos-fijos/MobileFixedExpenses";
import { MobileFixedExpenseForm } from "./gastos-fijos/MobileFixedExpenseForm";
import { MobileBudgets } from "./presupuestos/MobileBudgets";
import { MobileBudgetForm } from "./presupuestos/MobileBudgetForm";
import { MobileGoals } from "./metas/MobileGoals";
import { MobileGoalForm } from "./metas/MobileGoalForm";

type Editor = { kind: "movement"; row?: FinanceMovimiento } | { kind: "category"; row?: Categoria } | { kind: "fixed"; row?: GastoFijo } | { kind: "budget"; row?: Presupuesto } | { kind: "goal"; row?: MetaAhorro };
type Removal = { kind: "movement"; row: FinanceMovimiento } | { kind: "category"; row: Categoria } | { kind: "fixed"; row: GastoFijo } | { kind: "budget"; row: Presupuesto } | { kind: "goal"; row: MetaAhorro };
const removalTitles = { movement: "movimiento", category: "categoría", fixed: "gasto fijo", budget: "presupuesto", goal: "meta" };

export function MobileApp() {
  const pathname = (usePathname() || "/").replace(/\/$/, "");
  const router = useRouter();
  const section = mobileSections.find((item) => item.href === pathname);
  const finance = useMobileFinance();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  useEffect(() => { setMenuOpen(false); if (!section) router.replace("/dashboard"); }, [pathname, section, router]);
  function edit(value: Editor) { finance.clearMessages(); setEditor(value); }
  function remove(value: Removal) { finance.clearMessages(); setRemoval(value); }
  async function confirmRemoval() {
    if (!removal) return;
    const success = await finance.mutate((repository) => removal.kind === "movement"
      ? repository.deleteMovimiento(removal.row.id) : removal.kind === "category" ? repository.deleteCategoria(removal.row.id)
      : removal.kind === "fixed" ? repository.deleteGastoFijo(removal.row.id) : removal.kind === "budget" ? repository.deletePresupuesto(removal.row.id) : repository.deleteMeta(removal.row.id),
    "Registro eliminado.");
    if (success) setRemoval(null);
  }
  const { data, busy, error, loading } = finance;
  return <div className="min-h-screen bg-slate-950 text-slate-100">
    <MobileHeader title={section?.label ?? "Inicio"} menuOpen={menuOpen} onOpenMenu={() => setMenuOpen(true)} />
    {menuOpen ? <MobileSidebar pathname={pathname} onClose={() => setMenuOpen(false)} /> : null}
    <main className="mx-auto grid w-full max-w-2xl gap-5 px-4 pt-5" style={{ paddingBottom: "calc(2rem + env(safe-area-inset-bottom, 0px))" }}>
      {["/dashboard", "/movimientos", "/presupuestos"].includes(pathname) ? <label className="grid gap-2 text-sm">{pathname === "/presupuestos" ? "Mes del presupuesto" : "Mes de los movimientos"}<input className="input min-h-12" type="month" value={finance.period} disabled={busy} onChange={(event) => { if (event.target.value) finance.setPeriod(event.target.value); }} /></label> : null}
      {finance.notice ? <p role="status" className="break-words text-sm text-emerald-300">{finance.notice}</p> : null}
      {error && !editor && !removal ? <div className="card p-4"><p role="alert" className="break-words text-red-300">{error}</p><button className="btn-secondary mt-3 min-h-11" disabled={loading} onClick={finance.reload}>Reintentar</button></div> : null}
      {loading ? <p role="status" className="p-4 text-slate-300">Cargando tus datos…</p> : null}
      {!loading && data && pathname === "/dashboard" ? <MobileDashboard summary={data.summary} rows={data.movements} onCreate={() => edit({ kind: "movement" })} onEdit={(row) => edit({ kind: "movement", row })} /> : null}
      {!loading && data && pathname === "/movimientos" ? <MobileMovements rows={data.movements} onCreate={() => edit({ kind: "movement" })} onEdit={(row) => edit({ kind: "movement", row })} onDelete={(row) => remove({ kind: "movement", row })} /> : null}
      {!loading && data && pathname === "/categorias" ? <MobileCategories rows={data.categories} onCreate={() => edit({ kind: "category" })} onEdit={(row) => edit({ kind: "category", row })} onDelete={(row) => remove({ kind: "category", row })} /> : null}
      {!loading && data && pathname === "/gastos-fijos" ? <MobileFixedExpenses rows={data.fixedExpenses} onCreate={() => edit({ kind: "fixed" })} onEdit={(row) => edit({ kind: "fixed", row })} onDelete={(row) => remove({ kind: "fixed", row })} /> : null}
      {!loading && data && pathname === "/presupuestos" ? <MobileBudgets rows={data.budgets} onCreate={() => edit({ kind: "budget" })} onEdit={(row) => edit({ kind: "budget", row })} onDelete={(row) => remove({ kind: "budget", row })} /> : null}
      {!loading && data && pathname === "/metas" ? <MobileGoals rows={data.goals} onCreate={() => edit({ kind: "goal" })} onEdit={(row) => edit({ kind: "goal", row })} onDelete={(row) => remove({ kind: "goal", row })} /> : null}
    </main>
    {editor?.kind === "movement" ? <MobileMovementForm categories={data?.categories ?? []} goals={data?.goals ?? []} movement={editor.row} busy={busy} error={error} onClose={() => setEditor(null)}
      onSave={(input) => finance.mutate((repository) => editor.row ? repository.updateMovimiento(editor.row.id, input) : repository.createMovimiento(input), "Movimiento guardado.", input.fecha.slice(0, 7))} /> : null}
    {editor?.kind === "category" ? <MobileCategoryForm category={editor.row} busy={busy} error={error} onClose={() => setEditor(null)}
      onSave={(input) => finance.mutate((repository) => editor.row ? repository.updateCategoria(editor.row.id, input) : repository.createCategoria(input), "Categoría guardada.")} /> : null}
    {editor?.kind === "fixed" ? <MobileFixedExpenseForm categories={data?.categories ?? []} row={editor.row} busy={busy} error={error} onClose={() => setEditor(null)} onSave={(input) => finance.mutate((r) => editor.row ? r.updateGastoFijo(editor.row.id, input) : r.createGastoFijo(input), "Gasto fijo guardado.")} /> : null}
    {editor?.kind === "budget" ? <MobileBudgetForm categories={data?.categories ?? []} rows={data?.budgets ?? []} row={editor.row} period={finance.period} busy={busy} error={error} onClose={() => setEditor(null)} onSave={(input) => finance.mutate((r) => editor.row ? r.updatePresupuesto(editor.row.id, input) : r.createPresupuesto(input), "Presupuesto guardado.", `${input.anio}-${String(input.mes).padStart(2, "0")}`)} /> : null}
    {editor?.kind === "goal" ? <MobileGoalForm row={editor.row} busy={busy} error={error} onClose={() => setEditor(null)} onSave={(input) => finance.mutate((r) => editor.row ? r.updateMeta(editor.row.id, input) : r.createMeta(input), "Meta guardada.")} /> : null}
    {removal ? <MobileDialog title={`Eliminar ${removalTitles[removal.kind]}`} busy={busy} onClose={() => setRemoval(null)}>
      <p className="break-words text-slate-300">{removal.kind === "movement" ? `¿Querés eliminar ${removal.row.descripcion || removal.row.categoria}?`
        : removal.kind === "category" ? `¿Querés eliminar ${removal.row.nombre}? No se puede eliminar una categoría con movimientos asociados. También se eliminarán sus presupuestos y gastos fijos.`
        : removal.kind === "goal" ? `¿Querés eliminar ${removal.row.nombre}? Los movimientos conservarán sus montos y quedarán sin esa meta.`
        : removal.kind === "fixed" ? `¿Querés eliminar ${removal.row.descripcion}?` : `¿Querés eliminar el presupuesto de ${removal.row.categoria}?`}</p>
      {error ? <p role="alert" className="mt-4 break-words text-red-300">{error}</p> : null}
      <div className="mt-5 grid gap-3"><button className="btn min-h-12" disabled={busy} onClick={() => void confirmRemoval()}>{busy ? "Eliminando…" : "Eliminar"}</button><button className="btn-secondary min-h-12" disabled={busy} onClick={() => setRemoval(null)}>Cancelar</button></div>
    </MobileDialog> : null}
  </div>;
}
