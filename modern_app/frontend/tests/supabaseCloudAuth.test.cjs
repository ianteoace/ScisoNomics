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
require.extensions[".tsx"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
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

let deviceTestContext;
function loadServices() {
  for (const file of ["services/cloudAuth.ts", "services/supabaseCloudAuth.ts", "services/supabaseTokenStorage.ts", "services/supabaseGoogleAuth.ts", "services/supabaseOAuthStorage.ts", "services/supabaseOAuthCallback.ts", "lib/supabase.ts"]) delete require.cache[path.join(root, file)];
  const cloud = require("../services/cloudAuth.ts");
  const filename = path.join(root, "services/deviceAuthorization.ts");
  class DeviceVerificationRequiredError extends cloud.CloudAuthRequestError {
    constructor() { super("Device verification required", { kind: "auth", code: "device_verification_required" }); }
  }
  const grant = (token,user) => ({ user, access_token: token, expires_in: 3600, familyId: "fixture-family", deviceId: "fixture-device", accountBinding: "fixture-binding" });
  require.cache[filename] = { id: filename, filename, loaded: true, exports: {
    DeviceVerificationRequiredError,
    beginDeviceLogin: async (token,user) => deviceTestContext.devicePending
      ? { context: { userId:user.id }, enrollment: { status:"pending_verification", verificationId:"fixture", verificationToken:"fixture-continuation", expiresIn:600, resendAvailableIn:60 } }
      : { grant: grant(token,user) },
    completeDeviceEnrollment: async (token,context,_enrollment,code) => {
      if (code !== "444444") throw new cloud.CloudAuthRequestError("Código incorrecto", { code:"device_otp_invalid", kind:"auth" });
      return grant(token,await cloud.cloudAuth.me(token));
    },
    resendDeviceEnrollment: async (_token,enrollment) => ({...enrollment,verificationToken:"replacement-continuation"}),
    restoreDeviceGrant: async (token,owner) => {
      if (deviceTestContext.deviceRevoked) throw new cloud.CloudAuthRequestError("Device revoked", { code:"device_revoked", kind:"auth" });
      const user=await cloud.cloudAuth.me(token);
      if (user.id !== owner) throw new cloud.CloudAuthRequestError("Wrong owner", { code:"internal_identity_mismatch", kind:"auth" });
      return grant(token,user);
    },
    rememberDeviceGrant(owner) { deviceTestContext.trustedOwners.add(owner); },
    forgetDeviceGrant(owner) { deviceTestContext.trustedOwners.delete(owner); },
    hasCachedDeviceGrant(owner) { return deviceTestContext.trustedOwners.has(owner); },
    listAccountDevices: async () => [],
  } };
  return {
    cloud: require("../services/cloudAuth.ts"),
    external: require("../services/supabaseCloudAuth.ts"),
    config: require("../lib/supabase.ts"),
    google: require("../services/supabaseGoogleAuth.ts"),
    callback: require("../services/supabaseOAuthCallback.ts"),
  };
}

function setup(t, { configured = true, tauri = false, mobile = false } = {}) {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL = "https://cloud.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = configured ? "https://identity.test" : "";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = configured ? "sb_publishable_test_only" : "";
  const credentials = new Map();
  const browser = new EventTarget();
  browser.navigator = { userAgent: mobile ? "Android" : "Windows NT" };
  browser.localStorage = new MemoryStorage();
  browser.sessionStorage = new MemoryStorage();
  if (tauri) browser.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === "log_google_oauth_diagnostic") {
      if (ctx.nativeDiagnosticError) throw new Error("fixture-secret");
      (ctx.nativeDiagnostics ||= []).push(args.payload);
      return;
    }
    if (command === "plugin:opener|open_url") {
      if (ctx.openerError) throw new Error("Sensitive opener URL must not leak");
      ctx.openedUrls.push(new URL(args.url));
      return;
    }
    if (command.endsWith("pending_supabase_oauth")) {
      ctx.nativeCalls.push({ command, projectId: args.projectId });
      if (ctx.nativeError) throw new Error("Sensitive native error must not leak");
      const key = `pkce:${args.projectId}`;
      if (command === "save_pending_supabase_oauth") { credentials.set(key, args.payload); return true; }
      if (command === "load_pending_supabase_oauth") return credentials.get(key) || null;
      if (command === "delete_pending_supabase_oauth") { credentials.delete(key); return; }
    }
    if (command.includes("supabase") || command.startsWith("plugin:mobile-secure-storage|")) {
      ctx.nativeCalls.push({ command, accountId: args.accountId });
      if (ctx.nativeError) throw new Error("Native failure with secret details");
      if (ctx.refreshSaveError && command === "plugin:mobile-secure-storage|save" && !args.accountId.endsWith("::pending_google")) throw new Error("Sensitive native refresh failure");
      if (ctx.pendingDeleteError && command === "plugin:mobile-secure-storage|delete" && args.accountId.endsWith("::pending_google")) throw new Error("Sensitive native deletion failure");
      const key = `supabase:${args.accountId}`;
      const operation = command.startsWith("plugin:mobile-secure-storage|") ? `${command.split("|")[1]}_persistent_supabase_refresh_token` : command;
      if (command === "plugin:mobile-secure-storage|save" && args.accountId.endsWith("::pending_google")) {
        assert.match(args.accountId, /^[a-f0-9]{64}::[A-Za-z0-9_-]{1,120}$/);
        assert.ok(args.token.length > 0 && args.token.length <= 4096 && !/\s/.test(args.token), "native token-slot contract");
      }
      if (operation === "save_persistent_supabase_refresh_token") {
        if (ctx.pauseSave) await ctx.pauseSave;
        credentials.set(key, args.token);
        return { ok: true, roundtrip: true };
      }
      if (operation === "load_persistent_supabase_refresh_token") return { found: credentials.has(key), token: credentials.get(key) || null };
      if (operation === "delete_persistent_supabase_refresh_token") { credentials.delete(key); return { ok: true }; }
    }
    if (command === "save_persistent_cloud_refresh_token") {
      if (ctx.pauseLegacySave) await ctx.pauseLegacySave;
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
  const ctx = { calls, credentials, browser, backendError: null, backendEmails: {}, signupSession: false, signupError: null, signupIdentities: [{ provider: "email", id: "email-identity" }], pauseMe: null, pauseLegacyRefresh: null, nativeCalls: [], nativeError: false, pauseSave: null, pauseLegacySave: null, rejectRefresh: false, otpError: null, recoveryEmailOverride: null, resendError: null, openedUrls: [], openerError: false, exchangeError: false, oauthUnconfirmed: false, pauseExchange: null };
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
        if (url.searchParams.get("grant_type") === "pkce") {
          if (ctx.pauseExchange) await ctx.pauseExchange;
          assert.ok(body.code_verifier, "PKCE sends the verifier generated by the SDK");
          const challenge = require("node:crypto").createHash("sha256").update(body.code_verifier).digest("base64url");
          assert.equal(challenge, ctx.openedUrls.at(-1).searchParams.get("code_challenge"));
          if (ctx.exchangeError) return json({ error_code: "flow_state_expired", msg: "Sensitive code must not leak" }, 400);
          const email = body.auth_code === "google-bob-code" ? "bob@example.com" : "alice@example.com";
          const value = session(email);
          if (ctx.oauthUnconfirmed) delete value.user.email_confirmed_at;
          return json(value);
        }
        if (ctx.rejectRefresh && url.searchParams.get("grant_type") === "refresh_token") return json({ error_code: "refresh_token_not_found" }, 400);
        const email = url.searchParams.get("grant_type") === "refresh_token" ? tokenOwners.get(body.refresh_token) : body.email;
        if (!email || body.password === "wrong") return json({ error_code: "invalid_credentials", msg: "Secret error text must not leak" }, 400);
        return json(session(email));
      }
      if (url.pathname.endsWith("/signup")) {
        if (ctx.signupError) return json({ error_code: ctx.signupError.code, msg: "Sensitive provider response must not leak" }, ctx.signupError.status);
        return json(ctx.signupSession ? session(body.email) : { id: subjects[body.email], email: body.email, identities: ctx.signupIdentities });
      }
      if (url.pathname.endsWith("/verify")) {
        if (ctx.otpError) return json({ error_code: ctx.otpError.code, msg: "Secret provider response must not leak" }, ctx.otpError.status);
        return json(session(body.type === "recovery" && ctx.recoveryEmailOverride || body.email));
      }
      if (url.pathname.endsWith("/user")) {
        const email = tokenOwners.get(headers.get("Authorization")?.replace("Bearer ", ""));
        return json({ id: subjects[email], email, aud: "authenticated", app_metadata: {}, user_metadata: {} });
      }
      if (url.pathname === "/auth/v1/resend" && ctx.resendError) return json({ error_code: ctx.resendError.code, msg: "Secret provider response must not leak" }, ctx.resendError.status);
      if (["/auth/v1/logout", "/auth/v1/recover", "/auth/v1/resend"].includes(url.pathname)) return json({});
      throw new Error(`Unexpected provider API: ${url.pathname}`);
    }
    if (url.pathname === "/auth/me" || url.pathname === "/auth/supabase/bootstrap") {
      const email = tokenOwners.get(headers.get("Authorization")?.replace("Bearer ", ""));
      assert.ok(email, "Backend receives a provider access token");
      if (ctx.pauseMe) await ctx.pauseMe;
      if (ctx.backendError) return json({ detail: ctx.backendError.detail }, ctx.backendError.status);
      return json(user(email));
    }
    if (url.pathname === "/billing/entitlements") {
      const email = tokenOwners.get(headers.get("Authorization")?.replace("Bearer ", ""));
      assert.ok(email, "Premium lookup uses the active cloud access token");
      const premium = email === "alice@example.com";
      return json({ plan: premium ? "premium" : "free", status: "active",
        features: { budgets: premium, saving_goals: premium, fixed_expenses: premium, planning: premium },
        expires_at: premium ? "2030-01-01T00:00:00Z" : null });
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
  deviceTestContext = ctx;
  ctx.trustedOwners = new Set();
  Object.assign(ctx, loadServices());
  t.after(() => ctx.external.cancelDeviceVerification());
  return ctx;
}

