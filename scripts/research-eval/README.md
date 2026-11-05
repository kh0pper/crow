# Research-reliability eval

Measures whether a research bot that follows the `research-pipeline` skill reports what the page
says, not what a search snippet says. The design and the live results are kept in the private
engineering notes; this directory holds the harness that scores a run and the live runner that
drives a real model through Crow's own path.

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
aid only and must not be used for a verdict; nothing in the code stops it.

## Trajectories

`trajectories/<case>.json` holds recorded bot behavior for each case, as a variant `{steps, fails}`, where `steps` is a list of
`{call, args}`, `{batch: [...]}` or `{say}` and `fails` names the criteria it must fail. `$project` and `$source:<url>` placeholders resolve
to numbers. Base trajectories per case: `careful` (should pass), `hank` (the snippet-trusting
failure; each lists the criteria it must fail) and `correcting` (corrects the snippet's wording
in prose). Adversarial ones are named `<case>.<name>` (`rr07.trimmed`, `rr01.batch`,
`rr01.overclaim`, `rr10.fetched-derived`, `rr01.misquote`, `rr11.fetched-dead`), run on that
case only, and each must fail exactly the check it targets, through the real tools.

## Harness mode vs live mode

**Harness mode** (`--mode=harness`, the default) replays a recorded trajectory by calling the
real MCP tools directly from the MCP client, with no model and no `pi` process. `pi` is not a
dependency of this repo or on CI runners, so this lets CI exercise the whole path: tools,
database, session log, scorer, report. The session log has the same shape the `pi` driver writes,
so the scorer does not change between the modes.

