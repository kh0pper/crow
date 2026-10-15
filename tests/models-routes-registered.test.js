/**
 * Models plan 3a, Task 3 (+ Rev 2 H1/H2/M1 and the orchestration-off Low):
 * the registered listing JSON, register (= edit), adopt and hf-adopt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLifecycleCore } from "../servers/gateway/models/lifecycle-core.js";
import { createJobStore } from "../servers/gateway/models/lifecycle.js";
import { hfSyntheticCatalog, registerModel } from "../servers/gateway/models/manager.js";
import { upsertProvider, listProvidersAll } from "../servers/shared/providers-db.js";
import { loadState, registryKey } from "../servers/gateway/models/state.js";
import {
  freshLibsql, seedSession, authHeaders, noCsrfHeaders, noSessionHeaders, withServer, withOrchestrationDisabled,
} from "./fixtures/models-routes-harness.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const PRIMARY = Buffer.alloc(10_000, 1);

function makeCatalog() {
  const base = { family: "T", lab: "L", license: "apache-2.0", gated: false, task: "chat", context_len: 8192, min_runtime_version: "b1", default_quant: "Q4_K_M", tags: [] };
  const q = (id) => [{ file: `${id}-Q4_K_M.gguf`, quant: "Q4_K_M", size_mb: PRIMARY.length / 1e6, min_ram_mb: 1, min_vram_mb: 0, sha256: sha(PRIMARY) }];
  return {
    version: 1, runtime: { name: "llama.cpp", release: "b1", assets: {} },
    models: [
      { ...base, id: "small-chat", hf_repo: "t/small", quants: q("small-chat"), serving: { class: "resident" } },
      { ...base, id: "big-window", hf_repo: "t/big", quants: q("big-window"), serving: { class: "windowed" } },
      { ...base, id: "wedgy", hf_repo: "t/wedgy", quants: q("wedgy"), serving: { class: "wedge-risk" } },
    ],
  };
}

const LISTING_PROVIDERS = {
  "small-chat": { models: [{ id: "small-chat" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18102/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18102, catalogId: "small-chat", quant: "Q4_K_M", mutexGroup: "g1", launch: { ctx: 4096 }, alwaysResident: false, defaultMember: true } },
  "big-window": { models: [{ id: "big-window" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18103/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18103, catalogId: "big-window", quant: "Q4_K_M", mutexGroup: "g1" } },
  "wedgy": { models: [{ id: "wedgy" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18104/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18104, catalogId: "wedgy", quant: "Q4_K_M", mutexGroup: "g2" } },
  "peer-row": { models: [{ id: "small-chat" }], baseUrl: "http://100.64.9.1:3008/llm/v1", gpuPolicy: { runtime: "native", owner: "peer", port: 18120, catalogId: "small-chat", quant: "Q4_K_M" } },
  "crow-embed": { models: [{ id: "emb" }], baseUrl: "http://127.0.0.1:8004/v1", bundleId: "llamacpp-embed", gpuPolicy: {} },
};

function listingCore() {
  return createLifecycleCore({
    providersFn: () => LISTING_PROVIDERS, ownInstanceIdFn: () => "me", readReservationFn: () => null,
    snapshotOfFn: () => null, siblingsOfFn: () => [], externalHealthFn: () => ({}),
    acquireFn: async () => true, stopFn: async () => ({ stopped: true }), jobs: createJobStore(),
  });
}

/** A downloaded (not adopted) quant: the blob file the download pipeline writes. */
function seedDownloaded(dir, id = "small-chat", quant = "Q4_K_M") {
  mkdirSync(join(dir, "models", "blobs"), { recursive: true });
  writeFileSync(join(dir, "models", "blobs", `${id}-${quant}.gguf`), PRIMARY);
}

const post = (base, path, token, body, headers = authHeaders(token)) =>
  fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });

