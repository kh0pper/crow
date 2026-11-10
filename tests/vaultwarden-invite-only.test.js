/**
 * Security audit N3-4 phase 2e — Vaultwarden is invite-only from the moment it is
 * installed.
 *
 * What this file covers, in order:
 *   1. the handler against a fake Vaultwarden admin API (login form encoding, one
 *      login per operation, cookie reuse/expiry, `_status` mapping, invite 200/409/
 *      500/unreachable, the FULL admin-config POST that closes sign-ups, the
 *      sign-ups HTML parse),
 *   2. the destination (fixed loopback port from the reviewed manifest, `.env`
 *      ignored), no token, and "the token never leaves",
 *   3. the real keychain reader (the same extension entry the install path saved),
 *   4. the card's five states + the adminSaved exception (pure) and the markup,
 *   5. both routes (owner-only, peer refused, 400 without a handler, a look-alike
 *      bundle refused, plain errors),
 *   6. the install path (invite after compose up when the email is set; nothing
 *      without it; nothing for a bundle that only NAMES the handler),
 *   7. the contract rule for `firstAdmin.invite`.
 *
 * Scratch CROW_HOME/CROW_DATA_DIR before anything Crow-side is imported, so this
 * file never reads or writes the operator's ~/.crow. No docker, no real app.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { parseHTML } from "linkedom";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-vw-invite-home-"));
const TMP_DATA = join(TMP_HOME, "data");
const TMP_BUNDLES = mkdtempSync(join(tmpdir(), "crow-vw-invite-src-"));
mkdirSync(TMP_DATA, { recursive: true });
writeFileSync(join(TMP_HOME, "installed.json"), "[]\n");
process.env.CROW_HOME = TMP_HOME;
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: TMP_DATA },
  stdio: "pipe",
  cwd: REPO,
});

const H = await import("../servers/gateway/first-admin/vaultwarden-invite.js");
const REGISTRY = await import("../servers/gateway/first-admin/registry.js");
const FA = await import("../servers/gateway/dashboard/shared/first-admin.js");
const { buildExtensionsHTML } = await import("../servers/gateway/dashboard/panels/extensions/html.js");
const { extensionsClientJS } = await import("../servers/gateway/dashboard/panels/extensions/client.js");
const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const express = (await import("express")).default;
const B = await import("../servers/gateway/routes/bundles.js");

B._setAppBundlesForTest(TMP_BUNDLES);

after(() => {
  B._setAppBundlesForTest(null);
  B._setOwnerCheckForTest(null);
  B._setFirstAdminInviteDepsForTest(null);
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  B._setHookRunnerForTest(null);
  H.clearInviteStateCache();
  H.clearAdminSession();
  for (const d of [TMP_HOME, TMP_BUNDLES]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const INSTALL = "2026-11-09T10:00:00.000Z";
const TOKEN = "Plain-admin-token_1+2/3=";
const OWNER = "owner@example.com";

/** A `.env` fixture bundle dir. */
function envDir(env) {
  const dir = mkdtempSync(join(tmpdir(), "crow-vw-invite-env-"));
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(join(dir, ".env"), `${lines}\n`);
  return dir;
}
// The URL in this .env is DELIBERATELY not the one the handler uses (B2): it must be
// ignored for admin calls.
const LOOPBACK_DIR = () => envDir({ VAULTWARDEN_URL: "http://localhost:8097", VAULTWARDEN_OWNER_EMAIL: OWNER });

/** A tiny page: only what parseSignupsAllowed looks at. */
function adminHtml({ signups = "off" } = {}) {
  return `<html><body><form>
  <input type="checkbox" id="input_sso_signups_allowed" checked>
  <input type="checkbox" id="input_signups_allowed"${signups === "on" ? " checked" : ""}>
</form></body></html>`;
}

const ADMIN_TOKEN_HASH = "$argon2id=v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$ZmFrZS1oYXNoLXZhbHVl";
/** Attribute-escaped the way Vaultwarden's own admin page renders a value. */
const attr = (v) => String(v)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;")
  .replace(/=/g, "&#x3D;")
  .replace(/\$/g, "&#x24;")
  .replace(/,/g, "&#x2C;");

/**
 * A realistic slice of Vaultwarden's `/admin` page: ~52 settings inputs of all three
 * `conf-*` classes, the SSO checkbox FIRST (as on the real page), an
 * attribute-escaped Argon2 `admin_token`, and two inputs the config POST must never
 * carry (one without a `conf-*` class, one without a `name`).
 */
function adminPage({ signups = "off" } = {}) {
  const boxes = [
    ["sso_signups_allowed", true],
    ["signups_allowed", signups === "on"],
    ["signups_verify", false],
    ["invitations_allowed", true],
    ["password_hints_allowed", true],
    ["show_password_hint", false],
    ["mail_debug", false],
    ["require_device_email", false],
    ["sends_allowed", true],
    ["emergency_access_allowed", true],
    ["enable_db_wal", false],
    ["sso_enabled", false],
    ["sso_only", false],
    ["sso_signups_match_email", false],
    ["sso_pkce", true],
    ["sso_allow_unknown_email_verification", false],
    ["_enable_smtp", true],
    ["_enable_yubico", false],
    ["_enable_sso", false],
    ["_enable_emergency_access", true],
  ];
  const numbers = [
    ["password_iterations", "600000"],
    ["password_hints_allowed_count", ""],
    ["smtp_port", "587"],
    ["smtp_timeout", "15"],
    ["sends_hourly_limit", "100"],
    ["sends_max_size", "100"],
    ["rocket_port", "80"],
    ["database_max_conns", "10"],
    ["database_timeout", "30"],
    ["database_idle_timeout", "600"],
    ["database_min_conns", "0"],
    ["icon_download_timeout", "10"],
    ["icon_cache_ttl", "2592000"],
    ["icon_cache_negttl", "259200"],
    ["admin_session_lifetime", "20"],
  ];
  const texts = [
    ["admin_token", ADMIN_TOKEN_HASH],
    ["domain", "http://localhost:8097"],
    ["signups_domains_whitelist", ""],
    ["smtp_host", "127.0.0.1"],
    ["smtp_from", "vault@example.com"],
    ["smtp_from_name", "Vaultwarden"],
    ["smtp_username", ""],
    ["smtp_security", "starttls"],
    ["smtp_auth_mechanism", "Plain"],
    ["rocket_address", "127.0.0.1"],
    ["ip_header", "X-Real-IP"],
    ["icon_service", "internal"],
    ["sso_audience", "vaultwarden"],
    ["sso_authority", ""],
    ["sso_client_id", ""],
  ];
  const passwords = [
    ["smtp_password", ""],
    ["yubico_secret_key", ""],
    ["sso_client_secret", ""],
  ];
  const inputs = [
    ...boxes.map(([n, c]) => `<input class="conf-checkbox" type="checkbox" id="input_${n}" name="${n}"${c ? " checked" : ""}>`),
    ...numbers.map(([n, v]) => `<input class="conf-number" type="number" id="input_${n}" name="${n}"${v === "" ? "" : ` value="${v}"`}>`),
    ...texts.map(([n, v]) => `<input class="conf-text" type="text" id="input_${n}" name="${n}"${v === "" ? "" : ` value="${attr(v)}"`}>`),
    ...passwords.map(([n, v]) => `<input class="conf-password" type="password" id="input_${n}" name="${n}"${v === "" ? "" : ` value="${attr(v)}"`}>`),
    // Neither of these belongs to the config form:
    '<input class="form-control" type="search" id="input_search" name="search" value="users">',
    '<input class="conf-text" type="text" id="input_nameless" value="nameless">',
  ];
  return `<html><body><form id="config-form">\n${inputs.join("\n")}\n</form></body></html>`;
}

/** A fetch-shaped Response with the pieces the handler reads. */
function res_({ status = 200, body = "", cookies = [], json = null } = {}) {
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return {
    status,
    headers: {
      getSetCookie: () => list,
      get: (name) => (String(name).toLowerCase() === "set-cookie" ? (list[0] ?? null) : null),
    },
    text: async () => (json !== null ? JSON.stringify(json) : body),
    json: async () => (json !== null ? json : JSON.parse(body)),
  };
}

/**
 * A fake Vaultwarden: `routes` maps `METHOD /path` to a handler, and every call
 * is recorded (url, method, body, headers) so a test can count logins.
 * `H.clearAdminSession()` keeps one test's remembered cookie out of the next.
 */
