const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

const { createAppUpdater, isPackagedTauriApp, AUTO_CHECK_KEY, DISMISSED_UPDATE_KEY } = require("../services/appUpdater.ts");
const { createManifest } = require("../../scripts/create-updater-manifest.cjs");

function fixture(overrides = {}) {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const calls = [];
  const update = {
    version: "3.2.2",
    download: async (onEvent) => {
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

test("same version from Tauri check does not offer an update", async () => {
  const { updater } = fixture({ check: async () => null });
  await updater.check(true);
  assert.equal(updater.getState().status, "up_to_date");
  assert.equal(updater.getState().version, null);
});

test("a newer signed release is offered and installed after safe preparation", async () => {
  const { updater, calls } = fixture();
  await updater.check(true);
  assert.equal(updater.getState().status, "available");
  assert.equal(updater.getState().version, "3.2.2");
  await updater.install();
  assert.deepEqual(calls.slice(0, 4), ["check", "download", "prepare", "install"]);
  assert.equal(updater.getState().progress, 100);
});

test("invalid metadata and network errors are clear, while startup failures stay quiet", async () => {
  const metadata = fixture({ check: async () => { throw new Error("invalid JSON metadata"); } });
  await metadata.updater.check(true);
  assert.match(metadata.updater.getState().error, /información.*no es válida/);
  const offline = fixture({ check: async () => { throw new Error("network request failed"); } });
  await offline.updater.check();
  assert.equal(offline.updater.getState().status, "idle");
  assert.equal(offline.updater.getState().error, null);
  await offline.updater.check(true);
  assert.match(offline.updater.getState().error, /conexión/);
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
  assert.equal(values.get(DISMISSED_UPDATE_KEY), "3.2.2");
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
  await updater.check(true);
  assert.equal(updater.getState().status, "unavailable");
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
  fs.writeFileSync(`${installer}.sig`, "invalid-signature");
  assert.throws(() => createManifest({ installerPath: installer, version: "3.2.2", tag: "v3.2.2" }), /firma/);
});
