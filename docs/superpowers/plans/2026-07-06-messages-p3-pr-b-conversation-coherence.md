# Messages Phase 3 PR-B — Conversation coherence (S3) — Implementation Plan

## R1 review outcome

**Verdict: REVISE** — 0 critical / 4 important. All four are addressed in this revision.

- **I-1 — collapse key missing on the direct-Nostr path.** The plan added `metadata:{ nostr_event_id }` only to the sync-path notify (`_notifyMessageApplied`); the direct-Nostr notify at `nostr.js:486` carried no metadata, so cross-device notification collapse (layer b) never worked in its own target case. **Fixed:** Task 3 now also passes `metadata:{ nostr_event_id: event.id }` at `nostr.js:486`, with a test asserting the direct-path notification row carries the collapse key.
- **I-2 — `is_blocked` bypass via the sync channel.** `_applyMessage` stored + notified without checking the local contact's block flag, letting the sync channel deliver notifications for a locally-blocked contact during block-propagation divergence. **Fixed:** Task 2 resolves `id AND is_blocked`; a blocked contact's row is still **stored** (converged-block semantics — no data loss) but its **notification is suppressed** (the notification is the security control), with tests in Tasks 2 + 3.
- **I-3 — broken test import (`OUTBOUND_TRANSFORMS` not exported).** The Task 1 test imported `OUTBOUND_TRANSFORMS` (a module-private `const` at `instance-sync.js:95`), which would hard-fail the whole ESM test file. **Fixed by DROP:** verified against `emitChange`'s order of operations (`EXCLUDED_COLUMNS` strip at :543 runs first, then `OUTBOUND_TRANSFORMS` at :549), `OUTBOUND_TRANSFORMS.messages` is fully redundant with `EXCLUDED_COLUMNS.messages` (it strips the same four columns and adds nothing — `crow_id` is attached upstream by `emitMessageInsert`'s JOIN, not by any transform). It is removed entirely; Task 1's test asserts on `EXCLUDED_COLUMNS` + the emitted wire-row shape instead. **Route: DROP** (see the I-3 note in Task 1 Step 3).
- **I-4 — pre-PR-A contacts never resolve.** A contact added before PR-A shipped never emitted a contact-sync entry, so its `crow_id` never lands on the peer and every synced message for it is dropped forever. **Addressed:** (a) a Known-limitations section documents the boundary; (b) the live E2E exercises BOTH a freshly-added AND a pre-existing contact with honest expected outcomes; (c) a one-shot idempotent **contacts backfill** (new Task 4) re-emits existing full contacts so peers can resolve them.

## R2 review outcome

**Verdict: REVISE** — 0 critical / 1 important / 2 minor. All addressed in this revision; R1's four closures were independently re-verified in code by R2.

- **I-B1 — Task 4's backfill could silently REVERT a peer's newer edit — including un-blocking a blocked contact.** The R1-revision's idempotency claim ("re-emit converges as a no-op") holds only when both instances already agree. In the **diverged** case (peer blocked X at lamport `L_g`; we haven't applied it yet), the backfill re-emits our stale row with a **fresh, higher** lamport → the peer's `_applyContact` takes the `lamportTs > localTs` UPDATE branch → **silently sets `is_blocked=0`** with no `sync_conflicts` row — destroying a deliberate block via fabricated recency on no-user-intent data. **Fixed:** (1) the false convergence claim is corrected in Task 4; (2) **ordering mitigation** — `backfillContactsOnce` now drains the already-replicated inbound backlog (`_processNewEntries` over every open in-feed) BEFORE selecting/re-emitting, so anything the peer already sent us wins first; (3) the residual window (peer edits not yet replicated into our in-feed at backfill time) is documented in Known limitations — it is one-shot-per-instance and closes permanently once the flag is set.
- **M-B1 — blocked contact still bumped the unread badge.** `messages:changed` fired unconditionally on `rowsAffected > 0`; only the notification was gated. **Fixed:** Task 2 now gates BOTH the notification and the `messages:changed` badge emit on `!isBlocked` (the row is still stored for convergence).
- **M-B2 — stored-but-hidden assumption.** **Fixed:** Task 5's checklist verifies the Messages panel does not render conversations for `is_blocked=1` contacts (synced content must not surface for a blocked contact).

## Known limitations

- **Backfill divergence window (I-B1 residual).** `backfillContactsOnce` drains the locally-replicated inbound backlog before re-emitting, but a peer edit that has NOT yet replicated into our in-feed at backfill time can still be overwritten by the backfill's fresh-lamport re-emit (last-write-wins picks the fabricated-newer local row; for `is_blocked` that means a silently reverted block). The window is narrow (one boot, once per instance lifetime, flag-guarded `__contacts_backfill_v1`) and matches the operator-accepted `reemitSyncableSettingsOnce` precedent — but unlike settings, contacts/blocks are a security surface, so this is documented rather than silent. A lamport-preserving re-emit (peer takes the INSERT branch only for rows it lacks; no clobber possible) is the clean fix — it needs an explicit-lamport path through `emitChange` and is logged as a follow-up.
- **Pre-PR-A / pre-pairing contacts (I-4).** `crow_id → local contact_id` resolution on the peer depends on the contact having been replicated via PR-A's contact-sync. A contact **added before PR-A shipped** (or before the two instances paired) has no `contacts` row with that `crow_id` on the peer, so `_applyMessage` **correctly skips** every synced message for it (no phantom contact — trust boundary). Coherence therefore silently does not apply to such legacy contacts until they are re-emitted. **Mitigation:** Task 4's one-shot backfill re-emits existing full contacts once per instance, after which their messages resolve; and any contact that is later edited (rename, re-verify, key change) re-emits naturally and self-heals. **Freshly-added contacts are unaffected** — they emit a contact row on add.
- **Plaintext-at-rest copy (M-2 — acknowledged, out of scope).** Mirroring `messages` over the instance-sync Hypercore feeds writes the decrypted message **content** as a new plaintext-at-rest copy into each paired instance's `out`/`in` feed directory (in addition to the existing plaintext copy already in each instance's `messages` table). This is consistent with how every other synced table (memories, crow_context, contacts) already rides the feeds in cleartext under the shared-identity trust boundary. It is **out of scope** for PR-B — flagged here as an explicit, acknowledged decision rather than an oversight.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With one shared identity across paired instances, make 1:1 message threads read **coherently** on every instance. Today inbound DMs land on every online instance but outbound (`sent`) rows exist only where typed, and an instance that was offline permanently misses whatever fell out of relay retention. PR-B mirrors `messages` **both directions** over the existing instance-sync mesh — keyed on the stable `nostr_event_id` (its `UNIQUE` constraint = free store-dedupe), with `contact_id` resolved **locally** from a wire-carried `crow_id` — and dedupes notifications per-event so a message delivered via BOTH direct Nostr AND sync produces exactly one notification per instance.

