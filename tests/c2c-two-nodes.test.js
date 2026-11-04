/**
 * Crow-to-Crow plan 1, Task 7C: the TWO-NODE GATE.
 *
 * Real Crow sharing nodes, each its own child process with a scratch CROW_HOME,
 * paired through the real invite flow, talking over a LOCAL hyperdht testnet and a
 * LOCAL Nostr relay (both on 127.0.0.1) — the harness of
 * tests/contact-binding-two-nodes.test.js. Nothing here dials a public DHT node or
 * a public relay; the child refuses both.
 *
 * The two sides are driven exactly as a host drives them:
 *   - reads through `node.sql` (the node's real DB);
 *   - actions through `node.c2c(fn, args)`, the fixture's test-only allowlist over
 *     servers/sharing/c2c/{owner,visitor}.js (inviteContact, setRole,
 *     unshareContact, listLiveMembers; acceptVisit, declineVisit, leaveVisit,
 *     listVisits). Every action runs with the node's real db, its own instance id
 *     and a send from its live peer manager, so the module's own flush runs after
 *     commit; a frame it cannot send stays in `c2c_outbox` for the boot's
 *     flush-on-connect, which is what the offline legs below observe.
 *
 * Every wait is `until(...)` on observable state — no sleeps — and each test owns
 * its nodes and stops them in `finally`. `stopAllContactNodes()` runs in `after`.
 *
 * What is pinned:
 *   1. invite → accept → role → unshare end to end (both sides' rows at each step,
 *      and not one refusal in either log);
 *   2. an invite queued while the visitor is offline is delivered when it starts;
 *   3. a paired SIBLING of the visitor (same identity, another instance) answers
 *      `not_home`, the frame stays queued, and the target instance gets it;
 *   4. the owner restarts with an unacked frame: it is re-sent and applied ONCE
 *      (the receiver's mark advances to exactly that frame's seq);
 *   5. a re-invite of an ACCEPTED member while it is offline: the old instance
 *      hears the old membership's unshare, then the new invite.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startNostrRelay } from "./fixtures/nostr-relay.mjs";
import {
  startTestnet, startContactNode, stopAllContactNodes, inviteAndAccept, waitConnected, isPinned, until,
} from "./fixtures/contact-node.mjs";

const T = { timeout: 150_000 };
/** Tests that start a sibling or restart a node take a little longer. */
const TL = { timeout: 180_000 };

const tag = () => randomBytes(4).toString("hex");

let relay, testnet;

before(async () => {
  relay = await startNostrRelay();
  testnet = await startTestnet();
}, { timeout: 300_000 });

after(async () => {
  await stopAllContactNodes();
  await relay?.close();
  await testnet?.destroy();
}, { timeout: 120_000 });

async function node(name, opts = {}) {
  return startContactNode({ name, bootstrap: testnet.bootstrap, relayUrl: relay.url, ...opts });
}

/** A (owner) and B (visitor), paired through the real invite flow and cb-pinned. */
async function pair(prefix) {
  const a = await node(`${prefix}-a`);
  const b = await node(`${prefix}-b`);
  assert.notEqual(a.instanceId, b.instanceId, `${prefix}: two instances, two ids`);
  await inviteAndAccept(a, b);
  assert.ok(await waitConnected(a, b), `${prefix}: the two nodes never admitted each other`);
  // An invite goes only to a cb-pinned contact (owner.js O4): A pins B when B's
  // bound handshake completes, which is right after admission.
  assert.ok(await until(() => isPinned(a, b.crowId), 30_000), `${prefix}: A never pinned B`);
  return { a, b };
}

/* ------------------------------------------------------------------- reads */

const contactIdOf = async (n, crowId) => {
  const rows = await n.sql("SELECT id FROM contacts WHERE crow_id = ? LIMIT 1", [crowId]);
  return Number(rows[0]?.id);
};

/** A project with its local OWNER row: every owner action is gated on manage_members. */
async function newProject(n) {
  const slug = `c2c-2n-${tag()}`;
  const { lastInsertRowid } = await n.exec("INSERT INTO project_spaces (slug, name) VALUES (?, ?)", [slug, `Labs ${slug}`]);
  const projectId = Number(lastInsertRowid);
  await n.exec("INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')", [projectId]);
  const rows = await n.sql("SELECT uuid FROM project_spaces WHERE id = ? LIMIT 1", [projectId]);
  return { projectId, projectUuid: rows[0].uuid };
}

