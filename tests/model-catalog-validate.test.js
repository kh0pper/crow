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

/** The seed's first_run_default entry (read dynamically, never pinned). */
function defaultModel(catalog) {
  return catalog.models.find((m) => m.first_run_default === true);
}

/** Some ungated, non-default seed entry — the curated catalog carries no
 * gated model, so every "gated" case below builds its own fixture. */
function otherModel(catalog) {
  return catalog.models.find((m) => m.first_run_default !== true && m.gated !== true);
}

test("valid seed catalog passes", () => {
  const catalog = loadSeed();
  const result = validateCatalog(catalog);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("duplicate model id fails", () => {
  const catalog = loadSeed();
  const dup = clone(otherModel(catalog));
  dup.id = defaultModel(catalog).id; // collide with the existing first_run_default entry
  catalog.models.push(dup);
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /duplicate model id/i.test(e)));
});

test("missing quant sha256 fails on an ungated entry", () => {
  const catalog = loadSeed();
  const model = otherModel(catalog);
  assert.equal(model.gated, false);
  model.quants[0].sha256 = null;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /sha256/i.test(e)));
});

test("min_ram_mb below quant size_mb fails (RAM-math floor)", () => {
  const catalog = loadSeed();
  const model = otherModel(catalog);
  model.quants[0].min_ram_mb = Math.floor(model.quants[0].size_mb) - 1;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /min_ram_mb/i.test(e)));
});

test("min_runtime_version greater than runtime.release fails", () => {
  const catalog = loadSeed();
  const model = otherModel(catalog);
  // one build past whatever runtime.release the seed carries.
  model.min_runtime_version = `b${Number(catalog.runtime.release.slice(1)) + 1}`;
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
  otherModel(catalog).first_run_default = true;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /first_run_default/i.test(e)));
});

test("first_run_default entry that is gated:true fails", () => {
  const catalog = loadSeed();
  const current = defaultModel(catalog);
  delete current.first_run_default;
  const gated = otherModel(catalog);
  gated.gated = true;
  gated.first_run_default = true;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /first_run_default/i.test(e) && /gated/i.test(e)));
});

test("first_run_default entry with no min_vram_mb:0 quant fails", () => {
  const catalog = loadSeed();
  const model = defaultModel(catalog);
  for (const q of model.quants) q.min_vram_mb = 4096;
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
  const model = otherModel(catalog);
  model.gated = true;
  model.quants[0].sha256 = null;
  const result = validateCatalog(catalog);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("null quant sha256 is rejected when the model entry is gated:false", () => {
  const catalog = loadSeed();
  const model = otherModel(catalog);
  assert.equal(model.gated, false);
  model.quants[0].sha256 = null;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /sha256/i.test(e)));
});

// --- chat_template_kwargs (C1 Task 1) ---

test("seed first_run_default entry carries chat_template_kwargs enable_thinking:false", () => {
  const catalog = loadSeed();
  const model = defaultModel(catalog);
  assert.equal(model.first_run_default, true);
  assert.deepEqual(model.chat_template_kwargs, { enable_thinking: false });
  const result = validateCatalog(catalog);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("a model with no chat_template_kwargs still validates cleanly", () => {
  const catalog = loadSeed();
  const model = otherModel(catalog);
  assert.equal(model.chat_template_kwargs, undefined);
  const result = validateCatalog(catalog);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("chat_template_kwargs as an array fails", () => {
  const catalog = loadSeed();
  defaultModel(catalog).chat_template_kwargs = ["enable_thinking"];
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /chat_template_kwargs/i.test(e)));
});

test("chat_template_kwargs as a string fails", () => {
  const catalog = loadSeed();
  defaultModel(catalog).chat_template_kwargs = "enable_thinking:false";
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /chat_template_kwargs/i.test(e)));
});

test("chat_template_kwargs as null fails", () => {
  const catalog = loadSeed();
  defaultModel(catalog).chat_template_kwargs = null;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /chat_template_kwargs/i.test(e)));
});

