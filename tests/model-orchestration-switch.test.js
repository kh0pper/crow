import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isModelOrchestrationDisabled, OrchestrationDisabledError, ORCHESTRATION_DISABLED_ENV, isModelBundleManifest,
} from "../servers/shared/model-orchestration.js";

test("env name is CROW_DISABLE_MODEL_ORCHESTRATION", () => {
  assert.equal(ORCHESTRATION_DISABLED_ENV, "CROW_DISABLE_MODEL_ORCHESTRATION");
});

test("truth table: only 1/true (trimmed, any case) disable orchestration", () => {
  const on = ["1", "true", "TRUE", " 1 ", "True"];
  const off = [undefined, "", "0", "false", "no", "yes", "2", " "];
  for (const v of on) assert.equal(isModelOrchestrationDisabled({ CROW_DISABLE_MODEL_ORCHESTRATION: v }), true, `value ${JSON.stringify(v)}`);
  for (const v of off) {
    const env = v === undefined ? {} : { CROW_DISABLE_MODEL_ORCHESTRATION: v };
    assert.equal(isModelOrchestrationDisabled(env), false, `value ${JSON.stringify(v)}`);
  }
});

test("reads process.env at call time (not cached at import)", () => {
  const prev = process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  try {
    delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
    assert.equal(isModelOrchestrationDisabled(), false);
    process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
    assert.equal(isModelOrchestrationDisabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
    else process.env.CROW_DISABLE_MODEL_ORCHESTRATION = prev;
  }
});

test("OrchestrationDisabledError carries code/http/provider and names the env var", () => {
  const e = new OrchestrationDisabledError("crow-chat");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "OrchestrationDisabledError");
  assert.equal(e.code, "model_orchestration_disabled");
  assert.equal(e.http, 409);
  assert.equal(e.provider, "crow-chat");
  assert.match(e.message, /CROW_DISABLE_MODEL_ORCHESTRATION/);
  assert.equal(new OrchestrationDisabledError().provider, null);
});

test("isModelBundleManifest: inference, requires.gpu, or non-empty providers", () => {
  assert.equal(isModelBundleManifest({ inference: true }), true);
  assert.equal(isModelBundleManifest({ requires: { gpu: true } }), true);
  assert.equal(isModelBundleManifest({ requires: { gpu: "amd" } }), true);
  assert.equal(isModelBundleManifest({ providers: [{ id: "x" }] }), true);
  assert.equal(isModelBundleManifest({ requires: { gpu_arch: ["cuda", "rocm", "cpu"] } }), true); // ollama/localai shape
  assert.equal(isModelBundleManifest({ requires: { gpu_arch: [] } }), false);
  assert.equal(isModelBundleManifest({ sttProfileSeed: { id: "whisper" } }), true); // faster-whisper-server
  assert.equal(isModelBundleManifest({ ttsProfileSeed: { id: "kokoro" } }), true);  // kokoro-tts
  assert.equal(isModelBundleManifest({ providers: [] }), false);
  assert.equal(isModelBundleManifest({ inference: false, requires: { gpu: false } }), false);
  assert.equal(isModelBundleManifest({}), false);
  assert.equal(isModelBundleManifest(null), false);
  assert.equal(isModelBundleManifest(undefined), false);
});
