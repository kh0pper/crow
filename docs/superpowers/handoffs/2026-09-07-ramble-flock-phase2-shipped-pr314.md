# Handoff — Ramble Flock phase 2 shipped (PR #314), phase 3 next (2026-09-07)

**State:** phase 2 of the Flock design (nests + flock roster + egg shelf) is merged to `main` (PR #314 @2c6604c1) with ramble bundle `0.3.0`. Suite on the branch: 4113 pass / 0 fail. Deployed: crow primary + r4 gateways and grackle restarted deliberately back-to-back at 08:49–08:50 CDT (before any nest claim); grackle journal showed `[bundles] refreshed ramble 0.2.0 -> 0.3.0`, `[ramble] transport started`, `[panel] ramble routes mounted`, `addon ramble: connected, 13 tools discovered`; auto-update on crow reads 2c6604c1 / "Up to date".

## What shipped (8 SDD tasks + one final fix wave)
1. `ramble_eggs.shelf_origin` (NULL | `sync` | `user`) with a guarded ALTER + idempotent backfill; instance sync: convergence losers marked `sync`; re-promotion picks only `sync` shelf eggs and KEEPS the mark; class rule (a NULL-origin incubating egg beats a `sync`-origin one before the phase-1 age tiebreak); a peer's user-shelve op never triggers re-promotion; sparse phase-1 rows fall back to the local mark, an EXPLICIT null on the wire means plain; key-less shelf rows default to `sync`; a hatched row never takes an origin. Local table `ramble_nest_claims` (never synced).
2. `bundles/ramble/server/nests.js` (pure): `sha256("ramble-nest-v1:" + cell7 + ":" + isoWeek)`, nest iff first uint32 mod `nest.rate` (24) is 0, point = SW corner + hash fractions of the cell, art seed = fourth uint32; `cellsInBbox` capped at 8192 cells.
3. `bundles/ramble/server/flock.js`: `readFlockSettings` (`nest.rate` ≥ 1, `shelf.cap` ≥ 0), `listNests`, `claimNest` (75 m, one per local day per instance, cap 5 counting `user`-origin shelf eggs, idempotent per nest, heals a claim whose egg is missing), `incubateEgg` (ONE conditional UPDATE, all-or-nothing; emits shelved row first), `activateBird`, `flockState`.
4. MCP tools `ramble_flock`, `ramble_nests`, `ramble_claim_nest`.
5. Routes `GET /api/ramble/nests?bbox=`, `POST /api/ramble/nests/claim`, `GET /api/ramble/flock`, `POST /api/ramble/eggs/:id/incubate`, `POST /api/ramble/birds/:id/activate`; SSE `ramble-nest-claimed` on the existing stream.
6. Panel: flock view (birds grid — tap to activate, active one tagged "With you" — egg shelf with Incubate, "8 kinds, N found"), nest egg-pins at zoom 15+, "Take the egg" popup; direction C, zero backticks, two engine-only markup sinks.
7. Docs en/es (new sections, settings table, tool rows, three operating notes), spec §2.4 + §7 wording amended to the shipped contract, registry regenerated.

## Rulings to carry (full list in the PR and the SDD ledger)
- Deviations: a claim credits NO warmth/energy; `?bbox=` not `?cells=`; `ramble_nests` tool added; cap counts `user`-origin shelf eggs only.
- Convergence beats choice-preservation: if you swap eggs on one Crow while the other still credits warmth to the old egg at a higher lamport, the older egg wins on both sides and the swap is undone consistently (documented in Operating notes). Swap again once both are in sync.
- Accepted races: two DIFFERENT nests tapped in the same instant on ONE instance can both pass the daily/cap reads (worst case one extra shelf egg); a stray mint between a peer's user-shelve and the successor's arrival yields one `sync` shelf row that costs no shelf spot.
- Incubating a `sync`-origin shelf egg is allowed; the swap writes NULL. The shelf can read "6 of 5" after that (documented).
- Nothing boots a gateway or the MCP server from a worktree against the live db (a plan-mandated smoke did, once, during Task 5 — crow's live crow.db got the phase-2 DDL early; benign, additive).
- **Deploy discipline:** restart every gateway before anyone claims a nest (`applyRambleEgg` is core; a phase-1 gateway drops `shelf_origin`).
- Deferred minors (all CAN WAIT per the final review): antimeridian-crossing bbox throws (route pre-validates); `getPetRow` duplicates `ensurePetRow`; `EGG_ID_RE` duplicates `MARK_ID_RE`; `flockState` mints without emit (mirrors `eggState`); `ramble_nest_claims` never pruned; docs parity test compares heading levels/order only; the claim daily/cap guard could be one SQL statement if ever needed.

## Where things are
- Spec: `docs/superpowers/specs/2026-09-07-ramble-flock-design.md`. Phase-2 plan (3 review rounds recorded): `docs/superpowers/plans/2026-09-07-ramble-flock-phase2-nests-flock-shelf.md`.
- Every ruling made during execution is listed in the PR #314 body and in this handoff (the git-ignored SDD workspace was deleted after the final review); the worktree `crow-wt-flock2` can be removed once phase 3 starts from a fresh one.

## Next
Phase 3 = contacts delivery + gifts then swaps (spec §4 contacts/group fan-out and receive, §5 `ramble_trades` — a NEW replicated table: lamport_ts, SYNCED_TABLES/EXCLUDED_COLUMNS, natural-key apply handler, shouldSyncRow, stampSql branch, outbox-door + apply-door tests — §7 gift/trade routes + tools, "share invite" on met-crow). Gift/swap wire payloads never carry species/seed. Then phase 4 (AR, spec §6). Models arc plan 2 stays queued behind the Ramble phases. Process as before: `superpowers:writing-plans` → adversarial review (two rounds + scoped check) → SDD in a fresh worktree from `main`.
