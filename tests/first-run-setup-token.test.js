// tests/first-run-setup-token.test.js — the first-run takeover hole.
//
// On a fresh install there is no dashboard password, the gateway listens on
// 0.0.0.0 and isAllowedNetwork trusts any private-LAN source, so "whoever posts
// the first password first" used to own the instance. Now, while no password is
// set, a request that is not direct loopback must carry the one-time setup token
// (servers/gateway/dashboard/setup-token.js), and the token lives in
// <CROW_HOME>/setup-token, mode 0600, deleted with the first password.
//
// Harness: a scratch crow.db (init-db), the REAL dashboard router and the REAL
// /setup handler, and a request-side socket address so a LAN peer can be
// simulated over the loopback test connection.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, statSync, existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

const execFileP = promisify(execFile);

const REPO = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "first-run-setup-token-"));
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(dir, "data");
delete process.env.CROW_DB_PATH;
delete process.env.CROW_SETUP_TOKEN;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });

const express = (await import("express")).default;
const { createDbClient } = await import("../servers/db.js");
const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
const { setupPageHandler } = await import("../servers/gateway/setup-page.js");
const { isPasswordSet } = await import("../servers/gateway/dashboard/auth.js");
const {
  getSetupToken,
  tokenMatches,
  clearSetupToken,
  isDirectLoopback,
  allowFirstRun,
  announceSetupToken,
  bootSetupToken,
  setupTokenPath,
} = await import("../servers/gateway/dashboard/setup-token.js");
const { isSameOriginRequest, configuredOwnOrigins, isLoopbackHost, FIRST_RUN_CROSS_ORIGIN_MESSAGE } =
  await import("../servers/gateway/dashboard/same-origin.js");

const db = createDbClient();
const LAN = "192.0.2.7";
const PW = "correct horse battery staple";
const TOKEN_FILE = setupTokenPath({ crowHome: HOME });

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
  app.get("/setup", setupPageHandler);
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try { db.close(); } catch {}
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

/** Back to a fresh instance: no password, a token file on disk. */
async function resetFirstRun() {
  await db.execute("DELETE FROM dashboard_settings WHERE key = 'password_hash'");
  clearSetupToken({ crowHome: HOME });
  return getSetupToken({ crowHome: HOME }).token;
}

// The login page keeps its password form under the gated message (the POST is
// where the gate bites), so "gated" is about the message, "served" about the
// form carrying the token through.
const hasPasswordForm = (html) => /name="password"/.test(html);
const GATED_TEXT = "The setup link is printed by the installer";
const isGated = (html) => html.includes(GATED_TEXT);
const isServedWithToken = (html) => hasPasswordForm(html) && !html.includes(GATED_TEXT) && /name="setup_token"/.test(html);
// The gate names the token FILE, not a host path: under Docker it is inside the
// container, so a host path in the message would point at nothing there.
const WHERE_TO_LOOK = "on this machine, or inside the Crow container";

test("the token file is 0600 and a second read returns the same token", () => {
  const first = getSetupToken({ crowHome: HOME });
  assert.equal(first.source, "file");
  assert.equal(first.path, TOKEN_FILE);
  assert.match(first.token, /^[A-Za-z0-9_-]{40,}$/, "32 random bytes, base64url");
  assert.equal(statSync(TOKEN_FILE).mode & 0o777, 0o600);
  const before = readFileSync(TOKEN_FILE, "utf8");
  const second = getSetupToken({ crowHome: HOME });
  assert.equal(second.token, first.token);
  assert.equal(readFileSync(TOKEN_FILE, "utf8"), before, "the file is left untouched");
});

test("CROW_SETUP_TOKEN wins and no file is written for that home", () => {
  const otherHome = mkdtempSync(join(dir, "env-home-"));
  process.env.CROW_SETUP_TOKEN = "hosted-token-from-the-environment";
  try {
    const t = getSetupToken({ crowHome: otherHome });
    assert.equal(t.token, "hosted-token-from-the-environment");
    assert.equal(t.source, "env");
    assert.equal(t.path, null);
    assert.equal(existsSync(setupTokenPath({ crowHome: otherHome })), false);
  } finally {
    delete process.env.CROW_SETUP_TOKEN;
  }
});

