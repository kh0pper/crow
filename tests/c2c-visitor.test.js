// Task 7 part A of the Crow-to-Crow plan: the visitor side (a "visit" record, the
// invite/role/unshare handlers the receive pipeline runs inside its transaction, and
// the accept/decline/leave actions), plus the owner-side V6 fix (a re-invite of an
// accepted member tells its OLD instance directly).
// The bindings under test are the outbox contract (S1, S2, S4, S7, R4 at the top of
// servers/sharing/c2c/outbox.js), the plan's V1–V6 rulings, and the REAL
// `handleC2cFrame` for every frame-level case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { C2C_TABLES_SQL } from "../scripts/migrations/0016-crow-to-crow.mjs";
import { buildFrame } from "../servers/sharing/c2c/frames.js";
import { handleC2cFrame } from "../servers/sharing/c2c/receive.js";
import { inviteContact } from "../servers/sharing/c2c/owner.js";
import {
  acceptVisit, createVisitorHandlers, declineVisit, deleteLocalCopies, leaveVisit,
  listVisits, onInvite, onRole, onUnshare, VisitError,
} from "../servers/sharing/c2c/visitor.js";
import { fill, t } from "../servers/gateway/dashboard/shared/i18n.js";

const P1 = "1".repeat(32);
const E1 = "a".repeat(32);
const E2 = "c".repeat(32);
const E0 = "b".repeat(32); // an older membership's epoch (an invite that arrives late)

const LOCAL = "inst-visitor";   // THIS instance: the visitor
const OWNER_INST = "inst-owner"; // the owner's Crow that sent the invite

const OWNER_CROW = "crow:owner";
const FRIEND_CROW = "crow:friend";
const STRANGER_CROW = "crow:stranger";
const OWNER_CONTACT = 1;
const FRIEND_CONTACT = 2;
const STRANGER_CONTACT = 3;

const CONTACTS = [
  { id: OWNER_CONTACT, crowId: OWNER_CROW, name: "alex" },
  { id: FRIEND_CONTACT, crowId: FRIEND_CROW, name: "sam" },
  { id: STRANGER_CONTACT, crowId: STRANGER_CROW, name: "mallory" },
];

/**
 * init-db's OWN `project_members` block, read straight out of the script: the real
 * table with its real role CHECK, so the owner side of V6 is exercised against the
 * DDL production runs (a `commenter` is stored as `guest`).
 */
function initDbTable(label) {
  const src = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  const marker = `initTable("${label}", \``;
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `init-db has no "${label}" block`);
  const from = at + marker.length;
  const to = src.indexOf("`);", from);
  assert.notEqual(to, -1, `init-db's "${label}" block is unterminated`);
  return src.slice(from, to);
}

/**
 * A scratch crow.db with the real 0016 c2c DDL and everything either side touches:
 * the visitor's visit records, the receive pipeline's mark/flag tables, and the
 * owner's project + membership rows for the V6 case.
 *
 * Three contacts: 1 is the OWNER of the shared project (remote, from this Crow's
 * point of view), 2 is the contact being invited on the owner side of V6, 3 is a
 * contact who has nothing to do with the visit.
 */
async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "c2c-visitor-"));
  const dbPath = join(dir, "crow.db");
  const db = createDbClient(dbPath);
  await db.executeMultiple(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT, display_name TEXT,
      is_blocked INTEGER DEFAULT 0, ed25519_pubkey TEXT, request_status TEXT);
    CREATE TABLE project_spaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, archived_at TEXT);
  `);
  await db.executeMultiple(initDbTable("project_members table"));
  await db.execute("ALTER TABLE project_members ADD COLUMN accepted_at TEXT");
  await db.executeMultiple(`
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, source TEXT, title TEXT, body TEXT,
      priority TEXT DEFAULT 'normal', action_url TEXT, metadata TEXT, schedule_id INTEGER,
      expires_at TEXT, is_read INTEGER DEFAULT 0, is_dismissed INTEGER DEFAULT 0,
      snoozed_until TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings_overrides (
      key TEXT NOT NULL, instance_id TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0,
      PRIMARY KEY (key, instance_id));
    CREATE TABLE project_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
      actor_type TEXT NOT NULL, actor_id INTEGER, action TEXT NOT NULL,
      target TEXT, payload TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  await db.executeMultiple(C2C_TABLES_SQL);
  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey) VALUES
            (?, 'alex', NULL), (?, 'sam', ?), (?, 'mallory', NULL)`,
    args: [OWNER_CROW, FRIEND_CROW, "a".repeat(64), STRANGER_CROW],
  });
  // The project this Crow OWNS (V6's side of the fixture), with its local owner row:
  // every owner action is gated on `manage_members`.
  const project = await db.execute({
    sql: "INSERT INTO project_spaces (uuid, slug, name) VALUES (?, 'labs', 'Labs')",
    args: [P1],
  });
  const projectId = Number(project.lastInsertRowid);
  await db.execute({
    sql: "INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')",
    args: [projectId],
  });

  return {
    dir, dbPath, db, projectId,
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

/** PT-3: the per-contact cb pin contact-binding.js reads (`value >= 1`). */
async function pin(db, crowId, instanceId = OWNER_INST) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value)
          VALUES (?, ?, '1')
          ON CONFLICT(key, instance_id) DO UPDATE SET value = excluded.value`,
    args: [`contact_hs_cb:${crowId}`, instanceId],
  });
}

