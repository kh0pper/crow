/**
 * Redesign P3, Task 3.4: the Board tab in a real browser.
 *
 * The REAL dashboard router (dashboardAuth, csrfMiddleware, the body parser,
 * the panel dispatch, /dashboard/shell-api) is mounted over a scratch
 * CROW_DATA_DIR and a scratch tasks.db brought through migrations 0001–0004,
 * with the vendored Turbo 8 served from public/. A private headless Chrome
 * (tests/fixtures/headless-chrome.mjs) drives it at phone 390×844 and desktop
 * 1280×800, in English and Spanish:
 *   - the phone shows one lane at a time, the one its chip chose (no lane
 *     peeking in beside it);
 *   - neither the page nor the lanes scroll sideways, and chips, card faces and Move
 *     buttons are at least 44 px tall;
 *   - the desktop shows the four lanes side by side;
 *   - Move on the phone: the sheet shows Working disabled with its reason,
 *     and choosing Done re-renders the board with the card in Done;
 *   - drag on the desktop: a card dragged from Up next onto Done moves, and
 *     one dragged onto Working stays where it is, with the refusal shown;
 *   - a failed result moved onto Done asks first: No leaves it, Yes accepts it;
 *   - Details opens the card's drawer on its bot's board, results included.
 *
 * Network: this process stands in for tailscaled (actAsServe), and Chrome
 * sends the headers Serve writes (serveHeaders, via Network.setExtraHTTPHeaders)
 * on a loopback socket from the same uid. No middleware writes a header.
 *
 * The cards are re-seeded before every test, so each one starts from the
 * same board whatever the one before it moved.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "shell-board-live-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
const TASKS = join(dir, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS;
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-shell-board-live");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const REPO = new URL("..", import.meta.url).pathname;

let server, base, chrome, setLang, t;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)")
    .run(hashToken("new-sess"), "2026-06-01 00:00:00");
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
  c.close();

  // tasks.db: the post-0003 shape by hand, then 0004 through the real runner
  // (the board-archive idiom, as tests/shell-board-move-routes.test.js does).
  const tk = new Database(TASKS);
  tk.exec(`CREATE TABLE IF NOT EXISTS tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT,
    parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT,
    action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  tk.close();
  const migDir = join(dir, "migrations");
  mkdirSync(migDir);
  for (const f of ["0001-board-stages.mjs", "0002-board-defs.mjs", "0003-tracker-convergence.mjs", "0004-track1-card-model.mjs"]) {
    symlinkSync(join(REPO, "scripts", "migrations", f), join(migDir, f));
  }
  const { runMigrations } = await import("../scripts/migrations/runner.mjs");
  await runMigrations({ migrationsDir: migDir, dbPath: DB_FILE, tasksDbPath: TASKS, sha: "test", log: () => {} });

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();
  setLang = async (lang) => { const d = createDbClient(); try { await writeSetting(d, "language", lang); } finally { d.close(); } };
  ({ t } = await import("../servers/gateway/dashboard/shared/i18n.js"));

  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  // The gateway app parses JSON bodies before the dashboard router (servers/gateway/index.js).
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(fileURLToPath(new URL("../servers/gateway/public", import.meta.url))));
  // The Bot Board API (the card drawer's GET /card/:id), at app root before
  // the dashboard router, as boot/feature-mounts.js mounts it.
  const { default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  app.use(botBoardApiRouter((req, res, next) => next()));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
  // Headless Chrome has no pointing device, so (pointer: fine) and (hover: hover)
  // never match and the Board never offers drag. Declare a mouse, as a desktop
  // browser has; phone tabs turn on touch emulation (coarse, no hover).
  chrome = await startHeadlessChrome({ extraArgs: ["--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2"] });
});

after(async () => {
  server?.closeAllConnections?.();
  server?.close();
  if (chrome) await chrome.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- the board every test starts from ----
// Needs you: an ask. Working: a pending card an active chat session holds.
// Up next: two cards. Done: one card. All unassigned (Everything scope).
const TITLES = {
  ask: "Pick a paint color",
  held: "Sort the receipts",
  next: "Draft the invite",
  next2: "Book the room",
  done: "Mail the forms",
};
let ids = {};

function seed() {
  const tk = new Database(TASKS);
  tk.exec("DELETE FROM board_mutations; DELETE FROM board_results; DELETE FROM tasks_items;");
  const add = tk.prepare("INSERT INTO tasks_items (title, status, priority, action_needed) VALUES (?, ?, ?, ?)");
  ids = {
    ask: Number(add.run(TITLES.ask, "pending", 1, "Which color: sage or sand?").lastInsertRowid),
    held: Number(add.run(TITLES.held, "in_progress", 1, null).lastInsertRowid),
    next: Number(add.run(TITLES.next, "pending", 1, null).lastInsertRowid),
    next2: Number(add.run(TITLES.next2, "pending", 2, null).lastInsertRowid),
    done: Number(add.run(TITLES.done, "done", 1, null).lastInsertRowid),
  };
  tk.close();
  const c = new Database(DB_FILE);
  c.exec("DELETE FROM bot_sessions");
  c.prepare("INSERT INTO bot_sessions (bot_id, kind, status, card_id) VALUES ('helper', 'chat', 'active', ?)").run(ids.held);
  c.close();
}
beforeEach(seed);

function statusOf(id) {
  const tk = new Database(TASKS);
  try { return tk.prepare("SELECT status FROM tasks_items WHERE id=?").get(id).status; } finally { tk.close(); }
}
function moveRows(id) {
  const tk = new Database(TASKS);
  try { return tk.prepare("SELECT COUNT(*) AS n FROM board_mutations WHERE item_id=? AND verb='move'").get(id).n; } finally { tk.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY = "!!window.Turbo && document.readyState === 'complete' && !!document.querySelector('[data-sb-board]') && !document.documentElement.hasAttribute('aria-busy')";
const TWO_FRAMES = "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})";

/** A tab at a viewport, logged in to the new shell, sending Serve's headers. */
async function open(path, { width = 390, height = 844 } = {}) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const events = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const ev = async (expression) => {
    const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error("page threw: " + JSON.stringify(o.exceptionDetails));
    return o.result.value;
  };
  const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.method) events.push(m);
    if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  const until = async (expression, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await ev(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) {
        let where = "";
        try { where = await ev("location.href"); } catch {}
        throw new Error("timed out waiting for " + what + " (" + expression + ") at " + where + (errors.length ? "; page errors: " + errors.slice(-5).join(" | ") : ""));
      }
      await sleep(60);
    }
  };
  /** The first CDP event named `method` that arrives after `from` (an events index). */
  const nextEvent = async (method, from, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      const e = events.slice(from).find((m) => m.method === method);
      if (e) return e.params;
      if (Date.now() > end) return null;
      await sleep(30);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.clearBrowserCookies");
  await send("Network.setExtraHTTPHeaders", { headers: serveHeaders("operator@example.com") });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  // The browser starts as a desktop with a mouse (see before()); the phone is a touch screen.
  if (width < 900) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  for (const ck of [{ name: "crow_session", value: "new-sess" }, { name: "crow_csrf", value: "tok" }]) {
    await send("Network.setCookie", { ...ck, url: base, path: "/" });
  }
  await send("Page.navigate", { url: base + path });
  await until(READY, "the board");
  await ev(TWO_FRAMES);
  const center = async (sel) => ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; var b=e.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2}; })()`);
  const click = async (sel) => {
    const p = await center(sel);
    assert.ok(p, "no element " + sel);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
  };
  const settled = async () => { await until(READY, "the board to settle"); await ev(TWO_FRAMES); };
  return { send, ev, until, click, center, settled, events, nextEvent, errors,
    close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); } };
}

const NO_H_SCROLL = "({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, vw: window.innerWidth })";
/** The page (document.scrollingElement) and the lanes box, sideways. */
const NO_H_SCROLL_ALL = "(function(){ var l=document.querySelector('.sb-lanes'); return { sw: document.scrollingElement.scrollWidth, vw: window.innerWidth, lanesSw: l.scrollWidth, lanesCw: l.clientWidth }; })()";
/** {count, bad}: the visible elements matching `sel`, and those under 44 px tall as "class:text:w×h". */
const small = (sel) => `(function(){ var bad=[], count=0, hs=[];
  document.querySelectorAll(${JSON.stringify(sel)}).forEach(function(el){
    var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return;
    var r=el.getBoundingClientRect(); if(!r.width&&!r.height) return;
    count++; hs.push(Math.round(r.height));
    if(r.width<44||r.height<44) bad.push((el.className||el.tagName)+':'+(el.textContent||'').trim().slice(0,24)+':'+Math.round(r.width)+'x'+Math.round(r.height));
  }); return { count: count, bad: bad, minH: hs.length ? Math.min.apply(null, hs) : null }; })()`;
/** Every group must really be on the page (a selector matching nothing proves nothing) and be ≥ 44. */
async function assertTargets(p, groups, tag) {
  const seen = {};
  for (const [sel, min, what] of groups) {
    const r = await p.ev(small(sel));
    assert.ok(r.count >= min, `${what}: found ${r.count} visible, expected at least ${min} (${tag})`);
    assert.deepEqual(r.bad, [], `${what} ≥ 44 (${tag})`);
    seen[what] = { count: r.count, minH: r.minH };
  }
  return seen;
}
/** Report measured values (the task report reads them from the test output). */
const note = (ctx, what, v) => ctx.diagnostic(`${what}: ${JSON.stringify(v)}`);

/** The lanes that are really on screen (rendered, with a box), by data-lane. */
const VISIBLE_LANES = `[].filter.call(document.querySelectorAll('.sb-lane'), function(l){ var r=l.getBoundingClientRect(); return getComputedStyle(l).display!=='none' && r.width>0 && r.height>0; }).map(function(l){ return l.getAttribute('data-lane'); })`;
/**
 * Tap a lane's chip, then wait until that lane is the one lane on screen;
 * returns its box.
 */
async function chipToLane(p, lane) {
  await p.click(`.sb-chip[data-lane=${lane}]`);
  await p.until(`(function(){ var v=${VISIBLE_LANES}; return v.length===1 && v[0]===${JSON.stringify(lane)}; })()`, `only the ${lane} lane on screen`);
  await p.ev(TWO_FRAMES);
  return p.ev(`(function(){ var r=document.getElementById('sb-lane-${lane}').getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; })()`);
}
const inLane = (lane, id) => `!!document.querySelector('#sb-lane-${lane} .sb-card[data-card="${id}"]')`;
const LANE_BOXES = `(function(){ return [].map.call(document.querySelectorAll('.sb-lane'), function(l){ var r=l.getBoundingClientRect(); return { lane: l.getAttribute('data-lane'), left: r.left, right: r.right, top: r.top, width: r.width }; }); })()`;
const GUTTER = `(function(){ var b=document.querySelector('.content-body'), cs=getComputedStyle(b); return b.getBoundingClientRect().left + parseFloat(cs.paddingLeft); })()`;

for (const lang of ["en", "es"]) {
  test(`390×844 ${lang}: one lane at a time, chosen by its chip, no sideways scroll, 44 px targets`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    await setLang(lang);
    const p = await open("/dashboard/board");
    try {
      assert.equal(await p.ev("document.documentElement.lang"), lang);
      assert.equal(await p.ev("document.body.classList.contains('shell')"), true, "the new shell");
      assert.equal(await p.ev("document.querySelector('.sb-chip[data-lane=done] .sb-chip-label').textContent"), t("shell.laneDone", lang));
      // The web font changes text widths: measure after it is in.
      await p.ev("document.fonts.ready.then(function(){ return 1; })");
      await p.ev(TWO_FRAMES);

      // one lane on screen at a time: Needs you to start with, its chip selected
      const vw = await p.ev("innerWidth");
      assert.deepEqual(await p.ev(VISIBLE_LANES), ["needs_you"], "only the Needs you lane is on screen");
      assert.equal(await p.ev("document.querySelector('.sb-chip[data-lane=needs_you]').getAttribute('aria-selected')"), "true");
      const gutter = await p.ev(GUTTER);

      // Each chip brings its lane, alone, to the column: no peeking, no sideways scroll.
      const cards = { needs_you: 1, working: 1, up_next: 2, done: 1 };
      for (const lane of ["working", "up_next", "done", "needs_you"]) {
        const box = await chipToLane(p, lane);
        note(ctx, `${lang} phone ${lane}`, { vw, gutter, box });
        assert.deepEqual(await p.ev(VISIBLE_LANES), [lane], `only the ${lane} lane is on screen`);
        assert.ok(Math.abs(box.left - gutter) <= 1, `the ${lane} lane's left ${box.left} is at the gutter ${gutter}`);
        assert.ok(box.right <= vw - gutter + 1, `the ${lane} lane fits the column (${box.right} ≤ ${vw - gutter})`);
        assert.equal(await p.ev(`document.querySelector('.sb-chip[data-lane=${lane}]').getAttribute('aria-selected')`), "true", `the ${lane} chip is selected`);
        const s = await p.ev(NO_H_SCROLL_ALL);
        assert.ok(s.sw <= s.vw, `no page scroll sideways on ${lane} (scrollingElement ${s.sw} ≤ innerWidth ${s.vw})`);
        assert.ok(s.lanesSw <= s.lanesCw, `the lanes box does not scroll sideways on ${lane} (${s.lanesSw} ≤ ${s.lanesCw})`);
        // chips, card faces and Move buttons are at least 44 px tall
        const seen = await assertTargets(p, [
          [".sb-chip", 4, "lane chips"],
          [".sb-card .bb-card", cards[lane], "card faces"],
          [".sb-move", cards[lane], "Move buttons"],
          [".sb-details", cards[lane], "Details links"],
        ], `${lang} phone ${lane}`);
        note(ctx, `${lang} phone ${lane} targets`, seen);
      }
      // A touch screen gets the Move sheet, not drag.
      assert.equal(await p.ev("document.querySelectorAll('.sb-card[draggable=true]').length"), 0, "no draggable cards on a touch screen");
      assert.deepEqual(p.errors, [], "no page errors");
    } finally { await p.close(); await setLang("en"); }
  });

  test(`390×844 ${lang}: Move on the phone — Working is disabled with its reason, and Done moves the card`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    await setLang(lang);
    const p = await open("/dashboard/board");
    try {
      assert.ok(await p.ev(inLane("up_next", ids.next)), "the card starts in Up next");
      // Bring Up next into view the way a person does: its chip.
      const gutter = await p.ev(GUTTER);
      const up = await chipToLane(p, "up_next");
      assert.ok(Math.abs(up.left - gutter) <= 1, `the Up next lane's left ${up.left} is at the gutter`);
      await p.click(`.sb-card[data-card="${ids.next}"] .sb-move`);
      await p.until("document.querySelector('[data-sb-sheet]').open", "the Move sheet");
      await p.ev(TWO_FRAMES);
      const sheet = await p.ev(`(function(){ var d=document.querySelector('[data-sb-sheet]'), r=d.getBoundingClientRect();
        function lane(to){ var b=d.querySelector('.sb-sheet-lane[data-to='+to+']'); return { disabled: b.getAttribute('aria-disabled'), current: b.getAttribute('aria-current'), sub: b.querySelector('.sb-sheet-sub').textContent, h: b.getBoundingClientRect().height }; }
        return { modal: d.matches(':modal'), box: { l: r.left, r: r.right, t: r.top, b: r.bottom }, card: d.querySelector('[data-sb-sheet-card]').textContent,
          working: lane('working'), needs_you: lane('needs_you'), up_next: lane('up_next'), done: lane('done'), focus: document.activeElement && document.activeElement.getAttribute('data-to') }; })()`);
      note(ctx, `${lang} phone sheet`, sheet);
      assert.equal(sheet.modal, true);
      assert.ok(sheet.box.l >= 0 && sheet.box.r <= 390 && sheet.box.t >= 0 && sheet.box.b <= 844 + 0.5, `the sheet is on screen ${JSON.stringify(sheet.box)}`);
      assert.match(sheet.card, new RegExp("#" + ids.next + " " + TITLES.next));
      assert.equal(sheet.working.disabled, "true", "Working is disabled");
      assert.equal(sheet.working.sub, t("shell.refuseWorking", lang), "with its reason");
      assert.equal(sheet.needs_you.disabled, "true");
      assert.equal(sheet.up_next.current, "true", "Up next is where it is");
      assert.equal(sheet.up_next.sub, t("shell.moveHere", lang));
      assert.equal(sheet.done.disabled, null, "Done is allowed");
      assert.equal(sheet.done.sub, "");
      assert.equal(sheet.focus, "done", "focus is on the first allowed lane");
      await assertTargets(p, [[".sb-sheet-lane", 4, "sheet lanes"], [".sb-sheet-cancel", 1, "sheet cancel"]], `${lang} sheet`);
      const s = await p.ev(NO_H_SCROLL);
      assert.ok(s.sw <= s.vw, "no sideways scroll with the sheet open");

      // A disabled lane does nothing.
      await p.click(".sb-sheet-lane[data-to=working]");
      await p.ev(TWO_FRAMES);
      assert.equal(await p.ev("document.querySelector('[data-sb-sheet]').open"), true, "a tap on Working leaves the sheet open");
      assert.equal(statusOf(ids.next), "pending");

      // Done re-renders with the card in Done.
      await p.click(".sb-sheet-lane[data-to=done]");
      await p.until(inLane("done", ids.next), "the card in Done");
      await p.settled();
      assert.equal(await p.ev(inLane("up_next", ids.next)), false, "and no longer in Up next");
      assert.equal(await p.ev("document.querySelector('.sb-chip[data-lane=done] .sb-chip-count').textContent"), "2", "the Done chip counts it");
      assert.equal(await p.ev("document.querySelector('.sb-chip[data-lane=up_next] .sb-chip-count').textContent"), "1");
      assert.equal(statusOf(ids.next), "done");
      assert.equal(moveRows(ids.next), 1, "one real move");
      assert.deepEqual(p.errors, [], "no page errors");
    } finally { await p.close(); await setLang("en"); }
  });

  test(`1280×800 ${lang}: four lanes side by side, no sideways scroll, 44 px targets`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    await setLang(lang);
    const p = await open("/dashboard/board", { width: 1280, height: 800 });
    try {
      assert.equal(await p.ev("document.documentElement.lang"), lang);
      const lanes = await p.ev(LANE_BOXES);
      const vw = await p.ev("innerWidth");
      note(ctx, `${lang} desktop lanes`, { vw, lanes });
      assert.equal(lanes.length, 4);
      for (let i = 0; i < 4; i++) {
        assert.ok(Math.abs(lanes[i].top - lanes[0].top) < 1, `lane ${lanes[i].lane} on the same row (${lanes[i].top} vs ${lanes[0].top})`);
        assert.ok(lanes[i].right <= vw, `lane ${lanes[i].lane} on screen (${lanes[i].right} ≤ ${vw})`);
        assert.ok(lanes[i].width >= 160, `lane ${lanes[i].lane} is a real column (${lanes[i].width})`);
        if (i) assert.ok(lanes[i].left >= lanes[i - 1].right, `lane ${lanes[i].lane} sits right of ${lanes[i - 1].lane}`);
      }
      assert.equal(await p.ev("getComputedStyle(document.querySelector('.sb-chips')).display"), "none", "no chips on the desktop: each heading carries its count");
      const s = await p.ev(NO_H_SCROLL);
      note(ctx, `${lang} desktop scroll`, s);
      assert.ok(s.sw <= s.vw, `scrollWidth ${s.sw} ≤ innerWidth ${s.vw}`);
      const lanesBox = await p.ev("(function(){ var b=document.querySelector('.sb-lanes'); return { sw: b.scrollWidth, cw: b.clientWidth }; })()");
      assert.ok(lanesBox.sw <= lanesBox.cw, `the lanes do not scroll sideways either (${lanesBox.sw} ≤ ${lanesBox.cw})`);
      const seen = await assertTargets(p, [
        [".sb-card .bb-card", 5, "card faces"],
        [".sb-move", 5, "Move buttons"],
        [".sb-details", 5, "Details links"],
      ], `${lang} desktop`);
      note(ctx, `${lang} desktop targets`, seen);
      assert.equal(await p.ev("document.querySelectorAll('.sb-card[draggable=true]').length"), 5, "cards are draggable on a fine pointer");
      assert.deepEqual(p.errors, [], "no page errors");
    } finally { await p.close(); await setLang("en"); }
  });

  test(`1280×800 ${lang}: drag on the desktop — Up next onto Done moves the card; onto Working it stays, with the refusal`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    await setLang(lang);
    const p = await open("/dashboard/board", { width: 1280, height: 800 });
    try {
      assert.ok(await p.ev(inLane("up_next", ids.next)));
      // Headless Chrome has no OS drag loop: Input.setInterceptDrags makes the
      // browser hand the started drag (after the page's own dragstart) back
      // over CDP as Input.dragIntercepted, and Input.dispatchDragEvent then
      // plays dragEnter / dragOver / drop at the target with that data.
      await p.send("Input.setInterceptDrags", { enabled: true });
      const drag = async (cardSel, laneSel, kind) => {
        const from = await p.center(cardSel + " .bb-card-title, " + cardSel + " .bb-card");
        const to = await p.center(laneSel);
        assert.ok(from && to);
        const mark = p.events.length;
        await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
        await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
        for (let i = 1; i <= 5; i++) {
          await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (to.x - from.x) * i / 10, y: from.y + (to.y - from.y) * i / 10, button: "left", buttons: 1 });
        }
        const got = await p.nextEvent("Input.dragIntercepted", mark);
        assert.ok(got, "the browser started a drag from the card");
        const data = got.data;
        assert.equal(await p.ev("!!document.querySelector('.sb-card.sb-dragging')"), true, "the page's dragstart ran");
        await p.send("Input.dispatchDragEvent", { type: "dragEnter", x: to.x, y: to.y, data });
        await p.send("Input.dispatchDragEvent", { type: "dragOver", x: to.x, y: to.y, data });
        const during = await p.ev(`(function(){ var l=document.querySelector(${JSON.stringify(laneSel)}), h=l.querySelector('[data-drop-hint]');
          return { disabled: l.getAttribute('aria-disabled'), over: l.classList.contains('sb-drop-over'), hint: h.hidden ? null : h.textContent }; })()`);
        note(ctx, `${lang} drag ${kind} (during)`, during);
        await p.send("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
        await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
        return during;
      };

      // Onto Working: refused, the reason shows, nothing moves.
      const refused = await drag(`.sb-card[data-card="${ids.next}"]`, "#sb-lane-working", "onto Working");
      assert.equal(refused.disabled, "true", "Working is disabled for this drag");
      assert.equal(refused.over, false, "Working never lights up as a drop target");
      assert.equal(refused.hint, t("shell.refuseWorking", lang), "the refusal is shown on the lane");
      await p.ev(TWO_FRAMES);
      await sleep(300); // a wrong move would POST and re-render; give it the chance to (negative check)
      assert.equal(await p.ev(inLane("up_next", ids.next)), true, "the card stays in Up next");
      assert.equal(await p.ev(inLane("working", ids.next)), false);
      assert.equal(statusOf(ids.next), "pending");
      assert.equal(moveRows(ids.next), 0, "no move was written");
      assert.equal(await p.ev("document.querySelectorAll('.sb-lane[aria-disabled], .sb-drop-over, .sb-dragging').length"), 0, "the drag state is cleared");

      // Onto Done: the card moves.
      const ok = await drag(`.sb-card[data-card="${ids.next}"]`, "#sb-lane-done", "onto Done");
      assert.equal(ok.disabled, null);
      assert.equal(ok.over, true, "Done lights up as the drop target");
      await p.until(inLane("done", ids.next), "the card in Done");
      await p.settled();
      assert.equal(await p.ev(inLane("up_next", ids.next)), false);
      assert.equal(await p.ev("document.querySelector('#sb-lane-done .sb-lane-count').textContent"), "2");
      assert.equal(statusOf(ids.next), "done");
      assert.equal(moveRows(ids.next), 1, "one real move");
      const s = await p.ev(NO_H_SCROLL);
      assert.ok(s.sw <= s.vw);
      assert.deepEqual(p.errors, [], "no page errors");
    } finally { await p.close(); await setLang("en"); }
  });

  test(`390×844 ${lang}: a failed result dropped on Done asks first — No leaves it, Yes accepts and closes it`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    await setLang(lang);
    const tk = new Database(TASKS);
    const fid = Number(tk.prepare("INSERT INTO tasks_items (title, status, priority) VALUES ('Check the totals', 'pending', 0)").run().lastInsertRowid);
    const rid = Number(tk.prepare("INSERT INTO board_results (item_id, actor_kind, actor_id, outcome, summary_md, status) VALUES (?, 'bot', 'helper', 'failure', 'The totals did not add up.', 'recorded')").run(fid).lastInsertRowid);
    tk.close();
    const resultStatus = () => { const d = new Database(TASKS); try { return d.prepare("SELECT status FROM board_results WHERE id=?").get(rid).status; } finally { d.close(); } };
    const p = await open("/dashboard/board");
    try {
      assert.ok(await p.ev(inLane("needs_you", fid)), "the failed card needs you");
      const toDone = async () => {
        await p.click(`.sb-card[data-card="${fid}"] .sb-move`);
        await p.until("document.querySelector('[data-sb-sheet]').open", "the Move sheet");
        await p.ev(TWO_FRAMES);
        assert.equal(await p.ev("document.querySelector('.sb-sheet-lane[data-to=done]').getAttribute('aria-disabled')"), null, "Done is offered");
        await p.click(".sb-sheet-lane[data-to=done]");
        await p.until("document.querySelector('[data-sb-confirm]').open", "the confirm dialog");
        await p.ev(TWO_FRAMES);
      };
      await toDone();
      const dlg = await p.ev(`(function(){ var d=document.querySelector('[data-sb-confirm]'), r=d.getBoundingClientRect();
        return { modal: d.matches(':modal'), text: d.querySelector('[data-sb-confirm-text]').textContent, sheetOpen: document.querySelector('[data-sb-sheet]').open,
          box: { l: r.left, r: r.right, t: r.top, b: r.bottom }, focus: document.activeElement && document.activeElement.hasAttribute('data-sb-confirm-no') }; })()`);
      note(ctx, `${lang} confirm dialog`, dlg);
      assert.equal(dlg.modal, true, "an in-page modal dialog");
      assert.equal(dlg.sheetOpen, false, "the Move sheet is closed under it");
      assert.equal(dlg.text, t("shell.confirmNotFullSuccess", lang));
      assert.equal(dlg.text, { en: "This result isn't a full success. Accept it and close the card?", es: "Este resultado no es un éxito completo. ¿Aceptarlo y cerrar la tarjeta?" }[lang], "Ruling P16's wording");
      assert.equal(dlg.focus, true, "focus starts on No (the safe choice)");
      assert.ok(dlg.box.l >= 0 && dlg.box.r <= 390 && dlg.box.t >= 0 && dlg.box.b <= 844 + 0.5, "on screen");
      await assertTargets(p, [["[data-sb-confirm-yes]", 1, "confirm Yes"], ["[data-sb-confirm-no]", 1, "confirm No"]], `${lang} confirm`);
      assert.equal(resultStatus(), "recorded", "nothing is accepted before Yes");

      // No: the card stays where it was.
      await p.click("[data-sb-confirm-no]");
      await p.until("!document.querySelector('[data-sb-confirm]').open", "the confirm dialog to close");
      await p.ev(TWO_FRAMES);
      assert.equal(await p.ev(inLane("needs_you", fid)), true, "No leaves the card in Needs you");
      assert.equal(statusOf(fid), "pending");
      assert.equal(resultStatus(), "recorded");
      assert.equal(moveRows(fid), 0);

      // Yes: accepted and closed.
      await toDone();
      await p.click("[data-sb-confirm-yes]");
      await p.until(inLane("done", fid), "the card in Done");
      await p.settled();
      assert.equal(statusOf(fid), "done");
      assert.equal(resultStatus(), "approved");
      assert.equal(moveRows(fid), 1, "one real move");
      assert.deepEqual(p.errors, [], "no page errors");
    } finally { await p.close(); await setLang("en"); }
  });
}

