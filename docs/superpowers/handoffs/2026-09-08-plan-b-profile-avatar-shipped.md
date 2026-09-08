# Handoff — Ramble names+profile arc Plan B: SHIPPED and deployed

**Date:** 2026-09-08 · **State:** PR #325 merged at `55ecb047`, all three gateways restarted and verified. The arc's Plan B is closed. Five Ramble follow-ups are queued from Kevin's live play session, one of which he already decided.

## What shipped

A Crow profile picture that actually reaches contacts, built with `superpowers:subagent-driven-development` from `docs/superpowers/plans/2026-09-08-profile-avatar-sharing.md` (spec `2026-09-08-ramble-names-and-profile-design.md` §4–§7, D4–D7).

- An inline `data:` picture, shrunk to a 128 px square in the browser, or the active Ramble bird rendered server-side as an SVG. It rides the pairing handshake both ways and goes to every established contact as a `crow_social` `profile` message on every change.
- Two additive contacts columns, `peer_display_name` and `peer_avatar`, hold what a peer reported. A name or picture the user typed always wins on screen and is never overwritten.
- Contacts panel: file input plus preview, plus a bird source offered only when a bird has hatched and the engine can draw it.
- Ramble: a contact's picture on their map pin. Bundle 0.7.0 → 0.8.0.
- Docs: the contacts guide stops pointing at Settings → Identity. English and Spanish.
- **Plus an operator-authorised bug fix** (below).

Gates: full suite **4249/0**, `check-port-allocation` OK, `build-registry --check` in sync, migration dry-run PASSED on copies of all three live DBs (`user_version 9 -> 9`, exactly the two columns, no row-count deltas). CI `suite`/`static-checks`/`audit` all green on `75de837e` before merge.

## The Ramble bug fixed along the way

Kevin hit it live: after his egg hatched, his bird was invisible on the map. `hidden` is an IDL property of `HTMLElement`, **not** `SVGElement`, so `svgEl.hidden = false` sets a dead expando and never removes the content attribute, while `#ramble [hidden] { display: none !important; }` (ramble.css:117) keeps matching it. Five SVG elements were affected: `rb-perch-bird`, `rb-hatch-bird` and `rb-ar-bird` could never be SHOWN; `rb-egg-art` and `rb-ar-egg` could never be HIDDEN. Latent since the phase-1 panel commit `a1fd849b`, triggered by the first hatch. Fixed with a `setHidden` helper toggling the attribute at all 30 write sites plus the one read site in `ramble-ar.js`, pinned by a test asserting no `.hidden =` assignment remains in either served file. The reviewer audited all 31 conversions individually: no inverted boolean, no dropped guard.

## ⚠ Deploy fact the plan and the previous handoff got WRONG

They claimed all three gateways would show `[panel] ramble routes mounted` and `addon ramble: connected, 15 tools discovered`. **False.** Ramble is INSTALLED ONLY ON GRACKLE (`installed.json`: crow primary 10 bundles, r4 7 bundles, neither containing ramble; `~/.crow/bundles/ramble` and `~/.crow-r4/bundles/ramble` do not exist). Crow primary and r4 correctly show **only** `[ramble] transport started` — the transport runs from the repo tree, but the panel routes and the MCP addon require an installed copy. Do not chase this as a failure.

grackle showed all four expected lines including `[bundles] refreshed ramble 0.7.0 -> 0.8.0`. `PRAGMA table_info(contacts)` confirms both columns on all three live DBs.

## Bugs the reviews caught that a green suite would not have

Five fix rounds, each closing on the first attempt. The substantive ones:

1. **Nullable `is_blocked` split the gates.** The recipient query filtered in SQL while the receive path filtered in JS, so a contact with a NULL value was excluded from the broadcast but accepted on receive.
2. **A fleet-wide revert.** The no-bird fallback wrote a *replicated* setting from a per-instance boot repaint. Verified against the live fleet: r4 has all 24 Ramble tables and zero hatched birds, and restarts on every deploy, so it would have reverted Kevin's bird choice everywhere on every boot. The fallback now lives only in the user-present save path.
3. **A rejected save that persisted.** `save_profile` interleaved validation with writes, so a mixed-invalid POST stored a change, answered 400, and never broadcast or armed the retry flag.
4. **Zero relays counted as delivered.** `sendControl` returns an empty relay list rather than throwing when every relay refuses; `broadcastProfile` ignored the return value and cleared the retry flag exactly when it was needed. Likely trigger is this feature's own doing: a cap-size avatar makes the DM ~55 KB against relay ceilings commonly at or below 65536.

## Open, and what to watch

- **Kevin's live acceptance is still his:** set a picture in Contacts → My Profile on grackle, confirm a second instance's contact row gains `peer_avatar`, and confirm the pin shows it. Then switch the source to the bird and confirm the swap. Also the Plan A phone smoke (World name at pseudonym → "your mark").
- **Relay size is the thing to watch.** If a relay rejects the ~55 KB profile DM the journal now says so per recipient (`[sharing] profile to <crow_id> reached zero relays`). Kevin's open Q4 — dropping `AVATAR_MAX_BYTES` from 32768 to 16384 — is the lever if it bites.
- **Two birds, one picture.** crow primary and grackle each have a hatched bird, so with the bird source both repaint the single user-level `profile_avatar_url` on their own boot/hatch events, last writer wins. Converges rather than flaps (the ramble tables replicate and the render is deterministic), but the avatar can alternate. Choosing which instance owns the bird avatar is a design decision, deliberately not taken here.
- **A pre-existing product wart, kept by ruling:** choosing the bird overwrites the uploaded photo in `profile_avatar_url`, and switching back to "My picture" still shows the bird. That is what spec §5 specifies. Fixing it properly means a second synced settings key; flagged to Kevin, his call.

## Queued Ramble work from Kevin's play session

1. **DECIDED and shipped:** the invisible-bird fix rode this PR.
2. **Chore cadence + the pet page.** Three taps in a row is unengaging. Kevin wants activities spaced hours apart, and the pet page to LIST what feeds the bird. Walking is already wired (`FEED_DELTAS`: meet a crow +20, new place +15, unlock +10, chore +8, check-in +5, idle −10) — the presentation hides it, which is the cheaper half of the fix.
3. **Kawaii animations for Feed/Preen/Play.** The panel already has the vocabulary. ⚠ Trap: the click handler calls `refreshPet()` which re-mounts the bird SVG, so animate the element or its wrapper, not the inner markup.
4. **Egg economy.** Hatching auto-mints a successor, and `ensureIncubatingEgg` runs on four paths including two pure reads, so merely viewing a screen recreates it. The flaw is incentive inversion: the incubating slot is the only one that earns warmth, so a free egg makes a nest-claimed egg inert. ⚠ Any fix must BANK warmth while the slot is empty or it punishes walking.
5. **AR photo challenges, contacts-only (Kevin's decision).** ⚠ Research finding: photo sharing CANNOT ride an existing path. Cross-instance auth exists only for the user's OWN fleet (same master seed); `crow_share` has no `file` type; the project clone bundle's preview text promises presigned URLs it never generates; and peer-message attachments never leave the sender's instance. **Recommended shape:** stream bytes over the existing Hyperswarm encrypted contact channel that already carries clone bundles and already authenticates contacts by signed nonce — no network-reachable MinIO, no relay ceiling. The built-but-unused 1 MB store-and-forward relay (`servers/sharing/relay.js`, zero client callers) is the natural offline complement. MinIO stays a LOCAL prerequisite.

A proper brainstorm is warranted for items 4 and 5.

## Next

Models arc plan 2 (`crow-models-bundles-to-catalog-arc`), unless Kevin prioritises the Ramble queue.
