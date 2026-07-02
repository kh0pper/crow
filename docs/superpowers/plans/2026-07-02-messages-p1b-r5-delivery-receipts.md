# Messages Phase 1b R5 — Delivery Receipts + Sender Retry Queue (+ self-hosted relay)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A DM sent while the recipient is offline/asleep, or dropped by public-relay retention roulette, is recovered instead of silently lost — the recipient confirms actual receipt (sender flips `relayed`→`delivered`, ✓→✓✓), and the sender re-publishes the exact unacked event on a ~60h backoff until acked or expired. A long-retention self-hosted relay (product-wide default) shrinks the offline window toward zero.

**Architecture:** Three composing layers. (1) **Delivery receipts** — on receipt of a plain DM from an established contact, the recipient sends a `crow_social`/`delivery_receipt` control envelope back (publish-only, never a 1:1 row); the sender routes it through the existing `subscribeToIncoming`→`onSocialMessage` path and flips `messages.delivery_status` to `delivered`, bound to the acking contact so a receipt can't be forged for another contact's messages. (2) **Sender retry queue** — a persisted `message_retry_queue` holding the *exact serialized signed event* (re-encrypting would change `event.id` and defeat recipient dedup); an unref'd backoff loop in `NostrManager` re-publishes due rows until acked (row deleted) or expired (~60h). (3) **Self-hosted relay** — a long-retention nostr-rs-relay on the maestro.press droplet, added to `DEFAULT_RELAYS` so every install uses it with zero handshake changes; operator-gated infra shipped separately (Task 6). Layers 1–2 (Tasks 1–5) are a self-contained, mergeable branch that ships the receipts/✓✓/retry-clear/forgery mechanism and recovers the **recipient-restart** case (a contact sub re-fetches full history with no `since` on reconnect, so a still-relay-retained message arrives and is acked). It does **not** by itself deliver the full offline (L1) guarantee for long or transient-socket-drop outages: a retry re-publishes the event with its **original `created_at`**, and age-based public-relay eviction (plus `since`-windowed live re-subscribes) can filter it out. **Layer 3 (Task 6) is what completes the L1 fix** — a relay we control retains the event until the recipient reconnects — so it is strongly recommended, sequenced as a separate operator-gated infra PR.

**Tech Stack:** Node ESM, `@libsql/client`, `nostr-tools` (NIP-44, kind:4), Node built-in test runner. Docker (nostr-rs-relay) for the relay. No new npm dependencies in the crow repo.

## Global Constraints

- **Commit with a positional path arg**: `git commit <path> -m "..."`, never `git add <path> && git commit`. Verify with `git show --stat HEAD` after each commit. There is substantial untracked WIP in the tree (`bundles/`, `bots/`, `scripts/`) — never sweep it.
- **`git pull --rebase` before any push** — parallel sessions push to `main`.
- **Never attribute Claude as a co-author** and never add Claude as a contributor.
- **Tests**: `node --test tests/<file>.test.js`. Full suite must stay green (`node --test tests/` — 939/939 on `main` as of `c1d01f55`).
- **Schema migrations**: this plan adds the `message_retry_queue` table, so **BUMP `SCHEMA_GENERATION` in `servers/shared/schema-version.js` from `2` to `3`** (Task 1). The boot gate then auto-applies it on a plain restart (validated live in R2 user_version 1→2 and R4). Do **not** add any other bump.
- **Never throw on the receive path**: the `onevent` closures, `onSocialMessage`, and the retry loop must be fully guarded — a throw kills the Nostr subscription and breaks all delivery. Emit the ack **fire-and-forget** (`Promise.resolve(...).catch(()=>{})`, the `_startHealthLoop` idiom at `nostr.js:224`) so a slow/failed publish never blocks or throws inside `onevent`.
- **Trust boundary (from L6/R4)**: `request_status IS NULL` = full contact; `'pending'`/`'accepted'` = gated partial. R5 adds no promotion. Receipts are emitted **only** for DMs received on the established-contact path (`subscribeToContact`), **never** for the unknown-sender `onMessageRequest` path (acking a stranger confirms receipt to them).
- **Pubkey normalization**: match secp256k1 keys on the trailing-64-hex lowercased form (`normalizePubkey` / `findContactByPubkey` in `servers/sharing/pubkey-util.js`). A stored key is 66-hex compressed (`02`/`03`); a Nostr `event.pubkey` is 64-hex x-only.
- **`delivery_status` is a nullable TEXT with NO CHECK** (`init-db.js:554`, added via `addColumnIfMissing`; the CHECK-constrained `delivery_status` at `init-db.js:488/515` is the unrelated `shared_items` table). Both `'relayed'` and `'delivered'` write cleanly on fresh + existing installs. Received rows stay NULL; only `direction='sent'` rows carry a status.

---

## Background — the exact code being changed (verified @ `main` c1d01f55)

**Send path.** `NostrManager.sendMessage(contact, content)` (`servers/sharing/nostr.js:127`): NIP-44-encrypts, `finalizeEvent` (kind:4), publishes to every connected relay via `safeRelayPublish`, then caches a `messages` row with `delivery_status = published.length > 0 ? 'relayed' : 'failed'` and `nostr_event_id = event.id`. Returns `{ eventId, relays: published }`. **R5 enqueues a retry row here when the send is a genuine 1:1 DM that relayed.** Note `crow_send_message` calls it with plain text (`tools/messaging.js:44`) but `crow_send_group_message` calls it with a `crow_social` JSON envelope (`tools/messaging.js:204`) — the enqueue must skip the latter (the recipient early-returns on `crow_social` and never acks it).

**Control send path.** `NostrManager.sendControl(contact, content)` (`nostr.js:197`): sends a kind:4 DM **without** caching a `messages` row — the correct primitive for the `delivery_receipt` envelope. Same publish-to-all-relays behavior; returns `{ eventId, relays }`.

**Established-contact receive path.** `subscribeToContact`'s `onevent` (`nostr.js:250-306`): decrypts; **returns early** if the payload is `invite_accepted`/`crow_social` (`nostr.js:261`); otherwise `INSERT OR IGNORE INTO messages (...'received'...)`, and on `rowsAffected > 0` fires a notification + `bus.emit("messages:changed", { contactId, unread })` (`nostr.js:292`). **R5 emits the ack here** — for both new and duplicate receipts (a dup means a retry re-delivered; re-acking self-heals a lost ack). The `contact` closure param carries `secp256k1_pubkey`.

**Broad incoming receive path.** `subscribeToIncoming(onInviteAccepted, onSocialMessage, onMessageRequest)` (`nostr.js:384-466`): filter `{ kinds:[4], "#p":[ownPubkey] }`; routes `crow_social` (with subtype) → `onSocialMessage(subtype, payload.payload, senderPubkey)` (`nostr.js:421-423`). **The sender receives the ack here** (its own pubkey is `#p` on the receipt event). Ends by calling `this._startHealthLoop()` (`nostr.js:465`) — **R5 also calls `this._startRetryLoop()` here.**

**Social handler.** `boot.js:355-465` — the `onSocialMessage` callback (a big `if (subtype === ...)` ladder). **R5 adds a `subtype === "delivery_receipt"` branch** delegating to an exported `handleDeliveryReceipt(db, eventIds, senderPubkey)`.

**Relay set.** `DEFAULT_RELAYS` (`nostr.js:42-46`, currently 3: damus/nos.lol/primal). `getConfiguredRelays()` (`nostr.js:476`) **merges** defaults with enabled `relay_config` rows (defaults always a floor). **Task 6 adds the maestro relay URL to `DEFAULT_RELAYS`.**

**Health-loop idiom.** `_startHealthLoop()` (`nostr.js:216-230`): idempotent (`if (this._healthTimer) return`), `setInterval` (env `CROW_NOSTR_HEALTH_MS` || 45000), `.unref()`, wraps each async call in `Promise.resolve(...).catch(()=>{})`. **`_startRetryLoop()` mirrors this exactly.** Constructor initializes `this._healthTimer = null` (`nostr.js:55`) — R5 adds `this._retryTimer = null`.

