import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { isAllowedNetwork } from "../servers/gateway/dashboard/auth.js";
import { rejectFunneledMiddleware } from "../servers/gateway/funnel.js";

// The gate decides on the TCP peer (req.socket), never req.ip: `ip` here is
// the socket address, and `req.ip` is deliberately set to something else so a
// regression to reading it shows up.
function mkReq({ ip = "127.0.0.1", headers = {}, socket = {} } = {}) {
  const sock = { remoteAddress: ip, ...socket };
  return { ip: "203.0.113.250", headers, socket: sock, connection: sock };
}

test("isAllowedNetwork: Funnel header rejects even with tailnet IP", () => {
  assert.equal(
    isAllowedNetwork(mkReq({ ip: "100.64.0.5", headers: { "tailscale-funnel-request": "?1" } })),
    false,
  );
});

test("isAllowedNetwork: Funnel header rejects even with forged identity header", () => {
  assert.equal(
    isAllowedNetwork(mkReq({
      headers: {
        "tailscale-funnel-request": "?1",
        "tailscale-user-login": "alice@example.com",
      },
    })),
    false,
  );
});

test("isAllowedNetwork: Tailscale-User-Login alone is never sufficient", () => {
  assert.equal(
    isAllowedNetwork(mkReq({ headers: { "tailscale-user-login": "alice@example.com" } })),
    false,
  );
});

test("isAllowedNetwork: bare localhost with no Tailscale headers is rejected", () => {
  assert.equal(isAllowedNetwork(mkReq({ ip: "127.0.0.1" })), false);
  assert.equal(isAllowedNetwork(mkReq({ ip: "::1" })), false);
});

test("isAllowedNetwork: RFC1918 and CGNAT IPs pass", () => {
  assert.equal(isAllowedNetwork(mkReq({ ip: "10.0.0.5" })), true);
  assert.equal(isAllowedNetwork(mkReq({ ip: "192.168.1.10" })), true);
  assert.equal(isAllowedNetwork(mkReq({ ip: "172.16.0.1" })), true);
  assert.equal(isAllowedNetwork(mkReq({ ip: "100.64.0.1" })), true);
  assert.equal(isAllowedNetwork(mkReq({ ip: "100.127.0.1" })), true);
});

test("isAllowedNetwork: public IP rejected", () => {
  assert.equal(isAllowedNetwork(mkReq({ ip: "8.8.8.8" })), false);
  assert.equal(isAllowedNetwork(mkReq({ ip: "1.2.3.4" })), false);
});

test("isAllowedNetwork: CROW_DASHBOARD_PUBLIC=true short-circuits allow", () => {
  process.env.CROW_DASHBOARD_PUBLIC = "true";
  try {
    assert.equal(isAllowedNetwork(mkReq({ ip: "8.8.8.8" })), true);
    assert.equal(
      isAllowedNetwork(mkReq({ ip: "8.8.8.8", headers: { "tailscale-funnel-request": "?1" } })),
      true,
    );
  } finally {
    delete process.env.CROW_DASHBOARD_PUBLIC;
  }
});

test("isAllowedNetwork: CROW_ALLOWED_IPS CIDR match", () => {
  process.env.CROW_ALLOWED_IPS = "203.0.113.0/24";
  try {
    assert.equal(isAllowedNetwork(mkReq({ ip: "203.0.113.42" })), true);
    assert.equal(isAllowedNetwork(mkReq({ ip: "203.0.114.1" })), false);
  } finally {
    delete process.env.CROW_ALLOWED_IPS;
  }
});

