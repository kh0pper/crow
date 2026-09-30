# pi-lab reply: local models and residency for the phone-call agent (2026-09-30)

Answers `pi-lab/docs/handoffs-inbox-2026-09-30-from-crow-assistant-calls.md`. Facts below are measured today unless marked **(unmeasured)** or **(vendor claim)**.

## One correction to the brief

Raven's production Flash-Next is no longer halogen. Since 2026-09-30 13:40, `flash-next.service` on raven:8030 runs **gufo** (MIT HIP engine) from our YaRN branch, at 409,600 context with MTP and vision. The served model id is unchanged (`qwen3.8-flash-next`). Halogen is kept only as a rollback.

## Measured today: turn latency and tool calls, the two resident candidates

Script: `pi-lab/scripts/call-agent-latency-probe.py`.
- **Prompt shape:** call-agent system prompt (plan, limits, shareable info, rules) plus the five spec tools and one turn from the other party. That is about 920 prompt tokens, streaming, thinking off (`chat_template_kwargs.enable_thinking=false`), temp 0.7.
- **Scenarios:** 6, each sent twice (rep 1 repeats the exact prompt, so it measures a prefix-cache hit).
- **Load:** both endpoints were otherwise idle.

| | Flash-Next, gufo, raven:8030 | Qwen3.6-35B-A3B, llama.cpp Vulkan, crow:8003 |
|---|---|---|
| TTFT, cold prefix (first send) | median 1.16 s (0.30-4.01) | median 0.85 s (0.75-1.48) |
| TTFT, warm prefix (repeat) | 0.01 s (tool calls 0.42 s) | 0.06 s (tool calls 0.18 s) |
| First sentence (when TTS could start), warm | 0.14-0.36 s | 0.13-0.39 s |
| Correct action, 12 requests | 9/12 | 7/12 |

**The main finding is the difference between cold and warm.** A call can fit the ~900 ms budget only while each turn reuses the cached prefix: the system prompt, the tools and the transcript so far. A cold prefill of about 1k tokens already costs about 1 s on either model, before STT and TTS. Any other request that uses the same server slot between turns evicts that prefix.

**Tool-call reliability is not good enough on either model to ship on vibes.** The sample is small (n=2 per scenario), but the failure modes are specific:
- **Spanish IVR menu ("para citas, oprima el 1"): both models failed 2/2.**
  - Flash-Next wrote a *malformed* tool call as plain text: `<tool_call><function=press_digits>1</parameter>…`, with the `<parameter=digits>` tag missing, so the server did not parse it.
  - The 35b once wrote `<end_call outcome="info" …>` as text, and once just talked.
  - English IVR was 4/4 on both.
- **Offer within limits → `record_booking`:** both often said "That works" without calling the tool. That may be prompt design as much as the model (see recommendations).
- **Out-of-limits offer → `needs_owner`:** Flash-Next 2/2, the 35b 1/2.

**Safety consequence for the spec:** assistant text that contains tool-call markup must **never reach TTS**. Filter `<tool_call`, `<function`, `</parameter` and similar out of the spoken stream. When you see it, run a repair parse, and if that fails, re-ask the model with no audio. Otherwise the agent reads markup aloud to a business.

## 1. LLM recommendation

**Pick: Qwen3.6-35B-A3B in a DEDICATED call instance on crow.**
- **Settings:** same GGUF as prod (`Qwen3.6-35B-A3B-UD-Q5_K_XL`), llama.cpp with the prod image (`vulkan-radv-mtp`), MTP draft n-max 2, `-np 1`.
- **Context: 16384.** A 20-minute call is about 3k words of transcript, roughly 4-5k tokens, plus about 1k system and tools, plus tool results.
- **KV cache:** f16. At 16k it costs little, and community reports tie quantized KV to tool-call breakage on this model family.
- **Prefix caching:** `cache_prompt` on (the default).

Why this and not the alternatives:
- **Not raven's Flash-Next (gufo), for now.** It has no TTFT advantage at call-sized prompts: gufo's large prefill lead is at long depth, and a call prompt is about 1-5k tokens. Its decode is 40-47 t/s against the 35b's about 75 with MTP; both are ample for 1-2 sentence replies. Three things make it the wrong host for a real-time call:
  - raven prod is **one session** (`--sessions 1`), shared with pi and the Blender judge. A call turn would queue behind a pi agent turn that can run for minutes, and its prefix would be evicted.
  - raven is **evicted for benchmark windows** on a regular basis.
  - gufo issue #266 (open) reports Flash-Next tool calls returning as prose, and today's malformed Spanish call matches it.
