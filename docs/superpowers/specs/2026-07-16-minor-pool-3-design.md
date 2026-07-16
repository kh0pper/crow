# Minor pool ×3 — heal-log rate-limit, room fan-out cap, dead feed-key-announce path

**Date:** 2026-07-16 · **Scope:** the three items left unshipped by the 2c follow-up pool
(PR #198; recorded in the pool-complete ledger block and memory). All three are small and
mechanical; per the arc plan §2 this spec is brief and the hard gate is the adversarial
diff review.

## Item 1 — tailnet refresh heal-failure log rate-limit (2d T8 note)

**Defect.** `startTailnetSyncClients → refresh()` (`servers/sharing/tailnet-sync.js:543`)
warns `[tailnet-sync] refresh heal for <id>…: <msg>` on EVERY 60s rescan for a
persistently failing `initInstance` — one log line per minute per wedged peer, forever.
Same class as the pre-#144 silent-retry problem inverted: not silent, but unbounded spam
that buries real signal (the known-benign log classes list keeps growing because of
exactly this shape).

**Fix.** Per-peer failure counter in the `startTailnetSyncClients` closure (Map
`peerId → count`), same observability contract as the F1 crash guard
(`nostr-crash-guard.js`): log at counts 1, 10, 100, 1000… (`Number.isInteger(Math.log10(n))`),
message carries `#n`. On a SUCCESSFUL heal for a peer with a non-zero counter, log one
`recovered after n failures` line and reset the counter — so a new failure episode logs
immediately again and the episode boundary is visible. Counter entries are deleted in the
existing out-of-scope cleanup loop (where dialers are stopped) so the Map cannot grow
unboundedly across re-pairs.

**Tests** (harness = the existing `__refreshForTest` handle; stub `db.execute` returning
one peer row without `gateway_url` so no PeerDialer spawns; stub manager whose
`initInstance` throws):
- T1a RED: 12 consecutive failing refreshes → exactly 2 heal-warn lines (#1, #10). Old
  code emits 12 → red.
- T1b: fail ×3 → succeed once → `recovered after 3` logged; fail again → immediate `#1`.
- Mutation: comment out the log10 gate → T1a red; comment out the reset-on-success →
  T1b red.

## Item 2 — onSocialMessage room fan-out publish stall (2c spec §F2 adjacent gap, R1 item 10)

**Defect.** `fanOut()` (`servers/sharing/room-fanout.js`) serially awaits
`nostrManager.sendControl(c, envelope)` per member with NO time bound. The call chain is
`nostr.js subscribeToIncoming → await onSocialMessage → room-inbound
handleRoomMessageInbound → await fanOut`. `sendControl → _sendControlEvent →
safeRelayPublish → relay.publish()` waits for the relay's OK frame; a half-open socket
stalls it indefinitely, and the serial loop compounds it per member. **Review
correction (R1 finding 1):** nostr-tools dispatches `onevent` WITHOUT awaiting it
(abstract-relay.js:423), so a wedged fan-out never froze the whole subscription — the
real damage is that ONE message's handling wedges forever with N× serial compounding,
plus a leaked pending promise per member. Still worth bounding; the "freezes the
subscription" framing in earlier drafts was wrong. (Recorded as deliberately out of
scope in 2c §F2 — "candidate for a future pool" — this is that pool.)

**Fix.** Same sender-bounding pattern as 2c C2a/C2b, applied inside `fanOut`:
- Per-member cap: `Promise.race([sendControl(...), capTimer])`, default `capMs = 10_000`,
  injectable via a new `capMs` option (tests use small values). Timer cleared in
  `finally`. A capped member counts as `failed` and logs through the existing `log`
  callback. Post-cap rejections of the abandoned `sendControl` are absorbed by the race
  (reaction attached at race time — the empirically proven #198 fact); they can never
  reach the process crash guard.
- Fan-out shape: serial `for` loop → `Promise.allSettled` over the non-excluded members,
  so N wedged members cost ≈ one cap, not N× (the R1-2.3 bound-the-fan-out-not-just-the-
  send rule; push precedent `servers/gateway/push/web-push.js:57`).
- Preserved semantics: `excludeContactId` skip, best-effort per member, `{sent, failed}`
  return shape, per-failure `log` line. Rooms have no cross-member ordering semantics
  (mirror of push). `sent`/`failed` become completion-ordered — all four call sites
  (`room-inbound.js:113`, `room-send.js:26` and `:30`,
  `dashboard/panels/messages/api-handlers.js:310`) ignore the result, and the existing
  test already sorts (R1 finding 5 corrected the earlier "one consumer" claim).

**Tests** (existing direct-import harness in `tests/room-fanout.test.js`):
- T2a RED: one member's `sendControl` never settles (`capMs: 50`) → old fanOut never
  resolves (asserted via an outer timer race) → red; new: resolves, hung member in
  `failed`, healthy member in `sent`.
- T2b: three hanging members, `capMs: 100` → total wall-clock < 2×capMs (parallel bound;
  guards regression to a serial capped loop).
- T2c: existing exclusion/sent/failed test keeps passing unchanged.
- Mutation: drop the cap → T2a red; revert to serial loop → T2b red.

## Item 3 — peer-manager `feed-key-announce` dead path

**Defect.** `_handleMessage case "feed-key-announce"` (`servers/sharing/peer-manager.js:342`)
is doubly broken: (1) NOTHING in the codebase ever sends that message type (grep: the
case statement is the sole occurrence) — feed keys ride the challenge /
challenge-response piggyback, and rotation rides tailnet-sync's in-band exchange (2d);
(2) if it EVER fired it would call `onInstanceKeyReceived(state.remoteCrowId, …)` —
passing a crow_id where the handler (boot.js:850) requires an INSTANCE id. crow_id is
shared fleet-wide, so it can never key a `crow_instances` row: the write would silently
no-op at best, and a future refactor of `onInstanceKeyReceived` could turn it into a
cross-instance key mis-write. The challenge-response path three cases above documents
this exact requirement ("Must include the peer's instance_id … crow_id is shared across
all paired instances").

**Fix.** Delete the case; leave a short comment at the site recording why (never sent +
wrong-keyed since birth), so it isn't re-added naively. Deleting beats "fixing" it:
a correct announce would need a new message shape (instance_id field) AND a sender —
design work for whichever future item actually needs an announce, not this one.

**Tests:** regression pin — drive `_handleMessage` directly (constructed `PeerManager`
with a stub identity, authenticated state) with a `feed-key-announce` message and assert
`onInstanceKeyReceived` is NOT invoked. Red on the old code (it IS invoked, mis-keyed) →
green after deletion.

## Non-goals

- No env knob for the fan-out cap (push's `CROW_PUSH_SEND_TIMEOUT_MS` is push-scoped;
  a knob here is speculative — the option param covers tests).
- No announce-message redesign (item 3 is a deletion, not a feature).
- No change to `safeRelayPublish` itself — its connect/publish waits are what the cap
  bounds; unwrapping them individually would re-litigate 2c C2a for no added bound.

## Ship gates

Suite on scratch env (baseline 1994 pass / 2 known bundles-validate-install fails /
0 skips — any 3rd failure is new); check-ports (exactly one error line: `Port 8090
(capstone-tracker)`); build-registry `--check`; adversarial diff review (fresh
subagent, READY-TO-MERGE verdict required); mutation checks above run and recorded.
