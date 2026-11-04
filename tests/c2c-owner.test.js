// Task 6 of the Crow-to-Crow plan: the owner side — invite, role, unshare, and
// the accept/decline handlers the receive pipeline runs inside its transaction.
// The bindings under test are the outbox contract (S1, S2, S4, S6, S7 at the top
// of servers/sharing/c2c/outbox.js), the orchestrator's O1–O6, and the real
// `handleC2cFrame` for the accept/decline/left cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { C2C_TABLES_SQL } from "../scripts/migrations/0016-crow-to-crow.mjs";
import { buildFrame } from "../servers/sharing/c2c/frames.js";
import { handleC2cFrame } from "../servers/sharing/c2c/receive.js";
import {
  authorizeOwnerFrame, CONTACT_CAPS_JSON, memberRole,
} from "../servers/sharing/c2c/authz.js";
import {
  inviteContact, setRole, unshareContact, listLiveMembers, onAccept, onDecline,
  createOwnerHandlers,
} from "../servers/sharing/c2c/owner.js";
import { AclError, CAPABILITY_KEYS, effectiveCapabilities } from "../servers/shared/project-acl.js";
import { fill, t } from "../servers/gateway/dashboard/shared/i18n.js";

const P1 = "1".repeat(32);
const CLONE_EPOCH = "c".repeat(32);
const VISIT_EPOCH = "e".repeat(32);
const LOCAL = "inst-local";
const VISITOR = "inst-visitor";
const PEER = "inst-peer";
const CROW = "crow:peer";
const UNBOUND = "crow:unbound";
const KEYED = "crow:keyed";
const CONTACT = 1;
const UNBOUND_CONTACT = 2;
const KEYED_CONTACT = 3;

/**
 * init-db's OWN `project_members` block, read straight out of the script (W5): the
 * real table with its real role CHECK, so "a commenter is stored as guest" is tested
 * against the constraint the database actually enforces, not a weaker copy.
 * `accepted_at` is added the way init-db adds it (addColumnIfMissing, on the line
 * right after the block) — the same shape both rails converge on.
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
 * A scratch crow.db with the real 0016 c2c DDL and the tables the owner side and
 * the receive pipeline touch. `project_members` is init-db's own DDL (above) and the
 * project has its local OWNER row: every owner action is gated on
 * `manage_members` (W3), exactly like the panel and the MCP tools.
 * Three contacts: 1 is bound (pinned key + cb pin), 2 has no key at all, 3 has the
 * key but no pin.
 */
async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "c2c-owner-"));
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
            (?, 'alex', ?), (?, 'unbound', ''), (?, 'keyed', ?)`,
    args: [CROW, "a".repeat(64), UNBOUND, KEYED, "b".repeat(64)],
  });
  const project = await db.execute({
    sql: "INSERT INTO project_spaces (uuid, slug, name) VALUES (?, 'labs', 'Labs')",
    args: [P1],
  });
  const projectId = Number(project.lastInsertRowid);
  // The caller is the project's local owner: W3 gates every owner action on
  // manage_members, which the owner role carries by default.
  await db.execute({
    sql: "INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')",
    args: [projectId],
  });
  await pin(db, CROW); // contact 1 is fully bound

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
async function pin(db, crowId, instanceId = LOCAL) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value)
          VALUES (?, ?, '1')
          ON CONFLICT(key, instance_id) DO UPDATE SET value = excluded.value`,
    args: [`contact_hs_cb:${crowId}`, instanceId],
  });
}

const invite = (s, over = {}) => inviteContact(s.db, {
  projectId: s.projectId, contactId: CONTACT, role: "viewer",
  localInstanceId: LOCAL, now: 1000, ...over,
});

/** Simulate the contact's Crow having accepted, without the pipeline. */
async function acceptDirect(s, { instanceId = VISITOR } = {}) {
  await s.db.execute({
    sql: `UPDATE project_members SET accepted_at = datetime('now'), origin_instance_id = ?
           WHERE project_id = ? AND contact_id = ? AND revoked_at IS NULL`,
    args: [instanceId, s.projectId, CONTACT],
  });
}

