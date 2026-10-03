/**
 * S6-CROW — Bot Builder › Permissions › "Folders this bot can read".
 *
 * The save handler validates and stores permission_policy.read_paths (one
 * absolute path per line; an invalid line refuses the whole save), and the
 * Permissions tab shows the project folder the bridge adds automatically as
 * read-only text — never stored in the def.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-read-paths-"));
process.env.CROW_DATA_DIR = dir;

let db = null;
let handleBotBuilderPost = null;
let renderBotEditor = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ handleBotBuilderPost } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js"));
  await db.execute({ sql: "INSERT INTO project_spaces (id, slug, name, workspace_dir) VALUES (?,?,?,?)",
    args: [7, "alpha", "Alpha", "/srv/projects/alpha"] });
  const def = JSON.stringify({ tools: {}, models: {}, permission_policy: { bash: "deny", write_paths: [] } });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)",
    args: ["proj-bot", "Proj Bot", def, 7] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,NULL)",
    args: ["solo-bot", "Solo Bot", def] });
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const mkRes = () => {
  const res = { html: null, redirected: null };
  res.send = (s) => { res.html = s; return res; };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  return res;
};
async function readDef(botId) {
  const { rows } = await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [botId] });
  return JSON.parse(rows[0].definition);
}
const save = async (botId, readPaths) => {
  const res = mkRes();
  await handleBotBuilderPost({ body: {
    action: "save_permissions", bot_id: botId, pp_bash: "deny", pp_write_paths: "",
    pp_external_send: "draft_only", pp_confirm: "", pp_read_paths: readPaths,
  }, headers: {}, cookies: {} }, res, { db });
  return res;
};
const render = async (botId, lang = "en") => {
  const res = mkRes();
  const req = { method: "GET", query: { bot: botId, tab: "permissions" }, body: {}, cookies: {}, headers: {} };
  await renderBotEditor(req, res, { db, layout: ({ content }) => content, lang, PAGE_CSS: "", botId, notice: "", q: req.query });
  return res.html;
};

test("save: read folders are stored normalized and de-duplicated; the project folder is NOT stored", async () => {
  const res = await save("proj-bot", " /home/u/notes/ \n/home/u/notes\n\n/data/shared\n");
  assert.match(res.redirected, /saved=1/, res.redirected);
  const def = await readDef("proj-bot");
  assert.deepEqual(def.permission_policy.read_paths, ["/home/u/notes", "/data/shared"]);
});

test("save: an invalid line refuses the whole save with a translated error and keeps the old value", async () => {
  const res = await save("proj-bot", "/ok/path\nDocuments\n/x/../etc");
  assert.match(res.redirected, /tab=permissions&error=/);
  const msg = decodeURIComponent(res.redirected.split("error=")[1]);
  assert.match(msg, /absolute paths/);
  assert.match(msg, /Documents, \/x\/\.\.\/etc/);
  assert.deepEqual((await readDef("proj-bot")).permission_policy.read_paths, ["/home/u/notes", "/data/shared"],
    "nothing changed");
});

test("save: an empty field clears the explicit folders", async () => {
  const res = await save("solo-bot", "");
  assert.match(res.redirected, /saved=1/);
  assert.deepEqual((await readDef("solo-bot")).permission_policy.read_paths, []);
});

test("render: the field shows the stored folders and the auto-added project folder read-only (en + es)", async () => {
  const html = await render("proj-bot");
  assert.match(html, /Folders this bot can read/);
  assert.match(html, /<textarea name="pp_read_paths"[^>]*>\/home\/u\/notes\n\/data\/shared<\/textarea>/);
  assert.match(html, /data-testid="read-paths-project">Added automatically[^<]*<code>\/srv\/projects\/alpha<\/code>/);
  const es = await render("proj-bot", "es");
  assert.match(es, /Carpetas que este bot puede leer/);
  assert.match(es, /Añadida automáticamente/);
});

test("render: a bot without a project shows no auto-added folder", async () => {
  const html = await render("solo-bot");
  assert.match(html, /name="pp_read_paths"/);
  assert.doesNotMatch(html, /read-paths-project/);
});