const contactByCrowId = async (crowId) => {
  const c = CONTACTS.find((x) => x.crowId === crowId);
  return c ? { id: c.id, crow_id: c.crowId, display_name: c.name } : null;
};

/** Deliver one payload through the REAL receive pipeline; returns the frames it sent. */
async function deliver(payload, {
  db, crowId = OWNER_CROW, proof = "cb", handlers = null, localInstanceId = LOCAL,
  sent = [], peerInstanceId = OWNER_INST,
}) {
  await handleC2cFrame({
    db,
    send: (toCrowId, frame) => { sent.push({ crowId: toCrowId, frame }); },
    localInstanceId,
    contactByCrowId,
    handlers: handlers ?? { onInvite, onRole, onUnshare },
  }, crowId, payload, { proof, instanceId: peerInstanceId });
  return sent;
}

const acks = (sent) => sent.filter((x) => x.frame.kind === "project.ack");
const refusals = (sent) => sent.filter((x) => x.frame.kind === "project.refuse");

const inviteFrame = ({
  epoch = E1, gen = 1, name = "Labs", role = "viewer", seq = 1,
  toInstanceId = null, ownerInstanceId = OWNER_INST, fromInstanceId = OWNER_INST, projectUuid = P1,
} = {}) => buildFrame({
  kind: "project.invite",
  projectUuid,
  epoch,
  seq,
  fromInstanceId,
  toInstanceId,
  body: { name, role, owner_instance_id: ownerInstanceId, gen },
});

const roleFrame = ({
  epoch = E1, role = "editor", seq = 1, toInstanceId = LOCAL,
  fromInstanceId = OWNER_INST, projectUuid = P1,
} = {}) => buildFrame({
  kind: "project.role", projectUuid, epoch, seq,
  fromInstanceId, toInstanceId, body: { role },
});

const unshareFrame = ({
  epoch = E1, seq = 1, toInstanceId = LOCAL, fromInstanceId = OWNER_INST, projectUuid = P1,
} = {}) => buildFrame({
  kind: "project.unshare", projectUuid, epoch, seq,
  fromInstanceId, toInstanceId, body: {},
});

async function visitRows(db) {
  const { rows } = await db.execute("SELECT * FROM c2c_visits ORDER BY id");
  return rows;
}

async function visitRow(db, ownerContactId = OWNER_CONTACT) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM c2c_visits WHERE owner_contact_id = ? ORDER BY id DESC LIMIT 1",
    args: [ownerContactId],
  });
  return rows[0] ?? null;
}

async function outbox(db, kind = null) {
  const { rows } = await db.execute({
    sql: kind ? "SELECT * FROM c2c_outbox WHERE kind = ? ORDER BY id" : "SELECT * FROM c2c_outbox ORDER BY id",
    args: kind ? [kind] : [],
  });
  return rows;
}

async function titles(db) {
  const { rows } = await db.execute("SELECT title, type FROM notifications ORDER BY id");
  return rows.map((r) => r.title);
}

async function count(db, table) {
  const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0].n);
}

const isVisitError = (code) => (err) => err instanceof VisitError && err.code === code;

/* --------------------------------------------- V1: the invite handler */