function setupGoogle(t, options = {}) {
  const ctx = setup(t, { tauri: true, ...options });
  t.after(() => ctx.google.cancelGoogleSupabaseSignIn());
  return ctx;
}

function decodePending(payload, mobile) { return JSON.parse(mobile ? Buffer.from(payload, "base64url").toString("utf8") : payload); }
function encodePending(value, mobile) { const payload = JSON.stringify(value); return mobile ? Buffer.from(payload).toString("base64url") : payload; }

function diagnosticEvents() {
  return console.info.mock.calls.map(call => call.arguments)
    .filter(args => typeof args[0] === "string" && args[0].startsWith("[google-oauth] "))
    .map(args => { assert.equal(args.length, 1); return JSON.parse(args[0].slice("[google-oauth] ".length)); });
}

test("production Google login emits no shared auth lifecycle or identity logs", async t => {
  const before = process.env.NODE_ENV; process.env.NODE_ENV = "production";
  t.after(() => { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; });
  const ctx = setupGoogle(t, { mobile: true });
  await ctx.google.signInWithGoogleSupabase();
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  const lines = console.info.mock.calls.map(call => JSON.stringify(call.arguments));
  assert.ok(!lines.some(line => line.includes('[auth]')));
  for (const value of ["alice@example.com", "sciso-A", "supabase-access", "supabase-refresh", "google-alice-code"]) assert.ok(!lines.some(line => line.includes(value)), "identity or token leaked into production logs");
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
});

