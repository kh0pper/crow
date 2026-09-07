# Handoff — Ramble Flock phase 1 shipped (PR #311 + #312), phase 2 next (2026-09-07)

**State:** phase 1 of the Flock design (home + bird + egg + hatch) is merged to `main` (PR #311 @ccea474f) with the deploy follow-up PR #312 (bundle deps + ramble 0.2.0). Docs PR #310 merged with it. Suite on the branch: 4025 pass / 0 fail. Deployed: crow primary + r4 gateways and grackle restarted deliberately; grackle is the instance that has Ramble installed as an extension (crow only runs the core transport from the repo).

## What shipped (13 SDD tasks + final fix wave)
1. Tables `ramble_eggs`, `ramble_credits`; pet columns `active_egg_id`, `chores_json`, `lamport_ts`; marks `bird_species`, `bird_seed`. No `SCHEMA_GENERATION` bump.
2. `bundles/ramble/server/bird-svg.cjs` genome engine (ROSTER, rollGenome, drawBird, drawEgg, mountBird, isValidBird). `.cjs` because the root is `type:module`.
3. `eggs.js`: warmth weights as `ramble_settings` keys, idempotent credits ledger, one-way hatch, `activeBird` (hatched only), `eggState`, `MEET_CROW_DAILY_CAP = 5`.
4. Chores in `pet.js` (feed / preen / play, once per local day, +8 energy).
5. `feed.js` `feedAll` fan-out (egg credit + pet feed, `onHatch`).
6. Instance sync for `ramble_eggs` / `ramble_pet`: deterministic hatch tiebreak (earlier `hatched_at`, then lower seed, triple moves as a unit), convergence (older incubating wins, loser shelved, oldest shelf re-promoted when zero incubating), pet LWW, emits only from feed / chore / hatch.
7. Bird on the public wire (`bird: {species, seed}`), single validator on receipt; `meet_crow` credit on receipt.
8. "Just me" (`visibility: 'private'`): never on the Nostr wire, listed as `origin <> 'remote'` so own synced copies show.
9. MCP tools `ramble_egg_state`, `ramble_checkin`, `ramble_chore`; `ramble_pet_state` carries bird + egg percent.
10. Routes egg / checkin / chore / pet / `bird/:species/:seed.svg` / `ramble/static/bird-svg.js` (registered before the static catch-all), `ramble-hatched` SSE; `visit_place` credited only from the browser's real `here` (geohash-7).
11. Panel rewrite in direction C: world-first home with the perch bird, egg view (ring + checklist + check-in), pet view (chores, next-egg card), grid sheet, hatch moment, haversine walk distance on locked pins, all audiences on the map.
12. Nest header crow becomes the hatched bird (face = pet energy; host-health "!" badge unchanged).
13. Docs en/es.

## Deploy finding (fixed in the product, PR #312)
Installed bundle copies (`~/.crow/bundles/<id>/`) refresh only on a manifest version delta, and a node-server bundle must declare its bare imports in its own `package.json` or the installed copy cannot resolve them. Ramble and four other bundles (data-dashboard, frigate, immich, nominatim) lacked the `package.json`; phase 1 had not bumped ramble's version. Guard test `tests/bundle-server-deps.test.js`; rule added to the repo CLAUDE.md.

## Rulings to carry into phase 2
- Phase-1 shelf eggs are ONLY convergence losers; the sync layer re-promotes one when an instance has no incubating egg. **Phase 2 must add a shelf-origin marker before user-shelved eggs exist** (nests / extra eggs), or re-promotion will un-shelve user eggs.
- Re-promotion is local-only (applies never emit); two instances can promote different eggs and converge on the next sync.
- `meet_crow` cap is per instance and local-day based (credits do not replicate).
- The Nest's dark mode is OS-driven (`prefers-color-scheme`); the panel binds both that and `[data-theme]`.
- Hatches triggered through the stdio MCP tools emit no live SSE; the panel refreshes after every action.
- Deferred minors (ledger): `hatchIfReady` non-atomic double-roll (end state consistent), `applyRamblePet` equal-lamport tiebreak (matches settings/block convention), shared-db test order in eggs/feed tests, `tile_attribution` innerHTML sink (operator-set, pre-existing), `tests/bundle-npm-required.test.js` concurrent-install cases fail when the file runs alone (pass in the suite).
- Parked core follow-up: `STRICT_PANEL_MOUNT` check reads Express-5 `layer.slash` on Express 4 (inert).

## Where things are
- Spec: `docs/superpowers/specs/2026-09-07-ramble-flock-design.md` (D1–D13; §2.4–2.5 nests/flock, §11 phases).
- Phase-1 plan: `docs/superpowers/plans/2026-09-07-ramble-flock-phase1-home-bird-egg.md`.
- SDD ledger with every ruling: `/home/kh0pp/crow-wt-flock/.superpowers/sdd/2026-09-07-ramble-flock-phase1-home-bird-egg/progress.md` (git-ignored; worktrees `crow-wt-flock` and `crow-wt-rfix` can be removed once phase 2 starts from a fresh worktree).
- Mockups (direction C) copied under that SDD workspace `mockups/`.

## Next
Phase 2 = nests + flock roster + egg shelf (spec §2.4–2.5, §3 flock screen, §5 `ramble_nest_claims`, §11 item 2): `superpowers:writing-plans` → adversarial plan review (two rounds + scoped check) → SDD in a fresh worktree branched from `main`. Then phase 3 (contacts delivery, gifts → swaps) and phase 4 (AR overlay). Models arc plan 2 stays queued behind the Ramble phases.
