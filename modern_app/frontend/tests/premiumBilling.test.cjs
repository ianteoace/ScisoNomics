const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};
require.extensions[".tsx"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

const root = path.resolve(__dirname, "..");
const owner = "internal-sciso-owner";
let activeOwner = owner;
let token = "access-test-only";
const cloudAuthPath = path.join(root, "services", "cloudAuth.ts");
require.cache[cloudAuthPath] = {
  id: cloudAuthPath,
  filename: cloudAuthPath,
  loaded: true,
  exports: {
    OWNER_CHANGED_EVENT: "owner-changed-test",
    ACCOUNT_SESSION_CHANGED_EVENT: "session-changed-test",
    getActiveOwnerId: () => activeOwner,
    getActiveAccount: () => activeOwner === "local" ? null : { user: { id: activeOwner } },
    getActiveCloudSessionAsync: async () => token ? { token, user: { id: activeOwner } } : null,
  },
};
process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL = "https://cloud.test";
const billing = require("../services/premiumBilling.ts");
const { PremiumCheckout, PremiumSubscriptionDetails } = require("../components/billing/PremiumCheckout.tsx");
const { PremiumVerificationFallback } = require("../components/billing/PremiumCheckout.tsx");
const { createPremiumAutoRefresh } = require("../services/premiumAutoRefresh.ts");
const entitlementsService = require("../services/entitlements.ts");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const subscriptionId = "11111111-2222-4333-8444-555555555555";
const checkoutUrl = "https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=provider123";
const pending = { status: "pending", subscription_id: subscriptionId, amount: "4500.00", paid_until: null, checkout_url: checkoutUrl, can_cancel: true };

const freeEntitlements = { plan: "free", status: "active", features: { budgets: false, saving_goals: false, fixed_expenses: false, planning: false }, expires_at: null };
const premiumEntitlements = { ...freeEntitlements, plan: "premium", features: { budgets: true, saving_goals: true, fixed_expenses: true, planning: true } };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function autoRefreshFixture(options = {}) {
  let currentOwner = owner, time = 10000, cached = options.premium ? premiumEntitlements : freeEntitlements;
  const calls = [], publications = [], timers = new Map();
  const win = new EventTarget(), doc = new EventTarget();
  doc.visibilityState = "visible";
  const controller = createPremiumAutoRefresh({
    owner: () => currentOwner, accountOwner: () => currentOwner === "local" ? undefined : currentOwner,
    session: async () => options.noSession ? null : { token: "test", user: { id: options.wrongSession ? "other-owner" : currentOwner } },
    cached: () => cached,
    subscription: async () => { calls.push("subscription"); return options.subscription || pending; },
    refresh: async () => { calls.push("refresh"); return options.refresh ? options.refresh() : options.subscription || pending; },
    entitlements: async () => { calls.push("entitlements"); cached = options.entitlements ? await options.entitlements() : cached; return cached; },
    publish: (state, e) => publications.push({ ...state, entitlements: e }),
    now: () => time,
    schedule: (callback, delay) => { const timer = Symbol(); timers.set(timer, { callback, delay }); return timer; },
    clear: (timer) => timers.delete(timer),
  });
  if (!options.unloaded) controller.update(options.subscription || pending);
  const detach = controller.attach(win, doc);
  return {
    controller, calls, publications, timers, detach, win, doc,
    focus: () => win.dispatchEvent(new Event("focus")),
    visible: () => doc.dispatchEvent(new Event("visibilitychange")),
    owner: (next) => { currentOwner = next; win.dispatchEvent(new Event("owner-changed-test")); },
    hidden: () => { doc.visibilityState = "hidden"; },
    async tick() { const [key, timer] = timers.entries().next().value || []; if (!timer) return; timers.delete(key); time += timer.delay; timer.callback(); await flush(); },
    advance: () => { time += 4000; },
  };
}

for (const status of ["pending", "authorized", "uncertain"]) {
  test(`focus refreshes ${status} and then entitlements`, async () => {
    const f = autoRefreshFixture({ subscription: { ...pending, status } });
    f.focus(); await flush();
    assert.deepEqual(f.calls, ["refresh", "entitlements"]);
    assert.equal(f.controller.state().verifying, false);
    f.detach();
  });
}

for (const options of [{ premium: true }, { subscription: { ...pending, status: "canceled" } }, { subscription: { ...pending, status: "none" } }, { noSession: true }, { wrongSession: true }]) {
  test(`focus skips ineligible premium/session/status ${JSON.stringify(options)}`, async () => {
    const f = autoRefreshFixture(options); f.focus(); await flush();
    assert.deepEqual(f.calls, []); f.detach();
  });
}

test("focus and visibility share a lock and cooldown with manual verification", async () => {
  let complete;
  const f = autoRefreshFixture({ refresh: () => new Promise((resolve) => { complete = resolve; }) });
  f.focus(); f.visible(); await flush();
  const manual = f.controller.verify(true);
  assert.deepEqual(f.calls, ["refresh"]);
  complete(pending); await manual;
  f.focus(); f.visible(); await flush();
  assert.deepEqual(f.calls, ["refresh", "entitlements"]);
  f.detach();
});

test("approved refresh publishes backend Premium/features in the same session and stops retries", async () => {
  const f = autoRefreshFixture({ refresh: async () => ({ ...pending, status: "authorized", payment_status: "approved" }), entitlements: async () => premiumEntitlements });
  f.controller.checkout(true); f.focus(); await flush();
  assert.equal(f.controller.state().message, "Premium activado.");
  assert.equal(f.publications.at(-1).entitlements.features.budgets, true);
  assert.equal(f.timers.size, 0);
  f.advance(); f.focus(); await flush();
  assert.deepEqual(f.calls, ["refresh", "entitlements"]); f.detach();
});

test("a late response from another owner is discarded before loading entitlements", async () => {
  let complete;
  const f = autoRefreshFixture({ refresh: () => new Promise((resolve) => { complete = resolve; }) });
  f.focus(); await flush(); f.owner("local"); complete(pending); await flush();
  assert.equal(f.controller.state().ownerId, "local");
  assert.equal(f.controller.state().subscription, null);
  assert.equal(f.calls.includes("entitlements"), false); f.detach();
});

test("checkout return permits only three retries and no permanent polling", async () => {
  const f = autoRefreshFixture(); f.controller.checkout(true); f.focus(); await flush();
  for (let i = 0; i < 3; i++) { assert.equal(f.timers.size, 1); await f.tick(); }
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.filter((x) => x === "refresh").length, 4);
  assert.match(f.controller.state().message, /todavía se está confirmando/); f.detach();
});

