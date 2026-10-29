// Which bundles a satellite may install (SAT-3, spec §7.1): only manifests with `satellite`
// set (true, or the measured object {min_ram_mb}). v1's allowed set is exactly ["gitea"]; it is
// not set on gitea yet (Gitea G1 brings the M1-measured numbers), so today's set may be empty.
// GPU, model, desktop and browser bundles never are; an eligible bundle carries the measured
// numbers the gate and admission need.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const { satelliteEligible, satelliteManifestProblem } = await import("../servers/satellite/gate.js");

const BUNDLES = join(import.meta.dirname, "..", "bundles");
const V1_ALLOWED = ["gitea"];

const manifests = readdirSync(BUNDLES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(BUNDLES, d.name, "manifest.json")))
  .map((d) => ({ dir: d.name, m: JSON.parse(readFileSync(join(BUNDLES, d.name, "manifest.json"), "utf8")) }));

test("the satellite set is a subset of the v1 allowlist", () => {
  assert.ok(manifests.length > 20, "the scan read the bundle manifests");
  const set = manifests.filter(({ m }) => satelliteEligible(m)).map(({ dir }) => dir).sort();
  for (const id of set) assert.ok(V1_ALLOWED.includes(id), `bundles/${id} sets "satellite" but is not in the v1 allowlist ${JSON.stringify(V1_ALLOWED)}`);
});

test("every satellite bundle is measured (numeric satellite.min_ram_mb and mcp.mem_mb) and installable", () => {
  for (const { dir, m } of manifests.filter(({ m: x }) => satelliteEligible(x))) {
    assert.equal(typeof m.satellite?.min_ram_mb, "number", `bundles/${dir}: satellite.min_ram_mb`);
    assert.equal(typeof m.mcp?.mem_mb, "number", `bundles/${dir}: mcp.mem_mb`);
    assert.equal(satelliteManifestProblem(m), null, `bundles/${dir}`);
  }
});

test("GPU, model, desktop and browser bundles never set satellite", () => {
  for (const { dir, m } of manifests) {
    const heavy = m.host_grants?.gpu || m.requires?.gpu || m.type === "model" || /model|desktop/.test(String(m.category || "")) || dir === "browser";
    if (heavy) assert.ok(!satelliteEligible(m), `bundles/${dir} must not be a satellite bundle`);
  }
});

test("the lint's own logic: an eligible heavy bundle would be caught", () => {
  assert.equal(satelliteManifestProblem({ id: "llm", satellite: { min_ram_mb: 64 }, mcp: { mem_mb: 30 }, host_grants: { gpu: true } }).code, "never_satellite");
  assert.equal(satelliteEligible({ satellite: true }), true);
  assert.equal(satelliteEligible({ satellite: { min_ram_mb: 1 } }), true);
  assert.equal(satelliteEligible({ satellite: false }), false);
  assert.equal(satelliteEligible({}), false);
});
