/**
 * The browser add-on restart remedy's REAL self-POST — tests/fix-it-restart-browser-addon.test.js
 *
 * The card's action must run the SAME path the Extensions Restart button runs:
 * POST /dashboard/bundles/api/start with `{bundle_id, recreate:true}`, carrying the
 * owner's own session cookie and CSRF token into this gateway's own listener
 * (fix-it/remedies/restart-browser-addon.js). That route is not exported as a
 * function, so the only way to test the real thing is over HTTP.
 *
 * So this file puts a REAL server on 127.0.0.1 (random port) and points the remedy's
 * dial address at it — `PORT` (gatewayBackendPort) and the gateway bind env var
 * (gatewayListenHost) are read at call time, so both are set for the test and restored
 * afterwards. Only the owner rule is stubbed (`_setRestartDepsForTest({ owner })`);
 * `restart` is never injected here: the request, its headers, its body, the redirect
 * handling and the timeout are the product's.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_BIND_ENV } from "../servers/gateway/listen-host.js";

let remedy;
let START_ROUTE;
let BUNDLE_ID;
let RESTART_TIMEOUT_MS;
let setDeps;
let OWNER_ONLY_FLASH;
let OWNER_ONLY_MESSAGE;
let home;

const OWNER = async () => true;
/** The dashboard request that clicked the button: the owner's own session. */
const ownerRequest = () => ({ headers: { cookie: "crow_session=abc123" }, csrfToken: "csrf-token-1" });

before(async () => {
  home = mkdtempSync(join(tmpdir(), "crowhome-browserrestart-"));
  process.env.CROW_HOME = home;
  remedy = await import("../servers/gateway/fix-it/remedies/restart-browser-addon.js");
  START_ROUTE = remedy.START_ROUTE;
  BUNDLE_ID = remedy.BUNDLE_ID;
  RESTART_TIMEOUT_MS = remedy.RESTART_TIMEOUT_MS;
  setDeps = remedy._setRestartDepsForTest;
  const restore = await import("../servers/gateway/fix-it/remedies/restore-bundle-compose.js");
  OWNER_ONLY_FLASH = restore.OWNER_ONLY_FLASH;
  OWNER_ONLY_MESSAGE = restore.OWNER_ONLY_MESSAGE;
});

