# Handoff — Ramble names arc Plan A shipped (PR #323), Plan B next

**Date:** 2026-09-08 · **State:** Plan A (world name + "your mark" labels) merged and deployed to all three gateways; Plan B (profile avatar to contacts) is the next plan to write.

## What shipped
- PR #323 `feat/ramble-world-name` → main. Ramble bundle 0.6.0 → **0.7.0**. Suite 4197/4197/0.
- Spec: `docs/superpowers/specs/2026-09-08-ramble-names-and-profile-design.md` (D1–D7). Plan (three review gates, rulings R1-1…R2-2, execution ledger in `.superpowers/sdd/2026-09-08-ramble-world-name/`): `docs/superpowers/plans/2026-09-08-ramble-world-name.md`.
- World name: `ramble_settings` key `world.name`, `sanitizeWorldName` / `setWorldName` / `WORLD_NAME_MAX` in `bundles/ramble/server/grid.js`; Visible sheet field `#rb-world-name`; `POST /api/ramble/grid { worldName }` (`""` clears, `null` = not sent).
- Wire: `content.name` on kinds 30397/20397 only for rows whose `author_level` is `pseudonym`/`real` (decided per row in the core drain from `row.author_level ?? level`); `eventToMark` → `author_name`; `insertRemoteMark` sanitizes again; column `ramble_marks.author_name` (ensureColumn), teaser allowlist, `RAMBLE_MARK_WIRE_COLUMNS`.
- Labels: `bundles/ramble/server/labels.js` (`labelFor`, `cawTitleFor`, `keyTail`) mirrored by the client's `markLabel`/`arTitle`; `ramble_query_world` rows carry `label`; `contactsByPubkey(db)` now lives in `delivery.js` (routes + MCP server share it).

## Rulings worth remembering
- **Core consumes no new bundle export** (R1-1): round 1 booted the new core against the real 0.6.0 installed copy and the whole drain died on a missing export. Rule: when core and an installed bundle copy can skew, core passes raw values and the bundle sanitizes; never destructure a new bundle export in core without a guard.
- The sanitizer replaces U+00B7 (the label separator) and strips zero-width/default-ignorable characters (the final review found `f6<ZWSP>65c26b` passing the hex rule). Lookalike dots survive: harmless, the real ` · key4` tail is unconditional.
- Instance-sync rows are the owner's own (all four `emit("ramble_marks")` sites are origin-local guarded), so a synced `author_name` is never displayed; the wire column is forward-looking.
- ZWJ is stripped, so a multi-person emoji sequence splits in a name (accepted).

## Deploy record
- crow primary + r4 + grackle restarted back-to-back after the merge; grackle journal: `refreshed ramble 0.6.0 -> 0.7.0` → transport started → routes mounted → 15 tools. `PRAGMA table_info(ramble_marks)` on grackle shows `author_name`.
- ⚠ OPEN (Kevin): phone smoke on grackle — set a World name at Name = pseudonym, leave a public mark, confirm "your mark" on map/Nearby/AR and the rotating placeholder text.

## Next: Plan B (spec §4, §5, §6 Plan-B rows, §8)
Avatar as inline `data:` URI ≤ 32768 chars (128 px canvas in the Contacts panel), `profile_avatar_source` picture|bird (bird rendered by `bird-svg.cjs`, refreshed on `activateBird`), display name + avatar in the handshake both ways (`sendInviteAccepted`, `handshake_complete`) plus a `crow_social` `profile` subtype broadcast via `sendControl` on change; NEW contacts columns `peer_display_name` / `peer_avatar` (guarded `addColumnIfMissing` in `scripts/init-db.js` — run `scripts/schema-migration-dryrun.sh` from the branch first); display `display_name || peer_display_name || crow_id`; `contact_avatar` on Ramble marks; fix the contacts guide (profile is edited in Contacts → My profile, not Settings → Identity); then the sheet copy "Contacts see the name they saved for you" becomes "your Crow name". Same rail: writing-plans in a fresh worktree from main, two adversarial code-traced rounds + scoped check, Kevin approval, SDD.

After Plan B: models arc plan 2 (`docs/superpowers/plans/2026-09-04-model-catalog-curation.md` lineage).