test("invite creates an invited visit; re-invite after decline resets it", async () => {
  await withDb(async ({ db }) => {
    const sent = await deliver(inviteFrame(), { db });
    assert.equal(acks(sent).length, 1, "the invite is acked");
    assert.equal(refusals(sent).length, 0);

    let visit = await visitRow(db);
    assert.ok(visit, "the visit record exists");
    assert.equal(visit.owner_contact_id, OWNER_CONTACT, "attributed to the ADMITTED contact");
    assert.equal(visit.project_uuid, P1);
    assert.equal(visit.name, "Labs");
    assert.equal(visit.role, "viewer", "the Crow-to-Crow role, not the owner's `guest` spelling");
    assert.equal(visit.epoch, E1);
    assert.equal(visit.gen, 1);
    assert.equal(visit.owner_instance_id, OWNER_INST);
    assert.equal(visit.state, "invited");
    assert.equal(visit.accepted_at, null);
    assert.equal(visit.ended_at, null);
    const firstId = Number(visit.id);

    // The visitor declined; the invitation is over but the row stays (its generation
    // is what a later invite has to beat).
    await declineVisit(db, { visitId: firstId, localInstanceId: LOCAL });
    visit = await visitRow(db);
    assert.equal(visit.state, "declined");
    assert.notEqual(visit.ended_at, null);

    // A newer invite re-opens the SAME row as a fresh, unanswered invitation.
    const resent = await deliver(inviteFrame({ epoch: E2, gen: 2, name: "Labs Two", role: "commenter", seq: 1 }), { db });
    assert.equal(acks(resent).length, 1, "a greater generation supersedes the declined visit");
    visit = await visitRow(db);
    assert.equal(Number(visit.id), firstId, "the row is reused (UNIQUE owner contact + project)");
    assert.equal(visit.state, "invited");
    assert.equal(visit.name, "Labs Two");
    assert.equal(visit.role, "commenter");
    assert.equal(visit.epoch, E2, "the new membership's epoch");
    assert.equal(visit.gen, 2);
    assert.equal(visit.accepted_at, null, "accepted_at is cleared");
    assert.equal(visit.ended_at, null, "and so is ended_at");

    assert.deepEqual(await titles(db), [
      "alex invited you to Labs",
      "alex invited you to Labs Two",
    ], "one notification per invitation");
  });
});

test("a higher-gen invite supersedes an ACTIVE visit; a lower or equal one is refused", async () => {
  await withDb(async ({ db }) => {
    await deliver(inviteFrame(), { db });
    const visitId = Number((await visitRow(db)).id);
    await acceptVisit(db, { visitId, localInstanceId: LOCAL });
    assert.equal((await visitRow(db)).state, "active");

    // S2: a newer invite needs no unshare first — it IS an implicit unshare, so the
    // replaced visit's copies are cleaned here (its own unshare may arrive late, stale).
    const cleaned = [];
    const superseding = createVisitorHandlers({ deleteCopies: async (v) => { cleaned.push(Number(v.id)); } });
    const sent = await deliver(inviteFrame({ epoch: E2, gen: 2, role: "editor", seq: 1 }), { db, handlers: superseding });
    assert.deepEqual(cleaned, [visitId], "the superseded active visit's copies are deleted");
    assert.equal(acks(sent).length, 1);
    assert.equal(refusals(sent).length, 0, "the newer generation is not refused");
    let visit = await visitRow(db);
    assert.equal(Number(visit.id), visitId, "the same visit row");
    assert.equal(visit.state, "invited", "the active visit is replaced");
    assert.equal(visit.epoch, E2);
    assert.equal(visit.gen, 2);
    assert.equal(visit.role, "editor");
    assert.equal(visit.accepted_at, null);

    // An OLD invite that arrived late (its own epoch's stream, so dedupe is not what
    // saves us) is `stale_epoch` and changes nothing.
    const stale = await deliver(inviteFrame({ epoch: E0, gen: 1, seq: 1 }), { db });
    assert.equal(refusals(stale).length, 1);
    assert.equal(refusals(stale)[0].frame.body.reason, "stale_epoch");
    assert.equal(acks(stale).length, 0);
    visit = await visitRow(db);
    assert.equal(visit.epoch, E2, "the stale invite left the visit alone");
    assert.equal(visit.gen, 2);

    // An EQUAL generation is refused too (S2: `gen <= visit.gen` is stale).
    const equal = await deliver(inviteFrame({ epoch: "d".repeat(32), gen: 2, seq: 1 }), { db });
    assert.equal(refusals(equal)[0]?.frame.body.reason, "stale_epoch");
    assert.equal((await visitRow(db)).epoch, E2);

    // And its seq was consumed with no effect (R4), so the frames after it still land:
    // the old epoch's "*" stream now has its mark.
    const { rows: marks } = await db.execute({
      sql: `SELECT high_water FROM c2c_inbound_seq
             WHERE contact_id = ? AND sender_instance_id = ? AND project_uuid = ?
               AND epoch = ? AND stream = '*'`,
      args: [OWNER_CONTACT, OWNER_INST, P1, E0],
    });
    assert.equal(Number(marks[0]?.high_water), 1, "the refused invite consumed its seq");
    assert.deepEqual((await outbox(db)).map((r) => r.kind), ["project.accept"],
      "a refused invite queues nothing (the accept from earlier is the only frame)");
  });
});