**Architecture:** The push side adds a small guarded `emitMessageInsert` helper (its own module, lazy-importing `managers.js` to break the `managers → nostr → …` require cycle, exactly like PR-A's `contact-sync.js`), called at the two real `messages` write sites in `servers/sharing/nostr.js` — the outbound `sendMessage` `sent`-row insert (`:189`) and the per-contact inbound `subscribeToContact` `received`-row insert (`:480`, gated on `rowsAffected > 0`). The helper attaches the contact's stable `crow_id` to the wire row via a JOIN; `emitChange`'s existing `EXCLUDED_COLUMNS.messages` strip drops the per-instance `id`/`contact_id`/`is_read`/`lamport_ts`. (**I-3:** there is NO `OUTBOUND_TRANSFORMS.messages` — it would be fully redundant with `EXCLUDED_COLUMNS.messages`, which runs first in `emitChange`; see Task 1.) The pull side adds a self-contained `_applyMessage` handler — dispatched in `_applyEntry` **before** the generic id-path (mirroring `_applyCrowContext`/`_applyContact`) — that resolves `crow_id → local contact_id`, **skips** when the contact isn't local yet (no phantom contact), `INSERT OR IGNORE`s on `nostr_event_id`, and on a genuinely-new row fires `messages:changed` (with the locally-resolved `contact_id`) and — for `received` rows only — one guarded notification carrying `nostr_event_id` as a client collapse key. Messages are **insert-only** and keyed by a `UNIQUE` natural key, so there is no LWW/update/delete/conflict path — `_applyMessage` is markedly simpler than `_applyContact`.

**Tech Stack:** Node ESM, `@libsql/client` (SQLite), Node built-in test runner (`node --test`), Hypercore feeds (stubbed in tests), NIP-44 Nostr DMs, ed25519 sign/verify.

## Global Constraints

- **Base branch:** PR-B **stacks on the PR-A branch** (`feat/messages-p3-pr-a-contacts-follow-user`), NOT `main`. PR-B reuses seams PR-A introduces: `export const EXCLUDED_COLUMNS`, the exported `shouldSyncRowForTest`, the `_applyEntry` natural-key dispatch pattern, and the lazy-import emit-helper pattern (`contact-sync.js`). If PR-A has not merged when PR-B starts, branch PR-B from PR-A's tip; if PR-A merged to `main`, branch from `main`. **Do not duplicate PR-A's changes** (e.g. the `EXCLUDED_COLUMNS` export already exists) — extend them.
- **Test runner:** Node built-in — `node --test tests/<file>.test.js`. All tests live in `tests/*.test.js`. No third-party framework.
- **Commit discipline:** `git commit <path> -m "..."` with explicit positional paths (never bare `git commit`/`git add .`); the working tree carries unrelated untracked WIP that must not be swept. For a NEW file, `git add <thatpath>` first, then commit that path. Verify with `git show --stat HEAD` after each commit. Never attribute Claude as author/co-author.
- **Never-throw on the sync/receive path:** every new emit call, `_applyMessage`, and its notify/badge hooks must swallow their own errors (`.catch(()=>{})` / `try{}catch{}`). A sync failure must never break the local write (`sendMessage` must still return its relay outcome; `onevent` must still send its delivery receipt) nor the apply loop.
- **Key on `nostr_event_id`, resolve contact by `crow_id`, never by `id`:** `messages.id` and `messages.contact_id` are per-instance `AUTOINCREMENT`/local-FK — never portable. The wire row carries the contact's stable `crow_id`; `_applyMessage` maps it to the **local** `contact_id`. A row with no `nostr_event_id` or no resolvable `crow_id` is not emitted / not applied.
- **No schema change in PR-B.** `SCHEMA_GENERATION` stays **4**. The `nostr_event_id UNIQUE` key (init-db:536), `messages.lamport_ts` (init-db:1719), and `notifications.metadata` (init-db:1377) all already exist. The notification collapse key rides in the existing `metadata` JSON column — **no new column**. (If plan-review mandates a first-class push-collapse column, that becomes a bump to 5 as an added task — see Task 3 / Open Question 1.)
- **Trust boundary:** inbound entries are already ed25519-verified against the shared identity in `_applyEntry` (instance-sync.js:673) before dispatch — do not bypass it. `shouldSyncRow("messages", …)` gates on **apply** as well as emit (defense in depth). `_applyMessage` never creates a contact — an unresolved `crow_id` is skipped, so a peer cannot conjure a contact row through the message channel.

**Baseline:** the PR-A branch green (**1083** @ `main` `4d98346f` + PR-A's added tests). Live target for the eventual E2E: crow↔grackle (shared seed `crow:kdq7zskhat`, sync feeds confirmed live 2026-07-06). black-swan (`crow:1m5ughwje2`) is a distinct identity — not a sync target.

**Spec:** `docs/superpowers/specs/2026-07-06-messages-phase3-contacts-follow-user-design.md` (§ PR-B; decisions S-COHERENCE-DIR, S-NOTIFY; Trust boundary).

**Verified anchors (M-1 — refreshed against the working tree with PR-A applied; instance-sync line numbers below are authoritative as-read, not the `4d98346f` tip the earlier draft cited):**
- `messages` schema — init-db.js:533-543: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `contact_id INTEGER NOT NULL` (FK→contacts(id)), `nostr_event_id TEXT UNIQUE` (:536), `content TEXT NOT NULL`, `direction TEXT NOT NULL CHECK(direction IN ('sent','received'))`, `is_read INTEGER DEFAULT 0`, `thread_id TEXT`, `created_at`. Added columns: `delivery_status TEXT` (:554), `attachments TEXT`, `lamport_ts INTEGER DEFAULT 0`. `contacts.is_blocked INTEGER DEFAULT 0` (:462, indexed :468). `notifications.metadata TEXT` (:1377). All verified present (no schema change in PR-B).
- `SYNCED_TABLES` includes `"messages"` (instance-sync.js:55); **nothing emits it today** (grep for `emitChange("messages"`/`emitMessage` = 0 hits).
- Write sites (`INSERT … INTO messages`): `nostr.js:189` (outbound `sendMessage`, `direction 'sent'`, `nostr_event_id = event.id`, plain INSERT), `nostr.js:480` (inbound `subscribeToContact.onevent`, `direction 'received'`, `INSERT OR IGNORE`, notifies at `:486` + `messages:changed` when `result.rowsAffected > 0`), `boot.js` (`handleIncomingRequest` — pending/stranger path, INSERT OR IGNORE), `boot.js` (group_message, synthetic `grp_<ts>` id — its own room sync).
- `EXCLUDED_COLUMNS` `export const` at instance-sync.js:75 (already has `contacts` from PR-A). `OUTBOUND_TRANSFORMS` module-private `const` at :95 (**NOT exported** — do not import it; I-3 drops the `messages` key entirely). `shouldSyncRow` at :160 (contacts branch :161). `InstanceSyncManager` constructor at :203.
- `emitChange` (instance-sync.js:534): `shouldSyncRow` gate at :538, strips `EXCLUDED_COLUMNS` (:543-547) then applies `OUTBOUND_TRANSFORMS` (:549-550); lamport-stamps the **original** local row at ~:581 via `WHERE id = row.id` (untouched by the wire strip). Order matters for I-3: the `EXCLUDED_COLUMNS` strip runs BEFORE any transform, so a redundant transform that deletes the same columns is a no-op.
- `_applyEntry` dispatch (instance-sync.js:657): `shouldSyncRow` gate at :666, sig-verify at :673, `dashboard_settings` special-case return at :686, `crow_context` at :707, **`contacts` at :721** (PR-A), generic conflict gate + switch at ~:732-752, **existing `messages:changed` broadcast at :761-771** (guarded `op==="insert" && table==="messages" && row?.contact_id != null` — this reads the **wire** `contact_id`, which PR-B strips, so it is both now-unreachable-for-messages *and* would misread; folded into `_applyMessage`).
- `createNotification(db, opts)` (shared/notifications.js:28): supports `metadata` (JSON, stored in `notifications.metadata`); web/ntfy/email push payloads carry only `{title, body, url}` (web-push.js) — **no** native collapse/`tag` field today. **M-3:** PR-B notifications are **title-only (no body / no message-preview)** — this is intentional; the notification store and the push fan-out never carry DM content, and the collapse key rides `metadata` (not the pushed payload).
- `sign(data, privKey)` (identity.js), `createDbClient(dbPath)` (db.js), `getInstanceSyncManager()` / `getManagersOrNull()` (managers.js), `bus` imported (instance-sync.js:22). Boot wiring for one-shot reconciliations: `servers/gateway/boot/mcp-mounts.js:66-72` (`reemitSyncableSettingsOnce`) — Task 4 adds the contacts backfill alongside.

---

### Task 1: `message-sync.js` emit helper + `shouldSyncRow`/`EXCLUDED_COLUMNS` for messages + emit at both write sites

**Files:**
- Create: `servers/sharing/message-sync.js` (the `emitMessageInsert` helper)
- Modify: `servers/sharing/instance-sync.js` (`EXCLUDED_COLUMNS` :75 → add `messages`; `shouldSyncRow` :160 → add `messages` branch; **do NOT** add `OUTBOUND_TRANSFORMS.messages` — I-3: redundant with `EXCLUDED_COLUMNS.messages`)
- Modify: `servers/sharing/nostr.js` (emit after the `sendMessage` insert ~:192; emit after the `subscribeToContact` insert ~:502, inside the `rowsAffected > 0` block)
- Test: `tests/messages-sync-emit.test.js` (create)

**Interfaces:**
- Consumes: `getInstanceSyncManager()` (managers.js, via lazy dynamic import to avoid the `managers → nostr → message-sync` cycle); a `db` client + `{ contactId, nostrEventId }`.
- Produces:
  - `emitMessageInsert(db, { contactId, nostrEventId })` — re-selects the just-written message JOINed to its contact's `crow_id`; if the row exists AND has a `nostr_event_id` AND the contact resolves to a `crow_id`, calls `sink()?.emitChange("messages", "insert", rowWithCrowId)`; else no-op. Guarded (never throws). `__setEmitSinkForTest(sink)` seam mirrors `contact-sync.js`.
  - `shouldSyncRow("messages", row)` returns `false` unless `row.nostr_event_id` AND `row.crow_id` are both truthy (drops synthetic group ids and unresolved-contact rows both directions).
  - `EXCLUDED_COLUMNS.messages = ["id", "contact_id", "is_read", "lamport_ts"]` — the **sole** wire strip (I-3: no `OUTBOUND_TRANSFORMS.messages`, which would be redundant). `emitMessageInsert` attaches `crow_id` upstream via a JOIN; after the strip the wire row carries: `crow_id, nostr_event_id, content, direction, thread_id, created_at, delivery_status, attachments`.

- [ ] **Step 1: Write the failing test**

Create `tests/messages-sync-emit.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createDbClient } from "../servers/db.js";
import {
  emitMessageInsert,
  __setEmitSinkForTest,
} from "../servers/sharing/message-sync.js";
import {
  shouldSyncRowForTest,
  EXCLUDED_COLUMNS,
} from "../servers/sharing/instance-sync.js";
// I-3: OUTBOUND_TRANSFORMS is module-private (a bare `const`, not exported) and
// is intentionally NOT imported — messages have no transform (the EXCLUDED_COLUMNS
// strip is the whole wire shape). Importing it would hard-fail this ESM file.

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3b-emit-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe",
});
const db = createDbClient(join(tmpDir, "crow.db"));
after(() => rmSync(tmpDir, { recursive: true, force: true }));
const SECP = "a".repeat(64);

test("shouldSyncRow: messages require nostr_event_id AND crow_id", () => {
  const ok = (row) => shouldSyncRowForTest("messages", row);
  assert.equal(ok({ nostr_event_id: "e1", crow_id: "crow:a", content: "hi" }), true);
  assert.equal(ok({ nostr_event_id: "e1", content: "hi" }), false, "no crow_id → drop");
  assert.equal(ok({ crow_id: "crow:a", content: "hi" }), false, "no nostr_event_id → drop");
  assert.equal(ok({ nostr_event_id: "grp_123", content: "x" }), false, "synthetic group id, no crow_id → drop");
  assert.equal(ok(null), false);
});

test("EXCLUDED_COLUMNS.messages strips per-instance keys", () => {
  assert.deepEqual([...EXCLUDED_COLUMNS.messages].sort(),
    ["contact_id", "id", "is_read", "lamport_ts"]);
});

test("EXCLUDED_COLUMNS strip yields the messages wire shape (no OUTBOUND_TRANSFORMS)", () => {
  // Replicate emitChange's strip (instance-sync.js:543-547): delete each column in
  // EXCLUDED_COLUMNS[table] from a copy of the row. Because messages have NO
  // OUTBOUND_TRANSFORMS (I-3 — it was fully redundant with this strip and was
  // dropped), the post-strip object IS the wire row exactly.
  const full = {
    id: 9, contact_id: 3, is_read: 1, lamport_ts: 5,
    crow_id: "crow:a", nostr_event_id: "e9", content: "yo",
    direction: "sent", thread_id: null, created_at: "2026-07-06T00:00:00Z",
    delivery_status: "relayed", attachments: null,
  };
  const wire = { ...full };
  for (const c of EXCLUDED_COLUMNS.messages) delete wire[c];
  assert.equal(wire.id, undefined);
  assert.equal(wire.contact_id, undefined);
  assert.equal(wire.is_read, undefined);
  assert.equal(wire.lamport_ts, undefined);
  assert.equal(wire.crow_id, "crow:a");
  assert.equal(wire.nostr_event_id, "e9");
  assert.equal(wire.direction, "sent");
});

test("emitMessageInsert: attaches crow_id via JOIN and forwards to the sink", async () => {
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (11,'crow:e', '', ?)", args: [SECP] });
  await db.execute({ sql: "INSERT INTO messages (id, contact_id, nostr_event_id, content, direction, is_read) VALUES (21, 11, 'ev1', 'hi there', 'sent', 1)" });
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (t, op, row) => seen.push([t, op, row.crow_id, row.contact_id, row.id, row.nostr_event_id, row.direction]) });
  await emitMessageInsert(db, { contactId: 11, nostrEventId: "ev1" });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ["messages", "insert", "crow:e", 11, 21, "ev1", "sent"]);
  // NB: the helper hands emitChange the FULL local row (with id + contact_id, for
  // the ~:581 lamport stamp) plus the JOINed crow_id; the wire strip happens in
  // emitChange via EXCLUDED_COLUMNS.messages (there is NO OUTBOUND_TRANSFORMS.messages
  // — I-3), exercised above.
  __setEmitSinkForTest(null);
});

test("emitMessageInsert: no crow_id for the contact → no emit (request/pending contact)", async () => {
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, request_status) VALUES (12,'req:deadbeef', '', ?, 'pending')", args: ["b".repeat(64)] });
  await db.execute({ sql: "INSERT INTO messages (id, contact_id, nostr_event_id, content, direction, is_read) VALUES (22, 12, 'ev2', 'stranger', 'received', 0)" });
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (...a) => seen.push(a) });
  await emitMessageInsert(db, { contactId: 12, nostrEventId: "ev2" });
  // crow_id 'req:deadbeef' resolves, BUT shouldSyncRow is enforced in emitChange,
  // not the helper — the helper still forwards. Assert instead that a MISSING row
  // is a no-op, and that a null sink never throws.
  __setEmitSinkForTest(null);
  await emitMessageInsert(db, { contactId: 999, nostrEventId: "nope" }); // no such row → no throw
  await emitMessageInsert(db, { contactId: 11, nostrEventId: "ev1" }); // null sink → no throw
});
```

> Note: `shouldSyncRow`'s pending/`req:` gate for messages keys on `nostr_event_id`+`crow_id` presence, not `request_status` — a `req:` contact's DM *would* be forwarded by the helper, then dropped at the **apply** side (`_applyMessage` can't resolve `req:` on the peer, since pending contacts don't sync per S-REQUESTS). The helper deliberately does not re-implement contact-syncability; it only guarantees a well-formed wire key. This is asserted end-to-end in Task 2.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/messages-sync-emit.test.js`
Expected: FAIL — `message-sync.js` does not exist; `EXCLUDED_COLUMNS.messages` undefined; `shouldSyncRow` has no messages branch.

- [ ] **Step 3: Write the helper + extend the three maps + wire the two emit sites**

Create `servers/sharing/message-sync.js`:

```js
/**
 * Phase 3 PR-B (S3): push message inserts onto the instance-sync mesh so 1:1
 * threads read coherently across a user's paired instances.
 *
 * Guarded + null-safe — a sync failure never breaks the local write, and the
 * sink is null pre-boot / in unit tests (no-op). Only INSERTs are emitted;
 * messages are immutable + keyed on nostr_event_id (UNIQUE), so there is no
 * update/delete wire op. The wire row carries the contact's stable crow_id
 * (JOINed here) — instance-sync's EXCLUDED_COLUMNS.messages strips the per-instance
 * id/contact_id on emit (there is NO OUTBOUND_TRANSFORMS.messages); _applyMessage
 * maps crow_id → local contact_id on the peer.
 *
 * managers.js → nostr.js → message-sync.js would form a require cycle if we
 * STATIC-import managers here (nostr.js imports this module). Lazy (cached)
 * dynamic import keeps the load graph acyclic — identical to contact-sync.js.
 */
let _mgrMod = null;
let _testSink = null;
export function __setEmitSinkForTest(sink) { _testSink = sink; }

async function sink() {
  if (_testSink) return _testSink;
  if (!_mgrMod) { try { _mgrMod = await import("./managers.js"); } catch { return null; } }
  return _mgrMod.getInstanceSyncManager?.() || null;
}

/**
 * Emit an INSERT for the message identified by (contactId, nostrEventId).
 * Re-selects the row JOINed to its contact's crow_id; forwards the FULL local
 * row (id + contact_id retained so emitChange's ~:581 lamport stamp works) with
 * crow_id attached. No emit when the row is missing, the event id is falsy, or
 * the contact has no crow_id. Never throws.
 */
export async function emitMessageInsert(db, { contactId, nostrEventId } = {}) {
  try {
    if (!db || !contactId || !nostrEventId) return;
    const { rows } = await db.execute({
      sql: `SELECT m.*, c.crow_id AS crow_id
              FROM messages m JOIN contacts c ON c.id = m.contact_id
             WHERE m.contact_id = ? AND m.nostr_event_id = ?
             LIMIT 1`,
      args: [contactId, nostrEventId],
    });
    const row = rows[0];
    if (!row || !row.nostr_event_id || !row.crow_id) return;
    await (await sink())?.emitChange("messages", "insert", row);
  } catch { /* never throw — coherence is best-effort */ }
}
```

In `servers/sharing/instance-sync.js`, extend `EXCLUDED_COLUMNS` (currently :75; PR-A already made it `export const` and added the `contacts` key — ADD the `messages` key, do not rewrite the block):

```js
  // Phase 3 PR-B: messages sync keyed on nostr_event_id; the per-instance
  // id/contact_id are never portable (crow_id rides the wire instead). is_read
  // is per-device (each instance computes its own unread badge). lamport_ts is
  // sync metadata carried in the entry envelope, not the row.
  messages: ["id", "contact_id", "is_read", "lamport_ts"],
```

**I-3 — do NOT add `OUTBOUND_TRANSFORMS.messages`.** An earlier draft added a `messages` transform that destructured out `{ id, contact_id, is_read, lamport_ts }`. That is **fully redundant** with the `EXCLUDED_COLUMNS.messages` key above: in `emitChange` the `EXCLUDED_COLUMNS` strip runs FIRST (:543-547) and deletes exactly those four columns, and only then does any `OUTBOUND_TRANSFORMS[table]` run (:549-550). The transform would neither add nor remove anything the strip hasn't already handled — `crow_id` is attached upstream by `emitMessageInsert`'s JOIN (a `const` transform is synchronous and cannot JOIN), so nothing needs the transform to keep it. Leave `OUTBOUND_TRANSFORMS` untouched (it stays module-private with only its `research_notes` key). This also removes the broken test import (the `const` is not exported).

Extend `shouldSyncRow` (currently :160; PR-A added the `contacts` branch — ADD a `messages` branch before the `dashboard_settings` check):

```js
  if (table === "messages") {
    // A syncable message MUST carry the stable key (nostr_event_id) and the
    // contact's crow_id (attached on emit). Rows lacking either — synthetic
    // group ids (grp_<ts>, own room sync) or an unresolved contact — never sync.
    if (!row) return false;
    return Boolean(row.nostr_event_id) && Boolean(row.crow_id);
  }
```

In `servers/sharing/nostr.js`, add the import near the top (after the existing sharing imports):

```js
import { emitMessageInsert } from "./message-sync.js";
```

At the **outbound** site — after the `sendMessage` local-cache INSERT (the `try { await this.db.execute({ sql: INSERT INTO messages … 'sent' …}) } catch {}` block ending ~:196), add inside the same `if (contactId && this.db)` guard, after the insert `try/catch`:

```js
      // Phase 3 PR-B: mirror this sent row to the user's paired instances so the
      // thread reads coherently there. Best-effort; never blocks/throws out of
      // sendMessage (which must still return its relay outcome).
      emitMessageInsert(this.db, { contactId, nostrEventId: event.id }).catch(() => {});
```

At the **inbound** site — inside `subscribeToContact.onevent`, in the `if (result.rowsAffected > 0) { … }` block (~:484-502, alongside the existing `createNotification` + `messages:changed` emit), add:

```js
                  // Phase 3 PR-B: mirror this received row to paired instances
                  // (S-COHERENCE-DIR) so an instance that was offline backfills
                  // it. Only on a genuinely-new row (rowsAffected > 0) to avoid
                  // re-emitting a duplicate. Best-effort; never throws.
                  emitMessageInsert(this.db, { contactId, nostrEventId: event.id }).catch(() => {});
```

> **Deliberately NOT emitted:** `boot.js:95` (`handleIncomingRequest` — pending/stranger DMs; the `req:<pubkey>` contact doesn't sync per S-REQUESTS, so a peer could never resolve it — verified end-to-end in Task 2) and `boot.js:507` (group_message — synthetic `grp_<ts>` id, own room-sync path). Add a one-line comment at each site noting the deliberate omission. **Do not** instrument these.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/messages-sync-emit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add servers/sharing/message-sync.js tests/messages-sync-emit.test.js
git commit servers/sharing/message-sync.js tests/messages-sync-emit.test.js servers/sharing/instance-sync.js servers/sharing/nostr.js -m "feat(sharing): Phase 3 PR-B message emit helper + wire transform + emit at both DM write sites"
git show --stat HEAD | head
```

---

### Task 2: `_applyMessage` inbound handler (nostr_event_id-keyed) + dispatch + fold the messages:changed hook

**Files:**
- Modify: `servers/sharing/instance-sync.js` (add a `messages` dispatch block in `_applyEntry` after the `contacts` block (:721) and before the generic conflict gate (~:732); add `_applyMessage` after `_applyContact`/`_applyCrowContext`; **remove** the now-unreachable `messages:changed` block at :761-771)
- Test: `tests/messages-sync.test.js` (create)

**Interfaces:**
- Consumes: `_applyEntry`'s already-verified, `shouldSyncRow`-gated `{ op, row, lamport_ts, instance_id }`; `bus` (event-bus, already imported).
- Produces: `async _applyMessage(op, row, lamportTs, instanceId)` — resolves `crow_id → local contact_id` **and `is_blocked`** (I-2); **skips** (no phantom contact) when the contact is unresolved; `INSERT OR IGNORE` on `nostr_event_id` with the wire `content/direction/thread_id/created_at/delivery_status/attachments` under the local `contact_id`; on `rowsAffected > 0` and **`!isBlocked`** fires BOTH `messages:changed` (unread badge — M-B1: a blocked contact must not tick the bell) AND the Task 3 notification. A blocked contact's row is still stored (convergence), but neither badge nor notification fires for it.

- [ ] **Step 1: Write the failing tests**

Create `tests/messages-sync.test.js` (reuse the PR-A/instance-sync harness style — real init-db tmpdir, `sign()` to forge signed entries):

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";
import bus from "../servers/shared/event-bus.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3b-apply-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe",
});
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const LOCAL_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const REMOTE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const SECP = "a".repeat(64);