test("development auth lifecycle also redacts internal owners, identities and URLs", async t => {
  const before = process.env.NODE_ENV; process.env.NODE_ENV = "development";
  t.after(() => { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; });
  const ctx = setupGoogle(t, { mobile: true });
  await ctx.google.signInWithGoogleSupabase();
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  const lines = console.info.mock.calls.filter(call => String(call.arguments[0]).startsWith('[auth]')).map(call => JSON.stringify(call.arguments));
  assert.ok(lines.length > 0);
  for (const value of ["alice@example.com", "sciso-A", "https://identity.test", "supabase-access", "supabase-refresh", "google-alice-code"]) assert.ok(!lines.some(line => line.includes(value)), "private auth metadata leaked into development logs");
});
function assertSafeDiagnostics(ctx) {
  const logs = diagnosticEvents(), text = JSON.stringify(logs);
  // Only auth_error_code may contain the public name bad_code_verifier;
  // no verifier value or similarly named free-form field is permitted.
  assert.doesNotMatch(JSON.stringify(logs.map(({ auth_error_code, ...row }) => row)), /code=|access_token|refresh_token|code_verifier|email|scisonomics:\/\/|https?:\/\//);
  for (const secret of ["google-alice-code", "supabase-access", "supabase-refresh", "Sensitive", "fixture-secret"]) assert.ok(!text.includes(secret), "secret leaked into diagnostics");
  for (const row of logs) {
    assert.ok(require("../services/googleOAuthDiagnostics.ts").GOOGLE_OAUTH_FAILURE_EVENTS.includes(row.event), "only failures belong in operational logs");
    assert.ok(Object.keys(row).every(key => ["event", "platform", "mode", "origin", "duration_ms", "http_status", "error_code", "auth_error_code"].includes(key)));
    if (row.auth_error_code !== undefined) {
      assert.equal(row.event, "oauth_exchange_failed"); assert.equal(row.error_code, "supabase_auth_failed");
      assert.ok([...require("../services/googleOAuthDiagnostics.ts").GOOGLE_OAUTH_AUTH_ERROR_CODES, "other"].includes(row.auth_error_code));
    }
    assert.equal(row.platform, "android");
    assert.ok(["warm", "cold"].includes(row.mode)); assert.ok(["onOpenUrl", "getCurrent"].includes(row.origin));
  }
  return logs;
}

for (const kind of ["missing", "expired", "invalid", "native-read"]) test(`Android diagnostics distinguish pending ${kind}`, async t => {
  const ctx = setupGoogle(t, { mobile: true });
  if (kind !== "missing") {
    await ctx.google.signInWithGoogleSupabase();
    const [key, payload] = [...ctx.credentials.entries()][0];
    await ctx.google.cancelGoogleSupabaseSignIn();
    const value = decodePending(payload, true);
    if (kind === "expired") value.expiresAt = Date.now() - 1;
    if (kind === "invalid") value.storage = { access_token: "fixture-secret" };
    ctx.credentials.set(key, encodePending(value, true));
    Object.assign(ctx, loadServices());
    if (kind === "native-read") ctx.nativeError = true;
  }
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code", "getCurrent");
  const expected = kind === "native-read" ? "oauth_pending_invalid" : `oauth_pending_${kind}`;
  assert.equal(ctx.google.getGoogleOAuthState().diagnosticCode, expected);
  const logs = assertSafeDiagnostics(ctx);
  assert.ok(logs.some(row => row.event === expected && row.mode === "cold" && row.origin === "getCurrent"));
  if (kind === "native-read") assert.ok(logs.some(row => row.error_code === "supabase_oauth_storage_failed"));
  assert.equal(ctx.calls.length, 0);
  ctx.nativeError = false;
});

for (const kind of ["exchange", "bootstrap", "device", "store", "delete", "invalid-session"]) test(`Android OAuth diagnostics identify ${kind} failure`, async t => {
  const ctx = setupGoogle(t, { mobile: true });
  await ctx.google.signInWithGoogleSupabase();
  if (kind === "exchange") ctx.exchangeError = true;
  if (kind === "bootstrap") ctx.backendError = { status: 409, detail: { code: "internal_account_required" } };
  if (kind === "device") t.mock.method(require("../services/deviceAuthorization.ts"), "beginDeviceLogin", async () => { throw new ctx.cloud.CloudAuthRequestError("No pudimos autorizar el dispositivo.", { code: "device_verification_unavailable", statusCode: 503 }); });
  if (kind === "store") ctx.refreshSaveError = true;
  if (kind === "delete") ctx.pendingDeleteError = true;
  if (kind === "invalid-session") ctx.oauthUnconfirmed = true;
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  const expected = { exchange: "oauth_exchange_failed", bootstrap: "oauth_bootstrap_failed", device: "oauth_device_auth_failed", store: "oauth_session_store_failed", delete: "oauth_pending_delete_failed", "invalid-session": "oauth_session_invalid" }[kind];
  assert.equal(ctx.google.getGoogleOAuthState().diagnosticCode, expected);
  const logs = assertSafeDiagnostics(ctx);
  assert.ok(logs.some(row => row.event === expected));
  if (kind === "exchange") assert.ok(logs.some(row => row.event === expected && row.http_status === 400 && row.error_code === "supabase_auth_failed" && row.auth_error_code === "flow_state_expired"));
  if (kind === "bootstrap") assert.ok(logs.some(row => row.event === expected && row.http_status === 409));
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  ctx.pendingDeleteError = false;
});

test("Android duplicates remain deduplicated and successful callbacks are silent", async t => {
  const ctx = setupGoogle(t, { mobile: true });
  await ctx.google.signInWithGoogleSupabase();
  let resolveExchange; ctx.pauseExchange = new Promise(resolve => { resolveExchange = resolve; });
  const first = ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code", "onOpenUrl");
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code", "getCurrent");
  resolveExchange(); await first;
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code", "getCurrent");
  const logs = assertSafeDiagnostics(ctx);
  assert.deepEqual(logs, [], "successful and duplicate callbacks emit no operational noise");
  assert.equal(ctx.google.getGoogleOAuthState().status, "succeeded");
  assert.equal(ctx.calls.filter(call => call.url.pathname.endsWith("/token")).length, 1);
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
  await new Promise(setImmediate);
  assert.equal((ctx.nativeDiagnostics || []).length, 0);
  assert.doesNotMatch(JSON.stringify(ctx.nativeDiagnostics || []), /code=|access_token|refresh_token|code_verifier|email|scisonomics:\/\/|https?:\/\//);
  for (const row of ctx.nativeDiagnostics || []) assert.ok(Object.keys(row).every(key => ["event", "platform", "mode", "origin", "duration_ms", "http_status", "error_code", "auth_error_code"].includes(key)));
});

test("Android diagnostic transport failure never changes the completed Google session", async t => {
  const ctx = setupGoogle(t, { mobile: true }); ctx.nativeDiagnosticError = true;
  await ctx.google.signInWithGoogleSupabase();
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  await new Promise(setImmediate);
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
  assert.equal(ctx.google.getGoogleOAuthState().status, "succeeded");
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
  assert.ok(!assertSafeDiagnostics(ctx).some(row => row.event === "oauth_completed"));
});

for (const code of ["bad_code_verifier", "bad_oauth_callback", "bad_oauth_state", "bad_jwt", "invalid_credentials", "validation_failed", "unexpected_failure", "flow_state_expired", "flow_state_not_found", "fixture-secret", undefined]) {
  test(`exchange AuthApiError diagnostics: ${code === "fixture-secret" ? "unknown" : code || "no code"}`, async t => {
    const ctx = setupGoogle(t, { mobile: true });
    await ctx.google.signInWithGoogleSupabase();
    const { AuthApiError } = require("@supabase/supabase-js");
    const error = new AuthApiError("fixture-secret", 401, code);
    for (const name of ["message", "body", "response", "headers", "error_description", "stack", "url", "access_token", "refresh_token", "code_verifier", "state"]) {
      Object.defineProperty(error, name, { configurable: true, get() { throw new Error("Sensitive field read by diagnostic"); } });
    }
    const create = ctx.config.createSupabaseAuthClient;
    t.mock.method(ctx.config, "createSupabaseAuthClient", (...args) => {
      const client = create(...args);
      t.mock.method(client.auth, "exchangeCodeForSession", async () => ({ data: { session: null, user: null }, error }));
      return client;
    });
    // Cold reconstruction ensures the actual exchange -> friendly mapping ->
    // diagnostic trace path observes the original SDK AuthApiError.
    const [key, payload] = [...ctx.credentials.entries()][0];
    await ctx.google.cancelGoogleSupabaseSignIn(); ctx.credentials.set(key, payload);
    await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code", "getCurrent");
    await new Promise(setImmediate);
    const row = assertSafeDiagnostics(ctx).find(row => row.event === "oauth_exchange_failed");
    const allowed = require("../services/googleOAuthDiagnostics.ts").GOOGLE_OAUTH_AUTH_ERROR_CODES;
    assert.equal(row.auth_error_code, allowed.includes(code) ? code : "other");
    assert.equal(row.error_code, "supabase_auth_failed"); assert.equal(row.http_status, 401);
    assert.ok(Number.isFinite(row.duration_ms));
    assert.ok(ctx.nativeDiagnostics.some(native => native.auth_error_code === row.auth_error_code));
    assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  });
}

test("non-AuthApiError has no auth_error_code even when it exposes a known code", t => {
  const ctx = setupGoogle(t, { mobile: true });
  const diagnostics = require("../services/googleOAuthDiagnostics.ts");
  const trace = diagnostics.createGoogleOAuthTrace({ mode: "warm", origin: "onOpenUrl" });
  const error = { code: "bad_jwt", status: 401, name: "Error" };
  for (const name of ["message", "body", "response", "headers", "stack", "code_verifier", "access_token"]) Object.defineProperty(error, name, { get() { throw new Error("Sensitive field read"); } });
  trace.fail("oauth_exchange_failed", error, 12);
  const row = assertSafeDiagnostics(ctx)[0];
  assert.equal(row.auth_error_code, undefined); assert.equal(row.http_status, 401);
  diagnostics.logGoogleOAuthDiagnostic("oauth_completed", { mode: "warm", origin: "onOpenUrl", authErrorCode: "bad_jwt" });
  assert.equal(assertSafeDiagnostics(ctx).length, 1);
});

test("SDK verifier missing is diagnosed before HTTP without inventing a provider status", async t => {
  const ctx = setupGoogle(t, { mobile: true }), create = ctx.config.createSupabaseAuthClient;
  let discardVerifier = false;
  t.mock.method(ctx.config, "createSupabaseAuthClient", (storage, key) => create({
    ...storage, getItem: name => discardVerifier && name.endsWith("-code-verifier") ? null : storage.getItem(name),
  }, key));
  await ctx.google.signInWithGoogleSupabase(); discardVerifier = true;
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  const row = assertSafeDiagnostics(ctx).find(row => row.event === "oauth_exchange_failed");
  assert.equal(row.error_code, "pkce_verifier_missing");
  assert.equal(row.http_status, undefined);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.google.getGoogleOAuthState().diagnosticCode, "oauth_exchange_failed");
});

test("late Android callback retains expired diagnosis after the existing timeout removed pending", async t => {
  const ctx = setupGoogle(t, { mobile: true }), timeout = global.setTimeout, now = Date.now;
  let expire;
  t.mock.method(global, "setTimeout", (fn, delay, ...args) => {
    if (delay > 290000 && delay <= 300000) expire = fn;
    return timeout(fn, delay, ...args);
  });
  await ctx.google.signInWithGoogleSupabase(); assert.ok(expire);
  t.mock.method(Date, "now", () => now() + 300001);
  const cancelled = new Promise(resolve => {
    const stop = ctx.google.subscribeGoogleOAuth(() => {
      if (ctx.google.getGoogleOAuthState().diagnosticCode === "oauth_pending_expired") { stop(); resolve(); }
    });
  });
  expire(); await cancelled;
  assert.equal(ctx.credentials.size, 0);
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  assert.equal(ctx.google.getGoogleOAuthState().diagnosticCode, "oauth_pending_expired");
  assert.ok(assertSafeDiagnostics(ctx).some(row => row.event === "oauth_pending_expired" && row.mode === "warm"));
  assert.equal(ctx.calls.length, 0);
});

test("Android cold success remains functional and emits no verifier or success logs", async t => {
  const ctx = setupGoogle(t, { mobile: true });
  await ctx.google.signInWithGoogleSupabase();
  const [key, payload] = [...ctx.credentials.entries()][0], verifierValues = Object.values(decodePending(payload, true).storage);
  await ctx.google.cancelGoogleSupabaseSignIn(); ctx.credentials.set(key, payload); Object.assign(ctx, loadServices());
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code", "getCurrent");
  const logs = assertSafeDiagnostics(ctx);
  assert.deepEqual(logs, []);
  assert.equal(ctx.google.getGoogleOAuthState().status, "succeeded");
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
  for (const verifier of verifierValues) assert.ok(!JSON.stringify(logs).includes(verifier), "verifier leaked into diagnostics");
});

test("Android invalid callback logs only its diagnostic event and never exchanges", async t => {
  const ctx = setupGoogle(t, { mobile: true });
  await ctx.google.signInWithGoogleSupabase();
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?access_token=fixture-secret");
  assert.equal(ctx.google.getGoogleOAuthState().diagnosticCode, "oauth_callback_invalid");
  assert.deepEqual(assertSafeDiagnostics(ctx).map(row => row.event), ["oauth_callback_invalid"]);
  assert.equal(ctx.calls.length, 0);
});

test("Google diagnostic logger discards unknown events, fields and error codes; desktop is silent", t => {
  const ctx = setupGoogle(t, { mobile: true });
  const diagnostics = require("../services/googleOAuthDiagnostics.ts");
  const hostile = { mode: "warm", origin: "onOpenUrl", durationMs: 1.4, httpStatus: 400, errorCode: "fixture-secret", callback: "scisonomics://auth/callback?code=fixture-secret", email: "qa@example.test", access_token: "fixture-secret", refresh_token: "fixture-secret", code_verifier: "fixture-secret", stack: "fixture-secret" };
  diagnostics.logGoogleOAuthDiagnostic("oauth_exchange_failed", hostile);
  diagnostics.logGoogleOAuthDiagnostic("oauth_exchange_failed", { ...hostile, httpStatus: 999, durationMs: Infinity, errorCode: "pkce_code_verifier_not_found" });
  diagnostics.logGoogleOAuthDiagnostic("fixture-secret", hostile);
  const logs = assertSafeDiagnostics(ctx); assert.equal(logs.length, 2);
  assert.equal(logs[0].error_code, "unknown"); assert.equal(logs[0].duration_ms, 1);
  assert.equal(logs[1].error_code, "pkce_verifier_missing"); assert.equal(logs[1].http_status, undefined);
  ctx.browser.navigator.userAgent = "Windows NT";
  diagnostics.logGoogleOAuthDiagnostic("oauth_exchange_failed", hostile);
  assert.equal(diagnosticEvents().length, 2);
});

test("Android Google diagnostic context survives device OTP and reports final session-store failure", async t => {
  const ctx = setupGoogle(t, { mobile: true }); ctx.devicePending = true;
  await ctx.google.signInWithGoogleSupabase();
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  assert.equal(ctx.external.getPendingDeviceState().required, true);
  assert.deepEqual(assertSafeDiagnostics(ctx), []);
  ctx.refreshSaveError = true;
  await assert.rejects(ctx.external.verifyNewDeviceCode("444444"));
  assert.equal(ctx.external.getPendingDeviceState().diagnosticCode, "oauth_session_store_failed");
  assert.ok(assertSafeDiagnostics(ctx).some(row => row.event === "oauth_session_store_failed"));
  ctx.refreshSaveError = false;
  await ctx.external.verifyNewDeviceCode("444444");
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
  assert.ok(!assertSafeDiagnostics(ctx).some(row => row.event === "oauth_completed"));
  assert.equal(ctx.external.getPendingDeviceState().diagnosticCode, undefined);
});

test("iOS Google is disabled even with a Tauri bridge", async t => {
  const ctx = setupGoogle(t);
  ctx.browser.navigator.userAgent = "iPhone";
  await assert.rejects(ctx.google.signInWithGoogleSupabase(), e => e.code === "supabase_oauth_mobile_pending");
  assert.equal(ctx.nativeCalls.length, 0);
  assert.equal(ctx.openedUrls.length, 0);
});

test("Android source declares a restricted OAuth intent without changing desktop registration", () => {
  const android = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.android.conf.json"), "utf8"));
  const desktop = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  assert.deepEqual(android.plugins["deep-link"].mobile, [{ scheme: ["scisonomics"], host: "auth", path: ["/callback"], appLink: false }]);
  assert.deepEqual(desktop.plugins["deep-link"].desktop, { schemes: ["scisonomics"] });
  assert.equal(desktop.plugins["deep-link"].mobile, undefined);
});

test("Android without native secure storage never starts Google or writes web secrets", async t => {
  const ctx = setupGoogle(t, { mobile: true });
  delete ctx.browser.__TAURI_INTERNALS__;
  await assert.rejects(ctx.google.signInWithGoogleSupabase(), e => e.code === "supabase_oauth_desktop_required");
  assert.equal(ctx.nativeCalls.length, 0);
  assert.equal(ctx.openedUrls.length, 0);
  assert.equal(ctx.credentials.size, 0);
});

test("Android rejects token-bearing pending snapshots before any native save", async t => {
  const ctx = setupGoogle(t, { mobile: true });
  const storage = require("../services/supabaseOAuthStorage.ts");
  await ctx.google.signInWithGoogleSupabase();
  const value = decodePending([...ctx.credentials.values()][0], true), calls = ctx.nativeCalls.length;
  await assert.rejects(storage.savePendingGoogleOAuth({ ...value, refresh_token: "fixture-secret" }), e => e.code === "supabase_oauth_storage_failed");
  await assert.rejects(storage.savePendingGoogleOAuth({ ...value, storage: { ...value.storage, access_token: "fixture-secret" } }), e => e.code === "supabase_oauth_storage_failed");
  assert.equal(ctx.nativeCalls.length, calls);
});

for (const mutation of ["plain", "foreign-origin", "wrong-redirect", "duplicate-challenge"]) test(`Android refuses unsafe authorize URL: ${mutation}`, async t => {
  const ctx = setupGoogle(t, { mobile: true });
  const create = ctx.config.createSupabaseAuthClient;
  t.mock.method(ctx.config, "createSupabaseAuthClient", (...args) => {
    const client = create(...args), start = client.auth.signInWithOAuth.bind(client.auth);
    t.mock.method(client.auth, "signInWithOAuth", async options => {
      const result = await start(options), url = new URL(result.data.url);
      if (mutation === "plain") url.searchParams.set("code_challenge_method", "plain");
      if (mutation === "foreign-origin") url.hostname = "evil.example.test";
      if (mutation === "wrong-redirect") url.searchParams.set("redirect_to", "scisonomics://evil/callback");
      if (mutation === "duplicate-challenge") url.searchParams.append("code_challenge", "invalid");
      return { ...result, data: { ...result.data, url: url.href } };
    });
    return client;
  });
  await ctx.google.signInWithGoogleSupabase();
  assert.equal(ctx.google.getGoogleOAuthState().status, "error");
  assert.equal(ctx.openedUrls.length, 0);
  assert.equal(ctx.credentials.size, 0);
  assert.equal(ctx.calls.length, 0);
});

test("Android Google keeps matching archived owner behind recovery until an explicit decision", async t => {
  const oldFlag = process.env.NEXT_PUBLIC_SCISONOMICS_MOBILE_ACCOUNT_RECOVERY;
  process.env.NEXT_PUBLIC_SCISONOMICS_MOBILE_ACCOUNT_RECOVERY = "1";
  t.after(() => { if (oldFlag === undefined) delete process.env.NEXT_PUBLIC_SCISONOMICS_MOBILE_ACCOUNT_RECOVERY; else process.env.NEXT_PUBLIC_SCISONOMICS_MOBILE_ACCOUNT_RECOVERY = oldFlag; });
  const ctx = setupGoogle(t, { mobile: true });
  const recovery = require("../services/mobileRecoveryState.ts");
  recovery.quarantineMobileAccounts({ activeOwnerId: "previous-owner", accounts: [{ authProvider: "supabase", storage: "persistent", user: { id: "previous-owner", email: " ALICE@EXAMPLE.COM " } }] });
  ctx.devicePending = true;
  await ctx.google.signInWithGoogleSupabase();
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(recovery.isMobileRecoveryBlocked(), true);
  await ctx.external.verifyNewDeviceCode("444444");
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
  assert.equal(ctx.cloud.getActiveAccount().authEnvironment, recovery.currentCloudEnvironment());
  assert.equal(recovery.recoverySources()[0].email, recovery.normalizeRecoveryEmail(ctx.cloud.getActiveAccount().user.email));
  assert.equal(recovery.recoverySources()[0].ownerId, "previous-owner");
  assert.equal(recovery.isMobileRecoveryBlocked(), true);
  const core = require("@tauri-apps/api/core"), invoke = core.invoke;
  t.mock.method(core, "invoke", async (command, args) => {
    if (command !== "mobile_sql_transaction") return invoke(command, args);
    assert.ok(args.statements.every(s => s.sql.startsWith("CREATE TABLE IF NOT EXISTS mobile_account_recovery")));
    return [];
  });
  t.mock.method(require("../services/data/mobileDatabase.ts"), "getMobileDatabase", async () => ({ select: async (sql, owners) => {
    if (sql.startsWith("SELECT target_owner")) return [];
    assert.ok(sql.includes("count(*)"), "inventory only");
    return [{ categories: owners[0] === "previous-owner" ? 1 : 0, movements: owners[0] === "previous-owner" ? 2 : 0 }];
  } }));
  assert.deepEqual(await require("../services/data/mobileAccountRecovery.ts").findMobileRecovery("sciso-A"), {
    sourceOwner: "previous-owner", targetOwner: "sciso-A", categories: 1, movements: 2, blocked: false,
  });
  const calls = ctx.calls.length;
  await assert.rejects(require("../services/data/mobileCloudPull.ts").getMobileCloudSession("sciso-A"), /Revisá primero/);
  assert.equal(ctx.calls.length, calls);
  assert.doesNotMatch(ctx.browser.localStorage.dump() + ctx.browser.sessionStorage.dump(), /supabase-access|supabase-refresh|code-verifier|google-alice-code/);
  recovery.finishRecoverySource("previous-owner", "separate");
  assert.equal(recovery.isMobileRecoveryBlocked(), false);
});

for (const mobile of [false, true]) {
const googleTest = (name, fn) => test(`${mobile ? "Android" : "Desktop"}: ${name}`, fn);
googleTest("Google URL uses fixed native callback and PKCE S256, with pending verifier only in secure storage", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase({ remember: true });
  assert.equal(ctx.google.getGoogleOAuthState().status, "waiting");
  assert.equal(ctx.openedUrls.length, 1);
  const url = ctx.openedUrls[0];
  assert.equal(url.origin, "https://identity.test");
  assert.equal(url.pathname, "/auth/v1/authorize");
  assert.equal(url.searchParams.get("provider"), "google");
  assert.equal(url.searchParams.get("redirect_to"), "scisonomics://auth/callback");
  assert.equal(ctx.calls.length, 0); // URL generation opens only the native opener.
  assert.equal(url.searchParams.get("code_challenge_method"), "s256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.credentials.size, 1);
  const payload = decodePending([...ctx.credentials.values()][0], mobile);
  assert.ok(Object.keys(payload.storage).every((key) => key.endsWith("-code-verifier")));
  assert.doesNotMatch(ctx.browser.localStorage.dump() + ctx.browser.sessionStorage.dump(), /code-verifier|pkce|google-alice-code/);
});

googleTest("Google callback exchanges PKCE, bootstraps the internal owner and remembers refresh in WinCred", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase({ remember: true });
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  assert.deepEqual(ctx.google.getGoogleOAuthState(), { status: "succeeded", ownerId: "sciso-A" });
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
  assert.notEqual(ctx.cloud.getActiveOwnerId(), subjects["alice@example.com"]);
  assert.equal(ctx.cloud.getActiveAccount().storage, "persistent");
  assert.equal(ctx.credentials.size, 1);
  assert.ok([...ctx.credentials.keys()][0].endsWith("::sciso-A"));
  assert.equal(ctx.calls[0].url.searchParams.get("grant_type"), "pkce");
  assert.equal(ctx.calls[1].url.pathname, "/auth/supabase/bootstrap");
  assert.ok(ctx.nativeCalls.findIndex((call) => call.command === "delete_pending_supabase_oauth" || (call.command === "plugin:mobile-secure-storage|delete" && call.accountId.endsWith("::pending_google")))
    < ctx.nativeCalls.findIndex((call) => call.command === "save_persistent_supabase_refresh_token" || (call.command === "plugin:mobile-secure-storage|save" && !call.accountId.endsWith("::pending_google"))));
  assert.doesNotMatch(ctx.browser.localStorage.dump(), /google-alice-code|supabase-access|supabase-refresh|code-verifier/);
  assert.doesNotMatch(ctx.browser.sessionStorage.dump(), /google-alice-code|supabase-refresh|code-verifier/);
});

googleTest("Google temporary session keeps refresh out of WinCred and browser persistence", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase({ remember: false });
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-bob-code");
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-B");
  assert.equal(ctx.cloud.getActiveAccount().storage, "session");
  assert.equal(ctx.credentials.size, 0);
});

