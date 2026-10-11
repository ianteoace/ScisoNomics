// Real components and Tailwind in an isolated Chromium profile. Functional
// handlers are covered in mobileUi; this suite measures rendered CSS, not Tauri.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const React = require('react'), {renderToStaticMarkup} = require('react-dom/server');
const {stylesheet,chromium,browserPath,renderFixture} = require('./helpers/desktopLayout.cjs');
function stub(file,exports){const id=path.resolve(__dirname,'..',file);require.cache[id]={id,filename:id,loaded:true,exports};}
stub('components/mobile/account/MobileAccountProvider.tsx',{useMobileAccount:()=>({session:null,financialAccount:null,financialContext:{ownerId:'local',isCurrent:()=>true}})});
const {MobileSettings}=require('../components/mobile/configuracion/MobileSettings.tsx');
const {MobileSidebar}=require('../components/mobile/MobileSidebar.tsx');
const {SpanishDateInput,SpanishMonthInput}=require('../components/ui/SpanishDateInput.tsx');
const {SupabaseAccountForm}=require('../components/account/SupabaseAccountForm.tsx');
require('../services/supabaseCloudAuth.ts').isSupabaseCloudAuthConfigured=()=>true;
function page(css,children){return '<!doctype html><html lang="en"><head><style>'+css+'</style></head><body class="bg-slate-950 text-slate-100"><main class="mx-auto max-w-2xl p-4">'+renderToStaticMarkup(children)+'</main></body></html>';}
test('grouped mobile settings, direct account drawer and Spanish date controls fit small screens', {skip:!browserPath(),timeout:60000},async t=>{
 const css=(await stylesheet())+fs.readFileSync(path.resolve(__dirname,'../components/mobile/MobileDialog.module.css'),'utf8'),browser=await chromium();t.after(()=>browser.close());
 const fixtures={settings:React.createElement(MobileSettings),drawer:React.createElement(MobileSidebar,{pathname:'/dashboard',onClose(){}}),dates:React.createElement('div',{className:'grid gap-4'},React.createElement(SpanishDateInput,{value:'2028-02-29',onChange(){}}),React.createElement(SpanishMonthInput,{value:'2026-10',onChange(){}})),login:React.createElement(SupabaseAccountForm,{allowGoogle:false,onAuthenticated(){},onBusyChange(){}})};
 for(const [name,component] of Object.entries(fixtures)){
  await browser.html(page(css,component));
  if(name==='drawer') await browser.evaluate("document.querySelector('dialog').showModal()");
  for(const width of [360,412,768]){
   await browser.width(width);
   const result=await browser.evaluate(`({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,text:document.body.innerText,groups:document.querySelectorAll('summary').length,controls:[...document.querySelectorAll('select,input')].map(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width}))})`);
   assert(result.scroll<=result.width+1, name+' overflows '+width);
   assert(result.controls.every(e=>e.left>=0&&e.right<=width+1&&e.width>30),name+' controls fit');
   if(name==='settings'){assert.equal(result.groups,4);assert.match(result.text,/Cuenta y nube/);assert.match(result.text,/Aplicación/);}
   if(name==='drawer')assert.match(result.text,/Iniciar sesión/);
   if(name==='dates'){assert.match(result.text,/Octubre/);assert.doesNotMatch(result.text,/January|February|October/);}
   if(name==='login')assert.match(result.text,/¿Olvidaste tu contraseña/);
   if(width===360&&process.env.SCISONOMICS_UI_SCREENSHOTS){const screenshot=await browser.command('Page.captureScreenshot',{format:'png'});const file=path.join(os.tmpdir(),'scisonomics-ui-'+name+'.png');fs.writeFileSync(file,Buffer.from(screenshot.data,'base64'));t.diagnostic(file);}
  }
  if(name==='dates'){
   await browser.evaluate("document.querySelector('main').style.width='180px';document.querySelector('main').style.padding='0'");
   const widths=await browser.evaluate("[...document.querySelectorAll('select,input')].map(e=>e.getBoundingClientRect().width)");
   assert(widths.every(width=>width>=85),'narrow date controls wrap rather than crush month/year text');
  }
 }
 await browser.html(renderFixture(css,{page:'configuracion'}));await browser.width(1400);
 assert.equal(await browser.evaluate("document.querySelectorAll('nav[aria-label=\"Secciones de configuración\"] section').length"),4);
});