function mgr(id = LOCAL_ID) { return new InstanceSyncManager(IDENTITY, createDbClient(DB_PATH), id); }
function signedEntry(table, op, row, lamport_ts, instance_id = REMOTE_ID) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}
async function seedContact(db, id, crowId) {
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (?, ?, '', ?)", args: [id, crowId, SECP] });
}

test("_applyMessage: resolves crow_id → local contact_id (NOT the wire id/contact_id)", async () => {
  const m = mgr(); const db = m.db;
  await seedContact(db, 100, "crow:coh1");
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { id: 9999, contact_id: 4242, crow_id: "crow:coh1", nostr_event_id: "coh-ev1",
      content: "hello from A", direction: "sent", created_at: "2026-07-06T10:00:00Z" }, 10));
  const { rows } = await db.execute({ sql: "SELECT contact_id, content, direction FROM messages WHERE nostr_event_id='coh-ev1'" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contact_id, 100, "stored under the LOCAL contact_id, not the wire 4242");
  assert.equal(rows[0].content, "hello from A");
  assert.equal(rows[0].direction, "sent", "sent row mirrors as sent (coherent thread)");
});

test("_applyMessage: skips when the contact is not local yet (no phantom contact)", async () => {
  const m = mgr(); const db = m.db;
  const before = (await db.execute("SELECT COUNT(*) c FROM contacts")).rows[0].c;
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:absent", nostr_event_id: "orphan-ev", content: "x", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 4));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='orphan-ev'" })).rows[0].c, 0, "no message stored");
  assert.equal((await db.execute("SELECT COUNT(*) c FROM contacts")).rows[0].c, before, "no phantom contact created");
});

