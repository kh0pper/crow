# Research: agentic assistant actions (calls, bookings), 2026-09-30

This is input to the "assistant actions" arc, whose first sub-project is outbound business calls. The findings come from three research passes on 2026-09-30: a commercial survey, an open-source stack survey, and a map of existing Crow capabilities. Labels mean: **[P]** verified on a primary/vendor page; **[S]** secondary source only.

## 1. Commercial landscape

| Product | Calls businesses | Hold / IVR | Booking | Consent / disclosure | Status |
|---|---|---|---|---|---|
| **Meta Muse** (launched 2026-09-08, runs on the Muse Spark model) | Yes: haircuts, reservations, stock checks, quotes. Returns transcript + summary | n/r | Phone + web (forms, travel, checkout via Stripe Link) | Asks before sensitive actions; audit trail; per-app scopes; a "Sentinel" agent gates all outbound traffic; per-user secure VM | US, 18+. Free / $20 / $100 tiers. Some calls were quietly routed to human contractors; Meta rolled that back |
| **Google Gemini "Call for Me"** (Pixel 11 beta, 2026-09-24) | Yes, from the user's own number | **Yes**: introduces itself, navigates IVR, waits on hold | Phone | Live transcript; user can take over at any time; shares only the personal info the user approves | Small US test, paid Gemini tier |
| **Google Search "check pricing" / Ask for Me** (since 2025-07) | Yes: calls several local businesses in parallel and summarizes | n/s | Availability only | Confirm first; discloses automation + recording up front; **businesses can opt out** | All US users |
| **Gemini Agent + Chrome auto browse** | No | — | Web | Confirms before send / buy / delete; takeover | AI Pro / Ultra |
| **OpenAI "dots"** (2026-09-29) | **No** (inbound only: you can phone your dot) | — | Web | Action rules + automatic review; proactive work is read-only | Pro / Business |
| **xAI Grok Bot** | No native calling (only a DIY recipe via Bland.ai) | — | Web via cloud computer | Approval "only when needed" | Beta |
| **Amazon Alexa+** | None documented | — | **Partner APIs**: OpenTable, Vagaro, Thumbtack, Uber, Ticketmaster… | n/d | US, Prime |
| **Apple iOS 26/27** | No | Hold Assist on your own calls; Call Screening | App intents | — | Shipped |
| **Pine AI**, **Instinct** (startups) | Yes: bills, cancellations, dentist waitlists, restaurants | Yes | Phone | n/v | Early access |

New Computer's "Dot" companion shut down in 2025-10 and never took actions.

**Pattern across vendors.** Calls go only to businesses the user names. Every call needs approval. The assistant discloses at the start that it is AI and that the call is recorded. The user gets a transcript and summary afterward, and at Google can take over mid-call. **No product calls private individuals.**

## 2. Legal notes (US / Texas; research, not legal advice)

- **FCC 2024-02-08 declaratory ruling.** AI-generated voice counts as "artificial voice" under the TCPA. Such calls to **wireless** numbers need the called party's prior express consent, even when not telemarketing. Many small businesses answer on mobile numbers, so this is a gray area for owner-directed one-off calls. Damages run $500–1,500 per call.
- **47 CFR 64.1200(b)** requires artificial-voice messages to identify the caller at the start. The FCC's proposed rule on disclosing AI-generated calls (CG Docket 23-362) was still pending (status unverified).
- **Recording consent.** Texas is one-party (Penal Code 16.02). Calls into all-party-consent states (CA, FL, WA, IL, PA…) may pull in stricter law, and CA applies §632 to out-of-state callers. So always announce recording.
- **CA AB 2905** requires disclosure when a call uses an AI-generated voice. **Texas:** TRAIGA covers only state agencies and healthcare. Claims that SB 140 requires AI disclosure are unsupported.
- **Voice cloning the owner** is the riskiest possible design. Use a clearly synthetic voice and disclose it.
- **Design rules to adopt:**
  - calls only to businesses the owner explicitly names;
  - approval before each call;
  - disclose AI + recording + on whose behalf, up front;
  - honor "don't call again" with a suppression list;
  - never dial emergency numbers;
  - rate limits and an audit log;
  - keep sensitive data out of any third-party path.