// Integration test for the rejectFunneled middleware. Uses the real import
// so tests stay in sync with the live middleware automatically.
function startTestApp() {
  const app = express();
  app.use(rejectFunneledMiddleware());
  app.get(/.*/, (req, res) => res.status(200).send("ok"));
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("rejectFunneled middleware: private paths blocked with Funnel header", async () => {
  const server = await startTestApp();
  try {
    const port = server.address().port;
    for (const path of ["/dashboard/nest", "/router/mcp", "/api/chat/conversations", "/storage/upload", "/dashboard/frigate", "/api/frigate/cameras", "/frigate/", "/dashboard/motioneye", "/llm/v1/chat/completions", "/llm/v1/models", "/llm/p/x/v1/chat/completions", "/llm/v1/embeddings", "/llm/models", "/"]) {
      const r = await request(port, path, { "tailscale-funnel-request": "?1" });
      assert.equal(r.status, 403, `expected 403 on ${path}, got ${r.status}`);
    }
  } finally {
    server.close();
  }
});

test("/llm routers refuse Funnel themselves, even with CROW_DASHBOARD_PUBLIC=true", async () => {
  const prev = process.env.CROW_DASHBOARD_PUBLIC;
  process.env.CROW_DASHBOARD_PUBLIC = "true";
  const { default: llmRouterRouter } = await import("../servers/gateway/routes/llm-router.js");
  const app = express();
  app.use(llmRouterRouter({ acquireFn: async () => true, resolveKeyFn: async () => ({ baseUrl: "http://127.0.0.1:9/v1", model: "m" }), loadProvidersFn: () => ({ providers: {} }) }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    for (const path of ["/llm/v1/chat/completions", "/llm/p/x/v1/chat/completions", "/llm/v1/embeddings", "/llm/v1/models"]) {
      const r = await request(server.address().port, path, { "tailscale-funnel-request": "?1" });
      assert.equal(r.status, 403, path);
    }
  } finally {
    server.close();
    if (prev === undefined) delete process.env.CROW_DASHBOARD_PUBLIC; else process.env.CROW_DASHBOARD_PUBLIC = prev;
  }
});

test("rejectFunneled middleware: SSO routes are never reachable via Funnel", async () => {
  const server = await startTestApp();
  try {
    const port = server.address().port;
    // The SSO accept route bypasses password dashboardAuth, so its only
    // network defenses are isAllowedNetwork (tested above) + this Funnel guard.
    for (const path of ["/dashboard/sso/accept", "/dashboard/sso/launch", "/dashboard/sso/accept?src=x&t=y&sig=z"]) {
      const r = await request(port, path, { "tailscale-funnel-request": "?1" });
      assert.equal(r.status, 403, `expected 403 on ${path}, got ${r.status}`);
    }
  } finally {
    server.close();
  }
});

test("isAllowedNetwork: SSO accept on a tailnet IP is still rejected over Funnel", () => {
  // The accept handler calls isAllowedNetwork() explicitly; a Funnel request
  // must fail even though the source IP is in the Tailscale CGNAT range.
  assert.equal(
    isAllowedNetwork(mkReq({ ip: "100.96.0.7", headers: { "tailscale-funnel-request": "?1" } })),
    false,
  );
});

test("rejectFunneled middleware: bot-federation endpoints are never funnel-exposed", async () => {
  const server = await startTestApp();
  try {
    const port = server.address().port;
    for (const path of ["/dashboard/bot-federation/def/x", "/dashboard/bot-federation/patch/x", "/dashboard/bot-federation/enabled/x"]) {
      const r = await request(port, path, { "tailscale-funnel-request": "?1" });
      assert.equal(r.status, 403, `expected 403 on ${path}, got ${r.status}`);
    }
  } finally {
    server.close();
  }
});

// Perch Hub C-3. Two new surfaces, both of which must stay off the public
// internet: the proxied hub itself (whose backend receives an auto-injected
// bearer, so a funnel-reachable /proxy/perch-hub/ would be an unauthenticated
// remote path to `POST /api/hub/spawn` — documented upstream as arbitrary code
// execution), and the gateway-side perch API the bots lens calls.
test("rejectFunneled middleware: the Perch surfaces are never funnel-exposed", async () => {
  const server = await startTestApp();
  try {
    const port = server.address().port;
    for (const path of [
      "/proxy/perch-hub/",
      "/proxy/perch-hub/bots",
      "/proxy/perch-hub/api/hub/spawn",
      "/proxy/browser/vnc.html",
      "/dashboard/perch-api/bots",
      "/dashboard/perch-api/bots/1/turn",
      // Perch Hub P2 (C-15): the interactive ("spawn as bot") surfaces —
      // same private prefix, same reasoning (a long-lived session's SSE
      // stream and its ask_user answers are exactly as private as a turn).
      "/dashboard/perch-api/bots/1/interactive",
      "/dashboard/perch-api/interactive/abc/message",
      "/dashboard/perch-api/interactive/abc/events",
      "/dashboard/perch-api/interactive/abc/answer",
      "/dashboard/perch-api/interactive/abc/abort",
      "/dashboard/perch-api/interactive/abc/stop",
      // Queue item 20 PR 2: "Give to…" and "Give <Name> a task".
      "/dashboard/perch-api/cards/1/give",
      "/dashboard/perch-api/bots/1/tasks",
      // Live browser tile: Delete screenshot.
      "/dashboard/perch-api/interactive/abc/browser-shots/1",
      // Live browser tile: the frames long poll.
      "/dashboard/perch-api/interactive/abc/browser/frame?after=0",
      // Live browser tile: Take over, Hand back and the sheet's heartbeat.
      "/dashboard/perch-api/browser/take-over",
      "/dashboard/perch-api/browser/hand-back",
      "/dashboard/perch-api/browser/heartbeat",
      "/dashboard/perch-api/browser/state",
      // R1.2: a project's home.
      "/dashboard/project/x",
    ]) {
      const r = await request(port, path, { "tailscale-funnel-request": "?1" });
      assert.equal(r.status, 403, `expected 403 on ${path}, got ${r.status}`);
    }
  } finally {
    server.close();
  }
});

test("dashboardAuth refuses an unauthenticated /dashboard/perch-api request instead of calling next()", async () => {
  // The perch API mounts behind dashboardAuth (bot-board-api idiom). Proven
  // here at the middleware, since a session-less caller must never reach a
  // route that can drive a bot or read a transcript.
  const { dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");

  const run = (req) => new Promise((resolve) => {
    let nexted = false;
    const out = { status: null, redirected: null };
    const res = {
      status(c) { out.status = c; return this; },
      type() { return this; },
      send() { resolve({ nexted, ...out }); return this; },
      json() { resolve({ nexted, ...out }); return this; },
      redirect(url) { out.redirected = url; resolve({ nexted, ...out }); },
      redirectAfterPost(url) { out.redirected = url; resolve({ nexted, ...out }); },
    };
    dashboardAuth(req, res, () => { nexted = true; resolve({ nexted, ...out }); });
  });

  // Off-network (bare loopback, no Tailscale headers) → hard refusal.
  const offNet = await run(mkReq({ ip: "127.0.0.1", headers: { host: "x" } }));
  assert.equal(offNet.nexted, false);
  assert.equal(offNet.status, 403);

  // On-network but session-less → bounced to the login page, never through.
  const noSession = await run(mkReq({ ip: "10.0.0.5", headers: { host: "x" } }));
  assert.equal(noSession.nexted, false, "a request with no crow_session cookie must never reach the perch API");
  assert.equal(noSession.redirected, "/dashboard/login");
});

test("dashboardAuth refuses an unauthenticated /dashboard/perch-api/interactive request instead of calling next()", async () => {
  // Perch Hub P2 (C-15): same gate, same prefix — a session-less caller must
  // never reach a route that can spawn, drive, or observe (via SSE) a
  // long-lived interactive session.
  const { dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");

  const run = (req) => new Promise((resolve) => {
    let nexted = false;
    const out = { status: null, redirected: null };
    const res = {
      status(c) { out.status = c; return this; },
      type() { return this; },
      send() { resolve({ nexted, ...out }); return this; },
      json() { resolve({ nexted, ...out }); return this; },
      redirect(url) { out.redirected = url; resolve({ nexted, ...out }); },
      redirectAfterPost(url) { out.redirected = url; resolve({ nexted, ...out }); },
    };
    dashboardAuth(req, res, () => { nexted = true; resolve({ nexted, ...out }); });
  });

  const offNet = await run(mkReq({ ip: "127.0.0.1", headers: { host: "x" } }));
  assert.equal(offNet.nexted, false);
  assert.equal(offNet.status, 403);

  const noSession = await run(mkReq({ ip: "10.0.0.5", headers: { host: "x" } }));
  assert.equal(noSession.nexted, false, "a request with no crow_session cookie must never reach the interactive API");
  assert.equal(noSession.redirected, "/dashboard/login");
});

test("auth-network: /dashboard/project/x needs a session", async () => {
  // The REAL dashboard router: the project home sits behind dashboardAuth like
  // every panel page. Off-network is refused; on-network without a session is
  // sent to the login page; neither reaches the panel.
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(dashboardRouter((req, res, next) => next()));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = server.address().port;
    const offNet = await request(port, "/dashboard/project/x");
    assert.equal(offNet.status, 403, "bare loopback, no tailnet identity");
    // Past the network gate (CROW_DASHBOARD_PUBLIC opens it; no tailnet identity is
    // forged): with no session the page still sends you to the login page.
    process.env.CROW_DASHBOARD_PUBLIC = "true";
    let noSession;
    try { noSession = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/dashboard/project/x", method: "GET" },
        (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location })); });
      req.on("error", reject);
      req.end();
    }); } finally { delete process.env.CROW_DASHBOARD_PUBLIC; }
    assert.ok(noSession.status === 302 || noSession.status === 303, `a redirect, got ${noSession.status}`);
    assert.equal(noSession.location, "/dashboard/login");
  } finally {
    server.close();
  }
});

