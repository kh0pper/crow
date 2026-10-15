/**
 * The public embed API is reachable anonymously over Funnel. A failure must
 * not hand the caller internal error text (SQL, table names, paths); it is
 * logged server-side instead.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import express from "express";

const ROOT = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "blog-embed-errors-"));
let server;
let base;

before(async () => {
  // init-db only: no data-dashboard tables, so the section lookup throws.
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") },
    stdio: "pipe",
    cwd: ROOT,
  });
  process.env.CROW_DB_PATH = join(dir, "crow.db");
  const { blogEmbedApiRouter } = await import("../servers/gateway/routes/blog-embed-api.js");
  const app = express();
  app.use(blogEmbedApiRouter());
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("chart data: a 500 carries no internal detail; the error is logged server-side", async () => {
  const logged = [];
  const origWarn = console.warn;
  console.warn = (...args) => logged.push(args.join(" "));
  let r;
  try {
    r = await fetch(`${base}/blog/api/chart/1/data.json`, { headers: { "Tailscale-Funnel-Request": "?1" } });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.deepEqual(body, { error: "internal_error" });
  assert.ok(logged.some((l) => /chart data error/.test(l) && /no such table/i.test(l)), "logged with the real message");
});