for (const result of [{ ...pending, payment_status: "rejected" }, { ...pending, status: "canceled" }]) {
  test(`checkout retries stop immediately for ${result.payment_status || result.status}`, async () => {
    const f = autoRefreshFixture({ refresh: async () => result }); f.controller.checkout(true); f.focus(); await flush();
    assert.equal(f.timers.size, 0); assert.deepEqual(f.calls, ["refresh", "entitlements"]); f.detach();
  });
}

test("ordinary focus has no retry loop and hidden windows do not refresh", async () => {
  const f = autoRefreshFixture(); f.focus(); await flush(); assert.equal(f.timers.size, 0);
  f.advance(); f.hidden(); f.visible(); f.focus(); await flush(); assert.deepEqual(f.calls, ["refresh", "entitlements"]); f.detach();
});

test("a checkout return bypasses a previous focus cooldown once", async () => {
  const f = autoRefreshFixture(); f.focus(); await flush();
  f.controller.checkout(true); f.focus(); f.visible(); await flush();
  assert.equal(f.calls.filter((x) => x === "refresh").length, 2);
  assert.equal(f.timers.size, 1); f.detach();
});

test("slow verification does not schedule retries beyond the ten-second budget", async () => {
  let complete;
  const f = autoRefreshFixture({ refresh: () => new Promise((resolve) => { complete = resolve; }) });
  f.controller.checkout(true); f.focus(); await flush(); f.advance(); f.advance(); complete(pending); await flush();
  assert.equal(f.timers.size, 0); assert.match(f.controller.state().message, /todavía se está confirmando/); f.detach();
});

