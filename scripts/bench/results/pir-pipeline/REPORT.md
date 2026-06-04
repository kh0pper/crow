# PIR-processor model benchmark: qwen3.6-35b-a3b (MoE) vs qwen3.6-27B (dense)

**Date:** 2026-06-03. **Harness:** `scripts/bench/pir-pipeline-bench.mjs` (replays real PIRs through the unmodified pir-processor bot via `bridge --inject`, snapshot-bracketed, telemetry from the pi session JSONL). **Scorer:** `scripts/bench/pir-pipeline-score.mjs`. Raw runs: `scripts/bench/results/pir-pipeline/{35b,27b}/<pir>/run*/`.

Both models served on `:8003` via llama.cpp (sequential — they cannot co-reside). 35B = UD-Q5_K_XL + MTP (Vulkan, daily driver). 27B = UD-Q6_K_XL, **non-MTP** for the accuracy A/B (MTP is lossless → speed only). Corpus: **2503540** (reply w/ PDF entity list — the case that triggered this), **AISD-R873** (reply, FERPA/withholding pushback), **2502592** (CSV data delivery).

## Headline — 2503540 (the count-accuracy case)

Ground truth: TCPA gap RESOLVED (no §12.101(b-4)-qualifying expansions → no §12.1101 notifications); ILTexas (057-848) CONFIRMED; Item 3 awaits OAG; impact PDF lists **27** no-significant-impact and **8** major-impact entities.

| metric (5 runs each) | 35B (MoE) | 27B (dense) |
|---|---|---|
| produced a usable reply | **3/5** (2 total failures, no artifacts) | **5/5** |
| substantive items correct (TCPA + ILTexas) | 3/5 | **5/5** |
| **fabricated a WRONG count** | **2/5** (said 26; 25/7) | **1/5** (said 17) |
| stated the *correct* 27/8 | **0/5** | **0/5** |
| clean overall | **0/5** | **4/5** |
| median gen speed | ~46 tok/s | ~8 tok/s |
| median wall-clock | 80s | 503s |

**The 27B is markedly more reliable**: it always produced a reply and resolved the substantive items every time, and it mostly *declined to invent* a count rather than guessing wrong. The 35B both failed outright (2/5) and confidently fabricated wrong tallies (2/5).

**But neither model gets the count right (0/5 both).** The 35B guesses; the 27B omits. Correctly counting a PDF bullet list is not something either model does reliably by reading — so a model swap alone does **not** fix the original bug.

## AISD-R873 (reply, legal pushback)

| | 35B | 27B |
|---|---|---|
| valid reply | 5/5 | 3/3 |
| median wall | 106s | **679s** (longest 1162s) |

Both handle it; the 27B is ~6× slower. **Critical operational finding:** at the default `PIBOT_TURN_TIMEOUT_MS=600000` (10 min), **all** 27B AISD runs errored out mid-turn — they only succeeded after the cap was raised. The 27B needs up to ~20 min for a complex reply.

## 2502592 (CSV delivery) — confounded

The tracker row's real status is `received` (data already loaded). The **27B correctly honored** the "already received → don't reprocess" guard and stopped; the **35B ignored it** and re-staged anyway. So this isn't a clean delivery-accuracy comparison. Where the 35B did run it, its `row_counts.json` matched the source CSVs **exactly** (1043/1070/1069/1063/497) — i.e., **tool-assisted counting (wc/csv.reader) is accurate on both models; the weakness is specifically eyeballing a PDF list.**

## Speed / cost

27B ≈ **7–9 tok/s** vs 35B's **45–62 tok/s** (≈6–8× slower). Reply turns: 27B 8–20 min vs 35B 0.5–2 min. Delivery on 27B would need ~30–60+ min. MTP (prior bench) lifts the 27B to ~16.8 tok/s — still ~3× slower than the 35B; MTP changes speed, not accuracy.

## Conclusion & recommendation

1. **Model decision (made by Kevin): adopt the 27B for the PIR bot.** Justified by reliability — 5/5 usable + 5/5 substantively-correct + far less fabrication vs the 35B's 0/5-clean. Served **on-demand** (swap in for PIR processing, restore the 35B after), since it can't co-reside with the daily driver.
2. **Mandatory:** raise `PIBOT_TURN_TIMEOUT_MS` for the PIR dispatch (default 600s fails the 27B). Size ≥ 25 min for replies; deliveries need ~60 min.
3. **Still required regardless of model — prompt-hardening for counts.** Neither model counts the PDF entity list correctly by reading. Fix: instruct the bot to count PDF entities programmatically (`pdftotext | grep -c '•'`-style), exactly as it already counts CSV rows (where both models are exact). This is the actual fix for the original 27/8 miscount; the model swap reduces fabrication but does not produce the correct number on its own.
