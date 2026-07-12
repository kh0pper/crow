/**
 * Item 2a / F3 (spec §3 F3, defect D2) — `contacts.origin` is a JUDGMENT, not a fact.
 *
 * "This is an advertised bot I may garbage-collect" is true only relative to the
 * instance holding the row. Replicating it is dangerous in BOTH directions:
 *   - toward the bot's host: a peer's emit could relabel the host's own bot row
 *     `origin='advertised'`; a host never sees its OWN bots in its advertised
 *     directory ⇒ a later GC pass would prune the host's own bot (FK CASCADE
 *     takes its DM history with it);
 *   - toward a peer that cannot see the advertisement: it inherits 'advertised'
 *     for a bot it never sees advertised ⇒ it prunes a live bot on next render.
 *
 * So `origin` is stripped on emit (EXCLUDED_COLUMNS.contacts) AND dropped on
 * apply (_applyContact's ALWAYS_DROP — an un-upgraded peer still sends it).
 *
 * The load-bearing ordering: `shouldSyncRow` (which gates on origin === 'local-bot')
 * runs on the RAW row at instance-sync.js:963, BEFORE the EXCLUDED_COLUMNS strip at
 * :978-981. Excluding `origin` therefore does NOT disable that gate — the last test
 * here is the regression guard that keeps it that way.
 *
 * Harness mirrors tests/contacts-sync.test.js + tests/providers-sync-wire.test.js:
 * real init-db.js schema in a tmpdir, fixed ed25519 identity, stub outbound feed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager, EXCLUDED_COLUMNS } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-origin-wire-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
  cwd: join(import.meta.dirname, ".."),
});
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const TEST_PRIV = Buffer.alloc(32, 0x3f);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const REMOTE_ID = "bbbbbbbb-0000-0000-0000-00000000f300";

let seq = 0;

/** Manager with a stub outbound feed capturing appended entries. */
function makeManager() {
  const db = createDbClient(DB_PATH);
  const mgr = new InstanceSyncManager(IDENTITY, db, `f3-test-${++seq}`);
  mgr.feedsDisabled = false; // don't depend on the runner's argv/env
  const entries = [];
  mgr.outFeeds = new Map([["peer-1", { append: async (e) => { entries.push(e); } }]]);
  return { mgr, db, entries };
}

function signedEntry(table, op, row, lamport_ts, instance_id = REMOTE_ID) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}

// Unique 64-hex secp per test (all tests share ONE db file — avoid secp-rebind collisions).
const secp = (n) => String(n).padStart(64, "0");

// ── F3, emit side ───────────────────────────────────────────────────────────

test("F3 emit: `origin` is in EXCLUDED_COLUMNS.contacts", () => {
  assert.ok(EXCLUDED_COLUMNS.contacts.includes("origin"),
    "origin is a local judgment — it must never be advertised on the wire");
});

test("F3 emit: an emitted contacts entry carries NO `origin` key at all", async () => {
  const { mgr, entries } = makeManager();
  const row = {
    crow_id: "crow:f3emit",
    ed25519_pubkey: "e",
    secp256k1_pubkey: secp(301),
    display_name: "Advertised Bot",
    origin: "advertised",
    is_bot: 1,
  };
  const ts = await mgr.emitChange("contacts", "update", row);
  assert.ok(typeof ts === "number", "an advertised-bot contact still syncs (only `origin` is stripped)");
  assert.equal(entries.length, 1, "exactly one entry on the wire");
  const payload = entries[0].row;
  assert.ok(!("origin" in payload),
    `emitted payload must not carry an \`origin\` key; got ${JSON.stringify(payload)}`);
  assert.equal(payload.is_bot, 1, "the FACT columns still ride the wire (only the judgment is stripped)");
});

// ── F3, apply side ──────────────────────────────────────────────────────────

test("F3 apply (local row ABSENT): an inbound `origin:advertised` INSERTs with origin NULL", async () => {
  // The real fleet shape: a host usually has NO contacts row for its own bot, so
  // the peer's entry lands on the INSERT branch and would create the row already
  // labelled prunable.
  const { mgr, db } = makeManager();
  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", {
    crow_id: "crow:f3ins",
    ed25519_pubkey: "e",
    secp256k1_pubkey: secp(302),
    display_name: "Peer's Bot",
    origin: "advertised",
  }, 40));
  const row = (await db.execute({ sql: "SELECT origin, display_name FROM contacts WHERE crow_id='crow:f3ins'" })).rows[0];
  assert.ok(row, "the contact row was created (the row still syncs)");
  assert.equal(row.display_name, "Peer's Bot", "the rest of the row applied normally");
  assert.equal(row.origin, null,
    "origin must be NULL: the judgment is re-derived locally, never inherited from the wire");
});