test("concurrent initialization shares the subscription request", async () => {
  const f = autoRefreshFixture({ unloaded: true });
  await Promise.all([f.controller.activate(), f.controller.activate()]);
  assert.equal(f.calls.filter((x) => x === "subscription").length, 1); f.detach();
});

test("effect cleanup and remount can initialize again without retaining a canceled activation", async () => {
  const f = autoRefreshFixture({ unloaded: true }); f.detach();
  const detach = f.controller.attach(f.win, f.doc); await flush();
  assert.deepEqual(f.calls, ["subscription", "refresh", "entitlements"]); detach();
});

test("cleanup discards an already in-flight refresh response", async () => {
  let complete;
  const f = autoRefreshFixture({ refresh: () => new Promise((resolve) => { complete = resolve; }) });
  f.focus(); await flush(); f.detach(); const count = f.publications.length; complete(pending); await flush();
  assert.equal(f.publications.length, count); assert.equal(f.calls.includes("entitlements"), false);
});

test("owner change during entitlements loading discards the final UI update", async () => {
  let complete;
  const f = autoRefreshFixture({ entitlements: () => new Promise((resolve) => { complete = resolve; }) });
  f.focus(); await flush(); f.owner("local"); const count = f.publications.length; complete(premiumEntitlements); await flush();
  assert.equal(f.publications.length, count); assert.equal(f.controller.state().ownerId, "local"); f.detach();
});

test("local mode never refreshes billing on focus", async () => {
  const f = autoRefreshFixture(); f.owner("local"); f.focus(); f.visible(); await flush();
  assert.deepEqual(f.calls, []); f.detach();
});

test("cleanup removes listeners and cancels scheduled checkout retries", async () => {
  const f = autoRefreshFixture(); f.controller.checkout(true); f.focus(); await flush();
  assert.equal(f.timers.size, 1); f.detach(); assert.equal(f.timers.size, 0);
  f.advance(); f.focus(); f.visible(); await flush(); assert.deepEqual(f.calls, ["refresh", "entitlements"]);
});

test("focus during checkout opening is deferred until the action completes", async () => {
  const f = autoRefreshFixture(); f.controller.setBusy(true); f.controller.checkout(true); f.focus(); await flush();
  assert.deepEqual(f.calls, []); f.controller.setBusy(false); await flush();
  assert.deepEqual(f.calls, ["refresh", "entitlements"]); assert.equal(f.timers.size, 1); f.detach();
});

test("uncertain refresh failure still checks authoritative entitlements without retrying", async () => {
  const f = autoRefreshFixture({ subscription: { ...pending, status: "uncertain" }, refresh: async () => { throw new Error("unconfirmed"); }, entitlements: async () => premiumEntitlements });
  f.focus(); await flush(); assert.equal(f.controller.state().message, "Premium activado."); assert.equal(f.timers.size, 0); f.detach();
});