test("tokenMatches: constant-time compare that refuses everything but an equal non-empty string", () => {
  assert.equal(tokenMatches("abc123", "abc123"), true);
  assert.equal(tokenMatches(undefined, "abc123"), false);
  assert.equal(tokenMatches(123456, "123456"), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("", "abc123"), false);
  assert.equal(tokenMatches("abc123", undefined), false);
  assert.equal(tokenMatches("abc1234", "abc123"), false, "a different length is false, not a throw");
  assert.equal(tokenMatches("abc124", "abc123"), false);
});

test("the boot line names the file and never the token; nothing at all once a password exists", () => {
  const bootHome = mkdtempSync(join(dir, "boot-home-"));
  const lines = [];
  const line = announceSetupToken({ crowHome: bootHome, passwordSet: false, log: (l) => lines.push(l) });
  assert.equal(lines.length, 1, "exactly one line");
  const path = setupTokenPath({ crowHome: bootHome });
  assert.ok(line.includes(path), "the line carries the file path");
  assert.ok(line.includes("[setup]"));
  const { token } = getSetupToken({ crowHome: bootHome });
  assert.equal(line.includes(token), false, "the line never carries the token");
  assert.equal(announceSetupToken({ crowHome: bootHome, passwordSet: true, log: (l) => lines.push(l) }), null);
  assert.equal(lines.length, 1, "silent once a password exists");
});

test("isDirectLoopback: bare loopback only — a forwarding or tailscale header takes it away", () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(isDirectLoopback(req("127.0.0.1")), true);
  assert.equal(isDirectLoopback(req("127.0.0.1", { host: "localhost:3001" })), true);
  assert.equal(isDirectLoopback(req("::1")), true);
  assert.equal(isDirectLoopback(req("::ffff:127.0.0.1")), true);
  assert.equal(isDirectLoopback(req("192.0.2.7")), false);
  for (const h of ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "tailscale-user-login", "tailscale-funnel-request"]) {
    assert.equal(isDirectLoopback(req("127.0.0.1", { [h]: h === "forwarded" ? "for=100.64.20.5" : "x" })), false, h);
  }
});

test("GET /dashboard/login: a LAN peer without a token gets the gated message; with it, the form", async () => {
  const token = await resetFirstRun();
  const gated = await get("/dashboard/login");
  const html = await gated.text();
  assert.equal(gated.status, 200);
  assert.ok(isGated(html), "gated without the token");
  assert.ok(html.includes(WHERE_TO_LOOK), "the gated message says where to look (this machine, or the container)");
  assert.equal(html.includes(TOKEN_FILE), false, "and names no host path for the token file");
  assert.equal(/name="setup_token"/.test(html), false, "no token is echoed to a peer that did not present one");

  const wrong = await (await get("/dashboard/login?token=not-the-token")).text();
  assert.ok(isGated(wrong), "a wrong token stays gated");

  const ok = await get(`/dashboard/login?token=${encodeURIComponent(token)}`);
  const okHtml = await ok.text();
  assert.ok(isServedWithToken(okHtml), "the right token shows the password form, token carried into it");
});

test("/setup: a LAN peer without a token is blocked, with the token it is served", async () => {
  const token = await resetFirstRun();
  const blocked = await (await get("/setup")).text();
  assert.ok(/Use the link you were sent/.test(blocked), "blocked message");
  assert.equal(hasPasswordForm(blocked), false);
  assert.ok(blocked.includes(WHERE_TO_LOOK), "the blocked page says where to look");
  assert.equal(blocked.includes(TOKEN_FILE), false, "no host path");

  const served = await (await get(`/setup?token=${encodeURIComponent(token)}`)).text();
  assert.ok(hasPasswordForm(served), "served with the token");
});

test("POST /dashboard/login from the LAN: no token and a wrong token are both refused", async () => {
  await resetFirstRun();
  const missing = await post("/dashboard/login", { password: PW, confirm: PW });
  assert.equal(missing.status, 200);
  assert.ok(isGated(await missing.text()));
  assert.equal(await isPasswordSet(), false, "no password was set");

  const wrong = await post("/dashboard/login", { password: PW, confirm: PW, setup_token: "not-the-token" });
  assert.equal(wrong.status, 200);
  assert.ok(isGated(await wrong.text()));
  assert.equal(await isPasswordSet(), false, "still no password");
});