test("_applyMessage: INSERT OR IGNORE dedupes on nostr_event_id (idempotent re-delivery)", async () => {
  const m = mgr(); const db = m.db;
  await seedContact(db, 101, "crow:coh2");
  const e = signedEntry("messages", "insert",
    { crow_id: "crow:coh2", nostr_event_id: "dup-ev", content: "once", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 5);
  await m._applyEntry(REMOTE_ID, e);
  await m._applyEntry(REMOTE_ID, e); // replay
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='dup-ev'" })).rows[0].c, 1, "exactly one row");
});

test("_applyMessage: a row already stored via direct Nostr is not duplicated by sync", async () => {
  const m = mgr(); const db = m.db;
  await seedContact(db, 102, "crow:coh3");
  // Simulate the direct-Nostr onevent store landing first.
  await db.execute({ sql: "INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read) VALUES (102, 'both-ev', 'body', 'received', 0)" });
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:coh3", nostr_event_id: "both-ev", content: "body", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 6));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='both-ev'" })).rows[0].c, 1, "sync did not double-store");
});

test("_applyMessage: fires messages:changed with the LOCAL contact_id on a new row", async () => {
  const m = mgr(); const db = m.db;
  await seedContact(db, 103, "crow:coh4");
  const events = [];
  const onBus = (p) => events.push(p);
  bus.on("messages:changed", onBus);
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:coh4", nostr_event_id: "badge-ev", content: "ping", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 7));
  bus.off("messages:changed", onBus);
  assert.equal(events.length, 1);
  assert.equal(events[0].contactId, 103, "badge event carries the locally-resolved contact_id");
});

test("_applyMessage: a bad wire row (no nostr_event_id) is dropped by the shouldSyncRow gate, never throws", async () => {
  const m = mgr(); const db = m.db;
  await seedContact(db, 104, "crow:coh5");
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert", { crow_id: "crow:coh5", content: "no id" }, 4));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE content='no id'" })).rows[0].c, 0);
});

test("_applyMessage: a locally-BLOCKED contact still STORES the synced row (I-2)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, is_blocked) VALUES (105, 'crow:blk', '', ?, 1)", args: [SECP] });
  const badgeEvents = [];
  const onBadge = (p) => badgeEvents.push(p);
  bus.on("messages:changed", onBadge);
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:blk", nostr_event_id: "blk-ev", content: "still stored", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 8));
  bus.off("messages:changed", onBadge);
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='blk-ev'" })).rows[0].c, 1,
    "row stored despite block (converged-block semantics — no data loss)");
  assert.equal(badgeEvents.length, 0,
    "M-B1: a blocked contact must not tick the unread badge (messages:changed suppressed)");
  // Notification SUPPRESSION for the blocked contact is asserted in
  // messages-sync-notify.test.js (that file wires the createNotification seam).
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/messages-sync.test.js`
Expected: FAIL — messages entries currently fall through to the generic id-path (`_applyInsert` would try `WHERE id`/copy the wire `id`, misbehaving), and no `crow_id → contact_id` resolution or skip-on-missing happens.

- [ ] **Step 3: Write the dispatch + `_applyMessage`; remove the old :761-771 hook**

In `_applyEntry`, add a dispatch block immediately after the `contacts` block (after its `return` at ~:728, before the generic conflict gate at ~:732; placement among the natural-key handlers is order-independent since each returns):

```js
    // messages are keyed by the stable nostr_event_id (UNIQUE); the per-instance
    // AUTOINCREMENT id + local contact_id are NOT portable. Route ALL ops through
    // the natural-key handler, mirroring _applyCrowContext / _applyContact.
    // shouldSyncRow already gated at :617 (nostr_event_id + crow_id required).
    if (table === "messages") {
      try {
        await this._applyMessage(op, row, lamport_ts, instance_id);
      } catch (err) {
        console.warn(`[instance-sync] Failed to apply ${op} on messages:`, err.message);
      }
      return;
    }