**Client rendering (already shipped, R2 Task 4).** `panels/messages/client.js:1157-1163`: `delivery_status === 'failed'` → failed style; `'relayed'|'delivered'` → a check indicator; `'delivered'` renders `✓✓`, `'relayed'` renders `✓`. Flipping the column to `'delivered'` lights ✓✓ **on the sender's next thread reload/refetch** (the column is read on fetch). Note the `messages:changed` SSE consumer (`servers/gateway/routes/streams.js`) is **badge-only** — it does not re-render message bubbles (live message-body updates are a deferred plan), so R5 does **not** emit it from the ack handler (doing so would also clobber the peer's unread badge, since that consumer reads `payload.unread ?? 0`). ✓✓ is reload-correct, which is sufficient.

---

## File Structure

- **Create** `servers/sharing/retry-queue.js` — the delivery-reliability module (one responsibility: durable outbound-DM delivery state). Exports: `DELIVERY_RECEIPT_SUBTYPE`, `buildDeliveryReceipt`, `shouldEnqueue`, `backoffSeconds`, `enqueueRetry`, `dueRetries`, `recordAttempt`, `markDelivered`. Pure helpers + guarded DB helpers.
- **Modify** `scripts/init-db.js` — add the `message_retry_queue` table + index (after the `messages` block, ~`:554`).
- **Modify** `servers/shared/schema-version.js` — `SCHEMA_GENERATION` `2`→`3`.
- **Modify** `servers/sharing/nostr.js` — constructor `_retryTimer` field; `sendMessage` enqueue; `_startRetryLoop()` + `_runRetryTick()`; `_sendDeliveryReceipt()`; ack emit in `subscribeToContact`'s `onevent`; start the loop in `subscribeToIncoming`.
- **Modify** `servers/sharing/boot.js` — export `handleDeliveryReceipt`; add the `delivery_receipt` branch to `onSocialMessage`.
- **Create** tests: `tests/message-retry-queue.test.js`, `tests/nostr-retry-loop.test.js`, `tests/delivery-receipt-emit.test.js`, `tests/delivery-receipt-handler.test.js`.
- **Modify** (Task 6, separate PR) `servers/sharing/nostr.js` `DEFAULT_RELAYS` + `docs/architecture/sharing-server.md` (relay note) + a network-exposure note.

---

## Task 1: `message_retry_queue` table + SCHEMA_GENERATION bump + `retry-queue.js` core

**Files:**
- Create: `servers/sharing/retry-queue.js`
- Modify: `scripts/init-db.js` (after `:554`)
- Modify: `servers/shared/schema-version.js` (`:13`)
- Test: `tests/message-retry-queue.test.js`

**Interfaces:**
- Consumes: `@libsql/client` DB (`.execute`); `normalizePubkey` (`servers/sharing/pubkey-util.js`).
- Produces (all guarded — never throw except where noted; DB errors resolve to a safe default):
  - `DELIVERY_RECEIPT_SUBTYPE : "delivery_receipt"` (const).
  - `buildDeliveryReceipt(eventIds: string[]) : string` — pure; returns `JSON.stringify({ type:"crow_social", version:1, subtype:"delivery_receipt", payload:{ event_ids: [...] } })`. Filters non-string/empty ids.
  - `shouldEnqueue({ content, publishedCount, recipientNorm, ownNorm }) : boolean` — pure. True iff `publishedCount > 0` AND `recipientNorm !== ownNorm` (skip self-messages) AND `content` is **not** a `crow_social`/`invite_accepted` envelope (parse `content`; if it starts with `{` and parses to `{type:"crow_social"|"invite_accepted"}` → false). Mirrors the recipient's store+ack eligibility so enqueue ⟺ the recipient will ack.
  - `backoffSeconds(attempt: number) : number` — pure. `attempt >= 1`; returns the delay before the *next* attempt from a fixed schedule `[30, 120, 600, 3600, 14400, 43200]` (30s, 2m, 10m, 1h, 4h, 12h), clamped to the last entry for higher attempts (every 12h thereafter).
  - `enqueueRetry(db, { eventId, contactId, recipientPubkey, rawEvent, nowSec }) : Promise<void>` — `INSERT OR IGNORE` a row with `attempt_count=0`, `next_attempt_at = nowSec + backoffSeconds(1)`, `created_at = nowSec`. Guarded.
  - `dueRetries(db, nowSec, limit=50) : Promise<row[]>` — rows with `next_attempt_at <= nowSec`, `ORDER BY next_attempt_at ASC LIMIT limit`. Guarded → `[]`.
  - `recordAttempt(db, row, nowSec, maxAgeSec) : Promise<{expired:boolean}>` — if `row.created_at < nowSec - maxAgeSec` → `DELETE` the row, return `{expired:true}`; else `UPDATE attempt_count = attempt_count+1, next_attempt_at = nowSec + backoffSeconds(row.attempt_count + 1)`, return `{expired:false}`. Guarded → `{expired:false}` on error (leaves the row for a later tick).
  - `markDelivered(db, eventIds, contactId) : Promise<void>` — `DELETE FROM message_retry_queue WHERE contact_id = ? AND nostr_event_id IN (...)`. **Contact-bound** so a forged receipt can't purge another contact's retries. No-op on empty `eventIds`. Guarded.

- [ ] **Step 1: Write the failing test**

Create `tests/message-retry-queue.test.js`:
```js
/**
 * message-retry-queue — R5 Task 1. The delivery-reliability primitives:
 * pure envelope/eligibility/backoff helpers + the persisted retry store
 * (enqueue / dueRetries / recordAttempt / markDelivered). Asserts the
 * eligibility sniff, backoff schedule, monotonic enqueue, due-selection,
 * expiry vs advance, and contact-bound deletion. Every DB helper is guarded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELIVERY_RECEIPT_SUBTYPE, buildDeliveryReceipt, shouldEnqueue, backoffSeconds,
  enqueueRetry, dueRetries, recordAttempt, markDelivered,
} from "../servers/sharing/retry-queue.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "retryq-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

// --- pure helpers ---

test("buildDeliveryReceipt makes a crow_social/delivery_receipt envelope", () => {
  const s = buildDeliveryReceipt(["e1", "e2", "", null, 5]);
  const p = JSON.parse(s);
  assert.equal(p.type, "crow_social");
  assert.equal(p.subtype, DELIVERY_RECEIPT_SUBTYPE);
  assert.deepEqual(p.payload.event_ids, ["e1", "e2"]); // non-string/empty dropped
});

test("shouldEnqueue: plain relayed DM to a peer → true", () => {
  assert.equal(shouldEnqueue({ content: "hi there", publishedCount: 1, recipientNorm: "a".repeat(64), ownNorm: "b".repeat(64) }), true);
});
test("shouldEnqueue: 0 relays → false", () => {
  assert.equal(shouldEnqueue({ content: "hi", publishedCount: 0, recipientNorm: "a".repeat(64), ownNorm: "b".repeat(64) }), false);
});
test("shouldEnqueue: self-message → false", () => {
  assert.equal(shouldEnqueue({ content: "hi", publishedCount: 2, recipientNorm: "a".repeat(64), ownNorm: "a".repeat(64) }), false);
});
test("shouldEnqueue: crow_social envelope (group msg) → false", () => {
  const env = JSON.stringify({ type: "crow_social", subtype: "group_message", payload: {} });
  assert.equal(shouldEnqueue({ content: env, publishedCount: 1, recipientNorm: "a".repeat(64), ownNorm: "b".repeat(64) }), false);
});
test("shouldEnqueue: invite_accepted envelope → false", () => {
  const env = JSON.stringify({ type: "invite_accepted", crowId: "crow:x" });
  assert.equal(shouldEnqueue({ content: env, publishedCount: 1, recipientNorm: "a".repeat(64), ownNorm: "b".repeat(64) }), false);
});
test("shouldEnqueue: a plain message that merely starts with '{' but isn't an envelope → true", () => {
  assert.equal(shouldEnqueue({ content: "{not json", publishedCount: 1, recipientNorm: "a".repeat(64), ownNorm: "b".repeat(64) }), true);
});

test("backoffSeconds follows the schedule and clamps", () => {
  assert.equal(backoffSeconds(1), 30);
  assert.equal(backoffSeconds(2), 120);
  assert.equal(backoffSeconds(4), 3600);
  assert.equal(backoffSeconds(6), 43200);
  assert.equal(backoffSeconds(99), 43200); // clamp to every-12h
  assert.equal(backoffSeconds(0), 30);     // guard: treated as first
});

// --- persisted store ---

async function seedContact(db, id, secp) {
  await db.execute({
    sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
          VALUES (?, ?, 'Peer', '', ?, 'crow')`,
    args: [id, "crow:peer" + id, secp],
  });
}