googleTest("Google callback missing code requires a fresh attempt without activating any account", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase();
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?error_code=missing_code");
  assert.equal(ctx.google.getGoogleOAuthState().status, "error");
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.credentials.size, 0);
  await ctx.google.signInWithGoogleSupabase();
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
});

googleTest("concurrent and repeated Google callbacks exchange/bootstrap once", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase();
  const url = "scisonomics://auth/callback?code=google-alice-code";
  await Promise.all([ctx.google.handleSupabaseGoogleCallback(url), ctx.google.handleSupabaseGoogleCallback(url)]);
  await ctx.google.handleSupabaseGoogleCallback(url);
  assert.equal(ctx.calls.filter((call) => call.url.pathname.endsWith("/token")).length, 1);
  assert.equal(ctx.calls.filter((call) => call.url.pathname === "/auth/supabase/bootstrap").length, 1);
  assert.equal(ctx.google.getGoogleOAuthState().status, "succeeded");
});

for (const reason of ["exchange", "bootstrap", "unconfirmed email"]) {
  googleTest(`Google ${reason} failure never activates an account or saves refresh`, async (t) => {
    const ctx = setupGoogle(t, { mobile });
    ctx.exchangeError = reason === "exchange";
    ctx.oauthUnconfirmed = reason === "unconfirmed email";
    if (reason === "bootstrap") ctx.backendError = { status: 409, detail: { code: "internal_account_required" } };
    await ctx.google.signInWithGoogleSupabase();
    await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
    assert.equal(ctx.google.getGoogleOAuthState().status, "error");
    assert.doesNotMatch(ctx.google.getGoogleOAuthState().message, /Sensitive|google-alice-code|supabase-access/);
    assert.equal(ctx.cloud.getActiveOwnerId(), "local");
    assert.equal(ctx.credentials.size, 0);
    if (reason !== "bootstrap") assert.ok(!ctx.calls.some((call) => call.url.pathname === "/auth/supabase/bootstrap"));
  });
}

