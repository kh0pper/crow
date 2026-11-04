// Task 5 of the Crow-to-Crow plan: the receive pipeline and per-frame
// authorization. Every kind handler is a stub here (the real owner/visitor
// handlers are Tasks 6 and 7); two scratch DB files or one stand in for the
// node's own crow.db. The pipeline order and the S1–S7/R2/R4–R9 contract at the
// top of servers/sharing/c2c/outbox.js are the things under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { C2C_TABLES_SQL } from "../scripts/migrations/0016-crow-to-crow.mjs";
import { buildFrame } from "../servers/sharing/c2c/frames.js";
import { handleC2cFrame, C2C_UPDATE_REQUIRED_PREFIX, C2C_MARK_CAP } from "../servers/sharing/c2c/receive.js";
import { c2cCan, liveMember, memberRole, CONTACT_CAPS_JSON } from "../servers/sharing/c2c/authz.js";
import { CAPABILITY_KEYS } from "../servers/shared/project-acl.js";

const CROW = "crow:peer";
const CONTACT = 1;
const LOCAL = "inst-local";
const PEER = "inst-peer";
const OTHER = "inst-other";
const P1 = "1".repeat(32);
const EPOCH = "a".repeat(32);
const OLD_EPOCH = "b".repeat(32);
const NEW_EPOCH = "c".repeat(32);

