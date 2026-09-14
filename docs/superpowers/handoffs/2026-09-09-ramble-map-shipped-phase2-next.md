# Ramble map arc shipped (0.9.0 → 0.9.5) — phase 2 next

**Date:** 2026-09-09
**Ships:** PRs #329, #331, #332, #333, #334, #335 — all merged, CI green, deployed
**Live on:** grackle only (`~/.crow`) — crow primary and r4 have **no** Ramble bundle installed
**Spec:** `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md`
**Phase 1 plan:** `docs/superpowers/plans/2026-09-08-ramble-map-phase1.md`
**Prior handoff:** `docs/superpowers/handoffs/2026-09-08-ramble-map-phase1-shipped.md`

## Where the arc stands

Phase 1 of four is done and in daily use. Six releases in a day: the map shipped, then
five rounds of fixes driven by the operator actually walking around with it.

| ver | PR | what |
|---|---|---|
| 0.9.0 | #329 | Fog of war, three zones, unlocking, bird seed, the walking-egg marker |
| 0.9.1 | #331 | Fog was **unreachable**; seed was **invisible** |
| 0.9.2 | #332 | Fog looks like weather; seed looks like seed; the bird speaks only when it has something to say |
| 0.9.3 | #333 | Chores above the reference panel; the panel folds |
| 0.9.4 | #334 | A walkable opening frame; the map travels with you |
| 0.9.5 | #335 | Seed is sparse and scattered, not one per walked square |

**Live state on grackle:** 26 unlocked cells, seed balance 4, `integrity_check` ok.
Pre-deploy backup at `/home/kh0pp/crow-db-backup-pre-ramble-090.db`.

## ⚠ Phase 2 is HEART CONTAINERS, not the shop

The operator asked "where is the store where seeds are traded for accessories" and then said
to proceed through the planned phases. It is worth being explicit, because the natural
assumption is wrong: **the shop is phase 4.** Spec §9 orders them

1. The map — **shipped**
2. **Heart containers and maximum energy** ← next, pure addition
3. The egg supply overhaul — the risky one, deliberately late
4. Accessories, wardrobe and shop

Seed is therefore an earn-only currency with nothing to spend it on until phase 4. That is
by design, not an oversight — but it does mean the operator is banking a currency he cannot
use, and he has noticed. Worth confirming he still wants phases in order rather than pulling
the shop forward.

## What phase 2 has to build (spec §2.3, §6.4)

- Heart containers derive **deterministically from the cell hash**, copying `nestFor` — and
  now also `seedFor`, which phase 1 added in `bundles/ramble/server/wallet.js` and is the
  closer model. Roughly **one in three first unlocks** (`heart.rate`, default 3).
- They may also appear **rarely in already-unlocked ground**, time-gated. Deliberately
  makes maximum energy grindable by a heavy walker who never explores: maximum energy is
  not competitive power, only a longer buffer before drooping.
- Each heart raises **maximum energy** by `energy.max.per.heart` (default 10) and does
  nothing else.
- §7 flags for the plan: deterministic heart placement from a cell hash.
- The point of hearts (spec §112): laying an egg in phase 3 requires sustained happiness, and
  a larger maximum gives more slack before dropping below happy. **Heart containers buy
  resilience; resilience buys eggs.** Phase 2 is what makes phase 3 survivable.

## Carry into phase 2 — hard-won, do not rediscover

- **⚠ A spend must be keyed uniquely by the PURCHASE.** Recorded on `applyRambleWallet`'s
  doc comment in `servers/sharing/instance-sync.js`. `MAX(delta)` resolves same-key
  disagreements upward, which is generous in the right direction for an *earn* and wrong for
  a spend — a coarse key would let someone with two Crows keep seed they already spent. Hearts
  accumulate rather than being spent, so phase 2 is safe; **phase 4 is where this bites.**
- **The map and the payout must read the SAME rule.** Phase 1's 0.9.5 had to gate
  `recordSeedPickup` on the same `seedFor` the map draws from, or the map promises seed a
  cell will not pay. A heart shown and not granted is the same bug.
- **A feature that gates on accumulated state must say what existing users see at upgrade.**
  Fog would have blanked every existing map on deploy; the fix was backfilling `ramble_cells`
  from `visit_place` credits, which were already in the database. Ask the same question of
  hearts: what does a player with 26 already-unlocked cells get on the day this ships?
- **Sparse features break ledger tests.** Once seed became one-cell-in-four, ledger tests
  started passing or failing on the spawn lottery. The fix is an explicit `everyCellBears()`
  fixture pinning `seed.rate` to 1, with the lottery tested separately. Do the same for hearts.
- **Panel client scripts: ZERO backticks** — one truncates the served script. The rule is
  known; the slip is markdown habit in *code comments*. And `grep -c` counts LINES: use
  `grep -o '\`' FILE | wc -l`. Markup sinks must stay at exactly 2;
  `opts.html = element` is the sanctioned no-sink way to hand Leaflet an Element.
- **Adversarial review earns its keep, every time.** It caught three blockers in phase 1 that
  eight per-task reviews and four plan rounds missed, and a bug in 0.9.2 that would have made
  the bird announce pre-existing marks on every page load. Every one was an interaction —
  between tasks, or between the branch and pre-existing production state — which task-scoped
  review and static tests structurally cannot see.

## Open, not blocking

- **Walk vs drive.** Seed appears along a freeway because those cells are genuinely unlocked,
  most likely driven through with the panel open. The game cannot tell a walk from a commute.
  Options: a speed gate on unlocking, or leave it. **A design decision, deliberately not taken.**
- **Earn rate dropped ~4x** with sparsity. `seed.rate` is a live setting, tunable without a
  deploy. Now is the cheap time to tune, before phase 4 prices anything against it.
- **The fog filter needs a device check.** `feTurbulence` + `feDisplacementMap` over a
  full-viewport path is per-pixel work. If panning is sluggish, drop the displacement and keep
  the blur — one attribute.
- Phase 1 follow-ups still parked: `unlockedCellsNear` full-scans; the seed cooldown is a
  global UTC bucket so a cell can pay twice across midnight; spec §2.4 overclaims that fog
  limits remote surveying (the MCP tools and `/unlock` are ungated — **fix the spec's
  wording**, the shipped user docs are honest); the AR view shows nothing in the frontier.

## Harness notes

- **`gh` is NOT installed on crow.** Use the `github` MCP server for PRs
  (`mcp__github__create_pull_request` / `merge_pull_request`). Poll CI with plain `curl`
  against `/commits/<sha>/check-runs` — the three branch-protection contexts are `suite`,
  `static-checks`, `audit`.
- Node: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` before any node/npm.
- Tests ONLY via `node scripts/run-suite.mjs` — **never** bare `node --test`, which writes to
  the live production database.
- Never `git checkout` in `~/crow`; a parked checkout silently disables fleet auto-update.
  Work in a worktree.
- `.gitignore` line 1 is `node_modules/` with a trailing slash, which does not match a
  worktree's `node_modules` **symlink** — it shows untracked forever.
- Suite baseline at this handoff: **4301/4301**.