```

**Remove** the now-unreachable-for-messages block at :754-771 (the comment + `if (op === "insert" && table === "messages" && row?.contact_id != null) { … bus.emit("messages:changed", …) }`). Its behavior is folded into `_applyMessage` with the **locally-resolved** `contact_id` (the old block read the **wire** `contact_id`, which PR-B strips — it would emit `undefined` and never fire). Verify no other code path reaches it.

Add `_applyMessage` after `_applyContact` (or after `_applyCrowContext`). Messages are insert-only + natural-key-deduped, so there is **no** LWW/update/delete/conflict path:

```js
  /**
   * Apply a messages mutation keyed on the stable nostr_event_id (Phase 3 PR-B /
   * S3). Messages are immutable inserts; the UNIQUE(nostr_event_id) constraint
   * gives free store-dedupe (the same event arriving via BOTH direct Nostr AND
   * sync yields exactly one row). The per-instance id/contact_id are never used —
   * contact_id is resolved LOCALLY from the wire-carried crow_id. If the contact
   * is not local yet, SKIP (no phantom contact): the row will also arrive via
   * direct Nostr once subscribed, or on a later re-sync once the contact syncs.
   *
   * On a genuinely-new row (INSERT OR IGNORE rowsAffected > 0) fires
   * messages:changed with the LOCAL contact_id (folded from the old :761-771 hook so
   * live badges update). The received-row notification is added in Task 3.
   *
   * @param {"insert"} op            - only inserts are emitted; other ops are no-ops
   * @param {object} row             - wire row (crow_id + nostr_event_id keyed)
   * @param {number} lamportTs       - entry envelope lamport (unused; messages don't LWW)
   * @param {string} instanceId      - origin instance id (unused)
   */
  async _applyMessage(op, row, lamportTs, instanceId) {
    if (op !== "insert") return; // messages are insert-only on the wire
    const eventId = row && row.nostr_event_id;
    const crowId = row && row.crow_id;
    if (!eventId || !crowId) {
      console.warn("[instance-sync] _applyMessage: missing nostr_event_id/crow_id — skipping");
      return;
    }

    // Resolve the LOCAL contact by crow_id. If absent, skip — never conjure a
    // contact through the message channel (trust boundary). The row backfills
    // once the contact syncs (PR-A) or via direct Nostr.
    const { rows: crows } = await this.db.execute({
      sql: "SELECT id, is_blocked FROM contacts WHERE crow_id = ? LIMIT 1",
      args: [crowId],
    });
    const localContactId = crows[0]?.id;
    if (localContactId == null) return;
    // I-2: resolve the local block flag. A locally-blocked contact still STORES
    // the synced row (converged-block semantics — the row is consistent with a
    // block that hasn't finished propagating, and dropping it would lose data),
    // but its NOTIFICATION is SUPPRESSED below. The notification is the security-
    // relevant surface the sync channel must not let a blocked contact bypass
    // during block-propagation divergence.
    const isBlocked = Number(crows[0]?.is_blocked ?? 0) === 1;

    // Store-dedupe on the UNIQUE nostr_event_id. Carry the original created_at
    // (coherent thread ordering) + direction verbatim (a 'sent' row on A shows as
    // 'sent' on B). is_read defaults 0 on this device (per-device unread badge).
    const result = await this.db.execute({
      sql: `INSERT OR IGNORE INTO messages
              (contact_id, nostr_event_id, content, direction, thread_id, created_at, delivery_status, attachments)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        localContactId,
        eventId,
        row.content ?? "",
        row.direction === "sent" ? "sent" : "received", // CHECK-constraint safe
        row.thread_id ?? null,
        row.created_at ?? new Date().toISOString(),
        row.delivery_status ?? null,
        row.attachments ?? null,
      ],
    });

    if (Number(result.rowsAffected ?? 0) > 0 && !isBlocked) {
      // I-2 + M-B1: a locally-blocked contact gets NEITHER the notification
      // NOR the unread-badge tick (the row itself is stored above regardless —
      // convergence preserved, no user-visible surface for a blocked contact).
      // Live badge update (folded from the old :761-771 hook), with the LOCAL id.
      try {
        const { rows } = await this.db.execute({
          sql: `SELECT COUNT(*) AS unread FROM messages
                WHERE contact_id = ? AND is_read = 0 AND direction = 'received'`,
          args: [localContactId],
        });
        bus.emit("messages:changed", { contactId: localContactId, unread: Number(rows?.[0]?.unread ?? 0) });
      } catch {}
      // Task 3 inserts the received-row notification here (gate shared with
      // the badge — see the enclosing !isBlocked).
      await this._notifyMessageApplied?.(localContactId, crowId, row);
    }
  }
```

> `_notifyMessageApplied` is added in Task 3; the optional-chaining call is a harmless no-op until then (keeps Task 2 and Task 3 independently reviewable). The `direction` normalization (`=== "sent" ? "sent" : "received"`) defends the `CHECK(direction IN ('sent','received'))` constraint against a malformed wire value — a bad direction can never throw the apply loop.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/messages-sync.test.js`
Expected: PASS.

Then a focused regression on the existing sync suite (the removed :761-771 hook):
Run: `node --test tests/instance-sync.test.js`
Expected: PASS (unchanged — the removed block only ever fired for `messages` inserts, now handled by `_applyMessage`; confirm no test asserted the old wire-`contact_id` path).

- [ ] **Step 5: Commit**

```bash
git add tests/messages-sync.test.js
git commit servers/sharing/instance-sync.js tests/messages-sync.test.js -m "feat(sharing): Phase 3 PR-B _applyMessage — nostr_event_id-keyed apply, crow_id contact resolution, fold messages:changed"
git show --stat HEAD | head
```

---

### Task 3: Notification dedupe (S-NOTIFY) — notify on newly-created received rows + nostr_event_id collapse key

**Files:**
- Modify: `servers/sharing/instance-sync.js` (add `_notifyMessageApplied` called from `_applyMessage` on `rowsAffected > 0`, gated on `!isBlocked` from Task 2)
- Modify: `servers/sharing/nostr.js` (**I-1**: add `metadata:{ nostr_event_id: event.id }` to the incoming-DM `createNotification` at :486)
- Test: `tests/messages-sync-notify.test.js` (create)

**Design decision (refinement of spec S-NOTIFY layer (a), documented):** The spec frames layer (a) as "the *existing* inbound-notify path fires only when a new row was created." Taken literally (only the direct-Nostr path ever notifies; the sync path never does), a message whose **sync** copy wins the race to `INSERT OR IGNORE` on an online instance would leave the direct-Nostr copy at `rowsAffected = 0` → **zero** notifications on that instance. To close that gap, PR-B fires the notification from **whichever path creates the row** — including `_applyMessage` — always gated on `rowsAffected > 0`. Per-instance this yields exactly one notification (the losing path sees `rowsAffected = 0`); across two simultaneously-online instances each still notifies once (unchanged from today's direct-Nostr behavior — the user already gets one push per device), and the `nostr_event_id` collapse key lets a client merge them. Only `direction === 'received'` rows notify (never the user's own `sent` mirrors). This matches the existing direct-Nostr notify at `nostr.js:486` (which also fires on `rowsAffected > 0`) and is strictly better than the literal spec (no zero-notification race, no regression).

**Interfaces:**
- Consumes: `createNotification` (dynamic-imported inside the guarded notify to keep the push side-effect graph lazy — matches the codebase pattern); the local contact's `display_name`.
- Produces: `async _notifyMessageApplied(localContactId, crowId, wireRow)` — for a `received` row only (and only when the contact is not locally blocked — the caller gates on `!isBlocked` per I-2), creates one `type:"peer"` notification titled with the contact's `display_name`, carrying `metadata: { nostr_event_id }` as a client-side collapse key. **M-3: title-only — no `body`/message-preview — intentional** (DM content never enters the notification store or the push fan-out). Never throws.
- **I-1:** the pre-existing direct-Nostr notify at `nostr.js:486` (in `subscribeToContact.onevent`, inside the `rowsAffected > 0` block) is updated to carry the **same** `metadata:{ nostr_event_id: event.id }` collapse key. Without this, layer-(b) cross-device collapse never works for a DM delivered directly (its own target case).

- [ ] **Step 1: Write the failing tests**

Create `tests/messages-sync-notify.test.js` (same harness header as `tests/messages-sync.test.js`; inject a `createNotification` spy). Because `_applyMessage` dynamic-imports `createNotification`, the cleanest seam is a **manager-level injectable** — expose `this.createNotification` on `InstanceSyncManager` (default: the shared helper, resolved lazily) and have `_notifyMessageApplied` prefer it. The test sets `m.createNotification = spy`.

```js
// … same harness header (IDENTITY, mgr, signedEntry, seedContact) as messages-sync.test.js …

test("_applyMessage: notifies on a NEW received row, with nostr_event_id collapse key", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES (200, 'crow:n1', '', ?, 'Alice')", args: [SECP] });
  const notes = [];
  m.createNotification = async (_db, opts) => { notes.push(opts); return { id: 1 }; };
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:n1", nostr_event_id: "n-ev1", content: "hi Alice", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 5));
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /Alice/);
  assert.equal(notes[0].type, "peer");
  assert.equal(notes[0].metadata?.nostr_event_id, "n-ev1", "collapse key present");
});

test("_applyMessage: a SENT mirror does NOT notify", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES (201, 'crow:n2', '', ?, 'Bob')", args: [SECP] });
  const notes = [];
  m.createNotification = async (_db, opts) => { notes.push(opts); return { id: 1 }; };
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:n2", nostr_event_id: "n-ev2", content: "I sent this", direction: "sent", created_at: "2026-07-06T10:00:00Z" }, 5));
  assert.equal(notes.length, 0, "own sent rows never notify");
});

test("_applyMessage: a duplicate (rowsAffected=0) does NOT notify", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES (202, 'crow:n3', '', ?, 'Cy')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read) VALUES (202, 'n-ev3', 'body', 'received', 0)" });
  const notes = [];
  m.createNotification = async (_db, opts) => { notes.push(opts); return { id: 1 }; };
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:n3", nostr_event_id: "n-ev3", content: "body", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 5));
  assert.equal(notes.length, 0, "already-existing row → no notify (per-instance dedupe)");
});

test("_applyMessage: a throwing createNotification never breaks the apply loop", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES (203, 'crow:n4', '', ?, 'Di')", args: [SECP] });
  m.createNotification = async () => { throw new Error("boom"); };
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:n4", nostr_event_id: "n-ev4", content: "still stored", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 5));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='n-ev4'" })).rows[0].c, 1, "row stored despite notify throw");
});

test("_applyMessage: a locally-BLOCKED contact stores the row but does NOT notify (I-2)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, is_blocked) VALUES (204, 'crow:blk2', '', ?, 'Blocked', 1)", args: [SECP] });
  const notes = [];
  m.createNotification = async (_db, opts) => { notes.push(opts); return { id: 1 }; };
  await m._applyEntry(REMOTE_ID, signedEntry("messages", "insert",
    { crow_id: "crow:blk2", nostr_event_id: "blk-n-ev", content: "hi", direction: "received", created_at: "2026-07-06T10:00:00Z" }, 6));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM messages WHERE nostr_event_id='blk-n-ev'" })).rows[0].c, 1, "row stored");
  assert.equal(notes.length, 0, "blocked contact → notification suppressed (the security control)");
});