async function memberRow(s) {
  const { rows } = await s.db.execute({
    sql: "SELECT * FROM project_members WHERE project_id = ? AND contact_id IS NOT NULL ORDER BY id DESC LIMIT 1",
    args: [s.projectId],
  });
  return rows[0] ?? null;
}

/** The project's CONTACT member rows (the local owner row is not a share). */
async function contactMembers(s) {
  const { rows } = await s.db.execute({
    sql: "SELECT * FROM project_members WHERE project_id = ? AND contact_id IS NOT NULL ORDER BY id",
    args: [s.projectId],
  });
  return rows;
}

async function outbox(s, kind = null) {
  const { rows } = await s.db.execute({
    sql: kind ? "SELECT * FROM c2c_outbox WHERE kind = ? ORDER BY id" : "SELECT * FROM c2c_outbox ORDER BY id",
    args: kind ? [kind] : [],
  });
  return rows;
}

async function count(s, table) {
  const { rows } = await s.db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0].n);
}

const contactByCrowId = async (crowId) =>
  (crowId === CROW ? { id: CONTACT, crow_id: CROW, display_name: "alex" } : null);

/** Deliver one frame through the REAL receive pipeline, with the real handlers. */
async function deliver(s, payload, handlers = { onAccept, onDecline }) {
  const sent = [];
  await handleC2cFrame({
    db: s.db,
    send: (crowId, frame) => { sent.push({ crowId, frame }); },
    localInstanceId: LOCAL,
    contactByCrowId,
    handlers,
  }, CROW, payload, { proof: "cb", instanceId: VISITOR });
  return sent;
}

const acceptFrame = (epoch, { seq = 1, toInstanceId = LOCAL } = {}) => buildFrame({
  kind: "project.accept", projectUuid: P1, epoch, seq,
  fromInstanceId: VISITOR, toInstanceId, body: { visitor_instance_id: VISITOR },
});

const declineFrame = (epoch, reason, { seq = 1 } = {}) => buildFrame({
  kind: "project.decline", projectUuid: P1, epoch, seq,
  fromInstanceId: VISITOR, toInstanceId: LOCAL,
  body: reason === undefined ? {} : { reason },
});

const acks = (sent) => sent.filter((x) => x.frame.kind === "project.ack");
const refusals = (sent) => sent.filter((x) => x.frame.kind === "project.refuse");

/* ------------------------------------------------------------------ invite */

test("invite converts a clone row; no rights before accept", async () => {
  await withDb(async (s) => {
    // The old one-time copy share left a clone row for this (project, contact).
    await s.db.execute({
      sql: `INSERT INTO project_members (project_id, contact_id, role, capabilities, mode, uuid)
            VALUES (?, ?, 'guest', NULL, 'clone', ?)`,
      args: [s.projectId, CONTACT, CLONE_EPOCH],
    });

    const { memberUuid } = await invite(s, { role: "commenter" });
    const row = await memberRow(s);

    assert.equal(row.mode, "live", "the clone row converts in place (no second row)");
    assert.equal((await contactMembers(s)).length, 1);
    assert.notEqual(row.uuid, CLONE_EPOCH, "the conversion mints a fresh epoch");
    assert.equal(row.uuid, memberUuid);
    assert.equal(row.role, "guest", "a commenter is stored as guest (the column's CHECK)");
    assert.equal(memberRole(row), "commenter");
    assert.equal(row.capabilities, CONTACT_CAPS_JSON);
    assert.equal(row.accepted_at, null, "an invite is not an acceptance");
    assert.equal(row.origin_instance_id, null, "no visitor instance is known yet");

    // No rights before accept: only accept/decline carry a live membership there.
    const roleFrame = buildFrame({
      kind: "project.role", projectUuid: P1, epoch: memberUuid, seq: 1,
      fromInstanceId: VISITOR, toInstanceId: LOCAL, body: { role: "viewer" },
    });
    const refused = await authorizeOwnerFrame(s.db, { frame: roleFrame, contactId: CONTACT });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "forbidden");

    const accept = buildFrame({
      kind: "project.accept", projectUuid: P1, epoch: memberUuid, seq: 1,
      fromInstanceId: VISITOR, toInstanceId: LOCAL, body: { visitor_instance_id: VISITOR },
    });
    assert.equal((await authorizeOwnerFrame(s.db, { frame: accept, contactId: CONTACT })).ok, true);
  });
});

