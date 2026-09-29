const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
globalThis.window = undefined;

// Execute the real TS services and Supabase SDK without another test dependency.
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};
const root = path.resolve(__dirname, "..");
const internalIds = { "alice@example.com": "sciso-A", "bob@example.com": "sciso-B" };
const subjects = { "alice@example.com": "11111111-1111-4111-8111-111111111111", "bob@example.com": "22222222-2222-4222-8222-222222222222" };

class MemoryStorage {
  data = new Map();
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
  dump() { return JSON.stringify(Object.fromEntries(this.data)); }
}

function loadServices() {
  for (const file of ["services/cloudAuth.ts", "services/supabaseCloudAuth.ts", "lib/supabase.ts"]) delete require.cache[path.join(root, file)];
  return {
    cloud: require("../services/cloudAuth.ts"),
    external: require("../services/supabaseCloudAuth.ts"),
    config: require("../lib/supabase.ts"),
  };
}

function setup(t, { configured = true, tauri = false } = {}) {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL = "https://cloud.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = configured ? "https://identity.test" : "";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = configured ? "sb_publishable_test_only" : "";
  const credentials = new Map();
  const browser = new EventTarget();
  browser.localStorage = new MemoryStorage();
  browser.sessionStorage = new MemoryStorage();
  if (tauri) browser.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === "save_persistent_cloud_refresh_token") {
      credentials.set(args.accountId, args.token);
      return { ok: true, roundtrip: true, error_code: null };
    }
    if (command === "load_persistent_cloud_refresh_token") return { found: credentials.has(args.accountId), token: credentials.get(args.accountId) || null, error_code: null };
    if (command === "delete_persistent_cloud_refresh_token") { credentials.delete(args.accountId); return { ok: true, error_code: null }; }
    throw new Error(`Unexpected native command: ${command}`);
  } };
  t.mock.property(globalThis, "window", browser);
  const calls = [];
  const tokenOwners = new Map();
  let serial = 0;
  const ctx = { calls, credentials, browser, backendError: null, backendEmails: {}, signupSession: false, pauseMe: null, pauseLegacyRefresh: null };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  function user(email) {
    return { id: internalIds[email], email: ctx.backendEmails[email] || email, created_at: "2026-01-01", updated_at: "2026-01-01", display_name: null };
  }
  function session(email) {
    const access = `supabase-access-${email}-${++serial}`;
    const refresh = `supabase-refresh-${email}-${serial}`;
    tokenOwners.set(access, email);
    tokenOwners.set(refresh, email);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "bearer", user: { id: subjects[email], email, aud: "authenticated", app_metadata: {}, user_metadata: {}, email_confirmed_at: "2026-01-01" } };
  }
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url, body, headers, method: init.method || "GET" });
    assert.ok(["cloud.test", "identity.test"].includes(url.host), `Non-test network blocked: ${url.host}`);
    if (url.host === "identity.test") {
      if (url.pathname.endsWith("/token")) {
        const email = url.searchParams.get("grant_type") === "refresh_token" ? tokenOwners.get(body.refresh_token) : body.email;
        if (!email || body.password === "wrong") return json({ error_code: "invalid_credentials", msg: "Secret error text must not leak" }, 400);
        return json(session(email));
      }
      if (url.pathname.endsWith("/signup")) return json(ctx.signupSession ? session(body.email) : { id: subjects[body.email], email: body.email, identities: [] });
      if (url.pathname.endsWith("/verify")) return json(session(body.email));
      if (url.pathname.endsWith("/user")) {
        const email = tokenOwners.get(headers.get("Authorization")?.replace("Bearer ", ""));
        return json({ id: subjects[email], email, aud: "authenticated", app_metadata: {}, user_metadata: {} });
      }
      if (["/auth/v1/logout", "/auth/v1/recover", "/auth/v1/resend"].includes(url.pathname)) return json({});
      throw new Error(`Unexpected provider API: ${url.pathname}`);
    }
    if (url.pathname === "/auth/me") {
      const email = tokenOwners.get(headers.get("Authorization")?.replace("Bearer ", ""));
      assert.ok(email, "Backend receives a provider access token");
      if (ctx.pauseMe) await ctx.pauseMe;
      if (ctx.backendError) return json({ detail: ctx.backendError.detail }, ctx.backendError.status);
      return json(user(email));
    }
    if (url.pathname === "/auth/login" || url.pathname === "/auth/refresh") {
      if (url.pathname === "/auth/refresh" && ctx.pauseLegacyRefresh) {
        await ctx.pauseLegacyRefresh;
        return json({ detail: "Legacy refresh rejected" }, 401);
      }
      const email = body.email || "alice@example.com";
      return json({ access_token: "legacy-access", refresh_token: "legacy-refresh", expires_in: 3600, token_type: "bearer", user: user(email) });
    }
    if (url.pathname === "/auth/logout") return json({ ok: true });
    throw new Error(`Unexpected cloud API: ${url.pathname}`);
  });
  return Object.assign(ctx, loadServices());
}

