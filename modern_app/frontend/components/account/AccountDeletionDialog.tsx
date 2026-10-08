"use client";

import { useEffect, useRef, useState } from "react";
import { ACCOUNT_SESSION_CHANGED_EVENT, OWNER_CHANGED_EVENT, getActiveOwnerId } from "../../services/cloudAuth";
import { accountDeletionOperation, requestAccountDeletion, type DeletionIntent, type DeletionResult } from "../../services/accountDeletion";
import { MobileDialog } from "../mobile/MobileDialog";

export function AccountDeletionDialog({ownerId}: {ownerId: string}) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [intent,setIntent]=useState<DeletionIntent|null>(null),[code,setCode]=useState(""),[text,setText]=useState("");
  const [resendAt,setResendAt]=useState(0),[tick,setTick]=useState(0);
  const operation=useRef<ReturnType<typeof accountDeletionOperation>|null>(null), mounted=useRef(false),pending=useRef(false);
  useEffect(()=>{
    mounted.current=true;
    const events=window;
    const invalidate=()=>{if(getActiveOwnerId()!==ownerId){setOpen(false);setIntent(null);setCode("");setText("");operation.current=null;}};
    events.addEventListener(OWNER_CHANGED_EVENT,invalidate);events.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT,invalidate);
    return()=>{mounted.current=false;operation.current=null;events.removeEventListener(OWNER_CHANGED_EVENT,invalidate);events.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT,invalidate);};
  },[ownerId]);
  useEffect(()=>{if(!open||!intent)return;const timer=setInterval(()=>setTick(value=>value+1),1000);return()=>clearInterval(timer);},[open,intent]);
  void tick;
  const cooldown=Math.max(0,Math.ceil((resendAt-Date.now())/1000));
  async function start(){
    if(pending.current||cooldown)return;pending.current=true;setBusy(true);setError("");
    try{const next=await requestAccountDeletion(ownerId);if(!mounted.current||getActiveOwnerId()!==ownerId)return;
      setIntent(next);setCode("");operation.current=accountDeletionOperation(ownerId,next);setResendAt(Date.now()+next.resendAvailableIn*1000);
    }catch(failure){if(mounted.current)setError(failure instanceof Error?failure.message:"No pudimos enviar la confirmación.");}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  }
  async function finish(){
    if(pending.current||!operation.current)return;pending.current=true;setBusy(true);setError("");
    try{
      const result=await operation.current.complete(code,text);
      const message=deletionMessage(result);
      // The owner-keyed UI may already have unmounted after cleanup; native
      // feedback remains visible and never contains account IDs or secrets.
      try{const dialog=await import("@tauri-apps/plugin-dialog");await dialog.message(message,{title:"Cuenta eliminada",kind:"info"});}catch{/* Local mode is already active. */}
      if(mounted.current){setOpen(false);setCode("");setText("");setIntent(null);}
    }catch(failure){if(mounted.current)setError(failure instanceof Error?failure.message:"No pudimos confirmar el resultado. Reintentá la misma solicitud.");}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  }
  function close(){if(busy)return;setOpen(false);setCode("");setText("");setIntent(null);operation.current=null;setError("");}
  return <>
    <button className="btn-secondary min-h-12 text-red-300" type="button" onClick={()=>{setOpen(true);setError("");}}>Eliminar mi cuenta</button>
    {open?<MobileDialog title="Eliminar mi cuenta cloud" busy={busy} onClose={close}>
      <div className="grid gap-4">
        <p>Se eliminarán tu cuenta ScisoNomics y tus datos sincronizados. La acción es irreversible respecto a cloud.</p>
        <p>Los datos locales, backups y exportaciones de tus dispositivos no se eliminan automáticamente. Los datos guardados de la cuenta permanecerán separados y dejarán de mostrarse como cuenta activa.</p>
        <p>Eliminar la cuenta no cancela suscripciones en Google Play ni Mercado Pago. Administralas en el proveedor donde las contrataste antes de continuar.</p>
        <p className="text-sm text-slate-400">Los registros comerciales y de seguridad necesarios se conservan separados de la cuenta activa. La eliminación del acceso externo puede quedar pendiente de completar.</p>
        {error?<p role="alert" className="text-red-300">{error}</p>:null}
        {!intent?<button className="btn min-h-12" disabled={busy} onClick={()=>void start()}>{busy?"Enviando…":"Continuar y enviar código"}</button>:<>
          <p>Ingresá el código enviado al correo de tu cuenta y escribí ELIMINAR. La app también verificará la firma de este dispositivo.</p>
          <label className="grid gap-2">Código de eliminación<input className="input min-h-12" autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} disabled={busy} onChange={e=>setCode(e.target.value.replace(/[^0-9]/g,""))}/></label>
          <label className="grid gap-2">Escribí ELIMINAR<input className="input min-h-12" autoComplete="off" value={text} disabled={busy} onChange={e=>setText(e.target.value)}/></label>
          <button className="btn min-h-12" disabled={busy||text!=="ELIMINAR"||code.length!==6} onClick={()=>void finish()}>{busy?"Confirmando…":"Eliminar cuenta y datos cloud"}</button>
          <button className="btn-secondary min-h-12" disabled={busy||cooldown>0} onClick={()=>void start()}>{cooldown?`Reenviar en ${cooldown}s`:"Reenviar código"}</button>
        </>}
        <button className="btn-secondary min-h-12" disabled={busy} onClick={close}>Conservar mi cuenta</button>
      </div>
    </MobileDialog>:null}
  </>;
}

export function deletionMessage(result: DeletionResult){
  return "Tu cuenta ScisoNomics y sus datos cloud fueron eliminados. Estás en modo local. Tus copias locales se conservan."
    +(result.external_auth_status==="pending"?" La eliminación del acceso externo todavía está pendiente; contactá a soporte si necesitás asistencia.":"")
    +(result.cleanupComplete===false?" No pudimos completar el borrado de la sesión guardada en este dispositivo. Reintentá su limpieza; el acceso cloud ya quedó bloqueado.":"");
}