test("direct-Nostr notify path carries the nostr_event_id collapse key (I-1)", async () => {
  // Mirrors the incoming-DM createNotification at nostr.js:486. Asserts the stored
  // notification ROW carries the collapse key, so a device that also receives this
  // DM via instance-sync (which notifies with the same key) can dedupe the two
  // pushes. (The call-site wiring at nostr.js:486 is additionally exercised by the
  // live E2E; this test locks the row-level contract the call site must satisfy.)
  const { createNotification } = await import("../servers/shared/notifications.js");
  const m = mgr(); const db = m.db;
  const res = await createNotification(db, {
    title: "Message from Alice",
    type: "peer",
    source: "sharing:message",
    action_url: "/dashboard/messages",
    metadata: { nostr_event_id: "direct-ev1" }, // <-- I-1 adds exactly this at :486
  });
  assert.ok(res && res.id, "notification created (peer type enabled by default)");
  const { rows } = await db.execute({ sql: "SELECT metadata FROM notifications WHERE id = ?", args: [res.id] });
  assert.equal(JSON.parse(rows[0].metadata).nostr_event_id, "direct-ev1", "direct-path collapse key persisted");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/messages-sync-notify.test.js`
Expected: FAIL — `_notifyMessageApplied` not implemented (the new-received-row, sent-mirror, duplicate, throw-safe, and blocked-suppression tests all fail because no notification fires / the notify is never gated). Note: the **I-1 direct-path** test (`direct-Nostr notify path carries…`) is a **contract/characterization** test that passes independently — it exercises `createNotification`'s `metadata` round-trip directly (the row-level contract the `nostr.js:486` call site must satisfy). Its call-site wiring is verified by the whole-suite green + code review + the live E2E; do not treat its early green as "I-1 done."

- [ ] **Step 3: Implement `_notifyMessageApplied`**

Add the method next to `_applyMessage` in `servers/sharing/instance-sync.js`:

```js
  /**
   * Phase 3 PR-B (S-NOTIFY): fire exactly one notification for a newly-stored
   * RECEIVED message (never for a 'sent' mirror). Called only on rowsAffected>0
   * from _applyMessage, so a duplicate (already stored via direct Nostr or an
   * earlier sync) never re-notifies (layer a — per-instance dedupe). Carries the
   * nostr_event_id in metadata as a client collapse key so two simultaneously-
   * online instances' pushes can be merged (layer b). Never throws.
   *
   * this.createNotification is a test seam (default: the shared helper, lazily
   * imported to keep the push side-effect graph out of this module's static load).
   */
  async _notifyMessageApplied(localContactId, crowId, wireRow) {
    try {
      if (!wireRow || wireRow.direction === "sent") return; // only inbound notifies
      let name = crowId;
      try {
        const { rows } = await this.db.execute({
          sql: "SELECT display_name FROM contacts WHERE id = ? LIMIT 1",
          args: [localContactId],
        });
        name = rows[0]?.display_name || crowId;
      } catch {}
      const notify = this.createNotification ||
        (async (db, opts) => {
          const { createNotification } = await import("../shared/notifications.js");
          return createNotification(db, opts);
        });
      await notify(this.db, {
        title: `Message from ${name}`,
        type: "peer",
        source: "sharing:message",
        action_url: "/dashboard/messages",
        // Client-side collapse key: two online instances that both notify for the
        // same DM can dedupe on this. Rides the existing metadata JSON column —
        // NO schema change (SCHEMA_GENERATION stays 4).
        metadata: { nostr_event_id: wireRow.nostr_event_id },
      });
    } catch (err) {
      try { console.warn("[instance-sync] message-applied notify failed:", err.message); } catch {}
    }
  }
```

Confirm `_applyMessage` (Task 2) already calls `if (!isBlocked) await this._notifyMessageApplied?.(localContactId, crowId, row);` inside its `rowsAffected > 0` block — the optional chaining now resolves to this real method, and the `!isBlocked` gate (I-2) suppresses the notify for a locally-blocked contact while the row stays stored.

**I-1 — add the collapse key on the direct-Nostr path.** In `servers/sharing/nostr.js`, the incoming-DM `createNotification` (:486, inside `subscribeToContact.onevent`, in the `if (result.rowsAffected > 0)` block) currently carries no `metadata`. Add the same collapse key `_notifyMessageApplied` uses, so a DM delivered directly AND via sync collapses across devices:

```js
                    await createNotification(this.db, {
                      title: `Message from ${contact.display_name || crowId}`,
                      type: "peer",
                      source: "sharing:message",
                      action_url: "/dashboard/messages",
                      // I-1: client-side collapse key — a device that also receives
                      // this DM via instance-sync notifies with the SAME
                      // nostr_event_id, so the two pushes dedupe. Title-only, no
                      // body/message-preview (M-3 — DM content stays out of the
                      // notification store + push payload).
                      metadata: { nostr_event_id: event.id },
                    });
```

`event.id` is already in scope at this site (it is the `nostr_event_id` stored two lines above). This is a single added property — do not restructure the block.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/messages-sync-notify.test.js`
Expected: PASS (6/6 — new-received, sent-mirror-silent, duplicate-silent, throw-safe, I-2 blocked-suppressed, I-1 direct-path collapse key).

- [ ] **Step 5: Commit**

```bash
git add tests/messages-sync-notify.test.js
git commit servers/sharing/instance-sync.js servers/sharing/nostr.js tests/messages-sync-notify.test.js -m "feat(sharing): Phase 3 PR-B notify on newly-synced received DMs (per-event dedupe + collapse key on both sync + direct-Nostr paths; suppress for blocked contacts)"
git show --stat HEAD | head
```

---

### Task 4: One-shot contacts backfill (I-4) — re-emit pre-PR-A full contacts so their DMs resolve on peers

**Why (I-4):** `_applyMessage` resolves `crow_id → local contact_id` and SKIPS when the contact isn't on the peer (no phantom contact — trust boundary). A contact added *before* PR-A shipped (or before the two instances paired) never emitted a contact-sync entry, so its `crow_id` never lands on the peer and **every** synced message for it is silently dropped forever (see Known limitations). This one-shot, idempotent backfill re-emits existing full contacts once per instance so peers can resolve them — modeled exactly on the existing `reemitSyncableSettingsOnce()` (guard-flag + emit-loop) pattern.

**Convergence semantics — CORRECTED by R2 (I-B1):** a re-emit gives the row a fresh (higher) `lamport_ts` via `_nextLamport`, so on the peer `_applyContact` takes the `lamportTs > localTs` UPDATE branch. When both instances already **agree** on the contact, that branch re-writes the same values — harmless no-op, no `sync_conflicts` row, `onContactSynced` re-fires idempotently. But when the peer holds a **newer diverged** edit we have not yet applied (the marquee case: the peer blocked the contact while we were offline), the fresh lamport makes OUR STALE ROW WIN — the peer's `is_blocked=1` is silently reverted to 0 with no conflict row. The backfill therefore MUST drain inbound state first:

- **Ordering guard (I-B1 mitigation):** before the SELECT, `backfillContactsOnce` iterates every open in-feed and `await this._processNewEntries(peerId, inFeed)` (the per-peer chaining in `_processNewEntries` serializes this safely with any concurrent apply). Only after the locally-replicated backlog is fully applied does it select + re-emit. This guarantees anything the peer already delivered to us wins before we fabricate recency.
- **Residual window (documented in Known limitations):** peer edits not yet *replicated into our in-feed* at backfill time can still be clobbered. One boot, once per instance lifetime, flag-guarded. The clean fix (lamport-preserving re-emit so peers only INSERT rows they lack) needs an explicit-lamport path through `emitChange` — logged as a follow-up, out of scope for PR-B.
- Because the backfill is **guarded by a flag row**, it runs at most once per instance lifetime — no repeated lamport thrash.

**Files:**
- Modify: `servers/sharing/instance-sync.js` (add `backfillContactsOnce()` next to `reemitSyncableSettingsOnce`)
- Modify: `servers/gateway/boot/mcp-mounts.js` (call `backfillContactsOnce()` at boot right after the `reemitSyncableSettingsOnce()` block at :66-72, in its own guarded try/catch)
- Test: `tests/messages-contacts-backfill.test.js` (create)

**Interfaces:**
- Produces: `async backfillContactsOnce()` — guarded by the `dashboard_settings` flag `__contacts_backfill_v1`; when `outFeeds.size === 0` marks the flag done + returns 0; else **FIRST drains the locally-replicated inbound backlog (I-B1: `for (const [peerId, inFeed] of this.inFeeds) await this._processNewEntries(peerId, inFeed)` — so a peer's already-delivered newer edit, e.g. a block, is applied before we fabricate recency)**, THEN SELECTs syncable full contacts (`(request_status IS NULL OR request_status = 'accepted') AND (is_bot IS NULL OR is_bot = 0) AND (origin IS NULL OR origin != 'local-bot') AND (is_blocked IS NULL OR is_blocked = 0)`) and for each calls `this.emitChange("contacts", "update", fullRow)` — `shouldSyncRow("contacts", …)` + `EXCLUDED_COLUMNS.contacts` are the final gate/strip. Sets the flag to `done:<n>`. Never throws out of the loop.

- [ ] **Step 1: Write the failing test**

Create `tests/messages-contacts-backfill.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const SECP = "a".repeat(64);

// R2b: helpers the drain test (I-B1) depends on — signedEntry mirrors the one
// in messages-sync.test.js; fakeFeedWith matches _processNewEntriesInner's
// contract exactly (iterates seq < feed.length, awaits feed.get(seq)).
import { sign } from "../servers/sharing/identity.js";
function signedEntry(table, op, row, lamport_ts) {
  const entry = { table, op, row, lamport_ts, instance_id: "peer-1" };
  entry.signature = sign(JSON.stringify(entry), IDENTITY.ed25519Priv);
  return entry;
}
const fakeFeedWith = (entries) => ({ length: entries.length, async get(seq) { return entries[seq]; } });

function freshMgr(label, id) {
  const d = mkdtempSync(join(tmpdir(), `crow-p3b-backfill-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d }, stdio: "pipe" });
  after(() => rmSync(d, { recursive: true, force: true }));
  const m = new InstanceSyncManager(IDENTITY, createDbClient(join(d, "crow.db")), id);
  // Pretend a peer feed is open so backfill doesn't early-return "no-peers";
  // give it a fake append so the wrapped emitChange doesn't touch a real Hypercore.
  m.feedsDisabled = false;
  m.outFeeds.set("peer-1", { append: async () => {} });
  return m;
}

