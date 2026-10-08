const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{test}=require('node:test'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
function fixture(t){
 const backups=new Map(),state={owner:'owner-a',calls:[],native:[],loads:[],fail:false,pause:null,status:'updated',purchaseState:'purchased'};
 const binding=owner=>owner==='owner-a'?'a'.repeat(64):'b'.repeat(64);
 const context=()=>({packageName:'com.scisoftware.scisonomics',productIds:['scisonomics_premium_monthly'],basePlanIds:['monthly'],obfuscatedAccountId:binding(state.owner)});
 const offer={productId:'scisonomics_premium_monthly',basePlanId:'monthly',offerToken:'offer',formattedPrice:'Precio de Play',currency:'ARS'};
 const purchase=()=>({purchaseToken:'purchase-sensitive-test-only',productIds:[offer.productId],packageName:context().packageName,obfuscatedAccountId:binding('owner-a'),state:state.purchaseState});
 function stub(name,exports){const id=name.startsWith('@')?require.resolve(name):path.join(root,name);backups.set(id,require.cache[id]);require.cache[id]={id,filename:id,loaded:true,exports};}
 stub('services/platform.ts',{getRuntimePlatformSync:()=>state.platform||'android'});
 stub('services/cloudAuth.ts',{getActiveOwnerId:()=>state.owner,cloudRequest:async(route,options)=>{
  state.calls.push({route,body:options.body});
  if(route.endsWith('/context'))return context();
  if(route.endsWith('/validate')&&state.fail)throw new Error('Backend rejected');
  if(route.endsWith('/validate')&&state.owner!=='owner-a')throw new Error('Esta compra pertenece a otra cuenta.');
  return {status:'active',expiresAt:'2030-01-01',acknowledged:true,autoRenew:true};
 }});
 stub('services/supabaseCloudAuth.ts',{getSession:async owner=>({user:{id:owner},token:'device-grant-test-only'})});
 stub('services/entitlements.ts',{loadEntitlements:async options=>{state.loads.push(options.ownerId);return {plan:'premium'};}});
 stub('@tauri-apps/api/core',{invoke:async(command,args)=>{
  state.native.push({command,args});
  if(command.endsWith('query_products'))return {packageName:context().packageName,offers:[offer]};
  if(command.endsWith('purchase')){if(state.pause)await state.pause;return {status:state.status,purchases:[purchase()]};}
  if(command.endsWith('query_purchases'))return {status:'updated',purchases:[purchase()]};
  return {opened:true};
 },addPluginListener:async(_,event,callback)=>{state.listener=callback;return {unregister:async()=>{state.listener=null}};}});
 const id=path.join(root,'services/googlePlayBilling.ts');delete require.cache[id];const service=require(id);
 t.after(()=>{delete require.cache[id];for(const [id,value]of backups){if(value)require.cache[id]=value;else delete require.cache[id];}});
 return {state,service,offer,context};
}
test('purchase is native but Premium is loaded only after backend validation',async t=>{
 const {state,service,offer,context}=fixture(t);await service.buyPlayPremium('owner-a',offer,context());
 assert.equal(state.calls.filter(c=>c.route.endsWith('/validate')).length,1);assert.deepEqual(state.loads,['owner-a']);
 const args=state.native.find(c=>c.command.endsWith('purchase')).args;assert(!JSON.stringify(args).includes('owner-a'));assert.equal(args.obfuscatedAccountId,'a'.repeat(64));
 assert(!state.calls.some(c=>c.route.includes('/billing/subscription')));
});
test('backend failure never enables Premium despite purchased callback',async t=>{
 const {state,service,offer,context}=fixture(t);state.fail=true;
 await assert.rejects(service.buyPlayPremium('owner-a',offer,context()));assert.equal(state.loads.length,0);
});
test('pending never validates or acknowledges as a paid purchase',async t=>{
 const {state,service,offer,context}=fixture(t);state.purchaseState='pending';
 assert.equal((await service.buyPlayPremium('owner-a',offer,context())).pending,true);
 assert(!state.calls.some(c=>c.route.endsWith('/validate')));assert(!state.native.some(c=>c.command.includes('acknowledge')));
});
test('user cancellation has no backend grant and duplicate launches coalesce',async t=>{
 const {state,service,offer,context}=fixture(t);state.status='canceled';
 const results=await Promise.all([service.buyPlayPremium('owner-a',offer,context()),service.buyPlayPremium('owner-a',offer,context())]);
 assert(results.every(r=>r.canceled));assert.equal(state.native.filter(c=>c.command.endsWith('purchase')).length,1);assert.equal(state.loads.length,0);
});
test('restore requeries Play then verifies with backend; foreign account never restores',async t=>{
 const {state,service}=fixture(t);await service.restorePlayPurchases('owner-a');assert(state.native.some(c=>c.command.endsWith('query_purchases')));
 state.owner='owner-b';state.loads=[];await assert.rejects(service.restorePlayPurchases('owner-b'),/otra cuenta/);assert.equal(state.loads.length,0);
});
test('simultaneous foreground restores and native updates coalesce for the current owner',async t=>{
 const {state,service}=fixture(t);const listener=await service.watchPlayPurchases('owner-a',()=>{});
 const first=service.restorePlayPurchases('owner-a'),second=service.restorePlayPurchases('owner-a');
 state.listener({status:'updated',purchases:[]});await Promise.all([first,second]);
 assert.equal(state.native.filter(c=>c.command.endsWith('query_purchases')).length,1);
 assert.equal(state.calls.filter(c=>c.route.endsWith('/refresh')).length,1);assert.deepEqual(state.loads,['owner-a']);
 await listener.unregister();
});
test('switching account while checkout is open ignores its stale completion',async t=>{
 const {state,service,offer,context}=fixture(t);let release;state.pause=new Promise(r=>release=r);
 const purchase=service.buyPlayPremium('owner-a',offer,context());await new Promise(r=>setImmediate(r));state.owner='owner-b';release();
 await assert.rejects(purchase);assert(!state.calls.some(c=>c.route.endsWith('/validate')));assert.equal(state.loads.length,0);
});
test('stale catalog binding cannot open checkout for another account',async t=>{
 const {state,service,offer,context}=fixture(t);const stale=context();state.owner='owner-b';
 await assert.rejects(service.buyPlayPremium('owner-b',offer,stale));assert.equal(state.native.length,0);
});
test('local, deleted and desktop contexts never invoke Play purchases',async t=>{
 const {state,service,offer,context}=fixture(t);state.owner='local';await assert.rejects(service.restorePlayPurchases('local'));
 state.owner='owner-a';state.platform='desktop';await assert.rejects(service.buyPlayPremium('owner-a',offer,context()));assert.equal(state.native.length,0);
});
test('management uses the native official Play screen; listener ignores another owner',async t=>{
 const {state,service}=fixture(t);await service.managePlaySubscription('owner-a','scisonomics_premium_monthly');
 assert.equal(state.native[0].command,'plugin:google-play-billing|manage_subscription');
 const listener=await service.watchPlayPurchases('owner-a',()=>{});state.owner='owner-b';state.listener({status:'updated',purchases:[]});
 await new Promise(r=>setImmediate(r));assert.equal(state.calls.length,0);await listener.unregister();
});
test('Android UI contains Play only, Windows checkout remains Mercado Pago',()=>{
 const mobile=fs.readFileSync(path.join(root,'components/mobile/billing/MobilePremium.tsx'),'utf8');assert(mobile.includes('Restaurar compras'));assert(mobile.includes('Administrar suscripción'));assert(!/mercadopago|Mercado Pago|checkout_url/.test(mobile));
 const windows=fs.readFileSync(path.join(root,'components/billing/PremiumCheckout.tsx'),'utf8');assert(windows.includes('Continuar con Mercado Pago'));
 const native=fs.readFileSync(path.join(root,'src-tauri/plugins/google-play-billing/android/src/main/java/com/scisoftware/billing/GooglePlayBillingPlugin.kt'),'utf8');
 assert(native.includes('play.google.com'));assert(native.includes('store/account/subscriptions'));assert(!native.includes('provider_subscription_id'));assert(!native.includes('acknowledgePurchase'));
});
