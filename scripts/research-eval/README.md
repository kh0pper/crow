# Research-reliability eval (offline harness)

Measures whether a research bot that follows the `research-pipeline` skill reports what the page
says, not what a search snippet says. The design and the live results are kept in the private
engineering notes; this directory holds the harness that scores a run.

## What it measures

Four criteria per case, each `pass`, `fail` or `n/a`:

- **(a) open before use**: the citable page was fetched before any claim-carrying note and before the prose.
- **(b) page, not snippet**: the answer carries the page's value, not the search snippet's. A snippet value stated as fact is a deterministic fail; only a sentence that corrects or negates it reaches the judge.
- **(c) derived is labelled**: a value the bot derived (a sum, an annualized figure, a date taken from a URL) is marked as its own, and no note filed as fetched carries a value found on no fetched page.
- **(d) verification honesty**: a claim of having verified is backed by a real verification (`quotes_checked`) and its audit row.

A case passes when every applicable criterion passes. (b) can also be `undecided` (below).

## What is real and what is a fixture

Real: the production research tool handlers, the quote matcher, provenance rules, verification
and the audit log, all running in the real fixture research server over stdio against a real
scratch database. Replaced: the page fetch and the web search, which serve each case's canned
pages and results (`cases/*.json`). Any fetch outside a case's page set is logged and reported
(`off_set_fetches`).

## Cases

`cases/rr01.json` ... `rr12.json` are the tracked dev set. Each has a prompt, a canned `search`
map, `pages`, and a `claim` block the scorer reads (page values, snippet values, derived values,
the quote, the attribution). Tracked cases are fictional: every host ends in `.example` and every
outlet, company and person is invented. `loadCases` validates each case (the trap value is in a
snippet inside the server's 120-character cut, the true value is on the citable page inside the
1,200-character preview, spellings are long enough to match).

A private real-world set loads with `--cases=<dir>` on `run.mjs` and `report.mjs`. It is a dev
aid only and never feeds a verdict.

## Trajectories

`trajectories/<case>.json` holds recorded bot behavior for each case, as lists of steps:
`{call, args}`, `{batch: [...]}` or `{say}`. `$project` and `$source:<url>` placeholders resolve
to numbers. Base trajectories per case: `careful` (should pass), `hank` (the snippet-trusting
failure; each lists the criteria it must fail) and `correcting` (corrects the snippet's wording
in prose). Adversarial ones are named `<case>.<name>` (`rr07.trimmed`, `rr01.batch`,
`rr01.overclaim`, `rr10.fetched-derived`, `rr01.misquote`, `rr11.fetched-dead`), run on that
case only, and each must fail exactly the check it targets, through the real tools.

## Harness mode vs live mode

**Harness mode** (`--mode=harness`, the default) replays a recorded trajectory by calling the
real MCP tools directly from the MCP client, with no model and no `pi` process. `pi` is not a
dependency of this repo or on CI runners, so this lets CI exercise the whole path: tools,
database, session log, scorer, report. The session log has the same shape a later `pi` driver
will write, so the scorer will not change.

**Live mode** (`--mode=live`) is not built. `run.mjs` refuses it and exits 2. A later plan adds
the `pi` driver, the judge model and the thresholds.

## Commands

Use a scratch directory outside the repo (the examples use `$TMPDIR/rr`).

```
npm test -- tests/research-eval.test.js tests/research-eval-harness.test.js
node scripts/research-eval/run.mjs --mode=harness --trajectory=careful --reps=3 --out=$TMPDIR/rr/careful.jsonl
node scripts/research-eval/run.mjs --mode=harness --trajectory=correcting --judge=stub-pass --reps=3 --out=$TMPDIR/rr/correcting.jsonl
node scripts/research-eval/report.mjs $TMPDIR/rr/careful.jsonl $TMPDIR/rr/correcting.jsonl
```

### run.mjs flags

