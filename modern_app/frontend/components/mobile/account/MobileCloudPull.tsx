"use client";

import { useEffect, useRef, useState } from "react";
import { MobilePullError, pullMobileCloudNow, readMobileCloudSnapshot, type CloudSnapshot } from "../../../services/data/mobileCloudPull";
import { pushMobileCloudNow } from "../../../services/data/mobileCloudPush";
import { mobileAccountEntityRepository } from "../../../services/data/mobileFinanceRepository";
import { MobileCategoryForm } from "../categorias/MobileCategoryForm";
import { MobileMovementForm } from "../movimientos/MobileMovementForm";
import { MobileDialog } from "../MobileDialog";
import type { FinanceMovimiento } from "../../../services/data/financeRepositoryTypes";

// Explicit account context only. Anonymous financial modules keep owner=local.
export function MobileCloudPull({ ownerId }: { ownerId: string }) {
  const [snapshot, setSnapshot] = useState<CloudSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<"category" | "movement" | FinanceMovimiento | null>(null);
  const [removal, setRemoval] = useState<{ kind: "category" | "movement"; id: number } | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void readMobileCloudSnapshot(ownerId).then(value => { if (mounted.current) setSnapshot(value); })
      .catch(() => { if (mounted.current) setError("No se pudieron leer los datos descargados. Reintentá sin borrarlos."); });
    return () => { mounted.current = false; };
  }, [ownerId]);
  async function synchronize() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await pullMobileCloudNow(ownerId);
      const next = await readMobileCloudSnapshot(ownerId);
      if (mounted.current) { setSnapshot(next); setNotice(`Descarga completada: ${result.categoriesApplied} categorías y ${result.movementsApplied} movimientos aplicados.`); }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof MobilePullError ? failure.message : "No se pudo leer el resultado de la sincronización. Reintentá sin borrar los datos.");
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function upload() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await pushMobileCloudNow(ownerId);
      const next = await readMobileCloudSnapshot(ownerId);
      if (mounted.current) {
        setSnapshot(next); setNotice(`Subida completada: ${result.uploaded} cambios confirmados. ${result.stillPending} pendientes; ${result.conflicts} conflictos.`);
        if (result.rejected) setError("Algunos cambios no se confirmaron. Se conservaron para revisión; descargar no los sobrescribe.");
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof MobilePullError ? failure.message : "No se pudo confirmar la subida. Los cambios siguen pendientes."); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function save(action: (repository: ReturnType<typeof mobileAccountEntityRepository>) => Promise<void>) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await action(mobileAccountEntityRepository(ownerId));
      const next = await readMobileCloudSnapshot(ownerId);
      if (mounted.current) { setSnapshot(next); setNotice("Cambio guardado para esta cuenta. Usá Subir cambios cuando quieras enviarlo."); }
      return true;
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "No se pudo guardar el cambio."); return false; }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="grid gap-3" aria-label="Datos cloud descargados">
    <h3 className="font-semibold">Datos de tu cuenta</h3>
    <p>Estos cambios pertenecen a tu cuenta cloud. Tus finanzas locales siguen separadas. Sincronizar ahora descarga cambios; Subir cambios envía los pendientes.</p>
    <button className="btn min-h-12" disabled={busy} onClick={() => { void synchronize(); }}>{busy ? "Sincronizando…" : "Sincronizar ahora"}</button>
    <button className="btn-secondary min-h-12" disabled={busy} onClick={() => { void upload(); }}>Subir cambios</button>
    <div className="grid gap-2 sm:grid-cols-2">
      <button className="btn-secondary min-h-12" disabled={busy} onClick={() => { setError(""); setEditor("category"); }}>Crear categoría cloud</button>
      <button className="btn-secondary min-h-12" disabled={busy} onClick={() => { setError(""); setEditor("movement"); }}>Crear movimiento cloud</button>
    </div>
    {notice ? <p role="status" className="text-emerald-300">{notice}</p> : null}
    {error ? <p role="alert" className="text-red-300">{error}</p> : null}
    {snapshot ? <>
      <p>{snapshot.categories.length} categorías · {snapshot.movements.length} movimientos descargados</p>
      {!snapshot.cursor ? <p>Todavía no descargaste datos para esta cuenta.</p> : null}
      <ul aria-label="Categorías descargadas" className="flex flex-wrap gap-2">{snapshot.categories.map(category => <li className="rounded-lg border border-slate-700 px-2 py-1" key={`${category.tipo}:${category.nombre}`}>{category.nombre}<button className="ml-2 min-h-11 text-sm" aria-label={`Eliminar categoría cloud ${category.nombre}`} disabled={busy} onClick={() => setRemoval({kind:"category",id:category.id})}>Eliminar</button></li>)}</ul>
      <ul aria-label="Movimientos descargados" className="grid gap-2">{snapshot.movements.slice(0, 50).map(movement => <li key={movement.sync_id} className="rounded-xl border border-slate-700 p-3">
        <p className="break-words font-semibold">{movement.descripcion || movement.categoria}</p>
        <p className="text-sm text-slate-400">{movement.fecha} · {movement.categoria} · {movement.tipo}</p>
        <p>{movement.monto.toLocaleString("es-AR", { style: "currency", currency: "ARS" })}</p>
        <p className="text-xs">{movement.sync_status === "synced" ? "Sincronizado" : "Pendiente de subir"}{movement.sync_error_code ? " · No confirmado: requiere revisión" : ""}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn-secondary min-h-11" disabled={busy} aria-label={`Editar movimiento cloud ${movement.descripcion}`} onClick={() => { setError(""); setEditor({...movement,nota:"",meta_id:null,saldo_acumulado:0} as FinanceMovimiento); }}>Editar</button>
          <button className="btn-secondary min-h-11" disabled={busy} aria-label={`Eliminar movimiento cloud ${movement.descripcion}`} onClick={() => setRemoval({kind:"movement",id:movement.id})}>Eliminar</button>
        </div>
      </li>)}</ul>
      {snapshot.movements.length > 50 ? <p>Se muestran los 50 movimientos más recientes. Todos los descargados están guardados.</p> : null}
    </> : null}
    {editor === "category" ? <MobileCategoryForm busy={busy} error={error} onClose={() => setEditor(null)} onSave={input => save(repository => repository.createCategoria(input))} /> : null}
    {editor && editor !== "category" ? <MobileMovementForm cloudContext categories={snapshot?.categories ?? []} movement={editor === "movement" ? undefined : editor} busy={busy} error={error} onClose={() => setEditor(null)} onSave={input => save(repository => editor === "movement" ? repository.createMovimiento(input) : repository.updateMovimiento(editor.id,input))} /> : null}
    {removal ? <MobileDialog title="Eliminar de esta cuenta" busy={busy} onClose={() => setRemoval(null)}>
      <p>Se guardará la eliminación pendiente para sincronizarla. No se borran tus datos locales.</p>
      {error ? <p role="alert">{error}</p> : null}
      <button className="btn min-h-12 mt-3" disabled={busy} onClick={() => { void save(repository => removal.kind === "category" ? repository.deleteCategoria(removal.id) : repository.deleteMovimiento(removal.id)).then(ok => {if(ok)setRemoval(null);}); }}>Confirmar eliminación</button>
      <button className="btn-secondary min-h-12 mt-3" disabled={busy} onClick={() => setRemoval(null)}>Cancelar</button>
    </MobileDialog> : null}
  </section>;
}