test("POST /dashboard/login from the LAN with the right token: password set, token file deleted, then the normal login", async () => {
  const token = await resetFirstRun();
  assert.ok(existsSync(TOKEN_FILE));
  const ok = await post("/dashboard/login", { password: PW, confirm: PW, setup_token: token });
  assert.equal(ok.status, 303, await ok.text().then((t) => t.slice(0, 200)));
  assert.equal(await isPasswordSet(), true, "the first password was set");
  assert.equal(existsSync(TOKEN_FILE), false, "the one-time token file is gone");

  // Now that a password exists the first-run gate does not apply: the LAN peer
  // gets the ordinary login page, and the ordinary password login is unchanged.
  const login = await (await get("/dashboard/login")).text();
  assert.equal(hasPasswordForm(login), true, "the plain login form");
  assert.equal(isGated(login), false, "no gated message");
  assert.equal(/name="setup_token"/.test(login), false, "no setup token on the ordinary login page");
  const signedIn = await post("/dashboard/login", { password: PW });
  assert.equal(signedIn.status, 303, "a normal login still works");
});

test("POST /dashboard/login: a Serve-shaped loopback request needs the token, a bare loopback one does not", async () => {
  await resetFirstRun();

  // The Serve shape: loopback socket WITH forwarding headers (what tailscaled
  // writes), so it is not the machine's own user.
  const serve = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null, headers: { "x-forwarded-for": "100.64.20.5", "x-forwarded-host": "crow.example.ts.net" } });
  assert.equal(serve.status, 200);
  assert.ok(isGated(await serve.text()), "refused without a token");
  assert.equal(await isPasswordSet(), false);

  const forwarded = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null, headers: { forwarded: "for=100.64.20.5" } });
  assert.equal(forwarded.status, 200);
  assert.ok(isGated(await forwarded.text()), "refused without a token");
  assert.equal(await isPasswordSet(), false);

  // The owner on the machine itself (or through an SSH tunnel): no token needed.
  const local = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null });
  assert.equal(local.status, 303, await local.text().then((t) => t.slice(0, 200)));
  assert.equal(await isPasswordSet(), true, "loopback may set the first password");
  assert.equal(existsSync(TOKEN_FILE), false, "and the token file is cleared");
});

// --- B1: a first-run validation error must not throw the token away ----------
test("B1: a first-run POST that fails validation re-renders WITH the token, and the retry succeeds", async () => {
  const token = await resetFirstRun();

  // Passwords don't match: the page comes back carrying the validated token, so
  // a non-loopback peer can simply correct the form.
  const mismatch = await post("/dashboard/login", { password: PW, confirm: `${PW}!`, setup_token: token });
  assert.equal(mismatch.status, 200);
  const mismatchHtml = await mismatch.text();
  assert.equal(isGated(mismatchHtml), false, "the token was accepted");
  const echoed = /name="setup_token" value="([^"]+)"/.exec(mismatchHtml)?.[1];
  assert.equal(echoed, token, "the token is carried back into the form");
  assert.equal(await isPasswordSet(), false, "nothing was set yet");

  // Too short a password is the other first-run error render: same carry-over.
  const weak = await post("/dashboard/login", { password: "short", confirm: "short", setup_token: token });
  assert.equal(weak.status, 200);
  assert.equal(/name="setup_token" value="([^"]+)"/.exec(await weak.text())?.[1], token, "the short-password retry keeps the token");
  assert.equal(await isPasswordSet(), false);

  // The retry with the token the page handed back sets the password.
  const ok = await post("/dashboard/login", { password: PW, confirm: PW, setup_token: echoed });
  assert.equal(ok.status, 303, (await ok.text()).slice(0, 200));
  assert.equal(await isPasswordSet(), true);
  assert.equal(existsSync(TOKEN_FILE), false, "the one-time file is gone");
});

// --- MINOR 1: the env token has no loopback exemption -------------------------
test("MINOR 1: with CROW_SETUP_TOKEN set, a bare loopback POST still needs the token", async () => {
  process.env.CROW_SETUP_TOKEN = "env-token-with-no-exemption";
  try {
    await resetFirstRun(); // no password, no file — the env token is the only token

    const local = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null });
    assert.equal(local.status, 200, "not signed in");
    assert.ok(isGated(await local.text()), "the machine itself is refused too");
    assert.equal(await isPasswordSet(), false);

    const wrong = await post("/dashboard/login", { password: PW, confirm: PW, setup_token: "not-the-env-token" }, { peer: null });
    assert.ok(isGated(await wrong.text()), "a wrong token stays refused");
    assert.equal(await isPasswordSet(), false);

    const ok = await post("/dashboard/login", { password: PW, confirm: PW, setup_token: "env-token-with-no-exemption" }, { peer: null });
    assert.equal(ok.status, 303, (await ok.text()).slice(0, 200));
    assert.equal(await isPasswordSet(), true);
  } finally {
    delete process.env.CROW_SETUP_TOKEN;
  }
});