async function memberRow(n, projectId, contactId) {
  const rows = await n.sql(
    "SELECT * FROM project_members WHERE project_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 1",
    [projectId, contactId]);
  return rows[0] ?? null;
}

async function visitRow(n, ownerContactId, projectUuid) {
  const rows = await n.sql(
    "SELECT * FROM c2c_visits WHERE owner_contact_id = ? AND project_uuid = ? ORDER BY id DESC LIMIT 1",
    [ownerContactId, projectUuid]);
  return rows[0] ?? null;
}

async function outbox(n, projectUuid) {
  return n.sql(
    `SELECT id, kind, epoch, seq, to_instance_id, attempts, last_attempt_at, last_refusal, acked_at
       FROM c2c_outbox WHERE project_uuid = ? ORDER BY id`, [projectUuid]);
}

const outboxRow = (rows, kind) => rows.filter((r) => r.kind === kind).at(-1) ?? null;

async function marks(n, projectUuid) {
  return n.sql(
    `SELECT sender_instance_id, epoch, stream, high_water FROM c2c_inbound_seq
      WHERE project_uuid = ? ORDER BY epoch, stream`, [projectUuid]);
}

/** The invite/accept pair every leg starts from: A invites B, B accepts. */
async function acceptedMember({ a, b }, prefix) {
  const project = await newProject(a);
  const aContactOfB = await contactIdOf(a, b.crowId);
  const bContactOfA = await contactIdOf(b, a.crowId);
  const inv = await a.c2c("inviteContact", { projectId: project.projectId, contactId: aContactOfB, role: "viewer" });
  assert.ok(await until(async () => (await visitRow(b, bContactOfA, project.projectUuid))?.epoch === inv.memberUuid, 30_000),
    `${prefix}: B never saw the invite`);
  const visit = await visitRow(b, bContactOfA, project.projectUuid);
  await b.c2c("acceptVisit", { visitId: visit.id });
  assert.ok(await until(async () => Boolean((await memberRow(a, project.projectId, aContactOfB))?.accepted_at), 30_000),
    `${prefix}: A never recorded the acceptance`);
  const member = await memberRow(a, project.projectId, aContactOfB);
  return { ...project, aContactOfB, bContactOfA, inv, visit, member, bInstance: member.origin_instance_id };
}

/* --------------------------------------------------------------- the gate */

/**
 * Every `[c2c]` line that reports a refusal, a held frame, a failure or a dropped
 * frame. The pipeline never logs a body, so matching these words can only hit the
 * refusals themselves.
 */
const C2C_TROUBLE = /\[c2c\][^\n]*(?:refus|closed with|failed|not_home|stale_epoch|busy|\bgap\b|bad frame|legacy-proof)/i;
const trouble = (n) => n.logLines(C2C_TROUBLE);

function assertGuardsQuiet(...nodes) {
  for (const n of nodes) assert.deepEqual(n.guardViolations(), [], `${n.name} hit a network guard`);
}

