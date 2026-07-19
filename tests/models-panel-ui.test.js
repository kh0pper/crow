/**
 * Model Catalog panel UI (Item G, Task 13).
 *
 * Three layers:
 *  1. Pure helpers (sizeClassOf/groupBySizeClass/formatMb/fitLabelKey/fitHintKey)
 *     — no I/O, no injection needed.
 *  2. `loadPanelData` — the injectable data-assembly seam (mirrors
 *     routes/models.js's opts pattern from Task 12), with fakes standing in
 *     for probe/state/runtime/providers so this stays fast and DB-free where
 *     it can be.
 *  3. The real panel `handler` mounted behind the REAL `dashboardAuth`
 *     middleware in a scratch express app, exercising the actual dashboard
 *     auth convention (403 network-denied / 303-redirect unauthenticated /
 *     200 authenticated) exactly the way `servers/gateway/dashboard/index.js`
 *     wires every panel route — same harness shape
 *     `tests/models-panel.test.js` uses for the Task 12 routes (real
 *     scratch libsql via scripts/init-db.js, a session token seeded into
 *     oauth_tokens, `Tailscale-User-Login` to satisfy isAllowedNetwork over
 *     plain loopback).
 *
 * Also covers the two hard invariants called out in the brief:
 *   - zero literal backticks inside the client <script> block, and
 *   - no raw i18n key leaks into the rendered HTML (every `models.*`/`nav.*`
 *     key used by the panel must resolve to real copy).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import modelCatalogPanel, {
  sizeClassOf,
  groupBySizeClass,
  formatMb,
  fitLabelKey,
  fitHintKey,
  loadPanelData,
} from "../servers/gateway/dashboard/panels/model-catalog.js";
import { dashboardAuth } from "../servers/gateway/dashboard/auth.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

const repoRoot = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

test("sizeClassOf: reads the small/mid/large tag, falls back to 'other'", () => {
  assert.equal(sizeClassOf({ tags: ["chat", "small", "cpu-capable"] }), "small");
  assert.equal(sizeClassOf({ tags: ["chat", "mid"] }), "mid");
  assert.equal(sizeClassOf({ tags: ["chat", "large", "reasoning"] }), "large");
  assert.equal(sizeClassOf({ tags: ["chat"] }), "other");
  assert.equal(sizeClassOf({ tags: [] }), "other");
  assert.equal(sizeClassOf({}), "other");
});

test("groupBySizeClass: buckets every model, empty groups stay empty arrays", () => {
  const models = [
    { id: "a", tags: ["small"] },
    { id: "b", tags: ["mid"] },
    { id: "c", tags: ["mid"] },
    { id: "d", tags: ["large"] },
  ];
  const groups = groupBySizeClass(models);
  assert.deepEqual(groups.small.map((m) => m.id), ["a"]);
  assert.deepEqual(groups.mid.map((m) => m.id), ["b", "c"]);
  assert.deepEqual(groups.large.map((m) => m.id), ["d"]);
  assert.deepEqual(groups.other, []);
});

test("formatMb: GB above 1024, MB below, null/NaN pass through as null", () => {
  assert.equal(formatMb(512), "512 MB");
  assert.equal(formatMb(2048), "2.0 GB");
  assert.equal(formatMb(6030), "5.9 GB");
  assert.equal(formatMb(null), null);
  assert.equal(formatMb(undefined), null);
  assert.equal(formatMb(NaN), null);
});

test("fitLabelKey/fitHintKey: every fit badge maps to a distinct key, unrecognized falls back to unknown", () => {
  for (const b of ["fits", "tight", "wont_fit"]) {
    assert.match(fitLabelKey(b), /^models\.fit/);
    assert.match(fitHintKey(b), /^models\.fit/);
  }
  assert.equal(fitLabelKey("bogus"), fitLabelKey("unknown"));
  assert.equal(fitHintKey("bogus"), fitHintKey("unknown"));
  // all four are pairwise distinct
  const labelKeys = new Set(["fits", "tight", "wont_fit", "unknown"].map(fitLabelKey));
  assert.equal(labelKeys.size, 4);
});

// ---------------------------------------------------------------------------
// 2. loadPanelData
// ---------------------------------------------------------------------------

function fakeCatalog() {
  return {
    runtime: { name: "llama.cpp", release: "b10068" },
    models: [
      {
        id: "ui-test-small", family: "fam", lab: "Lab", license: "mit", gated: false,
        task: "chat", context_len: 4096, tags: ["chat", "small"], notes: "n",
        default_quant: "Q4", first_run_default: true,
        quants: [{ file: "f.gguf", quant: "Q4", size_mb: 100, min_ram_mb: 500, min_vram_mb: 0, sha256: "x" }],
      },
      {
        id: "ui-test-gated", family: "fam2", lab: "Lab2", license: "gemma", gated: true,
        task: "chat", context_len: 8192, tags: ["chat", "large"], notes: null,
        default_quant: "Q8", first_run_default: false,
        quants: [{ file: "g.gguf", quant: "Q8", size_mb: 9000, min_ram_mb: 20000, min_vram_mb: 8000, sha256: "y" }],
      },
    ],
  };
}

test("loadPanelData: maps models with fit badges, registered/running state, and estimates RAM/VRAM in use", async () => {
  const data = await loadPanelData({
    dir: "/unused-because-loadStateFn-is-injected",
    loadCatalogFn: fakeCatalog,
    getCachedProbeFn: () => ({ platform: "linux", wsl2: false, accel: "vulkan", gpuName: "Fake GPU", vramMb: 12000, ramAvailableMb: 16000, diskFreeMb: 500000, unknown: [] }),
    loadStateFn: () => ({ reservations: {}, journal: {}, registry: { "ui-test-small": { quant: "Q4" } } }),
    getStatusSnapshotFn: () => ([{ alias: "ui-test-small", state: "running", live: true, port: 18100, restartCount: 0, lastError: null, startedAt: "t", pid: 1 }]),
    getNativeHandleFn: (id) => (id === "ui-test-small" ? { live: true } : null),
  });

  assert.equal(data.runtime.name, "llama.cpp");
  assert.equal(data.models.length, 2);
  const small = data.models.find((m) => m.id === "ui-test-small");
  assert.equal(small.registered, true);
  assert.equal(small.registeredQuant, "Q4");
  assert.equal(small.running, true);
  assert.equal(small.quants[0].fitBadge, "fits");

  const gated = data.models.find((m) => m.id === "ui-test-gated");
  assert.equal(gated.registered, false);
  assert.equal(gated.running, false);
  assert.equal(gated.gated, true);
  // 20000 min_ram_mb vs 16000+12000=28000 effective (min_vram_mb 8000 <= 12000 vram) -> fits
  assert.equal(gated.quants[0].fitBadge, "fits");

  assert.equal(data.runtimeModels.length, 1);
  assert.equal(data.runtimeModels[0].modelId, "ui-test-small");
  assert.equal(data.estimatedRamMb, 500); // only the live model's registered quant counts
  assert.equal(data.estimatedVramMb, 0);
});

test("loadPanelData: a registered-but-not-live model contributes nothing to the RAM/VRAM estimate", async () => {
  const data = await loadPanelData({
    loadCatalogFn: fakeCatalog,
    getCachedProbeFn: () => ({ platform: "linux", wsl2: false, accel: "cpu", gpuName: null, vramMb: null, ramAvailableMb: 8000, diskFreeMb: 1000, unknown: [] }),
    loadStateFn: () => ({ reservations: {}, journal: {}, registry: { "ui-test-small": { quant: "Q4" } } }),
    getStatusSnapshotFn: () => ([]), // never started this process lifetime
    getNativeHandleFn: () => null,
  });
  const small = data.models.find((m) => m.id === "ui-test-small");
  assert.equal(small.registered, true);
  assert.equal(small.running, false);
  assert.equal(data.runtimeModels[0].live, false);
  assert.equal(data.estimatedRamMb, 0);
});

test("loadPanelData: wont_fit quant on tiny RAM never falls open to fits/tight", async () => {
  const data = await loadPanelData({
    loadCatalogFn: fakeCatalog,
    getCachedProbeFn: () => ({ platform: "linux", wsl2: false, accel: "cpu", gpuName: null, vramMb: null, ramAvailableMb: 1024, diskFreeMb: 1000, unknown: [] }),
    loadStateFn: () => ({ reservations: {}, journal: {}, registry: {} }),
    getStatusSnapshotFn: () => ([]),
    getNativeHandleFn: () => null,
  });
  const gated = data.models.find((m) => m.id === "ui-test-gated");
  assert.equal(gated.quants[0].fitBadge, "wont_fit");
});

test("loadPanelData: probe cache miss (null) triggers exactly one reprobe call, its result is used", async () => {
  let reprobeCalls = 0;
  const data = await loadPanelData({
    loadCatalogFn: fakeCatalog,
    getCachedProbeFn: () => null,
    reprobeFn: async () => {
      reprobeCalls += 1;
      return { platform: "linux", wsl2: false, accel: "cpu", gpuName: null, vramMb: null, ramAvailableMb: 999999, diskFreeMb: 999999, unknown: [] };
    },
    loadStateFn: () => ({ reservations: {}, journal: {}, registry: {} }),
    getStatusSnapshotFn: () => ([]),
    getNativeHandleFn: () => null,
  });
  assert.equal(reprobeCalls, 1);
  // huge ramAvailableMb from the reprobe result -> even the gated/large quant fits
  const gated = data.models.find((m) => m.id === "ui-test-gated");
  assert.equal(gated.quants[0].fitBadge, "fits");
});

test("loadPanelData: reprobe failure is honest — probe stays null, every fit badge is 'unknown', never crashes", async () => {
  const data = await loadPanelData({
    loadCatalogFn: fakeCatalog,
    getCachedProbeFn: () => null,
    reprobeFn: async () => { throw new Error("no vulkaninfo on this box"); },
    loadStateFn: () => ({ reservations: {}, journal: {}, registry: {} }),
    getStatusSnapshotFn: () => ([]),
    getNativeHandleFn: () => null,
  });
  assert.equal(data.probe, null);
  for (const m of data.models) {
    for (const q of m.quants) assert.equal(q.fitBadge, "unknown");
  }
});

test("loadPanelData: hfTokenConfigured true only when the reserved provider row has a non-empty apiKey", async () => {
  const base = {
    loadCatalogFn: fakeCatalog,
    getCachedProbeFn: () => ({ platform: "linux", wsl2: false, accel: "cpu", gpuName: null, vramMb: null, ramAvailableMb: 8000, diskFreeMb: 1000, unknown: [] }),
    loadStateFn: () => ({ reservations: {}, journal: {}, registry: {} }),
    getStatusSnapshotFn: () => ([]),
    getNativeHandleFn: () => null,
  };

  const withToken = await loadPanelData({
    ...base, db: {},
    listProvidersAllFn: async () => ([{ id: "crow-hf-token", apiKey: "hf_abc" }]),
  });
  assert.equal(withToken.hfTokenConfigured, true);

  const withoutToken = await loadPanelData({
    ...base, db: {},
    listProvidersAllFn: async () => ([{ id: "crow-hf-token", apiKey: null }]),
  });
  assert.equal(withoutToken.hfTokenConfigured, false);

  const noDb = await loadPanelData(base); // db omitted entirely
  assert.equal(noDb.hfTokenConfigured, false);

  const dbThrows = await loadPanelData({
    ...base, db: {},
    listProvidersAllFn: async () => { throw new Error("db offline"); },
  });
  assert.equal(dbThrows.hfTokenConfigured, false); // fails closed, never throws
});

// ---------------------------------------------------------------------------
// 3. Full render: real dashboardAuth, real scratch DB, real registry/model-catalog.json
// ---------------------------------------------------------------------------

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "models-panel-ui-"));
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
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      try { db.close(); } catch { /* best effort */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function hashToken(tok) { return createHash("sha256").update(tok).digest("hex"); }

