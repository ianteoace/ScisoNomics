const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

const { ACCOUNT_SESSION_CHANGED_EVENT, OWNER_CHANGED_EVENT } = require("../services/cloudAuth.ts");
const { SYNC_STATE_CHANGED_EVENT } = require("../services/cloudSync.ts");
const { subscribeDashboardRefresh } = require("../services/dashboardRefresh.ts");

const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
const completedSync = (ownerId) => Object.assign(new Event(SYNC_STATE_CHANGED_EVENT), {
  detail: { status: "success", ownerId },
});

function setup(t, initialOwner = "local") {
  const target = new EventTarget();
  let ownerId = initialOwner;
  const reloads = [];
  const invalidations = [];
  const unsubscribe = subscribeDashboardRefresh({
    target,
    getOwnerId: () => ownerId,
    onReload: (value) => reloads.push(value),
    onInvalidate: (changed) => invalidations.push(changed),
    delayMs: 8,
  });
  t.after(unsubscribe);
  return { target, reloads, invalidations, setOwner: (value) => { ownerId = value; } };
}

test("dashboard requests its initial load on mount and local mode stays idle", async (t) => {
  const ctx = setup(t);
  await pause();
  assert.deepEqual(ctx.reloads, ["local"]);
  await pause();
  assert.deepEqual(ctx.reloads, ["local"]);
});

test("owner and session events coalesce into one reload for the new internal owner", async (t) => {
  const ctx = setup(t, "sciso-A");
  ctx.setOwner("sciso-B");
  ctx.target.dispatchEvent(new Event(OWNER_CHANGED_EVENT));
  ctx.target.dispatchEvent(new Event(ACCOUNT_SESSION_CHANGED_EVENT));
  await pause();
  assert.deepEqual(ctx.reloads, ["sciso-B"]);
  assert.ok(ctx.invalidations.includes(true));
});

test("completed auth hydration refreshes the active owner without changing it", async (t) => {
  const ctx = setup(t, "sciso-A");
  ctx.target.dispatchEvent(new Event(ACCOUNT_SESSION_CHANGED_EVENT));
  await pause();
  assert.deepEqual(ctx.reloads, ["sciso-A"]);
  assert.deepEqual(ctx.invalidations, [false, false]);
});

test("mount and immediate hydration or sync share one initial reload", async (t) => {
  const ctx = setup(t, "sciso-A");
  ctx.target.dispatchEvent(new Event(ACCOUNT_SESSION_CHANGED_EVENT));
  ctx.target.dispatchEvent(completedSync("sciso-A"));
  await pause();
  assert.deepEqual(ctx.reloads, ["sciso-A"]);
});

test("successful initial sync refreshes once; phase and failed sync events do not", async (t) => {
  const ctx = setup(t, "sciso-A");
  await pause();
  ctx.target.dispatchEvent(new Event(SYNC_STATE_CHANGED_EVENT));
  ctx.target.dispatchEvent(Object.assign(new Event(SYNC_STATE_CHANGED_EVENT), { detail: { status: "failed", ownerId: "sciso-A" } }));
  ctx.target.dispatchEvent(completedSync("sciso-A"));
  await pause();
  assert.deepEqual(ctx.reloads, ["sciso-A", "sciso-A"]);
});

test("a completed sync from another account never reloads the current owner", async (t) => {
  const ctx = setup(t, "sciso-B");
  await pause();
  ctx.target.dispatchEvent(completedSync("sciso-A"));
  await pause();
  assert.deepEqual(ctx.reloads, ["sciso-B"]);
});

test("bursts of account and sync events produce one reload", async (t) => {
  const ctx = setup(t, "sciso-A");
  await pause();
  for (let index = 0; index < 12; index += 1) {
    ctx.target.dispatchEvent(new Event(ACCOUNT_SESSION_CHANGED_EVENT));
    ctx.target.dispatchEvent(completedSync("sciso-A"));
  }
  await pause();
  assert.deepEqual(ctx.reloads, ["sciso-A", "sciso-A"]);
});

test("unmount removes listeners and cancels a queued reload", async () => {
  const target = new EventTarget();
  const reloads = [];
  const unsubscribe = subscribeDashboardRefresh({
    target,
    getOwnerId: () => "sciso-A",
    onReload: (value) => reloads.push(value),
    onInvalidate: () => {},
    delayMs: 8,
  });
  await pause();
  target.dispatchEvent(completedSync("sciso-A"));
  unsubscribe();
  target.dispatchEvent(completedSync("sciso-A"));
  await pause();
  assert.deepEqual(reloads, ["sciso-A"]);
});