function fakeVaultwarden(routes = {}) {
  H.clearAdminSession();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(String(url)).pathname;
    const call = { url: String(url), path, method, body: init.body, headers: init.headers || {} };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected request: ${method} ${path}`);
    const res = await handler(call);
    call.status = res && res.status;
    return res;
  };
  return { fetchImpl, calls };
}

const cookieHeader = (call) => call.headers.cookie || "";
const loginCalls = (calls) => calls.filter((c) => c.method === "POST" && c.path === "/admin");
const configCalls = (calls) => calls.filter((c) => c.method === "POST" && c.path === "/admin/config");

/** The signed-in happy path: login, then whatever `extra` routes the test adds. */
function signedIn({ signups = "off", users = [], extra = {} } = {}) {
  return fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin; HttpOnly"], body: adminPage({ signups }) }),
    "GET /admin/users": () => res_({ status: 200, json: users }),
    "GET /admin": () => res_({ status: 200, body: adminPage({ signups }) }),
    ...extra,
  });
}

// ── 1. the handler against a fake Vaultwarden ──

test("state: one login, form-encoded token, cookie reused on every call, _status mapped", async () => {
  const { fetchImpl, calls } = signedIn({
    signups: "off",
    users: [
      { email: OWNER, _status: 0, key: "a-real-key" },
      { email: "invited@example.com", _status: 1, key: "" },
      { email: "off@example.com", _status: 2, key: "" },
    ],
  });
  const state = await H.vaultwardenState({ installDir: LOOPBACK_DIR(), fetch: fetchImpl, readAdminToken: async () => TOKEN });
  assert.equal(loginCalls(calls).length, 1, "exactly one admin login for one operation");
  const login = loginCalls(calls)[0];
  assert.equal(login.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(login.body, new URLSearchParams({ token: TOKEN }).toString(), "the token is URL-encoded form data");
  for (const call of calls.slice(1)) assert.equal(cookieHeader(call), "VW_ADMIN=jwt-value", `${call.path} reuses the cookie`);
  assert.deepEqual(state, {
    signups: "off",
    users: [
      { email: OWNER, status: 0, registered: true, invited: false, disabled: false },
      { email: "invited@example.com", status: 1, registered: false, invited: true, disabled: false },
      { email: "off@example.com", status: 2, registered: false, invited: false, disabled: true },
    ],
    others: [],
    reachable: true,
    reason: null,
  });
  for (const call of calls) assert.ok(call.url.startsWith("http://127.0.0.1:8097/"), `${call.url}: loopback host only`);
});

test("sign-ups parse: the exact input_signups_allowed, never input_sso_signups_allowed", () => {
  assert.equal(H.parseSignupsAllowed(adminHtml({ signups: "on" })), "on", "the SSO box is always checked and is NOT this one");
  assert.equal(H.parseSignupsAllowed(adminHtml({ signups: "off" })), "off");
  assert.equal(H.parseSignupsAllowed('<input id="input_sso_signups_allowed" checked>'), "unknown", "the SSO input alone is not a reading");
  assert.equal(H.parseSignupsAllowed("<html>nothing here</html>"), "unknown");
  assert.equal(H.parseSignupsAllowed(null), "unknown");
  // The full fixture page carries both, SSO first.
  assert.equal(H.parseSignupsAllowed(adminPage({ signups: "on" })), "on");
  assert.equal(H.parseSignupsAllowed(adminPage({ signups: "off" })), "off");
});

test("S1: the admin config form parses like Vaultwarden's own getFormData (types, nulls, decoded entities)", async () => {
  const config = await H.adminConfigFromPage(adminPage({ signups: "on" }));
  assert.ok(Object.keys(config).length >= 45, `a full form has ~50 fields, got ${Object.keys(config).length}`);
  assert.equal(config.signups_allowed, true, "a checkbox is a boolean from the checked ATTRIBUTE");
  assert.equal(config.sso_signups_allowed, true);
  assert.equal(config.smtp_password, null, "an empty conf-password is null");
  assert.equal(config.smtp_username, null, "an empty conf-text is null");
  assert.equal(config.password_hints_allowed_count, null, "an empty conf-number is null");
  assert.equal(config.smtp_port, 587, "a conf-number is a number");
  assert.equal(config.password_iterations, 600000);
  assert.equal(config.admin_token, ADMIN_TOKEN_HASH, "HTML entities in the value are decoded (=, $ and , included)");
  assert.equal(config.search, undefined, "an input without a conf-* class is not part of the form");
  assert.equal(Object.values(config).includes("nameless"), false, "an input without a name is skipped");
  assert.equal(H.adminConfigComplete(config), true);
  assert.equal(H.adminConfigComplete({ signups_allowed: false, admin_token: "x" }), false, "too few fields is not the real form");
});

test("S1: closing sign-ups posts the WHOLE config with only signups_allowed changed", async () => {
  let closed = false;
  const fake = fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"], body: adminPage({ signups: closed ? "off" : "on" }) }),
    "GET /admin": () => res_({ status: 200, body: adminPage({ signups: closed ? "off" : "on" }) }),
    "POST /admin/config": () => { closed = true; return res_({ status: 200 }); },
  });
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN }), "off");
  const [config] = configCalls(fake.calls);
  assert.ok(config, "the config was posted");
  const body = JSON.parse(config.body);
  const baseline = await H.adminConfigFromPage(adminPage({ signups: "on" }));
  assert.deepEqual(body, { ...baseline, signups_allowed: false }, "every conf field is posted back, sign-ups the only change");
  assert.equal(body.smtp_host, "127.0.0.1", "SMTP survives: a partial body would reset it");
  assert.equal(body.admin_token, ADMIN_TOKEN_HASH);
  assert.equal(body.search, undefined);
  assert.equal(config.headers["content-type"], "application/json");
  assert.equal(cookieHeader(config), "VW_ADMIN=jwt-value");
});

test("S1: a page that does not parse into the full form posts NOTHING", async () => {
  const fake = fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"] }),
    "GET /admin": () => res_({ status: 200, body: adminHtml({ signups: "on" }) }),
    "POST /admin/config": () => res_({ status: 200 }),
    "POST /admin/invite": () => res_({ status: 200 }),
    "GET /admin/users": () => res_({ status: 200, json: [] }),
  });
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN }), "unknown");
  assert.equal(configCalls(fake.calls).length, 0, "nothing was posted (a partial POST would wipe the admin settings)");
  // The invite's close step refuses the same way, and leaves the read state alone.
  const inv = await H.inviteOwnerResult({ email: OWNER, installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  assert.deepEqual(inv, { result: "invited", signups: "unknown" });
  assert.equal(configCalls(fake.calls).length, 0);
});

test("invite 200 invites and closes sign-ups with the SAME cookie, then re-reads to confirm", async () => {
  let closed = false;
  const fake = fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"], body: adminPage({ signups: closed ? "off" : "on" }) }),
    "GET /admin/users": () => res_({ status: 200, json: [] }),
    "GET /admin": () => res_({ status: 200, body: adminPage({ signups: closed ? "off" : "on" }) }),
    "POST /admin/invite": () => res_({ status: 200, json: { email: OWNER, _status: 1 } }),
    "POST /admin/config": () => { closed = true; return res_({ status: 200, body: "" }); },
  });
  const dir = LOOPBACK_DIR();
  const out = await H.inviteOwnerResult({ email: OWNER, installDir: dir, fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  assert.deepEqual(out, { result: "invited", signups: "off" });
  assert.equal(loginCalls(fake.calls).length, 1, "one login for invite + close");
  const invite = fake.calls.find((c) => c.path === "/admin/invite");
  assert.equal(invite.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(invite.body), { email: OWNER });
  assert.equal(cookieHeader(invite), "VW_ADMIN=jwt-value");
  const [config] = configCalls(fake.calls);
  assert.equal(cookieHeader(config), "VW_ADMIN=jwt-value", "the cookie from the invite's login closes sign-ups too");
  assert.equal(JSON.parse(config.body).signups_allowed, false);
  assert.ok(fake.calls.indexOf(config) > fake.calls.indexOf(invite), "closing happens after the invite");
  // S4: the installed .env is kept in step with the app.
  assert.equal(parseEnvText(readFileSync(join(dir, ".env"), "utf8")).VAULTWARDEN_SIGNUPS_ALLOWED, "false");
});

test("S4: closing sign-ups writes VAULTWARDEN_SIGNUPS_ALLOWED=false and keeps every other .env line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-vw-invite-env-"));
  writeFileSync(join(dir, ".env"), [
    "# my vaultwarden",
    "VAULTWARDEN_URL=http://localhost:8097",
    "VAULTWARDEN_SIGNUPS_ALLOWED=true",
    "SOME_OTHER_KEY=kept",
    "",
  ].join("\n"));
  const fake = fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"] }),
    "GET /admin": () => res_({ status: 200, body: adminPage({ signups: "off" }) }),
    "POST /admin/config": () => res_({ status: 200 }),
  });
  assert.equal(await H.closeSignups({ installDir: dir, fetch: fake.fetchImpl, readAdminToken: async () => TOKEN }), "off");
  const text = readFileSync(join(dir, ".env"), "utf8");
  const afterEnv = parseEnvText(text);
  assert.equal(afterEnv.VAULTWARDEN_SIGNUPS_ALLOWED, "false");
  assert.equal(afterEnv.VAULTWARDEN_URL, "http://localhost:8097", "the other lines are untouched");
  assert.equal(afterEnv.SOME_OTHER_KEY, "kept");
  assert.match(text, /^# my vaultwarden$/m, "the comment line survives the write");
  // A close that is NOT confirmed (unknown) leaves the .env alone.
  const stillOn = fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"] }),
    "GET /admin": () => res_({ status: 200, body: adminPage({ signups: "on" }) }),
    "POST /admin/config": () => res_({ status: 200 }),
  });
  const dir2 = envDir({ VAULTWARDEN_SIGNUPS_ALLOWED: "true" });
  assert.equal(await H.closeSignups({ installDir: dir2, fetch: stillOn.fetchImpl, readAdminToken: async () => TOKEN }), "unknown");
  assert.equal(parseEnvText(readFileSync(join(dir2, ".env"), "utf8")).VAULTWARDEN_SIGNUPS_ALLOWED, "true");
});

test("invite leaves sign-ups alone when they were already off", async () => {
  const fake = signedIn({ signups: "off", users: [], extra: { "POST /admin/invite": () => res_({ status: 200 }) } });
  const out = await H.inviteOwnerResult({ email: OWNER, installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  assert.deepEqual(out, { result: "invited", signups: "off" });
  assert.equal(fake.calls.some((c) => c.path === "/admin/config"), false, "already closed: nothing to POST");
});

test("invite: 409 is 'already', 500 with the email wording is 'invalid-email', other 500 is 'failed'", async () => {
  const inviteFails = async (status, body = "") => {
    const fake = signedIn({ signups: "off", extra: { "POST /admin/invite": () => res_({ status, body }) } });
    return H.inviteOwnerResult({ email: OWNER, installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  };
  assert.equal((await inviteFails(409)).result, "already");
  assert.equal((await inviteFails(500, "owner@example.com is not a valid email address")).result, "invalid-email");
  assert.equal((await inviteFails(500, "internal error")).result, "failed");
  assert.equal((await inviteFails(418)).result, "failed");
  // A 409 does not skip the close: sign-ups are still open, so Crow asks to close them.
  // (This app keeps them open whatever is posted: the answer stays honest.)
  const fake = signedIn({ signups: "on", extra: {
    "POST /admin/invite": () => res_({ status: 409 }),
    "POST /admin/config": () => res_({ status: 200 }),
  } });
  const out = await H.inviteOwnerResult({ email: OWNER, installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  assert.deepEqual(out, { result: "already", signups: "on" }, "already registered, sign-ups still open: the card asks to close");
});

test("invite: a network failure is 'unreachable', a bad address is 'invalid-email' with no request", async () => {
  const fake = fakeVaultwarden({ "POST /admin": () => { throw new Error("ECONNREFUSED"); } });
  const out = await H.inviteOwnerResult({ email: OWNER, installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  assert.deepEqual(out, { result: "unreachable", signups: null });
  const never = fakeVaultwarden({});
  for (const bad of ["", "not-an-email", "a@b", "two words@example.com", null]) {
    const r = await H.inviteOwnerResult({ email: bad, installDir: LOOPBACK_DIR(), fetch: never.fetchImpl, readAdminToken: async () => TOKEN });
    assert.equal(r.result, "invalid-email", String(bad));
  }
  assert.equal(never.calls.length, 0, "nothing is sent for a bad address");
});

test("closeSignups: re-read 'off' confirms; a 200 that did not change anything is 'unknown'; a failed POST is 'failed'", async () => {
  const withConfig = (after, { configStatus = 200 } = {}) => fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"] }),
    "GET /admin": () => res_({ status: 200, body: adminPage({ signups: after }) }),
    "POST /admin/config": () => res_({ status: configStatus }),
  });
  const off = withConfig("off");
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: off.fetchImpl, readAdminToken: async () => TOKEN }), "off");
  assert.equal(loginCalls(off.calls).length, 1);
  const stillOn = withConfig("on");
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: stillOn.fetchImpl, readAdminToken: async () => TOKEN }), "unknown", "a 200 alone proves nothing");
  const failed = withConfig("off", { configStatus: 500 });
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: failed.fetchImpl, readAdminToken: async () => TOKEN }), "unknown");
  // The page keeps sign-ups open after a 500 POST: unknown, never "off".
  const contradicts = withConfig("on", { configStatus: 500 });
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: contradicts.fetchImpl, readAdminToken: async () => TOKEN }), "unknown");
});

// ── S2: the admin login budget ──

test("S2: the admin cookie is reused across operations — one login, not one per press", async () => {
  const fake = signedIn({ signups: "off", extra: { "POST /admin/config": () => res_({ status: 200 }) } });
  const deps = { installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN };
  assert.equal(await H.closeSignups(deps), "off");
  assert.equal(await H.closeSignups(deps), "off");
  const state = await H.vaultwardenState(deps);
  assert.equal(state.signups, "off");
  assert.equal(loginCalls(fake.calls).length, 1, "two closes and a state read cost ONE login");
});

test("S2: the card state is cached for five minutes, and an action drops it (the cookie stays)", async () => {
  assert.equal(H.STATE_TTL_MS, 300_000, "5 min: one login per cached window, not per render");
  let signups = "on";
  const fake = fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"], body: adminPage({ signups }) }),
    "GET /admin/users": () => res_({ status: 200, json: [] }),
    "GET /admin": () => res_({ status: 200, body: adminPage({ signups }) }),
    "POST /admin/config": () => { signups = "off"; return res_({ status: 200 }); },
  });
  const deps = { installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN };
  H.clearInviteStateCache();
  assert.equal((await H.cachedInviteState({ ...deps, bundleId: "vaultwarden" })).signups, "on");
  assert.equal((await H.cachedInviteState({ ...deps, bundleId: "vaultwarden" })).signups, "on", "served from the cache");
  const loginsBefore = loginCalls(fake.calls).length;
  assert.equal(await H.closeSignups(deps), "off");
  const after = await H.cachedInviteState({ ...deps, bundleId: "vaultwarden" });
  assert.equal(after.signups, "off", "the action dropped the stale card state");
  assert.equal(loginCalls(fake.calls).length, loginsBefore, "and the cookie was kept: no second login");
});

test("S2: a rejected cookie logs in once more, then the operation goes through", async () => {
  let logins = 0;
  let stale = false;
  const fake = fakeVaultwarden({
    "POST /admin": () => {
      logins++;
      return res_({ status: 200, cookies: [`VW_ADMIN=jwt-${logins}; Path=/admin`], body: adminPage({ signups: "off" }) });
    },
    "GET /admin": (call) => {
      if (stale && cookieHeader(call) === "VW_ADMIN=jwt-1") return res_({ status: 401, body: "session expired" });
      return res_({ status: 200, body: adminPage({ signups: "off" }) });
    },
    "POST /admin/config": () => res_({ status: 200 }),
  });
  const deps = { installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN };
  assert.equal(await H.closeSignups(deps), "off");
  assert.equal(logins, 1);
  stale = true; // Vaultwarden restarted: the remembered cookie is gone
  assert.equal(await H.closeSignups(deps), "off");
  assert.equal(logins, 2, "exactly one more login");
  const rejected = fake.calls.filter((c) => c.status === 401);
  assert.equal(rejected.length, 1, "the stale cookie really was tried first");
  assert.equal(cookieHeader(rejected[0]), "VW_ADMIN=jwt-1");
});

test("S2: a redirect to the login form is the same as a 401 (one re-login)", async () => {
  let logins = 0;
  let stale = false;
  const fake = fakeVaultwarden({
    "POST /admin": () => {
      logins++;
      return res_({ status: 302, cookies: [`VW_ADMIN=jwt-${logins}; Path=/admin`], body: "" });
    },
    "GET /admin": (call) => {
      if (stale && cookieHeader(call) === "VW_ADMIN=jwt-1") return res_({ status: 302, body: "" });
      return res_({ status: 200, body: adminPage({ signups: "off" }) });
    },
    "POST /admin/config": () => res_({ status: 200 }),
  });
  const deps = { installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN };
  assert.equal(await H.closeSignups(deps), "off", "a 303/302 login answer with the cookie is a login");
  stale = true;
  assert.equal(await H.closeSignups(deps), "off");
  assert.equal(logins, 2);
});

test("S2: a 429 is 'rate-limited' — its own reason, its own sentence, nothing posted", async () => {
  const limited = fakeVaultwarden({ "POST /admin": () => res_({ status: 429, body: "slow down" }) });
  const deps = { installDir: LOOPBACK_DIR(), fetch: limited.fetchImpl, readAdminToken: async () => TOKEN };
  const state = await H.vaultwardenState(deps);
  assert.equal(state.reason, "rate-limited");
  assert.equal(state.reachable, true, "the app answered: it is up");
  assert.equal(state.signups, "unknown");
  assert.equal(FA.inviteNotice("vaultwarden", state).kind, "blocked", "never read as 'done'");
  assert.equal(FA.inviteNotice("vaultwarden", state).reason, "rate-limited");
  assert.equal(await H.closeSignups(deps), "rate-limited");
  assert.equal((await H.inviteOwnerResult({ ...deps, email: OWNER })).result, "rate-limited");
  assert.equal(configCalls(limited.calls).length, 0, "nothing was posted at the app");
  assert.match(H.inviteResultSentence("rate-limited", { name: "Vaultwarden" }), /limiting admin logins for a few minutes/);
  assert.match(H.closeSignupsSentence("rate-limited", { name: "Vaultwarden" }), /limiting admin logins for a few minutes/);
  // The limit is not retried on every render: the state cache holds it.
  H.clearInviteStateCache();
  const loginsBefore = loginCalls(limited.calls).length;
  const first = await H.cachedInviteState({ ...deps, bundleId: "vaultwarden" });
  const second = await H.cachedInviteState({ ...deps, bundleId: "vaultwarden" });
  assert.equal(first.reason, "rate-limited");
  assert.deepEqual(second, first);
  assert.equal(loginCalls(limited.calls).length, loginsBefore + 1, "one login attempt for the whole cached window");
  const notice = FA.pendingFirstAdminNotices({
    installed: { vaultwarden: { installedAt: INSTALL } },
    manifests: { vaultwarden: VW_MANIFEST },
    liveProxyIds: ["vaultwarden"],
    inviteStates: { vaultwarden: second },
  });
  assert.equal(notice[0].invite.kind, "blocked");
});

// ── 2. the destination, no token, and the token never leaves ──

test("B2: the admin destination is fixed at 127.0.0.1 from the reviewed manifest — VAULTWARDEN_URL is ignored", async () => {
  assert.equal(H.vaultwardenBaseUrl(null), "http://127.0.0.1:8097");
  assert.equal(H.vaultwardenBaseUrl({ webUI: { port: 8097 } }), "http://127.0.0.1:8097");
  assert.equal(H.vaultwardenBaseUrl({ webUI: { port: 9999 } }), "http://127.0.0.1:9999", "the reviewed manifest's port is used");
  assert.equal(H.vaultwardenBaseUrl({ webUI: { port: "not a port" } }), "http://127.0.0.1:8097", "an unusable port falls back");
  for (const url of [
    "http://127.0.0.1:9999",
    "https://vault.example.com",
    "http://10.0.0.5:8097",
    "not a url",
  ]) {
    const dir = envDir({ VAULTWARDEN_URL: url });
    const fake = signedIn({ signups: "off", users: [], extra: { "POST /admin/config": () => res_({ status: 200 }) } });
    const state = await H.vaultwardenState({ installDir: dir, fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
    assert.equal(state.reachable, true, url);
    assert.equal(await H.closeSignups({ installDir: dir, fetch: fake.fetchImpl, readAdminToken: async () => TOKEN }), "off", url);
    for (const call of fake.calls) {
      assert.ok(call.url.startsWith("http://127.0.0.1:8097/"), `${url}: ${call.url} — the .env must not decide the destination`);
    }
  }
  // The shipped manifest agrees with the compose file's 127.0.0.1:8097:80.
  const shipped = JSON.parse(readFileSync(join(REPO, "bundles", "vaultwarden", "manifest.json"), "utf8"));
  assert.equal(H.vaultwardenBaseUrl(shipped), "http://127.0.0.1:8097");
});

test("no token: state says so, invite is 'no-token', close is 'failed'", async () => {
  const fake = fakeVaultwarden({});
  const readAdminToken = async () => null;
  const state = await H.vaultwardenState({ installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken });
  assert.deepEqual(state, { signups: "unknown", users: [], others: [], reachable: false, reason: "no-token" });
  assert.equal((await H.inviteOwnerResult({ email: OWNER, installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken })).result, "no-token");
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken }), "failed");
  assert.equal(fake.calls.length, 0);
  // A token Vaultwarden refuses (401, no cookie) reads as "no token" too: re-add it.
  const refused = fakeVaultwarden({ "POST /admin": () => res_({ status: 401, body: "bad token" }) });
  const refusedState = await H.vaultwardenState({ installDir: LOOPBACK_DIR(), fetch: refused.fetchImpl, readAdminToken: async () => TOKEN });
  assert.equal(refusedState.reason, "no-token");
  assert.equal(refusedState.reachable, true);
});

test("neither the token nor the cookie ever appears in a result or on the console", async () => {
  const seen = [];
  const spies = ["log", "warn", "error", "info", "debug"].map((k) => {
    const original = console[k];
    console[k] = (...args) => { seen.push(args.map(String).join(" ")); };
    return [k, original];
  });
  try {
    const fake = signedIn({ signups: "on", users: [], extra: {
      "POST /admin/invite": () => res_({ status: 200 }),
      "POST /admin/config": () => res_({ status: 200 }),
    } });
    const readAdminToken = async () => TOKEN;
    const results = [
      await H.vaultwardenState({ installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken }),
      await H.inviteOwnerResult({ email: OWNER, installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken }),
      await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken }),
    ];
    const text = JSON.stringify(results);
    assert.doesNotMatch(text, /Plain-admin-token/);
    assert.doesNotMatch(text, /VW_ADMIN/);
    assert.doesNotMatch(text, /jwt-value/);
  } finally {
    for (const [k, original] of spies) console[k] = original;
  }
  const joined = seen.join("\n");
  assert.doesNotMatch(joined, /Plain-admin-token|VW_ADMIN|jwt-value/);
});

// ── 3. the real keychain reader ──

test("the keychain reader finds the install path's VAULTWARDEN_ADMIN_TOKEN entry, and nothing else", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const { ensureWriteKey, saveExtensionSecret } = await import("../servers/gateway/keychain/store.js");
  const db = createDbClient();
  try {
    assert.equal(await H.keychainAdminTokenReader({ db })(), null, "an empty keychain has no token");
    const key = await ensureWriteKey(db);
    await saveExtensionSecret(db, key, {
      bundleId: "vaultwarden",
      envKey: "VAULTWARDEN_ADMIN_TOKEN",
      label: "Vaultwarden — admin page token",
      secret: TOKEN,
      origin: "generated",
    });
    await saveExtensionSecret(db, key, {
      bundleId: "vaultwarden",
      envKey: "APP_ADMIN_PASSWORD",
      label: "some other login",
      secret: "not-the-admin-token",
      origin: "typed",
    });
    assert.equal(await H.keychainAdminTokenReader({ db })(), TOKEN, "read with the same keychain deps the install path uses");
    assert.equal(await H.keychainAdminTokenReader()(), TOKEN, "and with its own db client");
  } finally {
    db.close();
  }
});

// ── 4. the card ──

const VW_MANIFEST = {
  id: "vaultwarden",
  name: "Vaultwarden",
  webUI: { port: 8097, path: "/", label: "Vaultwarden" },
  firstAdmin: { mode: "finish-setup", invite: "vaultwarden", note: "Crow invites your email at install." },
};
const installed = { vaultwarden: { installedAt: INSTALL } };
const manifests = { vaultwarden: VW_MANIFEST };
const state = (over = {}) => ({ signups: "off", users: [], others: [], reachable: true, reason: null, ...over });

function cards(inviteState, extra = {}) {
  return FA.pendingFirstAdminNotices({
    installed,
    manifests,
    liveProxyIds: ["vaultwarden"],
    inviteStates: { vaultwarden: inviteState },
    ...extra,
  });
}

test("card state 1: a registered account with sign-ups off is DONE — no card", () => {
  assert.deepEqual(cards(state({ signups: "off", users: [{ email: OWNER, registered: true }] })), []);
});

test("card state 2: a registered account with sign-ups on or unknown offers Close sign-ups", () => {
  for (const signups of ["on", "unknown"]) {
    const [card] = cards(state({ signups, users: [{ email: OWNER, registered: true }] }));
    assert.ok(card, signups);
    assert.equal(card.invite.kind, "close", signups);
    assert.equal(card.canDone, false, "Done cannot hide an open sign-up page");
    assert.equal(card.canSave, false, "there is no login to save here");
  }
});

test("card state 3: an invited address with no account yet says to create it, with the link", () => {
  const [card] = cards(state({ signups: "off", users: [{ email: OWNER, invited: true }] }));
  assert.equal(card.invite.kind, "create");
  assert.equal(card.invite.email, OWNER);
  assert.equal(card.link.href, "/proxy/vaultwarden/");
  assert.equal(card.canDone, false);
  assert.equal(card.canSave, false);
});

test("card state 4: nobody at all asks for the email, and says so when sign-ups are still on", () => {
  const [open] = cards(state({ signups: "on", users: [] }));
  assert.equal(open.invite.kind, "invite");
  assert.equal(open.invite.email, null);
  assert.equal(open.invite.signups, "on");
  const [quiet] = cards(state({ signups: "off", users: [] }));
  assert.equal(quiet.invite.kind, "invite");
  assert.equal(quiet.invite.signups, "off");
});

test("S5: only _status === 1 is 'invited' — a disabled account makes neither 'create' nor 'done'", () => {
  const disabled = [{ email: "off@example.com", status: 2, registered: false, invited: false, disabled: true }];
  const [card] = cards(state({ signups: "off", users: disabled }));
  assert.equal(card.invite.kind, "invite", "a disabled account is not an invitation");
  assert.equal(FA.inviteNotice("vaultwarden", { signups: "off", users: disabled, others: [] }).kind, "invite");
  // An invited account still is one.
  assert.equal(FA.inviteNotice("vaultwarden", { signups: "off", users: [{ email: OWNER, status: 1, invited: true }], others: [] }).kind, "create");
});

test("S5: registered addresses that are not the owner's are named on the card, capped at 5 and escaped", () => {
  const others = ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com", "f@example.com"];
  const [card] = cards(state({ signups: "on", users: [{ email: OWNER, registered: true }], others }));
  assert.equal(card.invite.kind, "close");
  const body = FA.firstAdminInviteBody(card.invite, "Vaultwarden", "en");
  assert.match(body, /Anyone on this machine can still create a Vaultwarden account/);
  assert.match(body, /check these are people you know/, "the card names them");
  const sentence = FA.firstAdminInviteOthers(card.invite, "en");
  assert.equal(sentence, "Also registered: a@example.com, b@example.com, c@example.com, d@example.com, e@example.com — check these are people you know.");
  assert.equal(FA.firstAdminInviteOthers({ others: [] }, "en"), null);
  assert.match(FA.firstAdminInviteOthers({ others: ["x@example.com"] }, "es"), /También registrados/);
  // The card renders it, escaped.
  const html = buildExtensionsHTML({
    installed, available: [], collections: [], needsConfig: {}, keychainPending: [],
    registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en",
    firstAdminPending: cards(state({ signups: "on", users: [{ email: OWNER, registered: true }], others: ["odd<name>@example.com"] })),
  }).viewsHtml;
  assert.match(html, /Also registered: odd&lt;name&gt;@example\.com/);
  assert.doesNotMatch(html, /odd<name>@example\.com/);
});

test("the handler names the owner's other accounts, not the owner's own", async () => {
  const fake = signedIn({
    signups: "on",
    users: [
      { email: OWNER, _status: 0 },
      { email: "someone@example.com", _status: 0 },
      { email: "off@example.com", _status: 2 },
      { email: "invited@example.com", _status: 1 },
    ],
  });
  const state = await H.vaultwardenState({ installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  assert.deepEqual(state.others, ["someone@example.com"], "the owner's address is expected; a disabled one is not registered");
  // With no owner address configured, Crow cannot vouch for any registration.
  const unknownOwner = await H.vaultwardenState({ installDir: envDir({ VAULTWARDEN_URL: "http://localhost:8097" }), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  assert.deepEqual(unknownOwner.others, [OWNER, "someone@example.com"]);
});

test("card state 5: unreachable / no-token / unknown keep today's card plus one sentence why", () => {
  for (const [reason, reachable] of [["unreachable", false], ["no-token", false], ["rate-limited", true], ["unknown", true]]) {
    const [card] = cards({ signups: "unknown", users: [], others: [], reachable, reason });
    assert.ok(card, reason);
    assert.equal(card.invite.kind, "blocked", reason);
    assert.equal(card.invite.reason, reason);
    assert.equal(card.canSave, false, `${reason}: no login form — the app's own state is the signal`);
    assert.equal(card.canDone, true, `${reason}: but the operator can finish it by hand and press Done`);
  }
  // No state at all (the panel could not compute one) is the same card.
  const [missing] = FA.pendingFirstAdminNotices({ installed, manifests, liveProxyIds: ["vaultwarden"], inviteStates: {} });
  assert.equal(missing.invite.kind, "blocked");
  assert.equal(missing.invite.reason, "unknown");
});