test("onRole rewrites the role and keeps the epoch", async () => {
  await withDb(async ({ db }) => {
    await deliver(inviteFrame(), { db });
    const sent = await deliver(roleFrame({ role: "editor" }), { db });
    assert.equal(acks(sent).length, 1);
    const visit = await visitRow(db);
    assert.equal(visit.role, "editor");
    assert.equal(visit.epoch, E1, "a role change KEEPS the epoch (S7)");
    assert.equal(visit.state, "invited");
    assert.deepEqual(await titles(db), ["alex invited you to Labs"], "a role change is quiet");
  });
});

test("a frame from a NON-owner contact for the visit is forbidden", async () => {
  await withDb(async ({ db }) => {
    await deliver(inviteFrame(), { db });
    const before = await visitRow(db);

    // The stranger is a real contact, but has no visit for this project: the visit
    // rule keys on the ADMITTED contact, never on a frame field. (A first INVITE from
    // a stranger is not refused — that is how an invitation arrives at all, S2 — so
    // the frames under test are the ones that would change the existing visit.)
    const role = await deliver(roleFrame({ role: "editor" }), { db, crowId: STRANGER_CROW });
    assert.equal(refusals(role).length, 1);
    assert.equal(refusals(role)[0].frame.body.reason, "forbidden");
    assert.equal(acks(role).length, 0);
    assert.deepEqual(await visitRow(db), before, "the visit is untouched");

    // The stranger's own stream took seq 1 with the refused role frame (R4 consumed
    // it), so this one names the next seq on that stream.
    const unshare = await deliver(unshareFrame({ seq: 2 }), { db, crowId: STRANGER_CROW });
    assert.equal(refusals(unshare)[0]?.frame.body.reason, "forbidden");
    assert.deepEqual(await visitRow(db), before, "and an unshare from them changes nothing either");
    assert.equal((await visitRows(db)).length, 1, "no visit was created for the stranger");
    assert.equal(await count(db, "notifications"), 1, "only the owner's own invite notified");
  });
});

/* ----------------------------------------------------- V1: the unshare */

test("unshare ends the visit", async () => {
  await withDb(async ({ db }) => {
    await deliver(inviteFrame(), { db });
    const visitId = Number((await visitRow(db)).id);
    await acceptVisit(db, { visitId, localInstanceId: LOCAL });
    assert.equal((await visitRow(db)).state, "active");

    const cleaned = [];
    const handlers = createVisitorHandlers({ deleteCopies: async (v) => { cleaned.push(v.id); } });
    const sent = await deliver(unshareFrame(), { db, handlers });
    assert.equal(acks(sent).length, 1);
    assert.equal(refusals(sent).length, 0);

    const visit = await visitRow(db);
    assert.equal(visit.state, "unshared");
    assert.notEqual(visit.ended_at, null, "and it has an end time");
    assert.deepEqual(cleaned, [visitId], "the plan-2 cleanup hook ran for this visit");
    assert.deepEqual(await titles(db), [
      "alex invited you to Labs",
      "alex stopped sharing Labs",
    ], "one notification for the unshare");

    // Plan 1's hook exists and is a no-op: exporting it is what plan 2 fills in.
    assert.equal(typeof deleteLocalCopies, "function");
    assert.equal(await deleteLocalCopies(visit), undefined);
  });
});

