/**
 * Model catalog panel API routes (Item G, Task 12).
 *
 * Harness mirrors tests/models-registration.test.js's `freshLibsql()`
 * (real providers/oauth_tokens/dashboard_settings/pi_bot_defs schema via
 * `scripts/init-db.js`, CROW_DATA_DIR pointed at a scratch dir — never the
 * real ~/.crow) plus a boot-a-scratch-express-app step (the pattern
 * tests/board-stage-api.test.js / tests/settings-scope-guard.test.js use
 * for JSON route testing: real router, ephemeral `app.listen(0)`, plain
 * `fetch`).
 *
 * Auth is exercised for REAL (not stubbed): a session token is seeded
 * directly into `oauth_tokens` (same table/hash `dashboard/auth.js`'s
 * `verifySession` reads), and every authenticated request carries the
 * `Tailscale-User-Login` header so `isAllowedNetwork` passes over a plain
 * loopback socket without weakening the check globally via
 * CROW_DASHBOARD_PUBLIC (see `tests/extension-ws-auth.test.js`'s
 * `tailnetReq` for the same trick).
 *
 * The download ENGINE (`manager.js`'s `enqueueDownload`, real HTTPS to
 * huggingface.co) is stubbed — this file tests the route's gate/plumbing,
 * not the download engine itself (that's `tests/models-registration.test.js`
 * / manager.js's own test file's job). `registerModel`/`unregisterModel`/
 * `providerBindings` are the REAL implementations (no network, real DB).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import modelsRouter, { requireDashboardSessionJson, HF_TOKEN_PROVIDER_ID } from "../servers/gateway/routes/models.js";
import { setProviderSyncManager } from "../servers/shared/providers-db.js";

const repoRoot = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "models-panel-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: repoRoot,
  });
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    dir, db,
    async cleanup() {
      setProviderSyncManager(null);
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function hashToken(t) { return createHash("sha256").update(t).digest("hex"); }

/** Seed a valid dashboard session directly into oauth_tokens (same shape
 * `attemptLogin`/`verifySession` in dashboard/auth.js use). */
async function seedSession(db, token = "test-session-token") {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await db.execute({
    sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)",
    args: [hashToken(token), expiresAt],
  });
  return token;
}

/** Headers for an authenticated request: tailnet identity header (so
 * isAllowedNetwork passes over plain loopback) + the session cookie. */
function authHeaders(token, extra = {}) {
  return {
    "tailscale-user-login": "test@example.com",
    cookie: `crow_session=${token}`,
    ...extra,
  };
}

/** Headers for a request that passes the network check but carries no/a bad
 * session — isolates the SESSION half of the gate (see module doc). */
function noSessionHeaders() {
  return { "tailscale-user-login": "test@example.com" };
}

function makeCatalog() {
  return {
    version: 1,
    runtime: { name: "llama.cpp", release: "b10068", assets: {} },
    models: [
      {
        id: "panel-test-model",
        family: "TestFamily",
        lab: "TestLab",
        hf_repo: "test/panel-test-model-GGUF",
        license: "apache-2.0",
        gated: false,
        task: "chat",
        context_len: 8192,
        min_runtime_version: "b10068",
        default_quant: "Q4_K_M",
        first_run_default: true,
        tags: ["chat", "small"],
        notes: "test fixture",
        quants: [
          // fits: min_ram_mb (1000) well under probe's 4000 ramAvailableMb
          { file: "panel-test-model-Q4_K_M.gguf", quant: "Q4_K_M", size_mb: 500, min_ram_mb: 1000, min_vram_mb: 0, sha256: "abc" },
          // tight: min_ram_mb (4200) is within 1.10x of 4000
          { file: "panel-test-model-Q5_K_M.gguf", quant: "Q5_K_M", size_mb: 700, min_ram_mb: 4200, min_vram_mb: 0, sha256: "def" },
          // wont_fit: min_ram_mb way over even the 1.10x tolerance
          { file: "panel-test-model-Q8_0.gguf", quant: "Q8_0", size_mb: 2000, min_ram_mb: 20000, min_vram_mb: 0, sha256: "ghi" },
        ],
      },
    ],
  };
}

