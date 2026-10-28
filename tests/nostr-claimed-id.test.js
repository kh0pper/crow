/**
 * PT-3 (private engineering notes), the Nostr half: group, room and call
 * items are bound to the AUTHENTICATED signer's key, never to a Crow ID or a
 * name the payload claims; a contact row's Crow ID must match its Ed25519 key
 * on every writing path; a key-bound `hs_cb: 1` advert pins "this contact
 * binds" for the Hyperswarm verifier; non-contacts are shown, labelled.
 *
 * Real init-db scratch DBs and real identities throughout. Every negative leg
 * follows a positive control in the same harness.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NoiseSecretStream from "@hyperswarm/secret-stream";

import { makeRealDb, socketPair, until, sleep } from "./fixtures/sync-fleet.mjs";
import { oldTree } from "./fixtures/old-tree.mjs";
import { deriveInstanceIdentity, sign } from "../servers/sharing/identity.js";
import { upsertFullContact } from "../servers/sharing/contact-promote.js";
import { CB_PIN_PREFIX, wireContactBinding } from "../servers/sharing/contact-binding.js";
import {
  handleGroupMessageNotify, handleInviteAccepted, handleHandshakeComplete,
  wireNostrReceive, initSharingRuntime,
} from "../servers/sharing/boot.js";
import * as peerProfile from "../servers/sharing/peer-profile.js";
import { buildHandshakeComplete, HANDSHAKE_COMPLETE_SUBTYPE } from "../servers/sharing/retry-queue.js";
import { handleInboundRoomEnvelope } from "../servers/sharing/room-inbound.js";
import { createRoom, getRoomByUid, listRoomMembers } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";
import { registerContactsTools } from "../servers/sharing/tools/contacts.js";
import { deleteContactLocal } from "../servers/sharing/contact-delete.js";
import { PeerManager } from "../servers/sharing/peer-manager.js";

const { handleProfileMessage, buildProfileMessage, PROFILE_SUBTYPE } = peerProfile;
const applyBindingAdvert = (...a) => peerProfile.applyBindingAdvert(...a);
const advertiseBindingToContacts = (...a) => peerProfile.advertiseBindingToContacts(...a);
const HS_CB_ADVERT_PREFIX = peerProfile.HS_CB_ADVERT_PREFIX ?? "contact_hs_cb_adv:";

const PT3_BASE_SHA = "697d5d07ba915994b3d591d55dbce820c2274b14";
const T = { timeout: 60_000 };
const MISMATCH = "Crow ID does not match its public key";

// ---------------------------------------------------------------- logs
const logs = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const capture = (...a) => { logs.push(a.map(String).join(" ")); };
const linesWith = (s) => logs.filter((l) => l.includes(s));

let old = null;
before(async () => {
  console.log = capture; console.warn = capture;
  old = await oldTree(PT3_BASE_SHA);
}, { timeout: 300_000 });
after(() => {
  Object.assign(console, realConsole);
  old?.cleanup();
});

// ---------------------------------------------------------------- helpers
const id = () => deriveInstanceIdentity(randomBytes(32));
const xo = (ident) => ident.secp256k1Pubkey.slice(-64); // Nostr event.pubkey (x-only)

async function freshDb(t, tag = "n") {
  const dir = mkdtempSync(join(tmpdir(), `pt3-nostr-${tag}-`));
  const db = await makeRealDb(dir);
  t.after(() => { try { db.close?.(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return db;
}
async function addFull(db, ident, name) {
  const r = await upsertFullContact(db, {}, {
    crowId: ident.crowId, ed25519Pub: ident.ed25519Pubkey, secp256k1Pub: ident.secp256k1Pubkey, displayName: name,
  });
  return r.contactId;
}
const one = async (db, sql, args = []) => (await db.execute({ sql, args })).rows[0] || null;
const all = async (db, sql, args = []) => (await db.execute({ sql, args })).rows;
const contactRow = (db, contactId) => one(db, "SELECT * FROM contacts WHERE id = ?", [contactId]);
const msgCount = async (db, contactId) => Number((await one(db, "SELECT COUNT(*) AS n FROM messages WHERE contact_id = ?", [contactId])).n);
const notifs = (db) => all(db, "SELECT title, source, action_url FROM notifications ORDER BY id");
const pinOf = async (db, localId, crowId) => (await one(db,
  "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", [CB_PIN_PREFIX + crowId, localId]))?.value ?? null;
const pinCount = async (db) => Number((await one(db, "SELECT COUNT(*) AS n FROM dashboard_settings_overrides WHERE key LIKE 'contact_hs_cb:%'")).n);

/** The three onSocial/onInvite/onRequest callbacks wireNostrReceive registers. */
async function wiredHandlers(db, { localId = null, sent = [] } = {}) {
  let h = null;
  const managers = {
    db, identity: id(), peerManager: { localInstanceId: localId }, syncManager: {},
    instanceSyncManager: { localInstanceId: localId },
    nostrManager: {
      subscribeToContact: async () => {},
      subscribeToIncoming: async (onInvite, onSocial, onRequest) => { h = { onInvite, onSocial, onRequest }; },
      sendControl: async (to, content) => { sent.push({ to, content }); return { relays: ["stub://r"] }; },
    },
  };
  await wireNostrReceive(managers);
  return h;
}