googleTest("cancelled Google and unsolicited startup callbacks cannot activate local mode", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase();
  await ctx.google.cancelGoogleSupabaseSignIn();
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.credentials.size, 0);
});

googleTest("denied Google consent cleans pending state without exchanging a code", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase();
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?error=access_denied&error_description=Sensitive");
  assert.equal(ctx.google.getGoogleOAuthState().status, "error");
  assert.doesNotMatch(ctx.google.getGoogleOAuthState().message, /Sensitive/);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.credentials.size, 0);
});

googleTest("cold startup restores only the secure PKCE verifier, consumes it and bootstraps internal identity", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase();
  const saved = [...ctx.credentials.entries()][0];
  // Simulate process termination: memory/timers disappear, native entry stays.
  await ctx.google.cancelGoogleSupabaseSignIn();
  ctx.credentials.set(saved[0], saved[1]);
  const cold = loadServices();
  await cold.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  assert.equal(cold.google.getGoogleOAuthState().ownerId, "sciso-A");
  assert.equal(cold.cloud.getActiveOwnerId(), "sciso-A");
  assert.ok(!ctx.credentials.has(saved[0]));
});

googleTest("expired native PKCE attempt is removed and requires a new Google login", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase();
  const [key, payload] = [...ctx.credentials.entries()][0];
  await ctx.google.cancelGoogleSupabaseSignIn();
  ctx.credentials.set(key, encodePending({ ...decodePending(payload, mobile), expiresAt: Date.now() - 1 }, mobile));
  const cold = loadServices();
  await cold.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  assert.equal(cold.google.getGoogleOAuthState().status, "error");
  assert.equal(ctx.credentials.size, 0);
  assert.equal(ctx.calls.length, 0);
});

googleTest("deep-link bridge subscribes before getCurrent and handles runtime/startup delivery once", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase();
  let handler, stopped = false;
  const url = "scisonomics://auth/callback?code=google-alice-code";
  const stop = await ctx.google.connectSupabaseGoogleDeepLinks({
    onOpenUrl: async (callback) => { handler = callback; return () => { stopped = true; }; },
    getCurrent: async () => { assert.ok(handler); handler([url]); return [url]; },
  });
  // Await completion through a subscriber without retaining the callback code.
  if (ctx.google.getGoogleOAuthState().status !== "succeeded") await new Promise((resolve) => {
    const unsubscribe = ctx.google.subscribeGoogleOAuth(() => {
      if (ctx.google.getGoogleOAuthState().status === "succeeded") { unsubscribe(); resolve(); }
    });
  });
  assert.equal(ctx.calls.filter((call) => call.url.pathname.endsWith("/token")).length, 1);
  stop();
  assert.equal(stopped, true);
});

googleTest("callback parser rejects unexpected schemes, paths, duplicate/unknown params and implicit credentials", (t) => {
  const { callback } = setup(t);
  for (const raw of ["https://auth/callback?code=x", "scisonomics://evil/callback?code=x", "scisonomics://auth/other?code=x",
    "scisonomics://auth/callback/../callback?code=x", "scisonomics://auth/callback?code=a&code=b", "scisonomics://auth/callback?code=x&redirectTo=https://evil.test",
    "scisonomics://auth/callback?code=x#access_token=secret", "scisonomics://auth/callback?access_token=secret", "scisonomics://auth/callback?code=%20x",
    "scisonomics://user@auth/callback?code=x", "scisonomics://auth:80/callback?code=x", "scisonomics://auth/callback"]) {
    assert.throws(() => callback.parseSupabaseOAuthCallback(raw), (error) => error.code === "supabase_oauth_callback_invalid");
  }
  assert.deepEqual(callback.parseSupabaseOAuthCallback("scisonomics://auth/callback?code=abc-123"), { code: "abc-123" });
});

googleTest("Google requires desktop/configuration and leaves local mode intact", async (t) => {
  const ctx = setup(t, { configured: false });
  await assert.rejects(ctx.google.signInWithGoogleSupabase(), (error) => error.code === "supabase_oauth_desktop_required");
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.calls.length, 0);
});

googleTest("two Google accounts isolate SDK storage/verifiers and keep distinct internal owners and secure refresh", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  await ctx.google.signInWithGoogleSupabase();
  const firstKey = decodePending([...ctx.credentials.values()][0], mobile).storageKey;
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  await ctx.google.signInWithGoogleSupabase();
  const pending = [...ctx.credentials.entries()].find(([key]) => key.startsWith("pkce:") || key.endsWith("::pending_google"));
  assert.notEqual(decodePending(pending[1], mobile).storageKey, firstKey);
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  assert.equal(ctx.google.getGoogleOAuthState().status, "waiting"); // Old callback cannot consume the new attempt.
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-bob-code");
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-B");
  assert.deepEqual(ctx.cloud.getStoredAccounts().map((account) => account.user.id).sort(), ["sciso-A", "sciso-B"]);
  assert.equal(ctx.credentials.size, 2);
  assert.ok([...ctx.credentials.keys()].every((key) => /::sciso-[AB]$/.test(key)));
});

googleTest("Google rejects missing configuration inside Tauri without affecting local mode", async (t) => {
  const ctx = setupGoogle(t, { mobile, configured: false });
  await assert.rejects(ctx.google.signInWithGoogleSupabase(), (error) => error.code === "supabase_not_configured");
  assert.equal(ctx.google.getGoogleOAuthState().status, "idle");
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.openedUrls.length, 0);
});

googleTest("Google refuses PKCE without WebCrypto instead of opening an implicit or plain flow", async (t) => {
  const ctx = setupGoogle(t, { mobile });
  // The guard runs before the first await. Restore the builtin immediately:
  // Node's test runner itself uses WebCrypto while completing a test.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let result;
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    result = ctx.google.signInWithGoogleSupabase();
  } finally { Object.defineProperty(globalThis, "crypto", descriptor); }
  await assert.rejects(result, (error) => error.code === "supabase_pkce_unavailable");
  assert.equal(ctx.google.getGoogleOAuthState().status, "idle");
  assert.equal(ctx.openedUrls.length, 0);
  assert.equal(ctx.credentials.size, 0);
});

for (const reason of ["secure storage", "external opener"]) {
  googleTest(`Google ${reason} failure is explicit and never falls back to browser persistence`, async (t) => {
    const ctx = setupGoogle(t, { mobile });
    ctx.nativeError = reason === "secure storage";
    ctx.openerError = reason === "external opener";
    await ctx.google.signInWithGoogleSupabase();
    assert.equal(ctx.google.getGoogleOAuthState().status, "error");
    assert.doesNotMatch(ctx.google.getGoogleOAuthState().message, /Sensitive|code_challenge|code-verifier/);
    assert.equal(ctx.cloud.getActiveOwnerId(), "local");
    assert.equal(ctx.credentials.size, 0);
    assert.doesNotMatch(ctx.browser.localStorage.dump() + ctx.browser.sessionStorage.dump(), /pkce|code-verifier/);
    ctx.nativeError = false;
  });
}

}