const FIXED_PROBE = {
  platform: "linux", wsl2: false, accel: "cpu", gpuName: null, vramMb: null,
  ramAvailableMb: 4000, diskFreeMb: 100_000, unknown: [],
};

/** Boot the router on an ephemeral port with the given opts merged onto
 * sane no-op defaults for anything a given test doesn't care about. */
async function withServer(opts, fn) {
  const app = express();
  app.use(express.json());
  app.use(modelsRouter((req, res, next) => next(), opts));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

test("requireDashboardSessionJson: exported for direct unit testing", () => {
  assert.equal(typeof requireDashboardSessionJson, "function");
});

test("GET /api/models/catalog: 401 with no/invalid session (network allowed)", async () => {
  const h = freshLibsql();
  try {
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog }, async (base) => {
      const r = await fetch(base + "/api/models/catalog", { headers: noSessionHeaders() });
      assert.equal(r.status, 401);
      const body = await r.json();
      assert.equal(body.code, "UNAUTHENTICATED");
    });
  } finally { await h.cleanup(); }
});

test("GET /api/models/catalog: 403 when the network check itself fails (bare loopback, no tailnet header)", async () => {
  const h = freshLibsql();
  try {
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog }, async (base) => {
      const r = await fetch(base + "/api/models/catalog");
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.equal(body.code, "NETWORK_DENIED");
    });
  } finally { await h.cleanup(); }
});

test("GET /api/models/catalog: 200 with a valid session", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE }, async (base) => {
      const r = await fetch(base + "/api/models/catalog", { headers: authHeaders(token) });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.models.length, 1);
      assert.equal(body.models[0].id, "panel-test-model");
    });
  } finally { await h.cleanup(); }
});

/** Every route this router mounts, as [method, path]. Kept as one literal
 * list so the parametrized auth test below and its own length assertion
 * catch a route silently added without auth coverage. */
const ALL_ROUTES = [
  ["GET", "/api/models/catalog"],
  ["GET", "/api/models/probe"],
  ["POST", "/api/models/reprobe"],
  ["POST", "/api/models/download"],
  ["GET", "/api/models/downloads"],
  ["DELETE", "/api/models/any-model-id"],
  ["POST", "/api/models/any-model-id/start"],
  ["POST", "/api/models/any-model-id/stop"],
  ["GET", "/api/models/runtime"],
  ["GET", "/api/models/hf-search?q=x"],
  ["GET", "/api/models/hf-token"],
  ["POST", "/api/models/hf-token"],
];

test("EVERY /api/models/* route (all 12) is gated: 403 NETWORK_DENIED with no headers, 401 UNAUTHENTICATED with an allowed network but no/bad session", async () => {
  assert.equal(ALL_ROUTES.length, 12, "route count drifted — update this list (and the coverage it's meant to guarantee) alongside the router");
  const h = freshLibsql();
  try {
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE }, async (base) => {
      for (const [method, path] of ALL_ROUTES) {
        const noHeaders = await fetch(base + path, { method });
        assert.equal(noHeaders.status, 403, `${method} ${path}: expected 403 with no headers, got ${noHeaders.status}`);
        assert.equal((await noHeaders.json()).code, "NETWORK_DENIED", `${method} ${path}`);

        const noSession = await fetch(base + path, { method, headers: noSessionHeaders() });
        assert.equal(noSession.status, 401, `${method} ${path}: expected 401 with network-ok/no-session, got ${noSession.status}`);
        assert.equal((await noSession.json()).code, "UNAUTHENTICATED", `${method} ${path}`);
      }
    });
  } finally { await h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Catalog + fit badges
// ---------------------------------------------------------------------------

test("GET /api/models/catalog: computes fits/tight/wont_fit per quant from the cached probe", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE }, async (base) => {
      const r = await fetch(base + "/api/models/catalog", { headers: authHeaders(token) });
      const body = await r.json();
      const quants = Object.fromEntries(body.models[0].quants.map((q) => [q.quant, q.fitBadge]));
      assert.equal(quants["Q4_K_M"], "fits");
      assert.equal(quants["Q5_K_M"], "tight");
      assert.equal(quants["Q8_0"], "wont_fit");
    });
  } finally { await h.cleanup(); }
});

