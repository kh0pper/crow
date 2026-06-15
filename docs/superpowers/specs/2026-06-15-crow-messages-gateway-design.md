# Crow Messages as a first-class Bot Builder gateway

**Status:** Design (approved in brainstorming 2026-06-15). First build = the gateway end-to-end: per-bot identity, the pi-bots transport adapter, invite-based sharing, and the non-technical Bot Builder UX. Roster auto-advertise, a cross-instance bot directory, and group threads are explicitly deferred.

## Problem

Crow bots can be reached over Gmail, Discord, Telegram, and Slack — but **not over Crow Messages**, the instance's own peer-to-peer DM system (Nostr-encrypted, between paired instances and contacts). The Bot Builder gateway dropdown even carries the placeholder `{ value: "crow-messages", label: "Crow Messages", available: false }` (`servers/gateway/dashboard/panels/bot-builder/editor.js:240`). The operator's intent: "Crow Messages should be a first-class gateway."

A first-class version means: a bot is **directly addressable** (peers DM the bot, not a generic instance endpoint), **multiple bots per instance** each have their own identity, the bot answers **as itself** (its persona, skills, MCP tools, and per-thread memory — not a generic one-shot), and a **non-technical user can share access with a link** without ever seeing a key, an allowlist, or a `crow:` id.

## Goal

Ship the Crow Messages gateway end-to-end for v1:
1. Each bot gets its own derived `crow:` identity (no new secret at rest).
2. A pi-bots transport adapter subscribes for the bot, drives the real pi bridge, and replies over Nostr — identical in shape to the existing Telegram/Slack host adapters.
3. Access is **default-deny**, opened by an **invite the operator shares as a link/QR** from the Bot Builder; the recipient taps **"Add & message"** once and is authorized.
4. The Bot Builder UI makes share/manage/revoke trivially easy; all crypto/ACL internals sit behind an "Advanced" disclosure.

Non-goals are in *Out of scope*.

## Decisions locked in brainstorming

| # | Decision | Choice |
|---|----------|--------|
| 1 | Who may message a bot | Both your own paired instances AND general contacts, one path, gated per-bot by an allowlist. |
| 2 | Bot identity mechanism | **Derived per-bot key** — own `crow:` id + Nostr keypair derived from instance seed + bot id; no new secret stored. |
| 3 | Discovery (v1) | **Shareable address/invite**; reuse the existing Crow Messages UI. No roster propagation, no new sender-side picker. |
| 4 | Trust model | **Invite-authorizes + default-deny**; plus manual allowlist entries and an "allow any paired instance" toggle. Unauthorized messages dropped silently. |
| 5 | Architecture | **pi-bots host adapter** (`scripts/pi-bots/gateways/crow-messages.mjs`), hosted by `gateway_runner` like Telegram/Slack; drives `bridge.handleInbound` so the bot answers as itself. |

## Concepts

- **Bot identity** — a per-bot Nostr/`crow:` identity derived from the instance seed. `{ crow_id, ed25519_pubkey, secp256k1_pubkey, secp256k1_priv }`, recreatable in any process (gateway or pi-bots) from `~/.crow`'s seed; never stored.
- **Bot address** — what a sender needs to DM the bot: `{ crow_id, secp256k1_pubkey, relay_hint[] }`. Carried inside an invite.
- **Invite** — a per-bot, regenerable token plus the bot address. Sharing it is how the operator grants access; accepting it is how a sender becomes authorized.
- **ACL entry** — one authorized sender for one bot, keyed on the **secp256k1 pubkey** (the only identity verifiable from a raw inbound DM), with `crow_id`/`display_name` as labels.
- **Authorization** — the adapter lets a message through iff the sender's secp256k1 pubkey is in the bot's ACL, OR `allow_paired_instances` is on and the pubkey matches a `crow_instances` row.

## Identity (derived per-bot key)

Add a pure helper to `servers/sharing/identity.js`:

```
deriveBotIdentity(instanceSeed, botId) -> { crowId, ed25519Pub/Priv, secp256k1Pub/Priv, secp256k1Pubkey, ed25519Pubkey }
```

It namespaces the existing `deriveKey`/`deriveIdentity` logic with a bot label, e.g. `botSeed = deriveKey(instanceSeed, "crow-bot-v1:" + botId, 32)` then the same Ed25519 + secp256k1 derivation `deriveIdentity` already performs (`identity.js:163-184`). Because it is a pure function of `(instanceSeed, botId)`:
- the **pi-bots adapter** derives the bot's keypair to subscribe/decrypt/sign;
- the **Bot Builder editor** derives the bot's `crow_id` to display its address;
- nothing per-bot is written to disk.

`crow_id` uses the existing `computeCrowId(ed25519Pub)` scheme (`identity.js:90-96`) so a bot id is indistinguishable in form from an instance/contact id.

## Transport + turn (pi-bots host adapter)

New `scripts/pi-bots/gateways/crow-messages.mjs`, exporting the standard adapter contract (`type, mode, configFields, gatewayHint, checkRequirements, start`) and registered in `scripts/pi-bots/gateways/index.mjs` `HOST_ADAPTERS`. `gateway_runner.mjs` already discovers host-managed gateways from `pi_bot_defs.definition.gateways[]` and calls `start({ bot_id, gw, log })` per bot.

```
type = "crow-messages"
mode = "nostr"
configFields = [ /* allow_paired_instances (bool); the share/manage UI is custom — see UX */ ]
checkRequirements() -> relays reachable + nostr available
gatewayHint(threadId) -> a per-turn prompt line (e.g. "This message arrived over Crow Messages.")
start({ bot_id, gw, log }) -> { stop() }
```

`start()`:
1. Derive the bot identity (`deriveBotIdentity(seed, bot_id)`); resolve the relay list from the existing sharing relay config.
2. Open a Nostr subscription `{ kinds:[4], "#p":[bot_secp_pubkey] }` across the relays. (One subscription per crow-messages bot — fine at home-lab scale; a shared relay pool in the runner is a permissible optimization.)
3. On each event, NIP-44-decrypt with the bot's secp key (`nip44.v2`), then route by payload:
   - **`bot_invite_accept` control** → validate the token (see *Invites*); on success insert/refresh the ACL row from the sender's advertised identity, increment token uses, and send a friendly ack ("You can chat with `<bot name>` now."). No pi turn.
   - **normal chat** → **authorize** (ACL ∪ paired-instance toggle). If authorized: enqueue via a `base.mjs` `SerialQueue` and call:
     ```
     handleInbound({
       bot_id,
       gateway_thread_id: "crow-messages:" + sender_secp_pubkey,
       user_message: text,
       gateway_type: "crow-messages",
       sendReply: async (chunk) => publishNostrDM(botKey, sender_secp_pubkey, chunk),
       log,
     })
     ```
     `sendReply` publishes a NIP-44-encrypted `kind:4` reply **from the bot's key** to the sender pubkey, via `base.mjs` `chunkedSend`. If **unauthorized**, drop silently (optionally one-time "this bot hasn't been shared with you" is out of scope; v1 drops).
4. `stop()` closes the subscription/relay handles.

Reuses `base.mjs` (`chunkedSend`, `splitMessage`, `SerialQueue`, `passesAllowlist`). No typing indicator (Nostr has none). **Bot turns never write the operator's personal `messages` table** — that store is the human Crow Messages UI's; per-thread bot memory is pi's job, keyed by `gateway_thread_id`.

The pi-bots layer gains its first Nostr usage. The primitives (`nostr-tools` `finalizeEvent`/`nip44`, relay connect/subscribe/publish) mirror `servers/sharing/nostr.js`; factor the minimal client into a small shared module the adapter imports (avoid duplicating the full `NostrManager`).

## Invites (the sharing mechanism)