test("invite refuses an unbound contact", async () => {
  await withDb(async (s) => {
    const isNotBound = (err) =>
      err instanceof AclError && err.code === "contact_not_bound" && err.message === "contact_not_bound";

    await assert.rejects(
      () => invite(s, { contactId: UNBOUND_CONTACT }),
      isNotBound,
      "no pinned key at all",
    );
    await assert.rejects(
      () => invite(s, { contactId: KEYED_CONTACT }),
      isNotBound,
      "a pinned key without this instance's cb pin",
    );
    assert.equal((await contactMembers(s)).length, 0, "nothing was written");
    assert.equal(await count(s, "c2c_outbox"), 0, "and nothing was queued");
    assert.equal(await count(s, "project_audit_log"), 0);
  });
});

test("invite rotates the epoch on re-invite", async () => {
  await withDb(async (s) => {
    const first = await invite(s);
    await acceptDirect(s);
    const second = await invite(s);

    const row = await memberRow(s);
    assert.notEqual(second.memberUuid, first.memberUuid, "a re-invite is a new membership");
    assert.equal(row.uuid, second.memberUuid);
    assert.equal(row.revoked_at, null, "the converted row is still active");
    assert.equal(row.accepted_at, null, "the new membership starts unaccepted again");
    assert.equal(row.origin_instance_id, null, "and without a target instance");
    assert.equal((await contactMembers(s)).length, 1, "the same row is reused in place");
  });
});

test("the invite cancels the old membership's queued frames and carries an increasing gen", async () => {
  await withDb(async (s) => {
    const first = await invite(s);
    await acceptDirect(s);
    await setRole(s.db, {
      projectId: s.projectId, contactId: CONTACT, role: "editor", localInstanceId: LOCAL,
    });
    const roleBefore = (await outbox(s, "project.role"))[0];
    assert.equal(roleBefore.acked_at, null, "the role frame of the old membership is queued");

    const second = await invite(s);

    const roleAfter = (await outbox(s, "project.role"))[0];
    assert.notEqual(roleAfter.acked_at, null, "S6: the old membership's queued frame is cancelled");
    assert.equal(roleAfter.last_refusal, "cancelled");
    assert.equal(roleAfter.epoch, first.memberUuid, "it was the old epoch's frame");

    const invites = await outbox(s, "project.invite");
    assert.equal(invites.length, 2);
    const gen1 = JSON.parse(invites[0].frame_json).body.gen;
    const gen2 = JSON.parse(invites[1].frame_json).body.gen;
    assert.ok(gen2 > gen1, `S2: a re-invite carries a greater generation (${gen1} → ${gen2})`);
    assert.equal(invites[1].epoch, second.memberUuid);
    assert.equal(invites[1].to_instance_id, null, "an invite rides the '*' stream (S1)");
    // The old invite is cancelled by the same S6 pass; the new one is live.
    assert.notEqual(invites[0].acked_at, null);
    assert.equal(invites[1].acked_at, null);
  });
});

test("nothing is flushed inside the transaction: the send sees the committed row", async () => {
  await withDb(async (s) => {
    // A second connection can never see an uncommitted row, so reading the outbox
    // from it inside the send spy proves the flush ran AFTER COMMIT (S4).
    const observer = createDbClient(s.dbPath);
    const seen = [];
    const send = async (frame) => {
      const { rows } = await observer.execute("SELECT kind FROM c2c_outbox ORDER BY id");
      seen.push({ kinds: rows.map((r) => r.kind), sent: frame.kind });
    };
    try {
      await invite(s, { send });
      assert.equal(seen.length, 1, "one queued frame was flushed");
      assert.deepEqual(seen[0].kinds, ["project.invite"], "the invite row was already committed");
      assert.equal(seen[0].sent, "project.invite");
    } finally {
      observer.close();
    }
  });
});