// --- MINOR 4: no token is minted for an instance that already has a password --
test("MINOR 4: getSetupToken does not recreate the file once a password exists", async () => {
  await resetFirstRun();
  assert.ok(existsSync(TOKEN_FILE), "a token file to remove");
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('password_hash', 'not-a-real-hash', datetime('now'))");
  clearSetupToken({ crowHome: HOME });
  try {
    assert.equal(await isPasswordSet(), true);
    const t = getSetupToken({ crowHome: HOME, hasPassword: await isPasswordSet() });
    assert.equal(t.token, "", "no token is handed out");
    assert.equal(existsSync(TOKEN_FILE), false, "and no file is written back");
  } finally {
    await db.execute("DELETE FROM dashboard_settings WHERE key = 'password_hash'");
  }
});

// --- MINOR 5: the boot seam, and a declared loopback proxy -------------------
test("MINOR 5: the gateway's boot seam creates the token file and logs its path, never the token", async () => {
  const bootHome = mkdtempSync(join(dir, "boot-seam-home-"));
  const lines = [];
  const line = await bootSetupToken({ crowHome: bootHome, isPasswordSet: () => false, log: (l) => lines.push(l) });
  const file = setupTokenPath({ crowHome: bootHome });
  assert.equal(lines.length, 1, "exactly one line");
  assert.ok(line.includes(file), "the line carries the file path");
  assert.equal(existsSync(file), true, "the boot hook created the file");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const { token } = getSetupToken({ crowHome: bootHome });
  assert.equal(line.includes(token), false, "the line never carries the token");

  const quietHome = mkdtempSync(join(dir, "boot-seam-quiet-"));
  const quiet = [];
  assert.equal(await bootSetupToken({ crowHome: quietHome, isPasswordSet: async () => true, log: (l) => quiet.push(l) }), null);
  assert.equal(quiet.length, 0, "silent once a password exists");
  assert.equal(existsSync(setupTokenPath({ crowHome: quietHome })), false, "and no file is created");
});

test("MINOR 5b: a loopback socket listed in CROW_TRUSTED_PROXIES is NOT exempt, headers or not", async () => {
  const previous = process.env.CROW_TRUSTED_PROXIES;
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers, query: {} });
  process.env.CROW_TRUSTED_PROXIES = "loopback";
  try {
    assert.equal(isDirectLoopback(req("127.0.0.1")), false, "a same-box proxy is not the machine's own user");
    assert.equal(isDirectLoopback(req("::1")), false, "v6 loopback too");

    await resetFirstRun();
    const gate = allowFirstRun(req("127.0.0.1"), { crowHome: HOME, from: "query" });
    assert.equal(gate.allowed, false, "no exemption through a declared proxy");
    assert.equal(gate.token, null);
  } finally {
    if (previous === undefined) delete process.env.CROW_TRUSTED_PROXIES;
    else process.env.CROW_TRUSTED_PROXIES = previous;
  }
});

// --- MINOR 3: two processes racing to mint the token agree --------------------
test("MINOR 3: two concurrent getSetupToken calls return the same value (first writer wins)", async () => {
  const raceHome = mkdtempSync(join(dir, "race-home-"));
  const mod = pathToFileURL(join(REPO, "servers/gateway/dashboard/setup-token.js")).href;
  const script = `import(${JSON.stringify(mod)}).then((m) => process.stdout.write(m.getSetupToken({ crowHome: process.env.RACE_HOME }).token));`;
  const run = () => execFileP(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, CROW_SETUP_TOKEN: "", RACE_HOME: raceHome },
    encoding: "utf8",
  });
  const [a, b] = await Promise.all([run(), run()]);
  const onDisk = readFileSync(join(raceHome, "setup-token"), "utf8").trim();
  assert.match(onDisk, /^[A-Za-z0-9_-]{40,}$/, "one token on disk");
  assert.equal(a.stdout.trim(), onDisk, "the first caller reports what is on disk");
  assert.equal(b.stdout.trim(), onDisk, "so does the racing caller");
});

// ---------------------------------------------------------------------------
// N1a-2: a web page must not be able to set the owner's first password.
//
// POST /dashboard/login is handled BEFORE csrfMiddleware (a first-run request
// carries no crow_session cookie, and csrf.js deliberately skips those) and
// allowFirstRun() exempts bare loopback, so on the code before same-origin.js
// every browser-shaped POST below answered 303 with the password set. Any page
// open in the owner's browser could auto-submit a form to
// http://localhost:3001/dashboard/login during first run and own the instance.
// A browser writes Origin / Sec-Fetch-Site itself and page script can neither
// read nor forge them, so those two headers now decide; a request with neither
// (curl on the box, the installer) keeps working through the setup-token gate.
// ---------------------------------------------------------------------------

