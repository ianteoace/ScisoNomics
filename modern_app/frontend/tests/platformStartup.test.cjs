const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

for (const extension of [".ts", ".tsx"]) {
  require.extensions[extension] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
      fileName: filename,
    });
    module._compile(outputText, filename);
  };
}

let ownerReads = 0;
const root = path.resolve(__dirname, "..");
function stub(filename, exports) {
  const resolved = filename.startsWith(".") ? path.resolve(root, filename) : require.resolve(filename);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub("./services/cloudAuth.ts", { getActiveOwnerId: () => { ownerReads++; return "internal-owner"; } });
stub("next/navigation", { useRouter: () => ({ replace: () => {} }), usePathname: () => "/dashboard" });
stub("./components/account/SupabaseOAuthListener.tsx", { SupabaseOAuthListener: () => { throw new Error("Mobile mounted desktop OAuth"); } });
stub("./components/account/DeviceVerificationDialog.tsx", { DeviceVerificationDialog: () => null });
let initializeMobile = async () => ({});
stub("./services/data/mobileDatabase.ts", { getMobileDatabase: () => initializeMobile() });
stub("./components/mobile/MobileApp.tsx", { MobileApp: () => React.createElement("p", {}, "App mobile: almacenamiento local listo") });
stub("./components/mobile/account/MobileAccountProvider.tsx", { MobileAccountProvider: ({ children }) => children });

const { getRuntimePlatformSync } = require("../services/platform.ts");
const http = require("../services/http.ts");
const { BackendStartupGate, StartupScreen } = require("../components/app/BackendStartupGate.tsx");
const { Providers } = require("../components/ui/Providers.tsx");

function runtime(t, os, userAgent = { windows: "Windows NT", android: "Android", ios: "iPhone" }[os] || "") {
  const oldWindow = global.window;
  const oldDocument = global.document;
  const calls = [];
  const native = os !== "browser";
  global.window = {
    navigator: { userAgent, platform: os === "ios" ? "iPhone" : "", maxTouchPoints: 0 },
    setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args),
    localStorage: { removeItem: () => {} },
    ...(native ? { __TAURI_INTERNALS__: {
      get plugins() { throw new Error("Startup must not read native path metadata"); },
      get convertFileSrc() { throw new Error("Startup must not use convertFileSrc"); },
      invoke: async (command) => { calls.push(command); return "dummy-local-token"; },
    } } : {}),
  };
  global.document = { documentElement: { classList: { add() {}, remove() {} } } };
  t.after(() => { global.window = oldWindow; global.document = oldDocument; });
  return calls;
}

// Mount the real functional components with isolated hook slots and effect
// cleanup. Resolve children only when their parent actually renders them.
function renderer(t, Component, props) {
  const instances = new Map();
  const testWindow = global.window;
  let current, pending = [];
  // Mobile must render even with the hydration snapshot still false.
  t.mock.method(React, "useSyncExternalStore", () => false);
  t.mock.method(React, "useState", (initial) => {
    const instance = current, index = instance.cursor++;
    if (!(index in instance.slots)) instance.slots[index] = typeof initial === "function" ? initial() : initial;
    return [instance.slots[index], (value) => { instance.slots[index] = typeof value === "function" ? value(instance.slots[index]) : value; }];
  });
  t.mock.method(React, "useEffect", (callback, deps) => {
    const instance = current, index = instance.cursor++, previous = instance.slots[index];
    if (!previous || deps.some((value, n) => value !== previous.deps[n])) {
      pending.push(() => { previous?.cleanup?.(); instance.slots[index] = { deps, cleanup: callback() }; });
    }
  });
  function resolve(node, key) {
    if (Array.isArray(node)) return node.map((child, i) => resolve(React.isValidElement(child) ? React.cloneElement(child, { key: child.key ?? i }) : child, `${key}.${i}`));
    if (!React.isValidElement(node)) return node;
    if (typeof node.type === "function") {
      const instanceKey = `${key}:${node.type.name}`;
      if (!instances.has(instanceKey)) instances.set(instanceKey, { slots: [], cursor: 0 });
      current = instances.get(instanceKey); current.cursor = 0;
      return resolve(node.type(node.props), `${instanceKey}.render`);
    }
    return React.cloneElement(node, {}, resolve(node.props.children, `${key}.children`));
  }
  function dispose() {
    const previousWindow = global.window;
    global.window = testWindow;
    try {
      for (const instance of instances.values()) for (const slot of instance.slots) {
        slot?.cleanup?.();
        if (slot?.cleanup) slot.cleanup = undefined;
      }
    } finally { global.window = previousWindow; }
  }
  t.after(dispose);
  return {
    render: () => renderToStaticMarkup(resolve(React.createElement(Component, props), "root")),
    tree: () => resolve(React.createElement(Component, props), "root"),
    effects: () => { const effects = pending; pending = []; for (const effect of effects) effect(); },
    dispose,
  };
}

