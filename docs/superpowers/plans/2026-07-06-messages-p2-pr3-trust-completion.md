# Messages Phase 2 PR3 — Robust Completion + Trust UI (C4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make contact pairing *complete itself* and *show its trust state*: re-accepting an invite repairs instead of erroring; the acceptor's `invite_accepted` is retried until the inviter acknowledges it (so an offline inviter can no longer strand the handshake); and the safety number that has existed since day one finally appears in the UI with a "Mark as verified" toggle, a verified badge, and an automatic reset whenever a contact's key changes.

**Architecture:** Three pieces on top of the R4/R5 machinery. (1) **Idempotent accept** — `acceptInviteCore` routes contact creation through R4's `upsertFullContact` (insert/promote/merge/noop) so the repair action IS the normal action. (2) **Handshake completion ack** — the acceptor sends `invite_accepted` via a new carve-in send that ALSO enqueues it into the existing `message_retry_queue`; the inviter, on processing an authenticated `invite_accepted`, replies with a `crow_social`/`handshake_complete` ack naming the event id; the acceptor's ack handler clears the retry row (`markDelivered`, contact-bound). The ack fires on the promote-success path AND on the ledger `"replayed"` verdict (the load-bearing cross-restart self-heal — I4). (3) **Trust UI** — a new `verified INTEGER DEFAULT 0` column (**the only Phase 2 schema bump, SCHEMA_GENERATION 3→4**), the safety number + verify toggle on the contact profile, a verified badge on contact cards and the Messages conversation header, and a reset-to-0 on every `upsertFullContact` merge/promote (key-change) path.

**Tech Stack:** Node ESM, `crypto` (`createHash` for the safety number — already in `identity.js`), `nostr-tools` (unchanged — reuses `NostrManager.sendControl`), the existing `message_retry_queue` table + `retry-queue.js` primitives, `addColumnIfMissing` in `scripts/init-db.js`, Node built-in test runner. **No new dependencies.** **Schema change: one additive column via `addColumnIfMissing` → `SCHEMA_GENERATION` 3→4** (boot gate auto-applies on plain restart — validated live 4× across this arc).

## Global Constraints

