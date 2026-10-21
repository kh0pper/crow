// Skills panel option C, PR 2: the on/off switch, read-only extension copies
// with Customize, the server-side Save guard, and honest delete warnings.
// Real repo bundles (kiosk, media) on a scratch CROW_HOME.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "skills-on-off-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
delete process.env.CROW_SKILL_SYNC;
const HOME = process.env.CROW_HOME, SKILLS = join(HOME, "skills"), RECORD = join(HOME, "skill-installs.json"), STATE = join(HOME, "skill-state.json");
mkdirSync(SKILLS, { recursive: true });
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
after(() => rmSync(scratch, { recursive: true, force: true }));

const { default: panel } = await import("../servers/gateway/dashboard/panels/skills.js");
const { skillHash } = await import("../servers/gateway/bundle-skill-sync.js");
const REPO = new URL("../", import.meta.url).pathname;
const shipped = (id, f) => readFileSync(join(REPO, "bundles", id, "skills", f), "utf8");
const KIOSK = shipped("kiosk", "kiosk.md");

const BOTS = [
  { bot_id: "home-helper", display_name: "Home helper", enabled: 1, definition: JSON.stringify({ skills: ["household-notes", "media"] }) },
  { bot_id: "research-desk", display_name: "Research desk", enabled: 1, definition: JSON.stringify({ skills: ["household-notes"] }) },
];
const db = { execute: async (q) => ({ rows: /pi_bot_defs/.test(typeof q === "string" ? q : q.sql) ? BOTS : [] }) };
async function call({ method = "GET", query = {}, body = {}, lang = "en" } = {}) {
  const out = { status: 200, redirect: null, body: null };
  const res = {
    redirect: (a, b) => { out.redirect = b === undefined ? a : b; out.status = b === undefined ? 302 : a; },
    redirectAfterPost: (u) => { out.redirect = u; out.status = 303; },
    status(c) { out.status = c; return this; },
  };
  const html = await panel.handler({ method, query, body }, res, { db, layout: ({ content, title }) => `<title>${title}</title>${content}`, lang });
  if (html !== undefined) out.body = html;
  return out;
}
const row = (html, name) => (html.split(/<tr\b/).find((tr) => tr.includes(`data-skill="${name}" data-source=`)) || "");
const sw = (html, name) => (row(html, name).match(/<button[^>]*role="switch"[^>]*>/) || [""])[0];
function setup() {
  writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: "kiosk" }, { id: "media" }]));
  writeFileSync(join(SKILLS, "kiosk.md"), KIOSK);
  writeFileSync(join(SKILLS, "media.md"), "# My media notes\n");
  writeFileSync(join(SKILLS, "household-notes.md"), "# Household notes\n");
  writeFileSync(RECORD, JSON.stringify({
    "kiosk.md": { bundle: "kiosk", sha256: skillHash(KIOSK), installedAt: "t" },
    "media.md": { bundle: "media", sha256: skillHash("# an older shipped media\n"), installedAt: "t" },
  }));
  rmSync(STATE, { force: true });
  rmSync(join(HOME, "bundles"), { recursive: true, force: true });
}

test("the switch: POST set-off writes the list and redirects; the row reads off; set-on undoes it", async () => {
  setup();
  const list0 = await call();
  assert.match(sw(list0.body, "household-notes"), /aria-checked="true"/);
  assert.match(sw(list0.body, "household-notes"), /aria-label="Household notes"/, "the name only");
  const r = await call({ method: "POST", body: { action: "set-off", skill: "household-notes" } });
  assert.equal(r.status, 303);
  assert.equal(r.redirect, "/dashboard/skills?toggled=household-notes&to=off");
  assert.deepEqual(JSON.parse(readFileSync(STATE, "utf8")).off, ["household-notes"]);
  const list = await call({ query: { toggled: "household-notes", to: "off" } });
  assert.match(sw(list.body, "household-notes"), /aria-checked="false"/);
  assert.match(sw(list.body, "household-notes"), /autofocus/, "focus returns to the switch after the redirect");
  assert.match(list.body, /data-skills-toast="Turned off: Household notes\. 2 bots will stop using it in new conversations\."/);
  assert.match(list.body, /<div[^>]*role="status"[^>]*id="skills-toast"[^>]*><\/div>/, "the status region starts empty; its text goes in after load");
  const es = await call({ query: { toggled: "household-notes", to: "off" }, lang: "es" });
  assert.match(es.body, /data-skills-toast="Desactivada: Household notes\. 2 bots dejarán de usarla en las conversaciones nuevas\."/);
  await call({ method: "POST", body: { action: "set-on", skill: "household-notes" } });
  assert.deepEqual(JSON.parse(readFileSync(STATE, "utf8")).off, []);
  const on = await call({ query: { toggled: "household-notes", to: "on" } });
  assert.match(on.body, /data-skills-toast="Turned on: Household notes\. Bots that select it get it in new conversations\."/);
});

