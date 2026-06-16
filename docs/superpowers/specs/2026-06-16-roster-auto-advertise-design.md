# Roster auto-advertise — Crow Messages gateway (design)

**Status:** Design (approved in brainstorming 2026-06-16)
**Theme:** 12 (roster-uniformity) — the first "Future" bullet of the Crow Messages gateway arc.
**Builds on:** Plan 1 (transport / per-bot Nostr identity / ACL) + Plan 2 (sharing UX). See
`2026-06-15-crow-messages-gateway-design.md`.

## Problem

A bot owned by one of the operator's Crows is *already authorized* to be messaged from the
operator's other (paired) Crows when its Crow Messages gateway has `allow_paired_instances=true`.
But it is **invisible** on those other instances: the Messages list is built purely from the local
`contacts` table, which has no entry for a sibling instance's bot. Today the only way to start the
conversation is to know the bot's crow_id or follow a `?bot_invite=` deep link. The operator should
just *see* their own bots in every one of their Crows' Messages lists, with no per-device invite.

**Core insight:** this is a **discovery** feature, not an access-grant feature — surface a bot you
can already message, and make the first send authorize cleanly.

## Scope

In scope:

- A bot advertises to paired instances iff its Crow Messages gateway has `allow_paired_instances=true`.
- Advertisement reaches **all** non-revoked paired instances (all the operator's own Crows). No
  per-peer selection (YAGNI — they are all the same operator).
- Advertised bots appear as **read-only "available" roster entries** in each paired instance's
  Messages list, badged with the owning instance's label.
- Sending the first message **materializes** the bot into a normal local conversation and authorizes
  it on the owning instance via the existing bot-invite accept handshake.

Out of scope (later phases): cross-instance bot directory / sender-side picker for *non-owned* peers
(Theme 9); group / multi-party bot threads; advertising to contacts who are not paired instances.

## Architecture

Two instances, two roles:

- **Owner** — the instance whose pi-bots host runs the bot's `crow-messages` adapter. Source of
  truth for the bot identity + ACL.
- **Viewer** — a paired instance rendering its Messages panel. Pulls the owner's advertised bots and
  shows them.

(Every instance is both, for its own bots and its siblings' bots.)

### 1. Advertisement endpoint (owner side)

New **signed** federation route, alongside the existing ones in `servers/gateway/routes/federation.js`:

```
GET /federation/advertised-bots
```

- Auth: identical to the existing federation routes — `X-Crow-Signature` / `X-Crow-Timestamp` /
  `X-Crow-Nonce` + bearer, validated for a non-revoked paired instance. **Never** Funnel-reachable
  (network-exposure invariant; federation routes are private).
- Body: for each bot definition whose `gateways[]` includes a `crow-messages` gateway with
  `allow_paired_instances=true`, return:

  ```json
  {
    "bots": [
      {
        "bot_id": "…",
        "display_name": "…",
        "instance_id": "<this owner instance id>",
        "instance_label": "<human label of this Crow>",
        "messaging_pubkey": "<bot's x-only secp256k1 pubkey>",
        "relay_url": "<resolved nostr relay>",
        "invite_code": "<lazily-minted paired-roster bot invite>"
      }
    ]
  }
  ```

- **Bot identity parity:** derive the bot's messaging pubkey in the gateway via
  `loadInstanceSeed(dirname(botsDbPath()))` → `deriveBotIdentity(...)`, exactly as the adapter does
  (NOT `loadOrCreateIdentity()`), so the advertised key equals the adapter's subscription key.
- **Invite code:** a dedicated, long-lived **"paired-roster" invite** per advertised bot — minted
  lazily (and reused) via `generateBotInviteCode(...)` with `max_uses=null` (unlimited) and no
  expiry. It is stored in `bot_message_invites` like any other invite, tagged so it is
  distinguishable (e.g. `added_via`/label or a `kind='paired-roster'` marker) and idempotently
  reused across requests rather than re-minted each call. All of the operator's paired instances
  share one Nostr identity, so a single accept authorizes the shared sender pubkey for every sibling
  — one unlimited-use invite is sufficient and the simplest correct choice.

### 2. Pull + merge (viewer side)

In the Messages data layer (`servers/gateway/dashboard/panels/messages/data-queries.js`):

- Enumerate non-revoked paired instances (`crow_instances`, status `!= 'revoked'`).
- Fan out `GET /federation/advertised-bots` to each in **parallel**, with a short **per-peer
  timeout** (e.g. 2 s) and a small in-memory **TTL cache** (~60 s) so panel renders are not gated on
  live network round-trips. A peer that is offline / errors / times out is **silently omitted** — it
  must never block or break the panel.
- Merge the returned bots into the conversation list as synthetic **read-only "available" entries**,
  **excluding** any bot that already has a local materialized contact (so it does not appear twice).
- This is additive to `getUnifiedConversationList(db)`; the existing AI-chat + contacts merge is
  unchanged.

### 3. Display (viewer side)

In `servers/gateway/dashboard/panels/messages/html.js`:

- A distinct **"Bots on your other Crows"** section in the Messages list. Each entry shows the bot
  display name + a badge with the owning **instance label**.
- Entries are read-only until materialized: clicking opens a compose view; the bot graduates into the
  normal conversation list on first send.

### 4. Materialize on first send (viewer side)

In `servers/gateway/dashboard/panels/messages/api-handlers.js`, a new action (e.g.
`message_advertised_bot`) that, on the **first** send to an advertised bot:

1. Runs the existing **`crow_accept_bot_invite`** flow with the advertised `invite_code`. This both
   creates the **local `contacts` row** for the bot (the existing accept path already inserts a
   contact + subscribes) and sends the signed acceptance back to the owner, whose adapter calls
   `upsertAclFromAccept(...)` → the owner-side `bot_message_acl` now authorizes this sender. This is
   the **proven Plan-1/2 path** and does not rely on the (unverified-for-siblings)
   `allow_paired_instances` runtime pubkey match.
2. Flags the new contact `origin='advertised'` (new column on `contacts`, default `NULL`) so it can
   be distinguished from manually-added / invite-accepted contacts for cleanup.
3. Sends the operator's message via the normal `crow_send_message` path.

Subsequent sends are ordinary contact messages — no special-casing.

### 5. Cleanup

- When a bot **stops advertising** (drops out of the owner's `/federation/advertised-bots` response —
  e.g. `allow_paired_instances` toggled off, or the bot deleted) **and** has no message history, the
  viewer drops it from the "available" section automatically (it is pull-derived). A *materialized*
  contact (origin='advertised') with no history is pruned on the next render; one with history is
  left in place but no longer auto-surfaced.
- On **unpair** (instance removed/revoked), advertised entries from that instance disappear (pull is
  gated on non-revoked `crow_instances`); materialized `origin='advertised'` contacts tied to that
  instance are removed.

## Data model changes

- `contacts.origin` — new nullable TEXT column (values: `NULL` legacy/manual, `'advertised'`).
  Added in `scripts/init-db.js` (guarded `ALTER TABLE … ADD COLUMN` for existing hosts). This is the
  only schema change; it needs a fleet `node scripts/init-db.js` per data dir at deploy.
- `bot_message_invites` — reuse as-is for the paired-roster invite (an unlimited-use, non-expiring
  row, tagged so it is reused not re-minted). No schema change required if an existing column can
  carry the tag; otherwise an optional `kind` TEXT column.

## Error handling

- Peer fetch failure (offline, timeout, 401/5xx) → that peer's bots are omitted; panel renders with
  whatever succeeded; log at debug, no user-facing error.
- Invite accept failure on materialize → surface a clear "couldn't reach that Crow's bot" message;
  do **not** create a half-state contact (accept is the gate — only create the contact when accept
  succeeds, which the existing accept path already does).
- Cache staleness vs. instant revoke: the TTL is short (~60 s); a bot de-advertised mid-cache may
  still show briefly, but sending still requires a live accept against the owner, so a revoked bot
  cannot actually be messaged.
- Kiosk guard: the send path already runs through `crow_send_message` / `crow_accept_bot_invite`,
  both of which honor `isKioskActive`.

## Security

- The advertisement endpoint exposes bot messaging pubkeys + a paired-roster invite **only** to
  authenticated, non-revoked paired instances over the signed federation transport. It must remain
  outside `PUBLIC_FUNNEL_PREFIXES` (network-exposure invariant — run `tests/auth-network.test.js` if
  any gateway middleware/routing is touched).
- Unlimited-use invite is acceptable **because** it is only ever returned to the operator's own
  authenticated paired instances and authorizes only the operator's own shared Nostr identity.
- Fail-closed everywhere (mirror `authorizeSender`): any error in enumerating/serving advertised bots
  returns an empty list rather than leaking.

## Testing

- **Owner endpoint**: returns only `allow_paired_instances` bots; correct messaging pubkey (matches
  `deriveBotIdentity`); reuses (does not re-mint) the paired-roster invite; rejects unsigned /
  non-paired callers; empty list on error.
- **Viewer merge**: parallel fetch with one slow/failing peer still renders; advertised bots merged;
  already-materialized bots not duplicated; TTL cache honored.
- **Materialize**: first send runs accept → creates `origin='advertised'` contact → message sent;
  accept failure creates no contact; second send is an ordinary contact send.
- **Cleanup**: de-advertised no-history bot drops from the list; unpair removes that instance's
  advertised + materialized-no-history entries.
- **Network invariant**: `tests/auth-network.test.js` still passes; the new route is not
  Funnel-public.
- Run with `node --test --test-force-exit tests/<file>.test.js` (force-exit avoids Nostr-relay
  hangs). No aggregate runner.

## Files (anchors)

- Owner endpoint: `servers/gateway/routes/federation.js` (new route) + a small helper to enumerate
  advertised bots + lazily mint/reuse the paired-roster invite (likely in
  `servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js`, which already mints invites
  via `generateBotInviteCode`).
- Bot identity: `servers/sharing/identity.js` (`loadInstanceSeed`, `deriveBotIdentity`,
  `generateBotInviteCode`).
- Viewer pull/merge: `servers/gateway/dashboard/panels/messages/data-queries.js`.
- Viewer display: `servers/gateway/dashboard/panels/messages/html.js`.
- Viewer materialize: `servers/gateway/dashboard/panels/messages/api-handlers.js`
  (reuses `crow_accept_bot_invite` in `servers/sharing/tools/contacts.js`).
- Schema: `scripts/init-db.js` (`contacts.origin`, optional invite `kind`).
- Paired-instance enumeration + signed-fetch transport: `servers/gateway/instance-registry.js`,
  `servers/sharing/peer-manager.js`, the existing federation client used to call peer routes.

## Gotchas carried forward (from Plan 1/2)

- **Identity parity**: derive bot keys via `loadInstanceSeed(dirname(botsDbPath()))`, not
  `loadOrCreateIdentity()`.
- **Dual DB clients, one crow.db**: gateway/UI = libsql (`db.execute`); pi-bots host =
  better-sqlite3 (`db.prepare`). The advertisement endpoint runs in the gateway (libsql).
- **ACL keyed on the signed `event.pubkey`** (x-only 64-hex); `contacts.secp256k1_pubkey` is 66-hex
  compressed — match trailing 64.
- **CSRF**: the new Messages POST action needs `csrfInput(req)`; use explicit action inputs
  (`actInputs()` pattern), not the `save_`-prefixed `hidden()` helper.
- **Commits**: positional-path `git commit <paths>`; `git add` new test files first;
  `git pull --rebase` before push.