test("Supabase login bootstraps the internal account and stores only the internal owner", async (t) => {
  const { cloud, external, calls, browser } = setup(t);
  const user = await external.signInWithPassword("alice@example.com", "correct password");
  assert.equal(user.id, "sciso-A");
  assert.equal(cloud.getActiveOwnerId(), "sciso-A");
  assert.equal(cloud.getStoredAccounts()[0].authProvider, "supabase");
  assert.equal(cloud.getStoredAccounts()[0].storage, "session");
  const session = await external.getSession();
  assert.equal(session.user.id, "sciso-A");
  assert.match(session.token, /^supabase-access/);
  const bootstrap = calls.find((call) => call.url.pathname === "/auth/supabase/bootstrap");
  assert.equal(bootstrap.headers.get("Authorization"), `Bearer ${session.token}`);
  assert.equal(bootstrap.method, "POST");
  assert.deepEqual(bootstrap.body, {});
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

test("failed bootstrap does not create or activate an account", async (t) => {
  const ctx = setup(t);
  ctx.backendError = { status: 403, detail: { code: "internal_account_required", message: "No internal account" } };
  await assert.rejects(ctx.external.signInWithPassword("alice@example.com", "correct"), (error) => error.code === "internal_account_required" && error.message.includes("alta interna"));
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.cloud.getStoredAccounts().length, 0);
  assert.deepEqual(ctx.calls.filter((call) => call.url.host === "cloud.test").map((call) => call.url.pathname), ["/auth/supabase/bootstrap"]);
});

test("signup without a session requires OTP without activating or persisting an account", async (t) => {
  const { external, cloud, calls } = setup(t);
  const result = await external.signUpWithPassword("alice@example.com", "long test password", "Alice");
  assert.equal(result.status, "verification_required");
  assert.equal(result.email, "alice@example.com");
  assert.equal(cloud.getActiveOwnerId(), "local");
  assert.equal(cloud.getStoredAccounts().length, 0);
  assert.equal(calls.filter((call) => call.url.host === "cloud.test").length, 0);
  assert.equal(calls.find((call) => call.url.pathname.endsWith("/signup")).body.email_redirect_to, undefined);
});

for (const code of ["email_exists", "user_already_exists"]) {
  test(`signup with explicit ${code} does not enter OTP or reveal provider details`, async (t) => {
    const ctx = setup(t);
    ctx.signupError = { code, status: 422 };
    const result = await ctx.external.signUpWithPassword("alice@example.com", "long test password");
    assert.deepEqual(result, { status: "account_exists" });
    assert.equal(ctx.cloud.getActiveOwnerId(), "local");
    assert.deepEqual(ctx.cloud.getStoredAccounts(), []);
    assert.deepEqual(ctx.calls.map((call) => call.url.pathname), ["/auth/v1/signup"]);
    assert.doesNotMatch(JSON.stringify(result), /Sensitive|email|alice@example.com/);
  });
}

for (const identities of [[], undefined]) {
  test(`ambiguous signup identities ${identities ? "empty" : "missing"} uses neutral outcome without OTP`, async (t) => {
    const ctx = setup(t);
    ctx.signupIdentities = identities;
    const result = await ctx.external.signUpWithPassword("alice@example.com", "long test password");
    assert.deepEqual(result, { status: "generic_signup_error" });
    assert.equal(ctx.cloud.getActiveOwnerId(), "local");
    assert.deepEqual(ctx.cloud.getStoredAccounts(), []);
    assert.deepEqual(ctx.calls.map((call) => call.url.pathname), ["/auth/v1/signup"]);
  });
}

test("unstructured signup error never claims the email exists or exposes provider text", async (t) => {
  const ctx = setup(t);
  ctx.signupError = { status: 400 };
  const result = await ctx.external.signUpWithPassword("alice@example.com", "long test password");
  assert.deepEqual(result, { status: "generic_signup_error" });
  assert.doesNotMatch(JSON.stringify(result), /Sensitive|alice@example.com/);
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
});

test("signup OTP verifies with email type, bootstraps and remembers the internal owner in Tauri", async (t) => {
  const ctx = setup(t, { tauri: true });
  const result = await ctx.external.signUpWithPassword(" alice@example.com ", "long test password");
  assert.equal(result.status, "verification_required");
  assert.equal(ctx.credentials.size, 0);
  const user = await ctx.external.verifyEmailCode(result.email, " 001234 ", { remember: true });
  assert.equal(user.id, "sciso-A");
  assert.notEqual(user.id, subjects["alice@example.com"]);
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
  assert.equal(ctx.cloud.getActiveAccount().storage, "persistent");
  const verify = ctx.calls.find((call) => call.url.pathname.endsWith("/verify"));
  assert.equal(verify.body.email, "alice@example.com");
  assert.equal(verify.body.token, "001234");
  assert.equal(verify.body.type, "email");
  const bootstrap = ctx.calls.find((call) => call.url.pathname === "/auth/supabase/bootstrap");
  assert.ok(ctx.calls.indexOf(verify) < ctx.calls.indexOf(bootstrap));
  assert.deepEqual(bootstrap.body, {});
  assert.equal(bootstrap.headers.get("Authorization"), `Bearer ${(await ctx.external.getSession()).token}`);
  assert.equal(ctx.credentials.size, 1);
  assert.ok([...ctx.credentials.keys()].every((key) => key.endsWith("::sciso-A")));
  assert.doesNotMatch(ctx.browser.localStorage.dump(), /001234|supabase-(refresh|access)/);
  assert.doesNotMatch(ctx.browser.sessionStorage.dump(), /001234|supabase-refresh/);
});

test("malformed OTP is rejected clearly without making a network request", async (t) => {
  const ctx = setup(t);
  await assert.rejects(ctx.external.verifyEmailCode("alice@example.com", "not-a-code"), (error) => error.code === "invalid_otp" && error.message.includes("Código inválido"));
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.cloud.getStoredAccounts().length, 0);
});

for (const reason of ["incorrect", "expired"]) {
  test(`${reason} signup OTP never bootstraps, stores a credential or replaces the active legacy owner`, async (t) => {
    const ctx = setup(t, { tauri: true });
    const legacy = await ctx.cloud.cloudAuth.login({ email: "alice@example.com", password: "correct" });
    await ctx.cloud.addOrUpdateAccount({ user: legacy.user, tokens: ctx.cloud.getCloudAuthTokens(legacy) }, { remember: true });
    // Supabase uses otp_expired for both wrong and expired numeric tokens.
    ctx.otpError = { code: "otp_expired", status: 403 };
    await assert.rejects(ctx.external.verifyEmailCode("bob@example.com", reason === "incorrect" ? "999999" : "111111"),
      (error) => error.code === "otp_expired" && /inválido|venció/.test(error.message) && !error.message.includes("Secret"));
    assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
    assert.equal(ctx.cloud.getActiveAccount().authProvider, "legacy");
    assert.deepEqual([...ctx.credentials.keys()], ["sciso-A"]);
    assert.ok(!ctx.calls.some((call) => call.url.pathname === "/auth/supabase/bootstrap"));
  });
}

test("verification rate limit tells the user to wait without activating an owner", async (t) => {
  const ctx = setup(t);
  ctx.otpError = { code: "over_request_rate_limit", status: 429 };
  await assert.rejects(ctx.external.verifyEmailCode("alice@example.com", "123456"),
    (error) => error.statusCode === 429 && error.message.includes("Demasiados intentos"));
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
});

test("resending signup uses the existing signup email and never sends an OTP or creates an owner", async (t) => {
  const ctx = setup(t);
  await ctx.external.resendSignupVerification(" alice@example.com ");
  const resend = ctx.calls.find((call) => call.url.pathname.endsWith("/resend"));
  assert.equal(resend.body.type, "signup");
  assert.equal(resend.body.email, "alice@example.com");
  assert.equal(resend.body.token, undefined);
  assert.equal(resend.body.email_redirect_to, undefined);
  assert.equal(ctx.cloud.getStoredAccounts().length, 0);
});

