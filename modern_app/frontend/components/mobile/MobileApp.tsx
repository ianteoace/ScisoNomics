"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Categoria } from "../../types/domain";
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

type Editor = { kind: "movement"; row?: FinanceMovimiento } | { kind: "category"; row?: Categoria };
type Removal = { kind: "movement"; row: FinanceMovimiento } | { kind: "category"; row: Categoria };

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
      ? repository.deleteMovimiento(removal.row.id) : repository.deleteCategoria(removal.row.id),
    removal.kind === "movement" ? "Movimiento eliminado." : "Categoría eliminada.");
    if (success) setRemoval(null);
  }
  const { data, busy, error, loading } = finance;
  return <div className="min-h-screen bg-slate-950 text-slate-100">
    <MobileHeader title={section?.label ?? "Inicio"} menuOpen={menuOpen} onOpenMenu={() => setMenuOpen(true)} />
    {menuOpen ? <MobileSidebar pathname={pathname} onClose={() => setMenuOpen(false)} /> : null}
    <main className="mx-auto grid w-full max-w-2xl gap-5 px-4 pt-5" style={{ paddingBottom: "calc(2rem + env(safe-area-inset-bottom, 0px))" }}>
      {pathname !== "/categorias" ? <label className="grid gap-2 text-sm">Mes de los movimientos<input className="input min-h-12" type="month" value={finance.period} disabled={busy} onChange={(event) => { if (event.target.value) finance.setPeriod(event.target.value); }} /></label> : null}
      {finance.notice ? <p role="status" className="break-words text-sm text-emerald-300">{finance.notice}</p> : null}
      {error && !editor && !removal ? <div className="card p-4"><p role="alert" className="break-words text-red-300">{error}</p><button className="btn-secondary mt-3 min-h-11" disabled={loading} onClick={finance.reload}>Reintentar</button></div> : null}
      {loading ? <p role="status" className="p-4 text-slate-300">Cargando tus datos…</p> : null}
      {!loading && data && pathname === "/dashboard" ? <MobileDashboard summary={data.summary} rows={data.movements} onCreate={() => edit({ kind: "movement" })} onEdit={(row) => edit({ kind: "movement", row })} /> : null}
      {!loading && data && pathname === "/movimientos" ? <MobileMovements rows={data.movements} onCreate={() => edit({ kind: "movement" })} onEdit={(row) => edit({ kind: "movement", row })} onDelete={(row) => remove({ kind: "movement", row })} /> : null}
      {!loading && data && pathname === "/categorias" ? <MobileCategories rows={data.categories} onCreate={() => edit({ kind: "category" })} onEdit={(row) => edit({ kind: "category", row })} onDelete={(row) => remove({ kind: "category", row })} /> : null}
    </main>
    {editor?.kind === "movement" ? <MobileMovementForm categories={data?.categories ?? []} movement={editor.row} busy={busy} error={error} onClose={() => setEditor(null)}
      onSave={(input) => finance.mutate((repository) => editor.row ? repository.updateMovimiento(editor.row.id, input) : repository.createMovimiento(input), "Movimiento guardado.", input.fecha.slice(0, 7))} /> : null}
    {editor?.kind === "category" ? <MobileCategoryForm category={editor.row} busy={busy} error={error} onClose={() => setEditor(null)}
      onSave={(input) => finance.mutate((repository) => editor.row ? repository.updateCategoria(editor.row.id, input) : repository.createCategoria(input), "Categoría guardada.")} /> : null}
    {removal ? <MobileDialog title={removal.kind === "movement" ? "Eliminar movimiento" : "Eliminar categoría"} busy={busy} onClose={() => setRemoval(null)}>
      <p className="break-words text-slate-300">{removal.kind === "movement" ? `¿Querés eliminar ${removal.row.descripcion || removal.row.categoria}?` : `¿Querés eliminar ${removal.row.nombre}? No se puede eliminar una categoría con movimientos asociados.`}</p>
      {error ? <p role="alert" className="mt-4 break-words text-red-300">{error}</p> : null}
      <div className="mt-5 grid gap-3"><button className="btn min-h-12" disabled={busy} onClick={() => void confirmRemoval()}>{busy ? "Eliminando…" : "Eliminar"}</button><button className="btn-secondary min-h-12" disabled={busy} onClick={() => setRemoval(null)}>Cancelar</button></div>
    </MobileDialog> : null}
  </div>;
}