test("every new route answers 401 without a session; mutating ones 403 without the CSRF echo", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      assert.equal((await fetch(base + "/api/models/registered", { headers: noSessionHeaders() })).status, 401);
      for (const path of ["/api/models/register", "/api/models/adopt", "/api/models/hf-adopt"]) {
        assert.equal((await post(base, path, token, {}, noSessionHeaders())).status, 401, path);
        assert.equal((await post(base, path, token, { catalogId: "small-chat" }, noCsrfHeaders(token))).status, 403, path);
      }
    });
    assert.equal(Object.keys(loadState(h.dir).registry).length, 0);
  } finally { await h.cleanup(); }
});

test("GET /api/models/registered: rows enriched with catalog/launch/serving class and startable", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      const body = await (await fetch(base + "/api/models/registered", { headers: authHeaders(token) })).json();
      const by = Object.fromEntries(body.rows.map((r) => [r.provider, r]));
      assert.equal(by["small-chat"].startable, true);
      assert.equal(by["small-chat"].catalogId, "small-chat");
      assert.deepEqual(by["small-chat"].launch, { ctx: 4096 });
      assert.equal(by["small-chat"].defaultMember, true);
      assert.equal(by["small-chat"].servingClass, "resident");
      assert.equal(by["big-window"].startable, false);
      assert.equal(by["big-window"].servingClass, "windowed");
      assert.equal(by["wedgy"].startable, false);
      assert.equal(by["peer-row"].startable, false);
      assert.equal(by["peer-row"].status, "foreign");
      assert.deepEqual(body.groups, ["g1", "g2"]);
      assert.deepEqual(body.roles, ["crow-embed"]);
      assert.equal(body.orchestrationDisabled, false);

      await withOrchestrationDisabled(async () => {
        const off = await (await fetch(base + "/api/models/registered", { headers: authHeaders(token) })).json();
        assert.equal(off.orchestrationDisabled, true);
        assert.ok(off.rows.every((r) => r.startable === false));
      });
    });
  } finally { await h.cleanup(); }
});

test("POST /api/models/register: registers, re-register edits the own row; INVALID_LAUNCH is 400 with errors[]", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    seedDownloaded(h.dir);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      const r = await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q4_K_M", providerId: "crow-chat", mutexGroup: null });
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.provider.id, "crow-chat");

      const edit = await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q4_K_M", providerId: "crow-chat", launch: { ctx: 2048 }, alwaysResident: true });
      assert.equal(edit.status, 200);
      const row = (await listProvidersAll(h.db)).find((p) => p.id === "crow-chat");
      assert.equal(row.gpuPolicy.launch.ctx, 2048);
      assert.equal(row.gpuPolicy.alwaysResident, true);

      const bad = await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q4_K_M", providerId: "crow-chat", launch: { ctx: 999999 } });
      assert.equal(bad.status, 400);
      const bb = await bad.json();
      assert.equal(bb.code, "INVALID_LAUNCH");
      assert.ok(Array.isArray(bb.errors) && bb.errors.length > 0);

      const unknown = await post(base, "/api/models/register", token, { catalogId: "nope" });
      assert.equal(unknown.status, 400);
      assert.equal((await unknown.json()).code, "UNKNOWN_MODEL");
      const unknownQ = await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q9" });
      assert.equal((await unknownQ.json()).code, "UNKNOWN_QUANT");
    });
  } finally { await h.cleanup(); }
});

