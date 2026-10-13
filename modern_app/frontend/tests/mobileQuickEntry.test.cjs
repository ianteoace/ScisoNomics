const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
globalThis.window = undefined;
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, file);
const fixture = (type='income', id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') => ({id,type,remainingMs:120000});
const flush = () => new Promise(resolve => setImmediate(resolve));
async function ready(ctx) { for (let i=0;i<100&&!ctx.api.getPendingQuickEntry();i++) await new Promise(resolve=>setTimeout(resolve,2)); assert(ctx.api.getPendingQuickEntry(),'native snapshot did not arrive'); }
function setup(t, platform='Android', cold=fixture(), options={}) {
  delete require.cache[require.resolve('../services/mobileQuickEntry.ts')];
  let handler, pending=cold;
  const calls=[];
  const browser = new EventTarget(); browser.navigator={userAgent:platform};
  browser.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async (command,args)=>{
    calls.push(command);
    if(command.endsWith('|register_listener'))throw new Error('camelCase fallback');
    if(command.endsWith('|registerListener')){handler=args.handler;return;}
    if(command.endsWith('|peek_pending')){const snapshot=pending;if(options.peekWait)await options.peekWait;return {pending:snapshot};}
    if(command.endsWith('|consume_pending')){const consumed=pending?.id===args.id;if(consumed)pending=null;return {consumed};}
    if(command.endsWith('|remove_listener'))return {};
    if(command.endsWith('|get_info'))return {sdk:36};
    if(command.endsWith('|request_add_tile'))return {status:'added'};
    throw new Error('Unexpected native command');
  }};
  t.mock.property(globalThis,'window',browser);
  const api=require('../services/mobileQuickEntry.ts');
  const stop=api.startQuickEntryBridge();
  t.after(()=>{stop();const entry=api.getPendingQuickEntry();if(entry)api.finishQuickEntry(entry.id);});
  return {api,calls,browser,emit(value){pending=value;handler.onmessage(value);}};
}
test('quick entry validates closed payload and maps income/expense to existing movement types',t=>{
  const {api}=setup(t,'Windows');
  assert.equal(api.quickEntryKind('income'),'ingreso');assert.equal(api.quickEntryKind('expense'),'gasto');
  for(const bad of [null,{},[],{...fixture(),type:'ingreso'},{...fixture(),type:'delete'},{...fixture(),id:'bad'},{...fixture(),remainingMs:0},{...fixture(),remainingMs:120001},{...fixture(),remainingMs:1.2},{...fixture(),amount:100}])assert.equal(api.parseQuickEntry(bad),null);
  assert.equal(api.parseQuickEntry(fixture()).type,'income');
});
test('cold snapshot, warm event and repeated callback consume once with no storage or financial requests',async t=>{
  const ctx=setup(t);await ready(ctx);
  const first=ctx.api.getPendingQuickEntry();assert.equal(first.type,'income');
  const results=await Promise.all([ctx.api.consumeQuickEntry(first.id),ctx.api.consumeQuickEntry(first.id)]);
  assert.deepEqual(results,[true,true]);assert.equal(await ctx.api.consumeQuickEntry(first.id),true);ctx.api.finishQuickEntry(first.id);
  assert.equal(ctx.calls.filter(c=>c.endsWith('|consume_pending')).length,1);
  ctx.emit(fixture());assert.equal(ctx.api.getPendingQuickEntry(),null);
  ctx.emit(fixture('expense','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  assert.equal(ctx.api.getPendingQuickEntry().type,'expense');
  assert(ctx.calls.every(c=>c.startsWith('plugin:quick-entry|')));
});
test('last warm event wins and invalid events cannot overwrite pending entry',async t=>{
  const ctx=setup(t);await ready(ctx);ctx.emit(fixture('expense','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  ctx.emit({...fixture(),type:'arbitrary'});assert.equal(ctx.api.getPendingQuickEntry().type,'expense');
  assert.equal(await ctx.api.consumeQuickEntry(fixture().id),false);
});
test('a late cold snapshot cannot replace a newer warm expense event',async t=>{
  let release;const peekWait=new Promise(resolve=>{release=resolve;});
  const ctx=setup(t,'Android',fixture(),{peekWait});
  for(let i=0;i<100&&!ctx.calls.some(c=>c.endsWith('|peek_pending'));i++)await new Promise(resolve=>setTimeout(resolve,2));
  ctx.emit(fixture('expense','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));release();await flush();
  assert.equal(ctx.api.getPendingQuickEntry().type,'expense');
});
test('Desktop never initializes listener, invokes native commands or accepts quick entry',async t=>{
  const ctx=setup(t,'Windows');await flush();assert.equal(ctx.api.getPendingQuickEntry(),null);assert.deepEqual(ctx.calls,[]);
  await assert.rejects(ctx.api.requestQuickEntryTile('income'),/Android/);
});
test('an expired pending action is discarded without invoking native consumption',async t=>{
  const ctx=setup(t);await ready(ctx);const entry=ctx.api.getPendingQuickEntry();
  t.mock.method(Date,'now',()=>entry.expiresAt+1);assert.equal(await ctx.api.consumeQuickEntry(entry.id),false);
});
test('adding tiles is explicit and uses only the closed request type',async t=>{
  const ctx=setup(t);await ready(ctx);assert(!ctx.calls.some(c=>c.endsWith('|request_add_tile')));
  assert.match(await ctx.api.requestQuickEntryTile('income'),/agregado/);
  await assert.rejects(ctx.api.requestQuickEntryTile('arbitrary'),/inválido/);
});
test('tracked native plugin owns services/resources and preserves platform lifecycle and Google callback',()=>{
  const base=path.join(__dirname,'../src-tauri/plugins/quick-entry');
  const manifest=fs.readFileSync(path.join(base,'android/src/main/AndroidManifest.xml'),'utf8');
  assert.equal((manifest.match(/BIND_QUICK_SETTINGS_TILE/g)||[]).length,2);assert.equal((manifest.match(/action.QS_TILE/g)||[]).length,2);
  assert.equal((manifest.match(/android:exported="true"/g)||[]).length,2);assert(!manifest.includes('ACTIVE_TILE'));
  for(const type of ['Income','Expense'])assert(manifest.includes(type+'QuickTileService'));
  const kotlin=fs.readFileSync(path.join(base,'android/src/main/java/com/scisoftware/quickentry/QuickTileService.kt'),'utf8');
  assert.match(kotlin,/SDK_INT >= 34[\s\S]*PendingIntent.getActivity[\s\S]*FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE[\s\S]*startActivityAndCollapse\(pending\)[\s\S]*else startActivityAndCollapse\(launch\)/);
  assert(kotlin.includes('getLaunchIntentForPackage(packageName)'));assert(kotlin.includes('MainActivity'));assert(kotlin.includes('unlockAndRun'));
  assert.doesNotMatch(kotlin,/scisonomics:\/\/|finance|SQLite|token|email|balance|monto|Log\./i);
  const plugin=fs.readFileSync(path.join(base,'android/src/main/java/com/scisoftware/quickentry/QuickEntryPlugin.kt'),'utf8');
  assert.match(plugin,/override fun load[\s\S]*receive\(activity.intent\)/);assert.match(plugin,/override fun onNewIntent\(intent: Intent\).*receive\(intent\)/);
  assert(plugin.includes('intent.data != null'));assert(plugin.includes('intent.removeExtra(key)'));
  const android=JSON.parse(fs.readFileSync(path.join(__dirname,'../src-tauri/tauri.android.conf.json'),'utf8'));
  assert.equal(android.identifier,'com.scisoftware.scisonomics');assert.equal(android.bundle.android.debugApplicationIdSuffix,'.debug');
  assert.deepEqual(android.plugins['deep-link'].mobile,[{scheme:['scisonomics'],host:'auth',path:['/callback'],appLink:false}]);
  assert.match(fs.readFileSync(path.join(__dirname,'../src-tauri/src/lib.rs'),'utf8'), /#\[cfg\(target_os = "android"\)\]\r?\n  let builder = builder.plugin\(tauri_plugin_quick_entry::init\(\)\);/);
});
