// House style (spec §4.4, D4/D5): per project (by uuid), optional per-bot
// default, off unless set; only themes the installed kit knows. Sync (bot
// spawn) and async (artifacts save) readers agree.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { openKit } from "../bundles/design-kit/server/kit.js";
import { renderVersion } from "../bundles/artifacts/server/render.js";
import { createDesign } from "../bundles/artifacts/server/design.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { pickHouseStyle, botThemeOf, readHouseStyleSync, readHouseStyle, readKitThemes, installedKitDir, houseStyleLinks } from "../servers/shared/design-kit.js";

const KIT = new URL("../bundles/design-kit", import.meta.url).pathname;
const s = {};
before(async () => {
  s.home = mkdtempSync(join(tmpdir(), "house-style-"));
  s.db = createDbClient(join(s.home, "crow.db"));
  await s.db.executeMultiple(`
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER);
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    INSERT INTO project_spaces (id, uuid, slug, name) VALUES (7, 'u-seven', 'seven', 'Seven'), (8, 'u-eight', 'eight', 'Eight');`);
  await s.db.execute({ sql: "CREATE TABLE IF NOT EXISTS design_house_styles (project_uuid TEXT PRIMARY KEY, theme TEXT NOT NULL, set_at TEXT NOT NULL DEFAULT (datetime('now')))", args: [] });
  await s.db.execute({ sql: "INSERT INTO design_house_styles (project_uuid, theme) VALUES ('u-gone', 'old-theme')", args: [] });
  await initArtifactsTables(s.db);   // prunes the orphan row above
  const rows = [["solo", null, { design: { house_style: "bot-theme" } }], ["proj", 7, { design: { house_style: "bot-theme" } }], ["plain", 7, {}], ["none", null, {}], ["junk", 8, { design: { house_style: "../x" } }]];
  for (const [id, p, def] of rows) await s.db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id) VALUES (?,?,?,?)", args: [id, id, JSON.stringify(def), p] });
  await s.db.execute({ sql: "INSERT INTO design_house_styles (project_uuid, theme) VALUES ('u-seven', 'proj-theme'), ('u-eight', 'ghost-theme')", args: [] });
});
after(() => { try { s.db.close(); } catch {} rmSync(s.home, { recursive: true, force: true }); });

