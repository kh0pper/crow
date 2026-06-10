import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateLocalToken, revokeLocalToken, getLocalTokenMeta,
  validateLocalToken, LOCAL_TOKEN_KEYS,
} from "../servers/gateway/local-token.js";
import { isSyncable } from "../servers/gateway/dashboard/settings/registry.js";

// In-memory db stub matching the exact SQL the settings registry emits for
// local-scoped reads/writes (readSetting / writeSetting{scope:"local"} /
// deleteLocalSetting). instance_id (args[1] on writes/reads) is irrelevant
// here: the test process is a single logical instance.
function memDb() {
  const overrides = new Map();
  const globals = new Map();
  return {
    async execute({ sql, args }) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("INSERT INTO dashboard_settings_overrides")) {
        overrides.set(args[0], args[2]); return { rows: [] };
      }
      if (s.startsWith("SELECT value FROM dashboard_settings_overrides")) {
        const v = overrides.get(args[0]);
        return { rows: v === undefined ? [] : [{ value: v }] };
      }
      if (s.startsWith("SELECT value FROM dashboard_settings WHERE")) {
        const v = globals.get(args[0]);
        return { rows: v === undefined ? [] : [{ value: v }] };
      }
      if (s.startsWith("DELETE FROM dashboard_settings_overrides")) {
        overrides.delete(args[0]); return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test("no token configured: meta empty, validate false", async () => {
  const db = memDb();
  assert.deepEqual(await getLocalTokenMeta(db), { present: false, createdAt: null });
  assert.equal(await validateLocalToken(db, "anything"), false);
  assert.equal(await validateLocalToken(db, ""), false);
});

test("generate returns a raw token, stores hash, validates", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  assert.match(token, /^[0-9a-f]{64}$/, "32-byte hex token");
  const meta = await getLocalTokenMeta(db);
  assert.equal(meta.present, true);
  assert.ok(meta.createdAt, "records a created timestamp");
  assert.equal(await validateLocalToken(db, token), true, "the issued token validates");
  // "x" is never a valid hex digit, so this is guaranteed != the real token
  // (replacing the last char with a digit could collide when it already matches).
  assert.equal(await validateLocalToken(db, token.slice(0, -1) + "x"), false, "a tampered token fails");
});

test("rotate (generate again) invalidates the old token", async () => {
  const db = memDb();
  const first = await generateLocalToken(db);
  const second = await generateLocalToken(db);
  assert.notEqual(first, second);
  assert.equal(await validateLocalToken(db, first), false, "old token no longer valid");
  assert.equal(await validateLocalToken(db, second), true, "new token valid");
});

test("revoke clears the token", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  await revokeLocalToken(db);
  assert.equal((await getLocalTokenMeta(db)).present, false);
  assert.equal(await validateLocalToken(db, token), false);
});

test("the token hash key is NOT syncable (per-instance, never replicated)", () => {
  assert.equal(isSyncable(LOCAL_TOKEN_KEYS.HASH_KEY), false);
  assert.equal(isSyncable(LOCAL_TOKEN_KEYS.CREATED_KEY), false);
});

import {
  localTokenAuthMiddleware, localOperatorAuth, applyLocalTokenAuth,
} from "../servers/gateway/local-token.js";

function run(mw, req) {
  return new Promise((resolve) => {
    mw(req, { status() { return this; }, json() {}, send() {} }, () => resolve(true));
  });
}

test("middleware sets req.localTokenAuth for a valid token on an MCP path", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: { authorization: `Bearer ${token}` } };
  await run(localTokenAuthMiddleware(db), req);
  assert.deepEqual(req.localTokenAuth, { token: "local-mcp" });
});

test("middleware skips the DB read on non-MCP paths (cost guard)", async () => {
  const db = memDb();
  await generateLocalToken(db);
  let reads = 0;
  const spyDb = { execute: (...a) => { reads++; return db.execute(...a); } };
  const req = { path: "/dashboard/nest", headers: { authorization: "Bearer whatever" } };
  await run(localTokenAuthMiddleware(spyDb), req);
  assert.equal(reads, 0, "no settings read for a non-MCP request");
  assert.equal(req.localTokenAuth, undefined);
});

test("middleware does NOT match unrelated routes ending in /messages", async () => {
  const db = memDb();
  await generateLocalToken(db);
  let reads = 0;
  const spyDb = { execute: (...a) => { reads++; return db.execute(...a); } };
  // Real non-MCP routes that end in /messages (2+ segments deep) must not be
  // treated as MCP transport paths. MCP paths are at most one prefix segment deep.
  for (const path of ["/dashboard/streams/messages", "/api/chat/conversations/abc/messages", "/api/bot-chat/bot1/messages"]) {
    const req = { path, headers: { authorization: "Bearer whatever" } };
    await run(localTokenAuthMiddleware(spyDb), req);
    assert.equal(req.localTokenAuth, undefined, `${path} must not authenticate`);
  }
  assert.equal(reads, 0, "no settings read for any non-MCP /messages route");
});

