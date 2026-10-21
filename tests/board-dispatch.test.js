/**
 * board_dispatch_item — dispatch-service.js + its MCP registration.
 *
 * A signed bot hands one of its own top-level cards to another bot, only
 * when the operator created that card (not a decision follow-up) or granted
 * it; the result is gated; nothing starts. Every rule and refusal code is
 * pinned here with "nothing written" checks, plus the laundering paths
 * (self-created, reparented, decision follow-ups, spent grants, bot-moved
 * subtrees), the claim races, and the real MCP wire with signed, forged and
 * absent signatures.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dir = mkdtempSync(join(tmpdir(), "board-dispatch-"));
const savedEnv = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
const DB_FILE = join(dir, "crow.db");
const TASKS = join(dir, "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;

const HUMAN = { kind: "human", id: null, jobId: null };
const SESSION = { kind: "session", id: null, jobId: null };
const UNSIGNED = { kind: "bot", id: null, jobId: null };
const BOT_A = { kind: "bot", id: "bot-a", jobId: null };
const BOT_B = { kind: "bot", id: "bot-b", jobId: null };

let dispatchCard, cardProvenance, createCard, updateCard, askDecision, decideOption, isEnabledBot, createDbClient;
let CROW_VOICE_BOT_ID;
let PID_A, PID_B, PID_C;
let tdb, cdb;
const wire = {};

const raw = () => new Database(DB_FILE);
const rawTasks = () => new Database(TASKS);
const card = (id) => { const t = rawTasks(); const r = t.prepare("SELECT * FROM tasks_items WHERE id=?").get(id); t.close(); return r; };
const mutations = (id) => { const t = rawTasks(); const r = t.prepare("SELECT * FROM board_mutations WHERE item_id=? ORDER BY id").all(id); t.close(); return r; };
const audits = (target) => { const c = raw(); const r = c.prepare("SELECT * FROM project_audit_log WHERE action='card_given' AND target=?").all(target); c.close(); return r; };
const count = (db, sql) => { const d = db === "t" ? rawTasks() : raw(); const n = d.prepare(sql).get().n; d.close(); return n; };

function seedBot(id, def, { enabled = 1, project = null } = {}) {
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)")
    .run(id, id, JSON.stringify(def), enabled, project);
  c.close();
}

/** Everything a refused dispatch must leave untouched. */
function snapshot(ids) {
  const t = rawTasks();
  const rows = ids.map((id) => t.prepare("SELECT * FROM tasks_items WHERE id=?").get(id));
  const muts = t.prepare("SELECT COUNT(*) AS n FROM board_mutations").get().n;
  t.close();
  return { rows, muts, audits: count("c", "SELECT COUNT(*) AS n FROM project_audit_log") };
}

async function refusal(promise) {
  try { await promise; } catch (err) { return err; }
  assert.fail("expected a refusal");
}

/** Assert a refusal with `code`/`http` that wrote nothing. */
async function refusesCleanly(fn, ids, code, http) {
  const before = snapshot(ids);
  const err = await refusal(fn());
  assert.equal(err.code, code, `code (${err.message})`);
  assert.equal(err.http, http);
  assert.deepEqual(snapshot(ids), before, "nothing written");
  return err;
}

