// Real components and compiled CSS in an isolated headless browser. Synthetic
// data only; no hydration, API requests, auth credentials or native storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { stylesheet, chromium, browserPath } = require('./helpers/desktopLayout.cjs');
require.extensions['.css'] = module => { module.exports = { dialog: 'dialog', drawer: 'drawer', mobile: 'mobile', content: 'content', header: 'header' }; };
global.window = { navigator: { userAgent: 'Android', platform: 'Linux', maxTouchPoints: 1 }, __TAURI_INTERNALS__: {} };
const platform = require('../services/platform.ts');
const authId = require.resolve('../services/supabaseCloudAuth.ts');
require.cache[authId] = { id: authId, filename: authId, loaded: true, exports: {
  subscribePendingDevice: () => () => {}, getPendingDeviceState: () => ({ required: true, resendAt: 0 }),
  getPendingDeviceServerState: () => ({ required: true, resendAt: 0 }), cancelDeviceVerification() {},
  isSupabaseCloudAuthConfigured: () => true,
} };
function stub(name, exports) {
  const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('../services/supabaseTokenStorage.ts', { isSupabaseSecureStorageAvailable: () => true });
stub('../services/supabaseGoogleAuth.ts', {
  subscribeGoogleOAuth: () => () => {}, getGoogleOAuthState: () => ({ status: 'idle' }), getGoogleOAuthServerState: () => ({ status: 'idle' }),
});
const { SupabaseAccountForm } = require('../components/account/SupabaseAccountForm.tsx');
const { DeviceVerificationDialog } = require('../components/account/DeviceVerificationDialog.tsx');
const { MobileDialog } = require('../components/mobile/MobileDialog.tsx');
const { MobileHeader } = require('../components/mobile/MobileHeader.tsx');
const { MobileSidebar } = require('../components/mobile/MobileSidebar.tsx');
const { MobileMovementForm } = require('../components/mobile/movimientos/MobileMovementForm.tsx');
const { MobileCategoryForm } = require('../components/mobile/categorias/MobileCategoryForm.tsx');
const { MobileFixedExpenseForm } = require('../components/mobile/gastos-fijos/MobileFixedExpenseForm.tsx');
const { MobileBudgetForm } = require('../components/mobile/presupuestos/MobileBudgetForm.tsx');
const { MobileGoalForm } = require('../components/mobile/metas/MobileGoalForm.tsx');
const { MobileSchedulingForm } = require('../components/mobile/planificacion/MobileSchedulingForm.tsx');
const noop = () => {};
const props = { onClose: noop, onSave: noop, busy: false, error: '', categories: [{ id: 1, nombre: 'Categoria'.repeat(15), tipo: 'gasto' }], goals: [], rows: [], period: '2026-10' };
function LoginDialog() { return React.createElement(MobileDialog, { title: 'Iniciar sesion', onClose: noop }, React.createElement(SupabaseAccountForm, { onAuthenticated: noop, onBusyChange: noop })); }
const fixtures = [DeviceVerificationDialog, LoginDialog, MobileMovementForm, MobileCategoryForm, MobileFixedExpenseForm, MobileBudgetForm, MobileGoalForm, MobileSchedulingForm, MobileSidebar];
function html(css, Component) {
  const children = React.createElement(React.Fragment, {},
    React.createElement(MobileHeader, { title: 'Movimientos', onOpenMenu: noop }),
    React.createElement('main', { className: 'mx-auto grid w-full max-w-2xl gap-3 px-3 pt-3' },
      React.createElement('section', { className: 'card p-5' }, 'TextoSinEspacios'.repeat(25)),
      React.createElement(Component, { ...props, pathname: '/dashboard' })));
  return '<!DOCTYPE html><html lang="es"><head><style>' + css + '</style></head><body>' + renderToStaticMarkup(React.createElement('div', { 'data-mobile-ui': '', className: 'min-w-0' }, children)) + '</body></html>';
}

test('mobile CSS scopes compact sizing and retains safe areas and keyboard fallbacks', () => {
  const css = fs.readFileSync(path.join(__dirname, '../components/mobile/MobileDialog.module.css'), 'utf8');
  assert.match(css, /\.mobile[\s\S]*overflow-x: hidden/);
  assert.match(css, /var\(--mobile-viewport-height, 100dvh\)/);
  for (const edge of ['top', 'bottom', 'left', 'right']) assert(css.includes('safe-area-inset-' + edge));
  const desktop = css.slice(0, css.indexOf('.mobile {'));
  assert.match(desktop, /max-width: 32rem/);
});

test('mobile forms and drawer fit narrow screens and remain usable with keyboard', { skip: !browserPath(), timeout: 60000 }, async t => {
  const css = await stylesheet() + '\n' + fs.readFileSync(path.join(__dirname, '../components/mobile/MobileDialog.module.css'), 'utf8');
  const browser = await chromium(); t.after(() => browser.close());
  for (const Component of fixtures) for (const [width, height] of [[320, 568], [360, 640], [390, 844], [320, 300]]) {
    await browser.width(width, height); await browser.html(html(css, Component));
    await browser.evaluate(`document.querySelector('dialog').showModal()`);
    await browser.command('Runtime.evaluate', { expression: 'Promise.all(document.getAnimations().map(animation => animation.finished))', awaitPromise: true });
    const value = await browser.evaluate(`(()=>{
      const d=document.querySelector('dialog'),r=d.getBoundingClientRect();
      const controls=[...d.querySelectorAll('button,a,input:not([type=checkbox]),select,textarea')];
      const menu=document.getElementById('mobile-menu-button').getBoundingClientRect();
      return {width:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right,bottom:r.bottom,
        dialogWidth:d.clientWidth,dialogScroll:d.scrollWidth,menu:[menu.width,menu.height],
        controls:controls.map(e=>({height:e.getBoundingClientRect().height,right:e.getBoundingClientRect().right})),
        close:d.querySelector('[aria-label="Cerrar"]').getBoundingClientRect().height};
    })()`);
    const label = Component.name + ' ' + width + 'x' + height + ': ' + JSON.stringify(value);
    assert(value.scroll <= width + 1 && value.dialogScroll <= value.dialogWidth + 1, label);
    assert(value.left >= 0 && value.right <= width + 1 && value.bottom <= height + 1, label);
    assert(value.close >= 44 && value.menu.every(n => n >= 44), label);
    assert(value.controls.every(c => c.height >= 44 && c.right <= value.right), label);
    const lastVisible = await browser.evaluate(`(()=>{const d=document.querySelector('dialog'),last=[...d.querySelectorAll('button,a')].at(-1);last.scrollIntoView({block:'end'});const a=last.getBoundingClientRect(),b=d.getBoundingClientRect();return a.bottom<=b.bottom+1})()`);
    assert(lastVisible, 'last action must be reachable by vertical scrolling: ' + label);
  }
  // The same shared dialog on desktop keeps original size; mobile rules do not
  // affect shared inputs/buttons without the mobile namespace.
  const original = platform.getRuntimePlatformSync;
  try {
    platform.getRuntimePlatformSync = () => 'desktop';
    await browser.width(900, 700);
    const markup = renderToStaticMarkup(React.createElement(MobileDialog, { title: 'Cuenta', onClose: noop }, React.createElement('input', { className: 'input' })));
    await browser.html('<html><head><style>' + css + '</style></head><body>' + markup + '</body></html>');
    const desktop = await browser.evaluate(`(()=>{const d=document.querySelector('dialog');d.showModal();return {width:d.getBoundingClientRect().width,height:d.querySelector('input').getBoundingClientRect().height,mobile:d.hasAttribute('data-mobile-ui')}})()`);
    assert.equal(desktop.width, 512); assert.equal(desktop.mobile, false); assert(desktop.height < 44);
  } finally { platform.getRuntimePlatformSync = original; }
});