/* -------------------------------------------------------------- accept/role */

test("accept records the visitor instance and targets later frames there", async () => {
  await withDb(async (s) => {
    const { memberUuid } = await invite(s);
    const sent = await deliver(s, acceptFrame(memberUuid));

    const row = await memberRow(s);
    assert.notEqual(row.accepted_at, null, "the acceptance is recorded");
    assert.equal(row.origin_instance_id, VISITOR, "the visitor's instance is remembered");
    assert.equal(acks(sent).length, 1, "the accept is acked");
    assert.equal(refusals(sent).length, 0);
    assert.equal(await count(s, "c2c_inbound_seq"), 1, "the seq rode the pipeline's transaction");

    // O3: ONE notification, naming the contact and the project (en + es in i18n).
    const notes = (await s.db.execute("SELECT title, type, source FROM notifications")).rows;
    assert.equal(notes.length, 1, "one notification for one acceptance");
    assert.equal(notes[0].title, "alex joined Labs");
    assert.equal(notes[0].type, "peer");

    // Every later frame of the membership is aimed at the accepting instance.
    await setRole(s.db, {
      projectId: s.projectId, contactId: CONTACT, role: "editor", localInstanceId: LOCAL,
    });
    const roles = await outbox(s, "project.role");
    assert.equal(roles.length, 1);
    assert.equal(roles[0].epoch, memberUuid, "the frame carries the CURRENT epoch");
    assert.equal(roles[0].to_instance_id, VISITOR, "aimed at the instance that accepted");
    assert.deepEqual(JSON.parse(roles[0].frame_json).body, { role: "editor" });

    const stored = (await s.db.execute({
      sql: "SELECT role FROM project_members WHERE id = ?", args: [row.id],
    })).rows[0];
    assert.equal(stored.role, "editor", "the row keeps the DB role (editor is the same word)");
  });
});

test("role change enqueues project.role with the current epoch, then flushes", async () => {
  await withDb(async (s) => {
    const { memberUuid } = await invite(s);
    await acceptDirect(s);

    const sent = [];
    await setRole(s.db, {
      projectId: s.projectId, contactId: CONTACT, role: "commenter",
      localInstanceId: LOCAL, send: (frame) => sent.push(frame),
    });

    assert.equal(sent.length, 2, "the unacked invite and the new role frame both flush");
    const role = sent.find((f) => f.kind === "project.role");
    assert.ok(role, "the role frame was sent");
    assert.equal(role.epoch, memberUuid);
    assert.equal(role.to_instance_id, VISITOR);
    assert.deepEqual(role.body, { role: "commenter" });

    const row = await memberRow(s);
    assert.equal(row.role, "guest", "commenter is stored as guest");
  });
});

test("a role change before accept is refused, not sent to nobody", async () => {
  await withDb(async (s) => {
    await invite(s);
    await assert.rejects(
      () => setRole(s.db, {
        projectId: s.projectId, contactId: CONTACT, role: "editor", localInstanceId: LOCAL,
      }),
      (err) => err instanceof AclError && err.code === "not_accepted",
    );
    assert.equal((await outbox(s, "project.role")).length, 0, "nothing was queued");
    assert.equal((await memberRow(s)).role, "viewer", "the role is unchanged");
  });
});

/* ----------------------------------------------------------------- unshare */

