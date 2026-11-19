/**
 * Queue item #51 — the extension proxy must not hand Crow's own cookies to a
 * proxied backend, and must not let a backend set them back on the dashboard's
 * origin.
 *
 * `/proxy/<id>/` serves an installed bundle's UI on the dashboard's own origin.
 * The gateway authenticates the request first (authMiddleware; the owner check
 * for a token-carrying viewer; the same checks on the upgrade path), and from
 * there the backend is third-party code: forwarding `crow_session` would hand it
 * a live, replayable dashboard session, and letting it `Set-Cookie: crow_session`
 * would let it mint or overwrite one for every dashboard page.
 *
 * Everything here runs against the REAL proxy in front of a REAL stub upstream
 * (extension-proxy-auth-token.test.js idiom): the hooks are the only place the
 * strip can happen, and an options-level test would not prove the header that
 * actually leaves the gateway.
 *
 * extension-proxy.js resolves CROW_HOME at module load, so it is pointed at a
 * scratch dir BEFORE the import.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyMiddleware } from "http-proxy-middleware";

const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-proxy-cookies-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = CROW_HOME; // no real instance id / no real crow.db
process.env.CROW_DB_PATH = join(CROW_HOME, "crow.db");
after(() => { try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {} });

const {
  default: extensionProxyFactory,
  setCookieName,
  rewriteProxySetCookie,
} = await import("../servers/gateway/routes/extension-proxy.js");
const { proxyCookiePath } = await import("../servers/gateway/proxy-cookie-filter.js");
const { CROW_COOKIE_NAMES, isCrowCookieName, stripCrowCookieHeader } = await import("../servers/gateway/cookie-names.js");
const cookieNames = await import("../servers/gateway/cookie-names.js");
const { setSessionCookie } = await import("../servers/gateway/dashboard/auth.js");
const mode = await import("../servers/gateway/dashboard/shell/mode.js");

const BUNDLE = "demo";
const PROXY_PATH = `/proxy/${BUNDLE}`;

// ---------------------------------------------------------------------------
// fixtures — a real proxy, a real gateway socket, a real upstream
// ---------------------------------------------------------------------------

/** Write the manifest + installed.json the factory reads at construction. */
function installBundle(port) {
  const dir = join(CROW_HOME, "bundles", BUNDLE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: BUNDLE, name: BUNDLE, type: "bundle", webUI: { port } }));
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: BUNDLE, type: "bundle" }]));
}

/** Every socket a server accepts, so teardown can end upgraded ones too. */
function track(server) {
  const set = new Set();
  server.on("connection", (s) => { set.add(s); s.on("close", () => set.delete(s)); });
  return () => { for (const s of set) s.destroy(); };
}

/**
 * An upstream that records the Cookie header of every request and every
 * WebSocket upgrade, and (optionally) answers with `Set-Cookie`s.
 *
 * `ws` shapes the UPGRADE answer, per test:
 *   null                              → a plain 101, closed after 20 ms
 *   { headers: [...], echo: true }    → a 101 with those raw header lines, echoing data
 *   { status, reason, headers, body } → a NON-101 response (a refused upgrade)
 */
async function startUpstream({ setCookies = null, ws = null } = {}) {
  const httpSeen = [];
  const wsSeen = [];
  const server = http.createServer((req, res) => {
    httpSeen.push({ url: req.url, cookie: req.headers.cookie });
    const cookies = typeof setCookies === "function" ? setCookies(req) : setCookies;
    const headers = { "content-type": "text/plain" };
    if (cookies) headers["set-cookie"] = cookies;
    res.writeHead(200, headers);
    res.end("upstream ok");
  });
  server.on("upgrade", (req, socket) => {
    wsSeen.push({ url: req.url, cookie: req.headers.cookie });
    if (ws?.status && ws.status !== 101) {
      const body = ws.body || "";
      const lines = [
        `HTTP/1.1 ${ws.status} ${ws.reason || "Error"}`,
        "Content-Type: text/plain",
        `Content-Length: ${Buffer.byteLength(body)}`,
        ...(ws.headers || []),
      ];
      socket.write(lines.join("\r\n") + "\r\n\r\n" + body);
      setTimeout(() => socket.end(), 20);
      return;
    }
    const extra = (ws?.headers || []).join("\r\n");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      (extra ? extra + "\r\n" : "") + "\r\n");
    if (ws?.echo) {
      socket.on("data", (d) => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
      return; // stays open: the test drives both directions
    }
    setTimeout(() => socket.end(), 20);
  });
  const kill = track(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, httpSeen, wsSeen, kill, port: server.address().port };
}

