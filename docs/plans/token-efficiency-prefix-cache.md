# Token efficiency: stabilize Crow's local prompt prefix so llama.cpp KV cache hits

## Session kickoff — START HERE

You are a **fresh session taking over this work** with no prior conversation. This doc is
self-contained; read it top to bottom.

- **Scope for the NEXT session: Phase 1.** Phase 0 (measurement) is **DONE** — see
  "Phase 0 results" below. Still **no code changed yet**. Apply the `buildPreamble` date fix,
  measure (isolated + contended), and gate on the accuracy floor recorded below.
- **Current state (handoff 2026-06-02):** Phase 0 measurement complete (read-only, no code touched).
  Root cause **confirmed** (the `buildPreamble` date line is the sole prefix buster) and the KV-cache
  mechanism **verified working** (~13× prefill speedup on a hit). Observability path, the buster
  location, and the accuracy noise floor are all recorded below. The prior Headroom compression
  evaluation is complete and torn down — **do not revisit compression** (verdict: ~0% benefit on
  Crow). All work happens in `/home/kh0pp/crow`. Local chat model: `qwen3.6-35b-a3b` at
  `http://100.118.41.122:8003/v1`. Throwaway measurement scripts live at `~/.crow/eval/tokeneff/`
  (`probe.py`, `cachehit.py`, `buster_diff.mjs`, `noise_floor.py`, `noise_raw.json`).
- **To begin:** read this whole doc, then start at **Phase 0.1** (observability reality check on
  `:8003`). Put throwaway measurement/accuracy scripts under `~/.crow/eval/tokeneff/` (outside the
  repo). Keep crow.db and the live services untouched while measuring.

---

## Background (why this exists)

Crow is a **local-first AI inference node**: a dashboard "AI chat", an AI Companion, and Meta Glasses
all talk to local llama.cpp / vLLM models on this box (the main chat model is `qwen3.6-35b-a3b`,
served by llama.cpp at `:8003`, single-slot `-np 1`, 256K ctx, MTP/speculative decoding on). On a
local model **tokens are free**; the real costs are **prefill latency** and **context-window pressure**.

A prior investigation (2026-05-31) evaluated the Headroom compression proxy and found it gives **~0%
real benefit** on Crow's workloads (it only compresses isolated structured tool outputs, never live
agent loops; tested across pi-bots + Claude Code, OpenAI + Anthropic routes, single + multi-turn) —
**do not revisit compression.** That research identified the actual top lever for a local setup:
**prefix / KV caching** — llama.cpp reusing the attention state for the stable front of the prompt
instead of re-prefilling it every turn. This plan makes that lever work.

**Evidence the cache mechanism already works** (no new infra needed — just stop busting it): the
repo's own bench logs show `cache_n: 0` on a first request → `cache_n: 62` on a repeat, with prefill
dropping ~907ms → ~56ms on a hit (`scripts/bench/results/mtp-35b-*.log`). MTP coexists with it.

## Root cause (corrected — earlier diagnoses were wrong; trust this one)

For the **dashboard chat path** (`servers/gateway/routes/chat.js` → `generateSystemPrompt` →
`generateInstructions` → `generateCondensedContext`):

- The condensed crow.md context is **already static** (no timestamp, no dynamic memory sections).
- **Memory is NOT in the system prompt** — the model recalls it at runtime via the `crow_memory`
  tool (a tool result in history). So there is **no memory "repartition" to do.**
- `buildAddonGuidance()` is **near-static** (changes only on MCP server connect/disconnect) and is
  already trailing in the system prompt — leave it.
- **THE ONE REAL BUSTER:** `buildPreamble()` in `servers/gateway/ai/system-prompt.js:13-23` injects
  `Current date and time: <new Date()>` at **position 0** of the system prompt. It changes every
  turn → llama.cpp invalidates the entire KV prefix that follows (system + tools + crow.md +
  history). Removing it recovers ~the whole available win.

