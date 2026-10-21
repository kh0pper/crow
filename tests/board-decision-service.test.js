// tests/board-decision-service.test.js
//
// decision-service.js: decision cards (a card offering 2-4 options; answering
// records the choice and can create one gated follow-up card). Same fixture
// pattern as tests/board-plan-result-service.test.js: real migrations via the
// runner, board_defs seeded with two project boards:
//   - project 1 "HasDone": terminals done + cancelled
//   - project 2 "NoDone": a single terminal 'complete' (no done, no cancelled)
// cdb gains pi_bot_defs so one decide test runs the real isEnabledBot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../scripts/migrations/runner.mjs";
import { createDbClient } from "../servers/db.js";
import { createCard, getCard, archiveCard } from "../servers/gateway/board/card-service.js";
import { isEnabledBot } from "../servers/gateway/board/bot-lookup.js";
import { CROW_VOICE_BOT_ID } from "../servers/shared/voice-bot.js";
import {
  validateDecision, askDecision, decideOption, expireDecisions, notifyBatch,
} from "../servers/gateway/board/decision-service.js";

const DIR = join(import.meta.dirname, "..", "scripts", "migrations");

const HUMAN = { kind: "human", id: "casey", jobId: null };
const BOT = { kind: "bot", id: "bot-1", jobId: null };

function markPriorDone(c) {
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
}