/** An operator-created top-level card (human create row) on bot-a's board. */
async function opCard(fields = {}) {
  return (await createCard(tdb, { title: "op card", project_id: PID_A, assigned_bot: "bot-a", ...fields }, HUMAN)).id;
}
function grant(id, bots) {
  const t = rawTasks();
  t.prepare("UPDATE tasks_items SET data_json=json_set(data_json,'$.dispatch_grants',json(?)) WHERE id=?").run(JSON.stringify(bots), id);
  t.close();
}
const go = (id, actor = BOT_A, toBot = "bot-b", note) => dispatchCard(tdb, cdb, { itemId: id, toBot, note }, actor);

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = raw();
  const mk = (slug) => Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES (?,?)").run(slug, slug).lastInsertRowid);
  PID_A = mk("a-board");
  PID_B = mk("b-board");
  PID_C = mk("c-board");
  c.close();
  ({ CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js"));
  const kanban = { tracker_config: { type: "kanban" } };
  seedBot("bot-a", kanban, { project: PID_A });
  seedBot("bot-b", kanban, { project: PID_B });
  seedBot("bot-c", kanban, { project: PID_C });
  seedBot("sleeper", kanban, { enabled: 0, project: PID_B });
  seedBot("nob", { tracker_config: { type: "none" } });
  seedBot(CROW_VOICE_BOT_ID, kanban, { project: PID_B });

  const t = rawTasks();
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
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, project_id INTEGER,
    display_name TEXT, status_values TEXT NOT NULL, terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]')`);
  const def = t.prepare("INSERT INTO board_defs (project_id, display_name, status_values, terminal_values) VALUES (?,?,?,?)");
  for (const p of [PID_A, PID_B, PID_C]) def.run(p, "b" + p, '["pending","in_progress","done"]', '["done"]');
  t.close();

  ({ dispatchCard, cardProvenance } = await import("../servers/gateway/board/dispatch-service.js"));
  ({ createCard, updateCard } = await import("../servers/gateway/board/card-service.js"));
  ({ askDecision, decideOption } = await import("../servers/gateway/board/decision-service.js"));
  ({ isEnabledBot } = await import("../servers/gateway/board/bot-lookup.js"));
  ({ createDbClient } = await import("../servers/db.js"));
  tdb = createDbClient(TASKS);
  cdb = createDbClient(DB_FILE);
});