## 3. Open-source building blocks

- **Pipecat** (BSD-2, v1.12.0, 2026-09-26) [P]
  - WebSocket serializers for Twilio, Telnyx, Plivo, Vonage and others.
  - Silero VAD + Smart Turn v3 (~12 ms on CPU).
  - **IVRNavigator** (LLM + DTMF) and **VoicemailDetector**.
  - Any OpenAI-compatible LLM; Whisper and Kokoro.
  - Best fit for a Docker bundle running on local models.
- **LiveKit Agents + LiveKit SIP** (Apache-2.0) [P]
  - Native SIP and DTMF, built-in answering-machine detection and IVR navigation (IVR nav is Python only).
  - Heavier: needs LiveKit server + Redis + SIP service with UDP ports open.
  - The upgrade path if WebSocket media hits limits.
- **Other frameworks**
  - Jambonz: open source frozen at 0.9.x.
  - Vocode: last commit 2024-11, avoid.
  - Dograh (BSD, on Pipecat) and AVA (MIT, Asterisk + local models) are design references.
  - agent-call (MIT MCP server: plan → confirm → dial → DTMF → transcript) is the best reference for tool shape.
- **Carriers**
  - **Telnyx** is about $0.007/min and $1/month per number, with bidirectional μ-law WebSocket media. It can **send DTMF mid-call** through the REST API [P].
  - **Twilio** is $0.014/min, but bidirectional Media Streams **cannot send DTMF** [P].
  - SignalWire and VoIP.ms are the cheaper SIP-only options.
  - Light personal use (20 × 5 min/month) comes to about $2–4/month.
- **Ingress**
  - The carrier connects *to us* for the webhook and media WebSocket.
  - Tailscale Funnel can only carry TLS over TCP (ports 443/8443/10000), not SIP/RTP.
  - Crow's Funnel invariant forbids exposing gateway private routes.
  - Options: a relay on a public VPS (black-swan pattern), or a Funnel-exposed **separate** call-media service process.
- **Speech on crow**
  - faster-whisper (upstream CTranslate2 has no ROCm; community ROCm builds exist [S]).
  - Moonshine v2 as a CPU fallback. Parakeet/Nemotron streaming ASR is CUDA-first.
  - Kokoro TTS: keep it on GPU and stream by sentence.
  - Phone audio is 8 kHz μ-law, so upsample it and test WER on real calls.
- **Latency budget**
  - Target under ~800 ms per turn. Local estimate is ~450–750 ms using the resident 4B for conversation (unmeasured).
  - 35B cold prompt processing is a risk, so pin a resident model for calls.
  - Qwen Cloud works as an escalation path.
- **Hold / IVR detection**
  - Asterisk `app_amd` is about 85–90% accurate.
  - For hold music, no maintained open-source classifier exists. DIY with an audio tagger (YAMNet/PANNs) + repeated-transcript detection + a cheap LLM "is this a live person?" check, capped by a wall-clock timer.
- **Web booking**
  - OpenTable, Resy, Zocdoc and Reserve with Google are all partner-only.
  - Cal.com went closed-source 2026-04; the MIT fork is Cal.diy.
  - Realistic path: browser agent (Playwright MCP / browser-use) in Crow's existing browser, with human confirm before submit.

## 4. What Crow already has (file refs from the codebase map)

- **Voice turn loop**
  - Meta-glasses WS: Opus in / PCM out, half duplex, `runVoiceTurn` at `bundles/meta-glasses/panel/routes.js:782`.
  - Companion (OLVV, Silero VAD).
  - STT adapters with optional `transcribeStream`: `servers/gateway/ai/stt/`, Deepgram streaming.
  - TTS adapters are async generators, Kokoro streaming: `servers/gateway/ai/tts/`.
  - llm-router `/llm/v1` with the fast 4B and escalation to 35B.