test("unshare revokes and enqueues project.unshare", async () => {
  await withDb(async (s) => {
    const { memberUuid } = await invite(s);
    await acceptDirect(s);

    await unshareContact(s.db, {
      projectId: s.projectId, contactId: CONTACT, localInstanceId: LOCAL,
    });

    const row = await memberRow(s);
    assert.notEqual(row.revoked_at, null, "the membership is revoked");
    const frames = await outbox(s, "project.unshare");
    assert.equal(frames.length, 1);
    assert.equal(frames[0].epoch, memberUuid, "the frame names the PRE-revoke epoch");
    assert.equal(frames[0].to_instance_id, VISITOR, "and the instance that accepted");
    assert.deepEqual(JSON.parse(frames[0].frame_json).body, {});
    assert.equal(await count(s, "project_audit_log"), 2, "invite + unshare are audited");
  });
});

test("an unshare before accept goes on the '*' stream", async () => {
  await withDb(async (s) => {
    const { memberUuid } = await invite(s);
    await unshareContact(s.db, {
      projectId: s.projectId, contactId: CONTACT, localInstanceId: LOCAL,
    });

    const frames = await outbox(s, "project.unshare");
    assert.equal(frames[0].to_instance_id, null, "O2: a never-accepted member has no instance");
    assert.equal(frames[0].epoch, memberUuid);
    const frame = JSON.parse(frames[0].frame_json);
    assert.equal(frame.to_instance_id, null);
    assert.equal(frame.kind, "project.unshare");

    // Same stream as the invite, so the visitor sees it in order after it (S1).
    const { rows } = await s.db.execute({
      sql: `SELECT next_seq FROM c2c_outbox_seq
             WHERE contact_id = ? AND project_uuid = ? AND epoch = ? AND stream = '*'`,
      args: [CONTACT, P1, memberUuid],
    });
    assert.equal(Number(rows[0].next_seq), 3, "the invite took 1, the unshare took 2");
  });
});

test("an unshare with a null target is routed and applied (receive side)", async () => {
  await withDb(async (s) => {
    // The visitor's own record of the membership an unshare ends.
    await s.db.execute({
      sql: `INSERT INTO c2c_visits
              (owner_contact_id, project_uuid, name, role, epoch, gen, owner_instance_id, state)
            VALUES (?, ?, 'Labs', 'viewer', ?, 1, ?, 'active')`,
      args: [CONTACT, P1, VISIT_EPOCH, PEER],
    });

    let applied = 0;
    const sent = await deliver(s, buildFrame({
      kind: "project.unshare", projectUuid: P1, epoch: VISIT_EPOCH, seq: 1,
      fromInstanceId: PEER, toInstanceId: null, body: {},
    }), { onUnshare: async () => { applied += 1; } });

    assert.equal(applied, 1, "a null target is allowed for project.unshare (O2)");
    assert.equal(acks(sent).length, 1);
    assert.equal(refusals(sent).length, 0);
    const { rows } = await s.db.execute({
      sql: `SELECT high_water FROM c2c_inbound_seq
             WHERE contact_id = ? AND sender_instance_id = ? AND project_uuid = ? AND epoch = ? AND stream = '*'`,
      args: [CONTACT, PEER, P1, VISIT_EPOCH],
    });
    assert.equal(Number(rows[0].high_water), 1, "it was consumed on the '*' stream");
  });
});

/* ---------------------------------------------------------------- decline */

test("decline left raises one notification", async () => {
  await withDb(async (s) => {
    const { memberUuid } = await invite(s);
    const accepted = await deliver(s, acceptFrame(memberUuid));
    assert.equal(acks(accepted).length, 1);
    assert.equal(await count(s, "notifications"), 1, "the accept notified");

    const left = await deliver(s, declineFrame(memberUuid, "left", { seq: 2 }));
    assert.equal(acks(left).length, 1, "the left is acked");
    assert.notEqual((await memberRow(s)).revoked_at, null, "leaving revokes the membership");
    const notes = (await s.db.execute("SELECT title FROM notifications ORDER BY id")).rows;
    assert.equal(notes.length, 2, "exactly one notification for the leave");
    assert.equal(notes[1].title, "alex left Labs");

    // A plain decline ends a pending invitation quietly: no third notification.
    await invite(s);
    const declined = await deliver(s, declineFrame((await memberRow(s)).uuid, undefined));
    assert.equal(acks(declined).length, 1);
    assert.notEqual((await memberRow(s)).revoked_at, null, "declining revokes too");
    assert.equal(await count(s, "notifications"), 2, "a decline says nothing");
  });
});

