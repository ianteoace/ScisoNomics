// Actual desktop components + Tailwind in Chromium, with synthetic data and
// inert providers. Measures CSS layout; does not hydrate charts/auth, run Next
// navigation handlers, or resize the native Tauri frame. Browser tests require
// Node 22+ and Chrome/Edge (or SCISONOMICS_LAYOUT_BROWSER); static coverage always
// runs. OS-temp profiles are isolated from both user profiles and repository tmp.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),ts=require('typescript');
const root=path.resolve(__dirname,'../..');
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true},fileName:file}).outputText,file);
const pass=({children})=>children;
function stub(name,exports){const id=name.startsWith('.')?path.resolve(root,name):require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports};}
stub('next/navigation',{usePathname:()=>'/dashboard',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push(){},replace(){}})});
stub('next/link',{__esModule:true,default:({href,children,...props})=>React.createElement('a',{...props,href},children)});
stub('sonner',{Toaster:()=>null});
stub('./components/app/BackendStartupGate.tsx',{BackendStartupGate:pass});
stub('./components/app/AppUpdateProvider.tsx',{AppUpdateProvider:pass,AppUpdateBanner:()=>null});
stub('./components/sync/AutoSyncProvider.tsx',{AutoSyncProvider:pass});
stub('./components/billing/PremiumAutoRefreshProvider.tsx',{PremiumAutoRefreshProvider:()=>null});
stub('./components/account/AddAccountModal.tsx',{AddAccountModal:()=>null});
stub('./components/account/AccountPanel.tsx',{AccountPanel:()=>null});
stub('./components/ui/Modal.tsx',{Modal:()=>null});
stub('./hooks/useDashboardUi.tsx',{DashboardUiProvider:pass,useDashboardUi:()=>({month:10,year:2026})});
stub('./services/cloudAuth.ts',{getAuthUIState:()=>({subtitle:'Sin sincronización'}),getActiveOwnerId:()=> 'local',getActiveAccount:()=>null,getStoredAccounts:()=>[],isCloudAuthConfigured:()=>false});
stub('./services/entitlements.ts',{});
stub('./services/api.ts',{api:{}});
const Layout=require('../../app/(dashboard)/layout.tsx').default;
const {DashboardView}=require('../../components/views/DashboardView.tsx');
const {MovimientosView}=require('../../components/views/MovimientosView.tsx');
const Settings=require('../../app/(dashboard)/configuracion/page.tsx').default;
const Calendar=require('../../app/(dashboard)/calendario/page.tsx').default;
const noop=()=>{};
function renderFixture(css,{collapsed=false,menu=false,page='dashboard'}={}){
 const original=React.useState;let index=0;
 React.useState=initial=>{const value=index++===0?collapsed:index===10?menu:typeof initial==='function'?initial():initial;return[value,noop];};
 try{
  const movement={id:1,fecha:'2026-10-01',tipo:'ingreso',categoria:'Trabajo',descripcion:'Movimiento de prueba '+ 'detalle'.repeat(24),monto:250000,saldo_acumulado:250000};
  const child=page==='configuracion'?React.createElement(Settings):page==='calendario'?React.createElement(Calendar):page==='movimientos'?React.createElement(MovimientosView,{rows:[movement],categories:[],metas:[],loading:false,onCreate:noop,onUpdate:noop,onDelete:noop}):React.createElement(DashboardView,{summary:{saldo_inicial:250000,ingreso:120000,gasto:20000,balance_final:350000},saldoActual:350000,previous:null,stats:null,upcoming:[],resumenPotente:null,presupuestos:[],gastosFijos:[],metas:[],recentMovements:[movement],month:10,year:2026,loading:false,onMonthChange:noop,onYearChange:noop,onQuickNewMovement:noop,onQuickMovements:noop,onQuickStats:noop,onQuickExport:async()=>{},onQuickBackup:async()=>{}});
  return '<!DOCTYPE html><html class="dark" lang="es"><head><style>'+css+'</style></head><body>'+renderToStaticMarkup(React.createElement(Layout,{},child))+'</body></html>';
 }finally{React.useState=original;}
}
async function stylesheet(){
 const config=require('../../tailwind.config.js');
 return (await require('postcss')([require('tailwindcss')({...config,content:[path.join(root,'app/**/*.{ts,tsx}'),path.join(root,'components/**/*.{ts,tsx}')],corePlugins:{...config.corePlugins}})]).process(fs.readFileSync(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')})).css;
}
function browserPath(){return [process.env.SCISONOMICS_LAYOUT_BROWSER,process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':null,process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':null,'/usr/bin/google-chrome','/usr/bin/chromium'].find(file=>file&&fs.existsSync(file));}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function chromium(){
 const executable=browserPath();if(!executable)throw new Error('Chromium is not available');
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'scisonomics-layout-'));
 const processHandle=spawn(executable,['--headless=new','--disable-gpu','--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});
 let socket;
 try{
  const active=path.join(profile,'DevToolsActivePort');
  for(let i=0;i<100&&!fs.existsSync(active);i++)await delay(100);
  const port=Number(fs.readFileSync(active,'utf8').split('\n')[0]);
  const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let serial=0;const pending=new Map();
  socket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id){const call=pending.get(value.id);if(!call)return;clearTimeout(call.timer);pending.delete(value.id);if(value.error)call.reject(new Error(value.error.message));else call.resolve(value.result);}});
  socket.addEventListener('close',()=>{for(const call of pending.values()){clearTimeout(call.timer);call.reject(new Error('Browser closed'));}pending.clear();});
  function command(method,params={}){return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Browser command timeout: '+method));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
  await command('Page.enable');
  return {command,async html(html){const tree=await command('Page.getFrameTree');await command('Page.setDocumentContent',{frameId:tree.frameTree.frame.id,html});},async width(width,height=800){await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await delay(250);},async evaluate(expression){const response=await command('Runtime.evaluate',{expression,returnByValue:true});if(response.exceptionDetails)throw new Error(response.exceptionDetails.text);return response.result.value;},async close(){try{await command('Browser.close');}catch{}socket.close();await delay(500);if(processHandle.exitCode===null)processHandle.kill();await delay(200);cleanup();}};
 }catch(error){socket?.close();processHandle.kill();cleanup();throw error;}
 function cleanup(){
  // Only the fresh OS-temp profile created here; never repo tmp or a user profile.
  const target=path.resolve(profile),base=path.resolve(os.tmpdir());
  if(path.dirname(target)!==base||!path.basename(target).startsWith('scisonomics-layout-'))throw new Error('Unexpected profile path');
  fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
}
const metrics=`(()=>{const sidebar=document.querySelector('aside'),content=sidebar.nextElementSibling;return {viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,sidebar:sidebar.getBoundingClientRect().width,contentTop:content.getBoundingClientRect().top,sidebarTop:sidebar.getBoundingClientRect().top,links:sidebar.querySelectorAll('nav a').length,overflow:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>document.documentElement.clientWidth+1).slice(0,5).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right}))};})()`;
module.exports={renderFixture,stylesheet,chromium,browserPath,metrics};
