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

// A chip and, after its label (never inside it), its "Off on this Crow" link.
const chipFor = (html, name) => (html.match(new RegExp(`<span class="btb-chip-wrap"><label class="btb-chip[^"]*"><input type="checkbox" name="skills" value="${name}"[\\s\\S]*?</label>(?:<a [^>]*>[^<]*</a>)?</span>`)) || [""])[0];

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
  const page = async (query) => skillsPanel.handler({ method: "GET", query, body: {} }, { redirect() {}, redirectAfterPost() {} }, { db: { execute: async () => ({ rows: [] }) }, layout: ({ content }) => content, lang: "en" });
  assert.equal(await go({ skill: "media" }), "rendered");
  assert.match(await page({ skill: "media" }), /<div class="sk-detail"[^>]*>[\s\S]*id="sk-detail-h"[^>]*>Media/, "the skill's detail opens in the list");
  assert.match(await page({ skill: "memory-management" }), /<div class="sk-detail"/);
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

test("the off check normalises the stored name (a bot that stored 'Media' still sees media as off)", () => {
  const html = renderSkillsCard({ def: { skills: ["Media"] }, lang: "en", crowHome: process.env.CROW_HOME });
  const chip = chipFor(html, "Media");
  assert.match(chip, /btb-chip-off/);
  assert.match(chip, /href="\/dashboard\/skills\?skill=Media"|href="\/dashboard\/skills\?skill=media"/);
});


// Skills panel option C, PR 3: Bot Builder speaks the Skills panel's language.
test("chips show friendly titles (slug kept in title= and for screen readers); the off link sits outside the label", () => {
  const html = renderSkillsCard({ def: { skills: ["media", "tutoring"] }, lang: "en", crowHome: process.env.CROW_HOME });
  const tut = chipFor(html, "tutoring");
  assert.match(tut, /<span class="btb-chip-title" title="tutoring">Tutoring<\/span><span class="btb-vh"> \(tutoring\)<\/span>/);
  const media = chipFor(html, "media");
  assert.match(media, /<\/label><a href="\/dashboard\/skills\?skill=media"[^>]*>Off on this Crow<\/a><\/span>$/, "the link is a sibling of the label");
  assert.doesNotMatch(media.replace(/<\/label>[\s\S]*$/, ""), /<a /, "no anchor inside the label");
  assert.match(html, /<a href="\/dashboard\/skills" class="btb-manage-skills">Manage skills ›<\/a>/);
  const es = renderSkillsCard({ def: { skills: [] }, lang: "es", crowHome: process.env.CROW_HOME });
  assert.match(es, />Gestionar habilidades ›</);
});

test("groups follow where each skill comes from: Yours, each extension by name (no capabilities.skills needed), Built-in folded unless one is selected", async () => {
  const { readFileSync } = await import("node:fs");
  const { skillHash } = await import("../servers/gateway/bundle-skill-sync.js");
  const kiosk = readFileSync(new URL("../bundles/kiosk/skills/kiosk.md", import.meta.url), "utf8");
  const podcast = readFileSync(new URL("../bundles/podcast/skills/podcast.md", import.meta.url), "utf8");
  writeFileSync(join(process.env.CROW_HOME, "installed.json"), JSON.stringify([{ id: "kiosk" }, { id: "podcast" }]));
  writeFileSync(join(process.env.CROW_HOME, "skills", "kiosk.md"), kiosk);
  writeFileSync(join(process.env.CROW_HOME, "skills", "podcast.md"), podcast);
  writeFileSync(join(process.env.CROW_HOME, "skill-installs.json"), JSON.stringify({
    "kiosk.md": { bundle: "kiosk", sha256: skillHash(kiosk), installedAt: "t" },
    "podcast.md": { bundle: "podcast", sha256: skillHash(podcast), installedAt: "t" },
  }));
  try {
    const manifest = JSON.parse(readFileSync(new URL("../bundles/podcast/manifest.json", import.meta.url), "utf8"));
    assert.ok(!manifest.capabilities || !manifest.capabilities.skills, "podcast declares no capabilities.skills");
    const html = renderSkillsCard({ def: { skills: [] }, lang: "en", crowHome: process.env.CROW_HOME });
    const groups = [...html.matchAll(/<(?:div|details) class="btb-group[^"]*"[^>]*>(?:<summary>)?<(?:label|span) class="btb-group-h">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(groups, ["Yours", "Kiosk display", "Podcasts", "Built-in"]);
    const podcastGroup = html.split('class="btb-group-h">Podcasts<')[1].split("btb-group")[0];
    assert.match(podcastGroup, /value="podcast"/);
    assert.match(html, /<details class="btb-group btb-group-builtin">/, "Built-in starts folded");
    const sel = renderSkillsCard({ def: { skills: ["tutoring"] }, lang: "en", crowHome: process.env.CROW_HOME });
    assert.match(sel, /<details class="btb-group btb-group-builtin" open>/, "open when a built-in is selected");
  } finally {
    const home = join(scratch, "home"); // the scratch home set up above, never a path read from the env
    rmSync(join(home, "skills", "kiosk.md")); rmSync(join(home, "skills", "podcast.md"));
    rmSync(join(home, "installed.json")); rmSync(join(home, "skill-installs.json"));
  }
});