test("rejectFunneled middleware: public paths pass with Funnel header", async () => {
  const server = await startTestApp();
  try {
    const port = server.address().port;
    for (const path of ["/blog", "/blog/post-1", "/robots.txt", "/sitemap.xml", "/.well-known/oauth-authorization-server", "/favicon.ico", "/manifest.json"]) {
      const r = await request(port, path, { "tailscale-funnel-request": "?1" });
      assert.equal(r.status, 200, `expected 200 on ${path}, got ${r.status}`);
    }
  } finally {
    server.close();
  }
});

test("rejectFunneled middleware: no Funnel header, all paths pass", async () => {
  const server = await startTestApp();
  try {
    const port = server.address().port;
    const r = await request(port, "/dashboard/nest");
    assert.equal(r.status, 200);
  } finally {
    server.close();
  }
});

function runFunnelMw(path, { funnel = true } = {}) {
  const mw = rejectFunneledMiddleware();
  const req = { headers: funnel ? { "tailscale-funnel-request": "?1" } : {}, path };
  let statusCode = null;
  let nexted = false;
  const res = {
    status(c) { statusCode = c; return this; },
    type() { return this; },
    send() { return this; },
  };
  mw(req, res, () => { nexted = true; });
  return { statusCode, nexted };
}

// Crow Workspace K5: the live-edit endpoints (editor-session-token auth, reached only through the tailnet Serve
// path /crow-live on the editor port) are never public — not in PUBLIC_FUNNEL_PREFIXES, rejected with the header.
test("funnel: the Workspace live-edit API (/api/workspace/live) is never funnel-exposed", async () => {
  for (const path of ["/api/workspace/live/v1/pending", "/api/workspace/live/v1/claim", "/api/workspace/live/v1/ack", "/api/workspace/quick/save"]) {
    assert.equal(runFunnelMw(path).statusCode, 403, path);
    assert.equal(runFunnelMw(path, { funnel: false }).nexted, true, `${path} without the Funnel header passes this layer`);
  }
  const { PUBLIC_FUNNEL_PREFIXES } = await import("../servers/gateway/funnel.js");
  assert.ok(!PUBLIC_FUNNEL_PREFIXES.some((p) => "/api/workspace/live/v1/pending".startsWith(p)));
});

test("funnel: public prefixes pass, lookalike paths are rejected", () => {
  assert.equal(runFunnelMw("/blog").nexted, true);
  assert.equal(runFunnelMw("/blog/feed.xml").nexted, true);
  assert.equal(runFunnelMw("/robots.txt").nexted, true);
  assert.equal(runFunnelMw("/.well-known/oauth-authorization-server").nexted, true);
  // segment-anchoring: a lookalike prefix must NOT pass
  assert.equal(runFunnelMw("/blogX").statusCode, 403);
  assert.equal(runFunnelMw("/robots.txt.bak").statusCode, 403);
  assert.equal(runFunnelMw("/favicon.ico2").statusCode, 403);
  // trailing-slash bypass and extension lookalikes must NOT pass
  assert.equal(runFunnelMw("/robots.txt/").statusCode, 403);
  assert.equal(runFunnelMw("/.well-known").statusCode, 403);
  assert.equal(runFunnelMw("/blog.rss").statusCode, 403);
  assert.equal(runFunnelMw("/sitemap.xml.gz").statusCode, 403);
  // private paths still rejected
  assert.equal(runFunnelMw("/dashboard").statusCode, 403);
  // non-funnel requests always pass this middleware
  assert.equal(runFunnelMw("/dashboard", { funnel: false }).nexted, true);
});