test("enqueueRetry inserts a due-in-30s row; dueRetries respects next_attempt_at", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = 1_800_000_000;
    await enqueueRetry(db, { eventId: "evt1", contactId: 1, recipientPubkey: "a".repeat(64), rawEvent: '{"id":"evt1"}', nowSec: now });
    assert.equal((await dueRetries(db, now, 50)).length, 0, "not due yet (30s out)");
    const due = await dueRetries(db, now + 31, 50);
    assert.equal(due.length, 1);
    assert.equal(due[0].nostr_event_id, "evt1");
    assert.equal(Number(due[0].attempt_count), 0);
  } finally { cleanup(); }
});

test("enqueueRetry is idempotent on event id (INSERT OR IGNORE)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = 1_800_000_000;
    await enqueueRetry(db, { eventId: "evtDup", contactId: 1, recipientPubkey: "a".repeat(64), rawEvent: "{}", nowSec: now });
    await enqueueRetry(db, { eventId: "evtDup", contactId: 1, recipientPubkey: "a".repeat(64), rawEvent: "{}", nowSec: now });
    const { rows } = await db.execute({ sql: "SELECT COUNT(*) c FROM message_retry_queue WHERE nostr_event_id='evtDup'", args: [] });
    assert.equal(Number(rows[0].c), 1);
  } finally { cleanup(); }
});

test("recordAttempt advances backoff below max age, expires (deletes) past it", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = 1_800_000_000;
    await enqueueRetry(db, { eventId: "evtA", contactId: 1, recipientPubkey: "a".repeat(64), rawEvent: "{}", nowSec: now });
    const row = (await dueRetries(db, now + 31, 50))[0];
    const r1 = await recordAttempt(db, row, now + 31, 216000); // maxAge 60h
    assert.equal(r1.expired, false);
    const after = (await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtA'", args: [] })).rows[0];
    assert.equal(Number(after.attempt_count), 1);
    // recordAttempt sets attempt_count = old+1 (=1) and schedules the NEXT
    // retry: backoffSeconds((old+1)+1) = backoffSeconds(2) = 120.
    assert.equal(Number(after.next_attempt_at), (now + 31) + backoffSeconds(2));
    // now force expiry: created_at far in the past
    const r2 = await recordAttempt(db, { ...after, created_at: now - 999999 }, now + 40, 216000);
    assert.equal(r2.expired, true);
    const gone = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtA'", args: [] });
    assert.equal(gone.rows.length, 0, "expired row deleted");
  } finally { cleanup(); }
});

