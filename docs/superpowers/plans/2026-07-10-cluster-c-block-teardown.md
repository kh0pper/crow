# Cluster C — Block Actually Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Blocking a contact tears down its live wiring immediately (no restart), unblocking re-wires it, and no receive path can store/notify/ack a blocked contact's inbound — fixing F-BLOCK-1 and its unread-badge addendum.

**Architecture:** Both block handlers call the #155 delete-path teardown primitive `unwireContact` (Nostr unsub + Hypercore feeds + DHT); both unblock handlers call `wireSyncedContact` (lazy re-wire); the sync-apply blocked branch upgrades to full `unwireContact` (cross-instance leg); four receive-time guards (per-contact `onevent`, `handleIncomingRequest`, `group_message`, `handleInviteAccepted` + `wireFullContact` belt) make the receive path unable to store/notify/ack blocked inbound even during races. Spec (2-round adversarially reviewed): `docs/superpowers/specs/2026-07-10-block-teardown-design.md`.

**Tech Stack:** Node ESM, libsql-style client (`db.execute`), node:test, nostr-tools NIP-44.

## Global Constraints

- **No SCHEMA_GENERATION bump** — code-only; no DDL.
- **NEVER `git commit --amend`.** Commit with **positional paths only** (`git add <path>` first for NEW files); verify `git show --stat HEAD` after every commit. Tree has unrelated WIP — never `git add -A`/`git add .`.
- Branch: `fix/messages-cluster-c-block-teardown`. Suite baseline: **1385 pass / 1 pre-existing fail (bundle-contract, foreign) / 1 skip**.
- Blocking is SILENT toward the blocked party: no store, no notification, no unread emit, no instance-sync mirror emit, no delivery receipt, no handshake ack, no `onMessage`.
- D4d's early-return placement is load-bearing: **before** the `wasProcessed` ack branch AND the short-code `"replayed"` ack branch.
- D4c is a **reorder** (sender resolve moves above the unconditional notification); the guard is `found && is_blocked===1`, never `!found` — an unknown group sender must still notify exactly as today.
- Receive-path guards must never throw (a throw kills the subscription); every new lookup is try/caught with fail-open-to-current-behavior.

---

### Task 1: D4a — fresh `is_blocked` check in `subscribeToContact.onevent`

