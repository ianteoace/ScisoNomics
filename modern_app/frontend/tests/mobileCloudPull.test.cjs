const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {
  compilerOptions: { module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true },fileName:filename,
}).outputText, filename);
const revision = '2026-10-05T12:00:00.123456Z';
const later = '2026-10-05T12:01:00.654321Z';
const meta = { created_at:'2026-10-05 10:00:00', updated_at:revision, deleted_at:null, remote_updated_at:revision,last_modified_device_id:'desktop-a',sync_status:'pending' };
const category = { ...meta,sync_id:'category-sync',nombre:'Cloud gastos',tipo:'gasto',color:'#fff',icono:'test' };
const movement = { ...meta,sync_id:'movement-sync',fecha:'2026-10-05',tipo:'gasto',monto:1234,descripcion:'prueba m8',categoria_sync_id:category.sync_id,categoria_id:9999 };
function payload(categories=[category],movements=[movement],cursor=revision) {
  return {ok:true,cursor,incremental:false,categorias:categories,movimientos:movements,tags:[],movimiento_tags:[],metas_ahorro:[],gastos_programados:[],gastos_fijos:[],presupuestos:[]};
}
function fixture(t, filename=':memory:') {
  const state={ calls:[],failAt:null,active:'owner-a',session:{authProvider:'supabase',user:{id:'owner-a'},token:'not-for-storage'},responses:[payload()],db:null };
  const backups = new Map(), previousWindow=global.window;
  global.window={__TAURI_INTERNALS__:{},navigator:{userAgent:'Android'}};
  const mock=(name,exports)=>{const p=name.startsWith('.')?path.resolve(root,name):require.resolve(name);backups.set(p,require.cache[p]);require.cache[p]={id:p,filename:p,loaded:true,exports};};
  const bind=(sql,params)=>{const values=[];const converted=sql.replace(/\$(\d+)/g,(_,n)=>{values.push(params[+n-1]);return '?';});return {sql:converted,values};};
  const open=()=>{
    const db=new DatabaseSync(filename);
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER);');
    ['0001_mobile_finance.sql','0002_mobile_planning.sql','0003_mobile_scheduling.sql','0004_mobile_cloud_pull.sql','0005_mobile_cloud_push.sql'].forEach((file,i)=>{
      if(!db.prepare('SELECT 1 FROM _sqlx_migrations WHERE version=?').get(i+1)) {db.exec(fs.readFileSync(path.join(root,'src-tauri/migrations',file),'utf8'));db.prepare('INSERT INTO _sqlx_migrations VALUES(?,1)').run(i+1);}
    }); state.db=db;
    return {select:async(sql,params=[])=>{const b=bind(sql,params);return db.prepare(b.sql).all(...b.values);},close:async()=>db.close()};
  };
  mock('@tauri-apps/plugin-sql',{__esModule:true,default:{load:async()=>open()}});
  mock('@tauri-apps/api/core',{invoke:async(command,{statements})=>{
    assert.equal(command,'mobile_sql_transaction');assert.ok(statements.length<=16);
    const db=state.db;db.exec('BEGIN IMMEDIATE');
    try {const changed=statements.map(({sql,values,expected_rows},i)=>{
      if(state.failAt===i)throw new Error('private-native-path-secret');
      const bound=bind(sql,values), result=Number(db.prepare(bound.sql).run(...bound.values).changes);
      if(expected_rows!==undefined && expected_rows!==result)throw new Error('compare-and-set');return result;
    });db.exec('COMMIT');return changed;} catch(error){db.exec('ROLLBACK');throw error;}
  }});
  class CloudAuthRequestError extends Error { constructor(message,kind){super(message);this.kind=kind;} }
  mock('./services/cloudAuth.ts',{CloudAuthRequestError,getActiveOwnerId:()=>state.active,cloudRequest:async(route,options)=>{
    state.calls.push({route,options});assert.ok(route.startsWith('/sync/pull'));assert.equal(options.headers.Authorization,'Bearer not-for-storage');
    if(state.failNetwork)throw new CloudAuthRequestError('sensitive body',state.failNetwork);
    if(state.beforeResponse)await state.beforeResponse();return state.responses.shift();
  }});
  mock('./services/supabaseCloudAuth.ts',{getSession:async()=>state.session});
  function modules(){for(const cached of Object.keys(require.cache))if(cached.startsWith(path.join(root,'services/data')))delete require.cache[cached];return require('../services/data/mobileCloudPull.ts');}
  t.after(()=>{if(state.db?.isOpen)state.db.close();global.window=previousWindow;for(const [p,v]of backups){if(v)require.cache[p]=v;else delete require.cache[p];}});
  state.modules=modules;return state;
}

