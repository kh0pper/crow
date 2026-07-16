/**
 * T3 (2c follow-up pool, spec §F2 C2b): the three boot backfills' pre-drain
 * loops are BOUNDED by _drainInboundCapped, with per-drain contracts:
 *
 *   - contacts + groups (G-F2-3): capped or not, PROCEED exactly as today —
 *     their re-emits are lamport-preserving, so a capped drain degrades to
 *     truthful deferred convergence (the #195 semantics). Flags written
 *     unconditionally; the call returns within cap+margin.
 *   - providers (G-F2-2): defer-on-cap — a capped (incomplete) drain must NOT
 *     proceed to the FRESH-MINT re-emit (it would fabricate recency over a
 *     peer's undrained newer edit → spurious sync_conflicts rows). Per-peer
 *     flag becomes `deferred:<n>` (non-terminal; only done:* is). ESCAPE
 *     HATCH (spec R2-1): the 3rd consecutive deferral emits anyway + done:*,
 *     so one permanently-wedged inbound feed cannot block providers backfill
 *     to every new peer forever.
 *
 * ANTI-VACUITY construction (spec R2-5, review round 2):
 *   - BOTH maps are armed: an unflagged peer in outFeeds (backfillProviders
 *     early-returns at :977 when outFeeds is empty — an inFeeds-only test is
 *     vacuous green) AND an inFeed whose entry delivery is parked.
 *   - The barrier parks at FEED-DELIVERY level: the inFeed is a REAL Hypercore
 *     holding a REAL appended entry, and its get() is wrapped so the drain's
 *     `await feed.get(seq)` inside the REAL _processNewEntriesInner genuinely
 *     hangs until released — delivery of the result is delayed, not the call
 *     (better-sqlite3 is synchronous under the async wrapper; a barrier that
 *     delays the SELECT itself is vacuous — 2d T7 lesson).
 *
 * Harness idiom from tests/feed-rotation.test.js / tests/lamport-reemit.test.js:
 * per-test mkdtemp CROW_DATA_DIR + real init-db, mgr.dataDir = scratch,
 * mgr.feedsDisabled = false, REAL Hypercore in-feed; stub capture out-feed
 * (the lamport-reemit backfill-gate idiom) so emissions and their envelope
 * lamports are assertable. NEVER point this file at ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Hypercore from "hypercore";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { __setEmitSinkForTest as __setGroupSink } from "../servers/sharing/group-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const LOCAL_ID = "inst-dddd-0000-0000-0000-00000000000d";
const PEER_ID = "peer-cccc-0000-0000-0000-00000000000c";
const PROVIDERS_FLAG = `__providers_backfill_v1:${PEER_ID}`;
const DRAIN_CAP_MS = 150;

async function makeIdentity() {
  const priv = Buffer.alloc(32, 0x2c);
  const pub = Buffer.from(await ed.getPublicKey(priv)).toString("hex");
  return { ed25519Priv: priv, ed25519Pubkey: pub };
}

/** Await `promise`, but reject with `msg` after `ms` — so an uncapped drain
 *  fails cleanly (RED) instead of hanging the whole test file forever. */
async function withDeadline(promise, ms, msg) {
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); });
  try { return await Promise.race([promise, guard]); }
  finally { clearTimeout(timer); }
}