- **Browser**: `bundles/browser` exposes 27 `crow_browser_*` MCP tools, including `wait_for_user` VNC handoff.
- **Approval patterns**
  - `servers/shared/confirm.js`: preview + single-use token.
  - Glasses spoken two-turn confirm and `needs_consent` flow.
  - Perch `ask_user` cards when `PI_BOT_INTERACTIVE`.
  - `external_send: draft_only`.
  - **Gap:** a new call tool is caught by neither send-gate list (pi-lab `isExternalSendTool`, `tool-executor.js EXTERNAL_SEND_TOOLS`).
- **Background**
  - `bot_jobs` + `job_runner.mjs`, capped at **10 min** (a real call can exceed that, so calls need their own service).
  - `bot_scheduler.mjs`, `board_report_result`, notifications (DB row, Web Push, ntfy, email; no action buttons).
- **Contacts**: the `contacts` table has `phone` and `email` columns (manual contacts, vCard import). No tool uses phone for calling.
- **Channels** all dial out (Telegram long-poll, Slack socket mode). A telephony webhook would be the first inbound-internet surface, so it must satisfy the Funnel invariant or live off-box.
- **No telephony code exists anywhere**, including the Android app manifest.

## Sources

The full URL lists are in the three research reports (session 2026-09-30). Key ones:

- Muse: https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
- Call for Me: https://techcrunch.com/2026/09/24/google-tests-letting-gemini-make-phone-calls-initially-for-us-pixel-owners/
- FCC ruling: https://docs.fcc.gov/public/attachments/DOC-400393A1.pdf
- CA AB 2905: https://leginfo.legislature.ca.gov/faces/billStatusClient.xhtml?bill_id=202320240AB2905
- Pipecat: https://pypi.org/project/pipecat-ai/ and https://docs.pipecat.ai/pipecat/fundamentals/ivr
- Telnyx pricing: https://telnyx.com/pricing/voice-api
- Telnyx DTMF: https://developers.telnyx.com/api/call-control/send-dtmf
- Twilio stream DTMF limit: https://www.twilio.com/docs/voice/media-streams/websocket-messages
- Funnel: https://tailscale.com/kb/1223/funnel
- agent-call: https://github.com/XiyaoWang0519/agent-call
- LiveKit AMD: https://livekit.com/blog/answering-machine-detection

## 5. Spike: Bluetooth hands-free (HFP) phone link on crow (2026-09-30, throwaway)

**Setup**
- crow uses a MediaTek BT adapter (hci0), BlueZ 5.72, PipeWire 1.0.5 / WirePlumber, native HFP backend. crow advertises the HFP **HF** role (UUID 111e) by default.
- Phone: Kevin's Pixel 9a (Android, Google Fi).