test("funnel: GATEWAY_FUNNEL_PUBLIC_PREFIXES extends the allowlist with the same semantics", () => {
  process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES = "/s/,/s, /s-assets/ ,not-a-path";
  try {
    // subtree entry "/s/" and exact entry "/s"
    assert.equal(runFunnelMw("/s").nexted, true);
    assert.equal(runFunnelMw("/s/family").nexted, true);
    assert.equal(runFunnelMw("/s-assets/icons/icon-192.png").nexted, true);
    // lookalikes and bare-subtree misses still rejected
    assert.equal(runFunnelMw("/sX").statusCode, 403);
    assert.equal(runFunnelMw("/s-assets").statusCode, 403);
    // entries not starting with "/" are dropped, never matched
    assert.equal(runFunnelMw("/not-a-path").statusCode, 403);
    // dashboard stays private regardless of env
    assert.equal(runFunnelMw("/dashboard").statusCode, 403);
    // env is read at middleware creation: static list unaffected
    assert.equal(runFunnelMw("/blog").nexted, true);
  } finally {
    delete process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES;
  }
});

test("funnel: env unset leaves the static allowlist behavior unchanged", () => {
  delete process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES;
  assert.equal(runFunnelMw("/s/family").statusCode, 403);
  assert.equal(runFunnelMw("/blog").nexted, true);
});