test("GET /api/models/catalog: reflects registered/running state from state.json + the native-handle accessor", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { registerModel } = await import("../servers/gateway/models/manager.js");
    await registerModel({ modelId: "panel-test-model", quant: "Q4_K_M", catalog: makeCatalog(), db: h.db, dir: h.dir });
    await withServer({
      dir: h.dir,
      loadCatalogFn: makeCatalog,
      getCachedProbeFn: () => FIXED_PROBE,
      getNativeHandleFn: (id) => (id === "panel-test-model" ? { live: true } : null),
    }, async (base) => {
      const r = await fetch(base + "/api/models/catalog", { headers: authHeaders(token) });
      const body = await r.json();
      assert.equal(body.models[0].registered, true);
      assert.equal(body.models[0].registeredQuant, "Q4_K_M");
      assert.equal(body.models[0].running, true);
    });
  } finally { await h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Download gate
// ---------------------------------------------------------------------------

test("POST /api/models/download: 400 UNKNOWN_MODEL for a bad model id", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE }, async (base) => {
      const r = await fetch(base + "/api/models/download", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ modelId: "does-not-exist" }),
      });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).code, "UNKNOWN_MODEL");
    });
  } finally { await h.cleanup(); }
});

test("POST /api/models/download: 400 UNKNOWN_QUANT for a bad quant on a real model", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE }, async (base) => {
      const r = await fetch(base + "/api/models/download", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ modelId: "panel-test-model", quant: "Q99_NOPE" }),
      });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).code, "UNKNOWN_QUANT");
    });
  } finally { await h.cleanup(); }
});

test("POST /api/models/download: wont_fit quant refused with 409 unless force:true", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    let enqueueCalls = 0;
    const opts = {
      dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE,
      enqueueDownloadFn: async ({ onProgress }) => { enqueueCalls++; onProgress({ bytesDone: 10, totalBytes: 10 }); },
    };
    await withServer(opts, async (base) => {
      const refused = await fetch(base + "/api/models/download", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ modelId: "panel-test-model", quant: "Q8_0" }),
      });
      assert.equal(refused.status, 409);
      const refusedBody = await refused.json();
      assert.equal(refusedBody.code, "WONT_FIT");
      assert.equal(refusedBody.fitBadge, "wont_fit");
      assert.equal(enqueueCalls, 0, "the download engine must never be invoked when the gate refuses");

      const forced = await fetch(base + "/api/models/download", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ modelId: "panel-test-model", quant: "Q8_0", force: true }),
      });
      assert.equal(forced.status, 202);
      assert.equal(enqueueCalls, 1, "force:true lets the wont_fit quant through to the download engine");
    });
  } finally { await h.cleanup(); }
});

test("POST /api/models/download: tight and unknown quants are allowed WITHOUT force", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    let enqueueCalls = 0;
    const opts = {
      dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE,
      enqueueDownloadFn: async ({ onProgress }) => { enqueueCalls++; onProgress({ bytesDone: 10, totalBytes: 10 }); },
    };
    await withServer(opts, async (base) => {
      // tight
      const tight = await fetch(base + "/api/models/download", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ modelId: "panel-test-model", quant: "Q5_K_M" }),
      });
      assert.equal(tight.status, 202);
    });
    // unknown: no cached probe at all
    await withServer({ ...opts, getCachedProbeFn: () => null }, async (base) => {
      const unknown = await fetch(base + "/api/models/download", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ modelId: "panel-test-model", quant: "Q4_K_M" }),
      });
      assert.equal(unknown.status, 202);
    });
    assert.equal(enqueueCalls, 2);
  } finally { await h.cleanup(); }
});

