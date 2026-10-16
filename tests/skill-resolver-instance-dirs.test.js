/**
 * Skills panel audit A28/A29: a non-primary instance (its own CROW_HOME) must
 * read ONLY its own <CROW_HOME>/skills plus the running checkout's skills/ —
 * never the primary's ~/.crow/skills, and never a hard-coded $HOME/crow.
 * Covers the resolver (bot spawns, bound-bot prompts), Bot Builder's chip list
 * and the capability registry, which all go through skillDirs().
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "skill-dirs-"));
const saved = { HOME: process.env.HOME, CROW_HOME: process.env.CROW_HOME };
// A fake host home whose PRIMARY instance has a main-only skill, and a
// $HOME/crow checkout that is not the running one.
process.env.HOME = join(dir, "fakehome");
const put = (d, n, body = `# ${n}\n`) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${n}.md`), body); };
put(join(process.env.HOME, ".crow", "skills"), "main-only");
put(join(process.env.HOME, "crow", "skills"), "stale-checkout-only");
const other = join(dir, "r4home");
put(join(other, "skills"), "r4-own");
process.env.CROW_HOME = other;

const { skillDirs, resolveSkill, REPO_SKILLS_DIR } = await import("../scripts/pi-bots/skill_resolver.mjs");
const { loadSkills } = await import("../servers/gateway/dashboard/panels/bot-builder/data-queries.js");
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } rmSync(dir, { recursive: true, force: true }); });

const RUNNING_REPO_SKILLS = resolve(fileURLToPath(new URL("../skills", import.meta.url)));

test("skillDirs: a non-primary CROW_HOME searches only its own skills and the running checkout", () => {
  assert.equal(REPO_SKILLS_DIR, RUNNING_REPO_SKILLS);
  assert.deepEqual(skillDirs(other), [join(other, "skills"), RUNNING_REPO_SKILLS]);
  assert.equal(resolveSkill("main-only", { crowHome: other }), null, "the primary's ~/.crow/skills never leaks into another instance");
  assert.equal(resolveSkill("stale-checkout-only", { crowHome: other }), null, "$HOME/crow is not the running checkout");
  assert.equal(resolveSkill("r4-own", { crowHome: other }).path, join(other, "skills", "r4-own.md"));
  assert.ok(resolveSkill("memory-management", { crowHome: other }).path.startsWith(RUNNING_REPO_SKILLS + "/"), "repo skills still resolve");
});

test("skillDirs: no crowHome falls back to CROW_HOME, then ~/.crow", () => {
  assert.deepEqual(skillDirs(), [join(other, "skills"), RUNNING_REPO_SKILLS]);
  delete process.env.CROW_HOME;
  try {
    assert.deepEqual(skillDirs(), [join(process.env.HOME, ".crow", "skills"), RUNNING_REPO_SKILLS]);
    assert.ok(resolveSkill("main-only"), "the primary itself still reads ~/.crow/skills");
  } finally { process.env.CROW_HOME = other; }
});

test("Bot Builder chips on a non-primary instance list only that instance's skills and the repo's", () => {
  const names = loadSkills(other);
  assert.ok(names.includes("r4-own"));
  assert.ok(names.includes("memory-management"));
  assert.ok(!names.includes("main-only"), "no chip for a primary-only skill");
  assert.ok(!names.includes("stale-checkout-only"));
});

test("Bot Builder chips list only names the resolver can load (code review M2)", () => {
  put(join(other, "skills"), "MixedCase");
  writeFileSync(join(other, "skills", ".md"), "old bug\n");
  const names = loadSkills(other);
  assert.ok(!names.includes("MixedCase"), "resolveSkill('MixedCase') looks up mixedcase.md, so no chip");
  assert.ok(!names.includes(""), "no empty chip from a dotfile");
  assert.equal(resolveSkill("MixedCase", { crowHome: other }), null);
});
