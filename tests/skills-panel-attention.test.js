// Skills panel option C, PR 3: the "Needs a look" strip and its actions.
// One fixture item per strip state (real repo bundles, scratch CROW_HOME):
// an update ready, a copy behind its extension, a removed skill a bot still
// asks for, a skill no longer shipped; then each action, and the empty state.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "skills-attn-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
delete process.env.CROW_SKILL_SYNC;
const HOME = process.env.CROW_HOME, SKILLS = join(HOME, "skills");
mkdirSync(SKILLS, { recursive: true });
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
after(() => rmSync(scratch, { recursive: true, force: true }));

const { default: panel } = await import("../servers/gateway/dashboard/panels/skills.js");
const { skillHash } = await import("../servers/gateway/bundle-skill-sync.js");
const REPO = new URL("../", import.meta.url).pathname;
const shipped = (id, f) => readFileSync(join(REPO, "bundles", id, "skills", f), "utf8");

const BOTS = [
  { bot_id: "home-helper", display_name: "Home helper", enabled: 1, definition: JSON.stringify({ skills: ["data-dashboard"] }) },
];
const db = { execute: async (q) => ({ rows: /pi_bot_defs/.test(typeof q === "string" ? q : q.sql) ? BOTS : [] }) };
async function call({ method = "GET", query = {}, body = {}, lang = "en" } = {}) {
  const out = { status: 200, redirect: null, body: null };
  const res = {
    redirect: (a, b) => { out.redirect = b === undefined ? a : b; },
    redirectAfterPost: (u) => { out.redirect = u; out.status = 303; },
    status(c) { out.status = c; return this; },
  };
  const html = await panel.handler({ method, query, body }, res, { db, layout: ({ content, title }) => `<title>${title}</title>${content}`, lang });
  if (html !== undefined) out.body = html;
  return out;
}
const strip = (html) => (html.match(/<section class="sk-attn[^"]*"[\s\S]*?<\/section>/) || [""])[0];
const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function setup() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(SKILLS, { recursive: true });
  mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
  writeFileSync(join(HOME, "installed.json"), JSON.stringify(["kiosk", "media", "data-dashboard"].map((id) => ({ id }))));
  writeFileSync(join(SKILLS, "kiosk.md"), "# An older kiosk\n");
  writeFileSync(join(SKILLS, "media.md"), "# My own media notes\n");
  writeFileSync(join(SKILLS, "data-scraping.md"), shipped("data-dashboard", "data-scraping.md"));
  writeFileSync(join(SKILLS, "retired-fixture.md"), "# Retired fixture\n");
  mkdirSync(join(HOME, "bundles", "data-dashboard", "skills"), { recursive: true });
  writeFileSync(join(HOME, "bundles", "data-dashboard", "skills", "retired-fixture.md"), "# Retired fixture\n");
  writeFileSync(join(HOME, "skill-installs.json"), JSON.stringify({
    "kiosk.md": { bundle: "kiosk", sha256: skillHash("# An older kiosk\n"), installedAt: "t" },
    "media.md": { bundle: "media", sha256: skillHash("# An older shipped media\n"), installedAt: "t" },
    "data-dashboard.md": { bundle: "data-dashboard", sha256: "gone", installedAt: "t" },
    "data-scraping.md": { bundle: "data-dashboard", sha256: skillHash(shipped("data-dashboard", "data-scraping.md")), installedAt: "t" },
  }));
}

test("the strip lists the four states with the mockup's labels and one button each (en and es)", async () => {
  setup();
  const s = strip((await call()).body);
  assert.match(text(s), /Needs a look · 4/);
  const items = s.split('class="sk-attn-item"').slice(1).map(text);
  assert.equal(items.length, 4);
  assert.match(items[0], /An older kiosk .*Update ready .*Review/);
  assert.match(items[1], /My own media notes .*Your copy · updates stopped .*Compare/);
  assert.match(items[2], /Data dashboard .*Removed · a bot still asks for it .*Restore .*Take it off Home helper/i);
  assert.match(items[3], /Retired fixture .*No longer shipped .*Keep/);
  assert.match(s, /href="\/dashboard\/skills\?skill=kiosk&amp;compare=1#skill-kiosk"/, "Review opens the detail with the diff");
  assert.match(s, /href="\/dashboard\/bot-builder\?bot=home-helper&amp;tab=abilities"/);
  assert.match(s, /Review<span class="sk-vh"> An older kiosk<\/span>/, "buttons say what they act on");
  const es = text(strip((await call({ lang: "es" })).body));
  assert.match(es, /Necesita revisión · 4/);
  assert.match(es, /Actualización lista/);
  assert.match(es, /Tu copia · sin actualizaciones/);
  assert.match(es, /Quitada · un bot aún la pide/);
  assert.match(es, /Ya no se incluye/);
  for (const b of ["Revisar", "Comparar", "Restaurar", "Conservar"]) assert.match(es, new RegExp(b));
});