test("an unshare before accept rides the '*' stream and still ends the visit", async () => {
  await withDb(async ({ db }) => {
    await deliver(inviteFrame(), { db });
    // The owner revoked before the visitor answered: no instance to aim at (O2), so
    // the frame rides the SAME "*" stream as the invite and takes the next seq there.
    const sent = await deliver(unshareFrame({ toInstanceId: null, seq: 2 }), { db });
    assert.equal(acks(sent).length, 1);
    assert.equal(refusals(sent).length, 0);
    assert.equal((await visitRow(db)).state, "unshared");
  });
});

/* ------------------------------------------- V5: the visitor's list */

test("listVisits reports sanitized names, the role and the state", async () => {
  await withDb(async ({ db }) => {
    await deliver(inviteFrame({ name: "\u202E Labs ", role: "commenter" }), { db });
    const list = await listVisits(db);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], {
      id: Number((await visitRow(db)).id),
      ownerContactId: OWNER_CONTACT,
      ownerName: "alex",
      projectName: "Labs",
      role: "commenter",
      state: "invited",
      invitedAt: (await visitRow(db)).invited_at,
    }, "the bidi override and the control character are gone from the project name");

    // A name the sanitiser refuses leaves an empty project name, never the raw string.
    await db.execute({
      sql: "UPDATE c2c_visits SET name = ? WHERE owner_contact_id = ?",
      args: ["crow:not-a-name", OWNER_CONTACT],
    });
    assert.equal((await listVisits(db))[0].projectName, "");
  });
});

/* ---------------------------------------------------- V2: the actions */

test("accept enqueues to the owner instance", async () => {
  await withDb(async ({ db }) => {
    await deliver(inviteFrame(), { db });
    const visit = await visitRow(db);
    const flushed = [];

    await acceptVisit(db, {
      visitId: Number(visit.id),
      localInstanceId: LOCAL,
      flushAfter: async ({ contactId }) => { flushed.push(contactId); return 0; },
    });

    const after = await visitRow(db);
    assert.equal(after.state, "active");
    assert.notEqual(after.accepted_at, null, "the acceptance is recorded");

    const rows = await outbox(db, "project.accept");
    assert.equal(rows.length, 1, "one accept frame");
    assert.equal(rows[0].contact_id, OWNER_CONTACT, "queued for the owner contact");
    assert.equal(rows[0].epoch, E1, "on the visit's epoch");
    assert.equal(rows[0].to_instance_id, OWNER_INST, "aimed at the instance that invited us");
    const frame = JSON.parse(rows[0].frame_json);
    assert.equal(frame.kind, "project.accept");
    assert.equal(frame.from_instance_id, LOCAL, "sent by this instance");
    assert.equal(frame.to_instance_id, OWNER_INST);
    assert.equal(frame.epoch, E1);
    assert.deepEqual(frame.body, { visitor_instance_id: LOCAL });

    assert.deepEqual(flushed, [OWNER_CONTACT], "the flush ran once, for the owner contact");
  });
});

test("the action state rules: accept only from invited, leave only from active", async () => {
  await withDb(async ({ db }) => {
    const visitId = async () => Number((await visitRow(db)).id);

    // declined → accept is refused
    await deliver(inviteFrame(), { db });
    const firstId = await visitId();
    await declineVisit(db, { visitId: firstId, localInstanceId: LOCAL });
    await assert.rejects(
      () => acceptVisit(db, { visitId: firstId, localInstanceId: LOCAL }),
      isVisitError("bad_state"),
      "a declined visit cannot be accepted",
    );
    // active → accept twice is refused
    await deliver(inviteFrame({ epoch: E2, gen: 2 }), { db });
    const secondId = await visitId();
    await acceptVisit(db, { visitId: secondId, localInstanceId: LOCAL });
    await assert.rejects(
      () => acceptVisit(db, { visitId: secondId, localInstanceId: LOCAL }),
      isVisitError("bad_state"),
    );
    // active → decline is refused
    await assert.rejects(
      () => declineVisit(db, { visitId: secondId, localInstanceId: LOCAL }),
      isVisitError("bad_state"),
      "a plain decline is only an answer to an invitation",
    );
    // invited → leave is refused
    await deliver(inviteFrame({ epoch: "d".repeat(32), gen: 3 }), { db });
    const thirdId = await visitId();
    await assert.rejects(
      () => leaveVisit(db, { visitId: thirdId, localInstanceId: LOCAL }),
      isVisitError("bad_state"),
      "there is nothing to leave before accepting",
    );
    // active → leave is the one that works
    await acceptVisit(db, { visitId: thirdId, localInstanceId: LOCAL });
    await leaveVisit(db, { visitId: thirdId, localInstanceId: LOCAL });
    const left = await visitRow(db);
    assert.equal(left.state, "left");
    assert.notEqual(left.ended_at, null);

    const declines = await outbox(db, "project.decline");
    assert.equal(declines.length, 2, "the declined invitation and the leave, nothing more");
    assert.deepEqual(JSON.parse(declines[0].frame_json).body, { reason: "declined" });
    assert.deepEqual(JSON.parse(declines[1].frame_json).body, { reason: "left" });
    assert.equal((await outbox(db, "project.accept")).length, 2, "no extra accept was queued");
    assert.equal((await visitRow(db)).epoch, "d".repeat(32), "the state stayed consistent");
  });
});