/** A scratch crow.db with the 0016 c2c DDL and the tables the pipeline reads. */
async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "c2c-receive-"));
  const dbPath = join(dir, "crow.db");
  const db = createDbClient(dbPath);
  await db.executeMultiple(`
    CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT, display_name TEXT, is_blocked INTEGER DEFAULT 0);
    CREATE TABLE project_spaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE TABLE project_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, project_id INTEGER NOT NULL,
      contact_id INTEGER, role TEXT NOT NULL, capabilities TEXT, mode TEXT,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT, origin_instance_id TEXT,
      accepted_at TEXT);
    CREATE TABLE c2c_effect_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT);
    CREATE TABLE dashboard_settings_overrides (
      key TEXT NOT NULL, instance_id TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0,
      PRIMARY KEY (key, instance_id));
  `);
  await db.executeMultiple(C2C_TABLES_SQL);
  await db.executeMultiple("INSERT INTO contacts (crow_id, display_name) VALUES ('crow:peer', 'Peer')");
  return {
    dir, dbPath, db,
    close() { try { db.close(); } catch {} },
    dispose() { this.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function withDb(fn) {
  const s = await fresh();
  try {
    return await fn(s);
  } finally {
    s.dispose();
  }
}

async function addProject(db, uuid = P1, name = "Labs") {
  const r = await db.execute({
    sql: "INSERT INTO project_spaces (uuid, slug, name) VALUES (?, ?, ?)",
    args: [uuid, `labs-${uuid.slice(0, 6)}`, name],
  });
  return Number(r.lastInsertRowid);
}

async function addMember(db, projectId, over = {}) {
  const m = {
    contactId: CONTACT, role: "viewer", mode: "live", uuid: EPOCH,
    acceptedAt: null, revokedAt: null, ...over,
  };
  await db.execute({
    sql: `INSERT INTO project_members (project_id, contact_id, role, mode, uuid, accepted_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [projectId, m.contactId, m.role, m.mode, m.uuid, m.acceptedAt, m.revokedAt],
  });
}

async function addVisit(db, over = {}) {
  const v = {
    ownerContactId: CONTACT, projectUuid: P1, name: "Labs", role: "viewer",
    epoch: EPOCH, gen: 1, ownerInstanceId: PEER, state: "invited", ...over,
  };
  await db.execute({
    sql: `INSERT INTO c2c_visits
            (owner_contact_id, project_uuid, name, role, epoch, gen, owner_instance_id, state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [v.ownerContactId, v.projectUuid, v.name, v.role, v.epoch, v.gen, v.ownerInstanceId, v.state],
  });
}

const BODIES = {
  "project.invite": { name: "Labs", role: "viewer", owner_instance_id: PEER, gen: 1 },
  "project.accept": { visitor_instance_id: LOCAL },
  "project.decline": {},
  "project.role": { role: "editor" },
  "project.unshare": {},
  "project.ack": { epoch: EPOCH, stream: "inst-v", seqs: [1] },
  "project.refuse": { epoch: EPOCH, stream: "inst-v", seq: 1, reason: "gap" },
};

/** Build a valid frame; ack/refuse are unsequenced and carry no envelope epoch/seq. */
function mk(kind, over = {}) {
  const noSeq = kind === "project.ack" || kind === "project.refuse";
  return buildFrame({
    kind,
    projectUuid: P1,
    epoch: noSeq ? undefined : EPOCH,
    seq: noSeq ? undefined : 1,
    fromInstanceId: PEER,
    toInstanceId: LOCAL,
    body: BODIES[kind],
    ...over,
  });
}

const contactByCrowId = async (crowId) =>
  (crowId === CROW ? { id: CONTACT, crow_id: CROW, display_name: "Peer" } : null);

/** Deliver one payload through the real pipeline; returns the frames it sent. */
async function deliver(db, payload, { proof = "cb", handlers = {}, sent = [] } = {}) {
  await handleC2cFrame({
    db,
    send: (crowId, frame) => { sent.push({ crowId, frame }); },
    localInstanceId: LOCAL,
    contactByCrowId,
    handlers,
  }, CROW, payload, { proof, instanceId: PEER });
  return sent;
}

const refusals = (sent) => sent.filter((s) => s.frame.kind === "project.refuse");
const acks = (sent) => sent.filter((s) => s.frame.kind === "project.ack");

async function highWater(db, { epoch = EPOCH, stream = LOCAL, projectUuid = P1 } = {}) {
  const { rows } = await db.execute({
    sql: `SELECT high_water FROM c2c_inbound_seq
           WHERE contact_id = ? AND sender_instance_id = ? AND project_uuid = ?
             AND epoch = ? AND stream = ?`,
    args: [CONTACT, PEER, projectUuid, epoch, stream],
  });
  return Number(rows[0]?.high_water ?? 0);
}

/** A handler that records its invocations (and, when asked, writes and/or throws). */
function recorder(name, body) {
  const calls = [];
  const handler = async (db, args) => {
    calls.push(args);
    if (body) await body(db, args);
  };
  return { name, handler, calls };
}

const noopHandlers = () => {
  const calls = [];
  const handlers = {};
  for (const name of ["onInvite", "onAccept", "onDecline", "onRole", "onUnshare"]) {
    handlers[name] = async () => { calls.push(name); };
  }
  return { handlers, calls };
};

/** Capture `console.warn` lines for the block (the pipeline logs there, never bodies). */
async function withWarnings(fn) {
  const lines = [];
  const real = console.warn;
  console.warn = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    await fn(lines);
  } finally {
    console.warn = real;
  }
}

/** The flag the UI reads (R5) — null when it is not set. */
async function updateFlag(db, crowId = CROW) {
  const row = (await db.execute({
    sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
    args: [C2C_UPDATE_REQUIRED_PREFIX + crowId, LOCAL],
  })).rows[0];
  return row?.value ?? null;
}

/* --------------------------------------------------------------- proof */

test("sig proof refused update_required (the flag is recorded and no handler runs)", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    const { handlers, calls } = noopHandlers();
    const sent = await deliver(db, mk("project.role"), { proof: "sig", handlers });

    assert.deepEqual(calls, [], "the effect never ran");
    const refused = refusals(sent);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].frame.body.reason, "update_required");
    assert.equal(refused[0].frame.to_instance_id, PEER, "the refusal answers the sender");
    assert.equal(refused[0].frame.body.epoch, EPOCH);
    assert.equal(refused[0].frame.body.stream, LOCAL);

    // R5: update_required HOLDS, so the seq is not consumed.
    assert.equal(await highWater(db), 0, "the sender keeps the frame until its Crow updates");

    const flag = (await db.execute({
      sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
      args: [C2C_UPDATE_REQUIRED_PREFIX + CROW, LOCAL],
    })).rows[0];
    assert.equal(flag?.value, "1", "the owner's UI can read the per-contact flag");

    // An ack/refuse from a legacy session has no stream to hold or answer.
    assert.deepEqual(await deliver(db, mk("project.ack"), { proof: "sig" }), [], "no reply to an ack");
  });
});

/* ------------------------------------------------------------- routing */

test("wrong to_instance_id is not_home", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    const { handlers, calls } = noopHandlers();
    const sent = await deliver(db, mk("project.role", { toInstanceId: OTHER }), { handlers });

    assert.deepEqual(calls, []);
    assert.equal(refusals(sent).length, 1);
    assert.equal(refusals(sent)[0].frame.body.reason, "not_home");
    assert.equal(refusals(sent)[0].frame.body.stream, OTHER, "the refusal names the frame's own stream");
    assert.equal(await highWater(db, { stream: OTHER }), 0, "not_home holds the seq for the right instance");
  });
});