// ================================================================ N-1
test("N-1a group_message: X's own key naming X is stored under X and titled with X's STORED name, not the payload's", T, async (t) => {
  const db = await freshDb(t, "n1a");
  const X = id();
  const xId = await addFull(db, X, "Xavier");
  await handleGroupMessageNotify(db, { group_name: "G", sender_name: "Somebody Else", message: "n1a hello", sender_crow_id: X.crowId }, xo(X));
  assert.equal(await msgCount(db, xId), 1);
  const n = await notifs(db);
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "[G] Xavier");
  assert.equal(n[0].source, "sharing:group_message");
});

test("N-1b group_message: contact Y's key claiming X is stored under Y, nothing in X's thread, one mismatch log line", T, async (t) => {
  const db = await freshDb(t, "n1b");
  const X = id(), Y = id();
  const xId = await addFull(db, X, "Xavier");
  const yId = await addFull(db, Y, "Yvonne");
  // Control: Y naming itself.
  await handleGroupMessageNotify(db, { group_name: "G", message: "n1b control", sender_crow_id: Y.crowId }, xo(Y));
  assert.equal(await msgCount(db, yId), 1, "control: Y's own message is stored under Y");
  const before = linesWith("group_message sender_crow_id does not match the signer").length;
  await handleGroupMessageNotify(db, { group_name: "G", sender_name: "Xavier", message: "n1b claim", sender_crow_id: X.crowId }, xo(Y));
  assert.equal(await msgCount(db, yId), 2, "stored under the signer Y");
  assert.equal(await msgCount(db, xId), 0, "nothing in X's thread");
  assert.equal(linesWith("group_message sender_crow_id does not match the signer").length - before, 1, "one mismatch log line");
  const n = await notifs(db);
  assert.equal(n.at(-1).title, "[G] Yvonne", "titled with the signer's stored name");
});

test("N-1c group_message: a BLOCKED Y's key claiming an unblocked X stores nothing and notifies nothing", T, async (t) => {
  const db = await freshDb(t, "n1c");
  const X = id(), Y = id();
  const xId = await addFull(db, X, "Xavier");
  const yId = await addFull(db, Y, "Yvonne");
  await handleGroupMessageNotify(db, { group_name: "G", message: "n1c control", sender_crow_id: X.crowId }, xo(X));
  assert.equal(await msgCount(db, xId), 1, "control: X is stored");
  assert.equal((await notifs(db)).length, 1, "control: X notifies");
  await db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?", args: [yId] });
  await handleGroupMessageNotify(db, { group_name: "G", message: "n1c claim", sender_crow_id: X.crowId }, xo(Y));
  assert.equal(await msgCount(db, xId), 1, "nothing new under X");
  assert.equal(await msgCount(db, yId), 0, "nothing under blocked Y");
  assert.equal((await notifs(db)).length, 1, "no notification");
});

test("N-1d group_message: a stranger claiming X is not stored; its notification is labelled and never shows the payload name", T, async (t) => {
  const db = await freshDb(t, "n1d");
  const X = id(), S = id();
  const xId = await addFull(db, X, "Xavier");
  await handleGroupMessageNotify(db, { group_name: "G", message: "n1d control", sender_crow_id: X.crowId }, xo(X));
  assert.equal((await notifs(db))[0].source, "sharing:group_message", "control: plain source for a contact");
  await handleGroupMessageNotify(db, { group_name: "G", sender_name: "Xavier", message: "n1d claim", sender_crow_id: X.crowId }, xo(S));
  assert.equal(await msgCount(db, xId), 1, "not stored under X");
  assert.equal(Number((await one(db, "SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%n1d claim%'")).n), 0, "not stored at all");
  const n = (await notifs(db)).at(-1);
  assert.equal(n.source, "sharing:group_message_unverified");
  assert.match(n.title, /\(not in your contacts\)/);
  assert.equal(n.title.includes("Xavier"), false, "the payload name is never shown");
});

// ================================================================ N-2
test("N-2a/b invite_accepted: a real identity creates a row; a mismatched ed25519Pub creates none", T, async (t) => {
  const db = await freshDb(t, "n2ab");
  const A = id(), B = id(), M = id();
  await handleInviteAccepted(db, {}, { crowId: A.crowId, ed25519Pub: A.ed25519Pubkey, secp256k1Pub: A.secp256k1Pubkey, displayName: "Ann" }, xo(A));
  assert.ok(await one(db, "SELECT id FROM contacts WHERE crow_id = ?", [A.crowId]), "control: created");
  await handleInviteAccepted(db, {}, { crowId: B.crowId, ed25519Pub: M.ed25519Pubkey, secp256k1Pub: B.secp256k1Pubkey, displayName: "Bob" }, xo(B));
  assert.equal(await one(db, "SELECT id FROM contacts WHERE crow_id = ?", [B.crowId]), null, "no row for a mismatched key");
  assert.ok(linesWith(MISMATCH).length >= 1, "the refusal is logged");
});

