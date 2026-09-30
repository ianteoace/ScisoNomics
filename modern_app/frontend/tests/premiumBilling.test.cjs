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
const checkout = "https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=123";

test("start uses the active internal owner token and opens only the provider URL", async (t) => {
  activeOwner = owner;
  token = "access-test-only";
  const calls = [];
  global.fetch = t.mock.fn(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ checkout_url: checkout }) };
  });
  assert.equal(await billing.startPremiumSubscription(owner), checkout);
  assert.equal(calls[0].url, "https://cloud.test/billing/subscription");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-test-only");
  assert.equal(calls[0].options.body, undefined);
  const opened = [];
  global.window = { open: (...args) => opened.push(args) };
  await billing.openPremiumCheckout(checkout);
  assert.equal(opened[0][0], checkout);
  assert.equal(opened[0][2], "noopener,noreferrer");
  await assert.rejects(billing.openPremiumCheckout("https://evil.test/checkout"));
  global.window = undefined;
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
  global.fetch = t.mock.fn(async () => ({ ok: true, json: async () => ({ status: "pending", paid_until: null, checkout_url: checkout, can_cancel: true }) }));
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
