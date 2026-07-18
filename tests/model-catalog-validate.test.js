import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateCatalog } from "../scripts/validate-model-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SEED_PATH = join(REPO_ROOT, "registry/model-catalog.json");

function loadSeed() {
  return JSON.parse(readFileSync(SEED_PATH, "utf8"));
}

// Deep clone helper so each test mutates its own copy of the seed.
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function firstModel(catalog, id) {
  return catalog.models.find((m) => m.id === id);
}

test("valid seed catalog passes", () => {
  const catalog = loadSeed();
  const result = validateCatalog(catalog);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("duplicate model id fails", () => {
  const catalog = loadSeed();
  const dup = clone(firstModel(catalog, "phi-4-mini-instruct"));
  dup.id = "qwen3-4b"; // collide with the existing first_run_default entry
  catalog.models.push(dup);
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /duplicate model id/i.test(e)));
});

test("missing quant sha256 fails on an ungated entry", () => {
  const catalog = loadSeed();
  const model = firstModel(catalog, "phi-4-mini-instruct");
  assert.equal(model.gated, false);
  model.quants[0].sha256 = null;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /sha256/i.test(e)));
});

test("min_ram_mb below quant size_mb fails (RAM-math floor)", () => {
  const catalog = loadSeed();
  const model = firstModel(catalog, "phi-4-mini-instruct");
  model.quants[0].min_ram_mb = Math.floor(model.quants[0].size_mb) - 1;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /min_ram_mb/i.test(e)));
});

test("min_runtime_version greater than runtime.release fails", () => {
  const catalog = loadSeed();
  const model = firstModel(catalog, "phi-4-mini-instruct");
  // runtime.release is "b10068" in the seed.
  model.min_runtime_version = "b10069";
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /min_runtime_version/i.test(e)));
});

test("zero first_run_default entries fails", () => {
  const catalog = loadSeed();
  for (const m of catalog.models) delete m.first_run_default;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /first_run_default/i.test(e)));
});

test("two first_run_default entries fails", () => {
  const catalog = loadSeed();
  firstModel(catalog, "phi-4-mini-instruct").first_run_default = true;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /first_run_default/i.test(e)));
});

test("first_run_default entry that is gated:true fails", () => {
  const catalog = loadSeed();
  const current = firstModel(catalog, "qwen3-4b");
  delete current.first_run_default;
  const gated = firstModel(catalog, "gemma-3-27b-it");
  gated.first_run_default = true;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /first_run_default/i.test(e) && /gated/i.test(e)));
});

test("first_run_default entry with no min_vram_mb:0 quant fails", () => {
  const catalog = loadSeed();
  const model = firstModel(catalog, "qwen3-4b");
  model.quants[0].min_vram_mb = 4096;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /first_run_default/i.test(e) && /min_vram_mb/i.test(e)));
});

test("unknown runtime asset key fails", () => {
  const catalog = loadSeed();
  catalog.runtime.assets["windows-x64"] = { file: "llama-b10068-bin-win-x64.zip", sha256: "a".repeat(64) };
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unknown runtime asset key/i.test(e) || /windows-x64/i.test(e)));
});

test("missing min_glibc on a linux asset fails", () => {
  const catalog = loadSeed();
  delete catalog.runtime.assets["linux-x64-cpu"].min_glibc;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /min_glibc/i.test(e)));
});

// --- Orchestrator-decided deviation: null sha256 is valid iff gated:true ---

test("null quant sha256 is valid when the model entry is gated:true", () => {
  const catalog = loadSeed();
  const model = firstModel(catalog, "gemma-3-27b-it");
  assert.equal(model.gated, true);
  model.quants[0].sha256 = null;
  const result = validateCatalog(catalog);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("null quant sha256 is rejected when the model entry is gated:false", () => {
  const catalog = loadSeed();
  const model = firstModel(catalog, "qwen3-14b");
  assert.equal(model.gated, false);
  model.quants[0].sha256 = null;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /sha256/i.test(e)));
});