test("N-2c promote path: full contact Y naming an unused Crow ID Z (with Z's real key) throws and leaves Y's row unchanged", T, async (t) => {
  const db = await freshDb(t, "n2c");
  const Y = id(), Z = id();
  const yId = await addFull(db, Y, "Yvonne");
  // Control: Y's honest re-send is a no-op.
  const ok = await upsertFullContact(db, {}, { crowId: Y.crowId, ed25519Pub: Y.ed25519Pubkey, secp256k1Pub: Y.secp256k1Pubkey });
  assert.equal(ok.outcome, "noop");
  await assert.rejects(
    upsertFullContact(db, {}, { crowId: Z.crowId, ed25519Pub: Z.ed25519Pubkey, secp256k1Pub: Y.secp256k1Pubkey }),
    { message: MISMATCH },
  );
  // And through the real receive handler (which must never throw).
  await handleInviteAccepted(db, {}, { crowId: Z.crowId, ed25519Pub: Z.ed25519Pubkey, secp256k1Pub: Y.secp256k1Pubkey }, xo(Y));
  const row = await contactRow(db, yId);
  assert.equal(row.crow_id, Y.crowId, "Y's crow_id is still Y's");
  assert.equal(row.ed25519_pubkey, Y.ed25519Pubkey);
  assert.equal(await one(db, "SELECT id FROM contacts WHERE crow_id = ?", [Z.crowId]), null);
});

test("N-2d merge path: an owner row whose key does not match its Crow ID throws before the DELETE", T, async (t) => {
  const run = async (ownerKey) => {
    const db = await freshDb(t, "n2d");
    const X = id(), O = id();
    await db.execute({
      sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type) VALUES (?, 'Owner', ?, ?, 'crow')",
      args: [X.crowId, ownerKey(X), O.secp256k1Pubkey],
    });
    const req = await db.execute({
      sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, request_status, contact_type) VALUES (?, ?, '', 'pending', 'crow')",
      args: ["req:" + xo(X), X.secp256k1Pubkey],
    });
    const reqId = Number(req.lastInsertRowid);
    await db.execute({ sql: "INSERT INTO messages (contact_id, nostr_event_id, content, direction) VALUES (?, 'ev-n2d', 'hi', 'received')", args: [reqId] });
    const p = upsertFullContact(db, {}, { crowId: X.crowId, ed25519Pub: X.ed25519Pubkey, secp256k1Pub: X.secp256k1Pubkey });
    return { db, reqId, p };
  };
  // Control: an owner holding X's own key merges.
  {
    const { db, reqId, p } = await run((X) => X.ed25519Pubkey);
    assert.equal((await p).outcome, "merged");
    assert.equal(await contactRow(db, reqId), null, "control: the request row was folded");
  }
  const M = id();
  const { db, reqId, p } = await run(() => M.ed25519Pubkey);
  await assert.rejects(p, { message: MISMATCH });
  assert.ok(await contactRow(db, reqId), "the request row was not deleted");
  assert.equal(await msgCount(db, reqId), 1, "its messages were not moved");
});

test("N-2e crow_add_contact: a mismatched key returns the exact error text; an empty key is accepted", T, async (t) => {
  const db = await freshDb(t, "n2e");
  const tools = {};
  registerContactsTools({ tool: (name, _d, _s, h) => { tools[name] = h; } }, {
    db, identity: id(), syncManager: { initContact: async () => {} }, peerManager: { joinContact: async () => {} },
    nostrManager: { relays: new Map([["stub://r", {}]]), subscribeToContact: async () => {} },
  });
  const A = id(), B = id(), C = id();
  const okRes = await tools.crow_add_contact({ crow_id: A.crowId, secp256k1_pubkey: A.secp256k1Pubkey, ed25519_pubkey: A.ed25519Pubkey });
  assert.equal(okRes.isError, undefined, "control: a matching key is added");
  const bad = await tools.crow_add_contact({ crow_id: B.crowId, secp256k1_pubkey: B.secp256k1Pubkey, ed25519_pubkey: C.ed25519Pubkey });
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].text, `Failed to add contact: ${MISMATCH}`);
  assert.equal(await one(db, "SELECT id FROM contacts WHERE crow_id = ?", [B.crowId]), null);
  const empty = await tools.crow_add_contact({ crow_id: C.crowId, secp256k1_pubkey: C.secp256k1Pubkey });
  assert.equal(empty.isError, undefined, "an empty key is accepted");
  assert.ok(await one(db, "SELECT id FROM contacts WHERE crow_id = ?", [C.crowId]));
});

// ================================================================ N-3
async function roomSetup(t) {
  const db = await freshDb(t, "n3");
  const ME = id(), H = id(), Y = id(), X = id();
  const ids = {
    H: await addFull(db, H, "Hal"), Y: await addFull(db, Y, "Yvonne"), X: await addFull(db, X, "Xavier"),
  };
  const nostrManager = { async sendControl() {} };
  const env = (subtype, payload, signer) => handleInboundRoomEnvelope({
    db, nostrManager, identity: { crowId: ME.crowId }, subtype, payload, senderPubkey: xo(signer),
  });
  const memberIds = async (uid) => (await listRoomMembers(db, (await getRoomByUid(db, uid)).id)).map((m) => Number(m.id)).sort();
  return { db, ME, H, Y, X, ids, env, memberIds };
}