test('empty cursor, category before movement, real SQL FK, internal owner and server id ignored',async t=>{
  const s=fixture(t),m=s.modules();assert.equal(await m.getMobilePullCursor('owner-a'),null);
  const result=await m.pullMobileCloudNow('owner-a');assert.equal(result.categoriesApplied,1);assert.equal(result.movementsApplied,1);
  assert.equal(s.calls[0].route,'/sync/pull');
  const row=s.db.prepare('SELECT * FROM movimientos').get();assert.equal(row.owner_user_id,'owner-a');assert.notEqual(row.categoria_id,9999);assert.equal(row.sync_status,'synced');
  assert.equal(row.last_remote_updated_at,revision);assert.equal(row.created_at,'2026-10-05T10:00:00.000000Z');
  assert.equal(await m.getMobilePullCursor('owner-a'),revision);assert.equal(await m.getMobilePullCursor('owner-b'),null);
  assert.equal((await m.readMobileCloudSnapshot('owner-a')).movements[0].descripcion,'prueba m8');
  const normal = require('../services/data/mobileFinanceRepository.ts').createMobileFinanceRepository('owner-a');
  assert.equal((await normal.listMovimientos({year:2026,month:10}))[0].descripcion,'prueba m8');
  assert.equal(s.db.prepare('SELECT sync_status FROM movimientos').get().sync_status,'synced');
  assert.deepEqual(await require('../services/data/mobileFinanceRepository.ts').mobileFinanceRepository.listMovimientos({year:2026,month:10}),[]);
});
test('repeated batch/change is idempotent and stale revision never resurrects or overwrites',async t=>{
  const s=fixture(t),m=s.modules();await m.applyMobilePull('owner-a',payload([category,category],[movement,movement]),null);
  const id=s.db.prepare('SELECT id FROM movimientos').get().id;
  const result=await m.applyMobilePull('owner-a',payload(),revision);assert.equal(result.categoriesApplied,0);assert.equal(result.movementsApplied,0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM movimientos').get().n,1);assert.equal(s.db.prepare('SELECT id FROM movimientos').get().id,id);
  await m.applyMobilePull('owner-a',payload([{...category,remote_updated_at:later,nombre:'Actualizada'}],[{...movement,remote_updated_at:later,descripcion:'Actualizado',monto:2000}],later),revision);
  await m.applyMobilePull('owner-a',payload([category],[movement],later),later);
  assert.equal(s.db.prepare('SELECT nombre FROM categorias').get().nombre,'Actualizada');assert.equal(s.db.prepare('SELECT monto FROM movimientos').get().monto,2000);
});
test('category and movement tombstones stay as rows and disappear from active snapshot',async t=>{
  const s=fixture(t),m=s.modules();await m.applyMobilePull('owner-a',payload(),null);
  await m.applyMobilePull('owner-a',payload([{...category,remote_updated_at:later,deleted_at:later}],[{...movement,remote_updated_at:later,deleted_at:later}],later),revision);
  assert.equal(s.db.prepare('SELECT deleted_at FROM categorias').get().deleted_at,later);
  assert.equal(s.db.prepare('SELECT deleted_at FROM movimientos').get().deleted_at,later);
  const snap=await m.readMobileCloudSnapshot('owner-a');assert.equal(snap.categories.length,0);assert.equal(snap.movements.length,0);
  await m.applyMobilePull('owner-a',payload([category],[movement],later),later);assert.equal((await m.readMobileCloudSnapshot('owner-a')).movements.length,0);
});
test('owner isolation even with same sync IDs and names, local rows untouched',async t=>{
  const s=fixture(t),m=s.modules();await m.getMobilePullCursor('owner-a');
  s.db.prepare('INSERT INTO categorias(nombre,tipo,owner_user_id,sync_id) VALUES(?,?,?,?)').run(category.nombre,'gasto','local',category.sync_id);
  const before=JSON.stringify(s.db.prepare("SELECT * FROM categorias WHERE owner_user_id='local'").all());
  await m.applyMobilePull('owner-a',payload(),null);await m.applyMobilePull('owner-b',payload([category],[{...movement,monto:77}]),null);
  assert.equal(JSON.stringify(s.db.prepare("SELECT * FROM categorias WHERE owner_user_id='local'").all()),before);
  assert.equal((await m.readMobileCloudSnapshot('owner-a')).movements[0].monto,1234);assert.equal((await m.readMobileCloudSnapshot('owner-b')).movements[0].monto,77);
  assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('cursor and data persist after closing SQLite and reopening service, incremental request',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sciso-pull-'));
  const s=fixture(t,path.join(dir,'mobile.db'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let m=s.modules();await m.pullMobileCloudNow('owner-a');s.db.close();m=s.modules();
  assert.equal(await m.getMobilePullCursor('owner-a'),revision);assert.equal((await m.readMobileCloudSnapshot('owner-a')).movements.length,1);
  s.responses.push(payload([],[],later));await m.pullMobileCloudNow('owner-a');assert.equal(s.calls[1].route,`/sync/pull?since=${encodeURIComponent(revision)}`);
  assert.equal(await m.getMobilePullCursor('owner-a'),later);
});
test('unsupported entities do not break valid category/movement application',async t=>{
  const s=fixture(t),m=s.modules();const p=payload();for(const key of ['tags','movimiento_tags','metas_ahorro','presupuestos','gastos_fijos','gastos_programados'])p[key]=[{private_unknown:'not logged'}];
  const result=await m.applyMobilePull('owner-a',p,null);assert.equal(result.ignoredCount,6);assert.equal(result.movementsApplied,1);
});
test('failed transaction rolls back both cursor and category, including initial empty state',async t=>{
  const s=fixture(t),m=s.modules();s.failAt=2;await assert.rejects(m.applyMobilePull('owner-a',payload(),null),e=>e.code==='apply_failed'&&!e.message.includes('secret'));
  assert.equal(await m.getMobilePullCursor('owner-a'),null);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM categorias').get().n,0);
  s.failAt=null;await m.applyMobilePull('owner-a',payload(),null);s.failAt=2;
  await assert.rejects(m.applyMobilePull('owner-a',payload([{...category,nombre:'Changed',remote_updated_at:later}],[],later),revision));
  assert.equal(await m.getMobilePullCursor('owner-a'),revision);assert.equal(s.db.prepare('SELECT nombre FROM categorias').get().nombre,category.nombre);
});
test('missing category refuses whole batch and never interprets server categoria_id as local',async t=>{
  const s=fixture(t),m=s.modules();await assert.rejects(m.applyMobilePull('owner-a',payload([],[movement]),null),{code:'apply_failed'});
  assert.equal(await m.getMobilePullCursor('owner-a'),null);
});
test('SQLite constraint conflict does not merge or reassign categories silently',async t=>{
  const s=fixture(t),m=s.modules();await m.applyMobilePull('owner-a',payload(),null);
  await assert.rejects(m.applyMobilePull('owner-a',payload([{...category,sync_id:'different',remote_updated_at:later}],[],later),revision),{code:'apply_failed'});
  assert.equal(await m.getMobilePullCursor('owner-a'),revision);
});
test('cursor compare-and-set rejects concurrent stale batch and prevents backward movement',async t=>{
  const s=fixture(t),m=s.modules();await m.applyMobilePull('owner-a',payload(),null);
  await assert.rejects(m.applyMobilePull('owner-a',payload([],[],later),null),{code:'apply_failed'});
  assert.equal(await m.getMobilePullCursor('owner-a'),revision);
  await m.applyMobilePull('owner-a',payload([],[],later),revision);
  await assert.rejects(m.applyMobilePull('owner-a',payload(),later),{code:'invalid_payload'});
});
test('microsecond revision and device tie-break follow desktop rules, not updated_at clocks',async t=>{
  const s=fixture(t),m=s.modules();await m.applyMobilePull('owner-a',payload(),null);
  const micro='2026-10-05T12:00:00.123457Z';
  await m.applyMobilePull('owner-a',payload([{...category,remote_updated_at:micro,nombre:'microsecond'}],[],later),revision);
  assert.equal(s.db.prepare('SELECT nombre FROM categorias').get().nombre,'microsecond');
  await m.applyMobilePull('owner-a',payload([{...category,remote_updated_at:micro,last_modified_device_id:'desktop-z',nombre:'tie winner'}],[],later),later);
  assert.equal(s.db.prepare('SELECT nombre FROM categorias').get().nombre,'tie winner');
});
test('unknown account/session/local/mobile restrictions make no cloud request',async t=>{
  const s=fixture(t),m=s.modules();await assert.rejects(m.pullMobileCloudNow('local'),{code:'invalid_owner'});
  s.session=null;await assert.rejects(m.pullMobileCloudNow('owner-a'),{code:'session_required'});
  s.session={authProvider:'supabase',user:{id:'other'},token:'not-for-storage'};await assert.rejects(m.pullMobileCloudNow('owner-a'),{code:'session_required'});
  global.window.navigator.userAgent='Windows';await assert.rejects(m.pullMobileCloudNow('owner-a'),{code:'unsupported_platform'});assert.equal(s.calls.length,0);
});
test('changed account during request does not apply data and rapid calls coalesce',async t=>{
  const s=fixture(t),m=s.modules();let release; s.beforeResponse=()=>new Promise(r=>release=r);
  const first=m.pullMobileCloudNow('owner-a'),second=m.pullMobileCloudNow('owner-a');assert.equal(first,second);
  while(!release)await new Promise(r=>setImmediate(r));s.active='owner-b';release();
  await assert.rejects(first,{code:'owner_changed'});assert.equal(s.calls.length,1);assert.equal(await m.getMobilePullCursor('owner-a'),null);
});
test('revoked device/network errors are explicit, sanitized and retain previous data/cursor',async t=>{
  const s=fixture(t),m=s.modules();await m.pullMobileCloudNow('owner-a');
  for(const kind of ['auth','network']) {s.failNetwork=kind;await assert.rejects(m.pullMobileCloudNow('owner-a'),e=>e.code===(kind==='auth'?'authorization_failed':'pull_failed')&&!e.message.includes('sensitive'));}
  assert.equal(await m.getMobilePullCursor('owner-a'),revision);assert.equal((await m.readMobileCloudSnapshot('owner-a')).movements.length,1);
  const columns=s.db.prepare('PRAGMA table_info(mobile_pull_state)').all().map(r=>r.name);assert.deepEqual(columns,['owner_user_id','cursor','supported_entities_version','updated_at']);
});
test('invalid payload, conflicting repeated identity and malformed timestamp never advance',async t=>{
  const s=fixture(t),m=s.modules();for(const p of [payload([category,{...category,nombre:'different'}]),payload([{...category,remote_updated_at:'invalid'}]),payload([category],[{...movement,fecha:'2026-02-30'}]),{...payload(),ok:false}]) {
    await assert.rejects(m.applyMobilePull('owner-a',p,null));assert.equal(await m.getMobilePullCursor('owner-a'),null);
  }
});
