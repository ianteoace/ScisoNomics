import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { cloudRequest, getActiveOwnerId, OWNER_CHANGED_EVENT } from "./cloudAuth";
import { getSession } from "./supabaseCloudAuth";
import { loadEntitlements } from "./entitlements";
import { getRuntimePlatformSync } from "./platform";

export type PlayOffer = {productId:string;title:string;basePlanId:string;offerToken:string;formattedPrice:string;currency:string};
type Context = {packageName:string;productIds:string[];basePlanIds:string[];obfuscatedAccountId:string};
type Purchase = {purchaseToken:string;productIds:string[];state:"purchased"|"pending"|"unknown";packageName:string;obfuscatedAccountId?:string};
type Purchases = {status:"updated"|"canceled"|"owned"|"error";purchases:Purchase[]};
export type PlayStatus = {status:string;expiresAt:string|null;autoRenew:boolean;acknowledged:boolean};
const jobs = new Map<string,Promise<unknown>>();
export const isPlayPurchaseInProgress=(owner:string)=>jobs.has("purchase:"+owner);
function requireCurrent(owner:string){
  if(getRuntimePlatformSync()!=="android")throw new Error("Google Play solo está disponible en Android.");
  if(owner==="local"||getActiveOwnerId()!==owner)throw new Error("Iniciá sesión con la cuenta que tiene la compra.");
}
async function request<T>(owner:string,path:string,body?:object):Promise<T>{
  requireCurrent(owner);const session=await getSession(owner);
  if(!session||session.user.id!==owner)throw new Error("Autorizá este dispositivo para usar Google Play.");
  requireCurrent(owner);
  const result=await cloudRequest<T>("/billing/google-play/"+path,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${session.token}`},...(body?{body:JSON.stringify(body)}:{})},45000);
  requireCurrent(owner);return result;
}
async function native<T>(command:string,args:Record<string,unknown>={}):Promise<T>{
  try{return await invoke<T>("plugin:google-play-billing|"+command,args)}
  catch{throw new Error("Google Play no está disponible. Reintentá desde la instalación de la tienda.");}
}
export async function playCatalog(owner:string){
  const context=await request<Context>(owner,"context");
  const result=await native<{packageName:string;offers:PlayOffer[]}>("query_products",{productIds:context.productIds,basePlanIds:context.basePlanIds});
  requireCurrent(owner);
  if(result.packageName!==context.packageName)throw new Error("Esta instalación no coincide con la app de Google Play.");
  return {context,offers:result.offers.filter(o=>context.productIds.includes(o.productId)&&context.basePlanIds.includes(o.basePlanId))};
}
export const playSubscription=(owner:string)=>request<PlayStatus>(owner,"subscription");
function pause(ms:number,signal:AbortSignal){
  return new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);reject(new Error("La confirmación fue interrumpida."));};
    const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);
    signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
  });
}
export async function confirmPlayEntitlements(owner:string,retry=true,signal?:AbortSignal){
  requireCurrent(owner);const controller=new AbortController();
  const changed=()=>{if(getActiveOwnerId()!==owner)controller.abort();};
  const abort=()=>controller.abort();signal?.addEventListener("abort",abort,{once:true});
  if(signal?.aborted)controller.abort();
  if(typeof window!=="undefined")window.addEventListener(OWNER_CHANGED_EVENT,changed);
  try{
    for(const delay of retry?[0,1000,2000,4000]:[0]){
      if(delay)await pause(delay,controller.signal);
      requireCurrent(owner);if(controller.signal.aborted)throw new Error("La confirmación fue interrumpida.");
      // Reconcile only; validation and acknowledgement are never repeated.
      let entitlement;
      try{
        await request<PlayStatus>(owner,"refresh",{});
        entitlement=await loadEntitlements({force:true,ownerId:owner});
      }catch(error){
        requireCurrent(owner);if(!retry||controller.signal.aborted)throw error;
        continue;
      }
      requireCurrent(owner);
      if(controller.signal.aborted)throw new Error("La confirmación fue interrumpida.");
      if(entitlement.plan==="premium")return {confirming:false};
    }
    return {confirming:retry};
  }finally{
    signal?.removeEventListener("abort",abort);
    if(typeof window!=="undefined")window.removeEventListener(OWNER_CHANGED_EVENT,changed);
  }
}
const screenRefreshes=new Map<string,{at:number;job:Promise<unknown>}>();
export async function refreshPlayPremiumScreen(owner:string,signal?:AbortSignal){
  requireCurrent(owner);const previous=screenRefreshes.get(owner);
  if(previous&&Date.now()-previous.at<5000)return previous.job;
  const job=confirmPlayEntitlements(owner,false,signal).catch(error=>{screenRefreshes.delete(owner);throw error;});
  screenRefreshes.set(owner,{at:Date.now(),job});return job;
}
async function validate(owner:string,context:Context,purchases:Purchase[],signal?:AbortSignal){
  let pending=false, purchased=false;
  for(const purchase of purchases){
    requireCurrent(owner);
    const product=purchase.productIds.find(id=>context.productIds.includes(id));if(!product)continue;
    if(purchase.packageName!==context.packageName)throw new Error("La compra no corresponde a esta instalación.");
    // Only Google API + registered ownership can decide this: local account IDs
    // may be absent on out-of-app resubscriptions or predate a binding rotation.
    if(purchase.state==="pending"){pending=true;continue;} // Display only; never grant or acknowledge locally.
    if(purchase.state!=="purchased")continue;
    purchased=true;
    const key=owner+":"+purchase.purchaseToken;
    if(!jobs.has(key))jobs.set(key,request<PlayStatus>(owner,"validate",{purchaseToken:purchase.purchaseToken,productId:product,packageName:purchase.packageName}).finally(()=>jobs.delete(key)));
    await jobs.get(key);
  }
  requireCurrent(owner);
  const confirmation=await confirmPlayEntitlements(owner,purchased&&!pending,signal);
  return {pending,...confirmation,status:await playSubscription(owner)};
}
export async function buyPlayPremium(owner:string,offer:PlayOffer,context:Context,signal?:AbortSignal){
  requireCurrent(owner);const key="purchase:"+owner;
  if(jobs.has(key))return jobs.get(key) as Promise<Awaited<ReturnType<typeof purchase>>>;
  async function purchase(){
    const fresh=await request<Context>(owner,"context");
    if(context.obfuscatedAccountId!==fresh.obfuscatedAccountId||!fresh.productIds.includes(offer.productId)||!fresh.basePlanIds.includes(offer.basePlanId))throw new Error("La cuenta cambió. Actualizá los productos antes de comprar.");
    const result=await native<Purchases>("purchase",{productId:offer.productId,offerToken:offer.offerToken,obfuscatedAccountId:context.obfuscatedAccountId});
    requireCurrent(owner);
    if(result.status==="canceled")return {canceled:true};
    if(result.status==="error")throw new Error("No se pudo completar la compra. Reintentá sin realizar otra compra.");
    return result.status==="owned"?restorePlayPurchases(owner,signal):validate(owner,context,result.purchases,signal);
  }
  const promise=purchase().finally(()=>jobs.delete(key));jobs.set(key,promise);return promise;
}
export async function restorePlayPurchases(owner:string,signal?:AbortSignal){
  requireCurrent(owner);const key="restore:"+owner;
  if(jobs.has(key))return jobs.get(key) as Promise<Awaited<ReturnType<typeof validate>>>;
  const promise=(async()=>{
    const context=await request<Context>(owner,"context");
    const result=await native<Purchases>("query_purchases");
    return validate(owner,context,result.purchases,signal);
  })().finally(()=>jobs.delete(key));
  jobs.set(key,promise);return promise;
}
export async function managePlaySubscription(owner:string,productId:string){
  requireCurrent(owner);await native("manage_subscription",{productId});
}
export async function watchPlayPurchases(owner:string,onChange:()=>void){
  requireCurrent(owner);
  return addPluginListener<Purchases>("google-play-billing","purchases",event=>{
    if(getActiveOwnerId()!==owner||event.status!=="updated"||jobs.has("purchase:"+owner)||jobs.has("restore:"+owner))return;
    void request<Context>(owner,"context").then(context=>validate(owner,context,event.purchases)).then(onChange).catch(()=>{});
  });
}