test("POST /api/models/download: tight and unknown quants are ALSO allowed WITH force:true (force is inert, not required, for them)", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    let enqueueCalls = 0;
    const opts = {
      dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE,
      enqueueDownloadFn: async ({ onProgress }) => { enqueueCalls++; onProgress({ bytesDone: 10, totalBytes: 10 }); },
    };
    await withServer(opts, async (base) => {
      // tight, force:true
      const tight = await fetch(base + "/api/models/download", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ modelId: "panel-test-model", quant: "Q5_K_M", force: true }),
      });
      assert.equal(tight.status, 202);
    });
    // unknown (no cached probe), force:true
    await withServer({ ...opts, getCachedProbeFn: () => null }, async (base) => {
      const unknown = await fetch(base + "/api/models/download", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ modelId: "panel-test-model", quant: "Q4_K_M", force: true }),
      });
      assert.equal(unknown.status, 202);
    });
    assert.equal(enqueueCalls, 2);
  } finally { await h.cleanup(); }
});

test("POST /api/models/download -> GET /api/models/downloads: job transitions downloading -> registering -> done, with a real provider row", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const opts = {
      dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE,
      enqueueDownloadFn: async ({ onProgress }) => { onProgress({ bytesDone: 500, totalBytes: 500 }); },
    };
    await withServer(opts, async (base) => {
      const post = await fetch(base + "/api/models/download", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ modelId: "panel-test-model", quant: "Q4_K_M" }),
      });
      const { jobId } = await post.json();

      // Poll briefly for the async registerModel step to settle (real DB write, no network).
      let job = null;
      for (let i = 0; i < 50; i++) {
        const r = await fetch(base + "/api/models/downloads", { headers: authHeaders(token) });
        const body = await r.json();
        job = body.downloads.find((j) => j.id === jobId);
        if (job && job.status === "done") break;
        await new Promise((res) => setTimeout(res, 20));
      }
      assert.ok(job, "job present in GET /api/models/downloads");
      assert.equal(job.status, "done");
      assert.equal(job.providerId, "panel-test-model");
      assert.equal(job.bytesDone, 500);
    });
  } finally { await h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

test("DELETE /api/models/:id: 400 for a bad model id, 404 for a valid-but-uninstalled model id", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE }, async (base) => {
      const bad = await fetch(base + "/api/models/does-not-exist", { method: "DELETE", headers: authHeaders(token) });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).code, "UNKNOWN_MODEL");

      const notInstalled = await fetch(base + "/api/models/panel-test-model", { method: "DELETE", headers: authHeaders(token) });
      assert.equal(notInstalled.status, 404);
      assert.equal((await notInstalled.json()).code, "NOT_INSTALLED");
    });
  } finally { await h.cleanup(); }
});

