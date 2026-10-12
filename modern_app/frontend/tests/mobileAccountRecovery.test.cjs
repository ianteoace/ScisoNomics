const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{test}=require('node:test'),{DatabaseSync}=require('node:sqlite'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:file}).outputText,file);
const source='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
function fixture(t,{empty=false}={}){
 const originalWindow=global.window,env={...process.env},cache=new Map();
 process.env.NEXT_PUBLIC_SCISONOMICS_MOBILE_ACCOUNT_RECOVERY='1';process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL='https://api.example.test';process.env.NEXT_PUBLIC_SUPABASE_URL='https://identity.example.test';
 global.window=new EventTarget();window.__TAURI_INTERNALS__={};window.navigator={userAgent:'Android'};
 const storage=()=>{const rows=new Map();return {getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,String(value)),removeItem:key=>rows.delete(key)};};
 window.localStorage=storage();window.sessionStorage=storage();
 const state={active:target,trusted:true,failAt:null,race:null,calls:[],db:new DatabaseSync(':memory:')};
 state.db.exec('PRAGMA foreign_keys=ON');for(const f of ['0001_mobile_finance.sql','0002_mobile_planning.sql','0003_mobile_scheduling.sql','0004_mobile_cloud_pull.sql','0005_mobile_cloud_push.sql'])state.db.exec(fs.readFileSync(path.join(root,'src-tauri/migrations',f),'utf8'));
 const bind=(sql,values)=>{const params=[];return {sql:sql.replace(/\$(\d+)/g,(_,n)=>{params.push(values[+n-1]);return '?';}),params};};
 const mock=(name,exports)=>{const id=name.startsWith('.')?path.resolve(root,name):require.resolve(name);cache.set(id,require.cache[id]);require.cache[id]={id,filename:id,loaded:true,exports};};
 const metadata=require('../services/mobileRecoveryState.ts');
 state.account={authProvider:'supabase',authEnvironment:metadata.currentCloudEnvironment(),storage:'session',user:{id:target,email:'qa@example.test'}};
 state.session={...state.account,token:'fixture-only-grant',expiresAt:'2099-01-01T00:00:00Z'};
 metadata.quarantineMobileAccounts({activeOwnerId:source,accounts:[{authProvider:'supabase',storage:'persistent',user:{id:source,email:' QA@Example.Test '}}]});
 mock('./services/data/mobileDatabase.ts',{getMobileDatabase:async()=>({select:async(sql,values=[])=>{const q=bind(sql,values);return state.db.prepare(q.sql).all(...q.params);}})});
 mock('./services/cloudAuth.ts',{getActiveOwnerId:()=>state.active,getStoredAccounts:()=>[state.account],CloudAuthRequestError:class extends Error{},cloudRequest:async()=>{state.calls.push('network');throw new Error('No test network permitted');}});
 mock('./services/supabaseCloudAuth.ts',{getSession:async()=>state.session});
 mock('./services/deviceAuthorization.ts',{hasCachedDeviceGrant:()=>state.trusted});
 mock('@tauri-apps/api/core',{invoke:async(command,{statements})=>{
  assert.equal(command,'mobile_sql_transaction');assert(statements.length<=16);
  const transaction=statements.some(s=>s.sql.startsWith('INSERT INTO mobile_account_recovery'));
  if(transaction&&state.race)state.race();
  state.db.exec('BEGIN IMMEDIATE');
  try{const results=statements.map((s,i)=>{if(transaction&&state.failAt===i)throw new Error('sensitive native detail must stay private');const q=bind(s.sql,s.values),n=Number(state.db.prepare(q.sql).run(...q.params).changes);if(s.expected_rows!==undefined&&n!==s.expected_rows)throw new Error('CAS');return n;});state.db.exec('COMMIT');return results;}
  catch(e){state.db.exec('ROLLBACK');throw e;}
 }});
 const id=path.resolve(root,'services/data/mobileAccountRecovery.ts');cache.set(id,require.cache[id]);delete require.cache[id];
 state.service=require(id);state.metadata=metadata;
 const seed=(owner=source)=>{
  const category=Number(state.db.prepare("INSERT INTO categorias(nombre,tipo,owner_user_id,sync_id,sync_status,last_synced_at,last_remote_updated_at,last_remote_device_id,last_remote_revision,sync_error_code,local_change_version,created_at,updated_at) VALUES('Gastos','gasto',?,'category-identity','synced','old','old','staging-device','old','old',7,'created-original','updated-original')").run(owner).lastInsertRowid);
  state.db.prepare("INSERT INTO movimientos(fecha,tipo,categoria_id,monto,owner_user_id,sync_id,descripcion,nota,sync_status,last_synced_at,last_remote_updated_at,last_remote_device_id,last_remote_revision,sync_error_code,local_change_version,created_at,updated_at) VALUES('2026-10-01','gasto',?,1250,?,'movement-identity','Descripción original','Nota conservada','synced','old','old','staging-device','old','old',4,'created-original','updated-original')").run(category,owner);
  return category;
 };
 state.seed=seed;if(!empty)seed();
 const snapshot=()=>JSON.stringify(['categorias','movimientos','mobile_pull_state'].map(table=>state.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()));state.snapshot=snapshot;
 t.after(()=>{state.db.close();global.window=originalWindow;for(const name of Object.keys(process.env))if(!(name in env))delete process.env[name];Object.assign(process.env,env);for(const[id,value]of cache){if(value)require.cache[id]=value;else delete require.cache[id];}});
 return state;
}
test('explicit recovery preserves rows, IDs, FKs, timestamps, sync identities and tombstones; resets only cloud metadata',async t=>{
 const s=fixture(t);s.db.exec("UPDATE movimientos SET deleted_at='2026-10-02T00:00:00Z'; INSERT INTO mobile_pull_state VALUES('"+source+"','old',1,'old'); INSERT INTO mobile_pull_state VALUES('"+target+"','prod-cursor',1,'old')");
 const before=s.db.prepare('SELECT * FROM movimientos').get(),category=s.db.prepare('SELECT * FROM categorias').get();
 const candidate=await s.service.findMobileRecovery(target);assert.deepEqual(candidate,{sourceOwner:source,targetOwner:target,categories:1,movements:1,blocked:false});
 assert.equal(s.metadata.isMobileRecoveryBlocked(),true);const result=await s.service.migrateMobileAccount(source,target);assert.equal(result.migrated,true);
 const after=s.db.prepare('SELECT * FROM movimientos').get(),newCategory=s.db.prepare('SELECT * FROM categorias').get();
 for(const key of ['id','sync_id','fecha','monto','descripcion','nota','deleted_at','created_at','updated_at','categoria_id'])assert.equal(after[key],before[key],key);
 for(const key of ['id','sync_id','nombre','tipo','created_at','updated_at'])assert.equal(newCategory[key],category[key],key);
 for(const row of [after,newCategory]){assert.equal(row.owner_user_id,target);assert.equal(row.sync_status,'pending');for(const key of ['last_synced_at','last_remote_updated_at','last_remote_device_id','last_remote_revision','sync_error_code'])assert.equal(row[key],null,key);}
 assert.equal(after.local_change_version,5);assert.equal(newCategory.local_change_version,8);assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length,0);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM movimientos WHERE owner_user_id=?').get(source).n,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM mobile_pull_state').get().n,0);
 assert.equal(s.metadata.isMobileRecoveryBlocked(),false);assert.equal(s.calls.length,0);
 const completed=s.snapshot();assert.equal((await s.service.migrateMobileAccount(source,target)).migrated,false);assert.equal(s.snapshot(),completed);
});
test('different emails, untrusted device, wrong owner and desktop all reject without changing rows',async t=>{
 const s=fixture(t),before=s.snapshot();s.session.user.email='other@example.test';await assert.rejects(s.service.migrateMobileAccount(source,target),{code:'email_mismatch'});
 s.session.user.email='qa@example.test';s.trusted=false;await assert.rejects(s.service.migrateMobileAccount(source,target),{code:'session_required'});s.trusted=true;s.active=source;await assert.rejects(s.service.migrateMobileAccount(source,target),{code:'invalid_target'});
 s.active=target;window.navigator.userAgent='Windows';await assert.rejects(s.service.migrateMobileAccount(source,target),{code:'unsupported_platform'});assert.equal(s.metadata.isMobileRecoveryBlocked(),false);assert.equal(s.snapshot(),before);
});
test('destination containing rows aborts; even a concurrent destination insert is checked inside the transaction',async t=>{
 const s=fixture(t);s.db.prepare("INSERT INTO categorias(nombre,tipo,owner_user_id,sync_id) VALUES('Destino','gasto',?,'target-identity')").run(target);
 let before=s.snapshot();assert.equal((await s.service.findMobileRecovery(target)).blocked,true);await assert.rejects(s.service.migrateMobileAccount(source,target),{code:'target_not_empty'});assert.equal(s.snapshot(),before);
 s.db.prepare('DELETE FROM categorias WHERE owner_user_id=?').run(target);s.race=()=>{s.db.prepare("INSERT INTO categorias(nombre,tipo,owner_user_id,sync_id) VALUES('Destino','gasto',?,'target-identity')").run(target);before=s.snapshot();};
 await assert.rejects(s.service.migrateMobileAccount(source,target),{code:'transaction_failed'});assert.equal(s.snapshot(),before);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM mobile_account_recovery').get().n,0);
});
test('empty source is a safe no-op and clears recovery without a prompt',async t=>{
 const s=fixture(t,{empty:true});assert.equal((await s.service.migrateMobileAccount(source,target)).migrated,false);assert.equal((await s.service.migrateMobileAccount(source,target)).migrated,false);assert.equal(s.metadata.isMobileRecoveryBlocked(),false);assert.equal(await s.service.findMobileRecovery(target),null);
});
test('failure after category owner UPDATE rolls back all rows and ledger, with sanitized error',async t=>{
 const s=fixture(t),before=s.snapshot();s.failAt=3;await assert.rejects(s.service.migrateMobileAccount(source,target),error=>{assert.equal(error.code,'transaction_failed');assert(!error.message.includes('sensitive'));return true;});assert.equal(s.snapshot(),before);assert.equal(s.metadata.isMobileRecoveryBlocked(),true);
});
test('extra planning relations and overflowing versions fail closed, never break references',async t=>{
 const s=fixture(t);s.db.prepare("INSERT INTO gastos_fijos(descripcion,monto,dia_vencimiento,categoria_id,owner_user_id,sync_id) VALUES('Original',10,1,1,?,'fixed-identity')").run(source);
 const before=s.snapshot();await assert.rejects(s.service.migrateMobileAccount(source,target),{code:'transaction_failed'});assert.equal(s.snapshot(),before);
 s.db.exec('DELETE FROM gastos_fijos; UPDATE categorias SET local_change_version=9007199254740991');const overflow=s.snapshot();await assert.rejects(s.service.migrateMobileAccount(source,target),{code:'transaction_failed'});assert.equal(s.snapshot(),overflow);
});
test('a crash after SQL commit heals the one-shot gate from the durable ledger',async t=>{
 const s=fixture(t);await s.service.migrateMobileAccount(source,target);const value=JSON.parse(window.localStorage.getItem('scisonomics_mobile_account_recovery_v1'));value.sources[0].status='pending';window.localStorage.setItem('scisonomics_mobile_account_recovery_v1',JSON.stringify(value));
 await s.service.evaluateRecoveryInventory();assert.equal(s.metadata.isMobileRecoveryBlocked(),false);assert.equal(await s.service.findMobileRecovery(target),null);assert.equal(s.db.prepare('SELECT count(*) n FROM movimientos').get().n,1);
});
test('pending gate prevents all mobile upload/pull before network; explicit separate choice reopens sync and retains source rows',async t=>{
 const s=fixture(t),before=s.snapshot();const pull=require('../services/data/mobileCloudPull.ts');
 await assert.rejects(pull.getMobileCloudSession(target),/Revisá primero/);assert.equal(s.calls.length,0);
 await s.service.keepMobileRecoverySeparate(source,target);assert.equal(s.snapshot(),before);assert.equal(s.metadata.isMobileRecoveryBlocked(),false);assert.equal((await pull.getMobileCloudSession(target)).user.id,target);
});
test('boot archives old metadata without deleting credentials or rows; new scoped accounts survive and failures block sync',t=>{
 const s=fixture(t);const archived=s.metadata.recoverySources();assert.equal(archived[0].email,'qa@example.test');assert.equal(archived[0].environment,null);
 const state=s.metadata.quarantineMobileAccounts({activeOwnerId:source,accounts:[{authProvider:'supabase',user:{id:source,email:'qa@example.test'}},s.account]});assert.equal(state.activeOwnerId,'local');assert.deepEqual(state.accounts,[s.account]);
 assert(!window.localStorage.getItem('scisonomics_mobile_account_recovery_v1').includes('token'));
 window.localStorage.setItem('scisonomics_mobile_account_recovery_v1','corrupt');assert.equal(s.metadata.isMobileRecoveryBlocked(),true);
});
test('fresh mobile installations have no prompt/gate and desktop preserves stored accounts',async t=>{
 const s=fixture(t,{empty:true});window.localStorage.removeItem('scisonomics_mobile_account_recovery_v1');assert.equal(s.metadata.isMobileRecoveryBlocked(),false);assert.equal(await s.service.findMobileRecovery(target),null);
 window.navigator.userAgent='Windows';const state={activeOwnerId:source,accounts:[{authProvider:'supabase',user:{id:source,email:'qa@example.test'}}]};assert.equal(s.metadata.quarantineMobileAccounts(state),state);
});
test('auth startup archives before hydration and an archive write failure cannot overwrite original account metadata',async t=>{
 const s=fixture(t),cloudId=path.resolve(root,'services/cloudAuth.ts'),mock=require.cache[cloudId];delete require.cache[cloudId];
 t.after(()=>{require.cache[cloudId]=mock;});
 const cloud=require(cloudId),raw=JSON.stringify({activeOwnerId:source,accounts:[s.metadata.recoverySources()[0].account]});
 window.localStorage.setItem('scisonomics_cloud_accounts_v1',raw);window.localStorage.removeItem('scisonomics_mobile_account_recovery_v1');
 const set=window.localStorage.setItem;window.localStorage.setItem=(key,value)=>{if(key==='scisonomics_mobile_account_recovery_v1')throw new Error('quota');set(key,value);};
 assert.equal(cloud.getStoredAuthState().accounts.length,0);assert.equal(s.metadata.isMobileRecoveryBlocked(),true);
 await assert.rejects(cloud.addOrUpdateAccount({user:s.account.user,tokens:{accessToken:'fixture-only-grant',expiresAt:'2099-01-01T00:00:00Z',tokenType:'bearer'}},{authProvider:'supabase',remember:false}),/No pudimos conservar/);
 assert.equal(window.localStorage.getItem('scisonomics_cloud_accounts_v1'),raw);
 window.localStorage.setItem=set;assert.equal(cloud.getStoredAuthState().accounts.length,0);assert.equal(s.metadata.recoverySources()[0].account.user.id,source);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(s.calls.length,0);
});
