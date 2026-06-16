# Cross-instance bot directory — design

**Date:** 2026-06-16
**Status:** approved (brainstorming)
**Phase:** Crow Messages gateway arc — deferred "Future" phase 2 (cross-instance bot directory / picker, Theme 9)

## Guiding principle

**A bot is a contact.** The codebase already treats a materialized bot as an ordinary `contacts` row that appears in the unified Messages list (the only marker today is the unreliable `origin`). This phase names that grain: the directory is a *discover-and-add* surface for bots that live on the operator's other Crows but aren't in the local roster yet. "Add" / "Message" produce ordinary contacts flagged `is_bot=1`. No parallel bot model. This is the seam for the future group phase — a group is a set of participant contacts, some flagged `is_bot`.

The peer set is the operator's own trusted Crow fleet (crow / MPA / grackle / black-swan) over the existing signed federation transport built for roster auto-advertise. There is **no new cross-owner ACL** — same trust boundary, same `GET /dashboard/advertised-bots` route + `advertised-bots-cache.js`.

## What already exists (reused)

- **Federation transport:** `GET /dashboard/advertised-bots` (`servers/gateway/routes/federation.js`), HMAC-gated by `advertisedBotsVerify`, dispatched via the signed-peer allowlist in `dashboard/index.js`. `servers/gateway/dashboard/advertised-bots-cache.js` does the per-peer signed fetch (never throws).
- **Advertisement payload:** `buildAdvertisementPayload` (`servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js`) enumerates `allow_paired_instances=true` bots and emits `{bot_id, display_name, instance_id, instance_label, messaging_pubkey, invite_code}`.
- **Materialize:** `crow_accept_bot_invite` (`servers/sharing/tools/contacts.js`) parses the signed invite, adds the bot as a contact, sends the `bot_invite_accept` DM. Used by the deep-link card, the phase-1 paste form, and the (being-removed) `message_advertised_bot` action.
- **Aggregate (superseded):** `getAdvertisedBotItems` + `pruneStaleAdvertisedContacts` in `messages/data-queries.js`.
- **Contacts panel:** `servers/gateway/dashboard/panels/contacts.js` (+ its `contacts/` modules) — roster management with manual add + vCard import + contact groups (`contact_groups`/`contact_group_members` tables exist).
- **Unified list:** `getUnifiedConversationList` (`messages/data-queries.js`) merges AI chats + peer contacts.

## Decisions locked in brainstorming

1. **Form factor:** Approach A — the directory is a shared component surfaced in BOTH the Contacts panel (as an add-source) and the Messages "+" picker. Integrate, don't mirror; no standalone panel.
2. **Bot metadata:** display name + optional operator-authored public **tagline** only. NO skills list. The private `def.system` prompt is never broadcast.
3. **Inline strip:** the current per-bot send-box `advertisedSection` in Messages collapses to a compact "N bots available on your other Crows → Browse" entry that opens the directory.
4. **Already-added bots:** the directory shows ALL advertised bots; ones already in contacts show an "Added ✓" badge (opens the chat) instead of Add/Message.

## 1. Data model

- **`contacts.is_bot`** `INTEGER DEFAULT 0` — new column, added by a guarded `addColumnIfMissing` in `scripts/init-db.js` (**schema-change deploy**). Migration backfills `is_bot = 1 WHERE origin = 'advertised'` (the reliably-known bots). Going forward it is set at materialize time (§2).
- **Tagline** — an optional operator-authored public string stored **in the bot def JSON**, on the crow-messages gateway entry: `def.gateways[].description` (type `crow-messages`). No schema change. Bounded length (e.g. ≤ 140 chars) enforced on save.

## 2. Single point that marks a contact as a bot

`crow_accept_bot_invite` (`servers/sharing/tools/contacts.js`) sets `is_bot = 1` when it inserts/links the contact. Every materialize path routes through this tool (deep link, phase-1 paste form, directory Add, directory Message), so one change covers all of them. (On the new-contact path only — never relabel a pre-existing contact, mirroring the existing `origin='advertised'` discipline.)

## 3. Advertisement payload

`buildAdvertisementPayload` adds `description` to each entry, sourced from the bot's crow-messages gateway config (`def.gateways[].description`, the tagline). Absent/empty → omit the field. Viewers tolerate its absence (back-compat with peers still on the old payload).

## 4. Shared directory component

### Data: `getBotDirectory(db)` (`messages/data-queries.js`, supersedes `getAdvertisedBotItems`)
- Resolve trusted peers (`getTrustedInstances`, minus self), fan out via the advertised-bots cache (`Promise.allSettled`, never throws).
- Build entries `{botId, displayName, description, instanceId, instanceLabel, messagingPubkey, inviteCode, added, contactId}`. `added`/`contactId` from a pubkey match (trailing-64, lowercased) against `contacts` (including blocked — a blocked bot is still "known", not offered).
- **Show all** advertised bots (do NOT exclude added ones). Dedup by messaging pubkey across peers.
- Group by instance: return `{ groups: [{ instanceId, instanceLabel, bots: [...] }], total, notAddedCount }`.
- Keep `pruneStaleAdvertisedContacts` (call it with the live pubkey set, guarded `if (live.size > 0)` as today).

### Render: `servers/gateway/dashboard/shared/bot-directory.js` (NEW)
- `buildBotDirectory({ groups, context, csrf, lang })` → HTML. `context` ∈ `'messages' | 'contacts'`.
- Collapsible per-instance group headers; a client-side search `<input>` (filters by name + tagline). Per bot: display name (escaped), tagline (escaped), instance badge.
- Actions per bot:
  - `added` → "Added ✓" link that opens the chat (Messages context) or the contact (Contacts context).
  - not added, `context='messages'` → **Add** and **Message** buttons.
  - not added, `context='contacts'` → **Add** button.