test("SSR returns browser synchronously and preserves static startup markup", (t) => {
  runtime(t, "browser");
  global.window = undefined;
  assert.equal(getRuntimePlatformSync(), "browser");
  const view = renderer(t, Providers, { children: React.createElement("p", {}, "financial page") });
  assert.match(view.render(), /Iniciando ScisoNomics/);
  assert.doesNotMatch(view.render(), /financial page/);
});

for (const agent of ["Mozilla/5.0 Windows NT 10.0 Chrome/130", "Android", "iPhone"]) {
  test(`a browser without Tauri stays browser: ${agent}`, (t) => {
    runtime(t, "browser", agent);
    assert.equal(getRuntimePlatformSync(), "browser");
  });
}

for (const [os, agent, expected] of [
  ["windows", "Mozilla/5.0 Windows NT 10.0", "desktop"],
  ["android", "Mozilla/5.0 Linux Android 15", "android"],
  ["ios", "Mozilla/5.0 iPhone", "ios"],
  ["ios", "Mozilla/5.0 iPad", "ios"],
  ["ios", "Mozilla/5.0 iPod", "ios"],
  ["macos", "Macintosh", "desktop"],
  ["linux", "Linux", "desktop"],
]) {
  test(`Tauri ${agent} returns ${expected} without a promise or native API call`, (t) => {
    const nativeCalls = runtime(t, os, agent);
    const platform = getRuntimePlatformSync();
    assert.equal(platform, expected);
    assert.equal(typeof platform, "string");
    assert.equal(platform.then, undefined);
    assert.deepEqual(nativeCalls, []);
  });
}

test("Tauri detection checks marker presence without reading native internals", (t) => {
  runtime(t, "android");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { get() { throw new Error("Native bridge read"); } });
  assert.equal(getRuntimePlatformSync(), "android");
});

test("Tauri iPad desktop mode returns ios synchronously", (t) => {
  runtime(t, "ios", "Mozilla/5.0 iPhone");
  Object.assign(window.navigator, { userAgent: "Mozilla/5.0 Macintosh", platform: "MacIntel", maxTouchPoints: 5 });
  assert.equal(getRuntimePlatformSync(), "ios");
});

for (const [os, agent] of [["android", "Android"], ["ios", "iPhone"]]) {
  test(`${os} blocks reads, writes, headers and local token access before any request`, async (t) => {
    const nativeCalls = runtime(t, os, agent);
    ownerReads = 0;
    const requests = [];
    t.mock.method(global, "fetch", async (...args) => { requests.push(args); throw new Error("Unexpected localhost request"); });
    const error = /Desktop local API is not available on mobile\./;
    await assert.rejects(http.getJSON("/health"), error);
    await assert.rejects(http.sendJSON("/movimientos", "POST", { amount: 1 }), error);
    await assert.rejects(http.getLocalRequestHeaders(undefined, undefined, true), error);
    await assert.rejects(http.getLocalRequestSecurity(), error);
    assert.throws(() => http.localOwnerHeaders(), error);
    assert.throws(() => http.getLocalRequestSecuritySnapshot(), error);
    assert.deepEqual(requests, []);
    assert.deepEqual(nativeCalls, []);
    assert.equal(ownerReads, 0);
  });
}

for (const [os, agent] of [["android", "Android"], ["ios", "iPhone"]]) {
  test(`${os} startup opens SQLite before its app without health, ready or desktop children`, async (t) => {
    runtime(t, os, agent);
    let resolveDatabase, opens = 0;
    initializeMobile = () => { opens++; return new Promise((resolve) => { resolveDatabase = resolve; }); };
    t.after(() => { initializeMobile = async () => ({}); });
    t.mock.method(global, "fetch", () => { throw new Error("Unexpected request"); });
    let childMounts = 0;
    const FinancialPage = () => { childMounts++; return React.createElement("p", {}, "financial page"); };
    const view = renderer(t, Providers, { children: React.createElement(BackendStartupGate, {}, React.createElement(FinancialPage)) });
    const initial = view.render();
    assert.match(initial, /Preparando ScisoNomics Mobile/);
    assert.doesNotMatch(initial, /Iniciando ScisoNomics/);
    view.effects();
    assert.equal(opens, 1);
    assert.match(view.render(), /Preparando ScisoNomics Mobile/);
    resolveDatabase({}); await new Promise(setImmediate);
    const html = view.render();
    assert.match(html, /App mobile: almacenamiento local listo/);
    assert.doesNotMatch(html, /financial page|animate-spin/);
    assert.equal(childMounts, 0);
    assert.equal(global.fetch.mock.callCount(), 0);
    assert.equal(view.render(), html);
  });
}

test("mobile initialization cannot update an unmounted gate", async (t) => {
  runtime(t, "android");
  let resolveDatabase;
  initializeMobile = () => new Promise((resolve) => { resolveDatabase = resolve; });
  t.after(() => { initializeMobile = async () => ({}); });
  const view = renderer(t, BackendStartupGate, { children: null });
  assert.match(view.render(), /Preparando ScisoNomics Mobile/); view.effects();
  view.dispose(); resolveDatabase({}); await new Promise(setImmediate);
  assert.match(view.render(), /Preparando ScisoNomics Mobile/);
});