test("null target allowed only for invite", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    // An invite before the visitor's instance is known rides the "*" stream.
    const invite = recorder("onInvite");
    const sent = await deliver(db, mk("project.invite", { toInstanceId: null }), { handlers: { onInvite: invite.handler } });
    assert.equal(invite.calls.length, 1, "the invite is processed");
    assert.deepEqual(invite.calls[0].frame.body, BODIES["project.invite"]);
    assert.equal(acks(sent).length, 1);
    assert.equal(acks(sent)[0].frame.body.stream, "*");
    assert.equal(await highWater(db, { stream: "*" }), 1);

    // A sequenced non-invite with no target names nobody: not_home, held.
    const role = recorder("onRole");
    const bad = await deliver(db, mk("project.role", { toInstanceId: null }), { handlers: { onRole: role.handler } });
    assert.equal(role.calls.length, 0);
    assert.equal(refusals(bad)[0].frame.body.reason, "not_home");
    assert.equal(await highWater(db, { stream: "*" }), 1, "the '*' mark did not move");
  });
});

/* -------------------------------------------------------------- dedupe */

test("dup re-acks without re-running the handler", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    await addVisit(db);
    const role = recorder("onRole");
    const handlers = { onRole: role.handler };

    const first = await deliver(db, mk("project.role"), { handlers });
    assert.equal(role.calls.length, 1);
    assert.equal(acks(first).length, 1);
    assert.equal(await highWater(db), 1);

    const again = await deliver(db, mk("project.role"), { handlers });
    assert.equal(role.calls.length, 1, "the effect ran once");
    assert.equal(acks(again).length, 1, "the duplicate is re-acked");
    assert.equal(refusals(again).length, 0);
    assert.equal(await highWater(db), 1);
  });
});

test("gap is refused and high_water unchanged", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    await addVisit(db);
    const role = recorder("onRole");
    const sent = await deliver(db, mk("project.role", { seq: 2 }), { handlers: { onRole: role.handler } });

    assert.equal(role.calls.length, 0);
    assert.equal(refusals(sent).length, 1);
    assert.equal(refusals(sent)[0].frame.body.reason, "gap");
    assert.equal(await highWater(db), 0, "the missing frame can still land");
  });
});

/* ------------------------------------------------------- the failure path */

test("a handler throw logs without the body, rolls back, consumes the seq and refuses unsupported", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => { warnings.push(a.map(String).join(" ")); };
    try {
      const sent = await deliver(db, mk("project.invite", {
        body: { ...BODIES["project.invite"], name: "SECRETBODY" },
      }), {
        handlers: {
          async onInvite(handle) {
            await handle.execute({ sql: "INSERT INTO c2c_effect_probe (note) VALUES ('partial')", args: [] });
            throw new Error("boom");
          },
        },
      });

      const probe = (await db.execute("SELECT COUNT(*) AS n FROM c2c_effect_probe")).rows[0].n;
      assert.equal(probe, 0, "the effect rolled back with the mark");
      assert.equal(await highWater(db), 1, "R4: the seq is consumed so the stream is not wedged");
      assert.equal(acks(sent).length, 0, "a failed frame is not acked");
      assert.equal(refusals(sent).length, 1);
      assert.equal(refusals(sent)[0].frame.body.reason, "unsupported");

      const log = warnings.filter((l) => l.startsWith("[c2c] project.invite failed:"));
      assert.equal(log.length, 1);
      assert.match(log[0], /boom/);
      assert.equal(warnings.some((l) => l.includes("SECRETBODY")), false, "never the contact's text");
    } finally {
      console.warn = realWarn;
    }
  });
});

/* -------------------------------------------------------- authorization */

test("stale epoch after re-invite is refused", async () => {
  await withDb(async ({ db }) => {
    const projectId = await addProject(db);
    // The re-invite already rotated the membership epoch (Task 6's invite).
    await addMember(db, projectId, { uuid: NEW_EPOCH, acceptedAt: null });

    const accept = recorder("onAccept");
    const sent = await deliver(db, mk("project.accept", { epoch: OLD_EPOCH }), { handlers: { onAccept: accept.handler } });

    assert.equal(accept.calls.length, 0, "the old membership's frame must not apply");
    assert.equal(refusals(sent).length, 1);
    assert.equal(refusals(sent)[0].frame.body.reason, "stale_epoch");
    assert.equal(refusals(sent)[0].frame.body.epoch, OLD_EPOCH);
    const row = (await db.execute({ sql: "SELECT accepted_at FROM project_members WHERE project_id = ?", args: [projectId] })).rows[0];
    assert.equal(row.accepted_at, null, "the new membership is untouched");

    assert.equal(await highWater(db, { epoch: OLD_EPOCH }), 1, "R4: the dead stream's seq is consumed");
    assert.equal(await highWater(db, { epoch: NEW_EPOCH }), 0, "the live membership's stream is untouched");
  });
});

