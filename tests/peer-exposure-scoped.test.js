/**
 * N1b-8 (security audit): one peer's request must not, with one click, expose a
 * capability to every peer forever.
 *
 * What these tests pin down, against the PRE-FIX code:
 *   - before: the "Allow" card added the capability to `remote_exposed_tools`
 *     (all trusted peers) and nothing was timed, so a second peer was allowed
 *     by the same click and the exposure never expired;
 *   - before: the card had ONE remedy with no peer and no duration
 *     (`args: {capability}`), so there was no way to scope or expire a grant;
 *   - before: every denial became a card (no per-peer cap, no 24 h window) and
 *     a resolved card was simply reopened, so a peer could flood the Nest;
 *   - before: the card carried whatever `requestingInstance` the event payload
 *     had, and the payload was built from `req.instanceAuth` — correct, but
 *     nothing recorded the peer as the identity the grant is keyed by, so the
 *     sentence "this card is for that verified id" was untestable.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  enforcePeerExposure,
  getExposedCapabilities,
  getPeerExposures,
  getPeerGrantedCapabilities,
  isCapabilityExposedToPeer,
  grantPeerCapability,
} from "../servers/gateway/peer-exposure.js";
import { writeSetting } from "../servers/gateway/dashboard/settings/registry.js";
import * as store from "../servers/shared/fix-it/store.js";
import {
  decidePeerExposureCard,
  dedupKeyFor,
  legacyDedupKeyFor,
  MAX_OPEN_CARDS_PER_PEER,
  NEW_CARD_WINDOW_MS,
} from "../servers/gateway/fix-it/peer-card-policy.js";
import {
  getSuppressedRequests,
  recordSuppressedRequest,
  SUPPRESSED_COUNTER_MAX_ENTRIES,
  SUPPRESSED_COUNTER_WINDOW_MS,
} from "../servers/gateway/fix-it/peer-card-counters.js";
import { resolveCalledCanonicalId } from "../servers/gateway/peer-exposure.js";
import { getLocalCapabilityIds } from "../servers/gateway/capability-ids.js";
import { pairingTag } from "../servers/shared/peer-id.js";

let dir, db, idx, remedy, section;

const DAY = 24 * 60 * 60 * 1000;
const CONNECTED = new Map([["funkwhale", { status: "connected", tools: [{ name: "fw_play" }] }]]);
const CALL = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fw_play" } };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "peer-exposure-scoped-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
  idx = await import("../servers/gateway/fix-it/index.js");
  remedy = (await import("../servers/gateway/fix-it/remedies/expose-capability.js")).default;
  section = (await import("../servers/gateway/dashboard/settings/sections/remote-exposure.js")).default;
});
after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });

/** Every piece of state these tests touch, back to a clean slate. */
async function reset() {
  await db.execute("DELETE FROM fix_it_items");
  for (const key of [
    "remote_exposed_tools",
    "remote_exposed_tools_by_peer",
    "peer_exposure_card_suppressed",
  ]) {
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [key] });
    await db.execute({ sql: "DELETE FROM dashboard_settings_overrides WHERE key = ?", args: [key] });
  }
}
beforeEach(reset);

function mkRes() {
  return {
    _status: null, _json: null, headersSent: false,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; this.headersSent = true; return this; },
  };
}

/**
 * A peer request as the gate sees it in production: `instanceAuth.instance` is
 * the row `validateInstanceToken` returned — which matched on `auth_token_hash`,
 * so the VERIFIED instance always carries that hash (fix round 4: the gate reads
 * the pairing tag from it and nowhere else).
 */
const peerReq = (peerId, body = CALL, extra = {}) => ({
  ...extra,
  instanceAuth: { instance: { id: peerId, auth_token_hash: tokenHashFor(peerId) } },
  body,
});

/** The bearer hash this instance would have stored for `id` (any stable string). */
const tokenHashFor = (id) => `test-token-hash-${id}`;

/** The pairing tag the gate computes from that row's hash. */
const tagFor = (id) => pairingTag(tokenHashFor(id));

/** The stored card a denial from `id` under its current pairing produces. */
const cardFor = (id) => ({ context: { requestingInstance: id, pairingTag: tagFor(id) } });

/**
 * Give `ids` a crow_instances row that passes the one trust predicate
 * (`trusted = 1 AND status IN ('active','offline')`). Review round 2 (N-a): the
 * Allow remedy refuses a peer that is not trusted HERE, and in production a card
 * can only be raised by a peer that authenticated — i.e. one that has such a
 * row. Tests that expect a click to grant must say so.
 *
 * Fix round 3: the row carries the bearer HASH too, because a card is bound to
 * the pairing it was raised under (`context.pairingTag`). In production that
 * hash is what `validateInstanceToken` matched the request against; here it is
 * a deterministic stand-in, and `emitDenied` publishes its tag the way the gate
 * does.
 */
async function trustPeer(...ids) {
  for (const id of ids) {
    await db.execute({
      sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status, trusted, auth_token_hash) VALUES (?, ?, ?, 'active', 1, ?)",
      args: [id, `Peer ${id}`, "crow-test", tokenHashFor(id)],
    });
  }
}

/**
 * Publish a denial exactly as the gate does — the verified id AND the tag of the
 * pairing it was verified under. A card raised without a tag can never be
 * allowed (fix round 3), which is why every click-the-card fixture goes through
 * here.
 */
async function emitDenied(peerId, capability, extra = {}) {
  await idx.emitFixIt(db, "peer-exposure:denied", {
    capability, requestingInstance: peerId, pairingTag: tagFor(peerId), ...extra,
  });
}

/** Run the real gate (no exposure overrides) for one peer. */
async function gate(peerId, { now, body = CALL, emit = false } = {}) {
  const res = mkRes();
  const ok = await enforcePeerExposure({
    prefix: "tools",
    req: peerReq(peerId, body),
    res, db, connectedServers: CONNECTED,
    now,
    auditFn: async () => {},
    // Card emission is off unless a test wants the real detector (it is
    // fire-and-forget and would race the assertions).
    emitFn: emit ? undefined : async () => {},
  });
  return { ok, res };
}

/**
 * Run the real gate on the `/router` mount for a PEER-CHOSEN tool name — the
 * attack surface of B2. `emitFn` lets a test collect the (fire-and-forget)
 * emit promises so it can await the detector rather than sleep.
 */
async function gateRouter(peerId, toolName, { emitFn } = {}) {
  const res = mkRes();
  const ok = await enforcePeerExposure({
    prefix: "router",
    req: peerReq(peerId, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName } }),
    res, db, connectedServers: CONNECTED,
    auditFn: async () => {},
    emitFn: emitFn || (async () => {}),
  });
  return { ok, res };
}

/** Collect the real emitFixIt promises the gate fires without awaiting. */
function emitCollector() {
  const pending = [];
  pending.fn = (d, ev, payload) => {
    const p = idx.emitFixIt(d, ev, payload);
    pending.push(p);
    return p;
  };
  pending.settle = () => Promise.all(pending);
  return pending;
}