**Files:**
- Modify: `servers/sharing/nostr.js` (inside `subscribeToContact`'s `onevent`, before the messages INSERT at ~line 483)
- Test: `tests/block-onevent-guard.test.js` (new)

**Interfaces:**
- Consumes: nothing new. Produces: nothing exported — behavioral guard only.

- [ ] **Step 1: Write the failing test**

Create `tests/block-onevent-guard.test.js` (harness mirrors `tests/nostr-receive-health-hooks.test.js` — stub relay + real NIP-44):

```js
/**
 * Cluster C D4a — a per-contact subscription that is still live when the
 * contact is blocked (block→teardown race, or a future wiring path that
 * forgets teardown) must NOT store, receipt, or surface the inbound DM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { getPublicKey, nip44 } from "nostr-tools";
import { NostrManager } from "../servers/sharing/nostr.js";

function stubRelay() {
  const r = {
    connected: true, subscribeCalls: [], closed: false,
    subscribe(filters, { onevent, onclose }) {
      r.subscribeCalls.push({ filters, onevent, onclose });
      const s = { onevent, onclose, closed: false, close() { this.closed = true; } };
      return s;
    },
    async connect() { r.connected = true; },
    close() { r.closed = true; },
  };
  return r;
}

const ourPriv = new Uint8Array(32).fill(1);
const theirPriv = new Uint8Array(32).fill(2);
const ourPub = getPublicKey(ourPriv);
const theirPub = getPublicKey(theirPriv);
const identity = { secp256k1Pubkey: ourPub, secp256k1Priv: ourPriv };
const encryptToUs = (pt) => nip44.v2.encrypt(pt, nip44.v2.utils.getConversationKey(theirPriv, ourPub));

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "block-onevent-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("onevent: blocked contact's DM is silently dropped (no row, no receipt); unblocked stores", async () => {
  const { db, cleanup } = freshDb();
  try {
    const ins = await db.execute({
      sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES ('crow:blockee', 'ed', ?, 'Blockee')",
      args: [theirPub],
    });
    const contactId = Number(ins.lastInsertRowid);

    const mgr = new NostrManager(identity, db);
    let receipts = 0;
    mgr._sendDeliveryReceipt = async () => { receipts++; };
    const relay = stubRelay();
    mgr.relays.set("wss://stub", relay);
    await mgr.subscribeToContact({ id: contactId, crow_id: "crow:blockee", secp256k1_pubkey: theirPub, display_name: "Blockee" });
    const onevent = relay.subscribeCalls[0].onevent;

    // Block AFTER subscribe — the sub is live (the F-BLOCK-1 shape).
    await db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?", args: [contactId] });
    await onevent({ id: "evt-blocked", pubkey: theirPub, created_at: 1_700_000_000, content: encryptToUs("while blocked") });
    let n = await db.execute({ sql: "SELECT COUNT(*) AS c FROM messages WHERE contact_id = ?", args: [contactId] });
    assert.equal(Number(n.rows[0].c), 0, "blocked inbound must NOT store");
    assert.equal(receipts, 0, "blocked inbound must NOT be receipted (silence)");

    // Unblock — the same live sub stores again (fresh check each event).
    await db.execute({ sql: "UPDATE contacts SET is_blocked = 0 WHERE id = ?", args: [contactId] });
    await onevent({ id: "evt-unblocked", pubkey: theirPub, created_at: 1_700_000_001, content: encryptToUs("after unblock") });
    n = await db.execute({ sql: "SELECT COUNT(*) AS c FROM messages WHERE contact_id = ?", args: [contactId] });
    assert.equal(Number(n.rows[0].c), 1, "unblocked inbound stores");
    assert.equal(receipts, 1, "unblocked inbound is receipted");
    await mgr.destroy();
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/block-onevent-guard.test.js`
Expected: FAIL — "blocked inbound must NOT store" (count 1) and receipts 1.

- [ ] **Step 3: Implement**

In `servers/sharing/nostr.js`, inside `onevent`, AFTER the `invite_accepted`/`crow_social` JSON early-return block and BEFORE the `if (contactId && this.db)` store block, insert:

```js
            // F-BLOCK-1 D4a: fresh block check. The sub is torn down on block,
            // but an in-flight event — or a future wiring path that forgets
            // teardown — must not store, notify, bump unread, mirror, receipt,
            // or surface a blocked contact's DM. Silent drop (no receipt: we
            // deliberately stop confirming receipt to a blocked party).
            if (contactId && this.db) {
              try {
                const { rows: blockRows } = await this.db.execute({
                  sql: "SELECT is_blocked FROM contacts WHERE id = ?",
                  args: [contactId],
                });
                if (Number(blockRows?.[0]?.is_blocked ?? 0) === 1) return;
              } catch { /* an unreadable check must not break delivery */ }
            }
```

(`markInbound()` above it still runs — the relay IS healthy; only the contact is blocked.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/block-onevent-guard.test.js tests/nostr-receive-health-hooks.test.js tests/nostr-resubscribe.test.js`
Expected: ALL PASS (the two pre-existing receive-path suites prove no regression).

- [ ] **Step 5: Commit**

```bash
git add tests/block-onevent-guard.test.js
git commit tests/block-onevent-guard.test.js servers/sharing/nostr.js -m "fix(sharing): blocked contact's inbound DM is dropped at receive time — fresh is_blocked check in the per-contact onevent (F-BLOCK-1 D4a)"
git show --stat HEAD
```

---

### Task 2: D4b + D4c — `handleIncomingRequest` early-return + `group_message` reorder

**Files:**
- Modify: `servers/sharing/boot.js` (`handleIncomingRequest` ~line 83; `group_message` branch ~lines 548-578)
- Test: `tests/block-receive-guards.test.js` (new)

**Interfaces:**
- Consumes: `handleIncomingRequest(db, managers, {senderPubkey, content, eventId})` — already exported; `managers.createNotification` injectable (existing test hook).

- [ ] **Step 1: Write the failing test**

Create `tests/block-receive-guards.test.js`:

```js
/**
 * Cluster C D4b + D4c — the catch-all receive paths drop a blocked contact's
 * inbound: message-requests (any request_status) and group_message fan-outs
 * (no notification, no store). An UNKNOWN group sender still notifies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { handleIncomingRequest, handleSocialMessage } from "../servers/sharing/boot.js";

const SECP = "b".repeat(64);

function freshDb(tag) {
  const dir = mkdtempSync(join(tmpdir(), `block-guards-${tag}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("D4b: blocked request contact (pending/accepted/full) → no store, no notification", async () => {
  const { db, cleanup } = freshDb("d4b");
  try {
    const cases = [
      { secp: "a".repeat(64), status: "pending" },
      { secp: "c".repeat(64), status: "accepted" },
      { secp: "d".repeat(64), status: null },
    ];
    let notifications = 0;
    const managers = { createNotification: async () => { notifications++; } };
    for (const c of cases) {
      await db.execute({
        sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, request_status, is_blocked) VALUES (?, ?, '', ?, 1)",
        args: [`req:${c.secp}`, c.secp, c.status],
      });
      await handleIncomingRequest(db, managers, { senderPubkey: c.secp, content: "hi", eventId: `e-${c.secp.slice(0, 4)}` });
      const { rows } = await db.execute("SELECT COUNT(*) AS c FROM messages");
      assert.equal(Number(rows[0].c), 0, `blocked ${c.status ?? "full"} contact must not store`);
    }
    assert.equal(notifications, 0, "no notifications for blocked senders");

    // Control: an UNblocked pending request still stores (existing behavior).
    const okSecp = "e".repeat(64);
    await db.execute({
      sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, request_status, is_blocked) VALUES (?, ?, '', 'pending', 0)",
      args: [`req:${okSecp}`, okSecp],
    });
    await handleIncomingRequest(db, managers, { senderPubkey: okSecp, content: "hello", eventId: "e-ok" });
    const { rows } = await db.execute("SELECT COUNT(*) AS c FROM messages");
    assert.equal(Number(rows[0].c), 1, "unblocked pending request still stores");
  } finally { cleanup(); }
});
```

NOTE FOR THE IMPLEMENTER on D4c's test: check whether the `group_message` branch is reachable through an exported function (the `onSocialMessage` dispatcher in boot.js — find its export or the smallest exported wrapper). If the subtype dispatcher is NOT exported, export the smallest testable unit the same way `handleIncomingRequest` already is (a `handleGroupMessageNotify(db, payload)` extraction is acceptable if the inline branch can't be driven), then add these three cases to this test file:
1. blocked sender (`sender_crow_id` of a contact with `is_blocked=1`) → NO notification, NO messages row;
2. unblocked sender → notification + stored row (existing behavior);
3. UNKNOWN sender (`sender_crow_id` matches no contact) → notification fires, no row (pins the reorder against a `!found` mistake).
Inject the notification counter the same way (`managers.createNotification` or the extraction's parameter). Assertions are fixed; mechanics may adapt. The `handleSocialMessage` import in the sketch is a GUESS — replace it with whatever exported symbol actually reaches the `group_message` branch.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/block-receive-guards.test.js`
Expected: FAIL — blocked cases store rows / fire notifications.

- [ ] **Step 3: Implement D4b**

In `servers/sharing/boot.js`, in `handleIncomingRequest`, immediately after `const existing = await findContactByPubkey(db, senderPubkey);`:

```js
    // F-BLOCK-1 D4b: a blocked contact — ANY request_status (full, pending,
    // accepted) — is silently dropped on the catch-all path: no store, no
    // notification. This was the S5.4 live store path.
    if (existing && Number(existing.is_blocked) === 1) return;
```

- [ ] **Step 4: Implement D4c (reorder)**

Replace the `group_message` branch body with (notification content and store content byte-identical; only the sender resolve MOVES above the notification):

```js
    } else if (subtype === "group_message") {
      const { group_name, sender_name, message: msgText } = payload;
      if (!msgText) return;
      // F-BLOCK-1 D4c: resolve the sender BEFORE the notification — a blocked
      // group member must neither notify nor store (their fan-out includes us;
      // send-side filters only cover members WE blocked when WE fan out). An
      // UNKNOWN (non-contact) sender still notifies exactly as before — the
      // guard is found&&blocked, never !found.
      let senderRow = null;
      try {
        const senderContact = await db.execute({
          sql: "SELECT id, is_blocked FROM contacts WHERE crow_id = ?",
          args: [payload.sender_crow_id || ""],
        });
        senderRow = senderContact.rows[0] || null;
      } catch { /* lookup failure degrades to today's behavior */ }
      if (senderRow && Number(senderRow.is_blocked) === 1) return;
      try {
        await createNotification(db, {
          title: `[${group_name || "Group"}] ${sender_name || "Someone"}`,
          body: msgText.length > 200 ? msgText.slice(0, 200) + "..." : msgText,
          type: "peer",
          source: "sharing:group_message",
          priority: "high",
        });
      } catch (err) {
        console.warn("[sharing] Failed to create group message notification:", err.message);
      }
      // Also store as a regular message with group context.
      // Phase 3 PR-B: deliberately NOT emitted to instance-sync — synthetic
      // grp_<ts> event id (not a real Nostr event); rooms have their own sync path.
      try {
        if (senderRow) {
          await db.execute({
            sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
                  VALUES (?, ?, ?, 'received', 0, datetime('now'))`,
            args: [senderRow.id, `grp_${Date.now()}`, `[${group_name}] ${msgText}`],
          });
        }
      } catch {}
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/block-receive-guards.test.js tests/message-request-actions.test.js`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/block-receive-guards.test.js
git commit tests/block-receive-guards.test.js servers/sharing/boot.js -m "fix(sharing): blocked contacts dropped on the catch-all receive paths — message-requests + group_message (F-BLOCK-1 D4b/D4c; unknown group sender still notifies)"
git show --stat HEAD
```

---

### Task 3: D3 + D4d — sync-apply full teardown, blocked-handshake silence, `wireFullContact` belt

**Files:**
- Modify: `servers/sharing/contact-promote.js` (blocked branch of `wireSyncedContact` ~line 101; export + belt-guard `wireFullContact` ~line 77)
- Modify: `servers/sharing/boot.js` (`handleInviteAccepted` — insert after the auth check at ~line 182)
- Test: `tests/block-rewire-guards.test.js` (new)

**Interfaces:**
- Consumes: `unwireContact(managers, row)` from `./contact-delete.js` (contact-promote.js already imports from that module — extend the import; acyclic).
- Produces: `wireFullContact` becomes an export of contact-promote.js (belt-guarded on `row.is_blocked`).

- [ ] **Step 1: Write the failing test**

Create `tests/block-rewire-guards.test.js`:

```js
/**
 * Cluster C D3 + D4d — the sync-apply blocked branch performs the FULL
 * teardown (incl. the Nostr unsub the old inline pair missed); a blocked
 * contact's invite_accepted is silenced (no upsert, no ack — even on the
 * ~60h replay of an already-processed event); wireFullContact refuses to
 * wire a blocked row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { getPublicKey } from "nostr-tools";
import { wireSyncedContact, wireFullContact } from "../servers/sharing/contact-promote.js";
import { handleInviteAccepted } from "../servers/sharing/boot.js";
import { recordProcessedEvent } from "../servers/sharing/processed-events.js";

const theirPriv = new Uint8Array(32).fill(7);
const theirPub = getPublicKey(theirPriv);

function freshDb(tag) {
  const dir = mkdtempSync(join(tmpdir(), `block-rewire-${tag}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function stubManagers() {
  const calls = [];
  return {
    calls,
    nostrManager: {
      unsubscribeFromContact: (crowId) => calls.push(["unsub", crowId]),
      subscribeToContact: async (c) => calls.push(["sub", c.crow_id || c.crowId]),
      sendControl: async () => calls.push(["ack"]),
      relays: new Map([["wss://stub", {}]]),
      connectRelays: async () => {},
      sendInviteAccepted: async () => {},
    },
    syncManager: {
      closeContactFeeds: async (id) => calls.push(["closeFeeds", id]),
      initContact: async (id) => calls.push(["initContact", id]),
    },
    peerManager: {
      leaveContact: async (crowId) => calls.push(["leave", crowId]),
      joinContact: async (c) => calls.push(["join", c.crowId]),
    },
  };
}

test("D3: wireSyncedContact on a blocked row performs the FULL teardown (incl. Nostr unsub)", async () => {
  const m = stubManagers();
  await wireSyncedContact(m, { id: 7, crow_id: "crow:blocked1", is_blocked: 1, secp256k1_pubkey: theirPub, ed25519_pubkey: "ed" });
  const kinds = m.calls.map((c) => c[0]);
  assert.ok(kinds.includes("unsub"), "Nostr unsubscribe — the leg the old inline pair missed");
  assert.ok(kinds.includes("closeFeeds"), "feeds closed");
  assert.ok(kinds.includes("leave"), "DHT topic left");
  assert.ok(!kinds.includes("sub"), "never subscribes a blocked row");
});

test("D4d belt: wireFullContact refuses a blocked row", async () => {
  const m = stubManagers();
  await wireFullContact(m, { id: 8, crow_id: "crow:blocked2", is_blocked: 1, secp256k1_pubkey: theirPub, ed25519_pubkey: "ed" });
  assert.equal(m.calls.length, 0, "no initContact/joinContact/subscribeToContact for a blocked row");
});

test("D4d: blocked sender's invite_accepted → no upsert, no ack — even for an already-processed event.id", async () => {
  const { db, cleanup } = freshDb("d4d");
  try {
    await db.execute({
      sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, display_name, is_blocked) VALUES ('crow:blocked3', ?, 'ed', 'Blocked3', 1)",
      args: [theirPub],
    });
    // The common blocked shape: the handshake WAS processed once, THEN the
    // user blocked. The sender's ~60h retry re-sends the same event.id.
    await recordProcessedEvent(db, "evt-replayed", "invite_accepted");

    const m = stubManagers();
    const payload = { type: "invite_accepted", crowId: "crow:blocked3", ed25519Pub: "ed", secp256k1Pub: theirPub, displayName: "Evil Rename" };
    await handleInviteAccepted(db, m, payload, theirPub, { id: "evt-replayed" });

    assert.ok(!m.calls.some((c) => c[0] === "ack"), "NO handshake ack to a blocked sender (placement before the replay branch)");
    const { rows } = await db.execute("SELECT display_name FROM contacts WHERE crow_id = 'crow:blocked3'");
    assert.equal(rows[0].display_name, "Blocked3", "no upsert mutation");
    assert.ok(!m.calls.some((c) => c[0] === "sub" || c[0] === "initContact"), "no re-wire");
  } finally { cleanup(); }
});
```

NOTE FOR THE IMPLEMENTER: `handleInviteAccepted`'s ack goes through `ackHandshake` → `managers.nostrManager.sendControl` — verify the stub surface matches the real call (open boot.js:150-160) and adapt the stub so an ack WOULD be recorded if the code reached it (the assertion must be capable of failing). If `recordProcessedEvent`'s signature differs, mirror its real usage from boot.js:232.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/block-rewire-guards.test.js`
Expected: FAIL — test 1 (no `unsub` recorded), test 2 (import error: `wireFullContact` not exported), test 3 (ack recorded on the replay branch).

- [ ] **Step 3: Implement**

`servers/sharing/contact-promote.js`:
1. Extend the existing contact-delete import: `import { readTombstone, clearTombstone, unwireContact } from "./contact-delete.js";`
2. Export + belt-guard `wireFullContact`:
```js
export async function wireFullContact(managers, row) {
  // F-BLOCK-1 D4d belt: no upsert path (tool, accept, invite_accepted) may
  // wire a blocked contact. The wiring returns on unblock (wireSyncedContact).
  if (row?.is_blocked) return;
  const { syncManager, peerManager, nostrManager } = managers || {};
  ...unchanged body...
```
3. Replace the blocked branch of `wireSyncedContact`:
```js
    if (row.is_blocked) {
      // F-BLOCK-1 D3: FULL teardown. The old inline pair closed feeds + left
      // the DHT but LEFT THE LIVE NOSTR SUB — the cross-instance leg of the
      // finding (a synced block must silence this instance too).
      // unwireContact is the single teardown owner (delete + block paths).
      await unwireContact(managers, row);
      return;
    }
```

`servers/sharing/boot.js`, in `handleInviteAccepted`, IMMEDIATELY after the auth check (`if (normalizePubkey(payload.secp256k1Pub) !== normalizePubkey(senderPubkey)) return;`) and BEFORE the `wasProcessed` branch:
```js
    // F-BLOCK-1 D4d: silence toward a blocked contact. Resolve BEFORE the
    // replay-hygiene and short-code branches below — BOTH of those ack, and
    // the common blocked case ("handshake processed, then blocked") re-sends
    // the same event.id for ~60h, which would keep acking a blocked party.
    // No upsert, no ack, no wiring. Skipping consumeShortInvite is safe: the
    // invite was consumed on the pre-block accept, and an unconsumed row
    // expires at the 72h ledger TTL.
    try {
      const senderContact = await findContactByPubkey(db, senderPubkey);
      if (senderContact && Number(senderContact.is_blocked) === 1) return;
    } catch { /* resolution failure must not break honest handshakes */ }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/block-rewire-guards.test.js tests/contacts-sync-hook.test.js tests/invite-accepted-promote.test.js tests/accept-idempotent.test.js tests/contact-promote.test.js tests/handshake-complete.test.js`
Expected: ALL PASS (the five pre-existing suites prove the promote/handshake paths are unregressed).

- [ ] **Step 5: Commit**

```bash
git add tests/block-rewire-guards.test.js
git commit tests/block-rewire-guards.test.js servers/sharing/contact-promote.js servers/sharing/boot.js -m "fix(sharing): synced block tears down the live Nostr sub; blocked handshakes are silenced before the ack branches; wireFullContact refuses blocked rows (F-BLOCK-1 D3/D4d)"
git show --stat HEAD
```

---

### Task 4: D1 + D2 — block tears down, unblock re-wires (both panels) + D5 seam

**Files:**
- Modify: `servers/gateway/dashboard/panels/contacts/api-handlers.js` (block/unblock actions, lines ~42-83; imports; options seam)
- Modify: `servers/gateway/dashboard/panels/messages/api-handlers.js` (block/unblock actions, lines ~89-127; imports)
- Test: `tests/block-handler-teardown.test.js` (new)

**Interfaces:**
- Consumes: `unwireContact` (contact-delete.js), `wireSyncedContact` (contact-promote.js), the messages handler's existing `_managers` seam (`handlePostAction(req, res, { db, sharingClientFactory, _managers })`).
- Produces: `handleContactAction(req, db, { sharingClientFactory, managers })` — new optional `managers` (default `getManagersOrNull()`).

- [ ] **Step 1: Write the failing test**

Create `tests/block-handler-teardown.test.js`:

```js
/**
 * Cluster C D1/D2 — the block actions tear down ALL live wiring (Nostr unsub +
 * feeds + DHT) via unwireContact; the unblock actions lazily re-wire via
 * wireSyncedContact. Both panels; includes the S5.4 req:-accepted shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";

const SECP = "02" + "a".repeat(64);

function freshDb(tag) {
  const dir = mkdtempSync(join(tmpdir(), `block-handlers-${tag}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function stubManagers() {
  const calls = [];
  return {
    calls,
    nostrManager: {
      unsubscribeFromContact: (crowId) => calls.push(["unsub", crowId]),
      subscribeToContact: async (c) => calls.push(["sub", c.crow_id || c.crowId]),
    },
    syncManager: {
      closeContactFeeds: async (id) => calls.push(["closeFeeds", id]),
      initContact: async (id) => calls.push(["initContact", id]),
    },
    peerManager: {
      leaveContact: async (crowId) => calls.push(["leave", crowId]),
      joinContact: async (c) => calls.push(["join", c.crowId]),
    },
  };
}

test("contacts panel: block → full teardown; unblock → re-wire; keyless manual stays inert", async () => {
  const { db, cleanup } = freshDb("contacts");
  try {
    const ins = await db.execute({
      sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES ('crow:t1', 'ed', ?, 'T1')",
      args: [SECP],
    });
    const id = Number(ins.lastInsertRowid);

    const m1 = stubManagers();
    const out1 = await handleContactAction({ body: { action: "block", contact_id: String(id) } }, db, { managers: m1 });
    assert.ok(out1?.redirect, "block redirects");
    const k1 = m1.calls.map((c) => c[0]);
    assert.ok(k1.includes("unsub"), "block tears down the Nostr sub (the F-BLOCK-1 leg)");
    assert.ok(k1.includes("closeFeeds") && k1.includes("leave"), "feeds + DHT teardown preserved");
    const b = await db.execute({ sql: "SELECT is_blocked FROM contacts WHERE id = ?", args: [id] });
    assert.equal(Number(b.rows[0].is_blocked), 1);

    const m2 = stubManagers();
    await handleContactAction({ body: { action: "unblock", contact_id: String(id) } }, db, { managers: m2 });
    const k2 = m2.calls.map((c) => c[0]);
    assert.ok(k2.includes("initContact") && k2.includes("join") && k2.includes("sub"), "unblock re-wires (no restart needed)");

    // Keyless manual contact: block+unblock never touch wiring, never throw.
    const insM = await db.execute("INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, contact_type) VALUES ('manual:x', '', '', 'M', 'manual')");
    const mid = Number(insM.lastInsertRowid);
    const m3 = stubManagers();
    await handleContactAction({ body: { action: "block", contact_id: String(mid) } }, db, { managers: m3 });
    await handleContactAction({ body: { action: "unblock", contact_id: String(mid) } }, db, { managers: m3 });
    assert.ok(!m3.calls.some((c) => c[0] === "sub" || c[0] === "join" || c[0] === "initContact"), "keyless manual is never wired");
  } finally { cleanup(); }
});

test("messages panel: block/unblock by crow_id incl. the req:-accepted stranger shape", async () => {
  const { db, cleanup } = freshDb("messages");
  try {
    const reqSecp = "f".repeat(64);
    await db.execute({
      sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, request_status) VALUES (?, ?, '', 'accepted')",
      args: [`req:${reqSecp}`, reqSecp],
    });
    const res = { redirected: null, redirectAfterPost(u) { this.redirected = u; return u; } };

    const m1 = stubManagers();
    await handlePostAction({ body: { action: "block", crow_id: `req:${reqSecp}` } }, res, { db, _managers: m1 });
    assert.ok(m1.calls.some((c) => c[0] === "unsub" && c[1] === `req:${reqSecp}`), "req: accepted stranger's live sub torn down (S5.4)");

    const m2 = stubManagers();
    await handlePostAction({ body: { action: "unblock", crow_id: `req:${reqSecp}` } }, res, { db, _managers: m2 });
    assert.ok(m2.calls.some((c) => c[0] === "sub"), "unblock re-subscribes");
  } finally { cleanup(); }
});
```

NOTE FOR THE IMPLEMENTER: open `tests/message-request-actions.test.js` first and mirror its exact `handlePostAction` invocation shape (res stub, opts). If `handlePostAction` requires more of `res` (e.g. `redirect`), extend the stub from that precedent. The assertions are fixed.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/block-handler-teardown.test.js`
Expected: FAIL — no `unsub` recorded on block (old inline pair), nothing recorded on unblock, and `managers` opt not honored by `handleContactAction`.

- [ ] **Step 3: Implement**

`servers/gateway/dashboard/panels/contacts/api-handlers.js`:
1. Imports: extend `import { deleteContactLocal } from "../../../../sharing/contact-delete.js";` → `import { deleteContactLocal, unwireContact } from ...`; extend the contact-promote import (or add) with `wireSyncedContact`.
2. Signature: `export async function handleContactAction(req, db, { sharingClientFactory = makeSharingClient, managers: injectedManagers = null } = {})`, then first lines:
```js
  const { action } = req.body;
  const managers = injectedManagers || getManagersOrNull();
```
3. Replace the block action body:
```js
  if (action === "block" && req.body.contact_id) {
    const contactId = parseInt(req.body.contact_id);
    await db.execute({
      sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?",
      args: [contactId],
    });
    // F-BLOCK-1 D1: tear down ALL live wiring — the Nostr relay sub (the leg
    // the old inline pair missed; inbound kept storing until restart), the
    // Hypercore feeds, and the DHT topic — via the delete-path primitive.
    // unwireContact is the single teardown owner.
    let row = null;
    try {
      const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [contactId] });
      row = rows[0] || null;
    } catch {}
    if (managers && row) { try { await unwireContact(managers, row); } catch {} }
    // Phase 3: a block follows the user across their instances.
    try { if (row) await emitContactChange("update", row); } catch {}
    return { redirect: "/dashboard/contacts" };
  }
```
4. Replace the unblock action body:
```js
  if (action === "unblock" && req.body.contact_id) {
    const contactId = parseInt(req.body.contact_id);
    await db.execute({
      sql: "UPDATE contacts SET is_blocked = 0 WHERE id = ?",
      args: [contactId],
    });
    // F-BLOCK-1 D2: lazy re-wire (initContact + joinContact + subscribeToContact
    // via wireSyncedContact's guards — keyless/local-bot rows stay inert). The
    // old "no lazy re-init path exists" note predates R4/#155's wireFullContact.
    let row = null;
    try {
      const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [contactId] });
      row = rows[0] || null;
    } catch {}
    if (managers && row) { try { await wireSyncedContact(managers, row); } catch {} }
    try { if (row) await emitContactChange("update", row); } catch {}
    return { redirect: "/dashboard/contacts" };
  }
```
`servers/gateway/dashboard/panels/messages/api-handlers.js`: same two rewrites keyed by `crow_id` (SELECT * by crow_id; `unwireContact(managers, row)` / `wireSyncedContact(managers, row)`; keep `res.redirectAfterPost("/dashboard/messages")` and the existing `emitContactChange` lines; the handler's existing `managers` variable already honors `_managers`). Add the two imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/block-handler-teardown.test.js tests/contacts-sync-panel-emit.test.js tests/message-request-actions.test.js tests/contacts-add-by-id-action.test.js`
Expected: ALL PASS (S7 block-follow emit behavior unregressed).

- [ ] **Step 5: Commit**

```bash
git add tests/block-handler-teardown.test.js
git commit tests/block-handler-teardown.test.js servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/panels/messages/api-handlers.js -m "fix(dashboard): block tears down the live subscription, unblock re-wires — both panels, no restart needed (F-BLOCK-1 D1/D2)"
git show --stat HEAD
```

---

### Task 5: Full suite, boot check, mutation-test evidence

**Files:** none (evidence to `.superpowers/sdd/progress.md` — git-IGNORED, never `git add`).

- [ ] **Step 1: Full suite** — `node --test tests/*.test.js 2>&1 | tail -6`. Expected: ≥ current baseline (1385+new / the 1 pre-existing bundle-contract fail / 1 skip).
- [ ] **Step 2: Boot check** — `timeout 25 node servers/gateway/index.js --no-auth 2>&1 | head -50`: boots clean, no new warnings.
- [ ] **Step 3: Mutations** (apply → run named test → RED → revert → `git status --short` clean):

| # | Mutation | Test that must go RED |
|---|---|---|
| M1 | nostr.js: remove the D4a fresh-check block | block-onevent-guard "blocked inbound must NOT store" |
| M2 | boot.js: remove the D4b early-return | block-receive-guards "blocked … must not store" |
| M3a | boot.js: remove the D4c guard line | block-receive-guards blocked-sender case |
| M3b | boot.js: flip D4c guard to `if (!senderRow) return;` | block-receive-guards "unknown sender still notifies" |
| M4 | boot.js: move the D4d early-return to just before `upsertFullContact` (after the ack branches) | block-rewire-guards "NO handshake ack … (placement)" |
| M5 | contact-promote.js: remove the wireFullContact belt guard | block-rewire-guards "refuses a blocked row" |
| M6 | contact-promote.js: revert the blocked branch to the old inline pair | block-rewire-guards "FULL teardown (incl. Nostr unsub)" |
| M7 | contacts/api-handlers.js: replace unwireContact call with the old inline pair (no unsub) | block-handler-teardown "block tears down the Nostr sub" |
| M8 | contacts/api-handlers.js: remove the unblock wireSyncedContact call | block-handler-teardown "unblock re-wires" |

- [ ] **Step 4: Append evidence to the progress ledger.**

---

## Post-implementation (controller, not subagents)

1. CDP scratch check: block a seeded contact via the real UI → conversation drops from the messages list, `is_blocked=1`; unblock → returns. (Live subscription behavior needs a real peer — next step.)
2. Final whole-branch Opus review → PR → Kevin gate.
3. Post-merge deploy fleet; live E2E crow↔black-swan: block Black Swan on crow via UI → DM from black-swan → NO new row on crow, unread unchanged, sender stays `relayed`; unblock → next DM arrives live. (Spec §5.)
