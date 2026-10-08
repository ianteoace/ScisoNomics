"use client";
import { useEffect, useState } from "react";
import { getActiveOwnerId } from "../../../services/cloudAuth";
import { buyPlayPremium, managePlaySubscription, playCatalog, playSubscription, restorePlayPurchases, type PlayStatus } from "../../../services/googlePlayBilling";
import { ENTITLEMENTS_CHANGED_EVENT } from "../../../services/entitlements";
import { useMobilePremium } from "../useMobilePremium";

export function MobilePremium() {
  const owner=getActiveOwnerId(),entitlements=useMobilePremium(owner);
  const [catalog,setCatalog]=useState<Awaited<ReturnType<typeof playCatalog>>|null>(null);
  const [catalogOwner,setCatalogOwner]=useState("");
  const [status,setStatus]=useState<PlayStatus|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  useEffect(()=>{
    let active=true;
    setCatalog(null);setCatalogOwner("");setStatus(null);setError("");setNotice("");
    if(owner==="local")return;
    const refresh=()=>{void playSubscription(owner).then(value=>{if(active&&getActiveOwnerId()===owner)setStatus(value);}).catch(()=>{});};
    void playCatalog(owner).then(value=>{if(active&&getActiveOwnerId()===owner){setCatalog(value);setCatalogOwner(owner);}}).catch(failure=>{if(active)setError(failure.message);});
    refresh();
    window.addEventListener(ENTITLEMENTS_CHANGED_EVENT,refresh);
    return()=>{active=false;window.removeEventListener(ENTITLEMENTS_CHANGED_EVENT,refresh);};
  },[owner]);
  const currentCatalog=catalogOwner===owner?catalog:null;
  async function run(kind:"buy"|"restore"){
    if(busy||owner==="local")return;setBusy(true);setError("");setNotice("");
    try{
      const result=kind==="restore"?await restorePlayPurchases(owner):currentCatalog?.offers[0]?await buyPlayPremium(owner,currentCatalog.offers[0],currentCatalog.context):null;
      if(getActiveOwnerId()!==owner)return;
      if(result&&"canceled" in result)setNotice("Compra cancelada.");
      else {if(result&&"pending" in result&&result.pending)setNotice("Compra pendiente. Premium se activará cuando el pago sea confirmado y verificado.");else setNotice("Verificación completada. El plan mostrado depende de tu cuenta.");setStatus(await playSubscription(owner));}
    }catch(failure){if(getActiveOwnerId()===owner)setError(failure instanceof Error?failure.message:"No se pudo verificar la compra.");}
    finally{setBusy(false);}
  }
  const expires=status?.expiresAt?new Date(status.expiresAt).toLocaleDateString("es-AR"):null;
  return <div className="grid gap-3" aria-label="Premium con Google Play">
    <p className="font-semibold">{entitlements.plan==="premium"?"Premium activo.":"Plan Free"}</p>
    {owner==="local"?<p>Iniciá sesión y autorizá este dispositivo para comprar o restaurar Premium.</p>:<>
      {currentCatalog?.offers[0]?<p>{currentCatalog.offers[0].formattedPrice} por mes · Google Play</p>:<p>Precio no disponible hasta consultar Google Play.</p>}
      {status?.status==="canceled"?<p>{expires?`Tu suscripción de Google Play está cancelada. Su período verificado llega hasta ${expires}.`:"Suscripción cancelada."}</p>:null}
      {status?.status==="grace"?<p>Google Play está intentando recuperar el pago. Revisá tu método de pago.</p>:null}
      {status?.status==="hold"?<p>El pago está suspendido. Revisá tu suscripción en Google Play.</p>:null}
      {status?.status==="paused"?<p>Suscripción pausada.</p>:null}
      {status?.status==="expired"||status?.status==="revoked"?<p>La suscripción ya no concede acceso.</p>:null}
      {status?.status==="pending"?<p>Pago pendiente. Todavía no concede Premium.</p>:null}
      {expires?<p>Vigencia verificada: {expires}</p>:null}
      {entitlements.plan==="premium"&&entitlements.expires_at?<p>Premium de tu cuenta hasta {new Date(entitlements.expires_at).toLocaleDateString("es-AR")}.</p>:null}
      <button className="btn min-h-12" disabled={busy||!currentCatalog?.offers.length||["active","grace","pending"].includes(status?.status||"")} onClick={()=>void run("buy")}>Suscribirme con Google Play</button>
      <button className="btn-secondary min-h-12" disabled={busy} onClick={()=>void run("restore")}>Restaurar compras</button>
      <button className="btn-secondary min-h-12" disabled={busy||!currentCatalog?.context.productIds[0]} onClick={()=>{
        if(currentCatalog)void managePlaySubscription(owner,currentCatalog.context.productIds[0]).catch(failure=>setError(failure.message));
      }}>Administrar suscripción</button>
      <p>La suscripción se administra y cancela desde Google Play. Las compras pertenecen a la cuenta ScisoNomics con la que las hiciste.</p>
    </>}
    {notice?<p role="status">{notice}</p>:null}{error?<p role="alert" className="text-red-300">{error}</p>:null}
  </div>;
}
