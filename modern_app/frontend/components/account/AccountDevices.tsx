"use client";

import { useEffect, useState } from "react";
import { getValidAccessToken } from "../../services/cloudAuth";
import { listAccountDevices, manageAccountDevice, type AccountDevice } from "../../services/deviceAuthorization";
import { signOut } from "../../services/supabaseCloudAuth";
import { MobileDialog } from "../mobile/MobileDialog";

export function AccountDevices({ ownerId }: { ownerId: string }) {
  const [devices, setDevices] = useState<AccountDevice[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<{ device: AccountDevice; rename: boolean } | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    let cancelled = false;
    setDevices([]); setError("");
    void getValidAccessToken(ownerId).then(async (session) => {
      if (!session) throw new Error("Iniciá sesión para ver tus dispositivos.");
      return listAccountDevices(session.token);
    }).then((rows) => { if (!cancelled) setDevices(rows); })
      .catch((failure) => { if (!cancelled) setError(failure instanceof Error ? failure.message : "No pudimos cargar los dispositivos."); });
    return () => { cancelled = true; };
  }, [ownerId, revision]);

  async function confirm() {
    if (!action || busy) return;
    setBusy(true); setError("");
    try {
      const session = await getValidAccessToken(ownerId);
      if (!session) throw new Error("Volvé a iniciar sesión.");
      const result = await manageAccountDevice(session.token, ownerId, action.device.device_id,
        action.rename ? "device_rename" : "device_revoke", action.rename ? name : undefined, action.device.current && !action.rename);
      setAction(null);
      if (result.currentRevoked) await signOut(ownerId);
      else setRevision((value) => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "No pudimos actualizar el dispositivo."); }
    finally { setBusy(false); }
  }

  return <section className="mt-4 grid min-w-0 gap-3 rounded-xl border border-slate-700 p-4" aria-label="Dispositivos">
    <h3 className="font-semibold">Dispositivos</h3>
    <p className="text-xs text-slate-400">Revocar detiene el acceso cloud. Los datos guardados en ese dispositivo no se borran.</p>
    {devices.map((device) => <div className="grid gap-2 rounded-lg bg-slate-900 p-3 text-sm" key={device.device_id}>
      <p className="break-words font-medium">{device.device_name}{device.current ? " · Este dispositivo" : ""}</p>
      <p>{device.platform === "android" ? "Android" : device.platform === "ios" ? "iOS" : "Desktop"} · {device.status === "trusted" ? "Autorizado" : "Revocado"}</p>
      <p className="text-xs text-slate-400">Último acceso: {new Date(device.last_seen_at).toLocaleString()}</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary min-h-11" disabled={busy} onClick={() => { setAction({ device, rename: true }); setName(device.device_name); }}>Renombrar</button>
        {device.status === "trusted" ? <button className="btn-secondary min-h-11" disabled={busy} onClick={() => setAction({ device, rename: false })}>Revocar</button> : null}
      </div>
    </div>)}
    {error ? <p role="alert" className="text-sm text-rose-300">{error}</p> : null}
    <button className="btn-secondary min-h-11" disabled={busy} onClick={() => setRevision((value) => value + 1)}>Actualizar dispositivos</button>
    {action ? <MobileDialog title={action.rename ? "Renombrar dispositivo" : "Revocar dispositivo"} busy={busy} onClose={() => setAction(null)}>
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        {action.rename ? <label className="grid gap-2 text-sm">Nombre
          <input autoFocus className="min-h-12 rounded-xl border border-slate-700 bg-slate-900 px-3" value={name} maxLength={64} required disabled={busy} onChange={(event) => setName(event.target.value)} />
        </label> : <p>{action.device.current ? "Estás revocando este dispositivo. Se cerrará tu sesión y necesitarás verificar tu correo para volver a entrar." : "Este dispositivo perderá acceso cloud y necesitará verificar el correo para volver a entrar."}</p>}
        {error ? <p role="alert" className="text-sm text-rose-300">{error}</p> : null}
        <button className="btn min-h-12" disabled={busy}>{busy ? "Guardando…" : action.rename ? "Guardar nombre" : "Confirmar revocación"}</button>
      </form>
    </MobileDialog> : null}
  </section>;
}