test("register refuses foreign-owned (NOT_OWNER), external-engine (EXTERNAL_ENGINE) and bundle-backed (BUNDLE_ROW) rows, untouched", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await upsertProvider(h.db, { id: "peer-row", baseUrl: "http://100.64.9.1:3008/llm/p/peer-row/v1", host: "local", models: [{ id: "small-chat", task: "chat" }], providerType: "openai-compat",
      gpuPolicy: { runtime: "native", owner: "someone-else", port: 18120, catalogId: "small-chat", quant: "Q4_K_M" } });
    await upsertProvider(h.db, { id: "ext-row", baseUrl: "http://100.64.9.1:8006/v1", host: "local", models: [{ id: "small-chat" }], providerType: "openai-compat",
      gpuPolicy: { engine: { managed: "external", host: "peer" } } });
    await upsertProvider(h.db, { id: "bundle-row", baseUrl: "http://127.0.0.1:8004/v1", host: "local", bundleId: "llamacpp-embed", models: [{ id: "small-chat" }] });
    const before = JSON.stringify(await listProvidersAll(h.db));
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      const expect = { "peer-row": "NOT_OWNER", "ext-row": "EXTERNAL_ENGINE", "bundle-row": "BUNDLE_ROW" };
      for (const [providerId, code] of Object.entries(expect)) {
        const r = await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q4_K_M", providerId });
        assert.equal(r.status, 409, providerId);
        const b = await r.json();
        assert.equal(b.code, code, providerId);
        if (code === "NOT_OWNER") assert.equal(b.owner, "someone-else");
      }
    });
    assert.equal(JSON.stringify(await listProvidersAll(h.db)), before, "no row changed");
    assert.equal(Object.keys(loadState(h.dir).registry).length, 0);
  } finally { await h.cleanup(); }
});

test("registerModel itself refuses to treat a foreign-owned native row as its own (H1)", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, { id: "small-chat", baseUrl: "http://100.64.9.1:3008/llm/p/small-chat/v1", host: "local", models: [{ id: "small-chat", task: "chat" }], providerType: "openai-compat",
      gpuPolicy: { runtime: "native", owner: "someone-else", port: 18120, catalogId: "small-chat", quant: "Q4_K_M" } });
    await assert.rejects(
      registerModel({ modelId: "small-chat", quant: "Q4_K_M", catalog: makeCatalog(), db: h.db, dir: h.dir, ownInstanceIdFn: () => "me" }),
      (e) => e.code === "NOT_OWNER" && e.owner === "someone-else"
    );
    await upsertProvider(h.db, { id: "bundle-row", baseUrl: "http://127.0.0.1:8004/v1", host: "local", bundleId: "llamacpp-embed", models: [{ id: "small-chat" }] });
    await assert.rejects(
      registerModel({ modelId: "small-chat", quant: "Q4_K_M", providerId: "bundle-row", refuseBundleRow: true, catalog: makeCatalog(), db: h.db, dir: h.dir }),
      (e) => e.code === "BUNDLE_ROW"
    );
  } finally { await h.cleanup(); }
});

test("register/adopt/hf-adopt answer 409 MODEL_ORCHESTRATION_DISABLED on an orchestration-off host", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      await withOrchestrationDisabled(async () => {
        for (const path of ["/api/models/register", "/api/models/adopt", "/api/models/hf-adopt"]) {
          const r = await post(base, path, token, { catalogId: "small-chat", quant: "Q4_K_M" });
          assert.equal(r.status, 409, path);
          assert.equal((await r.json()).code, "MODEL_ORCHESTRATION_DISABLED");
        }
      });
    });
  } finally { await h.cleanup(); }
});

