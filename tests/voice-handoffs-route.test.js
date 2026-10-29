/**
 * The phone confirm page (voice hand-off PR 4, Task 4.2): GET /dashboard/voice/handoffs/:id shows a kiosk's
 * hand-off, POST …/decide confirms or declines it through core.confirm(…, "phone"). A real express app with the
 * real csrfMiddleware behind a session stub (the dashboard's own order: auth, then CSRF, then the router), a
 * scratch init-db'd crow.db plus a tasks.db per test, the real store, give-service and voice-bot loader, a
 * fake engine, and a fake clock shared by the store and the core.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";

const root = mkdtempSync(join(tmpdir(), "vh-route-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = { crow: join(root, "master", "crow.db"), tasks: join(root, "master", "tasks.db") };

const { default: express } = await import("express");
const { createDbClient } = await import("../servers/db.js");
const { _setEngineStatusForTest: setStatus } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js");
const { createHandoffCore, phoneConfirmPath } = await import("../servers/gateway/voice/handoff.js");
const { createHandoffStore } = await import("../servers/gateway/voice/handoff-store.js");
const { createSummaryCache } = await import("../servers/gateway/voice/bot-summaries.js");
const { botDefsGeneration } = await import("../servers/gateway/voice/defs-generation.js");
const { createVoiceBotLoader } = await import("../servers/gateway/voice/crow-voice.js");
const { HANDOFF_PHONE_TTL_MS, HANDOFF_START_BUDGET_MS } = await import("../servers/gateway/voice/handoff-constants.js");
const { CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { voiceHandoffsRouter } = await import("../servers/gateway/routes/voice-handoffs.js");

const VOICE = { bot_id: CROW_VOICE_BOT_ID, kind: "voice", display_name: "Crow", fast_voice_model: "crow-voice/qwen3.5-4b", handoff: { enabled: true, allowed_bots: [] } };
const board = (over = {}) => ({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" }, models: { default: "prov/model-a" }, ...over });
const EVIL_NAME = "<img src=x onerror=alert(1)>Helper";
const TASK = "research radio history and write it up";
const ASK = "have writer research radio history and write it up";
const T0 = 1_800_000_000_000;
const OWN = "own-session-token";
const SSO = "sso-session-token";
const CSRF = "csrf-tok-123";
const flush = () => new Promise((r) => setImmediate(r));
function deferred() { let res; const promise = new Promise((a) => { res = a; }); return { promise, res }; }

const open = [];
const servers = [];
after(() => {
  setStatus(null);
  for (const s of servers) s.close();
  for (const c of open) { try { c.close(); } catch {} }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: join(root, "master") }, stdio: "pipe", cwd: REPO });
  const raw = new Database(MASTER.crow);
  const seed = raw.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)");
  seed.run(CROW_VOICE_BOT_ID, "Crow", JSON.stringify(VOICE), null);
  for (const [id, name] of [["writer", "Writer"], ["helper", EVIL_NAME]]) {
    const pid = Number(raw.prepare("INSERT INTO project_spaces (slug, name) VALUES (?,?)").run(id + "-p", id).lastInsertRowid);
    seed.run(id, name, JSON.stringify(board({ description: id + " does things" })), pid);
  }
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const tok = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)");
  tok.run(hashToken(OWN), "dashboard", future);
  tok.run(hashToken(SSO), "dashboard sso src:peer-1", future);
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
  const t = new Database(MASTER.tasks);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.close();
});

function clock(start = T0) {
  let t = start;
  let timers = [];
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    const due = timers.filter((x) => x.at <= t);
    timers = timers.filter((x) => x.at > t);
    for (const x of due) x.res();
  };
  now.wait = (ms) => new Promise((res) => timers.push({ at: t + ms, res }));
  return now;
}

function fakeEngine() {
  const calls = { spawn: [], stop: [] };
  let k = 0;
  const eng = {
    calls, hold: null,
    checkCardFree: async () => {},
    async spawn(args) {
      const sessionId = "s" + (++k);
      calls.spawn.push({ ...args, sessionId });
      if (eng.hold) await eng.hold.promise;
      return { sessionId, threadId: "t-" + sessionId, state: "starting" };
    },
    async message() {},
    watchTurns: () => () => {},
    suppressTurnEndPush: () => false,
    async stop(sid) { calls.stop.push(sid); return { ok: true }; },
  };
  return eng;
}

/** The session stub: a known crow_session cookie is a dashboard session, anything else goes to the login page. */
function stubAuth(req, res, next) {
  const m = /(?:^|;\s*)crow_session=([^;]+)/.exec(req.headers.cookie || "");
  if (m && (m[1] === OWN || m[1] === SSO)) { req.dashboardSession = m[1]; return next(); }
  res.redirect(303, "/dashboard/login");
}