test("invite → accept → role → unshare, end to end, with both sides' state checked at every step", T, async () => {
  const { a, b } = await pair("c2c2n1");
  try {
    const { projectId, projectUuid } = await newProject(a);
    const aContactOfB = await contactIdOf(a, b.crowId);
    const bContactOfA = await contactIdOf(b, a.crowId);

    /* ---- invite: A's member row is live, unaccepted and unaddressed; B's visit invited */
    const inv = await a.c2c("inviteContact", { projectId, contactId: aContactOfB, role: "viewer" });
    assert.match(inv.memberUuid, /^[0-9a-f]{32}$/, "the invite returns the membership's epoch");
    assert.ok(await until(async () => (await visitRow(b, bContactOfA, projectUuid))?.epoch === inv.memberUuid, 30_000),
      "B never received the invite");

    let member = await memberRow(a, projectId, aContactOfB);
    assert.equal(member.mode, "live");
    assert.equal(member.role, "viewer");
    assert.equal(member.uuid, inv.memberUuid, "the epoch is the membership's uuid");
    assert.equal(member.accepted_at, null, "nobody accepted yet");
    assert.equal(member.origin_instance_id, null, "and no instance is the target yet");
    assert.equal(member.revoked_at, null);
    const caps = JSON.parse(member.capabilities);
    assert.ok(Object.keys(caps).length > 0, "the contact's MCP capability mask is written");
    for (const [key, value] of Object.entries(caps)) assert.equal(value, false, `capability ${key} must be false`);

    let visit = await visitRow(b, bContactOfA, projectUuid);
    assert.equal(visit.state, "invited");
    assert.equal(visit.role, "viewer");
    assert.equal(visit.epoch, inv.memberUuid, "the visit names the same membership");
    assert.ok(Number(visit.gen) > 0, "S2: the invite carried a generation");
    assert.equal(visit.ended_at, null);

    /* ---- accept: the visitor's instance becomes the routing target */
    await b.c2c("acceptVisit", { visitId: visit.id });
    assert.ok(await until(async () => Boolean((await memberRow(a, projectId, aContactOfB))?.accepted_at), 30_000),
      "A never recorded the acceptance");
    member = await memberRow(a, projectId, aContactOfB);
    const bInstance = member.origin_instance_id;
    assert.equal(typeof bInstance, "string", "the accepting instance is recorded");
    assert.ok(bInstance.length > 0);
    assert.equal(bInstance, b.instanceId, "and it is B's own instance id");
    assert.equal(member.uuid, inv.memberUuid, "accepting does not rotate the epoch");
    assert.equal(member.revoked_at, null);

    visit = await visitRow(b, bContactOfA, projectUuid);
    assert.equal(visit.state, "active");
    assert.notEqual(visit.accepted_at, null);
    assert.equal(visit.epoch, inv.memberUuid);

    /* ---- role: the epoch stays, the role moves (a commenter is stored as `guest`) */
    const role = await a.c2c("setRole", { projectId, contactId: aContactOfB, role: "commenter" });
    assert.equal(role.memberUuid, inv.memberUuid, "a role change keeps the membership");
    assert.ok(await until(async () => (await visitRow(b, bContactOfA, projectUuid))?.role === "commenter", 30_000),
      "B never applied the role change");
    member = await memberRow(a, projectId, aContactOfB);
    assert.equal(member.role, "guest", "the owner's column spells a commenter `guest`");
    assert.equal(member.uuid, inv.memberUuid);
    assert.notEqual(member.accepted_at, null, "still accepted");
    assert.equal(member.revoked_at, null);
    visit = await visitRow(b, bContactOfA, projectUuid);
    assert.equal(visit.role, "commenter", "the visitor stores the Crow-to-Crow vocabulary");
    assert.equal(visit.epoch, inv.memberUuid);
    assert.equal(visit.state, "active");

    /* ---- unshare: A revokes, B's visit ends at the same epoch */
    const un = await a.c2c("unshareContact", { projectId, contactId: aContactOfB });
    assert.equal(un.memberUuid, inv.memberUuid, "the unshare names the membership it ends");
    assert.ok(await until(async () => (await visitRow(b, bContactOfA, projectUuid))?.state === "unshared", 30_000),
      "B never heard the unshare");
    member = await memberRow(a, projectId, aContactOfB);
    assert.notEqual(member.revoked_at, null, "A revoked the row");
    assert.equal(member.mode, "live", "the mode of the ended membership is unchanged");
    assert.equal(member.uuid, inv.memberUuid, "and it still names the membership B ended");
    visit = await visitRow(b, bContactOfA, projectUuid);
    assert.equal(visit.state, "unshared");
    assert.equal(visit.epoch, inv.memberUuid);
    assert.notEqual(visit.ended_at, null);

    /* ---- every frame is acked, nothing was refused anywhere */
    assert.ok(await until(async () => (await outbox(a, projectUuid)).every((r) => r.acked_at !== null), 30_000),
      "A still holds an unacked frame");
    const rows = await outbox(a, projectUuid);
    assert.deepEqual(rows.map((r) => r.kind), ["project.invite", "project.role", "project.unshare"]);
    for (const r of rows) assert.equal(r.last_refusal, null, `${r.kind} must not have been refused`);
    assert.deepEqual(trouble(a), [], "A logged a refusal or a failure");
    assert.deepEqual(trouble(b), [], "B logged a refusal or a failure");
    assertGuardsQuiet(a, b);
  } finally {
    await a.stop(); await b.stop();
  }
});

