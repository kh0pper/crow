# PIR full-flow regression harness

Drives the **whole** PIR lifecycle — inbound email → review → APPROVE → close —
per PIR, sandboxed from production, and asserts a per-stage verdict over N reps.
This is the "100% reproducible accuracy" framework: every deterministic stage is
asserted correct; correctness-critical model output is validated against
independently-computed ground truth and either PASSes, **ESCALATEs** (refused to
needs-human, never shipped), or **FAILs** (silently wrong — the only outcome the
bar forbids).

## Components

| File | Role |
|---|---|
| `pir-fullflow.mjs` | Orchestrator: sandbox lifecycle, per-rep reset, drives INGEST/BOT/VALIDATE/CLOSE, writes the verdict matrix. |
| `pir-stage-assert.mjs` | Pure per-stage verdict functions (PASS / ESCALATE / FAIL) + the count gate that mirrors production `validateClaims`. |
| `capture-fixture.mjs` | One-time Gmail `format:full` capture of a PIR response → `fixtures/<pir>.json`. |
| `fixtures/<pir>.json` | Captured Gmail message (payload tree the live `ingestReplay` consumes). |
| `golden/<pir>.json` | Human-verified ground truth (case_type, attachments, counts, close contract) with per-field provenance. |
| `results/pir-fullflow/REPORT.md` | Auto-generated stage×PIR verdict matrix. |

## Stages & verdicts

- **INGEST** (deterministic): replays the captured message through the live pure
  functions (`ingestReplay` = `walkPartsForAttachments` + `classifyCaseType` +
  `extractPlainBody`, exported from `sync_pir_responses.mjs` behind an
  import-guard). Asserts case_type / attachments / body vs golden. PASS or FAIL.
- **BOT**: the bot ran and produced the required staging artifacts for its case
  type (delivery: loader.py/row_counts.json/source_inventory/README; reply:
  correspondence_reply.txt/review_email.md). Missing => FAIL.
- **VALIDATE** (the count gate): reproduces production `validateClaims` exactly —
  any tally DECLARED in `claims.json` that is not a verified count ⇒ **ESCALATE**
  (correct-or-escalate, not a failure). A fabricated impact tally stated in
  *prose* that bypassed `claims.json` ⇒ **FAIL** (silently wrong). Tight
  impact-tally context + Generation-cohort/§/year exclusions avoid the S3
  false-positive on quoted cohort ids ("Generation 17").
- **CLOSE** (APPROVE → simulated send): delivery ⇒ loader committed the golden
  `grand_total` rows to the per-rep `TEA_DB` copy AND tracker = received/done;
  reply ⇒ a reply payload is staged (send stubbed) AND lease = done.

Run verdict = FAIL if any stage FAIL, else ESCALATE if any ESCALATE, else PASS.

## Isolation model (a maintenance window, like the model swap)

**Precondition:** PIR systemd timers stopped AND `canvas-companion-web` stopped
(the harness refuses to run otherwise — it needs sole-writer + port `:8080`).

- **Tracker/notes**: the harness launches a dedicated `canvas-companion` uvicorn
  on `:8080` pointed at a **copy** of `canvas.db` via the new `CANVAS_DB_PATH`
  env override (default unchanged → prod-safe). The bot's hardcoded `:8080`
  lands in throwaway state; prod `canvas.db` is never opened.
- **Loader commit**: each rep exports `TEA_DB=<fresh per-rep copy>` (loader reads
  `os.environ["TEA_DB"]`); pre-existing `research_pir<pir>_*` tables are dropped
  from the copy so the duplicate-guard never masks the commit.
- **Filesystem**: writes to the real `_staging` (the bot's `write_paths` are
  fail-closed there) and snapshot/restores it. Holding dirs are read-only inputs.
- **crow.db**: `research_sources` rows added during a run are deleted by
  watermark; the rep's `bot_sessions` row is reset.
- **Model serving**: the harness owns `pir_model_swap.sh` (27B reply / 35B
  delivery) with a fail-safe restore to the 35B daily driver on exit/SIGINT.

## Usage

```bash
# stop prod first (maintenance window):
sudo systemctl stop mpa-pir-response-sync.timer mpa-pir-processor-dispatch.timer
sudo systemctl stop canvas-companion-web.service

node pir-fullflow.mjs --pir 2502592 --runs 1 --tag proof      # one PIR
node pir-fullflow.mjs --all --runs 5                          # whole golden set, N=5
node pir-fullflow.mjs --pir 2503540 --ingest-only             # deterministic INGEST only (no model)

# restore afterward:
sudo systemctl start canvas-companion-web.service
sudo systemctl start mpa-pir-response-sync.timer mpa-pir-processor-dispatch.timer
```

Flags: `--ingest-only`, `--no-approve`, `--keep-sandbox`, `--no-swap`.
Env: `PIBOT_TURN_TIMEOUT_MS` (default 25 min — the 27B needs it on complex
replies), `PIR_FULLFLOW_RUN_TIMEOUT_MS`.

## Proven (2026-06-04)

- **Delivery 2502592** (35B, 1 rep): INGEST/BOT/VALIDATE/CLOSE all **PASS**.
  Loader committed exactly **4742** rows (= human-verified `csv.reader` total) to
  the TEA_DB copy; tracker → received/done. `claims.json` =
  `{4742,1043,1070,1069,1063,497}` (all verified). Isolation verified: prod
  `tea_data.db` + `canvas.db` untouched, staging restored, copies cleaned.
- **Reply 2503540** (27B): the count-accuracy case. After the `claims.json`
  lock-in, 2/2 lock-in runs stated the correct **27 / 8** (one as structured
  `claims.json`), VALIDATE PASS — vs 0/5 correct before the count hardening.

## Golden provenance (review S5)

Correctness golden is **independently computed**, never the bot's own prior
output: delivery row totals come from a direct `csv.reader` on the source CSVs
(not the bot's `row_counts.json`); 2503540's 27/8 from a direct PDF re-read.
Pipeline-derived values would be regression anchors only ("reproducible", not
"correct").