- **Commit with a positional path arg**: `git commit <path> -m "..."`, never bare. NEW files: `git add <thatpath>` first. Verify `git show --stat HEAD` after each commit. The working tree carries substantial unrelated untracked WIP (`bundles/`, `bots/`, `scripts/`, `.superpowers/messages-plan/`) that must NEVER be swept into a commit.
- **`git pull --rebase` before any push.** Never attribute Claude as co-author / contributor.
- **Tests**: `node --test tests/<file>.test.js`; full suite green (`node --test tests/` — **1052/1052 on `main` as of `96064291`**, ~35s).
- **Schema bump is REQUIRED and singular:** add exactly one `addColumnIfMissing("contacts", "verified", "INTEGER DEFAULT 0")` and bump `SCHEMA_GENERATION` 3→4. Do not add any other column or migration.
- **Never throw on the receive path**: every new `boot.js` handler (`handleHandshakeComplete`, the ack emission inside `handleInviteAccepted`) must be wrapped so a failure logs a fixed string and returns — a throw kills the subscription. The ack is best-effort (a lost ack self-heals on the acceptor's next retry / the inviter's next restart).
- **The invite code and short code must NEVER be logged** — this PR touches the accept path; keep every `console.*` to fixed strings.
- **Forgery binding (the R4/R5 crux):** the `handshake_complete` handler resolves the contact from the AUTHENTICATED `senderPubkey` (`event.pubkey`, sig-verified by nostr-tools) and clears retry rows CONTACT-BOUND via `markDelivered(db, eventIds, contact.id)` — never a payload-claimed identity. A stranger naming another contact's event ids must not clear that contact's retries (mirror `handleDeliveryReceipt`, `boot.js:186`).
- **Verified reset is mandatory on key change:** any path that rebinds `crow_id`/`secp256k1_pubkey` MUST also set `verified = 0`. Never silently keep a verified badge across a key change. In `upsertFullContact` that is the MERGE and PROMOTE branches (the NOOP branch — same crow_id + same secp — preserves `verified`; a fresh CREATE defaults it to 0). The ONE other key-rebinding write in the repo is `ensure-local-bot-contact.js:38` (verified live via `grep -rn "UPDATE contacts SET" servers/ scripts/` — every other `UPDATE contacts` touches only non-key fields); Task 1 adds `verified = 0` there too, closing the invariant fleet-wide.
- **i18n**: every new user-visible string in `servers/gateway/dashboard/shared/i18n.js`, BOTH `en` and `es`, single-line `"key": { en, es }` style. XSS: `escapeHtml` every interpolation; `textContent` in client.js.
- **Kiosk note:** the Contacts panel has NO kiosk guard today (verified live — no `isKiosk` pattern in `panels/contacts/`). The verify toggle is a local-only trust write (`UPDATE contacts SET verified`), lower-privilege than the invite generate/accept the kiosk guard protects. Do NOT invent a new kiosk guard here; match the existing block/unblock action convention (no per-form CSRF, no kiosk guard) unless Task 4's review says otherwise.
- Branch: `feat/messages-p2-pr3-trust-completion` (base = this plan's commit on `main`). Spec: `docs/superpowers/specs/2026-07-03-messages-phase2-contact-add-ux-design.md` §PR3.

---

## Background — the exact code being changed (verified @ `main` `96064291`)

**`upsertFullContact` (`servers/sharing/contact-promote.js:99`).** Signature `upsertFullContact(db, managers, { crowId, ed25519Pub, secp256k1Pub, displayName })` → returns `{ contactId, outcome }` with `outcome ∈ "created"|"promoted"|"merged"|"noop"`. It does its own wiring via `wireFullContact(managers, row)` (initContact/joinContact/subscribeToContact, each independently guarded). Four branches:
- **MERGE** (`byCrow && otherSecp`, `:117-132`): folds the other secp row into the crowId owner, UPDATE at `:123-128` (sets `request_status=NULL`, coalesces ed25519/display_name). **← add `verified = 0`.**
- **NOOP** (`:147-152`): `byCrow` owner with same secp — only fills a placeholder display_name. **← leave `verified` untouched (preserve).**
- **PROMOTE** (`:162-170`): UPDATE that may rebind `crow_id` + `secp256k1_pubkey`. **← add `verified = 0`.**
- **CREATE** (`:177-184`): fresh INSERT (no `verified` column named → defaults 0). **← no change needed.**

**`handleInviteAccepted` (`servers/sharing/boot.js:134`).** `handleInviteAccepted(db, managers, payload, senderPubkey)` — R4's authenticated promote path. Structure: auth check (`normalizePubkey(payload.secp256k1Pub) === normalizePubkey(senderPubkey)`, `:140`, bail on mismatch) → P2/C2 single-use gate (`:148-165`: `"replayed"`→log+return at `:152-156` with the I4 note; `"expired"`→log+return `:158-161`; else fall through) → `upsertFullContact` (`:167-172`). **PR3 changes:** add an `event` parameter (threaded from `onInviteAccepted`), and emit the `handshake_complete` ack (a) after a successful `upsertFullContact` (any outcome) and (b) at the `"replayed"` branch before its `return` (the I4 self-heal). NOT on the `"expired"` branch or the auth-fail bail (see the Threat/Limits note).

**The receive ladder (`servers/sharing/boot.js:360-527`, `wireNostrReceive`).** `nostrManager.subscribeToIncoming(onInviteAccepted, onSocialMessage, onMessageRequest)`:
- `onInviteAccepted` wrapper (`:396-397`): `async (payload, senderPubkey) => { await handleInviteAccepted(db, { syncManager, peerManager, nostrManager }, payload, senderPubkey); }`. **← add `event`, thread it.**
- `onSocialMessage` dispatch (`:398-510`): a subtype ladder; `DELIVERY_RECEIPT_SUBTYPE` → `handleDeliveryReceipt` at `:505-506`. **← add an `else if (subtype === HANDSHAKE_COMPLETE_SUBTYPE)` arm → `handleHandshakeComplete`.**

**`subscribeToIncoming` (`servers/sharing/nostr.js:561-646`).** The broad sub. `onevent` dedups by `seenEventIds` (`:574`), decrypts, and at `:596-598` calls `onInviteAccepted(payload, senderPubkey)`. **← change to `onInviteAccepted(payload, senderPubkey, event)`.** `seenEventIds` is per-subscription-session, so a within-session retry of the SAME `event.id` is skipped by an ONLINE inviter (no re-ack). Honest self-heal accounting (corrected per review): (a) the normal path — inviter online at pairing — acks on the first receipt, acceptor clears, done; (b) if that first ack is LOST and the inviter stays online, the acceptor's row simply churns ~10 republishes and expires harmlessly at ~60h (`CROW_NOSTR_RETRY_MAX_AGE_SEC`) — the contact is already promoted both sides, nothing user-visible; (c) the ledger `"replayed"` re-ack (I4) fires only when the inviter RESTARTS and re-receives the retried event via `initialSince` replay (bounded to the ~24h–30d re-receive window, not indefinite), plus the plain-invite noop-upsert re-ack covers non-short-code invites the same way. So I4 is a genuine but restart-bounded improvement, not a universal guarantee; the steady-state lost-ack cost is a bounded harmless retry.

**`handleDeliveryReceipt` (`servers/sharing/boot.js:186`)** — the exact model for `handleHandshakeComplete`: resolve `findContactByPubkey(db, senderPubkey)`, bail if none, then `markDelivered(db, ids, contact.id)` (contact-bound). boot.js already imports `findContactByPubkey` (`:17`) and `markDelivered, DELIVERY_RECEIPT_SUBTYPE` (`:24`).

**`retry-queue.js` (`servers/sharing/retry-queue.js`).** `DELIVERY_RECEIPT_SUBTYPE="delivery_receipt"` (`:21`), `buildDeliveryReceipt(eventIds)` (`:28-37`) → `{type:"crow_social",version:1,subtype,payload:{event_ids}}`. `shouldEnqueue` (`:46-58`) excludes `crow_social` + `invite_accepted` — **stays unchanged** (the carve-in is an explicit enqueue, not a policy change). `enqueueRetry`/`dueRetries`/`recordAttempt`/`markDelivered` are the persisted-queue primitives. `_runRetryTick` (`nostr.js:364`) republishes the EXACT stored `raw_event` for every due row regardless of type, and clears via `markDelivered`. **← add `HANDSHAKE_COMPLETE_SUBTYPE` + `buildHandshakeComplete(eventIds)`.**

**`acceptInviteCore` (`servers/sharing/tools/contacts.js:32-119`).** Current flow: `parseInviteCode` → already-a-contact early-return `"Already connected"` (`:41-45`) → raw `INSERT INTO contacts` (`:48-57`) → `initContact`/`joinContact`/`subscribeToContact` (`:62-75`) → `computeSafetyNumber` (`:78-81`) → build `acceptancePayload` `{type:"invite_accepted",crowId,ed25519Pub,secp256k1Pub,...(inviteId?)}` (`:88-94`) → `nostrManager.sendMessage({secp256k1_pubkey}, acceptancePayload)` (`:95-98`, pseudo-contact has no `id` → no message row, no enqueue) → success text. `upsertFullContact` is already imported (used by `crow_add_contact`, `:355`). **PR3 changes:** replace `:35-75` with a single `upsertFullContact(...)` call (idempotent — kills the early-return + raw INSERT), and send the acceptance via the new carve-in `nostrManager.sendInviteAccepted({ id: contactId, secp256k1_pubkey: peer.secp256k1Pubkey }, acceptancePayload)` so it enters the retry queue.

**`sendControl` (`servers/sharing/nostr.js:309-321`)** — the send shape to mirror for `sendInviteAccepted`: NIP-44 encrypt, `finalizeEvent` kind:4, publish loop, return `{eventId, relays}`. NO message-row write (correct for a control envelope). **← add `sendInviteAccepted(contact, content)` beside it: same send, then an explicit `enqueueRetry` when `published.length > 0 && contact.id`.**

**`computeSafetyNumber` (`servers/sharing/identity.js:102`).** `computeSafetyNumber(myEd25519Pub, theirEd25519Pub)` — both hex; returns 8 groups of 5 digits. Local pubkey = `identity.ed25519Pubkey` (hex). Note: `loadOrCreateIdentity()` is synchronous and, on a passphrase-ENCRYPTED-seed install, `decryptSeed(..., "")` throws — so the trust section gracefully omits (guarded try/catch → `myEd=""`). Acceptable known limitation (matches `shared-storage.js` precedent; default installs are unencrypted). Already imported into `tools/contacts.js:11`; import `loadOrCreateIdentity`/`computeSafetyNumber` into the contacts panel for the UI (precedent: `settings/sections/shared-storage.js`, `routes/bundles.js`).

**Contacts panel render (`servers/gateway/dashboard/panels/contacts/`).** `getContact`/`getContacts` use `SELECT c.*` (`data-queries.js:43,62`) → `verified` auto-available. `renderContactProfile(contact, activities, groups, allGroups, lang)` (`html.js:191`) does NOT get `identity` — thread `myEd25519Pubkey` in. `renderContactList` cards at `html.js:159-176`; `typeBadge(c, lang)` helper at `:40-44`. Panel wiring: `contacts.js:67-69` builds the profile. Action dispatch: `api-handlers.js` flat `if (action === ...)`; `unblock` (`:68-74`) is the template for `set_verified` (raw `UPDATE contacts`).

**Messages panel (explicit SELECTs — MUST add `verified`).** The open-thread contact object: `routes/peer-messages.js:162-166` (`SELECT id, crow_id, display_name, ed25519_pubkey, is_blocked, last_seen, created_at` — note `ed25519_pubkey` already present). The conversation-list rows: `panels/messages/data-queries.js:46-48` (an EXPLICIT named-column list — `c.id as contact_id, c.crow_id, …` — so `c.verified` must be added explicitly). Header rendered client-side: `panels/messages/client.js:839-849` (`renderChatUI` → name node `:849`), `headerData` built at `:650-658` from the peer contact; info panel `showPeerInfo` at `:1321-1344`.

**i18n (`servers/gateway/dashboard/shared/i18n.js`).** Single-line `"key": { en, es }`. The `invite.*` block is at `:340-365`; `invite.verifyLater` (`:360`) already says "compare safety numbers". Add `verified.*`/`trust.*` keys right after. Accessor `t(key, lang)`; `tJs(key, lang)` inside client.js template strings.

**Instance-sync note (forward-looking, NOT PR3 work).** `contacts` is in `SYNCED_TABLES` (`instance-sync.js:52`) and `emitChange` strips `EXCLUDED_COLUMNS[table]` before broadcasting a row. Nothing emits contact changes today (contacts-follow-user is Phase 3). Adding a defaulted column is safe now. **Flag for Phase 3:** decide whether `verified` syncs — a synced `verified` without a synced safety-number comparison means "someone on another device asserted verified", which likely warrants `EXCLUDED_COLUMNS.contacts += "verified"`. Do NOT wire any sync in PR3.

**Test scaffolding to reuse.** `tests/invite-accepted-promote.test.js` (the forged/authenticated `invite_accepted` cases — Task 3's ack must not regress them, and its I2 negative case pattern). `tests/contact-promote.test.js` (in-memory `dashboard_settings` + contacts db stub for `upsertFullContact`). `tests/delivery-receipt-emit.test.js` (method-stubbing a real `NostrManager`). `tests/contacts-peer-add.test.js` / `tests/messages-invite-share.test.js` (PR1 UI fixture patterns for Task 4/5).

---

## File Structure

- **Modify** `scripts/init-db.js` — one `addColumnIfMissing("contacts","verified","INTEGER DEFAULT 0")` in the contacts-columns block (`:1851`).
- **Modify** `servers/shared/schema-version.js` — `SCHEMA_GENERATION` 3→4.
- **Modify** `servers/sharing/contact-promote.js` — `verified = 0` in the MERGE + PROMOTE UPDATEs.
- **Modify** `servers/gateway/dashboard/shared/ensure-local-bot-contact.js:38` — `verified = 0` on the local-bot key-rebind UPDATE (the one non-`upsertFullContact` key-mutating path).
- **Modify** `servers/sharing/tools/contacts.js` — `acceptInviteCore` routes through `upsertFullContact`; sends via `sendInviteAccepted`.
- **Modify** `servers/sharing/retry-queue.js` — `HANDSHAKE_COMPLETE_SUBTYPE` + `buildHandshakeComplete`.
- **Modify** `servers/sharing/nostr.js` — `sendInviteAccepted` method; thread `event` into the `onInviteAccepted` call.
- **Modify** `servers/sharing/boot.js` — `handleInviteAccepted` gains `event` + emits the ack (success + replayed); `handleHandshakeComplete` + `onSocialMessage` dispatch; `onInviteAccepted` wrapper threads `event`.
- **Modify** `servers/gateway/dashboard/panels/contacts/html.js` — safety number + verify toggle + card badge.
- **Modify** `servers/gateway/dashboard/panels/contacts.js` — thread `identity.ed25519Pubkey` into `renderContactProfile`.
- **Modify** `servers/gateway/dashboard/panels/contacts/api-handlers.js` — `set_verified` action.
- **Modify** `servers/gateway/routes/peer-messages.js` + `servers/gateway/dashboard/panels/messages/data-queries.js` — add `verified` to the explicit SELECTs.
- **Modify** `servers/gateway/dashboard/panels/messages/client.js` — verified badge in the conversation header (+ optionally list rows / info panel).
- **Modify** `servers/gateway/dashboard/shared/i18n.js` — new trust keys EN+ES.
- **Create** tests: `tests/contact-verified-column.test.js`, `tests/accept-idempotent.test.js`, `tests/handshake-complete.test.js`, `tests/contacts-trust-ui.test.js`, `tests/messages-verified-badge.test.js`.

---

## Task 1: `verified` column + `SCHEMA_GENERATION` 3→4 + reset-on-key-change

**Files:**
- Modify: `scripts/init-db.js:1851` (contacts-columns block)
- Modify: `servers/shared/schema-version.js:13`
- Modify: `servers/sharing/contact-promote.js:123-128` (MERGE UPDATE), `:162-170` (PROMOTE UPDATE)
- Modify: `servers/gateway/dashboard/shared/ensure-local-bot-contact.js:38` (local-bot key-rebind UPDATE)
- Test: `tests/contact-verified-column.test.js`

**Interfaces:**
- Produces: a `verified` column (INTEGER, default 0) on `contacts`; `upsertFullContact` resets `verified→0` on MERGE and PROMOTE, preserves on NOOP, defaults 0 on CREATE.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-verified-column.test.js`:

```js
// tests/contact-verified-column.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";
import { upsertFullContact } from "../servers/sharing/contact-promote.js";

test("SCHEMA_GENERATION is bumped to 4 for the verified column", () => {
  assert.equal(SCHEMA_GENERATION, 4);
});

// In-memory contacts+messages db stub (contact-promote.test.js pattern).
function makeDb() {
  const contacts = [];
  let nextId = 1;
  const messages = [];
  const norm = (k) => String(k || "").toLowerCase().slice(-64);
  return {
    contacts, messages,
    async execute({ sql, args = [] }) {
      if (/^SELECT \* FROM contacts WHERE crow_id = \?/.test(sql)) {
        return { rows: contacts.filter((c) => c.crow_id === args[0]) };
      }
      if (/lower\(substr\(secp256k1_pubkey,-64\)\) = \?/.test(sql)) {
        return { rows: contacts.filter((c) => norm(c.secp256k1_pubkey) === args[0]).sort((a, b) => a.id - b.id) };
      }
      if (/^SELECT \* FROM contacts WHERE id = \?/.test(sql)) {
        return { rows: contacts.filter((c) => c.id === args[0]) };
      }
      if (/^INSERT INTO contacts/.test(sql)) {
        const row = { id: nextId++, crow_id: args[0], display_name: args[1], ed25519_pubkey: args[2], secp256k1_pubkey: args[3], request_status: null, verified: 0, contact_type: "crow" };
        contacts.push(row);
        return { rows: [], lastInsertRowid: row.id };
      }
      if (/^UPDATE contacts SET/.test(sql)) {
        // crude apply: match the trailing "WHERE id = ?"
        const id = args[args.length - 1];
        const row = contacts.find((c) => c.id === id);
        if (row) {
          if (/verified = 0/.test(sql)) row.verified = 0;
          if (/request_status = NULL/.test(sql)) row.request_status = null;
          if (/crow_id = \?/.test(sql)) row.crow_id = args[0];
          if (/secp256k1_pubkey = \?/.test(sql) && /crow_id = \?/.test(sql)) row.secp256k1_pubkey = args[1];
        }
        return { rows: [] };
      }
      if (/^UPDATE messages SET contact_id/.test(sql)) return { rows: [] };
      if (/^DELETE FROM contacts WHERE id = \?/.test(sql)) {
        const i = contacts.findIndex((c) => c.id === args[0]);
        if (i >= 0) contacts.splice(i, 1);
        return { rows: [] };
      }
      throw new Error("unexpected sql: " + sql);
    },
  };
}

const SECP_A = "a".repeat(64);
const SECP_B = "b".repeat(64);
const ED = "c".repeat(64);

test("CREATE defaults verified to 0", async () => {
  const db = makeDb();
  const r = await upsertFullContact(db, {}, { crowId: "crow:aaa", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  assert.equal(r.outcome, "created");
  assert.equal(db.contacts.find((c) => c.id === r.contactId).verified, 0);
});

test("NOOP preserves a verified badge (same crow_id + same secp)", async () => {
  const db = makeDb();
  const { contactId } = await upsertFullContact(db, {}, { crowId: "crow:aaa", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  db.contacts.find((c) => c.id === contactId).verified = 1; // user marked verified
  const r = await upsertFullContact(db, {}, { crowId: "crow:aaa", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  assert.equal(r.outcome, "noop");
  assert.equal(db.contacts.find((c) => c.id === contactId).verified, 1, "verified survives a noop re-accept");
});

test("PROMOTE resets verified to 0 on a key rebind", async () => {
  const db = makeDb();
  // A full contact with crow:old + SECP_A, marked verified.
  const { contactId } = await upsertFullContact(db, {}, { crowId: "crow:old", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  db.contacts.find((c) => c.id === contactId).verified = 1;
  // Re-accept the SAME secp under a DIFFERENT crow_id → PROMOTE (crow_id rebind).
  const r = await upsertFullContact(db, {}, { crowId: "crow:new", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  assert.equal(r.outcome, "promoted");
  assert.equal(db.contacts.find((c) => c.id === r.contactId).verified, 0, "key change clears verified");
});

test("MERGE resets verified to 0", async () => {
  const db = makeDb();
  // Owner row: crow:aaa with a DIFFERENT secp, verified.
  const owner = await upsertFullContact(db, {}, { crowId: "crow:aaa", ed25519Pub: ED, secp256k1Pub: SECP_B, displayName: "Alice" });
  db.contacts.find((c) => c.id === owner.contactId).verified = 1;
  // A separate row sharing SECP_A but no crow owner (simulate a request row).
  db.contacts.push({ id: 99, crow_id: "req:x", display_name: "req:x", ed25519_pubkey: "", secp256k1_pubkey: SECP_A, request_status: "accepted", verified: 0, contact_type: "crow" });
  // Now upsert crow:aaa with SECP_A → owner exists AND row 99 shares SECP_A → MERGE.
  const r = await upsertFullContact(db, {}, { crowId: "crow:aaa", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  assert.equal(r.outcome, "merged");
  assert.equal(db.contacts.find((c) => c.id === r.contactId).verified, 0, "merge clears verified");
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test tests/contact-verified-column.test.js` → FAIL (SCHEMA_GENERATION is 3; verified not reset).

- [ ] **Step 3: Bump the schema generation** — in `servers/shared/schema-version.js`, change `export const SCHEMA_GENERATION = 3;` to `= 4;`.

- [ ] **Step 4: Add the column migration** — in `scripts/init-db.js`, inside the contacts-columns block (right after the `request_status` line at `:1851`), add:

```js
// PR3 trust UI: 0 = unverified, 1 = user compared the safety number. Reset to 0
// on any crow_id/secp key change (see upsertFullContact). SCHEMA_GENERATION 3→4.
await addColumnIfMissing("contacts", "verified", "INTEGER DEFAULT 0");
```

- [ ] **Step 5: Reset `verified` on key change in `upsertFullContact`** — in `servers/sharing/contact-promote.js`:

MERGE UPDATE (`:124-128`): add `verified = 0,` to the SET clause:
```js
      sql: `UPDATE contacts SET request_status = NULL, verified = 0,
              ed25519_pubkey = COALESCE(NULLIF(ed25519_pubkey,''), ?),
              display_name  = COALESCE(NULLIF(display_name,''), ?) WHERE id = ?`,
```

PROMOTE UPDATE (`:162-169`): add `verified = 0,` to the SET clause:
```js
      sql: `UPDATE contacts SET crow_id = ?, secp256k1_pubkey = ?,
              ed25519_pubkey = COALESCE(NULLIF(ed25519_pubkey,''), ?),
              request_status = NULL, verified = 0,
              display_name = CASE WHEN display_name IS NULL OR display_name = '' OR display_name LIKE 'req:%'
                                  THEN ? ELSE display_name END
            WHERE id = ?`,
```
Do NOT touch the NOOP branch (`:147-152`) or the CREATE INSERT (`:177-181`).

- [ ] **Step 5b: Reset `verified` on the one other key-rebind path** — in `servers/gateway/dashboard/shared/ensure-local-bot-contact.js:38`, the local-bot UPDATE rebinds `secp256k1_pubkey`/`ed25519_pubkey`. Add `verified = 0` so the invariant holds fleet-wide:
```js
        sql: "UPDATE contacts SET is_bot = 1, display_name = ?, secp256k1_pubkey = ?, ed25519_pubkey = ?, origin = 'local-bot', verified = 0 WHERE id = ?",
```
(The local bot uses a deterministic per-`botId` identity so the keys rarely actually change, and a safety number for your own bot is meaningless — this is invariant hygiene, not a live bug. Confirmed via `grep -rn "UPDATE contacts SET" servers/ scripts/` that this is the ONLY key-mutating write outside `upsertFullContact`; `edit_contact` touches only display/notes/contact fields, `messages/api-handlers.js` only `request_status`.)

- [ ] **Step 6: Run tests** — `node --test tests/contact-verified-column.test.js tests/contact-promote.test.js` → ALL PASS (the R4 cases don't assert on `verified`, so the added SET column is a no-op for them; the real fresh-init `verified` column is validated in Task 6's isolated boot).

- [ ] **Step 7: Commit**

```bash
git add tests/contact-verified-column.test.js
git commit tests/contact-verified-column.test.js servers/shared/schema-version.js scripts/init-db.js servers/sharing/contact-promote.js servers/gateway/dashboard/shared/ensure-local-bot-contact.js -m "feat(sharing): verified contacts column (SCHEMA_GEN 3->4) + reset-on-key-change (P2/C4)"
git show --stat HEAD
```

---

## Task 2: Idempotent, repairable accept — route `acceptInviteCore` through `upsertFullContact`

**Files:**
- Modify: `servers/sharing/tools/contacts.js:32-119` (`acceptInviteCore`)
- Test: `tests/accept-idempotent.test.js`

**Interfaces:**
- Consumes: `upsertFullContact(db, managers, {...}) → { contactId, outcome }` (Task 1 / R4).
- Produces: `acceptInviteCore` becomes safely re-runnable — a re-accept of a known identity returns success (noop/merge/promote) instead of the old `"Already connected"` short-circuit or a UNIQUE error; `contactId` for Task 3's enqueue comes from `upsertFullContact`'s return.

- [ ] **Step 1: Write the failing test**

Create `tests/accept-idempotent.test.js` — drive `crow_accept_invite` end-to-end via the in-memory tool harness (reuse the lightest existing pattern — grep `crow_accept_invite`/`createSharingServer` in `tests/` and mirror `tests/crow-accept-bot-invite.test.js` or `tests/invite-accepted-promote.test.js` scaffolding). Essential cases (assert concretely against the harness you reuse):

```js
// Essential cases:
// 1. Fresh accept: crow_accept_invite on a valid invite for an UNKNOWN peer →
//    a contact row is inserted (outcome created), the result text contains
//    "Safety Number:" (safety number still computed + shown), no error.
// 2. Re-accept idempotency: accept the SAME invite code twice → the second call
//    returns a NON-error result (no throw, no UNIQUE violation) and the contact
//    count stays 1. Assert the second result is NOT isError.
// 3. Repair a partial (request_status='accepted') row: seed a contacts row with
//    request_status='accepted' sharing the invite's secp key but a placeholder
//    display_name; accept the invite → the row is PROMOTED (request_status NULL,
//    real display_name), still one row, result contains the safety number.
// 4. The acceptancePayload still carries inviteId when the invite code had one.
//    IMPORTANT: at this task the send is still `sendMessage`; Task 3 swaps it to
//    `sendInviteAccepted`. So the nostr stub MUST define BOTH methods, each
//    pushing to ONE shared `sent` array — the capture then survives the Task 3
//    swap and this test stays green across both commits. Assert the captured
//    acceptancePayload's parsed `inviteId` equals the code's inviteId.
```

Write real assertions from this skeleton — every case must exist.

- [ ] **Step 2: Run to verify failure** — `node --test tests/accept-idempotent.test.js` → FAIL (case 2 hits the old `"Already connected"` / raw INSERT).

- [ ] **Step 3: Refactor `acceptInviteCore`** — replace the existing-contact check + raw INSERT + explicit wiring (`contacts.js:35-75`) with a single idempotent upsert. The new body from `const peer = ...` through the wiring:

```js
async function acceptInviteCore({ invite_code, display_name }, { db, identity, syncManager, peerManager, nostrManager }) {
  const peer = parseInviteCode(invite_code);

  // Idempotent, repairable insert/promote/merge — re-accepting a known or
  // partial contact repairs it instead of erroring (the repair action IS the
  // normal action). Handles wiring (sync feeds, DHT topic, Nostr sub) itself.
  const { contactId } = await upsertFullContact(
    db,
    { syncManager, peerManager, nostrManager },
    {
      crowId: peer.crowId,
      ed25519Pub: peer.ed25519Pubkey,
      secp256k1Pub: peer.secp256k1Pubkey,
      displayName: display_name || undefined,
    },
  );

  // Compute safety number (unchanged).
  const safetyNumber = computeSafetyNumber(identity.ed25519Pubkey, peer.ed25519Pubkey);

  // Send acceptance back to the inviter so they auto-add us — and, in PR3, keep
  // retrying until they acknowledge (Task 3 swaps this to sendInviteAccepted).
  try {
    if (nostrManager.relays.size === 0) await nostrManager.connectRelays();
    const acceptancePayload = JSON.stringify({
      type: "invite_accepted",
      crowId: identity.crowId,
      ed25519Pub: identity.ed25519Pubkey,
      secp256k1Pub: identity.secp256k1Pubkey,
      ...(peer.inviteId ? { inviteId: peer.inviteId } : {}),
    });
    await nostrManager.sendMessage({ secp256k1_pubkey: peer.secp256k1Pubkey }, acceptancePayload);
  } catch {
    // Non-fatal — inviter can still add us manually.
  }

  return {
    content: [{ type: "text", text: [
      `Connected to ${display_name || peer.crowId}!`,
      ``,
      `Crow ID: ${peer.crowId}`,
      `Safety Number: ${safetyNumber}`,
      ``,
      `Verify this safety number with your contact through a separate channel`,
      `(in person, phone call, etc.) to confirm the connection is secure.`,
    ].join("\n") }],
  };
}
```

**NOTE (Task 3 will edit the `sendMessage` line):** this task leaves the acceptance send as `sendMessage` so it stays green independently; Task 3 swaps it to `sendInviteAccepted({ id: contactId, ... })` to enqueue the retry. Keep `contactId` in scope (it already is). Verify `upsertFullContact` is imported at the top of `contacts.js` (it is — used by `crow_add_contact`). Do NOT remove the `computeSafetyNumber` import.

- [ ] **Step 4: Run tests** — `node --test tests/accept-idempotent.test.js tests/crow-accept-bot-invite.test.js tests/invite-accepted-promote.test.js tests/short-invite-tools.test.js` → ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/accept-idempotent.test.js
git commit tests/accept-idempotent.test.js servers/sharing/tools/contacts.js -m "feat(sharing): idempotent repairable accept via upsertFullContact (P2/C4)"
git show --stat HEAD
```

---

## Task 3: Handshake completion ack + retry carve-in (the security task)

**Files:**
- Modify: `servers/sharing/retry-queue.js` (`HANDSHAKE_COMPLETE_SUBTYPE` + `buildHandshakeComplete`)
- Modify: `servers/sharing/nostr.js` (`sendInviteAccepted` method; thread `event` into the `onInviteAccepted` call at `:598`)
- Modify: `servers/sharing/boot.js` (`handleInviteAccepted` gains `event` + emits ack; `handleHandshakeComplete`; `onSocialMessage` dispatch; `onInviteAccepted` wrapper)
- Modify: `servers/sharing/tools/contacts.js` (acceptance send → `sendInviteAccepted`)
- Test: `tests/handshake-complete.test.js`

**Interfaces:**
- `HANDSHAKE_COMPLETE_SUBTYPE = "handshake_complete"` and `buildHandshakeComplete(eventIds): string` — mirrors `buildDeliveryReceipt`: `{ type:"crow_social", version:1, subtype:HANDSHAKE_COMPLETE_SUBTYPE, payload:{ event_ids } }`.
- `NostrManager.sendInviteAccepted(contact, content): Promise<{eventId, relays}>` — sends the acceptance DM exactly like `sendControl` (NIP-44, kind:4, NO message-row write) AND, when `published.length > 0 && (contact.id)` , calls `enqueueRetry(this.db, { eventId, contactId: contact.id, recipientPubkey, rawEvent: JSON.stringify(event), nowSec })`. This is the explicit carve-in — `shouldEnqueue` is NOT consulted or modified. Guarded: an enqueue failure never throws out of the send.
- `handleInviteAccepted(db, managers, payload, senderPubkey, event)` — new trailing `event` param. Emits a `handshake_complete` ack (naming `[event.id]`) to `senderPubkey` (a) after a successful `upsertFullContact` (any outcome) and (b) at the `"replayed"` branch (before its `return`). NOT on `"expired"` or the auth-fail bail. Ack is fire-and-forget, guarded.
- `handleHandshakeComplete(db, eventIds, senderPubkey)` — resolves the contact from the authenticated `senderPubkey`, then `markDelivered(db, eventIds, contact.id)` (contact-bound). Mirrors `handleDeliveryReceipt`. Never throws.

**Threat / limits note (fork SETTLED by Round-1 review — keep `"expired"→no-ack`):** the ack fires on promote-success + `"replayed"` but NOT on the ledger `"expired"` verdict. Consequence: a SHORT-CODE pairing whose inviter is offline for >10 min at pairing time processes the first `invite_accepted` past `codeExpiresAt` → `"expired"` → no promote, no ack → the acceptor's retry runs to its ~60h expiry with no completion, and the inviter never auto-adds the contact. This is bounded and R4-repairable (the acceptor can DM → the inviter sees a message-request → accept, or add-by-id), and short-code pairing is inherently a co-present/real-time flow, so the window rarely bites. Plain 24h link/QR invites carry no `inviteId`, skip the ledger entirely (`boot.js:148`), and ALWAYS promote+ack — they never strand. **The alternative (option D)** — relax the ledger so an AUTHENTICATED echo still promotes+acks past the window — is REJECTED, but on REPLAY-HYGIENE grounds, NOT because it "defeats an offline cracker" (Round-2 correction): the single-use ledger binds only HONEST clients that echo `inviteId`; an attacker who cracks the short code has already decrypted the inviter's real pubkeys and can forge an `invite_accepted` under their OWN identity with `inviteId` OMITTED — the auth check at `:140` passes and the ledger block is skipped entirely, so `"expired"→reject` never runs for them and the code-cracker threat is bounded ONLY by scrypt entropy + the C4 safety number, regardless of option chosen. What `"expired"→reject` correctly does is refuse to re-honor an authenticated ECHO (a captured/late honest `invite_accepted` carrying the nonce) past its window — clean replay hygiene at zero security cost, since PR3's ack to any such authenticated accept is benign (it only echoes the sender's own event id, encrypted to their own key, and clears nothing on the inviter side). Ship the plan's `"expired"→no-ack`.

- [ ] **Step 1: Write the failing test**

Create `tests/handshake-complete.test.js`:

```js
// tests/handshake-complete.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDSHAKE_COMPLETE_SUBTYPE,
  buildHandshakeComplete,
  DELIVERY_RECEIPT_SUBTYPE,
} from "../servers/sharing/retry-queue.js";

test("buildHandshakeComplete: crow_social envelope naming event ids", () => {
  const env = JSON.parse(buildHandshakeComplete(["evt-1", "evt-2", 5, ""]));
  assert.equal(env.type, "crow_social");
  assert.equal(env.subtype, HANDSHAKE_COMPLETE_SUBTYPE);
  assert.deepEqual(env.payload.event_ids, ["evt-1", "evt-2"]); // non-strings dropped
  assert.notEqual(HANDSHAKE_COMPLETE_SUBTYPE, DELIVERY_RECEIPT_SUBTYPE);
});
```

Add the handler + carve-in cases below (method-stub a real `NostrManager` per `tests/delivery-receipt-emit.test.js`; drive `handleInviteAccepted`/`handleHandshakeComplete` per `tests/invite-accepted-promote.test.js` + `tests/contact-promote.test.js`). Essential cases — write concrete assertions:

```js
// A. sendInviteAccepted enqueues on publish:
//    stub a NostrManager whose relay-publish returns success; call
//    sendInviteAccepted({ id: 7, secp256k1_pubkey: <64hex> }, '{"type":"invite_accepted",...}');
//    assert enqueueRetry was invoked (spy this.db.execute for INSERT ... message_retry_queue
//    with the event id + contact_id 7). With 0 relays published → NO enqueue.
//    Assert NO 'sent' messages row is written (control envelope, unlike sendMessage).
// B. handleInviteAccepted emits the ack on promote-success:
//    authenticated payload (normalizePubkey(payload.secp256k1Pub) === senderPubkey),
//    NO inviteId → upsertFullContact runs → assert nostrManager.sendControl was
//    called once with a buildHandshakeComplete([event.id]) envelope addressed to
//    { secp256k1_pubkey: senderPubkey }. (Stub upsertFullContact-free by using a
//    contacts db stub; or spy sendControl.)
// C. I4: ack on the "replayed" verdict too:
//    payload has inviteId; stub consumeShortInvite → "replayed"; assert
//    upsertFullContact did NOT run (no promote) BUT sendControl WAS called with
//    the handshake_complete ack (the cross-restart self-heal). event.id echoed.
// D. NO ack on "expired": stub consumeShortInvite → "expired"; assert sendControl
//    was NOT called and no promote ran.
// E. NO ack on auth-fail: normalizePubkey(payload.secp256k1Pub) !== senderPubkey →
//    assert sendControl NOT called, no promote, ledger consume NOT called.
// F. handleHandshakeComplete clears the retry row contact-bound:
//    seed a message_retry_queue row (nostr_event_id='evt-1', contact_id=3); a
//    contact row whose secp matches senderPubkey resolves to id 3; call
//    handleHandshakeComplete(db, ['evt-1'], senderPubkey) → assert the DELETE ran
//    for contact_id 3 + nostr_event_id 'evt-1' (row cleared).
// G. forged handshake_complete does NOT clear another contact's rows:
//    the retry row is contact_id=3 but senderPubkey resolves to contact id 9 (or
//    no contact) → assert the row for contact 3 is NOT deleted (markDelivered is
//    bound to the resolved contact.id). Never throws.
// H. event missing/undefined → handleInviteAccepted still promotes but sends NO
//    ack (guard event?.id); never throws.
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/handshake-complete.test.js` → FAIL (symbols not exported / handler undefined).

- [ ] **Step 3: `retry-queue.js`** — add beside `buildDeliveryReceipt`:

```js
export const HANDSHAKE_COMPLETE_SUBTYPE = "handshake_complete";

/** Pure: the crow_social ack an inviter sends when it has processed an
 * authenticated invite_accepted. Names the invite_accepted event id(s) so the
 * acceptor clears the exact retry row (markDelivered, contact-bound). Mirrors
 * buildDeliveryReceipt — a lost ack self-heals on the acceptor's next retry /
 * the inviter's next restart (the "replayed" re-ack). */
export function buildHandshakeComplete(eventIds) {
  const ids = (Array.isArray(eventIds) ? eventIds : [])
    .filter((x) => typeof x === "string" && x.length > 0);
  return JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: HANDSHAKE_COMPLETE_SUBTYPE,
    payload: { event_ids: ids },
  });
}
```

- [ ] **Step 4: `nostr.js` — `sendInviteAccepted` + thread `event`** — add the method beside `sendControl` (`:321`):

```js
  /**
   * Send an invite_accepted acceptance DM (control envelope — no message row)
   * AND enqueue it for retry (PR3 carve-in). The general shouldEnqueue policy
   * excludes invite_accepted; this is the ONE deliberate exception — the
   * acceptor retries the acceptance until the inviter acks it with
   * handshake_complete (which clears the row via markDelivered). Never throws
   * the enqueue.
   */
  async sendInviteAccepted(contact, content) {
    const { eventId, relays: published, event } = await this._sendControlEvent(contact, content);
    try {
      if (this.db && contact && contact.id != null && published.length > 0 && event) {
        // Normalize by LENGTH (66→64) exactly like sendMessage/_sendControlEvent —
        // NOT a /^0[23]/ replace, which would corrupt a 64-hex x-only key that
        // happens to start with 02/03. (recipient_pubkey is stored metadata only;
        // republish uses raw_event's #p tag — still, keep it correct.)
        let recipientPubkey = contact.secp256k1_pubkey || contact.secp256k1Pubkey || "";
        if (recipientPubkey.length === 66) recipientPubkey = recipientPubkey.slice(2);
        await enqueueRetry(this.db, {
          eventId,
          contactId: contact.id,
          recipientPubkey,
          rawEvent: JSON.stringify(event),
          nowSec: Math.floor(Date.now() / 1000),
        });
      }
    } catch { /* enqueue is best-effort */ }
    return { eventId, relays: published };
  }
```

Refactor `sendControl` to expose the raw event via a shared helper (so `sendInviteAccepted` can store it) WITHOUT changing `sendControl`'s public return shape:

```js
  async sendControl(contact, content) {
    const { eventId, relays } = await this._sendControlEvent(contact, content);
    return { eventId, relays };
  }

  /** Build+publish a kind:4 control DM; returns the signed event too. */
  async _sendControlEvent(contact, content) {
    if (this.relays.size === 0) await this.connectRelays();
    let recipientPubkey = contact.secp256k1_pubkey || contact.secp256k1Pubkey;
    if (recipientPubkey && recipientPubkey.length === 66) recipientPubkey = recipientPubkey.slice(2);
    const conversationKey = nip44.v2.utils.getConversationKey(this.identity.secp256k1Priv, recipientPubkey);
    const encrypted = nip44.v2.encrypt(content, conversationKey);
    const event = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [["p", recipientPubkey]], content: encrypted }, this.identity.secp256k1Priv);
    const published = [];
    for (const [url, relay] of this.relays) {
      try { if (await safeRelayPublish(relay, event)) published.push(url); } catch { /* relay best-effort */ }
    }
    return { eventId: event.id, relays: published, event };
  }
```

Thread the event into the invite-accepted callback (`nostr.js:598`): `await onInviteAccepted(payload, senderPubkey, event);`.

- [ ] **Step 5: `boot.js` — ack emission, handler, dispatch, wrapper**

Extend the retry-queue import (`:24`):
```js
import { markDelivered, DELIVERY_RECEIPT_SUBTYPE, HANDSHAKE_COMPLETE_SUBTYPE, buildHandshakeComplete } from "./retry-queue.js";
```

Add a guarded ack helper (near `handleInviteAccepted`):
```js
/** Fire-and-forget handshake_complete ack to the acceptor (authenticated
 * senderPubkey). Naming the invite_accepted event id lets the acceptor clear
 * the exact retry row. Best-effort — a lost ack self-heals. */
async function ackHandshake(nostrManager, senderPubkey, event) {
  try {
    if (!nostrManager || !event || !event.id) return;
    await nostrManager.sendControl({ secp256k1_pubkey: senderPubkey }, buildHandshakeComplete([event.id]));
  } catch { /* ack is best-effort */ }
}
```

Rewrite `handleInviteAccepted(db, managers, payload, senderPubkey, event)`: keep the auth check; at the `"replayed"` branch, call `await ackHandshake(managers?.nostrManager, senderPubkey, event);` BEFORE `return;` (I4); leave `"expired"` returning with NO ack; after a successful `upsertFullContact(...)`, call `await ackHandshake(managers?.nostrManager, senderPubkey, event);`. Concretely, the two edits inside the existing function:

```js
        if (verdict === "replayed") {
          console.warn("[sharing] short-code invite replay rejected");
          await ackHandshake(managers?.nostrManager, senderPubkey, event); // I4 self-heal
          return;
        }
```
```js
    await upsertFullContact(db, managers, {
      crowId: payload.crowId,
      ed25519Pub: payload.ed25519Pub,
      secp256k1Pub: payload.secp256k1Pub,
      displayName: payload.displayName,
    });
    await ackHandshake(managers?.nostrManager, senderPubkey, event);
```

Add `handleHandshakeComplete` (model on `handleDeliveryReceipt`, `:186`):
```js
/** The acceptor received the inviter's handshake_complete ack — clear the
 * invite_accepted retry row(s), CONTACT-BOUND to the authenticated sender so a
 * forged ack can't purge another contact's retries. Never throws. */
export async function handleHandshakeComplete(db, eventIds, senderPubkey) {
  try {
    const ids = (Array.isArray(eventIds) ? eventIds : []).filter((x) => typeof x === "string" && x);
    if (!db || ids.length === 0) return;
    const contact = await findContactByPubkey(db, senderPubkey);
    if (!contact) return;
    await markDelivered(db, ids, contact.id);
  } catch (err) {
    try { console.warn("[sharing] handshake_complete handling failed:", err.message); } catch {}
  }
}
```

Dispatch in `onSocialMessage` (add beside `:505-506`):
```js
    } else if (subtype === HANDSHAKE_COMPLETE_SUBTYPE) {
      await handleHandshakeComplete(db, payload.event_ids, senderPubkey);
```

Thread `event` in the `onInviteAccepted` wrapper (`:396-397`):
```js
  await nostrManager.subscribeToIncoming(async (payload, senderPubkey, event) => {
    await handleInviteAccepted(db, { syncManager, peerManager, nostrManager }, payload, senderPubkey, event);
  }, async (subtype, payload, senderPubkey) => {
```

- [ ] **Step 6: `tools/contacts.js` — send via the carve-in** — change the acceptance send in `acceptInviteCore` from `nostrManager.sendMessage(...)` to:
```js
    await nostrManager.sendInviteAccepted(
      { id: contactId, secp256k1_pubkey: peer.secp256k1Pubkey },
      acceptancePayload,
    );
```
(`contactId` is `upsertFullContact`'s return from Task 2.)

- [ ] **Step 6b: Patch the existing `short-invite-tools` stub (REQUIRED — else 3 committed tests go red).** `tests/short-invite-tools.test.js`'s `makeNostrStub` (`:62-70`) provides `sendMessage` but NO `sendInviteAccepted`; three cases (`:170` happy path, the single-use case, and the `crow_accept_invite` VERBATIM guard) capture the acceptance send by overriding `sendMessage` and asserting `sent.length === 1`. After Step 6's swap, `acceptInviteCore` calls `sendInviteAccepted` — which the stub lacks → a TypeError swallowed by `acceptInviteCore`'s `try/catch` → `sent` stays empty → those asserts FAIL. Fix the stub so a `sendMessage` capture also captures `sendInviteAccepted`, transparently (no per-case edits needed): add one line to `makeNostrStub`'s returned object:
```js
    sendInviteAccepted: overrides.sendInviteAccepted || overrides.sendMessage || (async () => ({ eventId: "e", relays: ["stub://r1"] })),
```
This file MUST be in Step 8's commit path.

- [ ] **Step 7: Run tests** — `node --test tests/handshake-complete.test.js tests/invite-accepted-promote.test.js tests/delivery-receipt-emit.test.js tests/accept-idempotent.test.js tests/short-invite-tools.test.js tests/contact-promote.test.js` → ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/handshake-complete.test.js
git commit tests/handshake-complete.test.js servers/sharing/retry-queue.js servers/sharing/nostr.js servers/sharing/boot.js servers/sharing/tools/contacts.js tests/short-invite-tools.test.js -m "feat(sharing): handshake_complete ack + invite_accepted retry carve-in (P2/C4)"
git show --stat HEAD
```

---

## Task 4: Contacts trust UI — safety number + verify toggle + card badge + i18n

**Files:**
- Modify: `servers/gateway/dashboard/panels/contacts/html.js` (`renderContactProfile` signature + safety-number/verify block; `renderContactList` card badge)
- Modify: `servers/gateway/dashboard/panels/contacts.js` (thread `identity.ed25519Pubkey`)
- Modify: `servers/gateway/dashboard/panels/contacts/api-handlers.js` (`set_verified` action)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (trust keys EN+ES)
- Test: `tests/contacts-trust-ui.test.js`

**Interfaces:**
- `renderContactProfile(contact, activities, groups, allGroups, lang, myEd25519Pubkey)` — new trailing `myEd25519Pubkey` param (a hex string or `""`). When both `myEd25519Pubkey` and `contact.ed25519_pubkey` are present and `contact.contact_type !== "manual"`, render a "Verification" section: the safety number (`computeSafetyNumber`, monospace, `escapeHtml`), plain-words copy, the current verified state, and a `set_verified` toggle form. Absent keys → omit the section (no crash).
- `set_verified` action (`api-handlers.js`): `UPDATE contacts SET verified = ? WHERE id = ?` with `verified` = `req.body.verified === "1" ? 1 : 0`; `return { redirect: "/dashboard/contacts?view=contact&contact=" + contactId }`.
- Card badge: a `✓` on `renderContactList` cards where `c.verified` is truthy.

- [ ] **Step 1: Write the failing test**

Create `tests/contacts-trust-ui.test.js` (mirror `tests/contacts-peer-add.test.js` fixture style). Concrete cases:

```js
// 1. renderContactProfile with myEd25519Pubkey + contact.ed25519_pubkey renders a
//    safety number (assert the output contains the exact computeSafetyNumber(...)
//    string) AND a form with action="set_verified".
// 2. When contact.verified is falsy → the toggle offers "Mark as verified"
//    (verified=1); when truthy → it shows a verified badge + an "unverify"
//    (verified=0) control. Assert both branches.
// 3. Omitted safety number: renderContactProfile(..., myEd25519Pubkey="") → NO
//    "set_verified" form, no throw.
// 4. Manual contact (contact_type="manual") → no verification section.
// 5. XSS: a contact with a hostile display_name still escapes; the safety number
//    is digits+spaces only (no escaping needed but assert no raw injection).
// 6. renderContactList: a card for a verified contact contains the verified
//    badge markup; an unverified one does not.
// 7. set_verified action (import handleContactAction): body { action:"set_verified",
//    contact_id:"5", verified:"1" } → asserts an UPDATE contacts SET verified = 1
//    WHERE id = 5 was issued (spy db.execute) and a redirect is returned;
//    verified:"0" → sets 0.
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/contacts-trust-ui.test.js` → FAIL.

- [ ] **Step 3: i18n keys** — add after `i18n.js:365` (both `en` + `es`, single-line style):

```js
  "contacts.verification": { en: "Verification", es: "Verificación" },
  "contacts.safetyNumber": { en: "Safety number", es: "Número de seguridad" },
  "contacts.safetyNumberHelp": { en: "Compare this number with your contact over a channel you trust — a phone call or in person. If it matches, they are who they say.", es: "Compara este número con tu contacto por un canal de confianza — una llamada o en persona. Si coincide, son quienes dicen ser." },
  "contacts.markVerified": { en: "Mark as verified", es: "Marcar como verificado" },
  "contacts.verified": { en: "Verified", es: "Verificado" },
  "contacts.unverify": { en: "Remove verification", es: "Quitar verificación" },
  "contacts.verifiedBadgeTitle": { en: "Safety number verified", es: "Número de seguridad verificado" },
```

- [ ] **Step 4: `renderContactProfile`** — add the `myEd25519Pubkey` param and a verification section. Import `computeSafetyNumber` at the top of `contacts/html.js` (`import { computeSafetyNumber } from "../../../../sharing/identity.js";` — verify the relative depth against the file's existing imports). Build the section (slot it into the return between `detailsHtml` and the final composition):

```js
  // Trust / safety-number verification (crow contacts only, when we can compute it).
  let verifyHtml = "";
  if (myEd25519Pubkey && contact.ed25519_pubkey && contact.contact_type !== "manual") {
    const safety = computeSafetyNumber(myEd25519Pubkey, contact.ed25519_pubkey);
    const isVerified = !!contact.verified;
    const toggle = isVerified
      ? `<form method="POST" style="display:inline"><input type="hidden" name="action" value="set_verified"><input type="hidden" name="contact_id" value="${contact.id}"><input type="hidden" name="verified" value="0"><button type="submit" class="btn btn-sm btn-secondary">${t("contacts.unverify", lang)}</button></form>`
      : `<form method="POST" style="display:inline"><input type="hidden" name="action" value="set_verified"><input type="hidden" name="contact_id" value="${contact.id}"><input type="hidden" name="verified" value="1"><button type="submit" class="btn btn-sm btn-primary">${t("contacts.markVerified", lang)}</button></form>`;
    verifyHtml = `<div class="profile-section">
      <div class="profile-section-title">${t("contacts.verification", lang)}${isVerified ? ` <span class="verified-badge" title="${t("contacts.verifiedBadgeTitle", lang)}">✓ ${t("contacts.verified", lang)}</span>` : ""}</div>
      <p style="font-size:0.8rem;color:var(--crow-text-secondary)">${t("contacts.safetyNumberHelp", lang)}</p>
      <div class="profile-field"><span class="profile-field-label">${t("contacts.safetyNumber", lang)}</span><span class="profile-field-value" style="font-family:monospace;letter-spacing:0.05em">${escapeHtml(safety)}</span></div>
      <div style="margin-top:0.5rem">${toggle}</div>
    </div>`;
  }
```
Interpolate `${verifyHtml}` into the final `return` (e.g. after `${detailsHtml}`). Update the function signature to accept `myEd25519Pubkey` as the 6th param (default `""`).

- [ ] **Step 5: `renderContactList` card badge** — in the card map (`html.js:159-176`), add a verified check to the name line:
```js
        <div class="contact-card-name">${escapeHtml(c.display_name || "Unknown")}${c.verified ? ` <span class="verified-badge" title="${t("contacts.verifiedBadgeTitle", lang)}">✓</span>` : ""}</div>
```

- [ ] **Step 6: Panel wiring (`contacts.js`)** — where the profile is built (`:67-69`), load the local identity and pass its ed25519 pubkey:
```js
      const { loadOrCreateIdentity } = await import("../../../sharing/identity.js");
      let myEd = "";
      try { myEd = loadOrCreateIdentity().ed25519Pubkey || ""; } catch {}
      bodyHtml = renderContactProfile(contact, activities, groups, groups, lang, myEd);
```
(Verify the relative import path against the other imports in `contacts.js`; use the same depth the panel already uses to reach `servers/sharing/`.)

- [ ] **Step 7: `set_verified` action (`api-handlers.js`)** — add beside `unblock` (`:68-74`):
```js
  if (action === "set_verified" && req.body.contact_id) {
    const contactId = parseInt(req.body.contact_id);
    await db.execute({
      sql: "UPDATE contacts SET verified = ? WHERE id = ?",
      args: [req.body.verified === "1" ? 1 : 0, contactId],
    });
    return { redirect: "/dashboard/contacts?view=contact&contact=" + contactId };
  }
```

- [ ] **Step 8: Run tests** — `node --test tests/contacts-trust-ui.test.js tests/contacts-peer-add.test.js` → ALL PASS.

- [ ] **Step 9: Commit**

```bash
git add tests/contacts-trust-ui.test.js
git commit tests/contacts-trust-ui.test.js servers/gateway/dashboard/panels/contacts/html.js servers/gateway/dashboard/panels/contacts.js servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/shared/i18n.js -m "feat(dashboard): contact safety-number + verified toggle + badge (P2/C4)"
git show --stat HEAD
```

---

## Task 5: Messages verified badge (SELECT threading + conversation header)

**Files:**
- Modify: `servers/gateway/routes/peer-messages.js:162-166` (add `verified` to the contact SELECT)
- Modify: `servers/gateway/dashboard/panels/messages/data-queries.js:46-48` (add `c.verified` to the conversation-list SELECT)
- Modify: `servers/gateway/dashboard/panels/messages/client.js` (thread `verified` into `headerData`; render the badge)
- Test: `tests/messages-verified-badge.test.js`

**Interfaces:**
- The peer contact object returned to the client (`/api/messages/peer/:contactId`) carries `verified`.
- `renderChatUI`'s `headerData` gains `verified`; a `✓` node renders next to the name when truthy.

- [ ] **Step 1: Write the failing test**

Create `tests/messages-verified-badge.test.js`. Because the header is client-side JS, test the SELECTs + the data threading at the server boundary (the pattern the messages panel tests already use — grep `data-queries` / `peer-messages` in `tests/`):

```js
// 1. peer-messages contact SELECT includes `verified`: assert the SQL string in
//    the route (or a small exported query builder if one exists) contains
//    "verified" so the client receives it. If the query is inline, add an
//    assertion via the existing route test harness that the returned contact
//    object has a `verified` field (0 by default).
// 2. data-queries conversation-list SELECT includes `c.verified` (assert the
//    unified-list row objects carry verified).
// If client.js has a testable pure helper for the header badge, assert it emits
// the badge markup only when verified is truthy; otherwise cover the badge via
// the isolated-boot smoke in Task 6 and keep this file to the SELECT assertions.
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/messages-verified-badge.test.js` → FAIL.

- [ ] **Step 3: Add `verified` to the SELECTs** —
  - `peer-messages.js:163`: `SELECT id, crow_id, display_name, ed25519_pubkey, is_blocked, last_seen, created_at, verified FROM contacts WHERE id = ?`.
  - `data-queries.js:46`: add `c.verified` to the peer-row column list.

- [ ] **Step 4: Thread + render in `client.js`** — in `loadPeerConversation` (`:650-658`), add `verified: contact.verified` to the `headerData` object. In `renderChatUI` (`:849`), after the name node, conditionally append a badge node (use `el(...)`/`textContent`, XSS-safe):
```js
  header.appendChild(el('div', { className: 'msg-chat-header-name', text: headerData.name }));
  if (headerData.verified) {
    header.appendChild(el('span', { className: 'verified-badge', text: '✓', title: tJs('contacts.verifiedBadgeTitle', lang) }));
  }
```
**Use lowercase `lang`** — `messagesClientJS(opts)` destructures `const { ..., lang } = opts` (`client.js:19`) and every existing `tJs(...)` call uses `lang` (evaluated server-side at template-generation time). A stray uppercase `LANG` is an undefined identifier → `ReferenceError` out of `messagesClientJS()` → the whole Messages panel 500s (not just a missing badge). `el()` (`client.js:61`) supports `title` via its attribute branch. Optionally add the same badge to the conversation-list rows and `showPeerInfo` if it's a one-line addition; if not trivial, leave a follow-up note (header is the spec's named surface).

- [ ] **Step 5: Run tests** — `node --test tests/messages-verified-badge.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/messages-verified-badge.test.js
git commit tests/messages-verified-badge.test.js servers/gateway/routes/peer-messages.js servers/gateway/dashboard/panels/messages/data-queries.js servers/gateway/dashboard/panels/messages/client.js -m "feat(dashboard): verified badge on the Messages conversation header (P2/C4)"
git show --stat HEAD
```

---

## Task 6: Full suite + boot (schema migration) + SECURITY-focused final review + PR → deploy

- [ ] **Step 1:** `node --test tests/ 2>&1 | tail -5` → 0 fail (1052 baseline + the new tests).
- [ ] **Step 2: Schema-migration boot check** — fresh-DB isolated boot MUST stamp `user_version = 4` and create the column:
```bash
D=$(mktemp -d); CROW_GATEWAY_URL= CROW_DATA_DIR=$D PORT=3999 timeout -k 5 25 node servers/gateway/index.js --no-auth > /tmp/p3boot.log 2>&1
grep -E "listening|Subscribed|Error" /tmp/p3boot.log | head
node -e "const {createClient}=require('@libsql/client');(async()=>{const db=createClient({url:'file:'+process.env.D+'/crow.db'});const uv=await db.execute('PRAGMA user_version');const ti=await db.execute(\"PRAGMA table_info(contacts)\");console.log('user_version',uv.rows[0].user_version);console.log('has verified',ti.rows.some(r=>r.name==='verified'));})()" D=$D
```
Expected: both subscribe lines, `user_version 4`, `has verified true`. (If the one-liner's client import differs from the repo's, use the repo's DB helper; the assertion is user_version=4 + column present.)
- [ ] **Step 3: Final whole-branch SECURITY review (opus)** — mandates: (a) **verified-reset completeness** — trace EVERY `upsertFullContact` write path (merge/promote/noop/create) and confirm `verified` resets on exactly the key-change paths and is preserved on noop; hunt for any OTHER path that mutates `crow_id`/`secp256k1_pubkey` without resetting `verified`. (b) **handshake ack forgery binding** — `handleHandshakeComplete` clears rows CONTACT-BOUND off the authenticated `senderPubkey`; a forged ack naming another contact's event ids cannot purge them (negative test); the ack emission is bound to the authenticated invite_accepted. (c) **retry carve-in correctness** — `shouldEnqueue` unchanged; `sendInviteAccepted` enqueues only on publish; the retry loop republishes the exact event; the ack clears via `markDelivered`; I4 re-ack on `"replayed"` present; the `"expired"` no-ack boundary is intentional + documented (weigh option D). (d) **never-throw** on all new receive-path handlers. (e) **event-threading** — `onInviteAccepted(payload, senderPubkey, event)` wired end-to-end; `event?.id` guarded. (f) **schema-migration safety** on populated prod (additive default-0 column, idempotent). (g) **XSS** on every new render (safety number is digits+spaces; display_name escaped). (h) **log hygiene** (no code/key logged). (i) instance-sync forward-note (verified not wired to sync).
- [ ] **Step 4:** Fix Critical/Important; re-review.
- [ ] **Step 5:** Record execution + review in this plan; update `.superpowers/sdd/progress.md`.
- [ ] **Step 6:** `git pull --rebase && git push -u origin feat/messages-p2-pr3-trust-completion`; PR via github MCP (owner=`kh0pper`, repo=`crow`, base=`main`) titled `feat(messages): robust completion + trust UI — idempotent accept, handshake ack, safety-number verify (Phase 2 PR3, C4)`; check-runs verified (`https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs` — expect 0 applicable; port-allocation is path-filtered off this diff); **merge OPERATOR-GATED (ask via AskUserQuestion)**; deploy crow: `git checkout main && git pull --rebase && echo '8r00kly^' | sudo -S systemctl restart crow-gateway.service`; verify `/health` 200 + `PRAGMA integrity_check` ok + **`PRAGMA user_version` → 4** + `[nostr] Subscribed to incoming on 4 relay(s)` + `[sharing] Subscribed to incoming Nostr messages` + `NRestarts=0`.

---

## Self-Review (against the design spec §PR3)

- **PR3.1 idempotent/repairable accept** → Task 2 (route `acceptInviteCore` through `upsertFullContact`; re-accept merges/promotes/noops; safety number preserved).
- **PR3.2 handshake completion surviving an offline inviter** → Task 3 (`handshake_complete` ack; `invite_accepted` retry carve-in via `sendInviteAccepted` — explicit enqueue, `shouldEnqueue` untouched; ack on promote-success + `"replayed"` I4; `handleHandshakeComplete` clears contact-bound; both directions idempotent). The `"expired"` no-ack boundary + option D are documented for the review/operator.
- **PR3.3 trust UI** → Task 1 (`verified` column, SCHEMA_GEN 3→4, reset-on-key-change) + Task 4 (safety number + verify toggle + card badge, EN+ES) + Task 5 (Messages header badge). Reset on every merge/promote key-change path; NOOP preserves; CREATE defaults 0.
- **Error handling** — new receive handlers never throw (guarded, fixed-string logs); UI omits the verify section when keys are absent; XSS-safe renders.
- **Testing** — per-PR unit tests for the column+reset, idempotent accept, handshake ack round-trip + forgery binding + carve-in, trust UI render + action, verified SELECT threading; full suite green; isolated boot asserts `user_version=4` + column present.
- **Type consistency** — `upsertFullContact → { contactId, outcome }` consumed in Tasks 2/3; `HANDSHAKE_COMPLETE_SUBTYPE`/`buildHandshakeComplete` in retry-queue.js matched in boot.js dispatch + ack; `sendInviteAccepted(contact, content) → {eventId, relays}`; `renderContactProfile(..., myEd25519Pubkey)` matched in the panel wiring; `verified` field flows column→SELECT→render uniformly.
- **Placeholder scan** — Tasks 2/4/5 give assertion-level test skeletons (adapt to existing harnesses the implementer must read first) with every case enumerated concretely; Tasks 1/3 give full test code. No TBDs.

## Review

**Round 1 (2026-07-06, adversarial security subagent, opus): APPROVE — 0 CRITICAL + 3 IMPORTANT + 3 MINOR, all addressed.** Every load-bearing anchor independently re-verified against live code @ `96064291`.
- **[IMPORTANT] Verified-reset hole outside `upsertFullContact`:** `ensure-local-bot-contact.js:38` rebinds `secp256k1_pubkey`/`ed25519_pubkey` without resetting `verified` — the ONLY other key-mutating `UPDATE contacts` in the repo (grep-confirmed; `edit_contact` + `messages/api-handlers.js` touch no key fields). FIXED: Task 1 Step 5b adds `verified = 0` there.
- **[IMPORTANT] I4 self-heal prose overstated:** re-ack fires only on an inviter RESTART within the `initialSince` re-receive window, not indefinitely; the common lost-ack-while-online case simply expires the retry row harmlessly at ~60h (contact already promoted both sides). FIXED: Background + Task 3 prose corrected to the honest accounting.
- **[IMPORTANT / fork SETTLED] `"expired"→no-ack` confirmed correct — option D REJECTED** (rationale corrected in Round 2, see below).
- Minors: M4 `sendInviteAccepted` recipient-pubkey normalization → length-based (66→64), not `/^0[23]/` (FIXED); M5 safety-number section gracefully omits on passphrase-encrypted-seed installs (known limitation, noted in Background); M6 line-drift — `computeSafetyNumber` at `:102`, `data-queries.js:46` is explicit named columns not `c.*` (FIXED in prose).
- Confirmed SOUND (no action): schema migration idempotent + O(1) default-0 fill + boot gate fires on `user_version 3<4`; no FTS/trigger on `contacts`; instance-sync emits no contact changes today (defaulted column safe; forward-note for Phase 3 stands); ack forgery binding airtight (contact-bound `markDelivered` off sig-verified `senderPubkey`; replayed captured ack is a no-op); `sendControl→_sendControlEvent` split transparent to both live callers (`room-fanout.js:37`, `_sendDeliveryReceipt`); Task-1 test stubs faithfully exercise the reset; event threading in-scope + guarded.

**Round 2 (2026-07-06, FRESH adversarial security subagent, opus): REVISE → all fixed.** Re-verified the three Round-1 fixes correct against live code (the `ensure-local-bot-contact.js:38` reset is the complete key-rebind set — grep re-confirmed; length-based normalization matches `_sendControlEvent`; `sendControl→_sendControlEvent` transparent to both callers).
- **[IMPORTANT] Task 3 left 3 committed tests red:** `tests/short-invite-tools.test.js`'s `makeNostrStub` has `sendMessage` but no `sendInviteAccepted`; after Task 3's swap the acceptance TypeError is swallowed by `acceptInviteCore`'s try/catch → `sent.length===1` asserts fail, and the file wasn't in Task 3's scope. FIXED: Task 3 Step 6b patches the stub (one-line `sendInviteAccepted` fallback to the `sendMessage` override) + the file is now in Step 8's commit; Task 2 case 4 rewritten to capture from BOTH methods into one shared array (survives the swap).
- **[IMPORTANT] Task 5 badge sample used `LANG`:** the in-scope var is lowercase `lang` (destructured at `client.js:19`, evaluated server-side); an undefined `LANG` → `ReferenceError` → the ENTIRE Messages panel 500s. FIXED: `LANG`→`lang` + a warning note.
- **[MINOR, important correction] the offline-crack rationale for `expired→no-ack` was WRONG:** an attacker who cracks the code can forge `invite_accepted` from their OWN identity with `inviteId` omitted, bypassing the ledger entirely — so `expired→reject` never runs for them and does NOT defeat the offline cracker (that's bounded by scrypt entropy + the safety number regardless). The DECISION stands, but on replay-hygiene grounds only. FIXED: threat note reworded; PR3's ack to such a forged-authenticated accept confirmed benign (echoes the attacker's own event id, clears nothing on the inviter side).
- Confirmed SOUND (no action): only one `renderContactProfile` caller (`contacts.js:69`, async, 6th param defaults `""`); `getContact`/`getContacts` `SELECT c.*` feed profile+card badge; badge-surface scoping honest (message-requests are unverifiable `pending` rows by construction); no safety-number TOCTOU (key + verified read together, reset on every key change); migration backfills 0 not NULL; forged-ack negative case correct; `event=undefined` on legacy 4-arg callers → no ack, no regression.

**Both rounds resolved. Plan APPROVED for execution.**
