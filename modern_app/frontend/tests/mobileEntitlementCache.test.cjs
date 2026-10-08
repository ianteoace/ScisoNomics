const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{test}=require('node:test'),ts=require('typescript');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const root=path.resolve(__dirname,'..'),{entitlementVerifier}=require('../services/signedEntitlements.ts');
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),verify=entitlementVerifier(keys.publicKey.export({type:'spki',format:'pem'}));
const signedKey='scisonomics_signed_entitlements_by_owner_v1',unsignedKey='scisonomics_entitlements_by_owner_v1';
function license(owner='owner-a'){
 const now=Math.floor(Date.now()/1000),claims={type:'scisonomics_entitlement',user_id:owner,plan:'premium',status:'active',features:{budgets:true,saving_goals:true,fixed_expenses:true,planning:true},subscription_expires_at:'2030-01-01T00:00:00Z',iat:now,exp:now+60};
 const body=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
 return body+'.'+crypto.sign('RSA-SHA256',Buffer.from(body),keys.privateKey).toString('base64url');
}
function fixture(t){
 const backup=new Map(),globals=new Map(['window','localStorage','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const env=process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL;process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL='https://cloud.example.test';
 const storage=new Map(),state={owner:'owner-a',online:false,requests:[],pause:null,token:license()};
 const localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
 Object.assign(globalThis,{localStorage,window:{localStorage,dispatchEvent:()=>{}},fetch:async url=>{state.requests.push(url);return {ok:true,json:async()=>({plan:'premium',entitlement_token:state.token})};}});
 function stub(name,exports){const id=path.join(root,name);backup.set(id,require.cache[id]);require.cache[id]={id,filename:id,loaded:true,exports};}
 stub('services/platform.ts',{getRuntimePlatformSync:()=> 'android'});
 stub('services/http.ts',{API_URL:'http://127.0.0.1:8000',getLocalRequestHeaders:()=>{throw new Error('Mobile must never use desktop API');}});
 stub('services/cloudAuth.ts',{getActiveOwnerId:()=>state.owner,getActiveAccount:()=>({user:{id:state.owner}}),getActiveCloudSessionAsync:async()=>state.online?{user:{id:state.owner},token:'session-memory-only'}:null});
 stub('services/signedEntitlements.ts',{verifyEntitlementToken:async(token,owner)=>{if(state.pause)await state.pause;return verify(token,owner);}});
 const id=path.join(root,'services/entitlements.ts');delete require.cache[id];const service=require(id);
 t.after(()=>{delete require.cache[id];for(const[id,value]of backup){if(value)require.cache[id]=value;else delete require.cache[id];}for(const[key,value]of globals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}if(env===undefined)delete process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL;else process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL=env;});
 return {service,state,storage};
}
test('mobile ignores unsigned Premium and keeps local mode Free without localhost requests',async t=>{
 const {service,state,storage}=fixture(t);storage.set(unsignedKey,JSON.stringify({'owner-a':{plan:'premium',features:{budgets:true}}}));
 assert.equal((await service.loadEntitlements()).plan,'free');state.owner='local';assert.equal((await service.loadEntitlements()).plan,'free');assert.deepEqual(state.requests,[]);
});
test('offline signed cache is verified, owner-specific and expires without extending access',async t=>{
 const {service,storage}=fixture(t);storage.set(signedKey,JSON.stringify({'owner-a':license()}));
 assert.equal((await service.loadEntitlements()).plan,'premium');assert.equal(service.getCachedEntitlements('owner-b').plan,'free');
 const clock=Date.now;t.after(()=>{Date.now=clock;});Date.now=()=>clock()+61000;assert.equal(service.getCachedEntitlements().plan,'free');
});
test('backend flags and forged licenses cannot create Premium or persist session/purchase tokens',async t=>{
 const {service,state,storage}=fixture(t);state.online=true;state.token='forged-license';
 assert.equal((await service.loadEntitlements({force:true})).plan,'free');assert.equal(storage.has(signedKey),false);
 state.token=license();assert.equal((await service.loadEntitlements({force:true})).plan,'premium');
 assert.equal(JSON.parse(storage.get(signedKey))['owner-a'],state.token);assert(!JSON.stringify([...storage]).includes('session-memory-only'));
 assert(state.requests.every(url=>url==='https://cloud.example.test/billing/entitlements'));
});
test('deletion during cache verification cannot restore forgotten account entitlement',async t=>{
 const {service,state,storage}=fixture(t);storage.set(signedKey,JSON.stringify({'owner-a':license(),'owner-b':license('owner-b')}));
 let release;state.pause=new Promise(resolve=>{release=resolve});const pending=service.loadEntitlements({force:true});
 service.forgetAccountEntitlements('owner-a');release();assert.equal((await pending).plan,'free');
 assert.equal(service.entitlementValidUntil('owner-a'),0);assert(!JSON.parse(storage.get(signedKey))['owner-a']);assert(JSON.parse(storage.get(signedKey))['owner-b']);
});
test('account switch during cache verification does not install the previous account license',async t=>{
 const {service,state,storage}=fixture(t);storage.set(signedKey,JSON.stringify({'owner-a':license()}));
 let release;state.pause=new Promise(resolve=>{release=resolve});const pending=service.loadEntitlements({force:true});state.owner='owner-b';release();
 assert.equal((await pending).plan,'free');assert.equal(service.getCachedEntitlements().plan,'free');assert.equal(service.entitlementValidUntil('owner-a'),0);
});
