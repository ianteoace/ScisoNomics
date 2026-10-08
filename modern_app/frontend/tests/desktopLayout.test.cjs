const assert=require('node:assert/strict'),{test}=require('node:test');
const {renderFixture,stylesheet,chromium,browserPath,metrics}=require('./helpers/desktopLayout.cjs');
test('desktop shell has shrinkable tracks and accessible links even without a browser',()=>{
 const expanded=renderFixture(''),collapsed=renderFixture('',{collapsed:true});
 assert.match(expanded,/desktop-shell grid min-h-screen grid-cols-\[84px_minmax\(0,1fr\)\]/);
 assert.match(expanded,/lg:grid-cols-\[250px_minmax\(0,1fr\)\]/);
 assert.match(expanded,/desktop-content min-w-0/);
 assert(!collapsed.includes('lg:grid-cols-[250px_minmax(0,1fr)]'));
 for(const [href,label]of [['/dashboard','Inicio'],['/movimientos','Movimientos'],['/categorias','Categorías']]){
  assert(expanded.includes('href="'+href+'"'));assert(expanded.includes('aria-label="'+label+'"'));assert(collapsed.includes('aria-label="'+label+'"'));
 }
 assert.match(expanded,/hidden min-w-0 items-center gap-2 lg:flex/);
});
test('desktop wide/narrow layout contains content and retains compact navigation', {skip:!browserPath(),timeout:60000},async t=>{
 const css=await stylesheet(),browser=await chromium();t.after(()=>browser.close());
 for(const page of ['dashboard','movimientos','configuracion','calendario'])for(const menu of [false,true]){
  await browser.html(renderFixture(css,{page,menu}));
  for(const width of [1400,1100,900,760,1400]){
   await browser.width(width);const value=await browser.evaluate(metrics);
   if(value.scroll>value.viewport+1)t.diagnostic(JSON.stringify({page,menu,width,...value}));
   assert(value.scroll<=value.viewport+1,'global overflow: '+JSON.stringify(value));
   assert(Math.abs(value.sidebar-(width>=1024?250:84))<=1,'sidebar must adapt to the viewport');
   assert(Math.abs(value.contentTop-value.sidebarTop)<=1,'desktop content must remain beside the sidebar');
   assert.equal(value.links,11);
   const navigation=await browser.evaluate(`(()=>{const links=[...document.querySelectorAll('.desktop-sidebar nav a')];return links.map(link=>({href:link.getAttribute('href'),label:link.getAttribute('aria-label'),icon:link.querySelector('svg').getBoundingClientRect().width}));})()`);
   assert(navigation.every(link=>link.icon>=15&&link.label&&link.href.startsWith('/')),'icons and accessible navigation must remain usable');
   const localScroll=await browser.evaluate(`(()=>{const table=document.querySelector('.table-wrap');return table?{width:table.clientWidth,scroll:table.scrollWidth,right:table.getBoundingClientRect().right}:null})()`);
   if(page==='movimientos'){assert(localScroll.scroll>localScroll.width,'wide table remains scrollable');assert(localScroll.right<=value.viewport);}
   if(menu){const popup=await browser.evaluate(`(()=>{const menu=document.querySelector('[role=menu]');return {left:menu.getBoundingClientRect().left,right:menu.getBoundingClientRect().right,items:menu.querySelectorAll('[role=menuitem]').length}})()`);assert(popup.left>=0&&popup.right<=value.viewport);assert(popup.items>=3);}
  }
 }
});
test('manual collapse survives narrow/wide resizing and compact navigation can scroll vertically',{skip:!browserPath(),timeout:30000},async t=>{
 const css=await stylesheet(),browser=await chromium();t.after(()=>browser.close());
 for(const collapsed of [true,false]){
  await browser.html(renderFixture(css,{collapsed}));
  for(const width of [1400,760,1400]){
   await browser.width(width,360);const value=await browser.evaluate(metrics);
   assert(Math.abs(value.sidebar-(collapsed||width<1024?84:250))<=1);
   const mode=await browser.evaluate(`(()=>{const toggle=document.querySelector('[aria-label="${collapsed?'Expandir':'Colapsar'} menu lateral"]'),nav=document.querySelector('.desktop-sidebar nav');nav.scrollTop=nav.scrollHeight;const link=nav.querySelector('a:last-of-type');return {toggle:getComputedStyle(toggle).display,scroll:nav.scrollTop,overflow:getComputedStyle(nav).overflowY,labels:[...nav.querySelectorAll('a>span')].filter(el=>getComputedStyle(el).display!=='none').length};})()`);
   assert.equal(mode.toggle==='none',width<1024);assert.equal(mode.labels,collapsed||width<1024?0:11);assert(mode.scroll>0);assert.equal(mode.overflow,'auto');
  }
 }
});
