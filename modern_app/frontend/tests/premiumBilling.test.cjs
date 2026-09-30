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
const { MercadoPagoCardForm } = require("../components/billing/MercadoPagoCardForm.tsx");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const subscriptionId = "11111111-2222-4333-8444-555555555555";

test("start returns pending subscription for active internal owner", async (t) => {
  activeOwner = owner;
  token = "access-test-only";
  const calls = [];
  global.fetch = t.mock.fn(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: "pending", subscription_id: subscriptionId, amount: "4500.00" }) };
  });
  assert.equal((await billing.startPremiumSubscription(owner)).subscription_id, subscriptionId);
  assert.equal(calls[0].url, "https://cloud.test/billing/subscription");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-test-only");
  assert.equal(calls[0].options.body, undefined);
});

test("card token is sent only to the owned subscription endpoint", async (t) => {
  activeOwner = owner;
  token = "access-test-only";
  const calls = [];
  global.fetch = t.mock.fn(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: "authorized", paid_until: null }) };
  });
  const result = await billing.authorizePremiumSubscription(owner, subscriptionId, "cardtoken12345678");
  assert.equal(result.status, "authorized");
  assert.equal(result.paid_until, null);
  assert.equal(calls[0].url, `https://cloud.test/billing/subscription/${subscriptionId}/authorize`);
  assert.equal(calls[0].options.body, JSON.stringify({ card_token_id: "cardtoken12345678" }));
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-test-only");
  activeOwner = "other-internal-owner";
  await assert.rejects(billing.authorizePremiumSubscription(owner, subscriptionId, "cardtoken12345678"), /cuenta cloud activa/);
  assert.equal(calls.length, 1);
});

test("tokenization form renders provider-owned card fields", () => {
  const html = renderToStaticMarkup(React.createElement(MercadoPagoCardForm, { amount: "4500.00", onToken: async () => {}, onError: () => {} }));
  assert.match(html, /id="mp-card-number"/);
  assert.match(html, /id="mp-card-security"/);
  assert.doesNotMatch(html, /<input[^>]+(?:card-number|card-security)/);
  assert.match(html, /Confirmar tarjeta/);
});

test("refresh and cancel remain scoped to active account", async (t) => {
  activeOwner = owner;
  const paths = [];
  global.fetch = t.mock.fn(async (url) => {
    paths.push(url);
    return { ok: true, json: async () => ({ status: "authorized", paid_until: "2026-11-01T00:00:00Z" }) };
  });
  assert.equal((await billing.refreshPremiumSubscription(owner)).status, "authorized");
  assert.equal((await billing.cancelPremiumSubscription(owner)).status, "authorized");
  assert.deepEqual(paths, ["https://cloud.test/billing/subscription/refresh", "https://cloud.test/billing/subscription/cancel"]);
  activeOwner = "other-internal-owner";
  await assert.rejects(billing.refreshPremiumSubscription(owner), /cuenta cloud activa/);
  assert.equal(paths.length, 2);
});

test("pending subscription stays pending until the backend confirms payment", async (t) => {
  activeOwner = owner;
  token = "access-test-only";
  global.fetch = t.mock.fn(async () => ({ ok: true, json: async () => ({ status: "pending", paid_until: null, subscription_id: subscriptionId, amount: "4500.00", can_cancel: true }) }));
  const status = await billing.getPremiumSubscription(owner);
  assert.equal(status.status, "pending");
  assert.equal(status.paid_until, null);
});

test("network and pending errors are clear without exposing tokens", async (t) => {
  activeOwner = owner;
  token = "private-test-token";
  global.fetch = t.mock.fn(async () => { throw new Error("private-test-token"); });
  await assert.rejects(billing.refreshPremiumSubscription(owner), (error) => !error.message.includes(token));
  global.fetch = t.mock.fn(async () => ({ ok: false, json: async () => ({ detail: { code: "subscription_creation_unconfirmed" } }) }));
  await assert.rejects(billing.startPremiumSubscription(owner), /Contactá a soporte/);
  global.fetch = t.mock.fn(async () => ({ ok: false, json: async () => ({ detail: { code: "invalid_card_token", provider_body: "secret-card-data" } }) }));
  await assert.rejects(billing.authorizePremiumSubscription(owner, subscriptionId, "cardtoken12345678"), (error) => !error.message.includes("secret-card-data") && /Volvé a ingresarla/.test(error.message));
  token = "";
  await assert.rejects(billing.getPremiumSubscription(owner), /sesión cloud/);
});

test("a late provider response cannot be applied to another owner", async (t) => {
  activeOwner = owner;
  token = "access-test-only";
  global.fetch = t.mock.fn(async () => {
    activeOwner = "other-internal-owner";
    return { ok: true, json: async () => ({ status: "authorized" }) };
  });
  await assert.rejects(billing.refreshPremiumSubscription(owner), /Cambió la cuenta activa/);
});
