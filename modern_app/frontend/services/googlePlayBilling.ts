import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { cloudRequest, getActiveOwnerId } from "./cloudAuth";
import { getSession } from "./supabaseCloudAuth";
import { loadEntitlements } from "./entitlements";
import { getRuntimePlatformSync } from "./platform";

export type PlayOffer = {productId:string;title:string;basePlanId:string;offerToken:string;formattedPrice:string;currency:string};
type Context = {packageName:string;productIds:string[];basePlanIds:string[];obfuscatedAccountId:string};
type Purchase = {purchaseToken:string;productIds:string[];state:"purchased"|"pending"|"unknown";packageName:string;obfuscatedAccountId?:string};
type Purchases = {status:"updated"|"canceled"|"owned"|"error";purchases:Purchase[]};
export type PlayStatus = {status:string;expiresAt:string|null;autoRenew:boolean;acknowledged:boolean};
const jobs = new Map<string,Promise<unknown>>();
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
async function validate(owner:string,context:Context,purchases:Purchase[]){
  let pending=false;
  for(const purchase of purchases){
    requireCurrent(owner);
    const product=purchase.productIds.find(id=>context.productIds.includes(id));if(!product)continue;
    if(purchase.packageName!==context.packageName)throw new Error("La compra no corresponde a esta instalación.");
    // Only Google API + registered ownership can decide this: local account IDs
    // may be absent on out-of-app resubscriptions or predate a binding rotation.
    if(purchase.state==="pending"){pending=true;continue;} // Display only; never grant or acknowledge locally.
    if(purchase.state!=="purchased")continue;
    const key=owner+":"+purchase.purchaseToken;
    if(!jobs.has(key))jobs.set(key,request<PlayStatus>(owner,"validate",{purchaseToken:purchase.purchaseToken,productId:product,packageName:purchase.packageName}).finally(()=>jobs.delete(key)));
    await jobs.get(key);
  }
  requireCurrent(owner);
  await request<PlayStatus>(owner,"refresh",{});
  await loadEntitlements({force:true,ownerId:owner});requireCurrent(owner);
  return {pending,status:await playSubscription(owner)};
}
export async function buyPlayPremium(owner:string,offer:PlayOffer,context:Context){
  requireCurrent(owner);const key="purchase:"+owner;
  if(jobs.has(key))return jobs.get(key) as Promise<Awaited<ReturnType<typeof purchase>>>;
  async function purchase(){
    const fresh=await request<Context>(owner,"context");
    if(context.obfuscatedAccountId!==fresh.obfuscatedAccountId||!fresh.productIds.includes(offer.productId)||!fresh.basePlanIds.includes(offer.basePlanId))throw new Error("La cuenta cambió. Actualizá los productos antes de comprar.");
    const result=await native<Purchases>("purchase",{productId:offer.productId,offerToken:offer.offerToken,obfuscatedAccountId:context.obfuscatedAccountId});
    requireCurrent(owner);
    if(result.status==="canceled")return {canceled:true};
    if(result.status==="error")throw new Error("No se pudo completar la compra. Reintentá sin realizar otra compra.");
    return result.status==="owned"?restorePlayPurchases(owner):validate(owner,context,result.purchases);
  }
  const promise=purchase().finally(()=>jobs.delete(key));jobs.set(key,promise);return promise;
}
export async function restorePlayPurchases(owner:string){
  requireCurrent(owner);const key="restore:"+owner;
  if(jobs.has(key))return jobs.get(key) as Promise<Awaited<ReturnType<typeof validate>>>;
  const promise=(async()=>{
    const context=await request<Context>(owner,"context");
    const result=await native<Purchases>("query_purchases");
    return validate(owner,context,result.purchases);
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