test("a late role from the old membership is refused stale_epoch on the visit side", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    // The re-invite replaced the visit's membership epoch.
    await addVisit(db, { epoch: NEW_EPOCH, gen: 2 });
    const role = recorder("onRole");
    const sent = await deliver(db, mk("project.role", { epoch: OLD_EPOCH }), { handlers: { onRole: role.handler } });

    assert.equal(role.calls.length, 0, "it must not apply to the new visit");
    assert.equal(refusals(sent)[0].frame.body.reason, "stale_epoch");
    assert.equal(await highWater(db, { epoch: OLD_EPOCH }), 1, "the old stream's seq is consumed");
    assert.equal(await highWater(db, { epoch: NEW_EPOCH }), 0, "the current visit's stream is untouched");
  });
});

test("the role map and the contact capability mask", () => {
  assert.equal(c2cCan("viewer", "read"), true);
  assert.equal(c2cCan("viewer", "comment"), false);
  assert.equal(c2cCan("commenter", "read"), true);
  assert.equal(c2cCan("commenter", "comment"), true);
  assert.equal(c2cCan("commenter", "propose"), false);
  for (const action of ["read", "comment", "propose", "add"]) assert.equal(c2cCan("editor", action), true, action);
  assert.equal(c2cCan("owner", "read"), false, "owners are local only");

  assert.equal(memberRole({ role: "viewer" }), "viewer");
  assert.equal(memberRole({ role: "guest" }), "commenter");
  assert.equal(memberRole({ role: "editor" }), "editor");
  assert.equal(memberRole({ role: "owner" }), null);

  const caps = JSON.parse(CONTACT_CAPS_JSON);
  assert.deepEqual(Object.keys(caps).sort(), [...CAPABILITY_KEYS].sort());
  for (const key of CAPABILITY_KEYS) assert.equal(caps[key], false, key);
});

test("no live row is forbidden", async () => {
  await withDb(async ({ db }) => {
    await addProject(db); // no project_members row at all
    const accept = recorder("onAccept");
    const sent = await deliver(db, mk("project.accept"), { handlers: { onAccept: accept.handler } });

    assert.equal(accept.calls.length, 0);
    assert.equal(refusals(sent)[0].frame.body.reason, "forbidden");
    assert.equal(await highWater(db), 1, "a terminal refusal consumes the seq");
  });
});

test("a clone-mode row is forbidden", async () => {
  await withDb(async ({ db }) => {
    const projectId = await addProject(db);
    // The old crow_share copy row is not a Crow-to-Crow authorization (spec §9.1).
    await addMember(db, projectId, { mode: "clone", acceptedAt: "2026-01-01 00:00:00" });
    assert.equal(await liveMember(db, { projectUuid: P1, contactId: CONTACT }), null);

    const accept = recorder("onAccept");
    const sent = await deliver(db, mk("project.accept"), { handlers: { onAccept: accept.handler } });
    assert.equal(accept.calls.length, 0);
    assert.equal(refusals(sent)[0].frame.body.reason, "forbidden");
  });
});

test("accept twice: the second is dup", async () => {
  await withDb(async ({ db }) => {
    const projectId = await addProject(db);
    await addMember(db, projectId, { acceptedAt: null });
    const accept = recorder("onAccept");
    const handlers = { onAccept: accept.handler };

    const first = await deliver(db, mk("project.accept"), { handlers });
    assert.equal(accept.calls.length, 1);
    assert.equal(acks(first).length, 1);

    const second = await deliver(db, mk("project.accept"), { handlers });
    assert.equal(accept.calls.length, 1, "the handler is not re-run");
    assert.equal(acks(second).length, 1, "the duplicate is re-acked");
    assert.equal(await highWater(db), 1);
  });
});

/* ----------------------------------------------------- acks and refusals */