test("markDelivered is contact-bound: only deletes the acking contact's rows", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    await seedContact(db, 2, "02" + "b".repeat(64));
    const now = 1_800_000_000;
    await enqueueRetry(db, { eventId: "mine", contactId: 1, recipientPubkey: "a".repeat(64), rawEvent: "{}", nowSec: now });
    await enqueueRetry(db, { eventId: "other", contactId: 2, recipientPubkey: "b".repeat(64), rawEvent: "{}", nowSec: now });
    // An attacker (contact 2) tries to purge contact 1's retry by naming its event id.
    await markDelivered(db, ["mine"], 2);
    assert.equal((await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='mine'", args: [] })).rows.length, 1, "contact 1's row untouched");
    // The legit ack from contact 1 clears it.
    await markDelivered(db, ["mine"], 1);
    assert.equal((await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='mine'", args: [] })).rows.length, 0);
  } finally { cleanup(); }
});

test("guards: DB helpers never throw on a broken db", async () => {
  const broken = { execute: async () => { throw new Error("boom"); } };
  await enqueueRetry(broken, { eventId: "x", contactId: 1, recipientPubkey: "a", rawEvent: "{}", nowSec: 1 });
  assert.deepEqual(await dueRetries(broken, 1, 50), []);
  assert.deepEqual(await recordAttempt(broken, { created_at: 0, attempt_count: 0, id: 1 }, 2, 10), { expired: false });
  await markDelivered(broken, ["x"], 1); // must not throw
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/message-retry-queue.test.js`
Expected: FAIL — `Cannot find module '../servers/sharing/retry-queue.js'`.

- [ ] **Step 3: Create the module**

Create `servers/sharing/retry-queue.js`:
```js
/**
 * Delivery reliability for Crow Messages (R5).
 *
 * One responsibility: durable outbound-DM delivery state so a message a
 * recipient did not receive (offline/asleep, or evicted by public-relay
 * retention) is recovered instead of silently lost.
 *
 *  - buildDeliveryReceipt / DELIVERY_RECEIPT_SUBTYPE — the crow_social ack
 *    the recipient publishes on receipt; the sender flips relayed→delivered.
 *  - shouldEnqueue / backoffSeconds — pure send-side policy.
 *  - enqueueRetry / dueRetries / recordAttempt / markDelivered — the persisted
 *    message_retry_queue (holds the EXACT serialized signed event so a retry
 *    re-publishes the same event.id and the recipient dedups it).
 *
 * Every DB helper is guarded — the receive path and the retry loop must never
 * throw.
 */

import { normalizePubkey } from "./pubkey-util.js";

export const DELIVERY_RECEIPT_SUBTYPE = "delivery_receipt";

// Delay (seconds) before the Nth retry. Attempt 1 fires ~30s after send; the
// tail repeats every 12h until the ~60h expiry (see recordAttempt's maxAgeSec).
const BACKOFF_SCHEDULE = [30, 120, 600, 3600, 14400, 43200];

/** Pure: the crow_social envelope the recipient sends to confirm receipt. */
export function buildDeliveryReceipt(eventIds) {
  const ids = (Array.isArray(eventIds) ? eventIds : [])
    .filter((x) => typeof x === "string" && x.length > 0);
  return JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: DELIVERY_RECEIPT_SUBTYPE,
    payload: { event_ids: ids },
  });
}

/**
 * Pure: is this send retry-eligible? True only for a genuine 1:1 DM that
 * reached >=1 relay, is not addressed to ourselves, and is not a crow_social /
 * invite_accepted control envelope (those are never stored or acked by the
 * recipient, so a retry would loop forever until expiry). Mirrors the
 * recipient's store+ack eligibility so enqueue <=> "the recipient will ack".
 */
export function shouldEnqueue({ content, publishedCount, recipientNorm, ownNorm }) {
  if (!(publishedCount > 0)) return false;
  if (recipientNorm && ownNorm && recipientNorm === ownNorm) return false;
  if (typeof content === "string" && content.startsWith("{")) {
    try {
      const t = JSON.parse(content)?.type;
      if (t === "crow_social" || t === "invite_accepted") return false;
    } catch {
      // starts with "{" but isn't JSON → a plain message; enqueue it.
    }
  }
  return true;
}

/** Pure: delay before attempt N (N>=1), clamped to the last schedule entry. */
export function backoffSeconds(attempt) {
  const i = Math.max(1, Math.floor(Number(attempt) || 1)) - 1;
  return BACKOFF_SCHEDULE[Math.min(i, BACKOFF_SCHEDULE.length - 1)];
}

/** Persist an unacked outbound DM for retry. INSERT OR IGNORE (event id unique). */
export async function enqueueRetry(db, { eventId, contactId, recipientPubkey, rawEvent, nowSec }) {
  try {
    if (!db || !eventId || !rawEvent) return;
    await db.execute({
      sql: `INSERT OR IGNORE INTO message_retry_queue
              (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)`,
      args: [eventId, contactId ?? null, recipientPubkey ?? null, rawEvent,
             Math.floor(nowSec) + backoffSeconds(1), Math.floor(nowSec)],
    });
  } catch {
    // Retry is an optimization; a queue-write failure must not break send.
  }
}

/** Rows whose next attempt is due. Guarded → []. */
export async function dueRetries(db, nowSec, limit = 50) {
  try {
    if (!db) return [];
    const { rows } = await db.execute({
      sql: `SELECT * FROM message_retry_queue WHERE next_attempt_at <= ?
            ORDER BY next_attempt_at ASC LIMIT ?`,
      args: [Math.floor(nowSec), limit],
    });
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * After a republish: expire the row (delete) if older than maxAgeSec, else
 * advance attempt_count + reschedule. Guarded → {expired:false} (leave for a
 * later tick).
 */
export async function recordAttempt(db, row, nowSec, maxAgeSec) {
  try {
    if (!db || !row) return { expired: false };
    if (Number(row.created_at) < Math.floor(nowSec) - maxAgeSec) {
      await db.execute({ sql: "DELETE FROM message_retry_queue WHERE id = ?", args: [row.id] });
      return { expired: true };
    }
    const nextAttempt = Number(row.attempt_count) + 1;
    await db.execute({
      sql: `UPDATE message_retry_queue SET attempt_count = ?, next_attempt_at = ? WHERE id = ?`,
      args: [nextAttempt, Math.floor(nowSec) + backoffSeconds(nextAttempt + 1), row.id],
    });
    return { expired: false };
  } catch {
    return { expired: false };
  }
}

/**
 * Clear retry rows for delivered events — CONTACT-BOUND so a forged receipt
 * naming another contact's event ids cannot purge that contact's retries.
 */
export async function markDelivered(db, eventIds, contactId) {
  try {
    const ids = (Array.isArray(eventIds) ? eventIds : []).filter((x) => typeof x === "string" && x);
    if (!db || ids.length === 0 || contactId == null) return;
    const placeholders = ids.map(() => "?").join(",");
    await db.execute({
      sql: `DELETE FROM message_retry_queue WHERE contact_id = ? AND nostr_event_id IN (${placeholders})`,
      args: [contactId, ...ids],
    });
  } catch {
    // Best-effort cleanup; the row will otherwise expire on its own.
  }
}

// normalizePubkey re-exported for callers that compute recipient/own norms.
export { normalizePubkey };
```

- [ ] **Step 4: Add the table to `scripts/init-db.js`**

Immediately after the `addColumnIfMissing("messages", "delivery_status", "TEXT")` line (`init-db.js:554`), add:
```js
// R5: persisted retry queue for unacked outbound DMs. Holds the EXACT
// serialized signed Nostr event so a retry re-publishes the same event.id and
// the recipient's INSERT OR IGNORE dedups it. A row exists <=> awaiting a
// delivery receipt; it is deleted on ack (markDelivered) or expiry (~60h).
await initTable("message_retry_queue table", `
  CREATE TABLE IF NOT EXISTS message_retry_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nostr_event_id TEXT UNIQUE NOT NULL,
    contact_id INTEGER,
    recipient_pubkey TEXT,
    raw_event TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_retry_next ON message_retry_queue(next_attempt_at);
`);
```

- [ ] **Step 5: Bump `SCHEMA_GENERATION`**

In `servers/shared/schema-version.js`, change line 13:
```js
export const SCHEMA_GENERATION = 3;
```
(Was `2`. The boot gate re-runs `init-db` when `user_version < SCHEMA_GENERATION`, creating the new table on a plain restart.)

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/message-retry-queue.test.js`
Expected: PASS (all cases). If `init-db.js` errored, the `freshDb()` harness will surface it.

- [ ] **Step 7: Commit**

```bash
git commit servers/sharing/retry-queue.js scripts/init-db.js servers/shared/schema-version.js tests/message-retry-queue.test.js -m "feat(messages): message_retry_queue table + retry-queue delivery primitives (R5 Task 1)"
git show --stat HEAD
```

---

## Task 2: Sender enqueue in `sendMessage` + `_startRetryLoop` republish loop

**Files:**
- Modify: `servers/sharing/nostr.js` (constructor `:55`; `sendMessage` `:127-191`; new `_startRetryLoop`/`_runRetryTick` near `_startHealthLoop` `:216`; start it in `subscribeToIncoming` `:465`)
- Test: `tests/nostr-retry-loop.test.js`

**Interfaces:**
- Consumes: `shouldEnqueue`, `enqueueRetry`, `dueRetries`, `recordAttempt`, `normalizePubkey` (Task 1); `safeRelayPublish` (`nostr.js:31`).
- Produces:
  - `sendMessage` enqueues via `enqueueRetry` when `shouldEnqueue(...)` — after the local-cache write, using the just-built `event` (`JSON.stringify(event)` = `rawEvent`), `contactId`, `published.length`, and the normalized recipient/own pubkeys.
  - `NostrManager._runRetryTick() : Promise<void>` — testable tick body: fetch `dueRetries`, re-publish each row's `raw_event` (parsed) to all `this.relays` via `safeRelayPublish`, then `recordAttempt`. A row whose `raw_event` won't parse is dropped via a direct `DELETE ... WHERE id=?` (not `markDelivered`, which no-ops on a NULL `contact_id`). Never throws.
  - `NostrManager._startRetryLoop() : void` — idempotent unref'd `setInterval` (env `CROW_NOSTR_RETRY_MS` || 60000) invoking `_runRetryTick` wrapped in `Promise.resolve(...).catch(()=>{})`. Reads `CROW_NOSTR_RETRY_MAX_AGE_SEC` || `216000` (~60h) for `_runRetryTick`'s expiry.

- [ ] **Step 1: Write the failing test**

Create `tests/nostr-retry-loop.test.js`:
```js
/**
 * nostr-retry-loop — R5 Task 2. _runRetryTick re-publishes due retry rows to
 * the connected relays (the EXACT stored event) and advances/expires them.
 * Uses a real DB + a fake relay map; asserts republish happened, backoff
 * advanced, an expired row was dropped, and a corrupt raw_event is purged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NostrManager } from "../servers/sharing/nostr.js";
import { enqueueRetry } from "../servers/sharing/retry-queue.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "retryloop-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

async function seedContact(db, id, secp) {
  await db.execute({
    sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
          VALUES (?, ?, 'Peer', '', ?, 'crow')`,
    args: [id, "crow:peer" + id, secp],
  });
}

// A NostrManager with a fake relay that records published events, no real net.
function fakeManager(db) {
  const identity = { secp256k1Pubkey: "b".repeat(64), secp256k1Priv: new Uint8Array(32) };
  const m = new NostrManager(identity, db);
  const published = [];
  m.relays = new Map([["wss://fake", { connected: true, connect: async () => {}, publish: async (e) => { published.push(e); } }]]);
  return { m, published };
}

test("_runRetryTick republishes a due row and advances its backoff", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = Math.floor(Date.now() / 1000);
    const evt = { id: "evtRetry", kind: 4, content: "cipher", tags: [["p", "a".repeat(64)]] };
    // Enqueue with a next_attempt_at already in the past so it's due now.
    await db.execute({
      sql: `INSERT INTO message_retry_queue (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at)
            VALUES (?, 1, ?, ?, 0, ?, ?)`,
      args: ["evtRetry", "a".repeat(64), JSON.stringify(evt), now - 5, now - 5],
    });
    const { m, published } = fakeManager(db);
    await m._runRetryTick();
    assert.equal(published.length, 1, "republished once");
    assert.equal(published[0].id, "evtRetry", "the EXACT stored event");
    const { rows } = await db.execute({ sql: "SELECT attempt_count FROM message_retry_queue WHERE nostr_event_id='evtRetry'", args: [] });
    assert.equal(Number(rows[0].attempt_count), 1, "attempt advanced");
  } finally { cleanup(); }
});

