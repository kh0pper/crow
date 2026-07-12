// tests/roster-advertise-prune.test.js
//
// F4 (spec `2026-07-12-advertised-contact-prune-design.md` §3 F4, §5 tests 4 & 8):
// the advertised-contact prune. A REAL schema is mandatory here — the feature is
// expressed in columns (`advertised_by_instance_id`, `lamport_ts`, `crow_id`) and
// in a second table (`contact_tombstones`) that a hand-rolled 4-column `contacts`
// cannot express. Running init-db into a mkdtemp CROW_DATA_DIR also proves the new
// column really lands via the migration.
//
// NEVER point this file at ~/.crow — this code DELETES contacts.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  getBotDirectory,
  pruneStaleAdvertisedContacts,
} from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { _setFetchImpl, _resetCache } from "../servers/gateway/dashboard/advertised-bots-cache.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-prune-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
});
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const LOCAL_ID = "inst-local";
const ADV = "inst-advertiser";
const OTHER = "inst-other";

// getOrCreateLocalInstanceId() reads $CROW_DATA_DIR/instance-id at call time.
// Pin both so getBotDirectory resolves LOCAL_ID and never touches ~/.crow.
writeFileSync(join(tmpDir, "instance-id"), LOCAL_ID);
process.env.CROW_DATA_DIR = tmpDir;

const db = createDbClient(DB_PATH);

const PK_BOT = "a".repeat(64); // the advertised bot's x-only key
const PK_KEEP = "b".repeat(64);

