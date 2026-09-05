import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLaunch, mergeLaunch, renderLaunchArgs, LAUNCH_OWNED_FLAGS } from "../servers/gateway/models/launch.js";

const FULL = {
  ctx: 262144, ngl: 999, flash_attn: "on", parallel: 1, no_mmap: true, kv_type: "q8_0",
  spec: { type: "draft-mtp", draft_n_max: 2 },
  sampling: { temp: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0 },
  jinja: true,
  extra_args: ["--pooling", "mean"],
};

test("validateLaunch: the full example is valid", () => {
  assert.deepEqual(validateLaunch(FULL, { contextLen: 262144, hasMtp: true }), []);
});

test("validateLaunch: null/undefined launch is valid (absent block)", () => {
  assert.deepEqual(validateLaunch(undefined), []);
  assert.deepEqual(validateLaunch(null), []);
});

test("validateLaunch: non-object fails naming the label", () => {
  const errs = validateLaunch("x", { label: "models[3].launch" });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /models\[3\]\.launch.*object/);
});

test("validateLaunch: unknown top-level key fails", () => {
  const errs = validateLaunch({ ctxx: 1 });
  assert.match(errs[0], /unknown key "ctxx"/);
});

test("validateLaunch: ctx must be an integer >= 1024 and <= contextLen", () => {
  assert.match(validateLaunch({ ctx: 100 })[0], /ctx/);
  assert.match(validateLaunch({ ctx: 4096.5 })[0], /ctx/);
  assert.match(validateLaunch({ ctx: 300000 }, { contextLen: 262144 })[0], /ctx 300000 exceeds context_len 262144/);
  assert.deepEqual(validateLaunch({ ctx: 262144 }, { contextLen: 262144 }), []);
});

test("validateLaunch: ngl integer >= 0; parallel integer >= 1; no_mmap boolean; flash_attn enum", () => {
  assert.match(validateLaunch({ ngl: -1 })[0], /ngl/);
  assert.match(validateLaunch({ parallel: 0 })[0], /parallel/);
  assert.match(validateLaunch({ no_mmap: "yes" })[0], /no_mmap/);
  assert.match(validateLaunch({ flash_attn: "maybe" })[0], /flash_attn must be one of on, off, auto/);
});

test("validateLaunch: kv_type must be a known llama.cpp cache type", () => {
  assert.match(validateLaunch({ kv_type: "q9_9" })[0], /kv_type/);
  assert.deepEqual(validateLaunch({ kv_type: "f16" }), []);
});

test("validateLaunch: spec needs type + positive integer draft_n_max, and an MTP source", () => {
  assert.match(validateLaunch({ spec: { type: "draft-mtp" } }, { hasMtp: true })[0], /spec\.draft_n_max/);
  assert.match(validateLaunch({ spec: { type: "draft-mtp", draft_n_max: 2 } }, { hasMtp: false })[0], /spec requires an mtp companion or the "mtp" tag/);
  assert.deepEqual(validateLaunch({ spec: { type: "draft-mtp", draft_n_max: 2 } }, { hasMtp: true }), []);
});

test("validateLaunch: sampling keys are numbers within range; unknown sampling key fails", () => {
  assert.match(validateLaunch({ sampling: { temp: -1 } })[0], /sampling\.temp/);
  assert.match(validateLaunch({ sampling: { top_p: 1.5 } })[0], /sampling\.top_p/);
  assert.match(validateLaunch({ sampling: { top_k: 2.5 } })[0], /sampling\.top_k/);
  assert.match(validateLaunch({ sampling: { bogus: 1 } })[0], /sampling: unknown key "bogus"/);
});

test("validateLaunch: extra_args must be strings and may not carry an owned flag", () => {
  assert.match(validateLaunch({ extra_args: "-b 4096" })[0], /extra_args must be an array of strings/);
  assert.match(validateLaunch({ extra_args: ["-c", "8192"] })[0], /extra_args may not contain "-c"/);
  assert.match(validateLaunch({ extra_args: ["--port=1"] })[0], /extra_args may not contain "--port"/);
  assert.match(validateLaunch({ extra_args: ["--mmproj", "x"] })[0], /extra_args may not contain "--mmproj"/);
  assert.deepEqual(validateLaunch({ extra_args: ["-b", "4096", "-ub", "4096", "--pooling", "mean"] }), []);
});

test("LAUNCH_OWNED_FLAGS contains identity, renderer-owned and companion/task flags", () => {
  for (const f of ["-m", "--model", "--alias", "--port", "--host", "-c", "--ctx-size", "--mmproj", "--embedding", "--embeddings",
    "--reranking", "--jinja", "-ngl", "--n-gpu-layers", "-fa", "--flash-attn", "-np", "--parallel", "--no-mmap", "-ctk", "-ctv",
    "--cache-type-k", "--cache-type-v", "--spec-type", "--spec-draft-n-max", "--temp", "--top-p", "--top-k", "--min-p", "--presence-penalty"]) {
    assert.ok(LAUNCH_OWNED_FLAGS.has(f), `missing ${f}`);
  }
});

test("mergeLaunch: override keys replace, sampling merges per key, extra_args replaces, nulls tolerated", () => {
  const merged = mergeLaunch(
    { ctx: 262144, sampling: { temp: 1.0, top_k: 20 }, extra_args: ["-b", "1"] },
    { ctx: 32768, sampling: { top_k: 40 }, extra_args: ["-b", "2"] },
  );
  assert.deepEqual(merged, { ctx: 32768, sampling: { temp: 1.0, top_k: 40 }, extra_args: ["-b", "2"] });
  assert.deepEqual(mergeLaunch(null, { ngl: 1 }), { ngl: 1 });
  assert.deepEqual(mergeLaunch({ ngl: 1 }, undefined), { ngl: 1 });
  assert.deepEqual(mergeLaunch(null, null), {});
});

test("mergeLaunch never mutates its inputs", () => {
  const base = { sampling: { temp: 1 } };
  const over = { sampling: { top_k: 2 } };
  mergeLaunch(base, over);
  assert.deepEqual(base, { sampling: { temp: 1 } });
  assert.deepEqual(over, { sampling: { top_k: 2 } });
});

test("renderLaunchArgs: fixed order, every knob", () => {
  assert.deepEqual(renderLaunchArgs(FULL), [
    "-c", "262144", "-ngl", "999", "-fa", "on", "-np", "1", "--no-mmap", "-ctk", "q8_0", "-ctv", "q8_0",
    "--spec-type", "draft-mtp", "--spec-draft-n-max", "2",
    "--temp", "1", "--top-p", "0.95", "--top-k", "20", "--min-p", "0", "--presence-penalty", "0",
    "--jinja", "--pooling", "mean",
  ]);
});

test("renderLaunchArgs: absent knobs render nothing; no_mmap:false renders nothing; jinja:false renders nothing", () => {
  assert.deepEqual(renderLaunchArgs(undefined), []);
  assert.deepEqual(renderLaunchArgs({}), []);
  assert.deepEqual(renderLaunchArgs({ no_mmap: false, jinja: false }), []);
  assert.deepEqual(renderLaunchArgs({ ctx: 8192 }), ["-c", "8192"]);
});