test("S3: Done hides the 'cannot read the app' card, never a live invite/close/create warning", () => {
  const done = { vaultwarden: INSTALL };
  assert.deepEqual(cards({ signups: "unknown", users: [], others: [], reachable: false, reason: "unreachable" }, { done }), [],
    "Done still finishes the card the operator handled by hand");
  for (const inviteState of [
    state({ signups: "off", users: [] }),
    state({ signups: "on", users: [{ email: OWNER, registered: true }] }),
    state({ signups: "off", users: [{ email: OWNER, invited: true }] }),
  ]) {
    const found = cards(inviteState, { done });
    assert.equal(found.length, 1, `a "${found[0] ? found[0].invite.kind : "?"}" state must show the card even after Done`);
  }
  // A plain finish-setup app keeps today's rule: Done hides it for that install.
  const other = FA.pendingFirstAdminNotices({
    installed: { kuma: { installedAt: INSTALL } },
    manifests: { kuma: { id: "kuma", name: "Kuma", webUI: { port: 3007, path: "/" }, firstAdmin: { mode: "finish-setup" } } },
    liveProxyIds: ["kuma"],
    done: { kuma: INSTALL },
  });
  assert.deepEqual(other, []);
});

test("B1: a manifest that only NAMES the vaultwarden handler gets no invite card", () => {
  const lookalike = {
    id: "not-vaultwarden",
    name: "Lookalike",
    webUI: { port: 9099, path: "/", label: "Lookalike" },
    firstAdmin: { mode: "finish-setup", invite: "vaultwarden" },
  };
  const notices = FA.pendingFirstAdminNotices({
    installed: { "not-vaultwarden": { installedAt: INSTALL } },
    manifests: { "not-vaultwarden": lookalike },
    liveProxyIds: ["not-vaultwarden"],
    inviteStates: { "not-vaultwarden": { signups: "off", users: [], others: [], reachable: true, reason: null } },
  });
  assert.equal(notices.length, 1, "the normal finish-setup card is still owed");
  assert.equal(notices[0].invite, null, "no invite state is read or shown for another bundle");
  assert.equal(notices[0].canSave, true, "and it offers the ordinary login form");
  assert.equal(REGISTRY.inviteHandlerBundleId("vaultwarden"), "vaultwarden");
  assert.equal(REGISTRY.inviteHandlerBundleId("nope"), null);
});