test("init prunes rows whose project no longer exists (review L8)", async () => {
  assert.equal((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM design_house_styles WHERE project_uuid='u-gone'", args: [] })).rows[0].n, 0);
});

test("pickHouseStyle: project wins, then the bot, only known ids", () => {
  const known = new Set(["proj-theme", "bot-theme"]);
  assert.equal(pickHouseStyle({ projectTheme: "proj-theme", botTheme: "bot-theme", known }), "proj-theme");
  assert.equal(pickHouseStyle({ projectTheme: null, botTheme: "bot-theme", known }), "bot-theme");
  assert.equal(pickHouseStyle({ projectTheme: "ghost-theme", botTheme: "bot-theme", known }), "bot-theme", "an unknown project theme is ignored");
  assert.equal(pickHouseStyle({ projectTheme: "proj-theme", botTheme: null, known: new Set() }), null, "no kit → none");
  assert.equal(pickHouseStyle({ projectTheme: "../x", botTheme: null, known: new Set(["../x"]) }), null, "bad ids never pass");
  assert.equal(botThemeOf({ design: { house_style: 3 } }), null);
  assert.equal(botThemeOf(null), null);
});

test("sync and async readers agree on every fixture bot", async () => {
  const known = new Set(["proj-theme", "bot-theme"]);
  const conn = new Database(join(s.home, "crow.db"), { readonly: true });
  try {
    const expected = { solo: "bot-theme", proj: "proj-theme", plain: "proj-theme", none: null, junk: null, missing: null };
    for (const [id, want] of Object.entries(expected)) {
      const row = conn.prepare("SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?").get(id);
      const sync = row ? readHouseStyleSync(conn, { projectId: row.project_id, def: JSON.parse(row.definition), known }) : null;
      assert.equal(sync, want, `sync ${id}`);
      assert.equal(await readHouseStyle(s.db, id, { known }), want, `async ${id}`);
    }
  } finally { conn.close(); }
});

test("a database without the tables reads as no house style", async () => {
  const conn = new Database(":memory:");
  try { assert.equal(readHouseStyleSync(conn, { projectId: 7, def: {}, known: new Set(["proj-theme"]) }), null); } finally { conn.close(); }
});

test("readKitThemes and houseStyleLinks: the installed kit's themes; empty when not installed", () => {
  const home = mkdtempSync(join(tmpdir(), "house-kit-"));
  try {
    assert.equal(readKitThemes(home).size, 0);
    mkdirSync(join(home, "bundles"), { recursive: true });
    cpSync(KIT, join(home, "bundles", "design-kit"), { recursive: true, filter: (p) => !p.includes("node_modules") });
    assert.equal(readKitThemes(home).size, 0, "copied but not in installed.json");
    writeFileSync(join(home, "installed.json"), JSON.stringify([{ id: "design-kit", type: "bundle", version: "1.0.0" }]));
    assert.equal(installedKitDir(home), join(home, "bundles", "design-kit"));
    const t = readKitThemes(home);
    assert.equal(t.size, 10);
    for (const { name } of t.values()) assert.match(name, /^[\p{L}\p{N} ]+$/u);
    const [id, theme] = [...t.entries()][0];
    const doc = JSON.parse(readFileSync(join(KIT, "lib", "themes.json"), "utf8")).themes[id];
    const fonts = [...new Set([doc.fonts.heading, doc.fonts.body])];
    assert.deepEqual(houseStyleLinks(id, theme), [...fonts.map((f) => `__lib/font/${f.slice(5)}/font.css`), `__lib/themes/${id}.css`]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a lib named twice plus a house style: the theme never leaks into libs (deduped refs)", async () => {
  const kit = openKit(KIT);
  const [id] = kit.themes.keys();
  const design = { kit: async () => kit };
  const r = await renderVersion("page", { html: "<p>x</p>", libs: ["css:pico", "css:pico"] }, { markdownBlocks, design, houseStyle: id });
  assert.deepEqual(r.design.libs, ["__lib/css/pico/pico.min.css"]);
  assert.equal(r.design.house_style, id);
  assert.ok(r.design.house_style_links.at(-1) === `__lib/themes/${id}.css`);
  assert.ok(!r.files[0].body.toString().includes("pico"), "a page is never injected: Pico stays a linked file");
  // The house style already listed as a lib: reported once in libs, still the house style.
  const both = await renderVersion("page", { html: "<p>x</p>", libs: [`theme:${id}`, `theme:${id}`] }, { markdownBlocks, design, houseStyle: id });
  assert.deepEqual(both.design.libs, [`__lib/themes/${id}.css`]);
  assert.equal(both.design.house_style, id);
});

test("a house style the kit no longer knows (dropped by an upgrade) is ignored, never refused", async () => {
  const kit = openKit(KIT);
  const r = await renderVersion("document", { markdown: "# A\n\nB." }, { markdownBlocks, design: { kit: async () => kit }, houseStyle: "gone-theme" });
  assert.equal(r.design, null);
  assert.ok(!r.files.some((f) => f.path.startsWith("__lib/")));
  const none = await renderVersion("document", { markdown: "# A\n\nB." }, { markdownBlocks, design: { kit: async () => null }, houseStyle: "arctic-frost" });
  assert.equal(none.design, null, "kit gone: no style, no refusal");
});

test("createDesign: a failing shared-module import degrades to no kit and no house style", async () => {
  const d = createDesign({ crowHome: s.home, db: s.db, importShared: async () => { throw new Error("boom"); } });
  assert.equal(await d.kit(), null);
  assert.equal(await d.houseStyleFor("solo"), null);
});

test("createDesign.houseStyleFor: the installed kit's theme for a bot default; none for an unknown one", async () => {
  const home = mkdtempSync(join(tmpdir(), "house-design-"));
  try {
    mkdirSync(join(home, "bundles"), { recursive: true });
    cpSync(KIT, join(home, "bundles", "design-kit"), { recursive: true, filter: (p) => !p.includes("node_modules") });
    writeFileSync(join(home, "installed.json"), JSON.stringify([{ id: "design-kit", type: "bundle", version: "1.0.0" }]));
    const [id] = readKitThemes(home).keys();
    await s.db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES ('styled','styled',?)", args: [JSON.stringify({ design: { house_style: id } })] });
    const d = createDesign({ crowHome: home, db: s.db });
    assert.equal(await d.houseStyleFor("styled"), id);
    assert.equal(await d.houseStyleFor("solo"), null, "bot-theme is not a kit theme");
    assert.equal(await d.houseStyleFor(null), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
