/**
 * The AI Companion is retired: NOTHING answers under /companion any more.
 *
 * Before this, the gateway mounted `setupCompanionProxy` on every boot — `/companion/*`
 * was reverse-proxied to 127.0.0.1:12393, `/companion/device-config` served a device's
 * bound bot, and `/companion/client-ws` (plus a bare `/client-ws`) was proxied as a
 * WebSocket with only a room-token check. That surface had to go for every install, not
 * just the one it was retired on:
 *
 *   - no source under servers/ registers a path starting with /companion, and the proxy
 *     module itself is gone (so a stale import cannot resurrect it);
 *   - the live gateway answers 404 to GET and POST on /companion/, /companion/anything and
 *     /companion/device-config — with no cookie AND with a session-looking cookie, so a
 *     session can never unlock it;
 *   - a WebSocket upgrade to /companion/client-ws is ANSWERED: HTTP 404 and the socket
 *     closes. The parent tree proxied it (a 101 when the app was up, a 502 when it was
 *     not), and the tree this change started from left the socket hanging with no answer
 *     at all; both fail this file;
 *   - one 404 check runs on a NORMAL-auth gateway (not --no-auth) with a real dashboard
 *     session, because that is how an installed Crow is reached: the route table answers,
 *     not the anonymous path.
 *
 * The live half boots a real gateway (the pattern tests/kiosk-live-regression.test.js
 * and the old wm-auth test used) under a
 * scratch CROW_HOME/CROW_DATA_DIR, so it can never touch the operator's install.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer, connect } from "node:net";
import http from "node:http";
const ROOT = join(import.meta.dirname, "..");
const SERVERS = join(ROOT, "servers");

// ---------------------------------------------------------------------------
// 1. the source: no /companion route, and the proxy module is gone
// ---------------------------------------------------------------------------

function walkJs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "vendor") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walkJs(p, out); continue; }
    if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("the companion proxy module and the bundle are gone from the repo", () => {
  assert.equal(existsSync(join(SERVERS, "gateway/routes/companion-proxy.js")), false, "the /companion reverse proxy is deleted");
  assert.equal(existsSync(join(ROOT, "bundles/companion")), false, "the AI Companion bundle is deleted");
  assert.equal(existsSync(join(ROOT, "docs/architecture/companion.md")), false, "its architecture page is deleted");
});

test("no route, mount or proxy setup under servers/ names /companion", () => {
  // `app.use("/companion"`, `app.get("/companion/device-config"`, `router.post("/companion/…`
  const routeRe = /\.(?:use|get|post|put|patch|delete|all)\(\s*["'`]\/companion/i;
  const setupRe = /\bsetupCompanionProxy\b/;
  const offenders = [];
  for (const file of walkJs(SERVERS)) {
    const src = readFileSync(file, "utf8");
    if (routeRe.test(src)) offenders.push(`${file}: registers a /companion route`);
    if (setupRe.test(src)) offenders.push(`${file}: still wires setupCompanionProxy`);
  }
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// 1b. the two WebSocket handles that are LEFT must still reach the listen callback
//     (S1: a missed handle silently never wires WS upgrades and no gate catches it)
// ---------------------------------------------------------------------------

test("the late mounts still hand calls + extension WS setups to runPostListenSetup", () => {
  const index = readFileSync(join(SERVERS, "gateway/index.js"), "utf8");
  const late = readFileSync(join(SERVERS, "gateway/boot/late-mounts.js"), "utf8");
  const post = readFileSync(join(SERVERS, "gateway/boot/post-listen.js"), "utf8");
  assert.match(late, /return \{ setupCallsSignaling, extensionProxyWsSetup \}/, "late-mounts returns both handles");
  assert.match(index, /setupCallsSignaling: _setupCallsSignaling/);
  assert.match(index, /extensionProxyWsSetup: _extensionProxyWsSetup/);
  assert.match(post, /const \{ setupCallsSignaling, extensionProxyWsSetup, PORT, BIND, noAuth \} = deps;/, "post-listen reads both");
  assert.match(post, /if \(setupCallsSignaling\)/);
  assert.match(post, /if \(extensionProxyWsSetup\)/);
});

// ---------------------------------------------------------------------------
// 2. the live gateway: 404, never proxied, with and without a session cookie
// ---------------------------------------------------------------------------

let child = null;
let port = 0;
let scratch = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function healthOnce(p) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${p}/health`, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", () => resolve(0));
    req.setTimeout(1500, () => { req.destroy(); resolve(0); });
  });
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "crow-no-companion-"));
  const dataDir = join(scratch, "data");
  mkdirSync(dataDir, { recursive: true });
  const env = {
    ...process.env,
    HOME: scratch,
    CROW_HOME: join(scratch, "home"),
    CROW_DATA_DIR: dataDir,
    CROW_DB_PATH: join(dataDir, "crow.db"),
    CROW_AUTO_UPDATE: "0",
    CROW_DISABLE_HEALTH_MONITOR: "1",
    CROW_DISABLE_INSTANCE_SYNC: "1",
    CROW_DISABLE_NOSTR: "1",
    CROW_DISABLE_NTFY_AUTOWIRE: "1",
  };
  mkdirSync(env.CROW_HOME, { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], { env, cwd: ROOT, stdio: "pipe" });
  port = await freePort();
  child = spawn(process.execPath, ["servers/gateway/index.js", "--no-auth"], {
    env: { ...env, PORT: String(port), CROW_GATEWAY_URL: `http://127.0.0.1:${port}` },
    cwd: ROOT,
    stdio: "pipe",
  });
  child.stdout.resume();
  child.stderr.resume();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the gateway exited (${child.exitCode}) before it was healthy`);
    if ((await healthOnce(port)) === 200) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the gateway never became healthy");
});

after(() => {
  if (child && child.exitCode === null) { try { child.kill("SIGKILL"); } catch { /* best effort */ } }
  if (scratch) rmScratch(scratch);
});