test("_runRetryTick expires (deletes) a row older than the max age", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO message_retry_queue (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at)
            VALUES (?, 1, ?, ?, 9, ?, ?)`,
      args: ["evtOld", "a".repeat(64), JSON.stringify({ id: "evtOld" }), now - 5, now - 999999],
    });
    const { m } = fakeManager(db);
    await m._runRetryTick();
    const { rows } = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtOld'", args: [] });
    assert.equal(rows.length, 0, "expired row deleted");
  } finally { cleanup(); }
});

test("_runRetryTick purges a corrupt raw_event without throwing", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, 1, "02" + "a".repeat(64));
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO message_retry_queue (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at)
            VALUES (?, 1, ?, ?, 0, ?, ?)`,
      args: ["evtBad", "a".repeat(64), "{not valid json", now - 5, now - 5],
    });
    const { m, published } = fakeManager(db);
    await m._runRetryTick();
    assert.equal(published.length, 0, "nothing republished for a corrupt row");
    const { rows } = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtBad'", args: [] });
    assert.equal(rows.length, 0, "corrupt row purged");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/nostr-retry-loop.test.js`
Expected: FAIL — `m._runRetryTick is not a function`.

- [ ] **Step 3: Add the retry loop + tick to `NostrManager`**

In `servers/sharing/nostr.js`, add the import to the existing `contact-promote` import line region (near `:33`):
```js
import { shouldEnqueue, enqueueRetry, dueRetries, recordAttempt, buildDeliveryReceipt, normalizePubkey } from "./retry-queue.js";
```
In the constructor (after `this._healthTimer = null;` at `:55`):
```js
    this._retryTimer = null; // single backoff loop re-publishing unacked DMs
```
Add these two methods immediately after `_startHealthLoop()` (after `nostr.js:230`):
```js
  /**
   * One retry pass: re-publish every due unacked DM (the EXACT stored signed
   * event, so the recipient dedups) to the connected relays, then advance or
   * expire it. A row whose raw_event won't parse is dropped. Never throws.
   */
  async _runRetryTick() {
    const maxAgeSec = Number(process.env.CROW_NOSTR_RETRY_MAX_AGE_SEC) || 216000; // ~60h
    const nowSec = Math.floor(Date.now() / 1000);
    let due;
    try { due = await dueRetries(this.db, nowSec, 50); } catch { return; }
    for (const row of due) {
      let event;
      try { event = JSON.parse(row.raw_event); } catch { event = null; }
      if (!event || !event.id) {
        // Corrupt payload — cannot republish. Delete by primary key directly
        // (NOT contact-bound markDelivered, which no-ops on a NULL contact_id
        // and would leave the row re-selected every tick forever).
        try { await this.db.execute({ sql: "DELETE FROM message_retry_queue WHERE id = ?", args: [row.id] }); } catch {}
        continue;
      }
      // Advance/expire even if every relay was down this tick (bounded by the
      // 12h tail + ~60h expiry) — avoids a tight re-publish loop during an outage.
      for (const [, relay] of this.relays) {
        try { await safeRelayPublish(relay, event); } catch { /* relay best-effort */ }
      }
      try { await recordAttempt(this.db, row, nowSec, maxAgeSec); } catch {}
    }
  }

  /**
   * Start the single periodic retry loop (idempotent, unref'd). Re-publishes
   * unacked DMs on a backoff until a delivery receipt clears them or they
   * expire. Mirrors _startHealthLoop — a stray rejection can never escape.
   */
  _startRetryLoop() {
    if (this._retryTimer) return;
    const ms = Number(process.env.CROW_NOSTR_RETRY_MS) || 60000;
    this._retryTimer = setInterval(() => {
      Promise.resolve(this._runRetryTick()).catch(() => {});
    }, ms);
    if (this._retryTimer.unref) this._retryTimer.unref();
  }
```

- [ ] **Step 4: Enqueue in `sendMessage`**

In `sendMessage` (`nostr.js:127-191`), after the local-cache `INSERT INTO messages` block (after the closing `}` of `if (contactId && this.db) { ... }` at `nostr.js:185`, before `return { eventId: event.id, relays: published };`), add:
```js
    // R5: if this genuine 1:1 DM reached >=1 relay, enqueue it for retry until
    // the recipient acks (delivery receipt) or it expires (~60h). Skips 0-relay
    // sends, self-messages, and crow_social/invite_accepted control envelopes
    // (the recipient never stores/acks those). Best-effort — never throws.
    try {
      const ownNorm = normalizePubkey(this.pubkey || "");
      const recipientNorm = normalizePubkey(recipientPubkey || "");
      if (contactId && this.db &&
          shouldEnqueue({ content, publishedCount: published.length, recipientNorm, ownNorm })) {
        await enqueueRetry(this.db, {
          eventId: event.id,
          contactId,
          recipientPubkey,
          rawEvent: JSON.stringify(event),
          nowSec: Math.floor(Date.now() / 1000),
        });
      }
    } catch { /* enqueue is best-effort */ }
```
(`recipientPubkey` is the x-only key computed at `nostr.js:132-138`; `content`, `published`, `contactId` are all in scope.)

- [ ] **Step 5: Start the loop in `subscribeToIncoming`**

In `subscribeToIncoming`, change the tail (`nostr.js:465`) from:
```js
    this._startHealthLoop();
  }
```
to:
```js
    this._startHealthLoop();
    this._startRetryLoop();
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/nostr-retry-loop.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Regression + commit**

Run: `node --test tests/nostr-retry-loop.test.js tests/message-retry-queue.test.js tests/nostr-resubscribe.test.js`
Expected: PASS (all).
```bash
git commit servers/sharing/nostr.js tests/nostr-retry-loop.test.js -m "feat(messages): enqueue unacked DMs + backoff retry loop republishing the exact event (R5 Task 2)"
git show --stat HEAD
```

---

## Task 3: Recipient emits a `delivery_receipt` on receipt (`subscribeToContact`)

