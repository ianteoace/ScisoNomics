const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
let pathname = "/configuracion";
const navigationPath = require.resolve("next/navigation");
require.cache[navigationPath] = { id: navigationPath, filename: navigationPath, loaded: true, exports: { usePathname: () => pathname } };

require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(outputText, filename);
};
require.extensions[".tsx"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: filename,
  });
  module._compile(outputText, filename);
};

const { createAppUpdater, createNativeAppUpdater, isPackagedTauriApp, isNewerAppVersion, AUTO_CHECK_KEY, DISMISSED_UPDATE_KEY, UPDATE_CHECK_TIMEOUT_MS, UPDATE_DOWNLOAD_TIMEOUT_MS } = require("../services/appUpdater.ts");
const { createManifest } = require("../../scripts/create-updater-manifest.cjs");
const { AppUpdateContext, AppUpdateBanner, AppUpdateSettings, useManualUpdateCheck } = require("../components/app/AppUpdateProvider.tsx");

// Execute the real feedback hook with deterministic effect cleanup and timers.
function feedbackFixture(t, updater, notify = false) {
  const slots = [], effects = [], timers = new Map();
  let cursor = 0;
  pathname = "/configuracion";
  const oldWindow = global.window;
  global.window = { setTimeout: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id) };
  t.after(() => { global.window = oldWindow; });
  t.mock.method(React, "useState", (initial) => {
    const i = cursor++; if (!(i in slots)) slots[i] = initial;
    return [slots[i], (value) => { slots[i] = value; }];
  });
  t.mock.method(React, "useRef", (initial) => { const i = cursor++; return slots[i] ||= { current: initial }; });
  t.mock.method(React, "useEffect", (callback, deps) => {
    const i = cursor++, old = slots[i];
    if (!old || deps.some((dep, n) => dep !== old.deps[n])) {
      effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; });
    }
  });
  function render() { cursor = 0; const result = useManualUpdateCheck(updater, notify); while (effects.length) effects.shift()(); return result; }
  return { render, timers, navigate: (path) => { pathname = path; render(); return render(); }, expire: () => { for (const { fn } of timers.values()) fn(); timers.clear(); }, unmount: () => { for (const slot of slots) slot?.cleanup?.(); } };
}

test("manual up-to-date feedback expires and navigation cannot replay it", async (t) => {
  const { updater, values } = fixture({ check: async () => null });
  const ui = feedbackFixture(t, updater);
  await ui.render().check();
  assert.equal(ui.render().feedback, "ScisoNomics está actualizado.");
  assert.equal(updater.getState().status, "idle");
  assert.equal(values.size, 0);
  assert.equal([...ui.timers.values()][0].ms, 4000);
  ui.expire(); assert.equal(ui.render().feedback, null);
  await ui.render().check();
  assert.equal(ui.navigate("/dashboard").feedback, null);
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.navigate("/configuracion").feedback, null);
  ui.unmount();
});

test("manual error is local, sanitized and temporary", async (t) => {
  const { updater } = fixture({ check: async () => { throw new Error("timeout token=secret signed-url?private=123"); } });
  const ui = feedbackFixture(t, updater); await ui.render().check();
  assert.match(ui.render().feedback, /conexión/);
  assert.doesNotMatch(ui.render().feedback, /secret|private|123/);
  assert.deepEqual([updater.getState().status, updater.getState().error], ["idle", null]);
  ui.expire(); assert.equal(ui.render().feedback, null); ui.unmount();
});

test("banner retry uses one temporary toast that is dismissed on navigation", async (t) => {
  const { toast } = require("sonner"), messages = [], dismissed = [];
  t.mock.method(toast, "info", (message, options) => { messages.push({ message, options }); return "updater-feedback"; });
  t.mock.method(toast, "dismiss", (id) => { dismissed.push(id); });
  const { updater, values } = fixture({ check: async () => null });
  const ui = feedbackFixture(t, updater, true), action = ui.render();
  await Promise.all([action.check(), action.check()]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message, "ScisoNomics está actualizado.");
  assert.deepEqual(messages[0].options, { duration: 4000 });
  assert.equal(updater.getState().status, "idle"); assert.equal(values.size, 0);
  ui.navigate("/dashboard"); assert.deepEqual(dismissed, ["updater-feedback"]);
  assert.equal(ui.timers.size, 0); assert.equal(ui.render().feedback, null); ui.unmount();
});