test("manual fallback is secondary and visible only for eligible Free cloud states", () => {
  for (const status of ["pending", "authorized", "uncertain", "none", "canceled"]) {
    const html = renderToStaticMarkup(React.createElement(PremiumVerificationFallback, { subscription: { ...pending, status }, premiumActive: false, local: false, busy: false, onVerify() {} }));
    assert.equal(html.includes("Verificar nuevamente"), ["pending", "authorized", "uncertain"].includes(status));
    assert.doesNotMatch(html, /class="btn/);
  }
  for (const props of [{ local: true, premiumActive: false }, { local: false, premiumActive: true }]) {
    assert.equal(renderToStaticMarkup(React.createElement(PremiumVerificationFallback, { subscription: pending, busy: false, onVerify() {}, ...props })), "");
  }
});

test("entitlements discard an older Free response after a newer Premium result", async (t) => {
  account(); browser();
  let finishOld;
  let requests = 0;
  global.fetch = t.mock.fn(async (url) => {
    if (url === "https://cloud.test/billing/entitlements") {
      requests++;
      return { ok: true, json: requests === 1 ? () => new Promise((resolve) => { finishOld = resolve; }) : async () => premiumEntitlements };
    }
    return { ok: true, json: async () => ({}) };
  });
  const old = entitlementsService.loadEntitlements({ force: true, ownerId: owner });
  await flush();
  await entitlementsService.loadEntitlements({ force: true, ownerId: owner });
  finishOld(freeEntitlements); await old;
  assert.equal(entitlementsService.getCachedEntitlements(owner).plan, "premium");
});

test("entitlements of a switched-away owner cannot replace its cached plan", async (t) => {
  account(); browser(); let finish;
  global.fetch = t.mock.fn(async () => ({ ok: true, json: () => new Promise((resolve) => { finish = resolve; }) }));
  const loading = entitlementsService.loadEntitlements({ force: true, ownerId: owner });
  await flush(); activeOwner = "other-account"; finish(freeEntitlements); await loading;
  assert.equal(entitlementsService.getCachedEntitlements(owner).plan, "premium");
  account();
});
const opened = [];
const openerPath = require.resolve("@tauri-apps/plugin-opener");
require.cache[openerPath] = { id: openerPath, filename: openerPath, loaded: true, exports: { openUrl: async (url) => opened.push(url) } };

function account() {
  activeOwner = owner;
  token = "access-test-only";
}

function browser() {
  const navigated = [];
  const tab = { opener: "original-opener", location: { replace: (url) => navigated.push(url) }, close: () => { tab.closed = true; }, closed: false };
  global.window = { open: () => tab, location: { assign: (url) => navigated.push(url) } };
  return { tab, navigated };
}

test("start returns an individual pending checkout for the internal owner", async (t) => {
  account();
  const calls = [];
  global.fetch = t.mock.fn(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => pending };
  });
  const result = await billing.startPremiumSubscription(owner);
  assert.equal(result.status, "pending");
  assert.equal(result.subscription_id, subscriptionId);
  assert.equal(result.checkout_url, checkoutUrl);
  assert.equal(calls[0].url, "https://cloud.test/billing/subscription");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-test-only");
  assert.equal(calls[0].options.body, undefined);
});

test("Premium UI offers Mercado Pago checkout and no card fields", () => {
  const html = renderToStaticMarkup(React.createElement(PremiumCheckout, { subscription: pending, premiumActive: false, local: false, busy: false, onContinue: () => {} }));
  assert.match(html, /Continuar con Mercado Pago/);
  assert.match(html, /mes/);
  assert.match(html, /Pago seguro procesado por Mercado Pago/);
  assert.doesNotMatch(html, /<input|<iframe|card-token|mp-card/);
  for (const subscription of [{ ...pending, status: "uncertain" }, { ...pending, status: "authorized" }]) {
    const disabled = renderToStaticMarkup(React.createElement(PremiumCheckout, { subscription, premiumActive: false, local: false, busy: false, onContinue: () => {} }));
    assert.doesNotMatch(disabled, /<button/);
  }
});

test("local mode and active Premium have no checkout CTA", () => {
  for (const props of [{ local: true, premiumActive: false }, { local: false, premiumActive: true }]) {
    const html = renderToStaticMarkup(React.createElement(PremiumCheckout, { subscription: pending, busy: false, onContinue: () => {}, ...props }));
    assert.doesNotMatch(html, /<button/);
  }
});

