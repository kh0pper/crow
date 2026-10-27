/**
 * Shell P2 Task 2.5 — the Chat tab shows the current project's conversations,
 * and an unsent composer draft survives a reload.
 *
 * Two harnesses:
 *   - /roost over HTTP against a real init-db'd scratch crow.db (CROW_DATA_DIR,
 *     never the operator's ~/.crow) with a fake interactive engine seam, the
 *     tests/roost-strip-data.test.js shape;
 *   - the emitted Perch client run in a vm sandbox against a small fake DOM,
 *     the tests/perch-hub-client.test.js shape.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-scope-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;
const PERCH_BOT = { gateways: [{ type: "perch" }], models: { default: "local/qwen" } };

// ---------------------------------------------------------------------------
// GET /roost: each session's own project
// ---------------------------------------------------------------------------

const ENGINE_SESSIONS = [
  // Filed in project 2 while its bot's home is project 3: the filing wins.
  { sessionId: "perchlive-a", botId: "homebot", state: "awake", pendingUi: null, cardId: null },
  // No shell_items row at all: the bot's own (live) project.
  { sessionId: "perchlive-b", botId: "homebot", state: "awake", pendingUi: null, cardId: null },
  // A row filed under no project: Unassigned, never the bot's project.
  { sessionId: "perchlive-c", botId: "homebot", state: "hibernating", pendingUi: null, cardId: null },
  // No row, and the bot's project is archived: Unassigned.
  { sessionId: "perchlive-d", botId: "archbot", state: "awake", pendingUi: null, cardId: null },
  // Filed in an archived project: Unassigned.
  { sessionId: "perchlive-e", botId: "archbot", state: "awake", pendingUi: null, cardId: null },
];

let server, base;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (id, slug, name, status, archived_at) VALUES (?,?,?,?,?)");
  proj.run(2, "p-two", "Two", "active", null);
  proj.run(3, "p-three", "Three", "active", null);
  proj.run(4, "p-four", "Four", "archived", "2026-10-01 00:00:00");
  const bot = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)");
  bot.run("homebot", "Home Bot", JSON.stringify(PERCH_BOT), 3);
  bot.run("archbot", "Arch Bot", JSON.stringify(PERCH_BOT), 4);
  const item = c.prepare("INSERT INTO shell_items (item_kind, item_ref, project_id, set_by) VALUES ('perch_thread', ?, ?, 'operator')");
  item.run("perchlive-a", 2);
  item.run("perchlive-c", null);
  item.run("perchlive-e", 4);
  c.close();

  const { default: perchApiRouter } = await import("../servers/gateway/routes/perch.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use(perchApiRouter((req, res, next) => next(), {
    interactiveEngine: { list: async () => ENGINE_SESSIONS.map((s) => ({ ...s })) },
  }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard/perch-api";
});

after(() => {
  if (server) server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function roost(qs = "") {
  const r = await fetch(base + "/roost" + qs);
  assert.equal(r.status, 200);
  return r.json();
}
function projectsBySession(body) {
  const out = {};
  for (const b of body.birds) for (const s of b.sessions) out[s.sessionId] = s.projectId;
  return out;
}

test("/roost reports each session's own project", async () => {
  const p = projectsBySession(await roost());
  assert.equal(p["perchlive-a"], 2, "the thread's filing wins over the bot's home project");
  assert.equal(p["perchlive-b"], 3, "a thread with no row reports its bot's live project");
  assert.equal(p["perchlive-c"], null, "a row filed under no project is Unassigned, not the bot's");
  assert.equal(p["perchlive-d"], null, "a bot whose project is archived gives no project");
  assert.equal(p["perchlive-e"], null, "a thread filed in an archived project is Unassigned");
});

test("/roost survives a broken shell_items read: 200, every projectId null", async () => {
  const c = new Database(DB_FILE);
  c.exec("ALTER TABLE shell_items RENAME TO shell_items_saved; CREATE TABLE shell_items (unrelated INTEGER);");
  c.close();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const p = projectsBySession(await roost());
    assert.equal(Object.keys(p).length, ENGINE_SESSIONS.length);
    for (const v of Object.values(p)) assert.equal(v, null);
  } finally {
    console.warn = warn;
    const d = new Database(DB_FILE);
    d.exec("DROP TABLE shell_items; ALTER TABLE shell_items_saved RENAME TO shell_items;");
    d.close();
  }
  assert.equal(projectsBySession(await roost())["perchlive-a"], 2, "restored");
});

test("/roost echoes ?scope= and leaves it out otherwise", async () => {
  assert.equal((await roost()).scope, undefined);
  assert.equal((await roost("?scope=2")).scope, 2);
  assert.equal((await roost("?scope=unassigned")).scope, "unassigned");
  assert.equal((await roost("?scope=all")).scope, "all");
  assert.equal((await roost("?scope=nonsense")).scope, "all");
});

// ---------------------------------------------------------------------------
// The client, in a vm sandbox
// ---------------------------------------------------------------------------

function makeTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const a = listeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    _dispatch(type, ev) { (listeners[type] || []).slice().forEach((fn) => fn(ev || {})); },
  };
}

let REGISTRY = null;
function makeEl(tag) {
  const attrs = {};
  const node = Object.assign(makeTarget(), {
    tagName: String(tag || "div").toUpperCase(),
    children: [], className: "", textContent: "", value: "", checked: false, disabled: false,
    hidden: false, type: "", placeholder: "",
    style: Object.defineProperty({}, "setProperty", { value(k, v) { this[k] = String(v); }, enumerable: false }),
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(ch) { this.children.push(ch); if (ch && typeof ch === "object") ch.parentNode = this; if (REGISTRY && ch && ch.id) REGISTRY[ch.id] = ch; return ch; },
    removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; },
    insertBefore(ch, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.unshift(ch); else this.children.splice(i, 0, ch); return ch; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    removeAttribute(k) { delete attrs[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    click() { if (this.onclick) this.onclick(); },
    focus() {}, blur() {},
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; },
  });
  node.innerHTML = "";
  Object.defineProperty(node, "firstChild", { get() { return this.children[0] || null; } });
  Object.defineProperty(node, "options", { get() { return this.children; } });
  return node;
}

const IDS = ["perch-list-body", "perch-transcript", "perch-ask", "perch-bot-name",
  "perch-session-meta", "perch-session-id", "perch-state", "perch-model", "perch-thinking", "perch-permission",
  "perch-plan-mode", "perch-input", "perch-send", "perch-back", "perch-abort",
  "perch-attach", "perch-file-input", "perch-chat",
  "perch-new", "perch-new-bot", "perch-new-bot-label", "perch-launch-note", "perch-close",
  "perch-new-model", "perch-new-model-label", "perch-new-model-more", "perch-model-more",
  "perch-rename", "perch-session-name",
  "perch-new-cwd", "perch-browse-btn", "perch-cwd-note", "perch-hub-root",
  "perch-launch-more", "perch-launch-more-model",
  "perch-tab-chat", "perch-tab-session", "perch-tab-files", "perch-tab-activity",
  "perch-tab-btn-chat", "perch-tab-btn-session", "perch-tab-btn-files", "perch-tab-btn-activity",
  "perch-activity-list", "perch-session-cwd", "perch-change-cwd", "perch-working",
  "perch-files-list", "perch-files-refresh", "perch-attn",
  "perch-fact-context", "perch-fact-uptime", "perch-fact-memory", "perch-fact-tools",
  "perch-ctxbar", "perch-ctxbar-fill", "perch-planbar", "perch-planbar-fill",
  "perch-plan-card", "perch-plan-head", "perch-plan-steps", "perch-cmdmenu",
  "perch-cwd-crumbs", "perch-cwd-list", "perch-file-viewer", "perch-fv-name",
  "perch-fv-close", "perch-fv-body",
  "perch-narrow-toggle", "perch-narrow-body",
  "perch-text-smaller", "perch-text-reset", "perch-text-larger", "perch-text-size-value"];

function makeStorage() {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    _map: m,
  };
}

function makeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function mount({ scope = null, roost, sessionStorage, initialHash = "", fetchImpl } = {}) {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const els = {};
  for (const id of IDS) els[id] = makeEl(id === "perch-plan-mode" ? "input" : "div");
  if (scope !== null) els["perch-hub-root"].setAttribute("data-scope", scope);
  const dynamic = {};
  REGISTRY = dynamic;
  const doc = Object.assign(makeTarget(), {
    cookie: "crow_csrf=t", body: makeEl("body"), documentElement: makeEl("html"),
    getElementById(id) { return els[id] || dynamic[id] || null; },
    createElement(tag) { return makeEl(tag); },
    createTextNode(t) { const n = makeEl("#text"); n.textContent = String(t); return n; },
    activeElement: null,
  });
  const mq = Object.assign(makeTarget(), { matches: false, media: "" });
  const win = Object.assign(makeTarget(), {
    innerHeight: 800, matchMedia: () => mq,
    visualViewport: Object.assign(makeTarget(), { height: 700, offsetTop: 0 }),
  });
  if (sessionStorage) win.sessionStorage = sessionStorage;
  const locState = { hash: initialHash };
  const location = {
    get hash() { return locState.hash; },
    set hash(v) { locState.hash = v; win._dispatch("hashchange", {}); },
    replace(v) { locState.hash = v === "#" ? "" : String(v); win._dispatch("hashchange", {}); },
    href: "", search: "",
  };
  const fetchCalls = [];
  const timers = new Map();
  let seq = 1;
  const sandbox = {
    document: doc, window: win, location,
    confirm: () => false, prompt: () => null,
    EventSource: class { constructor() { this.closed = false; } addEventListener() {} close() { this.closed = true; } },
    fetch(url, opts) {
      const method = (opts && opts.method) || "GET";
      const path = String(url).replace(/^.*perch-api/, "");
      fetchCalls.push({ method, path, opts });
      if (fetchImpl) return Promise.resolve(fetchImpl(method, path, opts));
      if (method === "GET" && path.startsWith("/roost")) return Promise.resolve(makeResponse(200, roost || { birds: [] }));
      return Promise.resolve(makeResponse(200, {}));
    },
    setTimeout(fn, d) { const id = seq++; timers.set(id, { fn, d }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, d) { const id = seq++; timers.set(id, { fn, d }); return id; },
    clearInterval(id) { timers.delete(id); },
    FileReader: class {},
  };
  vm.createContext(sandbox);
  vm.runInContext(perchHubJs("en"), sandbox);
  await tick(); await tick();
  return { els, doc, win, location, fetchCalls, timers };
}

const sessionRows = (els) => els["perch-list-body"].children
  .filter((r) => r.className === "roost-row" && r.children.some((c) => c.getAttribute && c.getAttribute("data-sid")));

const ROOST = {
  birds: [{ id: "homebot", name: "Home Bot", perch_attached: true, state: "working", sessions: [
    { sessionId: "perchlive-00000002", state: "awake", cardId: null, pendingUi: false, projectId: 2 },
    { sessionId: "perchlive-00000003", state: "awake", cardId: null, pendingUi: false, projectId: 3 },
    { sessionId: "perchlive-0000000a", state: "awake", cardId: null, pendingUi: false, projectId: null },
  ] }],
  occupiedCardIds: [],
  archived: [],
};

test("the list shows only the scope's sessions", async () => {
  const two = await mount({ scope: "2", roost: ROOST });
  assert.deepEqual(sessionRows(two.els).map((r) => r.children.find((c) => c.getAttribute && c.getAttribute("data-sid")).getAttribute("data-sid")),
    ["perchlive-00000002"]);
  const un = await mount({ scope: "unassigned", roost: ROOST });
  assert.deepEqual(sessionRows(un.els).map((r) => r.children.find((c) => c.getAttribute && c.getAttribute("data-sid")).getAttribute("data-sid")),
    ["perchlive-0000000a"]);
  const all = await mount({ scope: "all", roost: ROOST });
  assert.equal(sessionRows(all.els).length, 3);
});

test("a new session in a project carries it", async () => {
  const hub = await mount({ scope: "2", roost: ROOST });
  hub.els["perch-new"].click();
  await tick();
  const spawn = hub.fetchCalls.find((c) => c.method === "POST" && c.path === "/bots/homebot/interactive");
  assert.ok(spawn, "New session posts a spawn");
  assert.match(String(spawn.opts.body), /"project_id":2/);

  const un = await mount({ scope: "unassigned", roost: ROOST });
  un.els["perch-new"].click();
  await tick();
  const unSpawn = un.fetchCalls.find((c) => c.method === "POST" && c.path === "/bots/homebot/interactive");
  assert.match(String(unSpawn.opts.body), /"project_id":"unassigned"/, "an Unassigned view starts an Unassigned thread");

  const all = await mount({ scope: "all", roost: ROOST });
  all.els["perch-new"].click();
  await tick();
  const allSpawn = all.fetchCalls.find((c) => c.method === "POST" && c.path === "/bots/homebot/interactive");
  assert.ok(!/project_id/.test(String(allSpawn.opts.body || "")), "Everything leaves the filing to the bot's project");
});

test("perch composer draft survives a reload", async () => {
  const store = makeStorage();
  const sid = "perchlive-00000002";
  const KEY = "perch-draft:" + sid;
  const first = await mount({ roost: ROOST, sessionStorage: store, initialHash: "#" + sid });
  const input = first.els["perch-input"];
  input.value = "half a thought";
  input.oninput.call(input);
  // Debounced: nothing is written before the 300 ms timer...
  assert.equal(store.getItem(KEY), null);
  assert.ok([...first.timers.values()].some((t) => t.d === 300), "a 300 ms save is scheduled");
  // ...but leaving the page writes it at once.
  first.win._dispatch("pagehide", {});
  assert.equal(store.getItem(KEY), "half a thought");

  const second = await mount({ roost: ROOST, sessionStorage: store, initialHash: "#" + sid });
  assert.equal(second.els["perch-input"].value, "half a thought", "the draft is back in the composer");

  second.els["perch-send"].click();
  await tick(); await tick();
  assert.equal(store.getItem(KEY), null, "a successful send clears the draft");
});

test("a draft is saved on a Turbo visit and after the debounce, and a failed send keeps it", async () => {
  const store = makeStorage();
  const sid = "perchlive-00000003";
  const KEY = "perch-draft:" + sid;
  const hub = await mount({
    roost: ROOST, sessionStorage: store, initialHash: "#" + sid,
    fetchImpl: (method, path) => {
      if (path.startsWith("/roost")) return makeResponse(200, ROOST);
      if (method === "POST" && path.endsWith("/message")) return makeResponse(500, { error: "boom" });
      return makeResponse(200, {});
    },
  });
  const input = hub.els["perch-input"];
  input.value = "first";
  input.oninput.call(input);
  const t = [...hub.timers.values()].find((x) => x.d === 300);
  t.fn();
  assert.equal(store.getItem(KEY), "first");
  input.value = "second";
  hub.doc._dispatch("turbo:before-visit", {});
  assert.equal(store.getItem(KEY), "second");
  hub.els["perch-send"].click();
  await tick(); await tick();
  assert.equal(store.getItem(KEY), "second", "an unsent message stays a draft");
  assert.equal(input.value, "second", "and its words come back into the composer");
});

test("a failed send survives a reload", async () => {
  const store = makeStorage();
  const sid = "perchlive-00000002";
  const KEY = "perch-draft:" + sid;
  const failing = (method, path) => {
    if (path.startsWith("/roost")) return makeResponse(200, ROOST);
    if (method === "POST" && path.endsWith("/message")) return makeResponse(0, null);   // the network failing
    return makeResponse(200, {});
  };
  const first = await mount({ sessionStorage: store, initialHash: "#" + sid, fetchImpl: failing });
  const input = first.els["perch-input"];
  input.value = "never debounced";       // typed and sent before the 300 ms save could run
  input.oninput.call(input);
  first.els["perch-send"].click();
  await tick(); await tick();
  first.win._dispatch("pagehide", {});
  assert.equal(store.getItem(KEY), "never debounced");
  const second = await mount({ roost: ROOST, sessionStorage: store, initialHash: "#" + sid });
  assert.equal(second.els["perch-input"].value, "never debounced");
});

test("a late success does not clear a draft typed after the send", async () => {
  const store = makeStorage();
  const sid = "perchlive-00000002";
  const KEY = "perch-draft:" + sid;
  let release;
  const pending = new Promise((r) => { release = r; });
  const hub = await mount({
    sessionStorage: store, initialHash: "#" + sid,
    fetchImpl: (method, path) => {
      if (path.startsWith("/roost")) return makeResponse(200, ROOST);
      if (method === "POST" && path.endsWith("/message")) return pending;
      return makeResponse(200, {});
    },
  });
  const input = hub.els["perch-input"];
  input.value = "sent words";
  hub.win._dispatch("pagehide", {});
  hub.els["perch-send"].click();
  input.value = "newer words";
  hub.win._dispatch("pagehide", {});
  assert.equal(store.getItem(KEY), "newer words");
  release(makeResponse(200, {}));
  await tick(); await tick(); await tick();
  assert.equal(store.getItem(KEY), "newer words", "the late success clears only the text it sent");
});

test("a bot busy only in other projects does not claim to be idle", async () => {
  const hub = await mount({ scope: "4", roost: ROOST });
  const rows = hub.els["perch-list-body"].children.filter((r) => r.className === "roost-row");
  assert.equal(rows.length, 1, "the bot stays startable");
  const text = JSON.stringify(rows[0], (k, v) => (k === "parentNode" ? undefined : v));
  assert.ok(!/"idle"/.test(text), "its row must not print idle");
  const idle = await mount({ scope: "4", roost: { birds: [{ id: "b", name: "B", perch_attached: true, state: "idle", sessions: [] }] } });
  const idleText = JSON.stringify(idle.els["perch-list-body"].children, (k, v) => (k === "parentNode" ? undefined : v));
  assert.match(idleText, /"idle"/, "a bot with no sessions at all is really idle");
});

test("a dictated draft is saved", async () => {
  const { perchDictationJs } = await import("../servers/gateway/dashboard/perch-hub/dictation.js");
  const src = perchDictationJs("en");
  const at = src.indexOf("input.value=mergeTranscript(input.value,text);");
  assert.ok(at > -1);
  assert.match(src.slice(at, at + 400), /draftSave\(\)/, "the transcript written into the composer is saved as the draft");
});

test("classic Perch is unchanged: every session renders and the machines nav shows", async () => {
  const hub = await mount({ roost: ROOST });
  assert.equal(sessionRows(hub.els).length, 3);
  hub.els["perch-new"].click();
  await tick();
  const spawn = hub.fetchCalls.find((c) => c.method === "POST" && c.path === "/bots/homebot/interactive");
  assert.ok(!/project_id/.test(String((spawn && spawn.opts.body) || "")));
  const roostCall = hub.fetchCalls.find((c) => c.path.startsWith("/roost"));
  assert.equal(roostCall.path, "/roost", "classic asks /roost with no scope");

  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const classic = perchHubContent("en", { state: "ready" });
  assert.ok(!/data-scope=/.test(classic));
  assert.match(classic, /<header><nav class="machines">/);
  const shell = perchHubContent("en", { state: "ready" }, { scope: { projectId: 7, slug: "x" } });
  assert.match(shell, /<div id="perch-hub-root" data-scope="7">/);
  assert.match(shell, /<header hidden><nav class="machines">/, "the tabs replace the Board link in the shell");
  assert.match(perchHubContent("en", undefined, { scope: { unassigned: true } }), /data-scope="unassigned"/);
  assert.match(perchHubContent("en", undefined, { scope: { all: true } }), /data-scope="all"/);
});

test("the panel writes data-scope only in new mode", async () => {
  const { default: panel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const layout = (o) => o.content;
  const classic = await panel.handler({ crowMode: { mode: "classic" }, crowScope: { all: true } }, {}, { lang: "en", layout });
  assert.ok(!/data-scope=/.test(classic));
  const fresh = await panel.handler({ crowMode: { mode: "new" }, crowScope: { projectId: 2, slug: "p" } }, {}, { lang: "en", layout });
  assert.match(fresh, /data-scope="2"/);
});