test("feedback hook ignores results after navigation or unmount and prevents double-click notifications", async (t) => {
  let complete, checks = 0;
  const { updater } = fixture({ check: () => { checks++; return new Promise((resolve) => { complete = resolve; }); } });
  const ui = feedbackFixture(t, updater), action = ui.render();
  const first = action.check(), second = action.check();
  ui.navigate("/metas"); complete(null); await Promise.all([first, second]);
  assert.equal(checks, 1); assert.equal(ui.render().feedback, null); assert.equal(ui.timers.size, 0);
  const pending = ui.render().check(); ui.unmount(); complete(null); await pending;
  assert.equal(ui.timers.size, 0);
});

test("automatic up-to-date and errors are silent and a manual check replaces the startup attempt", async () => {
  const f = fixture({ check: async () => null }); await f.updater.checkOnStartup();
  assert.equal(f.updater.getState().status, "idle"); assert.equal(f.updater.getState().error, null);
  const manual = fixture(); await manual.updater.check(true); await manual.updater.checkOnStartup();
  assert.deepEqual(manual.calls, ["check"]);
  const bad = fixture({ check: async () => { throw new Error("invalid manifest"); } });
  await bad.updater.checkOnStartup(); await bad.updater.checkOnStartup();
  assert.equal(bad.updater.getState().status, "idle"); assert.equal(bad.updater.getState().error, null);
});

for (const [version, newer] of [["3.3.1", true], ["3.4.0", true], ["3.3.0", false], ["3.2.9", false], ["3.3.0-beta.1", false], ["3.3.0+build.2", false]]) {
  test(`native candidate ${version} compared with 3.3.0 cannot downgrade`, async () => {
    const f = fixture(); f.update.version = version; f.update.rawJson = manifest(version);
    await f.updater.check(true);
    assert.equal(isNewerAppVersion(version, "3.3.0"), newer);
    assert.equal(f.updater.getState().status, newer ? "available" : "idle");
    if (!newer) { await f.updater.install(); assert.deepEqual(f.calls, ["check", "close"]); }
  });
}

test("SemVer prerelease ordering and invalid versions are handled safely", () => {
  assert.equal(isNewerAppVersion("3.3.0-beta.10", "3.3.0-beta.2"), true);
  assert.equal(isNewerAppVersion("3.3.0", "3.3.0-rc.1"), true);
  for (const version of ["03.3.1", "3.3", "3.3.1-01", "3.3.1-..", "3.3.1/evil"]) {
    assert.throws(() => isNewerAppVersion(version, "3.3.0"), /version/);
  }
});

test("arbitrary manifest URL, platform, signature or version cannot be downloaded", async () => {
  const bad = [
    { platforms: { "windows-x86_64": { ...manifest("3.3.1").platforms["windows-x86_64"], url: "http://github.com/ianteoace/scisonomics/evil.exe" } } },
    { platforms: { "windows-x86_64": { ...manifest("3.3.1").platforms["windows-x86_64"], url: "https://github.com.evil.test/evil.exe" } } },
    { platforms: { "windows-x86_64": { ...manifest("3.3.1").platforms["windows-x86_64"], url: manifest("3.3.1").platforms["windows-x86_64"].url + "?secret=token" } } },
    { platforms: { "windows-x86_64": { url: manifest("3.3.1").platforms["windows-x86_64"].url, signature: "bad-signature" } } },
    { platforms: {} }, { version: "3.4.0" },
  ];
  for (const patch of bad) {
    const f = fixture(); f.update.rawJson = { ...f.update.rawJson, ...patch };
    const result = await f.updater.check(true); assert.equal(result.status, "error");
    await f.updater.install(); assert.deepEqual(f.calls, ["check", "close"]); assert.equal(f.updater.getState().status, "idle");
  }
});

