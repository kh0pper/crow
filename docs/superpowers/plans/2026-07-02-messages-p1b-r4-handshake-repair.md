# Messages Phase 1b R4 — De-fragilize the Handshake & Complete the L6 Story

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a half-completed contact handshake recoverable and self-completing — a late `invite_accepted` is no longer guillotined by a 24h clock, an operator can repair a stuck contact by pasting its keys, and an accepted message-request graduates to a full peer-synced contact the moment the sender proves (via an authenticated `invite_accepted`) they completed our invite.

**Architecture:** Three coordinated changes on the Nostr receive/handshake path. (1) `subscribeToIncoming` swaps its fixed `now − 86400` window for a **persisted, monotonic incoming-event cursor** in `dashboard_settings`, so an offline gateway resumes from where it left off. (2) A single shared **`upsertFullContact`** helper does idempotent insert-or-promote-or-merge of a full contact (keys, sync feeds, DHT topic, Nostr sub) and is the sole write path for both a new **`crow_add_contact`** repair tool and the rewired **`invite_accepted`** auto-add handler. (3) Promotion is gated to the **authenticated `invite_accepted` handler only** (never the plaintext message-request path), so a plaintext DM can never elevate a contact's trust.

**Tech Stack:** Node ESM, `@libsql/client`, `nostr-tools` (NIP-44), Node built-in test runner. No new dependencies.

## Global Constraints