test("POST /api/models/adopt: registers weights on disk; ADOPT_SIZE_MISMATCH is 400 with the size text", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const token = await seedSession(h.db);
    writeFileSync(join(weights, "ok.gguf"), PRIMARY);
    writeFileSync(join(weights, "short.gguf"), Buffer.alloc(5_000, 1));
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      const ok = await post(base, "/api/models/adopt", token, { catalogId: "small-chat", quant: "Q4_K_M", path: join(weights, "ok.gguf"), providerId: "crow-chat" });
      assert.equal(ok.status, 200);
      const b = await ok.json();
      assert.equal(b.provider.id, "crow-chat");
      assert.equal(b.verified, true);
      assert.equal(loadState(h.dir).registry["small-chat@Q4_K_M"].path, join(weights, "ok.gguf"));

      const bad = await post(base, "/api/models/adopt", token, { catalogId: "small-chat", quant: "Q4_K_M", path: join(weights, "short.gguf"), providerId: "other", allowUnverified: true });
      assert.equal(bad.status, 400);
      const bb = await bad.json();
      assert.equal(bb.code, "ADOPT_SIZE_MISMATCH");
      assert.match(bb.error, /catalog quant entry/);
    });
  } finally { await h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("POST /api/models/hf-adopt: validates input, 422 without an LFS sha, else adopts against the synthetic catalog", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const token = await seedSession(h.db);
    writeFileSync(join(weights, "My-Model-Q4_K_M.gguf"), PRIMARY);
    const info = { "t/withsha": { sha256: sha(PRIMARY), sizeBytes: PRIMARY.length }, "t/nosha": { sha256: null, sizeBytes: PRIMARY.length } };
    await withServer({
      dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore,
      fetchHfPathInfoFn: async ({ hfRepo }) => info[hfRepo],
    }, async (base) => {
      const badRepo = await post(base, "/api/models/hf-adopt", token, { hfRepo: "../x", file: "a.gguf", path: "/x" });
      assert.equal(badRepo.status, 400);
      const nosha = await post(base, "/api/models/hf-adopt", token, { hfRepo: "t/nosha", file: "My-Model-Q4_K_M.gguf", path: join(weights, "My-Model-Q4_K_M.gguf") });
      assert.equal(nosha.status, 422);
      assert.equal((await nosha.json()).code, "NO_VERIFIABLE_CHECKSUM");
      const ok = await post(base, "/api/models/hf-adopt", token, { hfRepo: "t/withsha", file: "My-Model-Q4_K_M.gguf", path: join(weights, "My-Model-Q4_K_M.gguf") });
      assert.equal(ok.status, 200);
      const b = await ok.json();
      assert.equal(b.verified, true);
      const entries = Object.values(loadState(h.dir).registry);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].source, "hf-browser");
      assert.equal(entries[0].adopted, true);
    });
  } finally { await h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("hfSyntheticCatalog keeps the shape downloadHfFile always built", () => {
  const c = hfSyntheticCatalog({ hfRepo: "org/Repo-GGUF", file: "Repo-Q4_K_M.gguf", modelId: "repo-q4-k-m", sha256: "abc", sizeMb: 12.5 });
  assert.deepEqual(c, { models: [{
    id: "repo-q4-k-m", family: "Repo-GGUF", hf_repo: "org/Repo-GGUF", task: "chat", context_len: null, default_quant: "hf",
    quants: [{ file: "Repo-Q4_K_M.gguf", quant: "hf", sha256: "abc", size_mb: 12.5, min_ram_mb: 12.5, min_vram_mb: 0 }],
  }] });
});

// ─── Review fixes (2026-10-15) ──────────────────────────────────────────────

/** What the orchestrator opens on start (gpu-orchestrator.js startNativeAndAwaitReady):
 * the row's catalogId@quant registry entry, its absolute `path` if adopted, else the blob dir. */
function startFileFor(dir, row) {
  const entry = loadState(dir).registry[registryKey(row.gpuPolicy.catalogId, row.gpuPolicy.quant)];
  return entry ? (entry.path || join(dir, "models", "blobs", entry.file)) : null;
}

test("review 1: Edit and Register as… on an adopted install keep path/adopted/verified/companions, and both providers still start from the adopted file", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const token = await seedSession(h.db);
    const file = join(weights, "ok.gguf");
    writeFileSync(file, PRIMARY);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      assert.equal((await post(base, "/api/models/adopt", token, { catalogId: "small-chat", quant: "Q4_K_M", path: file, providerId: "crow-chat" })).status, 200);
      const before = loadState(h.dir).registry["small-chat@Q4_K_M"];
      // Edit (re-register under the same id) and Register as… (a second id).
      assert.equal((await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q4_K_M", providerId: "crow-chat", launch: { ctx: 2048 } })).status, 200);
      assert.equal((await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q4_K_M", providerId: "crow-chat-b" })).status, 200);
    });
    const entry = loadState(h.dir).registry["small-chat@Q4_K_M"];
    assert.equal(entry.path, file);
    assert.equal(entry.adopted, true);
    assert.equal(entry.verified, true);
    assert.deepEqual(entry.companions, []);
    const rows = await listProvidersAll(h.db);
    for (const id of ["crow-chat", "crow-chat-b"]) {
      const row = rows.find((r) => r.id === id);
      assert.equal(startFileFor(h.dir, row), file, `${id} starts from the adopted file`);
    }
  } finally { await h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("review 1: a download-shaped re-register still drops adopted fields (the I2 rule is unchanged)", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const token = await seedSession(h.db);
    writeFileSync(join(weights, "ok.gguf"), PRIMARY);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      await post(base, "/api/models/adopt", token, { catalogId: "small-chat", quant: "Q4_K_M", path: join(weights, "ok.gguf") });
    });
    await registerModel({ modelId: "small-chat", quant: "Q4_K_M", catalog: makeCatalog(), db: h.db, dir: h.dir });
    const entry = loadState(h.dir).registry["small-chat@Q4_K_M"];
    assert.equal(entry.adopted, undefined);
    assert.equal(entry.path, undefined);
  } finally { await h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("review 5: an owner-less foreign native row (its base_url is another door) is refused NOT_OWNER", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await upsertProvider(h.db, { id: "peer-noowner", baseUrl: "http://100.64.9.1:3008/llm/p/peer-noowner/v1", host: "local", models: [{ id: "small-chat", task: "chat" }], providerType: "openai-compat",
      gpuPolicy: { runtime: "native", port: 18121, catalogId: "small-chat", quant: "Q4_K_M" } });
    const core = () => createLifecycleCore({
      providersFn: () => ({ "peer-noowner": { models: [{ id: "small-chat" }], baseUrl: "http://100.64.9.1:3008/llm/p/peer-noowner/v1", gpuPolicy: { runtime: "native", port: 18121, catalogId: "small-chat", quant: "Q4_K_M" } } }),
      ownInstanceIdFn: () => "me", readReservationFn: () => null, snapshotOfFn: () => null, siblingsOfFn: () => [], externalHealthFn: () => ({}),
      acquireFn: async () => true, stopFn: async () => ({}), jobs: createJobStore(),
    });
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: core }, async (base) => {
      const r = await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q4_K_M", providerId: "peer-noowner" });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).code, "NOT_OWNER");
    });
    assert.equal(Object.keys(loadState(h.dir).registry).length, 0);
  } finally { await h.cleanup(); }
});

