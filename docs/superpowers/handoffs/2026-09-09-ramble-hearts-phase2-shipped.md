# Ramble phase 2 shipped — heart containers and maximum energy

**Date:** 2026-09-09
**PR:** [#339](https://github.com/kh0pper/crow/pull/339) merged at `4a5c3215`
**Ramble:** 0.9.5 → 0.10.0
**Spec:** `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md`
**Plan:** `docs/superpowers/plans/2026-09-09-ramble-hearts-phase2.md`

## What shipped

Walking new ground occasionally turns up a heart container, which permanently lengthens the bird's
energy bar and does nothing else. Roughly one cell in `heart.rate` (3) holds one the first time you
enter it; far more rarely (`heart.wild.rate`, 40) one regrows in already-cleared ground, at most once
per `heart.wild.days` (30) window. Uncollected hearts draw as pips on cleared ground; you collect one
by walking there. Mood thresholds stay absolute at 60/30, which is what makes a longer bar buy real
slack instead of nothing.

**No schema change.** Hearts are rows in the existing `ramble_wallet` under `kind='heart'` with
`delta` always the literal `1`. No new table, no migration, no `SCHEMA_GENERATION` bump.

## Deployed — grackle only, and that is correct

crow primary and r4 have no Ramble bundle. Verified on grackle after restart: installed copy
refreshed 0.9.5 → 0.10.0, `server/hearts.js` present, `[proxy] addon ramble: connected, 15 tools`,
`integrity_check` ok, and the live data untouched — 27 cells, 0 heart rows, 5 seed rows, pet still
at energy 100/happy. Pre-deploy backup at `/home/kh0pp/crow-db-backup-pre-ramble-0100.db`.

⚠ **grackle's crow DB is `~/crow/data/crow.db`, NOT `~/.crow/crow.db`** (that file is 0 bytes).
Bundles still install under `~/.crow/bundles/`. The split costs a few minutes every time.

**14 pips, not the ~8 the plan predicted.** Ran the shipped `availableHearts` against grackle's real
27 cells: 13 first hearts + 1 wild = 14, 52% of cleared ground. That is +1.6σ on p=1/3 — luck, not a
bug — but the plan left `heart.rate = 3` on the strength of "about 8" while arguing that carpeting is
a real failure mode. Hearts are taken permanently, so the carpet clears as it is walked.

## Open for Kevin

- **Phone smoke test on grackle** — outstanding for four arcs now. Walk to one of the 14 pips and
  confirm the heart lands, the counter moves, the bar gets longer, and the bird says its line.
- **Is 14 pips too many?** `heart.rate` is a live setting; raising it to 4 or 5 thins the map without
  a deploy. Worth a look once you have seen it on the phone.

## Follow-ups, not done here

- `/around` (the AR "Look around" view) carries no hearts — consistent with seed, which it also
  omits, so not a new map/payout split. Belongs with phase 1's existing AR-beacon follow-up.
- The map bar is now five chips and `.rb-mapbar` wraps on a phone.
- `heart.wild.days` is a live replicated setting; changing it renumbers the wild key's windows, so a
  cell can pay again. A re-earn on retune, not a divergence — noted in `applyRambleWallet`.
- **There is no CI gate for guide-doc i18n parity.** `tests/i18n-global-parity.test.js` covers the
  translation-key mechanism only; nothing diffs `docs/guide/*.md` against `docs/es/guide/*.md`. The
  plan claimed such a gate exists. It does not. Parity was verified by hand here.

## Lessons that cost something

**A wrong-but-checkable justification is worse than none.** The plan justified the asymmetric energy
clamp with an ordering claim — that sync applies `ramble_pet` before `ramble_wallet`, citing
`SYNCED_TABLES` positions. `SYNCED_TABLES` is only ever a `.includes()` allowlist; `_applyEntry`
applies one entry at a time in arrival order. The design was right, the reason was false, and it had
shipped in a code comment. A future reader checks it, finds it false, concludes the hazard was
imagined, and reverts the clamp to symmetric — which permanently destroys energy on any pairing.

**Fixing review findings introduces new ones.** Round 2 of the plan review found four defects, three
of which were in code written to fix round 1 — including a "fresh" fixture cell that turned out to be
an existing test's own cell, reintroducing the lucky-hash dependency the plan bans.

**Guarding one caller is not guarding the invariant.** The first energy-clamp fix protected
`petState` while `feed` persisted the same truncation on a far hotter path. The asymmetry belonged in
`clampEnergy`, which every writer already goes through.

## Next

Phase 3 — the egg supply overhaul (removing the auto-minted egg, auto-promote, laying, the prologue).
The spec calls it the risky phase, deliberately late. Phase 4 is the seed shop.