// --- Schema v2: task enum, multi-part shards, companion files ---------------
//
// These cases build their own minimal catalog (not the shipped seed) so they
// stay valid no matter which models the curated catalog carries.

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function makeV2Catalog() {
  return {
    version: 1,
    runtime: {
      name: "llama.cpp",
      release: "b10068",
      assets: {
        "linux-x64-cpu": { file: "llama-b10068-bin-ubuntu-x64.tar.gz", sha256: SHA_A, min_glibc: "2.34" },
      },
    },
    models: [
      {
        id: "fixture-small",
        family: "fixture",
        lab: "Fixture Lab",
        hf_repo: "fixture/small-GGUF",
        license: "apache-2.0",
        gated: false,
        task: "chat",
        context_len: 8192,
        min_runtime_version: "b10068",
        default_quant: "Q4_K_M",
        first_run_default: true,
        tags: ["chat", "small", "cpu-capable"],
        notes: "fixture",
        quants: [
          { file: "small-Q4_K_M.gguf", quant: "Q4_K_M", size_mb: 100, min_ram_mb: 400, min_vram_mb: 0, sha256: SHA_A },
        ],
      },
      {
        id: "fixture-sharded",
        family: "fixture",
        lab: "Fixture Lab",
        hf_repo: "fixture/sharded-GGUF",
        license: "apache-2.0",
        gated: false,
        task: "chat",
        context_len: 8192,
        min_runtime_version: "b10068",
        default_quant: "Q4_K_M",
        tags: ["chat", "large"],
        notes: "fixture",
        quants: [
          {
            file: "Q4_K_M/sharded-Q4_K_M-00001-of-00003.gguf",
            quant: "Q4_K_M",
            size_mb: 300,
            min_ram_mb: 400,
            min_vram_mb: 0,
            sha256: SHA_A,
            shards: [
              { file: "Q4_K_M/sharded-Q4_K_M-00002-of-00003.gguf", size_mb: 100, sha256: SHA_B },
              { file: "Q4_K_M/sharded-Q4_K_M-00003-of-00003.gguf", size_mb: 100, sha256: SHA_C },
            ],
          },
        ],
        companions: [
          { kind: "mmproj", file: "mmproj-F16.gguf", size_mb: 10, sha256: SHA_D },
        ],
      },
    ],
  };
}

function v2Model(catalog, id) {
  return catalog.models.find((m) => m.id === id);
}

test("v2 fixture (shards + mmproj companion + chat task) validates cleanly", () => {
  const result = validateCatalog(makeV2Catalog());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("task: embedding, rerank and vision are accepted", () => {
  for (const task of ["embedding", "rerank", "vision"]) {
    const catalog = makeV2Catalog();
    v2Model(catalog, "fixture-sharded").task = task;
    const result = validateCatalog(catalog);
    assert.deepEqual(result.errors, [], `task ${task} should validate`);
  }
});

test("task outside the enum fails with an error naming task", () => {
  const catalog = makeV2Catalog();
  v2Model(catalog, "fixture-sharded").task = "banana";
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /fixture-sharded/.test(e) && /\btask\b/.test(e) && /banana/.test(e)), JSON.stringify(result.errors));
});

test("task missing entirely fails with an error naming task", () => {
  const catalog = makeV2Catalog();
  delete v2Model(catalog, "fixture-sharded").task;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /fixture-sharded/.test(e) && /\btask\b/.test(e)), JSON.stringify(result.errors));
});

test("shard missing sha256 on an ungated model fails, naming the shard", () => {
  const catalog = makeV2Catalog();
  delete v2Model(catalog, "fixture-sharded").quants[0].shards[1].sha256;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /shard\[1\]/.test(e) && /sha256/i.test(e)), JSON.stringify(result.errors));
});

test("shard missing sha256 is tolerated when the model is gated:true", () => {
  const catalog = makeV2Catalog();
  const model = v2Model(catalog, "fixture-sharded");
  model.gated = true;
  delete model.quants[0].shards[1].sha256;
  delete model.companions[0].sha256;
  const result = validateCatalog(catalog);
  assert.deepEqual(result.errors, []);
});

test("shard with a malformed sha256 fails", () => {
  const catalog = makeV2Catalog();
  v2Model(catalog, "fixture-sharded").quants[0].shards[0].sha256 = "nope";
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /shard\[0\]/.test(e) && /sha256/i.test(e)), JSON.stringify(result.errors));
});

test("shard missing file or with a non-positive size_mb fails", () => {
  let catalog = makeV2Catalog();
  delete v2Model(catalog, "fixture-sharded").quants[0].shards[0].file;
  let result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /shard\[0\]/.test(e) && /\bfile\b/.test(e)), JSON.stringify(result.errors));

  catalog = makeV2Catalog();
  v2Model(catalog, "fixture-sharded").quants[0].shards[0].size_mb = 0;
  result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /shard\[0\]/.test(e) && /size_mb/.test(e)), JSON.stringify(result.errors));
});

test("shard whose basename equals the quant's primary file fails", () => {
  const catalog = makeV2Catalog();
  const quant = v2Model(catalog, "fixture-sharded").quants[0];
  quant.shards[0].file = "other-dir/sharded-Q4_K_M-00001-of-00003.gguf";
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /shard\[0\]/.test(e) && /sharded-Q4_K_M-00001-of-00003\.gguf/.test(e)), JSON.stringify(result.errors));
});

test("two shards sharing a basename fail", () => {
  const catalog = makeV2Catalog();
  const quant = v2Model(catalog, "fixture-sharded").quants[0];
  quant.shards[1].file = quant.shards[0].file;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /shard\[1\]/.test(e) && /sharded-Q4_K_M-00002-of-00003\.gguf/.test(e)), JSON.stringify(result.errors));
});

test("companion whose basename equals a quant file fails", () => {
  const catalog = makeV2Catalog();
  v2Model(catalog, "fixture-sharded").companions[0].file = "sharded-Q4_K_M-00001-of-00003.gguf";
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /companion\[0\]/.test(e) && /sharded-Q4_K_M-00001-of-00003\.gguf/.test(e)), JSON.stringify(result.errors));
});

