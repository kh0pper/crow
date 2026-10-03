# Crow Kiosk K1: kiosk page + server-side voice loop (phone-tested) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired browser (Kevin's phone in K1, the Pi 3 in K2) opens `https://crow.dachshund-chromatic.ts.net:8444/kiosk`, shows the user's Ramble bird, and holds a tap-to-talk voice conversation with its bound Crow bot. Crow runs STT, the bot turn and TTS server-side. The bot can open and close `crow_wm` windows (timer, recipe, content). End of speech to first audio is measured on the device.

**Architecture:**
- Two pieces move into core:
  - the device store moves to `servers/shared/device-store.js` (adds the `kiosk` kind, a domain-separated token hash and a throttled `last_seen`);
  - a transport-free voice turn goes in `servers/gateway/voice/turn.js` (+ `turn-helpers.js`). It is extracted from the Meta Glasses loop and keeps glasses' behaviour.
- A new `kiosk` bundle (`type: mcp-server`) does everything else. Its panel routes carry:
  - the page and assets;
  - pairing (6-digit code + poll secret);
  - the dashboard admin API;
  - the loopback-only internal API for its MCP tools;
  - a `/api/kiosk/session` WebSocket whose first frame must be `hello`.
- `crow_wm` runs in-process on the kiosk. Its window state lives on the server, and actions reach the page as `wm` events.
- `llm-router.js` exports one routing policy, `chooseVoiceRoute`, which both `/llm/v1` and the kiosk use.

**Tech Stack:**
- Node 24 ESM, Express 5, `ws`, the Node built-in test runner (`npm test -- tests/<file>`), and `linkedom`/`@libsql/client` (both already devDeps) for hermetic tests.
- The browser page uses plain ES modules, an AudioWorklet and WebAudio. It has no framework and no build step.
- Pinned containers: `fedirz/faster-whisper-server:0.5.0-cpu` (the digest crow runs today) and `ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0`.

**Spec:** `docs/superpowers/specs/2026-10-03-crow-kiosk-companion-design.md` (binding). Kevin's answers of 2026-10-03:
- Q2: local **Kokoro** TTS.
- Q4: sleep **22:30–06:30**.
- Q1: HA has no lights or thermostat, so acceptance uses Robotina + TVs (K3).
- Cameras come later (K4).

Context only: `docs/superpowers/specs/2026-10-03-cameras-frigate-ring-design.md` (K4/C phases, not in this plan).

**Base:** the plan was written on branch `docs/kiosk-companion-spec` @ `37bdac1c` (worktree `~/crow-wt-kiosk`). Implementation goes on a new branch `feat/kiosk-k1`, cut from `origin/main` **at or after `24759696`** in a fresh worktree (Task 0). This plan file and the spec ride along.

`24759696` (#416, Ramble 0.13.0 wardrobe) landed after the spec was written. It changed `bird-svg.cjs` (outfit slots, `applyOutfit`). It also gave core `readPortrait(db)` in `servers/sharing/profile-avatar.js`: the active bird plus its real decay-on-read mood plus its outfit. This plan is grounded on that main.

---

## Ground truth this plan was written against (verified 2026-10-03 on crow, read-only)

| fact | where checked |
|---|---|
| The glasses voice turn is `runVoiceTurn` at `bundles/meta-glasses/panel/routes.js:782-1335`. It holds the think gate (`:994-1025`), sentence chunking (`SENTENCE_END`, `:925`), the confirm gate (`:186-225`, `:1068-1103`) and `getConvo`/`saveConvo` (24 messages, 15 min, `:230-248`). `negotiatePcm`/`pcmStream` are at `:688-745`; `pcmStream` buffers a whole sentence before yielding. `loadBoundBotDef` has a 30 s TTL (`:750-780`). | read |
| The glasses WS authenticates on upgrade, with the token taken from `Authorization` **or the `token` query param** (`:2088`). `verifyToken` does not check `device_kind`. | read |
| `bundles/meta-glasses/server/device-store.js` is 218 lines. `device_kind` is normalised to `glasses`/`companion` only. `verifyToken` rewrites the whole JSON list on every call. Core imports it by repo path from five Bot Builder files (`servers/gateway/dashboard/panels/bot-builder/{api-handlers,editor,delete-bot}.js`). | read, grep |
| `llm-router.js`: `wantsEscalation`/`wantsToolEscalation`/`TOOL_INTENT_RE`/`resolveKey`/`defaultProbeReady` are module-private. `FAST_KEY` = `crow-voice/qwen3.5-4b` and `ESC_KEY` = `crow-chat/qwen3.6-35b-a3b` (env-overridable). `TOOL_INTENT_RE` matches `stop`, `pause`, `show me`, `play`, `open`, `search`, … | read |
| The fast model is up on vLLM at `100.118.41.122:8011`, model id `qwen3.5-4b`, **`max_model_len` 8192**. The 35B answers at `:8003`. | `curl /v1/models` |
| `faster-whisper-server` runs `fedirz/faster-whisper-server:latest-cpu`. Its digest `sha256:760e5e43…` equals Docker Hub tag **`0.5.0-cpu`**. It listens on `127.0.0.1:8004` with **`WHISPER__TTL` default 300 s**, so an idle model unloads after 5 min. It keeps an `OrderedDict` of loaded models, so several models load side by side, and it supports `PRELOAD_MODELS`. It currently holds 43 MiB (no model loaded). Compose labels point at `~/crow/bundles/faster-whisper-server/docker-compose.yml`. | `docker inspect`, in-container source |
| `:8004` is also bound on the **tailnet IP** by `llamacpp-vulkan-qwen3-embed`. That is not our concern, because whisper is loopback-only. | `ss -ltnp` |
| The `kokoro-tts` bundle is **not installed**. Its compose is `ghcr.io/remsky/kokoro-fastapi-cpu:latest` (= `v0.9.0`, digest `sha256:ee3111d6…`) on `127.0.0.1:8880` with no memory cap. Its manifest seeds TTS profile "Kokoro (local)", voice `af_heart`. | `imagetools inspect`, read |
| `seedProfile` (`servers/gateway/routes/bundles.js:73`) **skips** a seed whose provider+baseUrl already exists. A second fasterwhisper profile on `:8004` therefore cannot come from a manifest seed. | read |
| Panel routes install as **copies** at `~/.crow/panels/<id>-routes.js`. Bundle server code installs at `~/.crow/bundles/<id>/server/`. `CROW_APP_ROOT` is exported by the gateway (`index.js:43`). Ramble's `server/app-root.js` is the resolution pattern. | read |
| WebSocket upgrades bypass Express. `rejectFunneledMiddleware` and `isAllowedNetwork` never see them unless the upgrade handler calls them. | read (`extension-proxy.js:137` note) |
| `isAllowedNetwork` rejects bare loopback and accepts `Tailscale-User-Login`. Serve traffic reaches `:3001` from 127.0.0.1 carrying Tailscale identity headers and `X-Forwarded-For`. `app.set("trust proxy", 1)` is set. | read |
| The global CSP is set by middleware (`index.js:342`). A route may overwrite it with `res.setHeader`. | read |
| Ramble's `/ramble/static/bird-svg.js` sits behind `dashboardAuth`, so an unpaired kiosk page cannot load it. On `origin/main` (Ramble **0.13.0**):<br>- `bird-svg.cjs` has `OUTFIT_SLOTS` (hat/scarf/glasses) and `applyOutfit`;<br>- `drawBird` draws `scarf` and `glasses`;<br>- an undressed bird draws ≤ 1,557 bytes and a fully dressed one 2,128 (measured over 8 species × 200 seeds × 3 moods);<br>- core `servers/sharing/profile-avatar.js` exports `readPortrait(db) → {egg_id, species, seed, mood, outfit}\|null`, whose mood is pet.js's decay-on-read and which never throws. | `git show origin/main:…`, measured |
| `scripts/run-suite.mjs` on main forces `CROW_DISABLE_NTFY_AUTOWIRE=1`. Any scratch gateway in this plan must set it too, or it may provision users on crow's shared ntfy (`boot/post-listen.js`, #412). | read |
| `PERCH_TOKENS` (`design-tokens.js:92`) has light/dark `sky/card/ink/dim/teal/tealSoft/wire/alive/attn/line`. The dark set lacks `alive`/`attn`. | read |
| Serve ports in use: 8444-8457 (minus 8447/8458+), 12393, plus Funnel on 443 (`/blog`). **8462 is free.** Local 13001/18004/18880 are free. | `tailscale serve status`, `ss` |
| `bundle-server-deps.test.js` scans only `bundles/<id>/server/` for bare imports. | read |

---

## Global Constraints

Copied from the spec. Every task's requirements implicitly include these.

- **Budgets (D11):**
  - "Kiosk page < ~300 MB in Chromium on the Pi 3, verified on the real Pi. No idle video; a small bird loop."
  - K1 code rules that serve this: no `<video>`/`<iframe>` on the idle screen; **no `requestAnimationFrame` anywhere in the page**; CSS-only bird animation; bird SVG **≤ 2 KB**; page JS+CSS **≤ 80 KB** uncompressed (a plan rule, sized for a Pi 3).
- **Latency (D11/§9):**
  - "Under 2 s from end of speech to start of TTS for short questions on the fast voice model."
  - Gate: **median < 2.0 s, p90 < 3.0 s over 20 scripted questions**, measured by the page as `t_play − t_speech_end` and reported as `turn_metrics`.
  - Levers in order if the gate is missed: (1) VAD hangover 450 ms, (2) `tiny.en` or STT on the GPU, (3) a pre-synthesized acknowledgement. The plan must report which lever was used.
- **Network:**
  - Tailnet + loopback only. **Never Funnel.** `/kiosk` and `/api/kiosk` are not in `PUBLIC_FUNNEL_PREFIXES`.
  - `isAllowedNetwork()` is applied **before** any token check, on HTTP **and** on the WS upgrade.
  - **No new host port.** Everything rides the gateway behind Serve `:8444`.
- **Device token:** 32 random bytes, stored only as sha256. It is accepted **only** by `/api/kiosk/session` (in `hello`). It is never accepted by `dashboardAuth`, MCP mounts, `/llm/v1`, the board, or any other route. **The token in a URL is ignored.**
- **Pairing:**
  - 6 random digits; `poll_secret` of 32 random bytes; held in memory, with only `sha256(poll_secret)` kept.
  - Expiry +10 min; `pair/start` rate-limited to 5/min/IP; ≤ 3 pending.
  - 5 wrong codes in 10 min lock approval for 10 min; the token is delivered exactly once.
  - Unpair closes the session with 4401.
- **Session:**
  - The first frame is `{type:"hello", device_id, token, caps}` within 5 s, or the server closes with 4401.
  - Client binary frames are PCM16 mono 16 kHz, 20 ms each.
- **Voice turn (D14, §7):**
  - The bound bot drives the turn: persona, `botVoiceScope`, permission policy, `fast_voice_model`.
  - The fast route is `fast_voice_model` or `crow-voice/qwen3.5-4b` with `enable_thinking=false`. Escalation is `COMPANION_ESCALATION_MODEL` (default `crow-chat/qwen3.6-35b-a3b`).
  - On escalation: say a filler ("One moment."), probe readiness, and **fall back to the fast model after 8 s**.
  - The **memory category is stripped** unless the device's `memory_integration` is `true`.
  - The `<think>` gate never speaks.
  - Barge-in aborts the LLM and TTS within 100 ms (fake clock in tests).
- **STT/TTS (§7.3, Kevin Q2):**
  - The kiosk STT profile is `faster-whisper-server` `:8004`, model `Systran/faster-distil-whisper-small.en`.
  - Kiosk TTS is **local Kokoro** (`kokoro-tts` bundle, `127.0.0.1:8880`, PCM). Edge stays selectable.
- **Audio (§7.3):** `getUserMedia({echoCancellation, noiseSuppression, autoGainControl: true})` feeds an AudioWorklet that resamples to 16 kHz PCM16. The page keeps a 1.0 s pre-roll and sends nothing while idle. VAD ends a turn after 600 ms of silence or at a 15 s cap. **No audio is stored on crow**: the WAV is discarded after STT.
- **Page CSP (§10):** `default-src 'self'`; `connect-src 'self' ws://127.0.0.1:8770`; `frame-src` limited to the YouTube embed origin. K1 opens no iframe; the frame-src line is kept for K3.
- **Theme (§5):**
  - `PERCH_TOKENS`, light by day and dark at night, following the display's sleep schedule (default **22:30–06:30**, Kevin Q4), not the OS.
  - Touch targets ≥ 56 px; body text ≥ 20 px.
  - `prefers-reduced-motion` or the device setting `animation:false` stops the bird animation.
  - Below 600 px wide the layout is a single column with tap-to-talk only (D8).
- **Repo rules (`CLAUDE.md`):**
  - Bump a bundle's `manifest.json` version on any code change (ramble, kiosk, faster-whisper-server, kokoro-tts), then `npm run build-registry`.
  - New bundle bare imports go in its `package.json`.
  - Any new host port goes in `docs/developers/port-allocation.md`, after checking **three registries** (doc + composes + live listeners). K1 adds none, and verifies that it adds none.
  - i18n parity en/es.
  - Panel client JS inside template literals: **no backticks and no `${`**.
  - Tests run as `npm test -- tests/<file>`, never raw `node --test`.
  - Commit with a positional path (`git commit <paths> -m`) after `git add` of new files. Run `git pull --rebase` before pushing.
  - Never add `CLAUDE.md`. Never attribute Claude.
- **Live hosts:** never touch live instances outside a window registered in `~/CROW-SCHEDULE.md`. Each window has an out-of-process deadman that restores prod.

## Review Focus

These are the conditions the spec implies but does not spell out, ordered by how likely each is to bite someone using a phone or the Pi. Each has a pinned test in the task named.

1. **Mic permission denied, or AudioContext still suspended (no gesture yet)**: the page must show "Tap to enable the microphone", never a silent dead bird. Test: `tests/kiosk-page-state.test.js` "mic denied → mic_blocked; no device → no_mic; suspended context → needs_gesture" (Task 11).
2. **The display was unpaired while the page was offline**: on reconnect, `hello` → close 4401 `unauthorized`. The page must drop its token and show the pairing code, not reconnect forever. Tests: `kiosk-page-state.test.js` "4401 unauthorized/unpaired clears the token; 4401 hello_timeout keeps it and reconnects" (Task 11); `tests/kiosk-session.test.js` "bad token, wrong first frame, or binary before hello → 4401 unauthorized" (Task 9); `tests/kiosk-routes.test.js` "full pairing: … " for the unpair → 4401 `unpaired` (Task 10).
3. **The same display open twice (phone + laptop with one token)**: the older session is closed 4000 `superseded` and must not auto-reconnect, which would ping-pong the two. Tests: `kiosk-session.test.js` "second hello supersedes the first with 4000" (Task 9); `kiosk-page-state.test.js` "4000 superseded → halt (no auto reconnect ping-pong)" (Task 11).
4. **The phone locks or loses Wi-Fi mid-turn**: the server must abort the turn (no orphan LLM/TTS stream), release the device's turn lock, and restore the timer window on reconnect. Test: `kiosk-session.test.js` "close during a turn aborts it; reconnect gets the timer in the snapshot" (Task 9).
5. **A TV in the room keeps the VAD open**: the 15 s cap ends the turn client-side, the server's 1 MiB per-turn cap drops oversized audio, and an 8 s no-speech window ends a tap with no speech. Tests: `tests/kiosk-vad.test.js` "15 s cap (a TV in the room) and 8 s no-speech (a tap with nothing said)" (Task 11); `kiosk-session.test.js` "over 1 MiB of audio → audio_too_long, no turn; under 200 ms → empty_transcript, no turn" (Task 9).

## Rulings (this plan's own decisions; the spec is silent or this plan narrows it)

| # | Ruling | Why |
|---|---|---|
| R1 | The `companion → kiosk` device migration (§4.1/§11) is **deferred to the K3 retirement PR**. K1 adds the `kiosk` kind only. | Until K3, OLLV and Bot Builder's "AI Companion" tab (`api-handlers.js:281-335`, `editor.js:344-358`) still create and claim `device_kind:"companion"` devices. Migrating on load would silently pull those devices out from under a live OLLV. The test listed in §13.1 moves with the migration. |
| R2 | A kiosk's real token hash lives in a **separate field**, `kiosk_token_hash = sha256("crow-kiosk-v1:" + token)`. Its `token_hash` holds 32 random bytes that are the hash of nothing anyone holds. Core `verifyToken` checks `kiosk_token_hash` only when called with `{kind:"kiosk"}`, and refuses a kiosk record otherwise. | The glasses WS (`routes.js:2081-2108`) and `POST /api/meta-glasses/photo` call `verifyToken` with no kind check, and an INSTALLED old glasses copy (e.g. grackle's) hashes whatever string the caller sends. A prefix alone would be forgeable (review C2). With a sentinel `token_hash`, every old verifier refuses a kiosk token, prefixed or not, without touching glasses (spec §7.1). |
| R3 | The kiosk executes `crow_wm` with a **kiosk-native executor** (`bundles/kiosk/server/wm.js`). It keeps the tool name, the single `command` string and the JSON action shape. It does **not** call `servers/wm/server.js`. | That file's other commands have side effects a household display must not trigger: `invite`/`memo`/`react` send to contacts, `relay` hits peers, `search` hits the web, `open pet` spawns an AppImage. Its pet code is deleted in K3. The kiosk refuses those commands without running them. |
| R4 | K1 window kinds are **timer, recipe and content**. `youtube` (the one iframe), `list` (HA todo) and `camera` come with K3/K4, and `caps` advertises only what the page renders. | The spec's K1 row names timer/recipe/content. Iframe memory is a K2 Pi measurement (R1 of the spec). |
| R5 | Bird class hooks are **opt-in**: `drawBird(g, mood, {hooks:true})`. With no third argument the output is **byte-identical** to today, pinned by a golden fixture written before the change. Ramble goes 0.13.0 → 0.13.1 (outfits included in the golden). | Every existing caller is unchanged: profile avatar, pins, panel. The spec asks for "byte-compatible apart from the added class attributes"; opt-in gives byte-identical for existing callers, and the hooks output is tested for geometry equivalence. |
| R6 | `faster-whisper-server` is pinned to `0.5.0-cpu` (the exact running digest, so the image does not change). It also gets `WHISPER__TTL=-1`, `PRELOAD_MODELS=["Systran/faster-distil-whisper-small.en"]` and `mem_limit: 8g`. The kiosk STT profile is created by the kiosk at approval (stable id `kiosk-stt-distil-small-en`), not by a manifest seed. | With the default TTL of 300 s, the first kiosk turn after 5 quiet minutes pays a model reload, and §7.3's warm-up-on-connect cannot fix that. `seedProfile` dedups by provider+baseUrl, so a second `:8004` profile can't be seeded. |
| R7 | Kokoro is pinned to `v0.9.0` with `mem_limit: 4g`. It is installed through Extensions in the deploy window (Task 14). The pre-merge smoke runs a scratch copy. | §7.3 / Kevin Q2. Pinned per the image-freshness convention (version tags, `scripts/extract-bundle-images.py`). |
| R8 | **Latency metric:** `e2e = t_play − t_speech_end`. `t_speech_end` is the page's `performance.now()` at the **last voiced frame**, so it includes the 600 ms hangover, as in the spec's breakdown. `t_play` is the scheduled `AudioBufferSourceNode.start` time mapped to `performance.now()` plus `AudioContext.outputLatency` (falling back to `baseLatency`). **Known biases:** mic input latency (tens of ms) is not included, and some Android builds under-report `outputLatency` (the page falls back to `baseLatency`). Both make the measured number slightly *optimistic*, so treat a median within 100 ms of 2.0 s as marginal in the report. The gate counts only turns that are `route=fast`, not a fast path, not escalated, **not degraded**, `vad_reason=silence`, and not aborted. An eligible turn with no audio counts as a **failure**. The 20 questions ship as data, and a test pins every one to the fast route. | The spec's §9 metric, with its validity edges made explicit, so the gate cannot pass on turns that never exercised the budgeted path. |
| R9 | The kiosk announce token is minted by the kiosk routes module at gateway boot, through new `local-token.js` helpers of the board-token shape: hash in a local-scope setting, raw value in `$CROW_HOME/kiosk-announce-token` mode 0600. `/api/kiosk/internal/*` requires a **direct loopback socket with no `tailscale-*`, `x-forwarded-for` or `forwarded` header**, plus the bearer. | Serve traffic also arrives from 127.0.0.1. Only the headers tell it apart from the MCP child. |
| R10 | The admin API (`/api/kiosk/admin/*`) is `dashboardAuth` + `csrfMiddleware`, and the panel client sends `X-Crow-Csrf`. | Panel `/api/*` routes get no CSRF today. Approving a pairing is the security-critical action. |
| R11 | A kiosk **requires a bound, enabled bot**: approval must pick one. There is no `ai_profile` fallback. A turn with no bot speaks/captions `no_bound_bot`. | D4/D14. This also keeps an owner's default profile off a household screen. |
| R12 | The pre-merge smoke runs a **scratch gateway** from the branch (`127.0.0.1:13001`, scratch `CROW_HOME`, model orchestration, sync and nostr off), a scratch whisper (`127.0.0.1:18004`), a scratch Kokoro (`127.0.0.1:18880`) and a temporary Serve `8462` (tailnet only). Prod is not touched. Recreating prod whisper and installing Kokoro + kiosk is a separate registered deploy window (Task 14). | Global rule: never touch live instances outside a registered window; keep windows short. |
| R13 | STT warm-up (1 s of silence) runs on `hello`, at most once per 10 min per STT profile. | With TTL -1 and the preload, this is belt-and-braces. A Pi that reconnects often must not hammer whisper. |
| R14 | Escalated turns start the 35B through `maybeAcquireLocalProvider` **in the background** and probe `GET /models` every 500 ms for up to 8 s. A `ReservedError` or `ServingClassError` falls back at once. | §7.2. `maybeAcquireLocalProvider` blocks until the model is ready, so awaiting it would break the 8 s promise. |
| R15 | K1 keeps the glasses `pcmStream` behaviour: it buffers each sentence's synthesis, then sends. | It is proven, and a browser plays a whole sentence buffer cleanly. If the gate is missed, levers 1–3 come first (spec order). Unbuffered streaming is recorded as a follow-up, not a K1 lever. |
| R16 | Stripping the memory category also removes `crow_create_notification` and the schedule tools, because they are in `TOOL_MANIFESTS.memory`. | Spec-faithful (§7.1). Kiosk timers are `crow_wm` timers. Reminders by voice come with `memory_integration:true`, or with a K3 decision. |
| R21 | Kiosk turns pass `denyTools: ["crow_delegate", "crow_job_status"]`. The tools are not advertised, and a forced call is refused by the turn's gate. | Review C3: `crow_delegate`'s `bot` argument reaches any enabled bot, and `crow_job_status` reads the result back. That would let a room bypass the bound bot's scope and the memory strip. |
| R22 | The route decision ignores in-process display-tool turns (`crow_wm`). The system message is byte-stable, and live window state rides on the turn's own user message (`turnContext`), stripped from saved history. The degraded-model note joins the leading system message. `maxTokens` is clamped to the model's `contextLen` minus a prompt estimate. "Set/start a timer for …" is a no-LLM fast path. | Review C1/M5/M6/M8: Qwen templates reject a late system message; sticky tool context would push plain questions to a cold 35B; a 4,000-token bump overflows the 4B's 8,192 context; a changing system prompt defeats the prefix cache; "set a timer" matches no tool-intent word. |
| R23 | Spec items deferred with their window kinds: `pause`/`resume` fast paths (§8.6) come with media windows (K3, R4). Long-press close-all (§8.5) **is** in K1. | Without a media window there is nothing to pause. |
| R17 | K2 caveat, recorded and not built: if the Pi joins the tailnet as a **tagged** node, Serve sends no `Tailscale-User-Login`, and `isAllowedNetwork` would reject it as bare loopback. K2 must join it as a user node, or add a narrowly scoped rule. | Found while checking `isAllowedNetwork` for the WS path. |
| R18 | The bird **wears its outfit** on the kiosk: `readPortrait` → `applyOutfit`. The SVG budget becomes ≤ 2,048 B undressed and ≤ 2,560 B fully dressed, both with hooks. | The wardrobe (#416) shipped after the spec. A fully dressed 0.13.0 bird is already 2,128 B, so spec §9's 2 KB figure cannot hold for dressed birds. Node count and CSS-only animation are what cost on a Pi 3. |
| R19 | The display's bird comes from core `readPortrait(db)` (`servers/sharing/profile-avatar.js`), not a kiosk copy of Ramble's SQL. That gives the decay-on-read mood (the contacts portrait uses the same function) and the outfit, and it never throws. With no hatched bird, the default crow is species `crow`, seed `0`, `happy`. | One mood source. `ramble_pet.mood` exists (`init-tables.js:104`), but it is not decayed on read. `readPortrait` derives the mood from energy + `last_fed_at`, exactly as `petState` and the contacts portrait do. |
| R20 | `kiosk_settings.vad_hangover_ms` (300–1200, default 600) is the switch for latency lever 1. The page reads it from `display_config`. The panel does not expose it; the smoke applies it through the admin API if the gate is missed. | Spec §9 requires the levers to be applicable and reported. A lever that needs a code change mid-window is not one. |

---

## File Structure

**Create**

| path | responsibility |
|---|---|
| `servers/shared/device-store.js` | the device store (moved from meta-glasses) + `kiosk` kind, `kiosk_settings`, domain-separated hash, `last_seen` throttle |
| `servers/gateway/voice/turn-helpers.js` | pure pieces pinned to glasses behaviour: think gate, sentence chunker, confirm gate, conversation store, PCM negotiation/stream, WAV wrap |
| `servers/gateway/voice/turn.js` | `createVoiceTurnRunner(deps)` → `runVoiceTurn`, `speakText`; `defaultVoiceDeps()` |
| `bundles/kiosk/manifest.json`, `package.json` | bundle metadata; MCP server deps (`@modelcontextprotocol/sdk`, `zod`) |
| `bundles/kiosk/server/app-root.js` | resolve the app root from an installed copy (ramble pattern) |
| `bundles/kiosk/server/questions.js` | the 20 scripted latency questions (data) |
| `bundles/kiosk/server/profiles.js` | `ensureKioskSttProfile`, `pickKioskTtsProfile` |
| `bundles/kiosk/server/pairing.js` | in-memory pairing store (codes, poll secrets, limits, lockout, one-time pickup) |
| `bundles/kiosk/server/wm.js` | kiosk `crow_wm`: command parser, server window store + timers, tool definition from caps, fast paths, prompt line |
| `bundles/kiosk/server/bird.js` | `resolveDisplayBird(db)`: read-only ramble lookup → `{species, seed, mood}` or the default crow |
| `bundles/kiosk/server/metrics.js` | per-device latency ring buffer + median/p90 |
| `bundles/kiosk/server/strings.js` | en/es strings for the panel and the page |
| `bundles/kiosk/server/session.js` | `createSessionHub(deps)`: the WS protocol state machine |
| `bundles/kiosk/server/runtime.js` | `createKioskRuntime(deps)`: Express router (page, pair, admin, internal) + upgrade handler + announce/show |
| `bundles/kiosk/server/server.js`, `index.js` | MCP tools `crow_kiosk_list_displays`, `crow_kiosk_announce`, `crow_kiosk_show` |
| `bundles/kiosk/panel/routes.js` | gateway glue: real deps → runtime; default export router factory + `setupWebSocket` |
| `bundles/kiosk/panel/kiosk.js` | dashboard panel: displays, pair approval, settings, diagnostics |
| `bundles/kiosk/public/kiosk.html`, `kiosk.css`, `kiosk.js`, `state.js`, `audio.js`, `resample.js`, `pcm-worklet.js`, `vad.js`, `wm-view.js`, `bird-view.js`, `metrics.js` | the page |
| `bundles/kiosk/skills/kiosk.md` | skill: how bots use `crow_kiosk_*` |
| `docs/architecture/kiosk.md` | architecture note (K1 scope) |
| `tests/device-store.test.js`, `tests/llm-router-voice-route.test.js`, `tests/voice-turn-helpers.test.js`, `tests/voice-turn.test.js`, `tests/kiosk-services.test.js`, `tests/ramble-bird-hooks.test.js`, `tests/fixtures/bird-svg-golden.json`, `tests/kiosk-pairing.test.js`, `tests/kiosk-announce-token.test.js`, `tests/kiosk-wm.test.js`, `tests/kiosk-session.test.js`, `tests/kiosk-routes.test.js`, `tests/kiosk-vad.test.js`, `tests/kiosk-page.test.js`, `tests/kiosk-page-state.test.js`, `tests/kiosk-panel.test.js` | hermetic tests |

**Modify**

| path | change |
|---|---|
| `bundles/meta-glasses/server/device-store.js` | becomes a self-resolving re-export shim (no glasses version bump; R2) |
| `servers/gateway/dashboard/panels/bot-builder/{api-handlers,editor,delete-bot}.js` | import the core store path |
| `servers/gateway/routes/llm-router.js` | export `chooseVoiceRoute`, `VOICE_ROUTE_KEYS`, `resolveVoiceKey`, `probeVoiceReady`; `handleChat` uses `chooseVoiceRoute` |
| `servers/gateway/local-token.js` | kiosk announce token helpers |
| `bundles/ramble/server/bird-svg.cjs` + `bundles/ramble/manifest.json` | opt-in hooks + split beak; 0.13.1 |
| `bundles/faster-whisper-server/{docker-compose.yml,manifest.json}` | pin, TTL, preload, mem cap; version bump |
| `bundles/kokoro-tts/{docker-compose.yml,manifest.json}` | pin, mem cap; version bump |
| `tests/auth-network.test.js` | `/kiosk` + `/api/kiosk` Funnel/off-tailnet cases |
| `registry/add-ons.json` | rebuilt (`npm run build-registry`) |
| `docs/.vitepress/config.ts` | sidebar entry for `architecture/kiosk.md` |

**Interfaces shared across tasks** (each task's own Interfaces block repeats what it consumes):

```text
servers/shared/device-store.js
  listDevices(db) → Device[] (no token_hash)
  findDevice(db, id) → Device|null (raw)
  pairDevice(db, {id, name, device_kind, stt_profile_id?, tts_profile_id?, kiosk_settings?, …}) → {device, token}
  unpairDevice(db, id) → {removed}
  verifyToken(db, id, token, {kind?, now?}) → Device|null
  updateDeviceProfiles(db, id, patch) → Device|null      // patch may carry kiosk_settings (merged+validated)
  tokenHash(token, kind) → hex
  unbindBotFromOtherDevices(db, botId, keepId) → {unbound}        // skips kiosk displays (Bot Builder save)
  normalizeKioskSettings(input, prior?) → KioskSettings
  KIOSK_DEFAULTS, DEVICE_KINDS, LAST_SEEN_WRITE_MS (300000)

KioskSettings = { follow_up:boolean, follow_up_s:int 2..20, memory_integration:boolean, animation:boolean,
                  sleep_start:"HH:MM", sleep_end:"HH:MM", lang:"en"|"es", vad_hangover_ms:int 300..1200 (default 600) }

servers/gateway/routes/llm-router.js
  chooseVoiceRoute(messages, {hasTools}) → {route:"fast"|"escalate", reason:null|"manual"|"tool-intent", key}
  VOICE_ROUTE_KEYS = {fast, escalate}; resolveVoiceKey(key) → {baseUrl, model, apiKey}; probeVoiceReady(baseUrl) → boolean

servers/gateway/voice/turn.js
  createVoiceTurnRunner(deps) → { runVoiceTurn(opts) → TurnResult, speakText({db, device, text, sink, signal}) }
  defaultVoiceDeps() → Promise<deps>
  opts = { db, device, audio?:Buffer(WAV), transcript?:string, sink:{event(obj), audio(Buffer)},
           extraTools?: [{definition:{name,description,inputSchema}, execute(args) → Promise<string>}],
           fastPaths?: (transcript) → Promise<{say?:string, events?:object[]}|null>,
           promptSuffix?: string, turnContext?: string, denyTools?: string[], signal?: AbortSignal }
  TurnResult = { transcript, route:"fast"|"escalate"|null, fastPath, escalated, degraded:null|string, aborted,
                 timings:{stt_ms?, llm_first_token_ms?, tts_first_chunk_ms?, total_ms} }

bundles/kiosk/server/wm.js
  createWmStore({now, setTimer, clearTimer, onTimerDone, maxWindows}) → WmStore
  createWmTool({store, deviceId, caps, emit}) → {definition, execute}
  matchWmFastPath(transcript, store, deviceId, caps?) → {say, events}|null
  kioskPromptSuffix() → string            // static
  kioskTurnContext(store, deviceId) → string   // live, rides on the turn's user message
  normalizeCaps(raw) → {windows:string[], iframe:false, max_windows:int}
```

---
## Tasks

### Task 0: Worktree (setup, no commit)

- [ ] **Step 1: Cut the implementation worktree from current main and carry the spec + this plan**

```bash
cd ~/crow && git fetch origin
git worktree add ~/crow-wt-kiosk-k1 -b feat/kiosk-k1 origin/main
cd ~/crow-wt-kiosk-k1
git checkout origin/docs/kiosk-companion-spec -- docs/superpowers/specs/2026-10-03-crow-kiosk-companion-design.md docs/superpowers/specs/2026-10-03-cameras-frigate-ring-design.md docs/superpowers/plans/2026-10-03-kiosk-k1-page-and-voice.md
git commit docs/superpowers/specs/2026-10-03-crow-kiosk-companion-design.md docs/superpowers/specs/2026-10-03-cameras-frigate-ring-design.md docs/superpowers/plans/2026-10-03-kiosk-k1-page-and-voice.md -m "docs(kiosk): K1 spec + plan"
ln -s ~/crow/node_modules node_modules   # same deps; never `npm install` into prod's tree
npm test -- tests/auth-network.test.js     # baseline sanity: PASS
```

Never `git checkout` a branch inside `~/crow`. Prod auto-update needs it parked on `main`.

---

### Task 1: Core device store (move + `kiosk` kind + domain-separated hash + `last_seen` throttle)

**Files:**
- Create: `servers/shared/device-store.js`
- Modify: `bundles/meta-glasses/server/device-store.js` (whole file → shim)
- Modify: `servers/gateway/dashboard/panels/bot-builder/api-handlers.js:252,293,322`, `editor.js:281,350`, `delete-bot.js:70,177` (the import path only)
- Test: `tests/device-store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: the `servers/shared/device-store.js` API in "Interfaces shared across tasks". `verifyToken(db, id, token, {kind:"kiosk"})` is the only way a kiosk record verifies.

- [ ] **Step 1: Write the failing test**

`tests/device-store.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import * as store from "../servers/shared/device-store.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function freshDb() {
  const raw = createClient({ url: "file::memory:" });
  await raw.execute("CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  let writes = 0;
  return {
    get writes() { return writes; },
    async execute(q) { if (/^\s*INSERT/i.test(q.sql)) writes++; return raw.execute(q); },
    close() { raw.close(); },
  };
}

test("kiosk pairing stores a domain-separated hash and a default kiosk_settings", async () => {
  const db = await freshDb();
  const { device, token } = await store.pairDevice(db, { id: "kiosk-a", name: "Kitchen", device_kind: "kiosk" });
  assert.equal(device.device_kind, "kiosk");
  assert.deepEqual(device.kiosk_settings, store.KIOSK_DEFAULTS);
  const raw = await store.findDevice(db, "kiosk-a");
  const sha = (x) => createHash("sha256").update(x).digest("hex");
  assert.equal(raw.kiosk_token_hash, sha("crow-kiosk-v1:" + token));
  assert.match(raw.token_hash, /^[0-9a-f]{64}$/, "a sentinel in token_hash, so old readers see a well-formed record");
  assert.notEqual(raw.token_hash, sha(token));
  assert.notEqual(raw.token_hash, sha("crow-kiosk-v1:" + token));
  assert.equal(token.length, 64);
  assert.ok(!("kiosk_token_hash" in device) && !("token_hash" in device), "pair result is redacted");
  assert.ok((await store.listDevices(db)).every((d) => !("kiosk_token_hash" in d) && !("token_hash" in d)));
});

/** main's meta-glasses verifyToken, verbatim in substance: sha256(caller string) vs token_hash. */
async function oldGlassesVerify(db, id, token) {
  const r = (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: ["meta_glasses_devices"] })).rows[0];
  const d = JSON.parse(r?.value || "[]").find((x) => x.id === id);
  if (!d) return null;
  const a = Buffer.from(d.token_hash, "hex"), b = Buffer.from(createHash("sha256").update(String(token)).digest("hex"), "hex");
  return a.length === b.length && a.equals(b) ? d : null;
}

test("an INSTALLED old glasses store refuses a kiosk token, plain or domain-prefixed (review C2)", async () => {
  const db = await freshDb();
  const { token } = await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  assert.equal(await oldGlassesVerify(db, "kiosk-a", token), null);
  assert.equal(await oldGlassesVerify(db, "kiosk-a", "crow-kiosk-v1:" + token), null);
  const g = await store.pairDevice(db, { id: "g1", name: "G" });
  assert.ok(await oldGlassesVerify(db, "g1", g.token), "glasses still verify through the old path");
});

test("Bot Builder's unbind-others never strands a kiosk display (review M7)", async () => {
  const db = await freshDb();
  await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  await store.pairDevice(db, { id: "g1", name: "G" });
  await store.pairDevice(db, { id: "g2", name: "G2" });
  for (const id of ["kiosk-a", "g1", "g2"]) await store.updateDeviceProfiles(db, id, { bound_bot_id: "house" });
  assert.deepEqual(await store.unbindBotFromOtherDevices(db, "house", "g2"), { unbound: 1 });
  const by = Object.fromEntries((await store.listDevices(db)).map((d) => [d.id, d.bound_bot_id]));
  assert.deepEqual(by, { "kiosk-a": "house", g1: null, g2: "house" });
});

test("a kiosk token verifies ONLY when the caller asks for a kiosk", async () => {
  const db = await freshDb();
  const { token } = await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  assert.equal(await store.verifyToken(db, "kiosk-a", token), null, "no kind → refused");
  assert.equal(await store.verifyToken(db, "kiosk-a", token, { kind: "glasses" }), null);
  assert.equal((await store.verifyToken(db, "kiosk-a", token, { kind: "kiosk" })).id, "kiosk-a");
  assert.equal(await store.verifyToken(db, "kiosk-a", "0".repeat(64), { kind: "kiosk" }), null);
});

test("a glasses token is unaffected (plain sha256) and refused when kiosk is requested", async () => {
  const db = await freshDb();
  const { token } = await store.pairDevice(db, { id: "g1", name: "Ray-Bans" });
  assert.equal((await store.verifyToken(db, "g1", token)).id, "g1");
  assert.equal(await store.verifyToken(db, "g1", token, { kind: "kiosk" }), null);
});

test("last_seen is written at most once per 5 minutes", async () => {
  const db = await freshDb();
  const { token } = await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  const base = db.writes;
  const t0 = Date.parse("2026-10-03T12:00:00Z");
  await store.verifyToken(db, "kiosk-a", token, { kind: "kiosk", now: t0 });
  await store.verifyToken(db, "kiosk-a", token, { kind: "kiosk", now: t0 + 60_000 });
  await store.verifyToken(db, "kiosk-a", token, { kind: "kiosk", now: t0 + 299_999 });
  assert.equal(db.writes - base, 1);
  await store.verifyToken(db, "kiosk-a", token, { kind: "kiosk", now: t0 + 300_000 });
  assert.equal(db.writes - base, 2);
  assert.equal((await store.findDevice(db, "kiosk-a")).last_seen, new Date(t0 + 300_000).toISOString());
});

test("re-pairing keeps the bot binding and the kiosk settings", async () => {
  const db = await freshDb();
  await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  await store.updateDeviceProfiles(db, "kiosk-a", { bound_bot_id: "household", kiosk_settings: { follow_up: true } });
  const { device } = await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  assert.equal(device.bound_bot_id, "household");
  assert.equal(device.kiosk_settings.follow_up, true);
});

test("kiosk_settings are validated and merged; device_kind cannot be flipped to or from kiosk by patch", async () => {
  const db = await freshDb();
  await store.pairDevice(db, { id: "kiosk-a", name: "K", device_kind: "kiosk" });
  const d = await store.updateDeviceProfiles(db, "kiosk-a", {
    device_kind: "glasses",
    kiosk_settings: { follow_up_s: 99, sleep_start: "25:00", lang: "fr", memory_integration: "true", junk: 1, vad_hangover_ms: 50 },
  });
  assert.equal(d.device_kind, "kiosk");
  assert.equal(d.kiosk_settings.follow_up_s, 20, "clamped to 2..20");
  assert.equal(d.kiosk_settings.sleep_start, "22:30", "bad HH:MM keeps prior");
  assert.equal(d.kiosk_settings.lang, "en");
  assert.equal(d.kiosk_settings.memory_integration, true, "form string 'true' coerces");
  assert.equal("junk" in d.kiosk_settings, false);
  assert.equal(d.kiosk_settings.vad_hangover_ms, 300, "clamped to 300..1200");
  assert.equal((await store.updateDeviceProfiles(db, "kiosk-a", { kiosk_settings: { vad_hangover_ms: "450" } })).kiosk_settings.vad_hangover_ms, 450);
  await store.pairDevice(db, { id: "g1", name: "G" });
  assert.equal((await store.updateDeviceProfiles(db, "g1", { device_kind: "kiosk" })).device_kind, "glasses");
});

test("companion devices keep their existing semantics (no migration in K1, ruling R1)", async () => {
  const db = await freshDb();
  await store.pairDevice(db, { id: "crow-kiosk", name: "Kiosk", device_kind: "companion" });
  assert.equal((await store.findDevice(db, "crow-kiosk")).device_kind, "companion");
});

test("the meta-glasses shim re-exports the core store, from the repo AND from an installed copy", async () => {
  const shim = await import("../bundles/meta-glasses/server/device-store.js");
  assert.equal(shim.verifyToken, store.verifyToken);
  const home = mkdtempSync(join(tmpdir(), "shim-"));
  const dir = join(home, ".crow", "bundles", "meta-glasses", "server");
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, "bundles/meta-glasses/server/device-store.js"), join(dir, "device-store.js"));
  const prev = process.env.CROW_APP_ROOT;
  process.env.CROW_APP_ROOT = ROOT;
  try {
    const installed = await import(pathToFileURL(join(dir, "device-store.js")).href);
    assert.equal(typeof installed.pairDevice, "function");
    assert.equal(typeof installed.tokenHash, "function");
  } finally { if (prev === undefined) delete process.env.CROW_APP_ROOT; else process.env.CROW_APP_ROOT = prev; }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/device-store.test.js`
Expected: FAIL — `Cannot find module '…/servers/shared/device-store.js'`.

- [ ] **Step 3: Create the core store**

`servers/shared/device-store.js`. Copy the existing file, then apply the changes shown here. The full file:

```js
/**
 * Device registry (dashboard_settings key "meta_glasses_devices"; local scope,
 * not in the sync allowlist). Moved to core from bundles/meta-glasses/server/
 * for the kiosk (spec 2026-10-03 §4.1); the old path is a re-export shim.
 *
 * Record: { id, name, paired_at, last_seen, token_hash, household_profile,
 *   stt_profile_id, ai_profile_slug, tts_profile_id, vision_profile_id,
 *   ocr_enabled, photo_retention, generation, device_kind, companion_features,
 *   kiosk_settings, bound_bot_id }
 *
 * device_kind: "glasses" | "companion" | "kiosk".
 * A KIOSK token is hashed domain-separated (sha256("crow-kiosk-v1:"+token)) and
 * verifies only through verifyToken(..., {kind:"kiosk"}), so no glasses route
 * (and no older installed copy of this store) can ever accept it (ruling R2).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY = "meta_glasses_devices";
const UNPAIR_KEY_PREFIX = "meta_glasses_device_unpaired.";
const RETENTION_VALUES = new Set(["never", "30d", "1y"]);
const KIND_VALUES = new Set(["glasses", "companion", "kiosk"]);
const KIOSK_HASH_DOMAIN = "crow-kiosk-v1:";
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEVICE_KINDS = Object.freeze([...KIND_VALUES]);
export const LAST_SEEN_WRITE_MS = 5 * 60 * 1000;
export const KIOSK_DEFAULTS = Object.freeze({
  follow_up: false,
  follow_up_s: 6,
  memory_integration: false,
  animation: true,
  sleep_start: "22:30",
  sleep_end: "06:30",
  lang: "en",
  vad_hangover_ms: 600,
});

function sha256Hex(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

export function tokenHash(token, kind) {
  return sha256Hex(kind === "kiosk" ? KIOSK_HASH_DOMAIN + token : token);
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function asBool(v) { return v === true || v === "true" || v === "on" || v === 1 || v === "1"; }

/** Merge + validate kiosk settings. Unknown keys dropped; bad values keep the prior value. */
export function normalizeKioskSettings(input, prior) {
  const base = { ...KIOSK_DEFAULTS, ...(prior && typeof prior === "object" ? prior : {}) };
  let src = input;
  if (typeof src === "string") { try { src = JSON.parse(src); } catch { src = null; } }
  if (!src || typeof src !== "object") return { ...base };
  const out = { ...base };
  for (const k of ["follow_up", "memory_integration", "animation"]) if (k in src) out[k] = asBool(src[k]);
  if ("follow_up_s" in src) {
    const n = Number.parseInt(src.follow_up_s, 10);
    if (Number.isFinite(n)) out.follow_up_s = Math.min(20, Math.max(2, n));
  }
  for (const k of ["sleep_start", "sleep_end"]) if (k in src && HHMM_RE.test(String(src[k]))) out[k] = String(src[k]);
  if ("lang" in src && (src.lang === "en" || src.lang === "es")) out.lang = src.lang;
  if ("vad_hangover_ms" in src) {
    const n = Number.parseInt(src.vad_hangover_ms, 10);
    if (Number.isFinite(n)) out.vad_hangover_ms = Math.min(1200, Math.max(300, n));   // latency lever 1 (ruling R20)
  }
  for (const k of Object.keys(out)) if (!(k in KIOSK_DEFAULTS)) delete out[k];
  return out;
}

async function readAll(db) {
  const res = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [KEY] });
  if (!res.rows[0]?.value) return [];
  try { return JSON.parse(res.rows[0].value); } catch { return []; }
}

async function writeAll(db, devices) {
  const v = JSON.stringify(devices);
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
    args: [KEY, v, v],
  });
}

/** A record without either token hash. */
function redact(record) {
  const { token_hash, kiosk_token_hash, ...rest } = record;
  return rest;
}

/** List paired devices (hashes redacted). */
export async function listDevices(db) {
  const devices = await readAll(db);
  return devices.map(redact);
}

/**
 * Bot Builder's one-device-per-bot rule: unbind every OTHER device bound to
 * botId — but never a kiosk display (a household display shares the bot by
 * design; saving a bot's glasses/companion gateway must not strand it).
 */
export async function unbindBotFromOtherDevices(db, botId, keepId) {
  const devices = await readAll(db);
  let changed = 0;
  for (const d of devices) {
    if (d.bound_bot_id === botId && d.id !== keepId && (d.device_kind || "glasses") !== "kiosk") { d.bound_bot_id = null; changed++; }
  }
  if (changed) await writeAll(db, devices);
  return { unbound: changed };
}

/** Find a device by id. Returns the raw record including token_hash. */
export async function findDevice(db, id) {
  const devices = await readAll(db);
  return devices.find((d) => d.id === id) || null;
}

/**
 * Pair a device: new bearer token, hash stored, plaintext returned once. Same id
 * → token rotation. Re-pair keeps the bot binding, voice profiles and settings.
 * Glasses/companion semantics are byte-for-byte the old store's: an omitted
 * device_kind means "glasses".
 */
export async function pairDevice(db, {
  id, name, generation = "unknown",
  household_profile = null, stt_profile_id = null,
  ai_profile_slug = null, tts_profile_id = null, vision_profile_id = null,
  ocr_enabled = false,
  photo_retention = "never",
  device_kind = "glasses",
  companion_features = null,
  kiosk_settings = null,
}) {
  if (!id) throw new Error("device id required");
  const kind = KIND_VALUES.has(device_kind) ? device_kind : "glasses";
  const token = randomBytes(32).toString("hex");
  // Kiosk (ruling R2): the real hash lives in kiosk_token_hash; token_hash gets
  // 32 random bytes that are the hash of NOTHING anyone holds, so every older
  // verifier (an installed meta-glasses copy compares sha256(<whatever string
  // the caller sends>) to token_hash) refuses a kiosk token — prefixed or not.
  const token_hash = kind === "kiosk" ? randomBytes(32).toString("hex") : tokenHash(token, kind);
  const devices = await readAll(db);
  const now = new Date().toISOString();
  const existing = devices.findIndex((d) => d.id === id);
  const prior = existing >= 0 ? devices[existing] : null;
  const priorOcr = prior ? !!prior.ocr_enabled : false;
  const priorRetention = prior ? prior.photo_retention : null;
  const retention = RETENTION_VALUES.has(photo_retention)
    ? photo_retention
    : (priorRetention && RETENTION_VALUES.has(priorRetention) ? priorRetention : "never");
  const keep = (val, key) => (val != null ? val : (prior ? prior[key] ?? null : null));
  const record = {
    id,
    name: name || id,
    paired_at: prior ? prior.paired_at : now,
    last_seen: null,
    token_hash,
    household_profile: keep(household_profile, "household_profile"),
    stt_profile_id: keep(stt_profile_id, "stt_profile_id"),
    ai_profile_slug: keep(ai_profile_slug, "ai_profile_slug"),
    tts_profile_id: keep(tts_profile_id, "tts_profile_id"),
    vision_profile_id: keep(vision_profile_id, "vision_profile_id"),
    ocr_enabled: !!(ocr_enabled || priorOcr),
    photo_retention: retention,
    generation,
    device_kind: kind,
    companion_features: companion_features ?? (prior ? prior.companion_features ?? null : null),
    bound_bot_id: prior ? (prior.bound_bot_id ?? null) : null,
  };
  if (kind === "kiosk") {
    record.kiosk_token_hash = tokenHash(token, "kiosk");
    record.kiosk_settings = normalizeKioskSettings(kiosk_settings, prior?.kiosk_settings);
  }
  if (existing >= 0) devices[existing] = record;
  else devices.push(record);
  await writeAll(db, devices);
  try {
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [UNPAIR_KEY_PREFIX + id] });
  } catch {}
  return { device: redact(record), token };
}

/** Unpair a device by id. */
export async function unpairDevice(db, id) {
  const devices = await readAll(db);
  const before = devices.length;
  const next = devices.filter((d) => d.id !== id);
  await writeAll(db, next);
  if (before !== next.length) {
    try {
      const now = new Date().toISOString();
      await db.execute({
        sql: `INSERT INTO dashboard_settings (key, value, updated_at)
              VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        args: [UNPAIR_KEY_PREFIX + id, now],
      });
    } catch {}
  }
  return { removed: before - next.length };
}

/**
 * Verify a bearer token against a device id. Returns the device (no hash) or
 * null. A kiosk record verifies ONLY when opts.kind === "kiosk"; a non-kiosk
 * record never verifies when opts.kind === "kiosk". last_seen is rewritten at
 * most once per LAST_SEEN_WRITE_MS (a kiosk reconnects often and every write
 * rewrites the whole JSON list).
 */
export async function verifyToken(db, id, token, opts = {}) {
  if (!id || !token) return null;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const devices = await readAll(db);
  const idx = devices.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  const record = devices[idx];
  const kind = record.device_kind || "glasses";
  if (opts.kind ? kind !== opts.kind : kind === "kiosk") return null;
  const stored = kind === "kiosk" ? record.kiosk_token_hash : record.token_hash;
  if (!constantTimeEqual(stored, tokenHash(String(token), kind))) return null;
  const last = record.last_seen ? Date.parse(record.last_seen) : NaN;
  if (!Number.isFinite(last) || now - last >= LAST_SEEN_WRITE_MS) {
    record.last_seen = new Date(now).toISOString();
    devices[idx] = record;
    await writeAll(db, devices);
  }
  return redact(record);
}

/** Update overrides on a device. device_kind can never be switched to or from "kiosk" (token hash domain). */
export async function updateDeviceProfiles(db, id, patch) {
  const devices = await readAll(db);
  const idx = devices.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  const cur = devices[idx];
  const allow = ["household_profile", "stt_profile_id", "ai_profile_slug", "tts_profile_id", "vision_profile_id", "ocr_enabled", "photo_retention", "name", "bound_bot_id", "device_kind", "companion_features", "kiosk_settings"];
  for (const k of allow) {
    if (!(k in patch)) continue;
    if (k === "ocr_enabled") {
      cur[k] = asBool(patch[k]);
    } else if (k === "device_kind") {
      const curKind = cur.device_kind || "glasses";
      if (curKind === "kiosk" || patch[k] === "kiosk") continue;
      cur[k] = patch[k] === "companion" ? "companion" : "glasses";
    } else if (k === "companion_features") {
      let v = patch[k];
      if (typeof v === "string") { try { v = v ? JSON.parse(v) : null; } catch { v = cur[k] ?? null; } }
      cur[k] = v ?? null;
    } else if (k === "kiosk_settings") {
      if ((cur.device_kind || "glasses") === "kiosk") cur[k] = normalizeKioskSettings(patch[k], cur[k]);
    } else if (k === "photo_retention") {
      if (RETENTION_VALUES.has(patch[k])) cur[k] = patch[k];
    } else {
      cur[k] = patch[k] === "" ? null : patch[k];
    }
  }
  devices[idx] = cur;
  await writeAll(db, devices);
  return redact(cur);
}
```

The `ocr_enabled` coercion is unchanged. The old code's `v === 1` is a subset of `asBool`, and `asBool` also accepts `"1"`.

- [ ] **Step 4: Replace the meta-glasses store with the shim**

`bundles/meta-glasses/server/device-store.js` (whole file):

```js
/**
 * MOVED to core: servers/shared/device-store.js (kiosk K1, spec 2026-10-03 §4.1).
 * This shim keeps the old path working from the repo AND from an installed copy
 * (~/.crow/bundles/meta-glasses/server/), which cannot reach core by a relative
 * path. Resolution: CROW_APP_ROOT → repo-relative → ~/crow (ramble app-root.js
 * pattern). Kept until the glasses loop moves to servers/gateway/voice/turn.js.
 */
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REL = join("servers", "shared", "device-store.js");
const target = [
  process.env.CROW_APP_ROOT,
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
  join(homedir(), "crow"),
].filter(Boolean).map((root) => join(root, REL)).find((p) => existsSync(p));
if (!target) throw new Error("meta-glasses device-store shim: cannot locate servers/shared/device-store.js (set CROW_APP_ROOT)");
const core = await import(pathToFileURL(target).href);

export const {
  listDevices, findDevice, pairDevice, unpairDevice, verifyToken, updateDeviceProfiles,
  tokenHash, normalizeKioskSettings, unbindBotFromOtherDevices, KIOSK_DEFAULTS, DEVICE_KINDS, LAST_SEEN_WRITE_MS,
} = core;
```

No meta-glasses version bump. An instance with meta-glasses installed (grackle today; crow does not have it) keeps its own full old store, which reads the same JSON. Ruling R2 makes kiosk records unverifiable through it: the sentinel `token_hash` is tested against main's old algorithm. Its `verifyToken`/`updateDeviceProfiles` spread whole records, so `kiosk_token_hash`/`kiosk_settings` survive its writes.

- [ ] **Step 5: Repoint the core importers**

In each of these files, replace `"../../../../../bundles/meta-glasses/server/device-store.js"` with `"../../../../shared/device-store.js"`:
- `servers/gateway/dashboard/panels/bot-builder/api-handlers.js` (3 sites)
- `servers/gateway/dashboard/panels/bot-builder/editor.js` (2)
- `servers/gateway/dashboard/panels/bot-builder/delete-bot.js` (2)

Also, in `api-handlers.js`, replace **both** "unbind any OTHER device currently bound to this bot" loops (the glasses branch and the companion branch: `for (const d of devices) { if (d.bound_bot_id === botId && d.id !== deviceId) await updateDeviceProfiles(db, d.id, { bound_bot_id: "" }); }`, plus the `listDevices` call that feeds it) with:

```js
            await unbindBotFromOtherDevices(db, botId, deviceId);   // skips kiosk displays (review M7)
```

Add `unbindBotFromOtherDevices` to that branch's import. `delete-bot.js` keeps unbinding **every** device of a deleted bot, kiosks included: a display whose bot is gone must show `no_bound_bot`.

```bash
cd ~/crow-wt-kiosk-k1
sed -i 's#"\.\./\.\./\.\./\.\./\.\./bundles/meta-glasses/server/device-store\.js"#"../../../../shared/device-store.js"#g' \
  servers/gateway/dashboard/panels/bot-builder/{api-handlers,editor,delete-bot}.js
grep -rn "meta-glasses/server/device-store" servers/ | grep -v "^bundles" ; echo "exit=$? (1 = none left)"
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npm test -- tests/device-store.test.js tests/bot-builder-checklist-delete.test.js tests/bot-builder-gateway-draft.test.js`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add servers/shared/device-store.js tests/device-store.test.js
git commit servers/shared/device-store.js bundles/meta-glasses/server/device-store.js servers/gateway/dashboard/panels/bot-builder/api-handlers.js servers/gateway/dashboard/panels/bot-builder/editor.js servers/gateway/dashboard/panels/bot-builder/delete-bot.js tests/device-store.test.js -m "feat(devices): core device store with kiosk kind, domain-separated kiosk token hash, throttled last_seen"
git show --stat HEAD
```

---

### Task 2: One voice routing policy (`chooseVoiceRoute`) + the 20 scripted questions

**Files:**
- Modify: `servers/gateway/routes/llm-router.js` (add exports; `handleChat` lines ~316-322 use them)
- Create: `bundles/kiosk/server/questions.js`
- Test: `tests/llm-router-voice-route.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `chooseVoiceRoute(messages, {hasTools}) → {route, reason, key}`, `VOICE_ROUTE_KEYS`, `resolveVoiceKey(key)`, `probeVoiceReady(baseUrl)`; `LATENCY_QUESTIONS: string[20]`.

- [ ] **Step 1: Write the failing test**

`tests/llm-router-voice-route.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseVoiceRoute, VOICE_ROUTE_KEYS } from "../servers/gateway/routes/llm-router.js";
import { LATENCY_QUESTIONS } from "../bundles/kiosk/server/questions.js";

const u = (content) => [{ role: "system", content: "s" }, { role: "user", content }];

test("plain question → fast", () => {
  assert.deepEqual(chooseVoiceRoute(u("What is the capital of Portugal?"), { hasTools: true }),
    { route: "fast", reason: null, key: VOICE_ROUTE_KEYS.fast });
});

test("!escalate → manual escalation", () => {
  const r = chooseVoiceRoute(u("!escalate explain entropy"), { hasTools: false });
  assert.equal(r.route, "escalate"); assert.equal(r.reason, "manual"); assert.equal(r.key, VOICE_ROUTE_KEYS.escalate);
});

test("action verb escalates only when tools are on the table", () => {
  assert.equal(chooseVoiceRoute(u("play some jazz"), { hasTools: true }).reason, "tool-intent");
  assert.equal(chooseVoiceRoute(u("play some jazz"), { hasTools: false }).route, "fast");
});

test("recent tool context is sticky (tool message within the lookback)", () => {
  const msgs = [...u("set a timer"), { role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "1", name: "crow_wm" }]) },
    { role: "tool", content: "{}", tool_call_id: "1" }, { role: "assistant", content: "Done." }, { role: "user", content: "thanks" }];
  assert.equal(chooseVoiceRoute(msgs, { hasTools: true }).route, "escalate");
});

test("every scripted latency question routes fast on a kiosk (tools always present)", () => {
  assert.equal(LATENCY_QUESTIONS.length, 20);
  assert.equal(new Set(LATENCY_QUESTIONS).size, 20);
  for (const q of LATENCY_QUESTIONS) {
    assert.equal(chooseVoiceRoute(u(q), { hasTools: true }).route, "fast", q);
    assert.ok(q.split(/\s+/).length <= 12, `short question: ${q}`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/llm-router-voice-route.test.js`
Expected: FAIL — `chooseVoiceRoute` is not exported.

- [ ] **Step 3: Implement**

Add to `servers/gateway/routes/llm-router.js`, directly after `stripEscalate`:

```js
/** The fast/escalate keys the router and the kiosk voice turn share. */
export const VOICE_ROUTE_KEYS = Object.freeze({ fast: FAST_KEY, escalate: ESC_KEY });

/**
 * THE voice routing policy (kiosk spec §7.2): the same decision /llm/v1 makes,
 * callable in-process so the kiosk needs no HTTP hop. `messages` is the full
 * OpenAI-style list; `hasTools` says whether the turn advertises any tools.
 */
export function chooseVoiceRoute(messages, { hasTools = false } = {}) {
  const body = { messages: Array.isArray(messages) ? messages : [], tools: hasTools ? [{}] : [] };
  if (wantsEscalation(body)) return { route: "escalate", reason: "manual", key: ESC_KEY };
  if (wantsToolEscalation(body)) return { route: "escalate", reason: "tool-intent", key: ESC_KEY };
  return { route: "fast", reason: null, key: FAST_KEY };
}

export const resolveVoiceKey = (key) => resolveKey(key);
export const probeVoiceReady = (baseUrl) => defaultProbeReady(baseUrl);
```

In `handleChat`, replace the five lines `llm-router.js:318-322`, from `const manualEsc = wantsEscalation(body);` through `const escReason = …`, with:

```js
  const decision = chooseVoiceRoute(body.messages, { hasTools: Array.isArray(body.tools) && body.tools.length > 0 });
  if (decision.reason === "manual") stripEscalate(body); // only the typed token is stripped
  const escalate = decision.route === "escalate";
  const escReason = decision.reason;
```

The next line, `let key = escalate ? ESC_KEY : FAST_KEY;`, stays as it is. `chooseVoiceRoute` has the same order and the same predicates, so `/llm/v1` behaviour is unchanged. The existing router tests prove it in Step 5.

`bundles/kiosk/server/questions.js`:

```js
/**
 * The 20 scripted short questions for the K1/K2 latency gate (spec §9, §13.2 A2/A5).
 * Chosen to be answerable in one sentence by the fast 4B with NO tool, and to
 * avoid every TOOL_INTENT_RE word (play, open, stop, show me, search, look up,
 * turn up, ...) so each one exercises the fast route — pinned by
 * tests/llm-router-voice-route.test.js. Ask them in this order, one per turn.
 */
export const LATENCY_QUESTIONS = Object.freeze([
  "What is the capital of Portugal?",
  "How many days are in a leap year?",
  "Give me a quick fun fact about octopuses.",
  "What is twelve times fourteen?",
  "How do you say thank you in Spanish?",
  "What rhymes with orange?",
  "Tell me a short joke.",
  "How many ounces are in a cup?",
  "What is the boiling point of water in Fahrenheit?",
  "Who wrote Pride and Prejudice?",
  "What is a good name for a goldfish?",
  "How far away is the moon, roughly?",
  "What is the opposite of ancient?",
  "How do you spell necessary?",
  "How many legs does a spider have?",
  "What color do you get mixing blue and yellow?",
  "What is the square root of eighty one?",
  "Name three kinds of citrus fruit.",
  "How long should I boil an egg for a soft yolk?",
  "What does a crow like to eat?",
]);
```

- [ ] **Step 4: Run the new test and watch it pass**

Run: `npm test -- tests/llm-router-voice-route.test.js`
Expected: PASS.

- [ ] **Step 5: The existing router tests still pass (same behaviour)**

Run: `npm test -- tests/llm-router-companion-source.test.js tests/llm-router-crash.test.js tests/llm-router-door.test.js tests/llm-router-reserved.test.js tests/llm-router-serving-class.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bundles/kiosk/server/questions.js tests/llm-router-voice-route.test.js
git commit servers/gateway/routes/llm-router.js bundles/kiosk/server/questions.js tests/llm-router-voice-route.test.js -m "feat(llm-router): export chooseVoiceRoute as the one voice routing policy; kiosk latency question set"
```

---
### Task 3: Voice-turn helpers, pinned to the glasses behaviour they reproduce

**Files:**
- Create: `servers/gateway/voice/turn-helpers.js`
- Test: `tests/voice-turn-helpers.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SENTENCE_END`
  - `createThinkGate() → {feed(text) → string}`
  - `createSentenceChunker(onSentence) → {push(text), flush()}`, both async
  - `createConfirmGate({now, ttlMs}) → {check({deviceId, eff, args, transcript}) → "allow"|"confirm"}`
  - `createConvoStore({maxMessages, idleMs, now}) → {get(id), save(id, messages), clear(id)}`
  - `isDestructiveTool(name)`, `describeDestructiveAction(tc)`, `canonicalArgsHash(args)`
  - `negotiatePcm(adapterName) → {synthFormat, codec, sampleRate, stripHeaderBytes}|null`
  - `pcmStream(adapter, text, voice, neg, {signal}) → AsyncGenerator<Buffer>`
  - `wrapPcmAsWav(pcm, sampleRate) → Buffer`

These are copies of the module-private glasses functions at `bundles/meta-glasses/panel/routes.js:186-248` and `:301-336` / `:688-745` / `:994-1025`. They change in two places, both called out in the code: `pcmStream` honours an abort signal, and the conversation store never starts its kept window on an orphaned tool or assistant message. Glasses is **not** switched to this module in K1 (spec §7.1).

- [ ] **Step 1: Write the failing test**

`tests/voice-turn-helpers.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as H from "../servers/gateway/voice/turn-helpers.js";

test("think gate (glasses :994-1025): leading <think> never reaches speech; partial tag is held; plain text passes", () => {
  const g = H.createThinkGate();
  assert.equal(g.feed("<thi"), "");
  assert.equal(g.feed("nk>plan the answer"), "");
  assert.equal(g.feed("</think>Hello"), "Hello");
  assert.equal(g.feed(" there."), " there.");
  const p = H.createThinkGate();
  assert.equal(p.feed("  Sure"), "  Sure");
  assert.equal(p.feed("<think>not a lead"), "<think>not a lead", "only a LEADING block is gated");
});

test("sentence chunker (glasses SENTENCE_END): splits on terminal punctuation + space or newline; flush sends the tail", async () => {
  const out = [];
  const c = H.createSentenceChunker(async (s) => { out.push(s); });
  await c.push("Hi there. How are");
  await c.push(" you? Fine");
  assert.deepEqual(out, ["Hi there. ", "How are you? "]);
  await c.flush();
  assert.deepEqual(out, ["Hi there. ", "How are you? ", "Fine"]);
  await c.flush();
  assert.equal(out.length, 3, "second flush is a no-op");
});

test("confirm gate (glasses :186-225): first call confirms; same tool+args+affirmative within 60 s allows; anything else re-arms", () => {
  let t = 0;
  const g = H.createConfirmGate({ now: () => t });
  const call = { deviceId: "d", eff: "crow_delete_post", args: { id: 3 } };
  assert.equal(g.check({ ...call, transcript: "delete post 3" }), "confirm");
  t = 10_000;
  assert.equal(g.check({ ...call, transcript: "yes do it" }), "allow");
  assert.equal(g.check({ ...call, transcript: "yes" }), "confirm", "consumed; re-armed");
  t = 80_000;
  assert.equal(g.check({ ...call, transcript: "yes" }), "confirm", "expired after 60 s");
  assert.equal(g.check({ ...call, args: { id: 4 }, transcript: "yes" }), "confirm", "args changed");
  assert.equal(g.check({ deviceId: "other", eff: "crow_delete_post", args: { id: 4 }, transcript: "yes" }), "confirm", "per device");
});

test("isDestructiveTool matches the glasses list + regex", () => {
  for (const n of ["crow_delete_post", "crow_unpublish_post", "crow_remove_backend", "crow_dismiss_all_notifications", "crow_destroy_x"]) assert.ok(H.isDestructiveTool(n), n);
  for (const n of ["crow_create_post", "crow_wm", "", null]) assert.ok(!H.isDestructiveTool(n), String(n));
});

test("conversation store: 24-message cap, 15-min idle reset, system dropped, never starts on an orphan tool/assistant", () => {
  let t = 0;
  const s = H.createConvoStore({ now: () => t });
  const msgs = [{ role: "system", content: "x" }];
  for (let i = 0; i < 20; i++) msgs.push({ role: "user", content: "u" + i }, { role: "assistant", content: "", tool_calls: "[]" }, { role: "tool", content: "r" });
  msgs.push({ role: "user", content: "last" }, { role: "assistant", content: "ok" });
  // 62 non-system messages: the plain last-24 window would START on a tool result (index 38 = tool).
  s.save("d", msgs);
  const kept = s.get("d");
  assert.equal(kept.length, 23, "the orphan tool result at the window's head is trimmed");
  assert.equal(kept[0].role, "user");
  assert.equal(kept.at(-1).content, "ok");
  assert.ok(!kept.some((m) => m.role === "system"));
  t = 15 * 60 * 1000 + 1;
  assert.deepEqual(s.get("d"), []);
});

test("negotiatePcm: kokoro/openai 24 kHz raw; piper strips 44 bytes; edge has no PCM path", () => {
  assert.deepEqual(H.negotiatePcm("kokoro"), { synthFormat: "pcm", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 });
  assert.equal(H.negotiatePcm("piper").stripHeaderBytes, 44);
  assert.equal(H.negotiatePcm("edge"), null);
});

test("pcmStream strips a header, passes the abort signal to synth, and yields nothing once aborted", async () => {
  const seen = [];
  const adapter = { async *synthesize(text, voice, opts) { seen.push(opts); yield Buffer.alloc(40, 1); yield Buffer.alloc(10, 2); yield Buffer.alloc(6, 3); } };
  const out = [];
  for await (const c of H.pcmStream(adapter, "hi", "v", { synthFormat: undefined, stripHeaderBytes: 44 })) out.push(c);
  assert.equal(Buffer.concat(out).length, 12);
  const live = new AbortController();
  for await (const c of H.pcmStream(adapter, "hi", "v", H.negotiatePcm("kokoro"), { signal: live.signal })) out.push(c);
  assert.equal(seen.at(-1).signal, live.signal, "the abort signal reaches the provider call");
  assert.equal(seen.at(-1).format, "pcm");
  const ac = new AbortController(); ac.abort();
  const calls = seen.length;
  const none = [];
  for await (const c of H.pcmStream(adapter, "hi", "v", H.negotiatePcm("kokoro"), { signal: ac.signal })) none.push(c);
  assert.equal(none.length, 0);
  assert.equal(seen.length, calls, "an already-aborted turn never calls the provider");
});

test("wrapPcmAsWav writes a 44-byte RIFF header for 16 kHz mono s16", () => {
  const w = H.wrapPcmAsWav(Buffer.alloc(320), 16000);
  assert.equal(w.length, 364);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt32LE(40), 320);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/voice-turn-helpers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `servers/gateway/voice/turn-helpers.js`**

```js
/**
 * Pure voice-turn pieces extracted from the Meta Glasses loop
 * (bundles/meta-glasses/panel/routes.js) for the transport-free core turn
 * (kiosk spec 2026-10-03 §7.1). Behaviour is pinned to glasses by
 * tests/voice-turn-helpers.test.js. Two deliberate differences, both marked:
 * pcmStream honours an AbortSignal (barge-in), and the convo store trims to a
 * window that starts on a user message (no orphan tool result).
 */

export const SENTENCE_END = /[.!?…。]["')\]]?\s|[\n]/;

export function createThinkGate() {
  let open = false;
  let pre = "";
  return {
    feed(text) {
      if (open) return text;
      pre += text;
      const lead = pre.replace(/^\s+/, "");
      if (lead.startsWith("<think>")) {
        const close = pre.indexOf("</think>");
        if (close < 0) return "";
        const out = pre.slice(close + 8);
        pre = "";
        open = true;
        return out;
      }
      if (lead.length < 7 && "<think>".startsWith(lead)) return "";
      const out = pre;
      pre = "";
      open = true;
      return out;
    },
  };
}

export function createSentenceChunker(onSentence) {
  let buf = "";
  return {
    async push(text) {
      buf += text;
      for (;;) {
        const m = SENTENCE_END.exec(buf);
        if (!m) break;
        const end = m.index + m[0].length;
        const sentence = buf.slice(0, end);
        buf = buf.slice(end);
        await onSentence(sentence);
      }
    },
    async flush() {
      const rest = buf;
      buf = "";
      if (rest.trim()) await onSentence(rest);
    },
  };
}

export const CONFIRM_TTL_MS = 60_000;
const DESTRUCTIVE_EXACT = new Set([
  "crow_delete_post", "crow_delete_memory", "crow_delete_setlist",
  "crow_unpublish_post", "crow_remove_backend", "crow_dismiss_all_notifications",
]);
const DESTRUCTIVE_REGEX = /^crow_(delete|remove|destroy|unpublish)_/;
export const AFFIRMATIVE_STARTS = /^\s*(yes|yeah|yep|yup|confirmed?|do it|go ahead|proceed|ok|okay)\b/i;
export const NEGATIVE_STARTS = /^\s*(no|nope|cancel|stop|wait|nevermind|never mind)\b/i;

export function isDestructiveTool(name) {
  if (!name) return false;
  return DESTRUCTIVE_EXACT.has(name) || DESTRUCTIVE_REGEX.test(name);
}

export function describeDestructiveAction(tc) {
  const base = (tc.name || "").replace(/^crow_/, "").replace(/_/g, " ");
  const arg = tc.arguments || {};
  const ref = arg.id || arg.slug || arg.post_id || arg.memory_id || arg.setlist_id || "";
  return ref ? `${base} ${ref}` : base;
}

export function canonicalArgsHash(args) {
  const seen = new WeakSet();
  const canonical = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (seen.has(v)) return '"__cycle__"';
    seen.add(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  };
  return canonical(args || {});
}

export function createConfirmGate({ now = Date.now, ttlMs = CONFIRM_TTL_MS } = {}) {
  const pending = new Map();
  return {
    check({ deviceId, eff, args, transcript }) {
      const p = pending.get(deviceId);
      const hash = canonicalArgsHash(args);
      const yes = AFFIRMATIVE_STARTS.test(transcript || "");
      const no = NEGATIVE_STARTS.test(transcript || "");
      if (p && p.toolName === eff && p.argsHash === hash && now() - p.at < ttlMs && yes && !no) {
        pending.delete(deviceId);
        return "allow";
      }
      pending.set(deviceId, { toolName: eff, argsHash: hash, at: now() });
      return "confirm";
    },
  };
}

export function createConvoStore({ maxMessages = 24, idleMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const store = new Map();
  return {
    get(id) {
      const e = store.get(id);
      if (!e) return [];
      if (now() - e.lastAt > idleMs) { store.delete(id); return []; }
      return e.messages;
    },
    save(id, messages) {
      let kept = messages.filter((m) => m.role !== "system").slice(-maxMessages);
      // DIFFERENCE from glasses: never begin on a tool result or a tool-calling
      // assistant whose user turn was trimmed away (OpenAI-compatible servers reject it).
      const firstUser = kept.findIndex((m) => m.role === "user");
      kept = firstUser < 0 ? [] : kept.slice(firstUser);
      store.set(id, { messages: kept, lastAt: now() });
    },
    clear(id) { store.delete(id); },
  };
}

export function negotiatePcm(adapterName) {
  switch (adapterName) {
    case "openai-tts":
    case "kokoro":
      return { synthFormat: "pcm", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 };
    case "elevenlabs":
      return { synthFormat: "pcm_24000", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 };
    case "azure":
      return { synthFormat: "raw-24khz-16bit-mono-pcm", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 };
    case "piper":
      return { synthFormat: undefined, codec: "pcm", sampleRate: 22050, stripHeaderBytes: 44 };
    default:
      return null;
  }
}

/** Buffer one sentence's synthesis, then yield 64 KB frames (glasses behaviour, ruling R15). */
export async function* pcmStream(adapter, text, voice, negotiation, { signal } = {}) {
  if (signal?.aborted) return;
  let bytesToStrip = negotiation.stripHeaderBytes || 0;
  const opts = { signal };
  if (negotiation.synthFormat) opts.format = negotiation.synthFormat;
  const parts = [];
  for await (const chunk of adapter.synthesize(text, voice, opts)) {
    if (signal?.aborted) return;
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytesToStrip > 0) {
      if (b.length <= bytesToStrip) { bytesToStrip -= b.length; continue; }
      parts.push(b.subarray(bytesToStrip));
      bytesToStrip = 0;
    } else {
      parts.push(b);
    }
  }
  const full = Buffer.concat(parts);
  const FRAME = 64 * 1024;
  for (let off = 0; off < full.length; off += FRAME) {
    if (signal?.aborted) return;
    yield full.subarray(off, Math.min(off + FRAME, full.length));
  }
}

export function wrapPcmAsWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- tests/voice-turn-helpers.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/voice/turn-helpers.js tests/voice-turn-helpers.test.js
git commit servers/gateway/voice/turn-helpers.js tests/voice-turn-helpers.test.js -m "feat(voice): transport-free turn helpers extracted from the glasses loop"
```

---

### Task 4: `servers/gateway/voice/turn.js` (the core voice turn)

**Files:**
- Create: `servers/gateway/voice/turn.js`
- Test: `tests/voice-turn.test.js`

**Interfaces:**
- Consumes:
  - Task 3: the helpers.
  - Task 2: `chooseVoiceRoute`, `VOICE_ROUTE_KEYS`, `resolveVoiceKey`, `probeVoiceReady`.
  - Existing:
    - `getChatTools`, `createToolExecutor`, `MAX_TOOL_ROUNDS`, `effectiveToolName`, `isExternalSendTool`, `isConnectedAddonTool`, `botVoiceScope` (`servers/gateway/ai/tool-executor.js`);
    - `generateSystemPrompt({deviceId, botDef})` (`ai/system-prompt.js`);
    - `createAdapterFromProfile({provider_id, model_id}, null, db)` (`ai/provider.js`);
    - the STT/TTS profile functions (`ai/stt/index.js`, `ai/tts/index.js`);
    - `maybeAcquireLocalProvider(name, {requester})` (`gpu-orchestrator.js`);
    - `TOOL_MANIFESTS.memory.tools` (`tool-manifests.js`).
- Produces: `createVoiceTurnRunner(deps) → {runVoiceTurn, speakText, convo}` and `defaultVoiceDeps()`, with the `opts`/`TurnResult` shapes from "Interfaces shared across tasks". Sink events: `transcript_final {text}`, `caption_delta {text}`, `tts_start {codec, sample_rate}`, `tts_end`, `error {code, recoverable, message?}`, plus any `events` a fast path or extra tool emits. Exported constants: `ESCALATION_READY_TIMEOUT_MS = 8000`, `FILLER_TEXT = "One moment."`.

Notes for the implementer:
- Cross-instance (federated) voice tools (`buildRemoteVoiceContext`) are **not** offered on a kiosk in K1. A household display reaching a peer's tools would need its own consent story.
- Escalation keeps `enable_thinking:false` (glasses behaviour); the think gate backstops it.
- A non-PCM TTS adapter (Edge) sends **one mp3 buffer per sentence**, because the page decodes each binary frame as one file.

- [ ] **Step 1: Write the failing test**

`tests/voice-turn.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceTurnRunner, ESCALATION_READY_TIMEOUT_MS, FILLER_TEXT } from "../servers/gateway/voice/turn.js";

/** A fake clock: sleep() advances it. */
function clock() { let t = 1_000; return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } }; }

/** chat adapter that plays one scripted round per chatStream call (the round index is shared by every adapter the harness hands out). */
function scriptedChat(rounds, log, state) {
  return {
    async *chatStream(messages, tools, opts) {
      log.push({ messages: messages.map((m) => ({ ...m })), tools: tools.map((t) => t.name), opts, systemAfterZero: messages.slice(1).some((m) => m.role === "system") });
      const events = rounds[state.i++] || [{ type: "done" }];
      for (const ev of events) { if (opts.signal?.aborted) return; log.pulls = (log.pulls || 0) + 1; yield ev; }
    },
  };
}

function harness({ rounds = [[{ type: "content_delta", text: "Lisbon is the capital. " }, { type: "done" }]], route = "fast",
  bot = { bot_id: "household", display_name: "House", fast_voice_model: "crow-voice/qwen3.5-4b" },
  chatTools = ["crow_memory", "crow_projects", "crow_glasses_capture_photo", "crow_delegate"], probe = () => false, acquire = async () => null,
  ttsName = "kokoro", ctx = null } = {}) {
  const c = clock();
  const log = [];
  const state = { i: 0 };
  const calls = { chatKeys: [], executed: [], spoken: [], sleeps: 0, acquired: [], routed: [] };
  const deps = {
    now: c.now, sleep: async (ms) => { calls.sleeps++; await c.sleep(ms); },
    loadBotRow: async (db, id) => (bot && id === bot.bot_id ? { bot_id: bot.bot_id, enabled: 1, definition: JSON.stringify(bot) } : null),
    getSttProfile: async () => ({ id: "kiosk-stt", language: "en" }),
    createSttAdapter: async () => ({ transcribe: async (audio, o) => ({ text: o.__text ?? "What is the capital of Portugal?" }) }),
    getTtsProfile: async () => ({ id: "kokoro", defaultVoice: "af_heart" }),
    createTtsAdapter: async () => ({ name: ttsName, async *synthesize(text, voice, o) { calls.spoken.push(text); yield Buffer.from(text); } }),
    createChatAdapter: async (key) => { calls.chatKeys.push(key); return scriptedChat(rounds, log, state); },
    resolveKey: async (key) => ({ baseUrl: "http://esc", model: key }),
    acquire: async (p) => { calls.acquired.push(p); return acquire(p); },
    probeReady: async () => probe(),
    contextLenFor: async () => ctx,
    chooseVoiceRoute: (msgs) => (calls.routed.push(msgs.map((m) => m.role)), route === "fast" ? { route: "fast", reason: null, key: "crow-voice/qwen3.5-4b" } : { route: "escalate", reason: "tool-intent", key: "crow-chat/qwen3.6-35b-a3b" }),
    fastKey: "crow-voice/qwen3.5-4b",
    getChatTools: () => chatTools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    createToolExecutor: () => ({ executeToolCalls: async (tcs) => { calls.executed.push(...tcs.map((t) => t.name)); return tcs.map((t) => ({ id: t.id, name: t.name, result: "ok" })); }, close: async () => {} }),
    maxToolRounds: 10,
    effectiveToolName: (tc) => (/^crow_(memory|projects|blog)$/.test(tc.name) && tc.arguments?.action ? "crow_" + String(tc.arguments.action).replace(/^crow_/, "") : tc.name),
    isExternalSendTool: () => false, isConnectedAddonTool: () => false, botVoiceScope: () => null,
    generateSystemPrompt: async ({ botDef }) => `PERSONA:${botDef.display_name}`,
    isMemoryTool: (n) => n === "crow_memory" || n === "crow_search_memories",
  };
  const events = [];
  const audio = [];
  const sink = { event: (e) => events.push(e), audio: (b) => audio.push(b) };
  const runner = createVoiceTurnRunner(deps);
  const device = { id: "kiosk-a", bound_bot_id: bot?.bot_id ?? null, kiosk_settings: { memory_integration: false } };
  return { runner, deps, calls, events, audio, sink, device, log, c };
}

test("transcript → bot persona + suffix → fast model; captions, PCM tts framing, timings", async () => {
  const h = harness();
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, audio: Buffer.alloc(10), sink: h.sink, promptSuffix: "KIOSK" });
  assert.equal(r.transcript, "What is the capital of Portugal?");
  assert.equal(r.route, "fast");
  assert.deepEqual(h.calls.chatKeys, ["crow-voice/qwen3.5-4b"]);
  assert.match(h.log[0].messages[0].content, /^PERSONA:House\n\nKIOSK$/);
  assert.equal(h.log[0].messages.at(-1).content, "What is the capital of Portugal?");
  assert.equal(h.log[0].opts.chatTemplateKwargs.enable_thinking, false);
  assert.deepEqual(h.events.map((e) => e.type), ["transcript_final", "caption_delta", "tts_start", "tts_end"]);
  assert.deepEqual(h.events[2], { type: "tts_start", codec: "pcm", sample_rate: 24000 });
  assert.equal(Buffer.concat(h.audio).toString(), "Lisbon is the capital.");
  for (const k of ["stt_ms", "llm_first_token_ms", "tts_first_chunk_ms", "total_ms"]) assert.equal(typeof r.timings[k], "number", k);
});

test("memory category + glasses capture are stripped unless memory_integration; a forced memory call is refused", async () => {
  const h = harness({ rounds: [[{ type: "tool_call", id: "t1", name: "crow_memory", arguments: { action: "search_memories", params: { query: "x" } } }, { type: "done" }], [{ type: "content_delta", text: "I can't here." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, audio: Buffer.alloc(1), sink: h.sink });
  assert.deepEqual(h.log[0].tools, ["crow_projects", "crow_delegate"]);
  assert.deepEqual(h.calls.executed, [], "the executor never ran the memory call");
  assert.match(h.log[1].messages.at(-1).content, /Memory is turned off on this display/);
  const on = harness();
  on.device.kiosk_settings.memory_integration = true;
  await on.runner.runVoiceTurn({ db: {}, device: on.device, audio: Buffer.alloc(1), sink: on.sink });
  assert.deepEqual(on.log[0].tools, ["crow_memory", "crow_projects", "crow_delegate"]);
});

test("think gate: <think> text is never spoken or captioned", async () => {
  const h = harness({ rounds: [[{ type: "content_delta", text: "<think>plan" }, { type: "content_delta", text: " it</think>Hello there. " }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hi", sink: h.sink });
  assert.deepEqual(h.calls.spoken, ["Hello there."]);
  assert.ok(!h.events.some((e) => e.type === "caption_delta" && /think|plan/.test(e.text)));
});

test("sentence chunking: each sentence is synthesized in order", async () => {
  const h = harness({ rounds: [[{ type: "content_delta", text: "One. Two" }, { type: "content_delta", text: "! Three" }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "count", sink: h.sink });
  assert.deepEqual(h.calls.spoken, ["One.", "Two!", "Three"]);
});

test("barge-in: abort stops the LLM stream and TTS at once (no further pulls, no more audio)", async () => {
  const ac = new AbortController();
  const h = harness({ rounds: [[{ type: "content_delta", text: "First. " }, { type: "content_delta", text: "Second. " }, { type: "content_delta", text: "Third. " }, { type: "done" }]] });
  const origAudio = h.sink.audio;
  let tAbort = 0;
  h.sink.audio = (b) => { origAudio(b); tAbort = performance.now(); ac.abort(); };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "go", sink: h.sink, signal: ac.signal });
  const tDone = performance.now();
  assert.equal(r.aborted, true);
  assert.equal(h.audio.length, 1, "only the first sentence's audio left the server");
  assert.ok(h.log.pulls <= 2, `stream stopped after abort (pulls=${h.log.pulls})`);
  assert.equal(h.log[0].opts.signal, ac.signal, "the abort signal reaches the provider fetch");
  assert.ok(tDone - tAbort < 100, `the turn returned ${Math.round(tDone - tAbort)} ms after the abort (real clock; spec: within 100 ms)`);
});

test("cold escalation target: filler first, then fall back to the fast model after 8 s", async () => {
  const h = harness({ route: "escalate", probe: () => false });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink });
  assert.equal(h.calls.spoken[0], FILLER_TEXT);
  assert.equal(r.route, "fast");
  assert.equal(r.degraded, "cold_timeout");
  assert.deepEqual(h.calls.acquired, ["crow-chat"]);
  assert.ok(h.c.now() >= 1_000 + ESCALATION_READY_TIMEOUT_MS);
  assert.deepEqual(h.calls.chatKeys, ["crow-voice/qwen3.5-4b"]);
  assert.match(h.log[0].messages[0].content, /larger model is not available/, "the note joins the leading system message");
  assert.ok(h.log.every((l) => !l.systemAfterZero), "no system message after index 0 in any request (Qwen templates reject it — review C1)");
});

test("escalation target ready on the second probe → escalated turn on the 35B", async () => {
  let n = 0;
  const h = harness({ route: "escalate", probe: () => ++n >= 2 });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink });
  assert.equal(r.route, "escalate"); assert.equal(r.escalated, true);
  assert.deepEqual(h.calls.chatKeys, ["crow-voice/qwen3.5-4b", "crow-chat/qwen3.6-35b-a3b"]);
});

test("box reserved → immediate fallback, no 8 s wait", async () => {
  const h = harness({ route: "escalate", acquire: async () => { throw Object.assign(new Error("reserved"), { code: "box_reserved" }); } });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink });
  assert.equal(r.degraded, "box_reserved");
  assert.ok(h.calls.sleeps <= 1);
});

test("destructive tool: two-turn spoken confirmation", async () => {
  const del = { type: "tool_call", id: "d1", name: "crow_delete_post", arguments: { id: 7 } };
  const h = harness({ rounds: [[del, { type: "done" }], [{ type: "content_delta", text: "Are you sure?" }, { type: "done" }], [del, { type: "done" }], [{ type: "content_delta", text: "Deleted." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "delete post 7", sink: h.sink });
  assert.deepEqual(h.calls.executed, []);
  assert.match(h.log[1].messages.at(-1).content, /Confirmation required/);
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "yes", sink: h.sink });
  assert.deepEqual(h.calls.executed, ["crow_delete_post"]);
});

test("extra tools run in-process; fast paths skip the LLM entirely", async () => {
  const wmCalls = [];
  const extra = { definition: { name: "crow_wm", description: "wm", inputSchema: { type: "object" } }, execute: async (a) => { wmCalls.push(a); return '{"ok":true}'; } };
  const h = harness({ rounds: [[{ type: "tool_call", id: "w1", name: "crow_wm", arguments: { command: "timer 2 minutes tea" } }, { type: "done" }], [{ type: "content_delta", text: "Timer set." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink, extraTools: [extra] });
  assert.deepEqual(wmCalls, [{ command: "timer 2 minutes tea" }]);
  assert.deepEqual(h.calls.executed, []);
  assert.ok(h.log[0].tools.includes("crow_wm"));

  const f = harness();
  const r = await f.runner.runVoiceTurn({ db: {}, device: f.device, transcript: "close", sink: f.sink,
    fastPaths: async (t) => (t === "close" ? { say: "Closed.", events: [{ type: "wm", action: "close", id: "content-1" }] } : null) });
  assert.equal(r.fastPath, true);
  assert.deepEqual(f.calls.chatKeys, []);
  assert.ok(f.events.some((e) => e.type === "wm" && e.action === "close"));
  assert.deepEqual(f.calls.spoken, ["Closed."]);
});

test("no bound bot → error no_bound_bot, nothing spoken", async () => {
  const h = harness({ bot: null });
  await h.runner.runVoiceTurn({ db: {}, device: { ...h.device, bound_bot_id: null }, transcript: "hi", sink: h.sink });
  assert.ok(h.events.some((e) => e.type === "error" && e.code === "no_bound_bot"));
  assert.deepEqual(h.calls.spoken, []);
});

test("denyTools: crow_delegate/crow_job_status are not advertised and a forced call never runs (review C3)", async () => {
  const h = harness({ rounds: [[{ type: "tool_call", id: "d1", name: "crow_delegate", arguments: { goal: "search Kevin's memories", bot: "kevin-personal" } }, { type: "done" }], [{ type: "content_delta", text: "I can't do that here." }, { type: "done" }]],
    chatTools: ["crow_projects", "crow_delegate", "crow_job_status"] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "delegate", sink: h.sink, denyTools: ["crow_delegate", "crow_job_status"] });
  assert.deepEqual(h.log[0].tools, ["crow_projects"]);
  assert.deepEqual(h.calls.executed, []);
  assert.match(h.log[1].messages.at(-1).content, /not available on this display/);
});

test("routing ignores in-process display-tool turns; turnContext rides on the request only (review M5/M6)", async () => {
  const extra = { definition: { name: "crow_wm", description: "wm", inputSchema: { type: "object" } }, execute: async () => '{"ok":true}' };
  const h = harness({ rounds: [[{ type: "tool_call", id: "w1", name: "crow_wm", arguments: { command: "timer 2 minutes tea" } }, { type: "done" }], [{ type: "content_delta", text: "Set." }, { type: "done" }], [{ type: "content_delta", text: "Lisbon." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink, extraTools: [extra], turnContext: "Open windows: none." });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "capital of Portugal?", sink: h.sink, extraTools: [extra], turnContext: "Open windows: timer 'Tea' 1:59 left." });
  assert.ok(!h.calls.routed[1].includes("tool"), "the crow_wm round-trip is invisible to the router");
  assert.match(h.log.at(-1).messages.at(-1).content, /^Open windows: timer 'Tea' 1:59 left\.\n\ncapital of Portugal\?$/);
  assert.equal(h.log.at(-1).messages[0].content, h.log[0].messages[0].content, "system message byte-stable across turns");
  const saved = h.runner.convo.get("kiosk-a").filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(saved, ["set a timer", "capital of Portugal?"], "saved history has plain transcripts");
});

test("maxTokens is clamped to the model's context minus the prompt estimate (review M6)", async () => {
  const h = harness({ ctx: 500 });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hi", sink: h.sink });
  const m = h.log[0].opts.maxTokens;
  assert.ok(m >= 64 && m < 400, `maxTokens ${m} for a 500-token context`);
  const big = harness({ ctx: null });
  await big.runner.runVoiceTurn({ db: {}, device: big.device, transcript: "hi", sink: big.sink });
  assert.equal(big.log[0].opts.maxTokens, 600, "unknown context → the glasses default");
});

test("Edge (no PCM path) sends ONE mp3 buffer per sentence", async () => {
  const h = harness({ ttsName: "edge", rounds: [[{ type: "content_delta", text: "One. Two." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "x", sink: h.sink });
  assert.deepEqual(h.events.find((e) => e.type === "tts_start"), { type: "tts_start", codec: "mp3", sample_rate: 24000 });
  assert.equal(h.audio.length, 2);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/voice-turn.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `servers/gateway/voice/turn.js`**

```js
/**
 * Transport-free voice turn (kiosk spec 2026-10-03 §7.1, D14). The reusable
 * core of the Meta Glasses loop: STT → bound bot (persona, botVoiceScope,
 * permission policy, fast_voice_model) → route (chooseVoiceRoute; escalation
 * with filler + 8 s cold fallback) → streamed tool loop with the <think> gate
 * → sentence-chunked TTS. Every dependency is injected (defaultVoiceDeps()
 * wires the real ones) so tests run on fakes. Glasses does NOT use this yet.
 *
 * NO AUDIO IS STORED: `opts.audio` is handed to the STT adapter and dropped.
 */
import {
  createThinkGate, createSentenceChunker, createConfirmGate, createConvoStore,
  negotiatePcm, pcmStream, isDestructiveTool, describeDestructiveAction,
} from "./turn-helpers.js";

export const ESCALATION_READY_TIMEOUT_MS = 8000;
export const ESCALATION_PROBE_EVERY_MS = 500;
export const FILLER_TEXT = "One moment.";
export const BOT_CACHE_TTL_MS = 30_000;
const DEGRADED_NOTE = "The larger model is not available right now. Answer with what you have, and call a tool directly if one is needed.";
const MEMORY_OFF = "Memory is turned off on this display. Tell the user you can't use saved memories here, then end your turn — do not call another tool.";

export function createVoiceTurnRunner(deps) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const convo = deps.convo || createConvoStore({ now });
  const confirm = deps.confirm || createConfirmGate({ now });
  const botCache = new Map();
  const fillerCache = new Map();

  async function loadBot(db, botId) {
    if (!botId) return null;
    const hit = botCache.get(botId);
    if (hit && now() - hit.at < BOT_CACHE_TTL_MS) return hit.def;
    let def = null;
    try {
      const row = await deps.loadBotRow(db, botId);
      if (row && row.enabled) {
        def = JSON.parse(row.definition);
        if (def) def.bot_id = row.bot_id;
      }
    } catch { def = null; }
    botCache.set(botId, { def, at: now() });
    return def;
  }

  async function openTts(db, device) {
    const profile = await deps.getTtsProfile(db, device);
    if (!profile) return null;
    const adapter = await deps.createTtsAdapter(profile);
    return { profile, adapter, neg: negotiatePcm(adapter.name), voice: profile.defaultVoice };
  }

  /** A speaker bound to one turn: emits tts_start once, then audio; non-PCM = one buffer per sentence. */
  function makeSpeaker(tts, sink, signal, onChunk) {
    let started = false;
    const begin = () => {
      if (started) return;
      started = true;
      sink.event({ type: "tts_start", codec: tts.neg ? "pcm" : "mp3", sample_rate: tts.neg ? tts.neg.sampleRate : 24000 });
    };
    const emit = (buf) => { if (signal?.aborted || !buf.length) return; onChunk(); sink.audio(buf); };
    async function collect(text) {
      const parts = [];
      const stream = tts.neg ? pcmStream(tts.adapter, text, tts.voice, tts.neg, { signal }) : tts.adapter.synthesize(text, tts.voice, { signal });
      for await (const c of stream) {
        if (signal?.aborted) return null;
        if (tts.neg) { begin(); emit(Buffer.isBuffer(c) ? c : Buffer.from(c)); } else parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      }
      return tts.neg ? null : Buffer.concat(parts);
    }
    const say = async (text) => {
      const t = String(text || "").trim();
      if (!t || signal?.aborted) return;
      const mp3 = await collect(t);
      if (mp3 && !signal?.aborted) { begin(); emit(mp3); }
    };
    say.filler = async () => {
      if (signal?.aborted) return;
      const key = `${tts.profile.id}|${tts.voice}|${tts.adapter.name}`;
      let buf = fillerCache.get(key);
      if (!buf) {
        const parts = [];
        const stream = tts.neg ? pcmStream(tts.adapter, FILLER_TEXT, tts.voice, tts.neg, { signal }) : tts.adapter.synthesize(FILLER_TEXT, tts.voice, { signal });
        for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        if (signal?.aborted) return;
        buf = Buffer.concat(parts);
        fillerCache.set(key, buf);
      }
      begin();
      emit(buf);
    };
    say.end = () => { if (started) sink.event({ type: "tts_end" }); };
    return say;
  }

  async function readyEscalation(key, db, signal) {
    const providerId = String(key).split("/")[0];
    let up;
    try { up = await deps.resolveKey(key); } catch { return { reason: "unresolved" }; }
    let refused = null;
    // maybeAcquireLocalProvider blocks until the model is ready, so it runs in
    // the background and we PROBE instead (ruling R14). A cold start keeps
    // going after we give up (the gateway's on-demand start, CROW-SCHEDULE.md).
    Promise.resolve().then(() => deps.acquire(providerId)).catch((err) => { refused = err || new Error("acquire failed"); });
    const deadline = now() + ESCALATION_READY_TIMEOUT_MS;
    while (now() < deadline) {
      if (signal?.aborted) return { reason: "aborted" };
      await Promise.resolve();
      if (refused) {
        const code = refused.code;
        return { reason: code === "box_reserved" ? "box_reserved" : code === "serving_class_refused" ? "serving_class" : "acquire_failed" };
      }
      if (await deps.probeReady(up.baseUrl)) return { adapter: await deps.createChatAdapter(key, db) };
      await sleep(ESCALATION_PROBE_EVERY_MS);
    }
    return { reason: "cold_timeout" };
  }

  async function runVoiceTurn(opts) {
    const { db, device, sink, signal } = opts;
    const t0 = now();
    const timings = {};
    const result = { transcript: "", route: null, fastPath: false, escalated: false, degraded: null, aborted: false, timings };
    const mark = (k) => { if (timings[k] == null) timings[k] = now() - t0; };
    const aborted = () => signal?.aborted === true;
    const fail = (code, recoverable = true, message) => sink.event({ type: "error", code, recoverable, ...(message ? { message } : {}) });
    let executor = null;
    try {
      // 1. STT (the WAV is only ever passed to the adapter; never written anywhere)
      let transcript = opts.transcript;
      if (transcript == null) {
        const sttProfile = await deps.getSttProfile(db, device);
        if (!sttProfile) { fail("no_stt_profile", false); return result; }
        const stt = await deps.createSttAdapter(sttProfile);
        const r = await stt.transcribe(opts.audio, { filename: "turn.wav", contentType: "audio/wav", language: sttProfile.language || undefined, signal });
        transcript = String(r?.text || "").trim();
        mark("stt_ms");
      }
      result.transcript = transcript;
      sink.event({ type: "transcript_final", text: transcript });
      if (aborted()) { result.aborted = true; return result; }
      if (!transcript) { fail("empty_transcript"); return result; }

      const tts = await openTts(db, device);
      if (!tts) { fail("no_tts_profile", false); return result; }
      const say = makeSpeaker(tts, sink, signal, () => mark("tts_first_chunk_ms"));

      // 2. Fast paths (no LLM)
      if (typeof opts.fastPaths === "function") {
        const fp = await opts.fastPaths(transcript);
        if (fp) {
          result.fastPath = true;
          for (const ev of fp.events || []) sink.event(ev);
          if (fp.say) { sink.event({ type: "caption_delta", text: fp.say }); await say(fp.say); }
          say.end();
          convo.save(device.id, [...convo.get(device.id), { role: "user", content: transcript }, { role: "assistant", content: fp.say || "" }]);
          return result;
        }
      }

      // 3. The bound bot drives the turn (ruling R11: no profile fallback)
      const bot = await loadBot(db, device.bound_bot_id);
      if (!bot) { fail("no_bound_bot", false); return result; }
      const memoryOn = device.kiosk_settings?.memory_integration === true;
      const extra = Array.isArray(opts.extraTools) ? opts.extraTools : [];
      const extraByName = new Map(extra.map((x) => [x.definition.name, x]));
      // denyTools (kiosk: crow_delegate, crow_job_status — review C3): never advertised AND
      // refused by the gate below even if force-called, so a room cannot hand work to
      // another bot (crow_delegate's `bot` arg accepts ANY enabled bot) or read it back.
      const deny = new Set(["crow_glasses_capture_photo", ...(Array.isArray(opts.denyTools) ? opts.denyTools : [])]);
      const tools = deps.getChatTools({ botDef: bot })
        .filter((t) => !deny.has(t.name) && (memoryOn || t.name !== "crow_memory") && !extraByName.has(t.name))
        .concat(extra.map((x) => x.definition));
      executor = deps.createToolExecutor({ botDef: bot });
      // No deviceId: generateSystemPrompt stamps it as a "glasses device_id" for
      // crow_glasses_* tools, and no kiosk tool takes a device_id.
      const system = await deps.generateSystemPrompt({ botDef: bot });
      // The system message stays byte-stable turn to turn (vLLM prefix cache, review M6);
      // live state (e.g. open windows) rides on THIS turn's user message only and is
      // dropped from the saved conversation.
      const userMsg = { role: "user", content: opts.turnContext ? `${opts.turnContext}\n\n${transcript}` : transcript };
      const messages = [
        { role: "system", content: opts.promptSuffix ? `${system}\n\n${opts.promptSuffix}` : system },
        ...convo.get(device.id),
        userMsg,
      ];

      // 4. Route — on a view WITHOUT in-process display-tool turns (review M5): a
      // crow_wm timer must not make the next 2-3 plain questions "recent tool context"
      // and send them to the (possibly cold) 35B.
      const isExtraCall = (m) => {
        if (m.role === "tool") return extraByName.has(m.tool_name);
        if (m.role !== "assistant" || !m.tool_calls) return false;
        try { const tc = JSON.parse(m.tool_calls); return Array.isArray(tc) && tc.length > 0 && tc.every((c) => extraByName.has(c.name)); } catch { return false; }
      };
      const decision = deps.chooseVoiceRoute(messages.filter((m) => !isExtraCall(m)), { hasTools: tools.length > 0 });
      let chat = await deps.createChatAdapter(bot.fast_voice_model || deps.fastKey, db);
      result.route = "fast";
      if (decision.route === "escalate") {
        const filler = say.filler();
        const ready = await readyEscalation(decision.key, db, signal);
        await filler;
        if (ready.adapter) { chat = ready.adapter; result.route = "escalate"; result.escalated = true; }
        // Qwen chat templates reject a system message anywhere but first (review C1):
        // the note joins the leading system message.
        else { result.degraded = ready.reason; messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${DEGRADED_NOTE}` }; }
      }
      if (aborted()) { result.aborted = true; return result; }

      // 5. Streamed tool loop
      const scope = deps.botVoiceScope(bot);
      const policy = bot.permission_policy || {};
      const shortName = (n) => String(n || "").replace(/^crow_/, "").replace(/_/g, " ");
      const policyGate = (tc) => {
        const eff = deps.effectiveToolName(tc);
        if (deny.has(eff) || deny.has(tc.name)) return `"${shortName(eff)}" is not available on this display. Tell the user, then end your turn — do not call another tool.`;
        if (!memoryOn && deps.isMemoryTool(eff)) return MEMORY_OFF;
        if (scope && deps.isConnectedAddonTool(eff) && !scope.selectedToolNames.has(eff)) {
          return `This assistant isn't allowed to use "${shortName(eff)}" by voice. Tell the user and end your turn — do not call another tool.`;
        }
        if (policy.external_send === "draft_only" && deps.isExternalSendTool(eff)) {
          return `This assistant is draft-only by voice and cannot send "${shortName(eff)}" externally. Tell the user it was not sent. Then end your turn — do not call another tool.`;
        }
        if (Array.isArray(policy.deny) && policy.deny.includes(eff)) {
          return `This assistant is not permitted to use "${shortName(eff)}" by voice. Tell the user and end your turn — do not call another tool.`;
        }
        const needsConfirm = isDestructiveTool(eff) || (Array.isArray(policy.confirm) && policy.confirm.includes(eff));
        if (!needsConfirm) return null;
        if (confirm.check({ deviceId: device.id, eff, args: tc.arguments, transcript }) === "allow") return null;
        return `Confirmation required. Tell the user: "Are you sure you want to ${describeDestructiveAction({ name: eff, arguments: tc.arguments })}? Say yes to proceed." Then end your turn — do not call another tool.`;
      };

      const chunker = createSentenceChunker((s) => say(s));
      let rounds = 0;
      let nextMax = 600;
      while (rounds < (deps.maxToolRounds || 10)) {
        rounds++;
        const think = createThinkGate();
        let content = "";
        const calls = [];
        const roundMax = nextMax;
        nextMax = 600;
        // Keep prompt + completion inside the model's context (review M6: the 4B is 8192;
        // tool schemas alone are ~5k tokens). ~3.2 chars/token is a deliberate over-estimate.
        const ctx = await deps.contextLenFor(result.escalated ? decision.key : (bot.fast_voice_model || deps.fastKey), db);
        const estPrompt = Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length) / 3.2);
        const maxTokens = ctx ? Math.max(64, Math.min(roundMax, ctx - estPrompt - 128)) : roundMax;
        timings.est_prompt_tokens = estPrompt; timings.max_tokens = maxTokens;   // in [kiosk-metrics]; the smoke records both
        for await (const ev of chat.chatStream(messages, tools, { temperature: 0.7, maxTokens, chatTemplateKwargs: { enable_thinking: false }, signal })) {
          if (aborted()) break;
          if (ev.type === "content_delta" && ev.text) {
            mark("llm_first_token_ms");
            content += ev.text;
            const spoken = think.feed(ev.text);
            if (spoken) { sink.event({ type: "caption_delta", text: spoken }); await chunker.push(spoken); }
          } else if (ev.type === "tool_call") {
            mark("llm_first_token_ms");
            calls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
          } else if (ev.type === "done") break;
        }
        if (aborted()) { result.aborted = true; break; }
        if (content || calls.length) {
          const m = { role: "assistant", content };
          if (calls.length) m.tool_calls = JSON.stringify(calls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })));
          messages.push(m);
        }
        if (!calls.length) break;
        const local = [];
        const remote = [];
        for (const tc of calls) {
          const gate = policyGate(tc);
          if (gate) { local.push({ id: tc.id, name: tc.name, result: gate }); continue; }
          const x = extraByName.get(tc.name);
          if (x) {
            let out;
            try { out = await x.execute(tc.arguments || {}); } catch (err) { out = JSON.stringify({ action: "error", message: err.message }); }
            local.push({ id: tc.id, name: tc.name, result: out });
            continue;
          }
          remote.push(tc);
        }
        const remoteResults = remote.length ? await executor.executeToolCalls(remote) : [];
        for (const r of [...local, ...remoteResults]) {
          messages.push({ role: "tool", content: r.result, tool_call_id: r.id, tool_name: r.name });
          if (typeof r.result === "string" && r.result.length > 500) nextMax = 4000;
        }
      }
      if (!aborted()) await chunker.flush();
      if (aborted()) result.aborted = true;
      say.end();
      const userIdx = messages.indexOf(userMsg);
      if (userIdx >= 0) messages[userIdx] = { role: "user", content: transcript };
      convo.save(device.id, messages);
      return result;
    } catch (err) {
      if (aborted()) { result.aborted = true; return result; }
      fail("turn_failed", true, err.message);
      return result;
    } finally {
      timings.total_ms = now() - t0;
      if (executor) { try { await executor.close(); } catch {} }
    }
  }

  /** Speak text outside a turn (announce, timer done). */
  async function speakText({ db, device, text, sink, signal }) {
    const tts = await openTts(db, device);
    if (!tts) return false;
    const say = makeSpeaker(tts, sink, signal, () => {});
    await say(text);
    say.end();
    return true;
  }

  return { runVoiceTurn, speakText, convo };
}

/** The real dependencies (gateway process). Lazy so tests never load them. */
export async function defaultVoiceDeps() {
  const stt = await import("../ai/stt/index.js");
  const tts = await import("../ai/tts/index.js");
  const provider = await import("../ai/provider.js");
  const tx = await import("../ai/tool-executor.js");
  const sp = await import("../ai/system-prompt.js");
  const router = await import("../routes/llm-router.js");
  const orch = await import("../gpu-orchestrator.js");
  const { TOOL_MANIFESTS } = await import("../tool-manifests.js");
  const memoryTools = new Set(Object.keys(TOOL_MANIFESTS.memory?.tools || {}));
  const byId = (list, id) => list.find((p) => p.id === id) || null;
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    loadBotRow: async (db, botId) => (await db.execute({ sql: "SELECT bot_id, definition, enabled FROM pi_bot_defs WHERE bot_id = ?", args: [botId] })).rows[0] || null,
    getSttProfile: async (db, device) => (device.stt_profile_id
      ? byId(await stt.getSttProfiles(db, { includeKeys: true }), device.stt_profile_id)
      : stt.getDefaultSttProfile(db, { includeKeys: true })),
    createSttAdapter: async (p) => (await stt.createSttAdapter(p)).adapter,
    getTtsProfile: async (db, device) => (device.tts_profile_id
      ? byId(await tts.getTtsProfiles(db, { includeKeys: true }), device.tts_profile_id)
      : tts.getDefaultTtsProfile(db, { includeKeys: true })),
    createTtsAdapter: async (p) => (await tts.createTtsAdapter(p)).adapter,
    createChatAdapter: async (key, db) => {
      const i = String(key).indexOf("/");
      const provider_id = i >= 0 ? key.slice(0, i) : key;
      const model_id = i >= 0 ? key.slice(i + 1) : "";
      return (await provider.createAdapterFromProfile({ provider_id, model_id }, null, db)).adapter;
    },
    resolveKey: router.resolveVoiceKey,
    probeReady: router.probeVoiceReady,
    acquire: (providerId) => orch.maybeAcquireLocalProvider(providerId, { requester: "kiosk" }),
    chooseVoiceRoute: router.chooseVoiceRoute,
    fastKey: router.VOICE_ROUTE_KEYS.fast,
    getChatTools: tx.getChatTools,
    createToolExecutor: tx.createToolExecutor,
    maxToolRounds: tx.MAX_TOOL_ROUNDS,
    effectiveToolName: tx.effectiveToolName,
    isExternalSendTool: tx.isExternalSendTool,
    isConnectedAddonTool: tx.isConnectedAddonTool,
    botVoiceScope: tx.botVoiceScope,
    generateSystemPrompt: sp.generateSystemPrompt,
    isMemoryTool: (n) => n === "crow_memory" || memoryTools.has(n),
    contextLenFor: async (key, db) => {
      try {
        const i = String(key).indexOf("/");
        const row = (await db.execute({ sql: "SELECT models FROM providers WHERE id = ?", args: [i >= 0 ? key.slice(0, i) : key] })).rows[0];
        const m = JSON.parse(row?.models || "[]").find((x) => x && (x.id === key.slice(i + 1) || i < 0));
        return Number.isFinite(m?.contextLen) ? m.contextLen : null;
      } catch { return null; }
    },
  };
}
```

The test's `sleeps <= 1` assertion for the reserved case depends on the `await Promise.resolve()` before the `refused` check. It gives the background `acquire` rejection a microtask to land before the first probe.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- tests/voice-turn.test.js tests/voice-turn-helpers.test.js`
Expected: PASS. If the reserved test sees `sleeps === 2`, the rejection needs one more microtask: change `await Promise.resolve()` to `await new Promise((r) => setImmediate(r))`. Do not loosen the assertion.

- [ ] **Step 5: Verify the real deps load in-process**

Run:

```bash
CROW_HOME=$(mktemp -d) CROW_DATA_DIR=$(mktemp -d) node --input-type=module -e '
const { defaultVoiceDeps } = await import("./servers/gateway/voice/turn.js");
const d = await defaultVoiceDeps();
console.log(typeof d.chooseVoiceRoute, d.fastKey, d.isMemoryTool("crow_search_memories"), d.isMemoryTool("crow_wm"));
process.exit(0);'
```

Expected: `function crow-voice/qwen3.5-4b true false`. The throwaway `CROW_HOME` keeps it off prod.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/voice/turn.js tests/voice-turn.test.js
git commit servers/gateway/voice/turn.js tests/voice-turn.test.js -m "feat(voice): core transport-free voice turn (bound bot, route + cold fallback, think gate, barge-in, memory strip)"
```

---

### Task 5: STT/TTS services pinned with memory caps + kiosk voice profiles

**Files:**
- Modify: `bundles/faster-whisper-server/docker-compose.yml`, `bundles/faster-whisper-server/manifest.json` (description only)
- Modify: `bundles/kokoro-tts/docker-compose.yml`, `bundles/kokoro-tts/manifest.json` (description only)
- Create: `bundles/kiosk/server/profiles.js`
- Test: `tests/kiosk-services.test.js`

**Interfaces:**
- Consumes: `readSetting(db, key)`, `writeSetting(db, key, value)` (`servers/gateway/dashboard/settings/registry.js`). They are passed in, so `profiles.js` has no bare or app imports.
- Produces:
  - `KIOSK_STT_PROFILE_ID = "kiosk-stt-distil-small-en"` and `KIOSK_STT_MODEL = "Systran/faster-distil-whisper-small.en"`;
  - `ensureKioskSttProfile(db, {readSetting, writeSetting}) → profile`;
  - `pickKioskTtsProfile(db, {readSetting}) → profile|null` (the Kokoro profile).

No new host port. `:8004` and `:8880` are already in `docs/developers/port-allocation.md`. The three-registry check is Step 6.

- [ ] **Step 1: Write the failing test**

`tests/kiosk-services.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureKioskSttProfile, pickKioskTtsProfile, KIOSK_STT_PROFILE_ID, KIOSK_STT_MODEL } from "../bundles/kiosk/server/profiles.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("faster-whisper: pinned to the running digest's tag, never unloads, preloads the kiosk model, capped, loopback only", () => {
  const y = read("bundles/faster-whisper-server/docker-compose.yml");
  assert.match(y, /^\s*image: fedirz\/faster-whisper-server:0\.5\.0-cpu\s*$/m);
  assert.match(y, /WHISPER__TTL: "-1"/);
  assert.match(y, /PRELOAD_MODELS: '\["Systran\/faster-distil-whisper-small\.en"\]'/);
  assert.match(y, /^\s*mem_limit: 8g\s*$/m);
  assert.match(y, /"127\.0\.0\.1:8004:8000"/);
  assert.doesNotMatch(y, /:latest/);
});

test("kokoro: pinned v0.9.0, 4g cap, loopback only", () => {
  const y = read("bundles/kokoro-tts/docker-compose.yml");
  assert.match(y, /^\s*image: ghcr\.io\/remsky\/kokoro-fastapi-cpu:v0\.9\.0\s*$/m);
  assert.match(y, /^\s*mem_limit: 4g\s*$/m);
  assert.match(y, /"127\.0\.0\.1:8880:8880"/);
  assert.doesNotMatch(y, /:latest/);
});

function settings(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, readSetting: async (db, k) => m.get(k) ?? null, writeSetting: async (db, k, v) => { m.set(k, v); } };
}

test("ensureKioskSttProfile: adds a distil-small.en English profile on the existing faster-whisper baseUrl, once", async () => {
  const s = settings({ stt_profiles: JSON.stringify([{ id: "fw", provider: "fasterwhisper", baseUrl: "http://localhost:8004/v1", defaultModel: "Systran/faster-whisper-large-v3", isDefault: true }]) });
  const p = await ensureKioskSttProfile({}, s);
  assert.equal(p.id, KIOSK_STT_PROFILE_ID);
  assert.equal(p.defaultModel, KIOSK_STT_MODEL);
  assert.equal(p.language, "en");
  assert.equal(p.baseUrl, "http://localhost:8004/v1");
  assert.equal(p.isDefault, false, "never steals the default");
  await ensureKioskSttProfile({}, s);
  assert.equal(JSON.parse(s.m.get("stt_profiles")).length, 2, "idempotent");
});

test("pickKioskTtsProfile prefers the local Kokoro profile; null when absent", async () => {
  const s = settings({ tts_profiles: JSON.stringify([{ id: "edge", provider: "edge" }, { id: "k", provider: "kokoro", baseUrl: "http://localhost:8880/v1" }]) });
  assert.equal((await pickKioskTtsProfile({}, s)).id, "k");
  assert.equal(await pickKioskTtsProfile({}, settings()), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/kiosk-services.test.js`
Expected: FAIL — `profiles.js` not found, and the compose assertions fail.

- [ ] **Step 3: Edit the composes**

`bundles/faster-whisper-server/docker-compose.yml`:

```yaml
services:
  faster-whisper-server:
    # Pinned (kiosk K1, 2026-10-03): 0.5.0-cpu IS the image crow already runs
    # (digest sha256:760e5e43…, formerly :latest-cpu) — pinning changes nothing
    # on a recreate.
    image: fedirz/faster-whisper-server:0.5.0-cpu
    container_name: faster-whisper-server
    environment:
      # Preload + default model. OpenAI-compatible /v1/audio/transcriptions.
      WHISPER__MODEL: Systran/faster-whisper-large-v3
      WHISPER__INFERENCE_DEVICE: cpu
      WHISPER__COMPUTE_TYPE: int8
      # Never unload a loaded model. The default (300 s) unloaded after five idle
      # minutes, so the first kiosk turn after a quiet spell paid a model load.
      WHISPER__TTL: "-1"
      # The kiosk's small English model (spec §7.3) is loaded at start.
      PRELOAD_MODELS: '["Systran/faster-distil-whisper-small.en"]'
      ENABLE_UI: "false"
    # large-v3 int8 + distil-small resident, plus decode buffers for a 90-min
    # meeting recording (R4 meeting recorder) — measured headroom, not a target.
    mem_limit: 8g
    volumes:
      # Persist the downloaded CTranslate2 weights across recreates (~3 GB).
      - faster-whisper-cache:/root/.cache/huggingface
    # Loopback only. The OpenAI-compatible Whisper endpoint is consumed by the
    # gateway STT adapter (glasses, kiosk, AI chat, meeting recorder).
    ports:
      - "127.0.0.1:8004:8000"
    restart: unless-stopped

volumes:
  faster-whisper-cache:
```

In `bundles/kokoro-tts/docker-compose.yml`, change the image line and add the cap:

```yaml
    # Pinned (kiosk K1, 2026-10-03): v0.9.0 == :latest on that date (sha256:ee3111d6…).
    image: ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0
    container_name: kokoro-tts
    mem_limit: 4g
```

In both manifests, edit the `description` so it no longer says "AI Companion" only:
- faster-whisper: "…for the Meta Glasses, the Kiosk display and AI-chat voice input…"
- kokoro: "…Powers the Kiosk display and Meta Glasses voices…"

Neither manifest has a `version` field. Docker-bundle refresh never copies `docker-compose.yml` (`bundles.js:712`). The new compose reaches crow when Task 14 recreates whisper from `~/crow/bundles/faster-whisper-server/` (its compose label path) and installs Kokoro fresh.

- [ ] **Step 4: Create `bundles/kiosk/server/profiles.js`**

```js
/**
 * Kiosk voice profiles (spec §7.3, ruling R6). The kiosk STT profile cannot
 * come from a manifest sttProfileSeed: seedProfile() dedups on provider+baseUrl
 * and :8004 already has the large-v3 profile. Created at first approval, with
 * a stable id so it is found again and never duplicated. Never the default.
 */
export const KIOSK_STT_PROFILE_ID = "kiosk-stt-distil-small-en";
export const KIOSK_STT_MODEL = "Systran/faster-distil-whisper-small.en";
const FALLBACK_BASE_URL = "http://localhost:8004/v1";

function parseList(raw) {
  try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

export async function ensureKioskSttProfile(db, { readSetting, writeSetting }) {
  const list = parseList(await readSetting(db, "stt_profiles"));
  const existing = list.find((p) => p.id === KIOSK_STT_PROFILE_ID);
  if (existing) return existing;
  const fw = list.find((p) => p.provider === "fasterwhisper");
  const profile = {
    id: KIOSK_STT_PROFILE_ID,
    name: "Kiosk (faster-whisper distil-small.en)",
    provider: "fasterwhisper",
    apiKey: "",
    baseUrl: (fw?.baseUrl || FALLBACK_BASE_URL).trim(),
    defaultModel: KIOSK_STT_MODEL,
    language: "en",
    isDefault: list.length === 0,
  };
  list.push(profile);
  await writeSetting(db, "stt_profiles", JSON.stringify(list));
  return profile;
}

export async function pickKioskTtsProfile(db, { readSetting }) {
  const list = parseList(await readSetting(db, "tts_profiles"));
  return list.find((p) => p.provider === "kokoro") || null;
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npm test -- tests/kiosk-services.test.js`
Expected: PASS.

- [ ] **Step 6: Three-registry port check (no new port)**

```bash
grep -nE '\| (8004|8880) ' docs/developers/port-allocation.md          # both rows present, 127.0.0.1
grep -rn '8004\|8880' bundles/*/docker-compose*.yml | grep -v -E 'faster-whisper|kokoro|qwen3-embed'   # nothing new
ss -ltn | grep -E ':(8004|8880)\b'                                      # 8004 loopback (+ embed on tailnet IP); 8880 absent until Task 14
node scripts/check-port-allocation.js
```

Expected: the doc rows exist; no other compose claims 8004/8880; `check-port-allocation` exits 0.

- [ ] **Step 7: Commit**

```bash
git add bundles/kiosk/server/profiles.js tests/kiosk-services.test.js
git commit bundles/faster-whisper-server/docker-compose.yml bundles/faster-whisper-server/manifest.json bundles/kokoro-tts/docker-compose.yml bundles/kokoro-tts/manifest.json bundles/kiosk/server/profiles.js tests/kiosk-services.test.js -m "feat(voice-services): pin faster-whisper 0.5.0-cpu (TTL -1, preload distil-small.en, 8g) and kokoro v0.9.0 (4g); kiosk STT/TTS profile helpers"
```

---
### Task 6: Bird class hooks + an opening beak (Ramble 0.13.0 → 0.13.1)

**Files:**
- Modify: `bundles/ramble/server/bird-svg.cjs` (`PARTS` + `drawBird`)
- Modify: `bundles/ramble/manifest.json` (`"version": "0.13.0"` → `"0.13.1"`)
- Create: `tests/fixtures/bird-svg-golden.json` (generated **before** the change), `tests/ramble-bird-hooks.test.js`

**Interfaces:**
- Consumes: the 0.13.0 engine (`rollGenome`, `applyOutfit`, `drawBird`).
- Produces:
  - `drawBird(genome, mood, {hooks:true})`, which emits `class` hooks:
    - `rb-bird` (the outer group);
    - `rb-feet`, `rb-tail`, `rb-body`, `rb-wing`;
    - `rb-head` (a group from the head circle through the beak; it includes hat/marks/scarf/cheeks/glasses, so they tilt with the head);
    - `rb-eye` (a group around the eye only, so a blink never squashes glasses);
    - `rb-beak` (a group containing `rb-beak-upper` + `rb-beak-lower`).
  - With no third argument the output is byte-identical to 0.13.0, outfits included (ruling R5).
  - `PARTS.beakUpper/beakLower/longbeakUpper/longbeakLower`.

**Size (ruling R18):** spec §9's "SVG ≤ 2 KB" predates the wardrobe. A fully dressed 0.13.0 bird is already 2,128 bytes **without** hooks. The pinned budget is therefore ≤ 2,048 bytes **undressed with hooks** and ≤ 2,560 bytes **fully dressed with hooks**. On a Pi 3 what costs is the node count (~35 elements) and the CSS-only animation, not the bytes. That is re-checked on the real Pi in K2.

- [ ] **Step 1: Rebase on main, then freeze the golden output BEFORE touching the engine**

```bash
git fetch origin && git rebase origin/main          # Ramble may have moved again; the golden must be taken from what main draws today
grep -n '"version"' bundles/ramble/manifest.json    # expect 0.13.0; if higher, bump from THAT version in Step 4
mkdir -p tests/fixtures
node -e '
const B = require("./bundles/ramble/server/bird-svg.cjs"); const out = [];
const OUTFITS = [null, { hat: "beanie" }, { scarf: "stripe", glasses: "shades" }, { hat: "bow", scarf: "knit", glasses: "round" }];
for (const sp of B.ROSTER) for (const seed of [0, 1, 7, 42, 304, 123456, 4294967295]) for (const mood of ["happy", "tired", "alarmed"]) for (const outfit of OUTFITS) {
  const g = outfit ? B.applyOutfit(B.rollGenome(seed, sp), outfit) : B.rollGenome(seed, sp);
  out.push({ sp, seed, mood, outfit, svg: B.drawBird(g, mood) });
}
require("fs").writeFileSync("tests/fixtures/bird-svg-golden.json", JSON.stringify(out));
console.log(out.length, "golden birds");'
grep -rn "PARTS)" bundles servers --include=*.js --include=*.cjs | grep -v "^bundles/ramble/server/bird-svg.cjs" ; echo "(no enumerations of PARTS expected)"
```

Expected: `672 golden birds`, and no code that enumerates `PARTS` (adding keys is safe).

- [ ] **Step 2: Write the failing test**

`tests/ramble-bird-hooks.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const B = require("../bundles/ramble/server/bird-svg.cjs");
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/bird-svg-golden.json", import.meta.url), "utf8"));
const genome = (seed, sp, outfit) => (outfit ? B.applyOutfit(B.rollGenome(seed, sp), outfit) : B.rollGenome(seed, sp));
const FULL = { hat: "beanie", scarf: "stripe", glasses: "shades" };

test("default output is byte-identical to 0.13.0, outfits included (golden)", () => {
  for (const g of GOLDEN) assert.equal(B.drawBird(genome(g.seed, g.sp, g.outfit), g.mood), g.svg, `${g.sp}/${g.seed}/${g.mood}/${JSON.stringify(g.outfit)}`);
});

test("hooks output carries every class hook", () => {
  const svg = B.drawBird(genome(7, "crow", FULL), "happy", { hooks: true });
  for (const c of ["rb-bird", "rb-feet", "rb-tail", "rb-body", "rb-wing", "rb-head", "rb-eye", "rb-beak", "rb-beak-upper", "rb-beak-lower"]) assert.ok(svg.includes(`class="${c}"`), c);
  assert.ok(svg.indexOf('class="rb-eye"') < svg.indexOf("r=\"10.5\""), "glasses sit outside the eye group (a blink never squashes them)");
});

const prims = (svg) => (svg.match(/<(ellipse|circle|path|rect|text)\b[^>]*>/g) || []).map((s) => s.replace(/ class="[^"]*"/, ""));
const BEAK_DS = [B.PARTS.beak, B.PARTS.longbeak, B.PARTS.beakUpper, B.PARTS.beakLower, B.PARTS.longbeakUpper, B.PARTS.longbeakLower];
const notBeak = (p) => !BEAK_DS.some((d) => p.includes(`d="${d}"`));

test("hooks output has the same geometry apart from the split beak (dressed and undressed)", () => {
  for (const sp of B.ROSTER) for (const seed of [0, 42, 304]) for (const mood of ["happy", "tired", "alarmed"]) for (const outfit of [null, FULL]) {
    const g = genome(seed, sp, outfit);
    assert.deepEqual(prims(B.drawBird(g, mood, { hooks: true })).filter(notBeak).sort(), prims(B.drawBird(g, mood)).filter(notBeak).sort(), `${sp}/${seed}/${mood}/${!!outfit}`);
  }
});

/** shoelace area of "M x y l dx dy l dx dy z" */
function area(d) {
  const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const p = [[n[0], n[1]]]; p.push([p[0][0] + n[2], p[0][1] + n[3]]); p.push([p[1][0] + n[4], p[1][1] + n[5]]);
  return Math.abs((p[0][0] * (p[1][1] - p[2][1]) + p[1][0] * (p[2][1] - p[0][1]) + p[2][0] * (p[0][1] - p[1][1])) / 2);
}
test("beak halves tile the original beak exactly", () => {
  assert.equal(area(B.PARTS.beakUpper) + area(B.PARTS.beakLower), area(B.PARTS.beak));
  assert.equal(area(B.PARTS.longbeakUpper) + area(B.PARTS.longbeakLower), area(B.PARTS.longbeak));
});

test("hooked bird size: ≤ 2,048 B undressed, ≤ 2,560 B fully dressed (ruling R18)", () => {
  let plain = 0, dressed = 0;
  for (const sp of B.ROSTER) for (let s = 0; s < 200; s++) for (const m of ["happy", "tired", "alarmed"]) {
    plain = Math.max(plain, B.drawBird(genome(s, sp), m, { hooks: true }).length);
    dressed = Math.max(dressed, B.drawBird(genome(s, sp, FULL), m, { hooks: true }).length);
  }
  assert.ok(plain <= 2048, `undressed max ${plain}`);
  assert.ok(dressed <= 2560, `dressed max ${dressed}`);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -- tests/ramble-bird-hooks.test.js`
Expected: the golden test PASSES (nothing has changed yet). The hook, beak-area and size tests FAIL (`PARTS.beakUpper` is undefined; no `class=`).

- [ ] **Step 4: Implement**

In `bundles/ramble/server/bird-svg.cjs`, add to the `PARTS` object after `beanie`. Each half runs from the tip to the midpoint of the base edge, so the two halves tile the original triangle:

```js
    beakUpper: "M0 0 l20 5 l-20 0.5 z", beakLower: "M0 5.5 l20 -0.5 l-20 6 z",
    longbeakUpper: "M0 0 l34 -3 l-33.5 6 z", longbeakLower: "M0.5 3 l33.5 -6 l-33 9 z"
```

In `drawBird`, change the signature and **only** the five assembly sites below. The eye/cheeks/marks/hat/scarf/glasses/crest/neck code from 0.13.0 stays byte-for-byte:

```js
  function drawBird(g, mood, opts) {
    mood = mood === "tired" || mood === "alarmed" ? mood : "happy";
    var hk = !!(opts && opts.hooks);
    function cl(name) { return hk ? ' class="' + name + '"' : ""; }
    // ... 0.13.0 code unchanged down to (and including) `var neck = …` ...
    var tail = '<path' + cl("rb-tail") + ' transform="' + at(cx - bw + 6, cy - 6) + ' scale(' + n(sp.tail) + ' 1)" d="' + PARTS.tail + '" fill="' + g.body + '"/>';
    var beakD = sp.longbeak ? PARTS.longbeak : PARTS.beak;
    var beak = hk
      ? '<g class="rb-beak" transform="' + at(cx + 22, cy - 46) + '"><path class="rb-beak-upper" d="' + (sp.longbeak ? PARTS.longbeakUpper : PARTS.beakUpper) + '" fill="' + sp.beak + '"/><path class="rb-beak-lower" d="' + (sp.longbeak ? PARTS.longbeakLower : PARTS.beakLower) + '" fill="' + sp.beak + '"/></g>'
      : '<path transform="' + at(cx + 22, cy - 46) + '" d="' + beakD + '" fill="' + sp.beak + '"/>';
    var wingDrop = mood === "alarmed" ? -6 : 0;
    var feetSvg = '<g' + cl("rb-feet") + ' stroke="' + feet + '" stroke-width="4" stroke-linecap="round" fill="none"><path transform="' + at(cx - 12, cy + 34) + '" d="' + PARTS.foot + '"/><path transform="' + at(cx + 12, cy + 34) + '" d="' + PARTS.foot + '"/></g>';
    // var alarm = … unchanged
    var eyeOut = hk ? '<g class="rb-eye">' + eye + '</g>' : eye;
    return '<g' + cl("rb-bird") + ' transform="' + at(cx, cy) + ' rotate(' + n(g.tilt) + ') scale(' + n(g.size) + ') ' + at(-cx, -cy) + '">' +
      feetSvg + tail +
      '<ellipse' + cl("rb-body") + ' cx="' + n(cx) + '" cy="' + n(cy) + '" rx="' + n(bw) + '" ry="' + n(bh) + '" fill="' + g.body + '"/>' +
      '<ellipse cx="' + n(cx + 4) + '" cy="' + n(cy + 8) + '" rx="' + n(bw * .62) + '" ry="' + n(bh * .62) + '" fill="' + g.belly + '" opacity=".95"/>' +
      '<ellipse' + cl("rb-wing") + ' cx="' + n(cx - 22) + '" cy="' + n(cy + 2 + wingDrop) + '" rx="18" ry="24" fill="' + hueShift(g.body, 0, .08) + '" opacity=".9" transform="rotate(-12 ' + n(cx - 22) + ' ' + n(cy + 2) + ')"/>' +
      (sp.sheen ? '<ellipse cx="' + n(cx - 10) + '" cy="' + n(cy - 18) + '" rx="16" ry="8" fill="#7ad3ff" opacity=".25"/>' : "") +
      neck + (hk ? '<g class="rb-head">' : "") + '<circle cx="' + n(cx) + '" cy="' + n(cy - 50) + '" r="' + n(hr) + '" fill="' + g.body + '"/>' +
      crest + hat + marks + scarf + cheeks + eyeOut + glasses + beak + alarm + (hk ? "</g>" : "") + '</g>';
  }
```

Diff it against the 0.13.0 `drawBird` before running the tests. The only differences allowed are the `cl(...)` insertions, the `beak`/`eyeOut` ternaries and the two head-group strings. The golden test enforces this.

`mountBird(el, g, mood)` stays as it is; the kiosk calls `drawBird(..., {hooks:true})` itself. Set `"version": "0.13.1"` in `bundles/ramble/manifest.json`.

- [ ] **Step 5: Run the Ramble bird tests and watch them pass**

Run: `npm test -- tests/ramble-bird-hooks.test.js tests/ramble-bird-svg.test.js tests/profile-avatar-bird.test.js tests/ramble-header-bird.test.js tests/ramble-wardrobe.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/bird-svg-golden.json tests/ramble-bird-hooks.test.js
git commit bundles/ramble/server/bird-svg.cjs bundles/ramble/manifest.json tests/fixtures/bird-svg-golden.json tests/ramble-bird-hooks.test.js -m "feat(ramble): opt-in bird class hooks + two-part beak for the kiosk (default output byte-identical, outfits included); ramble 0.13.1"
```

---

### Task 7: Pairing store + kiosk announce token

**Files:**
- Create: `bundles/kiosk/server/pairing.js`
- Modify: `servers/gateway/local-token.js` (append the announce-token helpers)
- Test: `tests/kiosk-pairing.test.js`, `tests/kiosk-announce-token.test.js`

**Interfaces:**
- Consumes: `readSetting`/`writeSetting` (existing, inside `local-token.js`).
- Produces:
  - `createPairingStore({now, randomInt, randomBytes}) → { start({ip, ua, login, nameHint}) → {pair_id, code, poll_secret, expires_in_s} | {error, status}, listPending() → [{pair_id, ip, ua, login, name_hint, created, expires}], claim(code) → {pending} | {error, status, retry_after_s?}, complete(pair_id, {device_id, token}) → boolean, release(pair_id), status(pair_id, pollSecret) → {status, body} }`
  - Constants `PAIR_TTL_MS = 600000`, `PICKUP_GRACE_MS = 120000`, `MAX_PENDING = 3`, `START_LIMIT_PER_MIN = 5`, `LOCK_AFTER = 5`, `LOCK_WINDOW_MS = LOCK_MS = 600000`.
  - `generateKioskAnnounceToken(db) → string`, `validateKioskAnnounceToken(db, token) → boolean`, `ensureKioskAnnounceToken(db) → {minted}`, `KIOSK_ANNOUNCE_TOKEN_KEYS`.

- [ ] **Step 1: Write the failing tests**

`tests/kiosk-pairing.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../bundles/kiosk/server/pairing.js";

function mk() {
  let t = 1_000_000;
  let n = 0;
  const codes = [123456, 654321, 111111, 222222, 333333, 444444, 555555];
  const s = P.createPairingStore({ now: () => t, randomInt: () => codes[n++ % codes.length] });
  return { s, adv: (ms) => { t += ms; } };
}
const start = (s, ip = "100.64.0.9") => s.start({ ip, ua: "Mozilla/5.0 Phone", login: "kevin@example.com", nameHint: "Phone" });

test("start → 6-digit code, 64-hex poll secret; the listing never shows the code or the secret", () => {
  const { s } = mk();
  const r = start(s);
  assert.match(r.code, /^\d{6}$/);
  assert.match(r.poll_secret, /^[0-9a-f]{64}$/);
  assert.match(r.pair_id, /^[0-9a-f]{32}$/);
  const l = s.listPending();
  assert.equal(l.length, 1);
  assert.equal(l[0].ip, "100.64.0.9"); assert.equal(l[0].login, "kevin@example.com");
  assert.ok(!JSON.stringify(l).includes(r.code)); assert.ok(!JSON.stringify(l).includes(r.poll_secret));
});

test("status needs the poll secret; approved token is delivered exactly once", () => {
  const { s } = mk();
  const r = start(s);
  assert.equal(s.status(r.pair_id, "nope").status, 403);
  assert.deepEqual(s.status(r.pair_id, r.poll_secret), { status: 200, body: { state: "pending" } });
  const c = s.claim(r.code);
  assert.equal(c.pending.pair_id, r.pair_id);
  assert.equal(s.complete(r.pair_id, { device_id: "kiosk-1", token: "t".repeat(64) }), true);
  assert.deepEqual(s.status(r.pair_id, r.poll_secret), { status: 200, body: { state: "approved", device_id: "kiosk-1", token: "t".repeat(64) } });
  assert.equal(s.status(r.pair_id, r.poll_secret).status, 404, "second pickup is gone");
});

test("a claimed code cannot be claimed twice; release puts it back", () => {
  const { s } = mk();
  const r = start(s);
  assert.ok(s.claim(r.code).pending);
  assert.equal(s.claim(r.code).error, "bad_code");
  s.release(r.pair_id);
  assert.ok(s.claim(r.code).pending);
});

test("5 wrong codes in 10 min lock approval for 10 min (even the right code), then unlock", () => {
  const { s, adv } = mk();
  const r = start(s);
  for (let i = 0; i < 5; i++) assert.equal(s.claim("000000").error, "bad_code");
  const locked = s.claim(r.code);
  assert.equal(locked.error, "locked"); assert.equal(locked.status, 429); assert.ok(locked.retry_after_s > 0);
  adv(10 * 60 * 1000);
  assert.equal(s.claim(r.code).error, "bad_code", "the code itself expired meanwhile");
});

test("wrong codes outside the 10-min window do not accumulate; malformed codes count", () => {
  const { s, adv } = mk();
  start(s);
  for (let i = 0; i < 4; i++) s.claim("12345x");
  adv(10 * 60 * 1000 + 1);
  start(s);
  assert.equal(s.claim("999999").error, "bad_code");
  assert.notEqual(s.claim("999998").error, "locked");
});

test("expiry: 10 min unapproved → gone; an approved entry gets 2 min for pickup", () => {
  const { s, adv } = mk();
  const r = start(s);
  adv(P.PAIR_TTL_MS);
  assert.equal(s.status(r.pair_id, r.poll_secret).status, 404);
  const r2 = start(s);
  adv(P.PAIR_TTL_MS - 1000);
  s.claim(r2.code); s.complete(r2.pair_id, { device_id: "k", token: "x" });
  adv(60 * 1000);
  assert.equal(s.status(r2.pair_id, r2.poll_secret).body.state, "approved");
});

test("rate limit 5 starts/min per IP; pending cap 3", () => {
  const { s, adv } = mk();
  for (let i = 0; i < 3; i++) assert.ok(start(s).code);
  assert.deepEqual(start(s), { error: "too_many_pending", status: 429 });
  assert.equal(start(s).error, "too_many_pending");
  assert.deepEqual(start(s), { error: "rate_limited", status: 429 }, "6th start this minute from this IP");
  adv(P.PAIR_TTL_MS);
  assert.ok(start(s, "100.64.0.10").code, "another IP, after the pending ones expired");
});
```

`tests/kiosk-announce-token.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { isSyncable } from "../servers/gateway/dashboard/settings/registry.js";
import { ensureKioskAnnounceToken, validateKioskAnnounceToken, KIOSK_ANNOUNCE_TOKEN_KEYS } from "../servers/gateway/local-token.js";

let home, db; const saved = { h: process.env.CROW_HOME, d: process.env.CROW_DATA_DIR };
before(() => {
  home = mkdtempSync(join(tmpdir(), "kiosk-ann-"));
  process.env.CROW_HOME = home; process.env.CROW_DATA_DIR = join(home, "data");
  const p = join(home, "crow.db");
  const c = new Database(p);
  c.exec(`CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE dashboard_settings_overrides (key TEXT NOT NULL, instance_id TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0, PRIMARY KEY (key, instance_id));`);
  c.close();
  db = createDbClient(p);
});
after(() => { db.close(); rmSync(home, { recursive: true, force: true }); for (const [k, v] of [["CROW_HOME", saved.h], ["CROW_DATA_DIR", saved.d]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

test("mint writes a 0600 file and a local-scope hash; validate is exact; ensure is idempotent", async () => {
  assert.deepEqual(await ensureKioskAnnounceToken(db), { minted: true });
  const file = join(home, "kiosk-announce-token");
  const tok = readFileSync(file, "utf8");
  assert.match(tok, /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await validateKioskAnnounceToken(db, tok), true);
  assert.equal(await validateKioskAnnounceToken(db, tok.slice(0, -1) + (tok.endsWith("0") ? "1" : "0")), false);
  assert.equal(await validateKioskAnnounceToken(db, ""), false);
  assert.deepEqual(await ensureKioskAnnounceToken(db), { minted: false });
  assert.equal(readFileSync(file, "utf8"), tok);
  assert.equal(isSyncable(KIOSK_ANNOUNCE_TOKEN_KEYS.HASH), false, "never syncs to peers");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- tests/kiosk-pairing.test.js tests/kiosk-announce-token.test.js`
Expected: FAIL — module or export not found.

- [ ] **Step 3: Implement `bundles/kiosk/server/pairing.js`**

```js
/**
 * Kiosk pairing (spec §4.4). Everything is in memory and nothing survives a
 * restart: a restart simply asks the display for a new code. Only
 * sha256(poll_secret) is kept. The code is guessed on the AUTHENTICATED side
 * (dashboard), so 10^6 codes plus a lockout is enough; the poll secret stops
 * a bystander who saw the code from collecting the token.
 */
import { createHash, randomBytes as nodeRandomBytes, randomInt as nodeRandomInt, timingSafeEqual } from "node:crypto";

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const PICKUP_GRACE_MS = 2 * 60 * 1000;
export const MAX_PENDING = 3;
export const START_LIMIT_PER_MIN = 5;
export const LOCK_AFTER = 5;
export const LOCK_WINDOW_MS = 10 * 60 * 1000;
export const LOCK_MS = 10 * 60 * 1000;

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
function sameHex(a, b) {
  const x = Buffer.from(String(a), "hex"); const y = Buffer.from(String(b), "hex");
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export function createPairingStore({ now = Date.now, randomInt = nodeRandomInt, randomBytes = nodeRandomBytes } = {}) {
  const pending = new Map();
  const startHits = new Map();
  let wrong = [];
  let lockedUntil = 0;

  function sweep() {
    const t = now();
    for (const [id, p] of pending) if (p.expires <= t) pending.delete(id);
    for (const [ip, hits] of startHits) { const keep = hits.filter((x) => t - x < 60_000); if (keep.length) startHits.set(ip, keep); else startHits.delete(ip); }
  }

  function start({ ip, ua, login, nameHint }) {
    sweep();
    const t = now();
    // Rate-limit key: the Serve-asserted Tailscale identity when present (a direct
    // LAN/tailnet client could forge X-Forwarded-For and so req.ip — review m3), else the IP.
    const key = String(login || ip || "?");
    const hits = startHits.get(key) || [];
    if (hits.length >= START_LIMIT_PER_MIN) return { error: "rate_limited", status: 429 };
    hits.push(t);
    startHits.set(key, hits);
    if (pending.size >= MAX_PENDING) return { error: "too_many_pending", status: 429 };
    let code;
    for (let i = 0; i < 20; i++) {
      code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (![...pending.values()].some((p) => p.code === code)) break;
    }
    const pair_id = randomBytes(16).toString("hex");
    const poll_secret = randomBytes(32).toString("hex");
    pending.set(pair_id, {
      pair_id, code, pollHash: sha(poll_secret), ip: String(ip || "?"),
      ua: String(ua || "").slice(0, 200), login: login ? String(login).slice(0, 128) : null,
      name_hint: String(nameHint || "").slice(0, 64),
      created: t, expires: t + PAIR_TTL_MS, claimed: false, result: null,
    });
    return { pair_id, code, poll_secret, expires_in_s: PAIR_TTL_MS / 1000 };
  }

  function listPending() {
    sweep();
    return [...pending.values()].filter((p) => !p.result)
      .map(({ pair_id, ip, ua, login, name_hint, created, expires }) => ({ pair_id, ip, ua, login, name_hint, created, expires }));
  }

  function claim(code) {
    const t = now();
    if (t < lockedUntil) return { error: "locked", status: 429, retry_after_s: Math.ceil((lockedUntil - t) / 1000) };
    sweep();
    const c = String(code || "").replace(/\s+/g, "");
    const p = /^\d{6}$/.test(c) ? [...pending.values()].find((x) => x.code === c && !x.claimed && !x.result) : null;
    if (!p) {
      wrong = wrong.filter((x) => t - x < LOCK_WINDOW_MS);
      wrong.push(t);
      if (wrong.length >= LOCK_AFTER) { lockedUntil = t + LOCK_MS; wrong = []; }
      return { error: "bad_code", status: 400 };
    }
    p.claimed = true;
    return { pending: { pair_id: p.pair_id, ip: p.ip, ua: p.ua, login: p.login, name_hint: p.name_hint } };
  }

  function complete(pair_id, { device_id, token }) {
    const p = pending.get(pair_id);
    if (!p) return false;
    p.result = { device_id, token };
    p.expires = Math.max(p.expires, now() + PICKUP_GRACE_MS);
    return true;
  }

  function release(pair_id) { const p = pending.get(pair_id); if (p && !p.result) p.claimed = false; }

  function status(pair_id, pollSecret) {
    sweep();
    const p = pending.get(String(pair_id || ""));
    if (!p) return { status: 404, body: { state: "gone" } };
    if (!pollSecret || !sameHex(sha(pollSecret), p.pollHash)) return { status: 403, body: { error: "bad_poll_secret" } };
    if (!p.result) return { status: 200, body: { state: "pending" } };
    pending.delete(p.pair_id);
    return { status: 200, body: { state: "approved", device_id: p.result.device_id, token: p.result.token } };
  }

  return { start, listPending, claim, complete, release, status };
}
```

- [ ] **Step 4: Append the announce-token helpers to `servers/gateway/local-token.js`**

Put them after `PHONE_TOKEN_KEYS`. They have the same shape as the phone token. **They are not wired into `validateLocalToken`.** The kiosk's `/api/kiosk/internal/*` routes are the token's only consumer (ruling R9).

```js
// Kiosk announce token (kiosk spec §4.1): lets the kiosk bundle's stdio MCP
// server reach the gateway's live display sessions through loopback-only
// /api/kiosk/internal/*. Same shape as the board/phone tokens (hash in a
// local-scope setting, raw value in <crowHome>/kiosk-announce-token 0600) but
// accepted NOWHERE else — validateLocalToken never consults it.
const KIOSK_ANNOUNCE_HASH_KEY = "kiosk_announce_token_hash";
const KIOSK_ANNOUNCE_CREATED_KEY = "kiosk_announce_token_created";
function kioskAnnounceTokenPath() {
  return join(crowHome(), "kiosk-announce-token");
}

export async function generateKioskAnnounceToken(db) {
  const token = randomBytes(32).toString("hex");
  await writeSetting(db, KIOSK_ANNOUNCE_HASH_KEY, sha256Hex(token), { scope: "local" });
  await writeSetting(db, KIOSK_ANNOUNCE_CREATED_KEY, new Date().toISOString(), { scope: "local" });
  const path = kioskAnnounceTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

export async function validateKioskAnnounceToken(db, token) {
  if (!token) return false;
  const stored = await readSetting(db, KIOSK_ANNOUNCE_HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function ensureKioskAnnounceToken(db) {
  const hash = await readSetting(db, KIOSK_ANNOUNCE_HASH_KEY);
  if (hash && existsSync(kioskAnnounceTokenPath())) return { minted: false };
  await generateKioskAnnounceToken(db);
  return { minted: true };
}

export const KIOSK_ANNOUNCE_TOKEN_KEYS = { HASH: KIOSK_ANNOUNCE_HASH_KEY, CREATED: KIOSK_ANNOUNCE_CREATED_KEY };
```

- [ ] **Step 5: Run them and watch them pass**

Run: `npm test -- tests/kiosk-pairing.test.js tests/kiosk-announce-token.test.js tests/board-mcp.test.js`
Expected: PASS. `board-mcp` proves `local-token.js` still behaves as before.

- [ ] **Step 6: Commit**

```bash
git add bundles/kiosk/server/pairing.js tests/kiosk-pairing.test.js tests/kiosk-announce-token.test.js
git commit bundles/kiosk/server/pairing.js servers/gateway/local-token.js tests/kiosk-pairing.test.js tests/kiosk-announce-token.test.js -m "feat(kiosk): in-memory pairing store (code + poll secret, limits, lockout, one-time pickup); kiosk announce token"
```

---

### Task 8: Kiosk `crow_wm` (server-side windows, timers, tool from caps, fast paths)

**Files:**
- Create: `bundles/kiosk/server/wm.js`
- Test: `tests/kiosk-wm.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `KIOSK_WINDOW_KINDS`, `IDLE_CLOSE_MS`;
  - `normalizeCaps(raw)`;
  - `parseDuration(text) → {seconds, before, after}|null`;
  - `parseKioskCommand(command) → {op, …}`;
  - `contentBlocks(title, body) → Block[]`;
  - `createWmStore({now, setTimer, clearTimer, onTimerDone, maxWindows}) → { list(dev), open(dev, win) → {window, evicted[]}, close(dev, id) → win|null, closeKind(dev, kind, name?) → win|null, closeAll(dev) → win[], focus(dev, id), step(dev, delta) → recipe|null, focused(dev), sweepIdle(dev) → win[], describe(dev) → string }`;
  - `createWmTool({store, deviceId, caps, emit}) → {definition, execute(args) → Promise<string>}`;
  - `matchWmFastPath(transcript, store, deviceId, caps?) → {say, events}|null` (controls + timer open);
  - `kioskPromptSuffix() → string` (static) and `kioskTurnContext(store, deviceId) → string` (live, per turn).

  Window shapes:
  - `{id, kind:"timer", title, name, ends_at, done, opened_at, touched_at}`
  - `{id, kind:"recipe", title, ingredients[], steps[], step, …}`
  - `{id, kind:"content", title, blocks[], …}`

  `wm` events (sink/emit):
  - `{type:"wm", action:"open", window}`
  - `{type:"wm", action:"close", id}`
  - `{type:"wm", action:"close_all"}`
  - `{type:"wm", action:"update", window}`
  - `{type:"wm", action:"focus", id}`
  - `{type:"wm", action:"timer_done", id}`
  - `{type:"wm", action:"snapshot", windows}`

- [ ] **Step 1: Write the failing test**

`tests/kiosk-wm.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as W from "../bundles/kiosk/server/wm.js";

function fakeTimers() {
  let t = 0; const q = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, live: true }; q.push(h); return h; },
    clearTimer: (h) => { if (h) h.live = false; },
    advance(ms) { t += ms; for (const h of q) if (h.live && h.at <= t) { h.live = false; h.fn(); } },
  };
}
function setup(caps) {
  const ft = fakeTimers(); const done = []; const emitted = [];
  const store = W.createWmStore({ ...ft, onTimerDone: (dev, w) => done.push(w) });
  const tool = W.createWmTool({ store, deviceId: "k", caps, emit: (e) => emitted.push(e) });
  return { ft, done, emitted, store, tool, run: async (command) => JSON.parse(await tool.execute({ command })) };
}

test("parseDuration: digits, units, words, an/a, combined; rejects nothing-found", () => {
  assert.equal(W.parseDuration("2 minutes tea").seconds, 120);
  assert.equal(W.parseDuration("1 hour 5 min").seconds, 3900);
  assert.equal(W.parseDuration("90s").seconds, 90);
  assert.equal(W.parseDuration("an hour").seconds, 3600);
  assert.equal(W.parseDuration("ten minutes").seconds, 600);
  assert.equal(W.parseDuration("half an hour").seconds, 1800);
  assert.equal(W.parseDuration("2 minutes called tea").after, "called tea");
  assert.equal(W.parseDuration("tea"), null);
});

test("timer: opens, fires onTimerDone at its end, stays (done) until closed; named stop works", async () => {
  const s = setup();
  const r = await s.run("set a timer for 2 minutes called tea");
  assert.equal(r.ok, true);
  const open = s.emitted.find((e) => e.action === "open");
  assert.equal(open.window.kind, "timer"); assert.equal(open.window.name, "Tea"); assert.equal(open.window.ends_at, 120_000);
  s.ft.advance(119_999); assert.equal(s.done.length, 0);
  s.ft.advance(1); assert.equal(s.done.length, 1); assert.equal(s.done[0].name, "Tea");
  assert.equal(s.store.list("k")[0].done, true);
  await s.run("timer 5 minutes pasta");
  assert.equal((await s.run("stop timer pasta")).ok, true);
  assert.deepEqual(s.store.list("k").map((w) => w.name), ["Tea"]);
});

test("timer bounds and missing duration are errors, not windows", async () => {
  const s = setup();
  assert.equal((await s.run("timer tea")).action, "error");
  assert.equal((await s.run("timer 30 hours")).action, "error");
  assert.equal(s.emitted.length, 0);
});

test("recipe + step navigation; content blocks match the display grammar", async () => {
  const s = setup();
  await s.run("recipe Lasagna | noodles; sauce; cheese | Boil noodles || 2. Layer sauce || Bake 45 minutes");
  const w = s.store.list("k")[0];
  assert.deepEqual(w.ingredients, ["noodles", "sauce", "cheese"]);
  assert.deepEqual(w.steps, ["Boil noodles", "Layer sauce", "Bake 45 minutes"]);
  assert.equal(W.matchWmFastPath("Next step.", s.store, "k").say, "Step 2. Layer sauce");
  assert.equal(W.matchWmFastPath("read the step", s.store, "k").say, "Step 2. Layer sauce");
  assert.equal(W.matchWmFastPath("go back", s.store, "k").say, "Step 1. Boil noodles");
  assert.deepEqual(W.contentBlocks("T", "Intro||- a\n- b"), [{ type: "heading", text: "T" }, { type: "text", text: "Intro" }, { type: "list", items: ["a", "b"] }]);
});

test("side-effect and desktop commands are refused WITHOUT running (ruling R3)", async () => {
  const s = setup();
  for (const c of ["invite Alice", "memo Bob hello", "react Bob 👍", "relay colibri lights", "search news", "open youtube cats", "open browser https://x.y", "open pet", "save workspace a"]) {
    const r = await s.run(c);
    assert.equal(r.action, "error", c);
  }
  assert.equal(s.emitted.length, 0);
});

test("caps filter both the tool description and execution", async () => {
  const s = setup({ windows: ["timer"] });
  assert.match(s.tool.definition.description, /timer/);
  assert.doesNotMatch(s.tool.definition.description, /recipe/);
  assert.equal((await s.run("recipe X | a | b")).action, "error");
  assert.deepEqual(W.normalizeCaps({ windows: ["timer", "youtube", "camera"], iframe: true, max_windows: 9 }), { windows: ["timer"], iframe: false, max_windows: 4 });
});

test("fast paths: only when the target exists; close/close-all/stop timer", async () => {
  const s = setup();
  assert.equal(W.matchWmFastPath("close", s.store, "k"), null);
  await s.run("display Notes | hello");
  await s.run("timer 1 minute tea");
  const fp = W.matchWmFastPath("Hey Crow, close the timer, please", s.store, "k");
  assert.equal(fp.say, "Timer stopped.");
  assert.equal(fp.events[0].action, "close");
  assert.equal(W.matchWmFastPath("close", s.store, "k").say, "Closed.");
  assert.equal(W.matchWmFastPath("what is a close call", s.store, "k"), null);
});

test("timer fast path: a spoken 'set a timer' opens it with no LLM; caps respected", () => {
  const s = setup();
  const fp = W.matchWmFastPath("Set a timer for 2 minutes called tea.", s.store, "k");
  assert.equal(fp.say, "Timer set for Tea: 2 minutes.");
  assert.equal(fp.events.at(-1).action, "open");
  assert.equal(s.store.list("k")[0].ends_at, 120_000);
  assert.equal(W.matchWmFastPath("start a timer for an hour", s.store, "k").say, "Timer set: 1 hour.");
  assert.equal(W.matchWmFastPath("set a timer for 2 minutes", s.store, "k", { windows: ["recipe"] }), null);
  assert.equal(W.matchWmFastPath("how long is a timer", s.store, "k"), null);
});

test("at most 4 windows: the oldest non-timer is evicted and a close is emitted", async () => {
  const s = setup();
  await s.run("timer 9 minutes a");
  for (const n of [1, 2, 3, 4]) await s.run(`display N${n} | x`);
  const kinds = s.store.list("k").map((w) => w.title);
  assert.equal(kinds.length, 4);
  assert.ok(!kinds.includes("N1"));
  assert.ok(s.emitted.some((e) => e.action === "close"));
});

test("idle sweep closes untouched non-timer windows after 10 min; prompt suffix lists windows within budget", async () => {
  const s = setup();
  await s.run("timer 30 minutes pasta");
  await s.run("display Notes | hi");
  s.ft.advance(W.IDLE_CLOSE_MS);
  assert.deepEqual(s.store.sweepIdle("k").map((w) => w.title), ["Notes"]);
  assert.match(W.kioskTurnContext(s.store, "k"), /^\[Display\] Open windows: timer 'Pasta' 20:00 left\.$/);
  const p = W.kioskPromptSuffix();
  assert.ok(p.length <= 1200, `suffix ${p.length} chars`);
  assert.equal(p, W.kioskPromptSuffix(), "static");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/kiosk-wm.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `bundles/kiosk/server/wm.js`**

```js
/**
 * Kiosk crow_wm (spec §8, rulings R3/R4). Same tool name, same single
 * `command` string, same JSON action shape as servers/wm/server.js — but a
 * kiosk-native executor: it implements the display subset and REFUSES every
 * other command without running it (invite/memo/react/relay/search/open … have
 * side effects a shared household display must not trigger). Window state is
 * per device, held here so it survives a page reload and is visible to the model.
 */
export const KIOSK_WINDOW_KINDS = Object.freeze(["timer", "recipe", "content"]);
export const IDLE_CLOSE_MS = 10 * 60 * 1000;
export const MAX_TIMER_S = 24 * 3600;
const MAX_TEXT = 4000;

export function normalizeCaps(raw) {
  const asked = Array.isArray(raw?.windows) ? raw.windows.filter((k) => KIOSK_WINDOW_KINDS.includes(k)) : [];
  const max = Number.isInteger(raw?.max_windows) ? Math.min(4, Math.max(1, raw.max_windows)) : 4;
  return { windows: asked.length ? [...new Set(asked)] : [...KIOSK_WINDOW_KINDS], iframe: false, max_windows: max };
}

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, sixty: 60, ninety: 90 };
const UNIT_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;

export function parseDuration(input) {
  let s = String(input || "").toLowerCase();
  s = s.replace(/\bhalf an hour\b/g, "30 minutes")
    .replace(/\b(?:an?|one)\s+(hour|minute|min|second|sec)\b/g, "1 $1")
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|sixty|ninety)\b/g, (w) => String(WORDS[w]));
  let total = 0, first = -1, last = -1, m;
  UNIT_RE.lastIndex = 0;
  while ((m = UNIT_RE.exec(s))) {
    if (last >= 0 && s.slice(last, m.index).replace(/\band\b|,/g, "").trim() !== "") break;
    if (first < 0) first = m.index;
    const n = parseFloat(m[1]);
    const u = m[2][0];
    total += u === "h" ? n * 3600 : u === "m" ? n * 60 : n;
    last = m.index + m[0].length;
  }
  if (first < 0) return null;
  return { seconds: Math.round(total), before: s.slice(0, first).trim(), after: s.slice(last).trim() };
}

export function contentBlocks(title, body) {
  const blocks = [{ type: "heading", text: String(title).slice(0, 80) }];
  for (const para of String(body).slice(0, MAX_TEXT).split("||").map((p) => p.trim()).filter(Boolean)) {
    const lines = para.split("\n").map((l) => l.trim()).filter(Boolean);
    const items = lines.filter((l) => l.startsWith("- "));
    if (items.length && items.length === lines.length) blocks.push({ type: "list", items: items.map((l) => l.slice(2)) });
    else blocks.push({ type: "text", text: para });
  }
  return blocks;
}

const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const USAGE = "Not available on this display. Use: timer <duration> <name>, stop timer [name], recipe <title> | <ingredients> | <steps>, display <title> | <text>, close, close all, next step.";

export function parseKioskCommand(command) {
  const raw = String(command || "").trim();
  const c = raw.toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  if (!c) return { op: "error", message: USAGE };
  if (/^close (all|everything)( windows)?$|^clear (the )?screen$/.test(c)) return { op: "close_all" };
  let m = c.match(/^(?:stop|cancel|dismiss|clear|close) (?:the )?timer(?: (?:for |called |named )?(.+))?$/);
  if (m) return { op: "close", kind: "timer", name: m[1] || null };
  m = c.match(/^close(?: (?:the )?(window|recipe|content|it|this|that))?$/);
  if (m) return { op: "close", kind: m[1] === "recipe" || m[1] === "content" ? m[1] : null, name: null };
  if (/^(next|next step)$/.test(c)) return { op: "step", delta: 1 };
  if (/^(previous|previous step|back|go back|last step)$/.test(c)) return { op: "step", delta: -1 };
  if (/^(read|repeat) (the )?step$|^what'?s the step$/.test(c)) return { op: "step", delta: 0 };
  m = raw.match(/^(?:(?:set|start)\s+(?:a\s+|an\s+)?)?timer\s+(?:for\s+)?([\s\S]+)$/i);
  if (m) {
    const d = parseDuration(m[1]);
    if (!d || d.seconds < 1 || d.seconds > MAX_TIMER_S) return { op: "error", message: "Say how long, from 1 second to 24 hours, e.g. timer 10 minutes pasta." };
    const name = cap1((d.after || d.before).replace(/^(called|named|labell?ed|for)\s+/, "").replace(/^["'“”]+|["'“”.]+$/g, "").trim().slice(0, 40)) || "Timer";
    return { op: "open", window: { kind: "timer", name, title: name, seconds: d.seconds } };
  }
  m = raw.match(/^recipe\s+([\s\S]+)$/i);
  if (m) {
    const parts = m[1].split(/\s+\|\s+/);
    const title = (parts[0] || "").trim().slice(0, 80);
    const ingredients = (parts[1] || "").split(/;|\n/).map((x) => x.trim()).filter(Boolean).slice(0, 40);
    const steps = parts.slice(2).join(" | ").split(/\|\||\n/).map((x) => x.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean).slice(0, 40);
    if (!title || !steps.length) return { op: "error", message: "Use: recipe <title> | <ingredient>; <ingredient> | <step> || <step>" };
    return { op: "open", window: { kind: "recipe", title, ingredients, steps, step: 0 } };
  }
  m = raw.match(/^(?:display|show results|show info)\s+([\s\S]+)$/i);
  if (m) {
    const body = m[1];
    const i = body.indexOf(" | ");
    const title = (i > 0 ? body.slice(0, i) : "Info").trim().slice(0, 80);
    return { op: "open", window: { kind: "content", title, blocks: contentBlocks(title, i > 0 ? body.slice(i + 3) : body) } };
  }
  return { op: "error", message: USAGE };
}

function fmtLeft(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

export function createWmStore({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onTimerDone = () => {}, maxWindows = 4 } = {}) {
  const devs = new Map();
  const timers = new Map();
  const dev = (id) => { let d = devs.get(id); if (!d) { d = { windows: [], seq: 0 }; devs.set(id, d); } return d; };
  const copy = (w) => (w ? JSON.parse(JSON.stringify(w)) : null);

  function remove(id, winId) {
    const d = dev(id);
    const i = d.windows.findIndex((w) => w.id === winId);
    if (i < 0) return null;
    const [w] = d.windows.splice(i, 1);
    const h = timers.get(winId);
    if (h) { clearTimer(h); timers.delete(winId); }
    return w;
  }
  function fire(id, winId) {
    timers.delete(winId);
    const w = dev(id).windows.find((x) => x.id === winId);
    if (!w) return;
    w.done = true;
    onTimerDone(id, copy(w));
  }
  return {
    list: (id) => dev(id).windows.map(copy),
    focused: (id) => copy(dev(id).windows.at(-1)),
    open(id, spec) {
      const d = dev(id);
      const t = now();
      const evicted = [];
      while (d.windows.length >= maxWindows) {
        const victim = d.windows.find((w) => w.kind !== "timer") || d.windows[0];
        evicted.push(remove(id, victim.id));
      }
      const { seconds, ...rest } = spec;
      const w = { ...rest, id: `${spec.kind}-${++d.seq}`, opened_at: t, touched_at: t };
      if (spec.kind === "timer") { w.ends_at = t + seconds * 1000; w.done = false; }
      d.windows.push(w);
      if (w.kind === "timer") timers.set(w.id, setTimer(() => fire(id, w.id), Math.max(0, w.ends_at - t)));
      return { window: copy(w), evicted: evicted.filter(Boolean).map(copy) };
    },
    close: (id, winId) => copy(remove(id, winId)),
    closeKind(id, kind, name) {
      const ws = dev(id).windows.filter((w) => !kind || w.kind === kind);
      let w = ws.at(-1) || null;
      if (name) { const n = String(name).toLowerCase(); w = ws.find((x) => (x.name || x.title || "").toLowerCase() === n) || ws.find((x) => (x.title || "").toLowerCase().includes(n)) || null; }
      return w ? copy(remove(id, w.id)) : null;
    },
    closeAll(id) { return [...dev(id).windows].map((w) => copy(remove(id, w.id))); },
    focus(id, winId) {
      const d = dev(id);
      const i = d.windows.findIndex((w) => w.id === winId);
      if (i < 0) return null;
      const [w] = d.windows.splice(i, 1);
      w.touched_at = now();
      d.windows.push(w);
      return copy(w);
    },
    step(id, delta) {
      const r = dev(id).windows.filter((w) => w.kind === "recipe").at(-1);
      if (!r) return null;
      r.step = Math.max(0, Math.min(r.steps.length - 1, r.step + delta));
      r.touched_at = now();
      return copy(r);
    },
    sweepIdle(id) {
      const t = now();
      return dev(id).windows.filter((w) => w.kind !== "timer" && t - w.touched_at >= IDLE_CLOSE_MS).map((w) => copy(remove(id, w.id)));
    },
    describe(id) {
      const ws = dev(id).windows;
      if (!ws.length) return "Open windows: none.";
      return "Open windows: " + ws.map((w) => (w.kind === "timer" ? `timer '${w.name}' ${w.done ? "done" : fmtLeft(w.ends_at - now()) + " left"}`
        : w.kind === "recipe" ? `recipe '${w.title}' step ${w.step + 1} of ${w.steps.length}` : `${w.kind} '${w.title}'`)).join("; ") + ".";
    },
  };
}

const COMMAND_HELP = {
  timer: "- timer <duration> <name> — e.g. timer 10 minutes pasta\n- stop timer [name]",
  recipe: "- recipe <title> | <ingredient>; <ingredient> | <step> || <step>\n- next step / previous step / read step",
  content: "- display <title> | <text> — || starts a paragraph; lines starting '- ' become a list",
};

export function createWmTool({ store, deviceId, caps, emit }) {
  const c = normalizeCaps(caps);
  const lines = c.windows.map((k) => COMMAND_HELP[k]).join("\n");
  const closes = ["close", ...c.windows.filter((k) => k !== "content").map((k) => `close ${k}`), "close all"].join(" / ");
  const definition = {
    name: "crow_wm",
    description: `Show things on this display. Call it only when someone asks to see, time or follow something — never for ordinary questions.\nCommands:\n${lines}\n- ${closes}`,
    inputSchema: { type: "object", properties: { command: { type: "string", description: "One command from the list, e.g. timer 10 minutes pasta" } }, required: ["command"] },
  };
  async function execute(args) {
    const cmd = parseKioskCommand(String(args?.command || ""));
    if (cmd.op === "error") return JSON.stringify({ action: "error", message: cmd.message });
    if (cmd.op === "open") {
      if (!c.windows.includes(cmd.window.kind)) return JSON.stringify({ action: "error", message: `This display can't show a ${cmd.window.kind} window.` });
      const { window, evicted } = store.open(deviceId, cmd.window);
      for (const e of evicted) emit({ type: "wm", action: "close", id: e.id });
      emit({ type: "wm", action: "open", window });
      return JSON.stringify({ ok: true, action: "open", kind: window.kind, title: window.title });
    }
    const fp = applyControl(cmd, store, deviceId);
    if (!fp) return JSON.stringify({ action: "error", message: "Nothing like that is open." });
    for (const e of fp.events) emit(e);
    return JSON.stringify({ ok: true, action: cmd.op, say: fp.say });
  }
  return { definition, execute };
}

function applyControl(cmd, store, deviceId) {
  if (cmd.op === "close_all") {
    const closed = store.closeAll(deviceId);
    return closed.length ? { say: "All clear.", events: [{ type: "wm", action: "close_all" }] } : null;
  }
  if (cmd.op === "close") {
    const w = store.closeKind(deviceId, cmd.kind, cmd.name);
    return w ? { say: w.kind === "timer" ? "Timer stopped." : "Closed.", events: [{ type: "wm", action: "close", id: w.id }] } : null;
  }
  if (cmd.op === "step") {
    const r = store.step(deviceId, cmd.delta);
    return r ? { say: `Step ${r.step + 1}. ${r.steps[r.step]}`, events: [{ type: "wm", action: "update", window: r }] } : null;
  }
  return null;
}

function normalizeUtterance(t) {
  return String(t || "").toLowerCase()
    .replace(/[“”"',.!?;:]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(hey crow|ok crow|okay crow|ok|okay|please)\s+/, "")
    .replace(/\s+(please|thanks|thank you)$/, "")
    .trim();
}

function spokenDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const part = (n, u) => (n ? `${n} ${u}${n === 1 ? "" : "s"}` : "");
  return [part(h, "hour"), part(m, "minute"), part(s, "second")].filter(Boolean).join(" ");
}

/**
 * No-LLM fast paths (spec §8.6): controls only when the target exists, plus
 * "set/start a timer for <duration> [called <name>]" (review M8: "set a timer"
 * matches no TOOL_INTENT_RE word, so without this the 4B must emit a tool call).
 */
export function matchWmFastPath(transcript, store, deviceId, caps) {
  const cmd = parseKioskCommand(normalizeUtterance(transcript));
  if (cmd.op === "open" && cmd.window.kind === "timer" && normalizeCaps(caps).windows.includes("timer")) {
    const { window, evicted } = store.open(deviceId, cmd.window);
    return {
      say: `Timer set${window.name !== "Timer" ? ` for ${window.name}` : ""}: ${spokenDuration(cmd.window.seconds)}.`,
      events: [...evicted.map((e) => ({ type: "wm", action: "close", id: e.id })), { type: "wm", action: "open", window }],
    };
  }
  if (!["close", "close_all", "step"].includes(cmd.op)) return null;
  return applyControl(cmd, store, deviceId);
}

/** Static (byte-stable, prefix-cacheable) kiosk instructions for the system message. */
export function kioskPromptSuffix() {
  return [
    "You are speaking through a shared home display to whoever is in the room. Reply in one to three short spoken sentences of plain prose: no markdown, no lists, no emoji.",
    "Use the crow_wm tool only when someone asks to see, time or follow something (a timer, a recipe, something to read); never for ordinary questions.",
  ].join("\n");
}

/** Live display state for THIS turn's user message (never the system message — review M6). */
export function kioskTurnContext(store, deviceId) {
  return `[Display] ${store.describe(deviceId)}`;
}
```

Two notes on the tests. In "close the timer, please", `normalizeUtterance` strips the punctuation and the trailing "please". In "Next step." the period goes, and `parseKioskCommand` sees `next step`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- tests/kiosk-wm.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bundles/kiosk/server/wm.js tests/kiosk-wm.test.js
git commit bundles/kiosk/server/wm.js tests/kiosk-wm.test.js -m "feat(kiosk): crow_wm v2 executor — server-held windows/timers, caps-filtered tool, no-LLM fast paths, side-effect commands refused"
```

---
### Task 9: Session protocol (`hello` auth, turns, barge-in, supersede, metrics)

**Files:**
- Create: `bundles/kiosk/server/session.js`, `bundles/kiosk/server/metrics.js`
- Test: `tests/kiosk-session.test.js`

**Interfaces:**
- Consumes:
  - Task 8: `normalizeCaps`, a `WmStore`.
  - Task 3: `wrapPcmAsWav`, injected.
  - Task 4 (injected as functions): `runTurn({device, audio, sink, signal, caps}) → TurnResult` and `speak({device, text, sink}) → Promise`.
- Produces:
  - `createMetricsStore({max}) → { serverTurn(dev, turnId, result), clientTurn(dev, m), list(dev), summary(dev) → {n, median_ms, p90_ms} }` and `sanitizeClientMetrics(m)`.
  - `createSessionHub(deps) → { attach(ws), closeDevice(id, code, reason), sendTo(id, obj) → bool, speak(id, text) → bool, refreshDevice(id, device), isConnected(id), connectedIds() }`.
  - Constants `HELLO_TIMEOUT_MS = 5000`, `MAX_TURN_BYTES = 1048576`, `MIN_TURN_BYTES = 6400` (200 ms).
- Protocol (spec §4.5), close codes:
  - `4401 "hello_timeout"`: the page keeps its token.
  - `4401 "unauthorized"` / `4401 "unpaired"`: the page drops its token.
  - `4000 "superseded"`: the page halts.

- [ ] **Step 1: Write the failing test**

`tests/kiosk-session.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSessionHub, HELLO_TIMEOUT_MS, MAX_TURN_BYTES } from "../bundles/kiosk/server/session.js";
import { createMetricsStore } from "../bundles/kiosk/server/metrics.js";
import { createWmStore } from "../bundles/kiosk/server/wm.js";
import { wrapPcmAsWav } from "../servers/gateway/voice/turn-helpers.js";

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; this.closed = null; }
  send(d) { this.sent.push(d); }
  close(code, reason) { if (this.closed) return; this.closed = { code, reason }; this.readyState = 3; this.emit("close"); }
  text(o) { this.emit("message", Buffer.from(JSON.stringify(o)), false); }
  bin(b) { this.emit("message", b, true); }
  msgs() { return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d)); }
}
const tick = () => new Promise((r) => setImmediate(r));
const DEV = { id: "kiosk-a", name: "Kitchen", device_kind: "kiosk", bound_bot_id: "household", kiosk_settings: { lang: "en" } };

function hub(over = {}) {
  const timers = [];
  const turns = [];
  const metrics = createMetricsStore();
  const logs = [];
  const wm = createWmStore({ setTimer: () => ({}), clearTimer: () => {} }); // no real timers: a 120 s timer would hold the test process open
  const h = createSessionHub({
    verifyKiosk: async (id, tok) => (id === "kiosk-a" && tok === "good" ? { ...DEV } : null),
    displayConfig: async (d) => ({ name: d.name, bird: { species: "crow", seed: 0, mood: "happy" } }),
    runTurn: over.runTurn || (async (o) => { turns.push(o); o.sink.event({ type: "transcript_final", text: "hi" }); o.sink.event({ type: "tts_start", codec: "pcm", sample_rate: 24000 }); o.sink.audio(Buffer.alloc(4)); o.sink.event({ type: "tts_end" }); return { route: "fast", fastPath: false, escalated: false, aborted: false, degraded: null, timings: { total_ms: 5 } }; }),
    speak: over.speak || (async ({ text, sink }) => { sink.event({ type: "tts_start", codec: "pcm", sample_rate: 24000 }); sink.audio(Buffer.from(text)); sink.event({ type: "tts_end" }); }),
    wm, metrics, wrapPcmAsWav,
    warmup: over.warmup || (async () => {}),
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    now: () => 42,
    log: (l) => logs.push(l),
  });
  return { h, timers, turns, metrics, wm, logs };
}
async function hello(h, ws = new FakeWs()) { h.attach(ws); ws.text({ type: "hello", device_id: "kiosk-a", token: "good", caps: { windows: ["timer", "recipe", "content"] } }); await tick(); return ws; }

test("no hello within 5 s → 4401 hello_timeout", () => {
  const { h, timers } = hub(); const ws = new FakeWs(); h.attach(ws);
  assert.equal(timers[0].ms, HELLO_TIMEOUT_MS);
  timers[0].fn();
  assert.deepEqual(ws.closed, { code: 4401, reason: "hello_timeout" });
});

test("bad token, wrong first frame, or binary before hello → 4401 unauthorized", async () => {
  for (const first of [{ type: "hello", device_id: "kiosk-a", token: "bad" }, { type: "turn_start" }]) {
    const { h } = hub(); const ws = new FakeWs(); h.attach(ws); ws.text(first); await tick();
    assert.deepEqual(ws.closed, { code: 4401, reason: "unauthorized" });
  }
  const { h } = hub(); const ws = new FakeWs(); h.attach(ws); ws.bin(Buffer.alloc(640));
  assert.deepEqual(ws.closed, { code: 4401, reason: "unauthorized" });
});

test("hello → ready (display_config, server_now), wm snapshot, idle; warm-up kicked", async () => {
  let warmed = 0;
  const { h, timers } = hub({ warmup: async () => { warmed++; } });
  const ws = await hello(h);
  const types = ws.msgs().map((m) => m.type);
  assert.deepEqual(types, ["ready", "wm", "state"]);
  assert.equal(ws.msgs()[0].server_now, 42);
  assert.equal(ws.msgs()[1].action, "snapshot");
  assert.equal(timers[0].cleared, true);
  assert.equal(warmed, 1);
  assert.equal(h.isConnected("kiosk-a"), true);
});

test("a turn: frames → one WAV of exactly those frames → events + audio → turn_done → idle", async () => {
  const { h, turns, metrics, logs } = hub();
  const ws = await hello(h);
  ws.text({ type: "turn_start", source: "tap", turn_id: "t1" });
  const f = Buffer.alloc(640, 7);
  for (let i = 0; i < 20; i++) ws.bin(f);
  ws.text({ type: "turn_end", vad_reason: "silence" });
  await tick(); await tick();
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].audio, wrapPcmAsWav(Buffer.concat(Array(20).fill(f)), 16000));
  const m = ws.msgs();
  assert.deepEqual(m.filter((x) => x.type === "state").map((x) => x.bird), ["idle", "listening", "thinking", "speaking", "idle"]);
  assert.equal(m.find((x) => x.type === "turn_done").turn_id, "t1");
  assert.equal(ws.sent.filter((d) => Buffer.isBuffer(d)).length, 1);
  ws.text({ type: "turn_metrics", turn_id: "t1", e2e_ms: 1500, vad_reason: "silence", output_latency_ms: 20 });
  assert.equal(metrics.list("kiosk-a")[0].e2e_ms, 1500);
  const line = logs.find((l) => l.startsWith("[kiosk-metrics] "));
  assert.ok(line.includes('"e2e_ms":1500') && line.includes('"route":"fast"'), line);
  assert.equal(metrics.summary("kiosk-a").n, 1);
});

test("over 1 MiB of audio → audio_too_long, no turn; under 200 ms → empty_transcript, no turn", async () => {
  const { h, turns } = hub();
  const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "t2" });
  for (let i = 0; i <= MAX_TURN_BYTES / 65536; i++) ws.bin(Buffer.alloc(65536));
  ws.text({ type: "turn_end" });
  await tick();
  assert.ok(ws.msgs().some((m) => m.type === "error" && m.code === "audio_too_long"));
  ws.text({ type: "turn_start", turn_id: "t3" }); ws.bin(Buffer.alloc(640)); ws.text({ type: "turn_end" }); await tick();
  assert.ok(ws.msgs().some((m) => m.type === "error" && m.code === "empty_transcript"));
  assert.equal(turns.length, 0);
});

test("busy: a second turn_start during a turn → turn_busy; barge_in aborts and later audio is dropped", async () => {
  let release;
  const { h } = hub({ runTurn: (o) => new Promise((r) => { release = () => { o.sink.audio(Buffer.alloc(8)); r({ route: "fast", aborted: o.signal.aborted, timings: {} }); }; o.signal.addEventListener("abort", () => {}); }) });
  const ws = await hello(h);
  ws.text({ type: "turn_start", turn_id: "a" }); ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" }); await tick();
  ws.text({ type: "turn_start", turn_id: "b" });
  assert.ok(ws.msgs().some((m) => m.code === "turn_busy"));
  ws.text({ type: "barge_in" });
  release(); await tick();
  assert.equal(ws.sent.filter((d) => Buffer.isBuffer(d)).length, 0, "audio after barge-in never leaves");
  assert.equal(ws.msgs().find((m) => m.type === "turn_done").aborted, true);
});

test("second hello for the same display supersedes the first with 4000", async () => {
  const { h } = hub();
  const a = await hello(h);
  const b = await hello(h);
  assert.deepEqual(a.closed, { code: 4000, reason: "superseded" });
  assert.equal(b.closed, null);
  assert.equal(h.isConnected("kiosk-a"), true, "the new session stays registered after the old one's close");
});

test("close during a turn aborts it; reconnect gets the timer in the snapshot", async () => {
  let seen;
  const { h, wm } = hub({ runTurn: (o) => new Promise((r) => { seen = o.signal; o.signal.addEventListener("abort", () => r({ route: "fast", aborted: true, timings: {} })); }) });
  wm.open("kiosk-a", { kind: "timer", name: "Tea", title: "Tea", seconds: 120 });
  const ws = await hello(h);
  ws.text({ type: "turn_start" }); ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" }); await tick();
  ws.close(1006, "");
  assert.equal(seen.aborted, true);
  const ws2 = await hello(h);
  assert.equal(ws2.msgs().find((m) => m.type === "wm").windows[0].name, "Tea");
});

test("unpair closes the live session 4401 unpaired; wm_event dismissed closes server-side", async () => {
  const { h, wm } = hub();
  const ws = await hello(h);
  const { window } = wm.open("kiosk-a", { kind: "content", title: "N", blocks: [] });
  ws.text({ type: "wm_event", id: window.id, kind: "dismissed" });
  assert.equal(wm.list("kiosk-a").length, 0);
  assert.ok(ws.msgs().some((m) => m.type === "wm" && m.action === "close" && m.id === window.id));
  wm.open("kiosk-a", { kind: "content", title: "A", blocks: [] }); wm.open("kiosk-a", { kind: "content", title: "B", blocks: [] });
  ws.text({ type: "wm_event", kind: "close_all" });
  assert.equal(wm.list("kiosk-a").length, 0, "long-press close-all");
  h.closeDevice("kiosk-a", 4401, "unpaired");
  assert.deepEqual(ws.closed, { code: 4401, reason: "unpaired" });
  assert.equal(h.isConnected("kiosk-a"), false);
});

test("speak while a turn is running is queued and played after the turn", async () => {
  let release;
  const { h } = hub({ runTurn: (o) => new Promise((r) => { release = () => r({ route: "fast", aborted: false, timings: {} }); }) });
  const ws = await hello(h);
  ws.text({ type: "turn_start" }); ws.bin(Buffer.alloc(8000)); ws.text({ type: "turn_end" }); await tick();
  assert.equal(h.speak("kiosk-a", "Tea timer is done."), true);
  assert.equal(ws.sent.filter((d) => Buffer.isBuffer(d)).length, 0);
  release(); await tick(); await tick();
  assert.equal(Buffer.concat(ws.sent.filter((d) => Buffer.isBuffer(d))).toString(), "Tea timer is done.");
});

test("metrics: median/p90 count only fast, non-fast-path, non-escalated, silence-ended, unaborted turns", () => {
  const m = createMetricsStore();
  const add = (id, e2e, r = {}) => { m.serverTurn("d", id, { route: "fast", fastPath: false, escalated: false, aborted: false, timings: {}, ...r }); m.clientTurn("d", { turn_id: id, e2e_ms: e2e, vad_reason: r.vad || "silence" }); };
  [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 3500].forEach((v, i) => add("t" + i, v));
  add("x1", 9000, { escalated: true }); add("x2", 9000, { fastPath: true }); add("x3", 9000, { vad: "max" }); add("x4", 9000, { route: "escalate" }); add("x5", 900, { degraded: "cold_timeout" });
  const s = m.summary("d");
  assert.equal(s.n, 10); assert.equal(s.median_ms, 1900); assert.equal(s.p90_ms, 2600); assert.equal(s.no_audio, 0);
  add("silent", null);
  const t = m.summary("d", { last: 20 });
  assert.equal(t.n, 11); assert.equal(t.no_audio, 1); assert.equal(t.p90_ms, 3500, "a turn with no audio counts as a failure, not a gap");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/kiosk-session.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `bundles/kiosk/server/metrics.js`**

```js
/** Per-device latency ring buffer (spec §9; ruling R8 decides which turns count toward the gate). */
const REASONS = new Set(["silence", "max", "no_speech", "manual"]);
const clampMs = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Math.max(0, Math.min(120_000, Math.round(Number(v)))) : null);

export function sanitizeClientMetrics(m) {
  return {
    turn_id: String(m?.turn_id || "").slice(0, 64),
    e2e_ms: clampMs(m?.e2e_ms),
    output_latency_ms: clampMs(m?.output_latency_ms),
    vad_reason: REASONS.has(m?.vad_reason) ? m.vad_reason : null,
    source: m?.source === "wake" || m?.source === "tap" || m?.source === "follow_up" ? m.source : null,
  };
}

export function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function createMetricsStore({ max = 100 } = {}) {
  const devs = new Map();
  function rec(dev, turnId) {
    let d = devs.get(dev);
    if (!d) { d = new Map(); devs.set(dev, d); }
    let r = d.get(turnId);
    if (!r) { r = { turn_id: turnId, at: Date.now() }; d.set(turnId, r); while (d.size > max) d.delete(d.keys().next().value); }
    return r;
  }
  return {
    serverTurn(dev, turnId, r) {
      Object.assign(rec(dev, String(turnId)), {
        route: r?.route ?? null, fast_path: !!r?.fastPath, escalated: !!r?.escalated, aborted: !!r?.aborted,
        degraded: r?.degraded ?? null, timings: r?.timings || {},
      });
    },
    clientTurn(dev, m) {
      const c = sanitizeClientMetrics(m);
      if (!c.turn_id) return null;
      return Object.assign(rec(dev, c.turn_id), { e2e_ms: c.e2e_ms, output_latency_ms: c.output_latency_ms, vad_reason: c.vad_reason, source: c.source });
    },
    list(dev) { return [...(devs.get(dev)?.values() || [])].reverse(); },
    /**
     * The gate view (ruling R8, review M5): the LAST `last` turns that exercised the
     * budgeted path — fast route, no fast path, not escalated, NOT degraded (a cold
     * fallback's first audio is the filler), not aborted, silence-ended. Such a turn
     * with no audio (e2e null) is a FAILURE, counted as Infinity, never dropped.
     */
    summary(dev, { last = 20 } = {}) {
      const ok = [...(devs.get(dev)?.values() || [])].filter((r) => r.route === "fast" && !r.fast_path && !r.escalated && !r.degraded && !r.aborted && r.vad_reason === "silence").slice(-last);
      const v = ok.map((r) => (Number.isFinite(r.e2e_ms) ? r.e2e_ms : Infinity)).sort((a, b) => a - b);
      return { n: v.length, no_audio: v.filter((x) => x === Infinity).length, median_ms: median(v), p90_ms: percentile(v, 90) };
    },
  };
}
```

- [ ] **Step 4: Implement `bundles/kiosk/server/session.js`**

```js
/**
 * Kiosk WebSocket session (spec §4.5). Transport-agnostic: `ws` is anything
 * with send/close/readyState and "message"/"close" events. The token lives
 * ONLY in the first frame (hello); the upgrade URL is never read for it.
 */
import { normalizeCaps } from "./wm.js";

export const HELLO_TIMEOUT_MS = 5000;
export const MAX_TURN_BYTES = 1024 * 1024;
export const MIN_TURN_BYTES = 6400;

export function createSessionHub(deps) {
  const sessions = new Map();
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const sendJson = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  function attach(ws) {
    let device = null;
    let authing = false;
    let caps = normalizeCaps(null);
    let inTurn = false;
    let frames = [];
    let bytes = 0;
    let turnId = null;
    let abort = null;
    let busy = false;
    const pendingSpeech = [];
    const helloTimer = setT(() => { if (!device) ws.close(4401, "hello_timeout"); }, deps.helloTimeoutMs || HELLO_TIMEOUT_MS);
    const state = (bird) => sendJson(ws, { type: "state", bird });
    const self = { ws, get device() { return device; }, get busy() { return busy; }, queueSpeech: (t) => pendingSpeech.push(t), runSpeech, abortTurn: () => abort?.abort() };

    async function runSpeech(text) {
      const sink = { event: (ev) => sendJson(ws, ev), audio: (b) => { if (ws.readyState === 1) ws.send(b); } };
      try { await deps.speak({ device, text, sink }); } catch (err) { deps.log?.(`[kiosk] speak failed: ${err.message}`); }
    }

    async function onHello(msg) {
      authing = true;
      const d = await deps.verifyKiosk(String(msg.device_id || ""), String(msg.token || ""));
      if (!d) { ws.close(4401, "unauthorized"); return; }
      if (ws.readyState !== 1) return;
      clearT(helloTimer);
      device = d;
      caps = normalizeCaps(msg.caps);
      const prior = sessions.get(d.id);
      sessions.set(d.id, self);
      if (prior && prior.ws !== ws) { try { prior.ws.close(4000, "superseded"); } catch {} }
      sendJson(ws, { type: "ready", server_now: (deps.now || Date.now)(), display_config: await deps.displayConfig(d) });
      sendJson(ws, { type: "wm", action: "snapshot", windows: deps.wm.list(d.id) });
      state("idle");
      Promise.resolve().then(() => deps.warmup(d)).catch(() => {});
    }

    async function onTurnEnd() {
      if (!inTurn) return;
      inTurn = false;
      const pcm = Buffer.concat(frames);
      frames = []; bytes = 0;
      if (pcm.length < MIN_TURN_BYTES) { sendJson(ws, { type: "error", code: "empty_transcript", recoverable: true }); state("idle"); return; }
      busy = true;
      abort = new AbortController();
      const my = abort;
      const id = turnId;
      state("thinking");
      const sink = {
        event: (ev) => {
          if (my.signal.aborted) return;
          sendJson(ws, ev);
          if (ev.type === "tts_start") state("speaking");
        },
        audio: (chunk) => { if (!my.signal.aborted && ws.readyState === 1) ws.send(chunk); },
      };
      let r = null;
      try {
        r = await deps.runTurn({ device: sessions.get(device.id)?.device || device, audio: deps.wrapPcmAsWav(pcm, 16000), sink, signal: my.signal, caps });
      } catch (err) {
        deps.log?.(`[kiosk] turn failed: ${err.message}`);
        sendJson(ws, { type: "error", code: "turn_failed", recoverable: true });
      } finally {
        busy = false;
        abort = null;
        const res = { route: r?.route ?? null, fastPath: !!r?.fastPath, escalated: !!r?.escalated, degraded: r?.degraded ?? null, aborted: my.signal.aborted || !!r?.aborted, timings: r?.timings || {} };
        deps.metrics.serverTurn(device.id, id, res);
        sendJson(ws, { type: "turn_done", turn_id: id, route: res.route, fast_path: res.fastPath, escalated: res.escalated, degraded: res.degraded, aborted: res.aborted, timings: res.timings });
        state("idle");
        while (pendingSpeech.length && ws.readyState === 1 && !busy) await runSpeech(pendingSpeech.shift());
      }
    }

    ws.on("message", (raw, isBinary) => {
      if (!device) {
        if (authing) return;
        if (isBinary) { ws.close(4401, "unauthorized"); return; }
        let msg;
        try { msg = JSON.parse(raw.toString("utf8")); } catch { ws.close(4401, "unauthorized"); return; }
        if (msg?.type !== "hello") { ws.close(4401, "unauthorized"); return; }
        onHello(msg).catch(() => ws.close(4401, "unauthorized"));
        return;
      }
      if (isBinary) {
        if (!inTurn) return;
        bytes += raw.length;
        if (bytes > MAX_TURN_BYTES) {
          inTurn = false; frames = []; bytes = 0;
          sendJson(ws, { type: "error", code: "audio_too_long", recoverable: true });
          state("idle");
          return;
        }
        frames.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      switch (msg?.type) {
        case "turn_start":
          if (busy) { sendJson(ws, { type: "error", code: "turn_busy", recoverable: true }); return; }
          inTurn = true; frames = []; bytes = 0;
          turnId = String(msg.turn_id || `t${(deps.now || Date.now)()}`).slice(0, 64);
          state("listening");
          return;
        case "turn_end":
          onTurnEnd();
          return;
        case "barge_in":
          if (abort) abort.abort();
          return;
        case "wm_event": {
          const id = String(msg.id || "");
          if (msg.kind === "dismissed") { const w = deps.wm.close(device.id, id); if (w) sendJson(ws, { type: "wm", action: "close", id: w.id }); }
          else if (msg.kind === "tapped") deps.wm.focus(device.id, id);
          else if (msg.kind === "close_all") { deps.wm.closeAll(device.id); sendJson(ws, { type: "wm", action: "close_all" }); }   // long-press (spec §8.5)
          return;
        }
        case "turn_metrics": {
          const merged = deps.metrics.clientTurn(device.id, msg);
          // One greppable line per timed turn: the smoke computes the gate from these (Task 13).
          if (merged) deps.log?.(`[kiosk-metrics] ${JSON.stringify({ device: device.id, ...merged })}`);
          return;
        }
        default:
      }
    });
    ws.on("close", () => {
      clearT(helloTimer);
      if (abort) abort.abort();
      if (device && sessions.get(device.id) === self) sessions.delete(device.id);
    });
    ws.on("error", () => {});
  }

  return {
    attach,
    closeDevice(id, code = 4401, reason = "unpaired") {
      const s = sessions.get(id);
      if (!s) return false;
      sessions.delete(id);
      try { s.ws.close(code, reason); } catch {}
      return true;
    },
    sendTo(id, obj) { const s = sessions.get(id); if (!s || s.ws.readyState !== 1) return false; s.ws.send(JSON.stringify(obj)); return true; },
    speak(id, text) {
      const s = sessions.get(id);
      if (!s || s.ws.readyState !== 1) return false;
      if (s.busy) s.queueSpeech(text); else s.runSpeech(text);
      return true;
    },
    refreshDevice(id, d) { const s = sessions.get(id); if (s && d) Object.assign(s.device, d); },
    isConnected: (id) => sessions.has(id),
    connectedIds: () => [...sessions.keys()],
  };
}
```

In the supersede test, the new session registers first and the old socket is closed afterwards. The old socket's `close` handler sees `sessions.get(id) !== self`, so it leaves the new session in place.

- [ ] **Step 5: Run it and watch it pass**

Run: `npm test -- tests/kiosk-session.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bundles/kiosk/server/session.js bundles/kiosk/server/metrics.js tests/kiosk-session.test.js
git commit bundles/kiosk/server/session.js bundles/kiosk/server/metrics.js tests/kiosk-session.test.js -m "feat(kiosk): session protocol — hello-only token, turns with 1 MiB cap, barge-in, supersede, queued speech, latency metrics"
```

---

### Task 10: Runtime (page/pair/admin/internal routes + WS upgrade), gateway glue, MCP tools, manifest, registry, network tests

**Files:**
- Create:
  - `bundles/kiosk/server/runtime.js`, `bundles/kiosk/server/bird.js`, `bundles/kiosk/server/app-root.js`;
  - `bundles/kiosk/server/server.js`, `bundles/kiosk/server/index.js`;
  - `bundles/kiosk/panel/routes.js`;
  - `bundles/kiosk/manifest.json`, `bundles/kiosk/package.json`, `bundles/kiosk/skills/kiosk.md`.
- Modify: `tests/auth-network.test.js` (append), `registry/add-ons.json` (rebuild)
- Test: `tests/kiosk-routes.test.js`

**Interfaces:**
- Consumes: Tasks 1, 4, 5, 7, 8 and 9.
- Produces:
  - `createKioskRuntime(deps) → { router(dashboardAuth), attachUpgrade(server), hub, pairing, wm, metrics, announce(target, {text, speak}), show(target, {title, body}), stop() }`;
  - `resolveDisplayBird(db, {readPortrait}) → {species, seed, mood, outfit, source}`, which consumes core `readPortrait` (`servers/sharing/profile-avatar.js`, on main since #416);
  - `kioskThemeCss(PERCH_TOKENS) → string`;
  - the MCP tools `crow_kiosk_list_displays`, `crow_kiosk_announce`, `crow_kiosk_show`.
  - Routes:

    | route | auth |
    |---|---|
    | `GET /kiosk` | isAllowedNetwork |
    | `GET /kiosk/assets/:file` | isAllowedNetwork |
    | `POST /api/kiosk/pair/start` | isAllowedNetwork |
    | `GET /api/kiosk/pair/status` | isAllowedNetwork + `X-Kiosk-Poll` |
    | `GET/POST/DELETE /api/kiosk/admin/*` | isAllowedNetwork + dashboardAuth + CSRF |
    | `GET/POST /api/kiosk/internal/*` | direct loopback + announce token |
    | WS `/api/kiosk/session` | isAllowedNetwork at upgrade, then `hello` |

`runtime.js` stays free of bare imports (`bundle-server-deps` scans `server/`). Express's `Router`/`json` and `ws`'s `WebSocketServer` are injected by `panel/routes.js`, which runs inside the gateway and resolves them from the gateway's `node_modules`. This is the meta-glasses pattern.

- [ ] **Step 1: Write the failing tests**

`tests/kiosk-routes.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { createClient } from "@libsql/client";
import * as store from "../servers/shared/device-store.js";
import { createKioskRuntime } from "../bundles/kiosk/server/runtime.js";
import { resolveDisplayBird, DEFAULT_BIRD } from "../bundles/kiosk/server/bird.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { readPortrait, portraitMood } from "../servers/sharing/profile-avatar.js";
import { wrapPcmAsWav } from "../servers/gateway/voice/turn-helpers.js";

let srv, base, rt, raw, tailnet = true, session = true;
const db = () => ({ execute: (q) => raw.execute(q), close() {} });
const settings = new Map();

before(async () => {
  raw = createClient({ url: "file::memory:" });
  await raw.execute("CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  await raw.execute("CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER)");
  await raw.execute({ sql: "INSERT INTO pi_bot_defs VALUES ('household','House','{}',1),('off','Off','{}',0)", args: [] });
  settings.set("stt_profiles", JSON.stringify([{ id: "fw", provider: "fasterwhisper", baseUrl: "http://localhost:8004/v1" }]));
  settings.set("tts_profiles", JSON.stringify([{ id: "kk", provider: "kokoro", name: "Kokoro (local)" }]));
  rt = createKioskRuntime({
    Router: express.Router, json: express.json, WebSocketServer,
    isAllowedNetwork: () => tailnet,
    csrfMiddleware: (req, res, next) => next(),
    openDb: db, deviceStore: store,
    settings: { readSetting: async (d, k) => settings.get(k) ?? null, writeSetting: async (d, k, v) => { settings.set(k, v); } },
    voice: { runVoiceTurn: async () => ({ route: "fast", timings: {} }), speakText: async () => true },
    sttWarmup: async () => {},
    resolveDisplayBird: async () => ({ species: "crow", seed: 0, mood: "happy", outfit: null, source: "default" }),
    themeCss: () => ":root{--k-sky:#eef1f3}",
    files: { publicDir: new URL("../bundles/kiosk/public/", import.meta.url).pathname, birdSvgPath: new URL("../bundles/ramble/server/bird-svg.cjs", import.meta.url).pathname },
    announceToken: { validate: async (d, t) => t === "ann-ok" },
    helloTimeoutMs: 300,
    wrapPcmAsWav,
    log: () => {},
  });
  const app = express();
  const dashboardAuth = (req, res, next) => (session ? next() : res.status(401).json({ error: "login" }));
  app.use(rt.router(dashboardAuth));
  srv = http.createServer(app);
  rt.attachUpgrade(srv);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { rt.stop(); srv.close(); });

const j = (path, opt = {}) => fetch(base + path, { ...opt, headers: { "Content-Type": "application/json", ...(opt.headers || {}) } });

test("page: strict CSP, no-store; unknown assets 404; theme + strings generated", async () => {
  const r = await fetch(base + "/kiosk");
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  for (const d of ["default-src 'self'", "script-src 'self'", "connect-src 'self' ws://127.0.0.1:8770", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(base + "/kiosk/assets/../../manifest.json")).status, 404);
  assert.equal((await fetch(base + "/kiosk/assets/nope.js")).status, 404);
  assert.match(await (await fetch(base + "/kiosk/assets/theme.css")).text(), /--k-sky/);
  assert.match(await (await fetch(base + "/kiosk/assets/strings.js")).text(), /^export const STRINGS = /);
  assert.match(await (await fetch(base + "/kiosk/assets/bird-svg.js")).text(), /window\.RambleBird/);
});

test("Funnel and off-tailnet are refused on page, pair and session", async () => {
  assert.equal((await fetch(base + "/kiosk", { headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
  assert.equal((await j("/api/kiosk/pair/start", { method: "POST", body: "{}", headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
  tailnet = false;
  try {
    assert.equal((await fetch(base + "/kiosk")).status, 403);
    const ws = new WebSocket(base.replace("http", "ws") + "/api/kiosk/session");
    const code = await new Promise((r) => { ws.on("unexpected-response", (req, res) => r(res.statusCode)); ws.on("error", () => {}); });
    assert.equal(code, 403);
  } finally { tailnet = true; }
});

test("full pairing: start → admin approve (bot required) → one-time pickup → session hello works", async () => {
  const s = await (await j("/api/kiosk/pair/start", { method: "POST", body: JSON.stringify({ name_hint: "Phone" }) })).json();
  assert.equal((await j("/api/kiosk/admin/approve", { method: "POST", body: JSON.stringify({ code: s.code, name: "Kitchen", bot_id: "off" }) })).status, 400, "disabled bot refused");
  const pend = await (await fetch(base + "/api/kiosk/admin/displays")).json();
  assert.equal(pend.pending.length, 1);
  assert.ok(!JSON.stringify(pend).includes(s.code), "code never shown in the admin listing");
  const ok = await (await j("/api/kiosk/admin/approve", { method: "POST", body: JSON.stringify({ code: s.code, name: "Kitchen", bot_id: "household" }) })).json();
  assert.equal(ok.ok, true);
  const dev = await store.findDevice(db(), ok.device_id);
  assert.equal(dev.device_kind, "kiosk"); assert.equal(dev.bound_bot_id, "household");
  assert.equal(dev.stt_profile_id, "kiosk-stt-distil-small-en"); assert.equal(dev.tts_profile_id, "kk");
  const p1 = await (await fetch(base + `/api/kiosk/pair/status?pair_id=${s.pair_id}`, { headers: { "X-Kiosk-Poll": s.poll_secret } })).json();
  assert.equal(p1.state, "approved");
  assert.equal((await fetch(base + `/api/kiosk/pair/status?pair_id=${s.pair_id}`, { headers: { "X-Kiosk-Poll": s.poll_secret } })).status, 404);

  const ws = new WebSocket(base.replace("http", "ws") + "/api/kiosk/session");
  const msgs = [];
  await new Promise((r) => ws.on("open", r));
  ws.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  ws.send(JSON.stringify({ type: "hello", device_id: p1.device_id, token: p1.token, caps: {} }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(msgs[0].type, "ready");
  assert.equal(msgs[0].display_config.bird.species, "crow");

  const closed = new Promise((r) => ws.on("close", (code, reason) => r([code, reason.toString()])));
  assert.equal((await fetch(base + `/api/kiosk/admin/displays/${p1.device_id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual(await closed, [4401, "unpaired"]);
  assert.equal(await store.findDevice(db(), p1.device_id), null);
});

test("token in the URL is ignored: no hello → 4401 hello_timeout", async () => {
  const ws = new WebSocket(base.replace("http", "ws") + "/api/kiosk/session?device_id=x&token=y");
  const [code, reason] = await new Promise((r) => ws.on("close", (c, rs) => r([c, rs.toString()])));
  assert.equal(code, 4401); assert.equal(reason, "hello_timeout");
});

test("admin requires the dashboard session", async () => {
  session = false;
  try { assert.equal((await fetch(base + "/api/kiosk/admin/displays")).status, 401); } finally { session = true; }
});

test("a kiosk token is useless anywhere but the session: admin, internal, glasses-style verify", async () => {
  const { token } = await store.pairDevice(db(), { id: "kiosk-z", name: "Z", device_kind: "kiosk" });
  session = false;
  try { assert.equal((await fetch(base + "/api/kiosk/admin/displays", { headers: { Authorization: `Bearer ${token}` } })).status, 401); } finally { session = true; }
  assert.equal((await fetch(base + "/api/kiosk/internal/displays", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal(await store.verifyToken(db(), "kiosk-z", token), null);
});

// If dashboardAuth reads a request field this stub lacks, ADD the field; never loosen the assertion.
test("core dashboardAuth never treats a kiosk token as a credential (spec §13.1, hermetic half)", async () => {
  const { dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");
  const { token } = await store.pairDevice(db(), { id: "kiosk-y", name: "Y", device_kind: "kiosk" });
  let nexted = false;
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, type() { return this; }, send() { return this; }, json() { return this; },
    redirect() { this.statusCode = 302; return this; }, redirectAfterPost() { this.statusCode = 303; return this; }, setHeader() {}, getHeader() {}, cookie() {} };
  await dashboardAuth({ headers: { "tailscale-user-login": "a@b", authorization: `Bearer ${token}` }, ip: "100.64.0.9", connection: { remoteAddress: "100.64.0.9" }, socket: { remoteAddress: "100.64.0.9" }, method: "GET", path: "/dashboard", originalUrl: "/dashboard", url: "/dashboard", query: {} }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.ok([302, 303, 401, 403].includes(res.statusCode), String(res.statusCode));
});

test("internal API: loopback + announce token; any forwarding/Tailscale header is refused", async () => {
  assert.equal((await fetch(base + "/api/kiosk/internal/displays")).status, 401);
  assert.equal((await fetch(base + "/api/kiosk/internal/displays", { headers: { Authorization: "Bearer ann-ok" } })).status, 200);
  for (const h of [{ "X-Forwarded-For": "100.64.0.9" }, { "Tailscale-User-Login": "a@b" }, { Forwarded: "for=1.2.3.4" }]) {
    assert.equal((await fetch(base + "/api/kiosk/internal/displays", { headers: { Authorization: "Bearer ann-ok", ...h } })).status, 403, JSON.stringify(h));
  }
  const r = await (await j("/api/kiosk/internal/announce", { method: "POST", body: JSON.stringify({ text: "Dinner's ready" }), headers: { Authorization: "Bearer ann-ok" } })).json();
  assert.ok(Array.isArray(r.offline));
});

test("resolveDisplayBird: validated portrait, else the default crow (never throws)", async () => {
  assert.deepEqual(await resolveDisplayBird({}, { readPortrait: async () => null }), DEFAULT_BIRD);
  assert.deepEqual(await resolveDisplayBird({}, { readPortrait: async () => { throw new Error("no tables"); } }), DEFAULT_BIRD);
  assert.deepEqual(await resolveDisplayBird({}, { readPortrait: async () => ({ species: "dodo", seed: 1 }) }), DEFAULT_BIRD);
  assert.deepEqual(await resolveDisplayBird({}, { readPortrait: async () => ({ species: "magpie", seed: 77, mood: "weird", outfit: [1] }) }),
    { species: "magpie", seed: 77, mood: "happy", outfit: null, source: "ramble" });
});

test("resolveDisplayBird + the real core readPortrait on Ramble tables: mood (decay-on-read) and outfit", async () => {
  const r = createClient({ url: "file::memory:" });
  await initRambleTables(r);
  const now = Date.now();
  await r.execute({ sql: "INSERT INTO ramble_eggs (egg_id, species, seed, status, created_at, outfit_json) VALUES ('e1','magpie',77,'hatched',1,?)", args: [JSON.stringify({ scarf: "knit" })] });
  await r.execute({ sql: "INSERT INTO ramble_pet (owner, energy, last_fed_at, active_egg_id) VALUES ('self', 40, ?, 'e1') ON CONFLICT(owner) DO UPDATE SET energy = 40, last_fed_at = excluded.last_fed_at, active_egg_id = 'e1'", args: [now] });
  const b = await resolveDisplayBird(r, { readPortrait });
  assert.deepEqual(b, { species: "magpie", seed: 77, mood: portraitMood(40, now), outfit: { scarf: "knit" }, source: "ramble" });
  assert.equal(b.mood, "tired");
});
```

Two schema facts were checked against `bundles/ramble/server/init-tables.js` on main: `ramble_eggs.created_at` is NOT NULL, and `ramble_pet.active_egg_id` and `ramble_eggs.outfit_json` are added by `ensureColumn`. The `last_fed_at` column name was checked against `readPortrait`'s own query. If the pet table names it differently on the rebased main, follow `readPortrait`.

Append to `tests/auth-network.test.js`:

```js
test("kiosk paths are never public-funnel paths (spec §10)", async () => {
  const { PUBLIC_FUNNEL_PREFIXES } = await import("../servers/gateway/funnel.js");
  for (const p of ["/kiosk", "/kiosk/", "/api/kiosk", "/api/kiosk/"]) assert.ok(!PUBLIC_FUNNEL_PREFIXES.includes(p), p);
  const app = express();
  app.use(rejectFunneledMiddleware());
  app.get("/kiosk", (req, res) => res.send("ok"));
  app.post("/api/kiosk/pair/start", (req, res) => res.send("ok"));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(base + "/kiosk", { headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
    assert.equal((await fetch(base + "/api/kiosk/pair/start", { method: "POST", headers: { "Tailscale-Funnel-Request": "?1" } })).status, 403);
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- tests/kiosk-routes.test.js tests/auth-network.test.js`
Expected: `kiosk-routes` FAILS (module not found). The new `auth-network` case PASSES at once, because global middleware already covers it. It is a regression pin.

- [ ] **Step 3: `bundles/kiosk/server/app-root.js`**

```js
/** Resolve the Crow app root from an installed copy (ramble pattern; see bundles/ramble/server/app-root.js). */
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
function looksLikeAppRoot(p) { return !!p && existsSync(join(p, "servers", "db.js")); }
const guess = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const conventional = join(homedir(), "crow");
export const APP_ROOT = looksLikeAppRoot(process.env.CROW_APP_ROOT) ? process.env.CROW_APP_ROOT
  : looksLikeAppRoot(guess) ? guess
  : looksLikeAppRoot(conventional) ? conventional
  : (process.env.CROW_APP_ROOT || guess);
export const appImport = (rel) => import(pathToFileURL(join(APP_ROOT, rel)).href);
```

- [ ] **Step 4: `bundles/kiosk/server/bird.js`**

```js
/**
 * The display's bird (spec §5, rulings R18/R19): core readPortrait(db) — the
 * user's hatched Ramble bird with its decay-on-read mood and its outfit (the
 * same function the contacts portrait uses) — validated here; else the fixed
 * default crow (species crow, seed 0). readPortrait is injected (the gateway
 * glue passes servers/sharing/profile-avatar.js's), so tests need no Ramble.
 */
const ROSTER = new Set(["crow", "raven", "grackle", "magpie", "mockingbird", "hummingbird", "penguin", "blackswan"]);
const MOODS = new Set(["happy", "tired", "alarmed"]);
export const DEFAULT_BIRD = Object.freeze({ species: "crow", seed: 0, mood: "happy", outfit: null, source: "default" });

export async function resolveDisplayBird(db, { readPortrait }) {
  try {
    const p = await readPortrait(db);
    const seed = Number(p?.seed);
    if (p && ROSTER.has(String(p.species)) && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff) {
      const outfit = p.outfit && typeof p.outfit === "object" && !Array.isArray(p.outfit) ? p.outfit : null;
      return { species: String(p.species), seed, mood: MOODS.has(p.mood) ? p.mood : "happy", outfit, source: "ramble" };
    }
  } catch { /* fall through to the default bird */ }
  return { ...DEFAULT_BIRD };
}
```

The outfit is passed to the page as data. The page hands it to the engine's own `applyOutfit`, which copies only known slot/value pairs, so a junk outfit draws nothing.

- [ ] **Step 5: `bundles/kiosk/server/runtime.js`**

```js
/**
 * Kiosk runtime: routes + WS upgrade + announce/show. Every gateway/framework
 * dependency is injected (Router/json from express, WebSocketServer from ws,
 * isAllowedNetwork, csrfMiddleware, the db, the device store, the voice turn),
 * so this file imports no bare package and runs in tests on fakes.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createPairingStore } from "./pairing.js";
import { createSessionHub } from "./session.js";
import { createMetricsStore } from "./metrics.js";
import { createWmStore, createWmTool, matchWmFastPath, kioskPromptSuffix, kioskTurnContext, contentBlocks } from "./wm.js";
import { ensureKioskSttProfile, pickKioskTtsProfile } from "./profiles.js";
import { STRINGS } from "./strings.js";

export const PAGE_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "media-src 'self' blob:", "connect-src 'self' ws://127.0.0.1:8770", "frame-src https://www.youtube-nocookie.com",
  "worker-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");
export const ASSETS = {
  "kiosk.js": "text/javascript", "state.js": "text/javascript", "audio.js": "text/javascript",
  "resample.js": "text/javascript", "pcm-worklet.js": "text/javascript", "vad.js": "text/javascript",
  "wm-view.js": "text/javascript", "bird-view.js": "text/javascript", "metrics.js": "text/javascript",
  "kiosk.css": "text/css",
};

/** Never on a shared display (review C3): crow_delegate's `bot` arg reaches ANY enabled bot. */
export const KIOSK_DENY_TOOLS = Object.freeze(["crow_delegate", "crow_job_status"]);

export function kioskThemeCss(T) {
  const vars = (o) => Object.entries(o).map(([k, v]) => `--k-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}:${v};`).join("");
  return `:root{${vars(T.light)}}:root[data-theme="dark"]{${vars({ ...T.light, ...T.dark })}}`;
}

function directLoopback(req) {
  const a = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (a !== "127.0.0.1" && a !== "::1") return false;
  return !Object.keys(req.headers).some((h) => h.startsWith("tailscale-") || h === "x-forwarded-for" || h === "forwarded" || h === "x-forwarded-host");
}

export function createKioskRuntime(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || ((m) => console.log(m));
  const pairing = createPairingStore({ now });
  const metrics = createMetricsStore();
  let hub = null;
  const wm = createWmStore({
    now,
    onTimerDone: (id, w) => {
      hub?.sendTo(id, { type: "wm", action: "timer_done", id: w.id });
      hub?.speak(id, `${w.name} timer is done.`);
    },
  });
  const withDb = async (fn) => { const db = deps.openDb(); try { return await fn(db); } finally { try { db.close?.(); } catch {} } };

  hub = createSessionHub({
    verifyKiosk: (id, token) => withDb((db) => deps.deviceStore.verifyToken(db, id, token, { kind: "kiosk" })),
    displayConfig: (d) => withDb(async (db) => ({ name: d.name, ...(d.kiosk_settings || {}), bird: await deps.resolveDisplayBird(db) })),
    runTurn: ({ device, audio, sink, signal, caps }) => withDb((db) => deps.voice.runVoiceTurn({
      db, device, audio, sink, signal,
      extraTools: [createWmTool({ store: wm, deviceId: device.id, caps, emit: (ev) => sink.event(ev) })],
      fastPaths: async (t) => matchWmFastPath(t, wm, device.id, caps),
      promptSuffix: kioskPromptSuffix(),
      turnContext: kioskTurnContext(wm, device.id),
      denyTools: KIOSK_DENY_TOOLS,
    })),
    speak: ({ device, text, sink }) => withDb((db) => deps.voice.speakText({ db, device, text, sink })),
    wm, metrics,
    wrapPcmAsWav: deps.wrapPcmAsWav,
    warmup: (d) => deps.sttWarmup(d),
    helloTimeoutMs: deps.helloTimeoutMs,
    now, log,
  });

  const sweep = (deps.setInterval || setInterval)(() => {
    for (const id of hub.connectedIds()) for (const w of wm.sweepIdle(id)) hub.sendTo(id, { type: "wm", action: "close", id: w.id });
  }, 60_000);
  sweep.unref?.();

  async function kioskDevices(db) { return (await deps.deviceStore.listDevices(db)).filter((d) => d.device_kind === "kiosk"); }
  async function targets(db, display) {
    const all = await kioskDevices(db);
    if (!display) return all;
    const q = String(display).toLowerCase();
    return all.filter((d) => d.id === display || String(d.name || "").toLowerCase() === q);
  }
  async function announce(display, { text, speak = true }) {
    return withDb(async (db) => {
      const out = { delivered: [], offline: [] };
      for (const d of await targets(db, display)) {
        if (hub.sendTo(d.id, { type: "announce", text })) { if (speak) hub.speak(d.id, text); out.delivered.push(d.name); }
        else out.offline.push(d.name);
      }
      return out;
    });
  }
  async function show(display, { title, body }) {
    return withDb(async (db) => {
      const out = { delivered: [], offline: [] };
      for (const d of await targets(db, display)) {
        const { window, evicted } = wm.open(d.id, { kind: "content", title, blocks: contentBlocks(title, body) });
        for (const e of evicted) hub.sendTo(d.id, { type: "wm", action: "close", id: e.id });
        (hub.sendTo(d.id, { type: "wm", action: "open", window }) ? out.delivered : out.offline).push(d.name);
      }
      return out;
    });
  }

  function router(dashboardAuth) {
    const r = deps.Router();
    // In the gateway the global 1 MB JSON parser runs first, so this limit only
    // applies in tests; every handler caps its own fields (slice) regardless.
    const json = deps.json({ limit: "64kb" });
    const gate = (req, res, next) => {
      if (req.headers["tailscale-funnel-request"]) return res.status(403).json({ error: "funnel_refused" });
      if (!deps.isAllowedNetwork(req)) return res.status(403).json({ error: "network_refused" });
      next();
    };
    const internal = async (req, res, next) => {
      if (!directLoopback(req)) return res.status(403).json({ error: "loopback_only" });
      const auth = String(req.headers.authorization || "");
      const ok = await withDb((db) => deps.announceToken.validate(db, auth.startsWith("Bearer ") ? auth.slice(7) : ""));
      if (!ok) return res.status(401).json({ error: "unauthorized" });
      next();
    };
    const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => { log(`[kiosk] ${req.method} ${req.path}: ${err.message}`); if (!res.headersSent) res.status(500).json({ error: "internal" }); });

    r.use("/kiosk", gate);
    r.use("/api/kiosk/pair", gate);
    r.use("/api/kiosk/admin", gate, dashboardAuth, deps.csrfMiddleware);
    r.use("/api/kiosk/internal", internal);

    r.get("/kiosk", (req, res) => {
      res.setHeader("Content-Security-Policy", PAGE_CSP);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
      res.type("html").send(readFileSync(join(deps.files.publicDir, "kiosk.html"), "utf8"));
    });
    r.get("/kiosk/assets/:file", (req, res) => {
      const f = req.params.file;
      res.setHeader("Cache-Control", "no-cache");
      if (f === "theme.css") return res.type("text/css").send(deps.themeCss());
      if (f === "strings.js") return res.type("text/javascript").send(`export const STRINGS = ${JSON.stringify(STRINGS)};\n`);
      if (f === "bird-svg.js") return res.type("text/javascript").send(readFileSync(deps.files.birdSvgPath, "utf8"));
      if (!Object.hasOwn(ASSETS, f)) return res.status(404).type("text/plain").send("Not found");
      const p = resolve(deps.files.publicDir, f);
      if (!p.startsWith(resolve(deps.files.publicDir)) || !existsSync(p)) return res.status(404).type("text/plain").send("Not found");
      res.type(ASSETS[f]).send(readFileSync(p, "utf8"));
    });

    r.post("/api/kiosk/pair/start", json, (req, res) => {
      const out = pairing.start({ ip: req.ip || req.socket?.remoteAddress || "?", ua: req.headers["user-agent"], login: req.headers["tailscale-user-login"] || null, nameHint: req.body?.name_hint });
      res.setHeader("Cache-Control", "no-store");
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json(out);
    });
    r.get("/api/kiosk/pair/status", (req, res) => {
      const out = pairing.status(String(req.query.pair_id || ""), String(req.headers["x-kiosk-poll"] || ""));
      res.setHeader("Cache-Control", "no-store");
      res.status(out.status).json(out.body);
    });

    r.get("/api/kiosk/admin/displays", wrap(async (req, res) => {
      const body = await withDb(async (db) => {
        const devices = (await kioskDevices(db)).map((d) => ({ ...d, connected: hub.isConnected(d.id), latency: metrics.summary(d.id) }));
        const bots = (await db.execute({ sql: "SELECT bot_id, display_name FROM pi_bot_defs WHERE enabled = 1 ORDER BY display_name", args: [] })).rows.map((x) => ({ bot_id: x.bot_id, display_name: x.display_name }));
        const prof = async (k) => { try { return JSON.parse((await deps.settings.readSetting(db, k)) || "[]").map((p) => ({ id: p.id, name: p.name || p.id, provider: p.provider })); } catch { return []; } };
        return { devices, bots, pending: pairing.listPending(), stt_profiles: await prof("stt_profiles"), tts_profiles: await prof("tts_profiles") };
      });
      res.json(body);
    }));
    r.post("/api/kiosk/admin/approve", json, wrap(async (req, res) => {
      const code = String(req.body?.code || "");
      const name = String(req.body?.name || "").trim().slice(0, 64) || "Display";
      const botId = String(req.body?.bot_id || "");
      await withDb(async (db) => {
        const bot = (await db.execute({ sql: "SELECT bot_id FROM pi_bot_defs WHERE bot_id = ? AND enabled = 1", args: [botId] })).rows[0];
        if (!bot) return res.status(400).json({ error: "bot_required" });
        const c = pairing.claim(code);
        if (c.error) return res.status(c.status).json({ error: c.error, retry_after_s: c.retry_after_s });
        try {
          const stt = await ensureKioskSttProfile(db, deps.settings);
          const tts = await pickKioskTtsProfile(db, deps.settings);
          const id = "kiosk-" + randomBytes(6).toString("hex");
          const { token } = await deps.deviceStore.pairDevice(db, { id, name, device_kind: "kiosk", stt_profile_id: stt.id, tts_profile_id: tts ? tts.id : null });
          await deps.deviceStore.updateDeviceProfiles(db, id, { bound_bot_id: botId });
          if (!pairing.complete(c.pending.pair_id, { device_id: id, token })) {
            await deps.deviceStore.unpairDevice(db, id);          // expired between claim and complete: no orphan device
            return res.status(410).json({ error: "pairing_expired" });
          }
          log(`[kiosk] paired ${id} "${name}" → bot ${botId} (requester ${c.pending.ip})`);
          res.json({ ok: true, device_id: id, tts: tts ? tts.name || tts.id : null });
        } catch (err) { pairing.release(c.pending.pair_id); throw err; }
      });
    }));
    r.post("/api/kiosk/admin/displays/:id", json, wrap(async (req, res) => {
      await withDb(async (db) => {
        const cur = await deps.deviceStore.findDevice(db, req.params.id);
        if (!cur || cur.device_kind !== "kiosk") return res.status(404).json({ error: "not_found" });
        const b = req.body || {};
        const patch = {};
        if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 64);
        if (typeof b.bound_bot_id === "string") {
          const ok = (await db.execute({ sql: "SELECT 1 FROM pi_bot_defs WHERE bot_id = ? AND enabled = 1", args: [b.bound_bot_id] })).rows[0];
          if (!ok) return res.status(400).json({ error: "bot_required" });
          patch.bound_bot_id = b.bound_bot_id;
        }
        for (const k of ["stt_profile_id", "tts_profile_id"]) if (typeof b[k] === "string") patch[k] = b[k] || null;
        if (b.kiosk_settings && typeof b.kiosk_settings === "object") patch.kiosk_settings = b.kiosk_settings;
        const d = await deps.deviceStore.updateDeviceProfiles(db, req.params.id, patch);
        hub.refreshDevice(d.id, d);
        res.json({ ok: true, device: d });
      });
    }));
    r.delete("/api/kiosk/admin/displays/:id", wrap(async (req, res) => {
      await withDb(async (db) => {
        const cur = await deps.deviceStore.findDevice(db, req.params.id);
        if (!cur || cur.device_kind !== "kiosk") return res.status(404).json({ error: "not_found" });
        await deps.deviceStore.unpairDevice(db, cur.id);
        hub.closeDevice(cur.id, 4401, "unpaired");
        wm.closeAll(cur.id);
        res.json({ ok: true });
      });
    }));
    r.get("/api/kiosk/admin/displays/:id/metrics", (req, res) => res.json({ turns: metrics.list(req.params.id), summary: metrics.summary(req.params.id) }));

    r.get("/api/kiosk/internal/displays", wrap(async (req, res) => {
      res.json({ displays: await withDb(async (db) => (await kioskDevices(db)).map((d) => ({ id: d.id, name: d.name, connected: hub.isConnected(d.id) }))) });
    }));
    r.post("/api/kiosk/internal/announce", json, wrap(async (req, res) => {
      const text = String(req.body?.text || "").trim().slice(0, 500);
      if (!text) return res.status(400).json({ error: "text_required" });
      res.json(await announce(req.body?.display, { text, speak: req.body?.speak !== false }));
    }));
    r.post("/api/kiosk/internal/show", json, wrap(async (req, res) => {
      const title = String(req.body?.title || "").trim().slice(0, 80);
      const body = String(req.body?.body || "").slice(0, 4000);
      if (!title || !body) return res.status(400).json({ error: "title_and_body_required" });
      res.json(await show(req.body?.display, { title, body }));
    }));
    return r;
  }

  function attachUpgrade(server) {
    const wss = new deps.WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      if (String(req.url || "").split("?")[0] !== "/api/kiosk/session") return;
      if (req.headers["tailscale-funnel-request"] || !deps.isAllowedNetwork(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        let alive = true;
        ws.on("pong", () => { alive = true; });
        const ping = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; try { ws.ping(); } catch {} }, 15_000);
        ws.on("close", () => clearInterval(ping));
        hub.attach(ws);
      });
    });
    return { openSessionCount: () => hub.connectedIds().length };
  }

  return { router, attachUpgrade, hub, pairing, wm, metrics, announce, show, stop: () => clearInterval(sweep) };
}
```

`server/strings.js` arrives in Task 12. Until then, create it as a stub so this task's tests can import it:

```js
export const STRINGS = { en: {}, es: {} };
```

Task 12 replaces the stub with the full table.

- [ ] **Step 6: `bundles/kiosk/panel/routes.js` (gateway glue; real deps)**

```js
/**
 * Kiosk panel routes (gateway process). Installed as a COPY at
 * ~/.crow/panels/kiosk-routes.js, so everything is resolved by path: the kiosk
 * bundle dir (installed copy first) and the app root (CROW_APP_ROOT).
 * Builds the runtime once (top-level await) and mints the announce token.
 */
import express, { Router } from "express";
import { WebSocketServer } from "ws";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const isBundle = (p) => !!p && existsSync(join(p, "manifest.json")) && existsSync(join(p, "server", "runtime.js"));
const BUNDLE_DIR = [
  join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "kiosk"),
  process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "kiosk") : null,
  resolve(here, ".."),
].filter(Boolean).find(isBundle);
if (!BUNDLE_DIR) throw new Error("kiosk: bundle directory not found");
const bImport = (rel) => import(pathToFileURL(join(BUNDLE_DIR, rel)).href);

const { APP_ROOT, appImport } = await bImport("server/app-root.js");
const { createDbClient } = await appImport("servers/db.js");
const { isAllowedNetwork } = await appImport("servers/gateway/dashboard/auth.js");
const { csrfMiddleware } = await appImport("servers/gateway/dashboard/shared/csrf.js");
const deviceStore = await appImport("servers/shared/device-store.js");
const { createVoiceTurnRunner, defaultVoiceDeps } = await appImport("servers/gateway/voice/turn.js");
const { wrapPcmAsWav } = await appImport("servers/gateway/voice/turn-helpers.js");
const { readSetting, writeSetting } = await appImport("servers/gateway/dashboard/settings/registry.js");
const { ensureKioskAnnounceToken, validateKioskAnnounceToken } = await appImport("servers/gateway/local-token.js");
const { PERCH_TOKENS } = await appImport("servers/gateway/dashboard/shared/design-tokens.js");
const { readPortrait } = await appImport("servers/sharing/profile-avatar.js");
const { createKioskRuntime, kioskThemeCss } = await bImport("server/runtime.js");
const { resolveDisplayBird } = await bImport("server/bird.js");

const vdeps = await defaultVoiceDeps();
const voice = createVoiceTurnRunner(vdeps);
const warmedAt = new Map();
async function sttWarmup(device) {
  const db = createDbClient();
  try {
    const p = await vdeps.getSttProfile(db, device);
    if (!p || Date.now() - (warmedAt.get(p.id) || 0) < 10 * 60 * 1000) return;
    warmedAt.set(p.id, Date.now());
    const stt = await vdeps.createSttAdapter(p);
    await stt.transcribe(wrapPcmAsWav(Buffer.alloc(32000), 16000), { filename: "warm.wav", contentType: "audio/wav", language: p.language || undefined, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    console.warn(`[kiosk] STT warm-up failed: ${err.message}`);
  } finally { try { db.close(); } catch {} }
}

const runtime = createKioskRuntime({
  Router, json: express.json, WebSocketServer,
  isAllowedNetwork, csrfMiddleware,
  openDb: () => createDbClient(),
  deviceStore, voice, sttWarmup, wrapPcmAsWav,
  settings: { readSetting, writeSetting },
  resolveDisplayBird: (db) => resolveDisplayBird(db, { readPortrait }),
  themeCss: () => kioskThemeCss(PERCH_TOKENS),
  files: { publicDir: join(BUNDLE_DIR, "public"), birdSvgPath: join(APP_ROOT, "bundles", "ramble", "server", "bird-svg.cjs") },
  announceToken: { validate: validateKioskAnnounceToken },
});

{
  const db = createDbClient();
  ensureKioskAnnounceToken(db)
    .then((r) => { if (r.minted) console.log("[kiosk] announce token minted"); })
    .catch((err) => console.warn(`[kiosk] announce token mint failed: ${err.message}`))
    .finally(() => { try { db.close(); } catch {} });
}

export default function kioskRouter(dashboardAuth) { return runtime.router(dashboardAuth); }
export function setupWebSocket(server) { return runtime.attachUpgrade(server); }
```

The bird engine path is the **app root** copy, not the installed Ramble copy. The hooks ship with core code even when Ramble is not installed or its installed copy is older.

- [ ] **Step 7: MCP server + manifest + package + skill**

`bundles/kiosk/server/server.js`:

```js
/** Kiosk MCP tools (spec §4.1): reach live sessions through loopback /api/kiosk/internal with the announce token. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function createKioskServer({
  fetchImpl = fetch,
  baseUrl = `http://127.0.0.1:${process.env.CROW_GATEWAY_PORT || process.env.PORT || 3001}`,
  tokenPath = join(process.env.CROW_HOME || join(homedir(), ".crow"), "kiosk-announce-token"),
} = {}) {
  const server = new McpServer({ name: "crow-kiosk", version: "0.1.0" });
  async function call(method, path, body) {
    let token;
    try { token = readFileSync(tokenPath, "utf8").trim(); } catch { return { error: "kiosk announce token missing — restart the Crow gateway" }; }
    try {
      const r = await fetchImpl(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j.error || `HTTP ${r.status}` };
    } catch (err) { return { error: err.message }; }
  }
  const out = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }], ...(o?.error ? { isError: true } : {}) });
  server.tool("crow_kiosk_list_displays", "List the paired kiosk displays and whether each is connected.", {}, async () => out(await call("GET", "/api/kiosk/internal/displays")));
  server.tool("crow_kiosk_announce", "Show a short message on kiosk displays and speak it (speak:false to only show it). display = a display name or id; omit for every display.",
    { display: z.string().max(64).optional(), text: z.string().min(1).max(500), speak: z.boolean().optional() },
    async (a) => out(await call("POST", "/api/kiosk/internal/announce", a)));
  server.tool("crow_kiosk_show", "Open a content window on kiosk displays. In body, || starts a new paragraph and lines starting '- ' become a list.",
    { display: z.string().max(64).optional(), title: z.string().min(1).max(80), body: z.string().min(1).max(4000) },
    async (a) => out(await call("POST", "/api/kiosk/internal/show", a)));
  return server;
}
```

`bundles/kiosk/server/index.js`:

```js
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKioskServer } from "./server.js";
await createKioskServer().connect(new StdioServerTransport());
```

`bundles/kiosk/package.json`:

```json
{
  "name": "crow-kiosk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Crow kiosk display bundle — paired browser display with the user's bird as voice companion.",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  }
}
```

`bundles/kiosk/manifest.json`:

```json
{
  "id": "kiosk",
  "name": "Kiosk display",
  "version": "0.1.0",
  "type": "mcp-server",
  "author": "Crow",
  "category": "hardware",
  "tags": ["kiosk", "display", "voice", "home", "bird", "touchscreen"],
  "icon": "monitor",
  "description": "Turn a browser into a home display: your Ramble bird as a voice companion (tap to talk; Crow runs speech-to-text, your chosen bot and text-to-speech), with on-screen timers, recipes and notes. Pair it with a code; tailnet only.",
  "server": { "command": "node", "args": ["server/index.js"], "envKeys": ["CROW_HOME", "CROW_GATEWAY_PORT"] },
  "panel": "panel/kiosk.js",
  "panelRoutes": "panel/routes.js",
  "skills": ["skills/kiosk.md"],
  "capabilities": {
    "mcp_server_id": "kiosk",
    "group": "Kiosk",
    "skills": ["kiosk"],
    "runtimes": { "pi": true },
    "tools": [
      { "name": "crow_kiosk_list_displays", "label": "List displays", "subgroup": "Display" },
      { "name": "crow_kiosk_announce", "label": "Announce", "subgroup": "Display" },
      { "name": "crow_kiosk_show", "label": "Show", "subgroup": "Display" }
    ]
  },
  "requires": { "min_ram_mb": 64, "min_disk_mb": 5 },
  "env_vars": [],
  "notes": "Voice needs an STT profile (the Faster-Whisper bundle; the kiosk adds its own distil-small.en profile at first pairing) and a TTS profile (install the Kokoro TTS bundle for local voice). Reached at https://<host>:8444/kiosk over the tailnet; never through Funnel."
}
```

`bundles/kiosk/skills/kiosk.md`:

```markdown
---
name: kiosk
description: Put a message or a note on the household kiosk display(s) with crow_kiosk_announce / crow_kiosk_show.
---
# Kiosk display

Use these tools when the user wants something on the home display ("tell the kitchen display dinner's ready", "put the grocery list on the screen").

- `crow_kiosk_list_displays` — which displays exist and which are online.
- `crow_kiosk_announce { text, display?, speak? }` — a short line, shown and spoken. Omit `display` for every display. Keep it to one sentence.
- `crow_kiosk_show { title, body, display? }` — a content window. `||` starts a paragraph; lines starting `- ` become a list.

The display is a shared household screen: never put private messages, credentials or personal memories on it.
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npm test -- tests/kiosk-routes.test.js tests/auth-network.test.js tests/bundle-server-deps.test.js tests/bundle-contract.test.js`
Expected: PASS. The page test will 404 on `kiosk.html` until Task 11. Create a placeholder `bundles/kiosk/public/kiosk.html` with `<!doctype html><title>Crow Kiosk</title>` now. Task 11 replaces it.

- [ ] **Step 9: Verify the glue loads against a scratch home (never prod)**

```bash
H=$(mktemp -d); export CROW_HOME=$H CROW_DATA_DIR=$H/data CROW_APP_ROOT=$PWD; unset CROW_DB_PATH
node scripts/init-db.js >/dev/null
node --input-type=module -e '
const m = await import("./bundles/kiosk/panel/routes.js");
const r = m.default((q, s, n) => n());
console.log(typeof r, typeof m.setupWebSocket);
setTimeout(() => process.exit(0), 500);'
ls -l $H/kiosk-announce-token
```

Expected: `function function`, an `[kiosk] announce token minted` line, and the token file in the throwaway home (mode `-rw-------`).

- [ ] **Step 10: Registry**

```bash
npm run build-registry
node scripts/build-registry.mjs --check && echo REGISTRY-OK
git diff --stat registry/add-ons.json
```

Expected: `kiosk` is added. Ramble is now 0.13.1. `REGISTRY-OK`.

- [ ] **Step 11: Commit**

```bash
git add bundles/kiosk tests/kiosk-routes.test.js
git commit bundles/kiosk tests/kiosk-routes.test.js tests/auth-network.test.js registry/add-ons.json -m "feat(kiosk): bundle runtime — page/pair/admin/internal routes, hello-gated WS upgrade, MCP announce/show tools, manifest + registry"
```

---
### Task 11: The page (bird states, tap-to-talk, VAD, PCM capture/playback, captions, windows, latency report)

**Files:**
- Create in `bundles/kiosk/public/`: `kiosk.html` (replaces the placeholder), `kiosk.css`, `kiosk.js`, `state.js`, `vad.js`, `resample.js`, `pcm-worklet.js`, `audio.js`, `metrics.js`, `bird-view.js`, `wm-view.js`
- Test: `tests/kiosk-vad.test.js`, `tests/kiosk-page-state.test.js`, `tests/kiosk-page.test.js`

**Interfaces:**
- Consumes:
  - the session protocol from Task 9;
  - `/kiosk/assets/{theme.css, strings.js, bird-svg.js}` from Task 10;
  - `window.RambleBird.drawBird(g, mood, {hooks:true})` from Task 6;
  - `wm` window shapes from Task 8.
- Produces (pure, Node-testable modules):
  - `state.js`: `closeDecision(code, reason)`, `backoffMs(n)`, `micDecision(err, ctxState)`, `isNight(date, start, end)`, `msToNextMinute(date)`
  - `vad.js`: `createVad(opts)`, `createPreroll(n)`, `VAD_DEFAULTS`
  - `resample.js`: `createDecimator(inRate, onFrame, frameSize, outRate)`
  - `metrics.js`: `e2eMs`, `playStartPerfTime`
  - `wm-view.js`: `classifySwipe`, `formatRemaining`, `createWindowView(root, opts)`

Pi-3 rules (Global Constraints):
- no `requestAnimationFrame` anywhere;
- all bird animation in CSS (transform/opacity);
- blink via a randomized `setTimeout`;
- beak level sampled with a `setInterval` at 15 Hz **only while audio plays**;
- clock ticks once per minute (aligned);
- a timer window ticks at 1 Hz only while it is the visible window;
- no `<video>`/`<iframe>`.

Latency measurement (ruling R8):
- `speechEndAt` = `performance.now()` at the last voiced frame;
- `playAt` = scheduled start + `outputLatency`;
- `e2e_ms = playAt − speechEndAt`, sent in `turn_metrics` with `vad_reason`.

- [ ] **Step 1: Write the failing tests**

`tests/kiosk-vad.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVad, createPreroll, VAD_DEFAULTS } from "../bundles/kiosk/public/vad.js";
import { createDecimator, createFrameGate } from "../bundles/kiosk/public/resample.js";
import { e2eMs, playStartPerfTime } from "../bundles/kiosk/public/metrics.js";

const run = (vad, frames) => { let t = 1000; for (const rms of frames) { t += 20; const r = vad.push(rms, t); if (r.end) return { ...r, t }; } return null; };

test("speech then silence ends after 600 ms hangover; speechEndAt is the last voiced frame", () => {
  const r = run(createVad(), [...Array(25).fill(0.05), ...Array(40).fill(0.001)]);
  assert.equal(r.reason, "silence");
  assert.equal(r.speechEndAt, 1000 + 25 * 20);
  assert.equal(r.t - r.speechEndAt, VAD_DEFAULTS.hangoverMs);
});

test("pauses shorter than the hangover do not end the turn", () => {
  const r = run(createVad(), [...Array(10).fill(0.05), ...Array(20).fill(0.001), ...Array(10).fill(0.05), ...Array(40).fill(0.001)]);
  assert.equal(r.speechEndAt, 1000 + 40 * 20);
});

test("15 s cap (a TV in the room) and 8 s no-speech (a tap with nothing said)", () => {
  assert.equal(run(createVad(), Array(1000).fill(0.05)).reason, "max");
  const quiet = run(createVad(), Array(1000).fill(0.001));
  assert.equal(quiet.reason, "no_speech"); assert.equal(quiet.speechEndAt, null);
  assert.equal(run(createVad(), [0.05, 0.05, 0.05, ...Array(1000).fill(0.001)]).reason, "no_speech", "a 60 ms cough is not speech");
  const lever = run(createVad({ hangoverMs: 450 }), [...Array(25).fill(0.05), ...Array(40).fill(0.001)]);
  assert.ok(lever.t - 1500 >= 450 && lever.t - 1500 < 470, "lever 1 (450 ms) is one option; frame granularity is 20 ms");
});

test("pre-roll keeps the last 1.0 s (50 × 20 ms frames)", () => {
  const p = createPreroll();
  for (let i = 0; i < 80; i++) p.push(i);
  const d = p.drain();
  assert.equal(d.length, 50); assert.equal(d[0], 30); assert.equal(p.size, 0);
});

test("frame gate (in the worklet): nothing posted while idle; start(preroll) flushes the last 1.0 s first", () => {
  const posted = [];
  const g = createFrameGate((p) => posted.push(p));
  for (let i = 0; i < 80; i++) g.push(i, 0);
  assert.equal(posted.length, 0, "idle: no main-thread messages");
  assert.equal(g.ringSize, 50);
  g.start(true);
  assert.deepEqual(posted.slice(0, 2), [30, 31]); assert.equal(posted.length, 50);
  g.push(99, 0); assert.equal(posted.at(-1), 99);
  g.stop(); g.push(100, 0); assert.equal(posted.at(-1), 99);
  g.start(false); assert.equal(posted.at(-1), 99, "a tap sends no pre-roll");
});

test("decimator: 48 kHz and 44.1 kHz → 320-sample 16 kHz frames with the right RMS", () => {
  for (const rate of [48000, 44100]) {
    const frames = [];
    const push = createDecimator(rate, (pcm, rms) => frames.push({ n: pcm.length, rms }));
    const s = new Float32Array(rate);
    for (let i = 0; i < rate; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / rate);
    for (let i = 0; i < rate; i += 128) push(s.subarray(i, i + 128));
    assert.ok(frames.length >= 49 && frames.length <= 50, `${rate}: ${frames.length}`);
    assert.ok(frames.every((f) => f.n === 320));
    assert.ok(Math.abs(frames[10].rms - 0.5 / Math.SQRT2) < 0.03, `${rate}: rms ${frames[10].rms}`);
  }
});

test("latency arithmetic: play start maps audio-clock time to performance time and adds output latency", () => {
  assert.equal(playStartPerfTime({ nowPerf: 5000, ctxCurrentTime: 10, startWhen: 10.05, outputLatency: 0.02 }), 5070);
  assert.equal(e2eMs({ speechEndAt: 3200, playAt: 5070 }), 1870);
  assert.equal(e2eMs({ speechEndAt: null, playAt: 5070 }), null);
});
```

`tests/kiosk-page-state.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeDecision, backoffMs, micDecision, isNight, msToNextMinute } from "../bundles/kiosk/public/state.js";

test("4401 unauthorized/unpaired clears the token; 4401 hello_timeout keeps it and reconnects", () => {
  assert.equal(closeDecision(4401, "unauthorized").action, "forget_token");
  assert.equal(closeDecision(4401, "unpaired").action, "forget_token");
  assert.equal(closeDecision(4401, "hello_timeout").action, "reconnect");
  assert.equal(closeDecision(1006, "").action, "reconnect");
});

test("4000 superseded → halt (no auto reconnect ping-pong)", () => {
  assert.deepEqual(closeDecision(4000, "superseded"), { action: "halt", banner: "opened_elsewhere" });
});

test("reconnect backoff 1 s → 30 s cap", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("mic denied → mic_blocked; no device → no_mic; suspended context → needs_gesture", () => {
  assert.equal(micDecision({ name: "NotAllowedError" }, "running"), "mic_blocked");
  assert.equal(micDecision({ name: "SecurityError" }, "running"), "mic_blocked");
  assert.equal(micDecision({ name: "NotFoundError" }, "running"), "no_mic");
  assert.equal(micDecision(null, "suspended"), "needs_gesture");
  assert.equal(micDecision(null, "running"), "ok");
});

test("night window wraps midnight (default 22:30–06:30, Kevin Q4)", () => {
  const at = (h, m) => new Date(2026, 9, 3, h, m);
  assert.equal(isNight(at(22, 29)), false); assert.equal(isNight(at(22, 30)), true);
  assert.equal(isNight(at(3, 0)), true); assert.equal(isNight(at(6, 30)), false);
  assert.equal(isNight(at(13, 0), "12:00", "14:00"), true);
  assert.equal(msToNextMinute(new Date(2026, 9, 3, 7, 41, 59, 500)), 500);
});
```

`tests/kiosk-page.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { parseHTML } from "linkedom";
import { ASSETS } from "../bundles/kiosk/server/runtime.js";
import { classifySwipe, formatRemaining, createWindowView } from "../bundles/kiosk/public/wm-view.js";

const PUB = new URL("../bundles/kiosk/public/", import.meta.url);
const files = readdirSync(PUB);
const read = (f) => readFileSync(new URL(f, PUB), "utf8");

test("idle DOM: no video/iframe, no inline script/style (CSP), bird engine then module entry", () => {
  const html = read("kiosk.html");
  const { document } = parseHTML(html);
  assert.equal(document.querySelectorAll("video,iframe").length, 0);
  const scripts = [...document.querySelectorAll("script")];
  assert.deepEqual(scripts.map((s) => [s.getAttribute("src"), s.getAttribute("type")]), [["/kiosk/assets/bird-svg.js", null], ["/kiosk/assets/kiosk.js", "module"]]);
  assert.doesNotMatch(html, /\sstyle=/);
  for (const id of ["bird", "bird-art", "mic", "captions", "cap-user", "cap-bot", "windows", "pairing", "pair-code", "banner", "clock"]) assert.ok(document.getElementById(id), id);
});

test("no requestAnimationFrame and no video/iframe creation anywhere in the page code", () => {
  for (const f of files.filter((x) => x.endsWith(".js"))) {
    const src = read(f);
    assert.doesNotMatch(src, /requestAnimationFrame/, f);
    assert.doesNotMatch(src, /createElement\(\s*["'](video|iframe)["']/, f);
    assert.doesNotMatch(src, /innerHTML\s*=(?!\s*RB\.drawBird)/, `${f}: innerHTML only for the bird engine's own SVG`);
  }
});

test("page weight ≤ 80 KB (html + css + js, uncompressed)", () => {
  const total = files.reduce((n, f) => n + statSync(new URL(f, PUB)).size, 0);
  assert.ok(total <= 80 * 1024, `page is ${total} bytes`);
});

test("every relative import resolves to a whitelisted asset", () => {
  for (const f of files.filter((x) => x.endsWith(".js"))) {
    for (const m of read(f).matchAll(/from\s+["']\.\/([\w.-]+)["']/g)) assert.ok(Object.hasOwn(ASSETS, m[1]) || m[1] === "strings.js", `${f} imports ${m[1]}`);
  }
  for (const f of files.filter((x) => x !== "kiosk.html")) assert.ok(Object.hasOwn(ASSETS, f), `${f} is served`);
});

test("CSS: reduced motion honoured, 56 px touch targets, 20 px body text, phone single column", () => {
  const css = read("kiosk.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.no-anim/);
  assert.match(css, /min-height:\s*56px/);
  assert.match(css, /font-size:\s*20px/);
  assert.match(css, /@media \(max-width: 599px\)/);
});

test("CSS never transforms hook groups that carry an SVG transform attribute; idle animates only the HTML wrapper", () => {
  const css = read("kiosk.css");
  assert.doesNotMatch(css, /\.rb-(bird|wing|tail)\b/);
  assert.doesNotMatch(css, /\.rb-beak(?!-lower)\b/);
  assert.match(css, /\.is-idle \.k-bird-art\s*\{[^}]*animation/);
  assert.doesNotMatch(css, /\.is-idle [^{]*\.rb-/, "nothing inside the SVG animates at idle");
});

test("swipe + countdown helpers", () => {
  assert.equal(classifySwipe({ dx: -90, dy: 5, dt: 400 }), "left");
  assert.equal(classifySwipe({ dx: 40, dy: 2, dt: 50 }), "right", "fast fling");
  assert.equal(classifySwipe({ dx: 40, dy: 2, dt: 400 }), null);
  assert.equal(classifySwipe({ dx: 100, dy: 200, dt: 100 }), null, "vertical scroll is not a dismiss");
  assert.equal(formatRemaining(61_001), "1:02");
});

test("window view: one visible window + tab rail; text only (no markup injection); close button dismisses", () => {
  const { document, window } = parseHTML("<div id=w></div>");
  const root = document.getElementById("w");
  const dismissed = [];
  const v = createWindowView(root, { t: (k) => k, onDismiss: (id) => dismissed.push(id), now: () => 0 });
  v.apply({ action: "snapshot", windows: [
    { id: "content-1", kind: "content", title: "<img src=x onerror=alert(1)>", blocks: [{ type: "heading", text: "x" }, { type: "text", text: "<b>hi</b>" }, { type: "list", items: ["a", "b"] }] },
    { id: "recipe-2", kind: "recipe", title: "Lasagna", ingredients: ["noodles"], steps: ["Boil", "Layer"], step: 1 },
  ] });
  assert.equal(root.querySelectorAll("article").length, 1);
  assert.equal(root.querySelector("article").dataset.id, "recipe-2");
  assert.equal(root.querySelectorAll(".k-tabs button").length, 2);
  assert.equal(root.querySelector(".k-steps .is-current").textContent, "Layer");
  v.apply({ action: "focus", id: "content-1" });
  assert.equal(root.querySelectorAll("img,b").length, 0, "markup arrives as text");
  root.querySelector(".k-win-close").dispatchEvent(new window.Event("click"));
  assert.deepEqual(dismissed, ["content-1"]);
  v.apply({ action: "open", window: { id: "timer-3", kind: "timer", title: "Tea", name: "Tea", ends_at: 61_001, done: false } });
  assert.equal(root.querySelector(".k-timer").textContent, "1:02");
  v.apply({ action: "timer_done", id: "timer-3" });
  assert.ok(root.querySelector("article").classList.contains("is-done"));
  v.apply({ action: "close_all" });
  assert.equal(root.hidden, true);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- tests/kiosk-vad.test.js tests/kiosk-page-state.test.js tests/kiosk-page.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Pure modules**

`bundles/kiosk/public/state.js`:

```js
/** Pure page decisions (unit-tested in Node). */
export function closeDecision(code, reason) {
  if (code === 4401 && (reason === "unauthorized" || reason === "unpaired")) return { action: "forget_token" };
  if (code === 4000 && reason === "superseded") return { action: "halt", banner: "opened_elsewhere" };
  return { action: "reconnect" };
}
export function backoffMs(attempt) { return Math.min(30_000, 1000 * 2 ** Math.min(Math.max(0, attempt), 5)); }
export function micDecision(err, ctxState) {
  if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) return "mic_blocked";
  if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) return "no_mic";
  if (err) return "mic_error";
  return ctxState === "suspended" ? "needs_gesture" : "ok";
}
const mins = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
export function isNight(date, start = "22:30", end = "06:30") {
  const m = date.getHours() * 60 + date.getMinutes();
  const s = mins(start), e = mins(end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}
export function msToNextMinute(date) { return 60_000 - (date.getSeconds() * 1000 + date.getMilliseconds()); }
```

`bundles/kiosk/public/vad.js`:

```js
/** Client energy VAD (spec §7.3): 600 ms hangover, 15 s cap, 8 s with no speech ends a tap. */
export const VAD_DEFAULTS = Object.freeze({ threshold: 0.012, hangoverMs: 600, maxMs: 15_000, minSpeechMs: 120, noSpeechMs: 8000, frameMs: 20 });

export function createVad(opts = {}) {
  const o = { ...VAD_DEFAULTS, ...opts };
  let startAt = null, speechMs = 0, started = false, lastVoiceAt = null, ended = false;
  return {
    push(rms, t) {
      if (ended) return { end: false };
      if (startAt == null) startAt = t - o.frameMs;
      if (rms >= o.threshold) { speechMs += o.frameMs; lastVoiceAt = t; if (speechMs >= o.minSpeechMs) started = true; }
      let r = null;
      if (started && t - lastVoiceAt >= o.hangoverMs) r = { end: true, reason: "silence", speechEndAt: lastVoiceAt };
      else if (t - startAt >= o.maxMs) r = { end: true, reason: "max", speechEndAt: lastVoiceAt ?? t };
      else if (!started && t - startAt >= o.noSpeechMs) r = { end: true, reason: "no_speech", speechEndAt: null };
      if (r) ended = true;
      return r || { end: false };
    },
  };
}

/** 1.0 s ring of 20 ms frames, held in page memory only; nothing is sent while idle. */
export function createPreroll(maxFrames = 50) {
  const buf = [];
  return {
    push(f) { buf.push(f); if (buf.length > maxFrames) buf.shift(); },
    drain() { return buf.splice(0); },
    get size() { return buf.length; },
  };
}
```

`bundles/kiosk/public/resample.js`:

```js
/** Box-filter decimation to 16 kHz PCM16, emitted as fixed 20 ms frames with their RMS. */
export function createDecimator(inRate, onFrame, frameSize = 320, outRate = 16000) {
  const ratio = inRate / outRate;
  let phase = 0, acc = 0, cnt = 0, n = 0, sumSq = 0;
  let out = new Int16Array(frameSize);
  return function push(samples) {
    for (let i = 0; i < samples.length; i++) {
      acc += samples[i]; cnt++; phase += 1;
      if (phase >= ratio) {
        phase -= ratio;
        let v = acc / cnt;
        acc = 0; cnt = 0;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        out[n++] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
        sumSq += v * v;
        if (n === frameSize) { onFrame(out, Math.sqrt(sumSq / frameSize)); out = new Int16Array(frameSize); n = 0; sumSq = 0; }
      }
    }
  };
}

/**
 * Runs INSIDE the AudioWorklet (review m7): while idle, frames go into a 1.0 s
 * ring and NOTHING is posted to the main thread (no 50 Hz messages at idle on a
 * Pi 3). start(withPreroll) flushes the ring first (wake word, K2) then posts live
 * frames; stop() goes back to ring-only.
 */
export function createFrameGate(post, maxFrames = 50) {
  const ring = [];
  let capturing = false;
  return {
    push(pcm, rms) {
      if (capturing) { post(pcm, rms); return; }
      ring.push([pcm, rms]);
      if (ring.length > maxFrames) ring.shift();
    },
    start(withPreroll) {
      if (withPreroll) for (const [p, r] of ring) post(p, r);
      ring.length = 0;
      capturing = true;
    },
    stop() { capturing = false; },
    get ringSize() { return ring.length; },
  };
}
```

`bundles/kiosk/public/metrics.js`:

```js
/** Latency arithmetic (spec §9, ruling R8). Input-side mic latency is NOT included (stated bias). */
export function playStartPerfTime({ nowPerf, ctxCurrentTime, startWhen, outputLatency = 0 }) {
  return Math.round(nowPerf + (startWhen - ctxCurrentTime) * 1000 + outputLatency * 1000);
}
export function e2eMs({ speechEndAt, playAt }) {
  if (speechEndAt == null || playAt == null) return null;
  return Math.round(playAt - speechEndAt);
}
```

`bundles/kiosk/public/pcm-worklet.js`:

```js
import { createDecimator, createFrameGate } from "./resample.js";
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    const gate = createFrameGate((pcm, rms) => this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]));
    this.push = createDecimator(sampleRate, (pcm, rms) => gate.push(pcm, rms));
    this.port.onmessage = (e) => { if (e.data?.cmd === "start") gate.start(!!e.data.preroll); else if (e.data?.cmd === "stop") gate.stop(); };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.push(ch);
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
```

`bundles/kiosk/public/audio.js`:

```js
/** Mic capture (AEC/NS/AGC on, spec §7.3) and in-page playback (so Chromium's echo canceller sees it). */
import { playStartPerfTime } from "./metrics.js";

export async function openMic(ctx, onFrame) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  await ctx.audioWorklet.addModule("/kiosk/assets/pcm-worklet.js");
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
  node.port.onmessage = (e) => onFrame(e.data.pcm, e.data.rms, performance.now());
  src.connect(node);
  return {
    start(preroll) { node.port.postMessage({ cmd: "start", preroll: !!preroll }); },
    stop() { node.port.postMessage({ cmd: "stop" }); },
    close() { try { src.disconnect(); node.disconnect(); } catch {} stream.getTracks().forEach((t) => t.stop()); },
  };
}

export function createPlayer(ctx, { onLevel, onFirstPlay, onDrained }) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.connect(ctx.destination);
  const data = new Uint8Array(analyser.fftSize);
  const sources = new Set();
  let codec = "pcm", rate = 24000, nextAt = 0, first = true, level = null, chain = Promise.resolve();
  const startLevel = () => {
    if (level) return;
    level = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let s = 0;
      for (let i = 0; i < data.length; i++) { const x = (data[i] - 128) / 128; s += x * x; }
      onLevel(Math.min(1, Math.sqrt(s / data.length) * 4));
    }, 66);
  };
  const stopLevel = () => { clearInterval(level); level = null; onLevel(0); };
  async function play(buf) {
    let ab;
    if (codec === "pcm") {
      const i16 = new Int16Array(buf, 0, buf.byteLength >> 1);
      ab = ctx.createBuffer(1, i16.length, rate);
      const ch = ab.getChannelData(0);
      for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
    } else {
      ab = await ctx.decodeAudioData(buf.slice(0));
    }
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(analyser);
    const when = Math.max(ctx.currentTime + 0.02, nextAt);
    src.start(when);
    nextAt = when + ab.duration;
    sources.add(src);
    src.onended = () => { sources.delete(src); if (!sources.size) { stopLevel(); onDrained(); } };
    if (first) {
      first = false;
      onFirstPlay(playStartPerfTime({ nowPerf: performance.now(), ctxCurrentTime: ctx.currentTime, startWhen: when, outputLatency: ctx.outputLatency || ctx.baseLatency || 0 }));
      startLevel();
    }
  }
  return {
    begin(c, sr) { codec = c === "mp3" ? "mp3" : "pcm"; rate = sr || 24000; first = true; nextAt = 0; },
    push(buf) { chain = chain.then(() => play(buf)).catch(() => {}); },
    flush() { for (const s of sources) { try { s.stop(); } catch {} } sources.clear(); nextAt = 0; chain = Promise.resolve(); stopLevel(); },
    get playing() { return sources.size > 0; },
  };
}
```

`bundles/kiosk/public/bird-view.js`:

```js
/** The bird: drawn by the Ramble engine with class hooks; every animation is CSS (no rAF). */
export function mountBird(container, bird, { animate = true } = {}) {
  const RB = window.RambleBird;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 200 200");
  svg.setAttribute("class", "k-bird-svg");
  svg.setAttribute("aria-hidden", "true");
  let mood = bird.mood;
  let genome = RB.rollGenome(bird.seed, bird.species);
  if (bird.outfit && typeof RB.applyOutfit === "function") genome = RB.applyOutfit(genome, bird.outfit);
  const draw = () => { svg.innerHTML = RB.drawBird(genome, mood, { hooks: true }); };
  draw();
  container.replaceChildren(svg);
  let blink = null;
  const scheduleBlink = () => {
    if (!animate) return;
    blink = setTimeout(() => {
      container.classList.add("blink");
      setTimeout(() => container.classList.remove("blink"), 160);
      scheduleBlink();
    }, 4000 + Math.random() * 5000);
  };
  scheduleBlink();
  const host = container.closest(".k-bird") || container;
  return {
    setState(s) { for (const k of ["idle", "listening", "thinking", "speaking"]) host.classList.toggle("is-" + k, k === s); },
    setLevel(v) { host.style.setProperty("--beak", String(Math.round(v * 100) / 100)); },
    setMood(m) { if (m !== mood) { mood = m; draw(); } },
    pause(p) { if (p) { clearTimeout(blink); blink = null; } else if (!blink) scheduleBlink(); },
  };
}
```

`setProperty` on `style` is CSSOM, which `style-src 'self'` allows. Only markup `style=""` attributes are blocked.

`bundles/kiosk/public/wm-view.js`:

```js
/** Window stack for small screens (spec §8.5): one visible window, a tab rail, swipe to dismiss. Text only. */
export function classifySwipe({ dx, dy, dt }) {
  if (Math.abs(dy) > Math.abs(dx)) return null;
  if (Math.abs(dx) >= 80 || (dt > 0 && Math.abs(dx) / dt > 0.5)) return dx < 0 ? "left" : "right";
  return null;
}
export function formatRemaining(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function createWindowView(root, { t = (k) => k, onDismiss = () => {}, onTap = () => {}, onCloseAll = () => {}, now = () => Date.now() } = {}) {
  const doc = root.ownerDocument;
  let wins = [];
  let tick = null;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const toTop = (id) => { const w = wins.find((x) => x.id === id); if (w) wins = [...wins.filter((x) => x !== w), w]; };

  function dismiss(id) { wins = wins.filter((w) => w.id !== id); onDismiss(id); render(); }
  function swipe(node, id) {
    let x0 = null, y0 = 0, t0 = 0, hold = null;
    const cancelHold = () => { clearTimeout(hold); hold = null; };
    node.addEventListener("pointerdown", (e) => {
      x0 = e.clientX; y0 = e.clientY; t0 = e.timeStamp;
      hold = setTimeout(() => { hold = null; x0 = null; wins = []; onCloseAll(); render(); }, 700);   // long-press = close all (spec §8.5)
    });
    node.addEventListener("pointermove", (e) => { if (hold && Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) > 12) cancelHold(); });
    node.addEventListener("pointercancel", cancelHold);
    node.addEventListener("pointerup", (e) => {
      cancelHold();
      if (x0 == null) return;
      const s = classifySwipe({ dx: e.clientX - x0, dy: e.clientY - y0, dt: e.timeStamp - t0 });
      x0 = null;
      if (s) dismiss(id);
    });
  }
  function body(w) {
    const card = el("article", `k-win k-win-${w.kind}${w.done ? " is-done" : ""}`);
    card.dataset.id = w.id;
    card.append(el("h2", "k-win-title", w.title));
    if (w.kind === "timer") {
      card.append(el("p", "k-timer", w.done ? t("timer_done") : formatRemaining(w.ends_at - now())));
    } else if (w.kind === "recipe") {
      if (w.ingredients?.length) {
        card.append(el("h3", "k-sub", t("ingredients")));
        const ul = el("ul", "k-ingredients");
        for (const i of w.ingredients) ul.append(el("li", null, i));
        card.append(ul);
      }
      card.append(el("p", "k-step-of", t("step_of").replace("{n}", String(w.step + 1)).replace("{total}", String(w.steps.length))));
      const ol = el("ol", "k-steps");
      w.steps.forEach((s, i) => ol.append(el("li", i === w.step ? "is-current" : null, s)));
      card.append(ol);
    } else {
      for (const b of w.blocks || []) {
        if (b.type === "text") card.append(el("p", null, b.text));
        else if (b.type === "list") { const ul = el("ul"); for (const i of b.items || []) ul.append(el("li", null, i)); card.append(ul); }
        else if (b.type === "card") card.append(el("div", "k-card", b.text || b.title || ""));
        else if (b.type === "divider") card.append(el("hr"));
      }
    }
    const close = el("button", "k-win-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", t("windows_close"));
    close.addEventListener("click", () => dismiss(w.id));
    card.append(close);
    swipe(card, w.id);
    return card;
  }
  function render() {
    clearInterval(tick);
    tick = null;
    root.replaceChildren();
    const top = wins[wins.length - 1];
    if (!top) { root.hidden = true; return; }
    root.hidden = false;
    if (wins.length > 1) {
      const rail = el("nav", "k-tabs");
      for (const w of wins) {
        const b = el("button", w === top ? "is-active" : null, w.title);
        b.type = "button";
        b.addEventListener("click", () => { toTop(w.id); onTap(w.id); render(); });
        rail.append(b);
      }
      root.append(rail);
    }
    root.append(body(top));
    if (top.kind === "timer" && !top.done) {
      tick = setInterval(() => { const p = root.querySelector(".k-timer"); if (p) p.textContent = formatRemaining(top.ends_at - now()); }, 1000);
    }
  }
  return {
    apply(m) {
      switch (m.action) {
        case "snapshot": wins = (m.windows || []).slice(); break;
        case "open": wins = [...wins.filter((w) => w.id !== m.window.id), m.window]; break;
        case "update": wins = wins.some((w) => w.id === m.window.id) ? wins.map((w) => (w.id === m.window.id ? m.window : w)) : [...wins, m.window]; break;
        case "close": wins = wins.filter((w) => w.id !== m.id); break;
        case "close_all": wins = []; break;
        case "focus": toTop(m.id); break;
        case "timer_done": wins = wins.map((w) => (w.id === m.id ? { ...w, done: true } : w)); toTop(m.id); break;
        default: return;
      }
      render();
    },
    list: () => wins.slice(),
    pause(p) { if (p) { clearInterval(tick); tick = null; } else render(); },
  };
}
```

- [ ] **Step 4: `kiosk.html`, `kiosk.css`, `kiosk.js`**

`bundles/kiosk/public/kiosk.html`:

```html
<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Crow Kiosk</title>
<link rel="stylesheet" href="/kiosk/assets/theme.css">
<link rel="stylesheet" href="/kiosk/assets/kiosk.css">
<script src="/kiosk/assets/bird-svg.js"></script>
<script type="module" src="/kiosk/assets/kiosk.js"></script>
</head>
<body>
<main id="app" class="k-app">
  <header class="k-top"><time id="clock" class="k-clock"></time><span id="date" class="k-date"></span></header>
  <section class="k-stage">
    <button id="bird" class="k-bird is-idle" type="button">
      <span class="k-ring" aria-hidden="true"></span>
      <span id="bird-art" class="k-bird-art"></span>
      <span class="k-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    </button>
    <div id="windows" class="k-windows" aria-live="polite" hidden></div>
  </section>
  <section id="pairing" class="k-pairing" hidden>
    <p id="pair-label" class="k-pair-label"></p>
    <p id="pair-code" class="k-pair-code"></p>
    <p id="pair-hint" class="k-pair-hint"></p>
  </section>
  <footer id="captions" class="k-captions" aria-live="polite">
    <p id="cap-user" class="k-cap-user"></p>
    <p id="cap-bot" class="k-cap-bot"></p>
  </footer>
  <button id="mic" class="k-mic" type="button"></button>
  <div id="banner" class="k-banner" role="status" hidden></div>
</main>
</body>
</html>
```

`bundles/kiosk/public/kiosk.css`:

```css
/* Crow kiosk — 800×480 landscape first, single column under 600 px. Colors from PERCH_TOKENS via theme.css (--k-*). */
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--k-sky); color: var(--k-ink); font-family: system-ui, sans-serif; font-size: 20px; line-height: 1.35; overflow: hidden; -webkit-user-select: none; user-select: none; }
button { font: inherit; color: inherit; min-height: 56px; min-width: 56px; border: 0; background: none; cursor: pointer; touch-action: manipulation; }
.k-app { display: grid; grid-template-rows: 48px 1fr auto; height: 100vh; padding: 8px 16px; gap: 8px; }
.k-top { display: flex; align-items: baseline; gap: 16px; }
.k-clock { font-size: 34px; font-weight: 700; }
.k-date { color: var(--k-dim); }
.k-stage { display: grid; grid-template-columns: 2fr 3fr; gap: 16px; min-height: 0; }
.k-bird { position: relative; display: grid; place-items: center; border-radius: 24px; background: var(--k-card); border: 1px solid var(--k-line); }
.k-bird-art, .k-bird-svg { width: min(100%, 300px); aspect-ratio: 1; display: block; }
.k-ring { position: absolute; inset: 12%; border-radius: 50%; border: 6px solid var(--k-teal); opacity: 0; }
.k-dots { position: absolute; bottom: 14%; display: flex; gap: 8px; opacity: 0; }
.k-dots i { width: 12px; height: 12px; border-radius: 50%; background: var(--k-teal); }
/* Idle breathing animates the HTML wrapper (compositor-only). CSS transforms are NEVER put on hook
   groups that carry an SVG transform attribute (rb-bird, rb-beak, rb-tail, rb-wing): CSS would replace
   the attribute and move the bird (review M3). SVG-child animation repaints on the main thread, so it
   runs only while listening/thinking/speaking, never at idle. */
.k-bird-art { will-change: transform; }
.is-idle .k-bird-art { animation: k-breath 6s ease-in-out infinite; }
.k-bird-svg .rb-head, .k-bird-svg .rb-eye, .k-bird-svg .rb-beak-lower { transform-box: fill-box; transform-origin: center; }
.k-bird-svg .rb-beak-lower { transform-origin: 0% 50%; transform: rotate(calc(var(--beak, 0) * 24deg)); }
.blink .rb-eye { transform: scaleY(0.12); }
.is-listening .rb-head { transform: rotate(-8deg); transition: transform .25s; }
.is-listening .k-ring { animation: k-pulse 1.4s ease-out infinite; }
.is-thinking .rb-head { animation: k-bob 1s ease-in-out infinite; }
.is-thinking .k-dots { opacity: 1; }
.is-thinking .k-dots i { animation: k-dot 1s ease-in-out infinite; }
.is-thinking .k-dots i:nth-child(2) { animation-delay: .15s; }
.is-thinking .k-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes k-breath { 50% { transform: scale(1.03); } }
@keyframes k-pulse { 0% { opacity: .7; transform: scale(.9); } 100% { opacity: 0; transform: scale(1.15); } }
@keyframes k-bob { 50% { transform: translateY(-4px) rotate(4deg); } }
@keyframes k-dot { 50% { opacity: .2; } }
.k-windows { min-height: 0; display: grid; grid-template-rows: auto 1fr; gap: 8px; }
.k-tabs { display: flex; gap: 8px; overflow-x: auto; }
.k-tabs button { padding: 0 16px; border-radius: 28px; background: var(--k-card); border: 1px solid var(--k-line); }
.k-tabs .is-active { background: var(--k-teal-soft); border-color: var(--k-teal); }
.k-win { position: relative; overflow: auto; padding: 16px 64px 16px 20px; border-radius: 20px; background: var(--k-card); border: 1px solid var(--k-line); touch-action: pan-y; }
.k-win-title { margin: 0 0 8px; font-size: 26px; }
.k-win-close { position: absolute; top: 4px; right: 4px; font-size: 32px; }
.k-timer { font-size: 72px; font-weight: 700; margin: 8px 0; font-variant-numeric: tabular-nums; }
.k-steps .is-current { font-weight: 700; color: var(--k-teal); }
.k-step-of, .k-sub { color: var(--k-dim); font-size: 20px; }
.k-win-timer.is-done { position: fixed; inset: 0; z-index: 10; display: grid; place-content: center; text-align: center; border-radius: 0; background: var(--k-teal); color: var(--k-card); }
.k-captions { min-height: 64px; }
.k-captions p { margin: 0; }
.k-cap-user { color: var(--k-dim); }
.k-cap-bot { font-size: 22px; }
.k-mic { position: fixed; right: 16px; bottom: 16px; min-height: 56px; padding: 0 24px; border-radius: 28px; background: var(--k-teal); color: var(--k-card); font-weight: 700; }
.k-pairing { position: fixed; inset: 0; display: grid; place-content: center; text-align: center; background: var(--k-sky); }
.k-pair-code { font-size: 96px; font-weight: 800; letter-spacing: .08em; margin: 8px 0; color: var(--k-teal); font-variant-numeric: tabular-nums; }
.k-banner { position: fixed; left: 16px; right: 16px; top: 8px; padding: 12px 16px; border-radius: 14px; background: var(--k-card); border: 2px solid var(--k-attn); }
@media (max-width: 599px) {
  .k-app { grid-template-rows: 40px auto 1fr auto; height: auto; min-height: 100vh; overflow: auto; }
  html, body { overflow: auto; }
  .k-stage { grid-template-columns: 1fr; }
  .k-bird-art, .k-bird-svg { width: min(70vw, 260px); }
  .k-captions { padding-bottom: 88px; }
}
@media (prefers-reduced-motion: reduce) { .k-bird *, .k-bird { animation: none !important; transition: none !important; } }
.no-anim .k-bird *, .no-anim .k-bird { animation: none !important; transition: none !important; }
```

`bundles/kiosk/public/kiosk.js`:

```js
/** Crow kiosk page: pairing → session → tap-to-talk. Phone-friendly (D8); Pi agent hooks arrive in K2. */
import { STRINGS } from "./strings.js";
import { closeDecision, backoffMs, micDecision, isNight, msToNextMinute } from "./state.js";
import { createVad } from "./vad.js";
import { e2eMs } from "./metrics.js";
import { openMic, createPlayer } from "./audio.js";
import { mountBird } from "./bird-view.js";
import { createWindowView } from "./wm-view.js";

const LS_DEV = "crow.kiosk.device_id";
const LS_TOK = "crow.kiosk.token";
const CAPS = { windows: ["timer", "recipe", "content"], iframe: false, max_windows: 4, agent: false };
const $ = (id) => document.getElementById(id);
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
let lang = (navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
const t = (k) => STRINGS[lang]?.[k] || STRINGS.en?.[k] || "";

let ws = null, attempt = 0, halted = false, config = {}, bird = null, wmView = null, reconnectTimer = null;
let ctx = null, mic = null, player = null, birdState = "idle", turn = null, clockTimer = null, serverOffset = 0;

function banner(key) { const b = $("banner"); b.textContent = key ? t(key) : ""; b.hidden = !key; }
function setBird(s) {
  birdState = s;
  bird?.setState(s);
  $("mic").textContent = t(s === "listening" ? "mic_stop" : s === "speaking" ? "mic_interrupt" : "mic_talk");
}
function applyTheme() { document.documentElement.dataset.theme = isNight(new Date(), config.sleep_start, config.sleep_end) ? "dark" : "light"; }
function tickClock() {
  const d = new Date();
  $("clock").textContent = d.toLocaleTimeString(lang, { hour: "numeric", minute: "2-digit" });
  $("date").textContent = d.toLocaleDateString(lang, { weekday: "short", month: "short", day: "numeric" });
  applyTheme();
  clockTimer = setTimeout(tickClock, msToNextMinute(d) + 50);
}

async function pair() {
  $("pairing").hidden = false;
  $("pair-label").textContent = t("pair_label");
  $("pair-hint").textContent = t("pair_hint");
  $("pair-code").textContent = "";
  let res;
  try {
    res = await fetch("/api/kiosk/pair/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name_hint: /Mobile|Android|iPhone/.test(navigator.userAgent) ? "Phone" : "Display" }) });
  } catch { setTimeout(pair, 5000); return; }
  if (!res.ok) { $("pair-hint").textContent = t(res.status === 429 ? "pair_busy" : "pair_error"); setTimeout(pair, 15_000); return; }
  const { pair_id, code, poll_secret } = await res.json();
  $("pair-code").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  const deadline = Date.now() + 10 * 60 * 1000;
  const poll = async () => {
    if (Date.now() > deadline) { pair(); return; }
    let r;
    try { r = await fetch(`/api/kiosk/pair/status?pair_id=${encodeURIComponent(pair_id)}`, { headers: { "X-Kiosk-Poll": poll_secret }, cache: "no-store" }); } catch { setTimeout(poll, 2000); return; }
    if (r.status === 404 || r.status === 403) { pair(); return; }
    const j = await r.json().catch(() => ({}));
    if (j.state === "approved" && j.token) { ls.set(LS_DEV, j.device_id); ls.set(LS_TOK, j.token); $("pairing").hidden = true; connect(); return; }
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
}

function scheduleReconnect(ms) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, ms); }
/** One socket at a time (review M4): events from any socket that is not the current one are ignored. */
function connect() {
  clearTimeout(reconnectTimer); reconnectTimer = null;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const id = ls.get(LS_DEV), tok = ls.get(LS_TOK);
  if (!id || !tok) { pair(); return; }
  halted = false;
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/kiosk/session`);
  ws = sock;
  sock.binaryType = "arraybuffer";
  sock.onopen = () => { if (ws === sock) sock.send(JSON.stringify({ type: "hello", device_id: id, token: tok, caps: CAPS })); };
  sock.onmessage = (ev) => { if (ws !== sock) return; if (typeof ev.data === "string") onText(JSON.parse(ev.data)); else player?.push(ev.data); };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    if (turn && !turn.ended) { turn.ended = true; mic?.stop(); }
    player?.flush();
    setBird("idle");
    const d = closeDecision(ev.code, ev.reason);
    if (d.action === "forget_token") { ls.del(LS_DEV); ls.del(LS_TOK); pair(); return; }
    if (d.action === "halt") { halted = true; banner(d.banner); return; }
    scheduleReconnect(backoffMs(attempt++));
  };
}
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function onText(m) {
  switch (m.type) {
    case "ready":
      attempt = 0; banner(null);
      config = m.display_config || {};
      if (config.lang === "en" || config.lang === "es") lang = config.lang;
      serverOffset = (m.server_now || Date.now()) - Date.now();
      mountUi();
      break;
    case "state":
      setBird(m.bird);
      if (m.bird === "idle") maybeFollowUp();
      break;
    case "transcript_final": $("cap-user").textContent = m.text || ""; $("cap-bot").textContent = ""; break;
    case "caption_delta": $("cap-bot").textContent += m.text || ""; break;
    case "tts_start": player?.begin(m.codec, m.sample_rate); break;
    case "wm": wmView?.apply(m); if (m.action === "timer_done") chime(); break;
    case "announce": $("cap-user").textContent = ""; $("cap-bot").textContent = m.text || ""; break;
    case "turn_done": if (turn && turn.id === m.turn_id) { turn.done = m; report(); } break;
    case "error":
      if (m.code === "no_bound_bot") banner("no_bot");
      else if (!m.recoverable) banner("error_generic");
      else $("cap-bot").textContent = t(`err_${m.code}`);
      break;
    default:
  }
}

function mountUi() {
  const b = config.bird || { species: "crow", seed: 0, mood: "happy" };
  const anim = config.animation !== false && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.classList.toggle("no-anim", !anim);
  bird = mountBird($("bird-art"), b, { animate: anim });
  $("bird").setAttribute("aria-label", t("mic_talk"));
  setBird("idle");
  if (!wmView) {
    wmView = createWindowView($("windows"), {
      t, now: () => Date.now() + serverOffset,
      onDismiss: (id) => send({ type: "wm_event", id, kind: "dismissed" }),
      onTap: (id) => send({ type: "wm_event", id, kind: "tapped" }),
      onCloseAll: () => send({ type: "wm_event", kind: "close_all" }),
    });
  }
  if (!clockTimer) tickClock();
  if (!$("cap-bot").textContent) $("cap-bot").textContent = t("tap_hint");
}

async function ensureAudio() {
  if (!ctx) ctx = new AudioContext({ latencyHint: "interactive" });
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
  if (!player) {
    player = createPlayer(ctx, {
      onLevel: (v) => bird?.setLevel(v),
      onFirstPlay: (at) => { if (turn && turn.playAt == null) { turn.playAt = at; report(); } },
      onDrained: () => {},
    });
  }
  if (!mic) {
    try { mic = await openMic(ctx, onFrame); } catch (err) { banner(micDecision(err, ctx.state)); return false; }
  }
  const d = micDecision(null, ctx.state);
  if (d !== "ok") { banner(d); return false; }
  banner(null);
  return true;
}

function onFrame(pcm, rms, at) {
  if (!turn || turn.ended) return;               // the worklet only posts during a turn
  if (ws && ws.readyState === 1) ws.send(pcm);
  const r = turn.vad.push(rms, at);
  if (r.end) endTurn(r.reason, r.speechEndAt);
}

async function startTurn(source) {
  if (!ws || ws.readyState !== 1) return;
  if (!(await ensureAudio())) return;
  const noSpeechMs = source === "follow_up" ? (config.follow_up_s || 6) * 1000 : 8000;
  const hangoverMs = Number(config.vad_hangover_ms) || 600;   // latency lever 1 (ruling R20)
  turn = { id: `t${Date.now()}`, source, vad: createVad({ noSpeechMs, hangoverMs }), speechEndAt: null, playAt: null, done: null, reason: null, ended: false, reported: false };
  send({ type: "turn_start", source: source === "wake" ? "wake" : "tap", turn_id: turn.id });
  mic.start(source === "wake");                   // 1.0 s pre-roll only for a wake word (spec §7.3)
  $("cap-user").textContent = "";
  $("cap-bot").textContent = "";
}
function endTurn(reason, speechEndAt) {
  if (!turn || turn.ended) return;
  turn.ended = true; turn.reason = reason; turn.speechEndAt = speechEndAt;
  mic?.stop();
  send({ type: "turn_end", vad_reason: reason });
}
function report() {
  if (!turn || turn.reported || !turn.done) return;
  const audioExpected = turn.done.timings && turn.done.timings.tts_first_chunk_ms != null && !turn.done.aborted;
  if (audioExpected && turn.playAt == null) return;
  turn.reported = true;
  send({ type: "turn_metrics", turn_id: turn.id, source: turn.source, vad_reason: turn.reason,
    e2e_ms: e2eMs({ speechEndAt: turn.speechEndAt, playAt: turn.playAt }),
    output_latency_ms: Math.round(((ctx && (ctx.outputLatency || ctx.baseLatency)) || 0) * 1000) });
}
function maybeFollowUp() {
  if (!config.follow_up || !turn || !turn.done || turn.done.aborted || turn.reason === "no_speech" || turn.source === "follow_up") return;
  startTurn("follow_up");
}
function chime() {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 880; g.gain.value = 0.15;
  o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.6);
}

async function onTap() {
  if (halted) { halted = false; banner(null); connect(); return; }
  if (birdState === "speaking" || player?.playing) { send({ type: "barge_in" }); player?.flush(); setBird("idle"); return; }
  if (turn && !turn.ended) { endTurn("manual", null); return; }
  if (birdState === "thinking") return;
  await startTurn("tap");
}
$("bird").addEventListener("click", onTap);
$("mic").addEventListener("click", onTap);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !halted && ls.get(LS_TOK)) connect(); });   // connect() is a no-op while a socket is live

$("mic").textContent = t("mic_talk");
connect();
```

`maybeFollowUp` refuses to follow up a follow-up turn, a turn with no speech, or an aborted turn. Without that, an empty room would loop forever.

- [ ] **Step 5: Run the page tests and watch them pass**

Run: `npm test -- tests/kiosk-vad.test.js tests/kiosk-page-state.test.js tests/kiosk-page.test.js tests/kiosk-routes.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bundles/kiosk/public tests/kiosk-vad.test.js tests/kiosk-page-state.test.js tests/kiosk-page.test.js
git commit bundles/kiosk/public tests/kiosk-vad.test.js tests/kiosk-page-state.test.js tests/kiosk-page.test.js -m "feat(kiosk): the page — CSS-animated bird states, tap-to-talk with energy VAD + 1 s pre-roll, AudioWorklet PCM16 capture, in-page playback, captions, window stack, latency report"
```

---
### Task 12: Dashboard panel (displays, pairing approval, settings, diagnostics), en/es strings, docs, boot check

**Files:**
- Create: `bundles/kiosk/panel/kiosk.js`, `docs/architecture/kiosk.md`, `docs/es/architecture/kiosk.md`
- Modify: `bundles/kiosk/server/strings.js` (replace the Task 10 stub), `docs/.vitepress/config.ts` (two sidebar entries)
- Test: `tests/kiosk-panel.test.js`

**Interfaces:**
- Consumes: the admin API from Task 10 (`GET /api/kiosk/admin/displays`, `POST /api/kiosk/admin/approve`, `POST/DELETE /api/kiosk/admin/displays/:id`, `GET …/:id/metrics`). The layout's fetch wrapper adds `X-Crow-Csrf` to same-origin POST/DELETE (`dashboard/shared/layout.js:463-498`).
- Produces: the panel manifest `{id:"kiosk", route:"/dashboard/kiosk", handler}`; `export const CLIENT_SCRIPT`; `STRINGS = {en, es}`.

- [ ] **Step 1: Write the failing test**

`tests/kiosk-panel.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import panel, { CLIENT_SCRIPT } from "../bundles/kiosk/panel/kiosk.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";

const SAME_OK = new Set(["brand"]);

test("strings: en/es parity — same keys, non-empty, translated, same {placeholders}", () => {
  const en = Object.keys(STRINGS.en).sort(), es = Object.keys(STRINGS.es).sort();
  assert.deepEqual(es, en);
  assert.ok(en.length >= 40);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
  for (const k of en) {
    assert.ok(STRINGS.en[k] && STRINGS.es[k], k);
    if (!SAME_OK.has(k)) assert.notEqual(STRINGS.es[k], STRINGS.en[k], `untranslated: ${k}`);
    assert.equal(ph(STRINGS.es[k]), ph(STRINGS.en[k]), `placeholders: ${k}`);
  }
});

test("panel client script lives in a template literal: no backticks, no ${", () => {
  assert.ok(!CLIENT_SCRIPT.includes("`"));
  assert.ok(!CLIENT_SCRIPT.includes("${"));
  assert.doesNotMatch(CLIENT_SCRIPT, /innerHTML/);
});

test("panel renders in the viewer's language with escaped JSON strings", async () => {
  assert.equal(panel.id, "kiosk");
  assert.equal(panel.route, "/dashboard/kiosk");
  let html = "";
  await panel.handler({ query: {} }, { send: (h) => { html = h; } }, { db: {}, lang: "es", layout: ({ title, content }) => `<title>${title}</title>${content}` });
  assert.match(html, new RegExp(STRINGS.es.panel_title));
  const json = html.match(/<script type="application\/json" id="kk-strings">([\s\S]*?)<\/script>/)[1];
  assert.ok(!json.includes("<"), "JSON block cannot close the script element");
  assert.equal(JSON.parse(json).approve, STRINGS.es.approve);
  assert.match(html, new RegExp(STRINGS.es.household_hint.slice(0, 20)));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/kiosk-panel.test.js`
Expected: FAIL — panel module not found.

- [ ] **Step 3: `bundles/kiosk/server/strings.js` (full table)**

```js
/** Kiosk strings (page + panel). en/es parity is pinned by tests/kiosk-panel.test.js. */
export const STRINGS = {
  en: {
    brand: "Crow",
    pair_label: "Pair this display",
    pair_hint: "In Crow, open Kiosk → Pair a display and type this code.",
    pair_busy: "Too many pairing requests right now. Trying again shortly.",
    pair_error: "Couldn't reach Crow. Trying again shortly.",
    tap_hint: "Tap the bird to talk.",
    mic_talk: "Tap to talk",
    mic_stop: "Done",
    mic_interrupt: "Stop",
    mic_blocked: "The microphone is blocked. Allow it in the browser settings, then reload.",
    needs_gesture: "Tap the bird to turn on sound and the microphone.",
    no_mic: "No microphone found.",
    mic_error: "The microphone didn't start. Reload to try again.",
    opened_elsewhere: "This display is open somewhere else. Tap to use it here.",
    no_bot: "This display has no assistant yet. Choose one in Crow → Kiosk.",
    error_generic: "Something went wrong. Check the display's settings in Crow.",
    err_turn_busy: "One moment — I'm still answering.",
    err_empty_transcript: "I didn't catch that.",
    err_audio_too_long: "That was too long for me. Try a shorter question.",
    err_turn_failed: "Sorry, that didn't work. Try again.",
    err_tts_error: "I couldn't speak that answer.",
    timer_done: "Time's up",
    step_of: "Step {n} of {total}",
    ingredients: "Ingredients",
    windows_close: "Close",
    panel_title: "Kiosk displays",
    panel_intro: "Displays show your bird and talk with the assistant you choose. They work only on your tailnet.",
    household_hint: "Bind a display to a household assistant with a narrow set of tools, not to your personal assistant: anyone in the room can talk to it.",
    pair_title: "Pair a display",
    pair_steps: "Open /kiosk on the display (or a phone), then type the code it shows.",
    code: "Code",
    name: "Name",
    bot: "Assistant",
    approve: "Pair",
    pending_requests: "Waiting to pair",
    requester: "From {ip}",
    no_pending: "No display is waiting. Open /kiosk on it to get a code.",
    displays: "Paired displays",
    no_displays: "No displays yet.",
    connected: "Connected",
    offline: "Offline",
    last_seen: "Last seen {when}",
    never_seen: "Never connected",
    latency: "Median {median} ms · p90 {p90} ms ({n} questions)",
    no_latency: "No timed questions yet.",
    stt: "Speech-to-text",
    tts: "Voice",
    follow_up: "Keep listening after an answer",
    memory: "Let the assistant use memories",
    memory_warn: "Anyone in the room could hear what it remembers.",
    save: "Save",
    saved: "Saved.",
    unpair: "Unpair",
    unpair_confirm: "Unpair {name}? It will need a new code.",
    diagnostics: "Diagnostics",
    diag_cols: "When · total · STT · first word · first audio · route",
    tts_missing: "Local voice (Kokoro) isn't installed. Install “Kokoro TTS (local)” from Extensions for the fastest, private voice.",
    bot_required: "Choose an assistant.",
    bad_code: "That code isn't waiting to pair. Check the display.",
    locked: "Too many wrong codes. Try again in {s} seconds.",
  },
  es: {
    brand: "Crow",
    pair_label: "Vincular esta pantalla",
    pair_hint: "En Crow, abre Kiosk → Vincular una pantalla y escribe este código.",
    pair_busy: "Hay demasiadas solicitudes de vinculación. Se intentará de nuevo en breve.",
    pair_error: "No se pudo conectar con Crow. Se intentará de nuevo en breve.",
    tap_hint: "Toca el pájaro para hablar.",
    mic_talk: "Toca para hablar",
    mic_stop: "Listo",
    mic_interrupt: "Parar",
    mic_blocked: "El micrófono está bloqueado. Permítelo en los ajustes del navegador y recarga.",
    needs_gesture: "Toca el pájaro para activar el sonido y el micrófono.",
    no_mic: "No se encontró ningún micrófono.",
    mic_error: "El micrófono no arrancó. Recarga para intentarlo de nuevo.",
    opened_elsewhere: "Esta pantalla está abierta en otro sitio. Toca para usarla aquí.",
    no_bot: "Esta pantalla aún no tiene asistente. Elige uno en Crow → Kiosk.",
    error_generic: "Algo salió mal. Revisa los ajustes de la pantalla en Crow.",
    err_turn_busy: "Un momento, todavía estoy respondiendo.",
    err_empty_transcript: "No te entendí.",
    err_audio_too_long: "Fue demasiado largo. Prueba con una pregunta más corta.",
    err_turn_failed: "Lo siento, no funcionó. Inténtalo de nuevo.",
    err_tts_error: "No pude decir esa respuesta.",
    timer_done: "Se acabó el tiempo",
    step_of: "Paso {n} de {total}",
    ingredients: "Ingredientes",
    windows_close: "Cerrar",
    panel_title: "Pantallas kiosk",
    panel_intro: "Las pantallas muestran tu pájaro y hablan con el asistente que elijas. Solo funcionan en tu tailnet.",
    household_hint: "Vincula cada pantalla a un asistente del hogar con pocas herramientas, no a tu asistente personal: cualquiera en la sala puede hablarle.",
    pair_title: "Vincular una pantalla",
    pair_steps: "Abre /kiosk en la pantalla (o en un teléfono) y escribe el código que muestra.",
    code: "Código",
    name: "Nombre",
    bot: "Asistente",
    approve: "Vincular",
    pending_requests: "Esperando vinculación",
    requester: "Desde {ip}",
    no_pending: "Ninguna pantalla está esperando. Abre /kiosk en ella para obtener un código.",
    displays: "Pantallas vinculadas",
    no_displays: "Todavía no hay pantallas.",
    connected: "Conectada",
    offline: "Desconectada",
    last_seen: "Vista por última vez {when}",
    never_seen: "Nunca se conectó",
    latency: "Mediana {median} ms · p90 {p90} ms ({n} preguntas)",
    no_latency: "Aún no hay preguntas cronometradas.",
    stt: "Voz a texto",
    tts: "Voz",
    follow_up: "Seguir escuchando después de responder",
    memory: "Permitir que el asistente use recuerdos",
    memory_warn: "Cualquiera en la sala podría oír lo que recuerda.",
    save: "Guardar",
    saved: "Guardado.",
    unpair: "Desvincular",
    unpair_confirm: "¿Desvincular {name}? Necesitará un código nuevo.",
    diagnostics: "Diagnóstico",
    diag_cols: "Hora · total · STT · primera palabra · primer audio · ruta",
    tts_missing: "La voz local (Kokoro) no está instalada. Instala “Kokoro TTS (local)” desde Extensiones para una voz más rápida y privada.",
    bot_required: "Elige un asistente.",
    bad_code: "Ese código no está esperando vinculación. Revisa la pantalla.",
    locked: "Demasiados códigos incorrectos. Inténtalo de nuevo en {s} segundos.",
  },
};
```

- [ ] **Step 4: `bundles/kiosk/panel/kiosk.js`**

```js
/**
 * Crow's Nest panel — Kiosk displays: pair (code approval), bind an assistant,
 * per-display voice + settings, unpair, latency diagnostics.
 * All user data is rendered with textContent. CLIENT_SCRIPT has NO backticks
 * and NO "${" (it sits inside a template literal; tests/kiosk-panel.test.js).
 */
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIR = [
  join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "kiosk"),
  process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "kiosk") : null,
  resolve(here, ".."),
].filter(Boolean).find((p) => existsSync(join(p, "server", "strings.js")));
const { STRINGS } = await import(pathToFileURL(join(BUNDLE_DIR, "server", "strings.js")).href);

export const CLIENT_SCRIPT = `
(function () {
  if (window.__kkRefresh) { clearInterval(window.__kkRefresh); window.__kkRefresh = null; }
  var S = JSON.parse(document.getElementById('kk-strings').textContent);
  var root = document.getElementById('kk-root');
  if (!root) return;
  function fill(s, o) { return String(s).replace(/\\{(\\w+)\\}/g, function (m, k) { return o && o[k] != null ? String(o[k]) : m; }); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function opt(sel, value, label, selected) { var o = el('option', null, label); o.value = value; if (selected) o.selected = true; sel.appendChild(o); }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); });
  }
  var state = null;

  function renderPair(data) {
    var box = document.getElementById('kk-pair'); clear(box);
    box.appendChild(el('h2', null, S.pair_title));
    box.appendChild(el('p', 'kk-dim', S.pair_steps));
    var pend = el('div', 'kk-pending');
    pend.appendChild(el('h3', null, S.pending_requests));
    if (!data.pending.length) pend.appendChild(el('p', 'kk-dim', S.no_pending));
    data.pending.forEach(function (p) {
      var row = el('p', 'kk-req');
      row.appendChild(el('strong', null, p.name_hint || '?'));
      row.appendChild(document.createTextNode(' — ' + fill(S.requester, { ip: p.ip }) + (p.login ? ' (' + p.login + ')' : '') + ' — ' + (p.ua || '').slice(0, 80)));
      pend.appendChild(row);
    });
    box.appendChild(pend);
    var form = el('form', 'kk-form');
    var code = el('input'); code.name = 'code'; code.inputMode = 'numeric'; code.autocomplete = 'off'; code.placeholder = '123 456'; code.required = true;
    var name = el('input'); name.name = 'name'; name.placeholder = S.name; name.maxLength = 64;
    var bot = el('select'); bot.name = 'bot_id'; opt(bot, '', '— ' + S.bot + ' —', true);
    data.bots.forEach(function (b) { opt(bot, b.bot_id, b.display_name || b.bot_id, false); });
    var go = el('button', 'btn btn-primary', S.approve); go.type = 'submit';
    var msg = el('p', 'kk-msg');
    [[S.code, code], [S.name, name], [S.bot, bot]].forEach(function (pair) { var l = el('label', null, pair[0]); l.appendChild(pair[1]); form.appendChild(l); });
    form.appendChild(go); form.appendChild(msg);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!bot.value) { msg.textContent = S.bot_required; return; }
      api('POST', '/api/kiosk/admin/approve', { code: code.value.replace(/\\s+/g, ''), name: name.value, bot_id: bot.value }).then(function (j) {
        if (j.ok) { code.value = ''; name.value = ''; msg.textContent = S.saved; load(); return; }
        msg.textContent = j.error === 'locked' ? fill(S.locked, { s: j.retry_after_s }) : (S[j.error] || j.error || '');
      });
    });
    box.appendChild(form);
    box.appendChild(el('p', 'kk-hint', S.household_hint));
    if (!data.tts_profiles.some(function (p) { return p.provider === 'kokoro'; })) box.appendChild(el('p', 'kk-warn', S.tts_missing));
  }

  function renderDevice(d, data) {
    var card = el('section', 'kk-card');
    var head = el('h3', null, d.name);
    head.appendChild(el('span', d.connected ? 'kk-on' : 'kk-off', d.connected ? S.connected : S.offline));
    card.appendChild(head);
    card.appendChild(el('p', 'kk-dim', d.last_seen ? fill(S.last_seen, { when: new Date(d.last_seen).toLocaleString() }) : S.never_seen));
    var lat = d.latency || {};
    card.appendChild(el('p', 'kk-lat', lat.n ? fill(S.latency, { median: lat.median_ms == null ? '>' + 3000 : lat.median_ms, p90: lat.p90_ms == null ? '>' + 3000 : lat.p90_ms, n: lat.n }) + (lat.no_audio ? ' · ' + lat.no_audio + ' ✗' : '') : S.no_latency));   // Infinity serializes as null
    var bot = el('select'); data.bots.forEach(function (b) { opt(bot, b.bot_id, b.display_name || b.bot_id, b.bot_id === d.bound_bot_id); });
    var stt = el('select'); data.stt_profiles.forEach(function (p) { opt(stt, p.id, p.name, p.id === d.stt_profile_id); });
    var tts = el('select'); data.tts_profiles.forEach(function (p) { opt(tts, p.id, p.name, p.id === d.tts_profile_id); });
    var ks = d.kiosk_settings || {};
    var fu = el('input'); fu.type = 'checkbox'; fu.checked = !!ks.follow_up;
    var mem = el('input'); mem.type = 'checkbox'; mem.checked = !!ks.memory_integration;
    [[S.bot, bot], [S.stt, stt], [S.tts, tts], [S.follow_up, fu], [S.memory, mem]].forEach(function (pair) { var l = el('label', null, pair[0]); l.appendChild(pair[1]); card.appendChild(l); });
    card.appendChild(el('p', 'kk-dim', S.memory_warn));
    var msg = el('span', 'kk-msg');
    var save = el('button', 'btn btn-primary btn-sm', S.save); save.type = 'button';
    save.addEventListener('click', function () {
      api('POST', '/api/kiosk/admin/displays/' + encodeURIComponent(d.id), { bound_bot_id: bot.value, stt_profile_id: stt.value, tts_profile_id: tts.value, kiosk_settings: { follow_up: fu.checked, memory_integration: mem.checked } })
        .then(function (j) { msg.textContent = j.ok ? S.saved : (S[j.error] || j.error || ''); });
    });
    var unpair = el('button', 'btn btn-secondary btn-sm', S.unpair); unpair.type = 'button';
    unpair.addEventListener('click', function () {
      if (!window.confirm(fill(S.unpair_confirm, { name: d.name }))) return;
      api('DELETE', '/api/kiosk/admin/displays/' + encodeURIComponent(d.id)).then(load);
    });
    var diagBtn = el('button', 'btn btn-secondary btn-sm', S.diagnostics); diagBtn.type = 'button';
    var diag = el('div', 'kk-diag');
    diagBtn.addEventListener('click', function () {
      api('GET', '/api/kiosk/admin/displays/' + encodeURIComponent(d.id) + '/metrics').then(function (j) {
        clear(diag);
        diag.appendChild(el('p', 'kk-dim', S.diag_cols));
        (j.turns || []).slice(0, 20).forEach(function (t) {
          var tm = t.timings || {};
          diag.appendChild(el('p', 'kk-row', [new Date(t.at).toLocaleTimeString(), t.e2e_ms == null ? '—' : t.e2e_ms, tm.stt_ms == null ? '—' : tm.stt_ms, tm.llm_first_token_ms == null ? '—' : tm.llm_first_token_ms, tm.tts_first_chunk_ms == null ? '—' : tm.tts_first_chunk_ms, (t.fast_path ? 'fast-path' : (t.route || '?')) + (t.degraded ? ' (' + t.degraded + ')' : '') + (t.vad_reason ? ' · ' + t.vad_reason : '')].join(' · ')));
        });
      });
    });
    var bar = el('div', 'kk-bar'); [save, diagBtn, unpair, msg].forEach(function (n) { bar.appendChild(n); });
    card.appendChild(bar); card.appendChild(diag);
    return card;
  }

  function render(data) {
    state = data;
    renderPair(data);
    var list = document.getElementById('kk-devices'); clear(list);
    list.appendChild(el('h2', null, S.displays));
    if (!data.devices.length) list.appendChild(el('p', 'kk-dim', S.no_displays));
    data.devices.forEach(function (d) { list.appendChild(renderDevice(d, data)); });
  }
  function load() { return api('GET', '/api/kiosk/admin/displays').then(function (j) { if (j.devices) render(j); }); }
  function refreshPending() {
    if (!document.getElementById('kk-root') || document.hidden) return;
    api('GET', '/api/kiosk/admin/displays').then(function (j) {
      if (!j.devices || !state) return;
      var changed = JSON.stringify(j.pending) !== JSON.stringify(state.pending) || j.devices.length !== state.devices.length;
      if (changed && !document.activeElement.closest('#kk-root form, #kk-root section')) render(j);
      else state = j;
    });
  }
  load();
  window.__kkRefresh = setInterval(refreshPending, 5000);
})();
`;

const STYLES = `
  .kk-wrap { max-width: 880px; }
  .kk-dim, .kk-hint { color: var(--crow-text-secondary); }
  .kk-warn { color: var(--crow-warning); }
  .kk-card { border: 1px solid var(--crow-border); border-radius: 14px; padding: 12px 16px; margin: 12px 0; background: var(--crow-bg-surface); }
  .kk-card h3 { display: flex; gap: 12px; align-items: baseline; margin: 0 0 4px; }
  .kk-on { color: var(--crow-success); font-size: .85rem; } .kk-off { color: var(--crow-text-muted); font-size: .85rem; }
  .kk-card label, .kk-form label { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  .kk-bar { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .kk-form { display: grid; gap: 4px; max-width: 420px; }
  .kk-form input[name=code] { font-size: 1.4rem; letter-spacing: .15em; width: 9ch; }
  .kk-row { font-family: ui-monospace, monospace; font-size: .8rem; margin: 2px 0; }
`;

export default {
  id: "kiosk",
  name: "Kiosk",
  icon: "monitor",
  route: "/dashboard/kiosk",
  navOrder: 56,
  category: "hardware",
  async handler(req, res, { layout, lang }) {
    const L = STRINGS[lang] ? lang : "en";
    const S = STRINGS[L];
    const json = JSON.stringify(S).replace(/</g, "\\u003c");
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const content = `
      <style>${STYLES}</style>
      <div id="kk-root" class="kk-wrap">
        <h1>${esc(S.panel_title)}</h1>
        <p class="kk-dim">${esc(S.panel_intro)}</p>
        <div id="kk-pair" class="kk-card"></div>
        <div id="kk-devices"></div>
      </div>
      <script type="application/json" id="kk-strings">${json}</script>
      <script>${CLIENT_SCRIPT}<\/script>`;
    res.send(layout({ title: S.panel_title, content }));
  },
};
```

The panel `handler` reads `{layout, lang}`. The dashboard passes `lang` (`dashboard/index.js:900-903`).

- [ ] **Step 5: Docs (en + es) and sidebar**

`docs/architecture/kiosk.md`:

```markdown
# Kiosk display

A paired browser — a phone today, a Raspberry Pi 3 with a 7" touchscreen next — shows your Ramble bird and talks with the Crow assistant you bind to it. Crow does all the work: speech-to-text, the assistant's turn, text-to-speech. The browser only captures audio after a tap and plays the reply.

**Design:** `docs/superpowers/specs/2026-10-03-crow-kiosk-companion-design.md`. **K1 plan:** `docs/superpowers/plans/2026-10-03-kiosk-k1-page-and-voice.md`.

## Pieces
- `bundles/kiosk/` — the bundle: page (`public/`), routes + WebSocket (`server/runtime.js`, `server/session.js`), pairing (`server/pairing.js`), windows (`server/wm.js`), MCP tools (`server/server.js`), dashboard panel (`panel/kiosk.js`).
- `servers/gateway/voice/turn.js` — the transport-free voice turn (bound bot, routing with an 8 s cold fallback, think gate, barge-in, memory stripped by default).
- `servers/shared/device-store.js` — paired devices (`device_kind: kiosk`), token hashes only.

## Network and auth
- Tailnet only: `https://<host>:8444/kiosk`. Never Funnel (`/kiosk`, `/api/kiosk` are not public prefixes; the router and the WebSocket upgrade also refuse a Funnel header).
- Pairing: the display shows a 6-digit code; an owner approves it in **Kiosk → Pair a display** and picks the assistant. The display collects its token once with a poll secret.
- The device token is accepted only in the session's first `hello` frame — never in a URL, never by any other route.
- MCP tools reach live sessions through loopback-only `/api/kiosk/internal/*` with `$CROW_HOME/kiosk-announce-token`.

## Voice services
- Speech-to-text: the Faster-Whisper bundle (loopback :8004); the kiosk adds a `distil-small.en` profile at first pairing.
- Voice: the Kokoro TTS bundle (loopback :8880) when installed.

## Privacy
- Nothing is sent before a tap. No audio is stored; transcripts live only in the display's short in-memory conversation (15 min).
- Memories are off by default on a display (`memory_integration`).
```

`docs/es/architecture/kiosk.md`: the same structure translated. Keep file paths and code identifiers in English:

```markdown
# Pantalla kiosk

Un navegador vinculado —hoy un teléfono, después una Raspberry Pi 3 con pantalla táctil de 7"— muestra tu pájaro de Ramble y habla con el asistente de Crow que le asignes. Crow hace todo el trabajo: voz a texto, el turno del asistente y texto a voz. El navegador solo capta audio después de un toque y reproduce la respuesta.

**Diseño:** `docs/superpowers/specs/2026-10-03-crow-kiosk-companion-design.md`. **Plan K1:** `docs/superpowers/plans/2026-10-03-kiosk-k1-page-and-voice.md`.

## Piezas
- `bundles/kiosk/` — el paquete: página (`public/`), rutas + WebSocket (`server/runtime.js`, `server/session.js`), vinculación (`server/pairing.js`), ventanas (`server/wm.js`), herramientas MCP (`server/server.js`), panel (`panel/kiosk.js`).
- `servers/gateway/voice/turn.js` — el turno de voz independiente del transporte (asistente vinculado, enrutado con respaldo en frío de 8 s, filtro de razonamiento, interrupción, recuerdos desactivados por defecto).
- `servers/shared/device-store.js` — dispositivos vinculados (`device_kind: kiosk`), solo hashes de tokens.

## Red y autenticación
- Solo tailnet: `https://<host>:8444/kiosk`. Nunca Funnel.
- Vinculación: la pantalla muestra un código de 6 dígitos; la persona propietaria lo aprueba en **Kiosk → Vincular una pantalla** y elige el asistente. La pantalla recoge su token una sola vez con un secreto de sondeo.
- El token del dispositivo solo se acepta en el primer mensaje `hello` de la sesión: nunca en una URL ni en otra ruta.
- Las herramientas MCP llegan a las sesiones por `/api/kiosk/internal/*` (solo loopback) con `$CROW_HOME/kiosk-announce-token`.

## Servicios de voz
- Voz a texto: el paquete Faster-Whisper (loopback :8004); el kiosk añade un perfil `distil-small.en` en la primera vinculación.
- Voz: el paquete Kokoro TTS (loopback :8880) cuando está instalado.

## Privacidad
- No se envía nada antes de un toque. No se guarda audio; las transcripciones solo viven en la conversación en memoria de la pantalla (15 min).
- Los recuerdos están desactivados por defecto en una pantalla (`memory_integration`).
```

In `docs/.vitepress/config.ts`, add `{ text: 'Kiosk display', link: '/architecture/kiosk' },` directly after the `/architecture/companion` entry (line ~318). Add `{ text: 'Pantalla kiosk', link: '/es/architecture/kiosk' },` directly after `/es/architecture/companion` (line ~129).

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npm test -- tests/kiosk-panel.test.js tests/i18n-global-parity.test.js`
Expected: PASS.

- [ ] **Step 7: Boot check — the branch gateway mounts the kiosk (throwaway home, loopback bind, 60 s)**

```bash
H=$(mktemp -d); export CROW_HOME=$H CROW_DATA_DIR=$H/data CROW_APP_ROOT=$PWD PORT=13901 CROW_GATEWAY_BIND=127.0.0.1 \
  CROW_DISABLE_MODEL_ORCHESTRATION=1 CROW_DISABLE_INSTANCE_SYNC=1 CROW_DISABLE_NOSTR=1 CROW_AUTO_UPDATE=0 CROW_DISABLE_BOT_RUNTIME=1 CROW_DISABLE_NTFY_AUTOWIRE=1
unset CROW_DB_PATH
node scripts/init-db.js >/dev/null
mkdir -p $H/panels $H/bundles && cp -r bundles/kiosk $H/bundles/kiosk
cp bundles/kiosk/panel/kiosk.js $H/panels/kiosk.js && cp bundles/kiosk/panel/routes.js $H/panels/kiosk-routes.js && echo '["kiosk"]' > $H/panels.json
ln -s $PWD/node_modules $H/panels/node_modules          # what the installer does (bundles.js "Ensure panels dir can resolve gateway dependencies"); express/ws resolve from here
timeout 60 node servers/gateway/index.js > $H/gw.log 2>&1 &
sleep 10
TS='Tailscale-User-Login: boot-check@local'   # what Serve adds; bare loopback is refused by isAllowedNetwork
curl -s -o /dev/null -w "%{http_code}\n" -H "$TS" http://127.0.0.1:13901/kiosk
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:13901/kiosk
curl -s -X POST -H "$TS" -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:13901/api/kiosk/pair/start; echo
grep -iE "kiosk" $H/gw.log | head
```

Expected:
- `200`, then `403` (bare loopback);
- a `{"pair_id":…,"code":"NNNNNN",…}` JSON;
- `[panel] kiosk routes mounted`, `[panel] kiosk WebSocket handler mounted` and `[kiosk] announce token minted` in the log.

The gateway binds 127.0.0.1 only and exits after 60 s.

- [ ] **Step 8: Commit**

```bash
git add bundles/kiosk/panel/kiosk.js docs/architecture/kiosk.md docs/es/architecture/kiosk.md tests/kiosk-panel.test.js
git commit bundles/kiosk/panel/kiosk.js bundles/kiosk/server/strings.js docs/architecture/kiosk.md docs/es/architecture/kiosk.md docs/.vitepress/config.ts tests/kiosk-panel.test.js -m "feat(kiosk): dashboard panel (pair approval, assistant binding, voice + settings, unpair, latency diagnostics), en/es strings, docs"
```

---
### Task 13: Full local gates + PRE-MERGE attended smoke on crow (registered window, deadman) — LIVE

**What it proves before anything merges (spec §12 K1 exit gate, §13.2 A1–A3):**
1. A phone pairs with a 6-digit code and the bird appears (A1).
2. 20 scripted questions give a fast-route **median < 2.0 s and p90 < 3.0 s** end of speech → first audio, measured on the phone (A2). If not, the plan's levers are applied in order and reported.
3. A timer and a recipe open, the recipe swipes away, and "close the timer" closes it on the fast path (A3).
4. Live: bird states, barge-in, announce/show through the internal API and the MCP tool, unpair → 4401, and the device token refused everywhere else.

**Touches** (prod is never stopped, and no model container is touched):
- a **scratch gateway** run from `~/crow-wt-kiosk-k1` (transient user unit `kiosk-smoke-gw`, `RuntimeMaxSec=7200`, `127.0.0.1:13001`, scratch `CROW_HOME`), with model orchestration, sync, nostr, bot runtime, Perch and ntfy autowire all OFF;
- a scratch faster-whisper (`crow-kiosk-smoke-stt`, `127.0.0.1:18004`, the Task 5 compose = pinned 0.5.0-cpu, 8g cap, `restart: "no"`);
- a scratch Kokoro (`crow-kiosk-smoke-tts`, `127.0.0.1:18880`, v0.9.0, 4g cap, `restart: "no"`);
- temporary Serve **8462** → `127.0.0.1:13001`, tailnet only.

The resident 4B (`100.118.41.122:8011`) is used as a client. The scratch gateway cannot start or stop any model. An escalated turn probes `:8003` and falls back after 8 s.

**Ports:** `13001`, `18004`, `18880` and Serve `8462` are free (checked 2026-10-03; Step 2 re-checks). They are scratch-only and never committed, so `port-allocation.md` is unchanged.

**Sudo:** Serve only. Use `sudo -S` with the credential from the global CLAUDE.md. Never write it to a file or to this plan.

**Every step starts with** `source /tmp/claude-1000/kiosk-smoke/vars.sh`.

**Findings** go in `$SMOKE/findings.md`. The final report is copied to `~/crow-weekend-push/reports/2026-10-0X-kiosk-k1-smoke.md` (spec §13.2). Any FAIL that needs code means a fix commit with its unit test, plus a re-run of the affected step in a new registered window, before Task 14.

**Files:** none in the repo.

- [ ] **Step 1: Full local gates (no live host involved)**

```bash
cd ~/crow-wt-kiosk-k1 && git fetch origin && git rebase origin/main
npm test 2>&1 | tail -15                                       # full suite in the scratch env: 0 fail
node scripts/check-port-allocation.js && echo PORTS-OK
node scripts/build-registry.mjs --check && echo REGISTRY-OK
npm audit --omit=dev --audit-level=critical; echo "audit exit=$?"
git log origin/main..HEAD --format='%an %ae%n%b' | grep -ci 'claude\|co-authored' ; echo "(must be 0)"
```

Expected: the suite passes with 0 failures, `PORTS-OK`, `REGISTRY-OK`, audit exit 0, and `0` attribution lines.

- [ ] **Step 2: Check, register, write helpers, snapshot prod, arm the deadman**

```bash
cat ~/CROW-SCHEDULE.md | sed -n '/## Reservations/,/## Standing/p' | head -40      # no window overlapping this slot
node ~/crow/scripts/ops/box-reserve.mjs status                                       # no box hold (a hold is fine, but note it: escalations will degrade)
curl -s -m 5 http://100.118.41.122:8011/v1/models | grep -q qwen3.5-4b && echo "4B resident" || echo "4B NOT resident — do not start"
for p in 13001 18004 18880; do ss -ltn | grep -qE ":$p\b" && echo "$p BUSY" || echo "$p free"; done
tailscale serve status | grep -q ':8462' && echo "8462 BUSY" || echo "8462 free"
docker ps -a --format '{{.Names}}' | grep -E '^crow-kiosk-smoke' && echo "stale smoke containers: run teardown first" || echo clean
```

Add the Reservations row to `~/CROW-SCHEDULE.md`. It must be timestamped, and the last column is a condition:

```markdown
| **2026-10-0X (Day) HH:MM → +2 h hard cap (attended; transient units kiosk-smoke-{gw,deadman}; deadman tears down at the cap)** | **Crow kiosk K1 PRE-MERGE smoke** (plan Task 13): scratch gateway from feat/kiosk-k1 on 127.0.0.1:13001 (scratch CROW_HOME; model orchestration, sync, nostr, bot runtime, ntfy autowire OFF), scratch faster-whisper 0.5.0-cpu 127.0.0.1:18004 (8g cap) + scratch Kokoro v0.9.0 127.0.0.1:18880 (4g cap), temp Serve 8462 (tailnet only). Uses the RESIDENT 4B (:8011) as a client; never starts/stops a model; no GPU job. Prod gateway + prod whisper untouched. | Claude session (crow) + Kevin | manual | no crow-kiosk-smoke* containers AND `systemctl --user list-units 'kiosk-smoke-*'` empty AND serve 8462 off AND row moved to Done |
```

Then:

```bash
SMOKE=/tmp/claude-1000/kiosk-smoke; rm -rf $SMOKE; mkdir -p $SMOKE; chmod 700 $SMOKE
cat > $SMOKE/vars.sh <<'EOF'
# Sourced at the top of EVERY smoke step.
SMOKE=/tmp/claude-1000/kiosk-smoke
REPO=$HOME/crow-wt-kiosk-k1
NODE=$HOME/.nvm/versions/node/v24.21.0/bin/node
unset CROW_DB_PATH CROW_BACKUP_DIR                       # nothing may point at prod
export CROW_HOME=$SMOKE/home CROW_DATA_DIR=$SMOKE/data CROW_APP_ROOT=$REPO PORT=13001 CROW_GATEWAY_PORT=13001 CROW_GATEWAY_BIND=127.0.0.1 \
  CROW_AUTO_UPDATE=0 CROW_DISABLE_INSTANCE_SYNC=1 CROW_DISABLE_NOSTR=1 CROW_DISABLE_MODEL_ORCHESTRATION=1 CROW_DISABLE_BOT_RUNTIME=1 \
  CROW_DISABLE_NTFY_AUTOWIRE=1 CROW_DISABLE_HEALTH_MONITOR=1 CROW_DISABLE_PERCH=1 \
  CROW_EXTERNAL_ENGINE_POLL_MS=0 CROW_BOX_RESERVATION_PATH=$SMOKE/box-reservation.json   # as run-suite.mjs sets them
TS='Tailscale-User-Login: smoke@local'
SW="docker compose -p crow-kiosk-smoke-stt -f $REPO/bundles/faster-whisper-server/docker-compose.yml -f $SMOKE/stt.override.yml"
ST="docker compose -p crow-kiosk-smoke-tts -f $REPO/bundles/kokoro-tts/docker-compose.yml -f $SMOKE/tts.override.yml"
EOF
cat > $SMOKE/stt.override.yml <<'EOF'
services:
  faster-whisper-server:
    container_name: crow-kiosk-smoke-stt
    restart: "no"
    ports: !override
      - "127.0.0.1:18004:8000"
EOF
cat > $SMOKE/tts.override.yml <<'EOF'
services:
  kokoro-tts:
    container_name: crow-kiosk-smoke-tts
    restart: "no"
    ports: !override
      - "127.0.0.1:18880:8880"
EOF
cat > $SMOKE/teardown.sh <<'EOF'
#!/usr/bin/env bash
source /tmp/claude-1000/kiosk-smoke/vars.sh
systemctl --user stop kiosk-smoke-gw.service 2>/dev/null
$SW down -v --remove-orphans 2>/dev/null
$ST down -v --remove-orphans 2>/dev/null
docker ps -aq --filter name=crow-kiosk-smoke | xargs -r docker rm -f 2>/dev/null
echo "teardown done $(date +%T). Serve 8462 needs: sudo tailscale serve --https=8462 off (the deadman cannot sudo; a stale mapping only 502s, tailnet-only)" >> /tmp/claude-1000/kiosk-smoke/teardown.log
EOF
chmod +x $SMOKE/teardown.sh
source $SMOKE/vars.sh
docker inspect -f '{{.Id}} {{.State.StartedAt}} {{.Config.Image}}' faster-whisper-server > $SMOKE/prod-whisper-before.txt
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/health > $SMOKE/prod-health-before.txt
tailscale serve status > $SMOKE/serve-before.txt
systemd-run --user --unit=kiosk-smoke-deadman --on-active=7200 /bin/bash $SMOKE/teardown.sh
systemctl --user list-timers kiosk-smoke-deadman.timer
```

- [ ] **Step 3: Scratch STT + TTS up; check them against the spec's §9 estimates**

```bash
source /tmp/claude-1000/kiosk-smoke/vars.sh
$SW up -d && $ST up -d
for i in $(seq 1 90); do curl -fsS http://127.0.0.1:18004/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:18880/v1/audio/voices >/dev/null 2>&1 && break; sleep 2; done
curl -s -o $SMOKE/tts.pcm -w "kokoro first-sentence synth: %{time_total}s\n" -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","input":"Lisbon is the capital of Portugal.","voice":"af_heart","response_format":"pcm"}' http://127.0.0.1:18880/v1/audio/speech
ls -l $SMOKE/tts.pcm                                                          # > 0 bytes (24 kHz s16le)
cd $REPO && $NODE --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { wrapPcmAsWav } from "./servers/gateway/voice/turn-helpers.js";
writeFileSync(process.env.SMOKE + "/q.wav", wrapPcmAsWav(readFileSync(process.env.SMOKE + "/tts.pcm"), 24000));'
for n in 1 2 3; do curl -s -o $SMOKE/stt$n.json -w "distil-small.en STT run $n: %{time_total}s\n" -F file=@$SMOKE/q.wav -F model=Systran/faster-distil-whisper-small.en -F language=en http://127.0.0.1:18004/v1/audio/transcriptions; done
cat $SMOKE/stt3.json; echo
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' crow-kiosk-smoke-stt crow-kiosk-smoke-tts
```

Expected:
- Kokoro produces PCM in roughly 0.2–0.6 s (spec estimate 200–300 ms; record the real number).
- STT runs 2 and 3 take roughly 0.3–0.6 s (spec estimate 300–500 ms), and run 1 is no slower than the others by more than the preload saves. This proves `PRELOAD_MODELS` worked.
- The transcript reads "Lisbon is the capital of Portugal."
- Both containers are under their caps.

Write all the numbers to `findings.md`. If STT run 1 is several seconds, the preload did not happen. That is a FAIL of ruling R6's compose: fix it and re-run this step.

- [ ] **Step 4: Scratch home — install the kiosk, seed providers, voice profiles, a household bot, a dashboard password**

```bash
source /tmp/claude-1000/kiosk-smoke/vars.sh
cd $REPO && $NODE scripts/init-db.js >/dev/null
mkdir -p $CROW_HOME/panels $CROW_HOME/bundles && cp -r bundles/kiosk $CROW_HOME/bundles/kiosk
cp bundles/kiosk/panel/kiosk.js $CROW_HOME/panels/kiosk.js && cp bundles/kiosk/panel/routes.js $CROW_HOME/panels/kiosk-routes.js
ln -s $REPO/node_modules $CROW_HOME/panels/node_modules   # mirrors the installer; without it the copied routes cannot import express/ws (review M2)
echo '["kiosk"]' > $CROW_HOME/panels.json
$NODE --input-type=module -e '
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const { createDbClient } = await import("./servers/db.js");
const { writeSetting } = await import("./servers/gateway/dashboard/settings/registry.js");
const { setPassword } = await import("./servers/gateway/dashboard/auth.js");
const db = createDbClient();
// Mirrors of prod rows (read-only copy of id/base_url/models; NO bundle_id, so nothing here could ever manage them).
await db.execute({ sql: "INSERT INTO providers (id, base_url, host, models) VALUES (?,?,?,?)", args: ["crow-voice", "http://100.118.41.122:8011/v1", "local", JSON.stringify([{ id: "qwen3.5-4b", contextLen: 8192 }])] });
await db.execute({ sql: "INSERT INTO providers (id, base_url, host, models) VALUES (?,?,?,?)", args: ["crow-chat", "http://100.118.41.122:8003/v1", "local", JSON.stringify([{ id: "qwen3.6-35b-a3b" }])] });
await writeSetting(db, "stt_profiles", JSON.stringify([{ id: "fw", name: "Faster-Whisper (smoke)", provider: "fasterwhisper", apiKey: "", baseUrl: "http://localhost:18004/v1", defaultModel: "Systran/faster-whisper-large-v3", language: "", isDefault: true }]));
await writeSetting(db, "tts_profiles", JSON.stringify([{ id: "kk", name: "Kokoro (smoke)", provider: "kokoro", apiKey: "", baseUrl: "http://localhost:18880/v1", defaultVoice: "af_heart", isDefault: true }]));
const house = { display_name: "House", system_prompt: "You are House, the friendly voice of the family kitchen display. Answer in one or two short sentences.", fast_voice_model: "crow-voice/qwen3.5-4b", tools: { crow_mcp: [] }, permission_policy: {} };
await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)", args: ["house", "House", JSON.stringify(house)] });
const pw = randomBytes(12).toString("base64url") + "A1!";
await setPassword(pw);
writeFileSync(process.env.SMOKE + "/dash-pass", pw, { mode: 0o600 });
console.log("seeded"); process.exit(0);'
```

The seed carries no Ramble tables, so the bird is the default crow. Step 7 covers a dressed bird.

- [ ] **Step 5: Start the scratch gateway (transient unit, 2 h cap) and the temporary Serve**

```bash
source /tmp/claude-1000/kiosk-smoke/vars.sh
ENVS=""; for v in CROW_HOME CROW_DATA_DIR CROW_APP_ROOT PORT CROW_GATEWAY_PORT CROW_GATEWAY_BIND CROW_AUTO_UPDATE CROW_DISABLE_INSTANCE_SYNC CROW_DISABLE_NOSTR CROW_DISABLE_MODEL_ORCHESTRATION CROW_DISABLE_BOT_RUNTIME CROW_DISABLE_NTFY_AUTOWIRE CROW_DISABLE_HEALTH_MONITOR CROW_DISABLE_PERCH CROW_EXTERNAL_ENGINE_POLL_MS CROW_BOX_RESERVATION_PATH; do ENVS="$ENVS -E $v=${!v}"; done
# env -u INVOCATION_ID: systemd-run sets it, and the gateway would then believe it is supervised by crow-gateway.service (review m6)
systemd-run --user --unit=kiosk-smoke-gw -p RuntimeMaxSec=7200 --working-directory=$REPO $ENVS /usr/bin/env -u INVOCATION_ID $NODE servers/gateway/index.js
sleep 12
journalctl --user -u kiosk-smoke-gw -o cat | grep -E "kiosk|Crow Gateway listening|ERROR" | head
curl -s -o /dev/null -w "page %{http_code}\n" -H "$TS" http://127.0.0.1:13001/kiosk
ls -l $CROW_HOME/kiosk-announce-token
sudo tailscale serve --bg --https=8462 http://127.0.0.1:13001
tailscale serve status | grep -A2 ':8462'                     # "(tailnet only)" — never Funnel
grackle "curl -s -o /dev/null -w '%{http_code}\n' https://crow.dachshund-chromatic.ts.net:8462/kiosk"          # from a REAL remote node: 200
grackle "curl -s -o /dev/null -w '%{http_code}\n' https://crow.dachshund-chromatic.ts.net:8462/api/kiosk/internal/displays -H 'Authorization: Bearer x'"   # 403 loopback_only (Serve adds X-Forwarded-For)
```

Expected:
- the log shows `[panel] kiosk routes mounted`, `[panel] kiosk WebSocket handler mounted`, `[kiosk] announce token minted` and `Crow Gateway listening on http://127.0.0.1:13001`;
- `page 200`, and the token file is mode 600;
- Serve 8462 is tailnet only;
- the remote checks return `200` and `403`.

If grackle is unreachable (it is mid-decommission), use any other tailnet node, e.g. `ssh raven`. Do not test from crow itself.

- [ ] **Step 6: [KEVIN] A1 — pair the phone**

1. [KEVIN] On the phone (on the tailnet), open `https://crow.dachshund-chromatic.ts.net:8462/kiosk`. A 6-digit code appears.
2. [KEVIN] On a laptop, open `https://crow.dachshund-chromatic.ts.net:8462/dashboard/kiosk`. Claude gives the scratch dashboard password from `$SMOKE/dash-pass`, in the terminal only. Check that "Waiting to pair" shows the phone's tailnet IP, login and user agent. Type the code and a name ("Kevin's phone"), pick **House**, then **Pair**.
3. [KEVIN] The phone shows the bird (the default crow) and "Tap the bird to talk". **Tap the bird once.** This creates the AudioContext and grants the microphone (allow it).

Evidence: the `[kiosk] paired kiosk-… "Kevin's phone" → bot house (requester 100.…)` log line, and a phone screenshot saved to `$SMOKE/a1.png`.

- [ ] **Step 7: [KEVIN] A2 — the 20 scripted questions (latency gate)**

```bash
source /tmp/claude-1000/kiosk-smoke/vars.sh
date -Is > $SMOKE/a2-start.txt
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' crow-kiosk-smoke-stt faster-whisper-server    # note any prod transcription running (CPU contention, spec §7.3)
cd $REPO && $NODE -e 'import("./bundles/kiosk/server/questions.js").then(m => m.LATENCY_QUESTIONS.forEach((q, i) => console.log(String(i + 1).padStart(2), q)))'
```

[KEVIN] Ask the 20 questions in order, at a normal voice from arm's length. Tap the bird, ask, and wait for the whole answer before the next tap. Do not tap during an answer.

Then compute the gate from the server log. The last 20 eligible turns are the 20 questions:

```bash
source /tmp/claude-1000/kiosk-smoke/vars.sh
journalctl --user -u kiosk-smoke-gw --since "$(cat $SMOKE/a2-start.txt)" -o cat | grep '^\[kiosk-metrics\] ' | sed 's/^\[kiosk-metrics\] //' > $SMOKE/a2.jsonl
# Cross-check: every phone tap must have a metrics row. Compare against the Diagnostics turn list (server rows incl. those with no client metrics);
# a row with route=fast, tts_first_chunk_ms set and NO e2e/vad_reason counts as a FAILURE (Infinity) in the A2 verdict, never as excluded.
cd $REPO && $NODE --input-type=module -e '
import { readFileSync } from "node:fs";
import { median, percentile } from "./bundles/kiosk/server/metrics.js";
const rows = readFileSync(process.env.SMOKE + "/a2.jsonl", "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
// Same rule as metrics.summary: degraded (cold-fallback) turns are excluded; an eligible turn with NO audio counts as Infinity (a failure).
const ok = (r) => r.route === "fast" && !r.fast_path && !r.escalated && !r.degraded && !r.aborted && r.vad_reason === "silence";
const bad = rows.filter((r) => !ok(r));
// A fast-route turn that sent audio but never got turn_metrics back (playback/decode failure, disconnect) is a FAILURE too.
const journal = process.env.SMOKE + "/a2-turns.jsonl";   // server-side turn_done rows, see the grep below
const use = rows.filter(ok).slice(-20);
const s = (k) => use.map((r) => (k === "e2e_ms" ? r.e2e_ms : r.timings?.[k])).filter(Number.isFinite).sort((a, b) => a - b);
const e = use.map((r) => (Number.isFinite(r.e2e_ms) ? r.e2e_ms : Infinity)).sort((a, b) => a - b);
console.log(JSON.stringify({ turns: rows.length, eligible: use.length, no_audio: e.filter((x) => x === Infinity).length, excluded: bad.map((r) => ({ id: r.turn_id, route: r.route, fast_path: r.fast_path, escalated: r.escalated, degraded: r.degraded, vad: r.vad_reason })),
  e2e: { median: median(e), p90: percentile(e, 90), min: e[0], max: e.at(-1) },
  server_median: { stt_ms: median(s("stt_ms")), llm_first_token_ms: median(s("llm_first_token_ms")), tts_first_chunk_ms: median(s("tts_first_chunk_ms")) },
  output_latency_ms: median(use.map((r) => r.output_latency_ms).filter(Number.isFinite).sort((a, b) => a - b)) }, null, 1));
console.log(use.length === 20 && median(e) < 2000 && percentile(e, 90) < 3000 ? "A2 PASS" : "A2 FAIL (or fewer than 20 eligible: re-ask the excluded ones)");'
```

Validity rules (ruling R8):
- Only eligible turns count: fast route, not a fast path, not escalated, **not degraded**, not aborted, `vad_reason=silence`.
- An eligible turn that produced **no audio counts as a failure** (Infinity), never a gap.
- An excluded question (escalated/degraded/fast-path/VAD cap) is **re-asked**, and the number of re-asks is reported. **More than 3 re-asks** for routing reasons is itself a FAIL: the fast route is not holding for plain questions. Rows are never patched.
- The breakdown (STT / first token / first audio on the server, plus `output_latency_ms`) goes into `findings.md` next to the spec §9 estimates.
- If a prod transcription was running (the `docker stats` line), say so in the report.
- Cross-check: the panel's Diagnostics "Median … p90 …" for the phone must equal this computation.

**If A2 FAILS, apply the levers in spec order, one at a time, re-running the full 20 after each:**

- **Lever 1 (VAD hangover 450 ms):**

  ```bash
  source /tmp/claude-1000/kiosk-smoke/vars.sh
  J=$SMOKE/cj; curl -s -c $J -b $J -H "$TS" --data-urlencode "password=$(cat $SMOKE/dash-pass)" http://127.0.0.1:13001/dashboard/login -o /dev/null
  CSRF=$(awk '$6=="crow_csrf"{print $7}' $J); DEV=$(curl -s -b $J -H "$TS" http://127.0.0.1:13001/api/kiosk/admin/displays | $NODE -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).devices[0].id))')
  curl -s -b $J -H "$TS" -H "X-Crow-Csrf: $CSRF" -H 'Content-Type: application/json' -d '{"kiosk_settings":{"vad_hangover_ms":450}}' http://127.0.0.1:13001/api/kiosk/admin/displays/$DEV
  ```

  [KEVIN] reloads the phone page, then asks the 20 again.
- **Lever 2 (smaller STT model):** set the kiosk profile's model to `Systran/faster-whisper-tiny.en` in the scratch DB:

  ```bash
  cd $REPO && $NODE --input-type=module -e 'const { createDbClient } = await import("./servers/db.js"); const R = await import("./servers/gateway/dashboard/settings/registry.js"); const db = createDbClient(); const l = JSON.parse(await R.readSetting(db, "stt_profiles")); l.find((p) => p.id === "kiosk-stt-distil-small-en").defaultModel = "Systran/faster-whisper-tiny.en"; await R.writeSetting(db, "stt_profiles", JSON.stringify(l)); process.exit(0)'
  ```

  Profiles are read per turn, so no restart is needed. Warm it first with one STT call, as in Step 3. If this lever is the one that passes, Task 14's production profile change is a **[KEVIN] decision** (tiny.en is less accurate). STT on the GPU is a separate GPU-window plan, not this smoke.
- **Lever 3 (pre-synthesized acknowledgement):** not built in K1. Record A2 FAIL with all three runs' numbers, stop the smoke (teardown), and bring the numbers to Kevin. **Do not merge.**

Write which lever was used, or "none", to `findings.md`. The PR body carries it (spec §9).

- [ ] **Step 8: [KEVIN] A3 windows, bird states, barge-in; announce/show; dressed bird**

1. [KEVIN] "Set a timer for 2 minutes called tea." Expected: a timer window with "Tea 1:5x" counting down and the spoken "Timer set for Tea: 2 minutes." It runs on the **fast path**: the `[kiosk-metrics]` row has `fast_path:true` and no LLM call is made. If STT words it differently and it falls to the LLM, the route is logged, so record the transcript.
2. [KEVIN] "Show me a lasagna recipe." Expected: a recipe window (title, ingredients, numbered steps). Then "next step" is a fast path: no LLM in the log, and "Step 2. …" is spoken.
3. [KEVIN] Swipe the recipe left. It is gone; the log shows `wm_event dismissed`, and the server window list no longer has it.
4. [KEVIN] "Close the timer." It closes on the fast path: "Timer stopped." with no LLM call in the log.
5. [KEVIN] Watch the bird through one question: breathing at idle, head tilt plus ring while listening, bob plus dots while thinking, beak moving while speaking. Screenshot each state if possible (`$SMOKE/a3-*.png`).
6. [KEVIN] Barge-in: ask "Tell me a long story about a crow." and tap during the answer. Audio stops at once, and the next `[kiosk-metrics]` row has `"aborted":true`.
7. Timer done: [KEVIN] "Set a timer for 10 seconds called test." After ~10 s the full-screen "Time's up" card, the chime and the spoken "Test timer is done." appear.
8. Announce + show through the internal API and through the MCP tool (Claude):

   ```bash
   source /tmp/claude-1000/kiosk-smoke/vars.sh
   curl -s -H "Authorization: Bearer $(cat $CROW_HOME/kiosk-announce-token)" -H 'Content-Type: application/json' -d '{"text":"Smoke test announcement."}' http://127.0.0.1:13001/api/kiosk/internal/announce; echo
   cd $REPO && $NODE --input-type=module -e '
   import { Client } from "@modelcontextprotocol/sdk/client/index.js";
   import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
   const t = new StdioClientTransport({ command: process.execPath, args: ["bundles/kiosk/server/index.js"], env: { ...process.env } });
   const c = new Client({ name: "smoke", version: "0" }); await c.connect(t);
   console.log((await c.callTool({ name: "crow_kiosk_list_displays", arguments: {} })).content[0].text);
   console.log((await c.callTool({ name: "crow_kiosk_show", arguments: { title: "Groceries", body: "- milk\n- eggs" } })).content[0].text);
   await c.close();'
   ```

   Expected: the phone shows and speaks "Smoke test announcement."; the tool lists the phone as connected; a "Groceries" content window opens.
9. Dressed bird: create Ramble tables in the scratch DB with a hatched magpie wearing `{"scarf":"knit","glasses":"round"}` and energy 40 (use `initRambleTables` + the two INSERTs from `tests/kiosk-routes.test.js`). [KEVIN] reloads the phone. The magpie appears tired, with a scarf and glasses, and its beak still opens while it speaks.

- [ ] **Step 9: Live token-scope spot checks (spec §10/§13.1) and unpair**

```bash
source /tmp/claude-1000/kiosk-smoke/vars.sh
cd $REPO && TOK=$($NODE --input-type=module -e 'const { createDbClient } = await import("./servers/db.js"); const S = await import("./servers/shared/device-store.js"); const { token } = await S.pairDevice(createDbClient(), { id: "kiosk-scope", name: "scope", device_kind: "kiosk" }); console.log(token); process.exit(0)')
for path in /router/mcp /llm/v1/chat/completions /api/notifications /dashboard /api/kiosk/admin/displays; do
  printf "%-28s " $path; curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "$TS" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:13001$path
done
$NODE --input-type=module -e '
import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:13001/api/kiosk/session?device_id=kiosk-scope&token=" + process.argv[1], { headers: { "Tailscale-User-Login": "smoke@local" } });
ws.on("close", (c, r) => { console.log("url-token ws closed", c, String(r)); process.exit(0); });' "$TOK"
```

Expected:
- no route returns 200 for the kiosk token (401/403, or 302 to the login page for `/dashboard`);
- the URL-token WS closes with `4401 hello_timeout`.

Note on `/llm/v1`: it accepts **any** tailnet/loopback caller by design, bearer or not (`llm-router.js` sourceGate). With the Serve header it may return a model response. That is not the kiosk token being accepted, and the line is recorded as "n/a: route is source-gated, not token-gated". Rerun that one call without `Authorization` to show the identical status.

Then [KEVIN] in the scratch dashboard: **Unpair** "Kevin's phone". The phone drops back to a fresh pairing code (close 4401 `unpaired`) and does not loop.

- [ ] **Step 10: Teardown, verify prod untouched, close the window**

```bash
source /tmp/claude-1000/kiosk-smoke/vars.sh
bash $SMOKE/teardown.sh
sudo tailscale serve --https=8462 off
systemctl --user stop kiosk-smoke-deadman.timer 2>/dev/null
systemctl --user list-units 'kiosk-smoke-*' --no-legend; echo "(empty expected)"
docker ps -a --format '{{.Names}}' | grep crow-kiosk-smoke; echo "(none expected)"
diff <(tailscale serve status) $SMOKE/serve-before.txt && echo "SERVE MAP IDENTICAL"
docker inspect -f '{{.Id}} {{.State.StartedAt}} {{.Config.Image}}' faster-whisper-server | diff - $SMOKE/prod-whisper-before.txt && echo "PROD WHISPER UNTOUCHED"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/health                  # same as prod-health-before.txt
```

Move the schedule row to Done, with the outcome. Copy `findings.md` plus the A2 JSON and the screenshots to `~/crow-weekend-push/reports/2026-10-0X-kiosk-k1-smoke.md`. Keep `$SMOKE` until the PR merges, then delete it: it holds the scratch dashboard password.

---

### Task 14: PR, CI, merge, deploy window (prod whisper recreate + Kokoro + kiosk install), post-deploy acceptance

**Preconditions:** Task 13 A1–A3 PASS, with the A2 lever recorded. If lever 2 was what passed, Kevin has decided the production STT model.

- [ ] **Step 1: Rebase, full suite, push**

```bash
cd ~/crow-wt-kiosk-k1 && git fetch origin && git rebase origin/main
npm test 2>&1 | tail -5
git push -u origin feat/kiosk-k1
```

- [ ] **Step 2: Open the PR** with the GitHub MCP tool (`gh` is not installed on crow): `mcp__github__create_pull_request` with owner `kh0pper`, repo `crow`, head `feat/kiosk-k1` and base `main`. Title: `feat(kiosk): K1 — kiosk page + server-side voice loop (phone-tested)`. The body contains:
  - the spec and plan paths;
  - the rulings R1–R20, one line each;
  - the A1–A3 evidence;
  - the A2 numbers (median, p90, breakdown) and the lever used;
  - the deploy steps below.

  It has **no Claude attribution and no co-author lines**.

- [ ] **Step 3: CI**

Wait for every check-run on the head sha to be `completed`/`success`:

```bash
SHA=$(git rev-parse HEAD); curl -s https://api.github.com/repos/kh0pper/crow/commits/$SHA/check-runs | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.total_count, j.check_runs.map(r=>r.name+":"+r.status+"/"+r.conclusion).join(" "))})'
```

Expected: `suite`, `static-checks` and `audit` are all `completed/success`. An empty list means something is wrong, not pending-normal (CLAUDE.md).

- [ ] **Step 4: Merge**

Merge once CI is green. Under the standing autonomy grants (2026-07-11 merge + deploy; 2026-09-22 autonomous cycles) this needs no extra prompt, and Kevin can veto in the PR. Use `mcp__github__merge_pull_request` with the squash method. **Do not** merge on a red or empty check-run list (`enforce_admins`).

- [ ] **Step 5: Deploy window — register first, deadman-guarded**

Run it at a quiet time with no meeting recording in progress. The R4 meeting recorder uses prod whisper:

```bash
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' faster-whisper-server        # idle (< 5 %) before starting
```

Register this row in `~/CROW-SCHEDULE.md`:

```markdown
| **2026-10-0X HH:MM → +45 min hard cap (attended; deadman kiosk-deploy-deadman restores the previous whisper compose if prod STT is unhealthy)** | **Crow kiosk K1 deploy**: pull ~/crow main; recreate prod faster-whisper from the pinned compose (same image digest; adds TTL -1, distil-small preload, 8g cap) — glasses/meeting-recorder STT down ≤ 2 min; restart crow-gateway; [KEVIN] install Kokoro TTS + Kiosk display from Extensions. No GPU, no model containers. | Claude session (crow) + Kevin | manual | prod whisper healthy on 0.5.0-cpu with both models loaded AND kokoro-tts healthy AND /kiosk 200 via :8444 AND auto_update_last_result not "Skipped" AND row moved to Done |
```

Then:

```bash
D=/tmp/claude-1000/kiosk-deploy; mkdir -p $D; chmod 700 $D
cd ~/crow && git status --short | head -3; git rev-parse --abbrev-ref HEAD          # MUST be main
git pull --ff-only origin main                                                     # auto-update (6 h) may already have pulled it; either way
MERGE=$(git log --format=%H -1 --grep='feat(kiosk): K1' origin/main)
git show "$MERGE^":bundles/faster-whisper-server/docker-compose.yml > $D/whisper-old.yml   # the compose prod runs today (pre-merge)
grep -n 'image:' $D/whisper-old.yml                                                # latest-cpu = the same digest as 0.5.0-cpu
cat > $D/restore.sh <<'EOF'
#!/usr/bin/env bash
# Deadman: if prod whisper is not healthy, put the previous compose back.
curl -fsS -m 5 http://127.0.0.1:8004/health >/dev/null && { echo "whisper healthy, nothing to restore $(date +%T)" >> /tmp/claude-1000/kiosk-deploy/deadman.log; exit 0; }
cd /home/kh0pp/crow/bundles/faster-whisper-server && docker compose -p faster-whisper-server -f /tmp/claude-1000/kiosk-deploy/whisper-old.yml up -d
echo "restored previous whisper compose $(date +%T)" >> /tmp/claude-1000/kiosk-deploy/deadman.log
EOF
chmod +x $D/restore.sh
systemd-run --user --unit=kiosk-deploy-deadman --on-active=2700 /bin/bash $D/restore.sh
```

- [ ] **Step 6: Recreate prod whisper (same image, new env + cap), verify both models**

```bash
cd ~/crow/bundles/faster-whisper-server && docker compose up -d          # project name = dir name = faster-whisper-server (matches the existing container's labels)
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8004/health >/dev/null 2>&1 && break; sleep 2; done
docker inspect -f '{{.Config.Image}} {{.HostConfig.Memory}}' faster-whisper-server        # fedirz/faster-whisper-server:0.5.0-cpu 8589934592
docker exec faster-whisper-server printenv WHISPER__TTL PRELOAD_MODELS
# Measure the 8g cap instead of assuming it (review m7): a ~5-minute clip through large-v3 while sampling memory.
for i in $(seq 1 40); do cat /tmp/claude-1000/kiosk-smoke/tts.pcm; done > /tmp/claude-1000/kiosk-deploy/long.pcm
cd ~/crow && node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; import { wrapPcmAsWav } from "./servers/gateway/voice/turn-helpers.js"; writeFileSync("/tmp/claude-1000/kiosk-deploy/long.wav", wrapPcmAsWav(readFileSync("/tmp/claude-1000/kiosk-deploy/long.pcm"), 24000));'
( for i in $(seq 1 120); do docker stats --no-stream --format '{{.MemUsage}}' faster-whisper-server; sleep 1; done ) > /tmp/claude-1000/kiosk-deploy/mem.log &
curl -s -o /dev/null -w "long clip large-v3: %{time_total}s\n" -F file=@/tmp/claude-1000/kiosk-deploy/long.wav -F model=Systran/faster-whisper-large-v3 http://127.0.0.1:8004/v1/audio/transcriptions
wait; sort -h /tmp/claude-1000/kiosk-deploy/mem.log | tail -1                 # peak; must be < 6 GiB, else raise mem_limit in a follow-up commit before closing the window
curl -s -o /dev/null -w "distil warm: %{time_total}s\n" -F file=@/tmp/claude-1000/kiosk-smoke/q.wav -F model=Systran/faster-distil-whisper-small.en -F language=en http://127.0.0.1:8004/v1/audio/transcriptions
curl -s -w "\nlarge-v3 (glasses/meeting default): %{time_total}s\n" -F file=@/tmp/claude-1000/kiosk-smoke/q.wav -F model=Systran/faster-whisper-large-v3 http://127.0.0.1:8004/v1/audio/transcriptions
```

Expected:
- the image is unchanged and the cap is 8 GiB;
- the env is set;
- both models transcribe the test clip correctly. The first large-v3 call pays its one load, and later ones stay warm (TTL -1).

If `q.wav` was deleted with the smoke dir, regenerate it as in Task 13 Step 3.

- [ ] **Step 7: Restart the gateway; [KEVIN] install Kokoro + Kiosk; verify**

```bash
sudo systemctl restart crow-gateway        # sudo -S with the credential from the global CLAUDE.md; never stored in a file
sleep 15; journalctl -u crow-gateway --since "-2 min" -o cat | grep -iE "kiosk|error" | head
cat ~/.crow/bundles/ramble/manifest.json | grep version                    # 0.13.1 (bundle repair refreshed the installed copy)
```

[KEVIN] In Crow's Nest → Extensions, install **Kokoro TTS (local)**. Its install job pulls `v0.9.0` and seeds the "Kokoro (local)" TTS profile. Then install **Kiosk display** and restart when prompted.

```bash
docker inspect -f '{{.Config.Image}} {{.HostConfig.Memory}}' kokoro-tts                     # ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0 4294967296
curl -s -o /dev/null -w "kiosk page via Serve: %{http_code}\n" https://crow.dachshund-chromatic.ts.net:8444/kiosk
grackle "curl -s -o /dev/null -w '%{http_code}\n' https://crow.dachshund-chromatic.ts.net:8444/kiosk"     # 200 from a remote node
tailscale funnel status 2>/dev/null | grep -i kiosk; echo "(no kiosk path on Funnel expected)"
sqlite3 -readonly ~/.crow/data/crow.db "select value from dashboard_settings where key='auto_update_last_result'"   # must NOT be "Skipped: not on main"
```

- [ ] **Step 8: [KEVIN] Post-deploy acceptance on prod (short)**

1. [KEVIN] Open `https://crow.dachshund-chromatic.ts.net:8444/kiosk` on the phone. Pair in **Kiosk** (prod dashboard) and bind a household assistant. Kevin picks or creates one; a bot with a narrow tool selection is recommended (panel copy).
2. [KEVIN] Ask three of the scripted questions. Diagnostics shows them at a median in line with the smoke.
3. [KEVIN] "Set a timer for 1 minute called check". It opens and rings.

Then clear the deadman (`systemctl --user stop kiosk-deploy-deadman.timer`), move the schedule row to Done, and delete `/tmp/claude-1000/kiosk-smoke` (scratch password).

- [ ] **Step 9: Register the new standing automation (global rule; ruling R14)**

A kiosk escalation can now start the 35B on demand: `maybeAcquireLocalProvider(…, {requester:"kiosk"})`. Add it to the **Standing Automations** table in `~/CROW-SCHEDULE.md`:

```markdown
| **crow gateway — kiosk voice turn (bundle `kiosk`)** | an escalated kiosk turn (tool intent / recent non-display tool context) | may START crow-chat (35B) on demand via the orchestrator, requester `kiosk`; the turn falls back to the resident 4B after 8 s and never waits for the start; refused (no start) under a box reservation or serving-class veto |
```

- [ ] **Step 10: Fleet check after auto-update reaches the other instances (core changes are fleet-wide)**

The device-store move, the `llm-router` refactor and the Bot Builder unbind helper reach every instance on its next auto-update (6 h). After that pull, check the one instance with meta-glasses installed (grackle, while it lives) and a Bot Builder device-binding save:

```bash
grackle "systemctl status crow-gateway --no-pager 2>/dev/null | head -3; systemctl --user status crow-gateway --no-pager 2>/dev/null | head -3"   # find whether it is a system or user unit first
grackle "cd ~/crow && git log -1 --format=%h && (journalctl -u crow-gateway --since '-30 min' -o cat 2>/dev/null; journalctl --user -u crow-gateway --since '-30 min' -o cat 2>/dev/null) | grep -iE 'meta-glasses|device-store|ERR' | tail -5"
grackle 'sqlite3 -readonly ~/.crow/data/crow.db "select value from dashboard_settings where key = '"'"'meta_glasses_devices'"'"'" | grep -o "\"bound_bot_id\":[^,]*"'    # bindings unchanged vs before the pull
```

If glasses pairing or a glasses voice turn is available there, run one glasses voice turn ([KEVIN] if the glasses are at hand); otherwise record that only the static checks ran. If grackle is already retired, record "n/a — no meta-glasses instance".

Follow-ups to record in the PR (not built here):
- K2 Pi bring-up (ruling R17: tagged-node caveat);
- K3 HA + Today + sleep + the companion→kiosk migration (R1) + OLLV retirement;
- K4 cameras;
- glasses switched to `servers/gateway/voice/turn.js`;
- unbuffered TTS streaming (R15).

---

## Self-Review (run by the plan author, 2026-10-03)

**Spec coverage (K1 row of §12):**
- core device-store move + throttle + `kiosk` kind → Task 1 (the migration is deferred, R1);
- `voice/turn.js` → Tasks 3–4;
- `chooseVoiceRoute` → Task 2;
- the bundle (panel, routes, session WS, pairing, MCP tools, announce token) → Tasks 7, 9, 10, 12;
- the page (bird states, captions, tap-to-talk, `crow_wm` v2: timer/content/recipe, swipe, fast paths, server window state) → Tasks 8 and 11;
- bird hooks (Ramble bump) → Task 6;
- kiosk STT profile + Kokoro → Task 5 + Task 14 (Kevin Q2);
- latency instrumentation → Tasks 9 and 11;
- hermetic tests → every task;
- the exit gate → Task 13.

§13.1 items that are not K1 belong to their own phases: HA, Today/notifications, wake word. §13.1 "kiosk token 401 on /api/notifications, /router/mcp, /llm/v1, /dashboard" is covered live in Task 13 Step 9, and hermetically for every kiosk-owned route in Task 10.

**Placeholder scan:** none.
- `2026-10-0X`/`HH:MM` in the schedule rows are filled at run time by design: the window's date is not known now.
- Sudo lines name the credential's source (the global CLAUDE.md) and never carry it.

**Type consistency:** `runVoiceTurn` opts/result, `createWmTool`, `matchWmFastPath`, `kioskPromptSuffix`, `createSessionHub` deps, `createKioskRuntime` deps, and the `turn_metrics` fields (`turn_id`, `e2e_ms`, `vad_reason`, `output_latency_ms`, `source`) were cross-checked between Tasks 4, 8, 9, 10 and 11.

**Review Focus:** five conditions, each with its pinned test in the owning task.

**Dry-run of the plan's own code (2026-10-03, after the review revision):** every complete file in this plan was materialized onto a throwaway detached worktree of `origin/main` @ `24759696` and run with `scripts/run-suite.mjs`:
- `voice-turn-helpers`, `voice-turn`, `kiosk-pairing`, `kiosk-wm`, `kiosk-session`, `kiosk-vad`, `kiosk-page-state`, `device-store` and `kiosk-panel`: **76/76 pass**;
- `kiosk-page`, `kiosk-routes` (real `ws` and the real core `readPortrait`), `device-store` and `kiosk-session`: **39/39**;
- `bundle-server-deps` + `bundle-contract` with the kiosk manifest: **83/83**.

Not dry-run: the partial snippets (`bird-svg.cjs`, `llm-router.js`, `local-token.js`, the Bot Builder edits) and the tests that need them.

**Adversarial review (opus, 2026-10-03): REVISE → revised.**
- C1 (late system message) → R22.
- C2 (prefix-forgeable hash) → R2 (separate field + sentinel).
- C3 (`crow_delegate`) → R21.
- M1 (two failing tests) → fixed.
- M2 (`panels/node_modules`) → symlinked in the boot check and smoke.
- M3 (bird CSS) → wrapper-only idle animation + CSS test.
- M4 (reconnect race) → single-socket guard.
- M5 (gate validity) → degraded excluded, no-audio = failure, re-ask cap, routing view.
- M6 (context/prefix cache) → clamp + `turnContext`.
- M7 (Bot Builder unbind) → `unbindBotFromOtherDevices`.
- M8 (standing automation, timer fast path) → Task 14 Step 9 + fast path.
- Minors: rate key by Tailscale identity, `complete()` check, pre-roll in the worklet, long-press close-all, smoke env flags + `INVOCATION_ID`, measured whisper cap, fleet check, last-20 summary, non-vacuous tests, R19 wording.
- Not taken: `getOutputTimestamp()`. The bias is stated in R8 instead.

**Scoped re-review: APPROVE.** C1–C3 and M1–M8 are verified resolved. Its four new minors are folded in: the panel renders no-audio failures instead of "null ms"; a turn missing client metrics counts as a failure in A2; `est_prompt_tokens`/`max_tokens` are logged per turn; the fleet check detects the grackle unit type.

## Execution handoff

Recommended: **subagent-driven** (superpowers:subagent-driven-development). There are 14 tasks with explicit interfaces, and two of them change shared core (`device-store`, `llm-router`) with fleet-wide reach on auto-update, so a fresh per-task reviewer is worth the cost. Tasks 13–14 are attended and are run by the orchestrating session itself, with Kevin.