test("web reserves a tab before the request and opens the validated checkout without an opener", async () => {
  account();
  const { tab, navigated } = browser();
  const reserved = billing.preparePremiumCheckoutWindow();
  assert.equal(reserved, tab);
  assert.equal(tab.opener, null);
  await billing.openPremiumCheckout(owner, pending, reserved);
  assert.deepEqual(navigated, [checkoutUrl]);
  assert.equal(tab.closed, false);
});

test("desktop opens checkout using the official Tauri opener", async () => {
  account();
  global.window = { __TAURI_INTERNALS__: {} };
  assert.equal(billing.preparePremiumCheckoutWindow(), null);
  const before = opened.length;
  await billing.openPremiumCheckout(owner, pending);
  assert.deepEqual(opened.slice(before), [checkoutUrl]);
});

test("blocked browser popup uses safe same-tab navigation", async () => {
  account();
  const navigated = [];
  global.window = { open: () => null, location: { assign: (url) => navigated.push(url) } };
  await billing.openPremiumCheckout(owner, pending);
  assert.deepEqual(navigated, [checkoutUrl]);
});

test("invalid checkout or owner change cannot navigate and closes the reserved tab", async () => {
  account();
  for (const url of ["https://evil.test/", checkoutUrl.replace("https", "http"), checkoutUrl + "&preapproval_id=other", checkoutUrl + "&preapproval_plan_id=plan", checkoutUrl + "#fragment", checkoutUrl.replace("www.", "user@www.")]) {
    const { tab, navigated } = browser();
    await assert.rejects(billing.openPremiumCheckout(owner, { ...pending, checkout_url: url }, tab));
    assert.equal(tab.closed, true);
    assert.deepEqual(navigated, []);
  }
  const { tab, navigated } = browser();
  activeOwner = "another-owner";
  await assert.rejects(billing.openPremiumCheckout(owner, pending, tab));
  assert.equal(tab.closed, true);
  assert.deepEqual(navigated, []);
});

test("checkout eligibility blocks uncertain and reuses the existing pending link", () => {
  assert.equal(billing.canContinuePremium(pending, false), true);
  assert.equal(billing.canContinuePremium({ ...pending, status: "uncertain" }, false), false);
  assert.equal(billing.canContinuePremium({ ...pending, status: "authorized" }, false), false);
  assert.equal(billing.canContinuePremium({ ...pending, checkout_url: null }, false), false);
  assert.equal(billing.canContinuePremium(pending, true), false);
});

test("status messages use the real entitlement and verified rejection detail", () => {
  assert.match(billing.premiumStatusMessage(pending, false), /Mercado Pago/);
  assert.match(billing.premiumStatusMessage({ ...pending, status: "authorized" }, false), /Esperando/);
  assert.match(billing.premiumStatusMessage({ ...pending, status: "authorized", payment_status: "approved" }, false), /Esperando/);
  assert.equal(billing.premiumStatusMessage(pending, true), "Premium activado.");
  assert.match(billing.premiumStatusMessage({ ...pending, payment_status: "rejected" }, false), /rechazado.*otro medio/);
  assert.match(billing.premiumStatusMessage({ ...pending, payment_status: "rejected", payment_status_detail: "cc_rejected_high_risk" }, false), /seguridad de Mercado Pago/);
  assert.equal(billing.premiumStatusMessage({ ...pending, status: "uncertain" }, false), "Estamos verificando el estado con Mercado Pago.");
  assert.match(billing.premiumStatusMessage({ ...pending, status: "canceled" }, false), /cancelada/);
});

test("refresh remains scoped to the active account without a cancel API client", async (t) => {
  account();
  const paths = [];
  global.fetch = t.mock.fn(async (url) => {
    paths.push(url);
    return { ok: true, json: async () => ({ ...pending, status: "authorized", paid_until: "2026-11-01T00:00:00Z" }) };
  });
  assert.equal((await billing.refreshPremiumSubscription(owner)).status, "authorized");
  assert.equal(billing.cancelPremiumSubscription, undefined);
  assert.deepEqual(paths, ["https://cloud.test/billing/subscription/refresh"]);
  activeOwner = "other-owner";
  await assert.rejects(billing.refreshPremiumSubscription(owner));
  assert.equal(paths.length, 1);
});

