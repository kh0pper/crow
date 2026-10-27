/**
 * Redesign P3, Task 3.2 — the Board tab's panel (/dashboard/board): the
 * current shell scope's cards in four lanes, a tap from each card's
 * conversation, with a Details link into the classic card view.
 *
 * Harness: an init-db'd scratch crow.db (CROW_DATA_DIR, never the operator's
 * ~/.crow) and a scratch tasks.db brought through migrations 0001–0004 by the
 * runner (0001–0003 marked done over a hand-seeded post-0003 shape, the
 * board-archive.test.js idiom). The panel handler is called directly with a
 * layout stub that records its options; the scope is set the way the
 * dashboard dispatch sets it, through the shell's own resolveScope rule.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "shell-board-panel-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;

const REPO = new URL("..", import.meta.url).pathname;
const TASKS = process.env.CROW_TASKS_DB_PATH;

let db, panel, botBoard, laneCounts, resolveScope, t;
let P1, P2, P3, P4, slug1, slug2;
const ids = {};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });

  // tasks.db: the perch-interactive-routes fixture shape + board_defs, then
  // migrations 0001–0004 (0004 adds board_plans / board_results).
  const tk = new Database(TASKS);
  tk.exec(`CREATE TABLE IF NOT EXISTS tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT,
    parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT,
    action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated',
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    data_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  tk.close();
  {
    const c = new Database(join(dir, "crow.db"));
    c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
    for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
      c.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
    }
    c.close();
  }
  const migDir = join(dir, "migrations");
  mkdirSync(migDir);
  for (const f of ["0001-board-stages.mjs", "0002-board-defs.mjs", "0003-tracker-convergence.mjs", "0004-track1-card-model.mjs"]) {
    symlinkSync(join(REPO, "scripts", "migrations", f), join(migDir, f));
  }
  const { runMigrations } = await import("../scripts/migrations/runner.mjs");
  await runMigrations({ migrationsDir: migDir, dbPath: join(dir, "crow.db"), tasksDbPath: TASKS, sha: "test", log: () => {} });

  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  P1 = (await createProjectSpace(db, { name: "Alpha" })).id;
  P2 = (await createProjectSpace(db, { name: "Beta" })).id;
  P3 = (await createProjectSpace(db, { name: "Gamma" })).id;
  P4 = (await createProjectSpace(db, { name: "Delta" })).id;
  await db.execute({ sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id = ?", args: [P4] });
  const slugOf = async (id) => (await db.execute({ sql: "SELECT slug FROM project_spaces WHERE id=?", args: [id] })).rows[0].slug;
  slug1 = await slugOf(P1);
  slug2 = await slugOf(P2);

  // Cards. Ids are fixed by insertion order; card 5 is in Alpha.
  const tw = new Database(TASKS);
  const ins = tw.prepare("INSERT INTO tasks_items (title, project_id, status, priority, action_needed, assigned_bot) VALUES (?,?,?,?,?,?)");
  const add = (k, title, project, status = "pending", o = {}) => {
    ids[k] = Number(ins.run(title, project, status, o.priority ?? 3, o.action ?? null, o.bot ?? null).lastInsertRowid);
  };
  add("needs", "alpha-needs", P1);                         // 1: a recorded result -> Needs you
  add("held", "alpha-held", P1);                           // 2: an active session holds it -> Working
  add("betaDone", "beta-done", P2, "done");                // 3
  add("loose", "loose-pending", null, "pending", { bot: "hank" }); // 4
  add("five", "alpha-five", P1);                           // 5: has a conversation
  add("six", "alpha-six", P1, "in_progress");              // 6: in progress, nothing holds it -> Up next
  add("looseDone", "loose-done", null, "done");            // 7
  add("betaOpen", "<b>beta-open</b>", P2);                 // 8: bot-written markup in a title
  for (let i = 0; i < 105; i++) add("g" + i, "gamma-" + i, P3, "pending", { priority: 5 });
  tw.prepare("INSERT INTO board_results (item_id, actor_kind, outcome, status) VALUES (?, 'bot', 'success', 'recorded')").run(ids.needs);
  // Not top-level or archived: never on the board.
  tw.prepare("INSERT INTO tasks_items (title, project_id, parent_id) VALUES ('alpha-subtask', ?, 1)").run(P1);
  ids.archivedCard = Number(tw.prepare("INSERT INTO tasks_items (title, project_id, archived_at) VALUES ('alpha-archived', ?, datetime('now'))").run(P1).lastInsertRowid);
  tw.prepare("INSERT INTO tasks_items (title, project_id, board_id) VALUES ('alpha-tracker-item', ?, 3)").run(P1);
  // Cards whose project is no longer live: an archived project, and an id
  // that names no project at all. They count as Unassigned (Chat's rule).
  add("orphanArchived", "orphan-archived", P4, "pending", { action: "check this" });
  add("orphanMissing", "orphan-missing", 9999);
  tw.close();
  assert.equal(ids.five, 5);

  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, card_id, status, kind) VALUES ('hank', ?, 'active', 'chat')", args: [ids.held] });
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, card_id, status, kind, gateway_thread_id) VALUES ('hank', 5, 'waiting-user', 'perch-live', 'perchlive-old')", args: [] });
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, card_id, status, kind, gateway_thread_id) VALUES ('hank', 5, 'waiting-user', 'perch-live', 'perchlive-z')", args: [] });

  // Beta's <b> card: an older live conversation and a newer archived one.
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, card_id, status, kind, gateway_thread_id) VALUES ('aaa', ?, 'waiting-user', 'perch-live', 'perchlive-live')", args: [ids.betaOpen] });
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, card_id, status, kind, gateway_thread_id, archived_at) VALUES ('aaa', ?, 'waiting-user', 'perch-live', 'perchlive-arch', datetime('now'))", args: [ids.betaOpen] });

  // Bots for the classic card view: "aaa" sorts first (and so is the default
  // bot) but is on Beta; hank is on Alpha.
  const addBot = (id, pid) => db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)",
    args: [id, id, JSON.stringify({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }), pid],
  });
  await addBot("aaa", P2);
  await addBot("hank", P1);

  ({ default: panel, laneCounts } = await import("../servers/gateway/dashboard/panels/board.js"));
  ({ default: botBoard } = await import("../servers/gateway/dashboard/panels/bot-board.js"));
  ({ resolveScope } = await import("../servers/gateway/dashboard/shell/request.js"));
  ({ t } = await import("../servers/gateway/dashboard/shared/i18n.js"));
});

after(() => { try { db && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

async function render(query = {}, lang = "en") {
  const req = { method: "GET", query, headers: {} };
  req.crowScope = (await resolveScope(req, db)).scope;
  let opts = null;
  const layout = (o) => { opts = o; return o.content; };
  const res = { redirect() {}, headersSent: false };
  const html = await panel.handler(req, res, { db, layout, lang });
  return { html, opts };
}

function laneHtml(html, lane) {
  const a = html.indexOf(`id="sb-lane-${lane}"`);
  if (a < 0) return "";
  return html.slice(a, html.indexOf("</section>", a));
}

function chipCount(html, lane) {
  const m = html.match(new RegExp(`class="sb-chip"[^>]*data-lane="${lane}"[\\s\\S]*?<span class="sb-chip-count">(\\d+)</span>`));
  return m ? Number(m[1]) : null;
}

test("a project scope shows only its cards", async () => {
  const { html, opts } = await render({ project: slug1 });
  for (const s of ["alpha-needs", "alpha-held", "alpha-five", "alpha-six"]) assert.ok(html.includes(s), s);
  for (const s of ["beta-done", "beta-open", "loose-pending", "loose-done", "gamma-0", "alpha-subtask", "alpha-archived", "alpha-tracker-item"]) {
    assert.ok(!html.includes(s), s + " must not show");
  }
  assert.ok(opts && typeof opts.title === "string" && opts.title, "layout gets a title");
});

test("Unassigned shows project-less cards, Done included", async () => {
  const { html } = await render({ project: "unassigned" });
  assert.ok(html.includes("loose-pending"));
  assert.ok(laneHtml(html, "done").includes("loose-done"), "a finished unassigned card is in Done");
  assert.ok(!html.includes("alpha-") && !html.includes("beta-"));
});

test("Everything shows both projects and the unassigned", async () => {
  const { html } = await render({ project: "all" });
  for (const s of ["alpha-needs", "beta-done", "loose-pending", "loose-done"]) assert.ok(html.includes(s), s);
});

test("a card with a conversation opens it", async () => {
  const { html } = await render({ project: slug1 });
  const m = html.match(/<li class="sb-card" data-card="5">[\s\S]*?<\/li>/);
  assert.ok(m, "card 5 is rendered");
  assert.match(m[0], /class="sb-open" href="\/dashboard\/perch#perchlive-z"/, "the newest perch-live thread");
  assert.match(m[0], /class="sb-details" href="\/dashboard\/bot-board\?card=5"[^>]*>Details</);
});

test("a card without one opens its details", async () => {
  const { html } = await render({ project: slug1 });
  const m = html.match(new RegExp(`<li class="sb-card" data-card="${ids.six}">[\\s\\S]*?</li>`));
  assert.ok(m);
  assert.match(m[0], new RegExp(`class="sb-open" href="/dashboard/bot-board\\?card=${ids.six}"`));
});

test("lane counts are real", async () => {
  const { html } = await render({ project: slug1 });
  assert.deepEqual(["needs_you", "working", "up_next", "done"].map((l) => chipCount(html, l)), [1, 1, 2, 0]);
  assert.ok(laneHtml(html, "needs_you").includes("alpha-needs"), "a recorded result needs you");
  assert.ok(laneHtml(html, "up_next").includes("alpha-six"), "in progress with nothing holding it is up next");
  const { createDbClient } = await import("../servers/db.js");
  const tdb = createDbClient(TASKS);
  try {
    const { lockMapFor } = await import("../servers/gateway/routes/board-lock.js");
    const lockMap = await lockMapFor(db, [1, 2, 5, 6]);
    assert.deepEqual(await laneCounts(tdb, { projectId: P1 }, lockMap), { needs_you: 1, working: 1, up_next: 2, done: 0 });
  } finally { tdb.close(); }
});

test("a locked card shows in Working", async () => {
  const { html } = await render({ project: slug1 });
  assert.ok(laneHtml(html, "working").includes("alpha-held"));
  assert.ok(!laneHtml(html, "up_next").includes("alpha-held"));
});

test("a lane over 100 cards shows 100 and says how many there are", async () => {
  const { html } = await render({ project: String(P3) });
  const up = laneHtml(html, "up_next");
  assert.equal((up.match(/<li class="sb-card"/g) || []).length, 100);
  assert.ok(up.includes("Showing 100 of 105"));
  assert.equal(chipCount(html, "up_next"), 105, "the chip count is not truncated");
});

test("bot-written text is escaped", async () => {
  const { html } = await render({ project: slug2 });
  assert.ok(html.includes("&lt;b&gt;beta-open&lt;/b&gt;"));
  assert.ok(!html.includes("<b>beta-open"));
});

// Task 3.3: every card can be moved from the Board tab; refused lanes say why.
function moveButton(html, id) {
  const li = html.match(new RegExp(`<li class="sb-card" data-card="${id}">[\\s\\S]*?</li>`));
  assert.ok(li, "card " + id + " is rendered");
  const m = li[0].match(/<button type="button" class="sb-move" data-sb-move data-from="([a-z_]+)" data-refuse="([^"]*)"[^>]*>/);
  assert.ok(m, "card " + id + " has a Move button");
  return { li: li[0], from: m[1], refuse: JSON.parse(m[2].replace(/&quot;/g, '"')) };
}

test("each card's Move button carries its lane and the stored-state refusals", async () => {
  const { html } = await render({ project: slug1 });
  const needs = moveButton(html, ids.needs);
  assert.equal(needs.from, "needs_you");
  assert.deepEqual(needs.refuse, { working: "needs_session", up_next: "use_review" }, "Done is open: it accepts the result");
  assert.match(needs.li, /data-result-action="accept"/, "the face's Accept stays on the Board tab");
  assert.match(needs.li, /data-result-action="reject"/);
  const held = moveButton(html, ids.held);
  assert.equal(held.from, "working");
  assert.deepEqual(held.refuse, { needs_you: "needs_reason", up_next: "locked", done: "locked" });
  const six = moveButton(html, ids.six);
  assert.equal(six.from, "up_next");
  assert.deepEqual(six.refuse, { needs_you: "needs_reason", working: "needs_session" });
  assert.match(six.li, />Move<span class="sb-vh"> #\d+ alpha-six<\/span><\/button>/);

  // One sheet, four lanes, and the reasons in the operator's language.
  assert.equal((html.match(/<dialog class="sb-sheet"/g) || []).length, 1);
  for (const l of ["needs_you", "working", "up_next", "done"]) assert.ok(html.includes(`class="sb-sheet-lane" data-to="${l}"`), l);
  const reasons = JSON.parse(html.match(/data-reasons="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
  assert.equal(reasons.use_review, t("shell.refuseReview", "en"));
  assert.equal(reasons.answer_first, t("shell.refuseDecision", "en"));
  assert.equal(reasons.needs_session, t("shell.refuseWorking", "en"));

  // Move is a 44 px target under body.shell; the no-JS move form stays hidden.
  assert.match(html, /body\.shell \.sb-move \{[^}]*min-height: 44px/);
  assert.match(html, /body\.shell \.sb-card \.bb-nojs-move \{ display: none; \}/);
  assert.ok(!/\.bb-result-actions[^{]*\{[^}]*display: none/.test(html), "Accept/Reject are not hidden");
});

test("a card title in the Move button is escaped", async () => {
  const { html } = await render({ project: slug2 });
  assert.ok(html.includes('Move<span class="sb-vh"> #' + ids.betaOpen + " &lt;b&gt;beta-open&lt;/b&gt;</span>"));
});

test("Spanish strings render", async () => {
  const { html } = await render({ project: slug1 }, "es");
  assert.ok(html.includes(t("shell.laneNeedsYou", "es")));
  assert.ok(html.includes(">" + t("shell.cardDetails", "es") + "<"));
});

test("bot-board resolves a card's bot", async () => {
  const layout = (o) => (o.title || "") + "\n" + o.content;
  const res = { redirect() {}, headersSent: false };
  const html = await botBoard.handler({ method: "GET", query: { card: "5" }, headers: {} }, res, { db, layout, lang: "en" });
  assert.ok(html.includes("Card #5"), "the card in hank's project resolves to hank's board");
  const nf = await botBoard.handler({ method: "GET", query: { card: "999" }, headers: {} }, res, { db, layout, lang: "en" });
  assert.ok(nf.includes(t("botboard.cardNotFound", "en")), "an unknown id gives the existing not-found section");
});

test("cards in an archived or missing project are Unassigned, and counted", async () => {
  const un = await render({ project: "unassigned" });
  assert.ok(laneHtml(un.html, "needs_you").includes("orphan-archived"), "a waiting card in an archived project still needs you");
  assert.ok(un.html.includes("orphan-missing"));
  assert.deepEqual(["needs_you", "working", "up_next", "done"].map((l) => chipCount(un.html, l)), [1, 0, 2, 1]);
  const all = await render({ project: "all" });
  for (const s of ["orphan-archived", "orphan-missing", "gamma-0"]) assert.ok(all.html.includes(s), s);
  assert.equal(chipCount(all.html, "needs_you"), 2);
  const { createDbClient } = await import("../servers/db.js");
  const { activeProjects } = await import("../servers/shared/shell-items.js");
  const { lockMapFor } = await import("../servers/gateway/routes/board-lock.js");
  const tdb = createDbClient(TASKS);
  try {
    const activeIds = (await activeProjects(db)).map((p) => p.id);
    assert.ok(!activeIds.includes(P4), "the archived project is not live");
    const lockMap = await lockMapFor(db, [ids.loose, ids.looseDone, ids.orphanArchived, ids.orphanMissing]);
    assert.deepEqual(await laneCounts(tdb, { unassigned: true }, lockMap, { activeIds }), { needs_you: 1, working: 0, up_next: 2, done: 1 });
  } finally { tdb.close(); }
});

test("a live conversation wins over a newer archived one", async () => {
  const { html } = await render({ project: slug2 });
  const m = html.match(new RegExp(`<li class="sb-card" data-card="${ids.betaOpen}">[\\s\\S]*?</li>`));
  assert.ok(m);
  assert.match(m[0], /class="sb-open" href="\/dashboard\/perch#perchlive-live"/);
});

test("a card no bot's board holds still opens its full card view", async () => {
  const layout = (o) => (o.title || "") + "\n" + o.content;
  const res = { redirect() {}, headersSent: false };
  const view = (card) => botBoard.handler({ method: "GET", query: { card: String(card) }, headers: {} }, res, { db, layout, lang: "en" });
  for (const [k, title] of [["loose", "loose-pending"], ["looseDone", "loose-done"], ["g0", "gamma-0"], ["orphanArchived", "orphan-archived"], ["orphanMissing", "orphan-missing"]]) {
    const html = await view(ids[k]);
    assert.ok(html.includes(`Card #${ids[k]}`), k + " renders its card view");
    assert.ok(html.includes(title), k + " shows its title");
    assert.ok(html.includes(t("botboard.planFileHeading", "en")), k + " shows its plan section");
    assert.ok(!html.includes(t("botboard.cardNotFound", "en")), k);
  }
  // With a bot named whose project doesn't hold the card: still the card.
  const viaBot = await botBoard.handler({ method: "GET", query: { bot: "hank", card: String(ids.g0) }, headers: {} }, res, { db, layout, lang: "en" });
  assert.ok(viaBot.includes(`Card #${ids.g0}`));
  // An archived card and a subtask id are not found.
  const arch = await view(ids.archivedCard);
  assert.ok(arch.includes(t("botboard.cardNotFound", "en")));
});

test("no tasks.db: an empty board, not an error", async () => {
  const moved = TASKS + ".away";
  renameSync(TASKS, moved);
  try {
    const { html } = await render({ project: slug1 });
    assert.ok(html.includes(t("shell.boardEmpty", "en")));
    assert.ok(html.includes('href="/dashboard/perch"'), "the empty board links to Chat");
    assert.ok(!existsSync(TASKS), "rendering never creates a tasks.db");
  } finally {
    renameSync(moved, TASKS);
  }
});
