/**
 * Security audit N3-4 phase 2e — Vaultwarden is invite-only from the moment it is
 * installed.
 *
 * What this file covers, in order:
 *   1. the handler against a fake Vaultwarden admin API (login form encoding, one
 *      login per operation, cookie reuse, `_status` mapping, invite 200/409/500/
 *      unreachable, closing sign-ups and re-reading it, the sign-ups HTML parse),
 *   2. loopback-only, no token, and "the token never leaves",
 *   3. the real keychain reader (the same extension entry the install path saved),
 *   4. the card's five states + the adminSaved exception (pure) and the markup,
 *   5. both routes (owner-only, peer refused, 400 without a handler, plain errors),
 *   6. the install path (invite after compose up when the email is set; nothing
 *      without it),
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
const LOOPBACK_DIR = () => envDir({ VAULTWARDEN_URL: "http://localhost:8097" });

/** Vaultwarden's admin page HTML: the SSO checkbox comes FIRST, as on the real page. */
function adminHtml({ signups = "off" } = {}) {
  return `<html><body><form>
  <input type="checkbox" id="input_sso_signups_allowed" checked>
  <input type="checkbox" id="input_signups_allowed"${signups === "on" ? " checked" : ""}>
</form></body></html>`;
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
    text: async () => body,
    json: async () => (json !== null ? json : JSON.parse(body)),
  };
}

/**
 * A fake Vaultwarden: `routes` maps `METHOD /path` to a handler, and every call
 * is recorded (url, method, body, headers) so a test can count logins.
 */