after(async () => {
  if (wire.httpServer) {
    wire.httpServer.closeAllConnections();
    await new Promise((resolve) => wire.httpServer.close(resolve));
  }
  try { tdb.close(); } catch {}
  try { cdb.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// ---- the success path ----

test("an operator-created card goes to the target: gated (card and children), bot actor everywhere, dispatch row, audit via dispatch, nothing starts", async () => {
  const id = await opCard({ autonomy: "auto" });
  const kid = (await createCard(tdb, { title: "kid", parent_id: id, autonomy: "auto" }, HUMAN)).id;
  const humanBefore = count("t", "SELECT COUNT(*) AS n FROM board_mutations WHERE actor_kind='human'");
  const jobsBefore = count("c", "SELECT COUNT(*) AS n FROM bot_jobs");
  const sessBefore = count("c", "SELECT COUNT(*) AS n FROM bot_sessions");

  const out = await go(id, BOT_A, "bot-b", "needs a second pair of eyes");
  assert.deepEqual(out, { ok: true, item_id: id, from: "bot-a", to: "bot-b" });

  const row = card(id);
  assert.equal(row.assigned_bot, "bot-b");
  assert.equal(row.project_id, PID_B);
  assert.equal(row.autonomy, "gated");
  assert.equal(row.parent_id, null);
  assert.equal(card(kid).project_id, PID_B);
  assert.equal(card(kid).autonomy, "gated");
  assert.equal(card(kid).assigned_bot, null);

  const m = mutations(id);
  assert.deepEqual(m.map((r) => r.verb), ["create", "update", "dispatch"]);
  for (const r of m.slice(1)) { assert.equal(r.actor_kind, "bot"); assert.equal(r.actor_id, "bot-a"); }
  assert.deepEqual(JSON.parse(m[2].detail_json), { from: "bot-a", to: "bot-b", note: "needs a second pair of eyes" });
  const km = mutations(kid);
  assert.equal(km.at(-1).actor_kind, "bot");
  assert.equal(km.at(-1).actor_id, "bot-a");

  const a = audits(`card:${id}`);
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_type, "bot");
  assert.equal(a[0].actor_id, "bot-a");
  assert.deepEqual(JSON.parse(a[0].payload), { bot_id: "bot-b", via: "dispatch", children: 1 });

  assert.equal(count("t", "SELECT COUNT(*) AS n FROM board_mutations WHERE actor_kind='human'"), humanBefore, "no new human rows");
  assert.equal(count("c", "SELECT COUNT(*) AS n FROM bot_jobs"), jobsBefore, "no job created");
  assert.equal(count("c", "SELECT COUNT(*) AS n FROM bot_sessions"), sessBefore, "no session started");
});

test("no note records note:null", async () => {
  const id = await opCard();
  await go(id);
  assert.deepEqual(JSON.parse(mutations(id).at(-1).detail_json), { from: "bot-a", to: "bot-b", note: null });
});

// ---- rule 1: signed bot ----

test("rule 1: a session, an unsigned bot, a human or no actor is 403 actor_unverified", async () => {
  const id = await opCard();
  for (const actor of [SESSION, UNSIGNED, HUMAN, undefined, { kind: "bot", id: "" }]) {
    await refusesCleanly(() => dispatchCard(tdb, cdb, { itemId: id, toBot: "bot-b" }, actor), [id], "actor_unverified", 403);
  }
});

// ---- rule 2: top-level card ----

test("rule 2: missing or tracker item 404, archived 409, subtask 400 subtask", async () => {
  await refusesCleanly(() => go(999999), [], "not_found", 404);
  const t = rawTasks();
  const item = Number(t.prepare("INSERT INTO tasks_items (title, board_id, assigned_bot) VALUES ('item', 1, 'bot-a')").run().lastInsertRowid);
  t.close();
  await refusesCleanly(() => go(item), [item], "not_found", 404);
  const arch = await opCard();
  const t2 = rawTasks(); t2.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(arch); t2.close();
  await refusesCleanly(() => go(arch), [arch], "archived", 409);
  const parent = await opCard();
  const sub = (await createCard(tdb, { title: "sub", parent_id: parent, assigned_bot: "bot-a" }, HUMAN)).id;
  await refusesCleanly(() => go(sub), [sub, parent], "subtask", 400);
});

// ---- rule 3: own card ----

test("rule 3: a card assigned to another bot, or to nobody, is 403 not_assigned", async () => {
  const other = await opCard({ assigned_bot: "bot-c" });
  await refusesCleanly(() => go(other), [other], "not_assigned", 403);
  const none = await opCard({ assigned_bot: null });
  await refusesCleanly(() => go(none), [none], "not_assigned", 403);
});

// ---- rule 4: provenance or grant ----

test("rule 4: a bot-created card assigned to itself is 403 not_granted", async () => {
  const id = (await createCard(tdb, { title: "mine", project_id: PID_A, assigned_bot: "bot-a" }, BOT_A)).id;
  await refusesCleanly(() => go(id), [id], "not_granted", 403);
});

test("rule 4: a session-created card is 403 not_granted", async () => {
  const id = (await createCard(tdb, { title: "s", project_id: PID_A, assigned_bot: "bot-a" }, SESSION)).id;
  await refusesCleanly(() => go(id), [id], "not_granted", 403);
});

test("rule 4: a card with no create row (a synced card) fails closed", async () => {
  const t = rawTasks();
  const id = Number(t.prepare("INSERT INTO tasks_items (title, project_id, assigned_bot) VALUES ('synced', ?, 'bot-a')").run(PID_A).lastInsertRowid);
  t.close();
  await refusesCleanly(() => go(id), [id], "not_granted", 403);
  // A later human edit does not make it operator-created: only the first row counts.
  await updateCard(tdb, id, { title: "synced, edited" }, HUMAN);
  await refusesCleanly(() => go(id), [id], "not_granted", 403);
  assert.equal((await cardProvenance(tdb, id)).humanCreated, false);
});

test("rule 4: a bot that creates a subtask under an operator card and reparents it to top level is still 403", async () => {
  const parent = await opCard();
  const id = (await createCard(tdb, { title: "laundered", parent_id: parent, assigned_bot: "bot-a" }, BOT_A)).id;
  await updateCard(tdb, id, { parent_id: null }, BOT_A);
  await refusesCleanly(() => go(id), [id], "not_granted", 403);
});

test("rule 4: a decision follow-up assigned to the caller is 403 not_granted (human decider, via decision)", async () => {
  const ask = await askDecision(tdb, cdb, {
    projectId: PID_A,
    decision: {
      question: "Apply the fix?", fingerprint: "fp-dispatch-1", batch: "b-dispatch",
      options: [
        { label: "Fix it", consequence: "A follow-up card is made", recommended: true,
          then: { create_card: { title: "Apply the fix", assign_bot: "bot-a" } } },
        { label: "Skip", consequence: "Nothing happens" },
      ],
    },
  }, BOT_A);
  const r = await decideOption(tdb, cdb, ask.id, { index: 0 }, HUMAN, { isEnabledBot: (b) => isEnabledBot(cdb, b) });
  const id = r.created_card_id;
  assert.equal(card(id).assigned_bot, "bot-a");
  assert.equal(mutations(id)[0].actor_kind, "human", "the decider is human");
  await refusesCleanly(() => go(id), [id], "not_granted", 403);
});

test("rule 4: a grant naming the caller lets a bot-created card through; the grant is spent, so the new holder gets 403", async () => {
  const id = (await createCard(tdb, { title: "granted", project_id: PID_A, assigned_bot: "bot-a" }, BOT_A)).id;
  grant(id, ["bot-c"]);
  await refusesCleanly(() => go(id), [id], "not_granted", 403);
  grant(id, ["bot-a", "bot-b"]);
  assert.deepEqual((await cardProvenance(tdb, id)).grants, ["bot-a", "bot-b"]);
  await go(id);
  assert.equal(card(id).assigned_bot, "bot-b");
  assert.equal(JSON.parse(card(id).data_json).dispatch_grants, undefined, "grants cleared");
  await refusesCleanly(() => go(id, BOT_B, "bot-c"), [id], "not_granted", 403);
});

test("rule 4: an operator-created card can be dispatched onward by the new holder", async () => {
  const id = await opCard();
  await go(id);
  await go(id, BOT_B, "bot-c");
  assert.equal(card(id).assigned_bot, "bot-c");
  assert.equal(card(id).project_id, PID_C);
});

// ---- rule 5: valid target ----

test("rule 5: to self, a disabled, unknown or voice bot is 400 bad_bot", async () => {
  const id = await opCard();
  for (const to of ["bot-a", "sleeper", "ghost", CROW_VOICE_BOT_ID, ""]) {
    await refusesCleanly(() => go(id, BOT_A, to), [id], "bad_bot", 400);
  }
});

// ---- rule 6: subtree ----

test("rule 6: a locked subtask is 409 subtree_blocked", async () => {
  const id = await opCard();
  const kid = (await createCard(tdb, { title: "kid", parent_id: id }, HUMAN)).id;
  const c = raw();
  c.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, card_id, status) VALUES (?,?,?,?,?)").run("job-kid-" + kid, "bot-a", "work", kid, "running");
  c.close();
  await refusesCleanly(() => go(id), [id, kid], "subtree_blocked", 409);
});

test("rule 6: a subtask assigned to another bot is 409; one assigned to the caller is fine", async () => {
  const id = await opCard();
  const kid = (await createCard(tdb, { title: "kid", parent_id: id, assigned_bot: "bot-c" }, HUMAN)).id;
  await refusesCleanly(() => go(id), [id, kid], "subtree_blocked", 409);
  const id2 = await opCard();
  await createCard(tdb, { title: "kid2", parent_id: id2, assigned_bot: "bot-a" }, HUMAN);
  await go(id2);
});

test("rule 6: a card a bot reparented into the subtree is 409 (deep too); a human reparent is fine; archived kids are ignored", async () => {
  const id = await opCard();
  const victim = (await createCard(tdb, { title: "victim", project_id: PID_C }, HUMAN)).id;
  await updateCard(tdb, victim, { parent_id: id }, BOT_A);
  await refusesCleanly(() => go(id), [id, victim], "subtree_blocked", 409);

  const deep = await opCard();
  const kid = (await createCard(tdb, { title: "kid", parent_id: deep }, HUMAN)).id;
  const v2 = (await createCard(tdb, { title: "v2", project_id: PID_C }, HUMAN)).id;
  await updateCard(tdb, v2, { parent_id: kid }, BOT_A);
  await refusesCleanly(() => go(deep), [deep, kid, v2], "subtree_blocked", 409);

  const ok = await opCard();
  const moved = (await createCard(tdb, { title: "moved", project_id: PID_C }, HUMAN)).id;
  await updateCard(tdb, moved, { parent_id: ok }, HUMAN);
  const gone = (await createCard(tdb, { title: "gone", project_id: PID_C, assigned_bot: "bot-c" }, HUMAN)).id;
  await updateCard(tdb, gone, { parent_id: ok }, BOT_A);
  const t = rawTasks(); t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(gone); t.close();
  assert.equal(card(gone).project_id, PID_A, "a reparent re-inherits the parent's project");
  await go(ok);
  assert.equal(card(moved).project_id, PID_B);
  assert.equal(card(gone).project_id, PID_A, "archived kid stays put");
});

// ---- rule 7: give-core checks pass through, before the claim ----

test("rule 7: locked 409, finished 409, no_board 409 pass through with nothing written (grants kept)", async () => {
  const locked = await opCard();
  grant(locked, ["bot-a"]);
  const c = raw();
  c.prepare("INSERT INTO bot_sessions (bot_id, card_id, status) VALUES (?,?,?)").run("bot-a", locked, "active");
  c.close();
  await refusesCleanly(() => go(locked), [locked], "locked", 409);
  assert.deepEqual(JSON.parse(card(locked).data_json).dispatch_grants, ["bot-a"], "grant not spent");

  const done = await opCard({ status: "done" });
  await refusesCleanly(() => go(done), [done], "finished", 409);

  const nob = await opCard();
  await refusesCleanly(() => go(nob, BOT_A, "nob"), [nob], "no_board", 409);
});

// ---- races ----

/** A tdb whose claim UPDATE first runs `beforeClaim` (a concurrent writer). */
function racingTdb(beforeClaim) {
  return {
    execute: async (q) => {
      const sql = typeof q === "string" ? q : q.sql;
      if (/json_remove\(data_json, '\$\.dispatch_grants'\)/.test(sql)) await beforeClaim();
      return tdb.execute(q);
    },
  };
}

test("race: an assignee change between the checks and the claim is 409 changed, nothing moved", async () => {
  const id = await opCard();
  const rtdb = racingTdb(() => updateCard(tdb, id, { assigned_bot: "bot-c" }, HUMAN));
  const before = mutations(id).length;
  const err = await refusal(dispatchCard(rtdb, cdb, { itemId: id, toBot: "bot-b" }, BOT_A));
  assert.equal(err.code, "changed");
  assert.equal(err.http, 409);
  assert.equal(card(id).assigned_bot, "bot-c");
  assert.equal(card(id).project_id, PID_A);
  assert.equal(mutations(id).length, before + 1, "only the concurrent writer's row");
  assert.equal(audits(`card:${id}`).length, 0);
});

test("race: a lock taken between the checks and the write is 409 locked, nothing moved", async () => {
  const id = await opCard();
  const rtdb = racingTdb(async () => {
    const c = raw();
    c.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, card_id, status) VALUES (?,?,?,?,?)").run("job-race-" + id, "bot-a", "work", id, "queued");
    c.close();
  });
  const err = await refusal(dispatchCard(rtdb, cdb, { itemId: id, toBot: "bot-b" }, BOT_A));
  assert.equal(err.code, "locked");
  assert.equal(card(id).assigned_bot, "bot-a");
  assert.equal(card(id).project_id, PID_A);
  assert.deepEqual(mutations(id).map((r) => r.verb), ["create"]);
  assert.equal(audits(`card:${id}`).length, 0);
});

