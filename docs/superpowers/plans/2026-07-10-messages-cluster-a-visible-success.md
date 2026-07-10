# Cluster A — "Make success visible" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six P4-walkthrough findings (F-UI-1/3/4/5/6/7 + two addenda) so every messaging action in the dashboard visibly succeeds or visibly fails.

**Architecture:** Server-side: un-Turbo the four invite forms (`data-turbo="false"`), redirect accept-success into the new conversation, extend the existing `/dashboard/streams/messages` SSE route with named events (`crow-msg`, `crow-receipt`), return message ids from the send route, add a guarded `retry_of` delete, consolidate the peer-messages query, and precompute the safety number. Client-side (`messages/client.js`): one new `EventSource` (player.js pattern), id-keyed bubble reconciliation, a Retry control on failed bubbles, legible delivery-state CSS, and safety-number rendering in the Info panel.

**Tech Stack:** Node 20 ESM, Express, better-sqlite3 via `db.execute`, vanilla client JS in template strings, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-07-10-messages-cluster-a-visible-success-design.md`

## Global Constraints

- **NEVER run `git commit --amend`** (shared working tree; a parallel bench session dirties `scripts/bench/**`).
- **Commit ONLY with explicit positional paths**: `git add <paths> && git commit <paths> -m "..."`. NEVER `git add -A` / `git add .`. Verify with `git show --stat HEAD` after every commit.
- Branch: `fix/messages-cluster-a-visible-success`. Do not touch `scripts/bench/**` or `.superpowers/**` (git-ignored ledgers — never `git add` them).
- Tests: Node built-in runner — `node --test tests/<file>.test.js`. Full-suite baseline **1329 pass / 0 fail / 1 skip** must hold at the end.
- i18n: every new user-facing string gets `en` AND `es` in `servers/gateway/dashboard/shared/i18n.js` (flat `"ns.key": { en, es }` map; `t()` for HTML, `tJs()` inside client JS template strings).
- Client DOM building uses the panel's `el()` helper / `textContent` — never `innerHTML` with interpolated data (XSS).
- SSE bodies built via `html\`\`` or reviewed `raw()` only (`servers/gateway/streams/turbo-stream.js` contract). Plain named-event JSON payloads must contain only server-derived numbers/ids, never user text.
- Every new regression guard added here must be **mutation-tested** (invert/remove the guard → the new test must fail; restore → pass). Record the mutation check in the task's commit message body.

---

### Task 1: `data-turbo="false"` on the five dead forms (F-UI-1)

**Files:**
- Modify: `servers/gateway/dashboard/shared/peer-invite-ui.js:57,61,115,119`
- Modify: `servers/gateway/dashboard/panels/contacts/html.js:119` (add_by_id form)
- Test: `tests/peer-invite-ui.test.js`, `tests/short-code-ui.test.js`, `tests/contacts-peer-add.test.js`

**Interfaces:**
- Produces: all four shared invite forms + the contacts add_by_id form open with `<form method="POST" data-turbo="false">`. Later tasks rely on classic full-page POSTs for these five actions.

**Why:** Turbo Drive discards non-redirect POST responses; these handlers deliberately answer 200 re-renders. `data-turbo="false"` makes the browser render them. CSRF hidden inputs are already present in every form; classic POSTs are explicitly supported (`layout.js:420` comment).

- [ ] **Step 1: Write the failing tests**

In `tests/peer-invite-ui.test.js`, add:

```js
test("invite forms opt out of Turbo Drive (F-UI-1: Turbo discards non-redirect POST responses)", () => {
  const { generateForm, acceptForm } = renderPeerInviteForms({ lang: "en", csrf: "" });
  assert.match(generateForm, /<form method="POST" data-turbo="false">/);
  assert.match(acceptForm, /<form method="POST" data-turbo="false">/);
});
```

In `tests/short-code-ui.test.js`, add:

```js
test("short-code forms opt out of Turbo Drive (F-UI-1)", () => {
  const { generateForm, acceptForm } = renderShortCodeForms({ lang: "en", csrf: "" });
  assert.match(generateForm, /<form method="POST" data-turbo="false">/);
  assert.match(acceptForm, /<form method="POST" data-turbo="false">/);
});
```

In `tests/contacts-peer-add.test.js`, add (renderContactList is already imported there):

```js
test("add_by_id form opts out of Turbo Drive (F-UI-1 addendum: silent add-by-id rejection)", () => {
  const html = renderContactList([], [], {}, "en", {});
  const addByIdIdx = html.indexOf('value="add_by_id"');
  assert.ok(addByIdIdx > -1);
  const formOpen = html.lastIndexOf("<form", addByIdIdx);
  const formTag = html.slice(formOpen, html.indexOf(">", formOpen) + 1);
  assert.match(formTag, /data-turbo="false"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/peer-invite-ui.test.js tests/short-code-ui.test.js tests/contacts-peer-add.test.js`
Expected: the three new tests FAIL (no `data-turbo` in output).

- [ ] **Step 3: Implement**

In `servers/gateway/dashboard/shared/peer-invite-ui.js`, change all four form openers (lines 57, 61, 115, 119) from `<form method="POST">` to:

```js
const generateForm = `<form method="POST" data-turbo="false">
```

(same for `acceptForm` in `renderPeerInviteForms`, and both forms in `renderShortCodeForms`). Add one comment above the first:

```js
  // data-turbo="false" (F-UI-1): these POSTs answer with a 200 re-render (the
  // invite result must never appear in a URL). Turbo Drive discards non-redirect
  // POST responses, so under Turbo the buttons were dead. Classic form POST
  // renders the response; the csrf hidden input keeps it CSRF-valid.
```

In `servers/gateway/dashboard/panels/contacts/html.js:119`, the add_by_id form opener becomes:

```js
    <form method="POST" data-turbo="false" style="margin-top:0.75rem;padding:1rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px">
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/peer-invite-ui.test.js tests/short-code-ui.test.js tests/contacts-peer-add.test.js`
Expected: PASS.

- [ ] **Step 5: Mutation check + commit**

Mutation check: revert ONE of the four attribute additions → the matching test fails; restore. Then:

```bash
git add servers/gateway/dashboard/shared/peer-invite-ui.js servers/gateway/dashboard/panels/contacts/html.js tests/peer-invite-ui.test.js tests/short-code-ui.test.js tests/contacts-peer-add.test.js
git commit servers/gateway/dashboard/shared/peer-invite-ui.js servers/gateway/dashboard/panels/contacts/html.js tests/peer-invite-ui.test.js tests/short-code-ui.test.js tests/contacts-peer-add.test.js -m "fix(dashboard): data-turbo=false on invite + add_by_id forms — Turbo was discarding their 200 re-renders (F-UI-1)"
git show --stat HEAD
```

---

### Task 2: Accept success lands in the conversation + toast/flash (F-UI-3)

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/api-handlers.js:126-147,171-191`
- Modify: `servers/gateway/dashboard/panels/contacts/api-handlers.js:162-175,194-206`
- Modify: `servers/gateway/dashboard/panels/contacts.js:30-48` (flash pass-through)
- Modify: `servers/gateway/dashboard/panels/contacts/html.js` (flash banner in `renderContactList`)
- Modify: `servers/gateway/dashboard/panels/messages/client.js:146-157` (connected toast)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (2 new keys)
- Test: `tests/messages-accept-feedback.test.js` (new), `tests/contacts-peer-add.test.js`

**Interfaces:**
- Consumes: `handlePostAction(req, res, { db, sharingClientFactory })` from messages api-handlers; `handleContactAction(req, db, sharingClientFactory?)` — check its actual signature at `panels/contacts/api-handlers.js` top and keep it.
- Produces: messages accept success → 303 to `/dashboard/messages?connected=1[&open=<contactId>]`; contacts accept success → 303 to `/dashboard/contacts?flash=peer_added`.

- [ ] **Step 1: Write the failing handler tests**

Create `tests/messages-accept-feedback.test.js` (copy the harness shape from `tests/messages-room-actions.test.js` — it imports `handlePostAction` directly and uses a `fakeRes` with `redirectAfterPost`):

```js
import { test } from "node:test";
import assert from "node:assert";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";

function fakeRes() {
  return { _r: null, headersSent: false, redirectAfterPost(p) { this._r = p; this.headersSent = true; return true; } };
}
// A stub db: accept-success path looks the contact row up by crow_id.
function fakeDb(rowsByCrowId = {}) {
  return {
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      if (/SELECT id FROM contacts WHERE crow_id/.test(sql)) {
        const crowId = q.args[0];
        return { rows: rowsByCrowId[crowId] ? [{ id: rowsByCrowId[crowId] }] : [] };
      }
      return { rows: [] };
    },
  };
}
const okAccept = (text) => async () => ({
  callTool: async () => ({ content: [{ type: "text", text }] }),
  close: async () => {},
});

test("accept_invite success redirects into the new conversation (F-UI-3)", async () => {
  const res = fakeRes();
  const req = {
    method: "POST",
    body: { action: "accept_invite", invite_code: "crow:abcdefghij.payload.sig" },
  };
  const db = fakeDb({ "crow:abcdefghij": 42 });
  await handlePostAction(req, res, { db, sharingClientFactory: okAccept("Connected to crow:abcdefghij!\nCrow ID: crow:abcdefghij") });
  assert.match(res._r, /^\/dashboard\/messages\?connected=1&open=42$/);
});

test("accept_invite success without a resolvable contact still signals success", async () => {
  const res = fakeRes();
  const req = { method: "POST", body: { action: "accept_invite", invite_code: "crow:abcdefghij.p.s" } };
  await handlePostAction(req, res, { db: fakeDb({}), sharingClientFactory: okAccept("Connected!") });
  assert.match(res._r, /^\/dashboard\/messages\?connected=1$/);
});

test("accept_short_invite success resolves the contact from the tool text", async () => {
  const res = fakeRes();
  const req = { method: "POST", body: { action: "accept_short_invite", short_code: "K7Q4-M2X9-3FHT" } };
  const db = fakeDb({ "crow:qrstuvwxyz": 7 });
  await handlePostAction(req, res, { db, sharingClientFactory: okAccept("Connected to crow:qrstuvwxyz!\nCrow ID: crow:qrstuvwxyz\nSafety Number: 1") });
  assert.match(res._r, /^\/dashboard\/messages\?connected=1&open=7$/);
});

test("accept_invite ERROR path still re-renders (returns false, no redirect)", async () => {
  const res = fakeRes();
  const req = { method: "POST", body: { action: "accept_invite", invite_code: "crow:abcdefghij.p.s" } };
  const errFactory = async () => ({
    callTool: async () => ({ isError: true, content: [{ type: "text", text: "expired" }] }),
    close: async () => {},
  });
  const handled = await handlePostAction(req, res, { db: fakeDb({}), sharingClientFactory: errFactory });
  assert.equal(handled, false);
  assert.equal(res._r, null);
  assert.match(req._inviteError, /expired/);
});
```

Note for the implementer: `handlePostAction`'s real signature is `(req, res, { db, sharingClientFactory, _managers })` — confirm at `api-handlers.js:~25` and match the stub. If `extractInviteCode` rejects the fake code shape, use a syntactically valid one (`CODE_RE` is `/crow:[a-z0-9]{10}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/`).

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/messages-accept-feedback.test.js`
Expected: FAIL (`res._r` is `/dashboard/messages`).

- [ ] **Step 3: Implement the messages handlers**

In `servers/gateway/dashboard/panels/messages/api-handlers.js`, add one helper near the top (after imports):

```js
/**
 * F-UI-3: resolve the just-accepted peer's contact row id so the accept
 * redirect can land INSIDE the new conversation. The invite code's first
 * segment is the inviter's crow id; the short-code path finds it in the
 * tool's success text ("Crow ID: crow:…"). Never throws — a resolution
 * failure just means we fall back to a plain success signal.
 */
