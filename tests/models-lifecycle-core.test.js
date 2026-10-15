/**
 * Models plan 3a, Task 2 (+ Rev 2 H1/H2/M3): one lifecycle core behind two
 * doors. The dashboard-session door (/api/models/providers/*, /api/models/jobs)
 * delegates to the same core and job store as the bearer door (/llm/models).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createLifecycleCore } from "../servers/gateway/models/lifecycle-core.js";
import { createJobStore, sharedJobStore } from "../servers/gateway/models/lifecycle.js";
import {
  freshLibsql, seedSession, authHeaders, noCsrfHeaders, noSessionHeaders, withServer, withOrchestrationDisabled,
} from "./fixtures/models-routes-harness.mjs";

const PROVIDERS = {
  "crow-chat": { models: [{ id: "chat-model" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18102/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18102 } },
  "crow-dead": { models: [{ id: "dead" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18104/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18104 } },
  "crow-slow": { models: [{ id: "slow" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18105/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18105 } },
  "peer-gemma": { models: [{ id: "gemma" }], baseUrl: "http://100.64.9.1:3008/llm/v1", gpuPolicy: { runtime: "native", owner: "peer", port: 18120 } },
  "ext-27b": { models: [{ id: "big" }], baseUrl: "http://100.64.9.1:8006/v1", gpuPolicy: { engine: { managed: "external", host: "peer" } } },
  "bundle-embed": { models: [{ id: "emb" }], baseUrl: "http://127.0.0.1:8004/v1", bundleId: "llamacpp-embed", gpuPolicy: {} },
};

function coreDeps(overrides = {}) {
  const calls = { acquire: [], stop: [] };
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    providersFn: () => PROVIDERS,
    ownInstanceIdFn: () => "me",
    readReservationFn: () => null,
    snapshotOfFn: () => null,
    siblingsOfFn: () => [],
    externalHealthFn: () => ({}),
    acquireFn: async (name, opts) => {
      calls.acquire.push([name, opts.requester]);
      if (name === "crow-dead") { const e = new Error("failed to bind"); e.stderrTail = ["boom"]; throw e; }
      if (name === "crow-slow") await gate;
      return true;
    },
    stopFn: async (name) => { calls.stop.push(name); return { stopped: true }; },
    jobs: createJobStore(),
    ...overrides,
  };
  return { deps, calls, release: () => release() };
}

async function waitJob(base, token, id) {
  for (let i = 0; i < 50; i++) {
    const j = await (await fetch(`${base}/api/models/jobs/${id}`, { headers: authHeaders(token) })).json();
    if (["resident", "failed", "blocked_by_reservation"].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job never finished");
}

test("sharedJobStore is one store per process", () => {
  assert.equal(sharedJobStore(), sharedJobStore());
});

test("two cores on sharedJobStore see one start: the second door joins the first job", () => {
  const a = coreDeps({ jobs: sharedJobStore() });
  const b = coreDeps({ jobs: sharedJobStore() });
  const panel = createLifecycleCore(a.deps);
  const bearer = createLifecycleCore(b.deps);
  const first = panel.start("crow-slow", "models-panel");
  assert.equal(first.status, 202);
  assert.ok(bearer.jobs.activeFor("crow-slow"), "the other door sees the active job");
  const listed = bearer.listing().find((r) => r.provider === "crow-slow");
  assert.equal(listed.status, "loading");
  const second = bearer.start("crow-slow", "pi-lab");
  assert.equal(second.body.job_id, first.body.job_id, "never two llama-servers for one provider");
  assert.equal(a.calls.acquire.length + b.calls.acquire.length, 1);
  a.release();
});

const NEW_MUTATING = [
  ["POST", "/api/models/providers/crow-chat/start"],
  ["POST", "/api/models/providers/crow-chat/stop"],
  ["DELETE", "/api/models/providers/crow-chat"],
];

test("every new route answers 401 without a session", async () => {
  const h = freshLibsql();
  try {
    const { deps } = coreDeps();
    await withServer({ dir: h.dir, lifecycleCoreFn: () => createLifecycleCore(deps) }, async (base) => {
      for (const [method, path] of [...NEW_MUTATING, ["GET", "/api/models/jobs/x"]]) {
        const r = await fetch(base + path, { method, headers: noSessionHeaders() });
        assert.equal(r.status, 401, `${method} ${path}`);
      }
    });
  } finally { await h.cleanup(); }
});

test("every new mutating route answers 403 without the X-Crow-Csrf echo, and nothing runs", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { deps, calls } = coreDeps();
    await withServer({ dir: h.dir, lifecycleCoreFn: () => createLifecycleCore(deps) }, async (base) => {
      for (const [method, path] of NEW_MUTATING) {
        const r = await fetch(base + path, { method, headers: noCsrfHeaders(token) });
        assert.equal(r.status, 403, `${method} ${path}`);
      }
    });
    assert.deepEqual(calls.acquire, []);
    assert.deepEqual(calls.stop, []);
  } finally { await h.cleanup(); }
});

test("start: 202 with a job; a failing start carries the stderr cause; requester is models-panel", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { deps, calls } = coreDeps();
    await withServer({ dir: h.dir, lifecycleCoreFn: () => createLifecycleCore(deps) }, async (base) => {
      const ok = await fetch(`${base}/api/models/providers/crow-chat/start`, { method: "POST", headers: authHeaders(token) });
      assert.equal(ok.status, 202);
      const { job_id } = await ok.json();
      assert.equal((await waitJob(base, token, job_id)).state, "resident");
      assert.deepEqual(calls.acquire[0], ["crow-chat", "models-panel"]);

      const bad = await (await fetch(`${base}/api/models/providers/crow-dead/start`, { method: "POST", headers: authHeaders(token) })).json();
      const j = await waitJob(base, token, bad.job_id);
      assert.equal(j.state, "failed");
      assert.deepEqual(j.cause, ["boom"]);

      const missing = await fetch(`${base}/api/models/jobs/nope`, { headers: authHeaders(token) });
      assert.equal(missing.status, 404);
    });
  } finally { await h.cleanup(); }
});

test("a foreign row is 409 NOT_OWNER with owner; an external engine 409 EXTERNAL_ENGINE (start and stop)", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { deps, calls } = coreDeps();
    await withServer({ dir: h.dir, lifecycleCoreFn: () => createLifecycleCore(deps) }, async (base) => {
      for (const verb of ["start", "stop"]) {
        const f = await fetch(`${base}/api/models/providers/peer-gemma/${verb}`, { method: "POST", headers: authHeaders(token) });
        assert.equal(f.status, 409);
        const fj = await f.json();
        assert.equal(fj.code, "NOT_OWNER");
        assert.equal(fj.owner, "peer");
        assert.equal(typeof fj.error, "string");
        const e = await fetch(`${base}/api/models/providers/ext-27b/${verb}`, { method: "POST", headers: authHeaders(token) });
        assert.equal(e.status, 409);
        assert.equal((await e.json()).code, "EXTERNAL_ENGINE");
      }
      const s = await fetch(`${base}/api/models/providers/crow-chat/stop`, { method: "POST", headers: authHeaders(token) });
      assert.equal(s.status, 200);
    });
    assert.deepEqual(calls.acquire, []);
    assert.deepEqual(calls.stop, ["crow-chat"]);
  } finally { await h.cleanup(); }
});

test("orchestration off: start and stop answer 409 MODEL_ORCHESTRATION_DISABLED before any job exists", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { deps, calls } = coreDeps();
    await withServer({ dir: h.dir, lifecycleCoreFn: () => createLifecycleCore(deps) }, async (base) => {
      await withOrchestrationDisabled(async () => {
        for (const verb of ["start", "stop"]) {
          const r = await fetch(`${base}/api/models/providers/crow-chat/${verb}`, { method: "POST", headers: authHeaders(token) });
          assert.equal(r.status, 409);
          assert.equal((await r.json()).code, "MODEL_ORCHESTRATION_DISABLED");
        }
      });
    });
    assert.deepEqual(calls.acquire, []);
    assert.deepEqual(calls.stop, []);
    assert.equal(deps.jobs.activeFor("crow-chat"), null);
  } finally { await h.cleanup(); }
});

test("DELETE is two-step: bindings first, then stop + unregister with ?confirm=true", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { deps, calls } = coreDeps();
    const unregistered = [];
    await withServer({
      dir: h.dir,
      lifecycleCoreFn: () => createLifecycleCore(deps),
      providerBindingsFn: async (db, id) => ({ profiles: [{ id: "p1", provider_id: id }], bots: [] }),
      unregisterModelFn: async (args) => { unregistered.push(args.modelId); return { disabled: true, deleted: false }; },
    }, async (base) => {
      const first = await fetch(`${base}/api/models/providers/crow-chat`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(first.status, 200);
      const fb = await first.json();
      assert.equal(fb.requiresConfirm, true);
      assert.equal(fb.bindings.profiles.length, 1);
      assert.deepEqual(unregistered, [], "nothing removed before confirm");

      const second = await fetch(`${base}/api/models/providers/crow-chat?confirm=true`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(second.status, 200);
      const sb = await second.json();
      assert.equal(sb.deleted, true);
      assert.deepEqual(calls.stop, ["crow-chat"], "stopped through stopNativeProvider (the single-flight queue)");
      assert.deepEqual(unregistered, ["crow-chat"]);
    });
  } finally { await h.cleanup(); }
});

test("DELETE refuses rows this instance does not own natively, and a row with a start in progress", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { deps, release } = coreDeps();
    const core = createLifecycleCore(deps);
    const unregistered = [];
    await withServer({
      dir: h.dir,
      lifecycleCoreFn: () => core,
      providerBindingsFn: async () => ({ profiles: [], bots: [] }),
      unregisterModelFn: async (args) => { unregistered.push(args.modelId); return { disabled: true, deleted: false }; },
    }, async (base) => {
      const expect = { "peer-gemma": "NOT_OWNER", "ext-27b": "EXTERNAL_ENGINE", "bundle-embed": "BUNDLE_ROW" };
      for (const [id, code] of Object.entries(expect)) {
        const r = await fetch(`${base}/api/models/providers/${id}?confirm=true`, { method: "DELETE", headers: authHeaders(token) });
        assert.equal(r.status, 409, id);
        assert.equal((await r.json()).code, code, id);
      }
      core.start("crow-slow", "test");
      const busy = await fetch(`${base}/api/models/providers/crow-slow?confirm=true`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(busy.status, 409);
      assert.equal((await busy.json()).code, "START_IN_PROGRESS");
      const unknown = await fetch(`${base}/api/models/providers/nope`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(unknown.status, 404);
    });
    assert.deepEqual(unregistered, []);
    release();
  } finally { await h.cleanup(); }
});

// ─── Review fixes (2026-10-15) ──────────────────────────────────────────────

test("review 2: a confirmed DELETE holds the provider: a start from either door during the removal is refused, and nothing is acquired", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { deps, calls } = coreDeps();
    const core = createLifecycleCore(deps);
    const bearer = createLifecycleCore({ ...deps });
    let releaseBindings;
    const bindingsGate = new Promise((r) => { releaseBindings = r; });
    let midStart = null;
    await withServer({
      dir: h.dir,
      lifecycleCoreFn: () => core,
      providerBindingsFn: async () => {
        // A start arrives while the removal awaits.
        midStart = bearer.start("crow-chat", "pi-lab");
        await bindingsGate;
        return { profiles: [], bots: [] };
      },
      unregisterModelFn: async () => ({ disabled: true, deleted: false }),
    }, async (base) => {
      const del = fetch(`${base}/api/models/providers/crow-chat?confirm=true`, { method: "DELETE", headers: authHeaders(token) });
      while (!midStart) await new Promise((r) => setTimeout(r, 5));
      releaseBindings();
      const r = await del;
      assert.equal(r.status, 200);
      assert.equal(midStart.status, 409);
      assert.equal(midStart.body.code, "REMOVING");
      assert.deepEqual(calls.acquire, [], "no llama-server started under a removal");
      assert.equal(deps.jobs.isRemoving("crow-chat"), false, "the hold is released afterwards");
      assert.equal(core.start("crow-chat", "x").status, 202, "starts work again once the removal is over");
    });
  } finally { await h.cleanup(); }
});

test("review 2: the hold is released even when the removal fails", async () => {
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const { deps } = coreDeps();
    await withServer({
      dir: h.dir, lifecycleCoreFn: () => createLifecycleCore(deps),
      providerBindingsFn: async () => ({ profiles: [], bots: [] }),
      unregisterModelFn: async () => { throw new Error("disk on fire"); },
    }, async (base) => {
      const r = await fetch(`${base}/api/models/providers/crow-chat?confirm=true`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(r.status, 500);
    });
    assert.equal(deps.jobs.isRemoving("crow-chat"), false);
  } finally { await h.cleanup(); }
});

test("review 8: the real llmModelsRouter() and modelsRouter() defaults share one job store", async () => {
  const { default: express } = await import("express");
  const { default: llmModelsRouter } = await import("../servers/gateway/routes/llm-models.js");
  const h = freshLibsql();
  try {
    const token = await seedSession(h.db);
    const job = sharedJobStore().create("shared-probe");
    const app = express();
    app.use(express.json());
    app.use(llmModelsRouter({ authFn: async (t) => t === "good" }));
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    try {
      const viaBearer = await fetch(`http://127.0.0.1:${server.address().port}/llm/models/jobs/${job.id}`, { headers: { authorization: "Bearer good" } });
      assert.equal(viaBearer.status, 200);
      assert.equal((await viaBearer.json()).provider, "shared-probe");
    } finally { server.close(); }
    await withServer({ dir: h.dir }, async (base) => {
      const viaPanel = await fetch(`${base}/api/models/jobs/${job.id}`, { headers: authHeaders(token) });
      assert.equal(viaPanel.status, 200);
      assert.equal((await viaPanel.json()).provider, "shared-probe");
    });
    sharedJobStore().update(job.id, { state: "failed" });
  } finally { await h.cleanup(); }
});

test("round 2 (b): a throw while choosing evicting/starting fails the job instead of leaving it queued forever", async () => {
  const { deps } = coreDeps({ siblingsOfFn: () => { throw new Error("orchestrator unavailable"); } });
  const core = createLifecycleCore(deps);
  const { body } = core.start("crow-chat", "t");
  await new Promise((r) => setImmediate(r));
  const j = core.job(body.job_id).body;
  assert.equal(j.state, "failed");
  assert.match(j.error, /orchestrator unavailable/);
  assert.equal(deps.jobs.activeFor("crow-chat"), null);
});
