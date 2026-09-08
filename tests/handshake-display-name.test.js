/**
 * handshake-display-name — F-CONTACT-2 (design §D5). The optional, additive,
 * hostile-treated display name on the pairing handshake:
 *
 *  - acceptInviteCore (crow_accept_invite): adds `displayName` to the
 *    invite_accepted payload ONLY when profile_display_name is set (sanitized);
 *    omits the key entirely otherwise (byte-identical to today — no placeholder).
 *  - buildHandshakeComplete(ids, name?): includes `displayName` only for a
 *    non-null string; an old peer sees no new key.
 *  - handleInviteAccepted: sanitizes payload.displayName before upsert; a
 *    missing name falls back to crowId.
 *  - handleHandshakeComplete: applies the inviter's name to the AUTHENTICATED
 *    sender's contact, and ONLY over a placeholder stored name (never a
 *    user-typed one).
 *
 * Managers are stubbed (no live relays); a real on-disk libsql db runs the real
 * upsertFullContact / findContactByPubkey (invite-accepted-promote.test.js
 * precedent). The tool-harness half follows short-invite-tools.test.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleInviteAccepted, handleHandshakeComplete } from "../servers/sharing/boot.js";
import { buildHandshakeComplete, HANDSHAKE_COMPLETE_SUBTYPE } from "../servers/sharing/retry-queue.js";
import { registerContactsTools } from "../servers/sharing/tools/contacts.js";
import { deriveInstanceIdentity, generateInviteCode } from "../servers/sharing/identity.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "handshake-name-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const stubMgrs = () => ({
  syncManager: { initContact: async () => {} },
  peerManager: { joinContact: async () => {} },
  nostrManager: { subscribeToContact: async () => {}, sendControl: async () => ({ eventId: "a", relays: [] }) },
});

const PK = "02" + "c".repeat(64);
const PK_XONLY = "c".repeat(64);
const OTHER_PK = "02" + "e".repeat(64);

const invitePayload = (extra = {}) => ({
  type: "invite_accepted", crowId: "crow:realpeer9", ed25519Pub: "d".repeat(64), secp256k1Pub: PK, ...extra,
});

// --- buildHandshakeComplete: additive, old-peer-safe ----------------------

test("buildHandshakeComplete(ids) with no name emits NO displayName key (old-peer wire compat)", () => {
  const env = JSON.parse(buildHandshakeComplete(["e1", "e2"]));
  assert.equal(env.type, "crow_social");
  assert.equal(env.subtype, HANDSHAKE_COMPLETE_SUBTYPE);
  assert.deepEqual(env.payload.event_ids, ["e1", "e2"]);
  assert.ok(!("displayName" in env.payload), "no displayName key when none is supplied");
});

test("buildHandshakeComplete(ids, name) includes the displayName; a null/empty name is omitted", () => {
  assert.equal(JSON.parse(buildHandshakeComplete(["e1"], "Kevin")).payload.displayName, "Kevin");
  assert.ok(!("displayName" in JSON.parse(buildHandshakeComplete(["e1"], null)).payload));
  assert.ok(!("displayName" in JSON.parse(buildHandshakeComplete(["e1"], "")).payload));
});

// --- handleInviteAccepted: the F-CONTACT-2 reported case -------------------

test("invite_accepted with NO displayName → contact named crowId (byte-identical to today)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await handleInviteAccepted(db, stubMgrs(), invitePayload(), PK, { id: "no-name" });
    const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: ["crow:realpeer9"] })).rows[0];
    assert.ok(row, "contact created");
    assert.equal(row.display_name, "crow:realpeer9", "falls back to crowId when no name is on the wire");
  } finally { cleanup(); }
});

test("invite_accepted with a displayName → the contact takes it", async () => {
  const { db, cleanup } = freshDb();
  try {
    await handleInviteAccepted(db, stubMgrs(), invitePayload({ displayName: "Dayane" }), PK, { id: "named" });
    const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: ["crow:realpeer9"] })).rows[0];
    assert.equal(row.display_name, "Dayane");
  } finally { cleanup(); }
});

test("invite_accepted with a hostile displayName arrives sanitized, or falls back to crowId", async () => {
  const { db, cleanup } = freshDb();
  try {
    const fills = ["1", "2", "3", "4", "5"];
    const cases = [
      { name: "crow:deadbeef", check: (v, crowId) => assert.equal(v, crowId, "identity-string name rejected → crowId fallback") },
      { name: "a".repeat(10240), check: (v) => assert.equal(Array.from(v).length, 64, "10 KB name capped to 64 code points") },
      { name: "\u202eEvil", check: (v) => assert.equal(v, "Evil", "RTL override stripped") },
      { name: "Bad\u0000Name", check: (v) => assert.equal(v, "BadName", "embedded NUL stripped") },
      { name: "<img src=x onerror=alert(1)>", check: (v) => assert.equal(v, "<img src=x onerror=alert(1)>", "kept as inert text — escaped at the sink, not here") },
    ];
    for (let i = 0; i < cases.length; i++) {
      const pk = "02" + fills[i].repeat(64);
      const crowId = "crow:host" + fills[i];
      const p = { type: "invite_accepted", crowId, ed25519Pub: "d".repeat(64), secp256k1Pub: pk, displayName: cases[i].name };
      await handleInviteAccepted(db, stubMgrs(), p, pk, { id: "hostile-" + i });
      const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] })).rows[0];
      assert.ok(row, `contact ${crowId} created`);
      cases[i].check(row.display_name, crowId);
    }
  } finally { cleanup(); }
});

// --- handleHandshakeComplete: the symmetric (inviter→acceptor) case --------

async function seedContact(db, crowId, secpPubkey, displayName) {
  const res = await db.execute({
    sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES (?, ?, ?, ?)`,
    args: [crowId, "d".repeat(64), secpPubkey, displayName],
  });
  return Number(res.lastInsertRowid);
}
const nameOf = async (db, id) =>
  (await db.execute({ sql: "SELECT display_name FROM contacts WHERE id = ?", args: [id] })).rows[0]?.display_name;

test("handleHandshakeComplete applies the inviter's name over a PLACEHOLDER stored name", async () => {
  const { db, cleanup } = freshDb();
  try {
    const id = await seedContact(db, "crow:inviter1", PK, "crow:inviter1"); // placeholder (crowId)
    await handleHandshakeComplete(db, ["evt-1"], PK_XONLY, "Kevin");
    assert.equal(await nameOf(db, id), "Kevin");
  } finally { cleanup(); }
});

test("handleHandshakeComplete does NOT overwrite a user-typed name (placeholder rule)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const id = await seedContact(db, "crow:inviter2", PK, "My Friend"); // user-typed
    await handleHandshakeComplete(db, ["evt-1"], PK_XONLY, "Kevin");
    assert.equal(await nameOf(db, id), "My Friend", "a user-typed name is never overwritten by a handshake name");
  } finally { cleanup(); }
});

test("handleHandshakeComplete applies only to the AUTHENTICATED sender's contact", async () => {
  const { db, cleanup } = freshDb();
  try {
    const sender = await seedContact(db, "crow:sender", PK, "crow:sender"); // placeholder
    const other = await seedContact(db, "crow:other", OTHER_PK, "crow:other"); // placeholder
    await handleHandshakeComplete(db, ["evt-1"], PK_XONLY, "Kevin");
    assert.equal(await nameOf(db, sender), "Kevin", "the sender's contact takes the name");
    assert.equal(await nameOf(db, other), "crow:other", "a different contact is untouched");
  } finally { cleanup(); }
});

test("handleHandshakeComplete sanitizes the name; a rejected name leaves the placeholder", async () => {
  const { db, cleanup } = freshDb();
  try {
    const idA = await seedContact(db, "crow:inv-a", PK, "crow:inv-a");
    await handleHandshakeComplete(db, ["evt-1"], PK_XONLY, "\u202eEvil");
    assert.equal(await nameOf(db, idA), "Evil", "bidi override stripped before storage");

    const idB = await seedContact(db, "crow:inv-b", OTHER_PK, "crow:inv-b");
    await handleHandshakeComplete(db, ["evt-2"], OTHER_PK.slice(-64), "crow:deadbeef");
    assert.equal(await nameOf(db, idB), "crow:inv-b", "an identity-string name is rejected → placeholder stands");
  } finally { cleanup(); }
});

// --- acceptInviteCore (crow_accept_invite): the outbound wire --------------

function captureTools(registerFn, ctx) {
  const tools = {};
  const server = { tool: (name, _d, _s, handler) => { tools[name] = handler; } };
  registerFn(server, ctx);
  return tools;
}
function makeNostrStub(sent) {
  return {
    relays: new Map([["stub://r1", {}]]),
    async connectRelays() { return ["stub://r1"]; },
    async subscribeToContact() {},
    sendInviteAccepted: async (contact, content) => { sent.push({ contact, content }); return { eventId: "e", relays: ["stub://r1"] }; },
    sendMessage: async () => ({ eventId: "e", relays: ["stub://r1"] }),
  };
}

async function acceptWith({ db, profileName }) {
  const inviter = deriveInstanceIdentity(randomBytes(32));
  const acceptor = deriveInstanceIdentity(randomBytes(32));
  const code = generateInviteCode(inviter);
  if (profileName != null) {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', ?, datetime('now'))",
      args: [profileName],
    });
  }
  const sent = [];
  const tools = captureTools(registerContactsTools, {
    db, identity: acceptor,
    peerManager: { joinContact: async () => {} },
    syncManager: { initContact: async () => {} },
    nostrManager: makeNostrStub(sent),
  });
  const res = await tools.crow_accept_invite({ invite_code: code });
  assert.ok(!res.isError, `accept should succeed: ${res.content?.[0]?.text}`);
  assert.equal(sent.length, 1, "one invite_accepted sent to the inviter");
  return JSON.parse(sent[0].content);
}

test("crow_accept_invite OMITS displayName when profile_display_name is unset (byte-identical to today)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const payload = await acceptWith({ db, profileName: null });
    assert.equal(payload.type, "invite_accepted");
    assert.ok(!("displayName" in payload), "no displayName key when the local profile name is unset");
  } finally { cleanup(); }
});

test("crow_accept_invite includes the sanitized displayName when profile_display_name is set", async () => {
  const { db, cleanup } = freshDb();
  try {
    const payload = await acceptWith({ db, profileName: "Dayane" });
    assert.equal(payload.displayName, "Dayane");
  } finally { cleanup(); }
});

test("crow_accept_invite sanitizes a hostile profile_display_name before it hits the wire", async () => {
  const { db, cleanup } = freshDb();
  try {
    const payload = await acceptWith({ db, profileName: "\u202eEvil" });
    assert.equal(payload.displayName, "Evil", "bidi override stripped outbound");
  } finally { cleanup(); }
});

// --- Plan B (2026-09-08 §4.2): the avatar rides the handshake both ways -----

const PNG_AV = "data:image/png;base64," + "Q".repeat(64);
const peerOf = async (db, crowId) => (await db.execute({ sql: "SELECT display_name, peer_display_name, peer_avatar FROM contacts WHERE crow_id = ?", args: [crowId] })).rows[0];
function ackingMgrs(acks) {
  return { ...stubMgrs(), nostrManager: { subscribeToContact: async () => {}, sendControl: async (c, content) => { acks.push(JSON.parse(content)); return { eventId: "a", relays: [] }; } } };
}

test("buildHandshakeComplete(ids, name, avatar): the avatar key appears only for a non-empty string (old-peer wire compat)", () => {
  assert.equal(JSON.parse(buildHandshakeComplete(["e1"], "Kevin", PNG_AV)).payload.avatar, PNG_AV);
  assert.ok(!("avatar" in JSON.parse(buildHandshakeComplete(["e1"], "Kevin")).payload));
  assert.ok(!("avatar" in JSON.parse(buildHandshakeComplete(["e1"], "Kevin", null)).payload));
  assert.ok(!("avatar" in JSON.parse(buildHandshakeComplete(["e1"], "Kevin", "")).payload));
  assert.ok(!("avatar" in JSON.parse(buildHandshakeComplete(["e1"])).payload), "the one-arg form is byte-identical to before");
});

test("invite_accepted with displayName + avatar: peer fields stored; a bad avatar is ignored; the handshake still acks", async () => {
  const { db, cleanup } = freshDb();
  try {
    const acks = [];
    const mgrs = ackingMgrs(acks);
    await handleInviteAccepted(db, mgrs, invitePayload({ displayName: "Dayane", avatar: PNG_AV }), PK, { id: "av-1" });
    let row = await peerOf(db, "crow:realpeer9");
    assert.equal(row.display_name, "Dayane", "a brand-new row still takes the handshake name (today's behaviour)");
    assert.equal(row.peer_display_name, "Dayane");
    assert.equal(row.peer_avatar, PNG_AV);
    assert.equal(acks.length, 1, "acked");

    const p2 = { type: "invite_accepted", crowId: "crow:host2", ed25519Pub: "d".repeat(64), secp256k1Pub: OTHER_PK, displayName: "Two", avatar: "https://example.com/not-inline.png" };
    await handleInviteAccepted(db, mgrs, p2, OTHER_PK, { id: "av-2" });
    row = await peerOf(db, "crow:host2");
    assert.equal(row.peer_display_name, "Two");
    assert.equal(row.peer_avatar, null, "a URL avatar is ignored — never fails the handshake");
    assert.equal(acks.length, 2, "still acked");
  } finally { cleanup(); }
});

test("handleHandshakeComplete stores the inviter's name + avatar in the peer fields; the typed-name rule is unchanged", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, "crow:inv-typed", PK, "My Friend");
    await handleHandshakeComplete(db, ["evt-1"], PK_XONLY, "Kevin", PNG_AV);
    let row = await peerOf(db, "crow:inv-typed");
    assert.equal(row.display_name, "My Friend", "never overwritten");
    assert.equal(row.peer_display_name, "Kevin");
    assert.equal(row.peer_avatar, PNG_AV);

    const placeholder = await seedContact(db, "crow:inv-ph", OTHER_PK, "crow:inv-ph");
    await handleHandshakeComplete(db, ["evt-2"], OTHER_PK.slice(-64), "Kevin");
    assert.equal(await nameOf(db, placeholder), "Kevin", "the placeholder rule still applies");
    row = await peerOf(db, "crow:inv-ph");
    assert.equal(row.peer_display_name, "Kevin");
    assert.equal(row.peer_avatar, null, "no avatar on the wire = left alone");
  } finally { cleanup(); }
});

test("the inviter's ack carries its own avatar when profile_avatar_url holds a valid data URI", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', 'Inviter', datetime('now')), ('profile_avatar_url', ?, datetime('now'))", args: [PNG_AV] });
    const acks = [];
    await handleInviteAccepted(db, ackingMgrs(acks), invitePayload(), PK, { id: "ack-av" });
    assert.equal(acks.length, 1);
    assert.equal(acks[0].subtype, HANDSHAKE_COMPLETE_SUBTYPE);
    assert.equal(acks[0].payload.displayName, "Inviter");
    assert.equal(acks[0].payload.avatar, PNG_AV);
  } finally { cleanup(); }
});

test("crow_accept_invite includes a valid avatar in the acceptance and omits a legacy URL one", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_avatar_url', ?, datetime('now'))", args: [PNG_AV] });
    let payload = await acceptWith({ db, profileName: "Dayane" });
    assert.equal(payload.avatar, PNG_AV);
    assert.equal(payload.displayName, "Dayane");
    await db.execute({ sql: "UPDATE dashboard_settings SET value = 'https://example.com/me.png' WHERE key = 'profile_avatar_url'", args: [] });
    payload = await acceptWith({ db, profileName: null }); // the name row from the first accept is still there
    assert.ok(!("avatar" in payload), "a URL is not an avatar → key omitted");
  } finally { cleanup(); }
});

test("handshake_complete peer fields are dropped for a blocked contact and for a pending request row (R1-C1)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, is_blocked) VALUES ('crow:blk', ?, ?, 'Blocked', 1)", args: ["d".repeat(64), PK] });
    await handleHandshakeComplete(db, [], PK_XONLY, "Renamed", PNG_AV);
    let r = await peerOf(db, "crow:blk");
    assert.equal(r.peer_display_name, null, "a blocked contact cannot rename itself");
    assert.equal(r.peer_avatar, null);
    assert.equal(r.display_name, "Blocked");
    const req = "req:" + "e".repeat(64);
    await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, request_status) VALUES (?, ?, ?, NULL, 'pending')", args: [req, "d".repeat(64), OTHER_PK] });
    await handleHandshakeComplete(db, [], OTHER_PK.slice(-64), "Stranger", PNG_AV);
    r = await peerOf(db, req);
    assert.equal(r.peer_avatar, null, "an unpaired request row never stores 32 KB");
    assert.equal(r.peer_display_name, null);
    assert.equal(r.display_name, null, "and cannot name itself either (R2-S1)");
    // R2-S1: a BLOCKED contact whose stored name is a placeholder stays a placeholder.
    const BLK2 = "02" + "b".repeat(64);
    await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, is_blocked) VALUES ('crow:blkph', ?, ?, 'crow:blkph', 1)", args: ["d".repeat(64), BLK2] });
    await handleHandshakeComplete(db, [], BLK2.slice(-64), "I Renamed Myself", PNG_AV);
    r = await peerOf(db, "crow:blkph");
    assert.equal(r.display_name, "crow:blkph");
    assert.equal(r.peer_display_name, null);
    // R2-1: an ACCEPTED message request is an established contact — both writes land.
    const ACC = "02" + "a".repeat(64);
    await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, request_status) VALUES ('crow:accepted1', '', ?, 'crow:accepted1', 'accepted')", args: [ACC] });
    await handleHandshakeComplete(db, [], ACC.slice(-64), "Accepted Pal", PNG_AV);
    r = await peerOf(db, "crow:accepted1");
    assert.equal(r.display_name, "Accepted Pal");
    assert.equal(r.peer_display_name, "Accepted Pal");
    assert.equal(r.peer_avatar, PNG_AV);
  } finally { cleanup(); }
});