test("DELETE /api/models/:id: returns bindings + requiresConfirm before deleting; ?confirm=true actually deletes", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { registerModel } = await import("../servers/gateway/models/manager.js");
    await registerModel({ modelId: "panel-test-model", quant: "Q4_K_M", catalog: makeCatalog(), db: h.db, dir: h.dir });
    // Bind an AI profile to this provider so `bindings` is non-empty.
    await h.db.execute({
      sql: "INSERT INTO dashboard_settings (key, value) VALUES ('ai_profiles', ?)",
      args: [JSON.stringify([{ id: "p1", provider_id: "panel-test-model" }])],
    });

    let stopCalls = 0;
    const handle = { live: true, stop: async () => { stopCalls++; } };
    await withServer({
      dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE,
      getNativeHandleFn: (id) => (id === "panel-test-model" ? handle : null),
    }, async (base) => {
      const preview = await fetch(base + "/api/models/panel-test-model", { method: "DELETE", headers: authHeaders(token) });
      assert.equal(preview.status, 200);
      const previewBody = await preview.json();
      assert.equal(previewBody.requiresConfirm, true);
      assert.equal(previewBody.bindings.profiles.length, 1);
      assert.equal(stopCalls, 0, "no teardown before confirm");

      const confirmed = await fetch(base + "/api/models/panel-test-model?confirm=true", { method: "DELETE", headers: authHeaders(token) });
      assert.equal(confirmed.status, 200);
      const confirmedBody = await confirmed.json();
      assert.equal(confirmedBody.deleted, true);
      assert.equal(stopCalls, 1, "the live native handle was stopped as part of teardown");
    });

    const row = await h.db.execute({ sql: "SELECT disabled FROM providers WHERE id = ?", args: ["panel-test-model"] });
    assert.equal(Number(row.rows[0].disabled), 1);
  } finally { await h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Start / stop reach the accessor
// ---------------------------------------------------------------------------

test("POST /api/models/:id/stop: calls handle.stop() when live, no-ops when already stopped, 404 when uninstalled", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { registerModel } = await import("../servers/gateway/models/manager.js");
    await registerModel({ modelId: "panel-test-model", quant: "Q4_K_M", catalog: makeCatalog(), db: h.db, dir: h.dir });

    let stopCalls = 0;
    const handle = { live: true, stop: async () => { stopCalls++; handle.live = false; } };
    await withServer({
      dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE,
      getNativeHandleFn: (id) => (id === "panel-test-model" ? handle : null),
    }, async (base) => {
      const r1 = await fetch(base + "/api/models/panel-test-model/stop", { method: "POST", headers: authHeaders(token) });
      assert.equal(r1.status, 200);
      assert.equal((await r1.json()).running, false);
      assert.equal(stopCalls, 1);

      // already stopped: idempotent, no second stop() call
      const r2 = await fetch(base + "/api/models/panel-test-model/stop", { method: "POST", headers: authHeaders(token) });
      assert.equal(r2.status, 200);
      assert.equal(stopCalls, 1);

      const r3 = await fetch(base + "/api/models/does-not-exist/stop", { method: "POST", headers: authHeaders(token) });
      assert.equal(r3.status, 400);
    });
  } finally { await h.cleanup(); }
});