test("N-3a room_join: the host's own join creates the room; a join naming another host, or for a room we host, is dropped", T, async (t) => {
  const { db, ME, H, Y, X, ids, env, memberIds } = await roomSetup(t);
  await env("room_join", { room_uid: "u-h", room_name: "Hal's", host_crow_id: H.crowId, members: [{ crow_id: Y.crowId }] }, H);
  const room = await getRoomByUid(db, "u-h");
  assert.ok(room, "control: created");
  assert.equal(room.host_crow_id, H.crowId);
  assert.deepEqual(await memberIds("u-h"), [Number(ids.Y)], "control: members added");

  await env("room_join", { room_uid: "u-x", room_name: "Claimed", host_crow_id: X.crowId, members: [] }, H);
  assert.equal(await getRoomByUid(db, "u-x"), null, "H naming X as host is dropped");

  const ours = await createRoom(db, { name: "Mine", memberContactIds: [ids.H], hostCrowId: ME.crowId });
  for (const host of [Y.crowId, ME.crowId]) {
    await env("room_join", { room_uid: ours.roomUid, room_name: "Mine", host_crow_id: host, members: [{ crow_id: X.crowId }] }, Y);
  }
  assert.deepEqual(await memberIds(ours.roomUid), [Number(ids.H)], "our room's membership is unchanged");
  assert.equal((await getRoomByUid(db, ours.roomUid)).host_crow_id, ME.crowId);
});

test("N-3b room_join: contact Y joining H's existing room is dropped; H's own follow-up join adds members", T, async (t) => {
  const { db, H, Y, X, ids, env, memberIds } = await roomSetup(t);
  await env("room_join", { room_uid: "u-h", room_name: "Hal's", host_crow_id: H.crowId, members: [] }, H);
  await env("room_join", { room_uid: "u-h", room_name: "Hal's", host_crow_id: Y.crowId, members: [{ crow_id: X.crowId }] }, Y);
  assert.deepEqual(await memberIds("u-h"), [], "Y's join for H's room added nobody");
  assert.equal((await getRoomByUid(db, "u-h")).host_crow_id, H.crowId);
  await env("room_join", { room_uid: "u-h", room_name: "Hal's", host_crow_id: H.crowId, members: [{ crow_id: X.crowId }] }, H);
  assert.deepEqual(await memberIds("u-h"), [Number(ids.X)], "control: the host adds members to its own room");
});

test("N-3c host-relay room_message: a non-member author is unattributed and labelled via the host; a member author is attributed, still via the host", T, async (t) => {
  const { db, H, X, Y, ids, env } = await roomSetup(t);
  await env("room_join", { room_uid: "u-h", room_name: "Hal's", host_crow_id: H.crowId, members: [{ crow_id: Y.crowId }] }, H);
  const gid = (await getRoomByUid(db, "u-h")).id;
  const row = (uid) => one(db, "SELECT sender_contact_id, sender_label FROM room_messages WHERE msg_uid = ?", [uid]);

  await env("room_message", { room_uid: "u-h", msg_uid: "m-y", author: { kind: "human", crow_id: Y.crowId, display_name: "Payload Y" }, text: "from Y" }, H);
  const ry = await row("m-y");
  assert.equal(Number(ry.sender_contact_id), Number(ids.Y), "control: a member author is attributed");
  assert.equal(ry.sender_label, "Yvonne via Hal", "the member's stored name, not the payload's");

  await env("room_message", { room_uid: "u-h", msg_uid: "m-x", author: { kind: "human", crow_id: X.crowId, display_name: "Claimed\u202E X" }, text: "claims X" }, H);
  const rx = await row("m-x");
  assert.equal(rx.sender_contact_id, null, "X is not a member: unattributed");
  assert.equal(rx.sender_label, "Claimed X via Hal", "the host's (sanitized) label, not X's stored name");
  assert.ok(gid);
});

// ================================================================ N-4
async function bootRuntime(db, ident, { localId = "inst-n4", sent = null, delayMs } = {}) {
  const pm = new PeerManager(ident, { env: {} });
  pm.p2pDisabled = true;
  const managers = {
    db, identity: ident, peerManager: pm,
    syncManager: { initContact: async () => {}, closeContactFeeds: async () => {} },
    instanceSyncManager: { localInstanceId: localId, feedsDisabled: true },
    nostrManager: {
      subscribeToContact: async () => {}, subscribeToIncoming: async () => {}, unsubscribeFromContact: async () => {},
      ...(sent ? { sendControl: async (to, content) => { sent.push({ to, content }); return { relays: ["stub://r"] }; } } : {}),
    },
  };
  await initSharingRuntime(managers, {
    applyProjectCloneBundle: async () => ({}), buildProjectCloneBundle: async () => ({}),
    ...(delayMs !== undefined ? { bindingAdvertDelayMs: delayMs } : {}),
  });
  return pm;
}
const SCAN = "full contact(s) whose Crow ID does not match the public key";

