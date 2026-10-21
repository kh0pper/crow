/**
 * The look turn asks the GPU orchestrator to make the vision provider
 * resident before it calls it. Two refusals are expected states, not faults,
 * and must not log a warning on every photo:
 *   - model_orchestration_disabled (this host never starts models);
 *   - external_engine (the provider is another box's engine Crow never manages).
 * Anything else still warns. No refusal ever stops the turn: the vision call
 * goes ahead and surfaces its own error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { acquireVisionProvider } from "../bundles/meta-glasses/server/vision-acquire.js";

const refuse = (code, message = "refused") => async () => { throw Object.assign(new Error(message), { code }); };

for (const code of ["model_orchestration_disabled", "external_engine"]) {
  test(`acquireVisionProvider: ${code} is quiet and never throws`, async () => {
    const warnings = [];
    await acquireVisionProvider({ acquire: refuse(code), providerId: "p", warn: (m) => warnings.push(m) });
    assert.deepEqual(warnings, []);
  });
}

test("acquireVisionProvider: any other failure warns once (with the provider id) and never throws", async () => {
  const warnings = [];
  await acquireVisionProvider({ acquire: refuse("docker_failed", "compose up failed"), providerId: "crow-vision", warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /crow-vision/);
  assert.match(warnings[0], /compose up failed/);
});

test("acquireVisionProvider: a failure with no code still warns", async () => {
  const warnings = [];
  await acquireVisionProvider({ acquire: async () => { throw new Error("boom"); }, providerId: "x", warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
});

test("acquireVisionProvider: success passes the provider id through and stays quiet", async () => {
  const seen = [];
  const warnings = [];
  await acquireVisionProvider({ acquire: async (id) => { seen.push(id); return true; }, providerId: "crow-vision", warn: (m) => warnings.push(m) });
  assert.deepEqual(seen, ["crow-vision"]);
  assert.deepEqual(warnings, []);
});

test("acquireVisionProvider: a missing orchestrator module (load failure) warns, never throws", async () => {
  const warnings = [];
  await acquireVisionProvider({ acquire: null, providerId: "x", warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
});