**Live mode** (`--mode=live`) runs one real model through the real driving path —
`handleInbound()` in `scripts/pi-bots/bridge.mjs` (the design's §3.3 first choice, and the one
this build took: it gives `buildBotWorld` → `writeBotMcp` → `pi --mode rpc` and the real pi session
JSONL under the world's `sessions/`) — inside a throwaway scratch instance, with the research
server's network edges replaced by the case's fixture. The full flow lives in
`scripts/research-eval/live.mjs`; nothing in it starts, warms or swaps a model.

Flags (see `LIVE_USAGE` in `live.mjs`):

```
run.mjs --mode=live --arm=<label> --base-url=<direct endpoint>/v1 --model=<id> --out=<file>.jsonl
  --pi-cli=<abs pi dist/cli.js> --pi-lab=<abs pi-lab checkout> --prod-max-pi=<n> --no-judge --window-end=<ISO>
  [--allow-host=<host:port>[,<host:port>]] [--pi-model=<file.json>] [--reps=3] [--cases=<dir>]
  [--turn-min=15] [--wall-min=240] [--sessions-dir=<dir>] [--resume]
```

`--no-judge` is required: the first run is strict, so a sentence the scorer would route to a judge
counts as `undecided` and is non-pass (design §13; ruling 2026-11-05). `--judge-config` is refused
with "a cloud judge is not wired yet (ruling 2026-11-05)". `--concurrency` must be 1 (one slot in a
registered window), and `--out` / `--sessions-dir` are refused inside the repo checkout and inside
the real user's crow dir.

Live exit codes: 2 usage or a driver refusal, 3 `--out` not empty and no `--resume`, 4 preflight
refused (the endpoint, its `/models` list, or the arm's seed/`top_k`/`min_p` support), 5 the wall
cap or the window end was reached (rows already written stay; `--resume` continues).

### What live mode checks before it trusts a row

1. **A direct single-model endpoint.** `checkEndpoints` (the driver's own guard): no gateway port,
   no `/llm/` or `/proxy/` path, loopback or an explicit `--allow-host`. A lazy loader (ollama,
   llama-swap and friends) is refused: a server that swaps models in on request is a router.
2. **`/models` lists exactly the one `--model`,** "loaded" where the server exposes a status
   (re-checked before every unit). A router-mode server that lists unloaded models is refused.
3. **The arm honours `seed`, `top_k` and `min_p`** — the three pinned settings that
   llama-server's OpenAI-compatible `/v1/chat/completions` takes in the request body. No `/props`
   read or doc quote can prove a *request* field is honoured, so this is a minimal deterministic
   probe, once per run: three pairs of 4-token completions. Two identical seeded requests must
   return the same text (the seed reaches the sampler); with `top_k=1`, and separately with
   `min_p=1`, two requests that differ only in the seed must also return the same text, because
   both settings make the choice greedy. That proves the field is applied at all, not that
   intermediate values are. An arm that fails is refused, not recorded as unseeded.
4. **The seam ran.** Every turn must report `mcpOverridden == ["crow-projects"]` (the override
   replaced exactly the one block), every model request must offer exactly the granted 13 tools,
   and the fixture server must have written its start marker (pid, case id, run id) into the
   scratch home. Any of these failing ABORTS the run (exit 2): they are deterministic, and a row
   from a run where the real research server may have run is worthless.
5. **Only transport trouble is retried** (a connection error, a 5xx, survivors, a missing session):
   a fresh scratch, the SAME seed, at most 3 attempts. A timeout, a context overflow or a 400 is
   scored or flagged and never re-rolled. Rows record `attempts` and every attempt's reason, and
   `report.mjs` prints the per-arm retry count.

### The sampling proxy

`pi-ai` sends only `temperature`, so a live row would otherwise record a sampling setting nobody
enforced. `scripts/research-eval/sampling-proxy.mjs` sits between pi and the arm's endpoint on
loopback: it forwards only `GET /v1/models` and `POST /v1/chat/completions` for the one model, pins
temperature 0.7 / top_p 0.95 / top_k 20 / min_p 0 / seed `1000 + rep` on every chat request,
records what it put on the wire (a row's `sampling` is that observation, not the constant) and the
tool names pi offered (`sampling_proxy.tools_ok`). When pi's request closes it destroys the upstream
request, so a killed turn never leaves the arm's model generating; the connect and the idle wait are
both bounded.

### Isolation and what it is not

Every unit gets a fresh scratch `CROW_HOME` under the temp dir (refused if it overlaps the real
user's crow directory or a protected instance dir). The bot's only tools are the fixture research
tools (`pi_builtin: []`, no bash, no fetch, no browser, no project), the bot's only provider is the
loopback proxy, and gateway variables are pinned to a closed port. `PI_OFFLINE=1` is pinned into
pi's env, so pi's startup model refresh, version check and telemetry stay off.

**This is not a sandbox.** Like the driver's own header says, live mode relies on the endpoint
allowlist, the checked tool surface and the proxy — not on a network namespace. Containment is
never selected for an eval child: its network namespace would also cut off the loopback sampling
proxy the arm runs through.

### CI and the local run

Live mode never runs in CI. CI runs the seam, proxy, preflight and runner tests with the stub pi
and the loopback stub model, and the harness. The real-pi end-to-end
(`tests/research-eval-live-real.test.js`) needs pi's `dist/cli.js` and a pi-lab checkout
(`PI_CLI` / `PI_LAB_DIR`) and skips in CI with "pi not installed"; it is run locally before merge.

**To be confirmed by the orchestrator's local run** (design Task 0; these are questions, not
facts):

- whether pi 0.85.1 accepts `pi_builtin: []`;
- whether the MCP client hands the block's env to the fixture server, and whether it also inherits
  `TMPDIR` (the override names it; nothing depends on it arriving);
- whether the provider id `arm` survives `piProviderIdHere`.

If pi turns out to send `top_k`, `min_p` and `seed` itself, the proxy stays: it is what records the
sampling the run actually used.

## Commands

Use a scratch directory outside the repo (the examples use `${TMPDIR:-/tmp}/rr`).

```
npm test -- tests/research-eval.test.js tests/research-eval-harness.test.js tests/research-eval-live.test.js
node scripts/research-eval/run.mjs --mode=harness --trajectory=careful --reps=3 --out=${TMPDIR:-/tmp}/rr/careful.jsonl
node scripts/research-eval/run.mjs --mode=harness --trajectory=correcting --judge=stub-pass --reps=3 --out=${TMPDIR:-/tmp}/rr/correcting.jsonl
node scripts/research-eval/report.mjs ${TMPDIR:-/tmp}/rr/careful.jsonl ${TMPDIR:-/tmp}/rr/correcting.jsonl

# Live (inside a registered window; the endpoint the operator brought up — nothing here starts a model)
node scripts/research-eval/run.mjs --mode=live --arm=<label> --base-url=http://127.0.0.1:<port>/v1 \
  --model=<id as /models lists it> --out=<private dir>/rows.jsonl --pi-cli=<abs pi dist/cli.js> \
  --pi-lab=<abs pi-lab checkout> --prod-max-pi=<n> --no-judge --window-end=<ISO>
node scripts/research-eval/report.mjs <private dir>/rows.jsonl
```

### run.mjs flags

- `--mode=harness|live`: `harness` (default) or live (see above; its own flag set).
- `--trajectory=careful|hank|correcting|<case>.<name>`: required in harness mode.
- `--out=<file>.jsonl`: required. Its directory is created automatically. One JSON row is appended per (case, rep) as soon as it exists.
- `--resume`: continue into an existing `--out`, skipping rows already there (keyed by arm, case, rep). Without it, a non-empty `--out` is refused (exit 3): a rerun writes into a new file.
- `--reps=3` (default 3), `--concurrency=4`, `--arm=<label>` (default `harness-<trajectory>`), `--model=<id>` (default `stub`).
- `--cases=<dir>`: load the case set from that directory instead of `cases/`.
- `--judge=stub-pass`: the only judge in harness mode. Omitted means no judge.

Exit codes: 0 done; 1 unexpected error; 2 bad usage; 3 `--out` not empty and no `--resume`.
Live mode has its own codes (2 usage/refusal, 3 `outGuard`, 4 preflight refused, 5 wall cap or
window end). In harness mode a transport failure is attempted up to 3 times in all, each on a fresh
scratch, then the row is written as contaminated.

### report.mjs flags

`report.mjs [--cases=<dir>] <rows>.jsonl [...]`. `--cases` names the expected case set; without
it the expected set is the union of case ids any arm has. It prints rates (per case, arm,
criterion, case type, paired arm comparisons) and, for a **live arm on the tracked measurement
set**, the operator's gate.

**The gate** (design §14, set 2026-11-05, frozen in `report.mjs` as `GATES`): an arm may back
research bots only at **≥80% on (a), ≥80% on (b) and ≥95% on (d)**. Each criterion's statistic is
the mean over the cases where it applies of that case's criterion pass proportion (ruling G), so a
case with fewer applicable reps is not weighted more; the pooled rate is printed alongside, and
undecided (b) is non-pass. The GATE line names the bars, the set date and how many undecided spans
counted as non-pass. The gate is printed only when the arm's rows are live rows *and* their case
set is `cases/` as it is on disk (dir and sha, recorded in each row's `config.case_set`); anything
else prints "gate: not applied" with the reason. A refusal below blocks every gate line.

Verdict refusals: the report prints `NO VERDICT` and the reasons, and exits 6, for: a
contaminated or malformed row, an unreadable input file, a duplicate (arm, case, rep), a sampling setting other than the
pre-registered one, an expected (arm, case) with fewer than 3 scored reps (zero included), or
scored rep counts that differ within an arm or across arms for a case. Exit 2 is bad usage; 0
means the figures are complete. A case's pass is recomputed from `criteria`, never read from the
row's `case_pass`.

## Rules fixed before any run

- **Sampling**: temperature 0.7, top_p 0.95, top_k 20, min_p 0, seed `1000 + rep`, for every arm.
  Live mode proves the arm honours `seed`, `top_k` and `min_p` at preflight and refuses one that
  does not; a live row records the sampling the proxy actually put on the wire.
- **Undecided is non-pass.** A sentence that reaches the judge and gets no verdict (or no judge at all) makes (b) `undecided`. It counts as not passing in the headline and the (b) rate, and the undecided rows are listed separately.
- **Judge interface**: the judge is called as `judge({kind, sentence, snippet})` and nothing else, after every deterministic check has passed, and returns `{verdict: "pass"|"fail"|"undecided", reason}`. `stub-pass` passes everything and is plumbing only: it shows that marked sentences reach the judge and that a pass flows into the case result, and it says nothing about scoring accuracy. Each row records `judge_calls` (real judge invocations, the billed count; the no-judge default counts 0) and `judge_spans` (spans that reached the judge stage, judge or not).
- **Thresholds** are the operator's, set before the first live run: the 2026-11-05 gate above.
  They live in `report.mjs` as `GATES`, dated, and the statistic they use is fixed by ruling G.
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

The harness test file (52+ runs from one template, concurrency 4) takes a few seconds. The live test
file runs the sampling proxy, the preflight and the runner against loopback stubs; its runner rows
come back contaminated because the stub pi never calls a model. The real-pi file skips without a pi
install.

## Caveats

- **Harness false-fail = 0 says nothing about how often a live bot's own paraphrases false-fail.** It only shows the scorer does not fail the recorded correction wordings. How often a live bot's paraphrases of a correction fail or land in `undecided` is measured, and the judge spot-checked, in the live plan.
- **Verification-claim and correction-marker detection are wording heuristics.** Main known limits: a negation reaches only a few words (4 normally, 10 for "unable to ... verify"), so "I was not in a much better position to verify it" reads as a claim; ambiguous phrasing ("I checked the numbers") is not counted as a claim; correction markers only route a sentence to the judge and never pass it on their own; a correction worded without any listed marker is a deterministic fail; derived-value labels rely on a fixed marker list, and "about" or "approximately" do not count as labels.
- **A quote that wraps across a line break cannot match.**
- **The tool-name spelling `mcp__crow-projects__...` is checked against a real pi session** by
  `tests/live-pi-driver-fixture.test.js` (a recorded, scrubbed real-pi log re-parsed in CI).
- **Live mode's real-pi end to end is local only** (see above); CI covers it with the stub pi, which
  never calls a model, so a CI live row is honestly `contaminated: "no model request passed the
  sampling proxy"`.
- Live results, thresholds' history and the judge choice live in the private engineering notes.