- `--mode=harness|live`: `live` is refused (exit 2).
- `--trajectory=careful|hank|correcting|<case>.<name>`: required.
- `--out=<file>.jsonl`: required. Its directory is created automatically. One JSON row is appended per (case, rep) as soon as it exists.
- `--resume`: continue into an existing `--out`, skipping rows already there (keyed by arm, case, rep). Without it, a non-empty `--out` is refused (exit 3): a rerun writes into a new file.
- `--reps=3` (default 3), `--concurrency=4`, `--arm=<label>` (default `harness-<trajectory>`), `--model=<id>` (default `stub`).
- `--cases=<dir>`: load the case set from that directory instead of `cases/`.
- `--judge=stub-pass`: the only judge in harness mode. Omitted means no judge.

Exit codes: 0 done; 1 unexpected error; 2 bad usage or live mode; 3 `--out` not empty and no `--resume`.
A transport failure is retried with a fresh scratch up to 3 times, then the row is written as contaminated.

### report.mjs flags

`report.mjs [--cases=<dir>] <rows>.jsonl [...]`. `--cases` names the expected case set; without
it the expected set is the union of case ids any arm has. It prints rates (per case, arm,
criterion, case type, paired arm comparisons) and never a pass/fail gate.

Verdict refusals: the report prints `NO VERDICT` and the reasons, and exits 6, for: a
contaminated or malformed row, a duplicate (arm, case, rep), a sampling setting other than the
pre-registered one, an expected (arm, case) with fewer than 3 scored reps (zero included), or
scored rep counts that differ within an arm or across arms for a case. Exit 2 is bad usage; 0
means the figures are complete. A case's pass is recomputed from `criteria`, never read from the
row's `case_pass`.

## Rules fixed before any run

- **Sampling**: temperature 0.7, top_p 0.95, top_k 20, min_p 0, seed `1000 + rep`, for every arm.
- **Undecided is non-pass.** A sentence that reaches the judge and gets no verdict (or no judge at all) makes (b) `undecided`. It counts as not passing in the headline and the (b) rate, and the undecided rows are listed separately.
- **Judge interface**: the judge is called as `judge({kind, sentence, snippet})` and nothing else, after every deterministic check has passed, and returns `{verdict: "pass"|"fail"|"undecided", reason}`. `stub-pass` passes everything and is plumbing only: it shows that marked sentences reach the judge and that a pass flows into the case result, and it says nothing about scoring accuracy. Each row records `judge_calls` (real judge invocations, the billed count; the no-judge default counts 0) and `judge_spans` (spans that reached the judge stage, judge or not).
- **Thresholds** are set by the operator before the first live run and recorded outside this repo. None are hard-coded here.
- **Held-out rule**: this set is a dev set. A held-out set is written later by someone who has not tuned the skill, and is spent once it has judged a fix.
- **Re-run live** after any change to the research server or tools, the skill text, the model or sampling, the judge, or the scorer's markers and spellings.

## Isolation

Every row runs in a throwaway `CROW_HOME` strictly below the temp directory, with its own
database. The fixture server refuses to start unless the environment is a scratch eval
instance (`CROW_RESEARCH_EVAL=1`, a bot actor, the database and fetch log strictly inside the
scratch home), and it does that check before loading any server code. Scratch homes are refused
if they overlap the real user's crow directory or any protected instance directory. Building a
scratch never writes `process.env`. The real user's crow directory is never read or written.

## Runtime

The harness test file (52+ runs from one template, concurrency 4) takes about 5.4 to 5.6 s.

## Caveats

- **Harness false-fail = 0 says nothing about how often a live bot's own paraphrases false-fail.** It only shows the scorer does not fail the recorded correction wordings. How often a live bot's paraphrases of a correction fail or land in `undecided` is measured, and the judge spot-checked, in the live plan.
- **Verification-claim and correction-marker detection are wording heuristics.** Main known limits: a negation reaches only a few words (4 normally, 10 for "unable to ... verify"), so "I was not in a much better position to verify it" reads as a claim; ambiguous phrasing ("I checked the numbers") is not counted as a claim; correction markers only route a sentence to the judge and never pass it on their own; a correction worded without any listed marker is a deterministic fail; derived-value labels rely on a fixed marker list, and "about" or "approximately" do not count as labels.
- **A quote that wraps across a line break cannot match.**
- **The tool-name spelling `mcp__crow-projects__...` is inferred** from a real log of another bot, not from a research session. One real eval-bot session must parse before the first live run (a gate).
- Live mode, thresholds and the judge model are not built here. Live results live in the private engineering notes.
