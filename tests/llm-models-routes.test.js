// tests/llm-models-routes.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmModelsRouter from "../servers/gateway/routes/llm-models.js";
import { ReservedError } from "../servers/gateway/box-reservation.js";

const providers = {
  "crow-chat": { models: [{ id: "qwen3.6-35b-a3b" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18102/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18102, mutexGroup: "g" } },
  "crow-slow": { models: [{ id: "slow" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18103/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18103 } },
  "crow-dead": { models: [{ id: "dead" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18104/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18104 } },
  "crow-null": { models: [{ id: "n" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18106/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18106 } },
  "crow-reserved": { models: [{ id: "r" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18105/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18105 } },
  "r4-gemma": { models: [{ id: "gemma" }], baseUrl: "http://100.64.9.1:3008/llm/v1", gpuPolicy: { runtime: "native", owner: "r4", port: 18120 } },
  "crow-local-27b": { models: [{ id: "qwen3.8-27b" }], baseUrl: "http://100.64.9.1:8006/v1", gpuPolicy: { engine: { managed: "external", host: "crow" } } },
};
let srv, url, stopped;
const RES = { owner: "win", expires_at: "2026-10-05T12:00:00Z", allow: [] };

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(llmModelsRouter({
    authFn: async (token) => token === "good",
    loadProvidersFn: () => ({ providers }),
    ownInstanceIdFn: () => "me",
    readReservationFn: () => null,
    snapshotOfFn: (n) => (n === "crow-chat" ? { live: true, argv: ["a"], stderrTail: [] } : null),
    siblingsOfFn: () => [],
    externalHealthFn: () => ({ "crow-local-27b": { ready: false } }),
    acquireFn: async (name) => {
      if (name === "crow-slow") { await new Promise((r) => setTimeout(r, 50)); return true; }
      if (name === "crow-dead") { const e = new Error("failed to bind"); e.stderrTail = ["llama_model_load: error loading model", "out of memory"]; throw e; }
      if (name === "crow-null") return null; // acquireProvider's "not orchestratable here"

      if (name === "crow-reserved") throw new ReservedError(RES, name);
      return true;
    },
    stopFn: async (name) => { stopped.push(name); return { stopped: true }; },
  }));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());

const auth = { authorization: "Bearer good", "content-type": "application/json" };
async function waitJob(id) {
  for (let i = 0; i < 40; i++) {
    const j = await (await fetch(`${url}/llm/models/jobs/${id}`, { headers: auth })).json();
    if (["resident", "failed", "blocked_by_reservation"].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job never finished");
}

test("401 without a bearer, 401 with a wrong one", async () => {
  assert.equal((await fetch(`${url}/llm/models`)).status, 401);
  assert.equal((await fetch(`${url}/llm/models`, { headers: { authorization: "Bearer bad" } })).status, 401);
});

test("GET /llm/models lists native, external and foreign rows", async () => {
  const j = await (await fetch(`${url}/llm/models`, { headers: auth })).json();
  const by = Object.fromEntries(j.models.map((m) => [m.provider, m]));
  assert.equal(by["crow-chat"].status, "resident");
  assert.equal(by["crow-local-27b"].status, "external_down");
  assert.equal(by["r4-gemma"].status, "foreign");
});

test("start returns 202 with a job that reaches resident", async () => {
  const r = await fetch(`${url}/llm/models/crow-slow/start`, { method: "POST", headers: auth });
  assert.equal(r.status, 202);
  const { job_id } = await r.json();
  assert.equal((await waitJob(job_id)).state, "resident");
});

test("a start that fails carries cause (stderr tail) and error", async () => {
  const { job_id } = await (await fetch(`${url}/llm/models/crow-dead/start`, { method: "POST", headers: auth })).json();
  const j = await waitJob(job_id);
  assert.equal(j.state, "failed");
  assert.match(j.error, /failed to bind/);
  assert.deepEqual(j.cause, ["llama_model_load: error loading model", "out of memory"], "the orchestrator's stderr tail, not the (already removed) handle's");
});

test("an acquire that returns anything but true is a failed job, never resident", async () => {
  const { job_id } = await (await fetch(`${url}/llm/models/crow-null/start`, { method: "POST", headers: auth })).json();
  const j = await waitJob(job_id);
  assert.equal(j.state, "failed");
  assert.match(j.error, /not started/);
});

test("/llm/models refuses Funnel-headed requests itself", async () => {
  const r = await fetch(`${url}/llm/models`, { headers: { ...auth, "tailscale-funnel-request": "?1" } });
  assert.equal(r.status, 403);
});

test("a reserved start reports blocked_by_reservation with owner and expiry", async () => {
  const { job_id } = await (await fetch(`${url}/llm/models/crow-reserved/start`, { method: "POST", headers: auth })).json();
  const j = await waitJob(job_id);
  assert.equal(j.state, "blocked_by_reservation");
  assert.deepEqual(j.reservation, { owner: "win", expires_at: "2026-10-05T12:00:00Z" });
});

test("a second start while one is active returns the same job", async () => {
  const a = await (await fetch(`${url}/llm/models/crow-slow/start`, { method: "POST", headers: auth })).json();
  const b = await (await fetch(`${url}/llm/models/crow-slow/start`, { method: "POST", headers: auth })).json();
  assert.equal(a.job_id, b.job_id);
  await waitJob(a.job_id);
});

test("NOT_OWNER and EXTERNAL_ENGINE are 409s; stop works for an owned row", async () => {
  const f = await fetch(`${url}/llm/models/r4-gemma/stop`, { method: "POST", headers: auth });
  assert.equal(f.status, 409);
  const fj = await f.json();
  assert.equal(fj.error.code, "NOT_OWNER");
  assert.equal(fj.error.owner, "r4");
  assert.equal(fj.error.door, "http://100.64.9.1:3008/llm/v1");
  const e = await fetch(`${url}/llm/models/crow-local-27b/start`, { method: "POST", headers: auth });
  assert.equal(e.status, 409);
  assert.equal((await e.json()).error.code, "EXTERNAL_ENGINE");
  stopped = [];
  const s = await fetch(`${url}/llm/models/crow-chat/stop`, { method: "POST", headers: auth });
  assert.equal(s.status, 200);
  assert.deepEqual(stopped, ["crow-chat"]);
});

test("unknown provider is 404", async () => {
  assert.equal((await fetch(`${url}/llm/models/nope/start`, { method: "POST", headers: auth })).status, 404);
});
