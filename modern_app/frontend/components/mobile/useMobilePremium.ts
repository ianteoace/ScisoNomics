"use client";
import { useEffect, useState } from "react";
import { ENTITLEMENTS_CHANGED_EVENT, entitlementValidUntil, getCachedEntitlements, loadEntitlements, type BillingEntitlements } from "../../services/entitlements";
import { ACCOUNT_SESSION_CHANGED_EVENT, getActiveOwnerId, OWNER_CHANGED_EVENT } from "../../services/cloudAuth";
import { restorePlayPurchases, watchPlayPurchases } from "../../services/googlePlayBilling";
import { getRuntimePlatformSync } from "../../services/platform";

export function useMobilePremium(ownerId: string, reconcilePlay = false) {
  const [state,setState]=useState<{owner:string;entitlements:BillingEntitlements}>({owner:ownerId,entitlements:getCachedEntitlements(ownerId)});
  useEffect(()=>{
    let active=true;
    let expiryTimer:ReturnType<typeof setTimeout>|undefined;
    let listener:{unregister:()=>Promise<void>}|undefined;
    const current=()=>active&&getActiveOwnerId()===ownerId;
    const schedule=()=>{clearTimeout(expiryTimer);const until=entitlementValidUntil(ownerId);if(until>Date.now())expiryTimer=setTimeout(reload,until-Date.now()+10);};
    const update=()=>{if(current()){setState({owner:ownerId,entitlements:getCachedEntitlements(ownerId)});schedule();}};
    const reload=()=>{if(!current())return;update();void loadEntitlements({force:true,ownerId}).then(entitlements=>{if(current()){setState({owner:ownerId,entitlements});schedule();}}).catch(update);};
    const play=reconcilePlay&&ownerId!=="local"&&getRuntimePlatformSync()==="android";
    const refresh=()=>{if(!current())return;if(play)void restorePlayPurchases(ownerId).then(update).catch(reload);else reload();};
    if(play)void watchPlayPurchases(ownerId,update).then(value=>{if(active)listener=value;else void value.unregister().catch(()=>{});}).catch(()=>{});
    update();refresh();
    const foreground=()=>{if(document.visibilityState==="visible")refresh();};
    window.addEventListener(ENTITLEMENTS_CHANGED_EVENT,update);
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT,refresh);window.addEventListener(OWNER_CHANGED_EVENT,update);
    document.addEventListener("visibilitychange",foreground);
    // schedule() follows the verified JWT expiry, not just the paid period.
    return()=>{active=false;clearTimeout(expiryTimer);void listener?.unregister().catch(()=>{});window.removeEventListener(ENTITLEMENTS_CHANGED_EVENT,update);
      window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT,refresh);window.removeEventListener(OWNER_CHANGED_EVENT,update);document.removeEventListener("visibilitychange",foreground);};
  },[ownerId,reconcilePlay]);
  return state.owner===ownerId?state.entitlements:getCachedEntitlements(ownerId);
}