/** A request to the live gateway; returns { status, headers }. */
function requestOn(port, method, path, headers = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(new Error("request timed out")); });
    if (body !== undefined) req.end(body);
    else if (method === "POST") req.end(JSON.stringify({}));
    else req.end();
  });
}

function request(method, path, headers = {}) {
  return requestOn(port, method, path, headers);
}

const PATHS = ["/companion/", "/companion/anything", "/companion/device-config?device=kiosk-1", "/client-ws"];
/** A dashboard session cookie — a made-up one: the point is that no cookie helps. */
const SESSION = { cookie: "crow_session=deadbeefdeadbeef; crow_csrf=tok" };

for (const path of PATHS) {
  test(`GET ${path} → 404, with and without a session cookie`, async () => {
    const plain = await request("GET", path);
    assert.equal(plain.status, 404, `GET ${path} answered ${plain.status}`);
    const withSession = await request("GET", path, SESSION);
    assert.equal(withSession.status, 404, `GET ${path} with a session answered ${withSession.status}`);
  });

  test(`POST ${path} → 404, with and without a session cookie`, async () => {
    const plain = await request("POST", path, { "content-type": "application/json" });
    assert.equal(plain.status, 404, `POST ${path} answered ${plain.status}`);
    const withSession = await request("POST", path, { "content-type": "application/json", ...SESSION });
    assert.equal(withSession.status, 404, `POST ${path} with a session answered ${withSession.status}`);
  });
}

test("a WebSocket upgrade to /companion/client-ws is REFUSED: HTTP 404, then the socket closes", async () => {
  // The parent tree proxied this upgrade (a 101 with the app up, a 502 without it), and
  // the tree this change started from left it hanging: no listener owned the path, and
  // node keeps an unclaimed upgrade socket open forever. Either of those fails here.
  const answer = await new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        "GET /companion/client-ws HTTP/1.1\r\n"
        + `Host: 127.0.0.1:${port}\r\n`
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        + "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let buf = "";
    let closed = false;
    let settled = false;
    const done = (why) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* best effort */ }
      resolve({ buf, closed, why });
    };
    socket.on("data", (d) => { buf += d.toString("latin1"); });
    // The refusal writes its status block and destroys the socket: wait for the close, so
    // "answered 404" and "closed" are both observed rather than assuming one.
    socket.on("close", () => { closed = true; done("closed"); });
    socket.on("error", () => done("error"));
    setTimeout(() => done("timeout"), 8000);
  });
  const statusLine = answer.buf.split("\r\n")[0] || "";
  assert.match(
    statusLine,
    /\s404\b/,
    `the upgrade must be answered with a definite 404 (got ${statusLine || "(no response)"} after ${answer.why}) — a proxied 101/502 or a hanging socket is a failure`,
  );
  assert.equal(answer.closed, true, `the refused socket was not closed (${answer.why})`);
  assert.doesNotMatch(statusLine, /\s101\b/, "the upgrade was accepted");
  assert.doesNotMatch(answer.buf, /Set-Cookie/i, "no handshake response headers leaked");
});