/**
 * Mount the real router. `auth` stands in for `dashboardAuth` (a bare-loopback
 * caller is refused by the real network gate), so the proxy runs exactly as it
 * does after a successful sign-in. The explicit upgrade is driven the way
 * setupWebSocket drives it — AFTER its own checks have passed.
 */
async function startGateway() {
  const proxies = [];
  const auth = (req, res, next) => { req.dashboardSession = "test-session"; next(); };
  const { router } = extensionProxyFactory(auth, {
    createProxy: (opts) => { const mw = createProxyMiddleware(opts); proxies.push(mw); return mw; },
  });
  const app = express();
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  const kill = track(server);
  await new Promise((r) => server.once("listening", r));
  server.on("upgrade", (req, socket, head) => proxies[0].upgrade(req, socket, head));
  return { server, kill, port: server.address().port };
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/** A raw upgrade request; resolves with the first response line. */
function rawUpgrade(port, path, headers = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`);
    });
    let buf = "";
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf.split("\r\n")[0] || ""); } };
    s.on("data", (c) => { buf += c; if (buf.includes("\r\n")) { s.destroy(); finish(); } });
    s.on("close", finish);
    s.on("error", finish);
    s.setTimeout(3000, () => { s.destroy(); finish(); });
  });
}

/** The `set-cookie` header values of a Node response, always as an array. */
function setCookieValues(headers) {
  const v = headers["set-cookie"];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/**
 * An upgrade whose raw bytes stay readable: `waitFor(text)` resolves once that
 * text has arrived (or the socket closed, which also resolves), `text()` is
 * everything received so far. Used to read the handshake — header block and
 * whatever follows it — and to drive frames on the live socket.
 */
function wsConnect(port, path, headers = {}) {
  const socket = net.connect(port, "127.0.0.1", () => {
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`);
  });
  let buf = "";
  let closed = false;
  const waiters = [];
  const settle = () => {
    for (const w of [...waiters]) {
      if (!buf.includes(w.needle)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve();
    }
  };
  socket.on("data", (c) => { buf += c.toString("latin1"); settle(); });
  socket.on("close", () => { closed = true; for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve(); } });
  return {
    socket,
    text: () => buf,
    waitFor: (needle, ms = 3000) => new Promise((resolve, reject) => {
      if (buf.includes(needle) || closed) return resolve();
      const w = { needle, resolve };
      w.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(buf)}`));
      }, ms);
      waiters.push(w);
    }),
    close: () => socket.destroy(),
  };
}

// ---------------------------------------------------------------------------
// the request path — the app's cookies go through, Crow's do not
// ---------------------------------------------------------------------------

test("HTTP: the backend receives the app's cookies and none of Crow's (session, csrf, 2fa, lang, shell)", async () => {
  const up = await startUpstream();
  installBundle(up.port);
  const gw = await startGateway();
  try {
    const res = await get(gw.port, `${PROXY_PATH}/index.html`, {
      cookie: [
        "app_sid=abc123",
        "crow_session=live-dashboard-session",
        "crow_csrf=csrf-value",
        "crow_pending_2fa=pending",
        "crow_2fa_trusted=trusted",
        "crow_lang=es",
        "crow_mode_local=classic",
        "crow_scope_1a2b3c4d=work",
        "crow_try_new_1a2b3c4d=pending",
        "theme=dark",
      ].join("; "),
    });
    assert.equal(res.status, 200);
    assert.equal(up.httpSeen.length, 1);
    assert.equal(up.httpSeen[0].cookie, "app_sid=abc123; theme=dark",
      "only the app's own cookies survive; Crow's session and CSRF values must never reach a proxied backend");
    for (const name of ["crow_session", "crow_csrf", "crow_pending_2fa", "crow_2fa_trusted", "crow_lang", "crow_mode", "crow_scope", "crow_try_new"]) {
      assert.ok(!(up.httpSeen[0].cookie || "").includes(name), `${name} leaked to the backend`);
    }
  } finally {
    gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

test("HTTP: a request carrying only Crow's cookies arrives with no Cookie header at all", async () => {
  const up = await startUpstream();
  installBundle(up.port);
  const gw = await startGateway();
  try {
    await get(gw.port, PROXY_PATH, { cookie: "crow_session=only; crow_csrf=only" });
    assert.equal(up.httpSeen.length, 1);
    assert.equal(up.httpSeen[0].cookie, undefined, "nothing left → the header is dropped, not sent empty");
  } finally {
    gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

test("a request with no Cookie header is forwarded untouched", async () => {
  const up = await startUpstream();
  installBundle(up.port);
  const gw = await startGateway();
  try {
    await get(gw.port, PROXY_PATH);
    assert.equal(up.httpSeen[0].cookie, undefined);
  } finally {
    gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

test("WebSocket upgrade: the backend receives the app's cookies and none of Crow's", async () => {
  const up = await startUpstream();
  installBundle(up.port);
  const gw = await startGateway();
  try {
    const line = await rawUpgrade(gw.port, `${PROXY_PATH}/websockify`, {
      cookie: "app_sid=abc123; crow_session=live-dashboard-session; crow_csrf=csrf-value; theme=dark",
    });
    assert.match(line, /101/);
    assert.equal(up.wsSeen.length, 1);
    assert.equal(up.wsSeen[0].cookie, "app_sid=abc123; theme=dark",
      "the upgrade request reaches the backend with the browser's Cookie header — it must be stripped too");
  } finally {
    gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

// ---------------------------------------------------------------------------
// the response path — a backend must not set Crow's cookie names
// ---------------------------------------------------------------------------

test("a backend Set-Cookie for crow_session / crow_csrf is dropped; the app's own cookie is kept and scoped", async () => {
  const up = await startUpstream({ setCookies: ["crow_session=forged; Path=/", "crow_csrf=forged; Path=/", "app_sid=abc; Path=/"] });
  installBundle(up.port);
  const gw = await startGateway();
  try {
    const res = await get(gw.port, `${PROXY_PATH}/`);
    const cookies = setCookieValues(res.headers);
    assert.deepEqual(cookies.map((c) => setCookieName(c)), ["app_sid"],
      "a proxied app cannot mint or overwrite the dashboard session/CSRF cookies");
    assert.match(cookies[0], /; Path=\/proxy\/demo\//);
  } finally {
    gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

test("a backend that sets only Crow's cookies produces no Set-Cookie header at all", async () => {
  const up = await startUpstream({ setCookies: ["crow_session=forged; Path=/", "crow_lang=xx; Path=/"] });
  installBundle(up.port);
  const gw = await startGateway();
  try {
    const res = await get(gw.port, `${PROXY_PATH}/`);
    assert.deepEqual(setCookieValues(res.headers), []);
  } finally {
    gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

test("Path rewriting variants all end up scoped to /proxy/<id>/ (the app's LAST Path wins, sub-paths kept), and Domain is stripped", async () => {
  const up = await startUpstream({
    setCookies: [
      "lower=1; path=/",                                   // lowercase attribute
      "multi=1; Path=/; HttpOnly; Path=/somewhere/else",   // two Path attributes: RFC 6265 keeps the LAST
      "nopath=1; HttpOnly",                                // no Path at all
      "dom=1; Domain=.example.test; Path=/",               // a Domain would point at the backend's host
      "mixed=1; PATH=/; dOmAiN=example.test; Path=/deep",  // case-insensitive, both attributes
    ],
  });
  installBundle(up.port);
  const gw = await startGateway();
  try {
    const cookies = setCookieValues((await get(gw.port, `${PROXY_PATH}/`)).headers);
    assert.equal(cookies.length, 5);
    assert.deepEqual(cookies, [
      "lower=1; Path=/proxy/demo/",
      "multi=1; HttpOnly; Path=/proxy/demo/somewhere/else",
      "nopath=1; HttpOnly; Path=/proxy/demo/",
      "dom=1; Path=/proxy/demo/",
      "mixed=1; Path=/proxy/demo/deep",
    ], "exactly one scoped Path each, the backend's sub-path kept, no Domain, no second Path");
    for (const c of cookies) {
      assert.doesNotMatch(c, /domain=/i, `Domain is stripped: ${c}`);
      assert.equal(c.match(/; *path=/gi).length, 1, `exactly one Path attribute: ${c}`);
    }
  } finally {
    gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

test("spaces around attribute names do not escape the scope (Path =/, Domain =ex.com)", async () => {
  const up = await startUpstream({
    setCookies: [
      "spaced=1; Path =/",                    // RFC 6265 trims the attribute name: this IS Path
      "last=1; Path=/scoped; Path =/",        // the LAST Path wins — and it is origin-wide
      "domspace=1; Domain =ex.com; Path=/",
      "domupper=1; DOMAIN=ex.com; Path=/",
      "both=1; Path =/; Domain =ex.com",
    ],
  });
  installBundle(up.port);
  const gw = await startGateway();
  try {
    const cookies = setCookieValues((await get(gw.port, `${PROXY_PATH}/`)).headers);
    assert.deepEqual(cookies, [
      "spaced=1; Path=/proxy/demo/",
      "last=1; Path=/proxy/demo/",
      "domspace=1; Path=/proxy/demo/",
      "domupper=1; Path=/proxy/demo/",
      "both=1; Path=/proxy/demo/",
    ], "a Path =/ or Domain =ex.com must never survive the rewrite");
  } finally {
    gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

test("a backend cannot mint a Crow cookie with a nameless or quoted-name Set-Cookie", async () => {
  const up = await startUpstream({
    setCookies: [
      "=crow_session=abc",               // nameless: browsers send `crow_session=abc` back
      "=crow_session=abc; Path=/",
      '"crow_session"=abc; Path=/',       // a quoted name is still that name
      '"crow_csrf"=x',
      "  =crow_csrf=abc",                  // leading spaces, same thing
      "novalue",                          // no '=' in the first segment: not a cookie
      "=; Path=/",                        // nameless with an empty value
      "app=1; Path=/",                    // the app's own cookie still goes through
    ],
  });
  installBundle(up.port);
  const gw = await startGateway();
  try {
    const cookies = setCookieValues((await get(gw.port, `${PROXY_PATH}/`)).headers);
    assert.deepEqual(cookies, ["app=1; Path=/proxy/demo/"], "only the app's own cookie survives");
  } finally {
    gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

test("a backend Set-Cookie for an instance-suffixed Crow cookie is dropped too", async () => {
  const up = await startUpstream({
    setCookies: ["crow_mode_1a2b3c4d=new; Path=/", "crow_scope_local=all; Path=/", "crow_try_new_1a2b3c4d=used; Path=/", "keep=1; Path=/"],
  });
  installBundle(up.port);
  const gw = await startGateway();
  try {
    const cookies = setCookieValues((await get(gw.port, `${PROXY_PATH}/`)).headers);
    assert.deepEqual(cookies.map((c) => setCookieName(c)), ["keep"]);
  } finally {
    gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

// ---------------------------------------------------------------------------
// the WebSocket handshake — http-proxy writes the upstream's header block
// straight to the client socket, so `proxyRes` never sees it
// ---------------------------------------------------------------------------

test("a 101 carries no Set-Cookie at all (Crow's or the app's), and frames still flow both ways", async () => {
  const up = await startUpstream({
    ws: {
      echo: true,
      headers: [
        "Set-Cookie: crow_session=forged; Path=/",
        "Set-Cookie: app_sid=abc; Path=/",
        "X-Kept: yes",
      ],
    },
  });
  installBundle(up.port);
  const gw = await startGateway();
  const ws = wsConnect(gw.port, `${PROXY_PATH}/websockify`);
  try {
    await ws.waitFor("\r\n\r\n");
    const head = ws.text().slice(0, ws.text().indexOf("\r\n\r\n"));
    assert.match(head, /^HTTP\/1\.1 101/, "the upgrade still succeeds");
    assert.doesNotMatch(head, /set-cookie/i,
      "a 101 is a handshake, not a document response: the app may set no cookie there — least of all crow_session");
    assert.match(head, /x-kept: yes/i, "every other handshake header is forwarded untouched");
    assert.equal(up.wsSeen.length, 1, "the upgrade reached the backend");

    ws.socket.write("ping");
    await ws.waitFor("echo:ping");
    assert.match(ws.text(), /echo:ping/, "the socket still carries data in both directions after the header block");
  } finally {
    ws.close(); gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

test("a non-101 refusal from the backend reaches the browser without its Set-Cookie", async () => {
  const up = await startUpstream({
    ws: {
      status: 403,
      reason: "Forbidden",
      headers: ["Set-Cookie: crow_session=forged; Path=/", "Set-Cookie: app_sid=abc; Path=/"],
      body: "no upgrade for you",
    },
  });
  installBundle(up.port);
  const gw = await startGateway();
  const ws = wsConnect(gw.port, `${PROXY_PATH}/websockify`);
  try {
    await ws.waitFor("no upgrade for you");
    const text = ws.text();
    const head = text.slice(0, text.indexOf("\r\n\r\n"));
    assert.match(head, /^HTTP\/1\.1 403/, "the refusal is forwarded as it is");
    assert.doesNotMatch(head, /set-cookie/i, "an error response to an upgrade sets no cookies on our origin either");
    assert.match(text, /no upgrade for you/, "the response body is untouched");
  } finally {
    ws.close(); gw.kill(); up.kill(); gw.server.close(); up.server.close();
  }
});

// ---------------------------------------------------------------------------
// the name list itself — one list, shared with every setter
// ---------------------------------------------------------------------------

test("isCrowCookieName: exact names, the shell's per-instance suffix, and no prefix over-match", () => {
  for (const name of ["crow_session", "crow_csrf", "crow_pending_2fa", "crow_2fa_trusted", "crow_lang", "crow_mode", "crow_scope", "crow_try_new"]) {
    assert.equal(isCrowCookieName(name), true, name);
  }
  // shell modes carry a per-instance suffix (cookieName() in shell/mode.js)
  assert.equal(isCrowCookieName("crow_mode_local"), true);
  assert.equal(isCrowCookieName("crow_mode_1a2b3c4d"), true);
  assert.equal(isCrowCookieName("crow_scope_1a2b3c4d"), true);
  assert.equal(isCrowCookieName("crow_try_new_1a2b3c4d"), true);
  // an app's own cookie that merely starts with a Crow name is NOT Crow's
  assert.equal(isCrowCookieName("crow_session_extra"), false);
  assert.equal(isCrowCookieName("crow_mode_zzz"), false);
  assert.equal(isCrowCookieName("app_crow_session"), false);
  assert.equal(isCrowCookieName("CROW_SESSION"), false);
  assert.equal(isCrowCookieName(""), false);
  assert.equal(isCrowCookieName(undefined), false);
});

test("stripCrowCookieHeader keeps every other cookie, in order, and returns null when nothing is left", () => {
  assert.equal(stripCrowCookieHeader("a=1; crow_session=s; b=2; crow_csrf=c"), "a=1; b=2");
  assert.equal(stripCrowCookieHeader("crow_session=s"), null);
  assert.equal(stripCrowCookieHeader(""), null);
  assert.equal(stripCrowCookieHeader(undefined), null);
  assert.equal(stripCrowCookieHeader("flag; crow_mode_local=x; other"), "flag; other", "a value-less cookie is not Crow's");
  assert.equal(stripCrowCookieHeader(["a=1", "crow_session=s"]), "a=1", "a string[] header is handled");
});

test("a quoted cookie name keeps its quotes on the way out (only the Crow-name check unquotes it)", () => {
  assert.equal(rewriteProxySetCookie('"app_sid"=abc; Path=/', PROXY_PATH), '"app_sid"=abc; Path=/proxy/demo/',
    "the app's name is forwarded exactly as it wrote it; quotes are only stripped for the comparison");
  assert.equal(rewriteProxySetCookie('  "app_sid" =abc ; Path=/', PROXY_PATH), '"app_sid"=abc; Path=/proxy/demo/',
    "the name text survives, surrounding spaces trimmed as a header always is");
  assert.equal(rewriteProxySetCookie('"crow_session"=abc; Path=/', PROXY_PATH), null,
    "quotes do not hide a Crow name");
  assert.equal(rewriteProxySetCookie('"=crow_session=abc', PROXY_PATH), '"=crow_session=abc; Path=/proxy/demo/',
    "a name of one quote is a name (not crow_session): it is forwarded, not silently rewritten");
  assert.equal(rewriteProxySetCookie('""=abc; Path=/', PROXY_PATH), null,
    "a quoted EMPTY name is still nameless");
});

test("rewriteProxySetCookie is the single rule the response hook uses", () => {
  assert.equal(rewriteProxySetCookie("crow_session=x; Path=/", PROXY_PATH), null);
  assert.equal(rewriteProxySetCookie("crow_csrf=x", PROXY_PATH), null);
  assert.equal(rewriteProxySetCookie("a=1; path=/; Path=/x", PROXY_PATH), "a=1; Path=/proxy/demo/x",
    "the LAST Path wins and its sub-path is kept");
  assert.equal(rewriteProxySetCookie("a=1; HttpOnly", PROXY_PATH), "a=1; HttpOnly; Path=/proxy/demo/");
  assert.equal(rewriteProxySetCookie("a=1; Domain=.x.test; Path=/", PROXY_PATH), "a=1; Path=/proxy/demo/");
  assert.equal(rewriteProxySetCookie("a=1", "/proxy/demo/"), "a=1; Path=/proxy/demo/", "a trailing slash in the mount path");
  // RFC 6265 trims spaces around the attribute NAME, and the last one wins.
  assert.equal(rewriteProxySetCookie("a=1; Path =/", PROXY_PATH), "a=1; Path=/proxy/demo/");
  assert.equal(rewriteProxySetCookie("a=1; Path=/x; Path =/", PROXY_PATH), "a=1; Path=/proxy/demo/",
    "`Path =/` last means origin-wide — it must be re-scoped, not forwarded");
  assert.equal(rewriteProxySetCookie("a=1; Path=/x", PROXY_PATH), "a=1; Path=/proxy/demo/x");
  assert.equal(rewriteProxySetCookie("a=1; Path=/", PROXY_PATH), "a=1; Path=/proxy/demo/");
  assert.equal(rewriteProxySetCookie("a=1; Path=//api/", PROXY_PATH), "a=1; Path=/proxy/demo/api/");
  assert.equal(rewriteProxySetCookie("a=1; Path=/../../etc", PROXY_PATH), "a=1; Path=/proxy/demo/", "no climbing out");
  assert.equal(rewriteProxySetCookie("a=1; Path=/x/%2e%2e/y", PROXY_PATH), "a=1; Path=/proxy/demo/", "an encoded .. counts");
  assert.equal(rewriteProxySetCookie("a=1; Path=api", PROXY_PATH), "a=1; Path=/proxy/demo/", "a relative Path is not a scope");
  assert.equal(rewriteProxySetCookie("a=1; Domain =ex.com; Path=/", PROXY_PATH), "a=1; Path=/proxy/demo/");
  assert.equal(rewriteProxySetCookie("a=1; DOMAIN=ex.com", PROXY_PATH), "a=1; Path=/proxy/demo/");
  // nameless / no-'=' cookies are dropped outright (browsers rebuild a Crow name from them)
  assert.equal(rewriteProxySetCookie("=crow_session=abc", PROXY_PATH), null);
  assert.equal(rewriteProxySetCookie('"crow_session"=abc; Path=/', PROXY_PATH), null, "a quoted name is still that name");
  assert.equal(rewriteProxySetCookie("novalue", PROXY_PATH), null, "no '=' in the first segment: not a cookie");
  assert.equal(rewriteProxySetCookie("", PROXY_PATH), null);
  assert.equal(rewriteProxySetCookie(undefined, PROXY_PATH), null);
  assert.equal(setCookieName("a=1; Path=/"), "a");
  assert.equal(setCookieName('"crow_session"=abc'), "crow_session", "quotes are not part of the name");
  assert.equal(setCookieName("=crow_session=abc"), "");
  assert.equal(setCookieName("novalue"), "");
  assert.equal(proxyCookiePath(PROXY_PATH, "/api"), "/proxy/demo/api");
  assert.equal(proxyCookiePath(PROXY_PATH, "/"), "/proxy/demo/");
  assert.equal(proxyCookiePath(PROXY_PATH, null), "/proxy/demo/");
  assert.equal(proxyCookiePath(PROXY_PATH, "api"), "/proxy/demo/", "a relative Path is not a scope");
  assert.equal(proxyCookiePath(PROXY_PATH, "/a/../b"), "/proxy/demo/");
});

test("every Crow cookie constant is in CROW_COOKIE_NAMES (adding one and forgetting the list fails here)", () => {
  const constants = Object.entries(cookieNames).filter(([k, v]) => /_COOKIE$/.test(k) && typeof v === "string" && v.startsWith("crow_"));
  assert.ok(constants.length >= 8, "the cookie constants are exported from cookie-names.js");
  for (const [key, value] of constants) {
    assert.ok(CROW_COOKIE_NAMES.includes(value), `${key} (${value}) must be in CROW_COOKIE_NAMES`);
  }
});

test("the setters' own cookies are all recognised by the strip rule", () => {
  // Set through the real code paths, so a renamed cookie fails here rather than
  // silently leaking through the proxy.
  const headers = {};
  setSessionCookie({ setHeader: (k, v) => { headers[k] = v; } }, "tok");
  for (const c of headers["Set-Cookie"]) assert.equal(isCrowCookieName(setCookieName(c)), true, c);
  assert.equal(isCrowCookieName(setCookieName(mode.modeCookie("new"))), true);
  assert.equal(isCrowCookieName(setCookieName(mode.tryCookie("pending"))), true);
  assert.equal(isCrowCookieName(mode.cookieName(mode.SCOPE_COOKIE)), true, "the per-instance scope cookie");
  assert.equal(isCrowCookieName(mode.cookieName(mode.MODE_COOKIE)), true);
  assert.equal(isCrowCookieName(mode.cookieName(mode.TRY_COOKIE)), true);
});

test("no gateway module outside cookie-names.js defines a crow_* cookie literal, and no Set-Cookie names one inline", () => {
  const ROOT = new URL("../servers/gateway/", import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "public" || entry === "node_modules") continue; // vendored/assets
        walk(full);
      } else if (entry.endsWith(".js")) {
        files.push(full);
      }
    }
  };
  walk(ROOT.pathname);
  assert.ok(files.length > 50, "walked the gateway tree");

  const definitions = [];
  const inline = [];
  const referenced = new Set();
  for (const file of files) {
    const rel = file.slice(ROOT.pathname.length);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/[A-Z][A-Z0-9_]*_COOKIE\b/g)) referenced.add(m[0]);
    if (rel === "cookie-names.js") continue;
    for (const line of src.split("\n")) {
      const code = line.trim();
      // Comments may name a cookie to explain the rule; only code counts.
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
      const def = /(?:const|let|var)\s+([A-Za-z0-9_]*COOKIE[A-Za-z0-9_]*)\s*=\s*["']crow_[a-z0-9_]+["']/.exec(line);
      if (def) definitions.push(`${rel}: ${def[1]}`);
      if (/Set-Cookie|document\.cookie\s*=/.test(line)) {
        for (const m of line.matchAll(/\bcrow_[a-z0-9_]+/g)) inline.push(`${rel}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(definitions, [], "Crow cookie names are defined ONLY in servers/gateway/cookie-names.js");
  assert.deepEqual(inline, [], "cookie headers interpolate the shared constants, never a literal name");
  for (const name of ["SESSION_COOKIE", "CSRF_COOKIE", "PENDING_2FA_COOKIE", "TRUSTED_2FA_COOKIE", "LANG_COOKIE", "MODE_COOKIE", "TRY_COOKIE", "SCOPE_COOKIE"]) {
    assert.ok(referenced.has(name), `${name} is used somewhere in the gateway (set or read)`);
  }
});