test("decline left raises one notification (handler in isolation, en + es present)", async () => {
  await withDb(async (s) => {
    const { memberUuid } = await invite(s);
    await acceptDirect(s);
    const titles = [];
    const { onDecline: decline } = createOwnerHandlers({
      notify: async (_db, opts) => { titles.push(opts.title); },
    });
    const member = await memberRow(s);
    await decline(s.db, { member, frame: { kind: "project.decline", body: { reason: "left" } } });
    assert.deepEqual(titles, ["alex left Labs"]);
    assert.notEqual((await memberRow(s)).revoked_at, null);
    assert.equal((await memberRow(s)).uuid, memberUuid);
    // The other language names the same two things and nothing else (i18n parity).
    assert.equal(
      fill(t("c2c.notify.left", "es"), { contact: "alex", project: "Labs" }),
      "alex salió de Labs",
    );
  });
});

/* -------------------------------------------------- O3: the accept guard */

test("an accept with an unusable visitor instance id throws and changes nothing", async () => {
  await withDb(async (s) => {
    await invite(s);
    const member = await memberRow(s);
    for (const bad of ["", "has spaces", "x".repeat(129), null, 42]) {
      await assert.rejects(
        () => onAccept(s.db, { member, frame: { kind: "project.accept", body: { visitor_instance_id: bad } } }),
        (err) => err instanceof AclError && err.code === "bad_frame",
        `refused: ${String(bad)}`,
      );
    }
    const row = await memberRow(s);
    assert.equal(row.accepted_at, null);
    assert.equal(row.origin_instance_id, null);
  });
});

/* ------------------------------------------------------------------- O5 */

test("contact capabilities are all false for the MCP ACL", async () => {
  await withDb(async (s) => {
    await invite(s, { role: "editor" });
    const eff = await effectiveCapabilities(s.db, s.projectId, CONTACT);
    assert.ok(eff, "the member row is found");
    assert.equal(eff.role, "editor");
    for (const key of CAPABILITY_KEYS) {
      assert.equal(eff.capabilities[key], false, `capability ${key} must be false for a contact`);
    }
  });
});

/* ------------------------------------------------------------------- O6 */

test("listLiveMembers reports invited, active, the update flag, and skips revoked", async () => {
  await withDb(async (s) => {
    await invite(s, { role: "commenter" });
    let members = await listLiveMembers(s.db, s.projectId);
    assert.deepEqual(members, [{
      contactId: CONTACT, displayName: "alex", role: "commenter",
      state: "invited", updateRequired: false,
    }]);

    await acceptDirect(s);
    members = await listLiveMembers(s.db, s.projectId);
    assert.equal(members[0].state, "active");

    // The flag the receive pipeline writes for a contact on the legacy proof.
    await s.db.execute({
      sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value) VALUES (?, ?, '1')",
      args: [`c2c_update_required:${CROW}`, LOCAL],
    });
    members = await listLiveMembers(s.db, s.projectId);
    assert.equal(members[0].updateRequired, true, "R5's marker reaches the owner's UI");

    await unshareContact(s.db, {
      projectId: s.projectId, contactId: CONTACT, localInstanceId: LOCAL,
    });
    assert.deepEqual(await listLiveMembers(s.db, s.projectId), [], "a revoked member is gone");
  });
});

/* --------------------------------------------------------------- guards */

// W5: the fixture is init-db's OWN project_members DDL, so this CHECK is the one
// production enforces — which is why a commenter must be stored as `guest`.
test("the fixture really carries init-db's role CHECK (no 'commenter' row is possible)", async () => {
  await withDb(async (s) => {
    await assert.rejects(
      () => s.db.execute({
        sql: `INSERT INTO project_members (project_id, contact_id, role, mode)
              VALUES (?, ?, 'commenter', 'live')`,
        args: [s.projectId, CONTACT],
      }),
      /CHECK constraint failed/i,
    );
  });
});