test("offline: an invite queued while B is stopped is delivered when B starts", T, async () => {
  const { a, b } = await pair("c2c2n2");
  let bBack = null;
  try {
    const { projectId, projectUuid } = await newProject(a);
    const aContactOfB = await contactIdOf(a, b.crowId);
    const bContactOfA = await contactIdOf(b, a.crowId);
    const bHome = b.home;

    await b.stop({ keepHome: true });
    assert.ok(await until(async () => !(await a.isConnected(b.crowId)), 30_000), "A never saw B go offline");

    const inv = await a.c2c("inviteContact", { projectId, contactId: aContactOfB, role: "viewer" });
    const queued = outboxRow(await outbox(a, projectUuid), "project.invite");
    assert.equal(queued.epoch, inv.memberUuid);
    assert.equal(queued.acked_at, null, "with B offline the invite stays queued");
    assert.equal(Number(queued.attempts), 0, "and the flush could not even attempt it");
    assert.equal(queued.last_attempt_at, null);
    assert.equal(queued.last_refusal, null);

    bBack = await node("c2c2n2-b", { home: bHome });
    assert.equal(bBack.crowId, b.crowId, "the same person, the same node");
    assert.ok(await until(async () => Boolean(await visitRow(bBack, bContactOfA, projectUuid)), 60_000),
      "B never received the queued invite after it started");
    const visit = await visitRow(bBack, bContactOfA, projectUuid);
    assert.equal(visit.state, "invited");
    assert.equal(visit.epoch, inv.memberUuid);
    assert.equal(visit.role, "viewer");
    assert.ok(await until(async () => (outboxRow(await outbox(a, projectUuid), "project.invite"))?.acked_at !== null, 30_000),
      "A never saw the queued invite acked");
    assert.deepEqual(trouble(a), []);
    assertGuardsQuiet(a, bBack);
  } finally {
    await bBack?.stop();
    await a.stop(); await b.stop();
  }
});

test("sibling gets not_home, frame waits for the target", TL, async () => {
  const { a, b } = await pair("c2c2n3");
  let b2 = null;
  let bBack = null;
  const bHome = b.home;
  try {
    const { projectId, projectUuid, aContactOfB, bContactOfA, inv, bInstance } = await acceptedMember({ a, b }, "c2c2n3");

    /* B goes offline; its paired sibling B2 (same identity, another instance) comes on. */
    await b.stop({ keepHome: true });
    assert.ok(await until(async () => !(await a.isConnected(b.crowId)), 30_000), "A never saw B go offline");

    b2 = await node("c2c2n3-b2", { seedFrom: b });
    assert.equal(b2.crowId, b.crowId, "B2 is the same person (one seed)");
    assert.notEqual(b2.instanceId, bInstance, "but a different instance");
    await inviteAndAccept(a, b2);
    assert.ok(await waitConnected(a, b2), "A and B2 never admitted each other");

    /* A frame aimed at B's instance reaches the sibling, which says not_home. */
    const role = await a.c2c("setRole", { projectId, contactId: aContactOfB, role: "editor" });
    assert.equal(role.memberUuid, inv.memberUuid);
    assert.ok(await until(async () => outboxRow(await outbox(a, projectUuid), "project.role")?.last_refusal === "not_home", 30_000),
      "the sibling never answered not_home");
    let row = outboxRow(await outbox(a, projectUuid), "project.role");
    assert.equal(row.to_instance_id, bInstance, "the frame is aimed at the instance that accepted");
    assert.equal(row.acked_at, null, "a not_home HOLDS the frame, it does not end it");
    assert.ok(Number(row.attempts) >= 1, "it was really sent (and answered)");

    /* The right instance comes back: the held frame is delivered and applied there. */
    await b2.stop();
    b2 = null;
    assert.ok(await until(async () => !(await a.isConnected(b.crowId)), 30_000), "A still holds the sibling's link");
    bBack = await node("c2c2n3-b", { home: bHome });
    assert.ok(await until(async () => (await visitRow(bBack, bContactOfA, projectUuid))?.role === "editor", 60_000),
      "the held frame never reached B");
    assert.ok(await until(async () => outboxRow(await outbox(a, projectUuid), "project.role")?.acked_at !== null, 30_000),
      "A never saw the role acked");
    row = outboxRow(await outbox(a, projectUuid), "project.role");
    assert.equal(row.last_refusal, "not_home", "the only refusal the frame got was the sibling's hold");
    const visit = await visitRow(bBack, bContactOfA, projectUuid);
    assert.equal(visit.state, "active");
    assert.equal(visit.epoch, inv.memberUuid, "the epoch never moved");
    assert.equal(visit.role, "editor");
    assertGuardsQuiet(a, bBack);
  } finally {
    await b2?.stop();
    await bBack?.stop();
    await a.stop();
    await b.stop();
  }
});

