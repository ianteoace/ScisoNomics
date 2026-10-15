const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{test}=require('node:test'),ts=require('typescript');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {entitlementVerifier}=require('../services/signedEntitlements.ts'),{ENTITLEMENTS_PUBLIC_KEY_PEM}=require('../services/entitlementPublicKey.ts');
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),verify=entitlementVerifier(keys.publicKey.export({type:'spki',format:'pem'}));
function token(overrides={},header={alg:'RS256',typ:'JWT'}){
 const now=Math.floor(Date.now()/1000),claims={type:'scisonomics_entitlement',user_id:'internal-owner',plan:'premium',status:'active',features:{budgets:true,saving_goals:true,fixed_expenses:true,planning:true},subscription_expires_at:'2030-01-01T00:00:00Z',iat:now,exp:now+60,...overrides};
 const body=Buffer.from(JSON.stringify(header)).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');return body+'.'+crypto.sign('RSA-SHA256',Buffer.from(body),keys.privateKey).toString('base64url');
}
test('mobile RSA key is exactly the existing desktop verifier key',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../../backend/app/main.py'),'utf8');const desktop=source.match(/ENTITLEMENTS_PUBLIC_KEY_PEM = """([\s\S]*?)"""/)[1];
 assert.deepEqual(crypto.createPublicKey(ENTITLEMENTS_PUBLIC_KEY_PEM).export({type:'spki',format:'der'}),crypto.createPublicKey(desktop).export({type:'spki',format:'der'}));
});
test('valid backend license is bound to internal owner and has a finite cache deadline',async()=>{
 const result=await verify(token(),'internal-owner');assert.equal(result.entitlements.plan,'premium');assert(result.validUntil>Date.now());
});
test('edited flags, forged signature and another owner fail closed',async()=>{
 const value=token(),parts=value.split('.');parts[1]=Buffer.from('{}').toString('base64url');await assert.rejects(verify(parts.join('.'),'internal-owner'));
 await assert.rejects(verify(value,'another-owner'));await assert.rejects(verify(value,'local'));
});
test('expired, unlimited, future-issued and unsigned licenses are rejected',async()=>{
 const now=Math.floor(Date.now()/1000);
 for(const claims of [{exp:now-1},{exp:now+86401},{iat:now+120,exp:now+180}])await assert.rejects(verify(token(claims),'internal-owner'));
 await assert.rejects(verify(token({}, {alg:'none',typ:'JWT'}),'internal-owner'));
});
test('signed claims cannot contradict server plan/status rules',async()=>{
 await assert.rejects(verify(token({plan:'free'}),'internal-owner'));await assert.rejects(verify(token({status:'expired'}),'internal-owner'));
});