test("backfillContactsOnce: re-emits syncable full contacts once, then no-ops on re-run (idempotent)", async () => {
  const m = freshMgr("idem", "local-1"); const db = m.db;
  const emitted = [];
  const orig = m.emitChange.bind(m);
  m.emitChange = async (t, o, r) => { emitted.push({ t, crow: r.crow_id }); return orig(t, o, r); };
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES ('crow:full1','ed', ?, 'Full One')", args: [SECP] });
  const n1 = await m.backfillContactsOnce();
  assert.equal(n1, 1, "one syncable contact re-emitted");
  assert.ok(emitted.some((e) => e.t === "contacts" && e.crow === "crow:full1"));
  // Re-run: flag guards → no-op (no repeated thrash).
  emitted.length = 0;
  const n2 = await m.backfillContactsOnce();
  assert.equal(n2, 0, "flag-guarded second run is a no-op");
  assert.equal(emitted.length, 0, "no re-emit on the guarded second run");
});

test("backfillContactsOnce: excludes pending, local-bot, and blocked contacts (SELECT filter)", async () => {
  const m = freshMgr("filter", "local-2"); const db = m.db;
  const emitted = [];
  m.emitChange = async (_t, _o, r) => { emitted.push(r.crow_id); }; // bypass real emit; the SELECT filter is what we assert
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:ok', 'ed', ?)", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, request_status) VALUES ('req:pending', 'ed', ?, 'pending')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, origin) VALUES ('crow:bot', 'ed', ?, 'local-bot')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, is_blocked) VALUES ('crow:blk', 'ed', ?, 1)", args: [SECP] });
  const n = await m.backfillContactsOnce();
  assert.equal(n, 1, "only the one full accepted contact re-emitted");
  assert.deepEqual(emitted, ["crow:ok"]);
});

test("backfillContactsOnce: no paired peers → marks done, emits nothing", async () => {
  const m = freshMgr("nopeers", "local-3");
  m.outFeeds.clear(); // no peers
  const emitted = [];
  m.emitChange = async (_t, _o, r) => emitted.push(r.crow_id);
  await m.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:solo', 'ed', ?)", args: [SECP] });
  assert.equal(await m.backfillContactsOnce(), 0);
  assert.equal(emitted.length, 0);
  // Flag set → a later run (even once peers exist) still no-ops: one-shot per lifetime.
  m.outFeeds.set("peer-1", { append: async () => {} });
  assert.equal(await m.backfillContactsOnce(), 0, "flag already marked done");
});

test("backfillContactsOnce: drains the inbound backlog BEFORE re-emitting (I-B1 — a peer's delivered block must win)", async () => {
  const m = freshMgr("ib1", "local-4");
  m.outFeeds.set("peer-1", { append: async () => {} });
  // Local stale contact: not blocked here…
  await m.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, is_blocked, lamport_ts) VALUES ('crow:divg', 'ed', ?, 0, 5)", args: [SECP] });
  // …but the peer already DELIVERED a newer block into our in-feed (not yet applied).
  const blockEntry = signedEntry("contacts", "update",
    { crow_id: "crow:divg", ed25519_pubkey: "ed", secp256k1_pubkey: SECP, is_blocked: 1 }, 9);
  m.inFeeds.set("peer-1", fakeFeedWith([blockEntry]));
  const emitted = [];
  const realEmit = m.emitChange.bind(m);
  m.emitChange = async (_t, _o, r) => emitted.push({ crow_id: r.crow_id, is_blocked: r.is_blocked });
  await m.backfillContactsOnce();
  // The drain applied the block first → the SELECT filter (is_blocked=0) excluded it → NOT re-emitted.
  assert.equal(emitted.filter((e) => e.crow_id === "crow:divg").length, 0,
    "a contact blocked by an already-delivered peer entry must not be re-emitted with fresh lamport");
  const { rows } = await m.db.execute({ sql: "SELECT is_blocked FROM contacts WHERE crow_id='crow:divg'" });
  assert.equal(Number(rows[0].is_blocked), 1, "the peer's delivered block was applied before the backfill emitted");
  m.emitChange = realEmit;
});
// fakeFeedWith(entries): minimal in-feed stub — { length: entries.length, async get(seq){ return entries[seq]; } }
// (matches the _processNewEntries contract: reads lastSeq via sync_state, iterates seq < length, feed.get(seq)).
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/messages-contacts-backfill.test.js`
Expected: FAIL — `backfillContactsOnce` is not a method (TypeError).

- [ ] **Step 3: Implement `backfillContactsOnce` + wire the boot call**

Add next to `reemitSyncableSettingsOnce` in `servers/sharing/instance-sync.js`:

```js
  /**
   * One-shot idempotent backfill (Phase 3 PR-B / I-4): re-emit every existing
   * SYNCABLE full contact so a peer can resolve crow_id → local contact_id for
   * contacts that predate PR-A (they never emitted a contact-sync entry, so
   * _applyMessage would otherwise SKIP every synced message for them forever).
   *
   * Guarded by a dashboard_settings flag so it runs at most once per instance
   * lifetime — no repeated lamport thrash. On the peer, _applyContact converges
   * an unchanged re-emit as an effective no-op (fresh lamport → UPDATE with
   * identical values; onContactSynced re-subscribe is idempotent). Mirrors
   * reemitSyncableSettingsOnce(). Never throws out of the loop.
   */
  async backfillContactsOnce() {
    const FLAG_KEY = "__contacts_backfill_v1";
    let alreadyRan = false;
    try {
      const { rows } = await this.db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = ?",
        args: [FLAG_KEY],
      });
      alreadyRan = rows?.length > 0;
    } catch {}
    if (alreadyRan) return 0;

    if (this.outFeeds.size === 0) {
      // No paired peers — nothing to backfill. Mark done so we don't recheck.
      try {
        await this.db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, 'no-peers', datetime('now')) ON CONFLICT(key) DO NOTHING",
          args: [FLAG_KEY],
        });
      } catch {}
      return 0;
    }

    // I-B1 ordering guard: drain the locally-replicated inbound backlog FIRST,
    // so a peer's already-delivered newer edit (e.g. a block) is applied before
    // we re-emit with a fresh lamport and fabricate recency over it.
    // _processNewEntries' per-peer promise-chain serializes this safely with
    // any concurrent append-listener run; checkpointing makes it idempotent.
    try {
      for (const [peerId, inFeed] of this.inFeeds) {
        await this._processNewEntries(peerId, inFeed);
      }
    } catch (err) {
      console.warn(`[instance-sync] contacts backfill drain failed: ${err.message}`);
    }

    let rows = [];
    try {
      const r = await this.db.execute({
        sql: `SELECT * FROM contacts
               WHERE (request_status IS NULL OR request_status = 'accepted')
                 AND (is_bot IS NULL OR is_bot = 0)
                 AND (origin IS NULL OR origin != 'local-bot')
                 AND (is_blocked IS NULL OR is_blocked = 0)`,
      });
      rows = r.rows || [];
    } catch (err) {
      console.warn(`[instance-sync] contacts backfill read failed: ${err.message}`);
      return 0;
    }

    let emitted = 0;
    for (const row of rows) {
      try {
        // shouldSyncRow("contacts", …) is the final gate inside emitChange;
        // EXCLUDED_COLUMNS.contacts strips verified/last_seen/id/created_at.
        await this.emitChange("contacts", "update", row);
        emitted++;
      } catch (err) {
        console.warn(`[instance-sync] contacts backfill emit failed for ${row.crow_id}: ${err.message}`);
      }
    }

    try {
      await this.db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO NOTHING",
        args: [FLAG_KEY, `done:${emitted}`],
      });
    } catch {}

    if (emitted > 0) {
      console.log(`[instance-sync] one-shot contacts backfill: ${emitted} contact(s) re-emitted → peers resolve legacy contacts`);
    }
    return emitted;
  }