test("Supabase login resolves /auth/me and stores only the internal owner", async (t) => {
  const { cloud, external, calls, browser } = setup(t);
  const user = await external.signInWithPassword("alice@example.com", "correct password");
  assert.equal(user.id, "sciso-A");
  assert.equal(cloud.getActiveOwnerId(), "sciso-A");
  assert.equal(cloud.getStoredAccounts()[0].authProvider, "supabase");
  assert.equal(cloud.getStoredAccounts()[0].storage, "session");
  const session = await external.getSession();
  assert.equal(session.user.id, "sciso-A");
  assert.match(session.token, /^supabase-access/);
  assert.equal(calls.find((call) => call.url.pathname === "/auth/me").headers.get("Authorization"), `Bearer ${session.token}`);
  assert.doesNotMatch(browser.localStorage.dump(), /supabase-(access|refresh)/);
  assert.doesNotMatch(browser.sessionStorage.dump(), /supabase-refresh/);
  assert.doesNotMatch(browser.sessionStorage.getItem("scisonomics_cloud_accounts_session_v1"), new RegExp(subjects["alice@example.com"]));
});

test("invalid Supabase login preserves the active legacy account", async (t) => {
  const { cloud, external } = setup(t);
  const legacy = await cloud.cloudAuth.login({ email: "alice@example.com", password: "legacy password" });
  await cloud.addOrUpdateAccount({ user: legacy.user, tokens: cloud.getCloudAuthTokens(legacy) }, { remember: false });
  await assert.rejects(external.signInWithPassword("bob@example.com", "wrong"), /Email o contraseña incorrectos/);
  assert.equal(cloud.getActiveOwnerId(), "sciso-A");
  assert.equal((await cloud.getValidAccessToken()).token, "legacy-access");
});

test("identity without an internal link does not create or activate an account", async (t) => {
  const ctx = setup(t);
  ctx.backendError = { status: 403, detail: { code: "internal_account_required", message: "No internal account" } };
  await assert.rejects(ctx.external.signInWithPassword("alice@example.com", "correct"), (error) => error.code === "internal_account_required" && error.message.includes("siguiente fase"));
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.cloud.getStoredAccounts().length, 0);
  assert.deepEqual(ctx.calls.filter((call) => call.url.host === "cloud.test").map((call) => call.url.pathname), ["/auth/me"]);
});

test("signup without a session asks for verification and never sets a provider owner", async (t) => {
  const { external, cloud, calls } = setup(t);
  const result = await external.signUpWithPassword("alice@example.com", "long test password", "Alice");
  assert.equal(result.status, "verification_required");
  assert.equal(cloud.getActiveOwnerId(), "local");
  assert.equal(cloud.getStoredAccounts().length, 0);
  assert.equal(calls.filter((call) => call.url.host === "cloud.test").length, 0);
});

test("signup with a session still requires backend resolution", async (t) => {
  const ctx = setup(t);
  ctx.signupSession = true;
  ctx.backendError = { status: 403, detail: { code: "internal_account_required" } };
  await assert.rejects(ctx.external.signUpWithPassword("alice@example.com", "long test password"), (error) => error.code === "internal_account_required");
  assert.equal(ctx.cloud.getStoredAccounts().length, 0);
});

test("two Supabase accounts keep separate internal owners, refresh tokens and clients", async (t) => {
  const { external, cloud, calls } = setup(t);
  await external.signInWithPassword("alice@example.com", "correct");
  await external.signInWithPassword("bob@example.com", "correct");
  assert.equal(cloud.getActiveOwnerId(), "sciso-B");
  const [first, second] = await Promise.all([cloud.forceRefreshActiveCloudSession("sciso-A"), cloud.forceRefreshActiveCloudSession("sciso-B")]);
  assert.equal(first.user.id, "sciso-A");
  assert.equal(second.user.id, "sciso-B");
  assert.notEqual(first.token, second.token);
  assert.equal(cloud.getActiveOwnerId(), "sciso-B");
  assert.equal(calls.filter((call) => call.url.host === "cloud.test" && call.url.pathname === "/auth/refresh").length, 0);
  assert.equal((await cloud.getValidAccessToken("sciso-A")).token, first.token);
});