test("an unknown visit and an unusable instance id are clear errors", async () => {
  await withDb(async ({ db }) => {
    await deliver(inviteFrame(), { db });
    const visitId = Number((await visitRow(db)).id);

    await assert.rejects(() => acceptVisit(db, { visitId: 999, localInstanceId: LOCAL }), isVisitError("not_found"));
    await assert.rejects(() => acceptVisit(db, { visitId, localInstanceId: "" }), isVisitError("bad_instance_id"));
    await assert.rejects(() => acceptVisit(db, { visitId, localInstanceId: "has spaces" }), isVisitError("bad_instance_id"));
    await assert.rejects(() => leaveVisit(db, { visitId: 0, localInstanceId: LOCAL }), isVisitError("bad_argument"));
    assert.equal((await visitRow(db)).state, "invited", "nothing changed");
    assert.equal(await count(db, "c2c_outbox"), 0, "and nothing was queued");
  });
});

test("nothing flushed inside the transaction: the send sees the committed row", async () => {
  await withDb(async (s) => {
    const { db } = s;
    await deliver(inviteFrame(), { db });
    const visitId = Number((await visitRow(db)).id);

    // A second connection can never see an uncommitted row, so reading the outbox and
    // the visit through it inside the send spy proves the flush ran AFTER COMMIT (S4).
    const observer = createDbClient(s.dbPath);
    const seen = [];
    const send = async (frame) => {
      const { rows } = await observer.execute("SELECT kind, epoch, to_instance_id FROM c2c_outbox ORDER BY id");
      const { rows: visit } = await observer.execute({
        sql: "SELECT state, accepted_at FROM c2c_visits WHERE id = ?", args: [visitId],
      });
      seen.push({ sent: frame.kind, rows, visit: visit[0] });
    };
    try {
      await acceptVisit(db, { visitId, localInstanceId: LOCAL, send });
      assert.equal(seen.length, 1, "one frame flushed");
      assert.deepEqual(seen[0].rows.map((r) => r.kind), ["project.accept"],
        "the accept row was already committed when it was sent");
      assert.equal(seen[0].rows[0].to_instance_id, OWNER_INST);
      assert.equal(seen[0].visit.state, "active", "and so was the state change");
      assert.notEqual(seen[0].visit.accepted_at, null);

      // The same for leave: the frame and the state are committed before the send.
      seen.length = 0;
      await leaveVisit(db, { visitId, localInstanceId: LOCAL, send });
      assert.deepEqual(seen[0].rows.map((r) => r.kind), ["project.accept", "project.decline"]);
      assert.equal(seen[0].visit.state, "left");
    } finally {
      observer.close();
    }
  });
});

/* ------------------------------ V1: notifications only after COMMIT (W1/S7) */

/**
 * The real pipeline, with the visitor handlers' fan-out swapped for a spy. The spy
 * reads the visit row and the notification table through a SECOND connection: an
 * uncommitted row is invisible there, so what it sees proves the hook ran after
 * COMMIT — and after the ack.
 */