// ---- the MCP wire ----

async function startWire() {
  if (wire.port) return;
  const { createBoardMcpServer } = await import("../servers/gateway/board-mcp.js");
  const { mountMcpServer } = await import("../servers/gateway/routes/mcp.js");
  const { SessionManager } = await import("../servers/gateway/session-manager.js");
  const { localTokenAuthMiddleware, generateLocalToken, generateBoardToken } = await import("../servers/gateway/local-token.js");
  const sig = await import("../scripts/pi-bots/actor-sig.mjs");
  wire.sig = sig;
  wire.localToken = await generateLocalToken(cdb);
  wire.boardToken = await generateBoardToken(cdb);
  const app = express();
  app.use(express.json());
  app.use(localTokenAuthMiddleware(cdb));
  const noAuth = (req, res) => res.status(401).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32001, message: "unauthorized" } });
  sig.initGatewayActorKey();
  mountMcpServer(app, "/board", () => createBoardMcpServer({ tdb, cdb, verifyActor: sig.verifyBoardActorSig }), new SessionManager(), noAuth);
  wire.httpServer = app.listen(0);
  await new Promise((resolve, reject) => { wire.httpServer.once("listening", resolve); wire.httpServer.once("error", reject); });
  wire.port = wire.httpServer.address().port;
}

