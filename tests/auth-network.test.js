import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { isAllowedNetwork } from "../servers/gateway/dashboard/auth.js";

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

// Integration test for the rejectFunneled middleware. We rebuild the
// middleware inline so the test doesn't need to boot the full gateway
// (which initializes DB, MCP servers, etc.).
function makeFunnelMiddleware() {
  const PUBLIC_FUNNEL_PREFIXES = [
    "/blog",
    "/robots.txt",
    "/sitemap.xml",
    "/.well-known/",
    "/favicon.ico",
    "/manifest.json",
  ];
  return (req, res, next) => {
    if (!req.headers["tailscale-funnel-request"]) return next();
    if (process.env.CROW_DASHBOARD_PUBLIC === "true") return next();
    if (PUBLIC_FUNNEL_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))) return next();
    res.status(403).type("text/plain").send("Forbidden: private path not reachable via Tailscale Funnel.");
  };
}

function startTestApp() {
  const app = express();
  app.use(makeFunnelMiddleware());
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
    for (const path of ["/dashboard/nest", "/router/mcp", "/api/chat/conversations", "/storage/upload", "/dashboard/frigate", "/api/frigate/cameras", "/frigate/", "/"]) {
      const r = await request(port, path, { "tailscale-funnel-request": "?1" });
      assert.equal(r.status, 403, `expected 403 on ${path}, got ${r.status}`);
    }
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