- **Generate (owner):** the Bot Builder "Share access" action mints a row in `bot_message_invites` (random token, optional `expires_at`/`max_uses`) and renders a **link + QR** encoding the bot address (`crow_id`, `secp256k1_pubkey`, relay hint) + token. "New link" rotates: it revokes prior tokens for that bot (so old links die) and mints a fresh one.
- **Accept (recipient):** the link is a deep link that opens the recipient's Crow and shows an **"Add & message `<bot name>`"** card. Tapping it sends a NIP-44 DM to the bot pubkey: `{ type:"crow_social", subtype:"bot_invite_accept", token, sender:{ crow_id, ed25519_pubkey, secp256k1_pubkey, display_name } }`. The adapter validates the token and inserts the ACL row. Modeled on the existing instance-invite link + `onInviteAccepted` flow (`servers/sharing/boot.js:208-232`).
- **Landing route:** a dashboard route (and/or `crow:`-scheme deep link) renders the accept card and triggers the accept-send from the recipient's identity. Reuse the instance-invite landing pattern; this route is **not** funnel-exposed beyond what the existing invite flow already allows.

## Trust / authorization

- **Default-deny.** A bot's ACL starts empty; with `allow_paired_instances` off, nobody can message it until an invite is accepted or an entry is added.
- **Authorize by secp256k1 pubkey** (verifiable from the event). `crow_id`/`display_name` are labels carried in the invite-accept or resolved from `contacts`.
- **Sources:** invite-accept (added_via `invite`), manual add via Advanced (added_via `manual`), or `allow_paired_instances` matching a `crow_instances` row (no ACL row needed).
- **Revoke:** remove the ACL row ("Remove" in the manage list); "New link" rotates the token so outstanding invites stop authorizing new senders. Removing a sender stops future turns immediately (checked per inbound).
- The adapter's authorization check is fail-closed: any error → drop.

## Sharing UX (non-technical — the headline)

All in **Bot Builder → the bot's Gateways tab** when type = Crow Messages. The default surface shows only:

- **"Share access"** button → opens a small panel with a **copyable link + QR** and one line: "Send this to anyone you want to let chat with `<bot name>`." No ids, no keys.
- **"Allow my other Crow devices"** checkbox → flips `allow_paired_instances`; covers the operator's own mesh with zero per-person sharing.
- **"Who can message `<bot name>`"** — a plain list of **names**, each with **Remove**. (Rows = ACL entries.)
- **"New link"** — regenerate/rotate (clean revoke-all of old links).

**Recipient experience:** tap link → Crow opens → **"`<bot name>` would like to chat — [Add & message]"** → one tap → the bot appears in their normal **Messages** list, authorized. No token, allowlist, or address ever shown. If they don't have Crow, the link first lands on a "get/open Crow" page.

**Advanced disclosure (collapsed):** the bot's raw `crow:` address (copyable), manual add-by-pubkey/`crow:` id, and per-invite token settings (expiry/uses). Never on the default path.

`editor.js`: flip `crow-messages` to `available: true`; render this custom config block for the type. `api-handlers.js`: persist `def.gateways=[{ type:"crow-messages", allow_paired_instances: bool }]`. Identity is derived (not stored); the access list and invites live in their tables (below). Register `crow-messages` in `gateways/index.mjs` `capabilitiesForUI()`/`STATIC_META` so the type is selectable and host-discovered.

## Data model (`scripts/init-db.js`, local-only)

```
bot_message_acl(
  id            INTEGER PK,
  bot_id        TEXT NOT NULL,
  sender_pubkey TEXT NOT NULL,         -- secp256k1 hex; the authorization key
  crow_id       TEXT,                  -- label
  display_name  TEXT,                  -- shown in "Who can message"
  added_via     TEXT NOT NULL,         -- 'invite' | 'manual'
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(bot_id, sender_pubkey)
);
bot_message_invites(
  id          INTEGER PK,
  bot_id      TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT,                    -- nullable = no expiry
  max_uses    INTEGER,                 -- nullable = unlimited
  uses        INTEGER NOT NULL DEFAULT 0,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
```