test("the adminSaved rule does not hide an invite card — the /admin token is not a login", () => {
  assert.equal(FA.firstAdminSavedKey({ firstAdmin: { mode: "finish-setup" } }), FA.FIRST_ADMIN_SAVED_KEY);
  assert.equal(FA.firstAdminSavedKey({ firstAdmin: { mode: "crow", secretEnv: "VAULTWARDEN_ADMIN_TOKEN" } }), null, "an admin-panel token is never 'the app's login'");
  const saved = new Set(["vaultwarden"]);
  assert.equal(cards(state({ signups: "on", users: [{ email: OWNER, registered: true }] }), { adminSaved: saved }).length, 1, "sign-ups still open: the card stays");
  assert.equal(cards(state({ signups: "off", users: [{ email: OWNER, invited: true }] }), { adminSaved: saved }).length, 1, "an invited address: the card stays");
  assert.equal(cards(state({ signups: "off", users: [] }), { adminSaved: saved }).length, 1, "nobody at all: the card stays");
  // A real login saved under the handler's admin-token env key is refused by
  // firstAdminSavedKey, so firstAdminSavedBundleIds can never mark it saved either.
  assert.equal(FA.firstAdminSavedKey({ firstAdmin: { mode: "finish-setup", invite: "vaultwarden", secretEnv: "VAULTWARDEN_ADMIN_TOKEN" } }), null);
  // A normal finish-setup app is still hidden by its saved admin login.
  const other = FA.pendingFirstAdminNotices({
    installed: { kuma: { installedAt: INSTALL } },
    manifests: { kuma: { id: "kuma", name: "Uptime Kuma", webUI: { port: 3007, path: "/", label: "Kuma" }, firstAdmin: { mode: "finish-setup" } } },
    liveProxyIds: ["kuma"],
    adminSaved: new Set(["kuma"]),
  });
  assert.deepEqual(other, []);
});