test("F3 apply (local row PRESENT as local-bot): an inbound `origin:advertised` leaves origin unchanged", async () => {
  // Host protection: a peer must not be able to relabel the host's OWN bot as
  // prunable — the host never sees its own bots advertised, so it would GC it
  // (and FK CASCADE would destroy its DM history).
  const { mgr, db } = makeManager();
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, origin, lamport_ts) VALUES ('crow:f3host','e',?,'My Bot','local-bot',10)",
    args: [secp(303)],
  });
  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "update", {
    crow_id: "crow:f3host",
    ed25519_pubkey: "e",
    secp256k1_pubkey: secp(303),
    display_name: "My Bot (renamed on the peer)",
    origin: "advertised",
  }, 50));
  const row = (await db.execute({ sql: "SELECT origin, display_name FROM contacts WHERE crow_id='crow:f3host'" })).rows[0];
  assert.equal(row.display_name, "My Bot (renamed on the peer)", "the update itself applied (LWW)");
  assert.equal(row.origin, "local-bot",
    "a peer must NOT be able to relabel the host's own bot as prunable");
});

// ── F2: provenance is set at INSERT only, never by a later UPDATE ───────────

test("F2 apply (local row PRESENT, manually pasted): an inbound UPDATE must NOT stamp advertised_by onto it", async () => {
  // A peer that added this bot FROM A DIRECTORY carries advertised_by=X on the wire.
  // If apply wrote that on a LWW UPDATE, it would silently make THIS instance's
  // hand-pasted contact garbage-collectable — breaking #155 §2.6 (pasted-invite bots
  // must not be lost). Provenance is a fact about how a row was ACQUIRED HERE; it is
  // not the sender's to assign after the fact.
  const { mgr, db } = makeManager();
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, is_bot, advertised_by_instance_id, lamport_ts) VALUES ('crow:f2paste','e',?,'Pasted Bot',1,NULL,10)",
    args: [secp(404)],
  });
  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "update", {
    crow_id: "crow:f2paste",
    ed25519_pubkey: "e",
    secp256k1_pubkey: secp(404),
    display_name: "Pasted Bot (renamed on the peer)",
    advertised_by_instance_id: "inst-advertiser-X",
  }, 50));
  const row = (await db.execute({ sql: "SELECT advertised_by_instance_id AS adv, display_name FROM contacts WHERE crow_id='crow:f2paste'" })).rows[0];
  assert.equal(row.display_name, "Pasted Bot (renamed on the peer)", "the update itself applied (LWW)");
  assert.equal(row.adv, null,
    "a peer must NOT be able to make this instance's hand-pasted contact prunable");
});

test("F2 apply (local row ABSENT): an inbound INSERT DOES carry advertised_by — convergence depends on it", async () => {
  // The negative above must not be over-applied: a peer learning the contact for the
  // FIRST time has to receive the provenance, or it can never prune independently and
  // spec §5.7's convergence fails.
  const { mgr, db } = makeManager();
  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", {
    crow_id: "crow:f2sync",
    ed25519_pubkey: "e",
    secp256k1_pubkey: secp(405),
    display_name: "Synced Bot",
    is_bot: 1,
    advertised_by_instance_id: "inst-advertiser-X",
  }, 60));
  const row = (await db.execute({ sql: "SELECT advertised_by_instance_id AS adv FROM contacts WHERE crow_id='crow:f2sync'" })).rows[0];
  assert.equal(row.adv, "inst-advertiser-X",
    "provenance MUST cross the wire on INSERT — without it the receiver can never prune");
});

// ── F3 REGRESSION GUARD ─────────────────────────────────────────────────────
// This is the test that proves the strip runs AFTER the gate. It passed BEFORE
// the F3 change too — that is exactly its job: it must still pass AFTER.

test("F3 REGRESSION GUARD: excluding `origin` did NOT disable the origin='local-bot' emit gate", async () => {
  const { mgr, entries } = makeManager();

  // shouldSyncRow (instance-sync.js:963) reads the RAW row, before the
  // EXCLUDED_COLUMNS strip (:978-981). If a refactor ever reorders those, the
  // strip would erase `origin` first and this gate would silently open —
  // broadcasting a phantom contact for a bot that only exists on THIS instance.
  const localBot = await mgr.emitChange("contacts", "update", {
    crow_id: "crow:f3localbot",
    ed25519_pubkey: "e",
    secp256k1_pubkey: secp(304),
    origin: "local-bot",
    is_bot: 1,
  });
  assert.equal(localBot, null, "a local-bot row must be refused by the emit gate");
  assert.equal(entries.length, 0, "and NOTHING may reach the wire");

  // Control: a normal contact on the same manager DOES emit — so the assertion
  // above is the gate firing, not a dead harness.
  const normal = await mgr.emitChange("contacts", "update", {
    crow_id: "crow:f3normal",
    ed25519_pubkey: "e",
    secp256k1_pubkey: secp(305),
    origin: "advertised",
  });
  assert.ok(typeof normal === "number", "a normal contact still emits");
  assert.equal(entries.length, 1, "exactly the normal contact reached the wire");
  assert.equal(entries[0].row.crow_id, "crow:f3normal");
});