test("N-4 boot scan: zero squat rows log nothing; one squat row logs one line with count 1", T, async (t) => {
  {
    const db = await freshDb(t, "n4a");
    await addFull(db, id(), "Honest");
    const before = linesWith(SCAN).length;
    await bootRuntime(db, id());
    await sleep(300);
    assert.equal(linesWith(SCAN).length, before, "control: no line for zero squat rows");
  }
  const db = await freshDb(t, "n4b");
  await addFull(db, id(), "Honest");
  const S = id(), M = id();
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type) VALUES (?, 'Squat', ?, ?, 'crow')",
    args: [S.crowId, M.ed25519Pubkey, S.secp256k1Pubkey],
  });
  const before = linesWith(SCAN).length;
  await bootRuntime(db, id());
  assert.ok(await until(() => linesWith(SCAN).length > before, 3000), "a line is logged");
  await sleep(200);
  const fresh = linesWith(SCAN).slice(before);
  assert.equal(fresh.length, 1, "one line");
  assert.match(fresh[0], new RegExp(`\\b1 ${SCAN.replace(/[()]/g, "\\$&")}`));
  assert.equal((await one(db, "SELECT ed25519_pubkey FROM contacts WHERE crow_id = ?", [S.crowId])).ed25519_pubkey, M.ed25519Pubkey, "nothing modified");
});

// ================================================================ N-5
test("N-5a room_invite: a stranger's call is labelled; a contact's uses the stored name; names are sanitized and capped at 60", T, async (t) => {
  const db = await freshDb(t, "n5a");
  const H = id(), S = id();
  await addFull(db, H, "Hal");
  const h = await wiredHandlers(db);
  await h.onSocial("room_invite", { room_code: "r1", join_url: "https://call.example/r1", host_name: "Spoofed" }, xo(H));
  let n = (await notifs(db)).at(-1);
  assert.equal(n.source, "sharing:room_invite", "control: plain source for a contact");
  assert.equal(n.title, "Hal is calling", "control: the stored name");

  await h.onSocial("room_invite", { room_code: "r2", join_url: "https://call.example/r2", host_name: "Ev\u0007il‮ Name" }, xo(S));
  n = (await notifs(db)).at(-1);
  assert.equal(n.source, "sharing:room_invite_unverified");
  assert.match(n.title, /\(not in your contacts\)/);
  assert.ok(n.title.includes("Evil Name"), `sanitized name in ${JSON.stringify(n.title)}`);
  assert.equal(n.action_url, "https://call.example/r2", "the link is kept (the browser puts it behind the label)");

  await h.onSocial("room_invite", { room_code: "r3", join_url: "https://call.example/r3", host_name: "a".repeat(100) }, xo(S));
  n = (await notifs(db)).at(-1);
  assert.ok(n.title.includes("a".repeat(60)) && !n.title.includes("a".repeat(61)), "capped at 60 characters");
});

test("N-5b voice_memo and reaction: strangers get _unverified sources and the label; contacts the stored name; a blocked contact nothing", T, async (t) => {
  const db = await freshDb(t, "n5b");
  const C = id(), S = id(), B = id();
  await addFull(db, C, "Cleo");
  const bId = await addFull(db, B, "Blocked One");
  await db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?", args: [bId] });
  const h = await wiredHandlers(db);

  await h.onSocial("voice_memo", { text: "memo text", sender_name: "Spoof" }, xo(C));
  let n = (await notifs(db)).at(-1);
  assert.deepEqual([n.source, n.title], ["sharing:voice_memo", "Voice memo from Cleo"]);
  await h.onSocial("voice_memo", { text: "memo text", sender_name: "Stranger" }, xo(S));
  n = (await notifs(db)).at(-1);
  assert.equal(n.source, "sharing:voice_memo_unverified");
  assert.match(n.title, /Stranger \(not in your contacts\)/);

  await h.onSocial("reaction", { emoji: "👍", sender_name: "Spoof" }, xo(C));
  n = (await notifs(db)).at(-1);
  assert.deepEqual([n.source, n.title], ["sharing:reaction", "Cleo reacted 👍"]);
  await h.onSocial("reaction", { emoji: "👍", sender_name: "Stranger" }, xo(S));
  n = (await notifs(db)).at(-1);
  assert.equal(n.source, "sharing:reaction_unverified");
  assert.match(n.title, /Stranger \(not in your contacts\)/);

  const count = (await notifs(db)).length;
  for (const [sub, p] of [["voice_memo", { text: "x", sender_name: "B" }], ["reaction", { emoji: "x" }], ["room_invite", { room_code: "r", join_url: "https://call.example/b" }]]) {
    await h.onSocial(sub, p, xo(B));
  }
  assert.equal((await notifs(db)).length, count, "a blocked contact's items notify nothing");
});

