// Skills panel option C, PR 1: today's table reads its rows from the catalog,
// so an extension's skill says which extension it came from (audit A1/A3-A5),
// a built-in replaced by a copy says so, and the hidden sync states show.
// Real repo bundles (kiosk, podcast, media, data-dashboard) on a scratch home.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "skills-sources-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
const HOME = process.env.CROW_HOME;
const SKILLS = join(HOME, "skills");
mkdirSync(SKILLS, { recursive: true });
after(() => rmSync(scratch, { recursive: true, force: true }));

const { default: panel } = await import("../servers/gateway/dashboard/panels/skills.js");
const { skillHash } = await import("../servers/gateway/bundle-skill-sync.js");
const REPO = new URL("../", import.meta.url).pathname;
const shipped = (id, file) => readFileSync(join(REPO, "bundles", id, "skills", file), "utf8");

writeFileSync(join(HOME, "installed.json"), JSON.stringify(["kiosk", "podcast", "media", "data-dashboard"].map((id) => ({ id, type: "bundle" }))));
const kiosk = shipped("kiosk", "kiosk.md"), podcast = shipped("podcast", "podcast.md");
writeFileSync(join(SKILLS, "kiosk.md"), kiosk);
writeFileSync(join(SKILLS, "podcast.md"), podcast);
writeFileSync(join(SKILLS, "media.md"), "# My own media notes\n");
writeFileSync(join(SKILLS, "data-dashboard.md"), shipped("data-dashboard", "data-dashboard.md"));
writeFileSync(join(SKILLS, "capstone-fixture.md"), "# Capstone fixture\n");
mkdirSync(join(HOME, "bundles", "data-dashboard", "skills"), { recursive: true });
writeFileSync(join(HOME, "bundles", "data-dashboard", "skills", "capstone-fixture.md"), "# Capstone fixture\n");
writeFileSync(join(SKILLS, "household-fixture.md"), "---\ndescription: Chores and lists for the house.\n---\n# Household\n");
writeFileSync(join(HOME, "skill-installs.json"), JSON.stringify({
  "kiosk.md": { bundle: "kiosk", sha256: skillHash(kiosk), installedAt: "t" },
  "podcast.md": { bundle: "podcast", sha256: skillHash(podcast), installedAt: "t" },
  "media.md": { bundle: "media", sha256: skillHash("# An older shipped media skill\n"), installedAt: "t" },
  "data-dashboard.md": { bundle: "data-dashboard", sha256: skillHash(shipped("data-dashboard", "data-dashboard.md")), installedAt: "t" },
}));

async function list(lang = "en") {
  const db = { execute: async () => ({ rows: [] }) };
  const res = { redirect() {}, redirectAfterPost() {} };
  return panel.handler({ method: "GET", query: {}, body: {} }, res, { db, layout: ({ content }) => content, lang });
}
/** The table rows for a skill name, keyed by source. */
function rowsFor(html, name) {
  const out = {};
  for (const tr of html.split(/<tr\b/).slice(1)) {
    const m = tr.match(/data-skill="([^"]+)" data-source="([^"]+)"/);
    if (m && m[1] === name) out[m[2]] = tr;
  }
  return out;
}
const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");

test("a recorded, unedited extension copy reads From <extension> (en and es)", async () => {
  const en = rowsFor(await list("en"), "kiosk");
  assert.deepEqual(Object.keys(en), ["ext"]);
  assert.match(text(en.ext), /From Kiosk display/);
  assert.doesNotMatch(text(en.ext), /custom/i);
  const es = rowsFor(await list("es"), "kiosk");
  assert.match(text(es.ext), /De Kiosk display/);
});

test("the podcast shape: From Podcasts + replaces built-in, and the built-in row says it's replaced — never 'overridden'", async () => {
  const html = await list("en");
  const r = rowsFor(html, "podcast");
  assert.deepEqual(Object.keys(r).sort(), ["builtin", "ext"]);
  assert.match(text(r.ext), /From Podcasts/);
  assert.match(text(r.ext), /replaces built-in/);
  assert.match(text(r.builtin), /Replaced by your copy/);
  assert.doesNotMatch(html, /overridden/i);
});

test("an edited copy whose extension shipped a newer version: Yours · copy of <ext> + updates stopped", async () => {
  const r = rowsFor(await list("en"), "media");
  assert.match(text(r.yours), /Yours · copy of Media Hub/);
  assert.match(text(r.yours), /Your copy · updates stopped/);
  const es = rowsFor(await list("es"), "media");
  assert.match(text(es.yours), /Tu copia · sin actualizaciones/);
});

test("a copy its installed extension no longer ships reads No longer shipped", async () => {
  const r = rowsFor(await list("en"), "capstone-fixture");
  assert.match(text(r.yours), /No longer shipped/);
  assert.match(text(rowsFor(await list("es"), "capstone-fixture").yours), /Ya no se incluye/);
});

test("the purpose line comes from YAML; English text on an es page is tagged lang=en", async () => {
  const r = rowsFor(await list("en"), "household-fixture");
  assert.match(text(r.yours), /Household/);
  assert.match(text(r.yours), /Chores and lists for the house\./);
  assert.match(text(r.yours), /Yours/);
  const es = rowsFor(await list("es"), "household-fixture");
  assert.match(es.yours, /lang="en"[^>]*>Chores and lists for the house\./);
  assert.match(text(es.yours), /Tuya/);
});

test("rows with no file (a shipped skill not installed yet) are not rendered in this table", async () => {
  const html = await list("en");
  assert.deepEqual(rowsFor(html, "data-scraping"), {});
  assert.ok(rowsFor(html, "data-dashboard").ext, "the installed sibling is listed");
});

test("a built-in reads Built-in with its cleaned title", async () => {
  const r = rowsFor(await list("en"), "tutoring");
  assert.deepEqual(Object.keys(r), ["builtin"]);
  assert.match(text(r.builtin), /Built-in/i);
  assert.match(r.builtin, />Tutoring</);
});
