// tests/bundles-orchestration-switch.test.js
//
// Spec 2026-09-24 D4 (corrected): under CROW_DISABLE_MODEL_ORCHESTRATION a
// model bundle can be neither installed nor started/stopped — locally or via
// a peer-forwarded /bundles/api/start. Uses real repo manifests:
// llamacpp-vulkan-qwen36-35b-a3b (inference + gpu), caddy (not a model bundle).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bundleOrchestrationRefusal, validateInstall } from "../servers/gateway/routes/bundles.js";
import { _setDockerProbeForTest } from "../servers/gateway/dashboard/panels/extensions/data-queries.js";

_setDockerProbeForTest(true); // same pin as bundles-validate-install.test.js

const prev = process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
afterEach(() => {
  if (prev === undefined) delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  else process.env.CROW_DISABLE_MODEL_ORCHESTRATION = prev;
});

test("switch on: a model bundle is refused with 409 MODEL_ORCHESTRATION_DISABLED", () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  const r = bundleOrchestrationRefusal("llamacpp-vulkan-qwen36-35b-a3b");
  assert.equal(r?.status, 409);
  assert.equal(r?.code, "MODEL_ORCHESTRATION_DISABLED");
  assert.match(r.error, /CROW_DISABLE_MODEL_ORCHESTRATION/);
});

test("switch on: ollama (gpu_arch only) and faster-whisper-server (stt seed) are refused", () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  assert.equal(bundleOrchestrationRefusal("ollama")?.code, "MODEL_ORCHESTRATION_DISABLED");
  assert.equal(bundleOrchestrationRefusal("faster-whisper-server")?.code, "MODEL_ORCHESTRATION_DISABLED");
  assert.equal(bundleOrchestrationRefusal("companion"), null);
});

test("switch on: a non-model bundle passes; switch off: a model bundle passes", () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  assert.equal(bundleOrchestrationRefusal("caddy"), null);
  delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  assert.equal(bundleOrchestrationRefusal("llamacpp-vulkan-qwen36-35b-a3b"), null);
});

test("switch on: unknown bundle id -> null (other gates own not-found)", () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  assert.equal(bundleOrchestrationRefusal("definitely-not-a-real-bundle"), null);
});

test("switch on: validateInstall refuses a model bundle before any other gate", async () => {
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  const r = await validateInstall("llamacpp-vulkan-qwen36-35b-a3b", { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "MODEL_ORCHESTRATION_DISABLED");
});

test("dispatchBundleAction's LOCAL path calls the guard before runCompose (peer-forwarded starts land here)", () => {
  const src = readFileSync(new URL("../servers/gateway/routes/bundles.js", import.meta.url), "utf8");
  const at = src.indexOf("// Local path");
  assert.ok(at > 0, "local-path marker not found");
  const local = src.slice(at, src.indexOf("runCompose(", at));
  assert.match(local, /bundleOrchestrationRefusal\(bundleId\)/);
});

test("uninstall and shared-storage apply routes call the guard before any compose", () => {
  const src = readFileSync(new URL("../servers/gateway/routes/bundles.js", import.meta.url), "utf8");
  for (const route of ['router.post("/bundles/api/uninstall"', 'router.post("/bundles/api/shared-storage/apply/:id"']) {
    const at = src.indexOf(route);
    assert.ok(at > 0, `${route} not found`);
    const body = src.slice(at, src.indexOf("runCompose(", at));
    assert.match(body, /bundleOrchestrationRefusal\(/, `${route} must call the guard before runCompose`);
  }
});