async function resolveAcceptedContactId(db, ...texts) {
  try {
    for (const t of texts) {
      const m = String(t || "").match(/crow:[a-z0-9]{10}/);
      if (!m) continue;
      const { rows } = await db.execute({
        sql: "SELECT id FROM contacts WHERE crow_id = ?",
        args: [m[0]],
      });
      if (rows[0]) return Number(rows[0].id);
    }
  } catch { /* fall through */ }
  return null;
}
```

Then change the two success returns. **SCOPE WARNING (R1-C2):** in the CURRENT code, `code` and `result` are declared INSIDE the `try` blocks (`api-handlers.js:128,130` and `:174`), but the success `return` sits AFTER the try/catch — they are **out of scope** there. You MUST hoist the declarations above the `try` and assign inside it, keeping `extractInviteCode()` itself inside the `try` (it can throw on malformed input):

`accept_invite` — restructure to:

```js
  if (action === "accept_invite" && req.body.invite_code) {
    let code;
    let result;
    try {
      code = extractInviteCode(req.body.invite_code);
      const client = await sharingClientFactory();
      try {
        result = await client.callTool({
          name: "crow_accept_invite",
          arguments: { invite_code: code },
        });
      } finally { try { await client.close?.(); } catch {} }
      if (result?.isError) {
        req._inviteError = result.content?.[0]?.text || "Invite could not be accepted.";
        return false; // re-render with the error banner
      }
    } catch (err) {
      console.error("[messages] Failed to accept invite"); // never echo the code
      req._inviteError = err.message;
      return false;
    }
    const openId = await resolveAcceptedContactId(db, code, result?.content?.[0]?.text);
    return res.redirectAfterPost(
      "/dashboard/messages?connected=1" + (openId ? `&open=${openId}` : ""),
    );
  }
```

`accept_short_invite` — same restructure: `let result;` above its `try`, assignment inside, error paths byte-identical, then:

```js
    const openId = await resolveAcceptedContactId(db, result?.content?.[0]?.text);
    return res.redirectAfterPost(
      "/dashboard/messages?connected=1" + (openId ? `&open=${openId}` : ""),
    );
```

- [ ] **Step 4: Contacts handlers + flash banner**

`servers/gateway/dashboard/panels/contacts/api-handlers.js` — the two accept success returns (lines 174, 205) become:

```js
    return { redirect: "/dashboard/contacts?flash=peer_added" };
```

`servers/gateway/dashboard/panels/contacts.js` — after line 49 (`peerAdd.csrf = csrfInput(req);`) add:

```js
    // F-UI-3: whitelisted post-redirect success flash (?flash=peer_added).
    if (req.query.flash === "peer_added") peerAdd.flash = t("contacts.peerAddedFlash", lang);
```

`servers/gateway/dashboard/panels/contacts/html.js` — in `renderContactList`'s peer-add section (around line 132-136): keep the `<details ... open>` trigger list and add `peerAdd.flash` to it, and render the flash above the error line:

```js
  const peerAddSection = `<details class="contacts-add-peer" style="margin-bottom:1rem"${peerAdd.inviteShare || peerAdd.inviteError || peerAdd.shortCodeShare || peerAdd.flash ? " open" : ""}>
    <summary style="cursor:pointer;font-size:0.85rem;color:var(--crow-accent);font-weight:500">${t("contacts.addPeer", lang)}</summary>
    <div style="margin-top:0.75rem;padding:1rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px">
      <p style="font-size:0.8rem;color:var(--crow-text-muted);margin:0 0 0.75rem">${t("contacts.addPeerDesc", lang)}</p>
      ${peerAdd.flash ? `<div style="font-size:0.85rem;color:var(--crow-success,#10b981);font-weight:600;margin-bottom:0.5rem">${escapeHtml(peerAdd.flash)}</div>` : ""}
      ${peerAdd.inviteError ? `...unchanged...` : ""}
```

(only the two shown lines change; everything else stays.)

- [ ] **Step 5: Client toast on `?connected=1`**

In `servers/gateway/dashboard/panels/messages/client.js`, inside the existing `__msgOpenHookBound` block (after the `openRoom` handling, line ~156), add:

```js
    if (params.get('connected') === '1') {
      // COUPLING NOTE (R2-M2): this lives inside the window-level
      // __msgOpenHookBound once-guard, which only re-arms on a full page load.
      // It works for every accept because the accept forms are
      // data-turbo="false" (Task 1) → the 303 lands as a real page load. If
      // those forms are ever re-Turbo'd, the second accept's toast silently
      // breaks — keep the two together.
      setTimeout(function () {
        try { if (window.crowToast) window.crowToast('${tJs("messages.connectedToast", lang)}'); } catch (e) {}
      }, 200);
      // Strip the one-shot params so a refresh/Turbo revisit doesn't re-toast.
      try {
        params.delete('connected');
        var qs = params.toString();
        window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
      } catch (e) {}
    }
```

(Note: keep `open` in the URL until after `msgSelectItem` has been scheduled — the setTimeout at line 151 captures `openId` beforehand, so deleting only `connected` is safe.)

- [ ] **Step 6: i18n keys**

In `servers/gateway/dashboard/shared/i18n.js`, next to the other `messages.*` keys:

```js
  "messages.connectedToast": { en: "Connected — you can start chatting.", es: "Conectado — ya puedes chatear." },
  "contacts.peerAddedFlash": { en: "Peer connected ✓", es: "Contacto conectado ✓" },
```

- [ ] **Step 7: Contacts flash test**

Add to `tests/contacts-peer-add.test.js`:

```js
test("peer_added flash renders as a success banner and opens the section (F-UI-3)", () => {
  const html = renderContactList([], [], {}, "en", { flash: "Peer connected ✓" });
  assert.match(html, /Peer connected ✓/);
  const detailsIdx = html.indexOf('class="contacts-add-peer"');
  const detailsTag = html.slice(html.lastIndexOf("<details", detailsIdx), html.indexOf(">", detailsIdx) + 1);
  assert.match(detailsTag, / open/);
});
```

- [ ] **Step 8: Run all touched tests**

Run: `node --test tests/messages-accept-feedback.test.js tests/contacts-peer-add.test.js tests/messages-room-actions.test.js tests/message-request-actions.test.js`
Expected: ALL PASS (room/request tests guard the dispatcher against regressions).

- [ ] **Step 9: Commit**

```bash
git add servers/gateway/dashboard/panels/messages/api-handlers.js servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/panels/contacts.js servers/gateway/dashboard/panels/contacts/html.js servers/gateway/dashboard/panels/messages/client.js servers/gateway/dashboard/shared/i18n.js tests/messages-accept-feedback.test.js tests/contacts-peer-add.test.js
git commit servers/gateway/dashboard/panels/messages/api-handlers.js servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/panels/contacts.js servers/gateway/dashboard/panels/contacts/html.js servers/gateway/dashboard/panels/messages/client.js servers/gateway/dashboard/shared/i18n.js tests/messages-accept-feedback.test.js tests/contacts-peer-add.test.js -m "feat(messages): accept success lands in the new conversation with visible feedback (F-UI-3)"
git show --stat HEAD
```