test("startup/manual race shares one check and reveals even a postponed version", async () => {
  let complete;
  const f = fixture({ check: () => new Promise((resolve) => { complete = resolve; }) });
  f.values.set(DISMISSED_UPDATE_KEY, f.update.version);
  const auto = f.updater.checkOnStartup(), manual = f.updater.check(true);
  complete(f.update); await Promise.all([auto, manual]);
  assert.equal(f.updater.getState().status, "available");
});

test("download/install requests are serialized and ready remains global", async () => {
  const f = fixture(); let finish;
  f.update.download = () => { f.calls.push("download"); return new Promise((resolve) => { finish = resolve; }); };
  await f.updater.check(true);
  const first = f.updater.install(), second = f.updater.install();
  assert.equal(f.updater.getState().status, "downloading");
  assert.equal((await f.updater.check(true)).status, "skipped");
  finish(); await Promise.all([first, second]);
  assert.deepEqual(f.calls, ["check", "download", "prepare", "install"]);
  assert.equal(f.updater.getState().status, "ready");
  await f.updater.check(true); await f.updater.install(); assert.equal(f.calls.length, 4);
});

test("disposal releases a late candidate and removes duplicate subscriptions", async () => {
  let complete;
  const f = fixture({ check: () => new Promise((resolve) => { complete = resolve; }) });
  let notified = 0; const listener = () => { notified++; };
  const unsubscribe = f.updater.subscribe(listener); f.updater.subscribe(listener);
  const checking = f.updater.check(); assert.equal(notified, 1);
  unsubscribe(); const disposed = f.updater.dispose(); complete(f.update);
  await Promise.all([checking, disposed]);
  assert.equal(notified, 1); assert.deepEqual(f.calls, ["close"]);
  assert.equal((await f.updater.check(true)).status, "skipped");
});

test("no global banner or stale settings feedback survives an up-to-date check", async (t) => {
  const f = fixture({ check: async () => null }); await f.updater.check(true);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, snapshot) => snapshot());
  const render = (component) => renderToStaticMarkup(React.createElement(AppUpdateContext.Provider, { value: f.updater }, React.createElement(component)));
  assert.equal(render(AppUpdateBanner), "");
  assert.doesNotMatch(render(AppUpdateSettings), /actualizado|más reciente|No hay actualizaciones/);
});

test("available, download and ready have a single global banner", async (t) => {
  const f = fixture(); await f.updater.check(true);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, snapshot) => snapshot());
  const render = () => renderToStaticMarkup(React.createElement(AppUpdateContext.Provider, { value: f.updater }, React.createElement(AppUpdateBanner)));
  assert.match(render(), /Nueva versión disponible: v3.3.1/);
  let finish; f.update.download = () => new Promise((resolve) => { finish = resolve; });
  const install = f.updater.install(); assert.match(render(), /Descargando/); finish(); await install;
  assert.match(render(), /se instaló/);
});

test("safe preparation failure remains actionable without launching the installer", async (t) => {
  const f = fixture({ prepareInstall: async () => { f.calls.push("prepare"); throw new Error("cierre seguro fallo"); } });
  await f.updater.check(true); await f.updater.install();
  assert.deepEqual(f.calls, ["check", "download", "prepare"]);
  assert.equal(f.updater.getState().status, "error");
  t.mock.method(React, "useSyncExternalStore", (_subscribe, snapshot) => snapshot());
  const html = renderToStaticMarkup(React.createElement(AppUpdateContext.Provider, { value: f.updater }, React.createElement(AppUpdateBanner)));
  assert.match(html, /cerrar la app de forma segura/); assert.match(html, /Buscar de nuevo/);
});