const FOREIGN_ORIGIN = "https://evil.example";
/** The refusal is a plain sentence, not a page. */
const isRefusal = (r, body) => r.status === 403 && /^text\/plain/.test(r.headers.get("content-type") || "") && body === FIRST_RUN_CROSS_ORIGIN_MESSAGE;

// Current code: 303 and isPasswordSet() === true — this is the hole itself.
test("N1a-2: a cross-site Origin cannot set the first password (403, nothing set)", async () => {
  await resetFirstRun();
  const foreign = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null, headers: { origin: FOREIGN_ORIGIN } });
  assert.ok(isRefusal(foreign, await foreign.text()), `expected the plain 403, got ${foreign.status}`);
  assert.equal(await isPasswordSet(), false, "no password was set");

  // An opaque Origin (a sandboxed frame, a file: page) and another port on this
  // host are not this gateway either.
  const opaque = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null, headers: { origin: "null" } });
  assert.equal(opaque.status, 403, "an opaque origin is not same-origin");
  const otherPort = await post("/dashboard/login", { password: PW, confirm: PW }, {
    peer: null,
    headers: { origin: `http://127.0.0.1:${Number(server.address().port) + 1}` },
  });
  assert.equal(otherPort.status, 403, "another port is another origin");
  assert.equal(await isPasswordSet(), false, "still no password");
});

// Current code: 303 and isPasswordSet() === true for both values.
test("N1a-2: Sec-Fetch-Site cross-site — and same-site from another port — is refused", async () => {
  await resetFirstRun();
  for (const site of ["cross-site", "same-site"]) {
    const r = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null, headers: { "sec-fetch-site": site } });
    assert.ok(isRefusal(r, await r.text()), `${site}: expected the plain 403, got ${r.status}`);
    assert.equal(await isPasswordSet(), false, `no password after ${site}`);
  }
  // A page cannot talk its way out by also naming this origin: cross-site wins.
  const both = await post("/dashboard/login", { password: PW, confirm: PW }, {
    peer: null,
    headers: { "sec-fetch-site": "cross-site", origin: base },
  });
  assert.equal(both.status, 403, "Sec-Fetch-Site alone decides");
  assert.equal(await isPasswordSet(), false);
});

// Current code: 303 and isPasswordSet() === true in every case, so these pass
// already — they are here to pin that the fix refuses only foreign pages.
test("N1a-2: the setup page's own Origin, a typed URL (Sec-Fetch-Site: none) and no headers at all still set it", async () => {
  await resetFirstRun();
  const own = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null, headers: { origin: base, "sec-fetch-site": "same-origin" } });
  assert.equal(own.status, 303, (await own.text()).slice(0, 200));
  assert.equal(await isPasswordSet(), true, "the setup page's own form still works");
  assert.equal(existsSync(TOKEN_FILE), false, "and the one-time token is still cleared");

  await resetFirstRun();
  const bare = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null });
  assert.equal(bare.status, 303, "curl / the installer on the box carries neither header");
  assert.equal(await isPasswordSet(), true);

  await resetFirstRun();
  const typed = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null, headers: { "sec-fetch-site": "none" } });
  assert.equal(typed.status, 303, "Sec-Fetch-Site: none is a typed URL or a bookmark");
  assert.equal(await isPasswordSet(), true);
});

// Current code: the foreign-Origin request is a 303 with the password set (the
// setup token does not help — the page posting it is the attacker's page).
test("N1a-2: the setup-token path gets the same Origin rule (foreign refused, own Origin still sets it)", async () => {
  const token = await resetFirstRun();
  const foreign = await post("/dashboard/login", { password: PW, confirm: PW, setup_token: token }, { headers: { origin: FOREIGN_ORIGIN } });
  assert.ok(isRefusal(foreign, await foreign.text()), `expected the plain 403, got ${foreign.status}`);
  assert.equal(await isPasswordSet(), false, "a token-bearing page from another site is refused");
  assert.ok(existsSync(TOKEN_FILE), "and the one-time token was not spent");

  const own = await post("/dashboard/login", { password: PW, confirm: PW, setup_token: token }, { headers: { origin: base, "sec-fetch-site": "same-origin" } });
  assert.equal(own.status, 303, (await own.text()).slice(0, 200));
  assert.equal(await isPasswordSet(), true, "the setup link opened on this machine still works");
  assert.equal(existsSync(TOKEN_FILE), false, "the token is cleared");
});