test("the card renders the invite form / the close button / the create sentence, translated", () => {
  const render = (inviteState, lang = "en") => buildExtensionsHTML({
    installed,
    available: [],
    collections: [],
    needsConfig: {},
    keychainPending: [],
    registrySource: "local",
    communityStores: [],
    bundleStatus: {},
    firstAdminPending: cards(inviteState),
    lang,
  }).viewsHtml;
  const invite = render(state({ signups: "off", users: [] }));
  assert.match(invite, /class="ext-firstadmin-invite"/);
  assert.match(invite, /class="ext-firstadmin-invite-email"/);
  assert.match(invite, /Invite my email/);
  assert.doesNotMatch(invite, /ext-firstadmin-open/, "nothing to open before an account exists");
  assert.ok(invite.includes(t("bundles.firstAdmin.invite.inviteBody", "en").replace("{name}", "Vaultwarden")));

  const create = render(state({ signups: "off", users: [{ email: OWNER, invited: true }] }));
  assert.ok(create.includes(t("bundles.firstAdmin.invite.createBody", "en").replace("{name}", "Vaultwarden").replace("{email}", OWNER)));
  assert.match(create, /ext-firstadmin-open/);
  assert.doesNotMatch(create, /ext-firstadmin-done/, "no Done on an invite card");
  assert.doesNotMatch(create, /ext-firstadmin-save/);
  // Sign-ups still open: the sentence does not claim they are closed, and the card
  // carries the one button that closes them.
  const createOpen = render(state({ signups: "on", users: [{ email: OWNER, invited: true }] }));
  assert.ok(createOpen.includes(t("bundles.firstAdmin.invite.createOpenBody", "en").replace("{name}", "Vaultwarden").replace("{email}", OWNER)));
  assert.doesNotMatch(createOpen, /sign-ups are closed to everyone else/);
  assert.match(createOpen, /ext-firstadmin-close/);

  const close = render(state({ signups: "on", users: [{ email: OWNER, registered: true }] }));
  assert.match(close, /ext-firstadmin-close/);
  assert.match(close, /Close sign-ups/);
  assert.doesNotMatch(close, /ext-firstadmin-done/);

  const blocked = render({ signups: "unknown", users: [], others: [], reachable: false, reason: "unreachable" });
  assert.match(blocked, /ext-firstadmin-done/, "today's card is still there");
  assert.ok(blocked.includes(t("bundles.firstAdmin.invite.reason.unreachable", "en").replace("{name}", "Vaultwarden")));

  const limited = render({ signups: "unknown", users: [], others: [], reachable: true, reason: "rate-limited" });
  assert.ok(limited.includes(t("bundles.firstAdmin.invite.reason.rateLimited", "en").replace("{name}", "Vaultwarden")));

  const es = render(state({ signups: "off", users: [] }), "es");
  assert.match(es, /Invitar mi email/);
  assert.ok(es.includes(t("bundles.firstAdmin.invite.inviteBody", "es").replace("{name}", "Vaultwarden")));
});

