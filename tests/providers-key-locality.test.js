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
import { InstanceSyncManager, rowsEquivalent } from "../servers/sharing/instance-sync.js";
import { upsertProvider, listProvidersAll, disableProvider, setProviderSyncManager } from "../servers/shared/providers-db.js";
import { emitOrQueue, _setEligibilityForTest } from "../servers/shared/sync-emit.js";
import { drainOnce } from "../servers/sharing/sync-outbox-drain.js";
import {
  providerNeedsKey, providerKeyNoticeSource, noticeProviderKeyNeeded,
} from "../servers/shared/provider-key-need.js";
import { sign } from "../servers/sharing/identity.js";
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
    { id: "lan-llama", base_url: "http://10.0.0.9:8080/v1", api_key: null, host: "cloud", bundle_id: null,
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
  assert.equal(needsKeyLine({ id: "x", baseUrl: "http://10.0.0.9:8080/v1", apiKey: null, instance_id: "peer-instance-id" }, { ownInstanceId: ownId }), "",
    "a keyless provider (llama.cpp on the LAN) is not told to enter a key");
  assert.equal(needsKeyLine({ id: "x", baseUrl: CLOUD.baseUrl, apiKey: "sk-here", instance_id: "peer-instance-id" }, { ownInstanceId: ownId }), "",
    "nothing to say once a key is here");
  // The Spanish line exists (i18n parity is enforced by tests/i18n-global-parity.test.js).
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  assert.notEqual(t("settings.providers.keyStaysLocal", "es"), t("settings.providers.keyStaysLocal", "en"));
  assert.notEqual(t("settings.providers.needsKeyHere", "es"), t("settings.providers.needsKeyHere", "en"));
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
  // Cloud SDK types on an unknown public host.
  assert.equal(providerNeedsKey({ base_url: "https://llm.example.com/v1", provider_type: "openai" }), true);
  // Keyless: a llama.cpp on the LAN, a tailnet box, a loopback sidecar, a bare name.
  assert.equal(providerNeedsKey({ base_url: "http://10.0.0.9:8080/v1", provider_type: "openai-compat" }), false);
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
      id: "prov-lan-llama", baseUrl: "http://10.0.0.9:8080/v1", host: "cloud",
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