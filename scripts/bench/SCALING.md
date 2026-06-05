# Scaling the PIR full-flow golden set (Tier-1 → 58 corpus)

The harness, isolation (directory-lock), deadman window cap, commit-gate, and
Qwen-recommended sampling are all in place and proven. Scaling is now purely
**per-PIR golden construction** — the bounded, repetitive effort the plan flagged
(~10-15 hrs for Tier-1, ~50-70 hrs for the full 58). This doc is the runbook.

## Per-PIR recipe

For each new PIR:
1. **Capture the fixture** (the entity's response email, `format:full`):
   `node scripts/bench/capture-fixture.mjs <pir> --msg <gmail_id>`
   Find the gmail id: search `subject:<pir> from:PIR` (TEA) or the entity's
   address; pick the "Release Documents" / substantive-response message (not the
   receipt/acknowledgement). For non-TEA portals (GovQA), search the portal
   sender. `inbound.json` in the holding dir has the id for recently-synced PIRs.
2. **Build `golden/<pir>.json`** with HUMAN-VERIFIED ground truth (review S5 —
   never the bot's own output):
   - `case_type`: delivery | correspondence | cost-estimate | no-responsive.
   - `attachments`: exact list from `ingestReplay(fixture)`.
   - **delivery** `counts.grand_total` + `close.grand_total`: direct
     `csv.reader`/`openpyxl` total on the source files (header-excluded), NOT the
     bot's row_counts.json. `kickoff_state.status="requested"` so the kickoff runs.
   - **reply/PDF-count** (e.g. impact lists): the entity tally from a direct PDF
     re-read; put the verified values in `counts.verified_set`.
3. **INGEST-validate** (no model/window): `node scripts/bench/pir-fullflow.mjs
   --pir <pir> --ingest-only` → INGEST must PASS.
4. **End-to-end**: include in the next `--all` run.

## Tier-1 status (15)

| PIR | case | golden | fixture | notes |
|---|---|---|---|---|
| 2503540 | reply (impact 27/8) | ✅ | ✅ | PASS×5 |
| 2502592 | delivery | ✅ | ✅ | zero-FAIL N=5 (total 4742) |
| 2502803 | delivery | ✅ | ✅ | PASS N=2 (total 4374) |
| AISD-R873 | correspondence (FERPA) | ▢ | ✅ | reply; ground truth = case_type + item resolutions |
| 2503528 | delivery | ▢ | ▢ | plan cites 114,531 rows; holding dir has PDFs only — data may be in a zip/already-loaded; verify source before golden |
| 2502721 | reply? (5 PDFs) | ▢ | ▢ | classify; likely correspondence/no-responsive |
| KIPP-PPE-2 | delivery (XLSX) | ▢ | ▢ | 4 EnrollmentSummaryReport.xlsx — need openpyxl row counts; may be summary not row data |
| CISD-2 | cost-estimate | ▢ | ▢ | cost-estimate model form + xlsx form (not a data load) |
| 2502803/... | — | — | — | — |
| 1, 4, 5, 9, 11, 14, 15 | mixed (PDF-heavy; 11 = 13 csv + 78 pdf) | ▢ | ▢ | classify each; delivery ones get csv/xlsx totals, reply ones get case_type |

(▢ = to do.) The PDF-heavy numeric PIRs (1, 14, 15, 5, 9, 11) need per-PIR
classification + count verification; the reply ones are cheap (case_type only),
the delivery ones need source-file totals.

## Run

```bash
# one PIR
node scripts/bench/pir-fullflow.mjs --pir <pir> --runs 5 --tag final
# whole golden set (every golden/*.json), self-managed window + deadman:
LAB_SUDO_PASS=... PIBOT_TURN_TIMEOUT_MS=1500000 PIR_FULLFLOW_WINDOW_CAP_MS=10800000 \
  node scripts/bench/pir-fullflow.mjs --all --runs 5 --tag final
```

**Cost note:** reply PIRs run on the 27B at ~12-15 min/rep, so N=5 over ~8 reply
PIRs is ~8-10 hrs of 27B time → best as an overnight `--all`. Delivery PIRs run on
the 35B at ~5 min/rep. Every window stops prod canvas-web + locks the prod tea
dir read-only (deadman-bounded, self-restoring) — keep `--all` to off-hours.
