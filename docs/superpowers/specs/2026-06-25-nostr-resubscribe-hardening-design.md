# Nostr relay re-subscribe hardening — design

**Date:** 2026-06-25
**Status:** approved (brainstorming) → writing-plans
**Origin:** [[session-handoff-2026-06-25-nostr-resubscribe-hardening]], surfaced by the 2026-06-25 Crow Messages rooms live test ([[crow-messages-group-threads-shipped]]).

## Problem

A long-lived `relay.subscribe(...)` is established **once** and **never re-established** when the relay WebSocket drops, goes idle, or the relay closes the long-running REQ. `nostr-tools`' `relay.subscribe` does not auto-resubscribe under our current call pattern (we call `Relay.connect(url)` with no options, leaving the library's reconnect/ping machinery off). The relay keeps holding the events (verified retrievable by a fresh REQ), but they never reach the handler until a process restart re-subscribes.

This silently breaks **receiving** in two places:

1. **pi-bots crow-messages adapter** — a bot stops receiving room messages AND 1:1 DMs until `pibot-gateways@<inst>` is restarted. This is the failure the live test caught.
2. **Gateway's own messaging** (`servers/sharing/nostr.js`) — `subscribeToIncoming` (peer invites, invite-accepts, room inbound) and `subscribeToContact` (per-contact 1:1) have the same latent bug; a long-running gateway can stop receiving peer/room traffic.

Both are in scope for this arc, fixed with one shared primitive.

## Key fact about the installed library (verified on disk)

`nostr-tools@2.23.3` `AbstractRelay` already has reconnect machinery, but it is **opt-in and currently off**:

- `enableReconnect` (default `false`) — on a socket close, auto-reconnects with backoff and re-fires open subs with `since = lastEmitted + 1`.
- `enablePing` (default `false`) — pings every ~29s, force-closes the socket if no pong within ~20s. **This is the only way to detect a half-open / silently-dead idle socket** (the exact failure mode here); without it `relay.connected` stays `true` forever on a dead connection.

Gap in the library's own reconnect: the `ws.onerror` (RST) path sets `skipReconnection = true` **and clears all open subs**, so a hard error would not self-heal via `enableReconnect` alone, and that behavior is not unit-testable in our own suite.

**Decision:** we own a single app-level reconnect engine (a periodic health loop) and use the library only for `enablePing` (to keep `relay.connected` truthful). `enableReconnect` stays **off** — exactly one reconnect engine, uniform across all drop modes, fully unit-testable with stub relays.

## Why a health loop + ping converges

With `enablePing: true` at connect, every drop mode ends the same way — `relay.connected === false` and the sub cleared:

- **clean idle close** → `ws.onclose` → `handleHardClose` (else-branch, since `enableReconnect` off) → `_connected = false`, subs cleared.
- **RST / `onerror`** → `skipReconnection = true` → `handleHardClose` else-branch → `_connected = false`, subs cleared.
- **silent half-open** → ping timeout → `ws.close()` → `onclose` → same as clean close.

The single health loop reconnects + resubscribes uniformly for all three. No two reconnect paths fighting.

## Architecture

### 1. `servers/sharing/resilient-subscribe.js` (new — relay/db-agnostic primitive)

Sibling to `safe-relay-publish.js`, same "reconnect-or-skip" philosophy, single purpose. Never touches sqlite and never constructs relays — that is what lets the same code serve the adapter (better-sqlite3, sync) and `NostrManager` (libsql, async) unchanged.

```
export function makeResilientSub(relay, filter, onevent, opts = {}) → handle
```

- `opts`: `{ initialSince, skewSec = 120, connectTimeoutMs = 10000 }`.
- Wraps `onevent` to record `lastSeen = max(seen event.created_at)`.
- Does an **initial subscribe at construction** (relay is connected then) so listening starts immediately, exactly like today.
- Registers the sub's `onclose` → sets internal `sub = null`, so the next `ensureHealthy()` knows to re-subscribe.
- Returns a **timer-less** handle:
  - `async ensureHealthy()` — guarded by a `busy` flag (skip if a prior tick is still running) and a `stopped` flag. If `!relay.connected`: bounded `relay.connect()` (raced against `connectTimeoutMs`); if it fails, return and retry next tick. Once connected, if `sub == null`, re-subscribe with `since = lastSeen ? lastSeen - skewSec : initialSince`.
  - `close()` — set `stopped = true`; close the sub if open. **Does not** close the relay (relay lifecycle stays with the caller).

The caller owns ONE `setInterval` (the health loop) that iterates its handles calling `ensureHealthy()`. Fewer timers; uniform.

**Resubscribe `since` window:** `lastSeen - 120s` covers clock drift between us, the relay, and the sender, so no gap-window event is missed. Replay overlap is harmless — see dedup safety below.

### 2. pi-bots adapter

- `scripts/pi-bots/gateways/nostr-client.mjs`
  - `connectRelays`: add `{ enablePing: true }` to `Relay.connect(url, { enablePing: true })`.
  - New `subscribeResilient(relays, filter, onevent, opts)`: build one `makeResilientSub` handle per relay; return `{ handles, ensureAllHealthy(), stop() }` where `ensureAllHealthy` iterates `handle.ensureHealthy()` and `stop()` closes every handle. (Imports `makeResilientSub` from `../../../servers/sharing/resilient-subscribe.js`, mirroring the existing `safe-relay-publish.js` import.)
  - Keep the existing `subscribe()` export (still used by tests / simple paths) — `subscribeResilient` is additive.