test("quant size_mb below the shards' total + 1 fails", () => {
  const catalog = makeV2Catalog();
  const quant = v2Model(catalog, "fixture-sharded").quants[0];
  quant.size_mb = 200.5; // shards sum to 200; primary must add at least 1 MB
  quant.min_ram_mb = 400;
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /fixture-sharded/.test(e) && /size_mb/.test(e) && /shard/i.test(e)), JSON.stringify(result.errors));
});

test("min_ram_mb is checked against the quant's TOTAL size_mb (all parts)", () => {
  const catalog = makeV2Catalog();
  const quant = v2Model(catalog, "fixture-sharded").quants[0];
  quant.min_ram_mb = 250; // less than the 300 MB total, more than the 100 MB primary part
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /min_ram_mb/.test(e)), JSON.stringify(result.errors));
});

test("shards that is not an array fails", () => {
  const catalog = makeV2Catalog();
  v2Model(catalog, "fixture-sharded").quants[0].shards = { file: "x.gguf" };
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /shards/.test(e)), JSON.stringify(result.errors));
});

test("companion kinds mmproj and mtp are accepted", () => {
  const catalog = makeV2Catalog();
  v2Model(catalog, "fixture-sharded").companions.push({ kind: "mtp", file: "mtp-sharded-Q8_0.gguf", size_mb: 5, sha256: SHA_B });
  const result = validateCatalog(catalog);
  assert.deepEqual(result.errors, []);
});

test("companion kind outside the enum fails", () => {
  const catalog = makeV2Catalog();
  v2Model(catalog, "fixture-sharded").companions[0].kind = "draft";
  const result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /companion\[0\]/.test(e) && /kind/.test(e) && /draft/.test(e)), JSON.stringify(result.errors));
});

test("companion missing size_mb, file, or sha256 (ungated) fails", () => {
  let catalog = makeV2Catalog();
  delete v2Model(catalog, "fixture-sharded").companions[0].size_mb;
  let result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /companion\[0\]/.test(e) && /size_mb/.test(e)), JSON.stringify(result.errors));

  catalog = makeV2Catalog();
  delete v2Model(catalog, "fixture-sharded").companions[0].file;
  result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /companion\[0\]/.test(e) && /\bfile\b/.test(e)), JSON.stringify(result.errors));

  catalog = makeV2Catalog();
  delete v2Model(catalog, "fixture-sharded").companions[0].sha256;
  result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /companion\[0\]/.test(e) && /sha256/i.test(e)), JSON.stringify(result.errors));
});

test("companions that is not an array fails; an empty array is fine", () => {
  let catalog = makeV2Catalog();
  v2Model(catalog, "fixture-sharded").companions = "mmproj-F16.gguf";
  let result = validateCatalog(catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /companions/.test(e)), JSON.stringify(result.errors));

  catalog = makeV2Catalog();
  v2Model(catalog, "fixture-sharded").companions = [];
  result = validateCatalog(catalog);
  assert.deepEqual(result.errors, []);
});

test("launch: a valid block on a model validates", () => {
  const c = clone(loadSeed());
  otherModel(c).launch = { ctx: 8192, ngl: 999, flash_attn: "on" };
  assert.deepEqual(validateCatalog(c).errors, []);
});

test("launch: ctx above the model's context_len fails, naming the model", () => {
  const c = clone(loadSeed());
  const m = otherModel(c);
  m.launch = { ctx: m.context_len * 2 };
  const { errors } = validateCatalog(c);
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`${m.id}.*launch.*exceeds context_len`));
});

test("launch: extra_args carrying an owned flag fails", () => {
  const c = clone(loadSeed());
  otherModel(c).launch = { extra_args: ["--alias", "x"] };
  assert.match(validateCatalog(c).errors[0], /extra_args may not contain "--alias"/);
});

test("launch: spec is accepted only with an mtp companion or the mtp tag", () => {
  const c = clone(loadSeed());
  const m = otherModel(c);
  m.launch = { spec: { type: "draft-mtp", draft_n_max: 2 } };
  m.tags = (m.tags || []).filter((t) => t !== "mtp");
  m.companions = (m.companions || []).filter((x) => x && x.kind !== "mtp");
  assert.match(validateCatalog(c).errors[0], /spec requires an mtp companion or the "mtp" tag/);
  m.tags.push("mtp");
  assert.deepEqual(validateCatalog(c).errors, []);
});

test("runtime asset key linux-x64-cuda is accepted and requires min_glibc", () => {
  const c = clone(loadSeed());
  c.runtime.assets["linux-x64-cuda"] = { file: "llama-b1-bin-ubuntu-cuda-x64.tar.gz", sha256: "a".repeat(64) };
  assert.match(validateCatalog(c).errors[0], /linux-x64-cuda.*min_glibc/);
  c.runtime.assets["linux-x64-cuda"].min_glibc = "2.34";
  assert.deepEqual(validateCatalog(c).errors, []);
});
