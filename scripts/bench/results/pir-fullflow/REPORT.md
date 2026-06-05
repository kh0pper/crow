# PIR full-flow verdict matrix — FINAL

Harness: `scripts/bench/pir-fullflow.mjs` (email → close, sandboxed, per-stage
verdicts). Scorer: `scripts/bench/pir-stage-assert.mjs`. Golden set: 2 PIRs
(1 reply, 1 delivery), **N=5 reps each**, 2026-06-05, under the corrected design:
Qwen-recommended sampling + directory-lock isolation + commit-verification gate.

Bar: **zero FAIL** (silently wrong); deterministic stages all PASS; model stages
PASS-or-ESCALATE. Verdicts: **PASS** (correct) · **ESCALATE** (refused to
needs-human, never shipped — acceptable) · **FAIL** (silently wrong — forbidden).

## Matrix (N=5)

| PIR | case | model | INGEST | BOT | VALIDATE | CLOSE | result |
|---|---|---|---|---|---|---|---|
| 2503540 | reply | 27B @ temp 0.7 | PASS×5 | PASS×5 | PASS×5 | PASS×5 | ✅ **PASS×5** |
| 2502592 | delivery | 35B | PASS×5 | PASS×5 | PASS×4 / ESC×1 | PASS×5 | ✅ **zero FAIL** (4 PASS / 1 ESCALATE) |
| 2502803 | delivery | 35B | PASS×2 | PASS×2 | PASS×2 | PASS×2 | ✅ **PASS×2** (committed 4374; scale add) |

**Both paths meet the bar: zero FAIL.** No silently-wrong output on either, across
10 model runs. Production was verified leak-free after every window (`leak=0`).

- **Reply 2503540: green & stable** — 5/5 PASS, each stating the correct **27/8**
  (`claims.json={27,8}` or `{27,8,35}`). The move from greedy to the Qwen
  non-thinking preset (temp 0.7) did **not** degrade reply correctness.
- **Delivery 2502592: zero FAIL** — 4 reps committed exactly **4742** rows to the
  per-rep tea copy (PASS); 1 rep (run1) put a derived stat `unique_districts:1108`
  into claims.json, which is not a verified row count, so the gate **escalated to
  needs-human** (caught, never shipped — its row counts were still correct). The
  PASS/ESCALATE flap is the non-greedy 35B + the count gate doing its job; never a
  wrong number reaches a human as fact.

## Design that achieves "correct-or-escalate, zero FAIL"

- **Sampling:** the PIR 27B runs at the Qwen non-thinking preset (temp 0.7 / top-p
  0.8 / top-k 20 / min-p 0), not greedy — greedy hurt this reasoning model's
  quality and bought only partial, agentic-loop-limited reproducibility. Safety
  comes from the validator/escalate layer, not from forcing determinism.
- **claims.json count gate:** every numeric tally the bot declares must equal a
  computed_facts value; otherwise ESCALATE. Scoped to data-row/entity tallies.
- **Commit-verification gate** (`dispatch_pir_processor.mjs verifyDeliveryCommit`):
  a delivery finalizes `received` only if the loader actually wrote the claimed
  rows (research_pir<N>_* in tea_data.db == row_counts.json total); otherwise it
  reverts to processing/needs-human. The bot's "success" reply is not proof.
- **Stage reclassification:** incomplete staging and an unverified commit are
  ESCALATE (production escalates both), never FAIL.

## Harness defects found & fixed (the matrix caught its own bugs + the model's)

1. **Detector false-positive** (reply): an "April 6" date read as an impact tally.
   Tightened `impactTallyNumbers` (adjacency + month/generation exclusions).
2. **claims.json over-broad** → VALIDATE flap. Scoped to data-row tallies (prompt
   → pi_bot_defs).
3. **PROD ISOLATION LEAK (×3, critical).** The agentic bot IMPROVISES a write to
   the prod tea_data.db path it knows from its prompt, bypassing the staged loader
   + env redirect; and a file-level `chmod 444` net is BYPASSABLE for a WAL db
   (writes go to -wal/-shm in the still-writable directory). Result: 4742 rows
   leaked to prod (caught + cleaned each time, integrity intact). **Fix: lock the
   tea DIRECTORY (chmod 555)** — verified on the real dir to return SQLITE_READONLY
   while the separate sandbox dir stays writable. After the fix, an N=2 probe and
   this N=5 both ended `leak=0`, including a rep whose bot tried (and was blocked
   from) a prod write.
4. **`.backup` hang** (held the window → a 13.5 h outage). `sqlite3 .backup` of the
   338 MB WAL prod db hangs because the texas-gov-data MCP holds it open. Fix:
   per-rep tea is a **fresh empty db** (the loader only CREATEs tables).
5. **No self-bounding window** (the 13.5 h root cause). Added an **out-of-process
   deadman** (hard cap, default 2 h) that force-restores prod even if the event
   loop is blocked; window setup moved inside try so any setup failure
   auto-restores; killSignal/timeout on every external call. Verified across many
   crashes: prod always came back.
6. **Self-managed window** via `LAB_SUDO_PASS` (harness stops/starts canvas-web +
   PIR timers itself), so the deadman can fully restore.

## Status

- Reply path: **done, green, stable** (5/5 PASS).
- Delivery path: **zero FAIL** (4 PASS / 1 ESCALATE), leak-free, isolation proven.
- The "100%" bar as defined — correct-or-escalate, zero FAIL, model stages
  PASS-or-ESCALATE — is **met on the 2-PIR proof tier**.

## Remaining (scale)

Expand golden refs to full Tier-1 (~15) and the 58-PIR corpus, then `--all
--runs 5`. Golden construction is the bounded cost; the harness, isolation,
deadman, and gates are in place. Operational note: every window stops prod
canvas-web + locks the prod tea dir read-only — now deadman-bounded and
self-restoring, but keep windows short.
