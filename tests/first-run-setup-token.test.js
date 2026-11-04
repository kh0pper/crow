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