test("a sibling's ack is dropped, never answered not_home", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    // An owner's queued frame, on the stream the ack names.
    const queue = async (seq) => db.execute({
      sql: `INSERT INTO c2c_outbox (contact_id, project_uuid, epoch, seq, kind, to_instance_id, frame_json)
            VALUES (?, ?, ?, ?, 'project.role', 'inst-v', '{}')`,
      args: [CONTACT, P1, EPOCH, seq],
    });
    await queue(1);
    await queue(2);

    // Aimed at another owner instance: dropped with no reply at all (S3).
    const dropped = await deliver(db, mk("project.ack", { toInstanceId: OTHER }));
    assert.deepEqual(dropped, [], "no ack, no not_home, no reply");
    let row = (await db.execute({ sql: "SELECT acked_at FROM c2c_outbox WHERE seq = 1", args: [] })).rows[0];
    assert.equal(row.acked_at, null, "the sibling's queue is untouched");

    // Aimed here: applied.
    await deliver(db, mk("project.ack", {
      toInstanceId: LOCAL,
      body: { epoch: EPOCH, stream: "inst-v", seqs: [2] },
    }));
    row = (await db.execute({ sql: "SELECT acked_at FROM c2c_outbox WHERE seq = 2", args: [] })).rows[0];
    assert.ok(row.acked_at, "the named instance applies it");
  });
});

test("a refusal aimed here is recorded and surfaced; a sibling's is dropped", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    const queue = async (seq) => db.execute({
      sql: `INSERT INTO c2c_outbox (contact_id, project_uuid, epoch, seq, kind, to_instance_id, frame_json)
            VALUES (?, ?, ?, ?, 'project.role', 'inst-v', '{}')`,
      args: [CONTACT, P1, EPOCH, seq],
    });
    await queue(1);
    await queue(2);

    const seen = [];
    const handlers = { onRefusal: async (args) => { seen.push(args); } };
    const body = (seq) => ({ epoch: EPOCH, stream: "inst-v", seq, reason: "forbidden" });

    // A sibling of the owner sees the refusal its peer sent to the asker: drop it.
    assert.deepEqual(await deliver(db, mk("project.refuse", { toInstanceId: OTHER, body: body(1) }), { handlers }), []);
    assert.deepEqual(seen, []);
    assert.equal((await db.execute({ sql: "SELECT acked_at FROM c2c_outbox WHERE seq = 1", args: [] })).rows[0].acked_at, null);

    // Aimed here: recorded (terminal, so the row ends) and surfaced.
    await deliver(db, mk("project.refuse", { toInstanceId: LOCAL, body: body(2) }), { handlers });
    assert.ok((await db.execute({ sql: "SELECT acked_at FROM c2c_outbox WHERE seq = 2", args: [] })).rows[0].acked_at);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, "forbidden");
    assert.equal(seen[0].terminal, "forbidden");
  });
});

/* -------------------------------------------------- envelopes and unknown kinds */

test("a broken envelope is dropped with no reply", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    const sent = [];
    const broken = {
      type: "c2c", v: 1, kind: "project.role", project_uuid: "not-hex",
      epoch: EPOCH, seq: 1, from_instance_id: PEER, to_instance_id: LOCAL, body: { role: "viewer" },
    };
    await deliver(db, broken, { sent });
    // An unknown kind with a broken envelope is still bad_frame: nothing to name.
    await deliver(db, { ...broken, kind: "project.future" }, { sent });

    assert.deepEqual(sent, [], "an unparseable envelope cannot be refused: no stream to name");
    assert.equal(await highWater(db), 0);
  });
});

test("an unknown kind at seq n consumes it, so seq n+1 is new", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    await addVisit(db);
    const future = {
      type: "c2c", v: 1, kind: "project.future", project_uuid: P1,
      epoch: EPOCH, seq: 1, from_instance_id: PEER, to_instance_id: LOCAL, body: {},
    };
    const unknown = await deliver(db, future);
    assert.equal(refusals(unknown)[0].frame.body.reason, "unsupported");
    assert.equal(await highWater(db), 1, "R4: the unknown kind's seq is consumed");

    const role = recorder("onRole");
    const next = await deliver(db, mk("project.role", { seq: 2 }), { handlers: { onRole: role.handler } });
    assert.equal(role.calls.length, 1, "the stream is not wedged");
    assert.equal(acks(next).length, 1);
    assert.equal(refusals(next).length, 0);
    assert.equal(await highWater(db), 2);
  });
});

/* ------------------------------------------------------------- concurrency */

