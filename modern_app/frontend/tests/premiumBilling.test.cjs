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
    getActiveOwnerId: () => activeOwner,
    getActiveAccount: () => activeOwner === "local" ? null : { user: { id: activeOwner } },
    getActiveCloudSessionAsync: async () => token ? { token, user: { id: activeOwner } } : null,
  },
};
process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL = "https://cloud.test";
const billing = require("../services/premiumBilling.ts");
const { PremiumCheckout } = require("../components/billing/PremiumCheckout.tsx");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const subscriptionId = "11111111-2222-4333-8444-555555555555";
const checkoutUrl = "https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=provider123";
const pending = { status: "pending", subscription_id: subscriptionId, amount: "4500.00", paid_until: null, checkout_url: checkoutUrl, can_cancel: true };
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
  assert.match(billing.premiumStatusMessage({ ...pending, status: "uncertain" }, false), /No intentes crear otra/);
  assert.match(billing.premiumStatusMessage({ ...pending, status: "canceled" }, false), /cancelada/);
});

test("refresh and cancel are scoped to the active account", async (t) => {
  account();
  const paths = [];
  global.fetch = t.mock.fn(async (url) => {
    paths.push(url);
    return { ok: true, json: async () => ({ ...pending, status: "authorized", paid_until: "2026-11-01T00:00:00Z" }) };
  });
  assert.equal((await billing.refreshPremiumSubscription(owner)).status, "authorized");
  await billing.cancelPremiumSubscription(owner);
  assert.deepEqual(paths, ["https://cloud.test/billing/subscription/refresh", "https://cloud.test/billing/subscription/cancel"]);
  activeOwner = "other-owner";
  await assert.rejects(billing.refreshPremiumSubscription(owner));
  assert.equal(paths.length, 2);
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