test("a failed recheck preserves an already validated available candidate", async () => {
  let fail = false;
  const f = fixture({ check: async () => { if (fail) throw new Error("network timeout"); return f.update; } });
  await f.updater.check(true); fail = true;
  assert.equal((await f.updater.check(true)).status, "error");
  assert.equal(f.updater.getState().status, "available");
  assert.equal(f.updater.getState().version, "3.3.1");
  await f.updater.install(); assert.deepEqual(f.calls, ["download", "prepare", "install"]);
});

test("disposing during download waits for the native resource and skips installation", async () => {
  const f = fixture(); let finish;
  f.update.download = () => { f.calls.push("download"); return new Promise((resolve) => { finish = resolve; }); };
  await f.updater.check(true); const installing = f.updater.install(), disposed = f.updater.dispose();
  assert.deepEqual(f.calls, ["check", "download"]);
  finish(); await Promise.all([installing, disposed]);
  assert.deepEqual(f.calls, ["check", "download", "close"]);
});

test("native check has a finite timeout and never enables downgrades", async (t) => {
  const plugin = require.resolve("@tauri-apps/plugin-updater"), old = require.cache[plugin];
  const oldWindow = global.window, oldEnv = process.env.NODE_ENV;
  t.after(() => { require.cache[plugin] = old; global.window = oldWindow; if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv; });
  let options;
  require.cache[plugin] = { id: plugin, filename: plugin, loaded: true, exports: { check: async (value) => { options = value; return null; } } };
  global.window = { __TAURI_INTERNALS__: {}, localStorage: null }; process.env.NODE_ENV = "production";
  const updater = createNativeAppUpdater(); await updater.check(true);
  assert.deepEqual(options, { timeout: UPDATE_CHECK_TIMEOUT_MS, allowDowngrades: false }); await updater.dispose();
});

function fixture(overrides = {}) {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const calls = [];
  const update = {
    currentVersion: "3.3.0",
    version: "3.3.1",
    rawJson: manifest("3.3.1"),
    download: async (onEvent, options) => {
      assert.equal(options.timeout, UPDATE_DOWNLOAD_TIMEOUT_MS);
      calls.push("download");
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 100 } });
      onEvent({ event: "Finished" });
    },
    install: async () => { calls.push("install"); },
    close: async () => { calls.push("close"); },
  };
  const deps = {
    supported: () => true,
    check: async () => { calls.push("check"); return update; },
    prepareInstall: async () => { calls.push("prepare"); },
    restartAfterFailedInstall: async () => { calls.push("restart"); },
    storage,
    ...overrides,
  };
  return { updater: createAppUpdater(deps), values, calls, update };
}

function manifest(version) {
  return { version, platforms: { "windows-x86_64": { url: `https://github.com/ianteoace/scisonomics/releases/download/${encodeURIComponent(`v${version}`)}/${encodeURIComponent(`ScisoNomics_${version}_x64-setup.exe`)}`, signature: Buffer.alloc(100, 1).toString("base64") } } };
}

test("same version from Tauri check does not offer an update", async () => {
  const { updater } = fixture({ check: async () => null });
  const result = await updater.check(true);
  assert.equal(result.status, "up_to_date");
  assert.equal(result.message, "ScisoNomics está actualizado.");
  assert.equal(updater.getState().status, "idle");
  assert.equal(updater.getState().version, null);
});

test("a newer signed release is offered and installed after safe preparation", async () => {
  const { updater, calls } = fixture();
  await updater.check(true);
  assert.equal(updater.getState().status, "available");
  assert.equal(updater.getState().version, "3.3.1");
  await updater.install();
  assert.deepEqual(calls.slice(0, 4), ["check", "download", "prepare", "install"]);
  assert.equal(updater.getState().progress, 100);
  assert.equal(updater.getState().status, "ready");
});

test("invalid metadata and network errors are clear, while startup failures stay quiet", async () => {
  const metadata = fixture({ check: async () => { throw new Error("invalid JSON metadata"); } });
  const metadataResult = await metadata.updater.check(true);
  assert.match(metadataResult.message, /información.*no es válida/);
  assert.equal(metadata.updater.getState().status, "idle");
  assert.equal(metadata.updater.getState().error, null);
  const offline = fixture({ check: async () => { throw new Error("network request failed"); } });
  await offline.updater.check();
  assert.equal(offline.updater.getState().status, "idle");
  assert.equal(offline.updater.getState().error, null);
  assert.match((await offline.updater.check(true)).message, /conexión/);
  assert.equal(offline.updater.getState().status, "idle");
});

