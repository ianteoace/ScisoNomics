"use client";
import { useEffect, useState } from "react";
import { MobileDialog } from "../MobileDialog";
import { useMobileAccount } from "./MobileAccountProvider";
import { isMobileRecoveryBlocked, mobileRecoveryEnabled, MOBILE_RECOVERY_CHANGED } from "../../../services/mobileRecoveryState";
import { MobileRecoveryError, evaluateRecoveryInventory, findMobileRecovery, keepMobileRecoverySeparate, migrateMobileAccount, type RecoveryCandidate } from "../../../services/data/mobileAccountRecovery";

export const OPEN_MOBILE_RECOVERY_EVENT = "scisonomics:open-mobile-recovery";

export function MobileAccountRecovery() {
  const { session, checking } = useMobileAccount();
  const [revision, setRevision] = useState(0), [candidate, setCandidate] = useState<RecoveryCandidate | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const owner = session?.user.id;
  useEffect(() => {
    if (!mobileRecoveryEnabled()) return;
    const changed = () => setRevision(value => value + 1);
    window.addEventListener(MOBILE_RECOVERY_CHANGED, changed);
    window.addEventListener(OPEN_MOBILE_RECOVERY_EVENT, changed);
    return () => { window.removeEventListener(MOBILE_RECOVERY_CHANGED, changed); window.removeEventListener(OPEN_MOBILE_RECOVERY_EVENT, changed); };
  }, []);
  useEffect(() => {
    if (!mobileRecoveryEnabled() || checking) return;
    let active = true; setCandidate(null); setError("");
    void (async () => {
      await evaluateRecoveryInventory();
      if (!owner) return;
      const result = await findMobileRecovery(owner);
      if (active) setCandidate(result);
    })().catch(() => { if (active) setError("No pudimos revisar los datos anteriores. Se conservan en este dispositivo y la sincronización queda pausada hasta revisarlos."); });
    return () => { active = false; };
  }, [owner, checking, revision]);
  async function decide(migrate: boolean) {
    if (!candidate || busy) return;
    setBusy(true); setError("");
    try {
      if (migrate) {
        const result = await migrateMobileAccount(candidate.sourceOwner, candidate.targetOwner);
        setNotice(result.migrated ? "Tus datos ya están en tu cuenta actual. Revisalos en Inicio o Movimientos. Después podés sincronizarlos manualmente desde Configuración → Sincronización." : "La recuperación ya fue completada; no se duplicaron datos.");
      } else { await keepMobileRecoverySeparate(candidate.sourceOwner,candidate.targetOwner); }
      setCandidate(null);
    } catch (failure) { setError(failure instanceof MobileRecoveryError ? failure.message : "No se pudo finalizar la revisión. Tus datos se conservan; reintentá sin borrar el almacenamiento de la app."); }
    finally { setBusy(false); }
  }
  if (!mobileRecoveryEnabled()) return null;
  return <>
    {candidate ? <MobileDialog title="Conservar tus datos anteriores" busy={busy} onClose={() => setCandidate(null)}>
      <div className="grid gap-3 text-sm">
        <p>Encontramos datos guardados en este dispositivo de una sesión anterior con este mismo correo. ¿Querés conservarlos en tu cuenta actual?</p>
        <p>{candidate.categories} categorías · {candidate.movements} movimientos (incluye registros eliminados conservados para sincronización).</p>
        {candidate.blocked ? <p role="alert">La cuenta actual ya tiene datos locales. Se requiere revisión manual; no podemos fusionarlos automáticamente.</p> : <button className="btn min-h-11" disabled={busy} onClick={() => void decide(true)}>{busy ? "Recuperando…" : "Conservar en mi cuenta actual"}</button>}
        <button className="btn-secondary min-h-11" disabled={busy} onClick={() => void decide(false)}>Mantener por separado, sin transferir</button>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </MobileDialog> : null}
    {notice ? <MobileDialog title="Datos recuperados" onClose={() => setNotice("")}><p className="text-sm">{notice}</p><button className="btn mt-4 min-h-11" onClick={() => setNotice("")}>Revisar mis datos</button></MobileDialog> : null}
    {!candidate && !notice && error ? <div data-mobile-ui="" role="alert" className="m-3 rounded-xl border border-amber-400/40 p-3 text-sm"><p>{error}</p><button className="btn-secondary mt-2" onClick={() => setRevision(value => value + 1)}>Revisar nuevamente</button></div> : null}
    {!candidate && !notice && !error && isMobileRecoveryBlocked() ? <div data-mobile-ui="" className="m-3 rounded-xl border border-amber-400/40 p-3 text-sm"><p>La sincronización está pausada por datos de una sesión anterior. Iniciá sesión con el mismo correo para revisarlos.</p><button className="btn-secondary mt-2" onClick={() => setRevision(value => value + 1)}>Revisar datos anteriores</button></div> : null}
  </>;
}