// Current code: unchanged (no first-run gate once a password exists) — pinned so
// the fix cannot spread into the ordinary login.
test("N1a-2: after first run nothing changes — a cross-site Origin is still an ordinary login", async () => {
  await resetFirstRun();
  const set = await post("/dashboard/login", { password: PW, confirm: PW }, { peer: null });
  assert.equal(set.status, 303, "first-run setup from the box");
  assert.equal(await isPasswordSet(), true);

  const signedIn = await post("/dashboard/login", { password: PW }, { peer: null, headers: { origin: FOREIGN_ORIGIN, "sec-fetch-site": "cross-site" } });
  assert.equal(signedIn.status, 303, `a normal login is not gated (got ${signedIn.status})`);
  const wrong = await post("/dashboard/login", { password: "not-the-password" }, { peer: null, headers: { origin: FOREIGN_ORIGIN } });
  assert.equal(wrong.status, 200, "the ordinary login error page");
  assert.equal((await wrong.text()).includes(FIRST_RUN_CROSS_ORIGIN_MESSAGE), false, "not the first-run refusal");
});

// The rule itself, without a database: which origins count as this gateway's.
test("N1a-2: the origin rule — Host, a proxy's X-Forwarded-Host, a configured public URL, and what is refused", () => {
  const req = (headers, protocol = "http") => ({ headers, protocol });
  const HOST = { host: "127.0.0.1:3001" };
  const none = { env: {} };

  assert.equal(isSameOriginRequest(req(HOST), none), true, "neither header: a script on the box");
  assert.equal(isSameOriginRequest(req({ ...HOST, origin: "http://127.0.0.1:3001" }), none), true, "the Host the request reached");
  assert.equal(isSameOriginRequest(req({ ...HOST, origin: "http://127.0.0.1:3002" }), none), false, "another port is another origin");
  assert.equal(isSameOriginRequest(req({ ...HOST, origin: "https://127.0.0.1:3001" }), none), false, "and another scheme is another origin");
  assert.equal(isSameOriginRequest(req({ ...HOST, origin: "https://evil.example" }), none), false);
  assert.equal(isSameOriginRequest(req({ ...HOST, origin: "null" }), none), false, "an opaque origin");
  assert.equal(isSameOriginRequest(req({ ...HOST, origin: "file://127.0.0.1:3001" }), none), false, "a non-web scheme");
  assert.equal(isSameOriginRequest(req({ ...HOST, "sec-fetch-site": "same-origin" }), none), true);
  assert.equal(isSameOriginRequest(req({ ...HOST, "sec-fetch-site": "none" }), none), true, "a typed URL");
  assert.equal(isSameOriginRequest(req({ ...HOST, "sec-fetch-site": "cross-site", origin: "http://127.0.0.1:3001" }), none), false, "cross-site beats a matching Origin");

  // Behind Serve or the installer's Caddy: the page's origin is the forwarded
  // host, and the scheme is the proxy's (which need not forward a proto).
  const proxied = { host: "127.0.0.1:3001", "x-forwarded-host": "crow.example.ts.net:8444" };
  assert.equal(isSameOriginRequest(req({ ...proxied, origin: "https://crow.example.ts.net:8444" }), none), true);
  assert.equal(isSameOriginRequest(req({ ...proxied, origin: "http://crow.example.ts.net:8444" }), none), true);
  assert.equal(isSameOriginRequest(req({ ...proxied, origin: "https://crow.example.ts.net:8445" }), none), false, "another port behind the proxy too");
  assert.equal(isSameOriginRequest(req({ ...proxied, origin: "https://evil.example" }), none), false);

  // A configured public origin is the gateway's own (hosted installs sign in there).
  const env = { CROW_GATEWAY_URL: "https://crow.example.ts.net" };
  assert.deepEqual([...configuredOwnOrigins(env)], ["https://crow.example.ts.net"]);
  assert.deepEqual([...configuredOwnOrigins({})], [], "nothing configured, nothing allowed");
  assert.equal(isSameOriginRequest(req({ ...HOST, origin: "https://crow.example.ts.net" }), { env }), true);
  assert.equal(isSameOriginRequest(req({ ...HOST, origin: "https://evil.example" }), { env }), false);
  // CROW_OAUTH_ISSUER_URL wins over it, exactly as issuer-url.js resolves it.
  const issuer = { CROW_GATEWAY_URL: "https://public.example", CROW_OAUTH_ISSUER_URL: "https://crow.example.ts.net:8444" };
  assert.deepEqual([...configuredOwnOrigins(issuer)], ["https://crow.example.ts.net:8444"]);
});

