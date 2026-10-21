// Skills panel option C, PR 1 (audit A26 + review I4): the seeded writing-rules
// template is not a rule. The panel shows "Set up writing rules" for it, and
// no MCP client is handed its placeholder text — not in the condensed
// instructions line, and not in the full crow.md (crow_get_context, the
// crow-guide prompt, /crow.md).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "writing-rules-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
after(() => rmSync(scratch, { recursive: true, force: true }));

const { isWritingRulesTemplate, writingRulesBody } = await import("../servers/shared/writing-rules.js");
const { generateCondensedContext, generateCrowContext, invalidateContextCache } = await import("../servers/memory/crow-context.js");
const { default: panel } = await import("../servers/gateway/dashboard/panels/skills.js");

/** The writing_style seed, read from init-db.js so this breaks if the seed changes shape. */
function seed() {
  const src = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  const m = src.match(/key:\s*"writing_style",[\s\S]*?content:\s*`([\s\S]*?)`/);
  assert.ok(m, "writing_style seed found in init-db.js");
  return m[1];
}
const SEED = seed();

beforeEach(() => invalidateContextCache());

function db(writing) {
  const rows = [
    { section_key: "identity", section_title: "Identity", content: "You are Crow.", device_id: null, project_id: null, sort_order: 1 },
    { section_key: "writing_style", section_title: "Writing Style", content: writing, device_id: null, project_id: null, sort_order: 55 },
  ];
  return { execute: async () => ({ rows }) };
}

test("the init-db seed is a template; so are a CRLF copy and a reordering", () => {
  assert.equal(isWritingRulesTemplate(SEED), true);
  assert.equal(isWritingRulesTemplate(SEED.replace(/\n/g, "\r\n")), true);
  const parts = SEED.split(/\n(?=### )/);
  assert.equal(isWritingRulesTemplate([parts[0], parts[3], parts[1], parts[2]].join("\n\n")), true);
  assert.equal(isWritingRulesTemplate(""), true);
  assert.equal(isWritingRulesTemplate(null), true);
  assert.equal(isWritingRulesTemplate("   \n"), true);
});

test("one real rule makes it not a template, whatever its length", () => {
  assert.equal(isWritingRulesTemplate(SEED.replace("(Add patterns you want Crow to never use in any writing)", "- delve")), false);
  assert.equal(isWritingRulesTemplate(SEED + "\n\nNo emoji."), false);
  assert.equal(isWritingRulesTemplate("No emoji."), false);
  assert.equal(isWritingRulesTemplate("(this is a real rule, in brackets) and more"), false);
});

test("a rule written in parentheses is a real rule, never a placeholder (review: only the seed's \"(Add …)\" lines are)", () => {
  const parens = '### Banned Patterns\n(never say "delve")\n(no em dashes)';
  assert.equal(isWritingRulesTemplate(parens), false);
  assert.equal(writingRulesBody(parens), parens, "kept unchanged");
  const mixed = SEED.replace("(Add patterns you want Crow to never use in any writing)", '(never say "delve")\n(no em dashes)');
  const body = writingRulesBody(mixed);
  assert.match(body, /### Banned Patterns\n\(never say "delve"\)\n\(no em dashes\)/);
  assert.doesNotMatch(body, /\(Add/);
  assert.doesNotMatch(body, /### Preferred Style/);
});

test("instructions and crow.md keep a parenthesised rule", async () => {
  const mixed = SEED.replace("(Add patterns you want Crow to never use in any writing)", "(no em dashes)");
  assert.match(await generateCondensedContext(db(mixed)), /Writing rules: \(no em dashes\)/);
  invalidateContextCache();
  const full = await generateCrowContext(db(mixed), { includeDynamic: false });
  assert.match(full, /\(no em dashes\)/);
  assert.doesNotMatch(full, /No writing rules set/);
});

test("writingRulesBody drops placeholder lines and empty subsections", () => {
  assert.equal(writingRulesBody(SEED), null);
  const partly = SEED.replace("(Add your style preferences: tone, register, formatting)", "Plain, short sentences.");
  const body = writingRulesBody(partly);
  assert.match(body, /### Preferred Style\nPlain, short sentences\./);
  assert.doesNotMatch(body, /\(Add/);
  assert.doesNotMatch(body, /### Banned Patterns/);
  assert.doesNotMatch(body, /### Context-Specific Rules/);
});

test("the Skills panel shows Set up writing rules for the seed, and the rules once there are some", async () => {
  const res = { redirect() {}, redirectAfterPost() {} };
  const render = (content) => panel.handler({ method: "GET", query: { view: "behavior" }, body: {} }, res, {
    db: { execute: async ({ sql }) => (/section_title/.test(sql) ? { rows: [] } : { rows: [{ content }] }) }, layout: ({ content: c }) => c, lang: "en",
  });
  assert.match(await render(SEED), /Set Up Writing Rules/);
  const real = await render(SEED.replace("(Add patterns you want Crow to never use in any writing)", "- delve"));
  assert.doesNotMatch(real, /Set Up Writing Rules/);
  assert.match(real, /- delve/);
});

test("instructions: the seed adds no Writing rules line and no placeholder", async () => {
  const out = await generateCondensedContext(db(SEED));
  assert.ok(out.includes("Crow — Behavioral Context"));
  assert.doesNotMatch(out, /Writing rules:/);
  assert.doesNotMatch(out, /\(Add patterns/);
});

test("instructions: a real banned pattern is the line, with no placeholder text", async () => {
  const out = await generateCondensedContext(db(SEED.replace("(Add patterns you want Crow to never use in any writing)", "- delve\n- tapestry")));
  assert.match(out, /Writing rules: - delve - tapestry|Writing rules: - delve\n- tapestry/);
  assert.doesNotMatch(out, /\(Add/);
});

test("instructions: banned patterns still a placeholder but a style set → the style, never an empty line", async () => {
  const out = await generateCondensedContext(db(SEED.replace("(Add your style preferences: tone, register, formatting)", "Plain, short sentences.")));
  assert.match(out, /Writing rules: .*Plain, short sentences\./);
  assert.doesNotMatch(out, /Writing rules:\s*(\n|$)/);
  assert.doesNotMatch(out, /\(Add/);
});

test("full crow.md: the seed reads (No writing rules set.); a partly filled section keeps its rules only", async () => {
  const full = await generateCrowContext(db(SEED), { includeDynamic: false });
  assert.match(full, /## Writing Style\n+\(No writing rules set\.\)/);
  assert.doesNotMatch(full, /\(Add patterns/);
  invalidateContextCache();
  const partly = await generateCrowContext(db(SEED.replace("(Add your style preferences: tone, register, formatting)", "Plain, short sentences.")), { includeDynamic: false });
  assert.match(partly, /Plain, short sentences\./);
  assert.doesNotMatch(partly, /\(Add/);
  invalidateContextCache();
  const custom = "My own rules, in my own shape.\n\n(keep this bracketed note) and this text";
  assert.ok((await generateCrowContext(db(custom), { includeDynamic: false })).includes(custom), "real text is passed through unchanged");
});
