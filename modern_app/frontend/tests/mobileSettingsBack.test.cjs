const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),{test}=require('node:test');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {prepareSettingsHistory:prepare,navigateSettingsHistory:navigate}=require('../lib/mobileSettingsHistory.ts');
function fixture(t,search=''){
 const old=global.window,entries=[{url:'/dashboard',state:{next:true}},{url:'/configuracion'+search,state:{next:true}}];let index=1;
 const window=new EventTarget();global.window=window;
 const apply=()=>{const url=new URL(entries[index].url,'http://app.local');window.location={href:url.href,search:url.search};window.history.state=entries[index].state;};
 window.history={state:null,pushState:(state,_,url)=>{entries.splice(++index);entries.push({state,url});apply();},replaceState:(state,_,url)=>{entries[index]={state,url};apply();},back:()=>{if(index){index--;apply();window.dispatchEvent(new Event('popstate'));}}};apply();
 t.after(()=>{global.window=old;});return {window,entries};
}
test('Android first Back returns every Settings detail to root and second Back follows previous navigation',t=>{
 const f=fixture(t);
 for(const section of ['cuenta','dispositivos','recovery','sync','suscripcion','quick-entry','acerca','general','datos','diagnostico','actualizaciones','legal']){
  navigate(section,true);assert.equal(f.window.history.state.next,true);assert.match(f.window.location.search,new RegExp('section='+section));
  f.window.history.back();assert.equal(f.window.location.search,'');assert.match(f.window.location.href,/configuracion$/);
 }
 f.window.history.back();assert.match(f.window.location.href,/dashboard$/);
});
test('direct links get one root entry; remounts do not duplicate history and visual Back uses the same entry',t=>{
 const f=fixture(t,'?panel=cuenta&other=1');prepare('cuenta',true);prepare('cuenta',true);
 assert.equal(f.entries.length,3);assert.match(f.window.location.search,/section=cuenta/);
 navigate('sync',true);assert.equal(f.entries.length,3);
 navigate(null,true);assert.equal(f.window.location.search,'?other=1');
 f.window.history.back();assert.match(f.window.location.href,/dashboard$/);
});
test('desktop keeps replacement navigation and Android root has no global Back interceptor',t=>{
 const f=fixture(t);prepare('cuenta',false);navigate('cuenta',false);assert.equal(f.entries.length,2);
 navigate(null,false);f.window.history.back();assert.match(f.window.location.href,/dashboard$/);
});
