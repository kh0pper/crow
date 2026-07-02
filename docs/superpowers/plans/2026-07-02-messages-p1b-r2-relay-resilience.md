# Messages Phase 1b — R2 Honest Delivery Feedback + Relay Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop silent send-side failures (the send half of the L6 "no more silent losses" theme). Today a DM that reaches 0 relays is reported as "sent," and the relay set is 2 hardcoded relays with the user-configurable path dead — one flaky relay is a silent single point of failure (observed in the Phase 1a harness: crow reached only 1 of 2 relays). After: messages carry a real `delivery_status`, `crow_send_message` errors on 0-relay sends, the dashboard surfaces failures, the default relay set is larger, and user-added relays actually take effect.

**Architecture:** Small, surgical changes on the existing send path (`servers/sharing/nostr.js` `sendMessage`/`connectRelays`), the send tool (`messaging.js`), the messages schema (`init-db.js`), the dashboard send handler + bubble (`messages/`), and a `SCHEMA_GENERATION` bump (dogfooding the migration-gate that just shipped). No new subsystem.

**Tech Stack:** Node 20, `servers/sharing/nostr.js`, `servers/sharing/tools/messaging.js`, `servers/gateway/dashboard/panels/messages/{data-queries,client,api-handlers}.js`, `scripts/init-db.js` + `servers/shared/schema-version.js`, `node --test`.

## Verified facts (2026-07-02)

- `sendMessage` (`nostr.js:118-170`) publishes to every connected relay via `safeRelayPublish`, collecting `published[]` = relays that accepted, then `INSERT INTO messages (... direction='sent' ...)` with **no delivery_status**, and returns `{eventId, relays: published}`. The honest count already exists — it's just not persisted or surfaced.
- `DEFAULT_RELAYS` (`nostr.js:34`) = exactly 2 (`relay.damus.io`, `nos.lol`). Both connect fine from crow live (302/435ms) — the harness "1/2" was intermittent publish-time flakiness, so the fix is MORE relays + honest reporting, not debugging one relay.
- `getConfiguredRelays()` (`nostr.js:448`) reads `relay_config WHERE relay_type='nostr' AND enabled=1` (else DEFAULT_RELAYS) — but is **DEAD**: all 7 `connectRelays()` callers pass no arg (`instances.js:98`, `contacts.js:128,213`, `nostr.js:120,179,217,366`), so `_doConnectRelays(undefined)` uses `DEFAULT_RELAYS`. `crow_add_relay` (`instances.js:63`) writes `relay_config` that nothing reads (L4).
- `messages` table (`init-db.js:511-530`) has `direction CHECK(sent|received)`, no `delivery_status`. (The `delivery_status` at `init-db.js:488` is on `shared_items`, a different table.)
- `crow_send_message` (`messaging.js:42-50`) reports `via ${delivery.relays.length} relay(s)` with **no `isError`** even at 0. Dashboard `send_peer` (`api-handlers.js:~50`) `console.error`s + redirects, swallowing failures.
- `SCHEMA_GENERATION` (`servers/shared/schema-version.js`) is currently 1; adding a column REQUIRES bumping it to 2 so the migration auto-applies on restart (the gate shipped in PR #127).

## Global Constraints

- Branch `fix/messages-r2-relay-resilience`. Positional-path commits; `git show --stat HEAD` after each.
- Tests: `node --test tests/<file>.test.js`. Gateway must boot.
- Send path is delivery-critical: never throw out of `sendMessage`/`connectRelays`; a delivery_status write failure must not lose the message (best-effort).
- Relay list changes affect a network default — use only well-established, long-lived public relays.

---

### Task 1: Relay resilience — wire getConfiguredRelays + expand defaults (fixes L4 + SPOF)

**Files:**
- Modify: `servers/sharing/nostr.js` — (a) expand `DEFAULT_RELAYS` from 2 to a resilient set of **heavily-operated, anon-kind-4-writable** public relays: keep `wss://relay.damus.io`, `wss://nos.lol`, add `wss://relay.primal.net`, `wss://relay.nostr.band`, `wss://offchain.pub`. **At impl time, verify each actually ACCEPTS an anonymous kind-4 publish** (a quick connect+publish probe) — drop any that's write-restricted/paid/defunct. (Review flagged `relay.snort.social` (historically write-restricted) and `nostr.mom` (small single-operator) as NOT safe defaults — use the band/offchain set instead.) (b) **`getConfiguredRelays()` MERGES, never replaces (review C2):** return `dedup([...DEFAULT_RELAYS, ...enabled_nostr_relay_config_rows])` so defaults are always a floor AND user-added relays are added — an install that ran `crow_add_relay` once must NOT drop to a single relay (that's the SPOF this fixes). Wrap the DB read in try/catch → fall back to `DEFAULT_RELAYS` on error (never-throw). (c) `_doConnectRelays(customRelays)` (`:73`): `customRelays || await this.getConfiguredRelays()`. (d) add `connectedRelayUrls()` → `[...this.relays.keys()]` accessor.
- Test: `tests/nostr-relay-config.test.js`