test("each action has its effect and the item leaves the strip", async () => {
  setup();
  let r = await call({ method: "POST", body: { action: "apply-update", skill: "kiosk.md" } });
  assert.equal(r.status, 303);
  assert.equal(readFileSync(join(SKILLS, "kiosk.md"), "utf8"), shipped("kiosk", "kiosk.md"));
  assert.match(r.redirect, /done=updated/);
  assert.match(text(strip((await call()).body)), /Needs a look · 3/);

  r = await call({ method: "POST", body: { action: "restore-shipped", skill: "media.md" } });
  assert.equal(readFileSync(join(SKILLS, "media.md"), "utf8"), shipped("media", "media.md"));
  assert.ok(readdirSync(join(HOME, "skill-backups")).some((f) => f.startsWith("media.")), "your edit was backed up");
  assert.match(text(strip((await call()).body)), /Needs a look · 2/);

  r = await call({ method: "POST", body: { action: "restore-shipped", skill: "data-dashboard.md" } });
  assert.ok(existsSync(join(SKILLS, "data-dashboard.md")));
  assert.match(text(strip((await call()).body)), /Needs a look · 1/);

  r = await call({ method: "POST", body: { action: "ack", skill: "retired-fixture.md", srcSha: "" } });
  assert.equal(r.status, 303);
  const after = await call({ query: { done: "kept", about: "retired-fixture" } });
  assert.match(text(strip(after.body)), /All skills are up to date/);
  assert.match(after.body, /data-skills-toast="Marked as yours\. It stops showing here\."/);
  assert.ok(existsSync(join(SKILLS, "retired-fixture.md")), "Keep keeps the file");
});

test("Keep mine on a copy behind its extension quiets it until another version ships", async () => {
  setup();
  const d = await call({ query: { skill: "media", compare: "1" } });
  const sha = skillHash(shipped("media", "media.md"));
  assert.match(d.body, new RegExp(`name="srcSha" value="${sha}"`));
  await call({ method: "POST", body: { action: "ack", skill: "media.md", srcSha: sha } });
  assert.doesNotMatch(text(strip((await call()).body)), /updates stopped/);
  assert.equal(readFileSync(join(SKILLS, "media.md"), "utf8"), "# My own media notes\n");
});

test("an action whose state changed since the page loaded writes nothing and says so", async () => {
  setup();
  writeFileSync(join(SKILLS, "kiosk.md"), "# edited meanwhile\n");
  const r = await call({ method: "POST", body: { action: "apply-update", skill: "kiosk.md" } });
  assert.match(r.redirect, /error=changed/);
  assert.equal(readFileSync(join(SKILLS, "kiosk.md"), "utf8"), "# edited meanwhile\n");
  assert.match((await call({ query: { error: "changed" } })).body, /changed since the page loaded, so nothing was written/);
});

test("a name a bot asks for that exists nowhere is listed as missing, with a link to that bot", async () => {
  setup();
  BOTS.push({ bot_id: "research-desk", display_name: "Research desk", enabled: 1, definition: JSON.stringify({ skills: ["ghost-skill"] }) });
  try {
    const s = strip((await call()).body);
    assert.match(text(s), /Needs a look · 5/);
    assert.match(text(s), /ghost-skill .*Missing · a bot still asks for it .*Take it off Research desk/);
    assert.match(s, /href="\/dashboard\/bot-builder\?bot=research-desk&amp;tab=abilities"/);
  } finally { BOTS.pop(); }
});

test("nothing to look at: one line, all skills are up to date", async () => {
  setup();
  rmSync(join(HOME, "skill-installs.json"));
  for (const f of ["kiosk.md", "media.md", "retired-fixture.md"]) rmSync(join(SKILLS, f));
  writeFileSync(join(HOME, "installed.json"), "[]");
  const saved = BOTS.splice(0);
  let s;
  try { s = strip((await call()).body); } finally { BOTS.push(...saved); }
  assert.match(s, /class="sk-attn ok"/);
  assert.match(text(s), /^All skills are up to date$/);
});