---

### Task 3: Send route returns ids + guarded `retry_of` delete (F-UI-5/7 server)

**Files:**
- Modify: `servers/gateway/routes/peer-messages.js:43-116` (`handlePeerSend`)
- Test: `tests/message-send-feedback.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `handlePeerSend` success response `{ ok: true, id: <number|null>, nostr_event_id: <string|null>, delivery_status: <string|null> }`; failure response `{ ok: false, error, id: <number|null> }` (the id of the just-written failed row). Accepts optional `req.body.retry_of` (int): on SUCCESS, deletes the referenced row iff `id = retry_of AND contact_id = :contactId AND direction = 'sent' AND delivery_status = 'failed'`. Task 6's client consumes all of this.

- [ ] **Step 1: Write the failing tests**

Extend `tests/message-send-feedback.test.js`. It uses a **real libsql DB** (`freshLibsql()` runs `scripts/init-db.js` into a tmpdir) plus a stub `sharingClientFactory` — reuse `freshLibsql`, `mkContact`, and its `fakeRes` shape (grep the file for how the existing route-level tests build `req`/`res`). The stub tool must mimic `sendMessage`'s side effect (it INSERTs the message row before the route reads it back):

```js
// Stub factory that mimics sendMessage's row write, then answers ok/isError.
function stubSendFactory(db, contactId, { fail = false } = {}) {
  return async () => ({
    callTool: async () => {
      await db.execute({
        sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, nostr_event_id, created_at)
              VALUES (?, ?, 'sent', ?, ?, datetime('now'))`,
        args: [contactId, "hi", fail ? "failed" : "relayed", fail ? null : "evt-abc"],
      });
      return fail
        ? { isError: true, content: [{ type: "text", text: "reached 0 relays" }] }
        : { content: [{ type: "text", text: "Message sent to 3 relay(s)" }] };
    },
    close: async () => {},
  });
}

test("send success returns the new row id + delivery_status (F-UI-5)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:idreturn", name: "R" });
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi" } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactId) },
    );
    assert.equal(res.body.ok, true);
    assert.ok(Number.isInteger(res.body.id));
    assert.equal(res.body.delivery_status, "relayed");
    assert.equal(res.body.nostr_event_id, "evt-abc");
  } finally { cleanup(); }
});

test("send failure (0 relays) returns the failed row id so the client can retry it (F-UI-7)", async () => {
  // stubSendFactory(..., { fail: true }) → expect status 502, body.ok false,
  // body.id = the failed row's real id (SELECT it to compare).
});

test("retry_of deletes the old failed row on success — guarded (F-UI-7)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:retryok", name: "R" });
    // Seed the OLD failed row this retry replaces.
    const seed = await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status, created_at)
            VALUES (?, 'hi', 'sent', 'failed', datetime('now'))`,
      args: [contactId],
    });
    const failedId = Number(seed.lastInsertRowid);
    const res = fakeJsonRes();
    await handlePeerSend(
      { params: { contactId: String(contactId) }, body: { message: "hi", retry_of: String(failedId) } },
      res,
      { db, sharingClientFactory: stubSendFactory(db, contactId) },
    );
    assert.equal(res.body.ok, true);
    const { rows } = await db.execute({ sql: "SELECT id FROM messages WHERE id = ?", args: [failedId] });
    assert.equal(rows.length, 0, "old failed row deleted");
  } finally { cleanup(); }
});

// Guard tests (each seeds a row the delete must NOT touch, asserts it survives):
test("retry_of does NOT delete a row belonging to another contact", async () => { /* seed failed row on contact B, retry on contact A with B's row id → row survives */ });
test("retry_of does NOT delete a non-failed row", async () => { /* seed delivery_status='relayed' row → survives */ });
test("retry_of does NOT delete a received row", async () => { /* seed direction='received', delivery_status='failed' → survives */ });
test("retry_of is IGNORED when the send itself fails", async () => { /* fail:true stub + retry_of → seeded failed row survives */ });
test("non-digit retry_of is ignored", async () => { /* retry_of: "55x" → seeded row 55-adjacent survives; strict /^\d+$/ gate, parseInt would accept "55x" */ });
```

Add a small `fakeJsonRes()` helper if the file lacks one:

```js
function fakeJsonRes() {
  return {
    statusCode: 200, body: null, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
  };
}
```

The guard-test skeletons marked `/* ... */` must be written out in full — same harness, one seeded row + one assertion each.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/message-send-feedback.test.js`
Expected: new tests FAIL (`body.id` undefined; no DELETE).

- [ ] **Step 3: Implement**

In `handlePeerSend`:

(a) Add a read-back helper used by both outcomes — insert after the `resultText` computation (line ~80):

```js
  // Read back the row sendMessage just wrote (success → relayed/…, 0-relay →
  // failed) so the client can key its optimistic bubble to the real row
  // (F-UI-5 dedup) and retry a failed one (F-UI-7). Latest-sent-row read-back
  // matches the existing attachments logic; a cross-tab race grabbing a
  // sibling's row is acceptable for UI reconciliation (same trade the
  // attachments path already makes).
  async function latestSentRow() {
    try {
      const { rows } = await db.execute({
        sql: `SELECT id, nostr_event_id, delivery_status FROM messages
              WHERE contact_id = ? AND direction = 'sent'
              ORDER BY id DESC LIMIT 1`,
        args: [contactId],
      });
      return rows[0] || null;
    } catch { return null; }
  }
```

(b) The failure return (line 81-84) becomes:

```js
  if (toolResult?.isError) {
    // Delivery failed (e.g. reached 0 relays). Do NOT report success. Include
    // the failed row's id so the client can offer Retry on the exact row.
    const failedRow = await latestSentRow();
    return res.status(502).json({
      ok: false,
      error: resultText || "Message could not be delivered.",
      id: failedRow && failedRow.delivery_status === "failed" ? Number(failedRow.id) : null,
    });
  }
```

(c) After the attachments block, before `res.json({ ok: true })` (line 115):

```js
  const sentRow = await latestSentRow();

  // F-UI-7: a successful retry replaces the old failed bubble — delete the
  // referenced row ONLY if it is this contact's own failed sent message.
  // Strict digit gate: parseInt would accept "55x".
  const retryOfRaw = req.body?.retry_of;
  if (typeof retryOfRaw === "string" ? /^\d+$/.test(retryOfRaw) : Number.isInteger(retryOfRaw)) {
    const retryOf = Number(retryOfRaw);
    await db.execute({
      sql: `DELETE FROM messages WHERE id = ? AND contact_id = ? AND direction = 'sent' AND delivery_status = 'failed'`,
      args: [retryOf, contactId],
    });
  }

  res.json({
    ok: true,
    id: sentRow ? Number(sentRow.id) : null,
    nostr_event_id: sentRow ? sentRow.nostr_event_id : null,
    delivery_status: sentRow ? sentRow.delivery_status : null,
  });
```