test("kiosk paths are never public-funnel paths (spec §10; page at /display per ruling F1)", async () => {
  const { PUBLIC_FUNNEL_PREFIXES } = await import("../servers/gateway/funnel.js");
  for (const p of ["/display", "/display/", "/kiosk", "/kiosk/", "/api/kiosk", "/api/kiosk/"]) assert.ok(!PUBLIC_FUNNEL_PREFIXES.includes(p), p);
  const app = express();
  app.use(rejectFunneledMiddleware());
  app.get("/display", (req, res) => res.send("ok"));
  app.get("/display/assets/:file", (req, res) => res.send("ok"));
  app.post("/api/kiosk/pair/start", (req, res) => res.send("ok"));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(base + "/display", { headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
    assert.equal((await fetch(base + "/display/assets/kiosk.js", { headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
    assert.equal((await fetch(base + "/api/kiosk/pair/start", { method: "POST", headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
  } finally { srv.close(); }
});

test("the display ticket mount is never a public-funnel path", async () => {
  const { PUBLIC_FUNNEL_PREFIXES } = await import("../servers/gateway/funnel.js");
  for (const p of ["/display/t", "/display/t/"]) assert.ok(!PUBLIC_FUNNEL_PREFIXES.some((x) => p.startsWith(x) || x.startsWith(p)), p);
  const app = express();
  app.use(rejectFunneledMiddleware());
  app.all("/display/t/:ticket/stream", (req, res) => res.send("audio"));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(base + "/display/t/AAAAAAAAAAAAAAAAAAAAAA/stream", { headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
    assert.equal((await fetch(base + "/display/t/AAAAAAAAAAAAAAAAAAAAAA/stream", { method: "HEAD", headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
    assert.equal((await fetch(base + "/display/t/AAAAAAAAAAAAAAAAAAAAAA/stream")).status, 200, "without the Funnel header the stub answers: the 403 above is the Funnel refusal");
  } finally { srv.close(); }
});

// Plan 2026-10-15 (exposure check judges only this gateway's paths): the Nest
// exposure check and the middleware must read ONE allowlist.
test("funnel: effectiveFunnelPrefixes() is the static list plus the env entries the middleware enforces", async () => {
  const { effectiveFunnelPrefixes, PUBLIC_FUNNEL_PREFIXES } = await import("../servers/gateway/funnel.js");
  process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES = "/s/,/s, /s-assets/ ,not-a-path";
  try {
    assert.deepEqual(effectiveFunnelPrefixes(), [...PUBLIC_FUNNEL_PREFIXES, "/s/", "/s", "/s-assets/"]);
    for (const p of effectiveFunnelPrefixes()) {
      const probe = p.endsWith("/") ? p + "x" : p;
      assert.equal(runFunnelMw(probe).nexted, true, `${probe} is in the effective list, so the middleware passes it`);
    }
  } finally {
    delete process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES;
  }
  assert.deepEqual(effectiveFunnelPrefixes(), [...PUBLIC_FUNNEL_PREFIXES]);
});

test("funnel: a lone '/' in GATEWAY_FUNNEL_PUBLIC_PREFIXES is ignored, never opens every path", async () => {
  const { effectiveFunnelPrefixes } = await import("../servers/gateway/funnel.js");
  process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES = "/, /s/";
  const origWarn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    assert.ok(!effectiveFunnelPrefixes().includes("/"));
    assert.equal(runFunnelMw("/dashboard").statusCode, 403);
    assert.equal(runFunnelMw("/s/family").nexted, true, "the other entries still apply");
    assert.ok(warned.some((w) => /GATEWAY_FUNNEL_PUBLIC_PREFIXES/.test(w)), "the dropped entry is logged");
    const before = warned.length;
    effectiveFunnelPrefixes();
    effectiveFunnelPrefixes();
    assert.equal(warned.length, before, "the warning is logged once, not on every health check");
  } finally {
    console.warn = origWarn;
    delete process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES;
  }
});

test("gatewayListenPort: PORT, then CROW_GATEWAY_PORT, then 3001", async () => {
  const { gatewayListenPort } = await import("../servers/gateway/listen-port.js");
  assert.equal(gatewayListenPort({}), 3001);
  assert.equal(gatewayListenPort({ CROW_GATEWAY_PORT: "3008" }), 3008);
  assert.equal(gatewayListenPort({ PORT: "3009", CROW_GATEWAY_PORT: "3008" }), 3009);
});

test("funnel: /blog stays in PUBLIC_FUNNEL_PREFIXES (the public blog surface; tailnet-only content under /blog needs its own Funnel block)", async () => {
  // Moved here from the retired source-archive route test. Every route mounted
  // under /blog is public over Funnel by default; anything that must stay
  // tailnet-only under /blog has to reject the Funnel header itself.
  const { PUBLIC_FUNNEL_PREFIXES } = await import("../servers/gateway/funnel.js");
  assert.ok(PUBLIC_FUNNEL_PREFIXES.includes("/blog"));
});

// ---------------------------------------------------------------------------
// P0 network-check hardening: the gate trusts the socket peer.
// The classifier and the socket-owner check are unit-tested in
// tests/peer-class.test.js; these cases pin the gate, the Express wiring, the
// public paths and the consumers built on them.
// ---------------------------------------------------------------------------
import { classifyPeer, resolveClientMiddleware, trustedProxyList } from "../servers/shared/peer-class.js";
import { setProcNetReaderForTests, resetPeerWarningsForTests, procV4Hex, procV6Hex } from "../servers/shared/peer-uid.js";
import { authorizeExtensionUpgrade } from "../servers/gateway/routes/extension-proxy.js";
import { dashboardLoginKey } from "../servers/gateway/middleware/rate-limit.js";
import { requireLocalhost } from "../servers/gateway/routes/admin-backup.js";
import { isLanRequest } from "../bundles/knowledge-base/routes/kb-public.js";
import { PUBLIC_FUNNEL_PREFIXES, effectiveFunnelPrefixes } from "../servers/gateway/funnel.js";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

const PROC_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const pport = (p) => p.toString(16).padStart(4, "0").toUpperCase();
const prow = (local, rem, st, uid) => `   0: ${local} ${rem} ${st} 00000000:00000000 00:00000000 00000000 ${uid}        0 1 1 0 20 4 30 10 -1`;
/** A procfs whose only connection is client 127.0.0.1:41000 (uid `uid`) → server 127.0.0.1:3001. */
function procWithClientUid(uid, { v6 = false } = {}) {
  const tables = { tcp: PROC_HEADER + "\n", tcp6: PROC_HEADER + "\n" };
  if (v6) tables.tcp6 += prow(`${procV6Hex("::1")}:${pport(41000)}`, `${procV6Hex("::1")}:${pport(3001)}`, "01", uid) + "\n";
  else tables.tcp += prow(`${procV4Hex("127.0.0.1")}:${pport(41000)}`, `${procV4Hex("127.0.0.1")}:${pport(3001)}`, "01", uid) + "\n";
  setProcNetReaderForTests((name) => tables[name]);
}
const LOOP = (over = {}) => ({ remoteAddress: "127.0.0.1", remotePort: 41000, localAddress: "127.0.0.1", localPort: 3001, ...over });
const rawReq = (headers, socket) => ({ headers, socket }); // an upgrade IncomingMessage: no ip, no Express

function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const done = () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let out;
  try { out = fn(); } catch (e) { done(); throw e; }
  if (out && typeof out.then === "function") return out.finally(done);
  done();
  return out;
}
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

test("lane A (a): a forged Tailscale-User-Login from a non-loopback PUBLIC peer is refused; from a LAN peer it is allowed on the address alone and carries no login", () => {
  quiet(() => {
    assert.equal(isAllowedNetwork(mkReq({ ip: "203.0.113.7", headers: { "tailscale-user-login": "owner@example.com" } })), false);
    const lan = mkReq({ ip: "10.0.0.5", headers: { "tailscale-user-login": "owner@example.com" } });
    assert.equal(isAllowedNetwork(lan), true);
    assert.equal(classifyPeer(lan).tailnetLogin, null);
  });
});

test("a forged Tailscale-User-Login (Serve-shaped) from a loopback peer that is NOT tailscaled's uid is refused", () => {
  resetPeerWarningsForTests();
  procWithClientUid(1000);
  try {
    quiet(() => {
      const req = rawReq(serveHeaders("owner@example.com"), LOOP());
      assert.equal(classifyPeer(req).via, "unverified");
      assert.equal(isAllowedNetwork(req), false);
      // The same login header with no Serve shape at all: refused too.
      assert.equal(isAllowedNetwork(rawReq({ "tailscale-user-login": "owner@example.com" }, LOOP({ remotePort: 41001 }))), false);
    });
    // The genuine article: the same connection owned by uid 0.
    procWithClientUid(0);
    assert.equal(isAllowedNetwork(rawReq(serveHeaders("owner@example.com"), LOOP())), true);
  } finally { setProcNetReaderForTests(null); }
});

test("lane A (b): a forged X-Forwarded-For from loopback with no configured proxy is unverified and refused", () => {
  quiet(() => withEnv({ CROW_TRUSTED_PROXIES: undefined }, () => {
    const req = mkReq({ ip: "127.0.0.1", headers: { "x-forwarded-for": "10.0.0.9" } });
    assert.equal(classifyPeer(req).via, "unverified");
    assert.equal(isAllowedNetwork(req), false);
  }));
});

test("Serve shape (uid 0): tailnet, tagged node, IPv6 tailnet allowed; two XFF values or an X-Real-IP alongside refused", () => {
  procWithClientUid(0);
  try {
    quiet(() => {
      assert.equal(isAllowedNetwork(rawReq(serveHeaders("a@example.com"), LOOP())), true);
      assert.equal(isAllowedNetwork(rawReq(serveHeaders(null), LOOP())), true, "tagged node: no login, still tailnet");
      assert.equal(isAllowedNetwork(rawReq(serveHeaders(null, "fd7a:115c:a1e0::1"), LOOP())), true, "IPv6 tailnet client through Serve");
      assert.equal(isAllowedNetwork(rawReq({ ...serveHeaders(), "x-forwarded-for": "100.64.20.5, 100.64.20.6" }, LOOP())), false);
      assert.equal(isAllowedNetwork(rawReq({ ...serveHeaders(), "x-real-ip": "8.8.8.8" }, LOOP())), false, "a hop takes trust away");
      assert.equal(isAllowedNetwork(rawReq({ ...serveHeaders(), "tailscale-funnel-request": "?1" }, LOOP())), false);
    });
  } finally { setProcNetReaderForTests(null); }
});

test("IPv6 tailnet: a direct fd7a:115c:a1e0::/48 peer (and its v4-mapped tailnet cousin) is allowed; LAN IPv6 is not", () => {
  assert.equal(isAllowedNetwork(mkReq({ ip: "fd7a:115c:a1e0::1234" })), true);
  assert.equal(isAllowedNetwork(mkReq({ ip: "::ffff:100.64.20.5" })), true);
  assert.equal(isAllowedNetwork(mkReq({ ip: "fd00::5" })), false);
  assert.equal(isAllowedNetwork(mkReq({ ip: "fd7a:115c:a1e1::1" })), false);
  procWithClientUid(0, { v6: true });
  try {
    assert.equal(isAllowedNetwork(rawReq(serveHeaders(null, "fd7a:115c:a1e0::9"), LOOP({ remoteAddress: "::1", localAddress: "::1" }))), true, "Serve over ::1 naming an IPv6 tailnet client");
  } finally { setProcNetReaderForTests(null); }
});

test("direct peers: forwarding headers can only take trust away", () => {
  quiet(() => {
    assert.equal(isAllowedNetwork(mkReq({ ip: "203.0.113.7", headers: { "x-forwarded-for": "10.0.0.9" } })), false);
    assert.equal(isAllowedNetwork(mkReq({ ip: "10.0.0.5", headers: { "x-forwarded-for": "8.8.8.8" } })), false);
    assert.equal(isAllowedNetwork(mkReq({ ip: "10.0.0.5" })), true);
  });
});

test("declared proxy: CROW_TRUSTED_PROXIES=loopback → every hop must be trusted; the login header is ignored", () => {
  withEnv({ CROW_TRUSTED_PROXIES: "loopback" }, () => {
    assert.equal(isAllowedNetwork(mkReq({ headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.9" } })), false);
    const ok = mkReq({ headers: { "x-forwarded-for": "10.0.0.9", "tailscale-user-login": "a@b" } });
    assert.equal(isAllowedNetwork(ok), true);
    assert.equal(classifyPeer(ok).client, "10.0.0.9");
    assert.equal(classifyPeer(ok).tailnetLogin, null);
    assert.equal(isAllowedNetwork(mkReq({ headers: {} })), false, "the proxy itself naming no client is not a client");
  });
});

test("household container: docker-proxy's bridge gateway declared → per-user tailnet client; undeclared → every user shares the bridge address", () => {
  quiet(() => {
    const req = () => mkReq({ ip: "::ffff:172.18.0.1", headers: { "x-forwarded-for": "100.64.20.7", "x-forwarded-host": "crow.example.ts.net:8453" } });
    withEnv({ CROW_TRUSTED_PROXIES: "172.18.0.1" }, () => {
      const r = req();
      assert.equal(classifyPeer(r).via, "proxy");
      assert.equal(classifyPeer(r).client, "100.64.20.7");
      assert.equal(isAllowedNetwork(r), true);
    });
    withEnv({ CROW_TRUSTED_PROXIES: undefined }, () => {
      const r = req();
      assert.equal(classifyPeer(r).via, "direct");
      assert.equal(classifyPeer(r).client, "172.18.0.1");
      assert.equal(isAllowedNetwork(r), true, "today's answer kept: an RFC1918 socket with a tailnet hop");
    });
  });
});

test("§3.9 front door: a Serve client that is a declared relay is allowed but its login is withheld", () => {
  procWithClientUid(0);
  try {
    withEnv({ CROW_TRUSTED_PROXIES: "100.64.20.9" }, () => {
      const r = rawReq(serveHeaders("owner@example.com", "100.64.20.9"), LOOP());
      assert.equal(isAllowedNetwork(r), true);
      assert.equal(classifyPeer(r).tailnetLogin, null);
      assert.equal(dashboardLoginKey(Object.assign(r, { ip: "100.64.20.9", crowPeer: classifyPeer(r) })), "100.64.20.9:");
    });
  } finally { setProcNetReaderForTests(null); }
});

// ---- real Express: trust proxy + resolveClientMiddleware --------------------
function echoApp() {
  const app = express();
  app.set("trust proxy", trustedProxyList());
  app.use(rejectFunneledMiddleware());
  app.use(resolveClientMiddleware());
  app.get(/.*/, (req, res) => res.json({ ip: req.ip, via: req.crowPeer.via, protocol: req.protocol, allowed: isAllowedNetwork(req) }));
  return new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
}
const getJson = async (port, path, headers) => { const r = await request(port, path, headers); return { status: r.status, body: r.status === 200 ? JSON.parse(r.body) : null }; };

test("Express wiring: a forged XFF from loopback keeps req.ip = 127.0.0.1; Serve (this process standing in for tailscaled) gets the tailnet client and https", async () => {
  await withEnv({ CROW_TRUSTED_PROXIES: undefined, CROW_SERVE_PEER_UIDS: undefined }, async () => {
    const w = console.warn; console.warn = () => {};
    const s = await echoApp();
    try {
      const port = s.address().port;
      const forged = await getJson(port, "/x", { "x-forwarded-for": "10.0.0.9" });
      assert.deepEqual([forged.body.ip, forged.body.via, forged.body.allowed], ["127.0.0.1", "unverified", false]);
      const notTs = await getJson(port, "/x", serveHeaders("owner@example.com"));
      assert.deepEqual([notTs.body.ip, notTs.body.via, notTs.body.allowed], ["127.0.0.1", "unverified", false], "this process is not uid 0: the bot case, end to end");
      actAsServe();
      const serve = await getJson(port, "/x", { ...serveHeaders("owner@example.com"), "x-forwarded-proto": "https" });
      assert.deepEqual([serve.body.ip, serve.body.via, serve.body.protocol, serve.body.allowed], ["100.64.20.5", "serve", "https", true]);
    } finally { s.close(); console.warn = w; }
  });
});

test("Express wiring: a declared proxy sets req.ip through Express's own trust proxy; express-rate-limit raises no validation error", async () => {
  const { default: rateLimit } = await import("express-rate-limit");
  await withEnv({ CROW_TRUSTED_PROXIES: "loopback" }, async () => {
    const errs = [];
    const e = console.error, w = console.warn;
    console.error = (...a) => errs.push(a.join(" "));
    console.warn = (...a) => errs.push(a.join(" "));
    const app = express();
    app.set("trust proxy", trustedProxyList());
    app.use(resolveClientMiddleware());
    app.use(rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false }));
    app.get("/x", (req, res) => res.json({ ip: req.ip, via: req.crowPeer.via }));
    const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
    try {
      const r = await getJson(s.address().port, "/x", { "x-forwarded-for": "1.2.3.4, 10.0.0.9" });
      assert.deepEqual(r.body, { ip: "10.0.0.9", via: "proxy" });
      const bare = await getJson(s.address().port, "/x", {});
      assert.equal(bare.body.ip, "127.0.0.1");
    } finally { s.close(); console.error = e; console.warn = w; }
    assert.ok(!errs.some((l) => l.includes("ERR_ERL_")), errs.join("\n"));
  });
  await withEnv({ CROW_TRUSTED_PROXIES: undefined }, async () => {
    const errs = [];
    const e = console.error, w = console.warn;
    console.error = (...a) => errs.push(a.join(" "));
    console.warn = () => {};
    const app = express();
    app.set("trust proxy", trustedProxyList());
    app.use(rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false }));
    app.get("/x", (req, res) => res.json({ ip: req.ip }));
    const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
    try {
      assert.equal((await getJson(s.address().port, "/x", { "x-forwarded-for": "10.0.0.9" })).body.ip, "127.0.0.1", "default: trust no one");
    } finally { s.close(); console.error = e; console.warn = w; }
    assert.ok(!errs.some((l) => l.includes("ERR_ERL_")), errs.join("\n"));
  });
});

// ---- every public Funnel path, through the real middleware stack ------------
test("public Funnel paths pass (req.ip = the public client) and private ones are 403, behind resolveClient + rejectFunneled", async () => {
  await withEnv({ GATEWAY_FUNNEL_PUBLIC_PREFIXES: "/s/,/s,/s-assets/", CROW_SERVE_PEER_UIDS: undefined }, async () => {
    actAsServe();
    const s = await echoApp();
    const funnel = (xff = "8.8.8.8") => ({ "tailscale-funnel-request": "?1", "x-forwarded-for": xff, "x-forwarded-host": "crow.example.ts.net", "x-forwarded-proto": "https" });
    try {
      const port = s.address().port;
      const publicPaths = ["/blog", "/blog/x", "/robots.txt", "/sitemap.xml", "/.well-known/oauth-authorization-server", "/favicon.ico", "/manifest.json", "/s", "/s/x", "/s-assets/i.png"];
      // Every allowlisted entry is exercised (a new entry without a probe here fails the test).
      for (const p of effectiveFunnelPrefixes()) {
        const probe = p.endsWith("/") ? p + "x" : p;
        assert.ok(publicPaths.some((q) => q === probe || (p.endsWith("/") && q.startsWith(p))), `no probe for ${p}`);
      }
      for (const path of publicPaths) {
        const r = await getJson(port, path, funnel());
        assert.equal(r.status, 200, path);
        assert.deepEqual([r.body.ip, r.body.via, r.body.allowed], ["8.8.8.8", "funnel", false], path);
      }
      for (const path of ["/dashboard", "/s-assets", "/robots.txt/", "/router/mcp"]) {
        assert.equal((await request(port, path, funnel())).status, 403, path);
      }
      // A Funnel shape naming a non-public address (review critical 4): still public pages, but req.ip stays the socket.
      const w = console.warn; console.warn = () => {};
      try {
        const odd = await getJson(port, "/blog", funnel("10.0.0.9"));
        assert.deepEqual([odd.status, odd.body.ip, odd.body.via], [200, "127.0.0.1", "unverified"]);
        assert.equal((await request(port, "/dashboard", funnel("10.0.0.9"))).status, 403);
      } finally { console.warn = w; }
    } finally { s.close(); }
  });
});

// ---- WebSocket upgrades (no Express: the gate works on the raw request) -----
test("WebSocket upgrade (extension proxy): the network gate answers on the raw IncomingMessage", async () => {
  procWithClientUid(0);
  try {
    assert.equal(isAllowedNetwork(rawReq(serveHeaders("a@example.com"), LOOP())), true, "Serve, uid 0: passes the network layer");
    assert.equal(isAllowedNetwork(rawReq(serveHeaders(null, "fd7a:115c:a1e0::1"), LOOP())), true, "tagged node over IPv6 Serve");
    procWithClientUid(1000);
    const w = console.warn; console.warn = () => {};
    try {
      for (const [label, req] of [
        ["Serve shape from uid 1000", rawReq({ ...serveHeaders("a@example.com"), cookie: "crow_session=x" }, LOOP())],
        ["forged login from a public socket", rawReq({ "tailscale-user-login": "a@example.com", cookie: "crow_session=x" }, { remoteAddress: "203.0.113.7" })],
        ["Funnel header", rawReq({ "tailscale-funnel-request": "?1", "x-forwarded-for": "8.8.8.8", cookie: "crow_session=x" }, LOOP({ remotePort: 41002 }))],
      ]) {
        assert.equal(isAllowedNetwork(req), false, label);
        assert.equal(await authorizeExtensionUpgrade(req), false, label);
      }
    } finally { console.warn = w; }
  } finally { setProcNetReaderForTests(null); }
});

test("token-only upgrade paths (calls signaling, companion) are never Funnel-public by default", () => {
  for (const p of ["/calls/ws", "/companion/client-ws", "/client-ws"]) {
    assert.ok(!PUBLIC_FUNNEL_PREFIXES.some((x) => (x.endsWith("/") ? p.startsWith(x) : p === x)), p);
    assert.ok(!effectiveFunnelPrefixes().some((x) => (x.endsWith("/") ? p.startsWith(x) : p === x)), p);
  }
});

// ---- consumers --------------------------------------------------------------
function runRequireLocalhost(req) {
  let status = null, nexted = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  requireLocalhost(req, res, () => { nexted = true; });
  return nexted ? "next" : status;
}

test("admin-backup requireLocalhost: bare loopback passes; Serve and loopback with a forged XFF are 403", () => {
  procWithClientUid(0);
  try {
    quiet(() => {
      assert.equal(runRequireLocalhost(mkReq({ ip: "127.0.0.1" })), "next");
      assert.equal(runRequireLocalhost(rawReq(serveHeaders(), LOOP())), 403);
      assert.equal(runRequireLocalhost(mkReq({ ip: "127.0.0.1", headers: { "x-forwarded-for": "127.0.0.1" } })), 403);
      assert.equal(runRequireLocalhost(mkReq({ ip: "10.0.0.5" })), 403);
    });
  } finally { setProcNetReaderForTests(null); }
});

test("KB isLanRequest keeps today's meaning: local and RFC1918 only, never the tailnet, Serve, Funnel or a front door", () => {
  procWithClientUid(0);
  const lan = (req) => isLanRequest(Object.assign(req, { crowPeer: classifyPeer(req) }));
  try {
    quiet(() => {
      assert.equal(lan(mkReq({ ip: "127.0.0.1" })), true, "local");
      assert.equal(lan(rawReq(serveHeaders(), LOOP())), false, "Serve tailnet");
      assert.equal(lan(rawReq(serveHeaders(null, "100.64.20.9"), LOOP({ remotePort: 41000 }))), false, "front door chained into Serve");
      assert.equal(lan(rawReq({ "tailscale-funnel-request": "?1", "x-forwarded-for": "8.8.8.8" }, LOOP())), false, "Funnel");
      assert.equal(lan(mkReq({ ip: "127.0.0.1", headers: { "x-forwarded-for": "10.0.0.9" } })), false, "unverified");
      assert.equal(lan(mkReq({ ip: "192.168.1.9" })), true, "direct RFC1918");
      assert.equal(lan(mkReq({ ip: "100.64.20.5" })), false, "direct tailnet");
      withEnv({ CROW_TRUSTED_PROXIES: "172.18.0.1" }, () => {
        assert.equal(lan(mkReq({ ip: "172.18.0.1", headers: { "x-forwarded-for": "10.0.0.9" } })), true, "proxy, RFC1918 client");
        assert.equal(lan(mkReq({ ip: "172.18.0.1", headers: { "x-forwarded-for": "100.64.20.7" } })), false, "proxy, tailnet client (household container)");
      });
    });
  } finally { setProcNetReaderForTests(null); }
});

test("maker-lab isLoopback: only a bare local peer, never Serve", async () => {
  const { isLoopback } = await import("../bundles/maker-lab/server/device-binding.js");
  procWithClientUid(0);
  try {
    assert.equal(isLoopback(mkReq({ ip: "127.0.0.1" })), true);
    assert.equal(isLoopback(rawReq(serveHeaders(), LOOP())), false);
    assert.equal(isLoopback(mkReq({ ip: "10.0.0.5" })), false);
  } finally { setProcNetReaderForTests(null); }
});

test("dashboard login limiter key: a rotated Tailscale-User-Login on a direct peer keeps the same key", () => {
  const key = (login) => { const r = mkReq({ ip: "10.0.0.5", headers: { "tailscale-user-login": login } }); r.ip = "10.0.0.5"; r.crowPeer = classifyPeer(r); return dashboardLoginKey(r); };
  assert.equal(key("a@example.com"), key("b@example.com"));
  assert.equal(key("a@example.com"), "10.0.0.5:");
});
