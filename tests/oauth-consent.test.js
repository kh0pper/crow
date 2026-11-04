// tests/oauth-consent.test.js — OAuth consent (the security audit's finding).
//
// CrowOAuthProvider.authorize() used to mint an authorization code for ANY
// registered client, with no dashboard login and no consent — and client
// registration is open by design (MCP dynamic registration). So anyone who could
// reach the gateway could register a client, call /authorize with their own PKCE
// challenge, lift the code out of the 302 Location, exchange it at /token and
// hold a full operator MCP bearer token. The code now exists only after the
// owner, signed in to the dashboard, clicks Allow on /dashboard/oauth/consent —
// and "the owner" means their own password session, not just any dashboard
// session (a full MCP token is more powerful than any other owner-only action).
//
// Harness: a scratch crow.db, the REAL dashboard router (which mounts the real
// consent router), the real CrowOAuthProvider, and a request-side socket address
// so a LAN peer can be simulated over the loopback test connection — the shape
// tests/first-run-setup-token.test.js uses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "oauth-consent-"));
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(dir, "data");
delete process.env.CROW_DB_PATH;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });

const express = (await import("express")).default;
const { createDbClient } = await import("../servers/db.js");
const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
const { setPassword } = await import("../servers/gateway/dashboard/auth.js");
const { createOAuthProvider } = await import("../servers/gateway/auth.js");
const { setInterfaceTableForTests } = await import("../servers/shared/ip-classify.js");
const { isConsentNext, pendingAuthorizations, setOAuthProvider } = await import("../servers/gateway/oauth-consent.js");

// Approving a sign-in is the owner's own turn (dashboard/local-session.js), so
// the origin rule (servers/shared/self-origin.js) is in play. Pin the interface
// table the way tests/self-origin.test.js does, so "this machine" does not
// depend on the NICs of the box the suite runs on: the fake LAN peer below is
// off-box, BOX_LAN is the box's own LAN address.
const BOX_LAN = "192.168.77.10";
setInterfaceTableForTests(() => ({
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", cidr: "127.0.0.1/8" }],
  lan0: [{ address: BOX_LAN, netmask: "255.255.255.0", family: "IPv4", cidr: `${BOX_LAN}/24` }],
}));

const db = createDbClient();
const provider = createOAuthProvider();
setOAuthProvider(provider); // what gateway/index.js does at boot

const LAN = "10.0.0.5"; // RFC1918: isAllowedNetwork allows it; bare loopback it refuses
const CLIENT_ID = "consent-test-client";
const CALLBACK = "http://127.0.0.1:47821/callback";
const STATE = "state-abc123";
const PW = "correct horse battery staple";

const SESSION = randomBytes(32).toString("hex");
const SSO_SESSION = randomBytes(32).toString("hex");
const ONHOST_SESSION = randomBytes(32).toString("hex");
const CSRF = randomBytes(16).toString("hex");
const cookieFor = (session) => `crow_session=${session}; crow_csrf=${CSRF}`;
const COOKIE = cookieFor(SESSION);
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

const VERIFIER = randomBytes(32).toString("base64url");
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

// Signed-in sessions, all real dashboard session rows (the same storage auth.js
// uses, which does not look at scopes): the owner's own password session, a
// peer sign-in (dashboard sso), and one minted by a login from this machine
// (dashboard onhost). Only the first may approve a sign-in.
for (const [token, scopes] of [[SESSION, "dashboard"], [SSO_SESSION, "dashboard sso src:peer"], [ONHOST_SESSION, "dashboard onhost"]]) {
  await db.execute({
    sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)",
    args: [sha256(token), scopes, new Date(Date.now() + 3_600_000).toISOString()],
  });
}

/** A LAN peer: the real connection is loopback, the peer address is not. */
let server;
function peerHeaderAs(req, _res, next) {
  const peer = req.headers["x-test-peer"];
  if (peer) {
    delete req.headers["x-test-peer"];
    Object.defineProperty(req, "socket", {
      value: { remoteAddress: peer, remotePort: 41001, localAddress: "127.0.0.1", localPort: server?.address()?.port },
      configurable: true,
      writable: true,
    });
  }
  next();
}

let base;
before(async () => {
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(peerHeaderAs);
  app.use(dashboardRouter((req, res, next) => next()));
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try { provider.db.close(); } catch {}
  try { db.close(); } catch {}
  setInterfaceTableForTests(null);
  if (server) await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  rmScratch(dir);
});

const get = (path, { peer = LAN, headers = {} } = {}) =>
  fetch(base + path, { redirect: "manual", headers: { ...(peer ? { "x-test-peer": peer } : {}), ...headers } });

