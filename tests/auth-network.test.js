import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { isAllowedNetwork } from "../servers/gateway/dashboard/auth.js";
import { rejectFunneledMiddleware } from "../servers/gateway/funnel.js";

function mkReq({ ip = "127.0.0.1", headers = {} } = {}) {
  return { ip, headers, connection: { remoteAddress: ip } };
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

test("isAllowedNetwork: Tailscale-User-Login alone is sufficient", () => {
  assert.equal(
    isAllowedNetwork(mkReq({ headers: { "tailscale-user-login": "alice@example.com" } })),
    true,
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
    for (const path of ["/dashboard/nest", "/router/mcp", "/api/chat/conversations", "/storage/upload", "/dashboard/frigate", "/api/frigate/cameras", "/frigate/", "/dashboard/motioneye", "/llm/v1/chat/completions", "/llm/v1/models", "/"]) {
      const r = await request(port, path, { "tailscale-funnel-request": "?1" });
      assert.equal(r.status, 403, `expected 403 on ${path}, got ${r.status}`);
    }
  } finally {
    server.close();
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