**Proven**
- **Pairing + HFP service-level connection.** Android lists crow with "Phone calls" and offers **crow as the in-call audio output**. The phone sends call-state indicators (`+CIEV` call/callsetup) and volume (`AT+VGS/VGM`).
- **Wideband voice.** The phone opens eSCO in **Transparent air mode = mSBC 16 kHz**, 60-byte packets both ways every ~7.5 ms.
- **Phone → crow audio.** Captured the far end cleanly at 16 kHz mono (the voicemail greeting).
- **crow → phone audio.** Tones injected into the call were **heard by the called party** (Kevin's Google Voice line).

**How PipeWire exposes the call.** Two **stream** nodes (not devices), profile `headset-audio-gateway`, codec `msbc`:
- `bluez_input.<addr>.N`: `Stream/Output/Audio`, the far-end voice.
- `bluez_output.<addr>.N`: `Stream/Input/Audio`, what crow says.

`pactl` sources and sinks do not list them; use `pw-dump` / `pw-record --target` / `pw-play --target`.

**Hazards found**
1. **WirePlumber auto-links the call streams to crow's default speaker and microphone.** The room would hear the call and the room mic would leak into it. We also saw our own playback looped into the recorder.
   - Product rule: set node rules so `headset-audio-gateway` streams are **never auto-connected**. The call service links them explicitly.
2. **A2DP media streams come from the same phone** (`a2dp-source`, sbc).
   - Filter to `headset-audio-gateway`.
   - Recommend users disable "Media audio" for the Crow device.
3. **A trusted, connected phone routes the owner's real calls to crow.**
   - Pairing UX must make the default "connect only for Crow calls", or untrust between calls.
   - Android auto-reconnects to trusted audio devices.
4. **Calling your own number** lands in the voicemail PIN menu, not message recording. Use another line for tests.

**Not yet proven: crow-initiated call control** (dial / DTMF / hang up)
- In the spike, calls were dialed on the phone.
- PipeWire 1.0.5's native backend owns the HFP RFCOMM channel and exposes **no telephony API**, so crow cannot send `ATD`/`AT+VTS`/`AT+CHUP` alongside it.
- Candidates:
  - (a) **oFono** as the HFP backend (`bluez5.hfphsp-backend = ofono`). oFono does AT call control over D-Bus (`VoiceCallManager.Dial`, `SendTones`, `Hangup`) and PipeWire keeps the mSBC audio.
  - (b) A newer PipeWire with native telephony D-Bus (version/status unverified).
  - (c) Our own HF implementation (BlueZ Profile1 RFCOMM AT layer + SCO socket + mSBC codec).
  - (d) Android-only: the Crow app places the call via `TelecomManager` and BT carries the audio. No DTMF unless the app is the default dialer.

### Spike part 2: crow-initiated call control via oFono. **PROVEN** (2026-09-30)

Setup changes on crow (kept for now):
- Installed `ofono` 1.31 (Ubuntu). `dundee` was disabled.
- WirePlumber override `~/.config/wireplumber/bluetooth.lua.d/51-crow-hfp-ofono.lua` sets `bluez5.hfphsp-backend = "ofono"`.
- To revert: delete the file, `systemctl --user restart wireplumber`, `sudo apt remove ofono`.

**Gotcha: startup order.** oFono's HFP-HF `RegisterProfile` fails with "UUID already registered" if PipeWire's native backend still holds the HF role, and oFono never retries. Once WirePlumber is on the ofono backend, run `systemctl restart ofono` and then restart WirePlumber. The product must enforce this order (or health-check that the `Handsfree` UUID is advertised).

oFono D-Bus results with the Pixel 9a:
- An HFP modem appears at `/hfp/org/bluez/hci0/dev_<addr>`, Powered + Online. Interfaces: VoiceCallManager, CallVolume, Handsfree, NetworkRegistration.
- A handsfree audio card appears at `/card_1`.
- **`VoiceCallManager.Dial(number, "default")`** works. States seen: dialing → alerting → active (answered at about 13–17 s).
- **`SendTones`** fails for a multi-digit string (`org.ofono.Error.Failed`). It **works one digit at a time** ("1", "2", "3", "#"), and the called party heard all four.
- **`HangupAll`** works.
- Audio injected into the crow-dialed call was **heard by the called party**.

**Codec.** Calls placed through oFono negotiated **CVSD (8 kHz narrowband)**. Phone-initiated calls on the native backend got mSBC (16 kHz). Wideband over oFono needs codec negotiation support (to investigate). Narrowband is acceptable for PSTN.

**Remaining open items**
- crow → phone `bluetoothctl connect` failed with `le-connection-abort-by-local`: it tried LE. The product should connect BR/EDR explicitly via `Device1.ConnectProfile(HFP AG UUID 0000111f-…)`, so crow connects only when it is about to make a call.
- iOS: untested. HFP HF plus oFono is standard for car kits, so it is expected to work.