// ---------------------------------------------------------------------------
// Fix round 1 — DNS rebinding. The gateway's "own origin" is READ from the
// request (Host), so a page that re-points its own domain at 127.0.0.1 sends
// Host and Origin that agree, from a loopback socket with no forwarding header:
// Sec-Fetch-Site and Origin both pass, and the bare-loopback exemption needed no
// token. The exemption now also demands that the Host name this machine —
// localhost / *.localhost / 127.0.0.0/8 / [::1], or a configured own origin.
// ---------------------------------------------------------------------------

/**
 * One HTTP request whose Host header is NOT the URL's host — `fetch` always
 * sends the URL's, and rebinding is exactly a Host the URL does not name. The
 * socket is the loopback test connection (the `peer: null` shape), and no
 * forwarding header is set, so the request is "direct loopback" as far as
 * setup-token.js can tell.
 *
 * `agent: false` + `connection: close`: the default global agent keeps the
 * socket alive, and a lingering handle stops this test file's process from
 * exiting (node --test then never prints its summary).
 */
function rawRequest(path, { method = "GET", host, headers = {}, body } = {}) {
  const payload = body == null ? null : String(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: server.address().port,
      path,
      method,
      agent: false,
      setHost: false, // the Host below is the test subject, not the URL's
      headers: {
        connection: "close",
        host,
        ...(payload ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
        text: async () => text,
      }));
    });
    req.on("error", reject);
    // A response that never comes must fail the test, not keep the process (and
    // therefore node --test's summary) alive.
    req.setTimeout(5_000, () => req.destroy(new Error(`no response to ${method} ${path} within 5s`)));
    if (payload) req.write(payload);
    req.end();
  });
}

const REBIND_HOST = "evil.example:3001";

// Fails on the current code: the route answered 303 with the first password set
// (Host and Origin agreed, Sec-Fetch-Site was same-origin, and allowFirstRun()
// exempted any bare loopback socket).
test("Fix round 1: a rebinding Host (Host = Origin = its own domain, loopback socket) cannot set the first password", { timeout: 20_000 }, async () => {
  await resetFirstRun();
  const r = await rawRequest("/dashboard/login", {
    method: "POST",
    host: REBIND_HOST,
    headers: { origin: `http://${REBIND_HOST}`, "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ password: PW, confirm: PW }).toString(),
  });
  assert.ok(isRefusal(r, await r.text()), `expected the plain 403, got ${r.status}`);
  assert.equal(await isPasswordSet(), false, "no password was stored");
  assert.ok(existsSync(TOKEN_FILE), "and the one-time token was not spent");
});

// Passes on the current code too (the token path is unchanged): pinned so the
// Host rule cannot swallow the setup link.
test("Fix round 1: the same rebinding Host with the setup token still sets the first password", { timeout: 20_000 }, async () => {
  const token = await resetFirstRun();
  const r = await rawRequest("/dashboard/login", {
    method: "POST",
    host: REBIND_HOST,
    headers: { origin: `http://${REBIND_HOST}`, "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ password: PW, confirm: PW, setup_token: token }).toString(),
  });
  assert.equal(r.status, 303, (await r.text()).slice(0, 200));
  assert.equal(await isPasswordSet(), true, "the token path is not the loopback exemption");
  assert.equal(existsSync(TOKEN_FILE), false, "the one-time token is cleared");
});

// Passes on the current code (today's behaviour): pinned so the Host rule is not
// so tight that the owner on the box is locked out of his own first run.
test("Fix round 1: every loopback spelling still sets the first password (localhost, 127.0.0.1, [::1], crow.localhost)", { timeout: 20_000 }, async () => {
  const port = server.address().port;
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `crow.localhost:${port}`]) {
    await resetFirstRun();
    const r = await rawRequest("/dashboard/login", {
      method: "POST",
      host,
      headers: { origin: `http://${host}`, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ password: PW, confirm: PW }).toString(),
    });
    assert.equal(r.status, 303, `${host}: ${(await r.text()).slice(0, 200)}`);
    assert.equal(await isPasswordSet(), true, `${host} may set the first password`);
  }
});

