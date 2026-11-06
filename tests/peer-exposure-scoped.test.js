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
  MAX_OPEN_CARDS_PER_PEER,
  NEW_CARD_WINDOW_MS,
} from "../servers/gateway/fix-it/peer-card-policy.js";
import { getSuppressedRequests } from "../servers/gateway/fix-it/peer-card-counters.js";

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

const peerReq = (peerId, body = CALL, extra = {}) => ({
  ...extra,
  instanceAuth: { instance: { id: peerId } },
  body,
});

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
  // peer-a is denied, a card is raised for it.
  assert.equal((await gate("peer-a")).ok, false);
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-a", toolName: "fw_play" });
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
  await remedy({ capability: "funkwhale", requestingInstance: "peer-e", days: 30 }, { db });
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-e", { now: t0 + 29 * DAY }), true);
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-e", { now: t0 + 31 * DAY }), false);

  // The GATE honours the injected clock too (not just the storage helper).
  assert.equal((await gate("peer-e", { now: t0 + 29 * DAY })).ok, true);
  assert.equal((await gate("peer-e", { now: t0 + 31 * DAY })).ok, false);
});

test('"until I remove it" never expires', async () => {
  const t0 = Date.now();
  await remedy({ capability: "funkwhale", requestingInstance: "peer-f", untilRemoved: true }, { db });
  assert.equal((await getPeerExposures(db)).get("peer-f").get("funkwhale").expiresAt, null);
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-f", { now: t0 + 3650 * DAY }), true);
  assert.equal((await gate("peer-f", { now: t0 + 3650 * DAY })).ok, true);
});

test("an expired grant is still stored (Settings can renew or remove it) and a malformed expiry fails closed", async () => {
  const t0 = Date.now();
  await remedy({ capability: "funkwhale", requestingInstance: "peer-g", days: 7 }, { db });
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
  await remedy({ capability: "funkwhale", requestingInstance: "peer-abc123", days: 1 }, { db });
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
  await writeSetting(db, "remote_exposed_tools", JSON.stringify(["crow-memory", "crow-blog"]), { scope: "local" });
  const before = (await db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = 'remote_exposed_tools'", args: [] })).rows[0].value;

  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-z" });
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
      peerName: "Victim Device", instanceAuth: { instance: { id: "verified-peer" }, peerName: "Victim Device" },
    },
    res, db, connectedServers: CONNECTED, auditFn: async () => {},
  });
  assert.equal(denied, false);
  const pending = await waitForPending((p) => p.length === 1);
  const card = pending[0];

  assert.equal(card.context.requestingInstance, "verified-peer");
  assert.equal(card.dedupKey, "expose:funkwhale:verified-peer");
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
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-b7" });
  let card = (await store.listPending(db))[0];
  assert.deepEqual(card.remedies.map((r) => r.actionId),
    ["expose-capability-30d", "expose-capability-7d", "expose-capability-forever"]);

  await clickAllow(card, "expose-capability-7d");
  const seven = (await getPeerExposures(db)).get("peer-b7").get("funkwhale");
  const days = (Date.parse(seven.expiresAt) - Date.now()) / DAY;
  assert.ok(days > 6.9 && days < 7.1, `7-day button grants 7 days, got ${days}`);

  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "crow-memory", requestingInstance: "peer-b7" });
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