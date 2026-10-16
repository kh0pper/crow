/**
 * "Give <Name> a task" (queue item 20, PR 2, option B): the bot card's ⋯
 * "Give a task…" opens a dialog — write a new task OR pick a waiting
 * (Unassigned) card, then "Add to board for later" (the default) or
 * "Start now". New task → POST /dashboard/perch-api/bots/<id>/tasks; a
 * waiting card → POST /dashboard/perch-api/cards/<id>/give. Only a bot whose
 * board is on gets the dialog; the others keep the link to the Bot Board
 * (where a board-off bot gets its Turn-on panel).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "btb-give-task-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;

let db, renderBotList, translations, giveTaskScript;
const cardIds = {};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const pid = (await createProjectSpace(db, { name: "Helper's board" })).id;
  const pid2 = (await createProjectSpace(db, { name: "Watcher's board" })).id;
  const add = (id, name, def, p) => db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)",
    args: [id, name, JSON.stringify(def), p] });
  await add("helper", "Helper", { gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }, pid);
  await add("watcher", "Watcher", { gateways: [{ type: "glasses" }] }, pid2);
  await add("assistant", "Assistant", { gateways: [{ type: "perch" }], tracker_config: { type: "none" } }, null);

  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    tags TEXT, parent_id INTEGER, project_id INTEGER, assigned_bot TEXT, board_id INTEGER,
    archived_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  const ins = t.prepare("INSERT INTO tasks_items (title, project_id) VALUES (?,?)");
  cardIds.vet = Number(ins.run("Book the <vet>", null).lastInsertRowid);
  cardIds.onBoard = Number(ins.run("already on a board", pid).lastInsertRowid);
  t.close();

  ({ renderBotList } = await import("../servers/gateway/dashboard/panels/bot-builder/html.js"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  ({ giveTaskScript } = await import("../servers/gateway/dashboard/panels/bot-builder/give-task.js"));
});
after(() => { try { db && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

async function render(lang = "en") {
  const res = { html: null, send(h) { this.html = h; return this; }, redirectAfterPost() {} };
  const headers = lang === "es" ? { cookie: "crow_lang=es" } : {};
  await renderBotList(res, { db, layout: ({ content }) => content, notice: "", PAGE_CSS: "", req: { headers, csrfToken: "tok" } });
  return res.html;
}
function cardOf(html, id) {
  const a = html.indexOf(`data-bot="${id}"`);
  assert.ok(a >= 0, id);
  const b = html.indexOf('class="btb-botcard"', a + 1);
  return html.slice(a, b > 0 ? b : html.indexOf('class="btb-botcard-new"'));
}
function dialog(html) {
  const a = html.indexOf('<div class="btb-give" id="btb-give"');
  assert.ok(a >= 0, "the dialog renders");
  return html.slice(a, html.indexOf("<script>", a));
}

test("a board-on bot's ⋯ 'Give a task…' opens the dialog (a menuitem button carrying the bot)", async () => {
  const html = await render();
  assert.match(cardOf(html, "helper"), /<button type="button" role="menuitem" tabindex="-1" class="btb-give-task" data-bot-id="helper" data-name="Helper" data-perch="1" aria-haspopup="dialog" aria-controls="btb-give">Give a task…<\/button>/);
  assert.match(cardOf(html, "watcher"), /class="btb-give-task" data-bot-id="watcher" data-name="Watcher" data-perch="0"/);
});

test("a board-off bot keeps the link to its Bot Board (the Turn-on panel)", async () => {
  const c = cardOf(await render(), "assistant");
  assert.ok(!c.includes("btb-give-task"));
  assert.ok(c.includes('href="/dashboard/bot-board?bot=assistant">Give a task…</a>'));
});

test("the dialog: hidden modal, a textarea for a new task, a select of waiting cards, later checked over now", async () => {
  const d = dialog(await render());
  assert.match(d, /^<div class="btb-give" id="btb-give" role="dialog" aria-modal="true" aria-labelledby="btb-give-h" hidden>/);
  assert.match(d, /<textarea id="btb-give-text" rows="3" maxlength="500"[^>]*><\/textarea>/);
  assert.match(d, /<select id="btb-give-card"><option value="">\(none\)<\/option><option value="(\d+)">Book the &lt;vet&gt;<\/option><\/select>/);
  assert.ok(!d.includes("already on a board"), "only Unassigned cards are offered");
  assert.match(d, /<input type="radio" name="btb-give-when" value="later" checked>/);
  assert.match(d, /<input type="radio" name="btb-give-when" value="now">/);
  assert.ok(d.includes(translations["botboard.giveNowNeedsPerch"].en));
});

test("Spanish: the dialog and the menu item carry no English", async () => {
  const html = await render("es");
  const d = dialog(html);
  for (const k of ["botbuilder.giveTaskNew", "botbuilder.giveTaskOrPick", "botbuilder.giveTaskNone", "botboard.giveLater", "botboard.giveNow"]) {
    assert.ok(d.includes(translations[k].es), k);
    assert.ok(!d.includes(">" + translations[k].en + "<"), k + " en");
  }
  assert.ok(cardOf(html, "helper").includes(">" + translations["botbuilder.rowGiveTask"].es + "<"));
});

// ---- the client script ----------------------------------------------------

function body(lang = "en") {
  const m = giveTaskScript(lang).match(/^<script>([\s\S]*)<\/script>$/);
  assert.ok(m);
  return m[1];
}

test("the script ships on the page, parses, has no backticks, and routes its strings through tJs", async () => {
  assert.ok((await render()).includes("window.__btbGiveTask"));
  const en = body("en"), es = body("es");
  assert.ok(!en.includes("`"));
  assert.doesNotThrow(() => new Function(en));
  for (const k of ["botbuilder.giveTaskTitle", "botbuilder.giveTaskNewPh", "botbuilder.giveTaskNeedOne", "botboard.giveBtn", "botboard.giveDone", "botboard.giveStarted", "botboard.giveStartFailed", "botboard.giveFailed"]) {
    const v = translations[k];
    assert.ok(en.includes("'" + v.en.replace(/'/g, "\\'") + "'"), k + " en");
    assert.ok(es.includes("'" + v.es.replace(/'/g, "\\'") + "'"), k + " es");
    assert.ok(!es.includes("'" + v.en.replace(/'/g, "\\'") + "'"), k + " leaks English");
  }
});

class El {
  constructor(doc, tag, attrs = {}) {
    this.doc = doc; this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.parent = null;
    this.hidden = "hidden" in attrs; this.disabled = "disabled" in attrs; this.checked = "checked" in attrs;
    this.textContent = ""; this.value = attrs.value || ""; this.placeholder = "";
  }
  get id() { return this.attrs.id || ""; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  hasAttribute(n) { return n in this.attrs; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  matches(sel) {
    return sel.split(",").some((one) => {
      const s = one.trim();
      if (s.startsWith(".")) return String(this.attrs.class || "").split(" ").includes(s.slice(1));
      const a = s.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
      if (a) return a[2] === undefined ? this.hasAttribute(a[1]) : this.getAttribute(a[1]) === a[2];
      return s === this.tag;
    });
  }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.matches && n.matches(sel)) return n; return null; }
  contains(o) { for (let n = o; n; n = n.parent) if (n === this) return true; return false; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  focus() { this.doc.activeElement = this; }
}

function mount() {
  const listeners = {};
  const doc = { activeElement: null, addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); } };
  const E = (tag, attrs) => new El(doc, tag, attrs);
  const root = E("body");
  const more = E("button", { class: "btb-more", "aria-controls": "btb-menu-0", "aria-expanded": "true" });
  const menu = E("div", { class: "btb-menu", id: "btb-menu-0" });
  const giveHelper = E("button", { class: "btb-give-task", "data-bot-id": "helper", "data-name": "Helper", "data-perch": "1" });
  const giveWatcher = E("button", { class: "btb-give-task", "data-bot-id": "watcher", "data-name": "Watcher", "data-perch": "0" });
  menu.append(giveHelper, giveWatcher);
  const dlg = E("div", { class: "btb-give", id: "btb-give", hidden: "" });
  const panel = E("div", { class: "btb-give-panel" });
  const title = E("p", { id: "btb-give-h" });
  const text = E("textarea", { id: "btb-give-text" });
  const select = E("select", { id: "btb-give-card" });
  const later = E("input", { type: "radio", name: "btb-give-when", value: "later", checked: "" });
  const now = E("input", { type: "radio", name: "btb-give-when", value: "now" });
  const hint = E("p", { id: "btb-give-hint", hidden: "" });
  const cancel = E("button", { "data-give-close": "" });
  const go = E("button", { id: "btb-give-go" });
  panel.append(title, text, select, later, now, hint, cancel, go);
  dlg.append(panel);
  root.append(more, menu, dlg);
  doc.getElementById = (id) => root.querySelectorAll(`[id="${id}"]`)[0] || null;
  doc.querySelector = (s) => root.querySelector(s);
  doc.querySelectorAll = (s) => root.querySelectorAll(s);
  const fetches = [], toasts = [], reloads = [];
  let respond = () => ({ ok: true, body: { ok: true, assigned: true, started: false, cardId: 99 } });
  const win = { crowToast: (msg, o) => toasts.push({ msg, type: o && o.type }) };
  const fetchFn = (url, opts) => { fetches.push({ url, body: JSON.parse(opts.body), method: opts.method }); const r = respond(); return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.body) }); };
  new Function("window", "document", "fetch", "setTimeout", "location", body())(win, doc, fetchFn, (f) => reloads.push(f), { href: "/dashboard/bot-builder", reload() {} });
  const fire = (type, target, key) => { const ev = { type, target, key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; for (const f of listeners[type] || []) f(ev); return ev; };
  return { doc, more, menu, giveHelper, giveWatcher, dlg, title, text, select, later, now, hint, cancel, go, fire, fetches, toasts, reloads, setRespond: (f) => { respond = f; }, flush: () => new Promise((r) => setTimeout(r, 0)) };
}

test("opening: the title names the bot, the ⋯ menu closes, later is checked, the textarea has focus", () => {
  const d = mount();
  d.fire("click", d.giveHelper);
  assert.equal(d.dlg.hidden, false);
  assert.equal(d.title.textContent, "Give Helper a task");
  assert.equal(d.text.placeholder, "What should Helper do?");
  assert.equal(d.menu.hidden, true);
  assert.equal(d.more.getAttribute("aria-expanded"), "false");
  assert.equal(d.later.checked, true);
  assert.equal(d.now.checked, false);
  assert.equal(d.doc.activeElement, d.text);
  assert.equal(d.go.textContent, "Give to Helper");
});

test("a bot with no Perch chat cannot Start now", () => {
  const d = mount();
  d.fire("click", d.giveWatcher);
  assert.equal(d.now.disabled, true);
  assert.equal(d.hint.hidden, false);
  d.fire("click", d.cancel);
  d.fire("click", d.giveHelper);
  assert.equal(d.now.disabled, false);
  assert.equal(d.hint.hidden, true);
});

test("a new task posts to bots/<id>/tasks with start:false by default", async () => {
  const d = mount();
  d.fire("click", d.giveHelper);
  d.text.value = "Plan the week";
  d.fire("input", d.text);
  d.fire("click", d.go);
  await d.flush();
  assert.deepEqual(d.fetches, [{ url: "/dashboard/perch-api/bots/helper/tasks", method: "POST", body: { title: "Plan the week", start: false } }]);
  assert.deepEqual(d.toasts.at(-1), { msg: "Given to Helper.", type: "success" });
  assert.equal(d.dlg.hidden, true);
});

test("a waiting card posts to cards/<id>/give; picking a card clears the textarea and vice versa", async () => {
  const d = mount();
  d.fire("click", d.giveHelper);
  d.text.value = "something";
  d.select.value = "12";
  d.fire("change", d.select);
  assert.equal(d.text.value, "", "picking a card clears the new-task text");
  d.later.checked = false; d.now.checked = true;
  d.setRespond(() => ({ ok: true, body: { ok: true, assigned: true, started: false, cardId: 12, code: "engine_required" } }));
  d.fire("click", d.go);
  await d.flush();
  assert.deepEqual(d.fetches.at(-1), { url: "/dashboard/perch-api/cards/12/give", method: "POST", body: { bot_id: "helper", start: true } });
  assert.equal(d.toasts.at(-1).msg, "Given to Helper. Couldn't start: engine_required");
  d.fire("click", d.giveHelper);
  d.select.value = "12";
  d.text.value = "typed";
  d.fire("input", d.text);
  assert.equal(d.select.value, "", "typing a task clears the picked card");
});

test("neither a task nor a card: says what is needed and posts nothing", () => {
  const d = mount();
  d.fire("click", d.giveHelper);
  d.text.value = "   ";
  d.fire("click", d.go);
  assert.equal(d.fetches.length, 0);
  assert.deepEqual(d.toasts.at(-1), { msg: "Write a task or pick a waiting card.", type: "error" });
  assert.equal(d.dlg.hidden, false);
});

test("Escape closes and hands focus back to the card's ⋯ button", () => {
  const d = mount();
  d.fire("click", d.giveHelper);
  const ev = d.fire("keydown", d.text, "Escape");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(d.dlg.hidden, true);
  assert.equal(d.doc.activeElement, d.more);
});