test("restart A with an unacked frame: it is re-sent, and B applies it once", TL, async () => {
  let { a, b } = await pair("c2c2n4");
  let bBack = null;
  const bHome = b.home;
  try {
    const { projectId, projectUuid, aContactOfB, bContactOfA, inv, bInstance } = await acceptedMember({ a, b }, "c2c2n4");

    await b.stop({ keepHome: true });
    assert.ok(await until(async () => !(await a.isConnected(b.crowId)), 30_000), "A never saw B go offline");

    const role = await a.c2c("setRole", { projectId, contactId: aContactOfB, role: "editor" });
    const queued = outboxRow(await outbox(a, projectUuid), "project.role");
    assert.equal(queued.epoch, inv.memberUuid);
    assert.equal(queued.acked_at, null, "the role frame is queued while B is away");
    assert.equal(Number(queued.attempts), 0);

    /* A restarts on the same home: same identity, same DB, the frame still queued. */
    a = await a.restart();
    assert.ok(await until(async () => {
      const row = outboxRow(await outbox(a, projectUuid), "project.role");
      return row !== null && row.acked_at === null;
    }, 30_000), "the restart lost the queued frame");

    bBack = await node("c2c2n4-b", { home: bHome });
    assert.ok(await until(async () => (await visitRow(bBack, bContactOfA, projectUuid))?.role === "editor", 60_000),
      "B never applied the re-sent role frame");
    assert.ok(await until(async () => outboxRow(await outbox(a, projectUuid), "project.role")?.acked_at !== null, 30_000),
      "A never saw the re-sent frame acked");

    /* Applied ONCE: B's mark for that stream is exactly that frame's seq, and the
     * stream holds one mark row (a second delivery is a dup and re-acks). */
    const sameStream = (await marks(bBack, projectUuid))
      .filter((m) => m.epoch === role.memberUuid && m.stream === bInstance);
    assert.equal(sameStream.length, 1, "one stream, one mark");
    assert.equal(Number(sameStream[0].high_water), Number(role.seq), "the mark advanced to exactly the frame's seq");
    const visit = await visitRow(bBack, bContactOfA, projectUuid);
    assert.equal(visit.state, "active");
    assert.equal(visit.epoch, inv.memberUuid);
    assert.equal(visit.role, "editor");
    assert.notEqual(visit.accepted_at, null, "the membership is still the accepted one");
    assert.deepEqual(trouble(a), []);
    assertGuardsQuiet(a, bBack);
  } finally {
    await bBack?.stop();
    await a.stop();
    await b.stop();
  }
});