NOTE: call `latestSentRow()` BEFORE the retry_of delete (the new row has a higher id than `retry_of`, so order doesn't change the result, but keep it explicit). The attachments block already queries the latest sent row — refactor it to reuse `sentRow` (`const msgId = sentRow && sentRow.id;`) so there is one read-back.

- [ ] **Step 4: Run tests**

Run: `node --test tests/message-send-feedback.test.js tests/message-delivery-status.test.js`
Expected: PASS.

- [ ] **Step 5: Mutation-test the retry_of guard**

Temporarily remove `AND delivery_status = 'failed'` from the DELETE → the "guarded" test must fail (its stub asserts the exact SQL). Also flip the success-only placement (move the delete above the isError return) → the "IGNORED on a failed send" test must fail. Restore both, re-run, record in the commit body.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/routes/peer-messages.js tests/message-send-feedback.test.js
git commit servers/gateway/routes/peer-messages.js tests/message-send-feedback.test.js -m "feat(messages): send route returns row ids; guarded retry_of replaces a failed row (F-UI-5/7)

Mutation-tested: dropping the delivery_status='failed' guard or moving the
delete above the isError return reddens the new tests."
git show --stat HEAD
```

---

### Task 4: Live named events on the messages stream (F-UI-4/6 server)

**Files:**
- Modify: `servers/gateway/routes/streams.js:78-104`
- Modify: `servers/sharing/boot.js:246-266` (`handleDeliveryReceipt`)
- Test: `tests/messages-stream-events.test.js` (new), `tests/messages-sync.test.js` (must stay green)

**Interfaces:**
- Consumes: `bus` singleton (`servers/shared/event-bus.js`); existing `messages:changed` emits (`sharing/nostr.js:511`, `sharing/instance-sync.js:1537`).
- Produces: SSE named events on `/dashboard/streams/messages`: `event: crow-msg` / `data: {"contactId":N,"unread":N}` per `messages:changed`; `event: crow-receipt` / `data: {"contactId":N,"ids":[...]}` per new bus event `messages:receipt`. New bus emit `bus.emit("messages:receipt", { contactId, ids })` from `handleDeliveryReceipt`. Task 6's client consumes both.

- [ ] **Step 1: Write the failing tests**

Create `tests/messages-stream-events.test.js`. Model on how `tests/messages-sync.test.js` drives the bus, plus a fake `sendRaw` capture. The stream handler closes over `openAuthedStream` — test at the route level by extracting the handler? No: the route registers on `bus` inside the request handler. Simplest robust approach: import the router factory, mount it on a stub express-like object, invoke the `/dashboard/streams/messages` handler with a fake `req`/`res` whose `openAuthedStream` path works. Look at how `tests/sse-cap.test.js` fakes SSE responses and reuse that harness. Assert:

```js
test("messages stream emits a crow-msg named event per messages:changed (F-UI-4)", async () => {
  // invoke handler with fake res; capture written chunks
  bus.emit("messages:changed", { contactId: 3, unread: 2 });
  const out = chunks.join("");
  assert.match(out, /event: crow-msg\ndata: \{"contactId":3,"unread":2\}\n\n/);
  // the badge turbo-stream frame is UNCHANGED and still present
  assert.match(out, /badge-peer-3/);
});

test("messages stream forwards messages:receipt as crow-receipt (F-UI-6 live tick)", async () => {
  bus.emit("messages:receipt", { contactId: 3, ids: [12, 13] });
  const out = chunks.join("");
  assert.match(out, /event: crow-receipt\ndata: \{"contactId":3,"ids":\[12,13\]\}\n\n/);
});

test("handleDeliveryReceipt emits messages:receipt with the local row ids", async () => {
  // stub db: UPDATE ok; SELECT id FROM messages ... → [{id:12},{id:13}]
  // findContactByPubkey path: seed a contact row per the existing
  // delivery-receipt tests (see tests/ for the R5 receipt test harness — reuse it).
  let got = null;
  bus.once("messages:receipt", (p) => { got = p; });
  await handleDeliveryReceipt(db, ["evt1", "evt2"], senderPubkey);
  assert.deepEqual(got, { contactId: <id>, ids: [12, 13] });
});

test("handleDeliveryReceipt does NOT emit messages:changed (badge-blanking guard)", async () => {
  let changed = false;
  const h = () => { changed = true; };
  bus.on("messages:changed", h);
  await handleDeliveryReceipt(db, ["evt1"], senderPubkey);
  bus.off("messages:changed", h);
  assert.equal(changed, false);
});
```

(Find the existing R5 receipt test file — grep `handleDeliveryReceipt` under `tests/` — and reuse its db/contact stubs verbatim.)

R1-M4 + R2-I2: the sse-cap.test.js harness does NOT transfer — it drives `openStream` directly, while this route goes through `openAuthedStream`. Build a fake `res` satisfying `openStream`'s full surface (`headersSent`, `writeHead`, `flushHeaders`, `write`, `writableEnded`, `on`, `end` — see `streams/sse.js:36-94`) plus `req.dashboardSession`, and extract the route handler from the router factory. There are **two** leaked timers per stream: `openStream`'s 30s heartbeat (`sse.js:75`) AND `openAuthedStream`'s 5-min session recheck (`authed-stream.js:47`). Every stream test MUST fire the captured `res` `'close'` listeners at the end to clear BOTH, or the runner hangs/flakes (the recheck would eventually call `verifySession` against a real DB).

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/messages-stream-events.test.js`
Expected: FAIL (no named events emitted).

- [ ] **Step 3: Implement streams.js**

In the `/dashboard/streams/messages` handler, extend the existing `handler` and add a receipt listener:

```js
    const handler = (payload) => {
      try {
        const contactId = payload?.contactId;
        if (contactId == null) return;
        const unread = Number(payload?.unread ?? 0);
        const unreadClass = unread > 0 ? "msg-unread-badge visible" : "msg-unread-badge";
        const display = unread > 0 ? String(unread) : "";
        sseTurbo(
          sendRaw,
          "replace",
          `badge-peer-${contactId}`,
          html`<span id="badge-peer-${contactId}" class="${unreadClass}" data-badge-peer="${contactId}">${display}</span>`,
        );
        // F-UI-4: named event for the panel's own EventSource (client.js).
        // Named events are invisible to <turbo-stream-source> (it only
        // consumes default "message" events), so badge behavior above is
        // untouched. Payload is server-derived numbers only.
        sendRaw(`event: crow-msg\ndata: ${JSON.stringify({ contactId: Number(contactId), unread })}\n\n`);
      } catch {
        // Subscriber isolation.
      }
    };

    // F-UI-6: delivery receipts flip ✓→✓✓ live in an open conversation. A
    // SEPARATE bus event from messages:changed — that consumer contract is
    // badge-only and reads payload.unread (see boot.js handleDeliveryReceipt).
    const receiptHandler = (payload) => {
      try {
        const contactId = payload?.contactId;
        if (contactId == null) return;
        const ids = (Array.isArray(payload?.ids) ? payload.ids : [])
          .map(Number)
          .filter(Number.isFinite);
        sendRaw(`event: crow-receipt\ndata: ${JSON.stringify({ contactId: Number(contactId), ids })}\n\n`);
      } catch {
        // Subscriber isolation.
      }
    };

    bus.on("messages:changed", handler);
    bus.on("messages:receipt", receiptHandler);
    res.on("close", () => { bus.off("messages:changed", handler); bus.off("messages:receipt", receiptHandler); });
    res.on("error", () => { bus.off("messages:changed", handler); bus.off("messages:receipt", receiptHandler); });
```

Also update the route's doc comment: badge-only is no longer true — describe the two named events.

- [ ] **Step 4: Implement the boot.js emit**

`servers/sharing/boot.js` — add the bus import (boot.js has none today). R2-I1: `servers/shared/event-bus.js` has ONLY a **default** export (`export default bus`, line 34) — `import { bus }` is an ESM load-time SyntaxError that takes down the whole sharing runtime via server.js. Use the same form nostr.js:27 uses:

```js
import bus from "../shared/event-bus.js";
```

In `handleDeliveryReceipt`, REPLACE the "No bus emit" comment block (lines 259-262) with:

```js
    // F-UI-6: nudge any open dashboard conversation to flip ✓→✓✓ live. This is
    // a SEPARATE event from messages:changed — that consumer is badge-only and
    // reads payload.unread (emitting it here would blank the peer's unread
    // badge). Payload carries the LOCAL row ids the UPDATE just touched.
    try {
      const { rows } = await db.execute({
        sql: `SELECT id FROM messages
              WHERE direction = 'sent' AND contact_id = ? AND nostr_event_id IN (${placeholders})`,
        args: [contact.id, ...ids],
      });
      if (rows.length > 0) {
        bus.emit("messages:receipt", { contactId: Number(contact.id), ids: rows.map((r) => Number(r.id)) });
      }
    } catch { /* live-tick nudge is best-effort */ }
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/messages-stream-events.test.js tests/messages-sync.test.js`
Expected: PASS (messages-sync's badge contract untouched).

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/routes/streams.js servers/sharing/boot.js tests/messages-stream-events.test.js
git commit servers/gateway/routes/streams.js servers/sharing/boot.js tests/messages-stream-events.test.js -m "feat(messages): crow-msg + crow-receipt named SSE events for live conversation updates (F-UI-4/6)"
git show --stat HEAD
```

---

### Task 5: Peer GET route — one query owner, delivery_status on reload, safety number (F-UI-6 server)

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/data-queries.js:164-181` (`getPeerMessages`)
- Modify: `servers/gateway/routes/peer-messages.js:126-183` (GET handler)
- Test: `tests/message-delivery-render.test.js`, `tests/messages-peer-route.test.js` (new)

**Interfaces:**
- Consumes: `computeSafetyNumber`, `loadOrCreateIdentity` from `servers/sharing/identity.js`.
- Produces: `getPeerMessages(db, contactId, { limit, offset, afterId })` — afterId>0 → ascending rows with id > afterId (no reverse); else the current descending-window-then-reverse. Every row includes `delivery_status` and `last_seen`. GET response `contact` object gains `safety_number` (string|null). Task 6/7 client consumes `delivery_status` on reload and `contact.safety_number`.

- [ ] **Step 1: Write the failing tests**

In `tests/message-delivery-render.test.js` (it already tests `getPeerMessages`), add:

```js
test("getPeerMessages afterId variant returns ascending new rows incl. delivery_status", async () => {
  // stub db capturing sql/args; assert:
  //  - sql matches /WHERE m\.contact_id = \? AND m\.id > \?/ and /ORDER BY m\.id ASC/
  //  - sql includes m.delivery_status and c.last_seen
  //  - rows are NOT reversed for afterId
});
```

Create `tests/messages-peer-route.test.js` — drive the GET handler. The route builds its own `createDbClient`, so test the extracted pieces instead: import `getPeerMessages` for query shape, and test safety-number attachment via a small exported helper. To keep the route testable, extract in `peer-messages.js`:

```js
// R1-I1: loadOrCreateIdentity() does a sync disk read + full keypair
// re-derivation (identity.js:119-133) — far too heavy for the per-message
// afterId hot path. Cache my ed25519 pubkey once per process (it cannot
// change without a restart).
let _myEd25519 = null;
async function myEd25519Pubkey() {
  // R2-M1: cache ON SUCCESS only — a transient load failure must not disable
  // safety numbers for the rest of the process lifetime.
  if (_myEd25519) return _myEd25519;
  try {
    const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
    const ed = loadOrCreateIdentity().ed25519Pubkey || "";
    if (ed) _myEd25519 = ed;
    return ed;
  } catch {
    return "";
  }
}

/**
 * F-UI-6: attach the symmetric safety number to the contact payload so the
 * Messages Info panel can show the SAME trust string the Contacts detail
 * shows (raw peer pubkeys are asymmetric and read as "numbers don't match").
 * Never throws; omits the field (null) when either key is unavailable.
 */
export async function withSafetyNumber(contact) {
  if (!contact || !contact.ed25519_pubkey) return contact ? { ...contact, safety_number: null } : null;
  try {
    const myEd = await myEd25519Pubkey();
    if (!myEd) return { ...contact, safety_number: null };
    const { computeSafetyNumber } = await import("../../sharing/identity.js");
    return { ...contact, safety_number: computeSafetyNumber(myEd, contact.ed25519_pubkey) };
  } catch {
    return { ...contact, safety_number: null };
  }
}
```

Test: `withSafetyNumber(null)` → null; contact without ed25519 → `safety_number: null`; with a real identity available (loadOrCreateIdentity works in the repo test env — check how `tests/contacts-trust-ui.test.js` handles identity; if it stubs, stub the same way, e.g. pass the compute through and assert the 8×5-digit format `/^\d{5}( \d{5}){7}$/`).

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/message-delivery-render.test.js tests/messages-peer-route.test.js`
Expected: new tests FAIL.

- [ ] **Step 3: Implement data-queries.js**

```js
/**
 * Get peer messages for a specific contact. One query owner for the live
 * route AND the panel (F-UI-6: the route's private copy dropped
 * delivery_status, so receipts vanished on reload).
 *  - afterId > 0: ascending rows with id > afterId (poll/live incremental).
 *  - else: latest window (descending LIMIT/OFFSET), returned oldest-first.
 */
export async function getPeerMessages(db, contactId, { limit = 50, offset = 0, afterId = 0 } = {}) {
  const cols = `m.id, m.content, m.direction, m.is_read, m.created_at,
                m.thread_id, m.nostr_event_id, m.attachments, m.delivery_status,
                c.display_name, c.crow_id, c.last_seen`;
  let rows;
  if (afterId > 0) {
    ({ rows } = await db.execute({
      sql: `SELECT ${cols} FROM messages m
            LEFT JOIN contacts c ON m.contact_id = c.id
            WHERE m.contact_id = ? AND m.id > ?
            ORDER BY m.id ASC
            LIMIT ?`,
      args: [contactId, afterId, limit],
    }));
  } else {
    ({ rows } = await db.execute({
      sql: `SELECT ${cols} FROM messages m
            LEFT JOIN contacts c ON m.contact_id = c.id
            WHERE m.contact_id = ?
            ORDER BY m.id DESC
            LIMIT ? OFFSET ?`,
      args: [contactId, limit, offset],
    }));
    rows = rows.reverse();
  }
  return rows.map((m) => ({
    ...m,
    attachments: m.attachments ? JSON.parse(m.attachments) : null,
  }));
}
```

- [ ] **Step 4: Implement the route**

`peer-messages.js` GET handler: delete the inline sql/args blocks (lines 136-172) and use:

```js
      const { getPeerMessages } = await import("../dashboard/panels/messages/data-queries.js");
      const messages = await getPeerMessages(db, contactId, { limit, offset, afterId });

      const { rows: contactRows } = await db.execute({
        sql: `SELECT id, crow_id, display_name, ed25519_pubkey, is_blocked, last_seen, created_at, verified
              FROM contacts WHERE id = ?`,
        args: [contactId],
      });

      res.json({
        // R1-I1: compute the safety number only on the initial load — the
        // afterId incremental fetches (SSE nudge / poll) don't render the Info
        // panel and must stay light.
        contact: afterId > 0 ? (contactRows[0] || null) : await withSafetyNumber(contactRows[0] || null),
        messages,
      });
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/message-delivery-render.test.js tests/messages-peer-route.test.js tests/message-send-feedback.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/dashboard/panels/messages/data-queries.js servers/gateway/routes/peer-messages.js tests/message-delivery-render.test.js tests/messages-peer-route.test.js
git commit servers/gateway/dashboard/panels/messages/data-queries.js servers/gateway/routes/peer-messages.js tests/message-delivery-render.test.js tests/messages-peer-route.test.js -m "fix(messages): one peer-messages query owner — delivery_status survives reload; safety number in peer API (F-UI-6)"
git show --stat HEAD
```

---

### Task 6: Client — live updates, id reconciliation, Retry (F-UI-4/5/7 client)

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/client.js` (sendPeerMessage ~672-723; appendBubble ~1058-1188; markBubbleFailed ~1193-1210; polling ~1416-1495; new `startMessagesStream`, `fetchNewPeerMessages`, `flipBubbleDelivered`, `retryFailedMessage`)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (1 key)
- Test: `tests/messages-client-live.test.js` (new — string/extraction assertions on the built client JS, following `tests/message-delivery-render.test.js`'s extraction pattern)

**Interfaces:**
- Consumes: Task 3's send response `{ ok, id, nostr_event_id, delivery_status }` / `{ ok:false, error, id }` + `retry_of` param; Task 4's `crow-msg` / `crow-receipt` named events; Task 5's `afterId` rows with `delivery_status`.
- Produces: browser behavior only.

- [ ] **Step 1: Write failing extraction tests**

Create `tests/messages-client-live.test.js`. Import the client-JS builder the same way `tests/message-delivery-render.test.js` does (read that file first and copy its setup). Assert on the BUILT string:

```js
test("client opens a messages EventSource with crow-msg + crow-receipt + session-expired handlers (F-UI-4)", () => {
  assert.match(js, /new EventSource\('\/dashboard\/streams\/messages'\)/);
  assert.match(js, /addEventListener\('crow-msg'/);
  assert.match(js, /addEventListener\('crow-receipt'/);
  assert.match(js, /addEventListener\('session-expired'/);
});

test("append paths dedupe by data-msg-id (F-UI-5)", () => {
  assert.match(js, /data-msg-id="' \+ /); // dedup querySelector present
});

test("optimistic bubble is stamped with the server row id (F-UI-5)", () => {
  assert.match(js, /sentBubble\.dataset\.msgId = body\.id/);
});

test("failed bubbles get a Retry control (F-UI-7)", () => {
  assert.match(js, /msg-retry-btn/);
  assert.match(js, /retry_of/);
});

test("empty-conversation live arrival APPENDS — it must NOT rebuild the chat UI (R2-C1 draft preservation)", () => {
  // fetchNewPeerMessages handles the empty case by fetching WITHOUT afterId
  // and appending; calling loadPeerConversation there would wipe the composer.
  const fn = extractFunction(js, "fetchNewPeerMessages"); // brace-matching helper from message-delivery-render.test.js
  assert.ok(!/loadPeerConversation/.test(fn), "empty branch must not reload the whole conversation");
  assert.match(fn, /lastId \? '\?afterId=' \+ lastId : ''/);
});
```

Where the existing test file does real DOM-shim execution of `appendBubble`, ADD a behavioral dedup test there too:

```js
test("appendBubble is idempotent per data-msg-id via the fetch loop guard", ...);
```

(if the harness can execute `fetchNewPeerMessages` with a fetch stub, prefer the behavioral test; otherwise the string assertions above are the regression guard and the CDP task provides the behavioral evidence.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/messages-client-live.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement — shared incremental fetch with dedup**

In `client.js`, add above `startPolling()`:

```js
  // === Live updates (F-UI-4) ===
  // Incremental fetch shared by the SSE nudge and the fallback poll. Dedup is
  // id-keyed against the DOM so an optimistic bubble (stamped in
  // sendPeerMessage) or a racing poll/live append can never double-render
  // (F-UI-5).
  async function fetchNewPeerMessages() {
    if (!_activeItem || _activeItem.type !== 'peer') return;
    // Empty conversation (first message — the walkthrough's exact repro): fetch
    // the initial window (no afterId) and APPEND into the already-rendered
    // empty viewport. NEVER call loadPeerConversation here — it rebuilds the
    // whole chat UI including the composer and would wipe an in-progress
    // draft (R2-C1: accept lands the user in an empty conversation to type
    // their first message; a nudge/poll must not eat it).
    var lastId = _messages.length > 0 ? _messages[_messages.length - 1].id : 0;
    if (_messages.length > 0 && !lastId) return;
    try {
      var nr = await fetch('/api/messages/peer/' + encodeURIComponent(_activeItem.id) + (lastId ? '?afterId=' + lastId : ''));
      var nd = await nr.json();
      if (!nd.messages || nd.messages.length === 0) return;
      var viewport = document.getElementById('msg-viewport');
      if (!viewport) return;
      for (var j = 0; j < nd.messages.length; j++) {
        var m = nd.messages[j];
        // R1-I3: two guards, in this order. (1) _messages guard: concurrent
        // fetches (nudge racing poll) both read the same lastId — skip a row
        // another fetch already accounted for, WITHOUT pushing a duplicate
        // object (thread-reply lookups scan _messages). (2) DOM guard: the
        // optimistic send path may have stamped the bubble before its
        // _messages push lands — account for the row but don't re-render.
        if (m.id && _messages.some(function (x) { return x.id === m.id; })) continue;
        _messages.push(m);
        if (m.id && viewport.querySelector('.msg-bubble[data-msg-id="' + m.id + '"]')) continue; // already rendered
        appendBubble(viewport, m);
        if (m.direction === 'received') {
          fetch('/api/messages/peer/' + m.id + '/read', { method: 'POST' }).catch(function(){});
        }
      }
      viewport.scrollTop = viewport.scrollHeight;
    } catch (e) { /* incremental fetch error — poll/SSE will retry */ }
  }

  function flipBubbleDelivered(id) {
    try {
      var b = document.querySelector('.msg-bubble[data-msg-id="' + Number(id) + '"]');
      if (!b) return;
      var tick = b.querySelector('.msg-delivery');
      if (!tick) {
        tick = el('span', { className: 'msg-delivery' });
        b.appendChild(tick);
      }
      tick.textContent = '\\u2713\\u2713';
      tick.classList.add('delivered');
      tick.title = '${tJs("messages.deliveryDelivered", lang)}';
    } catch (e) {}
  }

  function startMessagesStream() {
    if (window.__crowMsgStream) { try { window.__crowMsgStream.close(); } catch (e) {} window.__crowMsgStream = null; }
    try {
      var es = new EventSource('/dashboard/streams/messages');
      window.__crowMsgStream = es;
      es.addEventListener('crow-msg', function (evt) {
        try {
          var data = JSON.parse(evt.data);
          if (_activeItem && _activeItem.type === 'peer' && Number(data.contactId) === Number(_activeItem.id)) {
            fetchNewPeerMessages();
          }
        } catch (e) {}
      });
      es.addEventListener('crow-receipt', function (evt) {
        try {
          var data = JSON.parse(evt.data);
          if (!(_activeItem && _activeItem.type === 'peer' && Number(data.contactId) === Number(_activeItem.id))) return;
          (data.ids || []).forEach(flipBubbleDelivered);
        } catch (e) {}
      });
      es.addEventListener('session-expired', function () {
        try { es.close(); } catch (e) {}
        window.__crowMsgStream = null;
        // Next poll re-auths via the usual cookie path (player.js pattern).
      });
      es.onerror = function () { /* EventSource auto-reconnects; swallow. */ };
    } catch (e) { /* no EventSource — the fallback poll covers us */ }
  }
```

Call it from `startPolling()` (mirroring player.js's `startGlassesPoll`): add `startMessagesStream();` as the last line of `startPolling()`. `pollStatus()`'s conversation block (lines 1468-1488) is REPLACED by a single call:

```js
      // If viewing an active peer conversation, fetch new messages
      await fetchNewPeerMessages();
```

Also stop the stream in `stopPolling()`:

```js
    if (window.__crowMsgStream) { try { window.__crowMsgStream.close(); } catch (e) {} window.__crowMsgStream = null; }
```

- [ ] **Step 4: Implement — optimistic stamping in sendPeerMessage**

Replace the response-handling block (lines 706-716):

```js
      var body = null;
      try { body = await response.json(); } catch(_) { /* non-JSON body */ }
      if (!response.ok || (body && body.ok === false)) {
        // F-UI-7: stamp the failed row id so Retry targets the exact row.
        if (body && body.id) sentBubble.dataset.msgId = body.id;
        markBubbleFailed(sentBubble, body && body.error, { id: body && body.id, content: content });
      } else if (body && body.id) {
        // F-UI-5: reconcile the optimistic bubble with the real row.
        var existing = document.querySelector('.msg-bubble[data-msg-id="' + body.id + '"]');
        if (existing && existing !== sentBubble) {
          // A racing poll/live fetch already rendered the real row.
          sentBubble.remove();
        } else {
          sentBubble.dataset.msgId = body.id;
          _messages.push({
            id: body.id,
            direction: 'sent',
            content: content || '',
            created_at: new Date().toISOString(),
            delivery_status: body.delivery_status || 'relayed',
            nostr_event_id: body.nostr_event_id || null,
          });
          // Send-time tick (F-UI-6): show ✓ immediately; crow-receipt flips ✓✓.
          if (!sentBubble.querySelector('.msg-delivery')) {
            sentBubble.appendChild(el('span', {
              className: 'msg-delivery',
              title: '${tJs("messages.deliveryRelayed", lang)}',
              text: '\\u2713',
            }));
          }
        }
      }
```

- [ ] **Step 5: Implement — Retry (markBubbleFailed + retryFailedMessage)**

Replace `markBubbleFailed` (lines 1193-1210):

```js
  // Mark a 'sent' bubble as failed-to-deliver, with a Retry control (F-UI-7).
  // retryCtx = { id, content } when known (send-time from the POST body /
  // reload-time from the row). Classes replace the old inline styles (F-UI-6).
  function markBubbleFailed(bubble, errText, retryCtx) {
    try {
      var b = bubble;
      if (!b) {
        var vp = document.getElementById('msg-viewport');
        b = vp && vp.lastElementChild;
      }
      if (!b) return;
      b.classList.add('msg-bubble-failed');
      if (!b.querySelector('.msg-bubble-failed-note')) {
        b.appendChild(el('div', {
          className: 'msg-bubble-failed-note',
          text: '! ${tJs("messages.notDelivered", lang)}' + (errText ? ' — ' + errText : ''),
        }));
      }
      var ctx = retryCtx || {};
      if (ctx.content && !b.querySelector('.msg-retry-btn')) {
        b.appendChild(el('button', {
          className: 'msg-retry-btn',
          text: '${tJs("messages.retry", lang)}',
          onclick: function () { retryFailedMessage(b, ctx.content, ctx.id); },
        }));
      }
    } catch (e) { /* never let feedback crash the send path */ }
  }

  // Re-enter the send path for a failed message (F-UI-7). retry_of tells the
  // server to delete the old failed row once the resend lands.
  // NOTE (R1-M2, deliberate): retry re-sends TEXT only. This is consistent
  // with current behavior — failed sends never persist attachments
  // (peer-messages.js stores them only on success) and the send path never
  // transmits thread_id — so there is nothing to lose. Do not "fix" this here.
  async function retryFailedMessage(bubble, content, failedId) {
    if (!_activeItem || _activeItem.type !== 'peer') return;
    var btn = bubble.querySelector('.msg-retry-btn');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      var response = await fetch('/api/messages/peer/' + encodeURIComponent(_activeItem.id) + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, retry_of: failedId != null ? String(failedId) : undefined }),
      });
      var body = null;
      try { body = await response.json(); } catch (_) {}
      if (response.ok && body && body.ok !== false) {
        // Swap the failed bubble to a fresh sent state in place.
        bubble.classList.remove('msg-bubble-failed');
        var note = bubble.querySelector('.msg-bubble-failed-note'); if (note) note.remove();
        var rbtn = bubble.querySelector('.msg-retry-btn'); if (rbtn) rbtn.remove();
        if (body.id) {
          bubble.dataset.msgId = body.id;
          _messages.push({ id: body.id, direction: 'sent', content: content, created_at: new Date().toISOString(), delivery_status: body.delivery_status || 'relayed' });
        }
        if (!bubble.querySelector('.msg-delivery')) {
          bubble.appendChild(el('span', { className: 'msg-delivery', title: '${tJs("messages.deliveryRelayed", lang)}', text: '\\u2713' }));
        }
      } else {
        if (btn) { btn.disabled = false; btn.textContent = '${tJs("messages.retry", lang)}'; }
        markBubbleFailed(bubble, body && body.error, { id: failedId, content: content });
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '${tJs("messages.retry", lang)}'; }
    }
  }
```

In `appendBubble`'s failed branch (line 1162-1163), pass the retry context:

```js
    if (isSent && msg.delivery_status === 'failed') {
      markBubbleFailed(div, null, { id: msg.id, content: msg.content });
    } else if (...unchanged...)
```

And add the `delivered` class in the success branch (line 1164-1169):

```js
      div.appendChild(el('span', {
        className: 'msg-delivery' + (msg.delivery_status === 'delivered' ? ' delivered' : ''),
        title: msg.delivery_status === 'delivered' ? '${tJs("messages.deliveryDelivered", lang)}' : '${tJs("messages.deliveryRelayed", lang)}',
        text: msg.delivery_status === 'delivered' ? '\\u2713\\u2713' : '\\u2713',
      }));
```

- [ ] **Step 6: i18n key**

```js
  "messages.retry": { en: "Retry", es: "Reintentar" },
```

- [ ] **Step 7: Run tests**

Run: `node --test tests/messages-client-live.test.js tests/message-delivery-render.test.js`
Expected: PASS. Also boot-check the gateway parses: `node --check` is not enough for template strings — run `node --test tests/messages-client-live.test.js` (it builds the JS) and start the gateway once: `timeout 5 node servers/gateway/index.js --no-auth || true` (expect clean boot lines, no SyntaxError).

- [ ] **Step 8: Commit**

```bash
git add servers/gateway/dashboard/panels/messages/client.js servers/gateway/dashboard/shared/i18n.js tests/messages-client-live.test.js tests/message-delivery-render.test.js
git commit servers/gateway/dashboard/panels/messages/client.js servers/gateway/dashboard/shared/i18n.js tests/messages-client-live.test.js tests/message-delivery-render.test.js -m "feat(messages): live conversation updates + id-keyed dedup + Retry on failed bubbles (F-UI-4/5/7)"
git show --stat HEAD
```

---

### Task 7: Info-panel safety number + legible delivery CSS (F-UI-6 client)

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/client.js:1365-1378` (`showPeerInfo` Security block)
- Modify: `servers/gateway/dashboard/panels/messages/css.js:287-296`
- Test: `tests/messages-client-live.test.js` (extend), `tests/messages-css.test.js` if it exists (grep first), else string asserts in the same test file

**Interfaces:**
- Consumes: `contact.safety_number` from Task 5.
- Produces: browser rendering only.

- [ ] **Step 1: Failing tests**

Extend `tests/messages-client-live.test.js`:

```js
test("Info panel renders the symmetric safety number, not the raw peer pubkey (F-UI-6)", () => {
  assert.match(js, /contact\.safety_number/);
  assert.ok(!/ed25519_pubkey\.substring\(0, 32\)/.test(js), "raw truncated peer pubkey must be gone");
  assert.match(js, /safetyNumber/); // i18n label reference
});

test("delivery CSS is legible (F-UI-6)", () => {
  const css = messagesCss(); // import from ../servers/gateway/dashboard/panels/messages/css.js
  assert.match(css, /\.msg-delivery\s*\{[^}]*font-size:\s*0\.8rem/s);
  assert.match(css, /\.msg-delivery\.delivered\s*\{[^}]*var\(--crow-success/s);
  assert.match(css, /\.msg-bubble-failed-note/);
  assert.match(css, /\.msg-retry-btn/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/messages-client-live.test.js`
Expected: new tests FAIL.

- [ ] **Step 3: Implement showPeerInfo**

Replace the raw-pubkey block (client.js lines 1371-1377):

```js
    if (contact.safety_number) {
      // F-UI-6: show the SYMMETRIC safety number (same string both sides —
      // matches the Contacts detail page), not the raw asymmetric peer pubkey
      // that read as "the numbers don't match".
      secSec.appendChild(el('div', {
        className: 'msg-info-row',
        css: 'font-size:0.7rem;color:var(--crow-text-muted);margin-top:6px',
        text: '${tJs("contacts.safetyNumber", lang)}',
      }));
      secSec.appendChild(el('div', {
        className: 'msg-info-row',
        css: 'font-family:monospace;font-size:0.75rem;word-break:break-all;user-select:all',
        text: contact.safety_number,
      }));
    }
```

- [ ] **Step 4: Implement CSS**

Replace the `.msg-delivery` block (css.js lines 287-296):

```css
  /* F-UI-6: legible per-bubble delivery state. Single ✓ = relayed, accent
     ✓✓ = delivered, red note + Retry = failed. The old 0.7rem/muted/0.7-opacity
     tick was invisible in practice (P4 walkthrough). */
  .msg-delivery {
    display: inline-block;
    margin-left: 6px;
    font-size: 0.8rem;
    color: var(--crow-text-muted);
  }
  .msg-delivery.delivered {
    color: var(--crow-success, #10b981);
  }
  .msg-bubble-failed {
    border: 1px solid color-mix(in srgb, var(--crow-error, #ef4444) 45%, transparent);
  }
  .msg-bubble-failed-note {
    color: var(--crow-error, #ef4444);
    font-size: 0.78rem;
    font-weight: 600;
    margin-top: 4px;
  }
  .msg-retry-btn {
    display: inline-block;
    margin-top: 4px;
    padding: 2px 10px;
    font-size: 0.75rem;
    color: var(--crow-error, #ef4444);
    background: none;
    border: 1px solid var(--crow-error, #ef4444);
    border-radius: 6px;
    cursor: pointer;
  }
  .msg-retry-btn:disabled { opacity: 0.5; cursor: default; }
```

(Keep the old comment removed; `markBubbleFailed` no longer sets inline styles — Task 6 already switched it to classes.)

- [ ] **Step 5: Run + commit**

Run: `node --test tests/messages-client-live.test.js tests/message-delivery-render.test.js`
Expected: PASS.

```bash
git add servers/gateway/dashboard/panels/messages/client.js servers/gateway/dashboard/panels/messages/css.js tests/messages-client-live.test.js
git commit servers/gateway/dashboard/panels/messages/client.js servers/gateway/dashboard/panels/messages/css.js tests/messages-client-live.test.js -m "fix(messages): symmetric safety number in Info panel + legible delivery/failed CSS (F-UI-6)"
git show --stat HEAD
```

---

### Task 8: Addenda — add_by_id feedback + short-code expiry hint

**Files:**
- Modify: `servers/gateway/dashboard/panels/contacts/api-handlers.js:122-143` (add_by_id)
- Modify: `servers/gateway/dashboard/shared/peer-invite-ui.js` (`renderShortCodeForms` acceptForm)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (2 keys)
- Test: `tests/contacts-add-by-id-action.test.js` (exists — extend), `tests/short-code-ui.test.js`

**Interfaces:**
- Consumes: `crow_add_contact` tool result (`isError: true`, text `Failed to add contact: <err>` — `sharing/tools/contacts.js:351`).
- Produces: add_by_id failure → `{ inviteError }` (renders in the existing peerAdd error slot, visible because Task 1 un-Turbo'd the form... note: add_by_id ERROR now re-renders instead of redirecting) + one `console.warn` journal line.

- [ ] **Step 1: Failing tests**

Extend `tests/contacts-add-by-id-action.test.js` (it drives `handleContactAction` — reuse its stubs):

```js
test("add_by_id surfaces a tool refusal instead of silently redirecting (F-UI-1/3 addendum)", async () => {
  // sharingClientFactory stub returning isError:true, text "Failed to add contact: already exists with a different key"
  // R1-I2: the real signature is handleContactAction(req, db, { sharingClientFactory } = {})
  // (contacts/api-handlers.js:38) — pass the stub IN AN OPTIONS OBJECT or it is
  // silently ignored and the test hits the real sharing runtime.
  const result = await handleContactAction(req, db, { sharingClientFactory: stubFactory });
  assert.equal(result.redirect, undefined);
  assert.match(result.inviteError, /different key/);
});

test("add_by_id success still redirects", async () => { /* ok stub → { redirect: "/dashboard/contacts?flash=peer_added" } or plain /dashboard/contacts — see Step 3 */ });
```

Extend `tests/short-code-ui.test.js`:

```js
test("short-code accept form states the expiry up front (addendum)", () => {
  const { acceptForm } = renderShortCodeForms({ lang: "en", csrf: "" });
  assert.match(acceptForm, /10 minutes/);
});
```

NOTE: check `handleContactAction`'s real signature for how `sharingClientFactory` is injected (the existing test file shows it). If it's not injectable, add the same optional-param pattern the messages handler uses.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/contacts-add-by-id-action.test.js tests/short-code-ui.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement add_by_id**

In `contacts/api-handlers.js` (lines 126-142), capture and surface the result:

```js
    try {
      const client = await sharingClientFactory();
      let result;
      try {
        result = await client.callTool({
          name: "crow_add_contact",
          arguments: {
            crow_id: crowId,
            secp256k1_pubkey: secp,
            ed25519_pubkey: (req.body.ed25519_pubkey || "").trim() || undefined,
            display_name: (req.body.name || "").trim() || undefined,
          },
        });
      } finally { try { await client.close?.(); } catch {} }
      if (result?.isError) {
        const text = result.content?.[0]?.text || "Contact could not be added.";
        // Addendum (S4.5b): the I1 key-pinning refusal used to be silent at
        // EVERY layer — an attacker got silence (fine) but so did a legit typo
        // (bad). One journal line + a visible error. The guard itself is
        // untouched.
        console.warn("[contacts] add_by_id refused:", text);
        return { inviteError: text };
      }
    } catch (err) {
      console.error("[contacts] add_by_id failed:", err.message);
      return { inviteError: err.message };
    }
    return { redirect: "/dashboard/contacts?flash=peer_added" };
```

- [ ] **Step 4: Implement the expiry hint**

In `renderShortCodeForms`'s `acceptForm`, add before the submit button:

```js
    <p style="font-size:0.7rem;color:var(--crow-text-muted);margin:4px 0 0">${t("invite.shortCodeAcceptExpiryHint", lang)}</p>
```

i18n:

```js
  "invite.shortCodeAcceptExpiryHint": { en: "Codes expire about 10 minutes after they're created.", es: "Los códigos caducan unos 10 minutos después de crearse." },
```

- [ ] **Step 5: Run + commit**

Run: `node --test tests/contacts-add-by-id-action.test.js tests/short-code-ui.test.js tests/contacts-peer-add.test.js`
Expected: PASS.

```bash
git add servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/shared/peer-invite-ui.js servers/gateway/dashboard/shared/i18n.js tests/contacts-add-by-id-action.test.js tests/short-code-ui.test.js
git commit servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/shared/peer-invite-ui.js servers/gateway/dashboard/shared/i18n.js tests/contacts-add-by-id-action.test.js tests/short-code-ui.test.js -m "fix(contacts): add_by_id refusals are visible + journaled; short-code expiry stated up front (addenda)"
git show --stat HEAD
```

---

### Task 9: Full suite + gateway boot check

- [ ] **Step 1: Full suite**

Run: `node --test tests/*.test.js 2>&1 | tail -5`
Expected: **≥1329 pass + all new tests, 0 fail, 1 skip**. Fix any fallout (the dispatcher/renderer changes touch widely-asserted HTML — expect possible string-assert fixups in messages/contacts render tests; fix the TEST only if the new output is the intended one, otherwise fix the code).

- [ ] **Step 2: Gateway boots clean**

Run: `timeout 8 node servers/gateway/index.js --no-auth 2>&1 | head -30 || true`
Expected: normal boot lines, no SyntaxError/ReferenceError.

- [ ] **Step 3: Commit any fixups** (positional paths, as always).

---

### Task 10: Browser-click CDP verification (HARD REQUIREMENT)

**This class of bug is invisible to curl/MCP — that is exactly how F-UI-1 shipped broken. No PR without this evidence.**

**Setup — scratch two-gateway pair on crow (no prod impact, no deadman needed):**

- [ ] **Step 1: Launch two scratch gateways from the branch tree**

```bash
mkdir -p "$CLAUDE_JOB_DIR/tmp/ca-a" "$CLAUDE_JOB_DIR/tmp/ca-b"
CROW_DATA_DIR="$CLAUDE_JOB_DIR/tmp/ca-a" node scripts/init-db.js
CROW_DATA_DIR="$CLAUDE_JOB_DIR/tmp/ca-b" node scripts/init-db.js
CROW_DATA_DIR="$CLAUDE_JOB_DIR/tmp/ca-a" PORT=3471 node servers/gateway/index.js --no-auth &
CROW_DATA_DIR="$CLAUDE_JOB_DIR/tmp/ca-b" PORT=3472 node servers/gateway/index.js --no-auth &
```

(`PORT` is confirmed — `servers/gateway/index.js:81` reads `PORT || CROW_GATEWAY_PORT`; `CROW_DATA_DIR` is the same var `freshLibsql()` uses for init-db. Fresh data dirs mint fresh identities. `--no-auth` skips login and — by design since PR #142/#143 — skips instance-sync feed init, which is what we want for scratch instances. CSRF (R1-Q3, verified): under `--no-auth` there is no `crow_session` cookie, and `csrfMiddleware` skips validation without one (`dashboard/shared/csrf.js:80`) — the classic form POSTs will not 403. Confirm `/health` 200 on both before driving the browser.)

- [ ] **Step 2: Drive the crow-browser container over CDP**

The container browses `http://10.0.0.237:3471` / `:3472` (host LAN IP). Recipe: CDP websocket via `/home/kh0pp/crow/node_modules/ws/wrapper.mjs`; `Page.navigate`, `Runtime.evaluate` with page-context `fetch` + DOM queries; screenshot via `Page.captureScreenshot`. Write the driver to `$CLAUDE_JOB_DIR/tmp/ca-cdp-verify.mjs`, saving screenshots + a JSONL of DOM assertions.

- [ ] **Step 3: The click-through checklist (each = DOM assertion + screenshot)**

1. **Generate invite link** (A): open Messages → "+" → click "Create invite link" → assert `.invite-share` visible with a URL. (F-UI-1)
2. **Generate short code** (A): click generate → assert `.short-code-share` code visible. (F-UI-1)
3. **Accept invite** (B, paste A's code): assert redirect landed on `/dashboard/messages`, the new conversation is OPEN, toast text present. (F-UI-3)
4. **Accept error** (B, paste garbage): assert visible error banner. (F-UI-1 error path)
5. **Live DM** (A→B with B's conversation open): assert the bubble appears WITHOUT refresh within ~5s. (F-UI-4)
6. **First-message case + draft preservation**: fresh pair, empty conversation open on B, **type a draft into B's composer without sending** → A sends → assert the bubble appears AND the typed draft is still in `#msg-input` (R2-C1/Q1: the empty-branch fetch must never rebuild the composer). (F-UI-4 edge)
7. **Send** (B): exactly ONE bubble for the sent message after 10s (poll overlap window). (F-UI-5)
8. **Receipts**: sender bubble shows ✓ at send, flips ✓✓ when the receipt lands, legible size/color. (F-UI-6)
9. **Safety number**: Info panel shows the grouped digits; compare A's and B's — MUST match. (F-UI-6)
10. **Retry UI (seeded)**: R1-C1 — there is NO env/config way to force a 0-relay failure on a scratch gateway (`CROW_NOSTR_RELAYS` does not exist; `getConfiguredRelays()` always merges `DEFAULT_RELAYS` back in as a floor, `nostr.js:722-741`; host-level /etc/hosts or firewall tricks on crow would hit the PROD gateway). So pre-merge: **seed a failed row directly in scratch B's DB** (`INSERT INTO messages (contact_id, content, direction, delivery_status, created_at) VALUES (?, 'seeded-fail', 'sent', 'failed', datetime('now'))`), reload the conversation in the browser → assert the red failed note + Retry button render (the RELOAD path); click **Retry** (relays are live) → bubble swaps to ✓, the seeded failed row is GONE from the DB (assert by id). The fresh-send-failure path itself is covered by the route unit tests (Task 3, mutation-tested) pre-merge, and by the post-deploy black-swan check below. (F-UI-7)
11. **add_by_id refusal** (B): submit a wrong key for an existing contact → visible error, journal line in gateway stderr. (addendum)
12. **Short-code expiry hint** visible near the entry field. (addendum)

- [ ] **Step 4: Evidence + teardown**

Kill the scratch gateways; copy screenshots + assertion JSONL to `~/.crow/p4/cluster-a-evidence/`; summarize per-item PASS/FAIL in the PR body.

- [ ] **Step 5: Post-deploy re-verification (after merge + fleet deploy)**

Against real crow↔black-swan (the S10 manifest keeps that pairing for exactly this):
1. Items 1-5 **through the Tailscale Serve HTTPS hostname** (`https://crow.dachshund-chromatic.ts.net:8444` in the crow-browser) — this is the only place the SSE-through-Serve question (spec F-UI-4 note; R1-Q2) is actually answerable: a live DM from black-swan must appear in crow's open conversation without refresh.
2. **Fresh-send failure on black-swan** (the proven S5.2 recipe): redirect the 4 relay hostnames to 127.0.0.1 in black-swan's `/etc/hosts`, `ss -K` the relay sockets, **arm an out-of-process deadman that restores /etc/hosts + restarts the gateway** (systemd-run --on-active=600, per the global unattended-window rule), send a DM in the UI → red failed note + **Retry** button on a REAL fresh failure; restore /etc/hosts; wait for relay self-heal (~45s); click Retry → success. Disarm the deadman.

---

## Execution order & dependencies

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Tasks 3/4/5 are independent of each other but ALL must precede 6. Run sequentially (shared tree — no parallel subagents editing `client.js`).

## Out of scope (do not touch)

`shouldEnqueue` semantics; room/group send paths; `<turbo-stream-source>` element (badges keep working through it — a second consumer EventSource is additive); blocked-contact subscription teardown (Cluster C); relaysConnected liveness (Cluster D); profile-name sync (Cluster B); the ASYNC inviter-side replay-reject surfacing ("waiting for peer to confirm" indicator — R1-Q1: the split is deliberate; the synchronous accept-error banner is covered via Task 1's un-Turbo'd re-render).

## Review

**R1 (adversarial staff-engineer review, Opus subagent, 2026-07-10): REVISE — 2 critical, 3 important, 5 minor, 3 questions. All folded:**
- **C1** (fabricated `CROW_NOSTR_RELAYS` env + `DEFAULT_RELAYS` floor made the F-UI-7 CDP recipe impossible) → Task 10 item 10 rewritten: pre-merge seeded-failed-row Retry UI check + post-deploy black-swan fresh-failure via the proven S5.2 /etc/hosts recipe with an out-of-process deadman (new Step 5).
- **C2** (`code`/`result` out of scope at the accept success returns — the plan's own reassurance was wrong) → Task 2 Step 3 rewritten with the full hoisted restructure.
- **I1** (`loadOrCreateIdentity()` sync disk read + keypair derivation per GET, incl. the afterId hot path) → module-level pubkey cache + safety number computed only on initial (non-afterId) loads.
- **I2** (Task 8 stub passed positionally would silently hit the real sharing runtime) → options-object form pinned in the test skeleton.
- **I3** (`_messages.push` before the dedup `continue` accumulates duplicate objects under racing fetches) → `_messages.some()` guard before push, DOM guard after.
- **M2** (retry drops attachments/thread) → documented as deliberate consistency, not a gap. **M4** (stream tests must fire the close handler or leak the session-recheck interval) → noted in Task 4. **M5** (per-instance init-db) → fixed. **Q2** (SSE-through-Serve unverified) → post-deploy Step 5 item 1 requires a live DM through the Serve hostname. **Q3** (CSRF under --no-auth) → verified skipped (`csrf.js:80`), documented.
- **M1** (string-match client tests are weak) → conceded as guards-of-last-resort; behavioral DOM-shim tests preferred where the harness executes functions; the CDP run is the binding behavioral evidence.

**R2 (fresh-eyes adversarial review of the folded plan, Opus subagent, 2026-07-10): REVISE — 1 critical, 2 important, 2 minor. All folded:**
- **C1** (the R1-era empty-conversation branch called `loadPeerConversation`, which rebuilds the composer and wipes an in-progress draft — squarely in F-UI-3's own happy path, and the poll-guard replacement made it fire every 5 min on an open empty conversation) → empty branch now fetches the initial window WITHOUT afterId and APPENDS into the already-rendered viewport; never rebuilds the chat UI. Extraction test inverted to forbid `loadPeerConversation` there; CDP item 6 now asserts draft survival (Q1).
- **I1** (plan instructed `import { bus }` — event-bus.js is default-export-only; the named import is a load-time SyntaxError that takes down the sharing runtime via server.js) → corrected to `import bus from "../shared/event-bus.js"`.
- **I2** (sse-cap.test.js harness doesn't transfer to `openAuthedStream`; TWO leaked timers per stream, not one) → Task 4 test note rewritten with the full fake-res surface + both intervals cleared via the close listeners.
- **M1** (negative-caching `""` permanently disables safety numbers after one transient failure) → cache-on-success only. **M2** (connected-toast silently coupled to the forms staying `data-turbo="false"`) → coupling comment pinned in the code.
- R2 explicitly verified as SOUND: the C2 restructure's dispatcher contract, crow-id resolution for both accept paths, afterId safety-number skip, the I3 double-guard dedup under both race orderings, Task 3's cross-connection read-back (shipping attachments precedent), CSP/EventSource compatibility, `el()` option keys, i18n key freshness, and Task 9's bounded-fallout claim.