after(() => {
  delete process.env.CROW_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => setDeps(null));

const sendJson = (res, obj, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

/**
 * A loopback stand-in for this gateway. It records every request (method, url,
 * headers, raw and parsed body) and answers with `handler`. With `hold > 0` the
 * answer is delayed — a stand-in for the rebuild the real route waits out.
 *
 * PORT + the gateway bind env var are pointed at it for as long as it runs, and both
 * are restored when it closes (`close()` is always called from a finally).
 */
async function gateway({ handler = (req, res) => sendJson(res, { ok: true }), hold = 0 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      requests.push({ method: req.method, url: req.url, headers: req.headers, raw, body });
      const answer = () => handler(req, res);
      if (hold > 0) setTimeout(answer, hold); else answer();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const prevPort = process.env.PORT;
  const prevBind = process.env[GATEWAY_BIND_ENV];
  process.env.PORT = String(server.address().port);
  process.env[GATEWAY_BIND_ENV] = "127.0.0.1";
  return {
    port: server.address().port,
    requests,
    async close() {
      if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
      if (prevBind === undefined) delete process.env[GATEWAY_BIND_ENV]; else process.env[GATEWAY_BIND_ENV] = prevBind;
      await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    },
  };
}

/** Run the remedy's real restart path while `fn(gw)` holds the server. */
async function withGateway(opts, fn) {
  const gw = await gateway(opts);
  try { return await fn(gw); } finally { await gw.close(); }
}

/** Run the remedy as the owner, with the server as the gateway. */
const restartAs = (req, opts = {}) => withGateway(opts, async () => {
  setDeps({ owner: OWNER });
  try { return await remedy.default({ bundle: BUNDLE_ID }, { db: null, item: null, req }); } finally { setDeps(null); }
});

/** Collect console.warn for the duration of `fn`, and return both its result and the lines. */
async function captureWarn(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  let value;
  try { value = await fn(); } finally { console.warn = original; }
  return { value, lines };
}

test("(1) the route sees POST /dashboard/bundles/api/start with the cookie, the CSRF header and the {bundle_id, recreate} body → {ok:true} resolves true", async () => {
  const gw = await gateway();
  let out;
  try {
    setDeps({ owner: OWNER });
    out = await remedy.default({ bundle: BUNDLE_ID }, { db: null, item: null, req: ownerRequest() });
  } finally {
    setDeps(null);
    await gw.close();
  }

  assert.equal(out.resolved, true);
  assert.equal(START_ROUTE, "/dashboard/bundles/api/start");
  assert.equal(gw.requests.length, 1, "exactly one request, to the one route");

  const a = gw.requests[0];
  assert.equal(a.method, "POST");
  assert.equal(a.url, "/dashboard/bundles/api/start");
  assert.equal(a.headers.cookie, "crow_session=abc123");
  assert.equal(a.headers["x-crow-csrf"], "csrf-token-1");
  assert.deepEqual(a.body, { bundle_id: "browser", recreate: true });
  assert.match(String(a.headers["content-type"]), /application\/json/);
});

test("HELD REQUEST: a slow rebuild does not make the client give up", async () => {
  const gw = await gateway({ hold: 400 });
  let out;
  let took;
  try {
    setDeps({ owner: OWNER });
    const started = Date.now();
    out = await remedy.default({ bundle: BUNDLE_ID }, { db: null, item: null, req: ownerRequest() });
    took = Date.now() - started;
  } finally {
    setDeps(null);
    await gw.close();
  }

  assert.equal(out.resolved, true, "the held answer was waited for");
  assert.ok(took >= 350, `the held request really was held (took ${took} ms)`);
  assert.equal(gw.requests.length, 1);

  // CONTROL: the same route answering at once resolves too — so the hold, not luck.
  const quick = await restartAs(ownerRequest());
  assert.equal(quick.resolved, true);
});

test("a 302 to the login page is a refusal, not an answer (no follow)", async () => {
  const out = await restartAs(ownerRequest(), {
    handler: (req, res) => { res.writeHead(302, { location: "/dashboard/login" }); res.end(); },
  });

  assert.equal(out.resolved, false);
});

test("the redirect is not followed: the login page is never fetched", async () => {
  const seen = [];
  const out = await restartAs(ownerRequest(), {
    handler: (req, res) => {
      seen.push(req.method + " " + req.url);
      if (req.url === "/dashboard/bundles/api/start") { res.writeHead(302, { location: "/dashboard/login" }); res.end(); return; }
      res.writeHead(200, { "content-type": "text/html" }); res.end("<html>login</html>");
    },
  });

  assert.equal(out.resolved, false);
  assert.deepEqual(seen, ["POST /dashboard/bundles/api/start"], "the redirect target was never requested");
});

test("a refusal body {ok:false,error} → false, and the warn names the reason", async () => {
  const REASON = "the rebuild was refused: port 6080 is already in use";
  const { value, lines } = await captureWarn(() => restartAs(ownerRequest(), {
    handler: (req, res) => sendJson(res, { ok: false, error: REASON }),
  }));

  assert.equal(value.resolved, false);
  assert.equal(lines.length, 1, "one line, naming why the restart did not run");
  assert.match(lines[0], /restart did not run/i);
  assert.ok(lines[0].includes(REASON), `the warn names the reason (got: ${lines[0]})`);
});

test("HTTP 500 → false, and the warn names the status", async () => {
  const { value, lines } = await captureWarn(() => restartAs(ownerRequest(), {
    handler: (req, res) => { res.writeHead(500, { "content-type": "text/plain" }); res.end("Internal Server Error"); },
  }));

  assert.equal(value.resolved, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /restart did not run/i);
  assert.match(lines[0], /500/);
});

test("a non-JSON body → false, and the warn names what it could read", async () => {
  const { value, lines } = await captureWarn(() => restartAs(ownerRequest(), {
    handler: (req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>ok?</html>"); },
  }));

  assert.equal(value.resolved, false, "an unreadable answer is a refusal, never a success");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /restart did not run/i);
  assert.match(lines[0], /HTTP 200/);
});

test("no dashboard session cookie → false, and no request is made at all", async () => {
  const gw = await gateway();
  let out;
  try {
    setDeps({ owner: OWNER });
    out = await remedy.default({ bundle: BUNDLE_ID }, { db: null, item: null, req: { headers: {} } });
  } finally {
    setDeps(null);
    await gw.close();
  }

  assert.equal(out.resolved, false);
  assert.equal(out.flash, undefined, "the Nest's generic failure line, not a made-up sentence");
  assert.equal(gw.requests.length, 0, "there was no session to carry, so nothing was sent");
});

test("CONTROL: the same call WITH a cookie does reach the route", async () => {
  let seen = 0;
  const out = await restartAs(ownerRequest(), {
    handler: (req, res) => { seen += 1; sendJson(res, { ok: true }); },
  });

  assert.equal(out.resolved, true);
  assert.equal(seen, 1, "so the silence above was the missing session, not a broken server");
});

test("not the owner → the owner-only flash, and the route is never dialed", async () => {
  const gw = await gateway();
  let out;
  try {
    setDeps({ owner: async () => false });
    out = await remedy.default({ bundle: BUNDLE_ID }, { db: null, item: null, req: ownerRequest() });
  } finally {
    setDeps(null);
    await gw.close();
  }

  assert.equal(out.resolved, false);
  assert.equal(out.flash, OWNER_ONLY_FLASH);
  assert.equal(out.message, OWNER_ONLY_MESSAGE);
  assert.equal(gw.requests.length, 0);
});

test("the request is bounded by the 15-minute constant (and the held case above passed under it)", () => {
  assert.equal(RESTART_TIMEOUT_MS, 15 * 60 * 1000);
});