test("middleware matches real MCP mount paths (single-segment prefix or root)", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  for (const path of ["/mcp", "/router/mcp", "/memory/sse", "/tools-cursor/messages", "/blog-mcp/mcp"]) {
    const req = { path, headers: { authorization: `Bearer ${token}` } };
    await run(localTokenAuthMiddleware(db), req);
    assert.deepEqual(req.localTokenAuth, { token: "local-mcp" }, `${path} authenticates`);
  }
});

test("middleware ignores a wrong token (falls through, no flag)", async () => {
  const db = memDb();
  await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: { authorization: "Bearer not-the-token" } };
  await run(localTokenAuthMiddleware(db), req);
  assert.equal(req.localTokenAuth, undefined);
});

test("middleware yields to instance auth (does not run when req.instanceAuth set)", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: { authorization: `Bearer ${token}` }, instanceAuth: { instance: { id: "x" } } };
  await run(localTokenAuthMiddleware(db), req);
  assert.equal(req.localTokenAuth, undefined, "instance auth wins");
});

test("middleware no-ops without a Bearer header", async () => {
  const db = memDb();
  await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: {} };
  const ok = await run(localTokenAuthMiddleware(db), req);
  assert.equal(ok, true);
  assert.equal(req.localTokenAuth, undefined);
});

test("localOperatorAuth() is a full-access mcp:tools credential", () => {
  const a = localOperatorAuth();
  assert.equal(a.clientId, "local-mcp");
  assert.deepEqual(a.scopes, ["mcp:tools"]);
  assert.ok(a.expiresAt > Math.floor(Date.now() / 1000), "expiry in the future");
});

test("applyLocalTokenAuth: synthesizes full auth ONLY when the flag is set, never touches a gate", () => {
  const yes = { localTokenAuth: { token: "local-mcp" } };
  assert.equal(applyLocalTokenAuth(yes), true);
  assert.equal(yes.auth.clientId, "local-mcp");
  assert.deepEqual(yes.auth.scopes, ["mcp:tools"]);

  const no = {};
  assert.equal(applyLocalTokenAuth(no), false, "no flag -> falls through to OAuth");
  assert.equal(no.auth, undefined, "does not fabricate auth without the flag");
});

import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

const TOKEN_KEYS = [
  "connect.token.heading", "connect.token.intro",
  "connect.token.generate", "connect.token.rotate", "connect.token.revoke",
  "connect.token.activeSince", "connect.token.revealHeading",
  "connect.token.revealWarning", "connect.token.configLead",
  "connect.token.placeholderNote", "connect.token.connectionsPointer",
  "connect.token.actionError",
];

test("every connect.token.* key has a non-empty en AND es value", () => {
  for (const k of TOKEN_KEYS) {
    const e = i18n.translations[k];
    assert.ok(e, `missing entry for ${k}`);
    assert.ok(e.en && e.en.trim(), `missing en for ${k}`);
    assert.ok(e.es && e.es.trim(), `missing es for ${k}`);
  }
});

test("token UI copy obeys crow.md style (no em dash, no 'not X, but Y')", () => {
  for (const k of TOKEN_KEYS) {
    for (const lang of ["en", "es"]) {
      const v = i18n.t(k, lang);
      assert.ok(!v.includes("—"), `${k}.${lang} must not use an em dash`);
    }
  }
});

import connectPanel from "../servers/gateway/dashboard/panels/connect.js";

const HOST = "crow.example.ts.net:8444";
function mkReq({ method = "GET", body = null, db, csrf = "csrf-x", cookie = "" } = {}) {
  return {
    method, body, csrfToken: csrf,
    query: {}, headers: cookie ? { cookie } : {},
    protocol: "https",
    get(h) { return h.toLowerCase() === "host" ? HOST : ""; },
  };
}
function ctx(db) {
  return { db, layout: ({ content }) => content };
}

test("GET with no token: shows the token heading + a Generate control, reveals nothing", async () => {
  const db = memDb();
  const html = await connectPanel.handler(mkReq({ db }), { send() {}, setHeader() {} }, ctx(db));
  assert.ok(html.includes(i18n.t("connect.token.heading", "en")), "token section heading present");
  assert.ok(html.includes('value="generate_token"'), "Generate form present");
  assert.ok(!html.includes('value="revoke_token"'), "no Revoke control when no token");
  assert.ok(!/Bearer\s+[0-9a-f]{64}/.test(html), "no raw token revealed");
});