test("the card's client code posts the invite and the close routes and reloads on success", async () => {
  const CLIENT_HTML = extensionsClientJS("en", { servicesUi: false });
  const CLIENT_JS = CLIENT_HTML.slice(CLIENT_HTML.indexOf("<script>") + "<script>".length, CLIENT_HTML.lastIndexOf("</script>"));
  const OVERLAY_HTML = CLIENT_HTML.slice(0, CLIENT_HTML.indexOf("<script>"));
  const views = (inviteState) => buildExtensionsHTML({
    installed, available: [], collections: [], needsConfig: {}, keychainPending: [],
    registrySource: "local", communityStores: [], bundleStatus: {}, firstAdminPending: cards(inviteState), lang: "en",
  }).viewsHtml;

  function boot(html, answer) {
    const { window, document } = parseHTML(`<html><body><div class="main-content">${html}${OVERLAY_HTML}</div></body></html>`);
    const calls = [];
    let reloads = 0;
    const location = { hash: "", href: "https://crow.test/dashboard/extensions", reload() { reloads++; } };
    const fetchStub = (url, init) => {
      calls.push({ url: String(url), method: init && init.method, body: init && init.body ? JSON.parse(init.body) : null });
      return Promise.resolve(answer());
    };
    const ctx = vm.createContext({
      window, document, location, console, AbortController,
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: fetchStub,
      crypto: webcrypto,
      navigator: { clipboard: { writeText: () => Promise.resolve() } },
      setTimeout: () => 0, clearTimeout: () => {},
    });
    window.location = location;
    vm.runInContext(CLIENT_JS, ctx);
    const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
    return { window, document, calls, settle, reloads: () => reloads };
  }

  // The invite form: the typed email travels to the invite route, and the page reloads.
  {
    const { window, document, calls, settle, reloads } = boot(views(state({ signups: "off", users: [] })),
      () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: "invited" }) }));
    const form = document.querySelector(".ext-firstadmin-invite");
    form.querySelector(".ext-firstadmin-invite-email").value = OWNER;
    form.dispatchEvent(new window.Event("submit", { bubbles: true }));
    await settle();
    const posted = calls.find((c) => c.url.endsWith("/first-admin-invite"));
    assert.ok(posted, "the invite press posts");
    assert.equal(posted.method, "POST");
    assert.deepEqual(posted.body, { bundle_id: "vaultwarden", email: OWNER });
    assert.equal(reloads(), 1, "the card re-renders from a fresh read");
  }

  // The close button posts its own route; a failure keeps the card and shows the sentence.
  {
    const { window, document, calls, settle, reloads } = boot(views(state({ signups: "on", users: [{ email: OWNER, registered: true }] })),
      () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: false, result: "unknown", error: "server words" }) }));
    const closeBtn = document.querySelector(".ext-firstadmin-close");
    assert.ok(closeBtn, "sign-ups on: the button is there");
    closeBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    await settle();
    const posted = calls.find((c) => c.url.endsWith("/first-admin-close-signups"));
    assert.ok(posted, "the close press posts");
    assert.deepEqual(posted.body, { bundle_id: "vaultwarden" });
    assert.equal(reloads(), 0, "not confirmed: no reload pretending it worked");
    const card = document.querySelector(".ext-firstadmin[data-addon-id=\"vaultwarden\"]");
    assert.match(card.textContent, /could not confirm/);
    assert.equal(closeBtn.disabled, false, "the button comes back");
  }

  // S2: a rate-limited action says so, in its own words.
  {
    const { window, document, calls, settle, reloads } = boot(views(state({ signups: "on", users: [{ email: OWNER, registered: true }] })),
      () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: false, result: "rate-limited", error: "server words" }) }));
    const closeBtn = document.querySelector(".ext-firstadmin-close");
    closeBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    await settle();
    assert.ok(calls.some((c) => c.url.endsWith("/first-admin-close-signups")));
    assert.equal(reloads(), 0);
    const card = document.querySelector(".ext-firstadmin[data-addon-id=\"vaultwarden\"]");
    assert.match(card.textContent, /limiting admin logins for a few minutes/);
  }
});

test("every new sentence exists in both languages", () => {
  for (const key of [
    "bundles.firstAdmin.invite.closeBody",
    "bundles.firstAdmin.invite.createBody",
    "bundles.firstAdmin.invite.createOpenBody",
    "bundles.firstAdmin.invite.inviteBody",
    "bundles.firstAdmin.invite.signupsOpen",
    "bundles.firstAdmin.invite.others",
    "bundles.firstAdmin.invite.closeSignups",
    "bundles.firstAdmin.invite.closing",
    "bundles.firstAdmin.invite.inviteAction",
    "bundles.firstAdmin.invite.sending",
    "bundles.firstAdmin.invite.emailLabel",
    "bundles.firstAdmin.invite.emailRequired",
    "bundles.firstAdmin.invite.reason.notLocal",
    "bundles.firstAdmin.invite.reason.noToken",
    "bundles.firstAdmin.invite.reason.unreachable",
    "bundles.firstAdmin.invite.reason.rateLimited",
    "bundles.firstAdmin.invite.reason.unknown",
    "bundles.firstAdmin.invite.resultInvalidEmail",
    "bundles.firstAdmin.invite.resultNoToken",
    "bundles.firstAdmin.invite.resultUnreachable",
    "bundles.firstAdmin.invite.resultRateLimited",
    "bundles.firstAdmin.invite.resultFailed",
    "bundles.firstAdmin.invite.resultCloseUnknown",
    "bundles.firstAdmin.invite.resultCloseFailed",
  ]) {
    const en = t(key, "en");
    const es = t(key, "es");
    assert.notEqual(en, key, `${key} has an English sentence`);
    assert.notEqual(es, key, `${key} has a Spanish sentence`);
    assert.notEqual(es, en, `${key} is really translated`);
  }
});

// ── 5. the routes ──

const ROUTE_ID = "vaultwarden";const ROUTE_MANIFEST = {
  id: ROUTE_ID,
  name: "Vaultwarden Route",
  type: "bundle",
  version: "1.0.0",
  webUI: { port: 8097, path: "/", label: "Vaultwarden Route" },
  firstAdmin: { mode: "finish-setup", invite: "vaultwarden" },
};
const PLAIN_ID = "vw-plain";
const PLAIN_MANIFEST = {
  id: PLAIN_ID,
  name: "No invite here",
  type: "bundle",
  version: "1.0.0",
  webUI: { port: 8099, path: "/", label: "No invite here" },
  firstAdmin: { mode: "finish-setup" },
};
// B1: a bundle whose REVIEWED manifest names the handler, on a bundle id that is
// not the handler's own. It must resolve to nothing.
const LOOKALIKE_ID = "vw-lookalike";
const LOOKALIKE_MANIFEST = {
  id: LOOKALIKE_ID,
  name: "Lookalike",
  type: "bundle",
  version: "1.0.0",
  webUI: { port: 9099, path: "/", label: "Lookalike" },
  firstAdmin: { mode: "finish-setup", invite: "vaultwarden" },
};

/** A reviewed source bundle + an INSTALLED copy with a .env, recorded in installed.json. */
function seedRouteBundle(manifest) {
  const source = join(TMP_BUNDLES, manifest.id);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest, null, 2));
  const installedDir = join(TMP_HOME, "bundles", manifest.id);
  mkdirSync(installedDir, { recursive: true });
  writeFileSync(join(installedDir, ".env"), "VAULTWARDEN_URL=http://localhost:8097\n");
  const path = join(TMP_HOME, "installed.json");
  const current = readFileSync(path, "utf8");
  const list = current.trim() ? JSON.parse(current) : [];
  if (!list.some((e) => e && e.id === manifest.id)) {
    list.push({ id: manifest.id, type: "bundle", version: "1.0.0", installedAt: INSTALL });
    writeFileSync(path, JSON.stringify(list, null, 2));
  }
}

/** Drop an installed.json entry (the install tests install the real bundle id). */
function forgetInstalled(id) {
  const path = join(TMP_HOME, "installed.json");
  const list = JSON.parse(readFileSync(path, "utf8").trim() || "[]");
  writeFileSync(path, JSON.stringify(list.filter((e) => e && e.id !== id), null, 2));
}

async function withServer({ owner = true, crossHost = false } = {}, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (crossHost) req.crossHostAuth = { sourceInstanceId: "peer" }; next(); });
  B._setOwnerCheckForTest(() => owner);
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    return await fn(post);
  } finally {
    server.close();
    B._setOwnerCheckForTest(null);
  }
}