function seedPost0003TasksDb(t) {
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER,
    project_id INTEGER, assigned_bot TEXT, plan_ref TEXT, stage TEXT,
    board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "decisionsvc-"));
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");

  const c = new Database(dbPath);
  markPriorDone(c);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, tasks_db_uri TEXT);
    CREATE TABLE bot_jobs (job_id TEXT PRIMARY KEY, bot_id TEXT, card_id INTEGER, card_action TEXT,
      status TEXT, worker_pid INTEGER, started_at TEXT);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, card_id INTEGER, status TEXT,
      pi_session_dir TEXT, kind TEXT NOT NULL DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER);
    CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL DEFAULT 'system',
      source TEXT, title TEXT NOT NULL, body TEXT, priority TEXT DEFAULT 'normal', action_url TEXT, metadata TEXT,
      is_read INTEGER DEFAULT 0, is_dismissed INTEGER DEFAULT 0, snoozed_until TEXT, schedule_id INTEGER,
      expires_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));`);
  const ins = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, enabled) VALUES (?,?,?)");
  ins.run("bot-1", "Bot one", 1);
  ins.run("bot-off", "Bot off", 0);
  ins.run(CROW_VOICE_BOT_ID, "Voice", 1);
  c.close();

  const t = new Database(tasksDbPath);
  seedPost0003TasksDb(t);
  t.close();
  return { root, dbPath, tasksDbPath };
}

async function withStore(fn) {
  const f = fixture();
  try {
    await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, sha: "test", log: () => {} });
    const tdb = createDbClient(f.tasksDbPath);
    const cdb = createDbClient(f.dbPath);
    await tdb.execute({
      sql: "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (1,'HasDone',?,?,'[]')",
      args: ['["pending","in_progress","done","cancelled"]', '["done","cancelled"]'],
    });
    await tdb.execute({
      sql: "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (2,'NoDone',?,?,'[]')",
      args: ['["backlog","working","complete"]', '["complete"]'],
    });
    try {
      await fn({ tdb, cdb });
    } finally {
      tdb.close();
      cdb.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

// ---- helpers ----

function opts(overrides = {}) {
  return [
    { label: "Yes", consequence: "It runs tonight", recommended: true, value: "yes" },
    { label: "Not now", consequence: "Asked again later", snooze_days: 7, value: "later" },
    ...(overrides.extra || []),
  ];
}

function decision(over = {}) {
  return {
    question: "Run the cleanup?",
    context_md: "Disk is 80% full.",
    fingerprint: "fp-1",
    batch: "batch-1",
    options: opts(),
    ...over,
  };
}

async function rejects(p, code, http) {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code);
    if (http != null) assert.equal(e.http, http);
    return true;
  });
}

function dataOf(card) {
  return JSON.parse(card.data_json || "{}");
}

async function countCards(tdb) {
  return Number((await tdb.execute("SELECT COUNT(*) AS n FROM tasks_items")).rows[0].n);
}

async function verbs(tdb, id) {
  return (await tdb.execute({ sql: "SELECT verb FROM board_mutations WHERE item_id=? ORDER BY id", args: [id] })).rows.map((r) => r.verb);
}

const yes = async () => true;

// ---------------------------------------------------------------------------
// validateDecision
// ---------------------------------------------------------------------------

test("validateDecision: a good decision normalizes and defaults expires to today+7", () => {
  const now = Date.parse("2026-03-10T12:00:00Z");
  const v = validateDecision(decision(), { now });
  assert.equal(v.question, "Run the cleanup?");
  assert.equal(v.context_md, "Disk is 80% full.");
  assert.equal(v.fingerprint, "fp-1");
  assert.equal(v.batch, "batch-1");
  assert.equal(v.options.length, 2);
  assert.equal(v.options[0].recommended, true);
  assert.equal(v.options[1].recommended, false);
  assert.equal(v.options[1].snooze_days, 7);
  assert.equal(v.expires, "2026-03-17");
});

test("validateDecision: the 400 matrix", () => {
  const bad = (d, why) => assert.throws(() => validateDecision(d), (e) => {
    assert.equal(e.code, "bad_decision", why);
    assert.equal(e.http, 400, why);
    return true;
  }, why);

  bad(decision({ options: [opts()[1], opts()[0]] }), "recommended not first");
  bad(decision({ options: [opts()[0], { ...opts()[0], label: "Also" }] }), "two recommended");
  bad(decision({ options: [{ ...opts()[0], recommended: false }, opts()[1]] }), "none recommended");
  bad(decision({ options: [opts()[0]] }), "one option");
  bad(decision({ options: [...opts(), { label: "c", consequence: "c" }, { label: "d", consequence: "d" }, { label: "e", consequence: "e" }] }), "5 options");
  bad(decision({ options: [opts()[0], { label: "No" }] }), "missing consequence");
  bad(decision({ options: [opts()[0], { label: "No", consequence: "" }] }), "empty consequence");
  bad(decision({ options: [opts()[0], { label: "x".repeat(121), consequence: "c" }] }), "label too long");
  bad(decision({ options: [opts()[0], { label: "No", consequence: "c", snooze_days: 91 }] }), "snooze_days > 90");
  bad(decision({ options: [opts()[0], { label: "No", consequence: "c", snooze_days: 1.5 }] }), "snooze_days not int");
  bad(decision({ options: [opts()[0], { label: "No", consequence: "c", then: { create_card: { title: "" } } }] }), "follow-up title empty");
  bad(decision({ question: "" }), "empty question");
  bad(decision({ question: "q".repeat(301) }), "question too long");
  bad(decision({ fingerprint: "" }), "empty fingerprint");
  bad(decision({ batch: "b".repeat(101) }), "batch too long");
  bad(decision({ expires: "next week" }), "bad expires");
  bad(decision({ expires: "2026-02-31" }), "impossible date");
  bad(null, "null");
});

test("validateDecision: 4 options with a follow-up card is fine", () => {
  const v = validateDecision(decision({
    expires: "2026-04-01",
    options: [
      { label: "a", consequence: "a", recommended: true, then: { create_card: { title: "Do a", description: "d", assign_bot: "bot-1" } } },
      { label: "b", consequence: "b" }, { label: "c", consequence: "c" }, { label: "d", consequence: "d" },
    ],
  }));
  assert.equal(v.options.length, 4);
  assert.deepEqual(v.options[0].then.create_card, { title: "Do a", description: "d", owner: null, assign_bot: "bot-1" });
  assert.equal(v.expires, "2026-04-01");
});

// ---------------------------------------------------------------------------
// askDecision
// ---------------------------------------------------------------------------

test("askDecision creates a card carrying the decision and a decision_ask mutation", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const r = await askDecision(tdb, cdb, { projectId: 1, tags: "ops", decision: decision() }, BOT);
    assert.equal(r.deduped, false);
    const card = await getCard(tdb, r.id);
    assert.equal(card.title, "Run the cleanup?", "title defaults to the question");
    assert.equal(card.tags, "ops");
    assert.equal(Number(card.project_id), 1);
    assert.equal(card.status, "pending");
    const d = dataOf(card).decision;
    assert.equal(d.fingerprint, "fp-1");
    assert.equal(d.options.length, 2);
    assert.deepEqual(await verbs(tdb, r.id), ["create", "decision_ask"]);
  });
});

test("askDecision: an open card with the same fingerprint is returned, deduped", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, title: "Cleanup", decision: decision() }, BOT);
    const b = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ question: "Again?" }) }, BOT);
    assert.equal(b.id, a.id);
    assert.equal(b.deduped, true);
    assert.equal(await countCards(tdb), 1);
  });
});

test("askDecision: a snoozed answer suppresses a re-ask until snooze_days pass", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const t0 = Date.parse("2026-03-10T12:00:00Z");
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT, { now: t0 });
    await decideOption(tdb, cdb, a.id, { index: 1 }, HUMAN, { isEnabledBot: yes, now: t0 });

    const day3 = t0 + 3 * 86400000;
    const b = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT, { now: day3 });
    assert.deepEqual(b, { id: a.id, deduped: true });

    const day8 = t0 + 8 * 86400000;
    const c = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT, { now: day8 });
    assert.equal(c.deduped, false);
    assert.notEqual(c.id, a.id);
  });
});

test("askDecision: an answer without snooze_days does not suppress a re-ask", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT);
    await decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes });
    const b = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT);
    assert.equal(b.deduped, false);
  });
});

test("askDecision: exactly 5 open per batch; the 6th is 429 batch_full", async () => {
  await withStore(async ({ tdb, cdb }) => {
    for (let i = 0; i < 5; i++) {
      const r = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: `fp-${i}` }) }, BOT);
      assert.equal(r.deduped, false);
    }
    await rejects(askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-6" }) }, BOT), "batch_full", 429);
    // A duplicate fingerprint still dedupes rather than 429ing.
    const dup = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-2" }) }, BOT);
    assert.equal(dup.deduped, true);
    // A different batch is unaffected.
    const other = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-7", batch: "batch-2" }) }, BOT);
    assert.equal(other.deduped, false);
    assert.equal(await countCards(tdb), 6);
  });
});

test("askDecision: a bad decision is 400 and creates nothing", async () => {
  await withStore(async ({ tdb, cdb }) => {
    await rejects(askDecision(tdb, cdb, { projectId: 1, decision: decision({ options: [opts()[0]] }) }, BOT), "bad_decision", 400);
    assert.equal(await countCards(tdb), 0);
  });
});

// ---------------------------------------------------------------------------
// decideOption
// ---------------------------------------------------------------------------

function withFollowUp(over = {}) {
  return decision({
    options: [
      { label: "Fix it", consequence: "A follow-up card is made", recommended: true, value: "fix",
        then: { create_card: { title: "Apply the fix", description: "Steps", assign_bot: "bot-1", ...over } } },
      { label: "Skip", consequence: "Nothing happens" },
    ],
  });
}

test("decideOption creates exactly one gated follow-up card on the same project and closes the card", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 2, decision: withFollowUp() }, BOT);
    const r = await decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: (id) => isEnabledBot(cdb, id) });
    assert.equal(r.chosen.index, 0);
    assert.equal(r.chosen.label, "Fix it");
    assert.equal(r.chosen.value, "fix");
    assert.equal(r.chosen.other_text, null);
    assert.ok(r.chosen.decided_at);
    assert.equal(typeof r.created_card_id, "number");

    const follow = await getCard(tdb, r.created_card_id);
    assert.equal(follow.title, "Apply the fix");
    assert.equal(follow.description, "Steps");
    assert.equal(follow.autonomy, "gated");
    assert.equal(follow.assigned_bot, "bot-1");
    assert.equal(Number(follow.project_id), 2);
    assert.equal(await countCards(tdb), 2);

    const card = await getCard(tdb, a.id);
    assert.equal(card.status, "complete", "no 'done' on this board: first terminal value");
    const d = dataOf(card).decision;
    assert.equal(d.chosen.label, "Fix it");
    assert.equal(d.created_card_id, r.created_card_id);
    assert.equal(d.fingerprint, "fp-1", "json_set merge keeps the rest of the decision");
    assert.ok((await verbs(tdb, a.id)).includes("decision"));
  });
});

test("decideOption moves to 'done' when the board has it", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT);
    const r = await decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes });
    assert.equal(r.created_card_id, null);
    assert.equal((await getCard(tdb, a.id)).status, "done");
  });
});

for (const [name, bot, owner, expectOwner] of [
  ["disabled", "bot-off", null, "bot-off"],
  ["unknown", "nobody", null, "nobody"],
  ["voice", CROW_VOICE_BOT_ID, "alex", "alex"],
]) {
  test(`decideOption: a ${name} assign_bot leaves assigned_bot null and sets owner`, async () => {
    await withStore(async ({ tdb, cdb }) => {
      const a = await askDecision(tdb, cdb, { projectId: 1, decision: withFollowUp({ assign_bot: bot, owner }) }, BOT);
      const r = await decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: (id) => isEnabledBot(cdb, id) });
      const follow = await getCard(tdb, r.created_card_id);
      assert.equal(follow.assigned_bot, null);
      assert.equal(follow.owner, expectOwner);
    });
  });
}

test("decideOption: an enabled assign_bot keeps the given owner", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: withFollowUp({ owner: "alex" }) }, BOT);
    const r = await decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes });
    const follow = await getCard(tdb, r.created_card_id);
    assert.equal(follow.assigned_bot, "bot-1");
    assert.equal(follow.owner, "alex");
  });
});

test("decideOption twice: the second is 409 already_decided and there is still one follow-up", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: withFollowUp() }, BOT);
    await decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes });
    await rejects(decideOption(tdb, cdb, a.id, { index: 1 }, HUMAN, { isEnabledBot: yes }), "already_decided", 409);
    assert.equal(await countCards(tdb), 2);
  });
});

test("decideOption: a concurrent double tap yields one decision and one follow-up", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: withFollowUp() }, BOT);
    const results = await Promise.allSettled([
      decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes }),
      decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rej = results.find((r) => r.status === "rejected");
    assert.equal(rej.reason.code, "already_decided");
    assert.equal(rej.reason.http, 409);
    assert.equal(await countCards(tdb), 2);
  });
});

test("decideOption after expires is 409 expired", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const t0 = Date.parse("2026-03-10T12:00:00Z");
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ expires: "2026-03-12" }) }, BOT, { now: t0 });
    // Still answerable on the expiry day itself.
    const lastDay = Date.parse("2026-03-12T23:00:00Z");
    const b = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-b", expires: "2026-03-12" }) }, BOT, { now: t0 });
    await decideOption(tdb, cdb, b.id, { index: 0 }, HUMAN, { isEnabledBot: yes, now: lastDay });

    const after = Date.parse("2026-03-13T00:00:01Z");
    await rejects(decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes, now: after }), "expired", 409);
    assert.equal(dataOf(await getCard(tdb, a.id)).decision.chosen, undefined);
  });
});

test("decideOption on an archived card is 409 archived", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT);
    await archiveCard(tdb, cdb, a.id, HUMAN);
    await rejects(decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes }), "archived", 409);
  });
});

test("decideOption: not found 404, a non-decision card 404, bad index 400", async () => {
  await withStore(async ({ tdb, cdb }) => {
    await rejects(decideOption(tdb, cdb, 999, { index: 0 }, HUMAN, { isEnabledBot: yes }), "not_found", 404);
    const plain = await createCard(tdb, { title: "plain", project_id: 1 }, HUMAN);
    await rejects(decideOption(tdb, cdb, plain.id, { index: 0 }, HUMAN, { isEnabledBot: yes }), "not_found", 404);
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT);
    await rejects(decideOption(tdb, cdb, a.id, { index: 2 }, HUMAN, { isEnabledBot: yes }), "bad_option", 400);
    await rejects(decideOption(tdb, cdb, a.id, { index: -2 }, HUMAN, { isEnabledBot: yes }), "bad_option", 400);
    await rejects(decideOption(tdb, cdb, a.id, { index: "0" }, HUMAN, { isEnabledBot: yes }), "bad_option", 400);
    await rejects(decideOption(tdb, cdb, a.id, { index: -1 }, HUMAN, { isEnabledBot: yes }), "bad_option", 400);
    await rejects(decideOption(tdb, cdb, a.id, { index: -1, otherText: "x".repeat(2001) }, HUMAN, { isEnabledBot: yes }), "bad_option", 400);
  });
});

test("decideOption Other… stores the text and creates no follow-up", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: withFollowUp() }, BOT);
    const r = await decideOption(tdb, cdb, a.id, { index: -1, otherText: "Wait for the weekend" }, HUMAN, { isEnabledBot: yes });
    assert.equal(r.created_card_id, null);
    assert.equal(r.chosen.index, -1);
    assert.equal(r.chosen.other_text, "Wait for the weekend");
    const d = dataOf(await getCard(tdb, a.id)).decision;
    assert.equal(d.chosen.other_text, "Wait for the weekend");
    assert.equal(await countCards(tdb), 1);
  });
});

// ---------------------------------------------------------------------------
// expireDecisions
// ---------------------------------------------------------------------------

test("expireDecisions moves expired cards to cancelled (or the first terminal) and stamps expired_at", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const t0 = Date.parse("2026-03-10T12:00:00Z");
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ expires: "2026-03-11" }) }, BOT, { now: t0 });
    const b = await askDecision(tdb, cdb, { projectId: 2, decision: decision({ fingerprint: "fp-b", expires: "2026-03-11" }) }, BOT, { now: t0 });
    const c = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-c", expires: "2026-03-20" }) }, BOT, { now: t0 });

    const later = Date.parse("2026-03-12T08:00:00Z");
    assert.equal(await expireDecisions(tdb, cdb, later), 2);
    const ca = await getCard(tdb, a.id);
    assert.equal(ca.status, "cancelled");
    assert.ok(dataOf(ca).decision.expired_at);
    assert.equal((await getCard(tdb, b.id)).status, "complete");
    assert.equal((await getCard(tdb, c.id)).status, "pending");
    assert.ok((await verbs(tdb, a.id)).includes("decision_expire"));

    assert.equal(await expireDecisions(tdb, cdb, later), 0, "already expired cards are not counted again");

    // An expired fingerprint does not dedupe a new ask.
    const again = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT, { now: later });
    assert.equal(again.deduped, false);
  });
});

test("askDecision expires stale cards first, freeing their batch slots", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const t0 = Date.parse("2026-03-10T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: `fp-${i}`, expires: "2026-03-11" }) }, BOT, { now: t0 });
    }
    const later = Date.parse("2026-03-15T12:00:00Z");
    const r = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-new" }) }, BOT, { now: later });
    assert.equal(r.deduped, false);
  });
});

// ---------------------------------------------------------------------------
// notifyBatch
// ---------------------------------------------------------------------------

function fakeNotifier() {
  const calls = [];
  return {
    calls,
    actor: BOT,
    // Records the row like the real sender, so the per-day cap can count it.
    createNotification: async (db, o) => {
      calls.push(o);
      await db.execute({
        sql: "INSERT INTO notifications (type, source, title, body, metadata) VALUES (?,?,?,?,?)",
        args: [o.type, o.source ?? null, o.title, o.body ?? null, o.metadata ? JSON.stringify(o.metadata) : null],
      });
      return { id: calls.length };
    },
  };
}

test("notifyBatch pushes once for the batch, then {pushed:false} on a second call", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: `fp-${i}`, question: `Q${i}?` }) }, BOT)).id);
    }
    await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-x", batch: "batch-2" }) }, BOT);

    const n = fakeNotifier();
    const r1 = await notifyBatch(tdb, cdb, "batch-1", n);
    assert.deepEqual(r1, { pushed: true, count: 4 });
    assert.equal(n.calls.length, 1);
    const call = n.calls[0];
    assert.equal(call.type, "attention");
    assert.equal(call.priority, "normal");
    assert.equal(call.title, "4 decisions waiting");
    assert.equal(call.body, "Q0?\nQ1?\nQ2?");
    assert.equal(call.action_url, "/dashboard/bot-board#card=" + ids[0]);
    for (const id of ids) assert.ok(dataOf(await getCard(tdb, id)).decision.notified_at);

    const r2 = await notifyBatch(tdb, cdb, "batch-1", n);
    assert.deepEqual(r2, { pushed: false, count: 0, reason: "already_notified" });
    assert.equal(n.calls.length, 1);
  });
});

test("notifyBatch: singular title for one decision; a card added after the push stays board-only", async () => {
  await withStore(async ({ tdb, cdb }) => {
    await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT);
    const n = fakeNotifier();
    await notifyBatch(tdb, cdb, "batch-1", n);
    assert.equal(n.calls[0].title, "1 decision waiting");
    await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-2" }) }, BOT);
    const r = await notifyBatch(tdb, cdb, "batch-1", n);
    assert.deepEqual(r, { pushed: false, count: 0, reason: "already_notified" });
    assert.equal(n.calls.length, 1);
  });
});

test("notifyBatch: two concurrent calls push once in total", async () => {
  await withStore(async ({ tdb, cdb }) => {
    for (let i = 0; i < 3; i++) {
      await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: `fp-${i}` }) }, BOT);
    }
    const n = fakeNotifier();
    const [a, b] = await Promise.all([notifyBatch(tdb, cdb, "batch-1", n), notifyBatch(tdb, cdb, "batch-1", n)]);
    assert.equal(n.calls.length, 1);
    assert.equal(a.count + b.count, 3);
    assert.equal([a, b].filter((r) => r.pushed).length, 1);
  });
});

test("notifyBatch skips decided, expired and archived cards", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-a" }) }, BOT);
    const b = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-b" }) }, BOT);
    await decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes });
    await archiveCard(tdb, cdb, b.id, HUMAN);
    const n = fakeNotifier();
    assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", n), { pushed: false, count: 0 });
    assert.equal(n.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------

for (const [rail, sql, args] of [
  ["job", "INSERT INTO bot_jobs (job_id, bot_id, card_id, card_action, status) VALUES (?,?,?,?,?)", (id) => ["job-x", "bot-1", id, "work", "running"]],
  ["session", "INSERT INTO bot_sessions (bot_id, card_id, status) VALUES (?,?,?)", (id) => ["bot-1", id, "active"]],
]) {
  test(`decideOption on a card held by a bot ${rail} is 409 locked and writes nothing`, async () => {
    await withStore(async ({ tdb, cdb }) => {
      const a = await askDecision(tdb, cdb, { projectId: 1, decision: withFollowUp() }, BOT);
      await cdb.execute({ sql, args: args(a.id) });
      await rejects(decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes }), "locked", 409);
      const card = await getCard(tdb, a.id);
      const d = dataOf(card).decision;
      assert.equal(d.chosen, undefined, "no chosen written");
      assert.equal(d.created_card_id, undefined);
      assert.equal(card.status, "pending");
      assert.equal(await countCards(tdb), 1, "no follow-up card");
      assert.ok(!(await verbs(tdb, a.id)).includes("decision"));
    });
  });
}

test("expireDecisions: a held lock keeps the status but still expires the decision", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const t0 = Date.parse("2026-03-10T12:00:00Z");
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ expires: "2026-03-11" }) }, BOT, { now: t0 });
    await cdb.execute({ sql: "INSERT INTO bot_sessions (bot_id, card_id, status) VALUES (?,?,?)", args: ["bot-1", a.id, "active"] });
    assert.equal(await expireDecisions(tdb, cdb, Date.parse("2026-03-13T00:00:00Z")), 1);
    const card = await getCard(tdb, a.id);
    assert.equal(card.status, "pending");
    assert.ok(dataOf(card).decision.expired_at);
  });
});

test("notifyBatch: a throwing createNotification releases the claims for the next call", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const ids = [];
    for (let i = 0; i < 2; i++) ids.push((await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: `fp-${i}` }) }, BOT)).id);
    const boom = async () => { throw new Error("push down"); };
    await assert.rejects(notifyBatch(tdb, cdb, "batch-1", { createNotification: boom, actor: BOT }), /push down/);
    for (const id of ids) assert.equal(dataOf(await getCard(tdb, id)).decision.notified_at, undefined);
    const n = fakeNotifier();
    assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", n), { pushed: true, count: 2 });
    assert.equal(n.calls.length, 1);
  });
});

test("validateDecision: optional strings are measured after trimming", () => {
  const v = validateDecision(decision({
    options: [{ ...opts()[0], value: "  " + "v".repeat(200) + "  " }, opts()[1]],
  }));
  assert.equal(v.options[0].value, "v".repeat(200));
  assert.throws(() => validateDecision(decision({
    options: [{ ...opts()[0], value: "v".repeat(201) }, opts()[1]],
  })), (e) => e.code === "bad_decision");
});

// ---------------------------------------------------------------------------
// notifyBatch authorization, batch idempotence and per-actor cap
// ---------------------------------------------------------------------------

const BOT2 = { kind: "bot", id: "bot-2", jobId: null };
const SESSION = { kind: "session", id: null, jobId: null };
const UNATTRIBUTED = { kind: "bot", id: null, jobId: null };

test("askDecision stores asked_by from the actor", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, { kind: "bot", id: "bot-1", jobId: "job-9" });
    assert.deepEqual(dataOf(await getCard(tdb, a.id)).decision.asked_by, { kind: "bot", id: "bot-1", job_id: "job-9" });
  });
});

test("notifyBatch: the 4th push of the day by one actor is 429 push_limit, claims untouched", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const n = fakeNotifier();
    const now = Date.parse("2026-05-01T10:00:00Z");
    const ask = (i, who) => askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: `fp-${i}`, batch: `b-${i}`, expires: "2026-05-20" }) }, who, { now });
    for (let i = 0; i < 3; i++) {
      await ask(i, BOT);
      // the 3rd push claims several cards in one statement at 2 pushes used
      if (i === 2) await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-2b", batch: "b-2", expires: "2026-05-20" }) }, BOT, { now });
      const r = await notifyBatch(tdb, cdb, `b-${i}`, { ...n, now });
      assert.deepEqual(r, { pushed: true, count: i === 2 ? 2 : 1 });
    }
    const a = await ask(4, BOT);
    await rejects(notifyBatch(tdb, cdb, "b-4", { ...n, now }), "push_limit", 429);
    assert.equal(n.calls.length, 3);
    assert.equal(dataOf(await getCard(tdb, a.id)).decision.notified_at, undefined);
    // another actor, and the next UTC day, are unaffected
    await ask(5, BOT2);
    assert.equal((await notifyBatch(tdb, cdb, "b-5", { ...n, actor: BOT2, now })).pushed, true);
    assert.equal((await notifyBatch(tdb, cdb, "b-4", { ...n, now: Date.parse("2026-05-02T00:30:00Z") })).pushed, true);
  });
});

test("notifyBatch: six parallel calls across six batches by one actor push exactly three", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const n = fakeNotifier();
    const now = Date.parse("2026-05-01T10:00:00Z");
    for (let i = 0; i < 6; i++) {
      await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: `fp-${i}`, batch: `b-${i}`, expires: "2026-05-20" }) }, BOT, { now });
    }
    const res = await Promise.allSettled([0, 1, 2, 3, 4, 5].map((i) => notifyBatch(tdb, cdb, `b-${i}`, { ...n, now })));
    assert.equal(n.calls.length, 3);
    assert.equal(res.filter((r) => r.status === "fulfilled" && r.value.pushed).length, 3);
    const refused = res.filter((r) => r.status === "rejected");
    assert.equal(refused.length, 3);
    for (const r of refused) assert.equal(r.reason.code, "push_limit");
  });
});

test("notifyBatch: a push failure clears all three notify fields", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT);
    await assert.rejects(notifyBatch(tdb, cdb, "batch-1", { createNotification: async () => { throw new Error("down"); }, actor: BOT }), /down/);
    const d = dataOf(await getCard(tdb, a.id)).decision;
    assert.equal(d.notified_at, undefined);
    assert.equal(d.notified_by, undefined);
    assert.equal(d.notify_stamp, undefined);
    assert.equal((await notifyBatch(tdb, cdb, "batch-1", { ...fakeNotifier() })).pushed, true);
  });
});

test("notifyBatch: a malformed data_json row elsewhere does not break the cap query", async () => {
  await withStore(async ({ tdb, cdb }) => {
    await tdb.execute({ sql: "INSERT INTO tasks_items (title, data_json) VALUES ('junk', ?)", args: ["{not json"] });
    await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT);
    assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", fakeNotifier()), { pushed: true, count: 1 });
  });
});

test("batches are per asker: two bots using the same name both succeed with separate caps, each notifies only its own", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const ids = { a: [], b: [] };
    for (let i = 0; i < 5; i++) {
      ids.a.push((await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: `a-${i}`, batch: "x" }) }, BOT)).id);
      ids.b.push((await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: `b-${i}`, batch: "x" }) }, BOT2)).id);
    }
    await rejects(askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "a-6", batch: "x" }) }, BOT), "batch_full", 429);
    await rejects(askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "b-6", batch: "x" }) }, BOT2), "batch_full", 429);

    const n = fakeNotifier();
    assert.deepEqual(await notifyBatch(tdb, cdb, "x", { ...n, actor: BOT2 }), { pushed: true, count: 5 });
    for (const id of ids.b) assert.ok(dataOf(await getCard(tdb, id)).decision.notified_at);
    for (const id of ids.a) assert.equal(dataOf(await getCard(tdb, id)).decision.notified_at, undefined, "bot-1's cards untouched");
    assert.deepEqual(await notifyBatch(tdb, cdb, "x", { ...n, actor: BOT }), { pushed: true, count: 5 });
    assert.equal(n.calls.length, 2);
  });
});

test("notifyBatch: a caller with no cards under that name pushes nothing; sessions and unattributed bots have their own namespaces", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-a" }) }, BOT);
    const u = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-u" }) }, UNATTRIBUTED);
    const s = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "fp-s" }) }, SESSION);
    const n = fakeNotifier();
    assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", { ...n, actor: BOT2 }), { pushed: false, count: 0 });
    assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", { ...n, actor: HUMAN }), { pushed: false, count: 0 });
    assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", { createNotification: n.createNotification }), { pushed: true, count: 1 }, "missing actor = unattributed bot");
    assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", { ...n, actor: SESSION }), { pushed: true, count: 1 });
    assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", { ...n, actor: BOT }), { pushed: true, count: 1 });
    for (const id of [a.id, u.id, s.id]) assert.ok(dataOf(await getCard(tdb, id)).decision.notified_at);
    assert.equal(n.calls.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Final review fixes
// ---------------------------------------------------------------------------

test("fingerprints are per asker: two bots with the same fingerprint each get their own card", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "same", batch: "x" }) }, BOT);
    const b = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "same", batch: "x", question: "Other wording?" }) }, BOT2);
    assert.notEqual(a.id, b.id);
    assert.equal(b.deduped, false);
    assert.equal((await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "same", batch: "x" }) }, BOT)).deduped, true);
    assert.equal(dataOf(await getCard(tdb, b.id)).decision.question, "Other wording?");
  });
});

test("snooze is per asker too", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const t0 = Date.parse("2026-03-10T12:00:00Z");
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "sn" }) }, BOT, { now: t0 });
    await decideOption(tdb, cdb, a.id, { index: 1 }, HUMAN, { isEnabledBot: yes, now: t0 }); // "Not now", snooze 7
    assert.equal((await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "sn" }) }, BOT, { now: t0 + 1000 })).deduped, true);
    assert.equal((await askDecision(tdb, cdb, { projectId: 1, decision: decision({ fingerprint: "sn" }) }, BOT2, { now: t0 + 1000 })).deduped, false);
  });
});

test("notifyBatch: a disabled notification type releases the claims, uses no cap slot and reports notifications_off", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT);
    const off = async () => null;
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", { createNotification: off, actor: BOT }), { pushed: false, count: 0, reason: "notifications_off" });
    }
    const d = dataOf(await getCard(tdb, a.id)).decision;
    assert.equal(d.notified_at, undefined);
    assert.equal(d.notified_by, undefined);
    assert.equal(d.notify_stamp, undefined);
    assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", fakeNotifier()), { pushed: true, count: 1 });
  });
});

test("notifyBatch expires overdue decisions first, so they are not pushed", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const t0 = Date.parse("2026-03-10T12:00:00Z");
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision({ expires: "2026-03-11" }) }, BOT, { now: t0 });
    const n = fakeNotifier();
    assert.deepEqual(await notifyBatch(tdb, cdb, "batch-1", { ...n, now: Date.parse("2026-03-13T00:00:00Z") }), { pushed: false, count: 0 });
    assert.equal(n.calls.length, 0);
    assert.ok(dataOf(await getCard(tdb, a.id)).decision.expired_at, "expired by the notify call");
  });
});

test("decideOption: if the follow-up card cannot be created, the decision is still audited and the error propagates", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: withFollowUp() }, BOT);
    await tdb.execute("CREATE TRIGGER boom BEFORE INSERT ON tasks_items WHEN NEW.title='Apply the fix' BEGIN SELECT RAISE(ABORT,'boom'); END");
    await assert.rejects(decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: yes }), /boom/);
    assert.ok(dataOf(await getCard(tdb, a.id)).decision.chosen, "chosen was written");
    assert.ok((await verbs(tdb, a.id)).includes("decision"), "audit row exists");
  });
});

test("a follow-up card inherits the decision card's tags unchanged; an untagged decision gives none", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const tagged = await askDecision(tdb, cdb, { projectId: 1, tags: "scope-a,extra", decision: withFollowUp() }, BOT);
    const plain = await askDecision(tdb, cdb, { projectId: 1, decision: withFollowUp({ title: "Other follow-up" }) }, BOT2);
    const r1 = await decideOption(tdb, cdb, tagged.id, { index: 0 }, HUMAN, { isEnabledBot: yes });
    const r2 = await decideOption(tdb, cdb, plain.id, { index: 0 }, HUMAN, { isEnabledBot: yes });
    assert.equal((await getCard(tdb, r1.created_card_id)).tags, "scope-a,extra");
    assert.equal((await getCard(tdb, r2.created_card_id)).tags, null);
  });
});

// ---------------------------------------------------------------------------
// Provenance: a decision follow-up never reads as operator-created
// ---------------------------------------------------------------------------

test("decideOption: the follow-up's create row carries via:'decision' and the decision card's id", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: withFollowUp() }, BOT);
    const r = await decideOption(tdb, cdb, a.id, { index: 0 }, HUMAN, { isEnabledBot: (id) => isEnabledBot(cdb, id) });
    const rows = (await tdb.execute({
      sql: "SELECT verb, actor_kind, detail_json FROM board_mutations WHERE item_id=? ORDER BY id",
      args: [r.created_card_id],
    })).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verb, "create");
    assert.equal(rows[0].actor_kind, "human", "the deciding actor is still recorded");
    assert.deepEqual(JSON.parse(rows[0].detail_json), { via: "decision", decision_card_id: a.id });
  });
});

test("createCard: the create row's detail is {} by default and createDetail when given", async () => {
  await withStore(async ({ tdb }) => {
    const plain = await createCard(tdb, { title: "plain", project_id: 1 }, HUMAN);
    const marked = await createCard(tdb, { title: "marked", project_id: 1 }, HUMAN, { createDetail: { via: "decision", decision_card_id: 7 } });
    const detail = async (id) => JSON.parse((await tdb.execute({
      sql: "SELECT detail_json FROM board_mutations WHERE item_id=? AND verb='create'", args: [id],
    })).rows[0].detail_json);
    assert.deepEqual(await detail(plain.id), {});
    assert.deepEqual(await detail(marked.id), { via: "decision", decision_card_id: 7 });
  });
});

test("askDecision: the decision card's own create row is unmarked (only follow-ups carry via)", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const a = await askDecision(tdb, cdb, { projectId: 1, decision: decision() }, BOT);
    const row = (await tdb.execute({
      sql: "SELECT detail_json FROM board_mutations WHERE item_id=? AND verb='create'", args: [a.id],
    })).rows[0];
    assert.deepEqual(JSON.parse(row.detail_json), {});
  });
});