test("POST /api/models/:id/start: reaches maybeAcquireLocalProvider and maps true/false/null to 200/502/409; 404 when uninstalled", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { registerModel } = await import("../servers/gateway/models/manager.js");
    await registerModel({ modelId: "panel-test-model", quant: "Q4_K_M", catalog: makeCatalog(), db: h.db, dir: h.dir });

    let lastArg = null;
    let result = true;
    await withServer({
      dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE,
      maybeAcquireLocalProviderFn: async (id) => { lastArg = id; return result; },
    }, async (base) => {
      const uninstalled = await fetch(base + "/api/models/panel-test-model-2/start", { method: "POST", headers: authHeaders(token) });
      assert.equal(uninstalled.status, 400); // not in catalog at all

      const ok = await fetch(base + "/api/models/panel-test-model/start", { method: "POST", headers: authHeaders(token) });
      assert.equal(ok.status, 200);
      assert.equal(lastArg, "panel-test-model");

      result = false;
      const failed = await fetch(base + "/api/models/panel-test-model/start", { method: "POST", headers: authHeaders(token) });
      assert.equal(failed.status, 502);
      assert.equal((await failed.json()).code, "START_FAILED");

      result = null;
      const notNative = await fetch(base + "/api/models/panel-test-model/start", { method: "POST", headers: authHeaders(token) });
      assert.equal(notNative.status, 409);
      assert.equal((await notNative.json()).code, "NOT_NATIVE");
    });
  } finally { await h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Runtime status strip
// ---------------------------------------------------------------------------

test("GET /api/models/runtime: merges state.registry with the process supervisor's status snapshot", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { registerModel } = await import("../servers/gateway/models/manager.js");
    await registerModel({ modelId: "panel-test-model", quant: "Q4_K_M", catalog: makeCatalog(), db: h.db, dir: h.dir });

    await withServer({
      dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE,
      getStatusSnapshotFn: () => [{ alias: "panel-test-model", port: 18100, state: "running", live: true, restartCount: 0, lastError: null, startedAt: "2026-01-01T00:00:00.000Z", pid: 4242 }],
    }, async (base) => {
      const r = await fetch(base + "/api/models/runtime", { headers: authHeaders(token) });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.models.length, 1);
      assert.equal(body.models[0].modelId, "panel-test-model");
      assert.equal(body.models[0].live, true);
      assert.equal(body.models[0].pid, 4242);
    });
  } finally { await h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Hugging Face search proxy
// ---------------------------------------------------------------------------

/** Minimal local stand-in for `https://huggingface.co/api/models?...` —
 * no real network touched. Captures the last request's headers so a test
 * can assert the stored token was (or wasn't) forwarded. */
function startHfFixture() {
  let lastHeaders = null;
  let mode = "ok";
  const server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    if (mode === "500") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
      return;
    }
    if (mode === "hang") {
      // never respond — exercises the client-side timeout
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      {
        id: "org/some-gguf-repo",
        gated: false,
        downloads: 1234,
        likes: 56,
        tags: ["gguf", "license:apache-2.0"],
        siblings: [{ rfilename: "some-gguf-repo-Q4_K_M.gguf" }, { rfilename: "README.md" }],
      },
      {
        id: "org/gated-repo",
        gated: "manual",
        downloads: 10,
        likes: 1,
        tags: ["gguf", "license:mit"],
        siblings: [{ rfilename: "gated-repo-Q4_K_M.gguf" }],
      },
      {
        // no gguf files at all -> filtered out of results
        id: "org/no-gguf-repo",
        gated: false,
        downloads: 5,
        likes: 0,
        tags: ["license:mit"],
        siblings: [{ rfilename: "model.safetensors" }],
      },
    ]));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        setMode: (m) => { mode = m; },
        lastHeaders: () => lastHeaders,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test("GET /api/models/hf-search: works WITHOUT a token, filters to gguf repos, labels gated", async () => {
  const h = freshLibsql();
  const fx = await startHfFixture();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE, hfApiBase: fx.base }, async (base) => {
      const r = await fetch(base + "/api/models/hf-search?q=llama", { headers: authHeaders(token) });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.results.length, 2, "the no-gguf-files repo is filtered out");
      const gated = body.results.find((x) => x.id === "org/gated-repo");
      assert.equal(gated.gated, true);
      const open = body.results.find((x) => x.id === "org/some-gguf-repo");
      assert.equal(open.gated, false);
      assert.equal(open.license, "apache-2.0");
      assert.deepEqual(open.ggufFiles, ["some-gguf-repo-Q4_K_M.gguf"]);
      assert.ok(!fx.lastHeaders().authorization, "no token stored -> no Authorization header sent upstream");
    });
  } finally { await fx.close(); await h.cleanup(); }
});

test("GET /api/models/hf-search: uses the stored token when present", async () => {
  const h = freshLibsql();
  const fx = await startHfFixture();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE, hfApiBase: fx.base }, async (base) => {
      const set = await fetch(base + "/api/models/hf-token", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ token: "hf_secrettoken123" }),
      });
      assert.equal(set.status, 200);

      await fetch(base + "/api/models/hf-search?q=llama", { headers: authHeaders(token) });
      assert.equal(fx.lastHeaders().authorization, "Bearer hf_secrettoken123");
    });
  } finally { await fx.close(); await h.cleanup(); }
});

test("GET /api/models/hf-search: 400 with no q; 502 on upstream 500 and on a hang (never hangs the caller)", async () => {
  const h = freshLibsql();
  const fx = await startHfFixture();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE, hfApiBase: fx.base, hfSearchTimeoutMs: 200 }, async (base) => {
      const missing = await fetch(base + "/api/models/hf-search", { headers: authHeaders(token) });
      assert.equal(missing.status, 400);
      assert.equal((await missing.json()).code, "MISSING_QUERY");

      fx.setMode("500");
      const upstream500 = await fetch(base + "/api/models/hf-search?q=x", { headers: authHeaders(token) });
      assert.equal(upstream500.status, 502);
      assert.equal((await upstream500.json()).code, "HF_UPSTREAM_ERROR");

      fx.setMode("hang");
      const started = Date.now();
      const hung = await fetch(base + "/api/models/hf-search?q=x", { headers: authHeaders(token) });
      assert.equal(hung.status, 502);
      assert.equal((await hung.json()).code, "HF_UPSTREAM_ERROR");
      assert.ok(Date.now() - started < 5000, "the route's own timeout fired well before any external hang would");
    });
  } finally { await fx.close(); await h.cleanup(); }
});