test("W1: an invite's notification is delivered only after COMMIT and the ack", async () => {
  await withDb(async (s) => {
    const { db } = s;
    const observer = createDbClient(s.dbPath);
    const events = [];
    const spy = createVisitorHandlers({
      deliver: async (_db, payload) => {
        const { rows } = await observer.execute("SELECT state, epoch FROM c2c_visits");
        const { rows: notes } = await observer.execute("SELECT title FROM notifications ORDER BY id");
        events.push({ at: "deliver", title: payload.title, visit: rows[0] ?? null, notes: notes.map((n) => n.title) });
      },
    });
    try {
      await deliver(inviteFrame(), { db, handlers: spy });
    } finally {
      observer.close();
    }
    // Notifications: exactly one, and it was fanned out after the row was committed.
    const delivered = events.filter((e) => e.at === "deliver");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].title, "alex invited you to Labs");
    assert.equal(delivered[0].visit.state, "invited",
      "another connection sees the committed visit: the fan-out ran after COMMIT");
    assert.deepEqual(delivered[0].notes, ["alex invited you to Labs"],
      "the row itself was written in the transaction");
    assert.equal(await count(db, "notifications"), 1);
  });
});

test("W1: the after-commit hook runs after the ack, and a dup invite delivers nothing", async () => {
  await withDb(async ({ db }) => {
    const events = [];
    const handlers = createVisitorHandlers({
      deliver: async (_db, payload) => { events.push({ at: "deliver", title: payload.title }); },
    });
    const payload = inviteFrame();

    const sent = [];
    await handleC2cFrame({
      db,
      send: (_crowId, frame) => { events.push({ at: frame.kind }); sent.push(frame); },
      localInstanceId: LOCAL,
      contactByCrowId,
      handlers,
    }, OWNER_CROW, payload, { proof: "cb", instanceId: OWNER_INST });

    assert.equal(events.filter((e) => e.at === "deliver").length, 1);
    const order = events.map((e) => e.at);
    assert.ok(order.indexOf("project.ack") >= 0, order.join(","));
    assert.ok(order.indexOf("project.ack") < order.indexOf("deliver"), "after the ack");

    // The same frame again is a dup: re-acked, handler not run, hook dropped.
    events.length = 0;
    await handleC2cFrame({
      db,
      send: (_crowId, frame) => { events.push({ at: frame.kind }); },
      localInstanceId: LOCAL,
      contactByCrowId,
      handlers,
    }, OWNER_CROW, payload, { proof: "cb", instanceId: OWNER_INST });
    assert.deepEqual(events.map((e) => e.at), ["project.ack"], "a dup is re-acked only");
    assert.equal(await count(db, "notifications"), 1, "and writes no second notification row");
  });
});

test("W1: an unshare's notification is delivered only after COMMIT", async () => {
  await withDb(async (s) => {
    const { db } = s;
    await deliver(inviteFrame(), { db });
    const visitId = Number((await visitRow(db)).id);

    const observer = createDbClient(s.dbPath);
    const seen = [];
    const handlers = createVisitorHandlers({
      deliver: async (_db, payload) => {
        const { rows } = await observer.execute({
          sql: "SELECT state, ended_at FROM c2c_visits WHERE id = ?", args: [visitId],
        });
        seen.push({ title: payload.title, visit: rows[0] });
      },
    });
    try {
      await deliver(unshareFrame(), { db, handlers });
    } finally {
      observer.close();
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].title, "alex stopped sharing Labs");
    assert.equal(seen[0].visit.state, "unshared", "committed before the fan-out");
    assert.notEqual(seen[0].visit.ended_at, null);
  });
});

/* --------------------------------------- V6: the owner tells the old instance */