async function seedSession(db, token = "ui-test-session-token") {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await db.execute({
    sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)",
    args: [hashToken(token), expiresAt],
  });
  return token;
}

/** Mounts dashboardAuth exactly the way servers/gateway/index.js does
 * (the `res.redirectAfterPost` shim it installs globally), then the panel
 * route the same way servers/gateway/dashboard/index.js's `/dashboard/:panelId`
 * dispatcher calls `panel.handler(req, res, { db, layout, lang })`. */
async function withPanelServer(h, fn) {
  const app = express();
  app.use((req, res, next) => {
    res.redirectAfterPost = (url) => res.redirect(303, url);
    next();
  });
  app.get("/dashboard/model-catalog", dashboardAuth, async (req, res) => {
    const layout = ({ title, content }) => "<html><head><title>" + title + "</title></head><body>" + content + "</body></html>";
    try {
      const html = await modelCatalogPanel.handler(req, res, { db: h.db, layout, lang: req.headers["x-test-lang"] === "es" ? "es" : "en" });
      if (!res.headersSent) res.type("html").send(html);
    } catch (err) {
      if (!res.headersSent) res.status(500).send("panel error: " + err.message);
    }
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test("panel route: bare loopback with no tailnet identity is network-denied (403), same as every other panel", async () => {
  const h = freshLibsql();
  try {
    await withPanelServer(h, async (base) => {
      const r = await fetch(base + "/dashboard/model-catalog");
      assert.equal(r.status, 403);
    });
  } finally { await h.cleanup(); }
});

test("panel route: tailnet-identified but no session cookie redirects to /dashboard/login (dashboardAuth convention)", async () => {
  const h = freshLibsql();
  try {
    await withPanelServer(h, async (base) => {
      const r = await fetch(base + "/dashboard/model-catalog", {
        headers: { "tailscale-user-login": "test@example.com" },
        redirect: "manual",
      });
      assert.equal(r.status, 303);
      assert.match(r.headers.get("location"), /\/dashboard\/login$/);
    });
  } finally { await h.cleanup(); }
});

test("panel route: authenticated request renders 200 with the curated tab, runtime strip, and a real catalog model card", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withPanelServer(h, async (base) => {
      const r = await fetch(base + "/dashboard/model-catalog", {
        headers: { "tailscale-user-login": "test@example.com", cookie: "crow_session=" + token },
      });
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /id="mcat-runtime-strip"/);
      assert.match(html, /data-tab-panel="curated"/);
      assert.match(html, /data-tab-panel="browse-hf"/);
      // real registry/model-catalog.json content — the small, permissively
      // licensed first_run_default entry must be present
      assert.match(html, /data-model-id="qwen3-4b"/);
      assert.match(html, /data-action="download"/);
      assert.match(html, /id="mcat-hf-search-input"/);
    });
  } finally { await h.cleanup(); }
});

