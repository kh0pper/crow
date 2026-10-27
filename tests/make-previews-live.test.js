/**
 * Task 4.5, live: Make's preview job end to end in the fixture's headless Chrome over
 * its pipe (the same CDP framing as the preview container; no Docker, no DevTools port).
 * A real artifact origin (startArtifactOrigin, a real view-token store, a stub content
 * resolver), the real bounded fetcher to its bind address (previewFetcher), the real
 * renderInContext and isNearBlank, and the REAL dashboard router serving the result.
 * Only the renderer's lease is a stand-in: it hands out the fixture's CDP client.
 *
 * Follows tests/fixtures/headless-chrome.mjs: no Chrome skips, unless
 * CROW_REQUIRE_TEST_CHROME=1, which makes a missing Chrome a failure.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "make-previews-live-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
mkdirSync(join(process.env.CROW_HOME, "bundles", "artifacts"), { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-make-previews-live");
const REPO = new URL("..", import.meta.url).pathname;
cpSync(join(REPO, "bundles", "artifacts", "manifest.json"), join(process.env.CROW_HOME, "bundles", "artifacts", "manifest.json"));
writeFileSync(join(process.env.CROW_HOME, "installed.json"), JSON.stringify([{ id: "artifacts" }]));

const ARTIFACT_HOST = "artifacts.example.test";
const HTML = "text/html; charset=utf-8";
const XHTML = "application/xhtml+xml; charset=utf-8";
const MiB = 1024 * 1024;

let chrome = null, db, server, base, origin, P, isNearBlank, deps;
const content = new Map(); // artifactId -> { [path]: { body, contentType } }
const leases = { held: 0, releases: [] };

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

let seq = 0;
async function art(type, files) {
  const id = `art_live${String(++seq).padStart(4, "0")}`;
  const hash = `${String(seq).padStart(2, "0")}`.repeat(32);
  content.set(id, files);
  await db.execute({ sql: "INSERT INTO artifacts (id,title,type,current_version,received) VALUES (?,?,?,1,0)", args: [id, `Live ${id}`, type] });
  await db.execute({
    sql: "INSERT INTO artifact_versions (artifact_id,n,state,files_json,size,content_hash,made_by,untrusted_input) VALUES (?,1,'current','[]',1,?,'user',0)",
    args: [id, hash],
  });
  return { id, hash };
}

/** Render one artifact through ensureArtifactPreview + the queue; return { ready, png }. */
async function renderAndServe(id) {
  assert.equal((await P.ensureArtifactPreview(db, id, deps)).status, "pending");
  await deps.queue.idle();
  const ready = await P.ensureArtifactPreview(db, id, deps);
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  assert.ok(existsSync(ready.file));
  const r = await fetch(base + ready.url, { headers: { ...serveHeaders("operator@example.com"), cookie: "crow_session=live-sess; crow_csrf=tok" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  const png = Buffer.from(await r.arrayBuffer());
  assert.ok(png.equals(readFileSync(ready.file)));
  return { ready, png };
}

before(async () => {
  chrome = await startHeadlessChrome({ pipe: true, extraArgs: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${ARTIFACT_HOST}`] });
  if (!chrome) return;

  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), '2026-06-01 00:00:00')").run(hashToken("live-sess"));
  c.close();
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  const { initArtifactsTables } = await import("../bundles/artifacts/server/init-tables.js");
  await initArtifactsTables(db);

  P = await import("../servers/gateway/make/previews.js");
  const render = await import("../servers/gateway/preview/render.js");
  isNearBlank = render.isNearBlank;
  const { startArtifactOrigin } = await import("../servers/gateway/artifact-origin/server.js");
  const { createViewTokenStore } = await import("../servers/gateway/artifact-origin/view-tokens.js");
  const { createOriginFetcher } = await import("../servers/gateway/preview/origin-fetch.js");

  const tokens = createViewTokenStore();
  const port = await freePort();
  const baseUrl = `http://${ARTIFACT_HOST}:${port}`;
  origin = await startArtifactOrigin({
    port, host: "127.0.0.1", tokens, publicBase: baseUrl,
    resolveContent: async ({ artifactId, path }) => (content.get(artifactId) || {})[path] || null,
  });
  const info = { baseUrl, port, bindHost: "127.0.0.1" };
  const renderer = {
    async acquire() {
      leases.held++;
      let held = true;
      return { cdp: chrome.cdp, release(o) { if (!held) return; held = false; leases.held--; leases.releases.push(o); } };
    },
    lastOff: () => null,
  };
  deps = {
    dataDir: dir, queue: P.createPreviewQueue(), renderer, info, tokens, jobDb: db,
    fetcher: P.previewFetcher({ info, create: createOriginFetcher }),
    render: render.renderInContext, nearBlank: render.isNearBlank, now: Date.now,
    workspacePreview: async () => null,
  };
  P._setPreviewDepsForTest(deps);

  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(dashboardRouter((req, res, next) => next(), { renderLayout }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  P?._setPreviewDepsForTest(null);
  if (server) server.close();
  if (origin) { origin.closeAllConnections?.(); origin.close(); }
  await chrome?.close();
  try { db?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

test("a trusted two-block document renders and is served", { timeout: 60_000 }, async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const a = await art("document", {
    "index.html": {
      contentType: HTML,
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Garden plan</title><style>body{font:22px serif;margin:24px;color:#111;background:#fff}h1{font-size:40px}section{border:4px solid #264;padding:12px;margin:12px 0}</style></head>
<body><section><h1>Garden plan</h1><p>Tomatoes along the south fence, beans on the trellis.</p></section><section><h2>Watering</h2><p>Every second morning, more in a heat wave.</p></section></body></html>`,
    },
  });
  const { png } = await renderAndServe(a.id);
  assert.equal(await isNearBlank(png), false);
  assert.equal(leases.held, 0);
});

test("a trusted diagram (application/xhtml+xml) renders and is served", { timeout: 60_000 }, async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const a = await art("diagram", {
    "index.html": {
      contentType: XHTML,
      body: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Flow</title></head><body style="margin:0;background:#fff">
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect x="40" y="60" width="220" height="120" fill="#246" /><rect x="380" y="220" width="220" height="120" fill="#a42" /><line x1="260" y1="120" x2="380" y2="280" stroke="#111" stroke-width="8" /></svg></body></html>`,
    },
  });
  const { png } = await renderAndServe(a.id);
  assert.equal(await isNearBlank(png), false);
});

test("a resource over 8 MB is missing, and the preview is saved", { timeout: 60_000 }, async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const big = Buffer.alloc(9 * MiB, 0x41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
  const a = await art("document", {
    "index.html": {
      contentType: HTML,
      body: `<!doctype html><html><head><meta charset="utf-8"><style>body{font:24px serif;margin:24px;background:#fff;color:#111}h1{font-size:48px}</style></head>
<body><h1>A big picture</h1><img src="big.png" width="300" height="150" alt="big"></body></html>`,
    },
    "big.png": { contentType: "image/png", body: big },
  });
  // Record what the real fetcher answered: the 9 MiB asset is cut at the 8 MB cap.
  const real = deps.fetcher;
  const log = [];
  deps.fetcher = { session(o) { const s = real.session(o); return { async get(p) { const r = await s.get(p); log.push({ p, ok: r.ok, reason: r.reason }); return r; }, stats: () => s.stats() }; } };
  let ready, png;
  try { ({ ready, png } = await renderAndServe(a.id)); } finally { deps.fetcher = real; }
  const bigGet = log.find((e) => e.p.endsWith("/big.png"));
  assert.ok(bigGet, JSON.stringify(log));
  assert.deepEqual({ ok: bigGet.ok, reason: bigGet.reason }, { ok: false, reason: "cap_response" });
  assert.ok(png.length > 0);
  assert.equal(await isNearBlank(png), false, "the heading is in the capture");
  assert.ok(existsSync(ready.file));
});
