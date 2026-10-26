// tests/gpu-orchestrator-compose-guard.test.js
//
// Follow-up A (queue item 30): the gpu-orchestrator's `compose up` goes through the
// install security check. Only model bundles (repo manifest inference: true) are started
// or stopped; the check reads the model of exactly the invocation `up` runs (-f, cwd,
// env); the env is the gateway's allowlisted compose env, never its secrets; and a
// refused start happens BEFORE any mutex sibling is evicted. Every `docker compose`
// spawn is stubbed: nothing here runs docker.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as orch from "../servers/gateway/gpu-orchestrator.js";

const MODEL = "vllm-rocm-qwen35-4b"; // a real repo model bundle (inference: true)
const svc = (extra = {}) => JSON.stringify({ name: MODEL, services: { [MODEL]: { image: "x", ...extra } } });

let calls, configOut, saved;
beforeEach(() => {
  calls = [];
  configOut = svc({ devices: [{ source: "/dev/kfd", target: "/dev/kfd" }], shm_size: String(8 * 1024 ** 3) });
  orch._setOrchestratorComposeRunnerForTest(async (args, opts) => {
    calls.push({ args, opts });
    if (args.includes("config")) return { stdout: configOut, stderr: "" };
    return { stdout: "", stderr: "" };
  });
  orch._setReservationReaderForTest(() => null);
  orch._setReservationNoticeSenderForTest(async () => {});
  saved = { gh: process.env.GITHUB_PERSONAL_ACCESS_TOKEN, cf: process.env.COMPOSE_FILE, cp: process.env.COMPOSE_PROJECT_NAME };
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "gateway-secret-value";
  process.env.COMPOSE_FILE = "evil.yml";
  process.env.COMPOSE_PROJECT_NAME = "someone-else";
});
afterEach(() => {
  orch._setOrchestratorComposeRunnerForTest(null);
  orch._setReservationReaderForTest(null);
  orch._setReservationNoticeSenderForTest(null);
  for (const [k, v] of [["GITHUB_PERSONAL_ACCESS_TOKEN", saved.gh], ["COMPOSE_FILE", saved.cf], ["COMPOSE_PROJECT_NAME", saved.cp]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("a passing model bundle: one config, then one up, with the same -f, cwd and env; no gateway secret, no COMPOSE_*", async () => {
  await orch._bundleUpForTest(MODEL);
  assert.equal(calls.length, 2, JSON.stringify(calls.map((c) => c.args)));
  const [cfg, up] = calls;
  assert.deepEqual(cfg.args.slice(0, 2), ["-f", up.args[1]]);
  assert.ok(cfg.args.includes("config"));
  assert.deepEqual(up.args, ["-f", up.args[1], "up", "-d"]);
  assert.match(up.args[1], new RegExp(`/bundles/${MODEL}/docker-compose\\.yml$`));
  assert.equal(cfg.opts.cwd, up.opts.cwd);
  const { COMPOSE_PROFILES, ...cfgEnv } = cfg.opts.env;
  assert.equal(COMPOSE_PROFILES, "*", "the check sees every profile");
  assert.deepEqual(cfgEnv, up.opts.env, "the check and up get the same env");
  for (const k of ["GITHUB_PERSONAL_ACCESS_TOKEN", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME"]) assert.equal(up.opts.env[k], undefined, k);
  assert.ok(up.opts.env.HOME && up.opts.env.CROW_HOME, "HOME and CROW_HOME are passed");
});

test("a model the check refuses: ComposeGuardError, and no up", async () => {
  configOut = svc({ privileged: true });
  await assert.rejects(() => orch._bundleUpForTest(MODEL), (e) => e instanceof orch.ComposeGuardError && /privileged/.test(e.reason));
  assert.equal(calls.filter((c) => c.args.includes("up")).length, 0);
  configOut = svc({ ipc: "host" });
  await assert.rejects(() => orch._bundleUpForTest(MODEL), orch.ComposeGuardError, "ipc: host is refused for a model bundle too");
});

test("Compose unable to produce a model: refused (fail-closed), no up", async () => {
  orch._setOrchestratorComposeRunnerForTest(async (args) => {
    calls.push({ args });
    if (args.includes("config")) throw Object.assign(new Error("exit 15"), { stderr: "variable is not set" });
    return { stdout: "" };
  });
  await assert.rejects(() => orch._bundleUpForTest(MODEL), orch.ComposeGuardError);
  assert.equal(calls.filter((c) => c.args.includes("up")).length, 0);
});

test("only model bundles: a provider row naming any other repo bundle is never started or stopped", async () => {
  for (const id of ["caddy", "companion", "does-not-exist"]) {
    await assert.rejects(() => orch._bundleUpForTest(id), (e) => e instanceof orch.ComposeGuardError && /inference/.test(e.reason), id);
    await assert.rejects(() => orch._bundleStopForTest(id), orch.ComposeGuardError, id);
  }
  assert.equal(calls.length, 0, "no compose call at all");
  await assert.rejects(() => orch._bundleUpForTest(".."), /unsafe bundleId/);
});

test("stop of a model bundle uses the same -f/cwd and the allowlisted env", async () => {
  await orch._bundleStopForTest(MODEL);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(2), ["stop"]);
  assert.equal(calls[0].opts.env.GITHUB_PERSONAL_ACCESS_TOKEN, undefined);
});

test("a refused target is refused BEFORE any mutex sibling is evicted", async () => {
  configOut = svc({ privileged: true });
  const cfg = {
    providers: {
      "crow-voice": { bundleId: MODEL, baseUrl: "http://127.0.0.1:8011/v1", host: "local", gpuPolicy: { mutexGroup: "g" } },
      "crow-chat": { bundleId: "llamacpp-vulkan-qwen36-35b-a3b", baseUrl: "http://127.0.0.1:8003/v1", host: "local", gpuPolicy: { mutexGroup: "g" } },
    },
  };
  let stopped = 0;
  await assert.rejects(() => orch.acquireProvider("crow-voice", {
    cfg,
    probeReadyFn: async (u) => u.includes(":8003"), // the sibling is resident, the target is not
    bundleStopFn: async () => { stopped++; },
    waitForReadyFn: async () => true,
  }), orch.ComposeGuardError);
  assert.equal(stopped, 0, "the resident sibling was not stopped");
  assert.equal(calls.filter((c) => c.args.includes("up")).length, 0);
});

test("a passing target: checked once before the eviction, then up with that same invocation", async () => {
  const cfg = {
    providers: {
      "crow-voice": { bundleId: MODEL, baseUrl: "http://127.0.0.1:8011/v1", host: "local", gpuPolicy: { mutexGroup: "g" } },
      "crow-chat": { bundleId: "llamacpp-vulkan-qwen36-35b-a3b", baseUrl: "http://127.0.0.1:8003/v1", host: "local", gpuPolicy: { mutexGroup: "g" } },
    },
  };
  const order = [];
  orch._setOrchestratorComposeRunnerForTest(async (args, opts) => {
    order.push(args.includes("config") ? "config" : args.includes("up") ? "up" : args.join(" "));
    calls.push({ args, opts });
    return { stdout: args.includes("config") ? configOut : "" };
  });
  const r = await orch.acquireProvider("crow-voice", {
    cfg,
    probeReadyFn: async (u) => u.includes(":8003"),
    bundleStopFn: async () => { order.push("stop-sibling"); },
    waitForReadyFn: async () => true,
  });
  assert.equal(r, true);
  assert.deepEqual(order, ["config", "stop-sibling", "up"]);
});