- **Commit with a positional path arg**: `git commit <path> -m "..."`, never `git add <path> && git commit`. Verify with `git show --stat HEAD` after each commit.
- **`git pull --rebase` before any push** — parallel sessions push to `main`.
- **Never attribute Claude as a co-author** and never add Claude as a contributor.
- **Tests**: `node --test tests/<file>.test.js`. Full suite must stay green (`node --test tests/` — 922/922 on `main` as of `c8c2125`).
- **Schema migrations**: if you add a table/column/index/data migration to `scripts/init-db.js`, BUMP `SCHEMA_GENERATION` in `servers/shared/schema-version.js` (currently **2**) by 1 so the boot gate auto-applies it. **This plan reuses the existing `dashboard_settings` kv table and adds no columns, so NO bump is expected** — only bump if a task forces you to add one.
- **Trust boundary (from L6, PR #126)**: `request_status IS NULL` = full contact (peer-join / sync / room-trust / directory / people-picker / `crow_list_contacts`). `'pending'`/`'accepted'` = gated partial (secp-only; messaging allowed for `accepted`, never trust surfaces). **Promotion (NULL-ing `request_status`) is a trust elevation — it may fire ONLY from the authenticated `invite_accepted` handler, never from `handleIncomingRequest` / the plaintext path.**
- **Never throw on the receive path**: `onevent` / `onInviteAccepted` / `onMessageRequest` callbacks must be fully guarded — a throw kills the Nostr subscription and breaks all delivery.
- **Pubkey normalization**: match secp256k1 keys on the trailing-64-hex lowercased form (`normalizePubkey` / `findContactByPubkey` in `servers/sharing/pubkey-util.js`). A stored key is 66-hex compressed (`02`/`03` prefix); a Nostr `event.pubkey` is 64-hex x-only.

---

## Background — the exact code being changed (verified @ `main` c8c2125)

**The 24h cliff (L3).** `servers/sharing/nostr.js:392`:
```js
const incomingSince = Math.floor(Date.now() / 1000) - 86400; // Last 24h only
```
This is the `since` floor for the broad incoming subscription (`{ kinds:[4], "#p":[ownPubkey] }`, `nostr.js:448`). An `invite_accepted` DM published >24h before this gateway (the inviter) next subscribes is never seen → the acceptor is never auto-added → half-completed handshake → every later DM from them lands as an unsolicited message-request instead of a real contact.

**The auto-add handler.** `servers/sharing/boot.js:327-348` — the `onInviteAccepted` callback. It early-returns if a row with `crow_id = payload.crowId` exists, else INSERTs a brand-new full contact and wires sync/DHT/Nostr. It keys on **crow_id**, so it cannot see an existing message-request row (whose `crow_id` is `req:<64hex>`, not the real crowId) that shares the sender's secp pubkey → it would INSERT a **duplicate** person (one `req:` row + one full row, same secp key).

**The L6 request contact.** `handleIncomingRequest` (`boot.js:50`) creates `crow_id = 'req:' + normalizePubkey(senderPubkey)`, `ed25519_pubkey = ''`, `request_status = 'pending'`. The Messages "Requests" inbox flips it to `'accepted'` (`servers/gateway/dashboard/panels/messages/api-handlers.js:224`) and opens a per-contact Nostr sub — but it stays secp-only and gated; it can DM but cannot peer-sync or be trusted in rooms.

**Persistence surface.** `dashboard_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)` (`scripts/init-db.js:1070`) — reuse it for the cursor. No new table.

**Helpers available.** `normalizePubkey(pk)`, `findContactByPubkey(db, pk)` (`servers/sharing/pubkey-util.js`). `ctx` in `registerContactsTools` (`servers/sharing/tools/contacts.js:32`) = `{ db, identity, peerManager, syncManager, nostrManager }`. `syncManager.initContact(contactId, null)`, `peerManager.joinContact({ crowId, ed25519Pubkey })`, `nostrManager.subscribeToContact({ id, crow_id, secp256k1_pubkey, display_name })` — the exact call shapes used at `boot.js:301-312` and `contacts.js:104-117`.

---

## File Structure

- **Create** `servers/sharing/contact-promote.js` — `upsertFullContact(db, managers, spec)` (the shared insert/promote/merge helper) + `readIncomingSince(db, nowSec)` + `persistIncomingCursor(db, createdAtSec)` (cursor helpers; grouped here because they are the two pieces of "handshake durability" and share the module's DB-helper idiom). One responsibility: durable handshake state.
- **Modify** `servers/sharing/nostr.js` — `subscribeToIncoming` uses `readIncomingSince` for the `since` floor and calls `persistIncomingCursor` as events are processed.
- **Modify** `servers/sharing/boot.js` — extract the `onInviteAccepted` body into an exported `handleInviteAccepted(db, managers, payload)` that delegates to `upsertFullContact`; wire it in place of the inline callback.
- **Modify** `servers/sharing/tools/contacts.js` — register `crow_add_contact` (kiosk-guarded) delegating to `upsertFullContact`.
- **Modify** `servers/gateway/dashboard/panels/contacts/api-handlers.js` — an `add_by_id` action that calls the `crow_add_contact` tool via `sharingClientFactory`.
- **Modify** `servers/gateway/dashboard/panels/contacts/html.js` + `client.js` — an "Add by Crow ID" repair form (three key fields + name).
- **Create** tests: `tests/nostr-incoming-cursor.test.js`, `tests/contact-promote.test.js`, `tests/invite-accepted-promote.test.js`, `tests/contacts-add-by-id-action.test.js`.

---

## Task 1: Persistent incoming-event cursor (kill the 24h cliff, L3)

**Files:**
- Create: `servers/sharing/contact-promote.js` (cursor helpers only this task)
- Modify: `servers/sharing/nostr.js:383-459` (`subscribeToIncoming`)
- Test: `tests/nostr-incoming-cursor.test.js`

**Interfaces:**
- Produces:
  - `readIncomingSince(db, nowSec) : Promise<number>` — computes the `since` floor from the persisted cursor, **clamped** so it is (a) **never newer than the legacy `nowSec - 86400` floor** — a busy gateway whose cursor sits at ~now must still back-fill a full 24h on restart, so this can never regress vs the old fixed window — and (b) **never older than `nowSec - 30d`** — a long-offline gateway must not flood the public relays with an unbounded kind-4 replay (relays truncate to the most-recent N, silently dropping the oldest = the same cliff via a new cause). No cursor / bad db → the plain `nowSec - 86400` default. Never throws. The 1h overlap on the cursor absorbs clock skew + relay re-ordering; dedup downstream (`seenEventIds` + `INSERT OR IGNORE` on `nostr_event_id`) makes re-delivery harmless.
  - `persistIncomingCursor(db, createdAtSec) : Promise<void>` — upserts `dashboard_settings` key `'sharing:incoming_since'` to `createdAtSec` **only when it advances** (monotonic; never moves the cursor backwards). Never throws.

- [ ] **Step 1: Write the failing test**

Create `tests/nostr-incoming-cursor.test.js`:
```js
/**
 * nostr-incoming-cursor — R4 Task 1. The broad incoming Nostr subscription
 * must resume from a PERSISTED cursor instead of a fixed 24h window, so a late
 * invite_accepted isn't guillotined by the clock. Asserts: default when unset,
 * persisted-minus-overlap when set, monotonic advance (never backwards), and
 * never-throws on a bad db.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIncomingSince, persistIncomingCursor } from "../servers/sharing/contact-promote.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "cursor-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("default is now-86400 when no cursor persisted", async () => {
  const { db, cleanup } = freshDb();
  try {
    const now = 1_800_000_000;
    assert.equal(await readIncomingSince(db, now), now - 86400);
  } finally { cleanup(); }
});

test("a recent cursor still back-fills the full 24h floor (never regress)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const now = 1_800_000_000;
    await persistIncomingCursor(db, now - 3600); // cursor 1h old (busy gateway)
    // desired = (now-3600)-3600 is newer than now-86400 → clamp to the 24h floor.
    assert.equal(await readIncomingSince(db, now), now - 86400);
  } finally { cleanup(); }
});

test("an older cursor widens the window (cursor minus 1h overlap)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const now = 1_800_000_000;
    const stored = now - 2 * 86400; // 2 days offline
    await persistIncomingCursor(db, stored);
    assert.equal(await readIncomingSince(db, now), stored - 3600);
  } finally { cleanup(); }
});

test("a very stale cursor is capped at 30 days (bound the relay flood)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const now = 1_800_000_000;
    await persistIncomingCursor(db, now - 100 * 86400); // 100 days old
    assert.equal(await readIncomingSince(db, now), now - 30 * 86400);
  } finally { cleanup(); }
});

test("cursor advances but never moves backwards", async () => {
  const { db, cleanup } = freshDb();
  try {
    await persistIncomingCursor(db, 1_700_000_000);
    await persistIncomingCursor(db, 1_700_000_500); // advance
    await persistIncomingCursor(db, 1_600_000_000); // stale — must be ignored
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'sharing:incoming_since'", args: [],
    });
    assert.equal(Number(rows[0].value), 1_700_000_500);
  } finally { cleanup(); }
});

test("never throws on a broken db", async () => {
  const brokenDb = { execute: async () => { throw new Error("boom"); } };
  assert.equal(await readIncomingSince(brokenDb, 1_800_000_000), 1_800_000_000 - 86400);
  await persistIncomingCursor(brokenDb, 1_700_000_000); // must not throw
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/nostr-incoming-cursor.test.js`
Expected: FAIL — `Cannot find module '../servers/sharing/contact-promote.js'` (or export-not-found).

- [ ] **Step 3: Create the module with the cursor helpers**

Create `servers/sharing/contact-promote.js`:
```js
/**
 * Durable handshake state for Crow Messages (R4).
 *
 *  - readIncomingSince / persistIncomingCursor: a persisted, monotonic cursor
 *    for the broad incoming Nostr subscription so an offline gateway resumes
 *    from where it left off instead of a fixed 24h window (kills the L3 cliff).
 *  - upsertFullContact (Task 2): the single idempotent insert/promote/merge
 *    write path for a full (request_status NULL) contact.
 *
 * Every function is guarded — the receive path must never throw.
 */

const CURSOR_KEY = "sharing:incoming_since";
const OVERLAP_SEC = 3600;            // re-fetch a 1h overlap; dedup makes it harmless
const MIN_FLOOR_SEC = 86400;         // always look back >= 24h (never worse than the old fixed window)
const MAX_LOOKBACK_SEC = 30 * 86400; // never replay more than 30d (bounds the relay flood)

/**
 * The `since` floor for subscribeToIncoming, derived from the persisted cursor
 * and CLAMPED in both directions:
 *   - never NEWER than now-24h  → a busy gateway (cursor ~ now) still back-fills
 *     a full day on restart; can't regress vs the old fixed 24h window.
 *   - never OLDER than now-30d  → a long-offline gateway can't flood the public
 *     relays with an unbounded kind-4 replay (which relays truncate, silently
 *     dropping the oldest events = the cliff via a new cause).
 * No cursor / bad db → the plain now-24h default. Never throws.
 */
export async function readIncomingSince(db, nowSec) {
  const floor = nowSec - MIN_FLOOR_SEC;              // newest allowed since
  const lowerBound = nowSec - MAX_LOOKBACK_SEC;      // oldest allowed since
  try {
    if (!db) return floor;
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [CURSOR_KEY],
    });
    const stored = Number(rows?.[0]?.value);
    if (!Number.isFinite(stored) || stored <= 0) return floor;
    const desired = stored - OVERLAP_SEC;
    // Clamp: at most now-24h (never regress), at least now-30d (bound flood).
    return Math.max(lowerBound, Math.min(desired, floor));
  } catch {
    return floor;
  }
}

/**
 * Advance the persisted cursor to `createdAtSec` — but only forwards
 * (monotonic). Never throws.
 */
export async function persistIncomingCursor(db, createdAtSec) {
  try {
    if (!db || !Number.isFinite(createdAtSec) || createdAtSec <= 0) return;
    // INSERT-or-advance in one statement: on conflict, keep the larger value.
    await db.execute({
      sql: `INSERT INTO dashboard_settings (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
              value = CASE WHEN CAST(excluded.value AS INTEGER) > CAST(dashboard_settings.value AS INTEGER)
                           THEN excluded.value ELSE dashboard_settings.value END,
              updated_at = datetime('now')`,
      args: [CURSOR_KEY, String(Math.floor(createdAtSec))],
    });
  } catch {
    // Cursor is an optimization; a write failure must not break delivery.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/nostr-incoming-cursor.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the cursor into `subscribeToIncoming`**

In `servers/sharing/nostr.js`, add the import near the top (with the other local imports):
```js
import { readIncomingSince, persistIncomingCursor } from "./contact-promote.js";
```
Replace line 392:
```js
    const incomingSince = Math.floor(Date.now() / 1000) - 86400; // Last 24h only
```
with:
```js
    const incomingSince = await readIncomingSince(this.db, Math.floor(Date.now() / 1000));
```
Then, inside the `onevent` handler, after a successful decrypt+route (i.e. at the END of the `try` block that starts at `nostr.js:398`, just before the closing `} catch (decryptErr) {` at line 442), persist the cursor so it advances as events flow:
```js
            // Advance the durable incoming cursor (monotonic, never throws) so
            // a restart resumes from here instead of now-24h.
            await persistIncomingCursor(this.db, event.created_at);
```
Placement note: this line runs only after a successful decrypt (unrelated events for other recipients throw in `nip44.decrypt` and are caught before here), so the cursor tracks events actually addressed to us. That is the correct resume point.

- [ ] **Step 6: Run the full sharing-adjacent tests to verify no regression**

Run: `node --test tests/nostr-incoming-cursor.test.js tests/nostr-resubscribe.test.js tests/message-request-receive.test.js`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git commit servers/sharing/contact-promote.js servers/sharing/nostr.js tests/nostr-incoming-cursor.test.js -m "feat(messages): persist a monotonic incoming-event cursor to kill the 24h invite cliff (R4 L3)"
git show --stat HEAD
```

---

## Task 2: `upsertFullContact` — idempotent insert / promote / merge helper + `crow_add_contact` tool

**Files:**
- Modify: `servers/sharing/contact-promote.js` (add `upsertFullContact`)
- Modify: `servers/sharing/tools/contacts.js` (register `crow_add_contact`)
- Test: `tests/contact-promote.test.js`

**Interfaces:**
- Consumes: `normalizePubkey`, `findContactByPubkey` (`servers/sharing/pubkey-util.js`); `managers = { syncManager, peerManager, nostrManager }` (any may be absent in tests → wiring steps are individually guarded).
- Produces:
  - `upsertFullContact(db, managers, { crowId, ed25519Pub, secp256k1Pub, displayName }) : Promise<{ contactId:number, outcome:'created'|'promoted'|'merged'|'noop' }>`
    - Resolves **deterministically** (no reliance on `findContactByPubkey`'s arbitrary single-row order): looks up `byCrow` (exact `crow_id`, ≤1 by UNIQUE) and the full list of rows whose secp key matches (`ORDER BY id`).
    - **`merged`** — a `byCrow` row exists AND a **different** row (`id != byCrow.id`) shares the secp key → reassign that other row's `messages.contact_id` to `byCrow` with a **plain `UPDATE`** (globally-unique `nostr_event_id` means no collision; a plain UPDATE surfaces a genuine one instead of silently dropping it), delete the other row, ensure `byCrow` is a full contact (fill placeholders), then wire. Prevents both a `crow_id UNIQUE` violation and a duplicate person.
    - **`promoted`** — a single row (the `byCrow` owner, or a same-secp request/partial row when no owner exists) is completed in place: set real `crow_id`, fill `ed25519_pubkey`/`secp256k1_pubkey` only where empty, `display_name` only if empty/`req:`-placeholder, `request_status = NULL`; then wire. (When this row is the `byCrow` owner its `crow_id` is unchanged, so no UNIQUE risk; the merge branch already handled the two-row case.)
    - **`created`** — neither a `byCrow` owner nor any secp match → INSERT a full contact (`request_status` NULL, real keys), then wire.
    - **`noop`** — a full row (`request_status` NULL) already owns `crowId` with a matching secp key → leave it; refresh `display_name` only if the stored one is empty/placeholder. Do NOT re-wire (avoids leaking a Nostr sub handle per relay on every call).
    - **Conflict guard (I1):** if `byCrow` is already a full contact whose stored secp key **differs** from the input and no separate secp row exists, THROW (`A contact with Crow ID <id> already exists with a different key`) rather than silently rebinding a trusted contact's key from operator-pasted input.
    - Throws only on a genuine DB error, the conflict guard, or invalid input (the tool surfaces it as `isError`; the `invite_accepted` caller in Task 3 wraps it in try/catch). Never called from the plaintext path.
    - Validation: requires a 64- or 66-hex `secp256k1Pub` and a non-empty `crowId`; a `crowId` beginning `req:` is rejected (that is the internal request sentinel, never a real peer id).

- [ ] **Step 1: Write the failing test**

Create `tests/contact-promote.test.js`:
```js
/**
 * contact-promote — R4 Task 2. upsertFullContact is the single idempotent
 * write path for a full (request_status NULL) contact. Covers: fresh insert,
 * promotion of an accepted message-request in place, merge when a duplicate
 * full row already owns the crow_id, and no-op on an existing full contact.
 * managers wiring (sync/DHT/Nostr) is stubbed and its calls are asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertFullContact } from "../servers/sharing/contact-promote.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "promote-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function stubManagers() {
  const calls = { init: [], join: [], sub: [] };
  return {
    calls,
    syncManager: { initContact: async (id) => calls.init.push(id) },
    peerManager: { joinContact: async (a) => calls.join.push(a) },
    nostrManager: { subscribeToContact: async (a) => calls.sub.push(a) },
  };
}

const PK = "02" + "a".repeat(64);          // 66-hex compressed
const PK_XONLY = "a".repeat(64);           // its 64-hex x-only tail
const ED = "b".repeat(64);
const CROW = "crow:testpeer01";

test("created — fresh full contact when nothing exists", async () => {
  const { db, cleanup } = freshDb();
  try {
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "created");
    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [CROW] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].request_status, null);
    assert.equal(rows[0].ed25519_pubkey, ED);
    assert.equal(m.calls.init.length, 1);
    assert.equal(m.calls.join.length, 1);
    assert.equal(m.calls.sub.length, 1);
  } finally { cleanup(); }
});

test("promoted — an accepted request row becomes a full contact in place", async () => {
  const { db, cleanup } = freshDb();
  try {
    // Seed an accepted, secp-only request row (crow_id sentinel, empty ed25519).
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, NULL, '', ?, 'crow', 'accepted')`,
      args: ["req:" + PK_XONLY, PK],
    });
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "promoted");
    const { rows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?", args: [PK_XONLY],
    });
    assert.equal(rows.length, 1, "no duplicate row");
    assert.equal(rows[0].crow_id, CROW);
    assert.equal(rows[0].request_status, null);
    assert.equal(rows[0].ed25519_pubkey, ED);
    assert.equal(m.calls.join.length, 1, "promotion wires DHT join");
  } finally { cleanup(); }
});

