# Ramble map phase 1 shipped — fog, frontier, unlocking, bird seed

**Date:** 2026-09-08
**PR:** [#329](https://github.com/kh0pper/crow/pull/329) merged at `3494e126`
**Ramble:** 0.8.1 → 0.9.0
**Spec:** `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md`
**Plan:** `docs/superpowers/plans/2026-09-08-ramble-map-phase1.md`

## What shipped

The public map became something you earn. Ground you have physically stood in unlocks
permanently. A few cells past that is a dimmed frontier, where a typed beacon says a mark or
a nest is there without saying what. Everything beyond is fog. Walking already-unlocked
ground turns up **bird seed**, spent in a later phase on accessories.

Two new runtime tables, replicated between the user's own instances only:

| table | shape | conflict rule |
|---|---|---|
| `ramble_cells` | `cell` PK, `first_unlocked_at`, `lamport_ts` | earliest unlock wins (`MIN`); deletes ignored — an unlock is permanent |
| `ramble_wallet` | `(kind, key)` PK, `delta`, `created_at`, `lamport_ts` | `MAX(delta)`, `MIN(created_at)`, `MAX(lamport_ts)` |

Also: the location marker is now your own walking egg, and your bird once it hatches; the
unlock moment flashes the exact square earned; user docs in English and Spanish.

## Deployed

**grackle only, and that is correct.** Neither `~/.crow` nor `~/.crow-r4` has a
`bundles/ramble` directory or an `installed.json` entry — Ramble is installed only on
grackle. crow primary still auto-restarts on the HEAD change; there is nothing Ramble-shaped
for it to pick up.

Verified on grackle after restart: installed copy refreshed 0.8.1 → 0.9.0, both tables
created, `ramble_cells` = **25 rows**, `cells.backfilled` = 25, `integrity_check` ok,
`[proxy] addon ramble: connected, 15 tools discovered`, no Ramble errors in the journal.
Pre-deploy backup kept at `/home/kh0pp/crow-db-backup-pre-ramble-090.db` on grackle.

## Three blocking defects the final whole-branch review caught

All three were interactions between tasks, or between the branch and pre-existing production
state. Eight per-task reviews and four plan-review passes missed all three. This is the
strongest evidence yet for keeping the whole-branch review as a hard gate.

**1. Retiring the world view's corner button left the view with no exit.** Every remaining
navigation button lives in the egg, pet, or flock views. The new map marker only exists after
a real GPS fix, so denying the location prompt trapped the user with no route to their egg,
the daily check-in, their bird, or their flock. The plan said "retire the corner button" and
never asked what else that button was carrying — it was also the live incubation ring.
Fixed with a text-only door in the status strip that does not depend on geolocation.

**Lesson: when a plan retires a UI element, enumerate every affordance it carried before
approving the removal.** "Replace X with something prettier" is not the same change as
"delete the only exit from a view".

**2. Fog would have blanked every existing user's map on deploy.** `ramble_cells` starts
empty; nothing backfilled it; with no unlocked cells the gate drops every public mark and
nest. And because unlocking refuses any fix vaguer than 100 m, a desktop map would have been
fogged *permanently* — desktop Wi-Fi geolocation never gets that sharp.

The missing history already existed in the database. `ramble_credits` rows with
`kind = 'visit_place'` are keyed `<geohash7>:<ISO week>` and are awarded **only** from a real
position fix, never from panning the map — precisely the record this table would have kept.
`backfillCellsOnce` (in `bundles/ramble/server/init-tables.js`, last statement of
`initRambleTables`, guarded by a `cells.backfilled` settings flag) seeds from those plus nest
claims and the user's own marks.

**Lesson: a feature that gates on accumulated state must say what happens to users who
already have history.** The spec described the mechanic for a new player and nobody asked
what an existing player sees at the moment of upgrade.

**3. The seed wallet never converged.** `applyRambleWallet` used `ON CONFLICT DO NOTHING`,
whose comment claimed the balance converges for any arrival order. That is only true when the
row's value is a pure function of its key — and `delta` is `perPickup`, read from the live,
replicated, **mutable** `seed.per.pickup` setting. Two of the user's own Crows harvesting the
same cell in the same window while disagreeing about that setting would each ignore the
other's row and hold different balances forever. `applyRambleCell`, two functions above,
already did it correctly.

**Lesson: "idempotent under a natural key" is not the same property as "convergent".** Ask
whether the row's value can differ between instances for the same key. If it can, `DO NOTHING`
freezes the disagreement instead of resolving it.

## ⚠ Constraint for phase 2, recorded in the code

`MAX(delta)` is only generous in the right direction while every delta is an **earn**. A spend
written as a negative delta under a coarse key would resolve a `-10`/`-5` disagreement to
`-5` — less deducted — letting someone with two Crows keep seed they already spent. A spend
row must be keyed uniquely by the **purchase**, never by something as coarse as `cell:window`.
This note lives on `applyRambleWallet`'s doc comment in `servers/sharing/instance-sync.js`,
where the next implementer will actually read it.

## Follow-ups, not done here

- `unlockedCellsNear` reads the whole `ramble_cells` table while its comment claims to be
  bounded by geography. Correctness is fine; it scales badly at tens of thousands of cells.
- The seed cooldown is a global UTC bucket (`floor(now / 24h)`), so one cell can pay twice
  seconds apart across a midnight boundary, and clock skew between a user's own Crows
  produces the same double-pay.
- **Spec §2.4 overclaims.** It says fog "removes the ability to survey a whole city's marks
  remotely". It does not: MCP `ramble_query_world` and `ramble_nests` are ungated, and
  `POST /api/ramble/unlock` takes a self-asserted lat/lon. Fog is a game mechanic on the map
  overlay, not access control. The shipped user docs are honest about this; **the spec's
  wording should be corrected** rather than the MCP surface gated in a hurry.
- The AR view filters every beacon out, so the frontier reads as empty there while the map
  shows it. Also `/around`'s 500 m default radius exceeds a depth-3 frontier's ~460 m reach.
- `seed_picked` is returned by the area route and deliberately unconsumed; a pickup-feedback
  beat belongs in a later phase.
- An unlock double-fetches `GET /api/ramble/marks` (both `celebrateUnlock` and its caller
  call `refreshMarks`). Harmless — the redraw is idempotent — and it was dictated verbatim by
  the plan, surviving three adversarial rounds unflagged.

## Open for Kevin

- **Phone smoke test on grackle** — still outstanding from the previous two arcs, and now
  more interesting: walk somewhere new and confirm the fog lifts, the square flashes, the
  seed counter moves, and the walking egg waddles.
- The 25 backfilled cells should make the map look right immediately rather than blank.

## Harness notes

- **`gh` is not installed on crow**, although the global CLAUDE.md says to use it for GitHub
  operations. This PR was opened through the configured `github` MCP server instead. Either
  install `gh` or update the instruction — the next session hits the same wall.
- **`.gitignore` line 1 is `node_modules/` with a trailing slash**, which matches directories
  but not symlinks. A git worktree that symlinks `node_modules` (as this one did, to resolve
  `better-sqlite3`) shows it as untracked forever, and a `git add -A` there would commit a
  machine-specific absolute path. Dropping the trailing slash fixes it.