test("temporarily blocked resend shows a clear error and keeps verification usable", async (t) => {
  const ctx = setup(t);
  ctx.resendError = { code: "over_email_send_rate_limit", status: 429 };
  await assert.rejects(ctx.external.resendSignupVerification("alice@example.com"),
    (error) => error.code === "over_email_send_rate_limit" && error.message.includes("temporalmente bloqueado"));
  ctx.resendError = null;
  await ctx.external.resendSignupVerification("alice@example.com");
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
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
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.cloud.getStoredAccounts().length, 0);
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

test("Premium remains scoped to the internal owner across cloud and local accounts", async (t) => {
  const ctx = setup(t);
  const entitlements = require("../services/entitlements.ts");
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  assert.equal(ctx.cloud.getActiveOwnerId(), internalIds["alice@example.com"]);
  assert.notEqual(ctx.cloud.getActiveOwnerId(), subjects["alice@example.com"]);
  assert.equal((await entitlements.loadEntitlements({ force: true })).plan, "premium");
  ctx.cloud.switchToLocalMode();
  assert.equal((await entitlements.loadEntitlements({ force: true })).plan, "free");
  assert.equal(entitlements.getCachedEntitlements("sciso-A").plan, "premium");
  await ctx.external.signInWithPassword("bob@example.com", "correct");
  assert.equal((await entitlements.loadEntitlements({ force: true })).plan, "free");
  assert.equal(entitlements.getCachedEntitlements("sciso-A").plan, "premium");
});

test("password recovery rejects an invalid or expired code without changing a password", async (t) => {
  const ctx = setup(t);
  ctx.otpError = { code: "otp_expired", status: 403 };
  await assert.rejects(ctx.external.completePasswordRecovery("alice@example.com", "000000", "new long password"),
    (error) => error.code === "otp_expired" && /venció/.test(error.message));
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.ok(!ctx.calls.some((call) => call.method === "PUT" && call.url.pathname.endsWith("/user")));
});

test("password recovery cannot update a different verified email or internal owner", async (t) => {
  const ctx = setup(t);
  ctx.recoveryEmailOverride = "bob@example.com";
  await assert.rejects(ctx.external.completePasswordRecovery("alice@example.com", "123456", "new long password"),
    (error) => error.code === "recovery_identity_invalid");
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.deepEqual(ctx.cloud.getStoredAccounts(), []);
  assert.ok(!ctx.calls.some((call) => call.method === "PUT" && call.url.pathname.endsWith("/user")));
  assert.ok(!ctx.calls.some((call) => call.url.pathname === "/auth/supabase/bootstrap"));
});

test("visible account form offers only email, Google, signup and in-app recovery", (t) => {
  setup(t);
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { SupabaseAccountForm } = require("../components/account/SupabaseAccountForm.tsx");
  const html = renderToStaticMarkup(React.createElement(SupabaseAccountForm,
    { onAuthenticated() {}, onBusyChange() {} }));
  for (const label of ["Iniciar sesión", "Email", "Contraseña", "Continuar con Google",
    "¿No tenés cuenta? Crear cuenta", "¿Olvidaste tu contraseña?"]) assert.ok(html.includes(label), label);
  for (const hidden of ["Acceso anterior", "Legacy", "Supabase", "Google legacy"]) assert.ok(!html.includes(hidden), hidden);
  const modal = fs.readFileSync(path.join(root, "components/account/AddAccountModal.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(root, "components/account/AccountPanel.tsx"), "utf8");
  assert.match(modal, /<SupabaseAccountForm/);
  assert.match(panel, /<SupabaseAccountForm/);
  for (const source of [modal, panel]) assert.doesNotMatch(source, /cloudAuth\.(login|register|googleStart)|Acceso anterior|defaultProvider/);
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

test("revoked persisted Supabase refresh is cleared without using legacy", async (t) => {
  const ctx = setup(t, { tauri: true });
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  ctx.browser.sessionStorage.data.clear();
  ctx.rejectRefresh = true;
  const reloaded = loadServices();
  assert.equal(await reloaded.cloud.getValidAccessToken(), null);
  assert.equal(ctx.credentials.size, 0);
  assert.equal((await reloaded.cloud.getActiveCloudAuthState()).availability, "session_expired");
  assert.ok(!ctx.calls.some((call) => call.url.pathname === "/auth/refresh"));
});

for (const mobile of [false, true]) test(`${mobile ? "Android" : "Windows"} signs in again over a saved expired account without removing it`, async t => {
  const ctx = setup(t, {tauri: true, mobile});
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  ctx.browser.sessionStorage.data.clear();
  ctx.rejectRefresh = true;
  const reloaded = loadServices();
  assert.equal((await reloaded.cloud.getActiveCloudAuthState()).availability, "session_expired");
  assert.equal(reloaded.cloud.getStoredAccounts().length, 1);
  const callsBeforeLogin = ctx.calls.length;
  assert.equal((await reloaded.external.signInWithPassword("alice@example.com", "correct")).id, "sciso-A");
  assert.equal((await reloaded.cloud.getActiveCloudAuthState()).availability, "active");
  assert.equal(reloaded.cloud.getActiveOwnerId(), "sciso-A");
  assert.equal(reloaded.cloud.getStoredAccounts().length, 1);
  assert.equal(ctx.credentials.size, 1);
  assert.equal(reloaded.external.getPendingDeviceState().required, false);
  assert.ok(!ctx.calls.slice(callsBeforeLogin).some(call => call.url.searchParams.get("grant_type") === "refresh_token"));
});

test("native rotation failure is visible in persistence status and never falls back to localStorage", async (t) => {
  const ctx = setup(t, { tauri: true });
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  ctx.nativeError = true;
  await ctx.cloud.forceRefreshActiveCloudSession();
  assert.equal((await ctx.cloud.getActiveCloudAuthState()).persistenceStatus, "failed");
  assert.doesNotMatch(ctx.browser.localStorage.dump(), /supabase-(access|refresh)/);
  ctx.nativeError = false;
  await ctx.cloud.forceRefreshActiveCloudSession();
  assert.equal((await ctx.cloud.getActiveCloudAuthState()).persistenceStatus, "ok");
});

test("a late legacy native save cannot replace a newly activated Supabase provider", async (t) => {
  const ctx = setup(t, { tauri: true });
  const response = await ctx.cloud.cloudAuth.login({ email: "alice@example.com", password: "correct" });
  await ctx.cloud.addOrUpdateAccount({ user: response.user, tokens: ctx.cloud.getCloudAuthTokens(response) }, { remember: true });
  let release;
  ctx.pauseLegacySave = new Promise((resolve) => { release = resolve; });
  const pending = ctx.cloud.forceRefreshActiveCloudSession();
  await new Promise((resolve) => setImmediate(resolve));
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  release();
  await pending;
  assert.equal(ctx.cloud.getActiveAccount().authProvider, "supabase");
  assert.match((await ctx.cloud.getValidAccessToken()).token, /^supabase-access/);
});

test("restoration never publishes a token for a different internal owner", async (t) => {
  const ctx = setup(t, { tauri: true });
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  ctx.browser.sessionStorage.data.clear();
  const reloaded = loadServices();
  const me = reloaded.cloud.cloudAuth.me;
  t.mock.method(reloaded.cloud.cloudAuth, "me", async (token) => ({ ...(await me(token)), id: "wrong-owner" }));
  assert.equal(await reloaded.cloud.getValidAccessToken(), null);
  assert.equal(reloaded.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.credentials.size, 0);
});

test("Tauri stores only Supabase refresh in its separate project and internal owner namespace", async (t) => {
  const ctx = setup(t, { tauri: true });
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  assert.equal(ctx.cloud.getStoredAccounts()[0].storage, "persistent");
  const [key, token] = [...ctx.credentials][0];
  assert.match(key, /^supabase:[0-9a-f]{64}::sciso-A$/);
  assert.match(token, /^supabase-refresh/);
  assert.doesNotMatch(key, new RegExp(subjects["alice@example.com"]));
  assert.doesNotMatch(ctx.browser.localStorage.dump(), /supabase-(access|refresh)/);
  assert.doesNotMatch(ctx.browser.sessionStorage.dump(), /supabase-refresh/);
  assert.equal((await ctx.cloud.getActiveCloudAuthState()).persistenceStatus, "ok");
});

test("persistent Supabase accounts restore and rotate after a fresh boot with separate owners", async (t) => {
  const ctx = setup(t, { tauri: true });
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  await ctx.external.signInWithPassword("bob@example.com", "correct");
  const previous = new Map(ctx.credentials);
  ctx.browser.sessionStorage.data.clear();
  const reloaded = loadServices();
  assert.equal((await reloaded.cloud.getValidAccessToken("sciso-A")).user.id, "sciso-A");
  assert.equal((await reloaded.cloud.getValidAccessToken("sciso-B")).user.id, "sciso-B");
  assert.equal(reloaded.cloud.getActiveOwnerId(), "sciso-B");
  assert.ok([...ctx.credentials].every(([key, token]) => previous.get(key) !== token));
  assert.ok(!ctx.nativeCalls.some((call) => !call.command.includes("supabase")));
  assert.ok(!ctx.calls.some((call) => call.url.pathname === "/auth/refresh"));
});

test("bootstrap rejection writes no native Supabase credential and preserves legacy", async (t) => {
  const ctx = setup(t, { tauri: true });
  const legacy = await ctx.cloud.cloudAuth.login({ email: "alice@example.com", password: "correct" });
  await ctx.cloud.addOrUpdateAccount({ user: legacy.user, tokens: ctx.cloud.getCloudAuthTokens(legacy) }, { remember: true });
  ctx.backendError = { status: 409, detail: { code: "auth_provider_conflict", message: "Identity conflict" } };
  await assert.rejects(ctx.external.signInWithPassword("bob@example.com", "correct"), (error) => error.code === "auth_provider_conflict");
  assert.deepEqual([...ctx.credentials.keys()], ["sciso-A"]);
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-A");
});

test("native save failure is explicit and never publishes a remembered account", async (t) => {
  const ctx = setup(t, { tauri: true });
  ctx.nativeError = true;
  await assert.rejects(ctx.external.signInWithPassword("alice@example.com", "correct"), (error) => error.code === "supabase_secure_storage_failed" && !error.message.includes("secret"));
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.cloud.getStoredAccounts().length, 0);
  assert.equal(ctx.credentials.size, 0);
});

test("unverified rotation stays in memory until device authorization succeeds", async (t) => {
  const ctx = setup(t, { tauri: true });
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  const [key, old] = [...ctx.credentials][0];
  ctx.backendError = { status: 503, detail: { code: "backend_offline", message: "Try again" } };
  await assert.rejects(ctx.external.refreshSession("sciso-A"), (error) => error.statusCode === 503);
  assert.equal(ctx.credentials.get(key), old, "No persistent rotation before device authorization");
  ctx.backendError = null;
  await ctx.external.refreshSession("sciso-A");
  assert.notEqual(ctx.credentials.get(key), old);
  ctx.browser.sessionStorage.data.clear();
  const reloaded = loadServices();
  assert.equal((await reloaded.cloud.getValidAccessToken("sciso-A")).user.id, "sciso-A");
});

test("Supabase logout deletes its namespace and preserves legacy and another external account", async (t) => {
  const ctx = setup(t, { tauri: true });
  ctx.credentials.set("sciso-A", "dormant-legacy-refresh");
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  await ctx.external.signInWithPassword("bob@example.com", "correct");
  await ctx.cloud.logoutAccount("sciso-A");
  assert.equal(ctx.credentials.get("sciso-A"), "dormant-legacy-refresh");
  assert.ok([...ctx.credentials.keys()].some((key) => key.endsWith("::sciso-B")));
  assert.ok(![...ctx.credentials.keys()].some((key) => key.endsWith("::sciso-A")));
  assert.equal(ctx.cloud.getActiveOwnerId(), "sciso-B");
});

test("temporary Supabase login in Tauri stores no refresh credential", async (t) => {
  const ctx = setup(t, { tauri: true });
  await ctx.external.signInWithPassword("alice@example.com", "correct", { remember: false });
  assert.equal(ctx.credentials.size, 0);
  assert.equal(ctx.cloud.getStoredAccounts()[0].storage, "session");
});

test("legacy Google status sends its request ID only in the POST body", async (t) => {
  setup(t);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ status: "pending" }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const { cloudAuth } = require("../services/cloudAuth.ts");
  const requestId = "A".repeat(43);
  assert.deepEqual(await cloudAuth.googleStatus(requestId), { status: "pending" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/auth/google/status");
  assert.equal(calls[0].url.search, "");
  assert.ok(!calls[0].url.href.includes(requestId));
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { login_request_id: requestId });
});

test("a native delete waits for an in-flight rotation and cannot leave a resurrected credential", async (t) => {
  const ctx = setup(t, { tauri: true });
  await ctx.external.signInWithPassword("alice@example.com", "correct");
  let release;
  ctx.pauseSave = new Promise((resolve) => { release = resolve; });
  const refresh = ctx.external.refreshSession("sciso-A");
  await new Promise((resolve) => setImmediate(resolve));
  const deletion = ctx.cloud.removeAccount("sciso-A");
  release();
  assert.equal(await refresh, null);
  assert.equal((await deletion).ok, true);
  assert.equal(ctx.credentials.size, 0);
  assert.equal(ctx.cloud.getStoredAccounts().length, 0);
});


test("Android storage selects Keystore while Windows retains existing WinCred commands", async t => {
  const ctx=setup(t,{tauri:true,mobile:true});
  const storage=require("../services/secureTokenStorage.ts").getSecureTokenStorage();
  assert.equal(storage.backend,"android-keystore");
  await ctx.external.signInWithPassword("alice@example.com","correct");
  assert(ctx.nativeCalls.some(c=>c.command==="plugin:mobile-secure-storage|save"));
  assert(ctx.nativeCalls.every(c=>c.command.startsWith("plugin:mobile-secure-storage|")));
  ctx.browser.navigator.userAgent="Windows NT";
  assert.equal(require("../services/secureTokenStorage.ts").getSecureTokenStorage().backend,"desktop");
  await require("../services/supabaseTokenStorage.ts").saveSupabaseRefreshToken("sciso-B","dummy-refresh");
  assert.equal(ctx.nativeCalls.at(-1).command,"save_persistent_supabase_refresh_token");
});

test("Android login bootstraps internal users.id and never persists any token in browser storage", async t => {
  const ctx=setup(t,{tauri:true,mobile:true});
  await ctx.external.signInWithPassword("alice@example.com","correct");
  assert.equal(ctx.cloud.getActiveOwnerId(),"sciso-A");
  assert.equal((await ctx.external.getSession()).user.id,"sciso-A");
  assert(ctx.nativeCalls.every(c=>c.accountId.endsWith("::sciso-A")));
  assert.doesNotMatch(ctx.browser.localStorage.dump()+ctx.browser.sessionStorage.dump(),/supabase-access|supabase-refresh|refresh_token|accessToken/);
  assert(ctx.calls.some(c=>c.url.pathname==="/auth/supabase/bootstrap"));
  assert(!ctx.calls.some(c=>c.url.pathname.startsWith("/sync")||c.url.host.includes("localhost")));
});

test("Android persistent sessions survive a cold service reload, rotate and are removed on logout", async t => {
  const ctx=setup(t,{tauri:true,mobile:true});
  await ctx.external.signInWithPassword("alice@example.com","correct");
  const previous=new Map(ctx.credentials);
  ctx.browser.sessionStorage.setItem("scisonomics_cloud_access_tokens_session_v1",JSON.stringify({"sciso-A":{accessToken:"stale-access",expiresAt:"2999-01-01T00:00:00Z",tokenType:"bearer"}}));
  let reloaded=loadServices();
  const restored=await reloaded.external.refreshSession("sciso-A");
  assert.equal(restored.user.id,"sciso-A");
  assert.notEqual(restored.token,"stale-access");
  assert([...ctx.credentials].every(([key,token])=>previous.get(key)!==token));
  assert.equal(ctx.browser.sessionStorage.getItem("scisonomics_cloud_access_tokens_session_v1"),null);
  assert((await reloaded.external.signOut()).ok);
  assert.equal(ctx.credentials.size,0);
  reloaded=loadServices();
  assert.equal(reloaded.cloud.getActiveOwnerId(),"local");
  assert.equal(await reloaded.external.getSession(),null);
});

test("Android multiple accounts retain internal IDs and use independent encrypted storage keys",async t=>{
  const ctx=setup(t,{tauri:true,mobile:true});
  for(const email of ["alice@example.com","bob@example.com"])await ctx.external.signInWithPassword(email,"correct");
  assert.deepEqual(ctx.cloud.getStoredAccounts().map(a=>a.user.id).sort(),["sciso-A","sciso-B"]);
  assert.equal(ctx.credentials.size,2);
  assert.equal(ctx.cloud.getActiveOwnerId(),"sciso-B");
  await ctx.external.signOut("sciso-A");
  assert.equal(ctx.credentials.size,1);
  assert.equal((await ctx.external.getSession()).user.id,"sciso-B");
});

test("Android secure-storage failure cannot activate a remembered account or fall back to plaintext",async t=>{
  const ctx=setup(t,{tauri:true,mobile:true});ctx.nativeError=true;
  await assert.rejects(ctx.external.signInWithPassword("alice@example.com","correct"),e=>e.code==="supabase_secure_storage_failed"&&!e.message.includes("secret"));
  assert.equal(ctx.cloud.getActiveOwnerId(),"local");assert.equal(ctx.credentials.size,0);
  assert.doesNotMatch(ctx.browser.localStorage.dump()+ctx.browser.sessionStorage.dump(),/supabase-refresh|supabase-access/);
});

test("Android signup OTP and Google both use the shared provider",async t=>{
  const ctx=setupGoogle(t,{mobile:true});
  assert.equal((await ctx.external.signUpWithPassword("alice@example.com","correct")).status,"verification_required");
  await ctx.external.verifyEmailCode("alice@example.com","123456");
  assert.equal(ctx.cloud.getActiveOwnerId(),"sciso-A");
  await ctx.google.signInWithGoogleSupabase();
  assert.equal(ctx.google.getGoogleOAuthState().status,"waiting");
  assert.equal(ctx.openedUrls.length,1);
});

test("unsupported storage does not invoke native or provide an insecure fallback",t=>{
  const ctx=setup(t,{tauri:true});ctx.browser.navigator.userAgent="iPhone";
  assert.throws(()=>require("../services/secureTokenStorage.ts").getSecureTokenStorage(),/not_supported/);
  assert.equal(require("../services/supabaseTokenStorage.ts").isSupabaseSecureStorageAvailable(),false);
  delete ctx.browser.__TAURI_INTERNALS__;
  assert.throws(()=>require("../services/secureTokenStorage.ts").getSecureTokenStorage(),/not_available/);
  assert.equal(ctx.nativeCalls.length,0);
});

test("Android password recovery uses OTP without persisting credentials or activating a financial owner", async t => {
  const ctx = setup(t, { tauri: true, mobile: true });
  await ctx.external.requestPasswordReset("alice@example.com");
  await ctx.external.completePasswordRecovery("alice@example.com", "123456", "new long password");
  assert.equal(ctx.cloud.getActiveOwnerId(), "local");
  assert.equal(ctx.cloud.getStoredAccounts().length, 0);
  assert.equal(ctx.credentials.size, 0);
  assert(ctx.calls.some(call => call.method === "PUT" && call.url.pathname.endsWith("/user")));
  assert.doesNotMatch(ctx.browser.localStorage.dump() + ctx.browser.sessionStorage.dump(), /supabase-access|supabase-refresh|new long password/);
});


for (const mobile of [false, true]) test(`${mobile ? "Android" : "Windows"} new device requires OTP before any saved session, then restores`, async (t) => {
  const ctx=setup(t,{tauri:true,mobile});ctx.devicePending=true;
  await assert.rejects(ctx.external.signInWithPassword("alice@example.com","correct"),e=>e.code==="device_verification_required");
  assert.equal(ctx.cloud.getActiveOwnerId(),"local");
  assert.equal(ctx.credentials.size,0);
  assert.equal(ctx.cloud.getStoredAccounts().length,0);
  assert.equal(ctx.external.getPendingDeviceState().required,true);
  assert.doesNotMatch(JSON.stringify(ctx.external.getPendingDeviceState()),/continuation|supabase-access|supabase-refresh|444444/);
  await assert.rejects(ctx.external.verifyNewDeviceCode("111111"),e=>e.code==="device_otp_invalid");
  assert.equal(ctx.credentials.size,0);
  await ctx.external.resendDeviceVerification();
  assert.equal(ctx.credentials.size,0);
  assert.equal((await ctx.external.verifyNewDeviceCode("444444")).id,"sciso-A");
  assert.equal(ctx.external.getPendingDeviceState().required,false);
  assert.equal(ctx.cloud.getActiveOwnerId(),"sciso-A");
  assert.equal(ctx.credentials.size,1);
  ctx.browser.sessionStorage.data.clear();ctx.devicePending=false;
  const reloaded=loadServices();
  assert.equal((await reloaded.cloud.getValidAccessToken("sciso-A")).user.id,"sciso-A");
});

for (const mobile of [false, true]) {
test(`${mobile ? "Android" : "Desktop"} Google device OTP preserves pending client after consuming PKCE`, async t=>{
  const ctx=setupGoogle(t, { mobile });ctx.devicePending=true;
  await ctx.google.signInWithGoogleSupabase({remember:true});
  await ctx.google.handleSupabaseGoogleCallback("scisonomics://auth/callback?code=google-alice-code");
  assert.equal(ctx.google.getGoogleOAuthState().status,"idle");
  assert.equal(ctx.external.getPendingDeviceState().required,true);
  assert.equal(ctx.credentials.size,0);
  assert.equal(ctx.cloud.getActiveOwnerId(),"local");
  await ctx.external.verifyNewDeviceCode("444444");
  assert.equal(ctx.cloud.getActiveOwnerId(),"sciso-A");
  assert.equal(ctx.credentials.size,1);
});

}

test("revoked device clears refresh and account; fresh login requires verification again",async t=>{
  const ctx=setup(t,{tauri:true,mobile:true});
  await ctx.external.signInWithPassword("alice@example.com","correct");
  ctx.deviceRevoked=true;
  await assert.rejects(ctx.external.refreshSession("sciso-A"),e=>e.code==="device_revoked");
  assert.equal(ctx.credentials.size,0);
  assert.equal(ctx.cloud.getActiveOwnerId(),"local");
  assert.equal(ctx.cloud.getStoredAccounts().length,0);
  ctx.devicePending=true;
  await assert.rejects(ctx.external.signInWithPassword("alice@example.com","correct"),e=>e.code==="device_verification_required");
  assert.equal(ctx.credentials.size,0);
});

test("canceling device verification discards the pending login and preserves another account",async t=>{
  const ctx=setup(t,{tauri:true});
  await ctx.external.signInWithPassword("bob@example.com","correct");
  ctx.devicePending=true;
  await assert.rejects(ctx.external.signInWithPassword("alice@example.com","correct"));
  await ctx.external.cancelDeviceVerification();
  assert.equal(ctx.cloud.getActiveOwnerId(),"sciso-B");
  assert.equal(ctx.cloud.getStoredAccounts().length,1);
  assert.equal(ctx.credentials.size,1);
  await assert.rejects(ctx.external.verifyNewDeviceCode("444444"));
});
