"use client";
import { useEffect, useState } from "react";
import { getRuntimePlatformSync } from "../../../services/platform";
import { quickEntryInfo, requestQuickEntryTile, type QuickEntryType } from "../../../services/mobileQuickEntry";

export function MobileQuickEntrySettings() {
  const [sdk, setSdk] = useState<number | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const android = getRuntimePlatformSync() === "android";
  useEffect(() => { let active = true; if (android) void quickEntryInfo().then(info => { if (active && Number.isInteger(info.sdk)) setSdk(info.sdk); }).catch(() => {}); return () => { active = false; }; }, [android]);
  if (!android) return null;
  async function add(type: QuickEntryType) {
    if (busy) return; setBusy(true); setNotice("");
    try { setNotice(await requestQuickEntryTile(type)); } catch { setNotice("No pudimos agregar el acceso rápido. Usá Ajustes rápidos > Editar."); }
    finally { setBusy(false); }
  }
  return <section className="grid gap-3" aria-label="Accesos rápidos de Android">
    <h3 className="font-semibold">Accesos rápidos de Android</h3>
    <p>Abrí un nuevo ingreso o gasto desde Ajustes rápidos. Confirmás el movimiento dentro de ScisoNomics.</p>
    {sdk !== null && sdk >= 33 ? <>
      <button className="btn-secondary min-h-11" disabled={busy} onClick={() => void add("income")}>Agregar tile de ingreso</button>
      <button className="btn-secondary min-h-11" disabled={busy} onClick={() => void add("expense")}>Agregar tile de gasto</button>
    </> : <p>Abrí Ajustes rápidos &gt; Editar y agregá Ingreso/Gasto de ScisoNomics.</p>}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