test("invalid signature prevents sidecar shutdown and installer launch", async () => {
  const { updater, update, calls } = fixture();
  update.download = async () => { calls.push("download"); throw new Error("minisign signature verification failed"); };
  await updater.check(true);
  await updater.install();
  assert.match(updater.getState().error, /firma.*no es válida/);
  assert.deepEqual(calls, ["check", "download"]);
});

test("postponing hides the same release automatically, but manual check can show it", async () => {
  const { updater, values } = fixture();
  await updater.check();
  updater.postpone();
  assert.equal(values.get(DISMISSED_UPDATE_KEY), "3.3.1");
  assert.equal(updater.getState().status, "idle");
  await updater.check();
  assert.equal(updater.getState().status, "idle");
  await updater.check(true);
  assert.equal(updater.getState().status, "available");
  assert.deepEqual([...values.keys()], [DISMISSED_UPDATE_KEY]);
});

test("automatic checks can be disabled without disabling manual checks", async () => {
  const { updater, values, calls } = fixture();
  updater.setAutoCheckEnabled(false);
  assert.equal(values.get(AUTO_CHECK_KEY), "false");
  await updater.check();
  assert.deepEqual(calls, []);
  await updater.check(true);
  assert.deepEqual(calls, ["check"]);
});

test("concurrent checks share one network request", async () => {
  let resolveCheck;
  const pending = new Promise((resolve) => { resolveCheck = resolve; });
  const { updater, calls, update } = fixture({ check: async () => { calls.push("check"); return pending; } });
  const first = updater.check();
  const second = updater.check();
  resolveCheck(update);
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["check"]);
});

test("unpackaged/dev app does not call updater", async () => {
  const { updater, calls } = fixture({ supported: () => false });
  await updater.check();
  assert.deepEqual(calls, []);
  assert.equal((await updater.check(true)).status, "unavailable");
  assert.equal(updater.getState().status, "idle");
  assert.equal(isPackagedTauriApp(), false);
});

test("failed install restarts app so the local sidecar can be restored", async () => {
  const { updater, update, calls } = fixture();
  update.install = async () => { calls.push("install"); throw new Error("installer failed"); };
  await updater.check(true);
  await updater.install();
  assert.deepEqual(calls.slice(0, 5), ["check", "download", "prepare", "install", "restart"]);
});

test("release metadata uses the signed NSIS installer and the internal app version", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sciso-updater-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const installer = path.join(dir, "ScisoNomics_3.2.2_x64-setup.exe");
  fs.writeFileSync(installer, "test installer");
  fs.writeFileSync(`${installer}.sig`, Buffer.alloc(100, 1).toString("base64"));
  const manifest = createManifest({ installerPath: installer, version: "3.2.2", tag: "v3.2.2" });
  assert.equal(manifest.version, "3.2.2");
  assert.equal(manifest.platforms["windows-x86_64"].url,
    "https://github.com/ianteoace/scisonomics/releases/download/v3.2.2/ScisoNomics_3.2.2_x64-setup.exe");
  assert.ok(manifest.platforms["windows-x86_64"].signature);
  assert.throws(() => createManifest({ installerPath: installer, version: "3.2.2", tag: "v3.2.1" }), /tag/);
  for (const version of ["03.3.1", "3.3.1-01", "3.3.1-..", "3.3.1/evil"]) {
    assert.throws(() => createManifest({ installerPath: installer, version, tag: `v${version}` }), /SemVer/);
  }
  fs.writeFileSync(`${installer}.sig`, "invalid-signature");
  assert.throws(() => createManifest({ installerPath: installer, version: "3.2.2", tag: "v3.2.2" }), /firma/);
});