test("merged — request messages fold into a pre-existing full contact, request row deleted", async () => {
  const { db, cleanup } = freshDb();
  try {
    // A full contact already owns CROW (e.g. added via crow_accept_invite)...
    const full = await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
            VALUES (?, 'Peer', ?, ?, 'crow')`,
      args: [CROW, ED, PK],
    });
    const fullId = Number(full.lastInsertRowid);
    // ...and a separate request row for the SAME secp key accrued a message.
    const reqRow = await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, '', ?, 'crow', 'pending')`,
      args: ["req:" + PK_XONLY, PK],
    });
    const reqId = Number(reqRow.lastInsertRowid);
    await db.execute({
      sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
            VALUES (?, 'evt-merge', 'hi', 'received', 0, datetime('now'))`,
      args: [reqId],
    });
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "merged");
    const reqGone = await db.execute({ sql: "SELECT id FROM contacts WHERE id = ?", args: [reqId] });
    assert.equal(reqGone.rows.length, 0, "request row deleted");
    const moved = await db.execute({ sql: "SELECT contact_id FROM messages WHERE nostr_event_id = 'evt-merge'", args: [] });
    assert.equal(Number(moved.rows[0].contact_id), fullId, "message reassigned to the full contact");
  } finally { cleanup(); }
});

test("noop — an existing full contact is left as-is (no re-wire)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
            VALUES (?, 'Peer', ?, ?, 'crow')`,
      args: [CROW, ED, PK],
    });
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "noop");
    assert.equal(m.calls.sub.length, 0, "no re-subscribe on a live full contact");
  } finally { cleanup(); }
});