test("the switch refuses a bad name and a garbled state file, and the page says the list can't be read", async () => {
  setup();
  const bad = await call({ method: "POST", body: { action: "set-off", skill: "../x" } });
  assert.match(bad.redirect, /error=invalid-name/);
  assert.equal(existsSync(STATE), false);
  writeFileSync(STATE, "{ garbled");
  const r = await call({ method: "POST", body: { action: "set-off", skill: "media" } });
  assert.match(r.redirect, /error=state-unreadable/);
  assert.equal(readFileSync(STATE, "utf8"), "{ garbled");
  const list = await call();
  assert.match(list.body, /skill-state\.json/, "a banner names the file");
  assert.match(sw(list.body, "media"), /aria-checked="true"/, "fail open: everything reads on");
});

test("skill-writing has no switch: it is always given to self-authoring bots", async () => {
  setup();
  const list = await call();
  assert.equal(sw(list.body, "skill-writing"), "");
  assert.match(row(list.body, "skill-writing"), /Always given to self-authoring bots/);
});

test("an unedited extension copy opens read-only with Customize… and its warning; customize=1 opens the editor", async () => {
  setup();
  const view = await call({ query: { edit: "kiosk.md", source: "user" } });
  assert.doesNotMatch(view.body, /name="action" value="save"/, "no Save form");
  assert.match(view.body, /href="\/dashboard\/skills\?edit=kiosk\.md&amp;source=user&amp;customize=1"[^>]*>Customize…</);
  assert.match(view.body, /Makes your own copy\. It stops getting Kiosk display’s updates\./);
  assert.doesNotMatch(view.body, /name="action" value="delete"/, "no Delete for an extension skill");
  const edit = await call({ query: { edit: "kiosk.md", source: "user", customize: "1" } });
  assert.match(edit.body, /name="action" value="save"/);
  assert.match(edit.body, /<input type="hidden" name="customize" value="1">/);
  assert.match(edit.body, /It stops getting Kiosk display’s updates\./);
});