test("two concurrent deliveries: one runs the handler, the other re-acks as a dup", async () => {
  await withDb(async ({ db }) => {
    const projectId = await addProject(db);
    await addMember(db, projectId, { acceptedAt: null });

    const sent = [];
    const calls = [];
    const handlers = {
      async onAccept(handle) {
        calls.push(1);
        await handle.execute({ sql: "INSERT INTO c2c_effect_probe (note) VALUES ('accept')", args: [] });
      },
    };
    const ctx = {
      db,
      send: (crowId, frame) => { sent.push({ crowId, frame }); },
      localInstanceId: LOCAL,
      contactByCrowId,
      handlers,
    };
    const payload = mk("project.accept");
    await Promise.all([
      handleC2cFrame(ctx, CROW, payload, { proof: "cb", instanceId: PEER }),
      handleC2cFrame(ctx, CROW, payload, { proof: "cb", instanceId: PEER }),
    ]);

    assert.equal(calls.length, 1, "exactly one delivery ran the handler");
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM c2c_effect_probe")).rows[0].n, 1);
    assert.equal(acks(sent).length, 2, "both deliveries are acked (one commit, one dup)");
    assert.equal(refusals(sent).length, 0);
    assert.equal(await highWater(db), 1);
  });
});

/* ------------------------------------------------- F1: a missing handler holds */

test("F1: a frame for a kind with no handler gets busy, and the mark is unchanged", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    await addVisit(db);
    await withWarnings(async (lines) => {
      const sent = await deliver(db, mk("project.role"), { handlers: {} });

      assert.equal(refusals(sent).length, 1);
      assert.equal(refusals(sent)[0].frame.body.reason, "busy", "busy holds the frame, it does not end it");
      assert.equal(refusals(sent)[0].frame.to_instance_id, PEER);
      assert.equal(acks(sent).length, 0);
      assert.equal(await highWater(db), 0, "a held frame keeps its seq: nothing was consumed");
      assert.ok(
        lines.includes("[c2c] project.role handler not loaded"),
        `the load failure is visible: ${JSON.stringify(lines)}`,
      );
    });
  });
});

test("F1: after the handler appears, the re-sent frame applies", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    await addVisit(db);

    const first = await deliver(db, mk("project.role"), { handlers: {} });
    assert.equal(refusals(first)[0].frame.body.reason, "busy");
    assert.equal(await highWater(db), 0);

    // The module loaded (boot retries the load): the sender re-sends the same frame.
    const role = recorder("onRole");
    const again = await deliver(db, mk("project.role"), { handlers: { onRole: role.handler } });
    assert.equal(role.calls.length, 1, "the held frame applies once its handler exists");
    assert.equal(acks(again).length, 1);
    assert.equal(refusals(again).length, 0);
    assert.equal(await highWater(db), 1);
  });
});

/* ------------------------------------- F2: authorization inside the transaction */

test("F2: a re-invite committed just before the transaction makes the old frame stale_epoch", async () => {
  await withDb(async ({ db }) => {
    const projectId = await addProject(db);
    await addMember(db, projectId, { uuid: EPOCH, acceptedAt: null });

    const accept = recorder("onAccept");
    const sent = [];
    const ctx = {
      db,
      send: (crowId, frame) => { sent.push({ crowId, frame }); },
      localInstanceId: LOCAL,
      contactByCrowId,
      handlers: { onAccept: accept.handler },
      // The test seam: the re-invite commits between the frame's arrival (dedupe
      // already ran) and its transaction's BEGIN.
      beforeTransaction: async () => {
        await db.execute({
          sql: "UPDATE project_members SET uuid = ?, accepted_at = NULL WHERE project_id = ?",
          args: [NEW_EPOCH, projectId],
        });
      },
    };

    await handleC2cFrame(ctx, CROW, mk("project.accept"), { proof: "cb", instanceId: PEER });

    assert.deepEqual(accept.calls, [], "the old-epoch frame never applies to the new membership");
    assert.equal(refusals(sent).length, 1);
    assert.equal(refusals(sent)[0].frame.body.reason, "stale_epoch",
      "authorization read the membership inside the transaction");
    assert.equal(await highWater(db), 1, "R4: the refused frame's seq is consumed");
    const row = (await db.execute({ sql: "SELECT accepted_at, uuid FROM project_members WHERE project_id = ?", args: [projectId] })).rows[0];
    assert.equal(row.accepted_at, null, "the new membership is untouched");
    assert.equal(row.uuid, NEW_EPOCH);
  });
});

/* ----------------------------- F3: a known kind with a bad body consumes and refuses */