test("rejects the req: sentinel and a missing secp key", async () => {
  const { db, cleanup } = freshDb();
  try {
    await assert.rejects(() => upsertFullContact(db, stubManagers(), { crowId: "req:" + PK_XONLY, ed25519Pub: ED, secp256k1Pub: PK }));
    await assert.rejects(() => upsertFullContact(db, stubManagers(), { crowId: CROW, ed25519Pub: ED, secp256k1Pub: "" }));
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/contact-promote.test.js`
Expected: FAIL — `upsertFullContact` not exported.

- [ ] **Step 3: Implement `upsertFullContact`**

Append to `servers/sharing/contact-promote.js`:
```js
import { normalizePubkey } from "./pubkey-util.js";

const HEX_KEY = /^[0-9a-fA-F]{64}(?:[0-9a-fA-F]{2})?$/; // 64 x-only or 66 compressed

/** Wire a full contact into sync feeds, the DHT topic, and the Nostr sub. Each
 * step is independently guarded — a partial-manager (tests) or a transient
 * failure must not abort the upsert (the row is already correct). */
async function wireFullContact(managers, row) {
  const { syncManager, peerManager, nostrManager } = managers || {};
  try { if (syncManager) await syncManager.initContact(row.id, null); } catch {}
  try { if (peerManager) await peerManager.joinContact({ crowId: row.crow_id, ed25519Pubkey: row.ed25519_pubkey }); } catch {}
  try {
    if (nostrManager) await nostrManager.subscribeToContact({
      id: row.id, crow_id: row.crow_id, crowId: row.crow_id,
      secp256k1_pubkey: row.secp256k1_pubkey, display_name: row.display_name,
    });
  } catch {}
}

function isPlaceholderName(name) {
  return name == null || name === "" || String(name).startsWith("req:") || String(name).startsWith("crow:");
}

/**
 * Idempotent insert / promote / merge of a FULL (request_status NULL) contact.
 * See the interface block in the plan for the four outcomes. THROWS only on a
 * genuine DB error or invalid input — callers on the receive path must guard.
 * MUST be reached only from an authenticated path (crow_accept_invite tool,
 * crow_add_contact tool, or the invite_accepted handler) — NEVER the plaintext
 * message-request path (promotion is a trust elevation).
 */
export async function upsertFullContact(db, managers, { crowId, ed25519Pub, secp256k1Pub, displayName } = {}) {
  if (!db) throw new Error("upsertFullContact: db required");
  if (!crowId || String(crowId).startsWith("req:")) throw new Error("upsertFullContact: a real crowId is required");
  if (!secp256k1Pub || !HEX_KEY.test(String(secp256k1Pub))) throw new Error("upsertFullContact: a valid secp256k1 pubkey is required");
  const ed = ed25519Pub || "";
  const name = displayName || null;
  const secpNorm = normalizePubkey(secp256k1Pub);

  // Deterministic resolution — do NOT use findContactByPubkey (no ORDER BY →
  // arbitrary single row). Get the crowId owner (unique) and ALL secp matches.
  const byCrow = (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] })).rows[0] || null;
  const secpRows = (await db.execute({
    sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ? ORDER BY id ASC",
    args: [secpNorm],
  })).rows;

  // --- MERGE: the crowId owner exists AND a *different* row shares the secp key.
  const otherSecp = byCrow ? secpRows.find((r) => r.id !== byCrow.id) : null;
  if (byCrow && otherSecp) {
    // Fold the other row's messages into the owner (plain UPDATE — globally
    // unique nostr_event_id means no collision; surface a genuine one), then
    // delete the other row and complete the owner.
    await db.execute({ sql: "UPDATE messages SET contact_id = ? WHERE contact_id = ?", args: [byCrow.id, otherSecp.id] });
    await db.execute({ sql: "DELETE FROM contacts WHERE id = ?", args: [otherSecp.id] });
    await db.execute({
      sql: `UPDATE contacts SET request_status = NULL,
              ed25519_pubkey = COALESCE(NULLIF(ed25519_pubkey,''), ?),
              display_name  = COALESCE(NULLIF(display_name,''), ?) WHERE id = ?`,
      args: [ed, name, byCrow.id],
    });
    const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [byCrow.id] })).rows[0];
    await wireFullContact(managers, row);
    return { contactId: row.id, outcome: "merged" };
  }

  // --- COMPLETE / PROMOTE / NOOP a single existing row: the crowId owner, or a
  // same-secp request row when no owner exists. (byCrow && otherSecp is done.)
  const target = byCrow || secpRows[0] || null;
  if (target) {
    const storedSecp = normalizePubkey(target.secp256k1_pubkey || "");
    const isFull = target.request_status === null || target.request_status === undefined;

    // I1 conflict guard: a trusted contact already owns this crowId with a
    // DIFFERENT key and no separate secp row explains it → refuse to rebind.
    if (byCrow && isFull && storedSecp && storedSecp !== secpNorm) {
      throw new Error(`A contact with Crow ID ${crowId} already exists with a different key`);
    }

    if (isFull && target.crow_id === crowId && storedSecp === secpNorm) {
      if (name && isPlaceholderName(target.display_name)) {
        await db.execute({ sql: "UPDATE contacts SET display_name = ? WHERE id = ?", args: [name, target.id] });
      }
      return { contactId: target.id, outcome: "noop" };
    }

    // Promote in place. crow_id is only ever set when target is a non-owner
    // (byCrow null) OR target IS the owner (crow_id unchanged) → no UNIQUE risk.
    // NOTE (conscious decision, security-reviewed in Task 5): when byCrow is
    // null and target is an already-FULL contact with the SAME secp key but a
    // DIFFERENT crow_id, this rebinds its crow_id to the input. That is the
    // intended "repair the id" behavior for both the operator tool and an
    // authenticated invite_accepted whose secp is cryptographically bound — the
    // same key-holder is the same peer. No UNIQUE risk (input crow_id unowned).
    await db.execute({
      sql: `UPDATE contacts SET crow_id = ?, secp256k1_pubkey = ?,
              ed25519_pubkey = COALESCE(NULLIF(ed25519_pubkey,''), ?),
              request_status = NULL,
              display_name = CASE WHEN display_name IS NULL OR display_name = '' OR display_name LIKE 'req:%'
                                  THEN ? ELSE display_name END
            WHERE id = ?`,
      args: [crowId, secp256k1Pub, ed, name, target.id],
    });
    const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [target.id] })).rows[0];
    await wireFullContact(managers, row);
    return { contactId: row.id, outcome: "promoted" };
  }

  // --- CREATE a fresh full contact.
  const ins = await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
          VALUES (?, ?, ?, ?, 'crow')`,
    args: [crowId, name || crowId, ed, secp256k1Pub],
  });
  const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [Number(ins.lastInsertRowid)] })).rows[0];
  await wireFullContact(managers, row);
  return { contactId: row.id, outcome: "created" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/contact-promote.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Register the `crow_add_contact` tool**

In `servers/sharing/tools/contacts.js`, add the import at the top with the others:
```js
import { upsertFullContact } from "../contact-promote.js";
```
Add this tool registration immediately after the `crow_accept_invite` block closes (after `contacts.js:167`, before the `crow_accept_bot_invite` block):
```js
  // --- Tool: crow_add_contact (R4 handshake repair) ---

  server.tool(
    "crow_add_contact",
    "Repair or add a Crow contact directly from their Crow ID and public keys — the recovery path when an invite handshake half-completed and messages are stuck as requests. Idempotent: completes an existing partial/request contact in place instead of duplicating it.",
    {
      crow_id: z.string().max(200).describe("The contact's Crow ID (e.g. crow:abcd1234)"),
      secp256k1_pubkey: z.string().max(200).describe("Their secp256k1 public key (64- or 66-hex)"),
      ed25519_pubkey: z.string().max(200).optional().describe("Their ed25519 public key (enables peer sync + room trust)"),
      display_name: z.string().max(100).optional().describe("Name for this contact"),
    },
    async ({ crow_id, secp256k1_pubkey, ed25519_pubkey, display_name }) => {
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_add_contact");
      try {
        // Pass the raw `db` — upsertFullContact only needs `.execute`, and
        // crow_accept_invite calls `db.execute` on the raw ctx db (contacts.js:78,90).
        const r = await upsertFullContact(
          db,
          { syncManager, peerManager, nostrManager },
          { crowId: crow_id.trim(), ed25519Pub: (ed25519_pubkey || "").trim(), secp256k1Pub: secp256k1_pubkey.trim(), displayName: display_name?.trim() }
        );
        const verb = r.outcome === "created" ? "Added" : r.outcome === "noop" ? "Already connected to" : "Repaired contact";
        return { content: [{ type: "text", text: `${verb} ${display_name || crow_id} (${r.outcome}).` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to add contact: ${err.message}` }], isError: true };
      }
    }
  );
```

- [ ] **Step 6: Run test to verify tool wiring loads**

Run: `node --test tests/contact-promote.test.js && node -e "import('./servers/sharing/tools/contacts.js').then(()=>console.log('ok'))"`
Expected: PASS + `ok` (module imports cleanly).

- [ ] **Step 7: Commit**

```bash
git commit servers/sharing/contact-promote.js servers/sharing/tools/contacts.js tests/contact-promote.test.js -m "feat(messages): upsertFullContact insert/promote/merge helper + crow_add_contact repair tool (R4)"
git show --stat HEAD
```

---

## Task 3: Promote on authenticated `invite_accepted` (rewire the auto-add handler)

**Files:**
- Modify: `servers/sharing/boot.js:327-348` (extract + rewire `onInviteAccepted`)
- Test: `tests/invite-accepted-promote.test.js`

**Interfaces:**
- Consumes: `upsertFullContact` (Task 2).
- Produces: `handleInviteAccepted(db, managers, payload) : Promise<void>` — exported from `boot.js` (mirrors the already-exported `handleIncomingRequest`). Validates `payload.crowId && payload.ed25519Pub && payload.secp256k1Pub`; delegates to `upsertFullContact`. **Fully guarded — never throws** (receive path). This is the ONLY promotion trigger (per operator decision: authenticated `invite_accepted` only).

**Security note for the reviewer:** `handleInviteAccepted` is invoked exclusively from the `payload.type === "invite_accepted"` branch of `subscribeToIncoming` (`nostr.js:417`), reached only after NIP-44 decryption with our key. The sender's secp key is `event.pubkey` (cryptographically bound to the signed event). Promotion binds `request_status → NULL` to "the secp identity that proved it holds a DM we could decrypt AND is completing an invite handshake." A plaintext DM routes to `handleIncomingRequest` (unchanged) and can NEVER reach `upsertFullContact`. Trust boundary preserved.

- [ ] **Step 1: Write the failing test**

Create `tests/invite-accepted-promote.test.js`:
```js
/**
 * invite-accepted-promote — R4 Task 3. handleInviteAccepted must promote an
 * existing accepted/pending message-request row (secp-only, gated) into a full
 * (request_status NULL) contact when the same secp identity sends a valid
 * invite_accepted, WITHOUT creating a duplicate — and add a brand-new full
 * contact when no prior row exists. Managers are stubbed (no live relays).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInviteAccepted } from "../servers/sharing/boot.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "invacc-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
const stubMgrs = () => ({
  syncManager: { initContact: async () => {} },
  peerManager: { joinContact: async () => {} },
  nostrManager: { subscribeToContact: async () => {} },
});

const PK = "02" + "c".repeat(64);
const PK_XONLY = "c".repeat(64);
const payload = { type: "invite_accepted", crowId: "crow:realpeer9", ed25519Pub: "d".repeat(64), secp256k1Pub: PK };

test("promotes an accepted request in place (no duplicate)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, '', ?, 'crow', 'accepted')`,
      args: ["req:" + PK_XONLY, PK],
    });
    await handleInviteAccepted(db, stubMgrs(), payload);
    const { rows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?", args: [PK_XONLY],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].crow_id, "crow:realpeer9");
    assert.equal(rows[0].request_status, null);
  } finally { cleanup(); }
});

test("adds a fresh full contact when no prior row exists", async () => {
  const { db, cleanup } = freshDb();
  try {
    await handleInviteAccepted(db, stubMgrs(), payload);
    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: ["crow:realpeer9"] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].request_status, null);
  } finally { cleanup(); }
});