test("re-invite an accepted member while it is offline: the old instance hears the unshare, then the new invite", TL, async () => {
  const { a, b } = await pair("c2c2n5");
  let bBack = null;
  const bHome = b.home;
  try {
    const { projectId, projectUuid, aContactOfB, bContactOfA, inv, visit: firstVisit, bInstance } = await acceptedMember({ a, b }, "c2c2n5");
    const before = await b.sql("SELECT COALESCE(MAX(id), 0) AS id FROM notifications");

    await b.stop({ keepHome: true });
    assert.ok(await until(async () => !(await a.isConnected(b.crowId)), 30_000), "A never saw B go offline");

    /* The re-invite queues two frames in one transaction: the OLD membership's
     * unshare (epoch E1, aimed at B's instance) and the new invite (a new epoch,
     * on the "*" stream). The visitor must hear the first, then the second.
     *
     * A flush walks a contact's rows in (project, epoch, stream, seq) order, so the
     * two streams' RANDOM epochs decide which goes first on the wire. Every
     * re-invite runs the same code, so the gate takes re-invites until the new
     * epoch sorts after E1: the plan's order is then the deterministic one. (Each
     * earlier invite is cancelled by the next re-invite's cancelEpoch pass, S6, so
     * only the last one is left queued.) */
    let second = null;
    let ordered = false;
    for (let i = 0; i < 16 && !ordered; i++) {
      second = await a.c2c("inviteContact", { projectId, contactId: aContactOfB, role: "editor" });
      ordered = inv.memberUuid < second.memberUuid;
    }
    assert.ok(ordered, "16 re-invites and the new epoch never sorted after the old one (2^-16)");
    assert.notEqual(second.memberUuid, inv.memberUuid, "a re-invite is a new membership");

    const queued = await outbox(a, projectUuid);
    const unshare = outboxRow(queued, "project.unshare");
    const invite = queued.filter((r) => r.kind === "project.invite" && r.acked_at === null);
    assert.equal(invite.length, 1, "exactly one invite is left queued (the earlier ones were cancelled)");
    assert.equal(unshare.epoch, inv.memberUuid, "the unshare names the old membership");
    assert.equal(unshare.to_instance_id, bInstance, "and targets the old instance");
    assert.equal(unshare.acked_at, null, "both frames wait for B");
    assert.equal(invite[0].epoch, second.memberUuid);
    assert.equal(invite[0].to_instance_id, null, "an invite rides the '*' stream");
    assert.ok(unshare.epoch < invite[0].epoch, "so the unshare is flushed first");

    bBack = await node("c2c2n5-b", { home: bHome });
    assert.ok(await until(async () => (await visitRow(bBack, bContactOfA, projectUuid))?.epoch === second.memberUuid, 60_000),
      "B never reached the re-invite");
    const visit = await visitRow(bBack, bContactOfA, projectUuid);
    assert.equal(visit.state, "invited", "the re-invite re-opens the visit");
    assert.equal(visit.role, "editor");
    assert.ok(Number(visit.gen) > Number(firstVisit.gen), "the new membership's generation is greater");

    /* The old instance HEARD the unshare first: its visit ended (one `unshare`
     * notification) before the new invite re-opened it (one `invite` notification).
     * The rows are written inside each frame's own transaction, in arrival order. */
    const notes = await bBack.sql("SELECT source FROM notifications WHERE id > ? ORDER BY id", [Number(before[0].id)]);
    assert.deepEqual(notes.map((n) => n.source), ["sharing:c2c_unshare", "sharing:c2c_invite"],
      "the unshare ended the old visit before the new invite re-opened it");

    assert.ok(await until(async () => (await outbox(a, projectUuid)).every((r) => r.acked_at !== null), 30_000),
      "a frame of the re-invite was never acked");
    const after = await outbox(a, projectUuid);
    const doneUnshare = outboxRow(after, "project.unshare");
    assert.equal(doneUnshare.epoch, inv.memberUuid);
    assert.equal(doneUnshare.last_refusal, null, "the unshare was applied, not refused stale");
    assert.notEqual(doneUnshare.acked_at, null, "and it was delivered");
    assert.equal(outboxRow(after, "project.invite").epoch, second.memberUuid);

    /* Both streams were processed by B, each up to its own frame's seq. */
    const inbound = await marks(bBack, projectUuid);
    const oldStream = inbound.find((m) => m.epoch === inv.memberUuid && m.stream === bInstance);
    const newStream = inbound.find((m) => m.epoch === second.memberUuid && m.stream === "*");
    assert.ok(oldStream, "B holds the old membership's mark");
    assert.equal(Number(oldStream.high_water), Number(doneUnshare.seq), "the unshare's stream moved to its seq");
    assert.ok(newStream, "and the new invite's stream");
    assert.equal(Number(newStream.high_water), Number(outboxRow(after, "project.invite").seq));
    assert.deepEqual(trouble(a), [], "A logged a refusal for the re-invite's frames");
    assertGuardsQuiet(a, bBack);
  } finally {
    await bBack?.stop();
    await a.stop();
    await b.stop();
  }
});