test("the gateway's own security headers now apply to /companion (the old XFO exemption is gone)", async () => {
  const r = await request("GET", "/companion/");
  assert.equal(r.status, 404);
  // `index.js` used to skip X-Frame-Options for any path starting with /companion (the
  // proxied app framed itself). That exemption was removed with the proxy, so an unknown
  // /companion path gets the ordinary SAMEORIGIN header like every other unknown path.
  assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
});

// ---------------------------------------------------------------------------
// 3. the same 404 on a NORMAL-auth gateway, signed in as the owner
// ---------------------------------------------------------------------------

test("a signed-in dashboard session still gets a 404 on /companion (normal auth, not --no-auth)", async () => {
  // Every other live check above runs the gateway with --no-auth, which skips the session
  // gate entirely. An installed Crow runs WITH auth, so the question there is whether a
  // real, live dashboard session can reach the retired surface through a normally-started
  // gateway: it must 404 — not proxy (the parent tree's 101/502), not redirect, not 200.
  const scratch2 = mkdtempSync(join(tmpdir(), "crow-no-companion-auth-"));
  const dataDir2 = join(scratch2, "data");
  mkdirSync(dataDir2, { recursive: true });
  const env = {
    ...process.env,
    HOME: scratch2,
    CROW_HOME: join(scratch2, "home"),
    CROW_DATA_DIR: dataDir2,
    CROW_DB_PATH: join(dataDir2, "crow.db"),
    CROW_AUTO_UPDATE: "0",
    CROW_DISABLE_HEALTH_MONITOR: "1",
    CROW_DISABLE_INSTANCE_SYNC: "1",
    CROW_DISABLE_NOSTR: "1",
    CROW_DISABLE_NTFY_AUTOWIRE: "1",
  };
  mkdirSync(env.CROW_HOME, { recursive: true });
  let child2 = null;
  try {
    execFileSync(process.execPath, ["scripts/init-db.js"], { env, cwd: ROOT, stdio: "pipe" });
    // A password in the scratch DB before the gateway boots: the login then needs no
    // first-run setup token (a separate process owns that token). Run in its own process
    // so the module graph is built against THIS scratch env, never this test's own.
    const PW = "correct horse battery staple";
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      "const { setPassword } = await import('./servers/gateway/dashboard/auth.js'); await setPassword(process.env.CROW_TEST_PW);",
    ], { env: { ...env, CROW_TEST_PW: PW }, cwd: ROOT, stdio: "pipe" });

    const port2 = await freePort();
    child2 = spawn(process.execPath, ["servers/gateway/index.js"], {
      env: { ...env, PORT: String(port2), CROW_GATEWAY_URL: `http://127.0.0.1:${port2}` },
      cwd: ROOT,
      stdio: "pipe",
    });
    child2.stdout.resume();
    child2.stderr.resume();
    const deadline = Date.now() + 90_000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child2.exitCode !== null) throw new Error(`the auth gateway exited (${child2.exitCode}) before it was healthy`);
      if ((await healthOnce(port2)) === 200) { healthy = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(healthy, "the normal-auth gateway became healthy");

    // Auth is genuinely ON: a private dashboard route from a bare loopback socket is refused
    // by the network rule (a --no-auth gateway serves it). Nothing here is the no-auth path.
    const gated = await requestOn(port2, "GET", "/dashboard/schedule");
    assert.equal(gated.status, 403, `a private route answers the network refusal (got ${gated.status})`);

    // A REAL login (loopback is the page's own first-run/console path)…
    const body = new URLSearchParams({ password: PW }).toString();
    const login = await requestOn(port2, "POST", "/dashboard/login", {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(body),
    }, body);
    assert.ok(login.status === 303 || login.status === 302, `the login succeeded (got ${login.status})`);
    const cookies = [].concat(login.headers["set-cookie"] || []);
    const session = cookies.map((c) => /^crow_session=([^;]+)/.exec(c)).find(Boolean);
    assert.ok(session, "the login set a dashboard session cookie");

    // …and that real session opens nothing at /companion.
    for (const path of ["/companion/", "/companion/device-config?device=kiosk-1", "/companion/client-ws"]) {
      const r = await requestOn(port2, "GET", path, { cookie: `crow_session=${session[1]}; crow_csrf=tok` });
      assert.equal(r.status, 404, `GET ${path} as the signed-in owner answered ${r.status} (a redirect or a proxied answer is a failure)`);
      assert.equal(r.headers.location, undefined, `${path} must not redirect the owner to the login page`);
    }
  } finally {
    if (child2 && child2.exitCode === null) { try { child2.kill("SIGKILL"); } catch { /* best effort */ } }
    rmScratch(scratch2);
  }
});