// ================================================================ N-6
test("N-6a profile with hs_cb:1 from contact B's key pins B; a stranger's or a blocked B's does not", T, async (t) => {
  const localId = "inst-n6a";
  const db = await freshDb(t, "n6a");
  const B = id(), S = id();
  const bId = await addFull(db, B, "Bee");
  await handleProfileMessage(db, { v: 1, display_name: "Bee" }, xo(B), { localInstanceId: localId });
  assert.equal(await pinOf(db, localId, B.crowId), null, "control: no hs_cb, no pin");
  assert.equal(await handleProfileMessage(db, { v: 1, hs_cb: 1 }, xo(S), { localInstanceId: localId }).then((r) => r.applied), false);
  assert.equal(await pinCount(db), 0, "a stranger pins nothing");
  await db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?", args: [bId] });
  await handleProfileMessage(db, { v: 1, hs_cb: 1 }, xo(B), { localInstanceId: localId });
  assert.equal(await pinCount(db), 0, "a blocked B pins nothing");
  await db.execute({ sql: "UPDATE contacts SET is_blocked = 0 WHERE id = ?", args: [bId] });
  await handleProfileMessage(db, { v: 1, hs_cb: 1 }, xo(B), { localInstanceId: localId });
  assert.equal(await pinOf(db, localId, B.crowId), "1", "B is pinned");
  // A missing local id writes nothing.
  const db2 = await freshDb(t, "n6a2");
  await addFull(db2, B, "Bee");
  await handleProfileMessage(db2, { v: 1, hs_cb: 1 }, xo(B), {});
  assert.equal(await pinCount(db2), 0, "no local id: no pin written");
  // applyBindingAdvert directly: a request row is not a full contact.
  assert.equal(await applyBindingAdvert(db, localId, { crow_id: "req:" + xo(S), request_status: "accepted", is_blocked: 0 }, { hs_cb: 1 }), false);
});

test("N-6b the wired receive path: profile and handshake_complete carrying hs_cb:1 pin under the instance's local id", T, async (t) => {
  const localId = "inst-n6b";
  const db = await freshDb(t, "n6b");
  const B = id(), C = id();
  await addFull(db, B, "Bee");
  await addFull(db, C, "Cee");
  const h = await wiredHandlers(db, { localId });
  await h.onSocial(HANDSHAKE_COMPLETE_SUBTYPE, { event_ids: [] }, xo(C));
  assert.equal(await pinOf(db, localId, C.crowId), null, "control: handshake_complete without hs_cb does not pin");
  await h.onSocial(PROFILE_SUBTYPE, { v: 1, hs_cb: 1 }, xo(B));
  assert.equal(await pinOf(db, localId, B.crowId), "1");
  await h.onSocial(HANDSHAKE_COMPLETE_SUBTYPE, JSON.parse(buildHandshakeComplete([], "Cee", null)).payload, xo(C));
  assert.equal(await pinOf(db, localId, C.crowId), "1");
  // Direct handler signature too.
  const D = id();
  await addFull(db, D, "Dee");
  await handleHandshakeComplete(db, [], xo(D), null, null, { advert: { hs_cb: 1 }, localInstanceId: localId });
  assert.equal(await pinOf(db, localId, D.crowId), "1");
});

test("N-6c senders: the profile message and handshake_complete carry hs_cb:1", T, async () => {
  assert.equal(JSON.parse(buildProfileMessage({ displayName: "Me" })).payload.hs_cb, 1);
  assert.equal(JSON.parse(buildHandshakeComplete(["e1"], "Me", null)).payload.hs_cb, 1);
});

test("N-6d the OLD receiver ignores hs_cb: the base tree's handleProfileMessage applies it exactly as without it", T, async (t) => {
  const { handleProfileMessage: oldHandle } = await old.importModule("servers/sharing/peer-profile.js");
  const B = id();
  const results = [];
  for (const payload of [{ v: 1, display_name: "Bee Peer" }, { v: 1, display_name: "Bee Peer", hs_cb: 1 }]) {
    const db = await freshDb(t, "n6d");
    const cid = await addFull(db, B, "Bee");
    const r = await oldHandle(db, payload, xo(B));
    const row = await contactRow(db, cid);
    results.push({ applied: r.applied, changed: r.changed, peer: row.peer_display_name, avatar: row.peer_avatar ?? null, pins: await pinCount(db) });
  }
  assert.equal(results[0].applied, true, "control: the old receiver applies the profile");
  assert.deepEqual(results[1], results[0]);

  // The advert-only payload R9 actually sends leaves the old receiver's row unchanged.
  const db = await freshDb(t, "n6d-adv");
  const cid = await addFull(db, B, "Bee");
  await oldHandle(db, { v: 1, display_name: "Bee Peer", avatar: null }, xo(B));
  const before = await contactRow(db, cid);
  assert.equal(before.peer_display_name, "Bee Peer", "control: a prior profile is stored");
  const r = await oldHandle(db, JSON.parse(peerProfile.buildBindingAdvertMessage()).payload, xo(B));
  assert.equal(r.changed, false, "the old receiver changes nothing");
  assert.deepEqual(await contactRow(db, cid), before, "the row is unchanged");
  assert.equal(await pinCount(db), 0);
});