test("Supabase accounts sharing a normalized email do not merge internal IDs", async (t) => {
  const ctx = setup(t);
  ctx.backendEmails["bob@example.com"] = "alice@example.com";
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  await ctx.external.signInWithPassword("bob@example.com", "correct");
  assert.deepEqual(ctx.cloud.getStoredAccounts().map((account) => account.user.id).sort(), ["sciso-A", "sciso-B"]);
});

test("legacy WinCred refresh survives Supabase login for the same internal account", async (t) => {
  const { cloud, external, credentials } = setup(t, { tauri: true });
  const legacy = await cloud.cloudAuth.login({ email: "alice@example.com", password: "correct" });
  await cloud.addOrUpdateAccount({ user: legacy.user, tokens: cloud.getCloudAuthTokens(legacy) }, { remember: true });
  assert.equal(credentials.get("sciso-A"), "legacy-refresh");
  await external.signInWithPassword("alice@example.com", "correct");
  assert.equal(credentials.get("sciso-A"), "legacy-refresh");
  assert.equal(cloud.getStoredAccounts().length, 1);
});

test("legacy refresh and logout still use their own endpoints", async (t) => {
  const { cloud, calls } = setup(t, { tauri: true });
  const response = await cloud.cloudAuth.login({ email: "alice@example.com", password: "correct" });
  const tokens = cloud.getCloudAuthTokens(response);
  tokens.expiresAt = new Date(0).toISOString();
  await cloud.addOrUpdateAccount({ user: response.user, tokens }, { remember: true });
  assert.equal((await cloud.getValidAccessToken()).token, "legacy-access");
  await cloud.logoutAccount("sciso-A");
  assert.ok(calls.some((call) => call.url.pathname === "/auth/refresh"));
  assert.ok(calls.some((call) => call.url.pathname === "/auth/logout"));
  assert.equal(cloud.getActiveOwnerId(), "local");
});

test("local mode works without Supabase configuration and never borrows a cloud token", async (t) => {
  const { cloud, external, calls } = setup(t, { configured: false });
  assert.equal((await cloud.getActiveCloudAuthState()).availability, "local");
  assert.equal(await cloud.getValidAccessToken("local"), null);
  assert.equal(external.isSupabaseCloudAuthConfigured(), false);
  await assert.rejects(external.signInWithPassword("alice@example.com", "correct"), (error) => error.code === "supabase_not_configured");
  assert.equal(calls.length, 0);
});

test("Supabase logout affects only its own account and uses local provider scope", async (t) => {
  const { external, cloud, calls } = setup(t);
  await external.signInWithPassword("alice@example.com", "correct");
  await external.signInWithPassword("bob@example.com", "correct");
  await cloud.logoutAccount("sciso-A");
  assert.equal(cloud.getActiveOwnerId(), "sciso-B");
  assert.equal((await external.getSession()).user.id, "sciso-B");
  assert.equal(calls.find((call) => call.url.pathname.endsWith("/logout")).url.searchParams.get("scope"), "local");
  assert.ok(!calls.some((call) => call.url.host === "cloud.test" && call.url.pathname === "/auth/logout"));
});

test("a pending Supabase refresh cannot resurrect a removed account", async (t) => {
  const ctx = setup(t);
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  let release;
  ctx.pauseMe = new Promise((resolve) => { release = resolve; });
  const pending = ctx.external.refreshSession("sciso-A");
  await new Promise((resolve) => setImmediate(resolve));
  await ctx.cloud.removeAccount("sciso-A");
  release();
  assert.equal(await pending, null);
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.cloud.getStoredAccounts().length, 0);
});

test("refresh rejects a changed internal owner", async (t) => {
  const ctx = setup(t);
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  ctx.backendError = null;
  const me = ctx.cloud.cloudAuth.me;
  t.mock.method(ctx.cloud.cloudAuth, "me", async (token) => ({ ...(await me(token)), id: "wrong-internal-owner" }));
  assert.equal(await ctx.cloud.forceRefreshActiveCloudSession(), null);
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
  assert.equal((await ctx.cloud.getActiveCloudAuthState()).availability, "session_expired");
});