test("review 6: hf-adopt refuses allowUnverified (it always verifies the LFS sha256)", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    let looked = 0;
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore, fetchHfPathInfoFn: async () => { looked += 1; return { sha256: "x", sizeBytes: 1 }; } }, async (base) => {
      const r = await post(base, "/api/models/hf-adopt", token, { hfRepo: "t/withsha", file: "A-Q4_K_M.gguf", path: "/srv/A-Q4_K_M.gguf", allowUnverified: true });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).code, "BAD_REQUEST");
    });
    assert.equal(looked, 0);
  } finally { await h.cleanup(); }
});

// ─── PR #483 review round 2 ─────────────────────────────────────────────────

test("round 2 #2: Register as… a quant that was never downloaded or adopted is 409 NOT_DOWNLOADED and writes nothing", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      const r = await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q4_K_M", providerId: "crow-chat" });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).code, "NOT_DOWNLOADED");
    });
    assert.equal((await listProvidersAll(h.db)).some((p) => p.id === "crow-chat"), false);
    assert.equal(Object.keys(loadState(h.dir).registry).length, 0);
  } finally { await h.cleanup(); }
});

test("round 2 #1: the legacy DELETE /api/models/:catalogId removes the custom-id provider an adopt created", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const token = await seedSession(h.db);
    writeFileSync(join(weights, "ok.gguf"), PRIMARY);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      assert.equal((await post(base, "/api/models/adopt", token, { catalogId: "small-chat", quant: "Q4_K_M", path: join(weights, "ok.gguf"), providerId: "crow-chat" })).status, 200);
      const preview = await (await fetch(`${base}/api/models/small-chat`, { method: "DELETE", headers: authHeaders(token) })).json();
      assert.equal(preview.requiresConfirm, true);
      assert.deepEqual(preview.providers, ["crow-chat"]);
      const r = await fetch(`${base}/api/models/small-chat?confirm=true`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).deleted, true);
    });
    const row = (await listProvidersAll(h.db)).find((p) => p.id === "crow-chat");
    assert.equal(!!row.disabled, true, "the provider the card stood for is really gone");
    assert.equal(existsSync(join(weights, "ok.gguf")), true, "adopted weights are never deleted");
  } finally { await h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("round 2 #1: the legacy DELETE refuses 409 when no provider of this instance serves the catalog id — never deleted:true for a no-op", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const token = await seedSession(h.db);
    writeFileSync(join(weights, "ok.gguf"), PRIMARY);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      await post(base, "/api/models/adopt", token, { catalogId: "small-chat", quant: "Q4_K_M", path: join(weights, "ok.gguf"), providerId: "crow-chat" });
      const { disableProvider } = await import("../servers/shared/providers-db.js");
      await disableProvider(h.db, "crow-chat");
      const r = await fetch(`${base}/api/models/small-chat?confirm=true`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(r.status, 409);
      const b = await r.json();
      assert.equal(b.code, "NO_PROVIDER");
      assert.notEqual(b.deleted, true);
    });
  } finally { await h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("round 2 #3: the unregister preview says whether the weights file will be deleted", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const token = await seedSession(h.db);
    seedDownloaded(h.dir);
    writeFileSync(join(weights, "ok.gguf"), PRIMARY);
    const providers = {};
    const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
    const core = () => createLifecycleCore({
      providersFn: () => providers, ownInstanceIdFn: getOrCreateLocalInstanceId, readReservationFn: () => null, snapshotOfFn: () => null,
      siblingsOfFn: () => [], externalHealthFn: () => ({}), acquireFn: async () => true, stopFn: async () => ({}), jobs: createJobStore(),
    });
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: core }, async (base) => {
      await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q4_K_M", providerId: "dl-a" });
      for (const r of await listProvidersAll(h.db)) providers[r.id] = { ...r, doorUrl: "http://d/llm/v1" };
      const solo = await (await fetch(`${base}/api/models/providers/dl-a`, { method: "DELETE", headers: authHeaders(token) })).json();
      assert.equal(solo.willDeleteFiles, true, "downloaded, no other user");
      await post(base, "/api/models/register", token, { catalogId: "small-chat", quant: "Q4_K_M", providerId: "dl-b" });
      for (const r of await listProvidersAll(h.db)) providers[r.id] = { ...r, doorUrl: "http://d/llm/v1" };
      const shared = await (await fetch(`${base}/api/models/providers/dl-a`, { method: "DELETE", headers: authHeaders(token) })).json();
      assert.equal(shared.willDeleteFiles, false, "another provider still uses the weights");
      await post(base, "/api/models/adopt", token, { catalogId: "big-window", quant: "Q4_K_M", path: join(weights, "ok.gguf"), providerId: "ad-1" });
      for (const r of await listProvidersAll(h.db)) providers[r.id] = { ...r, doorUrl: "http://d/llm/v1" };
      const adopted = await (await fetch(`${base}/api/models/providers/ad-1`, { method: "DELETE", headers: authHeaders(token) })).json();
      assert.equal(adopted.willDeleteFiles, false, "adopted weights are never deleted");
    });
  } finally { await h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});

test("round 2 (a): adopt refuses a path that is not a regular file", async () => {
  const h = freshLibsql();
  const weights = mkdtempSync(join(tmpdir(), "weights-"));
  try {
    const token = await seedSession(h.db);
    await withServer({ dir: h.dir, loadCatalogFn: makeCatalog, lifecycleCoreFn: listingCore }, async (base) => {
      const r = await post(base, "/api/models/adopt", token, { catalogId: "small-chat", quant: "Q4_K_M", path: weights, allowUnverified: true });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).code, "ADOPT_NOT_A_FILE");
    });
  } finally { await h.cleanup(); rmSync(weights, { recursive: true, force: true }); }
});