function fakeVaultwarden(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(String(url)).pathname;
    const call = { url: String(url), path, method, body: init.body, headers: init.headers || {} };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected request: ${method} ${path}`);
    return handler(call);
  };
  return { fetchImpl, calls };
}

const cookieHeader = (call) => call.headers.cookie || "";
const loginCalls = (calls) => calls.filter((c) => c.method === "POST" && c.path === "/admin");

/** The signed-in happy path: login, then whatever `extra` routes the test adds. */
function signedIn({ signups = "off", users = [], extra = {} } = {}) {
  return fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin; HttpOnly"], body: adminHtml({ signups }) }),
    "GET /admin/users": () => res_({ status: 200, json: users }),
    "GET /admin": () => res_({ status: 200, body: adminHtml({ signups }) }),
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
    users: [{ email: OWNER, registered: true }, { email: "invited@example.com", registered: false }],
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
});

test("invite 200 invites and closes sign-ups with the SAME cookie, then re-reads to confirm", async () => {
  let closed = false;
  const fake = fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"], body: adminHtml({ signups: closed ? "off" : "on" }) }),
    "GET /admin/users": () => res_({ status: 200, json: [] }),
    "GET /admin": () => res_({ status: 200, body: adminHtml({ signups: closed ? "off" : "on" }) }),
    "POST /admin/invite": () => res_({ status: 200, json: { email: OWNER, _status: 1 } }),
    "POST /admin/config": () => { closed = true; return res_({ status: 200, body: "" }); },
  });
  const out = await H.inviteOwnerResult({ email: OWNER, installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
  assert.deepEqual(out, { result: "invited", signups: "off" });
  assert.equal(loginCalls(fake.calls).length, 1, "one login for invite + close");
  const invite = fake.calls.find((c) => c.path === "/admin/invite");
  assert.equal(invite.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(invite.body), { email: OWNER });
  assert.equal(cookieHeader(invite), "VW_ADMIN=jwt-value");
  const config = fake.calls.find((c) => c.path === "/admin/config");
  assert.equal(cookieHeader(config), "VW_ADMIN=jwt-value", "the cookie from the invite's login closes sign-ups too");
  assert.deepEqual(JSON.parse(config.body), { signups_allowed: false });
  assert.ok(fake.calls.indexOf(config) > fake.calls.indexOf(invite), "closing happens after the invite");
  assert.ok(fake.calls.filter((c) => c.path === "/admin" && c.method === "GET").length >= 2, "read, close, re-read");
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
  // A 409 does not close anything, because nothing was invited: no login beyond the one.
  const fake = signedIn({ signups: "on", extra: { "POST /admin/invite": () => res_({ status: 409 }) } });
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
    "GET /admin": () => res_({ status: 200, body: adminHtml({ signups: after }) }),
    "POST /admin/config": () => res_({ status: configStatus }),
  });
  const off = withConfig("off");
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: off.fetchImpl, readAdminToken: async () => TOKEN }), "off");
  assert.equal(loginCalls(off.calls).length, 1);
  const stillOn = withConfig("on");
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: stillOn.fetchImpl, readAdminToken: async () => TOKEN }), "unknown", "a 200 alone proves nothing");
  const failed = withConfig("off", { configStatus: 500 });
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: failed.fetchImpl, readAdminToken: async () => TOKEN }), "failed");
  const unparseable = fakeVaultwarden({
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"] }),
    "GET /admin": () => res_({ status: 200, body: "<html>no form</html>" }),
    "POST /admin/config": () => res_({ status: 200 }),
  });
  assert.equal(await H.closeSignups({ installDir: LOOPBACK_DIR(), fetch: unparseable.fetchImpl, readAdminToken: async () => TOKEN }), "unknown");
});

// ── 2. loopback only, no token, and the token never leaves ──

test("a non-loopback VAULTWARDEN_URL is refused: no request is made at all", async () => {
  for (const url of ["http://vault.internal:8097", "https://vault.example.com", "http://10.0.0.5:8097", "ftp://127.0.0.1:8097", "not a url"]) {
    const dir = envDir({ VAULTWARDEN_URL: url });
    const fake = fakeVaultwarden({});
    const state = await H.vaultwardenState({ installDir: dir, fetch: fake.fetchImpl, readAdminToken: async () => TOKEN });
    assert.equal(state.reason, "not-local", url);
    assert.equal(state.reachable, false);
    assert.equal((await H.inviteOwnerResult({ email: OWNER, installDir: dir, fetch: fake.fetchImpl, readAdminToken: async () => TOKEN })).result, "failed", url);
    assert.equal(await H.closeSignups({ installDir: dir, fetch: fake.fetchImpl, readAdminToken: async () => TOKEN }), "failed", url);
    assert.equal(await H.waitForVaultwarden({ installDir: dir, fetch: fake.fetchImpl, timeoutMs: 0 }), false, url);
    assert.equal(fake.calls.length, 0, `${url}: nothing was contacted`);
  }
  assert.match(H.NOT_LOCAL, /only talks to a Vaultwarden on this machine/);
  assert.equal(H.loopbackBaseUrl("http://localhost:9000"), "http://127.0.0.1:9000", "the port is kept, the host is not");
  assert.equal(H.loopbackBaseUrl("http://127.0.0.1:8097"), "http://127.0.0.1:8097");
});

test("no token: state says so, invite is 'no-token', close is 'failed'", async () => {
  const fake = fakeVaultwarden({});
  const readAdminToken = async () => null;
  const state = await H.vaultwardenState({ installDir: LOOPBACK_DIR(), fetch: fake.fetchImpl, readAdminToken });
  assert.deepEqual(state, { signups: "unknown", users: [], reachable: false, reason: "no-token" });
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
const state = (over = {}) => ({ signups: "off", users: [], reachable: true, reason: null, ...over });

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
  const [card] = cards(state({ signups: "off", users: [{ email: OWNER, registered: false }] }));
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

test("card state 5: unreachable / no-token / unknown keep today's card plus one sentence why", () => {
  for (const [reason, reachable] of [["unreachable", false], ["no-token", false], ["not-local", false], ["unknown", true]]) {
    const [card] = cards({ signups: "unknown", users: [], reachable, reason });
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

test("the adminSaved rule does not hide an invite card — the /admin token is not a login", () => {
  assert.equal(FA.firstAdminSavedKey({ firstAdmin: { mode: "finish-setup" } }), FA.FIRST_ADMIN_SAVED_KEY);
  assert.equal(FA.firstAdminSavedKey({ firstAdmin: { mode: "crow", secretEnv: "VAULTWARDEN_ADMIN_TOKEN" } }), null, "an admin-panel token is never 'the app's login'");
  const saved = new Set(["vaultwarden"]);
  assert.equal(cards(state({ signups: "on", users: [{ email: OWNER, registered: true }] }), { adminSaved: saved }).length, 1, "sign-ups still open: the card stays");
  assert.equal(cards(state({ signups: "off", users: [{ email: "new@example.com", registered: false }] }), { adminSaved: saved }).length, 1, "an invited address: the card stays");
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
  assert.match(invite, /ext-firstadmin-invite/);
  assert.ok(invite.includes(t("bundles.firstAdmin.invite.inviteBody", "en").replace("{name}", "Vaultwarden")));

  const create = render(state({ signups: "off", users: [{ email: OWNER, registered: false }] }));
  assert.ok(create.includes(t("bundles.firstAdmin.invite.createBody", "en").replace("{name}", "Vaultwarden").replace("{email}", OWNER)));
  assert.match(create, /ext-firstadmin-open/);
  assert.doesNotMatch(create, /ext-firstadmin-done/, "no Done on an invite card");
  assert.doesNotMatch(create, /ext-firstadmin-save/);
  // Sign-ups still open: the sentence does not claim they are closed, and the card
  // carries the one button that closes them.
  const createOpen = render(state({ signups: "on", users: [{ email: OWNER, registered: false }] }));
  assert.ok(createOpen.includes(t("bundles.firstAdmin.invite.createOpenBody", "en").replace("{name}", "Vaultwarden").replace("{email}", OWNER)));
  assert.doesNotMatch(createOpen, /sign-ups are closed to everyone else/);
  assert.match(createOpen, /ext-firstadmin-close/);

  const close = render(state({ signups: "on", users: [{ email: OWNER, registered: true }] }));
  assert.match(close, /ext-firstadmin-close/);
  assert.match(close, /Close sign-ups/);
  assert.doesNotMatch(close, /ext-firstadmin-done/);

  const blocked = render({ signups: "unknown", users: [], reachable: false, reason: "unreachable" });
  assert.match(blocked, /ext-firstadmin-done/, "today's card is still there");
  assert.ok(blocked.includes(t("bundles.firstAdmin.invite.reason.unreachable", "en").replace("{name}", "Vaultwarden")));

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
});

test("every new sentence exists in both languages", () => {
  for (const key of [
    "bundles.firstAdmin.invite.closeBody",
    "bundles.firstAdmin.invite.createBody",
    "bundles.firstAdmin.invite.createOpenBody",
    "bundles.firstAdmin.invite.inviteBody",
    "bundles.firstAdmin.invite.signupsOpen",
    "bundles.firstAdmin.invite.closeSignups",
    "bundles.firstAdmin.invite.closing",
    "bundles.firstAdmin.invite.inviteAction",
    "bundles.firstAdmin.invite.sending",
    "bundles.firstAdmin.invite.emailLabel",
    "bundles.firstAdmin.invite.emailRequired",
    "bundles.firstAdmin.invite.reason.notLocal",
    "bundles.firstAdmin.invite.reason.noToken",
    "bundles.firstAdmin.invite.reason.unreachable",
    "bundles.firstAdmin.invite.reason.unknown",
    "bundles.firstAdmin.invite.resultInvalidEmail",
    "bundles.firstAdmin.invite.resultNoToken",
    "bundles.firstAdmin.invite.resultUnreachable",
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

const ROUTE_ID = "vw-route";
const ROUTE_MANIFEST = {
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
  const fake = signedIn({ signups: "on", users: [], extra: {
    "POST /admin/invite": () => res_({ status: 200 }),
    "POST /admin/config": () => res_({ status: 200 }),
  } });
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
    // No token: 'failed' with the Settings → Passwords sentence, not a raw error.
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
    webUI: { port: 8098, path: "/", label: id },
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
  const job = B._createJobForTest(id, "install");
  try {
    return { out: await B.runInstallJob(id, envVars, { job, installedSnapshot: [], consentVerified: false, manifest }), job };
  } finally {
    B._finishJobForTest(job, "complete");
  }
}

test("the install invites the owner's email after compose up when the email is set", async () => {
  const id = "vw-install-invite";
  const manifest = installManifest(id);
  // A stateful fake: the config POST really closes sign-ups, so the log sentence
  // (and the bell's silence) can be honest about it.
  let closed = false;
  const fake = fakeVaultwarden({
    "GET /alive": () => res_({ status: 200 }),
    "POST /admin": () => res_({ status: 200, cookies: ["VW_ADMIN=jwt-value; Path=/admin"], body: adminHtml({ signups: "on" }) }),
    "GET /admin": () => res_({ status: 200, body: adminHtml({ signups: closed ? "off" : "on" }) }),
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
    assert.doesNotMatch(log, /Plain-admin-token|VW_ADMIN|jwt-value/);
  } finally {
    B._setFirstAdminInviteDepsForTest(null);
  }
});

test("no owner email: nothing is contacted, and the install still succeeds", async () => {
  const id = "vw-install-noemail";
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
  const id = "vw-install-down";
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
  assert.match(readFileSync(join(dir, "docker-compose.yml"), "utf8"), /SIGNUPS_ALLOWED=\$\{VAULTWARDEN_SIGNUPS_ALLOWED:-false\}/);
  assert.deepEqual(validateManifest(manifest, dir, { bundleExists: () => true }).errors, []);
});