/**
 * Security audit N1b-7 — provider settings sync to paired peers; API keys never
 * leave the instance where they were entered (operator ruling 2026-11-05).
 *
 * What must hold, and what each test drives through the REAL sync code:
 *
 *   1. A providers row syncs (address, models, description, type...) and its
 *      `api_key` never appears on the wire, in ANY emit door.
 *   2. A peer's row lands here with no key; an old (pre-upgrade) peer's raw
 *      inbound row that still carries `api_key` writes nothing — neither on an
 *      insert nor on an update, and a row that omits the key never nulls it.
 *   3. Two instances holding DIFFERENT keys still converge: their rows are
 *      equivalent, no conflict row is manufactured, re-delivery is silent.
 *   4. A synced provider that needs a key and has none here is surfaced once,
 *      by name; never for a keyless one (a llama.cpp on the LAN); never again
 *      once a key is entered here.
 *   5. Fix round 1 (operator ruling 2026-11-06): an inbound change that MOVES a
 *      provider's endpoint while the key lives HERE is held as a proposed
 *      change (one sync_conflicts row, one named bell item) until the operator
 *      accepts it on this device; a keyless row still updates freely. Held in
 *      BOTH directions (whoever holds the key).
 *   6. Fix round 2: NO conflict snapshot ever holds a key — not an ordinary
 *      Lamport conflict, not the endpoint hold, not the restore's stale
 *      re-snapshot — and old rows are redacted once at boot.
 *   7. Fix round 2: "needs a key on this device" rings once per provider id
 *      (a read or a dismissed notice is an answer too), and the held-address
 *      bell rings once per OPEN held conflict.
 *   8. Fix round 3: the READ doors strip old rows too — `crow_list_sync_conflicts`
 *      (a stdio-only install never runs the boot repair) and the sync-conflicts
 *      page — and neither throws on a `'null'` snapshot;
 *      the boot repair's write is conditional on the values it read, its SELECT
 *      reads only rows that mention a local-only column, and the snapshot strip
 *      returns the caller's own string when there is nothing to remove.
 *
 * Harness: real instance DBs (scripts/init-db.js per dir, like paired Crow
 * boxes), real InstanceSyncManagers over stub Hypercore feeds that carry the
 * SIGNED wire entries, one shared identity so sign/verify pass (pattern:
 * tests/providers-war-sim.test.js).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager, rowsEquivalent, stripConflictSnapshot } from "../servers/sharing/instance-sync.js";
import { upsertProvider, listProvidersAll, disableProvider, setProviderSyncManager } from "../servers/shared/providers-db.js";
import { emitOrQueue, _setEligibilityForTest } from "../servers/shared/sync-emit.js";
import { drainOnce } from "../servers/sharing/sync-outbox-drain.js";
import {
  providerNeedsKey, providerKeyNoticeSource, noticeProviderKeyNeeded,
} from "../servers/shared/provider-key-need.js";
import { sign } from "../servers/sharing/identity.js";
import { endpointHoldNoticeSource } from "../servers/shared/provider-endpoint.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";
import { trustRemotesOnApply } from "./fixtures/trusted-apply.mjs";

const A_ID = "aaaa1111-0000-4000-8000-0000000a0001";
const B_ID = "bbbb1111-0000-4000-8000-0000000b0001";

const KEY_A = "sk-test-key-on-a";
const KEY_B = "sk-other-key-on-b";

const TEST_PRIV = Buffer.alloc(32, 0x7b);
const IDENTITY = {
  ed25519Priv: TEST_PRIV,
  ed25519Pubkey: Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex"),
};

// getOrCreateLocalInstanceId() (called by upsertProvider / emitOrQueue) reads
// CROW_DATA_DIR directly — pin it to a scratch dir so the real ~/.crow is never
// touched. Restored in after() because run-suite.mjs sets it for the process.
const idDir = mkdtempSync(join(tmpdir(), "crow-n1b7-instanceid-"));
const PREV_DATA_DIR = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = idDir;

const _dirs = [];
after(() => {
  setProviderSyncManager(null);
  _setEligibilityForTest(null);
  if (PREV_DATA_DIR === undefined) delete process.env.CROW_DATA_DIR;
  else process.env.CROW_DATA_DIR = PREV_DATA_DIR;
  rmSync(idDir, { recursive: true, force: true });
  for (const d of _dirs) rmSync(d, { recursive: true, force: true });
  _dirs.length = 0;
});

/** A real, migrated instance DB + a real sync manager driving stub feeds. */
function freshInstance(label, instanceId) {
  const dir = mkdtempSync(join(tmpdir(), `crow-n1b7-${label}-`));
  _dirs.push(dir);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createDbClient(join(dir, "crow.db"));
  // PT-1: entries apply only from a trusted, live paired peer; the fixture
  // pairs the remote for the duration of an apply run.
  const mgr = trustRemotesOnApply(new InstanceSyncManager(IDENTITY, db, instanceId));
  mgr.feedsDisabled = false;
  const feeds = new Map();
  mgr.outFeeds = feeds;
  return {
    dir, db, mgr,
    /** The outbound side to one peer: what the manager appends IS the wire. */
    peerFeed(peerId) {
      const feed = {
        entries: [],
        get length() { return feed.entries.length; },
        async get(seq) { return feed.entries[seq]; },
        async append(entry) { feed.entries.push(entry); return feed.entries.length - 1; },
      };
      feeds.set(peerId, feed);
      return feed;
    },
    async row(id) {
      const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
      return rows[0] ?? null;
    },
    async conflicts() {
      const { rows } = await db.execute("SELECT COUNT(*) AS n FROM sync_conflicts");
      return Number(rows[0].n);
    },
    async close() {
      try { db.close(); } catch {}
    },
  };
}

/** A signed entry exactly as emitChange would build one (what an OLD peer sends). */
function signedEntry({ op, row, lamport_ts, instance_id }) {
  const entry = { table: "providers", op, row, lamport_ts, instance_id };
  entry.signature = sign(JSON.stringify(entry), IDENTITY.ed25519Priv);
  return entry;
}

/** A stub in-feed over already-signed entries. */
function stubFeed(entries) {
  return {
    entries,
    get length() { return entries.length; },
    async get(seq) { return entries[seq]; },
  };
}

const wireHasKey = (feed) => feed.entries.some((e) => Object.hasOwn(e.row, "api_key"));

const CLOUD = { baseUrl: "https://api.openai.com/v1", host: "cloud", providerType: "openai" };
const MODELS_1 = [{ id: "gpt-4o-mini" }];
const MODELS_2 = [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }];

/* ══════════════════════════════ 1. two-instance, both directions ══════════════ */