const post = (path, fields, { peer = LAN, headers = {} } = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(peer ? { "x-test-peer": peer } : {}), ...headers },
    body: new URLSearchParams(fields).toString(),
  });

/** A response object shaped like Express's, for calling authorize() directly. */
function fakeRes() {
  return {
    statusCode: null,
    location: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    redirect(a, b) {
      this.statusCode = typeof a === "number" ? a : 302;
      this.location = typeof a === "number" ? b : a;
      return this;
    },
  };
}

const registerClient = (name = "Test App") =>
  provider.clientsStore.registerClient({ client_id: CLIENT_ID, client_name: name, redirect_uris: [CALLBACK] });

const authorizationParams = () => ({
  redirectUri: CALLBACK,
  codeChallenge: CHALLENGE,
  codeChallengeMethod: "S256",
  state: STATE,
});

/** Run the real authorize() for a registered client and return the pending id it made. */
async function mintPending(name = "Test App") {
  const client = await registerClient(name);
  const res = fakeRes();
  await provider.authorize(client, authorizationParams(), res);
  assert.equal(res.statusCode, 302, `authorize must answer a redirect, got ${res.statusCode}`);
  const id = new URL("http://crow.invalid" + res.location).searchParams.get("req");
  assert.ok(pendingAuthorizations.has(id), "the pending entry exists");
  return { client, id, res };
}

// --- 1 ---------------------------------------------------------------------
test("1. authorize for a registered client only PENDS: 302 to the consent page, no code anywhere", async () => {
  const { res } = await mintPending();
  assert.match(res.location, /^\/dashboard\/oauth\/consent\?req=[A-Za-z0-9_-]{32}$/);
  assert.equal(res.location.includes("code="), false, "no code in any URL");
  assert.equal(provider.codes.size, 0, "no authorization code was minted");
});

// --- 2 ---------------------------------------------------------------------
test("2. an unregistered redirect_uri is still a 400, before anything is recorded", async () => {
  const client = await registerClient();
  const beforeCount = pendingAuthorizations.size;
  const res = fakeRes();
  await provider.authorize(client, { ...authorizationParams(), redirectUri: "http://evil.example/callback" }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.error, "invalid_request");
  assert.equal(pendingAuthorizations.size, beforeCount, "no pending entry was created");
  assert.equal(provider.codes.size, 0);
});

// --- 3 ---------------------------------------------------------------------
test("3. GET consent from the LAN with no session goes to the login page, carrying the request", async () => {
  const { id } = await mintPending();
  const r = await get(`/dashboard/oauth/consent?req=${id}`);
  assert.equal(r.status, 302);
  const location = r.headers.get("location");
  assert.equal(location, "/dashboard/login?next=" + encodeURIComponent(`/dashboard/oauth/consent?req=${id}`));
  assert.equal(String(location).includes("code="), false);
});

// --- 4 ---------------------------------------------------------------------
test("4. GET consent from bare loopback is refused, and points apps on this machine at the local MCP token", async () => {
  const { id } = await mintPending();
  const r = await get(`/dashboard/oauth/consent?req=${id}`, { peer: null });
  const html = await r.text();
  assert.equal(r.status, 403);
  assert.match(html, /local MCP token/i, "the page names the way that DOES work for a same-box app");
  assert.match(html, /dashboard address/i, "and says which address to approve from");
});