test("V6: re-inviting an accepted member unshares the old epoch with the old instance, then invites", async () => {
  await withDb(async (s) => {
    const { db } = s;
    await pin(db, FRIEND_CROW);
    const first = await inviteContact(db, {
      projectId: s.projectId, contactId: FRIEND_CONTACT, role: "viewer",
      localInstanceId: OWNER_INST, now: 1000,
    });
    // The friend's Crow accepted from `LOCAL`: the membership now lives there.
    await db.execute({
      sql: `UPDATE project_members SET accepted_at = datetime('now'), origin_instance_id = ?
             WHERE project_id = ? AND contact_id = ? AND revoked_at IS NULL`,
      args: [LOCAL, s.projectId, FRIEND_CONTACT],
    });

    const second = await inviteContact(db, {
      projectId: s.projectId, contactId: FRIEND_CONTACT, role: "commenter",
      localInstanceId: OWNER_INST, now: 2000,
    });
    assert.notEqual(second.memberUuid, first.memberUuid, "a re-invite is a new membership");

    const rows = await outbox(db);
    assert.deepEqual(rows.map((r) => r.kind),
      ["project.invite", "project.unshare", "project.invite"],
      "the old invite, then the old membership's unshare, then the new invite");

    const [oldInvite, oldUnshare, newInvite] = rows;
    assert.equal(oldInvite.epoch, first.memberUuid);
    assert.notEqual(oldInvite.acked_at, null, "S6: the old invite is cancelled");
    assert.equal(oldInvite.last_refusal, "cancelled");

    assert.equal(oldUnshare.epoch, first.memberUuid, "the unshare names the OLD epoch");
    assert.equal(oldUnshare.to_instance_id, LOCAL, "and is aimed at the OLD instance directly");
    assert.equal(oldUnshare.acked_at, null, "it survives the cancelEpoch pass (queued after it)");
    assert.deepEqual(JSON.parse(oldUnshare.frame_json).body, {});

    assert.equal(newInvite.epoch, second.memberUuid, "the new invite carries the new epoch");
    assert.equal(newInvite.to_instance_id, null, "an invite rides the '*' stream (S1)");
    assert.equal(newInvite.acked_at, null);
    const gen2 = JSON.parse(newInvite.frame_json).body.gen;
    const gen1 = JSON.parse(oldInvite.frame_json).body.gen;
    assert.ok(gen2 > gen1, `S2: the re-invite's generation is greater (${gen1} → ${gen2})`);

    /* The visitor's side of the same story: the friend's Crow holds an ACTIVE visit
     * at the old epoch, on `LOCAL`. The unshare the owner just queued ends it, and
     * the re-invite that follows re-opens it at the new epoch — in that order. */
    await db.execute({
      sql: `INSERT INTO c2c_visits
              (owner_contact_id, project_uuid, name, role, epoch, gen, owner_instance_id,
               state, accepted_at)
            VALUES (?, ?, 'Labs', 'viewer', ?, ?, ?, 'active', datetime('now'))`,
      args: [FRIEND_CONTACT, P1, first.memberUuid, gen1, OWNER_INST],
    });

    const sentUnshare = await deliver(JSON.parse(oldUnshare.frame_json), {
      db, crowId: FRIEND_CROW, peerInstanceId: OWNER_INST,
    });
    assert.equal(acks(sentUnshare).length, 1, "the old instance accepted the old-epoch unshare");
    let visit = await visitRow(db, FRIEND_CONTACT);
    assert.equal(visit.state, "unshared");
    assert.equal(visit.epoch, first.memberUuid);

    const sentInvite = await deliver(JSON.parse(newInvite.frame_json), {
      db, crowId: FRIEND_CROW, peerInstanceId: OWNER_INST,
    });
    assert.equal(acks(sentInvite).length, 1);
    visit = await visitRow(db, FRIEND_CONTACT);
    assert.equal(visit.state, "invited", "the re-invite re-opens the visit");
    assert.equal(visit.epoch, second.memberUuid);
    assert.equal(visit.role, "commenter");
  });
});

test("V6: a re-invite of a member that never accepted queues no unshare", async () => {
  await withDb(async (s) => {
    const { db } = s;
    await pin(db, FRIEND_CROW);
    await inviteContact(db, {
      projectId: s.projectId, contactId: FRIEND_CONTACT, role: "viewer",
      localInstanceId: OWNER_INST, now: 1000,
    });
    await inviteContact(db, {
      projectId: s.projectId, contactId: FRIEND_CONTACT, role: "viewer",
      localInstanceId: OWNER_INST, now: 2000,
    });
    const kinds = (await outbox(db)).map((r) => r.kind);
    assert.deepEqual(kinds, ["project.invite", "project.invite"],
      "no instance holds the old membership, so there is nobody to unshare with");
  });
});

/* ------------------------------------------------------- the i18n surface */

test("the visitor's notification strings exist in en and es", async () => {
  const names = { contact: "alex", project: "Labs" };
  assert.equal(fill(t("c2c.notify.invited"), names), "alex invited you to Labs");
  assert.equal(fill(t("c2c.notify.invited", "es"), names), "alex te invitó a Labs");
  assert.equal(fill(t("c2c.notify.unshared"), names), "alex stopped sharing Labs");
  assert.equal(fill(t("c2c.notify.unshared", "es"), names), "alex dejó de compartir Labs");
});