test("GET with a token present: masked state, placeholder config, Rotate + Revoke", async () => {
  const db = memDb();
  await generateLocalToken(db);
  const html = await connectPanel.handler(mkReq({ db }), { send() {}, setHeader() {} }, ctx(db));
  assert.ok(html.includes(i18n.t("connect.token.activeSince", "en")), "masked active state");
  assert.ok(html.includes("&lt;YOUR-TOKEN&gt;"), "config shows an escaped placeholder, not a real token");
  assert.ok(html.includes('value="rotate_token"') && html.includes('value="revoke_token"'), "Rotate + Revoke present");
  assert.ok(!/Bearer\s+[0-9a-f]{64}/.test(html), "real token not shown in masked state");
});

test("POST generate_token: reveals the raw token once + a Bearer config", async () => {
  const db = memDb();
  const html = await connectPanel.handler(
    mkReq({ method: "POST", body: { action: "generate_token" }, db }),
    { send() {}, setHeader() {} }, ctx(db));
  const m = html.match(/Bearer ([0-9a-f]{64})/);
  assert.ok(m, "reveals a Bearer token in the config");
  assert.equal(await validateLocalToken(db, m[1]), true, "the revealed token is the one that was stored");
  assert.ok(html.includes(i18n.t("connect.token.revealWarning", "en")), "shows the one-time warning");
});

test("POST revoke_token: clears the token and returns to the empty state", async () => {
  const db = memDb();
  await generateLocalToken(db);
  const html = await connectPanel.handler(
    mkReq({ method: "POST", body: { action: "revoke_token" }, db }),
    { send() {}, setHeader() {} }, ctx(db));
  assert.equal((await getLocalTokenMeta(db)).present, false, "token cleared");
  assert.ok(html.includes('value="generate_token"'), "back to the Generate control");
});

test("POST rotate_token: replaces an existing token; the new one is revealed and valid", async () => {
  const db = memDb();
  const first = await generateLocalToken(db);
  const html = await connectPanel.handler(
    mkReq({ method: "POST", body: { action: "rotate_token" }, db }),
    { send() {}, setHeader() {} }, ctx(db));
  const m = html.match(/Bearer ([0-9a-f]{64})/);
  assert.ok(m, "rotate reveals a new Bearer token");
  assert.notEqual(m[1], first, "the revealed token differs from the prior one");
  assert.equal(await validateLocalToken(db, m[1]), true, "the new token validates");
  assert.equal(await validateLocalToken(db, first), false, "the prior token is invalidated");
});

test("POST generate_token with a failing DB: shows an error callout, reveals no token", async () => {
  // db whose write throws -> generateLocalToken rejects -> handler catch path.
  const failingDb = { execute: async () => { throw new Error("disk error"); } };
  const html = await connectPanel.handler(
    mkReq({ method: "POST", body: { action: "generate_token" }, db: failingDb }),
    { send() {}, setHeader() {} }, ctx(failingDb));
  assert.ok(html.includes(i18n.t("connect.token.actionError", "en")), "renders the error callout");
  assert.ok(html.includes("callout-error"), "uses the error callout style");
  assert.ok(!/Bearer\s+[0-9a-f]{64}/.test(html), "no token revealed on failure");
});

import connectionsSection from "../servers/gateway/dashboard/settings/sections/connections.js";

test("Connections section points at the connect wizard for token generation", async () => {
  const req = { protocol: "https", headers: {}, get: (h) => (h.toLowerCase() === "host" ? HOST : "") };
  const html = await connectionsSection.render({ req, lang: "en" });
  assert.ok(html.includes("/dashboard/connect"), "links to the connect wizard");
  assert.ok(html.includes(i18n.t("connect.token.connectionsPointer", "en")), "uses the token pointer copy");
});

import { PUBLIC_FUNNEL_PREFIXES, rejectFunneledMiddleware } from "../servers/gateway/funnel.js";

// Hermetic: rejectFunneledMiddleware early-returns next() when
// CROW_DASHBOARD_PUBLIC === "true" (funnel.js:39). Clear it so this test
// asserts code behavior, not the ambient environment.
delete process.env.CROW_DASHBOARD_PUBLIC;

test("MCP paths are never in the public Funnel allowlist", () => {
  for (const p of PUBLIC_FUNNEL_PREFIXES) {
    assert.ok(!p.includes("mcp"), `${p} must not expose an MCP path`);
    assert.ok(!p.startsWith("/router"), `${p} must not expose the router`);
  }
});

test("a token-bearing MCP request over Funnel is rejected before auth", () => {
  const mw = rejectFunneledMiddleware();
  let status = 0, sent = "";
  const req = { headers: { "tailscale-funnel-request": "1", authorization: "Bearer deadbeef" }, path: "/router/mcp" };
  const res = { status(c) { status = c; return this; }, type() { return this; }, send(b) { sent = b; } };
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(nexted, false, "must not call next for a funneled MCP request");
  assert.equal(status, 403, "rejects with 403");
  assert.match(sent, /Forbidden/, "explains the rejection");
});