test("the frontend has no direct cancellation entry or request", () => {
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(filename);
      else if (/\.tsx?$/.test(filename)) {
        assert.doesNotMatch(fs.readFileSync(filename, "utf8"), /cancelPremiumSubscription|\/billing\/subscription\/cancel|Cancelar suscripción/, filename);
      }
    }
  }
  for (const directory of ["app", "components", "services"]) inspect(path.join(root, directory));
});

function details(subscription, premiumActive) {
  return renderToStaticMarkup(React.createElement(PremiumSubscriptionDetails, { subscription, premiumActive }));
}

test("active subscriptions point to Mercado Pago management without constructing a URL", () => {
  const renewal = new Date(Date.now() + 30 * 86400000).toISOString();
  const html = details({ ...pending, status: "authorized", paid_until: renewal, next_payment_date: renewal }, true);
  assert.match(html, /Estado: Activo/);
  assert.match(html, /Premium activo\./);
  assert.match(html, /Próxima renovación:/);
  assert.match(html, /Para cancelar o administrar tu suscripción, hacelo desde tu cuenta de Mercado Pago\./);
  assert.doesNotMatch(html, /href=|https?:|<button|<a\b|provider123|Cancelar suscripción/);
});

test("canceled with a valid paid period displays remaining Premium without renewal", () => {
  const paidUntil = new Date(Date.now() + 30 * 86400000).toISOString();
  const html = details({ ...pending, status: "canceled", paid_until: paidUntil, next_payment_date: paidUntil }, true);
  assert.match(html, /Estado: Activo/);
  assert.match(html, /Tu suscripción está cancelada\. Tenés Premium hasta/);
  assert.ok(html.includes(new Date(paidUntil).toLocaleDateString("es-AR")));
  assert.doesNotMatch(html, /Próxima renovación|href=|<button/);
});

test("canceled with an expired period displays Free and cancellation", () => {
  const expired = new Date(Date.now() - 86400000).toISOString();
  const html = details({ ...pending, status: "canceled", paid_until: expired }, false);
  assert.match(html, /Estado: Free/);
  assert.match(html, /Suscripción cancelada\./);
  assert.doesNotMatch(html, /Tenés Premium hasta|Próxima renovación|Premium activo/);
});

test("paid_until alone never grants Premium and missing or invalid dates do not fabricate a period", () => {
  for (const paidUntil of [null, "invalid-date", new Date(Date.now() + 86400000).toISOString()]) {
    const html = details({ ...pending, status: "canceled", paid_until: paidUntil }, false);
    assert.match(html, /Estado: Free/);
    assert.doesNotMatch(html, /Tenés Premium hasta|Invalid Date/);
  }
});

test("network and uncertainty errors never expose provider bodies or access tokens", async (t) => {
  account();
  token = "private-test-token";
  global.fetch = t.mock.fn(async () => { throw new Error(token); });
  await assert.rejects(billing.refreshPremiumSubscription(owner), (error) => !error.message.includes(token));
  global.fetch = t.mock.fn(async () => ({ ok: false, json: async () => ({ detail: { code: "subscription_creation_unconfirmed", provider_body: "secret-provider-data" } }) }));
  await assert.rejects(billing.startPremiumSubscription(owner), (error) => !error.message.includes("secret-provider-data") && /soporte/.test(error.message));
});

test("a late response after JSON parsing cannot be applied to another owner", async (t) => {
  account();
  global.fetch = t.mock.fn(async () => ({ ok: true, json: async () => { activeOwner = "other-owner"; return pending; } }));
  await assert.rejects(billing.refreshPremiumSubscription(owner));
});