test("an unknown role is refused before anything is written", async () => {
  await withDb(async (s) => {
    await assert.rejects(
      () => invite(s, { role: "owner" }),
      (err) => err instanceof AclError && err.code === "bad_role",
    );
    assert.equal((await contactMembers(s)).length, 0);
    assert.equal(await count(s, "c2c_outbox"), 0);
  });
});

/* --------------------- W1: no network I/O inside the frame's transaction (R7) */

/**
 * The real pipeline, with the owner handlers' fan-out swapped for a spy. The spy
 * reads `accepted_at` through a SECOND connection: an uncommitted row is invisible
 * there, so a non-null read proves the hook ran after COMMIT.
 */
test("W1: an accept's notification is delivered after COMMIT, the ack and the flush", async () => {
  await withDb(async (s) => {
    const { memberUuid } = await invite(s);
    const observer = createDbClient(s.dbPath);
    const events = [];
    const deliverSpy = async (_db, payload) => {
      const { rows } = await observer.execute({
        sql: "SELECT accepted_at FROM project_members WHERE project_id = ? AND contact_id = ?",
        args: [s.projectId, CONTACT],
      });
      events.push({ at: "deliver", title: payload.title, acceptedAt: rows[0]?.accepted_at ?? null });
    };
    try {
      await handleC2cFrame({
        db: s.db,
        send: (_crowId, frame) => { events.push({ at: frame.kind }); },
        localInstanceId: LOCAL,
        contactByCrowId,
        handlers: createOwnerHandlers({ deliver: deliverSpy }),
      }, CROW, acceptFrame(memberUuid), { proof: "cb", instanceId: VISITOR });
    } finally {
      observer.close();
    }

    const delivered = events.filter((e) => e.at === "deliver");
    assert.equal(delivered.length, 1, "the accept delivers exactly once");
    assert.equal(delivered[0].title, "alex joined Labs");
    assert.notEqual(delivered[0].acceptedAt, null,
      "another connection sees the committed acceptance: the fan-out ran after COMMIT");
    assert.equal(await count(s, "notifications"), 1, "the row itself was written in the transaction");

    const order = events.map((e) => e.at);
    assert.ok(order.includes("project.ack") && order.includes("project.invite"), order.join(","));
    assert.ok(order.indexOf("project.ack") < order.indexOf("deliver"), "after the ack");
    assert.ok(order.indexOf("project.invite") < order.indexOf("deliver"),
      "and after the flush of the queued invite");
  });
});

test("W1: a dup accept re-acks and never runs the after-commit hook", async () => {
  await withDb(async (s) => {
    const { memberUuid } = await invite(s);
    const delivered = [];
    const handlers = createOwnerHandlers({
      deliver: async (_db, payload) => { delivered.push(payload.title); },
    });
    const accept = acceptFrame(memberUuid);

    const first = await deliver(s, accept, handlers);
    assert.equal(acks(first).length, 1);
    assert.deepEqual(delivered, ["alex joined Labs"]);

    const second = await deliver(s, accept, handlers);
    assert.equal(delivered.length, 1, "a dup announces nothing (the hook was dropped)");
    assert.equal(acks(second).length, 1, "it is re-acked instead");
    assert.equal(await count(s, "notifications"), 1, "and writes no second row");
  });
});

/* --------------------------- W2: the invite name matches the wire rule exactly */

test("W2: every control character is removed, not just the first", async () => {
  await withDb(async (s) => {
    await s.db.execute({
      sql: "UPDATE project_spaces SET name = ? WHERE id = ?",
      args: ["\u0001a\u0002", s.projectId],
    });
    await invite(s);
    const [row] = await outbox(s, "project.invite");
    assert.equal(JSON.parse(row.frame_json).body.name, "a");
  });
});