test("mobile initialization failure is recoverable and hides native errors", async (t) => {
  runtime(t, "android");
  initializeMobile = async () => { throw new Error("private/native/path SELECT secret"); };
  t.after(() => { initializeMobile = async () => ({}); });
  const view = renderer(t, BackendStartupGate, { children: null });
  view.render(); view.effects(); await new Promise(setImmediate);
  const html = view.render();
  assert.match(html, /No se pudo abrir el almacenamiento local/);
  assert.match(html, /Reintentar/);
  assert.doesNotMatch(html, /private|secret/);
  const tree = view.tree();
  const button = tree.props.children.props.children[2];
  initializeMobile = async () => ({});
  button.props.onClick(); view.render(); view.effects(); await new Promise(setImmediate);
  assert.match(view.render(), /App mobile: almacenamiento local listo/);
});

test("Windows local API retains owner and token headers and request bodies", async (t) => {
  const nativeCalls = runtime(t, "windows");
  const requests = [];
  t.mock.method(global, "fetch", async (url, options) => { requests.push({ url, options }); return Response.json({ ok: true }); });
  assert.deepEqual(await http.getJSON("/settings/info"), { ok: true });
  await http.sendJSON("/movimientos", "POST", { amount: 20 });
  assert.equal(requests[0].url, `${http.API_URL}/settings/info`);
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[0].options.headers["X-Scisonomics-Owner-Id"], "internal-owner");
  assert.equal(requests[0].options.headers["X-Scisonomics-Local-Token"], "dummy-local-token");
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.body, '{"amount":20}');
  assert.deepEqual(nativeCalls, ["get_local_api_token"]);
  // A token cached by desktop must not bypass the mobile guard.
  window.navigator.userAgent = "Android";
  await assert.rejects(http.getJSON("/ready"), /Desktop local API is not available on mobile/);
  assert.equal(requests.length, 2);
});

test("the static startup title is replaced during hydration without waiting for platform effects", (t) => {
  runtime(t, "android");
  const mobileMarkup = renderToStaticMarkup(StartupScreen({ title: "Preparando ScisoNomics Mobile" }));
  const serverMarkup = renderToStaticMarkup(StartupScreen({ title: "Iniciando ScisoNomics" }));
  assert.equal(serverMarkup.replace("Iniciando ScisoNomics", "Preparando ScisoNomics Mobile"), mobileMarkup);
  const heading = { textContent: "Iniciando ScisoNomics" };
  const tree = StartupScreen({ title: "Preparando ScisoNomics Mobile" });
  tree.props.children.props.children[0].ref(heading);
  assert.equal(heading.textContent, "Preparando ScisoNomics Mobile");
});

test("development logs platform once with only tauri and platform fields", (t) => {
  runtime(t, "android");
  const environment = process.env.NODE_ENV;
  t.after(() => { if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment; });
  process.env.NODE_ENV = "development";
  const messages = [];
  t.mock.method(console, "info", (...args) => messages.push(args));
  assert.equal(getRuntimePlatformSync(), "android");
  getRuntimePlatformSync();
  BackendStartupGate({ children: null });
  assert.deepEqual(messages, [["[platform]", { tauri: true, platform: "android" }]]);
});

test("Windows startup still checks health and ready before rendering children", async (t) => {
  runtime(t, "windows");
  t.mock.method(console, "info", () => {});
  const version = require("../package.json").version, requests = [];
  t.mock.method(global, "fetch", async (url) => {
    requests.push(url);
    return Response.json(url.endsWith("/health") ? { ok: true, version } : { ok: true, status: "ready", database_ready: true, version });
  });
  const view = renderer(t, BackendStartupGate, { children: React.createElement("p", {}, "financial page") });
  assert.doesNotMatch(view.render(), /financial page/); view.effects();
  assert.match(view.render(), /Iniciando ScisoNomics/); view.effects();
  await new Promise(setImmediate);
  assert.match(view.render(), /financial page/);
  assert.deepEqual(requests, [`${http.API_URL}/health`, `${http.API_URL}/ready`]);
});

test("Windows startup still blocks incompatible versions", async (t) => {
  runtime(t, "windows");
  t.mock.method(console, "info", () => {}); t.mock.method(console, "error", () => {});
  const requests = [];
  t.mock.method(global, "fetch", async (url) => { requests.push(url); return Response.json({ ok: true, version: "0.0.1" }); });
  const view = renderer(t, BackendStartupGate, { children: React.createElement("p", {}, "financial page") });
  view.render(); view.effects(); view.render(); view.effects(); await new Promise(setImmediate);
  const html = view.render();
  assert.match(html, /No se pudo iniciar ScisoNomics/);
  assert.match(html, /incompatibilidad/);
  assert.doesNotMatch(html, /financial page/);
  assert.equal(requests.length, 1);
});
