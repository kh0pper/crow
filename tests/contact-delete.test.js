/**
 * F-CONTACT-1 (design §2.1, §2.5, §4.1, §4.4) — Tasks 3, 4, 5.
 *
 * Task 3: unwireContact + NostrManager.unsubscribeFromContact (teardown).
 * Task 4: deleteContactCascadePreview (read-only blast-radius counts).
 * Task 5: deleteContactLocal (order-load-bearing: unwire → DELETE → tombstone).
 *
 * Harness mirrors tests/contact-tombstones.test.js: real init-db into a tmpdir,
 * the async createDbClient handle. FK enforcement (better-sqlite3 default ON) is
 * load-bearing for the cascade characterization — if it is ever disabled the
 * message-survival assertion fails loudly (design §2.1).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { NostrManager } from "../servers/sharing/nostr.js";
import {
  unwireContact,
  deleteContactCascadePreview,
  deleteContactLocal,
  readTombstone,
} from "../servers/sharing/contact-delete.js";
import { __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";
import { readSetting } from "../servers/gateway/dashboard/settings/registry.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-contact-delete-test-"));
function initDb() {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
}
initDb();
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const db = createDbClient(DB_PATH);

let _cid = 0;
async function seedContact({ crowId, origin = null, lamport = 0 } = {}) {
  const crow_id = crowId || `crow:seed${++_cid}`;
  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin, lamport_ts)
          VALUES (?, ?, 'ed', 'secp', ?, ?)`,
    args: [crow_id, crow_id, origin, lamport],
  });
  const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crow_id] });
  return rows[0];
}

// ── Task 3: teardown — unsubscribeFromContact + unwireContact ────────────────

test("guard #9: unsubscribeFromContact closes+removes exactly the crowId's entries, isolating others (incl. a prefix-collision id)", () => {
  const mgr = new NostrManager({}, null);
  const URLS = ["wss://r1", "wss://r2"];
  for (const u of URLS) mgr.relays.set(u, {});
  // crow:aaa2 shares a raw prefix with crow:aaa — a prefix scan would wrongly
  // sweep it; the exact-key impl must leave it untouched.
  const CROWS = ["crow:aaa", "crow:aaa2", "crow:bbb"];
  const handles = {};
  for (const crow of CROWS) {
    for (const u of URLS) {
      const key = `${crow}:${u}`;
      const h = { closed: false, close() { this.closed = true; } };
      handles[key] = h;
      mgr.subscriptions.set(key, h);
    }
  }

  mgr.unsubscribeFromContact("crow:aaa");

  // crow:aaa — closed AND removed on both relays.
  for (const u of URLS) {
    const key = `crow:aaa:${u}`;
    assert.equal(mgr.subscriptions.has(key), false, `${key} should be removed`);
    assert.equal(handles[key].closed, true, `${key} should be closed`);
  }
  // crow:aaa2 and crow:bbb — present and un-closed on both relays.
  for (const crow of ["crow:aaa2", "crow:bbb"]) {
    for (const u of URLS) {
      const key = `${crow}:${u}`;
      assert.equal(mgr.subscriptions.has(key), true, `${key} should remain`);
      assert.equal(handles[key].closed, false, `${key} should not be closed`);
    }
  }
});

test("unsubscribeFromContact is guarded — missing relays/handles and a throwing close() never throw", () => {
  const mgr = new NostrManager({}, null);
  mgr.relays.set("wss://r1", {});
  mgr.relays.set("wss://r2", {});
  // r1 has a handle whose close() throws; r2 has no handle at all.
  mgr.subscriptions.set("crow:z:wss://r1", { close() { throw new Error("boom"); } });
  assert.doesNotThrow(() => mgr.unsubscribeFromContact("crow:z"));
  assert.equal(mgr.subscriptions.has("crow:z:wss://r1"), false); // still removed
  assert.doesNotThrow(() => mgr.unsubscribeFromContact("crow:absent"));
});

test("unwireContact with only nostrManager (no syncManager/peerManager) does not throw", async () => {
  const mgr = new NostrManager({}, null);
  mgr.relays.set("wss://r1", {});
  mgr.subscriptions.set("crow:x:wss://r1", { closed: false, close() { this.closed = true; } });
  await assert.doesNotReject(unwireContact({ nostrManager: mgr }, { id: 1, crow_id: "crow:x" }));
  assert.equal(mgr.subscriptions.has("crow:x:wss://r1"), false);
});

test("unwireContact calls each manager step (full managers)", async () => {
  const calls = [];
  const managers = {
    nostrManager: { unsubscribeFromContact: (id) => calls.push(["nostr", id]) },
    syncManager: { closeContactFeeds: async (id) => calls.push(["sync", id]) },
    peerManager: { leaveContact: async (id) => calls.push(["peer", id]) },
  };
  await unwireContact(managers, { id: 7, crow_id: "crow:full" });
  assert.deepEqual(calls, [["nostr", "crow:full"], ["sync", 7], ["peer", "crow:full"]]);
});

// ── Task 4: deleteContactCascadePreview ──────────────────────────────────────

test("guard #8: deleteContactCascadePreview returns exact cascade counts; an untouched contact is all zeros", async () => {
  const a = await seedContact({ crowId: "crow:previewA" });
  const b = await seedContact({ crowId: "crow:previewB" });

  // 3 messages
  for (let i = 0; i < 3; i++) {
    await db.execute({
      sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction) VALUES (?, ?, 'hi', 'received')`,
      args: [a.id, `evt-${a.id}-${i}`],
    });
  }
  // 1 shared_item
  await db.execute({
    sql: `INSERT INTO shared_items (contact_id, share_type, item_id, direction) VALUES (?, 'note', 1, 'sent')`,
    args: [a.id],
  });
  // 2 contact_group_members (one group is enough)
  await db.execute({ sql: `INSERT INTO contact_groups (name) VALUES ('G1')`, args: [] });
  await db.execute({ sql: `INSERT INTO contact_groups (name) VALUES ('G2')`, args: [] });
  const g1 = (await db.execute("SELECT id FROM contact_groups WHERE name='G1'")).rows[0].id;
  const g2 = (await db.execute("SELECT id FROM contact_groups WHERE name='G2'")).rows[0].id;
  await db.execute({ sql: `INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, ?)`, args: [g1, a.id] });
  await db.execute({ sql: `INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, ?)`, args: [g2, a.id] });
  // 1 owned project_space
  await db.execute({
    sql: `INSERT INTO project_spaces (slug, name, owner_contact_id) VALUES ('p-a', 'Proj A', ?)`,
    args: [a.id],
  });
  const projId = (await db.execute("SELECT id FROM project_spaces WHERE slug='p-a'")).rows[0].id;
  // 1 project_members membership
  await db.execute({
    sql: `INSERT INTO project_members (project_id, contact_id, role) VALUES (?, ?, 'editor')`,
    args: [projId, a.id],
  });

  const preview = await deleteContactCascadePreview(db, a.id);
  assert.deepEqual(preview, {
    messages: 3,
    sharedItems: 1,
    groups: 2,
    projectsOwned: 1,
    projectMemberships: 1,
  });

  const zero = await deleteContactCascadePreview(db, b.id);
  assert.deepEqual(zero, {
    messages: 0,
    sharedItems: 0,
    groups: 0,
    projectsOwned: 0,
    projectMemberships: 0,
  });
});

// ── Task 5: deleteContactLocal ───────────────────────────────────────────────

test("guard: deleteContactLocal cascades away messages, writes a tombstone, and unwires BEFORE the row vanishes", async () => {
  __setEmitSinkForTest({ emitChange: async () => null }); // suppress → tombstone at fallback lamport
  after(() => __setEmitSinkForTest(null));

  const row = await seedContact({ crowId: "crow:del1", lamport: 200 });
  for (let i = 0; i < 3; i++) {
    await db.execute({
      sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction) VALUES (?, ?, 'hi', 'received')`,
      args: [row.id, `del1-evt-${i}`],
    });
  }

  // Spy records whether the contact row STILL EXISTED when unwire ran.
  let existedAtUnwire = null;
  const spyNostr = {
    async unsubscribeFromContact(crowId) {
      const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM contacts WHERE crow_id = ?", args: [crowId] });
      existedAtUnwire = Number(rows[0].n) > 0;
    },
  };

  const res = await deleteContactLocal(db, { nostrManager: spyNostr }, row);
  assert.deepEqual(res, { ok: true });

  // unwire ran before the DELETE.
  assert.equal(existedAtUnwire, true, "unwireContact must run while the row still exists");

  // Row and its messages are gone (FK ON DELETE CASCADE fired).
  const { rows: cRows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM contacts WHERE id = ?", args: [row.id] });
  assert.equal(Number(cRows[0].n), 0);
  const { rows: mRows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM messages WHERE contact_id = ?", args: [row.id] });
  assert.equal(Number(mRows[0].n), 0, "FK CASCADE must remove the DM history (fails loudly if FK enforcement is off)");

  // Tombstone written (at the fallback lamport, since the emit was suppressed).
  const tomb = await readTombstone(db, "crow:del1");
  assert.ok(tomb, "a tombstone must exist after deletion");
  assert.equal(tomb.lamport_ts, 200);
});

test("guard: deleteContactLocal refuses a local-bot row (no delete, no tombstone)", async () => {
  __setEmitSinkForTest({ emitChange: async () => null });
  after(() => __setEmitSinkForTest(null));

  const row = await seedContact({ crowId: "crow:botlocal", origin: "local-bot", lamport: 5 });
  const res = await deleteContactLocal(db, {}, row);
  assert.deepEqual(res, { ok: false, reason: "local-bot" });

  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM contacts WHERE id = ?", args: [row.id] });
  assert.equal(Number(rows[0].n), 1, "the local-bot row must survive");
  assert.equal(await readTombstone(db, "crow:botlocal"), null, "no tombstone for a refused local-bot delete");
});

// ── Task 12: panel handler — two-step confirmation + real crow: delete ────────
//
// These drive the REAL exported handler (handleContactAction), not a
// reimplementation. The emit sink is suppressed so deleteContactLocal's tombstone
// lands at the row's fallback lamport with no live mesh.

async function countContact(crowId) {
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM contacts WHERE crow_id = ?", args: [crowId] });
  return Number(rows[0].n);
}

test("Task 12: delete_contact POST WITHOUT confirm=1 deletes nothing and redirects to the interstitial", async () => {
  __setEmitSinkForTest({ emitChange: async () => null });
  after(() => __setEmitSinkForTest(null));

  const row = await seedContact({ crowId: "crow:noconfirm" });
  const result = await handleContactAction({ body: { action: "delete_contact", contact_id: String(row.id) } }, db);

  // Redirects to the GET interstitial for THIS contact.
  assert.equal(result.redirect, `/dashboard/contacts?view=contact&contact=${row.id}&confirm=delete`);
  // Nothing deleted, no tombstone written.
  assert.equal(await countContact("crow:noconfirm"), 1, "the contact must survive a no-confirm POST");
  assert.equal(await readTombstone(db, "crow:noconfirm"), null, "no tombstone before confirmation");
});

test("Task 12 (F-CONTACT-1 regression): delete_contact POST WITH confirm=1 deletes a crow: contact", async () => {
  __setEmitSinkForTest({ emitChange: async () => null });
  after(() => __setEmitSinkForTest(null));

  const row = await seedContact({ crowId: "crow:reallygone", lamport: 42 });
  assert.equal(await countContact("crow:reallygone"), 1);

  const result = await handleContactAction({ body: { action: "delete_contact", contact_id: String(row.id), confirm: "1" } }, db);
  assert.equal(result.redirect, "/dashboard/contacts");

  // The crow: row is GONE — the whole point of F-CONTACT-1. On `main` (WHERE
  // contact_type='manual') this delete is a silent no-op and the count stays 1.
  assert.equal(await countContact("crow:reallygone"), 0, "a crow: contact must actually delete on confirm");
  const tomb = await readTombstone(db, "crow:reallygone");
  assert.ok(tomb, "a durable tombstone must exist after the confirmed delete");
  assert.equal(tomb.lamport_ts, 42);
});

test("Task 12: delete_contact confirm=1 refuses a local-bot row (still present, no tombstone)", async () => {
  __setEmitSinkForTest({ emitChange: async () => null });
  after(() => __setEmitSinkForTest(null));

  const row = await seedContact({ crowId: "crow:handlerbot", origin: "local-bot", lamport: 9 });
  const result = await handleContactAction({ body: { action: "delete_contact", contact_id: String(row.id), confirm: "1" } }, db);
  // Redirects back to the contact, no delete.
  assert.equal(result.redirect, `/dashboard/contacts?view=contact&contact=${row.id}`);
  assert.equal(await countContact("crow:handlerbot"), 1, "a local-bot row must not be deletable via the panel");
  assert.equal(await readTombstone(db, "crow:handlerbot"), null, "no tombstone for a refused local-bot delete");
});

// ── Task 9 (third bullet): save_profile caps the user's own display name ──────

test("Task 9: save_profile caps a 10 KB hostile display name via sanitizeDisplayName", async () => {
  const hostile = "‮" + "A".repeat(10240) + "\n <img src=x>";
  await handleContactAction({ body: { action: "save_profile", display_name: hostile } }, db);

  const stored = await readSetting(db, "profile_display_name");
  assert.ok(stored != null, "a value must be stored");
  assert.ok(Array.from(stored).length <= 64, `stored name must be capped at 64 code points, got ${Array.from(stored).length}`);
  assert.ok(!stored.includes("‮"), "bidi override must be stripped");
  assert.ok(!stored.includes("\n") && !stored.includes(" "), "control chars must be stripped");
});

test("Task 9: save_profile stores empty string (not the literal 'null') when the name sanitizes away", async () => {
  await handleContactAction({ body: { action: "save_profile", display_name: " ‮   " } }, db);
  const stored = await readSetting(db, "profile_display_name");
  assert.equal(stored, "", "an all-hostile name must clear to empty, never the string 'null'");
});