**Files:**
- Modify: `servers/sharing/nostr.js` (new `_sendDeliveryReceipt` method; call it in `subscribeToContact`'s `onevent`, `nostr.js:269-302`)
- Test: `tests/delivery-receipt-emit.test.js`

**Interfaces:**
- Consumes: `buildDeliveryReceipt` (Task 1); `sendControl` (`nostr.js:197`).
- Produces:
  - `NostrManager._sendDeliveryReceipt(contact, eventId) : Promise<void>` — builds the `delivery_receipt` envelope and publishes it to `contact` via `sendControl`. Never throws.
  - `onevent` in `subscribeToContact` fires `_sendDeliveryReceipt(contact, event.id)` **fire-and-forget** for every plain-DM receipt (new **or** duplicate), so a lost ack self-heals on the next retry. Not emitted for the `crow_social`/`invite_accepted` early-return (those aren't conversation).

- [ ] **Step 1: Write the failing test**

Create `tests/delivery-receipt-emit.test.js`:
```js
/**
 * delivery-receipt-emit — R5 Task 3. _sendDeliveryReceipt publishes a
 * crow_social/delivery_receipt control envelope (via sendControl) naming the
 * received event id, to the contact it came from. Stubs sendControl; asserts
 * the envelope shape + that a sendControl failure never throws.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NostrManager } from "../servers/sharing/nostr.js";
import { DELIVERY_RECEIPT_SUBTYPE } from "../servers/sharing/retry-queue.js";

function mgr() {
  return new NostrManager({ secp256k1Pubkey: "b".repeat(64), secp256k1Priv: new Uint8Array(32) }, null);
}

test("_sendDeliveryReceipt sends a delivery_receipt envelope for the event id", async () => {
  const m = mgr();
  const sent = [];
  m.sendControl = async (contact, content) => { sent.push({ contact, content }); return { eventId: "ack1", relays: ["r"] }; };
  await m._sendDeliveryReceipt({ id: 7, secp256k1_pubkey: "02" + "a".repeat(64) }, "evtX");
  assert.equal(sent.length, 1);
  const env = JSON.parse(sent[0].content);
  assert.equal(env.type, "crow_social");
  assert.equal(env.subtype, DELIVERY_RECEIPT_SUBTYPE);
  assert.deepEqual(env.payload.event_ids, ["evtX"]);
  assert.equal(sent[0].contact.id, 7);
});

test("_sendDeliveryReceipt never throws when sendControl rejects", async () => {
  const m = mgr();
  m.sendControl = async () => { throw new Error("relay down"); };
  await m._sendDeliveryReceipt({ id: 1, secp256k1_pubkey: "02" + "a".repeat(64) }, "evtY"); // must resolve, not reject
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/delivery-receipt-emit.test.js`
Expected: FAIL — `m._sendDeliveryReceipt is not a function`.

- [ ] **Step 3: Add `_sendDeliveryReceipt` and call it in `onevent`**

In `servers/sharing/nostr.js`, add the method after `_sendControl`-adjacent code (a natural spot is right after `sendControl` closes at `nostr.js:209`):
```js
  /**
   * R5: confirm receipt of a DM back to its sender. A crow_social control
   * envelope (never a 1:1 row) naming the received event id; the sender flips
   * relayed→delivered and stops retrying. Never throws (receive-path caller
   * fires this fire-and-forget).
   */
  async _sendDeliveryReceipt(contact, eventId) {
    try {
      if (!contact || !eventId) return;
      await this.sendControl(contact, buildDeliveryReceipt([eventId]));
    } catch {
      // Ack is best-effort; a lost ack self-heals on the sender's next retry.
    }
  }
```
Then, in `subscribeToContact`'s `onevent`, after the store block and before the `if (this.onMessage)` call — i.e. after the closing `}` of `if (contactId && this.db) { ... }` at `nostr.js:298`, insert:
```js
            // R5: confirm receipt to the sender (new OR duplicate — a dup means
            // a retry re-delivered, and re-acking self-heals a lost ack).
            // Fire-and-forget: never block or throw inside onevent.
            Promise.resolve(this._sendDeliveryReceipt(contact, event.id)).catch(() => {});
```
(This sits inside the outer `try` at `nostr.js:251`, after storage, so it runs for every plain DM but not for the `crow_social`/`invite_accepted` early-return at `nostr.js:261`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/delivery-receipt-emit.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Regression + commit**

Run: `node --test tests/delivery-receipt-emit.test.js tests/message-request-receive.test.js`
Expected: PASS (all) — the established-contact receive path still stores + notifies, now also acks.
```bash
git commit servers/sharing/nostr.js tests/delivery-receipt-emit.test.js -m "feat(messages): recipient emits a delivery_receipt on DM receipt (R5 Task 3)"
git show --stat HEAD
```

---

## Task 4: Sender ack handler — flip `delivered` + clear retry (forgery-bound)

**Files:**
- Modify: `servers/sharing/boot.js` (export `handleDeliveryReceipt`; add the `delivery_receipt` branch in `onSocialMessage`, `boot.js:355-465`)
- Test: `tests/delivery-receipt-handler.test.js`

**Interfaces:**
- Consumes: `findContactByPubkey` (`pubkey-util.js`, **already imported in `boot.js:17`**); `markDelivered` + `DELIVERY_RECEIPT_SUBTYPE` (Task 1).
- Produces: `handleDeliveryReceipt(db, eventIds, senderPubkey) : Promise<void>` — exported from `boot.js`. Resolves `senderPubkey`→contact (`findContactByPubkey`); if none, no-op. `UPDATE messages SET delivery_status='delivered' WHERE nostr_event_id IN (eventIds) AND direction='sent' AND contact_id = <that contact>` (**contact-bound** — a receipt can only mark *its own* messages, closing forgery since `event.id` is public on relays). Clears retry rows via contact-bound `markDelivered`. **No `bus` emit** (the SSE consumer is badge-only and would clobber the unread count — see the client-rendering note; ✓✓ is reload-correct). **Fully guarded — never throws** (receive path). Works independently of the retry queue, so a late ack (post-expiry) still flips the column.

- [ ] **Step 1: Write the failing test**

Create `tests/delivery-receipt-handler.test.js`:
```js
/**
 * delivery-receipt-handler — R5 Task 4. handleDeliveryReceipt flips a sent
 * message relayed→delivered and clears its retry row, but ONLY for the contact
 * the receipt authentically came from (event.id is public on relays, so a
 * forged receipt from another contact must NOT mark or purge). Late acks still
 * flip the column even when no retry row remains.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeliveryReceipt } from "../servers/sharing/boot.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ackh-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const PK_REAL = "02" + "a".repeat(64);   // contact 1 (real recipient)
const XONLY_REAL = "a".repeat(64);
const PK_ATTACKER = "02" + "c".repeat(64); // contact 2 (attacker)
const XONLY_ATTACKER = "c".repeat(64);

async function seed(db) {
  await db.execute({ sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type) VALUES (1,'crow:real','Real','', ?, 'crow')`, args: [PK_REAL] });
  await db.execute({ sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type) VALUES (2,'crow:atk','Atk','', ?, 'crow')`, args: [PK_ATTACKER] });
  await db.execute({ sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, delivery_status, created_at) VALUES (1,'evtSent','hi','sent',1,'relayed',datetime('now'))`, args: [] });
  await db.execute({ sql: `INSERT INTO message_retry_queue (nostr_event_id, contact_id, recipient_pubkey, raw_event, attempt_count, next_attempt_at, created_at) VALUES ('evtSent',1,?, '{}',0,1,1)`, args: [XONLY_REAL] });
}

test("authentic receipt flips relayed→delivered and clears the retry row", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seed(db);
    await handleDeliveryReceipt(db, ["evtSent"], XONLY_REAL);
    const msg = (await db.execute({ sql: "SELECT delivery_status FROM messages WHERE nostr_event_id='evtSent'", args: [] })).rows[0];
    assert.equal(msg.delivery_status, "delivered");
    const q = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtSent'", args: [] });
    assert.equal(q.rows.length, 0, "retry row cleared");
  } finally { cleanup(); }
});

test("forged receipt from a different contact does NOT mark or purge", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seed(db);
    await handleDeliveryReceipt(db, ["evtSent"], XONLY_ATTACKER); // attacker names a public event id
    const msg = (await db.execute({ sql: "SELECT delivery_status FROM messages WHERE nostr_event_id='evtSent'", args: [] })).rows[0];
    assert.equal(msg.delivery_status, "relayed", "unchanged");
    const q = await db.execute({ sql: "SELECT * FROM message_retry_queue WHERE nostr_event_id='evtSent'", args: [] });
    assert.equal(q.rows.length, 1, "retry row intact");
  } finally { cleanup(); }
});

test("late ack (no retry row left) still flips the column", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seed(db);
    await db.execute({ sql: "DELETE FROM message_retry_queue WHERE nostr_event_id='evtSent'", args: [] }); // expired earlier
    await handleDeliveryReceipt(db, ["evtSent"], XONLY_REAL);
    const msg = (await db.execute({ sql: "SELECT delivery_status FROM messages WHERE nostr_event_id='evtSent'", args: [] })).rows[0];
    assert.equal(msg.delivery_status, "delivered");
  } finally { cleanup(); }
});

