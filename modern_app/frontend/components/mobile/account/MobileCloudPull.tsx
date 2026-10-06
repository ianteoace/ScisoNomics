"use client";

import { useEffect, useRef, useState } from "react";
import { MobilePullError, pullMobileCloudNow, readMobileCloudSnapshot, type CloudSnapshot } from "../../../services/data/mobileCloudPull";

// First-stage read-only view. Anonymous financial modules keep owner=local.
export function MobileCloudPull({ ownerId }: { ownerId: string }) {
  const [snapshot, setSnapshot] = useState<CloudSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
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
      await pullMobileCloudNow(ownerId);
      const next = await readMobileCloudSnapshot(ownerId);
      if (mounted.current) { setSnapshot(next); setNotice("Descarga completada. Los datos de tu cuenta están guardados en este dispositivo."); }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof MobilePullError ? failure.message : "No se pudo leer el resultado de la sincronización. Reintentá sin borrar los datos.");
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="grid gap-3" aria-label="Datos cloud descargados">
    <h3 className="font-semibold">Datos de tu cuenta</h3>
    <p>Descargá categorías y movimientos. Esta vista es de consulta; los cambios de este dispositivo todavía no se envían a cloud.</p>
    <button className="btn min-h-12" disabled={busy} onClick={() => { void synchronize(); }}>{busy ? "Sincronizando…" : "Sincronizar ahora"}</button>
    {notice ? <p role="status" className="text-emerald-300">{notice}</p> : null}
    {error ? <p role="alert" className="text-red-300">{error}</p> : null}
    {snapshot ? <>
      <p>{snapshot.categories.length} categorías · {snapshot.movements.length} movimientos descargados</p>
      {!snapshot.cursor ? <p>Todavía no descargaste datos para esta cuenta.</p> : null}
      <ul aria-label="Categorías descargadas" className="flex flex-wrap gap-2">{snapshot.categories.map(category => <li className="rounded-lg border border-slate-700 px-2 py-1" key={`${category.tipo}:${category.nombre}`}>{category.nombre}</li>)}</ul>
      <ul aria-label="Movimientos descargados" className="grid gap-2">{snapshot.movements.slice(0, 50).map(movement => <li key={movement.sync_id} className="rounded-xl border border-slate-700 p-3">
        <p className="break-words font-semibold">{movement.descripcion || movement.categoria}</p>
        <p className="text-sm text-slate-400">{movement.fecha} · {movement.categoria} · {movement.tipo}</p>
        <p>{movement.monto.toLocaleString("es-AR", { style: "currency", currency: "ARS" })}</p>
      </li>)}</ul>
      {snapshot.movements.length > 50 ? <p>Se muestran los 50 movimientos más recientes. Todos los descargados están guardados.</p> : null}
    </> : null}
  </section>;
}