test("two instances: the key stays where it was entered, in BOTH directions, while address/models converge", async () => {
  const a = freshInstance("two-a", A_ID);
  const b = freshInstance("two-b", B_ID);
  const feedAtoB = a.peerFeed(B_ID);
  const feedBtoA = b.peerFeed(A_ID);

  try {
    // ── A adds a cloud provider WITH a key ──────────────────────────────────
    setProviderSyncManager(a.mgr);
    await upsertProvider(a.db, { id: "prov-cloud", ...CLOUD, models: MODELS_1, apiKey: KEY_A });

    assert.equal(feedAtoB.entries.length, 1, "A emitted exactly one wire entry");
    const firstWire = feedAtoB.entries[0];
    assert.equal(Object.hasOwn(firstWire.row, "api_key"), false,
      "the wire row must not carry api_key — this is the whole audit item");
    assert.equal(firstWire.row.base_url, CLOUD.baseUrl);
    assert.deepEqual(JSON.parse(firstWire.row.models), MODELS_1);

    // ── B applies it: same provider, same endpoint/models, NO key ────────────
    await b.mgr._processNewEntries(A_ID, feedAtoB);
    const bRow = await b.row("prov-cloud");
    assert.ok(bRow, "the provider row itself still syncs");
    assert.equal(bRow.base_url, CLOUD.baseUrl);
    assert.deepEqual(JSON.parse(bRow.models), MODELS_1);
    assert.equal(bRow.api_key, null, "B holds no key: keys never leave the instance that entered them");

    // ── B enters its OWN key K2; A keeps K ──────────────────────────────────
    setProviderSyncManager(b.mgr);
    const bPanelRow = (await listProvidersAll(b.db)).find((p) => p.id === "prov-cloud");
    await upsertProvider(b.db, { ...bPanelRow, apiKey: KEY_B });
    assert.equal(feedBtoA.entries.length, 1, "B emitted its key write");
    assert.equal(Object.hasOwn(feedBtoA.entries[0].row, "api_key"), false,
      "B's own key must not ride back to A");

    await a.mgr._processNewEntries(B_ID, feedBtoA);
    assert.equal((await a.row("prov-cloud")).api_key, KEY_A, "A keeps the key IT entered");
    assert.equal((await b.row("prov-cloud")).api_key, KEY_B, "B keeps the key IT entered");

    // ── CONVERGENCE while the keys differ ───────────────────────────────────
    // The two instances now hold the same content and different keys. That must
    // read as CONVERGED: the equivalence judgement ignores api_key, a re-delivery
    // at an equal lamport is noise, and neither side logs a conflict.
    const lastB = feedBtoA.entries[0];
    assert.equal(rowsEquivalent(await a.row("prov-cloud"), lastB.row), true,
      "the equivalence/digest judgement ignores api_key (else differing keys look divergent forever)");
    const verdict = await a.mgr._checkConflict("providers", "prov-cloud", lastB.lamport_ts, B_ID, lastB.row, "update");
    assert.equal(verdict, "skip", "an equal-lamport re-delivery is noise, not a conflict");

    // Full replay of BOTH feeds (checkpoints reset so the real apply path runs
    // again, not just _checkConflict): silent on both sides.
    await a.mgr._setLastAppliedSeq(B_ID, 0, null);
    await b.mgr._setLastAppliedSeq(A_ID, 0, null);
    await a.mgr._processNewEntries(B_ID, feedBtoA);
    await b.mgr._processNewEntries(A_ID, feedAtoB);
    assert.equal(await a.conflicts(), 0, "A logs no conflict while the keys differ");
    assert.equal(await b.conflicts(), 0, "B logs no conflict while the keys differ");
    assert.equal((await a.row("prov-cloud")).api_key, KEY_A);
    assert.equal((await b.row("prov-cloud")).api_key, KEY_B);

    // ── A edits the models; B gets them and keeps K2 ────────────────────────
    setProviderSyncManager(a.mgr);
    const aPanelRow = (await listProvidersAll(a.db)).find((p) => p.id === "prov-cloud");
    await upsertProvider(a.db, { ...aPanelRow, models: MODELS_2 });
    assert.equal(feedAtoB.entries.length, 2);

    await b.mgr._processNewEntries(A_ID, feedAtoB);
    const bAfter = await b.row("prov-cloud");
    assert.deepEqual(JSON.parse(bAfter.models), MODELS_2, "the models edit propagates");
    assert.equal(bAfter.api_key, KEY_B, "…and never disturbs B's own key");
    assert.equal((await a.row("prov-cloud")).api_key, KEY_A);

    // ── No key on ANY wire entry, either direction ──────────────────────────
    assert.equal(wireHasKey(feedAtoB), false);
    assert.equal(wireHasKey(feedBtoA), false);
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

/* ══════════════════════════════ 2. an OLD peer still sends the key ═════════════ */

test("old peer: a raw inbound row carrying api_key writes nothing — insert", async () => {
  const b = freshInstance("old-insert", B_ID);
  try {
    const entry = signedEntry({
      op: "insert",
      lamport_ts: 500,
      instance_id: A_ID,
      row: {
        id: "prov-old-insert", base_url: CLOUD.baseUrl, models: JSON.stringify(MODELS_1),
        provider_type: "openai", api_key: "sk-leaked-by-old-peer", instance_id: A_ID,
      },
    });
    await b.mgr._processNewEntries(A_ID, stubFeed([entry]));

    const inserted = await b.row("prov-old-insert");
    assert.ok(inserted, "the row itself is still applied (only the key is local)");
    assert.equal(inserted.base_url, CLOUD.baseUrl);
    assert.equal(inserted.api_key, null, "a new row from a peer is inserted with NO local key");
    assert.equal(await b.conflicts(), 0);
  } finally {
    await b.close();
  }
});

test("old peer: a raw inbound row carrying api_key never overwrites the local key — update", async () => {
  const b = freshInstance("old-update", B_ID);
  try {
    await b.db.execute({
      sql: "INSERT INTO providers (id, base_url, models, provider_type, api_key, lamport_ts, instance_id) VALUES (?, ?, ?, ?, ?, 100, ?)",
      args: ["prov-old-update", CLOUD.baseUrl, JSON.stringify(MODELS_1), "openai", KEY_B, B_ID],
    });
    const entry = signedEntry({
      op: "update",
      lamport_ts: 900,
      instance_id: A_ID,
      row: {
        id: "prov-old-update", base_url: CLOUD.baseUrl, models: JSON.stringify(MODELS_2),
        provider_type: "openai", api_key: "sk-leaked-by-old-peer",
      },
    });
    await b.mgr._processNewEntries(A_ID, stubFeed([entry]));

    const updated = await b.row("prov-old-update");
    assert.deepEqual(JSON.parse(updated.models), MODELS_2, "the peer's real content still applies");
    assert.equal(updated.api_key, KEY_B, "an inbound row never writes or overwrites the local key");
    // …and the peer's key was not even recorded as a conflict's losing version.
    const { rows: conflicts } = await b.db.execute("SELECT losing_data FROM sync_conflicts");
    assert.equal(conflicts.length, 0, "a dropped local-only column manufactures no conflict row");
  } finally {
    await b.close();
  }
});

test("old peer: an update that OMITS api_key leaves the local key alone", async () => {
  const b = freshInstance("old-sparse", B_ID);
  try {
    await b.db.execute({
      sql: "INSERT INTO providers (id, base_url, models, provider_type, api_key, lamport_ts, instance_id) VALUES (?, ?, ?, ?, ?, 100, ?)",
      args: ["prov-missing-key", CLOUD.baseUrl, JSON.stringify(MODELS_1), "openai", KEY_B, B_ID],
    });
    const entry = signedEntry({
      op: "update",
      lamport_ts: 1200,
      instance_id: A_ID,
      row: { id: "prov-missing-key", base_url: CLOUD.baseUrl, models: JSON.stringify(MODELS_2) },
    });
    await b.mgr._processNewEntries(A_ID, stubFeed([entry]));

    const sparse = await b.row("prov-missing-key");
    assert.equal(sparse.api_key, KEY_B, "an absent api_key on the wire never nulls the local one");
    assert.deepEqual(JSON.parse(sparse.models), MODELS_2);
  } finally {
    await b.close();
  }
});

test("conflict restore: a losing providers snapshot carrying api_key never writes it back", async () => {
  const b = freshInstance("old-restore", B_ID);
  try {
    await b.db.execute({
      sql: "INSERT INTO providers (id, base_url, models, provider_type, api_key, lamport_ts, instance_id) VALUES (?, ?, ?, ?, ?, 100, ?)",
      args: ["prov-restore", CLOUD.baseUrl, JSON.stringify(MODELS_1), "openai", KEY_B, B_ID],
    });
    const live = await b.row("prov-restore");
    // A conflict row as the pre-upgrade code recorded one: the LOSING side is a
    // peer's wire row that still carried its key.
    await b.db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
            VALUES ('providers', 'prov-restore', ?, ?, 100, 90, ?, ?, 'update')`,
      args: [B_ID, A_ID, JSON.stringify(live),
        JSON.stringify({ id: "prov-restore", base_url: CLOUD.baseUrl, provider_type: "openai",
          models: JSON.stringify(MODELS_2), api_key: "sk-leaked-by-old-peer" })],
    });
    const { rows } = await b.db.execute("SELECT id FROM sync_conflicts WHERE row_id = 'prov-restore'");
    const { restoreConflict } = await import("../servers/sharing/sync-conflict-resolve.js");
    const outcome = await restoreConflict(b.db, rows[0].id, { instanceSync: null });
    assert.equal(outcome.status, "applied");
    const after = await b.row("prov-restore");
    assert.deepEqual(JSON.parse(after.models), MODELS_2, "the restored content applies");
    assert.equal(after.api_key, KEY_B, "the losing snapshot's api_key is never written back");
  } finally {
    await b.close();
  }
});

/* ═══════════════════════ 3. every emit door strips api_key ═══════════════════ */

test("every emit path emits no api_key: emitChange, upsert, disable, backfill, outbox queue and drain", async () => {
  const inst = freshInstance("doors", A_ID);
  const peerFeed = inst.peerFeed(B_ID);

  try {
    await inst.db.execute({
      sql: "INSERT INTO providers (id, base_url, models, provider_type, api_key, lamport_ts, instance_id) VALUES (?, ?, ?, ?, ?, 10, ?)",
      args: ["prov-door", CLOUD.baseUrl, JSON.stringify(MODELS_1), "openai", KEY_A, A_ID],
    });
    const dbRow = await inst.row("prov-door");

    // (a) emitChange directly — the door every manager-side emit uses.
    setProviderSyncManager(null);
    await inst.mgr.emitChange("providers", "update", dbRow);
    assert.equal(peerFeed.entries.length, 1);
    assert.equal(Object.hasOwn(peerFeed.entries[0].row, "api_key"), false, "emitChange strips api_key");

    // (b) providers-db upsert (the panel / bundle / reconciler write path).
    setProviderSyncManager(inst.mgr);
    const panelRow = (await listProvidersAll(inst.db)).find((p) => p.id === "prov-door");
    await upsertProvider(inst.db, { ...panelRow, models: MODELS_2, apiKey: KEY_A });
    assert.equal(peerFeed.entries.length, 2);
    assert.equal(Object.hasOwn(peerFeed.entries[1].row, "api_key"), false, "upsertProvider's emit carries no api_key");

    // (c) disableProvider — its SELECT * spread hands the whole row to the emit.
    await disableProvider(inst.db, "prov-door");
    assert.equal(peerFeed.entries.length, 3);
    assert.equal(Object.hasOwn(peerFeed.entries[2].row, "api_key"), false, "a soft-delete emit carries no api_key");
    assert.equal(Number(peerFeed.entries[2].row.disabled), 1);

    // (d) the new-peer backfill (a SELECT * over the table, re-emitted as inserts).
    setProviderSyncManager(null);
    const before = peerFeed.entries.length;
    const emitted = await inst.mgr.backfillProvidersForNewPeers();
    assert.ok(emitted >= 1, "the backfill emitted the row");
    const backfilled = peerFeed.entries.slice(before);
    assert.ok(backfilled.length >= 1, "there is a wire payload to inspect");
    for (const e of backfilled) {
      assert.equal(Object.hasOwn(e.row, "api_key"), false, "backfill carries no api_key");
    }

    // (e) the stdio outbox (no live manager): the QUEUED payload itself, which
    // the drain later replays verbatim.
    _setEligibilityForTest(() => true);
    const stored = await inst.row("prov-door");
    try {
      await emitOrQueue(null, inst.db, "providers", "update", { ...stored, api_key: KEY_A });
    } finally {
      _setEligibilityForTest(null);
    }
    const { rows: boxed } = await inst.db.execute("SELECT row_json FROM sync_outbox ORDER BY id DESC LIMIT 1");
    assert.ok(boxed[0], "the write was queued");
    const queued = JSON.parse(boxed[0].row_json);
    assert.equal(Object.hasOwn(queued, "api_key"), false, "the sync outbox row carries no api_key");
    assert.equal(queued.id, "prov-door");

    // (f) the drain replays that queued row through emitChange onto the wire.
    const drained = [];
    inst.mgr.outFeeds.set("peer-drain", { append: async (e) => { drained.push(e); } });
    const drainedResult = await drainOnce(inst.mgr, inst.db);
    assert.ok(drainedResult.emitted >= 1, "the drain delivered the queued row");
    assert.ok(drained.length >= 1, "the drain appended a real wire entry");
    for (const e of drained) {
      assert.equal(Object.hasOwn(e.row, "api_key"), false, "the drained wire entry carries no api_key");
    }
  } finally {
    setProviderSyncManager(null);
    _setEligibilityForTest(null);
    await inst.close();
  }
});

/* ═══════════════════════════════════ 4. settings UI ═══════════════════════════ */

test("providers tab: the key line by the key field, and 'needs a key' on a peer row without one", async () => {
  const { default: tab, needsKeyLine } = await import("../servers/gateway/dashboard/settings/sections/llm/providers-tab.js");
  const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
  const ownId = getOrCreateLocalInstanceId();

  const rows = [
    { id: "peer-cloud", base_url: CLOUD.baseUrl, api_key: null, host: "cloud", bundle_id: null,
      provider_type: "openai", description: null, models: JSON.stringify(MODELS_1), disabled: 0,
      instance_id: "peer-instance-id" },
    { id: "mine-own", base_url: CLOUD.baseUrl, api_key: null, host: "cloud", bundle_id: null,
      provider_type: "openai", description: null, models: JSON.stringify(MODELS_1), disabled: 0,
      instance_id: ownId },
    { id: "lan-llama", base_url: "http://100.64.20.9:8080/v1", api_key: null, host: "cloud", bundle_id: null,
      provider_type: "openai-compat", description: null, models: JSON.stringify([{ id: "qwen3-4b" }]), disabled: 0,
      instance_id: "peer-instance-id" },
    { id: "peer-with-key", base_url: "https://api.anthropic.com", api_key: "sk-not-rendered", host: "cloud", bundle_id: null,
      provider_type: "anthropic", description: null, models: JSON.stringify(MODELS_1), disabled: 0,
      instance_id: "peer-instance-id" },
  ];
  const db = {
    execute: async (q) => {
      const sql = typeof q === "string" ? q : q.sql;
      if (sql.includes("FROM providers")) return { rows };
      return { rows: [] };
    },
  };

  const html = await tab.render({ db, lang: "en" });
  assert.match(html, /Keys stay on this device; they are not shared with paired devices\./,
    "the line by the key field says keys never leave this device");
  assert.doesNotMatch(html, /this API key will sync to your paired Crow instances/,
    "the old, now-false claim is gone");
  // Exactly one row is told it needs a key: the peer's keyed provider.
  assert.equal((html.match(/Needs an API key on this device\./g) || []).length, 1);
  assert.match(needsKeyLine({ id: "x", baseUrl: CLOUD.baseUrl, apiKey: null, instance_id: "peer-instance-id" }, { ownInstanceId: ownId }),
    /Needs an API key on this device\./);
  assert.equal(needsKeyLine({ id: "x", baseUrl: CLOUD.baseUrl, apiKey: null, instance_id: ownId }, { ownInstanceId: ownId }), "",
    "a locally created provider is never told to enter a key");
  assert.equal(needsKeyLine({ id: "x", baseUrl: "http://100.64.20.9:8080/v1", apiKey: null, instance_id: "peer-instance-id" }, { ownInstanceId: ownId }), "",
    "a keyless provider (a llama.cpp on the tailnet) is not told to enter a key");
  assert.equal(needsKeyLine({ id: "x", baseUrl: CLOUD.baseUrl, apiKey: "sk-here", instance_id: "peer-instance-id" }, { ownInstanceId: ownId }), "",
    "nothing to say once a key is here");
  // The Spanish line exists (i18n parity is enforced by tests/i18n-global-parity.test.js).
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  assert.notEqual(t("settings.providers.keyStaysLocal", "es"), t("settings.providers.keyStaysLocal", "en"));
  assert.notEqual(t("settings.providers.needsKeyHere", "es"), t("settings.providers.needsKeyHere", "en"));
});


/* ═════════ 5b. a peer may not repoint a provider that holds a key here ═══════ */

const HOLD_ID = "prov-hold";
const URL_OLD = CLOUD.baseUrl;                      // https://api.openai.com/v1
const URL_NEW = "https://openai.peer.example/v1";   // where the peer points it
const URL_NEWER = "https://openai.peer2.example/v1";

/** The held/conflict rows this device recorded for one providers row id. */
async function providerConflicts(db, rowId = HOLD_ID) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM sync_conflicts WHERE table_name = 'providers' AND row_id = ? ORDER BY id`,
    args: [rowId],
  });
  return rows;
}

const holdNoticeRows = async (db, id = HOLD_ID) => {
  const { rows } = await db.execute({
    sql: "SELECT id, title, body, action_url, is_read FROM notifications WHERE source = ? ORDER BY id",
    args: [endpointHoldNoticeSource(id)],
  });
  return rows;
};

/**
 * A and B share one cloud provider id. A's copy has NO key; B applies it, then
 * enters its OWN key — the state under test: the key lives HERE, and A is about
 * to want the address moved.
 */
async function keyedProviderOnBoth(label) {
  const a = freshInstance(`${label}-a`, A_ID);
  const b = freshInstance(`${label}-b`, B_ID);
  const feedAtoB = a.peerFeed(B_ID);
  const feedBtoA = b.peerFeed(A_ID);

  setProviderSyncManager(a.mgr);
  await upsertProvider(a.db, { id: HOLD_ID, ...CLOUD, models: MODELS_1 });
  await b.mgr._processNewEntries(A_ID, feedAtoB);

  setProviderSyncManager(b.mgr);
  const bPanel = (await listProvidersAll(b.db)).find((p) => p.id === HOLD_ID);
  await upsertProvider(b.db, { ...bPanel, apiKey: KEY_B });
  await a.mgr._processNewEntries(B_ID, feedBtoA);
  return { a, b, feedAtoB };
}

/** A repoints the provider — a plain local edit on A, which emits to B. */
async function repointOnA(a, url) {
  setProviderSyncManager(a.mgr);
  const panel = (await listProvidersAll(a.db)).find((p) => p.id === HOLD_ID);
  await upsertProvider(a.db, { ...panel, baseUrl: url });
}

test("endpoint hold: a peer's address change is held when the key lives here — one conflict, one bell, by name", async () => {
  const { a, b, feedAtoB } = await keyedProviderOnBoth("hold-one");
  try {
    assert.equal((await b.row(HOLD_ID)).base_url, URL_OLD, "both boxes start on the same address");
    assert.equal((await b.row(HOLD_ID)).api_key, KEY_B, "B holds the key on this device");

    await repointOnA(a, URL_NEW);
    await b.mgr._processNewEntries(A_ID, feedAtoB);

    const live = await b.row(HOLD_ID);
    assert.equal(live.base_url, URL_OLD, "B's row is NOT repointed — the change is held");
    assert.equal(live.api_key, KEY_B, "and the key stays where it was entered");

    const conflicts = await providerConflicts(b.db);
    assert.equal(conflicts.length, 1, "exactly one conflict records the held change");
    assert.equal(Number(conflicts[0].resolved), 0, "it is unresolved: it waits for the operator");
    assert.equal(conflicts[0].op, "update", "it reads as a proposed update (Restore is available)");
    const losing = JSON.parse(conflicts[0].losing_data);
    assert.equal(losing.base_url, URL_NEW, "the held version carries the peer's new address");
    assert.equal(Object.hasOwn(losing, "api_key"), false, "never a key in the held snapshot");
    const winning = JSON.parse(conflicts[0].winning_data);
    assert.equal(winning.base_url, URL_OLD, "the kept version is this device's row");
    // The conflict row is shown on the sync-conflicts page and returned by
    // crow_list_sync_conflicts: this device's key must not be stored in it.
    assert.equal(Object.hasOwn(winning, "api_key"), false, "never this device's key in the kept snapshot");
    assert.equal(conflicts[0].winning_data.includes(KEY_B), false, "the key appears nowhere in the stored row");

    const notices = await holdNoticeRows(b.db);
    assert.equal(notices.length, 1, "one bell item, not one per entry");
    assert.match(notices[0].title, /OpenAI: another device wants to change its address/,
      "the notice names the provider");
    assert.equal(notices[0].action_url, "/dashboard/settings?section=sync-conflicts",
      "it links to the conflict review");
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

test("endpoint hold: a newer address from the same peer REPLACES the held one — still one conflict", async () => {
  const { a, b, feedAtoB } = await keyedProviderOnBoth("hold-replace");
  try {
    await repointOnA(a, URL_NEW);
    await b.mgr._processNewEntries(A_ID, feedAtoB);
    await repointOnA(a, URL_NEWER);
    await b.mgr._processNewEntries(A_ID, feedAtoB);

    assert.equal((await b.row(HOLD_ID)).base_url, URL_OLD, "B's row is still untouched");
    const conflicts = await providerConflicts(b.db);
    assert.equal(conflicts.length, 1, "a second edit replaces the held version, it does not pile up");
    assert.equal(Number(conflicts[0].resolved), 0);
    assert.equal(JSON.parse(conflicts[0].losing_data).base_url, URL_NEWER,
      "the held version is the NEWEST address");
    assert.equal((await holdNoticeRows(b.db)).length, 1, "and the bell was not rung again");
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

test("endpoint hold: accepting applies the address AND keeps this device's key", async () => {
  const { a, b, feedAtoB } = await keyedProviderOnBoth("hold-accept");
  try {
    await repointOnA(a, URL_NEW);
    await b.mgr._processNewEntries(A_ID, feedAtoB);
    const [conflict] = await providerConflicts(b.db);

    const { restoreConflict } = await import("../servers/sharing/sync-conflict-resolve.js");
    const outcome = await restoreConflict(b.db, conflict.id, { instanceSync: b.mgr });
    assert.equal(outcome.status, "applied", "the held version can be applied from the review page");

    const live = await b.row(HOLD_ID);
    assert.equal(live.base_url, URL_NEW, "the accepted address is now used here");
    assert.equal(live.api_key, KEY_B, "and it is B's own key that now goes there — the operator's informed choice");
    assert.equal(Number((await providerConflicts(b.db))[0].resolved), 1, "the conflict is closed");
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

test("endpoint hold: dismissing keeps the address, and a re-delivery of the same entry raises nothing", async () => {
  const { a, b, feedAtoB } = await keyedProviderOnBoth("hold-dismiss");
  try {
    await repointOnA(a, URL_NEW);
    await b.mgr._processNewEntries(A_ID, feedAtoB);
    const [conflict] = await providerConflicts(b.db);

    const { resolveConflict } = await import("../servers/sharing/sync-conflict-resolve.js");
    await resolveConflict(b.db, conflict.id);
    assert.equal((await b.row(HOLD_ID)).base_url, URL_OLD, "keeping the current version keeps the address");

    // Re-deliver the SAME feed entry (fresh checkpoints, real apply path).
    await b.mgr._setLastAppliedSeq(A_ID, 0, null);
    await b.mgr._processNewEntries(A_ID, feedAtoB);

    assert.equal((await b.row(HOLD_ID)).base_url, URL_OLD, "still the local address");
    const after = await providerConflicts(b.db);
    assert.equal(after.length, 1, "a re-delivery does not stack a second conflict on top of the dismissed one");
    assert.equal(Number(after[0].resolved), 1, "the dismissal stands");
    assert.equal((await holdNoticeRows(b.db)).length, 1, "and the bell does not ring again");
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

test("endpoint hold: the same address change to a row with NO local key applies directly, with no conflict", async () => {
  const a = freshInstance("hold-keyless-a", A_ID);
  const b = freshInstance("hold-keyless-b", B_ID);
  const feedAtoB = a.peerFeed(B_ID);
  b.peerFeed(A_ID);
  try {
    // A llama.cpp on the tailnet (100.64.0.0/10, keyless like a LAN box): no key
    // on either side (the ruling's keyless case).
    setProviderSyncManager(a.mgr);
    await upsertProvider(a.db, {
      id: "prov-lan", baseUrl: "http://100.64.20.9:8080/v1", host: "cloud",
      providerType: "openai-compat", models: [{ id: "qwen3-4b" }],
    });
    await b.mgr._processNewEntries(A_ID, feedAtoB);

    const panel = (await listProvidersAll(a.db)).find((p) => p.id === "prov-lan");
    await upsertProvider(a.db, { ...panel, baseUrl: "http://100.64.20.10:8080/v1" });
    await b.mgr._processNewEntries(A_ID, feedAtoB);

    assert.equal((await b.row("prov-lan")).base_url, "http://100.64.20.10:8080/v1",
      "a keyless row updates freely — the hold protects a key, and there is none here");
    assert.equal((await providerConflicts(b.db, "prov-lan")).length, 0, "and it records no conflict");
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

test("endpoint hold: a models-only change to a keyed row applies directly, as before", async () => {
  const { a, b, feedAtoB } = await keyedProviderOnBoth("hold-models");
  try {
    setProviderSyncManager(a.mgr);
    const panel = (await listProvidersAll(a.db)).find((p) => p.id === HOLD_ID);
    await upsertProvider(a.db, { ...panel, models: MODELS_2 });
    await b.mgr._processNewEntries(A_ID, feedAtoB);

    const live = await b.row(HOLD_ID);
    assert.deepEqual(JSON.parse(live.models), MODELS_2, "the models edit still propagates");
    assert.equal(live.base_url, URL_OLD);
    assert.equal(live.api_key, KEY_B);
    assert.equal((await providerConflicts(b.db)).length, 0, "no endpoint moved, so nothing is held");
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

test("endpoint hold: a trailing-slash-only difference is not an endpoint change", async () => {
  const { a, b, feedAtoB } = await keyedProviderOnBoth("hold-slash");
  try {
    await repointOnA(a, `${URL_OLD}/`);
    await b.mgr._processNewEntries(A_ID, feedAtoB);

    const live = await b.row(HOLD_ID);
    assert.equal(live.base_url, `${URL_OLD}/`, "the row applies as any non-endpoint edit would");
    assert.equal(live.api_key, KEY_B);
    assert.equal((await providerConflicts(b.db)).length, 0,
      "`…/v1` and `…/v1/` are the same endpoint — nothing to hold");
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

test("endpoint hold: an INSERT that collides with a keyed local row and carries another URL is held", async () => {
  const b = freshInstance("hold-insert", B_ID);
  try {
    await b.db.execute({
      sql: "INSERT INTO providers (id, base_url, models, provider_type, api_key, lamport_ts, instance_id) VALUES (?, ?, ?, ?, ?, 100, ?)",
      args: [HOLD_ID, URL_OLD, JSON.stringify(MODELS_1), "openai", KEY_B, B_ID],
    });
    // A peer that never saw this row sends its own copy as an insert (the
    // new-pairing backfill does exactly this) — at a URL of its choosing.
    const entry = signedEntry({
      op: "insert",
      lamport_ts: 900,
      instance_id: A_ID,
      row: {
        id: HOLD_ID, base_url: URL_NEW, models: JSON.stringify(MODELS_1),
        provider_type: "openai", instance_id: A_ID,
      },
    });
    await b.mgr._processNewEntries(A_ID, stubFeed([entry]));

    const live = await b.row(HOLD_ID);
    assert.equal(live.base_url, URL_OLD, "the colliding insert is held, not applied");
    assert.equal(live.api_key, KEY_B);
    const conflicts = await providerConflicts(b.db);
    assert.equal(conflicts.length, 1, "the held insert is recorded");
    assert.equal(conflicts[0].op, "update", "recorded as a proposed update so it CAN be accepted");
    assert.equal(JSON.parse(conflicts[0].losing_data).base_url, URL_NEW);
    assert.equal((await holdNoticeRows(b.db)).length, 1, "one bell item, by name");
  } finally {
    await b.close();
  }
});

test("sync-conflicts page: a held providers conflict shows the address change, escaped", async () => {
  const inst = freshInstance("hold-ui", B_ID);
  try {
    const winning = JSON.stringify({ id: HOLD_ID, base_url: URL_OLD, api_key: KEY_B });
    // A value that is not a URL at all: rendered as written, so the line MUST escape it.
    const hostile = 'evil<scr';
    const losing = JSON.stringify({ id: HOLD_ID, base_url: hostile });
    await inst.db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, resolved, op)
            VALUES ('providers', ?, ?, ?, 2, 3, ?, ?, 0, 'update')`,
      args: [HOLD_ID, B_ID, A_ID, winning, losing],
    });
    // A providers conflict that did NOT move the address, and a memories conflict:
    // neither may grow an address-change line.
    await inst.db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, resolved, op)
            VALUES ('providers', 'prov-models-only', ?, ?, 2, 3, ?, ?, 0, 'update')`,
      args: [B_ID, A_ID,
        JSON.stringify({ id: "prov-models-only", base_url: URL_OLD, models: "[]" }),
        JSON.stringify({ id: "prov-models-only", base_url: URL_OLD, models: "[1]" })],
    });
    await inst.db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, resolved, op)
            VALUES ('memories', '7', ?, ?, 2, 3, ?, ?, 0, 'update')`,
      args: [B_ID, A_ID,
        JSON.stringify({ id: 7, content: "a" }), JSON.stringify({ id: 7, content: "b" })],
    });
    // A PATH-only move counts as an endpoint change (spec) and must still read
    // honestly: both origins are the same host, so the line shows the addresses.
    await inst.db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, resolved, op)
            VALUES ('providers', 'prov-path-only', ?, ?, 2, 3, ?, ?, 0, 'update')`,
      args: [B_ID, A_ID,
        JSON.stringify({ id: "prov-path-only", base_url: "https://api.openai.com/v1" }),
        JSON.stringify({ id: "prov-path-only", base_url: "https://api.openai.com/v2" })],
    });

    const { default: section } = await import("../servers/gateway/dashboard/settings/sections/sync-conflicts.js");
    const html = await section.render({ req: { csrfToken: "t", query: {} }, db: inst.db, lang: "en" });

    assert.equal((html.match(/Address change:/g) || []).length, 2,
      "exactly the two moved-address rows carry the line");
    assert.match(html, /Address change: https:\/\/api\.openai\.com → evil&lt;scr\./,
      "old origin → new origin, with the new value escaped");
    assert.ok(!html.includes("evil<scr"), "nothing unescaped reaches the page");
    assert.match(html, /Address change: https:\/\/api\.openai\.com\/v1 → https:\/\/api\.openai\.com\/v2\./,
      "a path-only move shows the addresses, never `https://x → https://x`");
    assert.match(html, /Accepting sends this device's API key to the new address\./,
      "and it says plainly what accepting does with the key");
  } finally {
    await inst.close();
  }
});

/* ═══════════════════════════ 5. "needs a key on this device" ═════════════════ */

const noticeRows = async (db, id) => {
  const { rows } = await db.execute({
    sql: "SELECT id, title, body, action_url, is_read FROM notifications WHERE source = ? ORDER BY id",
    args: [providerKeyNoticeSource(id)],
  });
  return rows;
};

test("providerNeedsKey: a keyed cloud type/preset needs one; a LAN llama.cpp and a tailnet row do not", () => {
  // Cloud preset hosts, whatever the type column says.
  assert.equal(providerNeedsKey({ base_url: "https://api.openai.com/v1", provider_type: null }), true);
  assert.equal(providerNeedsKey({ base_url: "https://api.anthropic.com", provider_type: "anthropic" }), true);
  assert.equal(providerNeedsKey({ base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }), true);
  // Cloud SDK types on an unknown public host: nothing local to reach, so a key.
  assert.equal(providerNeedsKey({ base_url: "https://llm.example.com/v1", provider_type: "openai" }), true);
  // Keyless: a tailnet/CGNAT box (100.64.0.0/10 — the repo's placeholder range),
  // a loopback sidecar, a bare name, a LAN-ish name.
  assert.equal(providerNeedsKey({ base_url: "http://100.64.20.9:8080/v1", provider_type: "openai-compat" }), false);
  assert.equal(providerNeedsKey({ base_url: "http://100.64.20.9:8080/v1", provider_type: "openai" }), false,
    "a tailnet address is keyless whatever the adapter type says");
  assert.equal(providerNeedsKey({ base_url: "http://100.64.20.1:8003/v1" }), false);
  assert.equal(providerNeedsKey({ base_url: "http://127.0.0.1:8011/v1", provider_type: "openai" }), false);
  assert.equal(providerNeedsKey({ base_url: "http://ollama:11434/v1" }), false);
  assert.equal(providerNeedsKey({ base_url: "http://box.local:8000/v1" }), false);
  // The panel shape (provider-row.js) is accepted too.
  assert.equal(providerNeedsKey({ baseUrl: "https://api.openai.com/v1" }), true);
  // No endpoint at all: nothing to key, never nag.
  assert.equal(providerNeedsKey({ base_url: "", provider_type: "openai" }), false);
  assert.equal(providerNeedsKey(null), false);
});

test("'needs a key' notice: raised ONCE by name for a keyed row, not for a keyless one, and quieted when a key is entered here", async () => {
  const a = freshInstance("notice-a", A_ID);
  const b = freshInstance("notice-b", B_ID);
  const feedAtoB = a.peerFeed(B_ID);

  try {
    setProviderSyncManager(a.mgr);
    await upsertProvider(a.db, { id: "prov-keyed", ...CLOUD, models: MODELS_1, apiKey: KEY_A });
    await upsertProvider(a.db, {
      id: "prov-lan-llama", baseUrl: "http://100.64.20.9:8080/v1", host: "cloud",
      providerType: "openai-compat", models: [{ id: "qwen3-4b" }],
    });
    assert.equal(feedAtoB.entries.length, 2, "both rows sync — the keyless one included");

    await b.mgr._processNewEntries(A_ID, feedAtoB);

    // The keyed row: exactly ONE notice, by name, linking to the providers tab.
    let keyed = await noticeRows(b.db, "prov-keyed");
    assert.equal(keyed.length, 1, "one notice per provider id");
    assert.match(keyed[0].title, /OpenAI needs an API key on this device/);
    assert.equal(keyed[0].action_url, "/dashboard/settings?section=llm&tab=providers");
    assert.equal(Number(keyed[0].is_read), 0);

    // The keyless local model server: never nagged.
    assert.equal((await noticeRows(b.db, "prov-lan-llama")).length, 0,
      "a keyless provider (llama.cpp on the LAN) is not nagged");

    // A re-delivery (A edits the models) does not raise a second one.
    setProviderSyncManager(a.mgr);
    const aPanel = (await listProvidersAll(a.db)).find((p) => p.id === "prov-keyed");
    await upsertProvider(a.db, { ...aPanel, models: MODELS_2 });
    await b.mgr._processNewEntries(A_ID, feedAtoB);
    keyed = await noticeRows(b.db, "prov-keyed");
    assert.equal(keyed.length, 1, "still ONE notice after a re-delivery");
    assert.equal(await noticeProviderKeyNeeded(b.db, "prov-keyed"), "already",
      "an open notice is the marker — asking again is a no-op");

    // The operator enters a key HERE: the notice is answered, and never returns.
    setProviderSyncManager(b.mgr);
    const bPanel = (await listProvidersAll(b.db)).find((p) => p.id === "prov-keyed");
    await upsertProvider(b.db, { ...bPanel, apiKey: KEY_B });
    keyed = await noticeRows(b.db, "prov-keyed");
    assert.equal(Number(keyed[0].is_read), 1, "entering a key here quiets the notice");

    setProviderSyncManager(a.mgr);
    const again = (await listProvidersAll(a.db)).find((p) => p.id === "prov-keyed");
    await upsertProvider(a.db, { ...again, models: [{ id: "gpt-4o" }] });
    await b.mgr._processNewEntries(A_ID, feedAtoB);
    keyed = await noticeRows(b.db, "prov-keyed");
    assert.equal(keyed.length, 1, "no new notice once a key is held here");
    assert.equal((await b.row("prov-keyed")).api_key, KEY_B);

    // A provider created LOCALLY with no key is never announced: the notice is
    // about a key that could not travel, not about the operator's own form.
    setProviderSyncManager(b.mgr);
    await upsertProvider(b.db, { id: "prov-local-own", ...CLOUD, models: MODELS_1 });
    assert.equal((await noticeRows(b.db, "prov-local-own")).length, 0,
      "a locally created provider is never nagged");
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

/* ═══════════ 6. fix round 2 — no conflict snapshot ever holds a key ══════════ */

/** Every stored snapshot of one providers row, parsed. */
async function conflictSnapshots(db, rowId) {
  const rows = await providerConflicts(db, rowId);
  return rows.map((r) => ({
    ...r,
    winning: r.winning_data ? JSON.parse(r.winning_data) : null,
    losing: r.losing_data ? JSON.parse(r.losing_data) : null,
  }));
}

test("conflict snapshot: an ordinary Lamport conflict on a keyed provider stores NO key in winning_data or losing_data", async () => {
  const b = freshInstance("lamport-conflict", B_ID);
  try {
    await b.db.execute({
      sql: "INSERT INTO providers (id, base_url, models, provider_type, api_key, lamport_ts, instance_id) VALUES (?, ?, ?, ?, ?, 900, ?)",
      args: ["prov-lamport", CLOUD.baseUrl, JSON.stringify(MODELS_2), "openai", KEY_B, B_ID],
    });
    // Same address (so the endpoint hold is not what is under test), an OLDER
    // lamport and different content: the ordinary LWW conflict path — the local
    // row wins and both versions are recorded for review. The peer's row is one
    // an OLD peer would send (it still carries its own key).
    const entry = signedEntry({
      op: "update",
      lamport_ts: 500,
      instance_id: A_ID,
      row: {
        id: "prov-lamport", base_url: CLOUD.baseUrl, models: JSON.stringify(MODELS_1),
        provider_type: "openai", api_key: "sk-leaked-by-old-peer",
      },
    });
    await b.mgr._processNewEntries(A_ID, stubFeed([entry]));

    const live = await b.row("prov-lamport");
    assert.equal(live.api_key, KEY_B, "the local version wins, key untouched");
    assert.deepEqual(JSON.parse(live.models), MODELS_2);

    const [conflict, ...rest] = await conflictSnapshots(b.db, "prov-lamport");
    assert.equal(rest.length, 0);
    assert.ok(conflict, "the stale edit is recorded for review");
    for (const side of ["winning", "losing"]) {
      const snapshot = conflict[side];
      assert.equal(Object.hasOwn(snapshot, "api_key"), false,
        `${side}_data must not carry an api_key column`);
      assert.equal(conflict[`${side}_data`].includes(KEY_B), false,
        `${side}_data holds no key from this device`);
      assert.equal(conflict[`${side}_data`].includes("sk-leaked-by-old-peer"), false,
        `${side}_data holds no key from the peer`);
    }
    assert.deepEqual(conflict.losing.models, JSON.stringify(MODELS_1),
      "the losing content is still recorded in full — only the key is gone");
    assert.equal(conflict.winning.base_url, CLOUD.baseUrl);
  } finally {
    await b.close();
  }
});

test("conflict restore: the stale re-snapshot writes winning_data with no key either", async () => {
  const b = freshInstance("stale-resnapshot", B_ID);
  try {
    await b.db.execute({
      sql: "INSERT INTO providers (id, base_url, models, provider_type, api_key, lamport_ts, instance_id) VALUES (?, ?, ?, ?, ?, 100, ?)",
      args: ["prov-stale", CLOUD.baseUrl, JSON.stringify(MODELS_2), "openai", KEY_B, B_ID],
    });
    const live = await b.row("prov-stale");
    // A conflict recorded when the local row still had MODELS_1 (key included, as
    // the pre-fix code did). The live row has moved on, so the restore's stale
    // guard fires and RE-SNAPSHOTS winning_data from the live row.
    await b.db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
            VALUES ('providers', 'prov-stale', ?, ?, 100, 90, ?, ?, 'update')`,
      args: [B_ID, A_ID,
        JSON.stringify({ ...live, models: JSON.stringify(MODELS_1) }),
        JSON.stringify({ id: "prov-stale", base_url: CLOUD.baseUrl, models: JSON.stringify(MODELS_2) })],
    });
    const { rows } = await b.db.execute("SELECT id FROM sync_conflicts WHERE row_id = 'prov-stale'");
    const { restoreConflict } = await import("../servers/sharing/sync-conflict-resolve.js");
    const outcome = await restoreConflict(b.db, rows[0].id, { instanceSync: null });
    assert.equal(outcome.status, "stale", "the guard fired: the snapshot was refreshed, nothing applied");

    const { rows: after } = await b.db.execute({
      sql: "SELECT winning_data FROM sync_conflicts WHERE id = ?",
      args: [rows[0].id],
    });
    const resnapshot = JSON.parse(after[0].winning_data);
    assert.deepEqual(resnapshot.models, JSON.stringify(MODELS_2), "winning_data is the current live row");
    assert.equal(Object.hasOwn(resnapshot, "api_key"), false,
      "the re-snapshot is a raw SELECT * — the key must not be stored in it");
    assert.equal(after[0].winning_data.includes(KEY_B), false, "the key appears nowhere in the row");
  } finally {
    await b.close();
  }
});

test("boot redaction: old conflict rows lose their keys, is idempotent, and leaves non-provider rows untouched", async () => {
  const b = freshInstance("redact", B_ID);
  try {
    // A pre-fix providers conflict: winning_data holds THIS device's key,
    // losing_data an old peer's. Plus a memories conflict, which must not move.
    const winning = JSON.stringify({
      id: "prov-old", base_url: CLOUD.baseUrl, models: JSON.stringify(MODELS_1),
      provider_type: "openai", api_key: KEY_B, lamport_ts: 100, instance_id: B_ID,
    });
    const losing = JSON.stringify({
      id: "prov-old", base_url: URL_NEW, models: JSON.stringify(MODELS_2),
      provider_type: "openai", api_key: "sk-leaked-by-old-peer",
    });
    await b.db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
            VALUES ('providers', 'prov-old', ?, ?, 100, 90, ?, ?, 'update')`,
      args: [B_ID, A_ID, winning, losing],
    });
    const memoriesWinning = JSON.stringify({ id: 7, content: "a", api_key: "not-a-providers-row" });
    const memoriesLosing = JSON.stringify({ id: 7, content: "b" });
    await b.db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
            VALUES ('memories', '7', ?, ?, 2, 3, ?, ?, 'update')`,
      args: [B_ID, A_ID, memoriesWinning, memoriesLosing],
    });

    const { redactConflictSnapshots, redactConflictSnapshotsAtBoot } =
      await import("../servers/sharing/sync-conflict-redact.js");
    const lines = [];
    assert.equal(await redactConflictSnapshotsAtBoot(b.db, { log: (m) => lines.push(m) }), 1,
      "exactly one providers row needed redacting");
    assert.equal(lines.length, 1, "one log line");
    assert.match(lines[0], /1 stored conflict snapshot row\(s\) rewritten/);

    const [redacted] = await conflictSnapshots(b.db, "prov-old");
    assert.equal(Object.hasOwn(redacted.winning, "api_key"), false);
    assert.equal(Object.hasOwn(redacted.losing, "api_key"), false);
    assert.equal(redacted.winning_data.includes(KEY_B), false, "this device's key is gone");
    assert.equal(redacted.losing_data.includes("sk-leaked-by-old-peer"), false, "the peer's key is gone");
    assert.equal(redacted.winning.base_url, CLOUD.baseUrl, "everything else is preserved");
    assert.equal(redacted.losing.base_url, URL_NEW);
    assert.equal(Number(redacted.resolved), 0, "the row is not resolved, not deleted: the operator still reviews it");

    const { rows: memoriesAfter } = await b.db.execute(
      "SELECT winning_data, losing_data FROM sync_conflicts WHERE table_name = 'memories'");
    assert.equal(memoriesAfter.length, 1, "the non-provider conflict row is still there");
    assert.equal(memoriesAfter[0].winning_data, memoriesWinning, "byte-identical: other tables are not rewritten");
    assert.equal(memoriesAfter[0].losing_data, memoriesLosing, "byte-identical");

    // Second run: nothing left to do, nothing re-written.
    assert.equal(await redactConflictSnapshots(b.db), 0, "idempotent");
    const [again] = await conflictSnapshots(b.db, "prov-old");
    assert.equal(again.winning_data, redacted.winning_data, "the snapshot is untouched by a second run");
    assert.equal(again.losing_data, redacted.losing_data);
  } finally {
    await b.close();
  }
});

/* ═════════ 7. fix round 2 — "needs a key" rings once, not once per state ════ */

test("'needs a key' notice: a read or a dismissed notice is still an answer — a re-delivery does not ring again", async () => {
  const a = freshInstance("notice-once-a", A_ID);
  const b = freshInstance("notice-once-b", B_ID);
  const feedAtoB = a.peerFeed(B_ID);
  try {
    setProviderSyncManager(a.mgr);
    await upsertProvider(a.db, { id: "prov-read", ...CLOUD, models: MODELS_1, apiKey: KEY_A });
    await upsertProvider(a.db, { id: "prov-dismissed", ...CLOUD, models: MODELS_1, apiKey: KEY_A });
    await b.mgr._processNewEntries(A_ID, feedAtoB);
    assert.equal((await noticeRows(b.db, "prov-read")).length, 1);
    assert.equal((await noticeRows(b.db, "prov-dismissed")).length, 1);

    // The operator reads one and dismisses the other. Both are answers to the
    // only question the notice asks.
    await b.db.execute({
      sql: "UPDATE notifications SET is_read = 1 WHERE source = ?",
      args: [providerKeyNoticeSource("prov-read")],
    });
    await b.db.execute({
      sql: "UPDATE notifications SET is_dismissed = 1 WHERE source = ?",
      args: [providerKeyNoticeSource("prov-dismissed")],
    });

    // A re-delivery (A edits the models on both rows) must not ring again.
    setProviderSyncManager(a.mgr);
    for (const id of ["prov-read", "prov-dismissed"]) {
      const panel = (await listProvidersAll(a.db)).find((p) => p.id === id);
      await upsertProvider(a.db, { ...panel, models: MODELS_2 });
    }
    await b.mgr._processNewEntries(A_ID, feedAtoB);

    assert.equal((await noticeRows(b.db, "prov-read")).length, 1, "still ONE notice after a read");
    assert.equal((await noticeRows(b.db, "prov-dismissed")).length, 1, "still ONE after a dismissal");
    assert.equal(await noticeProviderKeyNeeded(b.db, "prov-read"), "already");
    assert.equal(await noticeProviderKeyNeeded(b.db, "prov-dismissed"), "already");
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

test("'needs a key' notice: it re-arms only after the operator enters a key and that key is later removed", async () => {
  const b = freshInstance("notice-rearm", B_ID);
  try {
    await b.db.execute({
      sql: "INSERT INTO providers (id, base_url, models, provider_type, api_key, lamport_ts, instance_id) VALUES (?, ?, ?, ?, NULL, 10, ?)",
      args: ["prov-rearm", CLOUD.baseUrl, JSON.stringify(MODELS_1), "openai", A_ID],
    });
    assert.equal(await noticeProviderKeyNeeded(b.db, "prov-rearm"), "raised");
    assert.equal(await noticeProviderKeyNeeded(b.db, "prov-rearm"), "already");

    // The operator enters a key HERE (the local write path clears the notice).
    setProviderSyncManager(b.mgr);
    const panel = (await listProvidersAll(b.db)).find((p) => p.id === "prov-rearm");
    await upsertProvider(b.db, { ...panel, apiKey: KEY_B });
    assert.equal(await noticeProviderKeyNeeded(b.db, "prov-rearm"), "has-key");

    // …and that key is later removed on this box.
    await b.db.execute({ sql: "UPDATE providers SET api_key = NULL WHERE id = ?", args: ["prov-rearm"] });
    assert.equal(await noticeProviderKeyNeeded(b.db, "prov-rearm"), "raised",
      "a later loss of the key may ring once more");
    assert.equal(await noticeProviderKeyNeeded(b.db, "prov-rearm"), "already", "…and only once");
    assert.equal((await noticeRows(b.db, "prov-rearm")).length, 2, "one notice per key episode, never more");
  } finally {
    setProviderSyncManager(null);
    await b.close();
  }
});

/* ═══════ 8. fix round 2 — the endpoint hold, reverse direction (B → A) ═══════ */

/** B repoints the provider — the reverse of repointOnA. */
async function repointOnB(b, url) {
  setProviderSyncManager(b.mgr);
  const panel = (await listProvidersAll(b.db)).find((p) => p.id === HOLD_ID);
  await upsertProvider(b.db, { ...panel, baseUrl: url });
}

/**
 * The mirror of keyedProviderOnBoth: B creates the provider (keyless), A applies
 * it, then A enters its OWN key — the key lives on A, and B is about to want the
 * address moved.
 */
async function keyedProviderOnA(label) {
  const a = freshInstance(`${label}-a`, A_ID);
  const b = freshInstance(`${label}-b`, B_ID);
  const feedAtoB = a.peerFeed(B_ID);
  const feedBtoA = b.peerFeed(A_ID);

  setProviderSyncManager(b.mgr);
  await upsertProvider(b.db, { id: HOLD_ID, ...CLOUD, models: MODELS_1 });
  await a.mgr._processNewEntries(B_ID, feedBtoA);

  setProviderSyncManager(a.mgr);
  const aPanel = (await listProvidersAll(a.db)).find((p) => p.id === HOLD_ID);
  await upsertProvider(a.db, { ...aPanel, apiKey: KEY_A });
  await b.mgr._processNewEntries(A_ID, feedAtoB);
  return { a, b, feedBtoA };
}

test("endpoint hold, reverse: B moves the address while A holds the key — held on A, no key in either snapshot", async () => {
  const { a, b, feedBtoA } = await keyedProviderOnA("hold-reverse");
  try {
    assert.equal((await a.row(HOLD_ID)).base_url, URL_OLD, "both boxes start on the same address");
    assert.equal((await a.row(HOLD_ID)).api_key, KEY_A, "A holds the key on this device");

    await repointOnB(b, URL_NEW);
    await a.mgr._processNewEntries(B_ID, feedBtoA);

    const live = await a.row(HOLD_ID);
    assert.equal(live.base_url, URL_OLD, "A's row is NOT repointed — B's change is held");
    assert.equal(live.api_key, KEY_A, "and the key stays where it was entered");

    const conflicts = await providerConflicts(a.db);
    assert.equal(conflicts.length, 1, "exactly one conflict records the held change");
    assert.equal(Number(conflicts[0].resolved), 0, "it is unresolved: it waits for the operator");
    assert.equal(conflicts[0].op, "update", "it reads as a proposed update (Restore is available)");
    const losing = JSON.parse(conflicts[0].losing_data);
    assert.equal(losing.base_url, URL_NEW, "the held version carries the peer's new address");
    assert.equal(Object.hasOwn(losing, "api_key"), false, "never a key in the held snapshot");
    const winning = JSON.parse(conflicts[0].winning_data);
    assert.equal(winning.base_url, URL_OLD, "the kept version is this device's row");
    assert.equal(Object.hasOwn(winning, "api_key"), false, "never this device's key in the kept snapshot");
    assert.equal(conflicts[0].winning_data.includes(KEY_A), false, "the key appears nowhere in the stored row");

    const notices = await holdNoticeRows(a.db);
    assert.equal(notices.length, 1, "one bell item, not one per entry");
    assert.match(notices[0].title, /OpenAI: another device wants to change its address/,
      "the notice names the provider");
    assert.equal(notices[0].action_url, "/dashboard/settings?section=sync-conflicts",
      "it links to the conflict review");
  } finally {
    setProviderSyncManager(null);
    await a.close();
    await b.close();
  }
});

/* ═══ 9. fix round 2 — the held-address bell is per held CONFLICT, not per state ══ */

test("endpoint hold notice: one per OPEN held conflict — read or dismissed is not re-raised, a NEW conflict is", async () => {
  const b = freshInstance("hold-notice-once", B_ID);
  try {
    await b.db.execute({
      sql: "INSERT INTO providers (id, base_url, models, provider_type, api_key, lamport_ts, instance_id) VALUES (?, ?, ?, ?, ?, 100, ?)",
      args: [HOLD_ID, URL_OLD, JSON.stringify(MODELS_1), "openai", KEY_B, B_ID],
    });
    const live = await b.row(HOLD_ID);
    const { noticeProviderEndpointHeld, clearProviderEndpointHeldNotice } =
      await import("../servers/shared/provider-endpoint.js");
    const insertConflict = async (winTs, loseTs) => {
      await b.db.execute({
        sql: `INSERT INTO sync_conflicts
                (table_name, row_id, winning_instance_id, losing_instance_id,
                 winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
              VALUES ('providers', ?, ?, ?, ?, ?, ?, ?, 'update')`,
        args: [HOLD_ID, B_ID, A_ID, winTs, loseTs,
          JSON.stringify({ id: HOLD_ID, base_url: URL_OLD }),
          JSON.stringify({ id: HOLD_ID, base_url: URL_NEW })],
      });
      const { rows } = await b.db.execute("SELECT id FROM sync_conflicts ORDER BY id DESC LIMIT 1");
      return rows[0].id;
    };

    const first = await insertConflict(100, 90);
    assert.equal(await noticeProviderEndpointHeld(b.db, live, first), "raised");
    assert.equal(await noticeProviderEndpointHeld(b.db, live, first), "already",
      "the same open conflict never rings twice");

    // Read, then dismissed: either way the operator has SEEN this conflict, and a
    // newer held edit replacing it (same conflict row) must not ring again.
    await b.db.execute({
      sql: "UPDATE notifications SET is_read = 1 WHERE source = ?",
      args: [endpointHoldNoticeSource(HOLD_ID)],
    });
    assert.equal(await noticeProviderEndpointHeld(b.db, live, first), "already",
      "a read notice still answered THIS conflict");
    await b.db.execute({
      sql: "UPDATE notifications SET is_read = 0, is_dismissed = 1 WHERE source = ?",
      args: [endpointHoldNoticeSource(HOLD_ID)],
    });
    assert.equal(await noticeProviderEndpointHeld(b.db, live, first), "already",
      "a dismissed notice still answered THIS conflict");
    assert.equal((await holdNoticeRows(b.db)).length, 1, "still exactly one bell item");

    // The conflict is decided, and a NEW held change makes a NEW conflict row:
    // that one may ring again.
    await b.db.execute({ sql: "UPDATE sync_conflicts SET resolved = 1 WHERE id = ?", args: [first] });
    await clearProviderEndpointHeldNotice(b.db, HOLD_ID);
    const second = await insertConflict(200, 150);
    assert.equal(await noticeProviderEndpointHeld(b.db, live, second), "raised",
      "a new held conflict rings once more");
    assert.equal((await holdNoticeRows(b.db)).length, 2, "one per held conflict, not one per provider id");
  } finally {
    await b.close();
  }
});

/* ══ 10. fix round 3 — the READ doors strip old rows, and the repair's write ══ */

const OLD_KEY_WIN = "sk-still-in-an-old-row";
const OLD_KEY_LOSE = "sk-leaked-by-old-peer";
const OLD_ID = "prov-legacy";

/** Seed a pre-fix providers conflict: BOTH snapshots still carry an api_key. */
async function seedOldProviderConflict(db, { rowId = OLD_ID, winning, losing, resolved = 0 } = {}) {
  await db.execute({
    sql: `INSERT INTO sync_conflicts
            (table_name, row_id, winning_instance_id, losing_instance_id,
             winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, resolved, op)
          VALUES ('providers', ?, ?, ?, 100, 90, ?, ?, ?, 'update')`,
    args: [rowId, B_ID, A_ID,
      winning ?? JSON.stringify({
        id: rowId, base_url: CLOUD.baseUrl, models: JSON.stringify(MODELS_1), api_key: OLD_KEY_WIN,
      }),
      losing ?? JSON.stringify({
        id: rowId, base_url: URL_NEW, models: JSON.stringify(MODELS_2), api_key: OLD_KEY_LOSE,
      }),
      resolved],
  });
  const { rows } = await db.execute({
    sql: "SELECT * FROM sync_conflicts WHERE row_id = ? ORDER BY id DESC LIMIT 1",
    args: [rowId],
  });
  return rows[0];
}

/** The registered crow_list_sync_conflicts handler, without spinning an MCP server. */
async function listConflictsHandler(db) {
  const handlers = {};
  const { registerInstancesTools } = await import("../servers/sharing/tools/instances.js");
  registerInstancesTools({ tool: (name, _desc, _schema, fn) => { handlers[name] = fn; } }, { db });
  return handlers["crow_list_sync_conflicts"];
}

const conflictPageHtml = async (db) => {
  const section = (await import(
    "../servers/gateway/dashboard/settings/sections/sync-conflicts.js"
  )).default;
  return section.render({ req: { csrfToken: "test-csrf", query: {} }, db, lang: "en" });
};

test("read door: crow_list_sync_conflicts strips an old providers row's key — a stdio-only install never runs the boot repair", async () => {
  const b = freshInstance("read-tool", B_ID);
  try {
    await seedOldProviderConflict(b.db);
    const list = await listConflictsHandler(b.db);
    // Called directly, so zod's defaults are not applied — pass them.
    const res = await list({ unresolved_only: false, limit: 20 });
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /providers/, "the conflict is still listed");
    assert.match(text, /api\.openai\.com/, "and the rest of the snapshot is still shown");
    for (const key of [OLD_KEY_WIN, OLD_KEY_LOSE]) {
      assert.equal(text.includes(key), false, `the key is not returned: ${key}`);
    }
    assert.equal(text.includes("api_key"), false, "the field is gone, not just the value");
  } finally {
    await b.close();
  }
});

test("read door: the sync-conflicts page shows no key from an old providers row", async () => {
  const b = freshInstance("read-page", B_ID);
  try {
    await seedOldProviderConflict(b.db);
    const html = await conflictPageHtml(b.db);
    assert.match(html, /api\.openai\.com/, "the conflict is still rendered in full otherwise");
    for (const key of [OLD_KEY_WIN, OLD_KEY_LOSE]) {
      assert.equal(html.includes(key), false, `the page must not print the key: ${key}`);
    }
    assert.equal(html.includes("api_key"), false, "the field is gone, not just the value");
  } finally {
    await b.close();
  }
});

test("read doors: a 'null' snapshot shows nothing and never throws", async () => {
  const b = freshInstance("read-null", B_ID);
  try {
    await seedOldProviderConflict(b.db, {
      rowId: "prov-null-win",
      winning: "null",
      losing: JSON.stringify({ id: "prov-null-win", base_url: URL_NEW }),
    });
    await seedOldProviderConflict(b.db, {
      rowId: "prov-null-lose",
      winning: JSON.stringify({ id: "prov-null-lose", base_url: CLOUD.baseUrl }),
      losing: "null",
    });

    const list = await listConflictsHandler(b.db);
    const res = await list({ unresolved_only: false, limit: 20 });
    assert.equal(res.isError, undefined, "no throw on a 'null' snapshot");
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /prov-null-win/, "the row is still listed");
    assert.match(text, /\(none\)/, "the null side shows nothing");

    const html = await conflictPageHtml(b.db);
    assert.match(html, /prov-null-win/, "the row still renders on the page");
    assert.match(html, /\(none\)/, "and the null side renders as (none)");
  } finally {
    await b.close();
  }
});

test("boot redaction: a snapshot that changed after the read is never overwritten by the stale redaction", async () => {
  const b = freshInstance("redact-race", B_ID);
  try {
    const read = await seedOldProviderConflict(b.db, { rowId: "prov-race" });
    // Between the repair's read and its write, a newer snapshot lands on the row
    // (a peer's entry applied, a restore's re-snapshot): keyless, new address.
    const newer = JSON.stringify({ id: "prov-race", base_url: URL_NEWER, models: JSON.stringify(MODELS_2) });
    await b.db.execute({
      sql: "UPDATE sync_conflicts SET winning_data = ? WHERE id = ?",
      args: [newer, read.id],
    });

    const { writeBackRedacted, redactConflictSnapshots } =
      await import("../servers/sharing/sync-conflict-redact.js");
    const wrote = await writeBackRedacted(b.db, read.id, {
      winning: stripConflictSnapshot("providers", read.winning_data),
      losing: stripConflictSnapshot("providers", read.losing_data),
      expectedWinning: read.winning_data,
      expectedLosing: read.losing_data,
    });
    assert.equal(wrote, false, "the conditional UPDATE matched no row, so nothing was written");

    const { rows: after } = await b.db.execute({
      sql: "SELECT winning_data, losing_data FROM sync_conflicts WHERE id = ?",
      args: [read.id],
    });
    assert.equal(after[0].winning_data, newer, "the newer snapshot survives");
    assert.equal(after[0].losing_data, read.losing_data, "the side that did not move is unchanged too");

    // The full repair still redacts what is left on the NEXT run — the guard
    // skipped a stale write, it did not give up on the row.
    assert.equal(await redactConflictSnapshots(b.db), 1, "the remaining snapshot is redacted next run");
    const { rows: done } = await b.db.execute({
      sql: "SELECT winning_data, losing_data FROM sync_conflicts WHERE id = ?",
      args: [read.id],
    });
    assert.equal(done[0].winning_data, newer, "the newer snapshot is byte-identical");
    assert.equal(done[0].losing_data.includes(OLD_KEY_LOSE), false, "the old side did lose its key");
  } finally {
    await b.close();
  }
});

test("snapshot strip: the identical string comes back when there is nothing to remove", async () => {
  const spaced = '{ "id": "prov-plain", "base_url": "https://api.openai.com/v1" }';
  assert.equal(stripConflictSnapshot("providers", spaced), spaced,
    "byte-identical, not a re-serialization: 'writes only on change' stays strictly true");
  assert.equal(stripConflictSnapshot("providers", "null"), "null", "a JSON null comes back as it went in");
  assert.equal(stripConflictSnapshot("providers", "not json"), "not json", "an unreadable blob is left alone");
  assert.equal(stripConflictSnapshot("memories", spaced), spaced, "a table with no local-only columns is untouched");
  assert.equal(
    stripConflictSnapshot("providers", JSON.stringify({ id: "prov-plain", api_key: "sk-x" })),
    JSON.stringify({ id: "prov-plain" }),
    "and a key IS removed when one is present",
  );
});

test("boot redaction: a keyless providers row is left byte-identical (the SELECT reads only rows that can hold a key)", async () => {
  const b = freshInstance("redact-bound", B_ID);
  try {
    const spaced = '{ "id": "prov-plain", "base_url": "https://api.openai.com/v1", "models": "[]" }';
    await seedOldProviderConflict(b.db, {
      rowId: "prov-plain",
      winning: spaced,
      losing: JSON.stringify({ id: "prov-plain", base_url: URL_NEW }),
    });
    const { redactConflictSnapshots } = await import("../servers/sharing/sync-conflict-redact.js");
    assert.equal(await redactConflictSnapshots(b.db), 0, "nothing to redact");
    const { rows } = await b.db.execute({
      sql: "SELECT winning_data FROM sync_conflicts WHERE row_id = ?",
      args: ["prov-plain"],
    });
    assert.equal(rows[0].winning_data, spaced, "byte-identical: the row was never rewritten");
  } finally {
    await b.close();
  }
});