test("reload cannot send a Supabase refresh token to legacy or restore it from storage", async (t) => {
  const ctx = setup(t);
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  const key = "scisonomics_cloud_access_tokens_session_v1";
  const state = JSON.parse(ctx.browser.sessionStorage.getItem(key));
  state["sciso-A"].expiresAt = new Date(0).toISOString();
  ctx.browser.sessionStorage.setItem(key, JSON.stringify(state));
  const reloaded = loadServices();
  assert.equal(reloaded.cloud.getStoredAccounts()[0].authProvider, "supabase");
  assert.equal(await reloaded.cloud.getValidAccessToken(), null);
  assert.ok(!ctx.calls.some((call) => call.url.pathname === "/auth/refresh"));
});

test("email OTP resolves the internal user and password recovery never activates one", async (t) => {
  const { external, cloud, calls } = setup(t);
  await external.resendSignupVerification("alice@example.com");
  await external.verifyEmailCode("alice@example.com", "123456");
  assert.equal(cloud.getActiveOwnerId(), "sciso-A");
  cloud.switchToLocalMode();
  await external.requestPasswordReset("bob@example.com");
  await external.completePasswordRecovery("bob@example.com", "123456", "new long password");
  assert.equal(cloud.getActiveOwnerId(), "local");
  assert.ok(calls.some((call) => call.method === "PUT" && call.url.pathname.endsWith("/user")));
  assert.equal(cloud.getStoredAccounts().length, 1);
});

test("backend outage preserves rotated Supabase refresh tokens for retry", async (t) => {
  const ctx = setup(t);
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  ctx.backendError = { status: 503, detail: { code: "supabase_auth_unavailable", message: "Retry later" } };
  await assert.rejects(ctx.external.refreshSession(), (error) => error.kind === "server");
  ctx.backendError = null;
  assert.equal((await ctx.external.refreshSession()).user.id, "sciso-A");
  const refreshCalls = ctx.calls.filter((call) => call.url.searchParams.get("grant_type") === "refresh_token");
  assert.equal(refreshCalls.length, 2);
  assert.notEqual(refreshCalls[0].body.refresh_token, refreshCalls[1].body.refresh_token);
});

test("concurrent refresh requests for one owner share a single provider request", async (t) => {
  const ctx = setup(t);
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  const sessions = await Promise.all([ctx.cloud.forceRefreshActiveCloudSession(), ctx.cloud.forceRefreshActiveCloudSession(), ctx.external.refreshSession()]);
  assert.ok(sessions.every((session) => session.user.id === "sciso-A" && session.token === sessions[0].token));
  assert.equal(ctx.calls.filter((call) => call.url.searchParams.get("grant_type") === "refresh_token").length, 1);
});

test("local mode keeps cloud accounts available without choosing any cloud owner", async (t) => {
  const ctx = setup(t);
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  ctx.cloud.switchToLocalMode();
  assert.equal(await ctx.cloud.getValidAccessToken(), null);
  assert.equal(await ctx.cloud.getValidAccessToken("local"), null);
  assert.equal((await ctx.cloud.getActiveCloudAuthState()).availability, "local");
  assert.equal((await ctx.external.getSession("sciso-A")).user.id, "sciso-A");
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
});

test("a rejected late legacy refresh cannot clear a newer Supabase session", async (t) => {
  const ctx = setup(t, { tauri: true });
  const response = await ctx.cloud.cloudAuth.login({ email: "alice@example.com", password: "correct" });
  const tokens = ctx.cloud.getCloudAuthTokens(response);
  tokens.expiresAt = new Date(0).toISOString();
  await ctx.cloud.addOrUpdateAccount({ user: response.user, tokens }, { remember: true });
  let release;
  ctx.pauseLegacyRefresh = new Promise((resolve) => { release = resolve; });
  const pending = ctx.cloud.forceRefreshActiveCloudSession();
  await new Promise((resolve) => setImmediate(resolve));
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  const newAccess = ctx.cloud.getStoredToken();
  release();
  await pending;
  assert.equal(ctx.cloud.getStoredToken(), newAccess);
  assert.equal(ctx.cloud.getActiveAccount().authProvider, "supabase");
});