**Do NOT** use `generateInstructions({ includeDynamic: false })` — that option does not exist.
`generateDynamicSections` is private/unexported and the related `generateCrowContext` appends a
`*Generated: <timestamp>*` line, so it is not byte-stable. The chat path doesn't call those anyway.

## The fix (minimal — for Phase 1, AFTER measurement + go-ahead)

Remove the volatile date from the static system preamble. If date freshness is wanted, append a
single `Current time: <now>` line to the **latest user message** (the tail is reprocessed every turn
regardless, so it costs nothing and cannot bust the prefix).

- `servers/gateway/ai/system-prompt.js:13-23` — drop the `new Date()` / "Current date and time" line
  from `buildPreamble()`; keep the rest of the identity text static. Do not touch the
  condensed-context call.
- `servers/gateway/routes/chat.js:669-684` — (optional) prepend the one-line timestamp to the
  current user message in the `aiMessages` tail, next to the existing slash-strip (which already only
  rewrites the last message — safe, it can't poison the prefix).
- `servers/gateway/ai/adapters/openai.js:172-176` — add cache observability, but **verify the field
  exists first** (Phase 0.1): llama.cpp usually only emits `timings` /
  `prompt_tokens_details.cached_tokens` with `timings_per_token: true` or on non-streamed responses,
  and the gateway streams (`stream: true`, `openai.js:108`). A `GET :8003/slots` poll may be the real
  measurement path.

## Execution

### Phase 0 — verify assumptions, read-only (THIS SESSION; no behavior change)
1. **Observability reality check.** Probe `:8003` to confirm whether the streaming chat path can
   actually see `prompt_tokens_details.cached_tokens` / `timings.cache_n`. If not, use `GET :8003/slots`
   or a non-streamed probe for measurement. Don't build verification on a field that isn't returned.
2. **Empirical buster diff (proves the root cause).** Capture the exact request bodies of **two
   consecutive real dashboard chat turns** (instrument `openai.js` to dump the outgoing body, or
   replay via the gateway) and byte-diff them to find where the common prefix first diverges. Confirm
   it's the date. Also surface the **history busters** to watch in Phase 2: `tool_calls` JSON
   re-serialization + empty-args fixup (`openai.js:54-74`) and per-request presigned image URLs
   (`chat.js:651`, `expiry:3600`) embedded in historical messages.
3. **Accuracy noise floor.** Build a ~15-20 task set covering the four areas the user requires
   preserved — **memory recall, tool-calling, persona/writing-style, multi-turn coherence** — and run
   it **N≥3 times UNCHANGED** to measure run-to-run variance (the 35B is an MTP reasoning model; temp 0
   is NOT deterministic). Set the regression threshold above that noise floor. Deterministic
   assertions where possible: tool-calls = exact tool name + arg-key set; persona = regex (no em-dash,
   no "not X, but Y", `[crow: …]` notes present); open-ended = `grackle-embed` cosine vs baseline,
   threshold above measured noise.

**Then STOP and report** the numbers (current cache-hit ≈ 0 on the system prefix, the buster
location, observability path, and the accuracy noise floor). Await go-ahead before Phase 1.

### Phase 0 RESULTS (executed 2026-06-02, read-only — no code changed)

**0.1 Observability — streaming CAN see cache metrics (the plan's worry was unfounded), but only if
the request opts in.** `:8003` returns both `timings.cache_n` and
`usage.prompt_tokens_details.cached_tokens` on **streamed** responses **when the body adds
`timings_per_token: true` + `stream_options: {include_usage: true}`**. The gateway today sets
**neither** (`openai.js:103-109`), so it is blind to cache state right now. Phase-1 observability is
therefore a small *additive* request-body change — **no `/slots` polling required** (though `/slots`,
`/props`, `/tokenize` are all available as fallbacks).

**0.2 Buster CONFIRMED + cache mechanism VERIFIED.**
- Mechanism works (5 rapid identical repeats, isolated from contention): run 1 cold `cache_n=0,
  prompt_n=277, prompt_ms=465.6` → runs 2-5 warm `cache_n=273, prompt_n=4, prompt_ms≈34` =
  **~13× prefill speedup**. When identical requests are separated by live companion/glasses/dashboard
  traffic on the single `-np 1` slot, `cache_n` falls back to **0** (contention resets the prefix —
  the Phase-1 contended risk is real and observable).
- Reconstructing the live system prompt: `crow.md` condensed context is **byte-identical across calls**
  (1792 chars, no timestamp — `generateCondensedContext` is static; the timestamped
  `generateCrowContext:81` / `getFallbackDocument:389` are NOT on the chat path). The **only** volatile
  element is `buildPreamble()`'s `Current date and time: …` line at char 213 (~token 70) of a 921-token
  system prompt. A date change invalidates **~851 system tokens + all tool schemas + the entire
  history**.
- ⚠️ **NUANCE not in the original plan:** the date string is **minute-granular** (`"…, 08:30 AM CDT"`,
  no seconds). Two turns in the *same clock minute* produce an identical prefix → **no bust**. The
  buster fires **only across minute boundaries**, so human-paced chat (>60s think time) ≈ near-100%
  bust while rapid in-minute agentic tool-loops *already* reuse. **Phase-1 implication:** measure the
  "isolated consecutive turns" with a realistic >60s gap (or step the system clock / mock the date),
  not back-to-back, or the Phase-0 baseline won't even exhibit the bust.
- **Phase-2 history busters (surfaced as required):** presigned image URLs re-signed per request
  (`chat.js:654`, `expiry:3600`, image convos only); `tool_calls` re-serialization (`openai.js:55-71`,
  affects most agentic convos).

**0.3 Accuracy noise floor (faithful — driven through the real gateway `/chat` → `crow-chat`/`:8003`
path; 16 tasks × 3 unchanged runs; `noise_floor.py`).**

| Dimension | Run-to-run stability | Use as Phase-1 tripwire? |
|---|---|---|
| Tool-category selection | 3/3 unanimous every task (crow_memory / crow_discover / crow_blog) | **Yes — must stay unanimous** |
| Multi-turn coherence | 3/3 unanimous (july / bluebird / 42) | **Yes — must stay unanimous** |
| Open-ended self-consistency | cosine 0.78–0.96 | **Yes — require ≥ ~0.78** |
| Memory recall self-consistency | cosine **0.50–0.59** | **No** — noise dominated by variable tool-loop depth (1 vs 8 memory calls per run) |
| Persona "no em-dash" | 2/4 unanimous-FAIL, 2/4 flip | **No** — already violated at baseline (the 35B emits em-dashes despite crow.md, independent of this plan) |

**Recommended Phase-1 accuracy gate:** tool-category selection + multi-turn coherence must remain
unanimous, AND open-ended answer cosine (changed-prompt vs Phase-0 baseline) **≥ 0.78**. Do NOT gate on
recall cosine (floor 0.50) or persona em-dash (baseline-broken); flag persona separately as a
pre-existing, unrelated issue so the date fix isn't blamed for it.

### Phase 1 RESULTS (executed 2026-06-02 — fix applied, measured, accuracy-gated: PASS)

**Code change (committed `897d439`, 3 files):**
- `system-prompt.js` — `buildPreamble()` is now static (date line removed).
- `chat.js` — the current date/time is appended to the **latest user message only** (tail is
  reprocessed each turn → preserves date awareness, cannot bust the prefix). Applied alongside the
  existing slash-strip, both guarded to the last user turn.
- `openai.js` — prefix-cache observability: `stream_options.include_usage` for all providers;
  `timings_per_token` gated to local endpoints via `isLocalBase()`; a `[chat-cache]` log line +
  `cached_tokens`/`cache_n` added to the `done` usage.

**Cache win — measured two ways (both report turn-2+ reuse of the ~static prefix):**
- *Isolated (faithful replay to `:8003`, `replay_measure.mjs`):* realistic ~4.6k-token body
  (system + 9 tools + short history). CURRENT code (date changes across a minute boundary) → turn-2
  `cache_n=0`, re-prefill all 4626 tok, **6738 ms**. FIXED → turn-2 `cache_n=4541`, re-prefill 58 tok,
  **~230 ms** = **~29× faster prefill** (reproduced before+after, not a contention artifact).
- *Production end-to-end (live gateway after restart, `[chat-cache]` log):* real prompt ~11k tok.
  First call in a fresh conversation cold (`reused=0`), **every** subsequent call — across tool-loop
  rounds and across user turns — reuses **92–99%**. Bonus: because system+tools (~10.5k tok) are now
  byte-static across ALL dashboard conversations, even a *new* conversation's first turn warms to ~96%.
- *Contended (voice-like interferer injected between two dashboard turns):* turn-2 still reused **96%**
  — a single interleaved request did NOT evict the dashboard prefix (llama.cpp retained it). Better
  than the worst-case `-np 1` assumption; sustained heavy voice load may still differ, so the
  dedicated-slot follow-up (Phase 2) remains available but is **not** warranted by current data.

**Accuracy gate — PASS (`compare_gate.py`, fix vs Phase-0 baseline):** tool-category selection 4/4
unanimous; multi-turn coherence 3/3 unanimous; pure open-ended cross-cosine 0.81–0.94 (all ≥ 0.78 and
≥ baseline self-consistency). Recall tasks (report-only) cross-cosine *exceeds* their baseline
self-consistency (0.731>0.588, 0.595>0.498) → no regression. Persona em-dash unchanged at baseline
(`persona_identity` actually improved). No behavior regression attributable to the date removal.

**Status:** fix committed to local `main` (`897d439`). Gateway restarts clean and serves chats.
**Push to origin = fleet deploy** (instances auto-pull `main`) — done per operator decision.

### Phase 2 INVESTIGATION (2026-06-03 — image-history buster: DISPROVEN; plus a regression fix)

Investigated the "per-request presigned image URL busts the prefix" hypothesis because the operator
uses vision heavily. Findings:
- **The image-URL buster does NOT exist.** A presigned URL is *fetch metadata* — it is never in the
  model's token sequence. The KV cache is keyed on the resulting tokens (text + image embeddings),
  which are identical for the same image no matter how often the URL is re-signed. Verified on `:8003`:
  with a stable image in history, turn-2 reused **524/528** tokens (system + the image-bearing turn);
  image tokens cache exactly like text. So re-signing cannot bust the prefix. **No fix needed.**
- **Vision routing reality (corrects a plan assumption):** dashboard image messages route via the
  smart-router to **`grackle-vision`** (vLLM), not `:8003`. `:8003`'s llama.cpp build has **no curl
  support** (`error: cannot make GET request`) — it only accepts base64 `data:` URLs. The
  companion/glasses vision path (`servers/gateway/ai/vision.js`) already sends base64 (stable). So the
  `:8003` prefix is never touched by a remote image URL.
- **REGRESSION FIXED (`1c97247`):** the Phase-1 observability added `timings_per_token` to *all* local
  endpoints by IP — which includes the **vLLM** providers (`grackle-vision`, `crow-dispatch`). To
  avoid any chance of breaking the vision chat path on an unknown request field, dropped
  `timings_per_token` entirely and rely on the OpenAI-standard `stream_options.include_usage` →
  `cached_tokens` (verified: llama.cpp reports it without the flag — 0 cold → 293 warm; `[chat-cache]`
  still logs 99% reuse on `:8003`).
- **Adjacent open question (NOT cache, possible functional edge — unverified):** a multi-turn dashboard
  conversation that mixes an image turn (→ `grackle-vision`) with a later text-only follow-up
  (→ `crow-chat`/`:8003`) would send the historical image to `:8003` as a remote URL it cannot fetch.
  Whether this errors in practice depends on storage availability + routing and was not confirmed
  (dashboard image chat appears lightly used). Worth a separate look if multi-turn dashboard vision is
  used; out of scope for the prefix-cache effort.

Phase 2 cache work (history busters, dedicated slot) **closed — current data does not warrant it.**

### Phase 1 — apply the date fix, measure under realistic conditions, gate on accuracy (NEXT SESSION / after approval)
4. Make the `buildPreamble` change (+ optional latest-turn timestamp).
5. **Measure two ways, report both:**
   - **Isolated:** consecutive dashboard turns → expect turn-2+ `cache_n` to jump and `prompt_ms` to
     fall vs the Phase-0 baseline (~0).
   - **Contended (the honest number):** same, but with a background companion/glasses escalation load
     on the shared `:8003` slot. The companion and Meta Glasses both escalate to
     `crow-chat/qwen3.6-35b-a3b` = `:8003` via `servers/gateway/routes/llm-router.js:18-20,39`. With
     `-np 1`, a voice turn landing between two dashboard turns resets the single slot's prefix → the
     win only lands when dashboard turns are consecutive. Report how much survives.
6. **Accuracy gate:** rerun the harness; require no regression beyond the Phase-0 noise floor across
   all four areas. Any divergence → stop and surface for human review before keeping the change.

### Phase 2 — conditional follow-ups (only if Phase 1 data justifies)
- **History busters:** if Phase 0.2 showed `tool_calls` re-serialization or image URLs break
  mid-conversation reuse, stabilize them (canonical JSON serialization; defer/omit URL re-signing in
  historical turns).
- **Slot contention:** if the contended number is poor and voice traffic is frequent, evaluate a
  dedicated dashboard slot vs voice slot (or `-np 2` + prefix-affinity). Larger infra change —
  deferred until numbers warrant.

## Verification / done criteria
1. Gateway starts clean: `node servers/gateway/index.js --no-auth` (from repo root), open dashboard,
   send a chat. Gateway tests: `servers/gateway/__tests__/`; network invariant:
   `tests/auth-network.test.js`.
2. **Cache win (isolated):** turn 1 `cache_n ≈ 0`; consecutive turns 2+ show `cache_n` ≈ static
   system + prior history size and a clear `prompt_ms` drop — vs the Phase-0 baseline that stayed ≈ 0.
3. **Contended number reported** alongside, so the production-realistic gain is explicit.
4. **No accuracy regression:** harness within the Phase-0 noise floor.

## Rollback / safety
Core change is ~3 lines in `system-prompt.js` (+ optional one line in `chat.js`); `openai.js`
observability is read-only. Revert via `git`. No DB schema change required for the core fix. Gated on
the accuracy harness — if behavior regresses, revert the prompt change and keep only observability.

## Scope notes / gotchas
- **In scope:** the dashboard AI chat path on the local 35B. **Out of scope:** pi-bots (their tool
  outputs are internal to the pi CLI, not controllable from `scripts/pi-bots/bridge.mjs`); the
  companion/glasses prompt construction is client-side, not Crow's `system-prompt.js`.
- **Deferred entirely (do not start):** tool-result truncation/offload, reasoning-token budgets,
  constrained output, semantic cache. This effort is the prefix-cache fix only.
- **Reusable harness:** `scripts/bench/mtp-explore.sh measure <alias> <label> [prose|code] [greedy|scode|sgen]`
  captures `pp_tok/s` (prefill) + gen tok/s + MTP accept from full `timings` JSON.
- **Repo rules:** commit with a positional path arg (`git commit <path> -m "…"`); `git pull --rebase`
  before pushing; never attribute Claude as author/co-author; check before adding a committed
  `CLAUDE.md`.
