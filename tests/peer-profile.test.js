/**
 * peer-profile — spec 2026-09-08 §4.2–§4.4: what a contact tells us about
 * themselves lands in peer_display_name / peer_avatar, never over the name or
 * picture the user typed; the `profile` crow_social message is accepted only
 * from a FULL, unblocked contact; the broadcast reaches every full unblocked
 * human contact with a key, once, best effort.
 *
 * Real on-disk init-db schema (handshake-display-name.test.js precedent);
 * managers stubbed, no relays. The dispatch test drives the REAL
 * wireNostrReceive ladder with a capturing subscribeToIncoming
 * (boot-receive-decouple.test.js precedent).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import {
  PROFILE_SUBTYPE, ensurePeerProfileColumns, readLocalProfile, buildProfileMessage,
  applyPeerProfile, handleProfileMessage, profileRecipients, broadcastProfile, readBroadcastPending, isEstablishedContact,
} from "../servers/sharing/peer-profile.js";
import { __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";
import { wireNostrReceive } from "../servers/sharing/boot.js";
import { _resetReceiveHealth } from "../servers/sharing/receive-health.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "peer-profile-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const PNG = "data:image/png;base64," + "A".repeat(64);
const JPG = "data:image/jpeg;base64," + "B".repeat(64);
const pk = (ch) => "02" + ch.repeat(64);
const xonly = (ch) => ch.repeat(64);

async function seed(db, { crowId, secp, name = crowId, extra = {} }) {
  const cols = ["crow_id", "ed25519_pubkey", "secp256k1_pubkey", "display_name", ...Object.keys(extra)];
  const vals = [crowId, "d".repeat(64), secp, name, ...Object.values(extra)];
  const res = await db.execute({ sql: `INSERT INTO contacts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: vals });
  return Number(res.lastInsertRowid);
}
const rowOf = async (db, id) => (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [id] })).rows[0];

test("isEstablishedContact: NULL/undefined/'accepted' are established; 'pending' and anything else are not", () => {
  assert.equal(isEstablishedContact({ request_status: null }), true);
  assert.equal(isEstablishedContact({}), true);
  assert.equal(isEstablishedContact({ request_status: "accepted" }), true);
  assert.equal(isEstablishedContact({ request_status: "pending" }), false);
  assert.equal(isEstablishedContact({ request_status: "weird" }), false);
  assert.equal(isEstablishedContact(null), true, "a missing row reads as NULL status (callers resolve the row first)");
});

test("buildProfileMessage: the crow_social envelope with subtype profile; sanitized name, validated picture, nulls propagate", () => {
  const env = JSON.parse(buildProfileMessage({ displayName: "  Kevin\u202e ", avatar: PNG }));
  assert.equal(env.type, "crow_social");
  assert.equal(env.version, 1);
  assert.equal(env.subtype, PROFILE_SUBTYPE);
  assert.equal(PROFILE_SUBTYPE, "profile");
  assert.deepEqual(env.payload, { v: 1, display_name: "Kevin", avatar: PNG });
  assert.deepEqual(JSON.parse(buildProfileMessage({})).payload, { v: 1, display_name: null, avatar: null }, "a cleared profile is sent as nulls");
  assert.deepEqual(JSON.parse(buildProfileMessage({ displayName: "crow:x", avatar: "https://x/y.png" })).payload, { v: 1, display_name: null, avatar: null });
});

test("readLocalProfile: sanitized name + validated picture from the GLOBAL rows; a legacy URL avatar is null; unreadable db is nulls", async () => {
  const { db, cleanup } = freshDb();
  try {
    assert.deepEqual(await readLocalProfile(db), { displayName: null, avatar: null });
    await db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', ?, datetime('now')), ('profile_avatar_url', 'https://example.com/me.png', datetime('now'))", args: ["\u202eEvil"] });
    assert.deepEqual(await readLocalProfile(db), { displayName: "Evil", avatar: null });
    await db.execute({ sql: "UPDATE dashboard_settings SET value = ? WHERE key = 'profile_avatar_url'", args: [PNG] });
    assert.deepEqual(await readLocalProfile(db), { displayName: "Evil", avatar: PNG });
    assert.deepEqual(await readLocalProfile({ execute: async () => { throw new Error("boom"); } }), { displayName: null, avatar: null });
    assert.deepEqual(await readLocalProfile(null), { displayName: null, avatar: null });
  } finally { cleanup(); }
});

test("applyPeerProfile: undefined leaves a field alone, a string sets it (sanitized/validated), null clears; display_name/avatar_url are never touched; one emit per real change", async () => {
  const { db, cleanup } = freshDb();
  const emits = [];
  __setEmitSinkForTest({ emitChange: async (table, op, row) => { emits.push({ table, op, crow_id: row.crow_id, peer: row.peer_display_name }); return 1; }, feedsDisabled: false });
  try {
    const id = await seed(db, { crowId: "crow:pal", secp: pk("a"), name: "My Friend", extra: { avatar_url: "https://example.com/local.png" } });
    let r = await applyPeerProfile(db, id, { displayName: "  Kevin  ", avatar: PNG });
    assert.equal(r.changed, true);
    let row = await rowOf(db, id);
    assert.equal(row.peer_display_name, "Kevin");
    assert.equal(row.peer_avatar, PNG);
    assert.equal(row.display_name, "My Friend", "the typed name is untouched");
    assert.equal(row.avatar_url, "https://example.com/local.png", "the local picture is untouched");
    r = await applyPeerProfile(db, id, { avatar: JPG });
    assert.equal(r.changed, true);
    row = await rowOf(db, id);
    assert.equal(row.peer_display_name, "Kevin", "undefined = left alone");
    assert.equal(row.peer_avatar, JPG);
    r = await applyPeerProfile(db, id, { displayName: null, avatar: "https://example.com/not-inline.png" });
    row = await rowOf(db, id);
    assert.equal(row.peer_display_name, null, "null clears");
    assert.equal(row.peer_avatar, null, "a rejected picture clears");
    r = await applyPeerProfile(db, id, { displayName: null });
    assert.equal(r.changed, false, "no-op when nothing changes");
    assert.equal((await applyPeerProfile(db, id, {})).changed, false, "nothing given, nothing done");
    assert.equal((await applyPeerProfile(db, 999999, { displayName: "X" })).changed, false, "unknown contact");
    assert.deepEqual(emits.map((e) => [e.table, e.op, e.crow_id]), [["contacts", "update", "crow:pal"], ["contacts", "update", "crow:pal"], ["contacts", "update", "crow:pal"]], "exactly one emit per real change");
    assert.equal(emits[0].peer, "Kevin", "the emitted row carries the peer field");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("handleProfileMessage: accepted from a FULL unblocked contact; dropped from a stranger, a pending request, a blocked contact; never throws", async () => {
  const { db, cleanup } = freshDb();
  __setEmitSinkForTest({ emitChange: async () => 1, feedsDisabled: false });
  try {
    const full = await seed(db, { crowId: "crow:full", secp: pk("1"), name: "crow:full" });
    await seed(db, { crowId: "req:" + xonly("2"), secp: xonly("2"), name: null, extra: { request_status: "pending" } });
    const blocked = await seed(db, { crowId: "crow:blocked", secp: pk("3"), name: "Blocked", extra: { is_blocked: 1 } });
    const payload = { v: 1, display_name: "Kevin", avatar: PNG };

    let r = await handleProfileMessage(db, payload, xonly("1"));
    assert.deepEqual([r.applied, r.changed, r.contactId], [true, true, full]);
    let row = await rowOf(db, full);
    assert.equal(row.peer_display_name, "Kevin");
    assert.equal(row.peer_avatar, PNG);
    assert.equal(row.display_name, "crow:full", "the profile message never writes display_name — even over a placeholder");

    r = await handleProfileMessage(db, payload, xonly("9"));
    assert.deepEqual([r.applied, r.reason], [false, "stranger"]);
    assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM contacts")).rows[0].n), 3, "a stranger's profile creates no row");

    r = await handleProfileMessage(db, payload, xonly("2"));
    assert.deepEqual([r.applied, r.reason], [false, "not-established"]);

    const accepted = await seed(db, { crowId: "crow:acc", secp: pk("7"), name: "crow:acc", extra: { request_status: "accepted" } });
    r = await handleProfileMessage(db, payload, xonly("7"));
    assert.deepEqual([r.applied, r.changed, r.contactId], [true, true, accepted], "an ACCEPTED request is an established contact (R2-1)");
    assert.equal((await rowOf(db, accepted)).peer_display_name, "Kevin");

    r = await handleProfileMessage(db, payload, xonly("3"));
    assert.deepEqual([r.applied, r.reason], [false, "blocked"]);
    assert.equal((await rowOf(db, blocked)).peer_display_name, null);

    r = await handleProfileMessage(db, { v: 1, display_name: "Kev" }, xonly("1"));
    row = await rowOf(db, full);
    assert.equal(row.peer_display_name, "Kev");
    assert.equal(row.peer_avatar, PNG, "an absent avatar key leaves the picture alone");

    r = await handleProfileMessage(db, { v: 1, display_name: null, avatar: null }, xonly("1"));
    row = await rowOf(db, full);
    assert.equal(row.peer_display_name, null, "explicit nulls clear (the peer removed their picture)");
    assert.equal(row.peer_avatar, null);

    assert.equal((await handleProfileMessage(db, "junk", xonly("1"))).applied, false);
    assert.equal((await handleProfileMessage(db, [1], xonly("1"))).applied, false);
    assert.equal((await handleProfileMessage(db, payload, null)).applied, false);
    assert.equal((await handleProfileMessage(null, payload, xonly("1"))).applied, false);
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("the profile subtype reaches handleProfileMessage through the REAL receive ladder (wireNostrReceive -> onSocialMessage)", async () => {
  _resetReceiveHealth();
  const { db, cleanup } = freshDb();
  __setEmitSinkForTest({ emitChange: async () => 1, feedsDisabled: false });
  try {
    const full = await seed(db, { crowId: "crow:ladder", secp: pk("4"), name: "crow:ladder" });
    let handlers = null;
    const managers = {
      db,
      identity: { crowId: "crow:me", secp256k1Pubkey: "a".repeat(64), secp256k1Priv: new Uint8Array(32) },
      peerManager: { joinContact: async () => {}, joinInstanceSync: async () => {} },
      syncManager: { initContact: async () => {} },
      instanceSyncManager: { localInstanceId: "inst-test" },
      nostrManager: {
        subscribeToContact: async () => {},
        subscribeToIncoming: async (onInvite, onSocial, onRequest) => { handlers = { onInvite, onSocial, onRequest }; },
      },
    };
    await wireNostrReceive(managers);
    assert.ok(handlers, "the ladder was captured");
    await handlers.onSocial("profile", { v: 1, display_name: "Ladder Kevin", avatar: JPG }, xonly("4"));
    const row = await rowOf(db, full);
    assert.equal(row.peer_display_name, "Ladder Kevin");
    assert.equal(row.peer_avatar, JPG);
    await handlers.onSocial("profile", { v: 1, display_name: "Nope", avatar: JPG }, xonly("5"));
    assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM contacts")).rows[0].n), 1, "a stranger on the ladder creates nothing");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("profileRecipients + broadcastProfile: every full unblocked human keyed contact, once; failures counted, not thrown; no manager = skipped", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', 'Kevin', datetime('now')), ('profile_avatar_url', ?, datetime('now'))", args: [PNG] });
    await seed(db, { crowId: "crow:full", secp: pk("a"), name: "Full" });
    await seed(db, { crowId: "crow:full2", secp: xonly("b"), name: "Full x-only" });
    await seed(db, { crowId: "crow:blocked", secp: pk("c"), name: "B", extra: { is_blocked: 1 } });
    await seed(db, { crowId: "req:" + xonly("d"), secp: xonly("d"), name: null, extra: { request_status: "pending" } });
    await seed(db, { crowId: "crow:accepted", secp: pk("e"), name: "Acc", extra: { request_status: "accepted" } });
    await seed(db, { crowId: "crow:bot", secp: pk("f"), name: "Bot", extra: { is_bot: 1 } });
    await seed(db, { crowId: "crow:localbot", secp: pk("1"), name: "LB", extra: { origin: "local-bot" } });
    await seed(db, { crowId: "manual:x", secp: "", name: "Manual", extra: { contact_type: "manual" } });
    await seed(db, { crowId: "crow:badkey", secp: "not-hex", name: "Bad" });

    assert.deepEqual((await profileRecipients(db)).map((r) => r.crow_id), ["crow:full", "crow:full2", "crow:accepted"], "accepted requests are established contacts (R2-1)");

    const sent = [];
    const nostrManager = { sendControl: async (contact, content) => { sent.push({ contact, content }); return { eventId: "e", relays: ["r"] }; } };
    assert.deepEqual(await broadcastProfile(db, nostrManager), { sent: 3, failed: 0, skipped: 0 });
    assert.deepEqual(sent.map((s) => s.contact.secp256k1_pubkey), [pk("a"), xonly("b"), pk("e")]);
    const env = JSON.parse(sent[0].content);
    assert.equal(env.subtype, "profile");
    assert.deepEqual(env.payload, { v: 1, display_name: "Kevin", avatar: PNG });
    assert.equal(await readBroadcastPending(db), false, "a clean fan-out clears the pending flag");

    let n = 0;
    const flaky = { sendControl: async () => { if (n++ === 0) throw new Error("relay down"); return { eventId: "e", relays: ["r"] }; } };
    assert.deepEqual(await broadcastProfile(db, flaky), { sent: 2, failed: 1, skipped: 0 }, "a failure is counted and the loop continues");
    assert.equal(await readBroadcastPending(db), true, "a failed fan-out leaves the flag pending (R2-S3)");
    assert.deepEqual(await broadcastProfile(db, nostrManager), { sent: 3, failed: 0, skipped: 0 });
    assert.equal(await readBroadcastPending(db), false);
    assert.deepEqual(await broadcastProfile(db, null), { sent: 0, failed: 0, skipped: 1 });
    assert.equal(await readBroadcastPending(db), true, "no manager = nothing went out = pending");
    assert.deepEqual(await broadcastProfile(db, {}), { sent: 0, failed: 0, skipped: 1 }, "no sendControl = no wire");
  } finally { cleanup(); }
});

test("ensurePeerProfileColumns adds the two columns to a contacts table that lacks them, and is idempotent", async () => {
  const db = createClient({ url: "file::memory:" });
  await db.execute("CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, display_name TEXT)");
  await ensurePeerProfileColumns(db);
  await ensurePeerProfileColumns(db);
  const names = (await db.execute("PRAGMA table_info(contacts)")).rows.map((r) => r.name);
  assert.deepEqual(names.filter((n) => n.startsWith("peer_")), ["peer_display_name", "peer_avatar"]);
  await ensurePeerProfileColumns({ execute: async () => { throw new Error("no such table"); } }); // never throws
  // R2-Q1: the verify block fires when ALTER fails but PRAGMA answers (a VIEW named contacts).
  const viewDb = createClient({ url: "file::memory:" });
  await viewDb.execute("CREATE TABLE base (id INTEGER PRIMARY KEY, crow_id TEXT)");
  await viewDb.execute("CREATE VIEW contacts AS SELECT * FROM base");
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try { await ensurePeerProfileColumns(viewDb); } finally { console.error = origError; }
  assert.ok(errors.some((e) => e.includes("contacts.peer_* columns MISSING")), "the loud line fires");
});
