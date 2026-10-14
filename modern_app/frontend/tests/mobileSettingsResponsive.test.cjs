// Actual mobile Settings and Tailwind CSS in an isolated browser; synthetic
// account/entitlement data, no hydration, cloud requests or native operations.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {stylesheet,chromium,browserPath} = require('./helpers/desktopLayout.cjs');
function stub(name, exports) {
  const id = require.resolve(name);
  if (require.cache[id]) Object.assign(require.cache[id].exports, exports);
  else require.cache[id] = {id,filename:id,loaded:true,exports};
}
global.window = {navigator:{userAgent:'Android',platform:'Linux',maxTouchPoints:1},__TAURI_INTERNALS__:{},location:{search:''}};
stub('../components/mobile/account/MobileAccountProvider.tsx', {useMobileAccount:()=>({
  financialContext:{ownerId:'local',isCurrent:()=>true},financialAccount:null,session:null,checking:false,error:'',refresh:async()=>{},
})});
stub('../services/entitlements.ts', {getCachedEntitlements:()=>({plan:'free'}),ENTITLEMENTS_CHANGED_EVENT:'entitlements'});
stub('../services/mobileRecoveryState.ts', {isMobileRecoveryBlocked:()=>false,mobileRecoveryEnabled:()=>false});
stub('../services/supabaseCloudAuth.ts', {isSupabaseCloudAuthConfigured:()=>false});
stub('../components/mobile/useMobilePremium.ts', {useMobilePremium:()=>({plan:'free'})});
const {MobileSettings} = require('../components/mobile/configuracion/MobileSettings.tsx');
const {MOBILE_SETTINGS_GROUPS} = require('../components/mobile/configuracion/MobileSettingsNavigation.tsx');
const {MobileHeader} = require('../components/mobile/MobileHeader.tsx');
function fixture(css, section) {
  const original = React.useState; let index = 0;
  React.useState = initial => {
    const position = index++;
    return [position === 0 ? section : section === 'quick-entry' && position === 5 ? 33 : typeof initial === 'function' ? initial() : initial,()=>{}];
  };
  try {
    const body = React.createElement('div',{'data-mobile-ui':'',className:'min-w-0'},
      React.createElement(MobileHeader,{title:'Configuración',onOpenMenu(){}}),
      React.createElement('main',{className:'mx-auto grid w-full max-w-2xl gap-3 px-3 pt-3 pb-6'},React.createElement(MobileSettings)));
    return '<!DOCTYPE html><html lang="es"><head><style>'+css+'</style></head><body>'+renderToStaticMarkup(body)+'</body></html>';
  } finally {React.useState=original;}
}

test('Settings root/detail fit 320/360/390px and keep Back reachable at reduced height', {skip:!browserPath(),timeout:60000}, async t => {
  const css = await stylesheet(); const browser = await chromium(); t.after(()=>browser.close());
  const sections = [null,...MOBILE_SETTINGS_GROUPS.flatMap(group=>group.rows.map(row=>row.id))];
  for (const [width,height] of [[320,568],[360,640],[390,844],[320,300]]) for (const section of sections) {
    await browser.width(width,height); await browser.html(fixture(css,section));
    const dimensions = await browser.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('[data-settings-row]')];
      const controls=[...document.querySelector('main').querySelectorAll('button,a')];
      return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,rows:rows.length,
        targets:controls.map(e=>({height:e.getBoundingClientRect().height,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})),
        rowHeights:rows.map(e=>e.getBoundingClientRect().height),forms:document.querySelectorAll('form,input').length};
    })()`);
    const context = `${section || 'root'} ${width}x${height}`;
    assert(dimensions.scroll<=width,JSON.stringify({context,dimensions}));
    assert(dimensions.targets.every(rect=>rect.height>=44 && rect.left>=0 && rect.right<=width),context);
    if (section === null) {
      assert.equal(dimensions.rows,12,context); assert.equal(dimensions.forms,0,context);
      assert(dimensions.rowHeights.every(h=>h>=56),context);
    } else {
      assert.equal(dimensions.rows,0,context);
      await browser.evaluate('window.scrollTo(0,document.documentElement.scrollHeight)');
      const back = await browser.evaluate(`(()=>{
        const header=document.querySelector('header').getBoundingClientRect(),b=document.querySelector('main button').getBoundingClientRect();
        return {top:b.top,bottom:b.bottom,headerBottom:header.bottom,viewport:innerHeight};
      })()`);
      assert(back.top>=back.headerBottom && back.bottom<=height,JSON.stringify({context,back}));
      // Bottom controls are reachable by scrolling, including narrow/short screens.
      const last = await browser.evaluate(`(()=>{const a=[...document.querySelector('main').querySelectorAll('button,a')].at(-1);a.scrollIntoView({block:'end'});const r=a.getBoundingClientRect();return {top:r.top,bottom:r.bottom};})()`);
      assert(last.top>=0 && last.bottom<=height,JSON.stringify({context,last}));
    }
  }
});
