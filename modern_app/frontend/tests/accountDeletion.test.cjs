const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{test}=require('node:test'),ts=require('typescript');
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:filename}).outputText,filename);

function fixture(t){
 const backup=new Map(),state={owner:'owner-a',calls:[],forgot:[],removed:[],identities:[],entitlements:[],accounts:['owner-a','owner-b'],lost:false};
 class RequestError extends Error{constructor(message,options={}){super(message);Object.assign(this,options);}}
 const stub=(name,exports)=>{const p=path.join(root,name);backup.set(p,require.cache[p]);require.cache[p]={id:p,filename:p,loaded:true,exports};};
 const intent={requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',capability:'c'.repeat(43),expiresIn:300,resendAvailableIn:60};
 const challenge={challengeId:intent.requestId,nonce:'n'.repeat(43),issuedAt:10,expiresAt:120,familyId:'family',targetDeviceId:null,requestHash:'h'.repeat(43)};
 const finance=new DatabaseSync(':memory:');finance.exec('PRAGMA foreign_keys=ON;CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER)');
 for(const [index,file]of ['0001_mobile_finance.sql','0002_mobile_planning.sql','0003_mobile_scheduling.sql','0004_mobile_cloud_pull.sql','0005_mobile_cloud_push.sql'].entries()){finance.exec(fs.readFileSync(path.join(root,'src-tauri/migrations',file),'utf8'));finance.prepare('INSERT INTO _sqlx_migrations VALUES(?,1)').run(index+1);}
 for(const owner of ['local','owner-a','owner-b']){const category=finance.prepare("INSERT INTO categorias(nombre,tipo,owner_user_id,sync_id) VALUES('Fixture','gasto',?,?)").run(owner,'category-'+owner);finance.prepare("INSERT INTO movimientos(fecha,tipo,categoria_id,monto,owner_user_id,sync_id) VALUES('2026-10-07','gasto',?,1,?,?)").run(Number(category.lastInsertRowid),owner,'movement-'+owner);}
 const financeHash=()=>crypto.createHash('sha256').update(JSON.stringify(['categorias','movimientos'].map(table=>finance.prepare('SELECT * FROM '+table+' ORDER BY id').all()))).digest('hex');
 const localHash=financeHash();
 const driver=require.resolve('@tauri-apps/plugin-sql');backup.set(driver,require.cache[driver]);
 require.cache[driver]={id:driver,filename:driver,loaded:true,exports:{__esModule:true,default:{load:async()=>({select:async(sql,params=[])=>{const values=[];const text=sql.replace(/\$(\d+)/g,(_,n)=>{values.push(params[+n-1]);return '?';});return finance.prepare(text).all(...values);},execute:async(sql,params=[])=>{const values=[];const text=sql.replace(/\$(\d+)/g,(_,n)=>{values.push(params[+n-1]);return '?';});return {rowsAffected:Number(finance.prepare(text).run(...values).changes)};},close:async()=>{}})}}};
 t.after(()=>finance.close());
 stub('services/cloudAuth.ts',{CloudAuthRequestError:RequestError,getActiveOwnerId:()=>state.owner,switchToLocalMode:()=>{state.owner='local';},removeAccount:async owner=>{state.removed.push(owner);state.accounts=state.accounts.filter(id=>id!==owner);return{ok:!state.cleanupFailed};},cloudRequest:async(route,options)=>{
  state.calls.push({route,options});if(route.endsWith('/request'))return intent;if(route.endsWith('/challenge'))return challenge;
  if(state.lost){state.lost=false;throw new RequestError('Resultado no confirmado',{kind:'timeout'});}
  if(state.rejected)throw new RequestError('Código incorrecto',{kind:'auth',code:'deletion_otp_invalid'});
  return{status:'deleted',external_auth_status:'pending',billing_retained:true};
 }});
 stub('services/supabaseCloudAuth.ts',{getSession:async owner=>state.sessionMissing?null:{user:{id:owner},token:'synthetic-device-grant'},forgetSession:owner=>state.forgot.push(owner)});
 stub('services/deviceAuthorization.ts',{signAccountDeletion:async(owner,value)=>{state.signed={owner,value};if(state.switchDuringSign)state.owner='owner-b';return{formatVersion:1,deviceId:'device',publicKey:'public',publicKeyHash:'hash',signature:'synthetic-signature'};},deletedIdentityCleanup:owner=>async()=>{state.identities.push(owner);return true;}});
 stub('services/entitlements.ts',{forgetAccountEntitlements:owner=>state.entitlements.push(owner)});
 const p=path.join(root,'services/accountDeletion.ts');backup.set(p,require.cache[p]);delete require.cache[p];const api=require(p);
 t.after(()=>{for(const[p,value]of backup){if(value)require.cache[p]=value;else delete require.cache[p];}});
 return {...state,state,intent,challenge,api,localHash,financeHash,finance};
}

test('deletion uses the internal account and purpose-specific native proof, then returns to local without touching finance',async t=>{
 const s=fixture(t);assert.deepEqual(await s.api.requestAccountDeletion('owner-a'),s.intent);
 const result=await s.api.accountDeletionOperation('owner-a',s.intent).complete('123456','ELIMINAR');
 assert.equal(result.external_auth_status,'pending');assert.equal(result.cleanupComplete,true);assert.equal(s.state.owner,'local');
 assert.deepEqual(s.state.removed,['owner-a']);assert.deepEqual(s.state.accounts,['owner-b']);assert.deepEqual(s.state.identities,['owner-a']);assert.deepEqual(s.state.entitlements,['owner-a']);
 assert.equal(s.financeHash(),s.localHash);assert.equal(s.state.signed.owner,'owner-a');
 const body=JSON.parse(s.state.calls.find(c=>c.route.endsWith('/complete')).options.body);
 assert.equal(body.user_id,undefined);assert.equal(body.ownerId,undefined);assert.equal(body.code,'123456');assert.equal(body.confirmation,'ELIMINAR');
 assert.equal(body.proof.signature,'synthetic-signature');assert.deepEqual(s.state.calls.map(c=>c.route),['/account/delete/request','/account/delete/challenge','/account/delete/complete']);
});

test('lost completion response retains an exact memory-only request for an idempotent retry',async t=>{
 const s=fixture(t),operation=s.api.accountDeletionOperation('owner-a',s.intent);s.state.lost=true;
 await assert.rejects(operation.complete('123456','ELIMINAR'));
 assert.equal(s.state.owner,'owner-a');assert.equal(s.state.removed.length,0);
 await operation.complete('123456','ELIMINAR');
 const posts=s.state.calls.filter(c=>c.route.endsWith('/complete'));assert.equal(posts.length,2);assert.equal(posts[0].options.body,posts[1].options.body);
 assert.equal(s.state.calls.filter(c=>c.route.endsWith('/challenge')).length,1);
 assert.equal((await operation.complete('123456','ELIMINAR')).status,'deleted');assert.equal(s.state.calls.length,3);
});

test('explicit invalid OTP keeps the account and renews its proof before a corrected code',async t=>{
 const s=fixture(t),operation=s.api.accountDeletionOperation('owner-a',s.intent);s.state.rejected=true;
 await assert.rejects(operation.complete('000000','ELIMINAR'));assert.equal(s.state.owner,'owner-a');assert.equal(s.state.removed.length,0);
 s.state.rejected=false;await operation.complete('123456','ELIMINAR');assert.equal(s.state.calls.filter(c=>c.route.endsWith('/challenge')).length,2);
});

test('no session or ambiguous confirmation cannot submit a deletion',async t=>{
 const s=fixture(t);s.state.sessionMissing=true;await assert.rejects(s.api.requestAccountDeletion('owner-a'));
 await assert.rejects(s.api.accountDeletionOperation('owner-a',s.intent).complete('123456','si'));assert.equal(s.state.calls.length,0);
});

test('switching owner while signing never deletes either account',async t=>{
 const s=fixture(t);s.state.switchDuringSign=true;
 await assert.rejects(s.api.accountDeletionOperation('owner-a',s.intent).complete('123456','ELIMINAR'));
 assert.equal(s.state.calls.filter(c=>c.route.endsWith('/complete')).length,0);assert.deepEqual(s.state.accounts,['owner-a','owner-b']);
});

test('native cleanup failure cannot preserve the account as active or alter other owners',async t=>{
 const s=fixture(t);s.state.cleanupFailed=true;const result=await s.api.accountDeletionOperation('owner-a',s.intent).complete('123456','ELIMINAR');
 assert.equal(result.cleanupComplete,false);assert.equal(s.state.owner,'local');assert.deepEqual(s.state.accounts,['owner-b']);assert.equal(s.financeHash(),s.localHash);
});

test('late account close while another account is active removes only the deleted account',async t=>{
 const s=fixture(t);s.state.owner='owner-b';await s.api.forgetDeletedAccount('owner-a');
 assert.equal(s.state.owner,'owner-b');assert.deepEqual(s.state.accounts,['owner-b']);
});