- **Not the shared prod 35b on :8003.** It is the same model, but bots and pi hit it directly (pi's `localModels` bypasses the gateway), so the call's warm prefix is not guaranteed. A burst of bot traffic mid-call costs a cold prefill plus queueing.
- **Not the 27b.** Decode is 14-17 t/s on llama.cpp. On gufo with DFlash2 it measured about 35 t/s on raven; crow numbers come tonight. Either way its TTFT is worse than a 3B-active MoE.
- **Cloud `qwen3.8-flash` stays the fallback** when the local call model is not admissible (see §2).

**Open items:**
- **Memory (unmeasured):** does a second 26 GB 35b co-reside with crow's prod set (35b + embed + 4b vLLM + on-demand 27b copilot)? If it does not fit, the fallback design is a **gateway lease on the prod 35b** for the call's duration, capped at 20 min: other consumers degrade to the 4b or cloud, and pi's direct :8003 use must learn to respect the lease. pi-lab will measure both.
- **Load time (unmeasured):** start the call instance at plan **approval**, not at dial, and warm it with the system prompt and tools before dialing. The first turn then pays for only the new tokens.
- **Model choice is not final** until the scripted eval (§4) runs. Candidates:
  - this 35b;
  - **Ornith-1.5-35B-A3B**, an RL post-train of the same base with claimed tool-use gains, but many user reports of broken tool calls and looping (vendor claim / unverified);
  - Flash-Next on gufo;
  - cloud `qwen3.8-flash` as the baseline.

## 2. Guaranteed residency

Today **nothing protects a live call**, and I verified two specifics:
- `pi-lab/scripts/dsv4-window.sh` (every crow benchmark window) **overwrites the box-reservation file unconditionally** (`reservation_open` does `mv -f`). It then stops **every** model container, including anything `alwaysResident`. A call-owner hold would simply be clobbered.
- raven windows (`scripts/two-box/raven-prod.sh`) read nothing on crow at all.

So `serving.class` / `alwaysResident` alone is not enough. That guards against the *orchestrator*, not against windows. My recommendation uses three pieces:

1. **A call lease, honored by windows.** crow-phone takes a lease (`owner: call-<id>`, `expires_at = now + 20 min + margin`) through `box-reserve` or a sibling lease file. **pi-lab changes its window tools to refuse to start while a call lease exists**: they wait, bounded, then skip the window rather than abort the call. This covers dsv4-window.sh, raven-prod.sh evict and the Engram queue launcher, which uses the crow GPU for training and has its own memory guard. pi-lab owns that change.
2. **Admission check before dialing.** Refuse, or fall back to cloud, if any of these holds:
   - a window reservation is active;
   - a window timer fires within 25 min (pi-lab will expose one query for "seconds until the next scheduled window", instead of crow parsing `CROW-SCHEDULE.md`);
   - the call model is not healthy after the warm-up request.
3. **Run the call model on crow, not raven.** The phone, BlueZ/oFono, PipeWire and Pipecat all live on crow. Raven is full: its prod holds about 98 GiB of GTT and it is evicted for windows too. Raven only makes sense if we later give it a second gufo session for calls, which is unmeasured memory.

## 3. STT / TTS on gfx1151

**pi-lab has no latency measurements for STT/TTS on this hardware yet.** crow's only speech model today is faster-whisper large-v3 on CPU, for the meeting recorder, which is batch and not timed. What exists:

- **gufo Qwen3-ASR-1.7B** (native gfx1151, separate `gufo serve asr` process):
  - OpenAI `/v1/audio/transcriptions` plus a **Realtime WebSocket** (`/v1/realtime?intent=transcription`) with committed utterances and a per-session `language`.
  - gufo's own numbers: a 15 s clip in 0.99 s (RTF 0.066). Text generation dominates, so short-utterance latency is probably lower **(unmeasured)**.
  - No segment timestamps (`verbose_json` returns empty `segments`). That is fine for a call agent, and a blocker only for the meeting recorder.
  - Spanish support is Qwen's claim **(vendor claim)**.
  - Narrowband 8 kHz CVSD accuracy: **unmeasured for every candidate.** gufo resamples to 16 kHz, which adds no information.
- **gufo Qwen3-TTS-12Hz-1.7B:**
  - **First streamed PCM audio 0.201 s**, RTF 0.39. Real-time capable.
  - CustomVoice (preset speakers), VoiceDesign (voice from a text description) and Base (voice clone from a reference clip).
  - Language is auto by default. Spanish quality is not verified by us.
  - GPU, about 2 GiB. It runs serialized with ASR in its own process.
- **Kokoro-82M on CPU:** known to be fast and keeps the GPU free. Its Spanish voices are thinner than English. No crow numbers.

**My recommendation:** don't lock STT or TTS into the spec yet. Define them as a pluggable interface and let a bake-off on **real narrowband call audio** pick the engines:
- **STT:** faster-whisper turbo on CPU vs Qwen3-ASR on gufo (plus Moonshine as the CPU fallback). Measure time to final transcript after end of speech, and WER in EN and ES.
- **TTS:** Kokoro vs Qwen3-TTS. Measure time to first audio, and quality judged by Kevin.

The ROCm CTranslate2 build is a community package and needs Kevin's approval to install.

## 4. What pi-lab will own

1. **Scripted call eval (first).** Extend today's probe into multi-turn EN/ES call scripts:
   - IVR trees, a receptionist, hold then resume, voicemail, an out-of-limits offer, "don't call again", and a callee trying to extract information outside the shareable list.
   - It scores the correct tool, correct arguments, zero spoken markup, policy adherence and per-turn latency with the prefix growing like a real call.
   - It runs against the candidates in §1. It also tests the prompt fixes suggested by today's misses: state the IVR rule in the call's language, and require `record_booking` *before* agreeing.
2. **Residency guard:** windows honor the call lease, plus the next-window query for admission (§2).
3. **Memory and load measurement** of a dedicated call 35b co-resident with crow's prod set, plus the lease fallback if it does not fit.
4. **STT/TTS bake-off** on narrowband EN/ES audio (§3). We need a few recorded test calls through the Pixel 9a/oFono path, or 8 kHz CVSD-simulated audio as a stand-in.
5. **End-to-end turn-latency harness** once crow-phone has a loopback path (VAD end of speech → first TTS audio).
6. **Schedule entries:**
   - these runs are short and mostly day-safe (a few requests against idle models);
   - the dedicated-instance memory test and the bake-off go in registered night windows in `~/CROW-SCHEDULE.md`;
   - the next crow GPU windows are the 27b gufo test tonight (09-30 21:15) and the 35b rebuild Thursday night.

**Suggested edit to spec §4:**
- LLM = dedicated local call instance (Qwen3.6-35B-A3B, llama.cpp, 16k, f16 KV, MTP), started at approval and warmed before dialing, with cloud `qwen3.8-flash` fallback. Final model pending pi-lab's call eval.
- Residency = call lease honored by all windows, plus an admission check (no active or imminent window, model healthy).
- STT and TTS pluggable, chosen by the bake-off.
- Spoken-stream markup filter is **mandatory**.

## Update, 2026-09-30 evening: the gufo tool-call failure is fixed in raven prod

The Spanish IVR failure above (Flash-Next writing `<function=press_digits>\n1\n</parameter>` with no opening parameter tag, so the call was dropped and the markup came back as `content`) is the malformed-call shape tracked under gufo #266. The maintainer's open PR **gufo-org/gufo#324** constrains tool-call decoding once a call starts. We tested it on raven with identical flags:

| | prod before (9abedf6) | 9abedf6 + #324 |
|---|---|---|
| Spanish IVR → `press_digits` | 0/10 (markup leaked as text) | 10/10 |
| English IVR | 10/10 | 10/10 |
| All six call scenarios | 9/12 | 12/12 |
| Warm time to first tool-call delta | 0.43 s | 0.46 s |

**Raven prod now runs 9abedf6 + #324** (`~/gufo-prod/9abedf6-pr324-c873a8a`, since 17:21; compat 7/7, pi smoke 3/3, call probe 23/24 over two runs; the one miss was the "offer" turn answering "That works" without `record_booking`, the prompt-design point in §4). Test results were posted on the PR: https://github.com/gufo-org/gufo/pull/324#issuecomment-5920730244. When #324 and our YaRN PR #350 merge, prod moves to upstream main.

What this changes for the spec and what it does not:

- **The spoken-stream markup filter stays mandatory.** #324 fixes gufo; the call instance recommended in §1 is llama.cpp (the 35b wrote `<end_call …>` as text in the same test), and a cloud fallback can fail the same way.
- **The §1 recommendation is unchanged.** Raven prod is still one session shared with pi and gets evicted for windows, so it is still not the real-time call host. It does make Flash-Next on gufo a stronger candidate in the scripted call eval, and a reasonable non-real-time tool worker (post-call summaries, booking extraction).
- Related gufo issues still open and worth a look if you target gufo later: #304 (raw newlines in JSON arguments leak the same way; maintainer fix in progress) and #273 (long-context thinking-on turns that end without a call because reasoning uses up `max_tokens`; keep `enable_thinking: false` on call turns).