test("both invite routes are owner-only: a non-owner session and a peer request get 403", async () => {
  seedRouteBundle(ROUTE_MANIFEST);
  await withServer({ owner: false }, async (post) => {
    for (const [path, body] of [
      ["/bundles/api/first-admin-invite", { bundle_id: ROUTE_ID, email: OWNER }],
      ["/bundles/api/first-admin-close-signups", { bundle_id: ROUTE_ID }],
    ]) {
      const r = await post(path, body);
      assert.equal(r.status, 403, path);
      assert.match(r.body.error, /owner at this machine's dashboard/);
    }
  });
  await withServer({ owner: true, crossHost: true }, async (post) => {
    // Express matches case-insensitively and ignores a trailing slash: the deny list must too.
    for (const path of [
      "/bundles/api/first-admin-invite",
      "/BUNDLES/API/FIRST-ADMIN-INVITE/",
      "/bundles/api/first-admin-close-signups",
      "/Bundles/Api/First-Admin-Close-Signups/",
    ]) {
      const r = await post(path, { bundle_id: ROUTE_ID, email: OWNER });
      assert.equal(r.status, 403, `${path}: a peer may not invite into this machine's vault`);
    }
  });
});

test("B1: another bundle whose reviewed manifest names the handler is refused, and nothing is contacted", async () => {
  seedRouteBundle(LOOKALIKE_MANIFEST);
  const fake = signedIn({ signups: "off", users: [] });
  B._setFirstAdminInviteDepsForTest({ fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  try {
    await withServer({ owner: true }, async (post) => {
      for (const path of ["/bundles/api/first-admin-invite", "/bundles/api/first-admin-close-signups"]) {
        const r = await post(path, { bundle_id: LOOKALIKE_ID, email: OWNER });
        assert.equal(r.status, 400, path);
        assert.equal(r.body.code, "no_invite_handler");
        assert.match(r.body.error, /does not invite anyone/);
      }
    });
    assert.equal(fake.calls.length, 0, "no login, no admin request at all");
  } finally {
    B._setFirstAdminInviteDepsForTest(null);
  }
  // And the panel's state reader refuses the same way: no handler, no token read.
  let tokenReads = 0;
  const states = await H.inviteStatesFor({
    installed: { [LOOKALIKE_ID]: { installedAt: INSTALL } },
    manifest: LOOKALIKE_MANIFEST,
    bundleId: LOOKALIKE_ID,
    fetch: fake.fetchImpl,
    readAdminToken: async () => { tokenReads++; return TOKEN; },
  });
  assert.deepEqual(states, {});
  assert.equal(tokenReads, 0, "the admin token is never read for another bundle");
  assert.equal(fake.calls.length, 0);
});

test("B1: the panel path computes a state ONLY for the real bundle, from the reviewed manifest", async () => {
  let tokenReads = 0;
  const fake = signedIn({ signups: "off", users: [] });
  const states = await H.inviteStatesFor({
    installed: { vaultwarden: { installedAt: INSTALL } },
    // The reviewed manifest, exactly as panels/extensions.js hands it in.
    manifest: ROUTE_MANIFEST,
    fetch: fake.fetchImpl,
    readAdminToken: async () => { tokenReads++; return TOKEN; },
  });
  assert.deepEqual(Object.keys(states), ["vaultwarden"]);
  assert.equal(states.vaultwarden.signups, "off");
  assert.equal(tokenReads, 1);
  // No reviewed declaration (the installed copy is not consulted): nothing happens.
  const none = await H.inviteStatesFor({
    installed: { vaultwarden: { installedAt: INSTALL } },
    manifest: null,
    fetch: fake.fetchImpl,
    readAdminToken: async () => { tokenReads++; return TOKEN; },
  });
  assert.deepEqual(none, {});
  assert.equal(tokenReads, 1, "still only the one read");
  // Not installed: nothing either.
  const notInstalled = await H.inviteStatesFor({ installed: {}, manifest: ROUTE_MANIFEST, fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  assert.deepEqual(notInstalled, {});
});

test("a bundle that declares no invite handler is a 400 with a plain sentence; unknown ids 400/404", async () => {
  seedRouteBundle(PLAIN_MANIFEST);
  await withServer({ owner: true }, async (post) => {
    for (const path of ["/bundles/api/first-admin-invite", "/bundles/api/first-admin-close-signups"]) {
      const r = await post(path, { bundle_id: PLAIN_ID, email: OWNER });
      assert.equal(r.status, 400, path);
      assert.match(r.body.error, /does not invite anyone/);
      assert.equal(r.body.code, "no_invite_handler");
      const bad = await post(path, { bundle_id: "not a bundle id" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, "Invalid bundle ID");
      const unknown = await post(path, { bundle_id: "not-installed" });
      assert.equal(unknown.status, 404);
    }
  });
});

test("the invite route invites and answers with a plain sentence; a bad address is a 400", async () => {
  seedRouteBundle(ROUTE_MANIFEST);
  let closed = false;
  const fake = fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"] }),
    "GET /admin/users": () => res_({ status: 200, json: [] }),
    "GET /admin": () => res_({ status: 200, body: adminPage({ signups: closed ? "off" : "on" }) }),
    "POST /admin/invite": () => res_({ status: 200 }),
    "POST /admin/config": () => { closed = true; return res_({ status: 200 }); },
  });
  B._setFirstAdminInviteDepsForTest({ fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  H.clearInviteStateCache();
  try {
    await withServer({ owner: true }, async (post) => {
      const bad = await post("/bundles/api/first-admin-invite", { bundle_id: ROUTE_ID, email: "nope" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.result, "invalid-email");
      assert.equal(bad.body.error, "That does not look like an email address.");
      const r = await post("/bundles/api/first-admin-invite", { bundle_id: ROUTE_ID, email: OWNER });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true);
      assert.equal(r.body.result, "invited");
      assert.match(r.body.message, /Crow invited owner@example\.com/);
      assert.doesNotMatch(JSON.stringify(r.body), /Plain-admin-token|VW_ADMIN|jwt-value/);
    });
  } finally {
    B._setFirstAdminInviteDepsForTest(null);
  }
});

test("the close route says 'off' only when the re-read agrees, and never echoes a raw error", async () => {
  seedRouteBundle(ROUTE_MANIFEST);
  const fake = signedIn({ signups: "off", extra: { "POST /admin/config": () => res_({ status: 200 }) } });
  B._setFirstAdminInviteDepsForTest({ fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  H.clearInviteStateCache();
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await post("/bundles/api/first-admin-close-signups", { bundle_id: ROUTE_ID });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.result, "off");
      assert.match(r.body.message, /Sign-ups are closed/);
    });
  } finally {
    B._setFirstAdminInviteDepsForTest(null);
  }
  // A Vaultwarden that answers 200 but keeps sign-ups open: ok:false, "unknown".
  const stubborn = signedIn({ signups: "on", extra: { "POST /admin/config": () => res_({ status: 200 }) } });
  B._setFirstAdminInviteDepsForTest({ fetch: stubborn.fetchImpl, readAdminToken: async () => TOKEN });
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await post("/bundles/api/first-admin-close-signups", { bundle_id: ROUTE_ID });
      assert.equal(r.body.ok, false);
      assert.equal(r.body.result, "unknown");
      assert.match(r.body.error, /could not confirm/);
    });
    // No token: 'failed' with the Settings → Passwords sentence, not a raw error. (The
    // remembered cookie would otherwise let the earlier fake keep answering.)
    H.clearAdminSession();
    B._setFirstAdminInviteDepsForTest({ fetch: stubborn.fetchImpl, readAdminToken: async () => null });
    await withServer({ owner: true }, async (post) => {
      const r = await post("/bundles/api/first-admin-close-signups", { bundle_id: ROUTE_ID });
      assert.equal(r.body.ok, false);
      assert.equal(r.body.result, "failed");
      assert.match(r.body.error, /Settings → Passwords/);
      const inv = await post("/bundles/api/first-admin-invite", { bundle_id: ROUTE_ID, email: OWNER });
      assert.equal(inv.body.result, "no-token");
      assert.match(inv.body.error, /Settings → Passwords/);
    });
  } finally {
    B._setFirstAdminInviteDepsForTest(null);
  }
  // S2: Vaultwarden's login limit gets its own plain sentence, not "could not close".
  const limited = fakeVaultwarden({ "POST /admin": () => res_({ status: 429 }) });
  B._setFirstAdminInviteDepsForTest({ fetch: limited.fetchImpl, readAdminToken: async () => TOKEN });
  try {
    await withServer({ owner: true }, async (post) => {
      const r = await post("/bundles/api/first-admin-close-signups", { bundle_id: ROUTE_ID });
      assert.equal(r.body.ok, false);
      assert.equal(r.body.result, "rate-limited");
      assert.match(r.body.error, /limiting admin logins for a few minutes/);
      const inv = await post("/bundles/api/first-admin-invite", { bundle_id: ROUTE_ID, email: OWNER });
      assert.equal(inv.body.result, "rate-limited");
      assert.match(inv.body.error, /limiting admin logins/);
    });
  } finally {
    B._setFirstAdminInviteDepsForTest(null);
  }
});

// ── 6. the install path ──

/** A source bundle that ships a compose file (stubbed runners: no docker). */
function installManifest(id, extra = {}) {
  const dir = join(TMP_BUNDLES, id);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    name: `${id} app`,
    type: "bundle",
    version: "0.1.0",
    category: "misc",
    docker: { composefile: "docker-compose.yml" },
    webUI: { port: 8097, path: "/", label: id },
    firstAdmin: { mode: "finish-setup", invite: "vaultwarden" },
    env_vars: [{ name: "VAULTWARDEN_URL", default: "http://localhost:8097" }, { name: "VAULTWARDEN_OWNER_EMAIL" }],
    ...extra,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "docker-compose.yml"), "services:\n  app:\n    image: busybox\n");
  return manifest;
}