test("panel route: renders in Spanish when lang=es is passed through the layout context", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withPanelServer(h, async (base) => {
      const r = await fetch(base + "/dashboard/model-catalog", {
        headers: { "tailscale-user-login": "test@example.com", cookie: "crow_session=" + token, "x-test-lang": "es" },
      });
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /Explorar Hugging Face/);
      assert.match(html, /Descargar/);
    });
  } finally { await h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Hard invariants: zero backticks in client JS, no raw i18n key leakage
// ---------------------------------------------------------------------------

test("client script block contains ZERO literal backtick characters", () => {
  const src = readFileSync(join(repoRoot, "servers/gateway/dashboard/panels/model-catalog.js"), "utf8");
  const scriptStart = src.indexOf("<script>", src.indexOf("function modelCatalogClientJS"));
  const scriptEnd = src.indexOf("</script>", scriptStart);
  assert.ok(scriptStart > -1 && scriptEnd > scriptStart, "could not locate the client <script> block");
  const body = src.slice(scriptStart + "<script>".length, scriptEnd);
  const backtickCount = (body.match(/`/g) || []).length;
  assert.equal(backtickCount, 0, "a literal backtick inside the client <script> block would break the whole dashboard");
});

test("rendered HTML never leaks a raw i18n key as visible text (en and es)", async () => {
  const h = freshLibsql();
  try {
    for (const lang of ["en", "es"]) {
      const layout = ({ content }) => content;
      const html = await modelCatalogPanel.handler({}, {}, { db: h.db, layout, lang });
      const leaks = html.match(/>models\.[A-Za-z0-9]+</g) || [];
      assert.deepEqual(leaks, [], `raw key leaked into rendered HTML (${lang}): ${leaks.join(", ")}`);
    }
  } finally { await h.cleanup(); }
});

test("every models.* / nav.model-catalog key referenced by the panel source resolves to real en+es copy", () => {
  const src = readFileSync(join(repoRoot, "servers/gateway/dashboard/panels/model-catalog.js"), "utf8");
  const used = new Set((src.match(/"models\.[A-Za-z0-9]+"/g) || []).map((s) => s.slice(1, -1)));
  assert.ok(used.size > 30, "sanity check: expected dozens of models.* keys in the panel source");
  for (const key of used) {
    assert.ok(translations[key], `missing i18n key: ${key}`);
    assert.ok(translations[key].en, `${key} has no en copy`);
    assert.ok(translations[key].es, `${key} has no es copy`);
  }
  assert.ok(translations["nav.model-catalog"], "missing nav.model-catalog i18n key");
});

test("panel manifest: registered id/route/icon shape matches the panel-registry contract", () => {
  assert.equal(modelCatalogPanel.id, "model-catalog");
  assert.equal(modelCatalogPanel.route, "/dashboard/model-catalog");
  assert.equal(typeof modelCatalogPanel.handler, "function");
  assert.equal(typeof modelCatalogPanel.navOrder, "number");
});