test("ignores an incomplete payload and never throws", async () => {
  const { db, cleanup } = freshDb();
  try {
    await handleInviteAccepted(db, stubMgrs(), { type: "invite_accepted", crowId: "crow:x" }); // no keys
    const { rows } = await db.execute({ sql: "SELECT COUNT(*) c FROM contacts", args: [] });
    assert.equal(Number(rows[0].c), 0);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/invite-accepted-promote.test.js`
Expected: FAIL — `handleInviteAccepted` not exported.

- [ ] **Step 3: Add the exported handler and rewire boot**

In `servers/sharing/boot.js`, add the import near the top (with the other local imports around line 16-22):
```js
import { upsertFullContact } from "./contact-promote.js";
```
Add the exported function at module scope (anywhere top-level is fine; a natural spot is just after `handleIncomingRequest`'s body closes at `boot.js:122` — note `deliverPendingShares` sits between it and `initSharingRuntime`, so don't expect adjacency to `initSharingRuntime`):
```js
/**
 * R4: an authenticated invite_accepted DM completes the handshake. Promotes an
 * existing accepted/pending message-request row for the same secp identity into
 * a FULL contact (or adds a fresh one), via the idempotent upsertFullContact.
 * This is the ONLY promotion trigger — the plaintext message-request path can
 * NEVER elevate a contact. Never throws (receive path).
 */
export async function handleInviteAccepted(db, managers, payload) {
  try {
    if (!payload || !payload.crowId || !payload.ed25519Pub || !payload.secp256k1Pub) return;
    await upsertFullContact(db, managers, {
      crowId: payload.crowId,
      ed25519Pub: payload.ed25519Pub,
      secp256k1Pub: payload.secp256k1Pub,
      displayName: payload.displayName,
    });
  } catch (err) {
    try { console.warn("[sharing] invite_accepted promotion failed:", err.message); } catch {}
  }
}
```
Replace the inline `onInviteAccepted` callback (the first argument to `subscribeToIncoming`) — from `async (payload) => {` at `boot.js:327` through its closing `}` immediately before `}, async (subtype, payload, senderPubkey) => {` at `boot.js:349` — with a thin delegation:
```js
      await nostrManager.subscribeToIncoming(async (payload) => {
        await handleInviteAccepted(db, { syncManager, peerManager, nostrManager }, payload);
      }, async (subtype, payload, senderPubkey) => {
```
(Leave the `onSocialMessage` and `onMessageRequest` callbacks that follow exactly as they are.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/invite-accepted-promote.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify boot module still imports and the receive wiring is intact**

Run: `node --test tests/invite-accepted-promote.test.js tests/message-request-receive.test.js tests/message-request-gates.test.js`
Expected: PASS (all) — the trust-gate suite proves the plaintext path is unchanged.

- [ ] **Step 6: Commit**

```bash
git commit servers/sharing/boot.js tests/invite-accepted-promote.test.js -m "feat(messages): promote an accepted request to a full contact on authenticated invite_accepted (R4)"
git show --stat HEAD
```

---

## Task 4: Contacts-panel "Add by Crow ID" repair form

**Files:**
- Modify: `servers/gateway/dashboard/panels/contacts/api-handlers.js` (new `add_by_id` action)
- Modify: `servers/gateway/dashboard/panels/contacts/html.js` (the form)
- Modify: `servers/gateway/dashboard/panels/contacts/client.js` (open/close the form, if the panel uses a JS-toggled dialog)
- Test: `tests/contacts-add-by-id-action.test.js`

**Interfaces:**
- Consumes: the `crow_add_contact` MCP tool (Task 2), reached via `sharingClientFactory` — the same in-process path `add_manual`'s neighbors and the Messages panel's `accept_invite` already use (`servers/gateway/dashboard/panels/messages/api-handlers.js:121-133`).
- Produces: POST action `add_by_id` on `/dashboard/contacts` accepting `crow_id`, `secp256k1_pubkey`, `ed25519_pubkey?`, `name?`.

- [ ] **Step 1: Write the failing test**

Create `tests/contacts-add-by-id-action.test.js`:
```js
/**
 * contacts-add-by-id-action — R4 Task 4. The Contacts panel add_by_id action
 * calls the crow_add_contact tool with the pasted keys (via an injected
 * sharing-client factory) and redirects. Asserts the tool is called with the
 * normalized args and that a missing crow_id/secp key is a safe no-op redirect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "addbyid-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function stubFactory(record) {
  return async () => ({
    callTool: async ({ name, arguments: args }) => { record.push({ name, args }); return { content: [{ type: "text", text: "ok" }] }; },
    close: async () => {},
  });
}

test("add_by_id calls crow_add_contact with the pasted keys", async () => {
  const { db, cleanup } = freshDb();
  try {
    const calls = [];
    const req = { body: { action: "add_by_id", crow_id: "crow:peer1", secp256k1_pubkey: "02" + "a".repeat(64), ed25519_pubkey: "b".repeat(64), name: "Peer" } };
    const out = await handleContactAction(req, db, { sharingClientFactory: stubFactory(calls) });
    assert.ok(out && out.redirect, "returns a redirect");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "crow_add_contact");
    assert.equal(calls[0].args.crow_id, "crow:peer1");
    assert.equal(calls[0].args.secp256k1_pubkey, "02" + "a".repeat(64));
  } finally { cleanup(); }
});

test("add_by_id with a missing key is a safe no-op redirect (no tool call)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const calls = [];
    const req = { body: { action: "add_by_id", crow_id: "", secp256k1_pubkey: "" } };
    const out = await handleContactAction(req, db, { sharingClientFactory: stubFactory(calls) });
    assert.ok(out && out.redirect);
    assert.equal(calls.length, 0);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/contacts-add-by-id-action.test.js`
Expected: FAIL — `add_by_id` unhandled → `handleContactAction` returns something without a `.redirect` for that branch (or falls through).

- [ ] **Step 3: Implement the `add_by_id` action**

In `servers/gateway/dashboard/panels/contacts/api-handlers.js`, add this branch immediately after the `add_manual` block (after `contacts.js:93`):
```js
  // R4: repair/add a real Crow contact by pasting its Crow ID + public keys.
  // Delegates to the crow_add_contact tool (idempotent insert/promote/merge),
  // which does the sync/DHT/Nostr wiring in-process.
  if (action === "add_by_id") {
    const crowId = (req.body.crow_id || "").trim();
    const secp = (req.body.secp256k1_pubkey || "").trim();
    if (!crowId || !secp) return { redirect: "/dashboard/contacts" };
    try {
      const client = await sharingClientFactory();
      try {
        await client.callTool({
          name: "crow_add_contact",
          arguments: {
            crow_id: crowId,
            secp256k1_pubkey: secp,
            ed25519_pubkey: (req.body.ed25519_pubkey || "").trim() || undefined,
            display_name: (req.body.name || "").trim() || undefined,
          },
        });
      } finally { try { await client.close?.(); } catch {} }
    } catch (err) {
      console.error("[contacts] add_by_id failed:", err.message);
    }
    return { redirect: "/dashboard/contacts" };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/contacts-add-by-id-action.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the form UI**

In `servers/gateway/dashboard/panels/contacts/html.js`, grep for `add_manual` to find the existing add-contact `<form>` and **copy its exact markup convention** — this panel uses inline `style="..."` attributes and `${t(...)}` i18n interpolation, NOT CSS classes like `contact-add-form`/`hint`. Add a sibling repair form matching that convention. Use the neighboring form's field/label/button inline styles verbatim; the only new content is the four fields and the hidden `action=add_by_id`. Skeleton (restyle inline to match the sibling exactly, and route user-facing strings through `t(...)` as the sibling does):
```html
<form method="POST" action="/dashboard/contacts" style="/* copy the add_manual form's inline style */">
  <input type="hidden" name="action" value="add_by_id">
  <!-- heading + hint: mirror the sibling's inline-styled label/hint elements -->
  <input name="crow_id" placeholder="crow:abcd1234" required>
  <input name="secp256k1_pubkey" placeholder="secp256k1 public key (64/66 hex)" required>
  <input name="ed25519_pubkey" placeholder="ed25519 public key (optional — enables sync)">
  <input name="name" placeholder="Display name (optional)">
  <button type="submit">Add / repair contact</button>
</form>
```
If the panel gates the add-form behind a toggle in `client.js`, wire this form's visibility with the same toggle pattern the `add_manual` form uses (grep `add_manual` in `client.js`); if the panel shows forms inline, no `client.js` change is needed — drop `client.js` from the commit.

- [ ] **Step 6: Verify the panel renders and the suite is green**

Run: `node --test tests/contacts-add-by-id-action.test.js`
Then confirm the gateway boots and the Contacts panel HTML builds without error:
Run: `node -e "import('./servers/gateway/dashboard/panels/contacts/html.js').then(()=>console.log('html ok'))"`
Expected: PASS + `html ok`.

- [ ] **Step 7: Commit**

```bash
git commit servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/panels/contacts/html.js servers/gateway/dashboard/panels/contacts/client.js tests/contacts-add-by-id-action.test.js -m "feat(messages): Contacts-panel Add-by-Crow-ID repair form for a half-completed handshake (R4)"
git show --stat HEAD
```
(If `client.js` was not touched, drop it from the commit path list.)

---

## Task 5: Full-suite green, gateway boot, security review, plan-doc & ledger

**Files:**
- Modify: `.superpowers/sdd/progress.md` (append R4 ledger)
- Modify: `docs/superpowers/plans/2026-07-02-messages-p1b-r4-handshake-repair.md` (add a Review section)

- [ ] **Step 1: Run the full test suite**

Run: `node --test tests/`
Expected: all pass (baseline 922 + the 4 new files' cases; the two historically-flaky env tests noted in prior ledgers should be re-confirmed, not newly broken by this branch).

- [ ] **Step 2: Verify the gateway starts cleanly**

Run: `node servers/gateway/index.js --no-auth` then Ctrl-C after it logs "listening".
Expected: no unhandled rejection; `[sharing] Subscribed to incoming Nostr messages` appears; no schema-init loop (SCHEMA_GENERATION unchanged → no migration on an up-to-date DB).

- [ ] **Step 3: Dedicated security review of the promotion/merge path**

Dispatch a security-focused review (the trust boundary is the crux). It must confirm:
- Promotion (`request_status → NULL`) is reachable ONLY from `handleInviteAccepted` (authenticated `invite_accepted`) and `crow_add_contact` (kiosk-guarded operator tool) — never from `handleIncomingRequest` or any plaintext branch. Grep `upsertFullContact` call sites to prove it.
- `crow_add_contact` is kiosk-guarded (matches `crow_accept_invite`/`crow_generate_invite`).
- The merge branch cannot orphan or cross-wire messages, and `crow_id UNIQUE` cannot be violated (the merge path deletes the losing row before the winner keeps the id).
- `add_by_id` validates presence of crow_id + secp key and cannot inject via the tool args.
- The intended crow_id-rebind (a full contact, same secp key, different crow_id → `promoted` with the crow_id rewritten) is acceptable given the secp key is cryptographically bound on the `invite_accepted` path and operator-supplied on the tool path — confirm no unintended trust transfer (e.g. it does not silently reassign an unrelated contact's identity).

- [ ] **Step 4: Append the R4 ledger to `.superpowers/sdd/progress.md`**

Add a `# Messages P1b R4 (handshake repair) ledger` section recording each task's commit, review verdict, and the final suite count.

- [ ] **Step 5: Add the Review section to this plan (after 2-round adversarial review is applied) and commit**

```bash
git commit .superpowers/sdd/progress.md docs/superpowers/plans/2026-07-02-messages-p1b-r4-handshake-repair.md -m "docs(messages): R4 handshake-repair ledger + plan review record"
git show --stat HEAD
```

---

## Self-Review (against the R4 scope from the master plan + operator directive)

**Spec coverage:**
- "idempotent + persistent invite_accepted processing, kill the 24h initialSince cliff (L3)" → Task 1 (persistent monotonic cursor) + Task 3 (idempotent via `upsertFullContact`). ✅
- "add-by crow_id + ed25519 + secp repair primitive (tool + UI)" → Task 2 (`crow_add_contact` tool) + Task 4 (Contacts form). ✅
- "promote an L6 accepted-request into a FULL peer-synced contact once the sender's identity arrives" → Task 3 (promote-in-place, keyed on secp), gated to authenticated `invite_accepted` only per the operator's locked decision. ✅

**Placeholder scan:** none — every step carries real code/commands.

**Type consistency:** `upsertFullContact(db, managers, {crowId, ed25519Pub, secp256k1Pub, displayName})` and its `{contactId, outcome}` return are used identically in Tasks 2/3/4; `readIncomingSince`/`persistIncomingCursor` signatures match between Task 1's helper and its `nostr.js` call sites; the tool name `crow_add_contact` is identical in Tasks 2 and 4.

**Known follow-ups (out of scope, log in ledger):** R5 delivered-ack + retry queue (the true offline-delivery fix — the cursor reduces but cannot eliminate relay-retention loss); delete the dead `send_peer` api-handler; extend 0-relay failure detection to `crow_send_group_message`; apple-touch-icon PNG.

## Review

**Round 1 (2026-07-02, adversarial Plan subagent, opus): REVISE — all findings applied.**
- **C1 (critical):** the `merged` branch was unreachable / order-dependent — it inferred "the other row" from `findContactByPubkey`, which has no `ORDER BY` (returns rowid-first). Rewrote `upsertFullContact` to resolve deterministically: `byCrow` (unique) + all secp matches (`ORDER BY id`), then `otherSecp = secpRows.find(id != byCrow.id)`. Merge is now order-independent.
- **C2 (critical):** advancing the cursor to ~now shrank the reboot back-fill from 24h→1h (a regression for the busy-inviter case), and a stale cursor could flood/​truncate on relays. `readIncomingSince` now **clamps**: never newer than `now-24h` (≥ old floor, no regression), never older than `now-30d` (bounds the flood). Tests updated to the three clamp regimes.
- **I1 (important):** the crowId-owner completion branch silently rebased a trusted contact's secp key from pasted input — added a conflict guard that THROWS on a full contact with a differing key.
- **I2 (important):** resolved the raw-`db` waffle — the tool passes raw `db` (matches `crow_accept_invite` at `contacts.js:78,90` and the tests).
- **M1:** merge message-reassignment uses a plain `UPDATE` (not `OR IGNORE`) — a genuine `nostr_event_id` collision surfaces instead of silently dropping.
- **M2:** Task 4 form markup note corrected to the panel's inline-style + `${t(...)}` convention (no CSS classes).
- **M3 / off-by-one:** handler-placement note and the `327-349` callback range corrected.
- **Confirmed-correct (no action):** trust boundary (promotion unreachable from the plaintext path); `{redirect}` return shape for the contacts panel; `handleContactAction` factory-injection signature; test DB harness; kiosk guard on `crow_add_contact`; no `SCHEMA_GENERATION` bump (reuses `dashboard_settings`).

**Round 2 (2026-07-02, focused Plan subagent, opus): APPROVE.** Traced every `upsertFullContact` branch against the 4 test scenarios + 5 extra cases (pending-promote-no-owner, order-independent merge, idempotent re-arrival noop, validation throws, UNIQUE-impossibility proof) and confirmed the clamp math for all three cursor regimes, monotonic `ON CONFLICT` max, `this.db`/`event.created_at` availability, and that the cursor never advances on a foreign (undecryptable) event. Applied its 2 mechanical minors — dropped the unused `findContactByPubkey` import; corrected Task 1 Step 4 to "6 tests". Its one informational item (a full contact with the same secp but a different crow_id is silently rebound) is now an explicit, commented, security-reviewed decision (intended repair behavior; secp is cryptographically bound). **Plan is ready for subagent-driven execution.**