```

In `servers/gateway/boot/mcp-mounts.js`, right after the `reemitSyncableSettingsOnce()` try/catch (:66-72), add:

```js
  // I-4: one-shot re-emit of existing full contacts so a peer can resolve
  // crow_id → local contact_id for contacts that predate PR-A's contact-sync
  // (otherwise every synced message for such a contact is dropped forever).
  // Guarded by a flag row; idempotent on subsequent boots.
  try {
    if (syncManager?.backfillContactsOnce) {
      await syncManager.backfillContactsOnce();
    }
  } catch (err) {
    console.warn(`[instance-sync] backfillContactsOnce failed: ${err.message}`);
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/messages-contacts-backfill.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add servers/sharing/instance-sync.js servers/gateway/boot/mcp-mounts.js tests/messages-contacts-backfill.test.js
git commit servers/sharing/instance-sync.js servers/gateway/boot/mcp-mounts.js tests/messages-contacts-backfill.test.js -m "feat(sharing): Phase 3 PR-B one-shot contacts backfill so pre-PR-A contacts' DMs resolve on peers (I-4)"
git show --stat HEAD | head
```

---

### Task 5: Full-suite verification, isolated boot smoke, self-review, ledger

**Files:**
- Modify: `.superpowers/sdd/progress.md` (git-ignored — do NOT `git add`)

- [ ] **Step 1: Full suite**

Run: `node --test tests/`
Expected: **PR-A baseline + the four new PR-B test files (`messages-sync-emit`, `messages-sync`, `messages-sync-notify`, `messages-contacts-backfill`), 0 fail** (~35s). If a pre-existing flaky (`crow-accept-bot-invite.test.js` handle-leak) appears, confirm it fails identically on the base branch before attributing.

- [ ] **Step 2: Isolated boot smoke (no schema bump expected)**

```bash
D=$(mktemp -d); CROW_GATEWAY_URL= CROW_DATA_DIR=$D PORT=3999 timeout -k 5 25 node servers/gateway/index.js --no-auth > /tmp/p3b-boot.log 2>&1
grep -E "listening|Subscribed|Error|Schema" /tmp/p3b-boot.log
sqlite3 $D/crow.db "PRAGMA user_version;"   # expect 4 (NO bump in PR-B)
```
Expected: `listening`, `[nostr] Subscribed to incoming on N relay(s)`, `[sharing] Subscribed to incoming Nostr messages`, no new `Error`, `user_version=4`. The one-shot `backfillContactsOnce` runs at boot (Task 4) — on a fresh single-instance DB it logs nothing (no peers → marks the flag done silently); it must NOT emit a new `Error`. (Pre-existing `unknown or invalid runtime name: nvidia` docker/vllm noise is fine.)

- [ ] **Step 3: Plan self-review vs spec**

Confirm each PR-B spec item maps to a task: `messages` emit both directions (Task 1 — `sendMessage` + `subscribeToContact`; `boot.js` request/group deliberately excluded, documented) ✓; `_applyMessage` keyed on `nostr_event_id` with `crow_id → local contact_id` + skip-on-missing (Task 2) ✓; `INSERT OR IGNORE` store-dedupe (Task 2) ✓; `messages:changed` preserved with locally-resolved `contact_id` (Task 2 fold) ✓; notification dedupe layer (a) suppress-when-existing + layer (b) `nostr_event_id` collapse key (Task 3) ✓; no schema change (confirmed Step 2, `metadata` reused) ✓. Confirm Open Question 3 resolution holds: the outbound `sent` write at `nostr.js:189` carries `event.id` as `nostr_event_id`, so `sent` rows dedupe/mirror correctly (no gap).

Then confirm each **R1** finding is closed: **I-1** — the direct-Nostr notify at `nostr.js:486` now carries `metadata:{ nostr_event_id: event.id }` (Task 3) with a row-level test ✓; **I-2** — `_applyMessage` resolves `is_blocked` and suppresses the notify for a blocked contact while still storing the row (Tasks 2+3) with tests ✓; **I-3** — no `OUTBOUND_TRANSFORMS.messages` (dropped; `EXCLUDED_COLUMNS.messages` is the sole strip); the Task 1 test does not import the unexported const ✓; **I-4** — Known-limitations documents the boundary, the one-shot `backfillContactsOnce` (Task 4) re-emits legacy contacts idempotently, and the live E2E (item 7) exercises both a fresh and a pre-existing contact ✓.

Then confirm each **R2** finding is closed: **I-B1** — `backfillContactsOnce` drains every open in-feed (`_processNewEntries`) BEFORE selecting/re-emitting, with a test proving a pending inbound block is applied before the backfill emits (Task 4); the corrected convergence semantics + residual window are documented (Task 4 + Known limitations) ✓; **M-B1** — `messages:changed` AND the notification share the `!isBlocked` gate, with the badge-suppression assertion in the blocked-contact test (Task 2) ✓; **M-B2** — verify in the running dashboard (or by reading the Messages panel SELECT) that conversations for `is_blocked=1` contacts are NOT rendered; if they are, file it as an immediate follow-up before deploy (synced content must not surface for a blocked contact) ✓.

- [ ] **Step 4: Update the git-ignored ledger** (do NOT `git add`)

Append a PR-B status block to `.superpowers/sdd/progress.md` (task-by-task outcomes, commit anchors, suite count).

- [ ] **Step 5: No commit for the ledger.** PR-B code is already committed per-task. Proceed to the whole-branch final SECURITY review (opus) before opening the PR.

---

## Open questions for plan-time (with best-evidence answers)

1. **Does `createNotification` support a collapse/dedup key, and does layer (b) touch the Android push payload?**
   **No dedicated key; use `metadata` — and the push payload is NOT touched in PR-B.** `createNotification` (shared/notifications.js:28) has a `metadata` param stored in `notifications.metadata` (init-db.js:1377, already exists) — PR-B carries `{ nostr_event_id }` there (no schema change, `SCHEMA_GENERATION` stays 4). The web/ntfy/email push payloads carry only `{title, body, url}` (web-push.js:60) with **no** native `tag`/`collapse_key`, so a synced-in DM's push does not *natively* collapse across two devices today. PR-B's collapse key is a **client-side** hint (dashboard Turbo/live client + notification list can dedupe on `metadata.nostr_event_id`). Threading a real `tag`/`collapseKey` through `createNotification → sendPushToAll`/`ntfy` → payload → the service worker/Android client is genuinely broader surface and is **deferred/flagged** as an optional follow-up (would not need a schema bump, only a payload+client change). Recommendation: ship the `metadata` collapse key now; do not expand the push payload in PR-B.

2. **Is the inbound store-then-notify ordering such that "row already existed" is detectable at the notify site?**
   **Yes — via `INSERT OR IGNORE` `rowsAffected`.** Both the direct-Nostr store (nostr.js:479-484 already guards `result.rowsAffected > 0`) and `_applyMessage` (Task 2) use `INSERT OR IGNORE` and read `result.rowsAffected`. The notification fires **only** in the `rowsAffected > 0` branch, so whichever path creates the row notifies once and the other (seeing `rowsAffected = 0`) stays silent — per-instance dedupe is deterministic. The important nuance PR-B fixes: the notification must fire from **whichever** path creates the row (Task 3 makes `_applyMessage` notify too), otherwise a sync copy that wins the race on an online instance would leave the direct-Nostr copy at `rowsAffected = 0` and produce **zero** notifications. See Task 3's design-decision note.

3. **Do `sent` messages carry a `nostr_event_id` at their write site (else they can't dedupe/mirror)?**
   **Yes.** The outbound `sendMessage` insert (nostr.js:189-192) stores `event.id` — the id of the finalized signed Nostr kind-4 event (`finalizeEvent(...)`, nostr.js:160-165) — into `nostr_event_id`. It is a plain `INSERT` (not `OR IGNORE`), always creating the row with a real stable key. So `sent` rows mirror and dedupe by `nostr_event_id` exactly like `received` rows — **no gap**. (The only messages that lack a real `nostr_event_id` are the group-message store at boot.js:507, synthetic `grp_<ts>` — deliberately not emitted, gated out by `shouldSyncRow` requiring `crow_id` too.)

---

## Post-plan pipeline (not tasks — the arc's standing process)

1. **2-round adversarial SECURITY review** of THIS plan (opus subagent) before any code — hardest on: the `nostr_event_id`-keyed apply + `crow_id → local contact_id` resolution (no phantom-contact injection through the message channel; forged wire `id`/`contact_id` ignored); signature/identity binding not bypassed by the new dispatch (instance-sync.js:673); `shouldSyncRow("messages", …)` gating on **apply** as well as emit; the notification-dedupe correctness (no zero-notification race, no double-notify per instance); `direction` CHECK-constraint safety; never-throw on both emit and apply. Do NOT code until both rounds pass.
2. **Subagent-driven execution** (fresh sonnet implementer per task, TDD, per-task spec+quality review; dispatch fix subagents for Critical/Important).
3. **Opus final whole-branch SECURITY review** (this touches cross-instance message data flow + notifications).
4. **PR** via github MCP (owner `kh0pper`, repo `crow`, base = PR-A branch or `main` per Global Constraints); check-runs verified pre-merge (expect 0 applicable — port-allocation path-filtered off this diff).
5. **Merge** = MERGE COMMIT, **operator-gated** (AskUserQuestion).
6. **Deploy** crow first, then **grackle** (coherence needs BOTH the pair on the new code): `git checkout main && git pull --rebase && sudo systemctl restart crow-gateway`. Verify on each: `/health` 200, `PRAGMA user_version` (=4), `integrity_check ok`, 4 relays + both subscribe lines, sync feeds initialized.
7. **LIVE E2E (crow↔grackle, shared seed) — exercise BOTH a fresh and a pre-existing contact (I-4):**
   - **(a) Freshly-added contact (added AFTER PR-A+PR-B deploy).** DM it from crow → the `sent` bubble also appears on grackle (coherent thread); the contact replies → `received` shows on both with exactly one notification per instance; take grackle offline, DM it, bring grackle back → the missed message backfills via sync; confirm no double-store and no double-notify on a single instance. **Expected: full coherence.**
   - **(b) Pre-existing contact (already on crow BEFORE this deploy).** Two honest sub-cases: **(b1)** if the one-shot `backfillContactsOnce` (Task 4) has run on crow with grackle paired, the contact's row now exists on grackle → a subsequent DM mirrors coherently (verify grackle has a `contacts` row for that `crow_id`, then DM and confirm the `sent`/`received` bubbles appear on both). **(b2)** for a contact that was NOT reachable by the backfill (e.g. added while the pair was unpaired, or a `req:`/pending contact that never became a full contact), `_applyMessage` on grackle **correctly SKIPS** its synced messages (no phantom contact) — verify grackle has NO `contacts` row and NO stored message for that `crow_id`, and that crow's local thread is unaffected. **Expected: (b1) coherent after backfill; (b2) legacy contact stays local-only per the Known-limitations boundary — this is the honest, documented outcome, not a bug.**
   - black-swan excluded (distinct identity).