Both are per-instance operational state (never synced). `allow_paired_instances` lives in the bot's `def.gateways[]` JSON (it's bot config, edited with the rest of the bot).

## Registry / plumbing summary

- `servers/sharing/identity.js` — add pure `deriveBotIdentity(seed, botId)`.
- `scripts/pi-bots/gateways/crow-messages.mjs` — new adapter (transport + turn).
- small shared Nostr-client helper (derive-aware publish/subscribe) imported by the adapter.
- `scripts/pi-bots/gateways/index.mjs` — register in `HOST_ADAPTERS` + `capabilitiesForUI()`/`STATIC_META`.
- `servers/gateway/dashboard/panels/bot-builder/editor.js` — flip available; render the share/manage UX + Advanced.
- `servers/gateway/dashboard/panels/bot-builder/api-handlers.js` — persist the gateway record; handle Share/New-link/Remove/Advanced-add actions (mint invite, rotate, delete ACL, insert manual ACL).
- invite **landing/accept route** (dashboard route + deep link) — reuse the instance-invite pattern.
- `scripts/init-db.js` — `bot_message_acl`, `bot_message_invites`.

## Security considerations

- **Default-deny**, fail-closed authorization; unauthorized inbound is dropped with no side effects. Authorization is on the cryptographically-verifiable secp256k1 pubkey of the signed event, not on any self-claimed field.
- **Invite tokens** are bearer capabilities: random, optionally single-use/expiring, and **rotatable** ("New link" revokes prior tokens). A leaked link only lets the holder *request* access via the accept handshake; the bot still records exactly who accepted (their pubkey) and the owner can Remove them.
- **Per-bot key isolation:** derived keys are distinct per bot; compromise of one bot's derived key (which lives only in memory, recreatable from the seed) does not expose the instance identity or other bots beyond what the shared seed already implies. The instance seed remains the single root secret (unchanged from today).
- The invite **landing/accept route** stays inside the existing dashboard/invite exposure envelope; no new funnel-public surface.
- Bot replies are sent **from the bot key**, so a sender never learns the instance's own identity key from chatting with a bot.

## Testing

- **`deriveBotIdentity`** — determinism (same seed+bot id → same keys/`crow_id`), distinctness across bot ids, address shape.
- **Authorization** — invite-accept inserts an ACL row and subsequent messages from that pubkey pass; unlisted pubkey dropped; `allow_paired_instances` lets a `crow_instances` pubkey through without an ACL row; Remove revokes (next message dropped).
- **Invites** — token validate/expire/`max_uses`/revoked; "New link" rotation invalidates the prior token.
- **Adapter routing** — a decrypted authorized chat event calls `handleInbound` with `gateway_thread_id = "crow-messages:"+pubkey` and `sendReply` publishes a chunked encrypted reply from the bot key; a `bot_invite_accept` event takes the ACL path and never starts a pi turn; an unauthorized event starts no turn and sends nothing.
- **No-leak** — bot turns do not write the `messages` table.
- **Integration-style** — round-trip against a mock relay: invite-accept → authorized chat → reply, using a stub `handleInbound`.

## Out of scope (v1)

- **Roster auto-advertise** to paired instances (bots auto-appearing in peers' Messages) — overlaps the Theme 12 roster-uniformity wave.
- **Cross-instance bot directory/picker** (browse all bots across peers) — Theme 9 (Bot Builder UX) follow-up.
- **Group/multi-party bot threads** — v1 is 1:1 (sender ↔ bot).
- **Writing bot conversations into the personal `messages` store** or surfacing them in the human Messages UI as owner-visible threads.
- **Auto-rotating derived keys** / per-bot seed rotation — the instance seed is the single root.

## Future (validates the shape; each a later follow-up)

- Roster advertise → bots appear in paired peers' Messages automatically (Theme 12).
- Directory/picker to browse and message any bot on any peer (Theme 9).
- Group threads / bot-in-a-room.
- Reuse the adapter pattern for a Signal/Matrix-style bridge (the placeholder `signal` type).