test("W2: an over-long emoji name is cut on a code point at 200 units, and enqueue accepts it", async () => {
  await withDb(async (s) => {
    await s.db.execute({
      sql: "UPDATE project_spaces SET name = ? WHERE id = ?",
      args: ["\u{1F600}".repeat(150), s.projectId], // 150 code points, 300 UTF-16 units
    });
    // enqueue re-parses the frame, so an unusable name would throw here.
    await invite(s);
    const [row] = await outbox(s, "project.invite");
    const name = JSON.parse(row.frame_json).body.name;
    assert.equal(name.length, 200, "the cap counts UTF-16 units, as frames.js does");
    assert.equal(name, "\u{1F600}".repeat(100), "whole code points only");
    assert.ok(name.isWellFormed(), "no split surrogate pair on the wire");
  });
});

/* ------------------------------- W3: the caller must be allowed to manage members */

/** Set the LOCAL user's role on the project (the caller `assertLocalCapability` reads). */
async function localRole(s, role) {
  await s.db.execute({
    sql: "UPDATE project_members SET role = ? WHERE project_id = ? AND contact_id IS NULL",
    args: [role, s.projectId],
  });
}

test("W3: invite, role change and unshare are refused without manage_members", async () => {
  await withDb(async (s) => {
    const denied = (err) => err instanceof AclError && err.code === "missing_capability";
    const { memberUuid } = await invite(s);
    await acceptDirect(s);

    await localRole(s, "viewer");
    await assert.rejects(
      () => invite(s),
      denied,
      "a viewer may not invite",
    );
    await assert.rejects(
      () => setRole(s.db, {
        projectId: s.projectId, contactId: CONTACT, role: "editor", localInstanceId: LOCAL,
      }),
      denied,
      "a viewer may not change a role",
    );
    await assert.rejects(
      () => unshareContact(s.db, {
        projectId: s.projectId, contactId: CONTACT, localInstanceId: LOCAL,
      }),
      denied,
      "a viewer may not unshare",
    );

    const row = await memberRow(s);
    assert.equal(row.uuid, memberUuid, "no re-invite happened");
    assert.equal(row.role, "viewer", "no role was written");
    assert.equal(row.revoked_at, null, "nothing was revoked");
    assert.equal((await outbox(s, "project.role")).length, 0);
    assert.equal((await outbox(s, "project.unshare")).length, 0);

    // The owner may do all three.
    await localRole(s, "owner");
    const second = await invite(s);
    assert.notEqual(second.memberUuid, memberUuid);
    await acceptDirect(s);
    await setRole(s.db, {
      projectId: s.projectId, contactId: CONTACT, role: "editor", localInstanceId: LOCAL,
    });
    await unshareContact(s.db, {
      projectId: s.projectId, contactId: CONTACT, localInstanceId: LOCAL,
    });
    assert.equal((await outbox(s, "project.role")).length, 1);
    assert.notEqual((await memberRow(s)).revoked_at, null, "the owner's unshare revoked it");
  });
});

/* ------------------------------------- W5: the bound check fails CLOSED */

test("W5: an unreadable cb pin refuses the invite instead of admitting it", async () => {
  await withDb(async (s) => {
    // A throwing seam: only the pin read fails, everything else works.
    const throwing = {
      execute: (arg) => {
        const sql = typeof arg === "string" ? arg : arg.sql;
        if (/dashboard_settings_overrides/.test(sql)) throw new Error("simulated pin read failure");
        return s.db.execute(arg);
      },
    };
    await assert.rejects(
      () => inviteContact(throwing, {
        projectId: s.projectId, contactId: CONTACT, role: "viewer", localInstanceId: LOCAL, now: 1000,
      }),
      (err) => err instanceof AclError && err.code === "contact_not_bound",
      "an unreadable pin must never read as bound",
    );
    assert.equal((await contactMembers(s)).length, 0, "nothing was written");
    assert.equal(await count(s, "c2c_outbox"), 0, "and nothing was queued");
  });
});