// ---------------------------------------------------------------------------
// HF token: write-only, never logged
// ---------------------------------------------------------------------------

test("hf-token: GET before/after POST reports only { configured }, never the raw value; POST body/value never logged", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const logs = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args) => { logs.push(args.map(String).join(" ")); originalLog.apply(console, args); };
    console.warn = (...args) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args) => { logs.push(args.map(String).join(" ")); };
    try {
      await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE }, async (base) => {
        const before = await fetch(base + "/api/models/hf-token", { headers: authHeaders(token) });
        const beforeBody = await before.json();
        assert.deepEqual(beforeBody, { configured: false });

        const SECRET = "hf_super-secret-value-should-never-leak";
        const post = await fetch(base + "/api/models/hf-token", {
          method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
          body: JSON.stringify({ token: SECRET }),
        });
        const postBody = await post.json();
        assert.deepEqual(postBody, { configured: true });
        assert.ok(!JSON.stringify(postBody).includes(SECRET), "POST response never echoes the token");

        const after = await fetch(base + "/api/models/hf-token", { headers: authHeaders(token) });
        const afterBody = await after.json();
        assert.deepEqual(afterBody, { configured: true });
        assert.ok(!JSON.stringify(afterBody).includes(SECRET), "GET response never returns the raw token");

        assert.ok(
          !logs.some((l) => l.includes(SECRET)),
          "the token must never appear in any console.log/warn/error call",
        );
      });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
    // Verify storage path directly: the exact providers.api_key column, under the reserved id.
    const row = await h.db.execute({ sql: "SELECT api_key, disabled, models, gpu_policy FROM providers WHERE id = ?", args: [HF_TOKEN_PROVIDER_ID] });
    assert.equal(row.rows[0].api_key, "hf_super-secret-value-should-never-leak");
    assert.equal(Number(row.rows[0].disabled), 1, "never an active routing candidate");
    assert.deepEqual(JSON.parse(row.rows[0].models), []);
    // Fix round 1: local_only marker — never broadcast to paired instances.
    assert.deepEqual(JSON.parse(row.rows[0].gpu_policy), { local_only: true });
    const { shouldSyncRowForTest } = await import("../servers/sharing/instance-sync.js");
    assert.equal(
      shouldSyncRowForTest("providers", { base_url: "https://huggingface.co", gpu_policy: row.rows[0].gpu_policy }),
      false,
      "the hf-token row as actually written must be rejected by the fleet-sync gate",
    );
  } finally { await h.cleanup(); }
});

test("hf-token: POST with a non-string token 400s", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, getCachedProbeFn: () => FIXED_PROBE }, async (base) => {
      const r = await fetch(base + "/api/models/hf-token", {
        method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify({ token: 12345 }),
      });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).code, "BAD_TOKEN");
    });
  } finally { await h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Probe passthrough
// ---------------------------------------------------------------------------

test("GET /api/models/probe + POST /api/models/reprobe", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    let reprobeCalls = 0;
    await withServer({
      dir: h.dir, loadCatalogFn: makeCatalog,
      getCachedProbeFn: () => null,
      reprobeFn: async () => { reprobeCalls++; return FIXED_PROBE; },
    }, async (base) => {
      const before = await fetch(base + "/api/models/probe", { headers: authHeaders(token) });
      assert.deepEqual(await before.json(), { probe: null });

      const reprobed = await fetch(base + "/api/models/reprobe", { method: "POST", headers: authHeaders(token) });
      assert.equal(reprobed.status, 200);
      const body = await reprobed.json();
      assert.deepEqual(body.probe, FIXED_PROBE);
      assert.equal(reprobeCalls, 1);
    });
  } finally { await h.cleanup(); }
});
