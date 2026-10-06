const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
function nextConfig(env) {
  const context = { process: { env }, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "next.config.js"), "utf8"), context);
  return context.module.exports;
}
const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

test("development defaults to localhost assets/HMR and permits the mobile proxy origin", () => {
  const config = nextConfig({ NODE_ENV: "development" });
  assert.equal(config.assetPrefix, "http://localhost:3000");
  for (const host of ["127.0.0.1", "localhost", "tauri.localhost"]) {
    assert.ok(config.allowedDevOrigins.includes(host));
  }
  assert.equal(config.allowedDevOrigins.length, new Set(config.allowedDevOrigins).size);
});

test("desktop development retains the CLI's asset host", () => {
  const config = nextConfig({ NODE_ENV: "development", TAURI_DEV_HOST: "192.168.1.66" });
  assert.equal(config.assetPrefix, "http://192.168.1.66:3000");
  assert.ok(config.allowedDevOrigins.includes("192.168.1.66"));
  const duplicate = nextConfig({ NODE_ENV: "development", TAURI_DEV_HOST: "localhost" });
  assert.equal(duplicate.allowedDevOrigins.length, new Set(duplicate.allowedDevOrigins).size);
});

test("Android's assets, webpack hot updates and HMR use the WebView origin, not the ADB host", () => {
  const dev = json("src-tauri/tauri.android.dev.conf.json");
  const origin = new URL(dev.app.windows[0].url).origin;
  for (const host of ["127.0.0.1", "192.168.1.66"]) {
    for (const targetEnv of [
      { TAURI_ENV_PLATFORM: "android" },
      { TAURI_ENV_TARGET_TRIPLE: "x86_64-linux-android" },
      { TAURI_ENV_TARGET_TRIPLE: "armv7-linux-androideabi" },
    ]) {
      const config = nextConfig({ NODE_ENV: "development", TAURI_DEV_HOST: host, ...targetEnv });
      assert.equal(config.assetPrefix, origin);
      assert.equal(new URL(`${config.assetPrefix}/_next/static/chunks/main-app.js`).origin, origin);
      assert.equal(new URL(`${config.assetPrefix}/_next/static/webpack/test.webpack.hot-update.json`).origin, origin);
      assert.ok(!config.assetPrefix.includes("127.0.0.1"));
    }
  }
});

test("production remains a static export with no development asset prefix, even with TAURI_DEV_HOST", () => {
  for (const platform of ["windows", "android"]) {
    const config = nextConfig({ NODE_ENV: "production", TAURI_DEV_HOST: "192.168.1.66", TAURI_ENV_PLATFORM: platform });
    assert.equal(config.assetPrefix, undefined);
    assert.equal(config.output, "export");
    assert.equal(config.reactStrictMode, true);
  }
});

test("Next's actual startup prefix and HMR builder work on Android's direct dev origin", () => {
  const { getAssetPrefix } = require("next/dist/client/asset-prefix");
  const { getSocketUrl } = require("next/dist/client/dev/hot-reloader/get-socket-url");
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousScriptElement = global.HTMLScriptElement;
  const dev = json("src-tauri/tauri.android.dev.conf.json");
  global.window = { location: new URL(dev.app.windows[0].url) };
  global.HTMLScriptElement = class {};
  const script = new global.HTMLScriptElement();
  const config = nextConfig({ NODE_ENV: "development", TAURI_ENV_PLATFORM: "android", TAURI_DEV_HOST: "127.0.0.1" });
  script.src = `${config.assetPrefix}/_next/static/chunks/main-app.js`;
  global.document = { currentScript: script };
  try {
    assert.equal(getSocketUrl(getAssetPrefix()), "ws://localhost:3000");
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.HTMLScriptElement = previousScriptElement;
  }
});

test("the direct dev origin has narrowly scoped native permissions and is absent from release configs", () => {
  const dev = json("src-tauri/tauri.android.dev.conf.json");
  const desktop = json("src-tauri/tauri.conf.json");
  const android = json("src-tauri/tauri.android.conf.json");
  assert.equal(dev.build.devUrl, "http://127.0.0.1:3000");
  assert.notEqual(new URL(dev.build.devUrl).origin, new URL(dev.app.windows[0].url).origin);
  const capability = dev.app.security.capabilities.find(c => typeof c === "object");
  assert.deepEqual(capability.remote.urls, ["http://localhost:3000/*"]);
  assert.deepEqual(capability.platforms, ["android"]);
  assert.equal(capability.local, false);
  assert.ok(capability.permissions.includes("sql:default"));
  assert.ok(capability.permissions.includes("sql:allow-execute"));
  assert.ok(!JSON.stringify(capability).includes("updater:"));
  assert.equal(android.app, undefined);
  assert.equal(desktop.app.security.capabilities, undefined);
  assert.equal(desktop.app.windows[0].url, undefined);
  assert.ok(json("package.json").scripts["tauri:android:dev"].includes("--host 127.0.0.1 --config src-tauri/tauri.android.dev.conf.json"));
});

test("Android alone starts the public mobile listener; desktop keeps its original dev command and URL", () => {
  const scripts = json("package.json").scripts;
  const desktop = json("src-tauri/tauri.conf.json");
  const android = json("src-tauri/tauri.android.conf.json");
  assert.equal(scripts.dev, "next dev --webpack -p 3000");
  assert.equal(scripts["tauri:dev"], "tauri dev");
  assert.equal(scripts["dev:mobile"], "next dev --webpack -p 3000 --hostname 0.0.0.0");
  assert.equal(desktop.build.beforeDevCommand, "npm run dev");
  assert.equal(desktop.build.devUrl, "http://127.0.0.1:3000");
  assert.equal(android.build.beforeDevCommand, "npm run dev:mobile");
  assert.equal(android.build.frontendDist, undefined);
  assert.equal(android.bundle.externalBin.length, 0);
  assert.equal(android.identifier, "com.scisoftware.scisonomics");
  assert.equal(android.bundle.android.debugApplicationIdSuffix, ".debug");
});

test("Android dev grants only public device proofs and the existing mobile transaction command", () => {
  const dev = json("src-tauri/tauri.android.dev.conf.json");
  const capability = dev.app.security.capabilities.find(c => typeof c === "object");
  assert.ok(capability.permissions.includes("allow-android-dev-native"));
  const permission = fs.readFileSync(path.join(root,"src-tauri/dev-permissions/android-native.toml"),"utf8");
  const commands=JSON.parse(permission.match(/commands\.allow\s*=\s*(\[[\s\S]*?\])/)[1].replace(/,\s*\]/,"]"));
  assert.deepEqual(commands,["get_or_create_account_device_identity","sign_device_enrollment_proof",
    "sign_device_authentication_proof","sign_refresh_proof","sign_device_management_proof","mobile_sql_transaction"]);
  for(const privateCommand of ["loadIdentity","saveIdentity","deleteIdentity","delete_account_device_identity"])
    assert.ok(!commands.includes(privateCommand));
  // Dev permissions are outside Tauri's shared permissions/ glob so packaged
  // Android and Windows don't acquire an application ACL manifest accidentally.
  assert.equal(fs.existsSync(path.join(root,"src-tauri/permissions")),false);
});
