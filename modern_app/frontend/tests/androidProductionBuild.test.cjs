const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateEnvironment,validatePublishableKey,verifyOutput}=require('../../scripts/build-android-production.cjs');
test('production environment rejects staging/missing key without printing its value',()=>{
 const env={NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL:'https://scisonomics-production-d8a3.up.railway.app',NEXT_PUBLIC_SUPABASE_URL:'https://egwxtvroruvjwhpizbeg.supabase.co',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture_only'};
 assert.doesNotThrow(()=>validateEnvironment(env));assert.throws(()=>validateEnvironment({...env,NEXT_PUBLIC_SUPABASE_URL:'https://staging.example.test'}),/NEXT_PUBLIC_SUPABASE_URL/);assert.throws(()=>validateEnvironment({...env,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:''}),/missing/);
});
test('recursive exported assets require both production origins and zero staging origins',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sciso-build-qa-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'chunks'));const file=path.join(dir,'chunks','fixture.js');
 fs.writeFileSync(file,'https://scisonomics-production-d8a3.up.railway.app https://egwxtvroruvjwhpizbeg.supabase.co');assert.deepEqual(verifyOutput(dir),{stagingApi:0,stagingSupabase:0,productionApi:1,productionSupabase:1});
 fs.appendFileSync(file,' https://ktfrqbghsrfmfkzzapkh.supabase.co');assert.throws(()=>verifyOutput(dir),/isolation/);fs.writeFileSync(file,'nothing');assert.throws(()=>verifyOutput(dir),/isolation/);
});

const env = {NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL:'https://scisonomics-production-d8a3.up.railway.app',NEXT_PUBLIC_SUPABASE_URL:'https://egwxtvroruvjwhpizbeg.supabase.co',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture_only'};
test('Android production preflight uses only apikey, fixed settings URL, no redirects and a bounded timeout',async()=>{
 let cancelled=false;
 await validatePublishableKey(env,async(url,options)=>{
  assert.equal(url,env.NEXT_PUBLIC_SUPABASE_URL+'/auth/v1/settings');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  assert.deepEqual(Object.keys(options.headers),['apikey']);assert.equal(options.headers.apikey,env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  assert.ok(options.signal instanceof AbortSignal);
  return {status:200,body:{cancel:async()=>{cancelled=true;}},json(){throw new Error('Body must not be read');},text(){throw new Error('Body must not be read');}};
 });
 assert.equal(cancelled,true);
});
for(const status of [201,204,301,401,403,429,500])test(`production preflight fails closed for HTTP ${status} without provider details`,async()=>{
 await assert.rejects(validatePublishableKey(env,async()=>({status,body:{cancel:async()=>{}},json(){throw new Error('sensitive');}})),error=>{assert.match(error.message,/Production identity key validation failed/);assert(!error.message.includes(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY));return true;});
});
test('offline/network/timeout errors are generic and do not expose headers or key',async()=>{
 for(const name of ['TypeError','TimeoutError','AbortError'])await assert.rejects(validatePublishableKey(env,async()=>{const error=new Error(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);error.name=name;throw error;}),error=>{assert.match(error.message,/Android build is blocked/);assert(!error.message.includes(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY));return true;});
});
test('invalid project configuration is rejected before any request',async()=>{
 let requests=0;await assert.rejects(validatePublishableKey({...env,NEXT_PUBLIC_SUPABASE_URL:'https://staging.example.test'},async()=>{requests++;return {status:200};}));assert.equal(requests,0);
});
test('production preflight aborts a hung request and reports only a generic failure',async t=>{
 let timeoutMs;const timeout=AbortSignal.timeout;
 t.mock.method(AbortSignal,'timeout',ms=>{timeoutMs=ms;return timeout(20);});
 await assert.rejects(validatePublishableKey(env,async(_url,{signal})=>new Promise((_resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Timeout was not enforced')),250);
  signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('sensitive transport data'));},{once:true});
 })),/Production identity key validation failed/);
 assert.equal(timeoutMs,4000);
});