test("1280×800: Details opens the card's drawer on its bot's board, with the card's results", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const { createDbClient } = await import("../servers/db.js");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const db = createDbClient();
  let pid;
  try {
    const have = (await db.execute({ sql: "SELECT id FROM project_spaces WHERE name='Venues' AND archived_at IS NULL", args: [] })).rows[0];
    pid = have ? Number(have.id) : (await createProjectSpace(db, { name: "Venues" })).id;
    await db.execute({
      sql: "INSERT OR IGNORE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('scout', 'Scout', ?, 1, ?)",
      args: [JSON.stringify({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }), pid],
    });
  } finally { db.close(); }
  const tk = new Database(TASKS);
  const cid = Number(tk.prepare("INSERT INTO tasks_items (title, status, priority, project_id) VALUES ('Find a venue', 'pending', 1, ?)").run(pid).lastInsertRowid);
  tk.prepare("INSERT INTO board_results (item_id, actor_kind, actor_id, outcome, summary_md, status) VALUES (?, 'bot', 'scout', 'success', 'Three venues are free that night.', 'recorded')").run(cid);
  tk.close();
  const p = await open("/dashboard/board", { width: 1280, height: 800 });
  try {
    const href = await p.ev(`document.querySelector('.sb-card[data-card="${cid}"] .sb-details').getAttribute('href')`);
    assert.equal(href, `/dashboard/bot-board?bot=scout#open=${cid}`);
    await p.click(`.sb-card[data-card="${cid}"] .sb-details`);
    await p.until("!!document.querySelector('#bb-drawer.bb-open')", "the card drawer");
    await p.until(`(document.getElementById('bb-d-title').textContent||'').indexOf('${cid}')>=0`, "the drawer on this card");
    await p.until("(document.getElementById('bb-d-result-wrap').textContent||'').indexOf('Three venues are free that night.')>=0", "the card's results in the drawer");
    assert.equal(await p.ev("location.pathname + location.search"), "/dashboard/bot-board?bot=scout");
    assert.equal(await p.ev("location.hash.indexOf('open=')"), -1, "the one-shot open key leaves the URL");
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { await p.close(); }
});

