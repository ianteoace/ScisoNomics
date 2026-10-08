const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),React=require('react'),{test}=require('node:test'),ts=require('typescript');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const root=path.resolve(__dirname,'..'),flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){
 const state={owner:'owner-a',platform:'android',restores:[],loads:[],watched:[],unregistered:0,fail:false,...options};
 const backup=new Map(),globals=new Map(['window','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const window=new EventTarget(),document=new EventTarget();document.visibilityState='visible';Object.assign(globalThis,{window,document});
 function stub(name,exports){const id=path.join(root,name);backup.set(id,require.cache[id]);require.cache[id]={id,filename:id,loaded:true,exports};}
 const entitlements={plan:'free',features:{budgets:false,saving_goals:false,fixed_expenses:false,planning:false}};
 stub('services/entitlements.ts',{ENTITLEMENTS_CHANGED_EVENT:'entitlements',entitlementValidUntil:()=>0,getCachedEntitlements:()=>entitlements,loadEntitlements:async options=>{state.loads.push(options.ownerId);return entitlements;}});
 stub('services/cloudAuth.ts',{ACCOUNT_SESSION_CHANGED_EVENT:'session',OWNER_CHANGED_EVENT:'owner',getActiveOwnerId:()=>state.owner});
 stub('services/platform.ts',{getRuntimePlatformSync:()=>state.platform});
 stub('services/googlePlayBilling.ts',{restorePlayPurchases:async owner=>{state.restores.push(owner);if(state.fail)throw new Error('not configured');},watchPlayPurchases:async owner=>{state.watched.push(owner);return {unregister:async()=>{state.unregistered++;}};}});
 let effect,cleanup; t.mock.method(React,'useEffect',callback=>{effect=callback});t.mock.method(React,'useState',initial=>[initial,()=>{}]);
 const id=path.join(root,'components/mobile/useMobilePremium.ts');delete require.cache[id];const {useMobilePremium}=require(id);useMobilePremium(state.owner,true);
 const dispose=()=>{cleanup?.();cleanup=null;};
 t.after(()=>{dispose();delete require.cache[id];for(const[id,value]of backup){if(value)require.cache[id]=value;else delete require.cache[id];}for(const[key,value]of globals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
 return {state,window,document,start:()=>{cleanup=effect()},dispose};
}
test('Android shell restores at startup, session restoration and foreground outside Premium settings',async t=>{
 const f=fixture(t);f.start();await flush();assert.deepEqual(f.state.watched,['owner-a']);assert.deepEqual(f.state.restores,['owner-a']);
 f.document.dispatchEvent(new Event('visibilitychange'));f.window.dispatchEvent(new Event('session'));await flush();
 assert.deepEqual(f.state.restores,['owner-a','owner-a','owner-a']);assert.deepEqual(f.state.loads,[]);
 f.dispose();await flush();assert.equal(f.state.unregistered,1);
 f.document.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(f.state.restores.length,3);
});
test('Android without Play configuration falls back to verified common entitlement without a loop',async t=>{
 const f=fixture(t,{fail:true});f.start();await flush();assert.deepEqual(f.state.loads,['owner-a']);
 f.window.dispatchEvent(new Event('entitlements'));await flush();assert.equal(f.state.restores.length,1);assert.equal(f.state.loads.length,1);
});
test('account switching prevents the old owner from restoring purchases on future events',async t=>{
 const f=fixture(t);f.start();await flush();f.state.owner='owner-b';
 f.document.dispatchEvent(new Event('visibilitychange'));f.window.dispatchEvent(new Event('session'));await flush();
 assert.deepEqual(f.state.restores,['owner-a']);assert.deepEqual(f.state.loads,[]);
});
test('local mode and desktop never initialize or query native Google Billing',async t=>{
 for(const options of [{owner:'local'},{platform:'desktop'}]){
  const f=fixture(t,options);f.start();await flush();assert.deepEqual(f.state.watched,[]);assert.deepEqual(f.state.restores,[]);f.dispose();
 }
});