- `scripts/pi-bots/gateways/crow-messages.mjs`
  - `start()`: replace the one-shot `subscribe(...)` with `subscribeResilient(...)`; add a `setInterval(ensureAllHealthy, HEALTH_INTERVAL_MS)` (default 45000, env-overridable `PIBOT_NOSTR_HEALTH_MS`). The `onevent` body (dedupe gate → `markEventSeen` → decrypt → queue) is unchanged.
  - `stop()`: `clearInterval(...)`, then `subResilient.stop()` (closes handles), then close relays + db (current order otherwise preserved).

### 3. `servers/sharing/nostr.js` (`NostrManager`)

- `_doConnectRelays`: add `{ enablePing: true }` to `Relay.connect`.
- `subscribeToIncoming` and `subscribeToContact`: replace each raw `relay.subscribe(...)` with a `makeResilientSub(relay, filter, wrappedOnevent, { initialSince })` handle, stored in `this.subscriptions` under the same keys (`incoming:${url}`, `${crowId}:${url}`). The existing `onevent` bodies (decrypt, libsql cache, notifications, callbacks) are unchanged — they become the `onevent` passed to the helper.
- Manager-level health loop: a single `this._healthTimer` (lazily started the first time any resilient sub is created; guarded so it is created once) iterates `this.subscriptions.values()` calling `ensureHealthy()`. Interval default 45000, env-overridable `CROW_NOSTR_HEALTH_MS`.
- `destroy()`: `clearInterval(this._healthTimer)` (and null it) before closing subs + relays. `boot.js` is **untouched**.

## Dedup safety (no double pi turns, no duplicate rows)

Replay on resubscribe is collapsed by existing layers:

- **Adapter:** in-process `makeDedupeGate` (4096-id FIFO) + persistent `bot_message_seen` (`cmStore.markEventSeen`). A replayed event is gated before any pi turn.
- **`nostr.js` `subscribeToIncoming`:** in-process `seenEventIds` Set.
- **`nostr.js` `subscribeToContact`:** `INSERT OR IGNORE` on `messages(nostr_event_id ...)`; `createNotification`/`bus.emit` only fire when `rowsAffected > 0`.

So a `since = lastSeen - 120s` replay produces no duplicate side effects.

## Error handling / invariants

- `ensureHealthy` never throws into the timer: bounded connect (timeout race), `try/catch` around connect, `busy` + `stopped` guards, no unbounded awaits.
- No sub/relay leak on reconnect: a dropped sub is re-created only after the old one is gone (`sub == null`); `close()`/`stop()`/`destroy()` tear down timers + handles + relays.
- Relay lifecycle stays with the caller; the helper only manages the subscription against a relay it is handed.
- `enableReconnect` is intentionally left **off** to avoid a second reconnect engine.

## Testing (node --test, injected stub relays — mirrors `tests/crow-messages-*.test.js` and the nostr-client unit tests)

New `tests/resilient-subscribe.test.js` with a `StubRelay` (`connected` toggle, recording `subscribe(filters,{onevent,onclose})`, a `connect()` that flips `connected` true and lets a test fire a delivered event, a `close()`):

1. **Reconnect + resubscribe + delivery:** initial sub delivers; simulate a drop (fire sub `onclose`, set `connected = false`); `ensureHealthy()` reconnects + resubscribes; a post-reconnect event reaches the handler.
2. **Rolling `since`:** after an event with `created_at = T`, a resubscribe uses `since = T - 120`; with no event yet, `since = initialSince`.
3. **Replay collapses at the caller's gate:** the helper has no dedup of its own — it re-delivers. Wrap the test `onevent` in a `makeDedupeGate` (the caller's role) and assert a replayed event id (same id delivered pre-drop and again post-resubscribe) reaches the wrapped handler twice but passes the business callback once.
4. **Clean teardown:** `close()`/stop sets `stopped`; a post-stop `ensureHealthy()` is a no-op (no new subscribe).
5. **Overlap guard:** a second `ensureHealthy()` while the first is still awaiting `connect()` does not double-subscribe (`busy`).

Existing suites (`tests/crow-messages-*.test.js`, nostr-client unit tests, sharing tests) stay green. Also smoke `node servers/gateway/index.js --no-auth` boots clean.

## Deploy / verify

Adapter + `nostr.js` both change → restart:

- `pibot-gateways@crow-mpa` + `pibot-gateways@grackle` (adapter).
- gateways crow `:3001`, MPA `:3006`, grackle `:3002`, black-swan `:3001` (`nostr.js`).

No schema change. Sudo `8r00kly^` (crow/grackle), passwordless black-swan.

**Live-verify (no restart):** force a relay socket drop (or let `enablePing` kill a stalled socket), then confirm a freshly-sent DM is delivered **without** a `pibot`/gateway restart. Simplest signal: a 1:1 DM round-trips after a simulated drop. The 2026-06-25 harness pattern (sign a DM with the crow-mpa host instance key to the bot's derived pubkey, watch for the bot's reply) is the reference.

## Out of scope (note, do not fix here)

- `seenEventIds` in `subscribeToIncoming` is an unbounded Set (pre-existing). Not widened by this change; leave for a separate cleanup.
- Library `enableReconnect` is deliberately not used.