// --- 5 ---------------------------------------------------------------------
test("5. the consent page: escaped client name, redirect origin, CSRF-carrying forms, no framing or caching", async () => {
  const { id } = await mintPending("<script>alert(1)</script>");
  const r = await get(`/dashboard/oauth/consent?req=${id}`, { headers: { cookie: COOKIE } });
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.equal(html.includes("<script>alert(1)</script>"), false, "the attacker-controlled client name is never raw");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "it appears HTML-escaped");
  assert.ok(html.includes("http://127.0.0.1:47821"), "the redirect URI's origin is shown");
  assert.ok(html.includes("Allowing gives this app full access"), "the blunt warning");
  assert.equal((html.match(/name="_csrf"/g) || []).length, 2, "both forms carry the CSRF token");
  assert.equal((html.match(/name="decision"/g) || []).length, 2, "one form per decision");
  assert.ok(html.includes(`value="${CSRF}"`), "the CSRF value is the crow_csrf cookie");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(String(r.headers.get("content-security-policy")), /frame-ancestors 'none'/);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

// --- 6 ---------------------------------------------------------------------
test("6. POST allow without a session is refused, and the pending request survives", async () => {
  const { id } = await mintPending();
  const r = await post("/dashboard/oauth/consent", { req: id, _csrf: CSRF, decision: "allow" });
  assert.equal(r.status, 403);
  assert.equal(pendingAuthorizations.has(id), true, "nothing was consumed");
  assert.equal(provider.codes.size, 0);
});

// --- 7 ---------------------------------------------------------------------
test("7. POST allow with a session but a wrong or absent _csrf is refused, and the request survives", async () => {
  const { id } = await mintPending();
  const wrong = await post("/dashboard/oauth/consent", { req: id, _csrf: "not-the-csrf-token", decision: "allow" }, { headers: { cookie: COOKIE } });
  assert.equal(wrong.status, 403);
  assert.equal(pendingAuthorizations.has(id), true, "nothing was consumed");

  const absent = await post("/dashboard/oauth/consent", { req: id, decision: "allow" }, { headers: { cookie: COOKIE } });
  assert.equal(absent.status, 403);
  assert.equal(pendingAuthorizations.has(id), true, "still nothing consumed");
  assert.equal(provider.codes.size, 0);
});

// --- 8 ---------------------------------------------------------------------
test("8. POST allow with the right CSRF mints a code that exchanges for a token; the request is single use", async () => {
  const { client, id } = await mintPending();
  const r = await post("/dashboard/oauth/consent", { req: id, _csrf: CSRF, decision: "allow" }, { headers: { cookie: COOKIE } });
  assert.equal(r.status, 303);
  const target = new URL(r.headers.get("location"));
  assert.equal(target.origin + target.pathname, CALLBACK);
  const code = target.searchParams.get("code");
  assert.ok(code, "the redirect carries the code");
  assert.equal(target.searchParams.get("state"), STATE, "and the original state");

  const tokens = await provider.exchangeAuthorizationCode(client, code, VERIFIER);
  assert.ok(tokens.access_token, "the code exchanges for an access token with the PKCE verifier");

  const replay = await post("/dashboard/oauth/consent", { req: id, _csrf: CSRF, decision: "allow" }, { headers: { cookie: COOKIE } });
  assert.equal(replay.status, 400, "the same request id cannot be decided twice");
});

// --- 9 ---------------------------------------------------------------------
test("9. POST deny sends error=access_denied with the state, and mints nothing", async () => {
  const { id } = await mintPending();
  const r = await post("/dashboard/oauth/consent", { req: id, _csrf: CSRF, decision: "deny" }, { headers: { cookie: COOKIE } });
  assert.equal(r.status, 303);
  const target = new URL(r.headers.get("location"));
  assert.equal(target.origin + target.pathname, CALLBACK);
  assert.equal(target.searchParams.get("error"), "access_denied");
  assert.equal(target.searchParams.get("state"), STATE);
  assert.equal(target.searchParams.get("code"), null, "no code at all");
  assert.equal(provider.codes.size, 0);
});

// --- 10 --------------------------------------------------------------------
test("10. an expired pending request is a 400 on the page and on the decision", async () => {
  const { id } = await mintPending();
  pendingAuthorizations.get(id).expiresAt = Date.now() - 1000; // the exported store is the aging hook
  const page = await get(`/dashboard/oauth/consent?req=${id}`, { headers: { cookie: COOKIE } });
  assert.equal(page.status, 400);
  assert.match(await page.text(), /expired/i);

  const { id: second } = await mintPending();
  pendingAuthorizations.get(second).expiresAt = Date.now() - 1000;
  const decision = await post("/dashboard/oauth/consent", { req: second, _csrf: CSRF, decision: "allow" }, { headers: { cookie: COOKIE } });
  assert.equal(decision.status, 400);
  assert.equal(provider.codes.size, 0);
});

// --- 11 --------------------------------------------------------------------
test("11. isConsentNext accepts only the exact consent URL the request id came in", () => {
  const id32 = "A".repeat(32);
  assert.equal(isConsentNext(`/dashboard/oauth/consent?req=${id32}`), true);
  for (const bad of [
    "//evil.example",
    "/dashboard",
    "/dashboard/oauth/consent?req=short",
    "https://evil.example/dashboard/oauth/consent?req=" + id32,
    `/dashboard/oauth/consent?req=${id32}&x=1`,
    "",
    null,
    undefined,
  ]) {
    assert.equal(isConsentNext(bad), false, String(bad));
  }
});

// --- 12 --------------------------------------------------------------------
test("12. a password login returns to the consent page for a good next, and to /dashboard for a bad one", async () => {
  await setPassword(PW);
  const next = `/dashboard/oauth/consent?req=${"B".repeat(32)}`;

  const page = await (await get("/dashboard/login?next=" + encodeURIComponent(next))).text();
  assert.ok(page.includes(`name="next" value="${next}"`), "the validated next is carried into the login form");
  const hostile = await (await get("/dashboard/login?next=" + encodeURIComponent("//evil.example"))).text();
  assert.equal(hostile.includes('name="next"'), false, "a hostile next is ignored, not echoed");

  const good = await post("/dashboard/login", { password: PW, next });
  assert.equal(good.status, 303);
  assert.equal(good.headers.get("location"), next, "the valid next wins over /dashboard");

  const bad = await post("/dashboard/login", { password: PW, next: "//evil.example" });
  assert.equal(bad.status, 303);
  assert.equal(bad.headers.get("location"), "/dashboard", "an invalid next cannot redirect anywhere");
});

// --- 13 --------------------------------------------------------------------
// Only the owner's OWN password session approves. A peer sign-in, a session
// minted by a login on this machine and a request from this machine itself all
// hold a working dashboard session, and all are refused (dashboard/local-session.js).
const OWNER_ONLY_TEXT = /Only the owner, signed in with the password/;

async function refusedFor(scopesSession, { peer = LAN } = {}) {
  const { id } = await mintPending();
  const headers = { cookie: cookieFor(scopesSession) };
  const page = await get(`/dashboard/oauth/consent?req=${id}`, { peer, headers });
  assert.equal(page.status, 403, `GET refused (${scopesSession.slice(0, 4)}… from ${peer})`);
  assert.match(await page.text(), OWNER_ONLY_TEXT);
  assert.equal(pendingAuthorizations.has(id), true, "the GET consumed nothing");

  const decision = await post("/dashboard/oauth/consent", { req: id, _csrf: CSRF, decision: "allow" }, { peer, headers });
  assert.equal(decision.status, 403, "POST refused even with the right CSRF token");
  assert.match(await decision.text(), OWNER_ONLY_TEXT);
  assert.equal(pendingAuthorizations.has(id), true, "nothing was consumed, so the pending request stays");
  assert.equal(provider.codes.size, 0, "and no code exists");
  return id;
}

test("13. a peer SSO session (dashboard sso …) cannot approve a sign-in", async () => {
  await refusedFor(SSO_SESSION);
});

test("14. a session minted by a login on this machine (dashboard onhost) cannot approve a sign-in", async () => {
  await refusedFor(ONHOST_SESSION);
});

test("15. the owner's own session is still refused when the request comes from this machine itself", async () => {
  await refusedFor(SESSION, { peer: BOX_LAN });
});

// --- 16 --------------------------------------------------------------------
test("16. the owner's password session from a LAN peer still approves end to end", async () => {
  const { client, id } = await mintPending();
  const headers = { cookie: COOKIE };
  const page = await get(`/dashboard/oauth/consent?req=${id}`, { headers });
  assert.equal(page.status, 200, "the owner's own session gets the page");
  assert.match(await page.text(), /name="decision"/);

  const r = await post("/dashboard/oauth/consent", { req: id, _csrf: CSRF, decision: "allow" }, { headers });
  assert.equal(r.status, 303);
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  assert.ok(code, "the owner's Allow mints the code");
  const tokens = await provider.exchangeAuthorizationCode(client, code, VERIFIER);
  assert.ok(tokens.access_token, "and it exchanges for an access token");
});

// --- 17 --------------------------------------------------------------------
const CUSTOM_CLIENT_ID = "consent-test-custom-scheme";
const CUSTOM_CALLBACK = "myapp://cb";

test("17. a custom-scheme client shows its scheme and host, never the string \"null\"", async () => {
  const client = await provider.clientsStore.registerClient({ client_id: CUSTOM_CLIENT_ID, client_name: "Custom App", redirect_uris: [CUSTOM_CALLBACK] });
  const redirected = fakeRes();
  await provider.authorize(client, { ...authorizationParams(), redirectUri: CUSTOM_CALLBACK }, redirected);
  assert.equal(redirected.statusCode, 302);
  const id = new URL("http://crow.invalid" + redirected.location).searchParams.get("req");

  const page = await get(`/dashboard/oauth/consent?req=${id}`, { headers: { cookie: COOKIE } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes("<code>myapp://cb</code>"), "the scheme and host instead of \"null\"");
  assert.equal(html.includes(">null<"), false, "the origin string \"null\" is never shown");
});

// --- 18 --------------------------------------------------------------------
test("18. a request id that is not the shape oauth-consent mints gets the expired page, not a login round trip", async () => {
  const short = await get("/dashboard/oauth/consent?req=short");
  assert.equal(short.status, 400, "a malformed id is not carried through the login page");
  assert.match(await short.text(), /expired/i);

  const missing = await get("/dashboard/oauth/consent");
  assert.equal(missing.status, 400, "no id at all is the same");

  const hostile = await get("/dashboard/oauth/consent?req=" + encodeURIComponent("A".repeat(31) + "!"), { peer: LAN });
  assert.equal(hostile.status, 400, "an id with a character the pattern refuses is not a consent next either");
});