// -------- R1: a pin set ONLY by the real advert handler makes a real PeerManager refuse a legacy response
async function streams(xInitiator = true) {
  const [s1, s2] = await socketPair();
  const x = new NoiseSecretStream(xInitiator, s1);
  const y = new NoiseSecretStream(!xInitiator, s2);
  x.on("error", () => {}); y.on("error", () => {});
  return [x, y];
}
/** A raw legacy (bare-signature) responder claiming `who` to `pm`. */
async function legacyLeg(t, pm, who) {
  const [p, r] = await streams(true);
  pm._handleConnection(p, {});
  const frames = [];
  let buf = "", closed = false;
  r.once("close", () => { closed = true; });
  r.on("data", (d) => {
    buf += d.toString();
    const ls = buf.split("\n"); buf = ls.pop();
    for (const l of ls) if (l.trim()) { try { frames.push(JSON.parse(l)); } catch {} }
  });
  t.after(() => { p.destroy(); r.destroy(); });
  assert.ok(await until(() => frames.some((f) => f.type === "challenge"), 3000), "pm sent its challenge");
  const ch = frames.find((f) => f.type === "challenge");
  const resp = { type: "challenge-response", crowId: who.crowId, pubkey: who.ed25519Pubkey, signature: sign(ch.challenge, who.ed25519Priv) };
  r.write(JSON.stringify(resp) + "\n" + JSON.stringify({ type: "authenticated" }) + "\n");
  return { get closed() { return closed; } };
}
const refusalsOf = (crowId) => logs.filter((l) => l.startsWith(`[peer-manager] contact refused ${crowId}: `));

test("N-6e (R1) a contact pinned ONLY through the real advert handler is refused cb_required_pinned on a legacy Hyperswarm response", T, async (t) => {
  const localId = "inst-n6e";
  const A = id(), B = id();
  const mkPm = (db) => {
    const pm = new PeerManager(A, { env: {} });
    pm.p2pDisabled = true;
    pm.localInstanceId = localId;
    wireContactBinding(pm, { db, localInstanceId: localId });
    return pm;
  };
  // Control: same harness, no advert → the legacy response is admitted.
  {
    const db = await freshDb(t, "n6e-ctl");
    await addFull(db, B, "Bee");
    const pm = mkPm(db);
    await legacyLeg(t, pm, B);
    assert.ok(await until(() => pm.isConnected(B.crowId), 5000), "control: legacy admitted while unpinned");
  }
  const db = await freshDb(t, "n6e");
  await addFull(db, B, "Bee");
  const h = await wiredHandlers(db, { localId });
  await h.onSocial(PROFILE_SUBTYPE, { v: 1, hs_cb: 1 }, xo(B)); // the only pin source
  assert.equal(await pinOf(db, localId, B.crowId), "1");
  const pm = mkPm(db);
  const before = refusalsOf(B.crowId).length;
  const leg = await legacyLeg(t, pm, B);
  assert.ok(await until(() => leg.closed, 5000), "destroyed");
  assert.equal(pm.isConnected(B.crowId), false);
  assert.deepEqual(refusalsOf(B.crowId).slice(before).map((l) => l.split(": ").pop()), ["cb_required_pinned"]);
});

// -------- R9: the advert reaches existing contacts proactively, once
test("N-6f (R9) after an update, each existing full contact gets exactly one hs_cb advert; a second boot sends none", T, async (t) => {
  const db = await freshDb(t, "n6f");
  const B = id(), C = id(), R = id();
  await addFull(db, B, "Bee");
  await addFull(db, C, "Cee");
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, request_status, contact_type) VALUES (?, ?, '', 'pending', 'crow')",
    args: ["req:" + xo(R), R.secp256k1Pubkey],
  });
  const sent = [];
  const adverts = () => sent.filter((s) => {
    const m = JSON.parse(s.content);
    return m.subtype === PROFILE_SUBTYPE && m.payload?.hs_cb === 1;
  });
  await bootRuntime(db, id(), { localId: "inst-n6f", sent, delayMs: 0 });
  assert.ok(await until(() => adverts().length >= 2, 5000), "both contacts advertised");
  await sleep(300);
  const to = adverts().map((s) => s.to.secp256k1_pubkey).sort();
  assert.deepEqual(to, [B.secp256k1Pubkey, C.secp256k1Pubkey].sort(), "exactly one each, full contacts only");
  const payload = JSON.parse(adverts()[0].content).payload;
  assert.equal("display_name" in payload || "avatar" in payload, false, "the advert carries no profile fields (nothing is cleared)");
  // Markers are LOCAL overrides.
  const markers = await all(db, "SELECT key, instance_id FROM dashboard_settings_overrides WHERE key LIKE ?", [HS_CB_ADVERT_PREFIX + "%"]);
  assert.equal(markers.length, 2);
  assert.ok(markers.every((m) => m.instance_id === "inst-n6f"));

  await bootRuntime(db, id(), { localId: "inst-n6f", sent, delayMs: 0 });
  await sleep(500);
  assert.equal(adverts().length, 2, "a second boot sends none");

  // Direct: a failed send is retried next time; no local id sends nothing.
  const db2 = await freshDb(t, "n6f2");
  await addFull(db2, B, "Bee");
  const none = await advertiseBindingToContacts(db2, { sendControl: async () => ({ relays: [] }) }, "inst-x", { spacingMs: 0 });
  assert.equal(none.sent, 0);
  const later = await advertiseBindingToContacts(db2, { sendControl: async () => ({ relays: ["r"] }) }, "inst-x", { spacingMs: 0 });
  assert.equal(later.sent, 1, "a zero-relay send is not marked, so it is retried");
  const noId = await advertiseBindingToContacts(db2, { sendControl: async () => { throw new Error("must not send"); } }, null, { spacingMs: 0 });
  assert.equal(noId.sent, 0);
});