// Passes on the current code (today's behaviour): pinned so a hosted install
// that reaches its own public name on a loopback socket is not locked out.
test("Fix round 1: a Host that is the configured public origin's host still sets the first password", { timeout: 20_000 }, async () => {
  const previous = process.env.CROW_GATEWAY_URL;
  process.env.CROW_GATEWAY_URL = "https://crow.example.ts.net";
  try {
    await resetFirstRun();
    const r = await rawRequest("/dashboard/login", {
      method: "POST",
      host: "crow.example.ts.net:3001",
      headers: { origin: "http://crow.example.ts.net:3001", "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ password: PW, confirm: PW }).toString(),
    });
    assert.equal(r.status, 303, (await r.text()).slice(0, 200));
    assert.equal(await isPasswordSet(), true, "the configured origin is the gateway's own");
  } finally {
    if (previous === undefined) delete process.env.CROW_GATEWAY_URL;
    else process.env.CROW_GATEWAY_URL = previous;
  }
});

// Fails on the current code: both pages served the password form to any bare
// loopback socket, whatever Host it carried (the login page even handed the
// setup token back in the form).
test("Fix round 1: GET /dashboard/login and /setup withhold the bare-loopback exemption from a rebinding Host (the token still opens both)", { timeout: 20_000 }, async () => {
  const token = await resetFirstRun();

  const login = await rawRequest("/dashboard/login", { host: REBIND_HOST, headers: { origin: `http://${REBIND_HOST}` } });
  const loginHtml = await login.text();
  assert.equal(login.status, 200);
  assert.ok(isGated(loginHtml), "gated, exactly as a LAN visitor's page is");
  assert.equal(/name="setup_token"/.test(loginHtml), false, "and no setup token is handed to it");

  const setup = await rawRequest("/setup", { host: REBIND_HOST });
  const setupHtml = await setup.text();
  assert.ok(/Use the link you were sent/.test(setupHtml), "/setup: the blocked message");
  assert.equal(hasPasswordForm(setupHtml), false, "/setup: no password form");

  // The rule is about the exemption, not about the pages: the setup link works.
  const loginWithToken = await rawRequest(`/dashboard/login?token=${encodeURIComponent(token)}`, { host: REBIND_HOST });
  assert.ok(isServedWithToken(await loginWithToken.text()), "the login page with the token");
  const setupWithToken = await rawRequest(`/setup?token=${encodeURIComponent(token)}`, { host: REBIND_HOST });
  assert.ok(hasPasswordForm(await setupWithToken.text()), "/setup with the token");
});

// Cannot fail on the current code — isLoopbackHost() does not exist there. It
// pins the rule every other test in this section leans on.
test("Fix round 1: isLoopbackHost — loopback names, loopback literals, a configured own origin, and nothing else", () => {
  const req = (host) => (host === undefined ? { headers: {} } : { headers: { host } });
  const none = { env: {} };

  for (const host of [
    "localhost:3001", "localhost", "LOCALHOST:3001", "crow.localhost:3001", "a.b.localhost:3001",
    "127.0.0.1:3001", "127.5.6.7:3001", "127.0.0.1",
    "[::1]:3001", "[::1]",
  ]) {
    assert.equal(isLoopbackHost(req(host), none), true, host);
  }
  for (const host of [
    "evil.example:3001", "localhost.evil.example", "crow.localhost.evil.example",
    "127.999.1.1:3001", // not an IPv4 literal: the resolver answers this name
    "127.evil.example", "[::2]:3001", "0.0.0.0:3001", "192.0.2.7:3001", "", "not a host", "[::1",
  ]) {
    assert.equal(isLoopbackHost(req(host), none), false, host);
  }
  assert.equal(isLoopbackHost(req(undefined), none), false, "no Host header at all");
  assert.equal(isLoopbackHost({}, none), false, "no headers at all");

  // A configured own origin counts by HOSTNAME: the configured public URL may
  // name no port (or another one) and another scheme than the local hop.
  const env = { CROW_GATEWAY_URL: "https://crow.example.ts.net" };
  assert.equal(isLoopbackHost(req("crow.example.ts.net:3001"), { env }), true);
  assert.equal(isLoopbackHost(req("crow.example.ts.net"), { env }), true);
  assert.equal(isLoopbackHost(req("crow.example.ts.net:3001"), none), false, "unconfigured: just a stranger's name");
  assert.equal(isLoopbackHost(req("evil.example:3001"), { env }), false);
});