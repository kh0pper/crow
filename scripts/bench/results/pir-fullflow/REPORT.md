# PIR full-flow verdict matrix

Harness: `scripts/bench/pir-fullflow.mjs` (email → close, sandboxed, per-stage
verdicts). Scorer: `scripts/bench/pir-stage-assert.mjs`. Golden set: 2 PIRs
(1 reply, 1 delivery), N=5 reps. Bar: zero FAIL (silently wrong); deterministic
stages all PASS; model stages PASS-or-ESCALATE; identical verdict across reps.

Verdicts: **PASS** (correct) · **ESCALATE** (refused to needs-human, never
shipped — acceptable) · **FAIL** (silently wrong — forbidden).

## Matrix (latest)

| PIR | case | reps | INGEST | BOT | VALIDATE | CLOSE | status |
|---|---|---|---|---|---|---|---|
| 2503540 | reply (27B, greedy/seeded) | 5 | PASS×5 | PASS×5 | PASS×5 | PASS×5 | ✅ green & stable |
| 2502592 | delivery (35B, non-greedy) | 5 | PASS×5 | PASS×3 / FAIL×2 | PASS×5 | PASS×3 / FAIL×2 | ⚠️ model flap (see below) |

**Reply path: done** — zero FAIL, stable ×5 on the greedy/seeded 27B.
**Delivery path: harness now correct; residual is the model.** Reps 1/2/5 run
clean (committed exactly 4742 rows to the per-rep db). Reps 3/4 are **35B
non-determinism**: rep 3 produced full staging but skipped actually running
`loader.py --commit` on APPROVE (committed=None); rep 4's kickoff produced no
staging at all. The 35B is the shared daily driver, served for speed WITHOUT
greedy/seeded sampling — so delivery verdicts flap (unlike the greedy 27B reply).

## Harness defects found & fixed (this is what the matrix is for)

1. **Detector false-positive** (reply): "April 6" date read as an impact tally —
   tightened `impactTallyNumbers` (adjacency + month exclusion). Reply green.
2. **claims.json over-broad** (delivery VALIDATE flap): scoped to data-row tallies
   only (prompt → pi_bot_defs). VALIDATE now PASS×5.
3. **PROD ISOLATION LEAK** (critical): the `TEA_DB` env override didn't reach the
   bot's loader subprocess at N=5, so 2 reps wrote **4742 rows into production
   `tea_data.db`**. Cleaned (backup `/tmp/leaked_pir2502592_pregnancy_services.sql`).
   Fixed: prod tea locked READ-ONLY during the window + the loader is force-
   redirected to the per-rep copy (prepended `os.environ["TEA_DB"]`).
4. **`.backup` hang** holding the window (caused a 13.5 h outage): `sqlite3
   .backup` of prod tea_data.db (338 MB WAL) hangs because the texas-gov-data MCP
   server holds it open. Fixed: per-rep tea is now a **fresh empty db** (the
   loader only CREATEs tables, never reads existing tea) — no prod tea copy at all.
5. **No self-bounding window** (the 13.5 h root cause): added an **out-of-process
   deadman** watchdog (hard cap, default 2 h) that force-restores prod + kills the
   harness even if the event loop is blocked; window setup moved inside try so any
   setup failure auto-restores prod; robust deadman disarm + sentinel. Verified:
   every crash this round left prod fully restored within seconds.

## Open decision (to finish delivery)

The delivery flap is the non-greedy 35B + one genuine silent-wrong mode (rep 3:
bot skips the real commit, which production would today finalize as `received`
with no data). Options:

- **A.** Run delivery on the **greedy/seeded 27B** (like reply) → reproducible,
  but ~2.5 h for N=5.
- **B.** Add **production commit-verification** (finalize `received` only if the
  loader actually wrote the expected rows; escalate otherwise) + reclassify
  empty-staging as ESCALATE → delivery becomes **never-silently-wrong (zero
  FAIL)** on the fast 35B, though verdicts still flap PASS/ESCALATE.
- **C.** Accept the proof tier: reply green; delivery lapses are *caught* by the
  harness (never shipped), documented as the speed/determinism tradeoff.

Recommendation: **B** (closes the real silent-wrong gap), optionally **A** later
for stable-green delivery too.

## Scope note

2-PIR golden set (proof tier). Full Tier-1 (~15) + 58-PIR corpus via `--all
--runs 5` is the documented remaining scale work (golden construction is the
bounded cost). Every full-flow window stops prod canvas-web + locks tea
read-only — now deadman-bounded and self-restoring, but keep windows short.