// -------- fix round 1
test("N-5c reaction emoji and group names are sanitized and capped, for contacts and strangers", T, async (t) => {
  const db = await freshDb(t, "n5c");
  const C = id(), S = id();
  await addFull(db, C, "Cleo");
  const h = await wiredHandlers(db);
  // Control: a plain emoji and group name pass through.
  await h.onSocial("reaction", { emoji: "👍" }, xo(C));
  assert.equal((await notifs(db)).at(-1).title, "Cleo reacted 👍");
  for (const who of [C, S]) {
    await h.onSocial("reaction", { emoji: "\u202Eo\u0007k" + "x".repeat(40) }, xo(who));
    const title = (await notifs(db)).at(-1).title;
    assert.ok(title.endsWith(" reacted okxxxxxx"), `controls stripped, capped at 8: ${JSON.stringify(title)}`);
    assert.equal(/[\u0000-\u001F\u202A-\u202E]/.test(title), false);
  }
  const before = (await notifs(db)).length;
  await h.onSocial("reaction", { emoji: "\u0007\u202E" }, xo(S));
  assert.equal((await notifs(db)).length, before, "an emoji that sanitizes to nothing is dropped");

  const cId = (await one(db, "SELECT id FROM contacts WHERE crow_id = ?", [C.crowId])).id;
  await handleGroupMessageNotify(db, { group_name: "Team", message: "g0" }, xo(C));
  assert.equal((await notifs(db)).at(-1).title, "[Team] Cleo", "control: a plain group name");
  for (const who of [C, S]) {
    await handleGroupMessageNotify(db, { group_name: "Bad\u0000\u202EName" + "g".repeat(100), message: "g1" }, xo(who));
    const title = (await notifs(db)).at(-1).title;
    const group = title.slice(1, title.indexOf("]"));
    assert.ok(group.startsWith("BadName"), JSON.stringify(title));
    assert.equal(Array.from(group).length, 60, "group name capped at 60");
  }
  const stored = await all(db, "SELECT content FROM messages WHERE contact_id = ? ORDER BY id", [cId]);
  assert.ok(stored.at(-1).content.startsWith("[BadName"), "the stored copy uses the sanitized name too");
});

test("N-6g (R13) deleting a contact clears its advert marker, so a re-added contact is advertised again", T, async (t) => {
  const db = await freshDb(t, "n6g");
  const localId = "inst-n6g";
  const B = id();
  await addFull(db, B, "Bee");
  const ok = { sendControl: async () => ({ relays: ["r"] }) };
  assert.equal((await advertiseBindingToContacts(db, ok, localId, { spacingMs: 0 })).sent, 1);
  assert.equal((await advertiseBindingToContacts(db, ok, localId, { spacingMs: 0 })).sent, 0, "control: the marker stops a resend");
  const row = await one(db, "SELECT * FROM contacts WHERE crow_id = ?", [B.crowId]);
  const res = await deleteContactLocal(db, { instanceSyncManager: { localInstanceId: localId } }, row);
  assert.equal(res.ok, true);
  assert.equal(Number((await one(db, "SELECT COUNT(*) AS n FROM dashboard_settings_overrides WHERE key = ?", [HS_CB_ADVERT_PREFIX + B.crowId])).n), 0, "marker cleared");
  await addFull(db, B, "Bee");
  assert.equal((await advertiseBindingToContacts(db, ok, localId, { spacingMs: 0 })).sent, 1, "the re-added contact gets a fresh advert");
});

test("N-6h the advert runs follow-up batches until every contact is done, without retrying a failure in the same run", T, async (t) => {
  const db = await freshDb(t, "n6h");
  const ids = [id(), id(), id(), id(), id()];
  for (const [i, x] of ids.entries()) await addFull(db, x, "P" + i);
  const sent = [];
  const failKey = ids[2].secp256k1Pubkey;
  const nm = { sendControl: async (to) => { sent.push(to.secp256k1_pubkey); return { relays: to.secp256k1_pubkey === failKey ? [] : ["r"] }; } };
  // Control: one batch of 2 leaves more.
  const first = await advertiseBindingToContacts(db, nm, "inst-ctl", { spacingMs: 0, maxPerRun: 2 });
  assert.deepEqual([first.sent, first.more], [2, true]);
  sent.length = 0;
  await peerProfile.scheduleBindingAdverts(db, nm, () => "inst-n6h", { delayMs: 0, spacingMs: 0, maxPerRun: 2 });
  assert.deepEqual([...sent].sort(), ids.map((x) => x.secp256k1Pubkey).sort(), "every contact tried exactly once across batches");
  const markers = Number((await one(db, "SELECT COUNT(*) AS n FROM dashboard_settings_overrides WHERE instance_id = 'inst-n6h' AND key LIKE ?", [HS_CB_ADVERT_PREFIX + "%"])).n);
  assert.equal(markers, 4, "the failed one stays unmarked for the next boot");
});