async function waitForPending(predicate, deadlineMs = 2000) {
  const start = Date.now();
  for (;;) {
    const pending = await store.listPending(db);
    if (predicate(pending)) return pending;
    if (Date.now() - start > deadlineMs) {
      assert.fail(`card did not materialize within ${deadlineMs}ms (saw ${pending.length})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function clickAllow(card, actionId = "expose-capability-30d") {
  let redirected = null;
  await idx.handleFixItAction(
    { body: { action: "remedy", item_id: String(card.id), action_id: actionId } },
    { redirectAfterPost: (u) => { redirected = u; } },
    { db },
  );
  return redirected;
}

// ---------------------------------------------------------------------------
// 1. Allow grants only the requesting peer
// ---------------------------------------------------------------------------

test("Allow grants only the requesting peer: a second peer is still refused", async () => {
  await trustPeer("peer-a");
  // peer-a is denied, a card is raised for it.
  assert.equal((await gate("peer-a")).ok, false);
  await emitDenied("peer-a", "funkwhale", { toolName: "fw_play" });
  const card = (await store.listPending(db))[0];
  assert.equal(card.context.requestingInstance, "peer-a");

  // One click on Allow.
  await clickAllow(card);

  // The peer that asked is now allowed…
  assert.equal((await gate("peer-a")).ok, true);
  // …and every other peer is still refused.
  const other = await gate("peer-b");
  assert.equal(other.ok, false);
  assert.equal(other.res._status, 403);
  assert.equal(other.res._json.error.code, -32001);
  // The grant is per-peer on disk, and the all-peer list is untouched.
  assert.deepEqual([...(await getPeerGrantedCapabilities(db, "peer-a"))], ["funkwhale"]);
  assert.deepEqual([...((await getPeerExposures(db)).keys())], ["peer-a"]);
  assert.equal((await getExposedCapabilities(db)).has("funkwhale"), false);
});

test("per-peer grants are read at check time: revoking one peer's grant re-denies it and nobody else", async () => {
  await grantPeerCapability(db, { peerId: "peer-r", capability: "funkwhale", expiresAt: null });
  assert.equal((await gate("peer-r")).ok, true);
  const { removePeerGrant } = await import("../servers/gateway/peer-exposure.js");
  await removePeerGrant(db, { peerId: "peer-r", capability: "funkwhale" });
  assert.equal((await gate("peer-r")).ok, false);
});

// ---------------------------------------------------------------------------
// 2. Expiry (time injected)
// ---------------------------------------------------------------------------

test("an expired grant is refused at check time; a live one still works (time injected)", async () => {
  const t0 = Date.now();
  await trustPeer("peer-e");
  await remedy({ capability: "funkwhale", requestingInstance: "peer-e", days: 30 }, { db, item: cardFor("peer-e") });
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-e", { now: t0 + 29 * DAY }), true);
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-e", { now: t0 + 31 * DAY }), false);

  // The GATE honours the injected clock too (not just the storage helper).
  assert.equal((await gate("peer-e", { now: t0 + 29 * DAY })).ok, true);
  assert.equal((await gate("peer-e", { now: t0 + 31 * DAY })).ok, false);
});

test('"until I remove it" never expires', async () => {
  const t0 = Date.now();
  await trustPeer("peer-f");
  await remedy({ capability: "funkwhale", requestingInstance: "peer-f", untilRemoved: true }, { db, item: cardFor("peer-f") });
  assert.equal((await getPeerExposures(db)).get("peer-f").get("funkwhale").expiresAt, null);
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-f", { now: t0 + 3650 * DAY }), true);
  assert.equal((await gate("peer-f", { now: t0 + 3650 * DAY })).ok, true);
});

test("an expired grant is still stored (Settings can renew or remove it) and a malformed expiry fails closed", async () => {
  const t0 = Date.now();
  await trustPeer("peer-g");
  await remedy({ capability: "funkwhale", requestingInstance: "peer-g", days: 7 }, { db, item: cardFor("peer-g") });
  assert.ok((await getPeerExposures(db)).get("peer-g").get("funkwhale"), "expired grants are kept, not pruned");
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-g", { now: t0 + 8 * DAY }), false);

  // A hand-edited/garbled expires_at never means "forever".
  await grantPeerCapability(db, { peerId: "peer-g", capability: "crow-memory", expiresAt: null });
  const raw = JSON.parse(await (await db.execute({
    sql: "SELECT value FROM dashboard_settings_overrides WHERE key = 'remote_exposed_tools_by_peer'",
    args: [],
  })).rows[0].value);
  raw["peer-g"]["crow-memory"].expires_at = "not-a-date";
  await writeSetting(db, "remote_exposed_tools_by_peer", JSON.stringify(raw), { scope: "local" });
  assert.equal(await isCapabilityExposedToPeer(db, "crow-memory", "peer-g"), false);
});

test("Settings lists each one-device allowance with its peer and expiry, and renews/removes it", async () => {
  const t0 = Date.now();
  await trustPeer("peer-abc123");
  await remedy({ capability: "funkwhale", requestingInstance: "peer-abc123", days: 1 }, { db, item: cardFor("peer-abc123") });
  // Age the grant past its expiry to prove the expired state is shown.
  const stored = (await getPeerExposures(db)).get("peer-abc123").get("funkwhale");
  const past = new Date(t0 - DAY).toISOString();
  await grantPeerCapability(db, { peerId: "peer-abc123", capability: "funkwhale", expiresAt: past });
  assert.ok(stored, "grant recorded");

  const html = await section.render({ db });
  assert.match(html, /Per-device allowances/);
  assert.match(html, /peer-abc123/, "the peer is shown");
  assert.match(html, /expired/, "an expired allowance is visible as expired");
  assert.match(html, /value="renew_peer_exposure"/);
  assert.match(html, /value="remove_peer_exposure"/);

  // Renew (+30 days) → active again.
  let redirected = null;
  const res = { redirectAfterPost: (u) => { redirected = u; } };
  assert.equal(await section.handleAction({
    req: { body: { action: "renew_peer_exposure", peer: "peer-abc123", cap: "funkwhale" } }, res, db,
    action: "renew_peer_exposure",
  }), true);
  assert.match(redirected, /section=remote-exposure/);
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-abc123"), true);

  // Remove → gone from storage and from the page.
  assert.equal(await section.handleAction({
    req: { body: { action: "remove_peer_exposure", peer: "peer-abc123", cap: "funkwhale" } }, res, db,
    action: "remove_peer_exposure",
  }), true);
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-abc123"), false);
  const after = await section.render({ db });
  assert.doesNotMatch(after, /peer-abc123/);
});

// ---------------------------------------------------------------------------
// 3. Existing all-peer exposures keep working, untouched
// ---------------------------------------------------------------------------

test("an existing all-trusted-peers exposure still allows EVERY peer (not narrowed, not migrated)", async () => {
  await writeSetting(db, "remote_exposed_tools", JSON.stringify(["funkwhale"]), { scope: "local" });
  assert.equal((await gate("peer-1")).ok, true);
  assert.equal((await gate("peer-2")).ok, true);
  // A per-peer grant elsewhere does not narrow it.
  await grantPeerCapability(db, { peerId: "peer-3", capability: "crow-memory", expiresAt: null });
  assert.equal((await gate("peer-1")).ok, true);
  assert.deepEqual([...((await getExposedCapabilities(db)))], ["funkwhale"]);
});

test("a card Allow leaves the all-peer list byte-for-byte unchanged", async () => {
  await trustPeer("peer-z");
  await writeSetting(db, "remote_exposed_tools", JSON.stringify(["crow-memory", "crow-blog"]), { scope: "local" });
  const before = (await db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = 'remote_exposed_tools'", args: [] })).rows[0].value;

  await emitDenied("peer-z", "funkwhale");
  await clickAllow((await store.listPending(db))[0]);
  const after = (await db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = 'remote_exposed_tools'", args: [] })).rows[0].value;
  assert.equal(after, before, "the all-peer setting is not written by a card");
  assert.deepEqual([...((await getExposedCapabilities(db)))].sort(), ["crow-blog", "crow-memory"]);
  // peer-z got the scoped grant; nobody else did.
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-z"), true);
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-y"), false);
});

// ---------------------------------------------------------------------------
// 4. Rate limits + dedupe
// ---------------------------------------------------------------------------

test("at most 3 open Allow cards per peer; further requests are counted, not carded", async () => {
  for (const capability of ["funkwhale", "crow-memory", "crow-blog"]) {
    await idx.emitFixIt(db, "peer-exposure:denied", { capability, requestingInstance: "peer-flood" });
  }
  assert.equal((await store.listPending(db)).length, MAX_OPEN_CARDS_PER_PEER);

  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "crow-storage", requestingInstance: "peer-flood" });
  const pending = await store.listPending(db);
  assert.equal(pending.length, MAX_OPEN_CARDS_PER_PEER, "the 4th capability creates no card");
  assert.ok(!pending.some((p) => p.context.capability === "crow-storage"));

  const counted = await getSuppressedRequests(db);
  assert.equal(counted.get("peer-flood|crow-storage")?.count, 1, "the refused request is recorded, not dropped silently");
  assert.equal(counted.get("peer-flood|crow-storage")?.reason, "open_card_cap");

  // Another peer is unaffected by peer-flood's cap (the limit is PER peer).
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "crow-storage", requestingInstance: "peer-quiet" });
  assert.equal((await store.listPending(db)).length, MAX_OPEN_CARDS_PER_PEER + 1);
});

test("a repeated identical request is deduped into the existing card (count bumped, one card)", async () => {
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-dup", toolName: "fw_play" });
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-dup", toolName: "fw_play" });
  const pending = await store.listPending(db);
  assert.equal(pending.length, 1, "still exactly one card");
  assert.equal(pending[0].count, 2, "the repeat is counted on that card");
  assert.equal(pending[0].dedupKey, dedupKeyFor("peer-dup", "funkwhale"));
});

test("only ONE new card per peer per capability per 24 h; a resolved card is counted, then reopens after the window", async () => {
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-24h" });
  const card = (await store.listPending(db))[0];
  await store.markResolved(db, card.id);

  // Same request again inside the window: no new card, the request is counted.
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-24h" });
  assert.equal((await store.listPending(db)).length, 0, "no new card inside 24 h");
  const counted = await getSuppressedRequests(db);
  assert.equal(counted.get("peer-24h|funkwhale")?.reason, "same_capability_within_24h");
  assert.equal((await store.getItem(db, card.id)).count, 2, "recorded on the answered card");

  // Past the window the request earns a fresh card.
  await db.execute({ sql: "UPDATE fix_it_items SET updated_at = datetime('now','-2 days') WHERE id = ?", args: [card.id] });
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-24h" });
  assert.equal((await store.listPending(db)).length, 1, "after 24 h the request may raise a card again");
});

test("the 24 h window is measured with the clock the caller injects (policy is pure)", () => {
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const answered = [{
    id: 7, dedupKey: dedupKeyFor("peer-p", "funkwhale"), status: "resolved", count: 1,
    context: { capability: "funkwhale", requestingInstance: "peer-p" },
    createdAt: "2025-12-31 23:00:00", updatedAt: "2026-01-01 00:00:00",
  }];
  assert.deepEqual(
    decidePeerExposureCard({ items: answered, peerId: "peer-p", capability: "funkwhale", now: t0 + 1000 }),
    { action: "count", itemId: 7, reason: "same_capability_within_24h" },
  );
  assert.deepEqual(
    decidePeerExposureCard({ items: answered, peerId: "peer-p", capability: "funkwhale", now: t0 + NEW_CARD_WINDOW_MS + 1000 }),
    { action: "create" },
  );
  assert.deepEqual(
    decidePeerExposureCard({ items: answered, peerId: "other-peer", capability: "funkwhale", now: t0 }),
    { action: "create" },
    "another peer's answered card does not block this one",
  );
});

// ---------------------------------------------------------------------------
// 5. The card records the VERIFIED peer id, never a name from the request body
// ---------------------------------------------------------------------------

test("the card is keyed by the verified peer id, not by anything the request body claims", async () => {
  await trustPeer("verified-peer");
  const spoof = {
    jsonrpc: "2.0", id: 9, method: "tools/call",
    params: { name: "fw_play", _meta: { requestingInstance: "victim-id", peerName: "Victim Device", requestedBy: "Victim Device" } },
    requestingInstance: "victim-id",
    requestingInstanceName: "Victim Device",
    peerName: "Victim Device",
    instance: { id: "victim-id" },
  };
  const res = mkRes();
  const denied = await enforcePeerExposure({
    prefix: "tools",
    req: {
      ...peerReq("verified-peer", spoof, {
        headers: { "x-peer-name": "Victim Device", "x-instance-id": "victim-id" },
      }),
      peerName: "Victim Device",
      instanceAuth: {
        instance: { id: "verified-peer", auth_token_hash: tokenHashFor("verified-peer") },
        peerName: "Victim Device",
      },
    },
    res, db, connectedServers: CONNECTED, auditFn: async () => {},
  });
  assert.equal(denied, false);
  const pending = await waitForPending((p) => p.length === 1);
  const card = pending[0];

  assert.equal(card.context.requestingInstance, "verified-peer");
  assert.equal(card.dedupKey, dedupKeyFor("verified-peer", "funkwhale", tagFor("verified-peer")));
  assert.ok(card.remedies.every((r) => r.args.requestingInstance === "verified-peer"));
  assert.doesNotMatch(JSON.stringify(card), /Victim Device/);
  assert.doesNotMatch(JSON.stringify(card), /victim-id/);

  // Clicking Allow grants the verified peer, never the body-claimed identity.
  await clickAllow(card);
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "verified-peer"), true);
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "victim-id"), false);
  assert.equal((await getPeerExposures(db)).has("victim-id"), false);
});

test("each card button grants its own duration (30 days / 7 days / until removed)", async () => {
  await trustPeer("peer-b7");
  await emitDenied("peer-b7", "funkwhale");
  let card = (await store.listPending(db))[0];
  assert.deepEqual(card.remedies.map((r) => r.actionId),
    ["expose-capability-30d", "expose-capability-7d", "expose-capability-forever"]);

  await clickAllow(card, "expose-capability-7d");
  const seven = (await getPeerExposures(db)).get("peer-b7").get("funkwhale");
  const days = (Date.parse(seven.expiresAt) - Date.now()) / DAY;
  assert.ok(days > 6.9 && days < 7.1, `7-day button grants 7 days, got ${days}`);

  await emitDenied("peer-b7", "crow-memory");
  card = (await store.listPending(db)).find((p) => p.context.capability === "crow-memory");
  await clickAllow(card, "expose-capability-forever");
  assert.equal((await getPeerExposures(db)).get("peer-b7").get("crow-memory").expiresAt, null);
  assert.equal((await getPeerExposures(db)).get("peer-b7").get("funkwhale").expiresAt, seven.expiresAt, "the other grant is untouched");
});

test("the per-peer store is local-only: it never syncs to other instances", async () => {
  const { isSyncable } = await import("../servers/gateway/dashboard/settings/sync-allowlist.js");
  assert.equal(isSyncable("remote_exposed_tools_by_peer"), false);
  assert.equal(isSyncable("peer_exposure_card_suppressed"), false);

  await grantPeerCapability(db, { peerId: "peer-local", capability: "funkwhale" });
  const globalRow = await db.execute({ sql: "SELECT 1 FROM dashboard_settings WHERE key = 'remote_exposed_tools_by_peer'", args: [] });
  assert.equal(globalRow.rows.length, 0, "no global (sync-emitted) row");
  const overrideRow = await db.execute({ sql: "SELECT 1 FROM dashboard_settings_overrides WHERE key = 'remote_exposed_tools_by_peer'", args: [] });
  assert.ok(overrideRow.rows.length > 0, "stored as this instance's local override");
});

test("a remedy whose card carries no verified peer id refuses instead of widening", async () => {
  await db.execute("DELETE FROM fix_it_items");
  const r = await remedy({ capability: "funkwhale", requestingInstance: "Victim Device" }, { db });
  assert.equal(r.resolved, false);
  assert.equal((await getExposedCapabilities(db)).has("funkwhale"), false);
  assert.equal((await getPeerExposures(db)).size, 0);
});

// ---------------------------------------------------------------------------
// 6. Review round 1 — B1: the decide-then-upsert step is serialised per peer
// ---------------------------------------------------------------------------

// The six core capabilities of any instance, plus addon-shaped ids a box with
// addons would have. Every one of them is an id the gate would have matched
// against the catalog before the event reached the detector.
const TWENTY_CAPABILITIES = [
  ...getLocalCapabilityIds(),
  "funkwhale", "trello", "notion", "slack", "canvas", "weather", "calendar",
  "contacts", "gallery", "podcast", "rss", "maps", "translate", "recipes",
];

test("B1: 20 concurrent denials for ONE peer make exactly 3 cards; the rest are counted", async () => {
  const lock = await import("../servers/gateway/fix-it/peer-card-lock.js");
  assert.equal(TWENTY_CAPABILITIES.length, 20, "20 distinct capabilities");
  assert.ok(MAX_OPEN_CARDS_PER_PEER < 20);

  // All 20 fire-and-forget events are in flight together — the exact shape that
  // used to let every one of them see "no open cards yet" and create a card.
  const droppedBefore = lock._peerLockOverflow();
  await Promise.all(TWENTY_CAPABILITIES.map((capability) => idx.emitFixIt(db, "peer-exposure:denied", {
    capability, capabilityKnown: true, requestingInstance: "peer-burst",
  })));

  const pending = await store.listPending(db);
  assert.equal(pending.length, MAX_OPEN_CARDS_PER_PEER, `expected ${MAX_OPEN_CARDS_PER_PEER} pending cards`);
  assert.equal(new Set(pending.map((p) => p.context.capability)).size, MAX_OPEN_CARDS_PER_PEER, "all different capabilities");

  const counted = await getSuppressedRequests(db);
  const total = [...counted.values()].reduce((n, v) => n + v.count, 0);
  // Round 2 (N-b): the per-peer queue is bounded, so an event that arrives with
  // the queue full is dropped before it touches the db (no card, no counter) and
  // counted in memory. Every event is still accounted for:
  // cards + db-counted + dropped === 20.
  const dropped = lock._peerLockOverflow() - droppedBefore;
  assert.equal(pending.length + total + dropped, TWENTY_CAPABILITIES.length,
    `3 cards + ${total} counted + ${dropped} dropped must be the 20 events`);
  assert.ok([...counted.values()].every((v) => v.reason === "open_card_cap" && v.count === 1));
  assert.equal(counted.size, total, "one entry per refused capability");
  assert.equal(lock._peerLockSize(), 0, "the per-peer chain is dropped once its tail settles");
});

// --- Review round 2, N-b: the per-peer queue is bounded ---------------------

test("N-b: 100 concurrent events from one peer never have more than the cap waiting, and the overflow is counted", async () => {
  const lock = await import("../servers/gateway/fix-it/peer-card-lock.js");
  assert.ok(Number.isInteger(lock.MAX_QUEUED_TASKS_PER_KEY) && lock.MAX_QUEUED_TASKS_PER_KEY > 0,
    "the per-key queue has a named cap");

  // (1) The lock itself. One task holds the key while 100 more arrive: the ones
  // beyond the cap are refused AT ARRIVAL (never queued, never run).
  lock._resetPeerLockForTest();
  let release;
  const gate = new Promise((r) => { release = r; });
  let started = 0;
  const runs = [lock.withPeerLock("peer-queue", async () => { started += 1; await gate; })];
  for (let i = 0; i < 100; i++) {
    runs.push(lock.withPeerLock("peer-queue", async () => { started += 1; }));
  }
  await new Promise((r) => setTimeout(r, 5)); // let the blocker take the key
  assert.equal(started, 1, "one task at a time per peer, as before");
  const droppedAtArrival = lock._peerLockOverflow();
  release();
  await Promise.all(runs);
  assert.equal(started, lock.MAX_QUEUED_TASKS_PER_KEY,
    `at most ${lock.MAX_QUEUED_TASKS_PER_KEY} tasks ever wait/run for one peer (1 ran + 15 queued)`);
  assert.equal(droppedAtArrival, 101 - lock.MAX_QUEUED_TASKS_PER_KEY,
    "the 85 events that arrived while the queue was full were dropped and counted in memory");
  assert.equal(lock._peerLockOverflow(), 101 - lock.MAX_QUEUED_TASKS_PER_KEY);
  assert.equal(lock._peerLockSize(), 0, "the key is dropped once its tail settles");

  // (2) Through the real event path: 100 distinct capabilities from one peer.
  // A drop costs NO db work, so the cards AND the counters stay bounded.
  const HUNDRED = Array.from({ length: 100 }, (_, i) => `cap-${i}`);
  const droppedBefore = lock._peerLockOverflow();
  await Promise.all(HUNDRED.map((capability) => idx.emitFixIt(db, "peer-exposure:denied", {
    capability, capabilityKnown: true, requestingInstance: "peer-hundred",
  })));
  const dropped = lock._peerLockOverflow() - droppedBefore;
  const pending = await store.listPending(db);
  const counted = await getSuppressedRequests(db);
  const total = [...counted.values()].reduce((n, v) => n + v.count, 0);
  assert.equal(pending.length, MAX_OPEN_CARDS_PER_PEER, "the open-card cap still holds");
  assert.ok(dropped > 0, "the flood did overflow the per-peer queue (100 events, cap 16)");
  assert.equal(pending.length + total + dropped, HUNDRED.length,
    `3 cards + ${total} counted + ${dropped} dropped must be the 100 events`);
  assert.equal(lock._peerLockSize(), 0);
});

// ---------------------------------------------------------------------------
// 7. Review round 1 — B2: the peer does not choose the capability id
// ---------------------------------------------------------------------------

test("B2: 200 junk tool names raise no card and leave ONE counter entry for the peer", async () => {
  const emits = emitCollector();
  const calls = [];
  for (let i = 0; i < 200; i++) calls.push(gateRouter("peer-junk", `crow_junk${i}`, { emitFn: emits.fn }));
  // …plus two names that are not even id-shaped (no tail, absurdly long).
  calls.push(gateRouter("peer-junk", `crow_${"a".repeat(300)}`, { emitFn: emits.fn }));
  calls.push(gateRouter("peer-junk", "crow_", { emitFn: emits.fn }));

  const results = await Promise.all(calls);
  assert.equal(results.length, 202);
  assert.ok(results.every((r) => r.ok === false), "every junk name is refused");
  await emits.settle();

  assert.equal((await store.listPending(db)).length, 0, "no card for a capability this instance does not have");
  const counted = await getSuppressedRequests(db);
  assert.equal(counted.size, 1, "one bucket, not one entry per junk name");
  assert.equal(counted.get("peer-junk|unknown")?.count, 202);
  assert.equal(counted.get("peer-junk|unknown")?.reason, "unknown_capability");
  assert.deepEqual((await getPeerExposures(db)).size, 0);
});

test("B2: crow_Memory and crow_memory are ONE capability (the case variant is not unknown)", async () => {
  assert.equal(resolveCalledCanonicalId("router", { method: "tools/call", params: { name: "crow_Memory" } }), "crow-memory");
  assert.equal(resolveCalledCanonicalId("router", { method: "tools/call", params: { name: "crow_memory" } }), "crow-memory");
  // The tail keeps its underscores (review round 2, N-f: the comment in
  // capability-ids.js said `crow-store-memory`, which is not what it returns).
  assert.equal(resolveCalledCanonicalId("router", { method: "tools/call", params: { name: "crow_store_memory" } }), "crow-store_memory");

  const emits = emitCollector();
  await Promise.all([
    gateRouter("peer-case", "crow_Memory", { emitFn: emits.fn }),
    gateRouter("peer-case", "crow_memory", { emitFn: emits.fn }),
  ]);
  await emits.settle();

  const pending = await store.listPending(db);
  assert.equal(pending.length, 1, "both spellings land on the same card");
  assert.equal(pending[0].context.capability, "crow-memory");
  assert.equal(pending[0].count, 2, "the second spelling was deduped, not carded again");
  assert.equal((await getSuppressedRequests(db)).size, 0, "nothing was counted as unknown");
});

test("B2: the suppressed-counter map is capped and pruned", async () => {
  const now = Date.now();
  const seeded = Object.create(null);
  for (let i = 0; i < SUPPRESSED_COUNTER_MAX_ENTRIES + 120; i++) {
    seeded[`peer-seed${i}|crow-memory`] = { count: 1, last_at: new Date(now - 1000).toISOString(), reason: "open_card_cap" };
  }
  await writeSetting(db, "peer_exposure_card_suppressed", JSON.stringify(seeded), { scope: "local" });
  await recordSuppressedRequest(db, { peerId: "peer-fresh", capability: "crow-blog", reason: "open_card_cap", now });
  const after = await getSuppressedRequests(db);
  assert.equal(after.size, SUPPRESSED_COUNTER_MAX_ENTRIES, "the map never exceeds the cap");
  assert.ok(after.has("peer-fresh|crow-blog"), "the newest entry survives; the oldest are evicted");

  // An entry whose window has passed is pruned on the next write.
  const stale = Object.create(null);
  stale["peer-stale|crow-memory"] = {
    count: 5, last_at: new Date(now - SUPPRESSED_COUNTER_WINDOW_MS - 1000).toISOString(), reason: "open_card_cap",
  };
  await writeSetting(db, "peer_exposure_card_suppressed", JSON.stringify(stale), { scope: "local" });
  await recordSuppressedRequest(db, { peerId: "peer-fresh", capability: "crow-blog", reason: "open_card_cap", now });
  assert.equal((await getSuppressedRequests(db)).has("peer-stale|crow-memory"), false, "an expired window is pruned");
});

// ---------------------------------------------------------------------------
// 8. Review round 1 — S1: a card written by the OLD detector
// ---------------------------------------------------------------------------

test("S1 (fix round 3): an old-shape Allow card with NO pairing tag refuses instead of granting", async () => {
  const peer = "peer-old";
  await trustPeer(peer);
  // Exactly what the pre-scoping detector wrote: one button, no duration, the
  // capability in the remedy args and the peer only in the card CONTEXT. It also
  // predates the pairing tag, so nothing in it says WHICH pairing asked.
  await store.upsertItem(db, {
    source: "remote-exposure",
    dedupKey: legacyDedupKeyFor(peer, "funkwhale"),
    title: "Another device tried to use Music",
    why: "Allow it?",
    severity: "warn",
    remedies: [{ label: "Allow", actionId: "expose-capability", kind: "instant", args: { capability: "funkwhale" } }],
    context: { capability: "funkwhale", requestingInstance: peer, toolName: "fw_play" },
  });
  const card = (await store.listPending(db))[0];
  assert.equal(card.remedies[0].actionId, "expose-capability");
  assert.equal(card.context.pairingTag, undefined, "the legacy card predates the tag");

  // Fix round 3 changed this from a grant to a refusal: without a tag there is
  // no way to tell the pairing that asked from a re-pair under the same id, and
  // a refusal is the safe default.
  const refused = await remedy({ capability: "funkwhale", days: 30 }, { db, item: card });
  assert.equal(refused.resolved, false, "a card with no pairing tag grants nothing");
  assert.match(refused.message, /pairing has changed/);
  assert.equal((await getPeerExposures(db)).size, 0, "no allowance was written, for this peer or any other");
  assert.equal((await getExposedCapabilities(db)).has("funkwhale"), false, "and never the all-peer list");
  assert.equal((await gate(peer)).ok, false, "the peer that (once) asked is still refused");

  // The card still occupies its rate-limit slot while it is pending: the same
  // request bumps THAT card (a pending card is deduped, never re-carded), so it
  // never multiplies in the Nest.
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", capabilityKnown: true, requestingInstance: peer });
  const after = await store.listPending(db);
  assert.equal(after.length, 1, "still exactly one card for the same (capability, peer)");
  assert.equal(after[0].id, card.id, "the card that was already open is the one that was bumped");
});

// ---------------------------------------------------------------------------
// 9. Review round 1 — N1: the dedupe key is unambiguous and old keys still read
// ---------------------------------------------------------------------------

test("N1: the dedupe key separator cannot appear in either part, and old keys still dedupe", () => {
  // Peer ids are [A-Za-z0-9._:-] (so they CAN contain ':'), which is what made
  // `expose:<capability>:<peer>` ambiguous.
  assert.notEqual(dedupKeyFor("peer:c", "crow-memory"), legacyDedupKeyFor("peer:c", "crow-memory"));
  assert.equal(dedupKeyFor("peer:c", "crow-memory"), "expose|crow-memory|peer:c");

  // A card opened with the old key shape is still recognised as the same
  // (capability, peer) — the fallback looks at the key, not only the context.
  const items = [{
    id: 3, dedupKey: legacyDedupKeyFor("peer-c", "funkwhale"), status: "pending", count: 1,
    context: { requestingInstance: "peer-c" },
    createdAt: "2026-01-01 00:00:00", updatedAt: "2026-01-01 00:00:00",
  }];
  assert.deepEqual(
    decidePeerExposureCard({ items, peerId: "peer-c", capability: "funkwhale" }),
    { action: "dedupe", itemId: 3 },
  );
});

// ---------------------------------------------------------------------------
// 10. Review round 1 — S3: revoking a peer drops its one-device allowances
// ---------------------------------------------------------------------------

test("S3: revoking a peer removes its grants; re-pairing the same id starts clean", async () => {
  const { revokePeer } = await import("../servers/sharing/revoke-peer.js");
  await db.execute({
    sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, ?, ?, ?)",
    args: ["peer-revoked", "Peer To Revoke", "crow-other", "active", 1],
  });
  await grantPeerCapability(db, { peerId: "peer-revoked", capability: "funkwhale", expiresAt: null });
  await grantPeerCapability(db, { peerId: "peer-revoked", capability: "crow-blog", expiresAt: null });
  await grantPeerCapability(db, { peerId: "peer-bystander", capability: "funkwhale", expiresAt: null });
  assert.equal((await gate("peer-revoked")).ok, true);

  const r = await revokePeer(db, "peer-revoked", { instanceSyncManager: null });
  assert.equal(r.ok, true);

  assert.equal((await getPeerExposures(db)).has("peer-revoked"), false, "every grant for the revoked peer is gone");
  assert.deepEqual([...((await getPeerExposures(db)).keys())], ["peer-bystander"], "another peer's grant is untouched");
  assert.equal((await gate("peer-revoked")).ok, false, "and the revoked peer is refused");

  // Re-pair with the same id (a revoke→re-pair reuses it): the row comes back,
  // the allowances do not.
  await db.execute({
    sql: "UPDATE crow_instances SET status = 'active', auth_token_hash = 'reissued', trusted = 1 WHERE id = ?",
    args: ["peer-revoked"],
  });
  assert.equal((await getPeerGrantedCapabilities(db, "peer-revoked")).size, 0, "no grant survives the re-pair");
  assert.equal((await gate("peer-revoked")).ok, false, "the re-paired peer must be allowed again from scratch");
});

test("S3: a revoke written by ANOTHER process (row only) also drops the grants on the next sweep", async () => {
  const { reconcilePeerCreds } = await import("../servers/gateway/peer-trust-sweeper.js");
  await db.execute({
    sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, ?, ?, ?)",
    args: ["peer-elsewhere", "Peer Revoked Elsewhere", "crow-third", "active", 1],
  });
  await grantPeerCapability(db, { peerId: "peer-elsewhere", capability: "funkwhale", expiresAt: null });
  assert.equal((await gate("peer-elsewhere")).ok, true);

  // The stdio MCP door flips the row and the gateway only sees the row change.
  await db.execute({ sql: "UPDATE crow_instances SET status = 'revoked' WHERE id = ?", args: ["peer-elsewhere"] });
  await reconcilePeerCreds(db);

  assert.equal((await getPeerExposures(db)).has("peer-elsewhere"), false, "the sweep drops the revoked peer's allowances");
  await db.execute({ sql: "UPDATE crow_instances SET status = 'active', trusted = 1 WHERE id = ?", args: ["peer-elsewhere"] });
  assert.equal((await gate("peer-elsewhere")).ok, false, "re-paired, but no allowance came back");
});

// ---------------------------------------------------------------------------
// 11. Review round 2 — SF1: an old-key card must not gain a duplicate
// ---------------------------------------------------------------------------

// The policy already matched the pre-round-1 key (`expose:<cap>:<peer>`), but the
// DETECTOR ignored the `dedupe` verdict and fell through to `upsertItem` under
// the NEW key — which inserted a second open card for the same request. Policy
// tests alone could not see that; this one goes through the real event path.
test("SF1: a repeat denial for a pre-round-1 card bumps THAT card and leaves exactly one open card", async () => {
  const peer = "peer-sf1";
  await trustPeer(peer);
  await store.upsertItem(db, {
    source: "remote-exposure",
    dedupKey: legacyDedupKeyFor(peer, "funkwhale"),
    title: "Another device tried to use Music",
    why: "Allow it?",
    severity: "warn",
    remedies: [{ label: "Allow", actionId: "expose-capability", kind: "instant", args: { capability: "funkwhale" } }],
    context: { capability: "funkwhale", requestingInstance: peer, toolName: "fw_play" },
  });
  const seeded = (await store.listPending(db))[0];
  assert.equal(seeded.dedupKey, legacyDedupKeyFor(peer, "funkwhale"));

  // The same peer asks again, through the real event path.
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", capabilityKnown: true, requestingInstance: peer, toolName: "fw_play" });

  const pending = await store.listPending(db);
  assert.equal(pending.length, 1, "ONE open card — the repeat must not insert a second row under the new key");
  assert.equal(pending[0].id, seeded.id, "the card that was already open is the one that was bumped");
  assert.equal(pending[0].dedupKey, legacyDedupKeyFor(peer, "funkwhale"), "its old key shape is preserved");
  assert.equal(pending[0].count, seeded.count + 1, "and its count records the repeat");
  const rows = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM fix_it_items WHERE source = ? AND status = 'pending'",
    args: ["remote-exposure"],
  });
  assert.equal(Number(rows.rows[0].n), 1, "exactly one pending row in the table, not just in the pending view");
});

// ---------------------------------------------------------------------------
// 12. Review round 2 — N-a: a revoke answers the peer's cards, and a card for
//     a peer that is no longer trusted cannot grant anything
// ---------------------------------------------------------------------------

test("N-a: revoke answers the peer's open card; re-pairing the same id does not make that card clickable again", async () => {
  const { revokePeer, PEER_EXPOSURE_CARD_SOURCE } = await import("../servers/sharing/revoke-peer.js");
  // The revoke module keeps the detector's source as a literal; if either moves,
  // the cards stop being answered and this test says so.
  const detector = (await import("../servers/gateway/fix-it/detectors/remote-exposure.js")).default;
  assert.equal(PEER_EXPOSURE_CARD_SOURCE, detector.source);

  const peer = "peer-na";
  await trustPeer(peer);
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: peer, toolName: "fw_play" });
  const card = (await store.listPending(db))[0];
  assert.equal(card.context.requestingInstance, peer);

  const r = await revokePeer(db, peer, { instanceSyncManager: null });
  assert.equal(r.ok, true);
  assert.equal((await store.getItem(db, card.id)).status, "resolved", "the revoke answers the card it left behind");
  assert.equal((await store.listPending(db)).length, 0, "nothing is left asking for a peer that is gone");

  // Re-pair under the SAME id (a revoke→re-pair reuses it): the row is trusted
  // again, so the remedy's trust check would pass — the answered card must not.
  await db.execute({
    sql: "UPDATE crow_instances SET status = 'active', auth_token_hash = 'reissued', trusted = 1 WHERE id = ?",
    args: [peer],
  });
  const redirected = await clickAllow(card);
  assert.match(redirected, /flash=fixit_not_pending/, "the stale card refuses");
  assert.equal((await getPeerGrantedCapabilities(db, peer)).size, 0, "and grants nothing");
  assert.equal((await getPeerExposures(db)).size, 0, "no allowance was written at all");
});

test("N-a: the Allow remedy refuses for a peer that is not a currently trusted peer", async () => {
  const peer = "peer-na-row";
  await trustPeer(peer);
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: peer });
  const card = (await store.listPending(db))[0];
  assert.ok(card, "the card exists while the peer is trusted");

  // A revoke written by ANOTHER process lands on the row only: the card is still
  // pending here, so the remedy itself must refuse.
  await db.execute({ sql: "UPDATE crow_instances SET status = 'revoked' WHERE id = ?", args: [peer] });
  const revoked = await remedy({ capability: "funkwhale", requestingInstance: peer, days: 30 }, { db, item: card });
  assert.equal(revoked.resolved, false, "a revoked peer is refused");
  assert.match(revoked.message, /trusted peer/, "and the refusal says why");
  assert.equal((await getPeerGrantedCapabilities(db, peer)).size, 0, "nothing granted");
  assert.equal((await getPeerExposures(db)).size, 0);

  // Paused (an owner's reversible sync hold) and untrusted rows are not trusted
  // either, and neither is an id with no row at all.
  await db.execute({ sql: "UPDATE crow_instances SET status = 'paused', trusted = 1 WHERE id = ?", args: [peer] });
  assert.equal((await remedy({ capability: "funkwhale", requestingInstance: peer }, { db })).resolved, false, "paused refused");
  await db.execute({ sql: "UPDATE crow_instances SET status = 'active', trusted = 0 WHERE id = ?", args: [peer] });
  assert.equal((await remedy({ capability: "funkwhale", requestingInstance: peer }, { db })).resolved, false, "untrusted refused");
  const neverPaired = await remedy({ capability: "funkwhale", requestingInstance: "peer-never-paired" }, { db });
  assert.equal(neverPaired.resolved, false, "a peer with no row is not a trusted peer");
  assert.match(neverPaired.message, /trusted peer/);
  assert.equal((await getPeerExposures(db)).size, 0, "no allowance was written by any of them");

  // Fix round 3: the peer's row is made trusted again — exactly what a revoke→
  // re-pair under the SAME id does — so the trust check alone cannot save us.
  // This card was raised by a pairing that is gone (it carries no tag, which is
  // what every card written before this round carries), so the remedy refuses.
  await db.execute({ sql: "UPDATE crow_instances SET status = 'active', trusted = 1, auth_token_hash = ? WHERE id = ?", args: ["reissued", peer] });
  const repaired = await remedy({ capability: "funkwhale", requestingInstance: peer, days: 30 }, { db, item: card });
  assert.equal(repaired.resolved, false, "a card from the old pairing is refused after a re-pair");
  assert.match(repaired.message, /pairing has changed/);
  assert.equal((await getPeerGrantedCapabilities(db, peer)).size, 0, "nothing granted");
  assert.equal((await getPeerExposures(db)).size, 0, "no allowance was written by the re-paired id either");
});

// ---------------------------------------------------------------------------
// 13. Fix round 3 — the card is bound to the PAIRING it was raised under
// ---------------------------------------------------------------------------

// `auth_token_hash` changes on every re-pair (NULL on revoke, a new hash on
// enroll/repair) and on every rotation, but the instance ID does NOT: a
// revoke→re-pair reuses it, and `peerTrust` passes for the re-paired row. An ID
// alone therefore cannot tell "the device that asked" from "a later device
// wearing the same id". The card records `context.pairingTag` (a one-way tag of
// the hash that verified the request) and the remedy compares it with the tag of
// the peer's CURRENT hash.

test("the card stores a 16-hex pairing tag and never the peer's bearer hash", async () => {
  const peer = "peer-tag";
  await trustPeer(peer);
  await emitDenied(peer, "funkwhale", { toolName: "fw_play" });
  const card = (await store.listPending(db))[0];

  assert.equal(card.context.pairingTag, tagFor(peer), "the tag of the pairing that asked");
  assert.match(card.context.pairingTag, /^[0-9a-f]{16}$/);
  // The stored hash is a live credential: the card carries a one-way tag only.
  assert.equal(card.context.auth_token_hash, undefined, "no raw hash field on the card");
  assert.ok(!JSON.stringify(card.context).includes(tokenHashFor(peer)), "no raw hash anywhere in the card context");

  // The helper itself: no hash → no tag (never a fixed/empty-string tag), and
  // two pairings never share one.
  assert.equal(pairingTag(null), null);
  assert.equal(pairingTag(undefined), null);
  assert.equal(pairingTag(""), null);
  assert.notEqual(pairingTag("hash-a"), pairingTag("hash-b"));
  assert.equal(pairingTag("hash-a"), pairingTag("hash-a"), "stable for the same pairing");
});

test("same pairing: a card raised under the current pairing still grants, exactly as before", async () => {
  const peer = "peer-same";
  await trustPeer(peer);
  await emitDenied(peer, "funkwhale");
  const card = (await store.listPending(db))[0];

  assert.equal((await remedy({ capability: "funkwhale", requestingInstance: peer, days: 30 }, { db, item: card })).resolved, true);
  assert.equal((await getPeerGrantedCapabilities(db, peer)).has("funkwhale"), true);
  assert.equal((await getExposedCapabilities(db)).has("funkwhale"), false, "still never the all-peer list");
});

test("a denial queued when a revoke sweeps is carded afterwards, and cannot grant the re-paired id", async () => {
  const { revokePeer } = await import("../servers/sharing/revoke-peer.js");
  const lock = await import("../servers/gateway/fix-it/peer-card-lock.js");
  const peer = "peer-race";
  await trustPeer(peer); // pairing H1

  // Hold the per-peer queue so the denial is decided AFTER the revoke's card
  // sweep — which does not take this lock, so it cannot see the card either.
  let release;
  const heldOpen = new Promise((r) => { release = r; });
  const blocker = lock.withPeerLock(peer, async () => { await heldOpen; });
  const queued = emitDenied(peer, "funkwhale"); // tag(H1), as the gate would send
  await new Promise((r) => setTimeout(r, 25)); // let it reach the lock

  assert.equal((await revokePeer(db, peer, { instanceSyncManager: null })).ok, true);
  assert.equal((await store.listPending(db)).length, 0, "no card existed when the revoke swept");

  // Re-pair under the SAME id with a NEW bearer hash: a different pairing.
  await db.execute({
    sql: "UPDATE crow_instances SET status = 'active', trusted = 1, auth_token_hash = ? WHERE id = ?",
    args: ["repaired-token-hash", peer],
  });

  release();
  await blocker;
  await queued;

  const pending = await store.listPending(db);
  assert.equal(pending.length, 1, "the queued denial creates its card after the sweep, as before");
  assert.equal(pending[0].context.pairingTag, tagFor(peer), "tagged with the OLD pairing it was raised under");

  // `peerTrust` passes now (the row is active/trusted again) — the pairing tag is
  // what refuses the click.
  const outcome = await remedy({ capability: "funkwhale", requestingInstance: peer, days: 30 }, { db, item: pending[0] });
  assert.equal(outcome.resolved, false, "the old pairing's card grants nothing after the re-pair");
  assert.match(outcome.message, /pairing has changed/);
  assert.equal((await getPeerGrantedCapabilities(db, peer)).size, 0, "no grant for the re-paired id");
  assert.equal((await getPeerExposures(db)).size, 0, "no allowance was written at all");
});

test("a row-only revoke is answered by the next sweep, like the grant drop", async () => {
  const { reconcilePeerCreds } = await import("../servers/gateway/peer-trust-sweeper.js");
  const peer = "peer-rowonly-card";
  await trustPeer(peer);
  await emitDenied(peer, "funkwhale");
  const card = (await store.listPending(db))[0];
  assert.equal(card.status, "pending");

  // The stdio MCP door flips the row; this gateway only sees the row change.
  await db.execute({ sql: "UPDATE crow_instances SET status = 'revoked' WHERE id = ?", args: [peer] });
  await reconcilePeerCreds(db);

  assert.equal((await store.getItem(db, card.id)).status, "resolved", "the sweep answers the peer's open card");
  assert.equal((await store.listPending(db)).length, 0, "nothing is left asking for a peer that is gone");
});

test("row-only revoke, then a re-pair with a new hash: the old pending card is refused", async () => {
  const peer = "peer-rowonly-repair";
  await trustPeer(peer);
  await emitDenied(peer, "funkwhale");
  const card = (await store.listPending(db))[0];

  // Revoked elsewhere, and the sweeper has not run: the card is still pending
  // when the same id pairs again with a new hash.
  await db.execute({ sql: "UPDATE crow_instances SET status = 'revoked' WHERE id = ?", args: [peer] });
  await db.execute({
    sql: "UPDATE crow_instances SET status = 'active', trusted = 1, auth_token_hash = ? WHERE id = ?",
    args: ["repaired-token-hash-2", peer],
  });

  const outcome = await remedy({ capability: "funkwhale", requestingInstance: peer, days: 30 }, { db, item: card });
  assert.equal(outcome.resolved, false, "the card that outlived the revoke cannot grant the re-paired id");
  assert.match(outcome.message, /pairing has changed/);
  assert.equal((await getPeerGrantedCapabilities(db, peer)).size, 0, "nothing granted");
  assert.equal((await getPeerExposures(db)).size, 0, "no allowance was written");
});

test("a pending card from an old pairing does not swallow the new pairing's request", async () => {
  const peer = "peer-stale-tag";
  await trustPeer(peer); // pairing H1
  await emitDenied(peer, "funkwhale");
  const old = (await store.listPending(db))[0];
  assert.equal(old.context.pairingTag, tagFor(peer));

  // Re-pair: a new hash, so a new pairing tag on the next denial.
  const newHash = "repaired-token-hash-3";
  await db.execute({ sql: "UPDATE crow_instances SET auth_token_hash = ? WHERE id = ?", args: [newHash, peer] });
  await idx.emitFixIt(db, "peer-exposure:denied", {
    capability: "funkwhale", requestingInstance: peer, pairingTag: pairingTag(newHash),
  });

  assert.equal((await store.getItem(db, old.id)).status, "resolved", "the stale card is answered, not reused");
  const pending = await store.listPending(db);
  assert.equal(pending.length, 1, "exactly one card is open");
  assert.notEqual(pending[0].id, old.id, "and it is a NEW card, not the old one");
  assert.equal(pending[0].context.pairingTag, pairingTag(newHash), "tagged with the current pairing");

  // The new card is a real, clickable request.
  await clickAllow(pending[0]);
  assert.equal((await getPeerGrantedCapabilities(db, peer)).has("funkwhale"), true);
});

// ---------------------------------------------------------------------------
// 14. Fix round 4 — the tag comes from the VERIFIED instance, and a sweep
//     reads the card table once
// ---------------------------------------------------------------------------

// `validateInstanceToken` matched the request's bearer against
// `auth_token_hash` and returned that row, so the verified instance DOES carry
// the hash. Fix round 4 removed the by-id re-read that used to stand in for it:
// after a revoke→re-pair that re-read could tag an OLD pairing's request with
// the NEW pairing's hash, which is exactly the card the remedy would accept.

/** A peer request whose VERIFIED row carries `hash` (null = carries none). */
const reqVerifiedAs = (id, hash) => ({
  instanceAuth: { instance: hash === null ? { id } : { id, auth_token_hash: hash } },
  body: CALL,
});

async function denyWithVerifiedHash(id, hash) {
  const res = mkRes();
  const ok = await enforcePeerExposure({
    prefix: "tools", req: reqVerifiedAs(id, hash), res,
    db, connectedServers: CONNECTED, auditFn: async () => {},
  });
  assert.equal(ok, false, "the call is still denied (nothing is exposed)");
  assert.equal(res._status, 403);
  const card = (await waitForPending((p) => p.length === 1))[0];
  return card;
}

test("the card's tag is the VERIFIED pairing's, even when the current row holds another hash", async () => {
  const peer = "peer-verified-pairing";
  await trustPeer(peer); // the row now holds tokenHashFor(peer) — "H2"
  const H1 = "hash-of-the-pairing-that-actually-asked";

  const card = await denyWithVerifiedHash(peer, H1);
  assert.equal(card.context.requestingInstance, peer);
  assert.equal(card.context.pairingTag, pairingTag(H1), "tagged with the pairing the request was verified under");
  assert.notEqual(card.context.pairingTag, tagFor(peer), "NOT with the hash a later re-read of the row would return");

  // The remedy compares the card's tag with the tag of the CURRENT row (H2):
  // they differ, so the click refuses — the H1 device is not the H2 device.
  const outcome = await remedy({ capability: "funkwhale", requestingInstance: peer, days: 30 }, { db, item: card });
  assert.equal(outcome.resolved, false, "the card outlived its pairing and is refused");
  assert.match(outcome.message, /pairing has changed/);
  assert.equal((await getPeerGrantedCapabilities(db, peer)).size, 0, "nothing granted");
  assert.equal((await getPeerExposures(db)).size, 0, "no allowance was written");
});

test("a verified instance with no hash raises an UNTAGGED card, and the remedy refuses it", async () => {
  const peer = "peer-no-verified-hash";
  await trustPeer(peer); // the row HAS a hash: the removed fallback would have used it

  const card = await denyWithVerifiedHash(peer, null);
  assert.equal(card.context.pairingTag, null, "no hash on the verified row → no tag, never the current row's");

  const outcome = await remedy({ capability: "funkwhale", requestingInstance: peer, days: 30 }, { db, item: card });
  assert.equal(outcome.resolved, false, "fail closed: an untagged card grants nothing");
  assert.match(outcome.message, /pairing has changed/);
  assert.equal((await getPeerGrantedCapabilities(db, peer)).size, 0, "nothing granted");
  assert.equal((await getPeerExposures(db)).size, 0, "no allowance was written");
});

/** A Fix-it store stub that counts the reads a sweep makes. */
function countingStore(items = []) {
  const calls = { listBySource: 0, markResolved: 0 };
  return {
    calls,
    listBySource: async () => { calls.listBySource += 1; return items; },
    markResolved: async () => { calls.markResolved += 1; },
  };
}

test("a sweep lists the peer-exposure cards ONCE however many revoked peers there are", async () => {
  const { reconcilePeerCreds } = await import("../servers/gateway/peer-trust-sweeper.js");
  // Revoked rows are never deleted, so a per-row `listBySource` grows without
  // bound (50 revokes → 50 reads every 10 s).
  for (let i = 0; i < 50; i++) {
    const id = `peer-revoked-bulk-${i}`;
    await db.execute({
      sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, ?, 'revoked', 0)",
      args: [id, `Revoked ${i}`, "crow-test"],
    });
  }
  assert.equal((await store.listPending(db)).length, 0, "nothing is pending in this fixture");

  const cards = countingStore([]);
  await reconcilePeerCreds(db, { fixItStore: cards });
  assert.equal(cards.calls.listBySource, 1, "one card read per sweep, not one per revoked row");
  assert.equal(cards.calls.markResolved, 0, "nothing pending → no card work at all");
});

test("a sweep resolves a pending card for a revoked peer, from the one read it made", async () => {
  const { reconcilePeerCreds } = await import("../servers/gateway/peer-trust-sweeper.js");
  const peer = "peer-revoked-bulk-card";
  await trustPeer(peer);
  await emitDenied(peer, "funkwhale");
  const card = (await store.listPending(db))[0];

  await db.execute({ sql: "UPDATE crow_instances SET status = 'revoked' WHERE id = ?", args: [peer] });
  const cards = countingStore([card]);
  await reconcilePeerCreds(db, { fixItStore: cards });
  assert.equal(cards.calls.listBySource, 1, "still one read per sweep");
  assert.equal(cards.calls.markResolved, 1, "the revoked peer's card is the one that was answered");
});