- All POST forms carry `${csrf || ""}`. All user-visible strings escaped via `escapeHtml`.

### Client JS
- Search filter (hide non-matching rows), group collapse/expand, modal open/close. Mirrors the existing `msgShowInviteDialog`/popover patterns; attach-once listeners (Turbo-safe).

## 5. Surfaces

- **Messages "+" popover:** new **"Message a Bot"** item (`onclick` opens the directory modal). The modal renders `buildBotDirectory({ context: 'messages' })`.
- **Messages inline strip:** replace the `advertisedSection` send-box rows with a compact "**{notAddedCount} bots available on your other Crows → Browse**" affordance that opens the same modal. Hidden when `notAddedCount === 0`. The `message_advertised_bot` action + its handler are removed.
- **Contacts panel:** a new **"Browse Crow bots"** add-source (beside manual add / vCard import) that opens the directory (`context: 'contacts'`).
- **Bot badge:** `getUnifiedConversationList` selects `is_bot`; the Messages avatar/list render and the Contacts roster render show a small "bot" badge where `is_bot=1`.

## 6. Materialize actions

- **Add** → POST → `crow_accept_bot_invite(invite_code)` (materializes the contact, sets `is_bot=1`, sends the accept DM). No user message. Redirect back to the originating panel.
- **Message** → same materialize, then redirect to `/dashboard/messages?open=<contactId>`. There is **no existing auto-select-on-load mechanism** (`msgSelectItem(type,id)` is click-driven only), so this adds a small client hook: on load, if `?open=<id>` is present, call `msgSelectItem('peer', id)` to open that conversation. The action handler resolves the new contact's integer id (by the bot `crow_id` parsed from the invite code) to build the redirect. No forced message text — the user types in the normal chat box. If resolving the id fails, fall back to a plain `/dashboard/messages` redirect (the new bot is in the list).

These reuse/extend the existing `accept_bot_invite` action handler in `messages/api-handlers.js` (and a sibling in the contacts panel's POST handler). `message_advertised_bot` is removed (the "send this exact text" flow is gone with the inline strip).

## 7. Error handling

- Malformed/expired invite code → `crow_accept_bot_invite` returns `isError` → handler logs + redirects (nothing materialized). Same as phase 1.
- Offline/unreachable peer → silently omitted by the cache (`Promise.allSettled`, never throws).
- Empty directory → the Browse entry / picker shows an empty state; the collapsed strip is hidden.
- `getBotDirectory` never throws (a bad peer is dropped); the panels render with an empty directory on total failure.

## 8. Testing

- `getBotDirectory`: grouping by instance; `added`/`contactId` pubkey match (02/03 parity via trailing-64); dedup across peers; shows-all (added not excluded); never-throws on a rejected peer fetch.
- `buildAdvertisementPayload`: includes `description` when the gateway config sets it; omits it when unset.
- `crow_accept_bot_invite`: sets `is_bot=1` on a newly created contact; does not relabel a pre-existing contact.
- init-db migration: `contacts.is_bot` exists; backfill sets `is_bot=1` for `origin='advertised'` rows and leaves others at 0.
- `bot-directory.js` render: per-instance groups; search input present; context-specific actions (Add/Message vs Add); "Added ✓" for added bots; CSRF token present; all interpolated strings escaped.
- Messages: collapsed Browse entry shows `notAddedCount` and is hidden at zero; "Message a Bot" popover item present and wired; the `?open=<id>` on-load hook selects the conversation when present and is a no-op otherwise.
- Bot badge: `getUnifiedConversationList` returns `is_bot`; the badge renders for bots and not for humans.
- i18n completeness for all new keys (en+es) — asserted indirectly via render (raw key must not leak; es string asserted explicitly since `t()` falls back to en silently).

## 9. Out of scope

- Cross-owner bot discovery (peers owned by other people) — the trusted set is the operator's own fleet; revisit if multi-tenant trust is ever added.
- A separate "discoverable" opt-in distinct from `allow_paired_instances` — reuse the existing gate.
- Advertising skills/tools/avatars — tagline only (YAGNI; revisit if browse-by-capability is wanted).
- Group / multi-party threads — phase 3; this phase only lays the `is_bot` seam.
- Retrofitting CSRF onto the pre-existing instance-invite forms (out of scope since phase 1).

## 10. Deploy

**Schema-change deploy.** Per host: `git pull --rebase` → `node scripts/init-db.js` per data dir FIRST (MPA needs `CROW_DB_PATH=~/.crow-mpa/data/crow.db`) → restart the gateway(s). crow main `~/.crow` → `:3001`; MPA `~/.crow-mpa` → `:3006`; grackle `~/crow` → `:3002`; black-swan (`ssh black-swan`) → `:3001` (slow boot). Sudo `8r00kly^`. **pi-bots NOT restarted** (the adapter does not read the new tagline or `is_bot`; `buildAdvertisementPayload` runs in the gateway). Verify via node ports, not ts.net `/health`. Live-verify cross-instance: set a tagline + `allow_paired_instances` on a bot on one Crow, confirm it appears (with tagline) in another Crow's directory (Contacts "Browse Crow bots" and Messages "Message a Bot"), Add → it becomes a badged contact, Message → opens the chat.