test("Save guard: no write to an unedited extension copy without customize=1 (same, refresh, verified opt-out); with it, written", async () => {
  setup();
  const tryWrite = async (extra = {}) => call({ method: "POST", body: { action: "save", filename: "kiosk.md", content: "# Changed\n", ...extra } });
  // same
  let r = await tryWrite();
  assert.equal(r.redirect, "/dashboard/skills?edit=kiosk.md&source=user");
  assert.equal(readFileSync(join(SKILLS, "kiosk.md"), "utf8"), KIOSK);
  // refresh (record of an older version, file equal to it)
  writeFileSync(join(SKILLS, "kiosk.md"), "# old shipped kiosk\n");
  writeFileSync(RECORD, JSON.stringify({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# old shipped kiosk\n"), installedAt: "t" } }));
  r = await tryWrite();
  assert.equal(readFileSync(join(SKILLS, "kiosk.md"), "utf8"), "# old shipped kiosk\n");
  // a "refresh": false bundle whose copy matches its record: verified unedited, guarded
  mkdirSync(join(HOME, "bundles", "kiosk"), { recursive: true });
  writeFileSync(join(HOME, "bundles", "kiosk", "manifest.json"), JSON.stringify({ id: "kiosk", refresh: false }));
  r = await tryWrite();
  assert.equal(readFileSync(join(SKILLS, "kiosk.md"), "utf8"), "# old shipped kiosk\n");
  // with customize=1 it is written
  r = await tryWrite({ customize: "1" });
  assert.equal(r.status, 303);
  assert.equal(readFileSync(join(SKILLS, "kiosk.md"), "utf8"), "# Changed\n");
});

test("an opted-out copy is NOT trusted as unedited: with no matching record it reads as your copy, and stays editable", async () => {
  setup();
  mkdirSync(join(HOME, "bundles", "kiosk"), { recursive: true });
  writeFileSync(join(HOME, "bundles", "kiosk", "manifest.json"), JSON.stringify({ id: "kiosk", refresh: false }));
  writeFileSync(join(SKILLS, "kiosk.md"), "# Someone's kiosk\n");
  writeFileSync(RECORD, "{}");
  const list = await call();
  assert.match(row(list.body, "kiosk"), /Yours · copy of Kiosk display/);
  const view = await call({ query: { edit: "kiosk.md", source: "user" } });
  assert.match(view.body, /name="action" value="save"/);
  const r = await call({ method: "POST", body: { action: "save", filename: "kiosk.md", content: "# Edited\n" } });
  assert.equal(r.status, 303);
  assert.equal(readFileSync(join(SKILLS, "kiosk.md"), "utf8"), "# Edited\n");
});

test("delete: refused for an extension copy; yours names its bots; a copy of an extension says it won't come back", async () => {
  setup();
  const r = await call({ method: "POST", body: { action: "delete", filename: "kiosk.md" } });
  assert.match(r.redirect, /error=extension-skill/);
  assert.ok(existsSync(join(SKILLS, "kiosk.md")));
  const yours = await call({ query: { edit: "household-notes.md", source: "user" } });
  assert.match(yours.body, /confirm\('Delete this skill\? Used by 2 bots: they will lose it\.'\)/);
  const copy = await call({ query: { edit: "media.md", source: "user" } });
  assert.match(copy.body, /confirm\('Delete your copy\? Media Hub’s version won’t come back by itself: it stays removed until you uninstall Media Hub and install it again\. Used by 1 bot: it will lose it\.'\)/);
  const list = await call();
  assert.match(row(list.body, "media"), /confirm\('Delete your copy\?/);
  assert.doesNotMatch(row(list.body, "kiosk"), /value="delete"/, "no Delete button on an extension row");
  const del = await call({ method: "POST", body: { action: "delete", filename: "household-notes.md" } });
  assert.equal(del.status, 303);
  assert.equal(existsSync(join(SKILLS, "household-notes.md")), false);
});

test("rows show who uses a skill", async () => {
  setup();
  const list = await call();
  assert.match(row(list.body, "household-notes"), /Used by 2 bots/);
  assert.match(row(list.body, "media"), /Used by 1 bot/);
  assert.match(row(list.body, "tutoring"), /Not used by a bot/);
  const es = await call({ lang: "es" });
  assert.match(row(es.body, "household-notes"), /La usan 2 bots/);
});

test("a Design kit skill on a kit-less Crow keeps its switch and says where it still loads (review I1)", async () => {
  setup();
  writeFileSync(join(SKILLS, "design-frontend.md"), "# Design frontend\n");
  const list = await call();
  const r = row(list.body, "design-frontend");
  assert.match(r, /Needs the Design kit/);
  assert.match(r, /Chat bots skip it; voice and scheduled runs still load it if a bot selects it\./);
  assert.match(sw(list.body, "design-frontend"), /aria-checked="true"/);
  const es = await call({ lang: "es" });
  assert.match(row(es.body, "design-frontend"), /Los bots de chat la omiten/);
  rmSync(join(SKILLS, "design-frontend.md"));
});

test("an off name whose file is gone shows as Off · not installed, with its switch to turn it back on", async () => {
  setup();
  writeFileSync(STATE, JSON.stringify({ version: 1, off: ["gone-skill"] }));
  const list = await call();
  const r = row(list.body, "gone-skill");
  assert.match(r, /Off · not installed/);
  assert.match(sw(list.body, "gone-skill"), /aria-checked="false"/);
  assert.match(r, /name="action" value="set-on"/);
  assert.match(row((await call({ lang: "es" })).body, "gone-skill"), /Desactivada · no instalada/);
});

test("the switch column header is a state in Spanish, not a verb", async () => {
  setup();
  const es = await call({ lang: "es" });
  assert.match(es.body, /data-label="Estado"/);
  assert.doesNotMatch(es.body, />Activar</);
});

test("a kit skill a voice bot selects on a kit-less Crow is not shown as unused", async () => {
  setup();
  writeFileSync(join(SKILLS, "design-frontend.md"), "# Design frontend\n");
  BOTS.push({ bot_id: "voice-desk", display_name: "Voice desk", enabled: 1, definition: JSON.stringify({ skills: ["design-frontend"] }) });
  try {
    const r = row((await call()).body, "design-frontend");
    assert.doesNotMatch(r, /Not used by a bot/);
    assert.match(r, /Used by 1 bot/);
  } finally { BOTS.pop(); rmSync(join(SKILLS, "design-frontend.md")); }
});