let n = 0;
async function setup({ avail = "up", coreOver = null } = {}) {
  setStatus({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db"), tasks = join(dir, "tasks.db");
  copyFileSync(MASTER.crow, crow);
  copyFileSync(MASTER.tasks, tasks);
  process.env.CROW_TASKS_DB_PATH = tasks;
  const db = createDbClient(crow);
  const tdb = createDbClient(tasks);
  open.push(db, tdb);
  const now = clock();
  const eng = fakeEngine();
  const confirms = [];
  const opened = { n: 0, closed: 0 };
  const core = createHandoffCore({
    store: createHandoffStore({ now }),
    summaries: createSummaryCache({ bus: new EventEmitter(), now }),
    availability: async () => avail,
    loadVoiceDef: createVoiceBotLoader({ generation: botDefsGeneration, now }),
    engine: async () => eng,
    openTasksDb: () => createDbClient(tasks),
    notify: async () => ({ id: 1 }),
    announce: async () => null,
    withDb: (fn) => fn(db),
    wait: now.wait,
    now,
    log: () => {},
  });
  const realConfirm = core.confirm;
  core.confirm = (...a) => { confirms.push(a.slice(1)); return realConfirm(...a); };
  if (coreOver) coreOver(core);
  const openDb = () => {
    opened.n++;
    const c = createDbClient(crow);
    const close = c.close.bind(c);
    c.close = () => { opened.closed++; return close(); };
    return c;
  };
  const app = express();
  // The gateway's own security headers run first (index.js): a CSP whose frame-ancestors allows the companion.
  app.use((req, res, next) => { res.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'self' https://peer.example:*"); next(); });
  app.use("/dashboard", express.urlencoded({ extended: false }));
  app.use("/dashboard", stubAuth);
  app.use("/dashboard", csrfMiddleware);
  app.use(voiceHandoffsRouter(stubAuth, { core, openDb }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(server);
  const base = "http://127.0.0.1:" + server.address().port;

  const insert = (over = {}) => core.store.insert(db, {
    kind: "handoff", surface: "kiosk", device_id: "kiosk-1", device_name: "Kitchen", bot_id: "writer",
    task: TASK, asked: ASK, status: "awaiting_phone", model_key: "prov/model-a", start_now: 1, lang: "en", ...over,
  });
  const get = (id, { session = OWN, lang = null } = {}) => fetch(base + phoneConfirmPath(id), {
    redirect: "manual", headers: { cookie: [session && `crow_session=${session}`, `crow_csrf=${CSRF}`, lang && `crow_lang=${lang}`].filter(Boolean).join("; ") },
  });
  const decide = (id, decision, { session = OWN, csrf = CSRF, body = null } = {}) => {
    const form = body ?? new URLSearchParams({ ...(decision === undefined ? {} : { decision }), ...(csrf ? { _csrf: csrf } : {}) }).toString();
    return fetch(base + phoneConfirmPath(id) + "/decide", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: [session && `crow_session=${session}`, `crow_csrf=${CSRF}`].filter(Boolean).join("; ") },
      body: form,
    });
  };
  const row = (id) => core.store.get(db, id);
  const cards = async () => (await tdb.execute("SELECT * FROM tasks_items ORDER BY id")).rows;
  return { db, core, eng, now, confirms, opened, insert, get, decide, row, cards, base };
}

const hasForm = (html) => /<form\b/.test(html);

test("without a session it redirects to login, and without CSRF the POST is 403", async () => {
  const s = await setup();
  const id = await s.insert();
  const g = await s.get(id, { session: null });
  assert.equal(g.status, 303);
  assert.equal(g.headers.get("location"), "/dashboard/login");
  const p = await s.decide(id, "confirm", { session: null });
  assert.equal(p.status, 303);
  assert.equal(p.headers.get("location"), "/dashboard/login");
  const noCsrf = await s.decide(id, "confirm", { csrf: null });
  assert.equal(noCsrf.status, 403);
  assert.match(await noCsrf.text(), /CSRF/);
  const wrong = await s.decide(id, "confirm", { csrf: "nope" });
  assert.equal(wrong.status, 403);
  assert.deepEqual(s.confirms, []);
  assert.equal((await s.row(id)).status, "awaiting_phone");
  assert.deepEqual(await s.cards(), []);
});

test("the live page shows the bot, display, task, when and asked words, with Confirm and Decline and the CSRF field", async () => {
  const s = await setup();
  const id = await s.insert();
  const r = await s.get(id);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<h1>Hand a task to Writer\?<\/h1>/);
  assert.match(html, /Asked on Kitchen, /);
  assert.ok(html.includes(TASK));
  assert.ok(html.includes(`“${ASK}”`));
  assert.match(html, new RegExp(`<form method="post" action="/dashboard/voice/handoffs/${id}/decide"`));
  assert.ok(html.includes(`<input type="hidden" name="_csrf" value="${CSRF}">`));
  assert.match(html, /name="decision" value="confirm">Confirm</);
  assert.match(html, /name="decision" value="decline">Decline</);
  assert.equal(s.opened.n, s.opened.closed, "one client per request, closed");
});

test("confirm starts the hand-off once: 303 back to the page, the row started, one card, the page shows it", async () => {
  const s = await setup();
  const id = await s.insert();
  const r = await s.decide(id, "confirm");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), phoneConfirmPath(id));
  assert.deepEqual(s.confirms, [[id, "yes", "phone"]]);
  const row = await s.row(id);
  assert.equal(row.status, "started");
  const cards = await s.cards();
  assert.equal(cards.length, 1);
  assert.equal(row.card_id, cards[0].id);
  assert.equal(cards[0].assigned_bot, "writer");
  assert.equal(s.eng.calls.spawn.length, 1);
  const html = await (await s.get(id)).text();
  assert.ok(!hasForm(html), "no buttons once decided");
  assert.match(html, /Confirmed\. Writer is working on it\./);
  assert.match(html, new RegExp(`href="/dashboard/bot-board\\?bot=writer#open=${cards[0].id}">Open the card<`));
  assert.equal(s.opened.n, s.opened.closed);
});

test("confirm returns within the start budget on a cold model: starting, never waiting on the spawn", async () => {
  const s = await setup({ avail: "on_demand" });
  const id = await s.insert();
  s.eng.hold = deferred();
  const p = s.decide(id, "confirm");
  for (let i = 0; i < 200 && !s.core.inFlight.has(id); i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 200 && s.eng.calls.spawn.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  s.now.advance(HANDOFF_START_BUDGET_MS);
  const r = await p;
  assert.equal(r.status, 303);
  assert.equal((await s.row(id)).status, "starting");
  assert.match(await (await s.get(id)).text(), /Confirmed\. Writer is starting up\./);
  s.eng.hold.res();
  for (let i = 0; i < 200 && (await s.row(id)).status === "starting"; i++) await flush();
  assert.equal((await s.row(id)).status, "started");
});

test("double confirm creates one card (Review Focus 3), sequential or concurrent", async () => {
  const s = await setup();
  const id = await s.insert();
  assert.equal((await s.decide(id, "confirm")).status, 303);
  assert.equal((await s.decide(id, "confirm")).status, 303);
  assert.equal((await s.decide(id, "decline")).status, 303);
  assert.equal(s.confirms.length, 1, "a decided row never reaches confirm again");
  assert.equal((await s.cards()).length, 1);
  assert.equal((await s.row(id)).status, "started");

  const s2 = await setup();
  const id2 = await s2.insert();
  const [a, b] = await Promise.all([s2.decide(id2, "confirm"), s2.decide(id2, "confirm")]);
  assert.deepEqual([a.status, b.status], [303, 303]);
  assert.equal((await s2.cards()).length, 1, "confirm's CAS lets one through");
  assert.equal(s2.eng.calls.spawn.length, 1);
});

test("an expired proposal cannot be confirmed: no card, and the page shows expired [rv1 C2]", async () => {
  const s = await setup();
  const id = await s.insert();
  s.now.advance(HANDOFF_PHONE_TTL_MS + 1);
  const before = await (await s.get(id)).text();
  assert.ok(!hasForm(before), "no buttons past the TTL, even before the sweep");
  assert.match(before, /This request expired\. Nothing was started\./);
  const r = await s.decide(id, "confirm");
  assert.equal(r.status, 303);
  assert.deepEqual(s.confirms, [], "core.confirm is never reached");
  assert.deepEqual(await s.cards(), []);
  assert.equal((await s.row(id)).status, "expired", "moved out on the POST");
  assert.match(await (await s.get(id)).text(), /This request expired\./);
});

test("a proposed (voice) row cannot be confirmed through the page [rv1 C4]", async () => {
  const s = await setup();
  const id = await s.insert({ surface: "phone", device_id: "phone-1", status: "proposed" });
  const html = await (await s.get(id)).text();
  assert.ok(!hasForm(html));
  assert.match(html, /This was asked by voice, and it is answered there\./);
  const r = await s.decide(id, "confirm");
  assert.equal(r.status, 404);
  assert.deepEqual(s.confirms, []);
  assert.equal((await s.row(id)).status, "proposed");
  assert.deepEqual(await s.cards(), []);
});

test("a phone-surface row forced to awaiting_phone is refused: only a kiosk's row is decided here (P5)", async () => {
  const s = await setup();
  const id = await s.insert({ surface: "phone", device_id: "phone-1" });
  const html = await (await s.get(id)).text();
  assert.ok(!hasForm(html));
  assert.match(html, /This one isn't confirmed on this page\./);
  assert.equal((await s.decide(id, "confirm")).status, 404);
  assert.equal((await s.decide(id, "decline")).status, 404);
  assert.deepEqual(s.confirms, []);
  assert.equal((await s.row(id)).status, "awaiting_phone");
  assert.deepEqual(await s.cards(), []);
});

test("a stop row shows stop wording and is 404 until core.decideStop exists; with it, the POST dispatches there (P8)", async () => {
  const s = await setup();
  const target = await s.insert({ status: "proposed", surface: "phone", device_id: "phone-1" });
  const id = await s.insert({ kind: "stop", target_id: target });
  const html = await (await s.get(id)).text();
  assert.match(html, /<h1>Stop Writer&#39;s task\?<\/h1>|<h1>Stop Writer's task\?<\/h1>/);
  assert.ok(!hasForm(html), "no buttons while nothing can decide a stop");
  assert.equal((await s.decide(id, "confirm")).status, 404);
  assert.deepEqual(s.confirms, [], "a stop row never reaches confirm");
  assert.equal((await s.row(id)).status, "awaiting_phone");

  const stops = [];
  const s2 = await setup({ coreOver: (core) => { core.decideStop = async (_db, sid, d) => { stops.push([sid, d]); return { status: "done" }; }; } });
  const t2 = await s2.insert({ status: "proposed", surface: "phone", device_id: "phone-1" });
  const id2 = await s2.insert({ kind: "stop", target_id: t2 });
  const page2 = await (await s2.get(id2)).text();
  assert.match(page2, /value="confirm">Stop it</);
  assert.match(page2, /value="decline">Keep it running</);
  const r = await s2.decide(id2, "confirm");
  assert.equal(r.status, 303);
  assert.equal((await s2.decide(id2, "decline")).status, 303);
  assert.deepEqual(stops, [[id2, "yes"], [id2, "no"]]);
  assert.deepEqual(s2.confirms, []);
  assert.deepEqual(await s2.cards(), [], "a stop creates no card");
});

test("a bad id, or an unknown one, is 404 and reads nothing", async () => {
  const s = await setup();
  for (const bad of ["vh-XYZ", "vh-0123", "vh-0123456789abcdef0", "x", "vh-0123456789ABCDEF"]) {
    assert.equal((await s.get(bad)).status, 404, bad);
    assert.equal((await s.decide(bad, "confirm")).status, 404, bad);
  }
  assert.equal((await s.get("vh-0123456789abcdef")).status, 404);
  assert.equal((await s.decide("vh-0123456789abcdef", "confirm")).status, 404);
  assert.deepEqual(s.confirms, []);
});

test("a decision that is not exactly confirm or decline is 400, never a yes", async () => {
  const s = await setup();
  const id = await s.insert();
  for (const d of ["yes", "no", "", "Confirm", "confirm ", "toString", "__proto__"]) {
    assert.equal((await s.decide(id, d)).status, 400, JSON.stringify(d));
  }
  assert.equal((await s.decide(id, undefined)).status, 400, "missing");
  const twice = new URLSearchParams([["decision", "confirm"], ["decision", "confirm"], ["_csrf", CSRF]]).toString();
  assert.equal((await s.decide(id, null, { body: twice })).status, 400, "repeated field");
  assert.deepEqual(s.confirms, []);
  assert.equal((await s.row(id)).status, "awaiting_phone");
  assert.deepEqual(await s.cards(), []);
});

test("decline logs declined and creates nothing", async () => {
  const s = await setup();
  const id = await s.insert();
  const r = await s.decide(id, "decline");
  assert.equal(r.status, 303);
  assert.deepEqual(s.confirms, [[id, "no", "phone"]]);
  const row = await s.row(id);
  assert.equal(row.status, "declined");
  assert.equal(row.decided_at, T0);
  assert.deepEqual(await s.cards(), []);
  assert.match(await (await s.get(id)).text(), /You declined it\. Nothing was started\./);
});

test("confirm's statuses map to the page: bad_decision 400, none and wrong_kind 404, the rest 303 (P9)", async () => {
  for (const [status, code] of [["bad_decision", 400], ["none", 404], ["wrong_kind", 404], ["already", 303], ["expired", 303], ["failed", 303], ["queued", 303]]) {
    const s = await setup({ coreOver: (core) => { core.confirm = async () => ({ status }); } });
    const id = await s.insert();
    assert.equal((await s.decide(id, "confirm")).status, code, status);
  }
});

test("a peer's single-sign-on session sees the page but cannot decide: 403 (P12)", async () => {
  const s = await setup();
  const id = await s.insert();
  const html = await (await s.get(id, { session: SSO })).text();
  assert.ok(!hasForm(html), "no buttons for a peer's session");
  assert.match(html, /Confirm this from your own sign-in on this Crow/);
  const r = await s.decide(id, "confirm", { session: SSO });
  assert.equal(r.status, 403);
  assert.deepEqual(s.confirms, []);
  assert.equal((await s.row(id)).status, "awaiting_phone");
  assert.deepEqual(await s.cards(), []);
});

test("the page is never framed or cached: X-Frame-Options DENY and CSP frame-ancestors 'none' (P12)", async () => {
  const s = await setup();
  const id = await s.insert();
  for (const r of [await s.get(id), await s.get("vh-0123456789abcdef"), await s.decide(id, "nope")]) {
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal((csp.match(/frame-ancestors/g) || []).length, 1, "the gateway's frame-ancestors is replaced, not joined");
    assert.match(csp, /^default-src 'self'; /, "the rest of the gateway's policy is kept");
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
});

test("the page escapes the task, the asked text, the display and the bot name", async () => {
  const s = await setup();
  const id = await s.insert({
    bot_id: "helper", device_name: "<b>Kitchen</b>",
    task: "write <script>alert(1)</script> up", asked: "say \"hi\" & <img src=y onerror=alert(2)>",
  });
  const html = await (await s.get(id)).text();
  assert.ok(!/<script>alert|<img src=|<b>Kitchen/.test(html), "nothing from the row reaches the page as markup");
  assert.ok(html.includes("write &lt;script&gt;alert(1)&lt;/script&gt; up"));
  assert.ok(html.includes("say &quot;hi&quot; &amp; &lt;img src=y onerror=alert(2)&gt;"));
  assert.ok(html.includes("&lt;b&gt;Kitchen&lt;/b&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;Helper"));
});

test("a null asked renders without the asked block; a failed not_sent row has its reason and no buttons (P9)", async () => {
  const s = await setup();
  const id = await s.insert({ asked: null, device_name: null });
  const html = await (await s.get(id)).text();
  assert.ok(!html.includes("What you said"));
  assert.match(html, /Asked on the kiosk, /);
  assert.ok(hasForm(html));
  await s.core.store.transition(s.db, id, ["awaiting_phone"], "failed", { detail: "not_sent" });
  const failed = await (await s.get(id)).text();
  assert.ok(!hasForm(failed));
  assert.match(failed, /This couldn&#39;t be sent|This couldn't be sent to your phone, so it can't be confirmed\./);
  const other = await s.insert({ device_id: "kiosk-2" });
  await s.core.store.transition(s.db, other, ["awaiting_phone"], "failed", { detail: "something_else" });
  assert.match(await (await s.get(other)).text(), /It couldn't be handed to Writer, so nothing was started\./);
});

test("the page is in the row's language (the push title's), else the dashboard's", async () => {
  const s = await setup();
  const id = await s.insert({ lang: "es" });
  const html = await (await s.get(id, { lang: "en" })).text();
  assert.match(html, /<html lang="es">/, "the row's es wins over a dashboard in en");
  assert.match(html, /¿Pasarle una tarea a Writer\?/);
  assert.match(html, /value="confirm">Confirmar</);
  assert.match(html, /value="decline">Rechazar</);
  const en = await s.insert({ lang: "en", device_id: "kiosk-2" });
  assert.match(await (await s.get(en, { lang: "es" })).text(), /<html lang="en">[\s\S]*Hand a task to Writer\?/, "the row's en wins over a dashboard in es");
  const bad = await s.insert({ lang: "en", device_id: "kiosk-3" });
  await s.db.execute({ sql: "UPDATE voice_handoffs SET lang = 'fr' WHERE id = ?", args: [bad] });
  assert.match(await (await s.get(bad, { lang: "es" })).text(), /<html lang="es">/, "an invalid row lang falls back to the dashboard's");
  await s.db.execute({ sql: "UPDATE voice_handoffs SET lang = NULL WHERE id = ?", args: [bad] });
  assert.match(await (await s.get(bad, { lang: "es" })).text(), /<html lang="es">/, "a missing row lang falls back too");
});

test("isLocalPasswordSessionOn: only this instance's own password session, on the caller's client", async () => {
  const { isLocalPasswordSessionOn } = await import("../servers/gateway/dashboard/local-session.js");
  const s = await setup();
  assert.equal(await isLocalPasswordSessionOn(s.db, { dashboardSession: OWN }), true);
  assert.equal(await isLocalPasswordSessionOn(s.db, { dashboardSession: SSO }), false);
  assert.equal(await isLocalPasswordSessionOn(s.db, { dashboardSession: OWN, crossHostAuth: { ok: true } }), false);
  assert.equal(await isLocalPasswordSessionOn(s.db, { dashboardSession: "unknown" }), false);
  assert.equal(await isLocalPasswordSessionOn(s.db, {}), false);
  assert.equal(await isLocalPasswordSessionOn({ execute: async () => { throw new Error("locked"); } }, { dashboardSession: OWN }), false, "an error is a no");
});

test("a failed row that has a card ran and could not finish: the page says so, never \"nothing was started\" (P26)", async () => {
  const s = await setup();
  const id = await s.insert();
  await s.core.store.transition(s.db, id, ["awaiting_phone"], "failed", { card_id: 7, outcome: "failure", detail: "The source archive is offline." });
  const html = await (await s.get(id)).text();
  assert.ok(!hasForm(html));
  assert.match(html, /Writer couldn't finish it\. The details are on Writer's board\./);
  assert.ok(!/nothing was started/.test(html));
  const es = await s.insert({ device_id: "kiosk-2", lang: "es" });
  await s.core.store.transition(s.db, es, ["awaiting_phone"], "failed", { card_id: 8, outcome: "failure", detail: "x" });
  assert.match(await (await s.get(es)).text(), /Writer no pudo terminarlo\. Los detalles están en el tablero de Writer\./);
});

test("a row whose session ended without a result says so on the page (P26, 5.3)", async () => {
  const s = await setup();
  const id = await s.insert();
  await s.core.store.transition(s.db, id, ["awaiting_phone"], "failed", { card_id: 7, detail: "session_ended_no_result" });
  const html = await (await s.get(id)).text();
  assert.ok(!hasForm(html));
  assert.match(html, /Writer stopped without finishing it\. The card is still on Writer's board\./);
  assert.ok(!/nothing was started/.test(html));
  const es = await s.insert({ device_id: "kiosk-2", lang: "es" });
  await s.core.store.transition(s.db, es, ["awaiting_phone"], "failed", { card_id: 8, detail: "session_ended_no_result" });
  assert.match(await (await s.get(es)).text(), /Writer se detuvo sin terminarlo\. La tarjeta sigue en el tablero de Writer\./);
});

test("every voiceHandoff page string is in English and Spanish", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("voiceHandoff."));
  assert.ok(keys.length >= 30, `found ${keys.length}`);
  for (const k of keys) {
    assert.ok(translations[k].en && translations[k].es, `${k} has en and es`);
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    assert.equal(vars(translations[k].en), vars(translations[k].es), `${k} has the same placeholders`);
  }
});