test("unknown sender is a safe no-op and never throws", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seed(db);
    await handleDeliveryReceipt(db, ["evtSent"], "f".repeat(64)); // no matching contact
    const msg = (await db.execute({ sql: "SELECT delivery_status FROM messages WHERE nostr_event_id='evtSent'", args: [] })).rows[0];
    assert.equal(msg.delivery_status, "relayed");
    await handleDeliveryReceipt({ execute: async () => { throw new Error("boom"); } }, ["evtSent"], XONLY_REAL); // broken db → no throw
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/delivery-receipt-handler.test.js`
Expected: FAIL — `handleDeliveryReceipt` not exported.

- [ ] **Step 3: Add the exported handler**

In `servers/sharing/boot.js`, add **one** new import near the other local imports. `findContactByPubkey` is **already imported** at `boot.js:17` (`import { normalizePubkey, findContactByPubkey } from "./pubkey-util.js"`) — do NOT re-import it (that is a duplicate-declaration `SyntaxError`). The only genuinely-new import is:
```js
import { markDelivered, DELIVERY_RECEIPT_SUBTYPE } from "./retry-queue.js";
```
(Grep first to confirm current state: `grep -n "pubkey-util\|retry-queue" servers/sharing/boot.js`.)

Add the exported function at module scope (a natural spot is just after `handleInviteAccepted` closes):
```js
/**
 * R5: a delivery receipt from a contact confirms they actually received our
 * DM(s). Flip the matching sent rows relayed→delivered and clear their retry
 * rows — both CONTACT-BOUND (the receipt's authenticated sender pubkey must own
 * those messages), because a Nostr event.id is public on relays and a stranger
 * could otherwise forge a receipt. Independent of the retry queue, so a late
 * (post-expiry) ack still flips the column. Never throws (receive path).
 */
export async function handleDeliveryReceipt(db, eventIds, senderPubkey) {
  try {
    const ids = (Array.isArray(eventIds) ? eventIds : []).filter((x) => typeof x === "string" && x);
    if (!db || ids.length === 0) return;
    const contact = await findContactByPubkey(db, senderPubkey);
    if (!contact) return; // receipt from a non-contact → ignore
    const placeholders = ids.map(() => "?").join(",");
    await db.execute({
      sql: `UPDATE messages SET delivery_status = 'delivered'
            WHERE direction = 'sent' AND contact_id = ? AND nostr_event_id IN (${placeholders})`,
      args: [contact.id, ...ids],
    });
    await markDelivered(db, ids, contact.id);
    // No bus emit: the messages:changed SSE consumer is badge-only and reads
    // payload.unread — emitting here (without a recomputed unread) would blank
    // the peer's unread badge, and it can't render ✓✓ anyway. ✓✓ shows on the
    // sender's next thread reload (delivery_status is read on fetch).
  } catch (err) {
    try { console.warn("[sharing] delivery_receipt handling failed:", err.message); } catch {}
  }
}
```

- [ ] **Step 4: Route the subtype in `onSocialMessage`**

In `boot.js`, inside the `onSocialMessage` callback ladder (`boot.js:355-465`), add a branch (a natural spot is right after the `bot_relay_result` branch, before `room_message`/`room_join` at `boot.js:462`):
```js
        } else if (subtype === DELIVERY_RECEIPT_SUBTYPE) {
          await handleDeliveryReceipt(db, payload.event_ids, senderPubkey);
```
(`senderPubkey` is the third param of the `onSocialMessage` callback — `boot.js:355`. The receipt is `crow_social` with `subtype` set, so `subscribeToIncoming` already routes it here; `payload` is the envelope's inner `payload`, i.e. `{ event_ids }`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/delivery-receipt-handler.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify boot imports cleanly + regression + commit**

Run: `node --test tests/delivery-receipt-handler.test.js tests/invite-accepted-promote.test.js tests/message-request-gates.test.js`
Expected: PASS (all) — boot's other receive handlers unaffected.
Run: `node -e "import('./servers/sharing/boot.js').then(()=>console.log('boot ok'))"`
Expected: `boot ok`.
```bash
git commit servers/sharing/boot.js tests/delivery-receipt-handler.test.js -m "feat(messages): sender flips relayed→delivered on a contact-bound delivery_receipt (R5 Task 4)"
git show --stat HEAD
```

---

## Task 5: Full suite, gateway boot, security review, ledger — code branch ready

**Files:**
- Modify: `.superpowers/sdd/progress.md` (append R5 ledger — **git-ignored scratch; do NOT `git add` it as part of a feature commit; commit it separately or leave untracked**)
- Modify: `docs/superpowers/plans/2026-07-02-messages-p1b-r5-delivery-receipts.md` (Review + Execution sections)

- [ ] **Step 1: Run the full test suite**

Run: `node --test tests/`
Expected: baseline 939 + the 4 new files' cases all pass. Re-confirm the two historically-flaky env cases (`crow-accept-bot-invite` leak, `health-signals` "no backup dir") are unchanged-not-newly-broken by this branch (both pre-existing per prior ledgers).

- [ ] **Step 2: Verify the gateway starts cleanly (schema auto-applies)**

Run: `node servers/gateway/index.js --no-auth` then Ctrl-C after it logs "listening".
Expected: no unhandled rejection; `[sharing] Subscribed to incoming Nostr messages` appears; on a fresh/older DB the boot gate runs `init-db` (creates `message_retry_queue`, stamps `user_version` 2→3) once, then boots. Confirm the table exists:
Run: `node -e "import('@libsql/client').then(async({createClient})=>{const db=createClient({url:'file:'+process.env.HOME+'/.crow/data/crow.db'});const r=await db.execute(\"SELECT name FROM sqlite_master WHERE name='message_retry_queue'\");console.log(r.rows);})"`
Expected: one row (`message_retry_queue`). *(Only if a local dev DB exists; the deploy step verifies on prod.)*

- [ ] **Step 3: Dedicated security review of the receipt/retry path**

Dispatch a security-focused review. It must confirm:
- **Receipt forgery is bound**: `handleDeliveryReceipt`'s UPDATE and `markDelivered` are both constrained to `contact_id = findContactByPubkey(senderPubkey)`, so a stranger who reads a public `event.id` off a relay cannot mark another contact's message delivered nor purge its retry row.
- **No ack loop / ack-of-ack**: the `delivery_receipt` is `crow_social`, so `subscribeToContact` early-returns on it (`nostr.js:261`) and never re-acks; `subscribeToIncoming` routes it to `onSocialMessage` only (never stored as a message, never enqueued).
- **Retry can't duplicate**: republish sends the EXACT stored event (`event.id` unchanged) → recipient `INSERT OR IGNORE` dedups; re-encryption is never done on retry.
- **No receipt to strangers**: acks are emitted only from `subscribeToContact` (established contacts), never the `onMessageRequest` path.
- **Receive-path invariants**: the ack emit and every retry-loop call are guarded/fire-and-forget; a relay failure or DB error cannot throw out of `onevent` or the interval.
- **Enqueue scope**: `shouldEnqueue` excludes 0-relay, self-messages, and `crow_social`/`invite_accepted` envelopes (group DMs don't accumulate un-expiring retries).

- [ ] **Step 4: Append the R5 ledger to `.superpowers/sdd/progress.md`**

Add a `# Messages P1b R5 (delivery receipts + retry queue) ledger` section recording each task's commit, review verdict, the final suite count, and the Task 6 relay follow-up as PENDING (operator-gated infra).

- [ ] **Step 5: Add the Review section (after 2-round adversarial plan review is applied) + commit the plan doc**

```bash
git commit docs/superpowers/plans/2026-07-02-messages-p1b-r5-delivery-receipts.md -m "docs(messages): R5 delivery-receipts plan review record"
git show --stat HEAD
```
Then push the branch and open the PR (github MCP — operator has no gh CLI). Merge = operator-gated (merge commit). Deploy on crow: `sudo systemctl restart crow-gateway.service`, then verify `/health` 200, `PRAGMA integrity_check`, `user_version` = 3, and a live DM round-trip flips to ✓✓. Fleet self-applies via pull-only auto-update on next restart.

---

## Task 6 (operator-gated infra + follow-up PR): self-hosted relay on maestro.press

> Ships **after** Tasks 1–5 merge. The mechanism already works on public relays; the self-hosted relay shrinks the offline window and is a **deliberate new public surface** on the maestro.press droplet (operator-approved 2026-07-02). Keep it a **separate small PR** — adding a relay URL to `DEFAULT_RELAYS` before the relay is live makes every fleet gateway spend a (harmless, best-effort-skipped) connect attempt on a dead host.

- [ ] **Step 1: Verify the droplet + choose the URL (do not assume)**

SSH `maestro.press` (`67.205.133.238`). Confirm: Docker present; the reverse proxy in front (nginx/Caddy) and whether a TLS cert can cover a `relay.` subdomain; DNS for the chosen `wss://relay.<domain>`; a free host port; `ufw`/DO-firewall state. Record the final `wss://` URL. *(A Nostr relay needs `wss://` for browser/product use even though R5 consumes it server-side from gateways.)*

- [ ] **Step 2: Stand up nostr-rs-relay (dockerized) with retention + abuse limits**

Deploy `scsibug/nostr-rs-relay` (or strfry, if preferred) as a Docker service with a config that: retains events **≥ the 60h retry horizon** (set a comfortable margin, e.g. 7d); caps total storage; rate-limits writes; and (kind:4 is open-write) applies a sane per-connection/IP limit. TLS-terminate at the reverse proxy for the `wss://` URL. Verify with a throwaway-key connect+publish+fetch probe (the same style used to vet the R2 default relays). **This is new infra the delivery guarantee leans on — note it in the lab maintenance log and confirm it survives a droplet reboot (restart policy).**

- [ ] **Step 3: Add the URL to `DEFAULT_RELAYS` (crow repo, small PR)**

In `servers/sharing/nostr.js`, add the verified URL to `DEFAULT_RELAYS` (`nostr.js:42-46`) with a one-line comment (self-hosted, long-retention). Add a test asserting the merged set from `getConfiguredRelays()` (or the exported `DEFAULT_RELAYS`) includes it. Note the exposure in `docs/architecture/sharing-server.md` and the network-exposure invariant doc (this relay is a separate service, not a gateway route — it does **not** violate the Funnel invariant, but it is a public surface worth documenting). Full suite green → PR → operator-gated merge → deploy (restart crow-gateway; fleet self-applies).

- [ ] **Step 4: Live end-to-end verification**

From the two-instance harness (Gitea `feat/messages-p1a-harness`; black-swan DUT), run the offline-then-wake scenario: send while the recipient gateway is stopped, confirm the message is retained on the maestro relay, start the recipient, confirm it arrives, the recipient acks, and the sender flips to ✓✓ with the retry row cleared. Record in the ledger.

---

## Self-Review (against the R5 scope from the master plan + operator decisions)

**Spec coverage:**
- "recipient emits a `crow_social` ack on receipt of a DM" → Task 3 (`_sendDeliveryReceipt` + `onevent` emit). ✅
- "sender flips `delivery_status` relayed→delivered on ack, shows ✓✓" → Task 4 (`handleDeliveryReceipt`) + existing client render (`client.js:1159-1163`). ✅
- "sender re-publishes unacked DMs on a backoff until acked or expired" → Task 2 (`_startRetryLoop`/`_runRetryTick`) + Task 1 (`message_retry_queue`, backoff, expiry ~60h per operator's 48–72h). ✅
- "self-hosted always-on relay — public, added product-wide" → Task 6 (maestro.press, `DEFAULT_RELAYS`), operator decisions 2026-07-02. ✅
- Operator "extended ~48–72h" window → `CROW_NOSTR_RETRY_MAX_AGE_SEC` default 216000 (60h). ✅

**Placeholder scan:** none — every step carries real code/commands. Task 6's exact `wss://` URL is intentionally resolved at standup (Step 1) because it depends on live droplet/DNS state; the plan flags this as a verify-don't-assume, consistent with the operator's standing rule.

**Type consistency:** `shouldEnqueue({content,publishedCount,recipientNorm,ownNorm})`, `enqueueRetry(db,{eventId,contactId,recipientPubkey,rawEvent,nowSec})`, `recordAttempt(db,row,nowSec,maxAgeSec)→{expired}`, `markDelivered(db,eventIds,contactId)`, `buildDeliveryReceipt(eventIds)→string`, `DELIVERY_RECEIPT_SUBTYPE`, `handleDeliveryReceipt(db,eventIds,senderPubkey)`, `_runRetryTick()`/`_startRetryLoop()`/`_sendDeliveryReceipt(contact,eventId)` are used identically across Tasks 1–4.

**Known follow-ups (out of scope, log in ledger):** extend 0-relay failure detection to `crow_send_group_message` (R2 follow-up); delete the dead `send_peer` api-handler; apple-touch-icon PNG. R5 does not batch acks (per-event ack, array-of-one) — a deliberate YAGNI given minutes/hours-apart retries.

**Graceful degradation to note in the ledger:** an R5 sender messaging a **pre-R5 recipient** (or one whose contact row is still a `'pending'`/`'accepted'` request, so no `subscribeToContact` ack is emitted) never receives a receipt → the DM retries ~5× over ~60h then expires and stays single-✓. Harmless (recipient dedups the exact re-published `event.id`; no duplicate rows), correct, but it is extra relay traffic worth stating. This resolves on the recipient's upgrade / full-contact promotion (R4).

## Review

**Round 1 (2026-07-02, adversarial staff-engineer subagent, opus): REVISE — all findings applied.**
- **IMPORTANT 1 (real UI regression):** the ack handler's `bus.emit("messages:changed", {contactId})` had two defects — the only consumer (`servers/gateway/routes/streams.js`) is **badge-only** (message-body live render is a deferred plan), so it never lit ✓✓ live (plan claim was false); and it reads `payload.unread ?? 0`, so an emit omitting `unread` would blank the peer's unread badge on any inbound receipt. **Fix:** dropped the emit entirely (✓✓ is reload-correct — the column is read on fetch); corrected the client-rendering note and the ack-handler interface/code.
- **IMPORTANT 2 (would break boot.js):** `boot.js:17` already imports `findContactByPubkey`; the Task-4 import block re-declared it → `SyntaxError`. **Fix:** reduced the new import to `{ markDelivered, DELIVERY_RECEIPT_SUBTYPE }` only, with an explicit do-not-re-import note.
- **IMPORTANT 3 (over-stated guarantee):** a retry re-publishes the event with its **original `created_at`**, so age-based public-relay eviction (and `since`-windowed live re-subscribes, L2/L7) can filter it out — Tasks 1–5 alone recover the **recipient-restart** case (full-history `subscribeToContact`, no `since`) but not arbitrary offline outages; the full L1 fix leans on Task 6's long-retention relay. **Fix:** reworded the Architecture + client note; Task 6 marked as strongly recommended to complete L1.
- **MINOR:** corrupt-`raw_event` cleanup switched from contact-bound `markDelivered` (no-ops on a NULL `contact_id` → row re-selected forever) to a direct `DELETE ... WHERE id=?`; removed the now-unused `markDelivered` import from `nostr.js`; added the pre-R5-recipient interop note above; noted the "attempt consumed during a total-relay outage" tradeoff inline (bounded, acceptable).
- **Confirmed sound (no action):** no ack-of-ack loop (receipt is `crow_social`, sender's own `subscribeToContact` early-returns at `:261`, routed only via `subscribeToIncoming`→`onSocialMessage`); retry cannot duplicate (exact `event.id` → recipient `INSERT OR IGNORE` dedups; no re-encryption); forgery doubly-bound (receipt must decrypt under the pairwise NIP-44 key AND handler UPDATE/`markDelivered` are `contact_id`-scoped); receive-path-never-throws honored (fire-and-forget acks, guarded loop, unref'd interval); `A` does receive `B`'s receipt (`sendControl` tags `["p", A_xonly]`, matching A's incoming filter); SCHEMA 2→3 auto-applies (verified `init-db.js` `PRAGMA user_version` + gateway boot gate); FK/init ordering fine (contacts created before the new table). All 4 embedded test files hand-traced against the specified implementation — assertions correct (incl. the `backoffSeconds(2)` fencepost fix).

**Round 2 (2026-07-02, focused confirmation subagent, opus): APPROVE.** Re-verified all 4 fixes against the plan + live source (`boot.js:17`, `nostr.js:33/292`, `streams.js:87`, `client.js:1157-1164`): ack handler no longer emits/imports `bus` and the interface + client-rendering note are consistent (✓✓ reload-only); the Task-4 import is reduced to `{ markDelivered, DELIVERY_RECEIPT_SUBTYPE }` with `findContactByPubkey` from the existing `boot.js:17` import (no SyntaxError); the offline-guarantee wording is honest and not self-contradictory with the Goal; the corrupt-row `DELETE ... WHERE id=?` matches its test and `markDelivered` is correctly removed from the `nostr.js` import yet still exported/used where needed. Caught **one stale interface-summary line** (Task 2 still said the corrupt row is dropped "via `markDelivered`") — **fixed** to reference the direct delete. **Plan is ready for subagent-driven execution.**