/** Poll until fn() is truthy or the deadline passes — condition-based, no bare sleeps. */
async function until(fn, ms = 4000, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/**
 * One fresh instance per test: real init-db scratch DB, a stub CAPTURE
 * out-feed for PEER_ID (unflagged → :977 gate passes and providers sees a
 * pending peer), and a REAL Hypercore in-feed for the SAME peer holding one
 * real entry whose delivery is parked behind a gate (feed-delivery barrier).
 */
async function makeRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `crow-t3-drain-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    // CROW_DB_PATH outranks CROW_DATA_DIR in init-db — blank it, or a shell
    // exporting it would run the migration against the REAL DB (PR #180).
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" },
    stdio: "pipe",
  });
  const db = createDbClient(join(dir, "crow.db"));
  const mgr = new InstanceSyncManager(await makeIdentity(), db, LOCAL_ID);
  mgr.dataDir = join(dir, "instance-sync"); // MUST: keep test feeds out of ~/.crow
  mgr.feedsDisabled = false;                // MUST: scratch env disables feeds (2c C6)
  mgr._drainCapMs = DRAIN_CAP_MS;           // small cap for test speed

  // Out-feed: capture stub keyed by the peer id (lamport-reemit idiom) —
  // emitChange's broadcast targets outFeeds keys, so every emission lands here.
  const wire = [];
  mgr.outFeeds = new Map([[PEER_ID, {
    append: async (e) => { wire.push(JSON.parse(JSON.stringify(e))); },
  }]]);

  // In-feed: REAL Hypercore with one REAL entry; delivery parked at get().
  const inCore = new Hypercore(join(dir, "in-peer"), { valueEncoding: "json" });
  await inCore.ready();
  // memories.id is INTEGER PRIMARY KEY — string ids fail silently on apply.
  // The 64-byte zero signature verifies false → skip-and-checkpoint, which is
  // all a COMPLETED drain needs (the mechanism under test is the cap/flags).
  await inCore.append({
    table: "memories", op: "insert",
    row: { id: 990001, content: "t3 parked entry", lamport_ts: 1 },
    lamport_ts: 1, instance_id: PEER_ID, signature: "00".repeat(64),
  });
  const realGet = inCore.get.bind(inCore);
  let release;
  const gate = new Promise((r) => { release = r; });
  let parked = true;
  inCore.get = async (seq, opts) => { if (parked) await gate; return realGet(seq, opts); };
  const unpark = () => { parked = false; release(); };
  mgr.inFeeds.set(PEER_ID, inCore);

  return {
    dir, db, mgr, wire, inCore, unpark,
    providersOnWire: () => wire.filter((e) => e.table === "providers"),
    flag: async (key) =>
      (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value ?? null,
    async cleanup() {
      unpark(); // let abandoned background drains finish before closing the core
      await new Promise((r) => setTimeout(r, 50));
      try { await inCore.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── G-F2-2: providers defer-on-cap + 3rd-deferral escape hatch ────────────────
test("G-F2-2: providers defer-on-cap -- capped drains write deferred:<n> with NO emit; 3rd deferral emits anyway + done (escape hatch)", async () => {
  const rig = await makeRig("prov");
  try {
    // Non-loopback base_url — loopback rows are gated off the wire by shouldSyncRow.
    await rig.db.execute({ sql: "INSERT INTO providers (id, base_url, models) VALUES ('prov-t3', 'http://10.0.0.99:8000/v1', '[]')", args: [] });

    // Run 1 (parked): capped drain → defer, no emissions.
    const r1 = await withDeadline(rig.mgr.backfillProvidersForNewPeers(), 5000,
      "providers backfill blocked >5s by a parked feed delivery (drain uncapped?)");
    assert.equal(r1, 0, "deferred run returns 0");
    assert.equal(rig.providersOnWire().length, 0, "NO providers entries rode under a capped drain");
    assert.equal(await rig.flag(PROVIDERS_FLAG), "deferred:1", "run 1 wrote deferred:1");

    // Run 2 (still parked): deferral count advances, still nothing on the wire.
    await withDeadline(rig.mgr.backfillProvidersForNewPeers(), 5000,
      "providers backfill run 2 blocked >5s (drain uncapped?)");
    assert.equal(rig.providersOnWire().length, 0, "still no providers entries after run 2");
    assert.equal(await rig.flag(PROVIDERS_FLAG), "deferred:2", "run 2 wrote deferred:2");

    // Run 3 (still parked): ESCAPE HATCH — emits anyway, terminal done:<n>.
    const r3 = await withDeadline(rig.mgr.backfillProvidersForNewPeers(), 5000,
      "providers backfill run 3 blocked >5s (drain uncapped?)");
    assert.ok(r3 >= 1, `escape hatch emitted (got ${r3})`);
    assert.ok(rig.providersOnWire().some((e) => e.row?.id === "prov-t3"),
      "the provider row rode the wire on the escape hatch");
    assert.equal(await rig.flag(PROVIDERS_FLAG), `done:${r3}`, "escape hatch wrote terminal done:<n>");
  } finally {
    await rig.cleanup();
  }
});

test("G-F2-2b: providers deferred run stays retryable -- unpark, next run completes the drain, emits, done", async () => {
  const rig = await makeRig("prov-unpark");
  try {
    await rig.db.execute({ sql: "INSERT INTO providers (id, base_url, models) VALUES ('prov-t3b', 'http://10.0.0.98:8000/v1', '[]')", args: [] });

    // Parked run → deferred, nothing rode.
    const r1 = await withDeadline(rig.mgr.backfillProvidersForNewPeers(), 5000,
      "providers backfill blocked >5s by a parked feed delivery (drain uncapped?)");
    assert.equal(r1, 0);
    assert.equal(rig.providersOnWire().length, 0, "no emissions while parked");
    assert.equal(await rig.flag(PROVIDERS_FLAG), "deferred:1", "parked run wrote deferred:1 (non-terminal)");

    // Unpark: the abandoned background drain completes and checkpoints seq 1.
    rig.unpark();
    assert.ok(await until(async () => (await rig.mgr._getLastAppliedSeq(PEER_ID, rig.inCore)) >= 1),
      "background drain checkpointed the parked entry after unpark");

    // Next run: drain completes within the cap → emits + terminal done:<n>.
    const r2 = await withDeadline(rig.mgr.backfillProvidersForNewPeers(), 5000,
      "providers backfill after unpark blocked >5s");
    assert.ok(r2 >= 1, `completed drain emitted (got ${r2})`);
    assert.ok(rig.providersOnWire().some((e) => e.row?.id === "prov-t3b"), "provider row rode after unpark");
    assert.equal(await rig.flag(PROVIDERS_FLAG), `done:${r2}`, "completed run wrote terminal done:<n>");
  } finally {
    await rig.cleanup();
  }
});

// ── G-F2-3: contacts + groups proceed under a capped drain, lamport-preserving ─
test("G-F2-3a: contacts backfill under a capped drain still emits lamport-preserving and writes its flag, within cap+margin", async () => {
  const rig = await makeRig("contacts");
  try {
    await rig.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:t3c', '', 't3caa', 'T3 Contact', 5)", args: [] });

    const t0 = Date.now();
    // Without the drain cap this await never resolves ⇒ withDeadline rejects (RED).
    const emitted = await withDeadline(rig.mgr.backfillContactsOnce(), 5000,
      "contacts backfill blocked >5s by a parked feed delivery (drain uncapped?)");
    const elapsed = Date.now() - t0;
    // Wrapper runs the gated-body drain AND the tombstone re-emit drain (both
    // capped) — bound at a small multiple of the cap, not a hang.
    assert.ok(elapsed < 3000, `returned within cap+margin (${elapsed}ms, cap ${DRAIN_CAP_MS}ms)`);

    assert.ok(emitted >= 1, "capped drain still emitted (contacts PROCEED on cap)");
    const entry = rig.wire.filter((e) => e.table === "contacts" && e.row?.crow_id === "crow:t3c").at(-1);
    assert.ok(entry, "contact rode the wire despite the capped drain");
    assert.equal(Number(entry.lamport_ts), 5, "envelope preserved the row lamport (no fresh mint)");
    assert.equal(await rig.flag("__contacts_backfill_v1"), `done:${emitted}`,
      "contacts done-flag written unconditionally (existing semantics)");
  } finally {
    await rig.cleanup();
  }
});

test("G-F2-3b: groups backfill under a capped drain still emits lamport-preserving and writes its flag, within cap+margin", async () => {
  const rig = await makeRig("groups");
  try {
    await rig.db.execute({ sql: "INSERT INTO contact_groups (name, group_uid, lamport_ts) VALUES ('T3 Group', 'uid-t3-group', 30)", args: [] });

    const t0 = Date.now();
    __setGroupSink(rig.mgr); // emitGroupUpsert routes through the module sink
    let emitted;
    try {
      emitted = await withDeadline(rig.mgr.backfillGroupsOnce(), 5000,
        "groups backfill blocked >5s by a parked feed delivery (drain uncapped?)");
    } finally {
      __setGroupSink(null);
    }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, `returned within cap+margin (${elapsed}ms, cap ${DRAIN_CAP_MS}ms)`);

    assert.ok(emitted >= 1, "capped drain still emitted (groups PROCEED on cap)");
    const entry = rig.wire.filter((e) => e.table === "contact_groups" && e.row?.group_uid === "uid-t3-group").at(-1);
    assert.ok(entry, "group rode the wire despite the capped drain");
    assert.equal(Number(entry.lamport_ts), 30, "envelope preserved the row lamport (no fresh mint)");
    assert.equal(await rig.flag("__groups_backfill_v1"), `done:${emitted}`,
      "groups done-flag written unconditionally (existing semantics)");
  } finally {
    await rig.cleanup();
  }
});