test("F3: an invite with an unknown role at seq n is consumed, so seq n+1 is new", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    await addVisit(db);
    const invite = recorder("onInvite");
    const bad = mk("project.invite", { body: { ...BODIES["project.invite"], role: "owner" } });
    const sent = await deliver(db, bad, { handlers: { onInvite: invite.handler } });

    assert.equal(invite.calls.length, 0, "a body we cannot read never reaches the handler");
    assert.equal(refusals(sent).length, 1);
    assert.equal(refusals(sent)[0].frame.body.reason, "bad_frame", "the envelope parsed, so it can be refused");
    assert.equal(await highWater(db), 1, "R4: the seq of the bad body is consumed");

    const role = recorder("onRole");
    const next = await deliver(db, mk("project.role", { seq: 2 }), { handlers: { onRole: role.handler } });
    assert.equal(role.calls.length, 1, "the stream is not wedged behind the bad body");
    assert.equal(acks(next).length, 1);
    assert.equal(refusals(next).length, 0);
    assert.equal(await highWater(db), 2);
  });
});

/* ----------------- F4: unknown kinds and bad bodies pass proof + routing first */

const futureFrame = (over = {}) => ({
  type: "c2c", v: 1, kind: "project.future", project_uuid: P1,
  epoch: EPOCH, seq: 1, from_instance_id: PEER, to_instance_id: LOCAL, body: {},
  ...over,
});
const badBodyInvite = (over = {}) => mk("project.invite", {
  body: { ...BODIES["project.invite"], role: "owner" },
  ...over,
});

test("F4: an unknown kind or a bad body on the legacy proof is held update_required", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);

    const unknown = await deliver(db, futureFrame(), { proof: "sig" });
    assert.equal(refusals(unknown).length, 1);
    assert.equal(refusals(unknown)[0].frame.body.reason, "update_required");

    const badBody = await deliver(db, badBodyInvite(), { proof: "sig" });
    assert.equal(refusals(badBody).length, 1);
    assert.equal(refusals(badBody)[0].frame.body.reason, "update_required");

    assert.equal(await highWater(db), 0, "R5/F4: a holding refusal consumes nothing");
  });
});

test("F4: an unknown kind or a bad body aimed elsewhere is held not_home; aimed here it consumes", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);

    const unknown = await deliver(db, futureFrame({ to_instance_id: OTHER }));
    assert.equal(refusals(unknown).length, 1);
    assert.equal(refusals(unknown)[0].frame.body.reason, "not_home");
    assert.equal(await highWater(db, { stream: OTHER }), 0, "not_home holds the seq for the right instance");

    const badBody = await deliver(db, badBodyInvite({ toInstanceId: OTHER }));
    assert.equal(refusals(badBody).length, 1);
    assert.equal(refusals(badBody)[0].frame.body.reason, "not_home");
    assert.equal(await highWater(db, { stream: OTHER }), 0, "and so does the bad body");

    // Only a frame aimed here (or a null target where that is allowed) consumes.
    const consumed = await deliver(db, futureFrame(), { proof: "cb" });
    assert.equal(refusals(consumed)[0].frame.body.reason, "unsupported");
    assert.equal(await highWater(db), 1);
  });
});

/* ------------------------------------------------------- F5: the mark row cap */