**Interfaces:**
- Produces: `getConfiguredRelays()` returns the MERGED (defaults ∪ configured, deduped) set and drives connections; `connectedRelayUrls():string[]`.

- [ ] **Step 0 (pre-deploy audit, do at deploy not impl):** `sqlite3 -readonly <db> "SELECT * FROM relay_config WHERE relay_type='nostr'"` on crow + grackle — confirm whether any latent rows exist (determines if C2 was a live risk; with the merge fix it's safe either way).
- [ ] **Step 1:** Test (temp init-db DB + stubbed relay-connect, no live network): empty `relay_config` → connect path requests the full `DEFAULT_RELAYS` (>2); after inserting 1 enabled nostr row `wss://custom.example` → connect path requests `DEFAULT_RELAYS ∪ {custom}` (defaults STILL present — assert the merge, not replace); a duplicate config row of a default → deduped (no double). Assert `getConfiguredRelays()` never throws on a broken db (returns DEFAULT_RELAYS).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (a)+(b)+(c)+(d). `_doConnectRelays` + `getConfiguredRelays` never-throw.
- [ ] **Step 4:** Run → PASS. Boot smoke.
- [ ] **Step 5:** Commit `fix(messages): use configured relays + larger default relay set (L4 dead-code + send SPOF)`.

### Task 2: delivery_status column + sendMessage persists honest status

**Files:**
- Modify: `scripts/init-db.js` — `addColumnIfMissing("messages", "delivery_status", "TEXT")` (nullable; values `pending`/`relayed`/`delivered`/`failed`, no CHECK to keep addColumn simple + forward-compatible with a future `delivered` ack). Place near the messages table def.
- Modify: `servers/shared/schema-version.js` — bump `SCHEMA_GENERATION` 1 → 2 (so the column auto-applies on restart via the PR #127 gate).
- Modify: `servers/sharing/nostr.js` `sendMessage` — set `delivery_status` on the sent INSERT: `published.length > 0 ? 'relayed' : 'failed'`. Keep the INSERT best-effort.
- Test: `tests/message-delivery-status.test.js`

**Interfaces:**
- Produces: sent `messages` rows carry `delivery_status` ('relayed' when ≥1 relay accepted, 'failed' when 0).

- [ ] **Step 1:** Test: `sendMessage` with a stubbed relay set where publish succeeds → the inserted sent row has `delivery_status='relayed'`; with a relay set where all publishes fail (or `relays.size===0` after a failed connect) → `delivery_status='failed'` and the returned `relays` is empty. (Stub `safeRelayPublish`/the relay map.)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add the migration + bump SCHEMA_GENERATION + set status in the INSERT.
- [ ] **Step 4:** Run → PASS. Verify migration idempotent + `PRAGMA user_version` stamps 2 (run init-db on a temp DB; column present, user_version=2).
- [ ] **Step 5:** Commit `feat(messages): persist delivery_status on sent DMs (relayed/failed) + bump schema generation`.

### Task 3: 0-relay send is a failure — tool isError + the LIVE route + UI surface it

**Review C1: the live UI send does NOT go through `api-handlers.js` `send_peer` (dead) — it goes `client.js:697 fetch('/api/messages/peer/:id/send')` → `servers/gateway/routes/peer-messages.js:89`, which discards the tool result and unconditionally returns `{ok:true}`. Fix the LIVE path.**

**Files:**
- Modify: `servers/sharing/tools/messaging.js` `crow_send_message` (`:42-50`) — when `delivery.relays.length === 0`, return `{ isError:true, content:[{type:'text', text:'Message could NOT be delivered — reached 0 relays. Check your connection / relay settings.'}] }`. When ≥1, accurate success text ("delivered to N relay(s)"). A partial publish (≥1 of N) stays success/'relayed' (publish-acceptance ≠ recipient delivery; not 'delivered' until the R5 ack).
- Modify: `servers/gateway/routes/peer-messages.js` (~:89-157) — CAPTURE the `crow_send_message` result (it's currently discarded at ~:120). If `result.isError` (or the relay count is 0), return a non-ok response (`res.status(502).json({ ok:false, error:'reached 0 relays' })` or `{ok:false}` with the message text) instead of the unconditional `{ok:true}` at ~:157. Parse the relay count from the result if needed.
- Modify: `servers/gateway/dashboard/panels/messages/client.js` `sendPeerMessage` (~:688-710) — read the fetch response: on `!response.ok` or `{ok:false}`, mark the optimistic bubble (~:688) as failed (add a failed class / status) rather than leaving the success bubble. (This gives send-time surfacing; Task 4's `delivery_status` gives it on reload too.)
- Test: `tests/message-send-feedback.test.js` — (a) the tool returns isError when stubbed `sendMessage` → `{relays:[]}`, success when `{relays:['wss://x']}`; (b) a route-level assertion that a 0-relay send yields a non-ok response (drive `peer-messages.js` with a stubbed sharing client whose send reports 0 relays → assert non-ok / ok:false; ≥1 → ok:true). This guards C1 from silently regressing.

- [ ] **Step 1:** Write both tests (tool isError branch + the route non-ok-on-0-relay). Run → FAIL.
- [ ] **Step 2:** Implement the tool isError + peer-messages.js result capture + client.js response handling.
- [ ] **Step 3:** Run → PASS. Confirm the ≥1-relay path still returns ok:true (no regression to normal sends).
- [ ] **Step 4:** Commit `fix(messages): a 0-relay send is a failure — tool isError + live peer-send route returns non-ok + UI marks the bubble failed (R2)`.

### Task 4: Message bubble shows delivery state

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/data-queries.js` `getPeerMessages` — include `delivery_status` in the selected columns for sent messages.
- Modify: `servers/gateway/dashboard/panels/messages/client.js` `appendBubble` (+ the render path) — for `direction='sent'` messages, render a small status affordance: `relayed` → a subtle single check "✓"; `failed` → a red "!" / "Failed" with a Retry affordance (Retry re-invokes send for that content — MVP can be a re-send button that repopulates the composer, or omit retry and just show the state clearly). `pending`/null → nothing or a faint clock. Keep it unobtrusive (small, muted).
- Modify: `messages/css.js` — a `.msg-delivery` style (muted; `.msg-delivery-failed` red).
- Test: a render-path assertion (like Task 4 of L6) — a sent message with `delivery_status='failed'` renders the failed affordance; `relayed` renders the check.

- [ ] **Step 1:** Failing render assertion (buildMessagesHTML/appendBubble path with a seeded failed sent message → contains the failed indicator).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the query column + bubble rendering + CSS + i18n for any label ("Failed"/"Retry").
- [ ] **Step 4:** Run → PASS. Live-render check via the render path (gateway boot is disruptive on prod — assert via the path).
- [ ] **Step 5:** Commit `feat(messages): show sent-message delivery state (relayed ✓ / failed) in the thread`.

### Task 5: Tests + suite green

- [ ] **Step 1:** Full suite `node --test tests/` stays green (report count). `node --check` all touched product files.
- [ ] **Step 2:** Commit any test consolidation. `git show --stat HEAD`.

---

## Follow-on (outline, separate)
- **R5 delivered-ack**: a `crow_social` delivery receipt from the recipient upgrades `delivery_status` 'relayed'→'delivered' + a sender retry queue for unacked DMs (the structural offline-delivery fix). This is why `delivery_status` allows a future 'delivered' value.
- **R4 handshake repair** (next planned): promote an accepted request → full peer-synced contact on identity arrival; add-by-id.

## Review

**Round 1 (2026-07-02, adversarial subagent, opus): REVISE — 2 criticals fixed:**
- **C1 (Task 3 patched a dead path):** the live UI send is `client.js:697 → routes/peer-messages.js` (which discarded the tool result + always returned `{ok:true}`), NOT `api-handlers.js send_peer`. Task 3 retargeted to peer-messages.js (capture result → non-ok on 0 relays) + client.js (read response, mark bubble failed) + a route-level test guarding it.
- **C2 (relay set replaced, not merged):** `getConfiguredRelays` returned ONLY config rows → any install that ran `crow_add_relay` once would drop to a single relay (re-creating the SPOF). Now MERGES defaults ∪ configured (deduped); defaults are always a floor; + a pre-deploy `relay_config` audit step.
Suggestions adopted: relay set swapped to heavily-operated anon-writable relays (band/offchain over snort/mom) with an impl-time write probe; getConfiguredRelays never-throw; partial-publish stays 'relayed'; NULL delivery_status confirmed safe (received rows inherently delivered, no query filters it); migration placement after the messages initTable (not the FK-rebuild block); SCHEMA_GENERATION 1→2 confirmed sufficient for auto-apply.

## Self-review notes
- Fixes the send half of "stop silent failures": 0-relay = failure (not success), persisted delivery_status, dashboard surfacing, and a resilient relay set so one flaky relay isn't a SPOF.
- Dogfoods the PR #127 schema-generation gate (bump to 2) — proves that path end-to-end on a real column add.
- Send path stays best-effort/never-throw; delivery_status is additive (nullable) so existing rows/queries are unaffected.
- Deliberately defers true `delivered` (needs the R5 ack) — the column is forward-compatible.
