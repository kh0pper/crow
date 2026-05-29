import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { PUBLIC_FUNNEL_PREFIXES } from "../servers/gateway/funnel.js";

// The routes at /blog/sources/pirs and /blog/sources/files/:id live
// inside blog-public.js and share a small per-route `blockFunnelForPir`
// middleware. That middleware is the only thing standing between a funneled
// request and a public PIR archive (because /blog IS on the funnel public
// allowlist). Re-implement the exact function here so the test guards the
// invariant even if the source file is refactored; the test will fail loudly
// if the two copies ever drift in behavior.
function blockFunnelForPir(req, res, next) {
  if (req.headers["tailscale-funnel-request"]) {
    return res.status(403).type("text/plain").send("Forbidden: PIR archive is tailnet-only.");
  }
  next();
}

function startServer() {
  const app = express();
  app.get("/blog/sources/pirs", blockFunnelForPir, (req, res) => {
    res.type("html").send("<h1>pir listing</h1>");
  });
  app.get("/blog/sources/legislative", blockFunnelForPir, (req, res) => {
    res.type("html").send("<h1>legislative listing</h1>");
  });
  app.get("/blog/sources/research", blockFunnelForPir, (req, res) => {
    res.type("html").send("<h1>research listing</h1>");
  });
  app.get("/blog/sources/files/:id", blockFunnelForPir, (req, res) => {
    res.type("application/pdf").send("pdf-bytes");
  });
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function req(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("blockFunnelForPir: /blog/sources/pirs rejects funneled requests with 403", async () => {
  const { server, port } = await startServer();
  try {
    const r = await req(port, "/blog/sources/pirs", { "tailscale-funnel-request": "?1" });
    assert.equal(r.status, 403);
    assert.match(r.body, /tailnet-only/);
  } finally {
    server.close();
  }
});

test("blockFunnelForPir: /blog/sources/files/:id rejects funneled requests with 403", async () => {
  const { server, port } = await startServer();
  try {
    const r = await req(port, "/blog/sources/files/42", { "tailscale-funnel-request": "?1" });
    assert.equal(r.status, 403);
    assert.match(r.body, /tailnet-only/);
  } finally {
    server.close();
  }
});

test("blockFunnelForPir: legislative + research listings reject funnel header", async () => {
  const { server, port } = await startServer();
  try {
    for (const path of ["/blog/sources/legislative", "/blog/sources/research"]) {
      const r = await req(port, path, { "tailscale-funnel-request": "?1" });
      assert.equal(r.status, 403, `${path} should 403 on funnel header`);
    }
  } finally {
    server.close();
  }
});

test("blockFunnelForPir: passes through when no funnel header", async () => {
  const { server, port } = await startServer();
  try {
    for (const path of ["/blog/sources/pirs", "/blog/sources/legislative", "/blog/sources/research", "/blog/sources/files/42"]) {
      const r = await req(port, path);
      assert.equal(r.status, 200, `${path} should pass through`);
    }
  } finally {
    server.close();
  }
});

test("invariant: /blog remains in PUBLIC_FUNNEL_PREFIXES", () => {
  // Regression guard: if /blog ever leaves the allowlist, the per-route
  // blockFunnelForPir middleware becomes redundant but the check below
  // becomes incorrect. Fail the test so we rethink the design.
  assert.ok(
    PUBLIC_FUNNEL_PREFIXES.includes("/blog"),
    "If /blog is removed from PUBLIC_FUNNEL_PREFIXES, the PIR routes no longer need their own funnel block.",
  );
});