test("F5: at the cap a new stream is dropped with no reply; an existing stream still applies", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    // One existing stream (the default delivery address) plus C2C_MARK_CAP - 1 others.
    await db.execute({
      sql: `INSERT INTO c2c_inbound_seq
              (contact_id, sender_instance_id, project_uuid, epoch, stream, high_water)
            VALUES (?, ?, ?, ?, ?, 0)`,
      args: [CONTACT, PEER, P1, EPOCH, LOCAL],
    });
    const filler = Array.from({ length: C2C_MARK_CAP - 1 }, (_, i) => i);
    await db.execute({
      sql: `INSERT INTO c2c_inbound_seq
              (contact_id, sender_instance_id, project_uuid, epoch, stream, high_water)
            VALUES ${filler.map(() => "(?, ?, ?, ?, ?, 0)").join(", ")}`,
      args: filler.flatMap((i) => [CONTACT, PEER, P1, i.toString(16).padStart(32, "0"), `inst-x-${i}`]),
    });
    const rowCount = async () => Number((await db.execute({
      sql: "SELECT COUNT(*) AS n FROM c2c_inbound_seq WHERE contact_id = ?", args: [CONTACT],
    })).rows[0].n);
    assert.equal(await rowCount(), C2C_MARK_CAP, "the contact is at the cap");

    await addVisit(db, { epoch: NEW_EPOCH });
    const role = recorder("onRole");
    await withWarnings(async (lines) => {
      // A NEW stream (a new epoch) would create row 513: dropped whole.
      const capped = await deliver(db, mk("project.role", { epoch: NEW_EPOCH }), { handlers: { onRole: role.handler } });
      assert.deepEqual(capped, [], "no reply at all: not an ack, not a refusal");
      assert.equal(await highWater(db, { epoch: NEW_EPOCH }), 0, "no mark was created");
      assert.equal(await rowCount(), C2C_MARK_CAP, "the table did not grow");

      // Once per contact per hour, not once per dropped frame.
      await deliver(db, mk("project.role", { epoch: "d".repeat(32) }), { handlers: { onRole: role.handler } });
      const capLines = lines.filter((l) => l === `[c2c] mark cap reached for contact ${CONTACT}`);
      assert.equal(capLines.length, 1, `logged once per hour: ${JSON.stringify(lines)}`);
    });
    assert.equal(role.calls.length, 0, "a capped frame never reaches the handler");

    // The existing stream always keeps working.
    await db.execute({
      sql: "UPDATE c2c_visits SET epoch = ? WHERE owner_contact_id = ? AND project_uuid = ?",
      args: [EPOCH, CONTACT, P1],
    });
    const sent = await deliver(db, mk("project.role"), { handlers: { onRole: role.handler } });
    assert.equal(role.calls.length, 1, "an existing stream still applies at the cap");
    assert.equal(acks(sent).length, 1);
    assert.equal(await highWater(db), 1);
    assert.equal(await rowCount(), C2C_MARK_CAP, "still one row per stream");
  });
});

/* ------------------------------------------------- F6: the update flag is cleared */

test("F6: a cb frame clears the contact's update_required flag", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    await addVisit(db);

    // A legacy frame set the flag (R5).
    await deliver(db, mk("project.role"), { proof: "sig", handlers: {} });
    assert.equal(await updateFlag(db), "1", "the UI is told to ask them to update");

    // The next frame arrives on the bound proof: the flag is stale now.
    const role = recorder("onRole");
    const sent = await deliver(db, mk("project.role"), { handlers: { onRole: role.handler } });
    assert.equal(await updateFlag(db), null, "the flag is deleted");
    assert.equal(role.calls.length, 1);
    assert.equal(acks(sent).length, 1);
    assert.equal(await highWater(db), 1);
  });
});

/* -------------------------------------------------- F7: the missing test cases */

test("F7: decline {reason:'left'} after accept is allowed, a plain decline is forbidden", async () => {
  await withDb(async ({ db }) => {
    const projectId = await addProject(db);
    await addMember(db, projectId, { acceptedAt: "2026-01-01 00:00:00" });

    const left = recorder("onDecline");
    const first = await deliver(db, mk("project.decline", { body: { reason: "left" } }), {
      handlers: { onDecline: left.handler },
    });
    assert.equal(left.calls.length, 1, "leaving an accepted membership is allowed");
    assert.equal(left.calls[0].frame.body.reason, "left");
    assert.equal(acks(first).length, 1);
    assert.equal(refusals(first).length, 0);

    const plain = recorder("onDecline");
    const second = await deliver(db, mk("project.decline", { seq: 2 }), {
      handlers: { onDecline: plain.handler },
    });
    assert.equal(plain.calls.length, 0, "a plain decline only answers an outstanding invite");
    assert.equal(refusals(second).length, 1);
    assert.equal(refusals(second)[0].frame.body.reason, "forbidden");
    assert.equal(await highWater(db), 2, "both seqs are settled");
  });
});

test("F7: an invite from an older generation through the pipeline is refused stale_epoch", async () => {
  await withDb(async ({ db }) => {
    await addProject(db);
    // The visit already came from generation 2; BODIES carries gen 1.
    await addVisit(db, { gen: 2, epoch: NEW_EPOCH });

    const invite = recorder("onInvite");
    const sent = await deliver(db, mk("project.invite", { toInstanceId: null }), {
      handlers: { onInvite: invite.handler },
    });

    assert.equal(invite.calls.length, 0, "an old invite never replaces the current visit");
    assert.equal(refusals(sent).length, 1);
    assert.equal(refusals(sent)[0].frame.body.reason, "stale_epoch");
    assert.equal(await highWater(db, { stream: "*" }), 1, "R4: the old invite's seq is consumed");
  });
});