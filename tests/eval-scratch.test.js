import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const LIB = join(ROOT, "scripts/lib");

test("assertEvalSeam ignores arguments and checks the real process env", async () => {
  const { assertEvalSeam } = await import("../scripts/lib/eval-guard.mjs");
  const forged = {
    CROW_RESEARCH_EVAL: "1", CROW_HOME: join(tmpdir(), "crow-forged"), CROW_ACTOR_KIND: "bot",
    CROW_ACTOR_BOT_ID: "b", CROW_DB_PATH: join(tmpdir(), "crow-forged", "data", "crow.db"),
  };
  const saved = process.env.CROW_RESEARCH_EVAL;
  delete process.env.CROW_RESEARCH_EVAL;
  try {
    assert.throws(() => assertEvalSeam(forged), /^Error: eval-only seam refused: CROW_RESEARCH_EVAL must be "1"/);
    assert.throws(() => assertEvalSeam(), /eval-only seam refused: /);
  } finally {
    if (saved !== undefined) process.env.CROW_RESEARCH_EVAL = saved;
  }
});

test("old and new paths export the same functions", async () => {
  const oldScratch = await import("../scripts/research-eval/scratch.mjs");
  const newScratch = await import("../scripts/lib/eval-scratch.mjs");
  assert.equal(oldScratch.scratchEnv, newScratch.scratchEnv);
  assert.equal(typeof newScratch.freshHome, "function");
  const oldGuard = await import("../scripts/research-eval/fixture-guard.mjs");
  const newGuard = await import("../scripts/lib/eval-guard.mjs");
  assert.equal(oldGuard.assertEvalEnv, newGuard.assertEvalEnv);
});

test("freshHome returns a directory strictly below the temp dir", async () => {
  const { freshHome } = await import("../scripts/lib/eval-scratch.mjs");
  const { rmSync } = await import("node:fs");
  const h = freshHome();
  try { assert.ok(h.startsWith(tmpdir() + "/") && h !== tmpdir()); } finally { rmSync(h, { recursive: true, force: true }); }
});

test("guard modules load no server code", () => {
  const allowed = (spec) => spec.startsWith("node:") || /(^|\/)protected-paths\.mjs$/.test(spec) || /(^|\/)eval-guard\.mjs$/.test(spec);
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const specs = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"/gms)].map((m) => m[1]);
    specs.push(...[...src.matchAll(/^\s*import\s*"([^"]+)"/gm)].map((m) => m[1]));
    for (const s of specs) {
      assert.ok(allowed(s), `${file}: ${s}`);
      if (!s.startsWith("node:")) walk(resolve(dirname(file), s));
    }
  };
  walk(join(ROOT, "scripts/research-eval/fixture-guard.mjs"));
  walk(join(LIB, "eval-guard.mjs"));
  assert.ok(seen.size >= 3);
});