/** Insert a contacts row. `pk` is stored 02-prefixed to exercise trailing-64 normalization. */
async function seedContact({ id, crowId, pk, advertisedBy = null, lamport = 100, messages = 0 }) {
  await db.execute({
    sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey,
                                lamport_ts, origin, is_bot, advertised_by_instance_id)
          VALUES (?, ?, ?, ?, ?, ?, 'advertised', 1, ?)`,
    args: [id, crowId, "Bot " + id, "ed" + String(id).padStart(2, "0"), "02" + pk, lamport, advertisedBy],
  });
  for (let i = 0; i < messages; i++) {
    await db.execute({
      sql: "INSERT INTO messages (contact_id, content, direction) VALUES (?, ?, 'received')",
      args: [id, "hello " + i],
    });
  }
}

async function contactIds() {
  const { rows } = await db.execute("SELECT id FROM contacts ORDER BY id");
  return rows.map((r) => Number(r.id));
}

async function tombstone(crowId) {
  const { rows } = await db.execute({
    sql: "SELECT crow_id, lamport_ts FROM contact_tombstones WHERE crow_id = ?",
    args: [crowId],
  });
  return rows[0] || null;
}

/** perInstance entry factory — `pubkeys` are x-only lowercase, as getBotDirectory builds them. */
function peer({ ok = true, complete = true, pubkeys = [] } = {}) {
  return { ok, complete, pubkeys: new Set(pubkeys) };
}

beforeEach(async () => {
  await db.execute("DELETE FROM messages");
  await db.execute("DELETE FROM contacts");
  await db.execute("DELETE FROM contact_tombstones");
  await db.execute("DELETE FROM crow_instances");
  _resetCache();
  _setFetchImpl(null);
});

// ── The trigger matrix (spec §5.4) ───────────────────────────────────────────

test("1. advertiser ok+complete and the bot is ABSENT from its list ⇒ PRUNED, tombstone at the row's own lamport_ts", async () => {
  await seedContact({ id: 1, crowId: "crow:gone", pk: PK_BOT, advertisedBy: ADV, lamport: 4382 });
  const perInstance = new Map([[ADV, peer({ pubkeys: [PK_KEEP] })]]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);

  assert.deepEqual(await contactIds(), [], "the stale advertised contact is deleted");
  const t = await tombstone("crow:gone");
  assert.ok(t, "a tombstone is written so a peer's later `update` cannot resurrect the row");
  // ANTI-DIVERGENCE: the tombstone MUST carry the pruned row's own lamport, never a
  // fresh counter value (spec §3 F4 / R3-CRITICAL-1 — a fresh burn is invisible to the
  // fleet and ties with a re-adder's insert, which the apply gate drops ⇒ permanent
  // divergence at the live fleet's 4385/4385/4384).
  assert.equal(Number(t.lamport_ts), 4382, "tombstone lamport === the pruned row's lamport_ts");
});

test("2. advertiser is unavailable (ok:false) ⇒ NOT pruned", async () => {
  await seedContact({ id: 1, crowId: "crow:gone", pk: PK_BOT, advertisedBy: ADV });
  const perInstance = new Map([[ADV, peer({ ok: false, complete: false, pubkeys: [] })]]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);

  assert.deepEqual(await contactIds(), [1], "an offline/timed-out advertiser never authorises a delete");
  assert.equal(await tombstone("crow:gone"), null);
});

test("2a. `ok` and `complete` are INDEPENDENTLY load-bearing — ok:false never prunes even if complete reads true", async () => {
  // getBotDirectory only ever derives complete from ok, so this shape cannot arise
  // from it today. The rule is `ok === true AND complete === true` (BOTH), and the
  // prune DELETES: it must not silently start depending on that coupling holding, in
  // this or any future caller.
  await seedContact({ id: 1, crowId: "crow:gone", pk: PK_BOT, advertisedBy: ADV });
  const perInstance = new Map([[ADV, peer({ ok: false, complete: true, pubkeys: [] })]]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);

  assert.deepEqual(await contactIds(), [1], "an unavailable peer's bot list is not evidence of anything");
  assert.equal(await tombstone("crow:gone"), null);
});

test("2b. advertiser was NOT queried this cycle (unpaired / untrusted) ⇒ NOT pruned", async () => {
  await seedContact({ id: 1, crowId: "crow:gone", pk: PK_BOT, advertisedBy: "inst-never-queried" });
  const perInstance = new Map([[ADV, peer({ pubkeys: [] })]]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);

  assert.deepEqual(await contactIds(), [1], "'never queried' must not read as 'queried and it advertises nothing'");
});

test("3. advertiser answered ok but NOT complete ⇒ NOT pruned", async () => {
  await seedContact({ id: 1, crowId: "crow:gone", pk: PK_BOT, advertisedBy: ADV });
  const perInstance = new Map([[ADV, peer({ ok: true, complete: false, pubkeys: [PK_KEEP] })]]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);

  assert.deepEqual(await contactIds(), [1], "a 200 with a silently-missing bot never authorises a delete");
});

test("4. bot absent from a DIFFERENT peer's list but PRESENT in its own advertiser's ⇒ NOT pruned", async () => {
  await seedContact({ id: 1, crowId: "crow:live", pk: PK_BOT, advertisedBy: ADV });
  const perInstance = new Map([
    [ADV, peer({ pubkeys: [PK_BOT] })],
    [OTHER, peer({ pubkeys: [] })],
  ]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);

  assert.deepEqual(await contactIds(), [1], "only the advertiser's own view can retire its bot");
});

test("5. bot advertised by a SECOND ok+complete peer ⇒ NOT pruned", async () => {
  await seedContact({ id: 1, crowId: "crow:dual", pk: PK_BOT, advertisedBy: ADV });
  const perInstance = new Map([
    [ADV, peer({ pubkeys: [] })],
    [OTHER, peer({ pubkeys: [PK_BOT] })],
  ]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);

  assert.deepEqual(await contactIds(), [1], "the directory dedups on first-seen pubkey — a bot advertised by two instances is still live");
});

test("6. advertised_by_instance_id === the local instance ⇒ NOT pruned (host protection)", async () => {
  await seedContact({ id: 1, crowId: "crow:mine", pk: PK_BOT, advertisedBy: LOCAL_ID });
  const perInstance = new Map([
    [LOCAL_ID, peer({ pubkeys: [] })],
    [ADV, peer({ pubkeys: [] })],
  ]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);

  assert.deepEqual(await contactIds(), [1], "the host NEVER prunes its own bot");
});

test("6a. a falsy localInstanceId prunes NOTHING — rule 1 is unprovable, so host protection fails SAFE", async () => {
  // getOrCreateLocalInstanceId is guarded at the call site and yields null if it
  // throws. With localInstanceId null, `advertiser === localInstanceId` can never
  // match, so rule 1 would silently disable and the host could prune its OWN bot.
  await seedContact({ id: 1, crowId: "crow:mine", pk: PK_BOT, advertisedBy: LOCAL_ID });
  await seedContact({ id: 2, crowId: "crow:theirs", pk: PK_KEEP, advertisedBy: ADV });
  const perInstance = new Map([
    [LOCAL_ID, peer({ pubkeys: [] })],
    [ADV, peer({ pubkeys: [] })],
  ]);

  await pruneStaleAdvertisedContacts(db, perInstance, null, null);

  assert.deepEqual(await contactIds(), [1, 2], "no local id ⇒ no prune at all, not a prune with rule 1 disabled");
});

test("7. advertised_by_instance_id IS NULL (manual / pasted-invite contact) ⇒ NOT pruned", async () => {
  await seedContact({ id: 1, crowId: "crow:manual", pk: PK_BOT, advertisedBy: null });
  const perInstance = new Map([[ADV, peer({ pubkeys: [] })]]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);

  assert.deepEqual(await contactIds(), [1], "NULL provenance is structurally never prunable");
});

test("8. row HAS messages ⇒ NOT pruned (the prune never destroys history)", async () => {
  await seedContact({ id: 1, crowId: "crow:chatty", pk: PK_BOT, advertisedBy: ADV, messages: 2 });
  const perInstance = new Map([[ADV, peer({ pubkeys: [] })]]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);

  assert.deepEqual(await contactIds(), [1], "a contact with history is kept even when un-advertised");
});

// ── The silent-no-op trap (spec §3 F4: writeTombstone no-ops on a falsy crowId) ──

test("a row with a falsy crow_id is WARNED and SKIPPED, never deleted", async () => {
  await seedContact({ id: 1, crowId: "", pk: PK_BOT, advertisedBy: ADV });
  const perInstance = new Map([[ADV, peer({ pubkeys: [] })]]);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, null);
  } finally {
    console.warn = origWarn;
  }

  assert.deepEqual(await contactIds(), [1], "no crow_id ⇒ no tombstone is possible ⇒ never delete (writeTombstone would silently no-op)");
  assert.equal(warnings.length, 1, "the skip is reported, not silent");
  assert.match(warnings[0], /crow_id/i);
});

// ── unwireContact runs BEFORE the delete (Nostr-subscription leak fix) ───────

test("the prune unwires the contact before deleting it, and a partial managers object never throws", async () => {
  await seedContact({ id: 1, crowId: "crow:gone", pk: PK_BOT, advertisedBy: ADV, lamport: 7 });
  const unsubbed = [];
  const managers = { nostrManager: { unsubscribeFromContact: async (id) => unsubbed.push(id) } };
  const perInstance = new Map([[ADV, peer({ pubkeys: [] })]]);

  await pruneStaleAdvertisedContacts(db, perInstance, LOCAL_ID, managers);

  assert.deepEqual(unsubbed, ["crow:gone"], "unsubscribeFromContact ran (the old bare DELETE leaked the subscription)");
  assert.deepEqual(await contactIds(), []);
});

// ── getBotDirectory: perInstance, and prune is OPT-IN (spec §5.8 / R3-MAJOR-6) ──

async function seedInstances(ids) {
  for (const id of ids) {
    await db.execute({
      sql: "INSERT INTO crow_instances (id, name, crow_id, trusted, status) VALUES (?, ?, ?, 1, 'active')",
      args: [id, id, "crow:" + id],
    });
  }
}

test("getBotDirectory returns perInstance with an entry for EVERY queried peer, including unavailable ones", async () => {
  await seedInstances([ADV, OTHER]);
  _setFetchImpl(async (_db, instanceId) => {
    if (instanceId === OTHER) throw new Error("offline");
    return { ok: true, body: { complete: true, bots: [
      { bot_id: "b1", display_name: "Helper", messaging_pubkey: "02" + PK_BOT, invite_code: "crow:a.b.c" },
    ] } };
  });

  const dir = await getBotDirectory(db);

  assert.ok(dir.perInstance instanceof Map, "perInstance is a Map");
  assert.deepEqual([...dir.perInstance.keys()].sort(), [ADV, OTHER].sort());
  const adv = dir.perInstance.get(ADV);
  assert.equal(adv.ok, true);
  assert.equal(adv.complete, true);
  assert.deepEqual([...adv.pubkeys], [PK_BOT], "x-only lowercase, 02-prefix stripped");
  const other = dir.perInstance.get(OTHER);
  assert.equal(other.ok, false, "a queried-but-unavailable peer is present with ok:false, not absent");
  assert.equal(other.complete, false);
  assert.equal(other.pubkeys.size, 0);
  // display shape unchanged
  assert.equal(dir.groups.length, 1);
  assert.equal(dir.total, 1);
  assert.equal(dir.notAddedCount, 1);
});

test("getBotDirectory(db) with DEFAULT options performs ZERO deletes; only {prune:true} garbage-collects", async () => {
  await seedInstances([ADV]);
  await seedContact({ id: 1, crowId: "crow:gone", pk: PK_BOT, advertisedBy: ADV, lamport: 55 });
  // ADV is ok+complete and advertises nothing → row 1 is prunable.
  _setFetchImpl(async () => ({ ok: true, body: { complete: true, bots: [] } }));

  const dir = await getBotDirectory(db);
  assert.deepEqual(await contactIds(), [1], "a read must never GC — the add path calls this and would otherwise delete contacts");
  assert.equal(dir.total, 0);

  _resetCache();
  await getBotDirectory(db, { prune: true });
  assert.deepEqual(await contactIds(), [], "the render opts in and the stale contact is collected");
  assert.ok(await tombstone("crow:gone"), "and the tombstone is written");
});