// R1 follow-ups Task 2: the classic drawer's status select comes from the
// CARD's own board def, not the page bot's. A card from a custom-def project
// opened via #open on a builtin-def bot's board lists its own statuses (no
// "(off-board)" option), a face on that board still gets the board's own
// four, and saving one of the card's own statuses works.
test("1280×800: a card from a custom-def project, opened on another bot's board, lists and saves its own statuses", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const { createDbClient } = await import("../servers/db.js");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const db = createDbClient();
  let venues, shipyard;
  try {
    const find = async (name) => {
      const have = (await db.execute({ sql: "SELECT id FROM project_spaces WHERE name=? AND archived_at IS NULL", args: [name] })).rows[0];
      return have ? Number(have.id) : (await createProjectSpace(db, { name })).id;
    };
    venues = await find("Venues");
    shipyard = await find("Shipyard");
    await db.execute({
      sql: "INSERT OR IGNORE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('scout', 'Scout', ?, 1, ?)",
      args: [JSON.stringify({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }), venues],
    });
  } finally { db.close(); }
  const tk = new Database(TASKS);
  tk.prepare("INSERT OR IGNORE INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (?, 'Shipyard', ?, ?, '[]')")
    .run(shipyard, JSON.stringify(["todo", "doing", "shipped", "dropped"]), JSON.stringify(["shipped", "dropped"]));
  const own = Number(tk.prepare("INSERT INTO tasks_items (title, status, priority, project_id) VALUES ('Paint the hull', 'todo', 1, ?)").run(shipyard).lastInsertRowid);
  const face = Number(tk.prepare("INSERT INTO tasks_items (title, status, priority, project_id) VALUES ('Find a venue', 'pending', 1, ?)").run(venues).lastInsertRowid);
  tk.close();
  const OPTS = "JSON.stringify([].map.call(document.getElementById('bb-d-status').options,function(o){return [o.value,o.textContent];}))";
  const opts = (pairs) => JSON.stringify(pairs);
  const ownOpts = opts([["todo", "todo"], ["doing", "doing"], ["shipped", "shipped"], ["dropped", "dropped"]]);
  const pageOpts = opts([["pending", t("botboard.statusPending", "en")], ["in_progress", t("botboard.statusInProgress", "en")],
    ["done", t("botboard.statusDone", "en")], ["cancelled", t("botboard.statusCancelled", "en")]]);
  const drawerOn = async (p, id) => {
    await p.until("!!document.querySelector('#bb-drawer.bb-open')", "the card drawer");
    await p.until(`(document.getElementById('bb-d-title').textContent||'').indexOf('${id}')>=0`, "the drawer on card " + id);
  };
  const p = await open("/dashboard/board", { width: 1280, height: 800 });
  try {
    await p.send("Page.navigate", { url: base + `/dashboard/bot-board?bot=scout#open=${own}` });
    await drawerOn(p, own);
    await p.until(`${OPTS}===${JSON.stringify(ownOpts)}`, "the card's own statuses in the select");
    assert.equal(await p.ev("document.getElementById('bb-d-status').value"), "todo");

    // A face on this board: the board's own four again, labelled as the board labels them.
    await p.ev(`document.querySelector('.bb-card[data-card="${face}"]').click()`);
    await drawerOn(p, face);
    await p.until(`${OPTS}===${JSON.stringify(pageOpts)}`, "the board's statuses for a card on this board");
    assert.equal(await p.ev("document.getElementById('bb-d-status').value"), "pending");

    // Back to the custom-def card, and save one of its own statuses.
    await p.send("Page.navigate", { url: "about:blank" });
    await p.send("Page.navigate", { url: base + `/dashboard/bot-board?bot=scout#open=${own}` });
    await drawerOn(p, own);
    await p.until(`${OPTS}===${JSON.stringify(ownOpts)}`, "the card's own statuses again");
    await p.ev("document.getElementById('bb-d-status').value='doing'");
    // The drawer scrolls; press Save the way a keyboard user does.
    await p.ev("document.getElementById('bb-d-save').click()");
    const end = Date.now() + 10000;
    while (statusOf(own) !== "doing" && Date.now() < end) await sleep(60);
    assert.equal(statusOf(own), "doing", "the card's own status saved (drawer said: " + (await p.ev("document.getElementById('bb-d-msg').textContent").catch(() => "?")) + ")");
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { await p.close(); }
});