async function callDispatch(token, headers, args) {
  const h = { ...headers, Authorization: `Bearer ${token}` };
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${wire.port}/board/mcp`), { requestInit: { headers: h } });
  const client = new Client({ name: "board-dispatch-test", version: "0" });
  await client.connect(transport);
  try {
    return await client.callTool({ name: "board_dispatch_item", arguments: args });
  } finally {
    await transport.terminateSession();
    await client.close();
  }
}
const signed = (botId) => ({ "X-Crow-Actor-Kind": "bot", "X-Crow-Actor-Id": botId, "X-Crow-Actor-Sig": wire.sig.signBoardActor({ botId }) });

test("wire: the tool is listed", async () => {
  await startWire();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${wire.port}/board/mcp`), { requestInit: { headers: { Authorization: `Bearer ${wire.localToken}` } } });
  const client = new Client({ name: "board-dispatch-test", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await transport.terminateSession();
  await client.close();
  const t = tools.find((x) => x.name === "board_dispatch_item");
  assert.ok(t, "board_dispatch_item listed");
  assert.match(t.description, /gated/);
  assert.match(t.description, /nothing starts/);
});

test("wire: forged, absent or session callers get 403 and nothing moves; real signed headers succeed", async () => {
  await startWire();
  const id = await opCard();
  const args = { item_id: id, to_bot: "bot-b", note: "over the wire" };
  const refused = [
    [wire.boardToken, { "X-Crow-Actor-Kind": "bot", "X-Crow-Actor-Id": "bot-a" }],            // unsigned
    [wire.boardToken, { ...signed("bot-c"), "X-Crow-Actor-Id": "bot-a" }],                   // another bot's signature
    [wire.boardToken, { "X-Crow-Actor-Kind": "bot", "X-Crow-Actor-Id": "bot-a", "X-Crow-Actor-Sig": "zz" }], // garbage
    [wire.boardToken, {}],                                                                   // board token, no headers
    [wire.localToken, {}],                                                                   // the operator's session
  ];
  for (const [tok, headers] of refused) {
    const res = await callDispatch(tok, headers, args);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^\[403 actor_unverified\]/);
  }
  assert.equal(card(id).assigned_bot, "bot-a");
  assert.deepEqual(mutations(id).map((r) => r.verb), ["create"]);

  const res = await callDispatch(wire.boardToken, signed("bot-a"), args);
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.deepEqual(JSON.parse(res.content[0].text), { ok: true, item_id: id, from: "bot-a", to: "bot-b" });
  assert.equal(card(id).assigned_bot, "bot-b");
  const last = mutations(id).at(-1);
  assert.equal(last.verb, "dispatch");
  assert.equal(last.actor_kind, "bot");
  assert.equal(last.actor_id, "bot-a");
});

test("wire: a refusal code surfaces as isError with [http code]", async () => {
  await startWire();
  const id = (await createCard(tdb, { title: "own", project_id: PID_A, assigned_bot: "bot-a" }, BOT_A)).id;
  const res = await callDispatch(wire.boardToken, signed("bot-a"), { item_id: id, to_bot: "bot-b" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^\[403 not_granted\]/);
});
