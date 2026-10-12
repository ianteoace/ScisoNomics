const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateEnvironment,verifyOutput}=require('../../scripts/build-android-production.cjs');
test('production environment rejects staging/missing key without printing its value',()=>{
 const env={NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL:'https://scisonomics-production-d8a3.up.railway.app',NEXT_PUBLIC_SUPABASE_URL:'https://egwxtvroruvjwhpizbeg.supabase.co',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture_only'};
 assert.doesNotThrow(()=>validateEnvironment(env));assert.throws(()=>validateEnvironment({...env,NEXT_PUBLIC_SUPABASE_URL:'https://staging.example.test'}),/NEXT_PUBLIC_SUPABASE_URL/);assert.throws(()=>validateEnvironment({...env,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:''}),/missing/);
});
test('recursive exported assets require both production origins and zero staging origins',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sciso-build-qa-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'chunks'));const file=path.join(dir,'chunks','fixture.js');
 fs.writeFileSync(file,'https://scisonomics-production-d8a3.up.railway.app https://egwxtvroruvjwhpizbeg.supabase.co');assert.deepEqual(verifyOutput(dir),{stagingApi:0,stagingSupabase:0,productionApi:1,productionSupabase:1});
 fs.appendFileSync(file,' https://ktfrqbghsrfmfkzzapkh.supabase.co');assert.throws(()=>verifyOutput(dir),/isolation/);fs.writeFileSync(file,'nothing');assert.throws(()=>verifyOutput(dir),/isolation/);
});