function stubInstall() {
  B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  B._setHookRunnerForTest(null);
}

async function runInstall(id, manifest, envVars) {
  stubInstall();
  forgetInstalled(id);
  // A fresh install: no .env from an earlier test's reinstall (the .env lines are kept).
  rmSync(join(TMP_HOME, "bundles", id), { recursive: true, force: true });
  const job = B._createJobForTest(id, "install");
  try {
    return { out: await B.runInstallJob(id, envVars, { job, installedSnapshot: [], consentVerified: false, manifest }), job };
  } finally {
    B._finishJobForTest(job, "complete");
  }
}

test("the install invites the owner's email after compose up when the email is set", async () => {
  const id = "vaultwarden";
  const manifest = installManifest(id);
  // A stateful fake: the config POST really closes sign-ups, so the log sentence
  // (and the bell's silence) can be honest about it.
  let closed = false;
  const fake = fakeVaultwarden({
    "GET /alive": () => res_({ status: 200 }),
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"], body: adminPage({ signups: "on" }) }),
    "GET /admin": () => res_({ status: 200, body: adminPage({ signups: closed ? "off" : "on" }) }),
    "GET /admin/users": () => res_({ status: 200, json: [] }),
    "POST /admin/invite": () => res_({ status: 200 }),
    "POST /admin/config": () => { closed = true; return res_({ status: 200 }); },
  });
  B._setFirstAdminInviteDepsForTest({ fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  try {
    const { out, job } = await runInstall(id, manifest, { VAULTWARDEN_OWNER_EMAIL: OWNER, VAULTWARDEN_URL: "http://localhost:8097" });
    assert.equal(out.ok, true, out.reason);
    const log = job.log.join("\n");
    assert.match(log, /Crow invited owner@example\.com: open .* and create your account with that email\. Sign-ups are closed to everyone else\./);
    assert.ok(fake.calls.some((c) => c.path === "/admin/invite"), "the invite really happened");
    assert.ok(fake.calls.some((c) => c.path === "/alive"), "after the app answered /alive");
    assert.ok(configCalls(fake.calls).length === 1, "the full config was posted once");
    assert.doesNotMatch(log, /Plain-admin-token|VW_ADMIN|jwt-value/);
  } finally {
    B._setFirstAdminInviteDepsForTest(null);
  }
});

test("no owner email: nothing is contacted, and the install still succeeds", async () => {
  const id = "vaultwarden";
  const manifest = installManifest(id);
  const fake = fakeVaultwarden({});
  B._setFirstAdminInviteDepsForTest({ fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  try {
    const { out, job } = await runInstall(id, manifest, { VAULTWARDEN_URL: "http://localhost:8097" });
    assert.equal(out.ok, true, out.reason);
    assert.equal(fake.calls.length, 0, "no email, no request at all");
    assert.doesNotMatch(job.log.join("\n"), /invite/i);
  } finally {
    B._setFirstAdminInviteDepsForTest(null);
  }
});

test("an invite failure never fails the install: one plain sentence, and it does not throw", async () => {
  const id = "vaultwarden";
  const manifest = installManifest(id);
  const fake = fakeVaultwarden({ "GET /alive": () => { throw new Error("ECONNREFUSED"); } });
  let clock = 0;
  B._setFirstAdminInviteDepsForTest({
    fetch: fake.fetchImpl,
    readAdminToken: async () => TOKEN,
    now: () => clock,
    sleep: async (ms) => { clock += ms + 1; },
  });
  try {
    const { out, job } = await runInstall(id, manifest, { VAULTWARDEN_OWNER_EMAIL: OWNER, VAULTWARDEN_URL: "http://localhost:8097" });
    assert.equal(out.ok, true, out.reason);
    assert.match(job.log.join("\n"), /Crow could not invite owner@example\.com: .* did not answer/);
  } finally {
    B._setFirstAdminInviteDepsForTest(null);
  }
});

test("B1: the install path only invites for the bundle the handler belongs to", async () => {
  const manifest = installManifest("vw-install-lookalike");
  const fake = fakeVaultwarden({});
  B._setFirstAdminInviteDepsForTest({ fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  try {
    const { out, job } = await runInstall("vw-install-lookalike", manifest, { VAULTWARDEN_OWNER_EMAIL: OWNER, VAULTWARDEN_URL: "http://localhost:8097" });
    assert.equal(out.ok, true, out.reason);
    assert.equal(fake.calls.length, 0, "no /alive, no login, no token read");
    assert.doesNotMatch(job.log.join("\n"), /invite/i);
  } finally {
    B._setFirstAdminInviteDepsForTest(null);
  }
});

// ── 7. the contract ──

const WEB = { id: "demo", name: "Demo", description: "d", type: "bundle", category: "misc", webUI: { port: 8080, path: "/", label: "Demo" } };

test("contract: invite is allowed only on finish-setup, and only with a handler Crow ships", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-vw-contract-"));
  mkdirSync(join(dir, "demo"), { recursive: true });
  const demo = join(dir, "demo");
  const errs = (firstAdmin) => (validateManifest({ ...WEB, firstAdmin }, demo).errors || []).join("\n");
  assert.equal(validateManifest({ ...WEB, firstAdmin: { mode: "finish-setup", invite: "vaultwarden" } }, demo).ok, true);
  assert.match(errs({ mode: "finish-setup", invite: "vaultwarden2" }), /must name one of Crow's invite handlers/);
  assert.match(errs({ mode: "finish-setup", invite: 42 }), /shape|invite/);
  for (const mode of ["crow", "default-login", "external", "none"]) {
    assert.match(errs({ mode, invite: "vaultwarden", ...(mode === "default-login" ? { user: "admin" } : {}) }), /invite is only allowed with mode "finish-setup"/, mode);
  }
  assert.deepEqual(REGISTRY.INVITE_HANDLER_NAMES, Object.keys(H.INVITE_HANDLERS));
  // B1: every handler is bound to a bundle, and the id binding is what resolves it.
  for (const name of REGISTRY.INVITE_HANDLER_NAMES) {
    assert.equal(REGISTRY.INVITE_HANDLERS[name].bundleId, name);
    assert.equal(H.INVITE_HANDLERS[name].bundleId, name);
  }
  assert.equal(H.inviteHandlerFor(VW_MANIFEST, "vaultwarden"), H.INVITE_HANDLERS.vaultwarden);
  assert.equal(H.inviteHandlerFor(VW_MANIFEST, "not-vaultwarden"), null);
  assert.equal(H.inviteHandlerFor(VW_MANIFEST, null), null);
});

test("the shipped Vaultwarden manifest declares the invite flow and validates", () => {
  const dir = join(REPO, "bundles", "vaultwarden");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(
    { mode: manifest.firstAdmin.mode, invite: manifest.firstAdmin.invite },
    { mode: "finish-setup", invite: "vaultwarden" },
  );
  const email = manifest.env_vars.find((v) => v.name === "VAULTWARDEN_OWNER_EMAIL");
  assert.equal(email.required, false);
  assert.equal(email.secret, undefined);
  assert.equal(email.pattern, "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
  assert.match(email.description, /invites it at install/);
  const signups = manifest.env_vars.find((v) => v.name === "VAULTWARDEN_SIGNUPS_ALLOWED");
  assert.equal(signups.default, "false");
  assert.match(signups.description, /Leave false/);
  assert.equal(H.SIGNUPS_ENV_KEY, "VAULTWARDEN_SIGNUPS_ALLOWED");
  assert.match(readFileSync(join(dir, "docker-compose.yml"), "utf8"), /SIGNUPS_ALLOWED=\$\{VAULTWARDEN_SIGNUPS_ALLOWED:-false\}/);
  assert.deepEqual(validateManifest(manifest, dir, { bundleExists: () => true }).errors, []);
  // The reviewed manifest is the only source of the admin port, and it matches compose.
  assert.equal(H.vaultwardenBaseUrl(manifest), "http://127.0.0.1:8097");
  assert.match(readFileSync(join(dir, "docker-compose.yml"), "utf8"), /"127\.0\.0\.1:8097:80"/);
});

test("S6: the skill does not claim nobody can register before Crow confirmed sign-ups are closed", () => {
  const skill = readFileSync(join(REPO, "bundles", "vaultwarden", "skills", "vaultwarden.md"), "utf8");
  assert.doesNotMatch(skill, /Nobody else can ever register/);
  assert.match(skill, /Once Crow confirms the\s+app's sign-ups are closed/);
  const docs = readFileSync(join(REPO, "docs", "developers", "bundles.md"), "utf8");
  assert.doesNotMatch(docs, /no URL, path or email comes from a manifest/);
  assert.doesNotMatch(docs, /driven by the app's own state, not by a Done press/);
  assert.match(docs, /Done\*\* only hides the "Crow could not read the app" card/);
  assert.match(docs, /VAULTWARDEN_URL` in the installed `\.env` is ignored/);
  // The module's header comment says it too (the finding's file:line).
  const source = readFileSync(join(REPO, "servers", "gateway", "first-admin", "vaultwarden-invite.js"), "utf8");
  assert.doesNotMatch(source, /VAULTWARDEN_URL` points anywhere else is refused/);
  assert.match(source, /must not decide where the\s+ \* admin token is sent/);
});