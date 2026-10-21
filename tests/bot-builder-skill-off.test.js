// Skills panel option C, PR 2: Bot Builder shows a skill switched off on this
// Crow as off (still selectable, the selection kept), with a link to the
// skill in the Skills panel — and that link resolves (?skill= → the edit view).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "btb-skill-off-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
writeFileSync(join(process.env.CROW_HOME, "skills", "media.md"), "# Media\n");
writeFileSync(join(process.env.CROW_HOME, "skills", "kept-on.md"), "# Kept on\n");
after(() => rmSync(scratch, { recursive: true, force: true }));

const { renderSkillsCard } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-abilities.js");
const { setSkillOff } = await import("../servers/shared/skill-state.js");
const { default: skillsPanel } = await import("../servers/gateway/dashboard/panels/skills.js");
setSkillOff(process.env.CROW_HOME, "media", true);
setSkillOff(process.env.CROW_HOME, "tutoring", true);

const chipFor = (html, name) => (html.match(new RegExp(`<label class="btb-chip[^"]*"><input type="checkbox" name="skills" value="${name}"[\\s\\S]*?</label>`)) || [""])[0];

test("an off skill renders as an off chip: still checked when selected, labelled, linked to the Skills panel (en and es)", () => {
  const html = renderSkillsCard({ def: { skills: ["media", "kept-on"] }, lang: "en", crowHome: process.env.CROW_HOME });
  const media = chipFor(html, "media");
  assert.match(media, /class="btb-chip btb-chip-off"/);
  assert.match(media, / checked>/);
  assert.match(media, /<a href="\/dashboard\/skills\?skill=media"[^>]*>Off on this Crow<\/a>/);
  const on = chipFor(html, "kept-on");
  assert.match(on, /class="btb-chip"/);
  assert.doesNotMatch(on, /Off on this Crow/);
  const tutoring = chipFor(html, "tutoring");
  assert.match(tutoring, /btb-chip-off/, "a built-in switched off, not selected");
  assert.doesNotMatch(tutoring, / checked>/);
  const es = renderSkillsCard({ def: { skills: ["media"] }, lang: "es", crowHome: process.env.CROW_HOME });
  assert.match(chipFor(es, "media"), />Desactivada en este Crow<\/a>/);
});

test("?skill=<name> lands on that skill's page: yours, built-in, or the list for an unknown name", async () => {
  const go = async (query) => {
    const out = {};
    const res = { redirect: (a, b) => { out.url = b === undefined ? a : b; }, redirectAfterPost() {} };
    const html = await skillsPanel.handler({ method: "GET", query, body: {} }, res, { db: { execute: async () => ({ rows: [] }) }, layout: ({ content }) => content, lang: "en" });
    return out.url || (html ? "rendered" : null);
  };
  assert.equal(await go({ skill: "media" }), "/dashboard/skills?edit=media.md&source=user");
  assert.equal(await go({ skill: "memory-management" }), "/dashboard/skills?edit=memory-management.md&source=repo");
  assert.equal(await go({ skill: "no-such-skill" }), "/dashboard/skills");
  assert.equal(await go({ skill: "../etc/passwd" }), "/dashboard/skills");
  assert.equal(await go({ skill: ["a", "b"] }), "rendered", "a repeated ?skill= is ignored");
});

test("a save round-trip keeps an off skill the bot selected (the checkbox is posted as before)", async () => {
  const { saveAbilities } = await import("../servers/gateway/dashboard/panels/bot-builder/save-handlers.js");
  const html = renderSkillsCard({ def: { skills: ["media", "kept-on"] }, lang: "en", crowHome: process.env.CROW_HOME });
  const posted = [...html.matchAll(/name="skills" value="([^"]+)" checked>/g)].map((m) => m[1]);
  assert.deepEqual(posted.sort(), ["kept-on", "media"]);
  const def = { skills: ["media", "kept-on"], tools: { crow_mcp: [], pi_builtin: ["read"] }, permission_policy: {} };
  await saveAbilities(def, { skills_rendered: "1", skills: posted, src_catalog: "{}" }, { lang: "en", changed: (k) => k === "skills" });
  assert.deepEqual([...def.skills].sort(), ["kept-on", "media"]);
});
