# Crow Kiosk: an always-on home display with the Ramble bird as voice companion (Design)

**Date:** 2026-10-03.
**Status:** Spec. It comes from the interactive brainstorm with Kevin on 2026-10-03 (`~/crow-weekend-push/HANDOFF.md`, "KIOSK / COMPANION REVAMP brainstorm"). Improvement-queue Item 8 is the source requirement. The decisions in §2 marked *Kevin* are binding. Everything else is this spec's ruling, and Kevin reviews it before a plan is written.
**Base:** `origin/main` @ `09ae235f`. All file references were read on that commit. Facts about live hosts were checked on crow on 2026-10-03.
**Sibling spec:** `2026-10-03-cameras-frigate-ring-design.md` (Frigate, ring-mqtt and the doorbell). Sub-project K4 below depends on it.

## 1. Purpose

Build a Google-Nest-Hub-style display for the house. It runs on a Raspberry Pi 3 with a 7" touchscreen. Its face is the user's own Ramble bird, and it does three things:

- **Talk.** Say "Hey Crow" or tap the bird. You get an answer from a Crow bot, with captions and on-screen windows (recipe, timer, list, camera).
- **Home at a glance.** Home Assistant tiles you can tap: vacuum, TV, lights, thermostat, scenes.
- **Today.** The clock, the weather, tonight's dinner from the Workspace "Menu" calendar, reminders, and the notification tray.

It replaces the Open-LLM-VTuber (OLLV) companion entirely. OLLV is a 13.9 GB image plus 1.8 GB of Live2D models, and it cannot run on a Pi 3. The AI window manager `crow_wm` is **kept and improved** (Item 8 correction). Only OLLV goes.

## 2. Decisions

| # | Topic | Decision | Source |
|---|---|---|---|
| D1 | Hardware | Raspberry Pi 3 (1 GB RAM, Cortex-A53) + official 7" DSI touchscreen (800×480) + USB mic + USB speaker | Kevin |
| D2 | Architecture | **A: browser kiosk.** Crow serves the kiosk page and runs the whole voice loop server-side (STT, bot turn, TTS). The Pi runs Chromium full-screen plus one tiny local agent (wake word + backlight) | Kevin |
| D3 | Pi OS | Raspberry Pi OS Lite (64-bit) + a Crow setup script: Chromium kiosk, openWakeWord "Hey Crow" agent, autostart, Tailscale join | Kevin |
| D4 | Pairing | A 6-digit code is shown on the kiosk and approved in Crow. Approval mints a device token bound to a bot, using the Meta Glasses device model (`device_kind`, `bound_bot_id`) | Kevin |
| D5 | Idle screen | Animated bird (idle, listening, thinking, speaking), clock, weather, Home tiles with tap control, Today strip. No cameras on the idle screen | Kevin |
| D6 | Talk | Wake word or tap; captions; `crow_wm` windows the bot opens and closes; swipe to dismiss | Kevin |
| D7 | Sleep | Display sleep schedule. Wakes on touch, on the wake word, or on a doorbell ring | Kevin |
| D8 | Test path | The same page works in a phone browser | Kevin |
| D9 | Home Assistant | HA's own API with a limited long-lived token, stored sealed. HA is never called from the browser | Kevin (§6.1 fixes the shape) |
| D10 | Notifications | Same source as the Android app (the `notifications` table). Can speak selected ones | Kevin |
| D11 | Budgets | Kiosk page < ~300 MB in Chromium on the Pi 3, verified on the real Pi. No idle video; a small bird loop. Under 2 s from end of speech to start of TTS for short questions on the fast voice model | Kevin |
| D12 | OLLV | Retired once the kiosk is live. The migration is spelled out (§11) | Kevin |
| D13 | Packaging | A new **`kiosk` bundle, type `mcp-server`**, with a panel + `panelRoutes` + `setupWebSocket`. The reusable core pieces live in core: the device store and the voice turn | this spec, §4.1 |
| D14 | Bot runtime for voice | The gateway's in-process voice turn: the bound bot's persona, tool scope, permission policy and `fast_voice_model`. It is the same path Meta Glasses uses, not a per-turn pi spawn | this spec, §7.1 |
| D15 | Wake word stays on the Pi | Audio leaves the Pi only after a wake word or a tap | this spec, §7.4 |

## 3. What exists today (ground truth, verified 2026-10-03)

- **Voice services on crow.**
  - The fast voice model `crow-voice/qwen3.5-4b` is up (vLLM-ROCm, `100.118.41.122:8011`).
  - The escalation model is `crow-chat/qwen3.6-35b-a3b` (`:8003`, llama.cpp), and it is started on demand.
  - STT: `faster-whisper-server` (CPU, `127.0.0.1:8004`) is the **default STT profile**. Its model is `Systran/faster-whisper-large-v3`.
  - TTS: the **default TTS profile is Edge TTS**. It is a cloud service: Microsoft, voice `en-GB-LibbyNeural`.
  - The `kokoro-tts` bundle (local, `127.0.0.1:8880`) exists in the repo but is **not installed** on crow.
- **Meta Glasses voice loop.** `bundles/meta-glasses/panel/routes.js` `runVoiceTurn` runs the whole turn: STT profile, then the bound bot (`loadBoundBotDef`, `fast_voice_model`, `createToolExecutor({botDef})`, `getChatTools({botDef})`, `generateSystemPrompt({botDef})`), then a streamed LLM tool loop with a `<think>` gate, then sentence-chunked TTS through `negotiatePcm`/`pcmStream`. It is about 550 lines inside a 3,000-line routes file. It also mixes in glasses-only fast paths: media, photo, note sessions.
- **Device store.** `bundles/meta-glasses/server/device-store.js` keeps devices in `dashboard_settings` key `meta_glasses_devices`, which is not in the sync allowlist and so stays local. Each device stores `token_hash` (sha256), `device_kind` (`glasses`|`companion`), `bound_bot_id`, `companion_features`, and per-device STT/TTS profile ids. Re-pairing preserves the binding. `verifyToken` rewrites the whole list on every call because it updates `last_seen`.
- **Existing kiosk device.** crow has one `companion` device, `crow-kiosk`. It is unbound and has never been seen.
- **`crow_wm`.** `servers/wm/server.js` is a single stateless tool. It takes a `command` string and returns a JSON action (`open`/`close`/`media`/`notification`/…). `bundles/companion/scripts/crow-wm.js` (1,284 lines) executes that action inside OLLV's browser, keyed off OLLV's `tool_call_status` events. It assumes a desktop: snap zones, drag, six windows, iframes. `open pet` spawns a Linux AppImage built by the companion bundle.
- **`/llm/v1` router.** `servers/gateway/routes/llm-router.js` chooses fast vs. escalation per turn: a leading `!escalate`, or tool intent (`TOOL_INTENT_RE`) or recent tool context. These helpers are module-private today.
- **The bird.** `bundles/ramble/server/bird-svg.cjs` is dependency-free and works in both Node and the browser. `rollGenome(seed, species)` + `drawBird(genome, mood)` produce a ~1.1 KB SVG. Moods are `happy`/`tired`/`alarmed`. The parts carry no class hooks. The user's bird is `activeBird(db)` (from `ramble_pet.active_egg_id` to `ramble_eggs` species+seed), served by `GET /api/ramble/pet`. It is `null` until the first egg hatches.
- **Home Assistant on crow.**
  - Container `homeassistant`, host network, `:8123`, config `~/homeassistant/config`.
  - Integrations include `roomba`, `samsungtv`, `met`, `cast`, `shopping_list`, `mobile_app` and HACS.
  - Entities include `vacuum.robotina`, `media_player.living_room_tv`, `media_player.samsung_tu7000_55_tv_un55tu7000bxza`, `weather.forecast_home` and one `todo`.
  - **There are no `light`, `climate`, `scene` or `script` entities** (and `scenes.yaml`/`scripts.yaml` are empty). The `home-assistant` bundle (`npx hass-mcp`, env `HA_URL`/`HA_TOKEN`) is in the repo but not installed on crow.
- **Notifications.** The `notifications` table (`scripts/init-db.js`) has `type` values `reminder`/`media`/`peer`/`system`/`attention`. `createNotification` emits `notifications:changed` on the in-process bus. The Android app polls `GET /api/push/notifications` and uses ntfy for push.
- **Visual language.** `PERCH_TOKENS` (`servers/gateway/dashboard/shared/design-tokens.js`) is light-first, with dark following the OS.
- **Pis.** colibri (last seen on the tailnet 343 days ago) and mockingbird (178 days ago) are both offline.
- **Workspace.** W1 is live on crow, and its "Menu" calendar exists in Nextcloud. **W2 (the Crow toolset with calendar tools) is not built yet.**

## 4. Architecture

```
 Pi 3 (Raspberry Pi OS Lite 64-bit)                     crow (gateway :3001, Serve :8444)
 ┌──────────────────────────────────────┐   tailnet     ┌───────────────────────────────────────────┐
 │ cage (Wayland kiosk compositor)      │   HTTPS/WSS   │ kiosk bundle                              │
 │  └ Chromium --kiosk  ────────────────┼──────────────►│  GET  /kiosk           page + assets      │
 │     https://crow…ts.net:8444/kiosk   │               │  POST /api/kiosk/pair/* pairing           │
 │     mic (getUserMedia, AEC on)       │               │  WSS  /api/kiosk/session  voice + events  │
 │     speaker (WebAudio)               │               │  routes → core voice turn (§7)            │
 │        ▲ ws://127.0.0.1:8770         │               │        → HA client (§6.1, server-side)    │
 │ crow-kiosk-agent (Python, systemd)   │               │        → Today feeds (§6.2/6.3)           │
 │  openWakeWord "hey_crow"             │               │ core: servers/shared/device-store.js      │
 │  backlight on/off (sysfs)            │               │       servers/gateway/voice/turn.js       │
 └──────────────────────────────────────┘               └───────────────────────────────────────────┘
```

### 4.1 Crow side

**Packaging (D13).** There is a new bundle `bundles/kiosk/`, `type: "mcp-server"`, following the Meta Glasses precedent:

- `panel/kiosk.js` is the dashboard panel. It holds the displays list, pairing approval and per-display settings.
- `panel/routes.js` exports the router plus `setupWebSocket(server)`. `panel-registry.js` already wires a panel's `setupWebSocket` export.
- `server/` is a small MCP server with three tools: `crow_kiosk_list_displays`, `crow_kiosk_announce(display?, text, speak?)` and `crow_kiosk_show(display?, title, body)`.
  - These let other bots and automations put something on the display ("dinner's ready").
  - The MCP server runs as a separate process. It reaches the live sessions by calling the gateway's loopback-only `POST /api/kiosk/internal/{announce,show}` with a path-scoped **kiosk announce token**. The gateway mints that token at boot to `$CROW_HOME/kiosk-announce-token`, the same shape as the board token in `servers/gateway/local-token.js`. It is accepted only on `/api/kiosk/internal/*`, and only from loopback. It is a different credential from a display's device token.
  - This deliberately avoids the `crow_glasses_speak` pattern, which only returns "queued" and never reaches a session.
- The page assets are `public/kiosk.html`, `kiosk.js`, `kiosk.css` and an AudioWorklet. The bird engine is served from the app root (`bundles/ramble/server/bird-svg.cjs`).

**Why a bundle and not a core panel.** It is optional and removable per instance. A Crow OS image can preinstall it. It gets the manifest-version refresh path. It matches the glasses precedent. Two pieces are shared between bundles, so they move into **core**:

1. **`servers/shared/device-store.js`.** The file moves from `bundles/meta-glasses/server/`, and a one-line re-export shim stays at the old path, so installed glasses copies keep working.
   - `device_kind` gains `kiosk`. The existing `companion` value is migrated to `kiosk` (§11).
   - `verifyToken` throttles its `last_seen` write to once per 5 minutes per device, because a kiosk reconnects often and each write rewrites the whole list.
2. **`servers/gateway/voice/turn.js`** is the transport-independent voice turn (§7.1).

**No new host port.** Everything rides the gateway behind Serve `:8444`.

### 4.2 Pi side

- **OS.** Raspberry Pi OS Lite (64-bit). The current release is confirmed at bring-up (§12). There is no desktop.
  - `cage` (a single-app Wayland compositor) runs Chromium on tty1 through an autologin user `kiosk`.
  - `zram-tools` provides compressed swap.
  - SSH is key-only, and `unattended-upgrades` is on.
- **Chromium** runs `--kiosk --noerrdialogs --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required --renderer-process-limit=2 --disable-features=Translate,MediaRouter`. The Chromium managed policy file sets:
  - `AudioCaptureAllowedUrls` to the Crow origin, so there is no mic prompt;
  - a `URLAllowlist` of the Crow origin only, with everything else blocked;
  - `DeveloperToolsAvailability: 2`.
- **`crow-kiosk-agent`** is a Python service in a venv (systemd, user `kiosk`). It contains:
  - **openWakeWord** reading the USB mic through an ALSA `dsnoop` device, so Chromium and the agent share the capture device without PipeWire;
  - **backlight control** via `/sys/class/backlight/*/bl_power`, with a udev rule granting the `kiosk` group write access;
  - a **local WebSocket on `127.0.0.1:8770`** that the page connects to. Chromium treats `ws://127.0.0.1` as potentially trustworthy from an HTTPS page. Agent → page: `{type:"wake"}`, `{type:"touch_while_dark"}`. Page → agent: `{type:"display", on}`, `{type:"speaking", on}`.
- **The setup script** is `scripts/kiosk/pi-setup.sh`, in the repo and fetched from GitHub raw or scp'd over the LAN. It is idempotent and takes `--crow-url`. It installs packages, writes the units, the policy, the ALSA and udev config, and the agent venv. It downloads the wake model from crow (`/kiosk/assets/wake/hey_crow.onnx`), then runs `tailscale up` (interactive login URL).

### 4.3 Network

- The kiosk is on the **tailnet only**. The page, pairing, session and assets are all under `/kiosk` and `/api/kiosk`.
  - They are reached at `https://crow.dachshund-chromatic.ts.net:8444/kiosk` (Serve, a real certificate). That is a secure context, which `getUserMedia` needs.
  - The routes refuse Funnel: they are not in `PUBLIC_FUNNEL_PREFIXES`, and the global `rejectFunneledMiddleware` applies.
  - They also apply `isAllowedNetwork()` before any token check.
- **No browser call goes to Home Assistant, Frigate or a model.** Crow proxies everything.
- The phone test path (D8) uses the same URL from a phone on the tailnet.

### 4.4 Pairing (D4)

1. An unpaired page (no token in `localStorage`) calls `POST /api/kiosk/pair/start` with `{name_hint}`.
   - This endpoint has no dashboard auth, but `isAllowedNetwork` applies. It is rate-limited to 5 per minute per IP, with at most 3 pending pairings per instance.
   - The server creates `{pair_id, code: 6 random digits, poll_secret: 32 random bytes, requester_ip, user_agent, expires: +10 min}`. It is held **in memory**, with only `sha256(poll_secret)` kept.
   - The response is `{pair_id, code, poll_secret}`. The page shows the code large next to the bird.
2. The operator opens **Kiosk → Pair a display** in the dashboard (dashboard auth). They type the code, pick a name and a bound bot, then confirm. The approve screen shows the requester's tailnet IP and user agent, so a stray pairing request is recognisable.
   - Five wrong codes in 10 minutes lock approval for 10 minutes.
   - Approval calls `pairDevice(db, {id: "kiosk-<random>", name, device_kind: "kiosk"})`, then sets `bound_bot_id`. It stores the plaintext token in the pending entry for one pickup.
3. The page polls `GET /api/kiosk/pair/status?pair_id=…` with the header `X-Kiosk-Poll: <poll_secret>` every 2 s. On approval it receives `{device_id, token}` exactly once, and the pending entry is deleted. The page stores both in `localStorage`.
4. **Unpairing** (panel) deletes the device and closes its live session with code 4401. The page drops its token and returns to step 1.

Six digits is only 10⁶ codes. That is acceptable because guessing happens on the **authenticated** side: an attacker would need the dashboard session. The `poll_secret` stops a third party from collecting the token for a code they merely saw.

### 4.5 Session protocol

`WSS /api/kiosk/session`. The browser cannot set an `Authorization` header on a WebSocket, so the token is **not** put in the URL, where proxies and logs would capture it. The first client frame must be `{type:"hello", device_id, token, caps}` within 5 s, or the server closes with 4401.

| direction | message |
|---|---|
| c→s text | `hello`, `turn_start {source: wake\|tap}`, `turn_end {vad_end_ms}`, `barge_in`, `tile_action {entity_id, action, value?}`, `wm_event {id, kind: dismissed\|tapped}`, `notif_action {id, read\|dismiss}`, `turn_metrics {...}` |
| c→s binary | PCM16 mono 16 kHz frames (20 ms) between `turn_start` and `turn_end` |
| s→c text | `ready {display_config}`, `state {bird: idle\|listening\|thinking\|speaking}`, `transcript_final`, `caption_delta`, `tts_start {codec, sample_rate}`, `tts_end`, `wm {action…}`, `tiles {entities…}` (full, then diffs), `today {…}`, `notif {added\|removed}`, `announce {text}`, `display {on}`, `error {code, recoverable}` |
| s→c binary | TTS audio chunks (PCM, or one mp3 per sentence when the adapter has no PCM path; the browser decodes either) |

## 5. Screen and interaction (800×480, landscape)

**Idle screen layout:**

```
┌────────────────────────────────────────────────────────────────┐
│  7:42  Sat Oct 3        ☁ 71° (H 78 / L 60)                     │  top bar: clock, weather
│ ┌───────────────┐  ┌──────────────── Home ─────────────────┐   │
│ │               │  │ [Robotina ▶ docked] [TV ⏻ off]        │   │  HA tiles, 2 rows × 3,
│ │    (bird)     │  │ [Kitchen 💡 on]  [Thermo 70° ±]       │   │  page dots if more
│ │               │  └───────────────────────────────────────┘   │
│ └───────────────┘  Today: 🍝 Dinner: lasagna · ⏰ 2 reminders  🔔3│  Today strip + tray badge
└────────────────────────────────────────────────────────────────┘
```

- **Bird.** This is the user's bird from `activeBird`. With no Ramble, or no hatched bird, it is a fixed default crow genome (species `crow`, seed `0`).
  - The mood comes from `ramble_pet.mood` when available, so a tired bird looks tired.
  - Animation states are done with CSS transforms and opacity only, so they stay on the compositor with no JS animation loop:
    - **idle:** a slow breath scale (6 s) and a blink every 4–9 s (a randomized timeout toggles a class);
    - **listening:** head tilt plus a pulsing ring in `teal`;
    - **thinking:** a head bob plus three dots;
    - **speaking:** a beak open/close driven by the TTS output level, sampled at 15 Hz from the playback node and not per frame.
  - This needs a **small additive change to `bird-svg.cjs`**: class hooks on the parts (`rb-body`, `rb-head`, `rb-beak`, `rb-eye`, `rb-wing`, `rb-tail`, `rb-feet`), plus a beak drawn as two paths so it can open.
  - That means a Ramble manifest version bump. The output stays byte-compatible apart from the added `class` attributes, and a test pins this.
- **Talk.** You start a turn with the wake word, by tapping the bird, or with the mic button (phone).
  - The bird shows listening, and captions appear in a bottom band: the user's words, then the reply as it streams.
  - Tapping anywhere while the bird is speaking **stops** the reply (barge-in, §7.5).
  - After the reply, the screen holds for the "follow-up window" (default 6 s; listening without the wake word, only if the device's `follow_up` setting is on). Then it returns to idle.
- **Windows (`crow_wm`, §8).** Windows open over the right side. On the 800×480 screen there is **one visible window at a time** (a stack with a small tab rail). Swipe left or right to dismiss. Windows auto-close after 10 minutes untouched; timers are exempt.
- **Theme.** `PERCH_TOKENS`, light by day and dark at night. The kiosk follows the display's sleep schedule and not the OS, because Pi OS Lite has no OS theme. Minimum touch target 56 px. Body text 20 px or larger. `prefers-reduced-motion`, or the device setting `animation: false`, stops the bird animation.
- **Sleep (D7).** A per-device schedule (default 22:30–06:30, edited in the panel) turns the backlight off through the agent. While the display is dark:
  - the bird animation and the clock timer pause;
  - the WS stays connected;
  - the first touch only wakes the screen and is swallowed (the agent reports `touch_while_dark`), so it never presses a tile;
  - the wake word wakes the screen and starts a turn;
  - a doorbell ring (K4) wakes it, and so does an `announce` marked urgent.
  - Outside the schedule, the screen dims after 5 minutes idle and goes dark after 30 minutes (configurable).
- **Phone (D8).** The same page lays out as a single column below 600 px wide. There is no agent there: tap-to-talk only, and the sleep controls are hidden.

## 6. Integrations

### 6.1 Home Assistant (K3)

- **Connection.** This is **server-side only**, through a new `bundles/kiosk/server/ha-client.js`:
  - HA's WebSocket API (`/api/websocket`): `auth`, `subscribe_entities` for tile state, and `call_service` for actions;
  - and REST `GET /api/states/<id>` for one-shot reads.
  - URL setting `kiosk.ha_url`, default `http://127.0.0.1:8123`, which is crow's host-networked HA.
- **The token (D9).** HA long-lived tokens **cannot be scoped**: a token acts with the full rights of the user who created it, and HA core has no per-entity permissions. "Limited" therefore means two things:
  - a **dedicated non-admin HA user** `crow-kiosk`, which cannot change HA configuration;
  - **Crow-side enforcement**: the kiosk only ever calls services on entities in the operator's **tile allowlist**, and only the services listed for each domain below.

  The token is entered in Kiosk settings and stored **sealed**: `sealSecret` from `servers/sharing/secret-box.js`, in `dashboard_settings` key `kiosk_ha_token`. It is local scope, not in the sync allowlist, never returned to the browser, and never logged.
- **Tiles.** The operator picks entities in the panel (the HA entity list is fetched server-side) and orders them. Each tile shows state and offers a tap action:

| domain | shown | tap / control | allowed services |
|---|---|---|---|
| `light` | on/off, brightness | tap toggles; long-press opens a brightness slider | `light.turn_on/turn_off/toggle` |
| `switch` | on/off | toggle | `switch.toggle` |
| `climate` | current + target temp, mode | ± buttons (0.5° or 1° per the entity's step) | `climate.set_temperature` |
| `vacuum` | state, battery | start / return to dock | `vacuum.start`, `vacuum.return_to_base`, `vacuum.pause` |
| `media_player` | state, title | power; play/pause | `media_player.turn_on/turn_off/media_play_pause` (only those in `supported_features`) |
| `scene` | name | activate | `scene.turn_on` |
| `script` | name | run | `script.turn_on` |

  - Locks, alarms, covers/garage doors and cameras are **not tile-able** in v1. Those are security-relevant actuations, and they stay with the bot's own confirmation flow.
  - Today's real candidates on crow are `vacuum.robotina`, the TV `media_player`s and `weather.forecast_home` (shown in the top bar, not as a tile). **Lights, thermostat, scenes and scripts do not exist in HA yet** (§3). Their tiles appear once those devices are integrated into HA (open question Q1).
- **Voice control of the home.** The kiosk turn adds one in-process tool, `crow_kiosk_home(action: list|state|toggle|turn_on|turn_off|set_temperature|start|dock|activate, name)`.
  - It is bounded by the **same allowlist** and resolves `name` against tile friendly names.
  - Tile entities are low-risk by construction, so there is no confirmation prompt, which is a deliberate difference from the hass-mcp skill's checkpoints.
  - A **fast path** handles exact `turn on|off <tile name>` / `start|dock the vacuum` utterances with no LLM call (like the glasses media fast path). That keeps the most common home commands inside the latency budget without escalating to the 35B (§7.2).
  - If the bound bot also has the `home-assistant` bundle's tools selected, those keep their own checkpoint rules.
- **Weather.** The top bar reads `weather.forecast_home` (met.no, already configured in HA) through the same client: current conditions plus today's high/low from `weather.get_forecasts`. Without HA configured, the weather slot is hidden.

### 6.2 Today strip and Workspace (K3)

- **Dinner.** This shows today's events from the Workspace "Menu" calendar. The kiosk calls a narrow **calendar reader capability** that **W2 will provide**: `getEvents({calendar:"Menu", from, to})`, read as `crow-bot` over CalDAV.
  - The kiosk discovers it at runtime. If the `workspace` bundle is not installed, or W2's toolset is absent, or the call fails, the dinner slot is **hidden**. It never shows an error on the idle screen.
  - Until W2 ships, the slot is hidden by design.
  - The W2 spec must include this read capability. This spec records it as a cross-spec dependency, not a W2 design.
- **Reminders.** These are undismissed `notifications` with `type='reminder'` due today, shown as a count plus the next one.
- **Tray badge.** This is the count of tray notifications (§6.3).

### 6.3 Notifications (K3, D10)

- **Source.** The same `notifications` table the Android app polls. The kiosk subscribes to the in-process `notifications:changed` bus event and re-queries, with a 5-minute fallback poll.
- **Per-display filter.** This matters because it is a **shared household screen**. The setting `tray_types` defaults to `reminder`, `home` and `attention`. `peer` (messages) and `media` are **off** by default, so private messages don't appear on the kitchen wall.
- **Tray.** Tapping the badge slides open a list. Tapping an item opens its text in a `content` window. "Done" marks it read or dismissed using the same semantics as `POST /api/notifications/:id/{read,dismiss}`, executed server-side for the device.
- **Speaking.** The setting `speak_types` (default: `reminder` and `home`, high priority only) speaks a new notification once through the device's TTS.
  - It never speaks while the display is asleep, except the doorbell (`home`/`doorbell`, K4).
  - It never speaks while a turn is active (it queues until the turn ends).

## 7. Voice loop

### 7.1 One voice turn module (D14)

`servers/gateway/voice/turn.js` exports `runVoiceTurn({device, audio | transcript, sink, extraTools, fastPaths, promptSuffix, signal})`. This is the reusable core of the glasses loop:

1. STT profile resolution and transcription.
2. Bound-bot resolution (`loadBoundBotDef`, 30 s cache).
3. The system prompt via `generateSystemPrompt({deviceId, botDef})`.
4. The model route (§7.2).
5. A streamed tool loop with the `<think>` TTS gate, `MAX_TOOL_ROUNDS`, the adaptive `maxTokens`, and the destructive-tool confirmation rule.
6. Sentence-chunked TTS through `negotiatePcm`/`pcmStream`.
7. Per-device conversation memory, using the same 15-minute idle reset and 24-message cap as glasses' `getConvo`/`saveConvo`.

The `sink` callbacks (`text`, `audio`, `event`) make it transport-free. The kiosk supplies:

- `extraTools`: `crow_wm` and `crow_kiosk_home`, executed in-process, with results that also go to the sink as `wm`/`tiles` events;
- `fastPaths`: wm close/next/stop-timer, and the HA on/off fast path;
- a short kiosk `promptSuffix`: concise spoken replies, plain prose, use `crow_wm` to show things, and the current window list (§8).

**Why not pi.** A per-turn pi spawn (bridge `--mode rpc`) costs seconds of process start-up before the first token, which cannot meet D11. The in-process loop is already proven on glasses with the bound bot's persona, tool scope (`botVoiceScope`) and permission policy. "Bot runtime" here means the bot definition drives the turn, exactly as with glasses.

**Glasses migration.** It is **not** part of this work. Glasses keeps its copy until a session with real glasses can verify it, and switching it over is a listed follow-up. K1's tests pin the extracted module against the glasses behaviors it reproduces: the think gate, sentence chunking, and the confirmation retry.

**Memory privacy.** This carries over from the companion. Unless the device's `memory_integration` is `true`, the kiosk turn **removes the memory category** from the bot's tool set, even if the bot selected it. A shared room display must not search the owner's memories by default.

### 7.2 Models and routing

- **Fast route.** The bound bot's `fast_voice_model`, or `crow-voice/qwen3.5-4b` when it is unset, with `enable_thinking=false`. The 4B is resident (vLLM).
- **Escalation.** `COMPANION_ESCALATION_MODEL` (default `crow-chat/qwen3.6-35b-a3b`). The decision is the router's existing logic: the tool-intent regex, recent tool context, or a vision turn.
  - K1 **exports** `chooseVoiceRoute(messages, {hasTools})` from `llm-router.js`, which wraps the private `wantsEscalation`/`wantsToolEscalation`, so `/llm/v1` and the kiosk share one policy. The kiosk does not make an HTTP hop to `/llm/v1`. It calls the adapter in-process, the way glasses does.
- **The 35B may be cold.** It is started on demand by the gateway, which is a standing automation in `CROW-SCHEDULE.md`. On an escalated turn the kiosk:
  1. says a short filler at once ("One moment."; pre-synthesized per voice, cached);
  2. probes readiness;
  3. if the escalation target is not ready within 8 s, answers with the fast model instead, telling it to use tools directly.
  It never blocks a household question on a multi-minute model start.
- **The `!escalate` prefix** cannot survive STT, so it is not offered on the kiosk.

### 7.3 STT and TTS choices (to meet D11)

- **STT.** Today's default, large-v3 on CPU, is too slow for a 2 s budget on short utterances. K1 adds a **dedicated kiosk STT profile**, still `faster-whisper-server` on `:8004`, with a small English model: default `Systran/faster-distil-whisper-small.en`. That server loads models per request, so this needs no new container.
  - The device's `stt_profile_id` points at it.
  - The first request after a server restart pays the model load. K1's warm-up sends one second of silence when a kiosk session connects.
  - Contention: the R4 meeting recorder also uses this CPU server (`CROW-SCHEDULE.md`). The latency report records whether a recording was transcribing.
- **TTS.** The latency target assumes **local Kokoro**: K1 installs the `kokoro-tts` bundle (CPU, `127.0.0.1:8880`, PCM output), and the device's `tts_profile_id` points at it.
  - Edge TTS (the current default) stays selectable per device, but it is a cloud call and adds a network round trip.
  - Which TTS is the **default** for the kiosk is open question Q2.
- **Audio in.** `getUserMedia({echoCancellation:true, noiseSuppression:true, autoGainControl:true})` feeds an AudioWorklet that resamples to 16 kHz PCM16. Chromium's WebRTC echo canceller works on audio the same page plays, which is why playback is done in the page.
  - The page keeps a **1.0 s pre-roll ring buffer** while idle, and **sends nothing**. On wake it sends the pre-roll plus live frames, so "Hey Crow, what's…" loses no words.
  - End of speech comes from a client energy VAD: 600 ms of silence after speech, or a 15 s cap. The page then sends `turn_end {vad_end_ms}`.
  - The server wraps the frames as WAV for the STT adapter.
- **Streaming.** STT is a single request after end of speech; faster-whisper has no streaming. The LLM streams. TTS is per sentence, so the first sentence starts playing while the rest is generated.

### 7.4 Wake word (D15, K2)

- **openWakeWord** runs on the Pi agent, on CPU. A Pi 3 runs a single model comfortably.
- **"Hey Crow" is not a pretrained openWakeWord model.** K2 trains `hey_crow` with openWakeWord's synthetic-data training pipeline (Piper-generated positive clips plus its negative feature sets). The training runs on crow and is registered in `CROW-SCHEDULE.md` as a CPU job; it does not use the GPU.
  - The ONNX model (a few hundred KB) ships as a kiosk bundle asset **after** the license check in Risk R5.
  - Until it passes the acceptance test (§13: at least 9 of 10 wakes at 2 m, and at most one false wake in a 2-hour radio/TV soak), the agent runs the bundled `hey_jarvis` model and tap.
- **While the page reports `speaking`, the agent ignores detections.** The agent's mic has no echo cancellation, and the bird saying "crow" would otherwise wake itself.

### 7.5 Barge-in

- **v1 barge-in is touch-only.** Tapping during speech sends `barge_in`. The server aborts the turn's LLM stream and TTS (the `signal` passed to `runVoiceTurn`), and the page flushes its playback queue.
- **Spoken barge-in is out of scope** because of the echo problem above. A follow-up could use the page's echo-cancelled stream for VAD-based barge-in.

## 8. `crow_wm`: kept and improved

The tool contract stays: the name `crow_wm`, one `command` string, JSON actions. Existing bot prompts and skills keep working. The improvements:

1. **Server-executed, event-delivered.** The kiosk turn executes `crow_wm` in-process (`servers/wm/server.js`), and the JSON action goes to the page as a `wm` event. The OLLV dependency on `tool_call_status` goes away.
2. **A capability-aware tool description.** The tool description is generated per session from the display's `caps` (from `hello`). It lists only the commands this display supports, and a Pi 3 profile omits `browser`, `videocall` and `pet`. That gives a shorter prompt (latency) and fewer impossible calls from the 4B.
3. **Window state on the server, and visible to the model.** The server keeps each device's open windows (id, kind, title, opened_at). The prompt suffix lists them ("Open: timer 'pasta' 6:12 left; recipe 'Lasagna' step 3/8"), so "close the recipe" and "how long on the pasta?" work. Today `crow_wm` is stateless and blind to what is on screen.
4. **New native window kinds.** These are plain DOM with no iframe, so they are cheap on a Pi 3:
   - **timer:** named and multiple, held on the server so they survive a page reload. On expiry it rings, speaks the name, and shows a full-screen card until dismissed. Commands: `timer <duration> [name]`, `stop timer [name]`.
   - **list:** the HA `todo` entity (the shopping list) shown and editable by voice: `list show`, `list add <item>`. HA calls go through the kiosk HA client, and `todo.*` services are limited to the configured list entity.
   - **recipe:** title + ingredients + numbered steps from the bot. Voice `next step`/`previous step`/`read step` is a fast path. When Kitchen ships, its recipes become the source.
   - **content:** the existing `display <title> | <body>` blocks.
   - **camera:** K4. A snapshot or low-res live view from the cameras spec.
5. **Touch.** Swipe to dismiss (horizontal fling of 80 px or more, or velocity above 0.5 px/ms), tap a tab to switch, long-press for close-all. There are no snap zones or drag on screens below 1024 px wide. The desktop layout is kept for wider screens.
6. **Fast paths with no LLM.** `close`, `close all`, `next`, `previous`, `stop timer`, `pause`, `resume`.
7. **Memory budget per display.** On the Pi 3 profile there is at most one iframe window (YouTube) open, and opening a second replaces the first. There are at most 4 windows.
8. **Removed for the kiosk:**
   - `open pet` (the Live2D AppImage), which goes with OLLV in §11;
   - the social commands `invite`, `memo` and `react`, which are not advertised on kiosk displays (the server code stays for other callers);
   - saved workspaces move from browser storage to per-device server state.

The page-side window manager is a **new, smaller module** (`bundles/kiosk/public/wm.js`). It reuses `crow-wm.js`'s action schema and the rich-content block renderer (`heading`/`text`/`list`/`card`/`divider`). It does not port the 1,284-line OLLV-injected file.

## 9. Performance budget and how it is measured

| metric | budget | how measured | where |
|---|---|---|---|
| Chromium memory, idle | ≤ 300 MB | Sum of `Pss` from `/proc/<pid>/smaps_rollup` over all chromium processes, sampled every 60 s by `scripts/kiosk/mem-sample.sh` (shipped by the setup script) | real Pi 3, K2 + K3 acceptance |
| Chromium memory, after 50 turns + 20 window opens | ≤ 300 MB, and less than 10 % growth over a 24 h idle soak afterwards | same sampler; the soak shows leaks | real Pi 3 |
| CPU, idle screen | ≤ 20 % average of one core (Chromium + agent) | `pidstat 60` | real Pi 3 |
| Idle video | none | code rule: no `<video>`/iframe on the idle screen; a test asserts the idle DOM has neither | hermetic |
| Bird loop | SVG ≤ 2 KB, CSS-only animation, no rAF at idle | test asserts no `requestAnimationFrame` registration in idle state | hermetic |
| End of speech → first TTS audio, short question on the fast model | < 2.0 s median, < 3.0 s p90 over 20 scripted questions | The page measures `t_play − t_vad_end` with `performance.now()` on the same device and reports it as `turn_metrics`. The server adds stage timings (STT, first LLM token, first TTS chunk). Results land in a per-device ring buffer shown in the panel's Diagnostics | phone (K1 gate), Pi (K2 gate) |

Expected breakdown for the 2 s target. These are estimates for the plan to check, not measurements:

- VAD hangover: 600 ms;
- STT on a 2–3 s clip with `distil-small.en` on crow's CPU: about 300–500 ms;
- the 4B's first sentence: about 300–500 ms;
- Kokoro's first sentence: about 200–300 ms;
- playback start: about 50 ms.

**If the K1 measurement misses the budget,** the levers in order are:

1. a shorter VAD hangover (450 ms);
2. a smaller STT model (`tiny.en`) or STT on the GPU;
3. a pre-synthesized acknowledgement.

The plan must report which lever was used.

## 10. Security

- **Device token.**
  - 32 random bytes, stored only as sha256 (the existing store).
  - Accepted **only** by `/api/kiosk/session` (in `hello`). From K4 it is also accepted by the camera routes of the cameras spec (`/api/cameras/<name>/{live,snapshot.jpg}`), limited to that display's allowed cameras. All idle-screen data arrives over the session.
  - It is never accepted by `dashboardAuth`, MCP mounts, `/llm/v1`, the board, or any other route. Tests assert a kiosk token gets 401 on representative other routes.
  - It sits in Chromium `localStorage` on the Pi's SD card, so **physical access to the SD card means kiosk access**. The blast radius is what the display can do:
    - talk to its bound bot (whose tool scope and permission policy apply, with memory stripped by default);
    - toggle allowlisted HA tiles;
    - see tray-filtered notifications.
  - Unpairing revokes it.
  - Recommendation (panel copy): bind kiosks to a **household bot** with a narrow tool selection, not to the owner's personal bot.
- **HA token.** A non-admin HA user, sealed at rest, local scope, server-side only. Crow-side entity and service allowlists are the real boundary (§6.1).
- **Pairing.** In-memory pending entries with a 10-minute lifetime, rate limits, an authenticated approver who sees the requester IP and user agent, and a poll secret (§4.4).
- **Network.** Tailnet + loopback only, no Funnel (three layers per the repo's network exposure invariant). The plan adds `/kiosk` and `/api/kiosk` cases to `tests/auth-network.test.js`.
- **Audio.** Nothing leaves the Pi before a wake or a tap. The pre-roll buffer is in page memory only. **No audio is stored on crow:** the turn's WAV is discarded after STT, and only transcripts enter the device's in-memory conversation.
- **Page.** A strict CSP: `default-src 'self'`, with `frame-src` limited to the YouTube embed origin for the one `crow_wm` iframe kind kept on the kiosk, and `connect-src 'self' ws://127.0.0.1:8770`.
- **Pi.** Key-only SSH. Chromium policies stop navigation off the Crow origin and disable dev tools. No other services listen. Unattended upgrades are on. **Tailscale key expiry is disabled for the kiosk node** ([KEVIN], admin console), because grackle's silent 5-day logout (2026-09) shows the failure mode.

## 11. Migration from the OLLV companion

**What carries over:**

| from (companion) | to (kiosk) |
|---|---|
| Device records with `device_kind:"companion"` (crow: `crow-kiosk`, unbound, never seen) | `device_kind:"kiosk"`, through an idempotent migration in the device store on load. Kept for the record. It has no usable token (OLLV never used one), so the display must be **paired** (§4.4) before use |
| `bound_bot_id` | kept as is |
| `companion_features.hearing_style` (`push_to_talk`/`wake_word`/`always`) | `kiosk.wake: tap` / `wake_word` / `wake_word` (always-listening is not offered; it would stream all room audio) |
| `companion_features.voice_idle_timeout` | `kiosk.follow_up_s` |
| `companion_features.memory_integration` | same name and same default (off), enforced in §7.1 |
| `companion_features.avatar_animation` / `pet_mode` | `kiosk.animation` (bird on/off) / dropped |
| `companion_features.social_chat`, `face_tracking`, `avatar_model` | dropped (no social UI, no camera on the kiosk, the bird replaces Live2D) |
| `COMPANION_PERSONA` / `COMPANION_CHARACTER_NAME` (unset on crow today) | if set, the panel offers "Create a kiosk bot from the companion persona". The bot persona is the only persona source on the kiosk |
| `COMPANION_TTS_VOICE` | the voice on the device's TTS profile |
| Household profiles (`COMPANION_PROFILE_N_*`; crow has `Kevin`) | **dropped.** Without speaker identification the kiosk cannot know who is talking. Per-person memory scoping is moot while memory is off by default |
| The Bot Builder Gateways tab type "AI Companion" | renamed "Kiosk display". It shows paired kiosk devices and the kiosk settings; the "type a name to pair" shortcut is replaced by the code flow |
| The `/llm/v1` router and `crow-voice` | **kept.** The router still serves glasses and the model door, and the 4B is the kiosk's fast model |

**Deleted, in the K3 retirement PR after the K3 acceptance passes:**

- the `bundles/companion/` tree: the Dockerfile, scripts, patches, `crow-wm.js`, injectors, `generate-config.py`, `settings-section.js` and skills;
- `servers/gateway/routes/companion-proxy.js`, `routes/federation-companion.js`, `dashboard/companion-target.js`, and their boot wiring in `boot/late-mounts.js` and `boot/post-listen.js`;
- the `/companion` path exception in `servers/gateway/index.js`;
- the layout's kiosk iframe overlay (`dashboard/shared/layout.js` `#kiosk-overlay`). The header's Companion button becomes **Kiosk** and opens `/kiosk` in a new tab. Without a token it shows a "This browser is not a paired display, pair it?" screen;
- the `companion_*` settings keys from `sync-allowlist.js`, plus the Settings → Companion section;
- `crow_wm`'s pet code (`PET_APPIMAGE_PATH`, the socket control);
- the registry entry, which is marked `deprecated` for one release (as W1 did with `nextcloud`) and then removed;
- the docs: `docs/architecture/companion.md` is replaced by `docs/architecture/kiosk.md`, and `docs/guide/kiosk-mode.md` is rewritten.

**Operator cleanup on crow** ([KEVIN] approves, after acceptance):

- uninstall the companion extension, which stops and removes the `crow-companion` container;
- `docker image rm crow-companion:latest` (13.9 GB);
- delete `~/.crow/live2d-models` (1.8 GB);
- remove the `companion` entry from `installed.json` through the uninstall path.

**Peers.** The kiosk button's peer federation (companion on a peer) is dropped. A display pairs with the one instance it is served by.

## 12. Phasing

| sub-project | scope | exit gate |
|---|---|---|
| **K1: kiosk page + voice loop (phone)** | core device-store move + throttle + `kiosk` kind; `servers/gateway/voice/turn.js`; `chooseVoiceRoute` export; the `kiosk` bundle (panel, routes, session WS, pairing, MCP tools + kiosk announce token); the page with bird states, captions, tap-to-talk, `crow_wm` v2 (timer/content/recipe, swipe, fast paths, server window state); the bird class hooks (Ramble bump); kiosk STT profile + kiosk TTS per Q2 (Kokoro install if chosen); latency instrumentation; hermetic tests | Kevin pairs his phone, asks 20 scripted short questions: median < 2 s, p90 < 3 s; a timer and a recipe open, swipe away, and voice-close |
| **K2: Pi bring-up + Pi kiosk** | the Pi bring-up prerequisites (below); `scripts/kiosk/pi-setup.sh`; `crow-kiosk-agent` (openWakeWord, ALSA dsnoop, backlight, local WS); Chromium policy; `hey_crow` training + license check; memory sampler | the live acceptance's Pi rows (§13.2): wake word, Q&A on the Pi, memory ≤ 300 MB, latency |
| **K3: home + today + sleep, then OLLV retirement** | HA client + sealed token + tile allowlist + tiles + `crow_kiosk_home` + HA fast path + weather; Today strip (dinner via the W2 capability when present, reminders); notification tray + speak; sleep schedule + wake sources; `list` window; then the separate **retirement PR** (§11) | live: light toggle (or a substitute tile if Q1 is open), dinner shown (if W2 has shipped, else confirm it degrades cleanly), sleep/wake; then the retirement PR merged and the operator cleanup done |
| **K4: cameras hookup** | after cameras C3 (sibling spec): the doorbell pops a `camera` window, wakes the display and plays the bird announce; a `camera` window by voice ("show the front door") | live doorbell press → pop on the Pi in ≤ 3 s, with the bird speaking |

**Pi bring-up (a K2 prerequisite; both Pis are offline).** None of these are code steps:

1. [KEVIN] Say which Pi is the Pi 3 with the screen (colibri or mockingbird; Q3). Power it with an official 2.5 A supply; the screen draws from it.
2. [KEVIN] Delete the stale tailnet entry for that hostname in the Tailscale admin console, so the new node keeps the name.
3. Flash current **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. Preset the hostname, user `kh0pp` with crow's SSH public key, Wi-Fi (2.4 GHz; the Pi 3 has no 5 GHz) and the locale. Record the OS release.
4. Check the hardware on the bench:
   - the DSI screen is detected (`/sys/class/backlight/*` exists, and `kmsprint` shows an 800×480 connector);
   - the touch input appears in `libinput list-devices`;
   - the USB mic records (`arecord -D plughw:…`) and the speaker plays (`speaker-test`).
5. Run `pi-setup.sh --crow-url https://crow.dachshund-chromatic.ts.net:8444`. [KEVIN] Open the printed Tailscale login URL and approve, then **disable key expiry** for the node.
6. Recreate `~/bin/<hostname>` on the lab machines if the Tailscale IP changed (CLAUDE.md "New Machine Template"), and update the `CLAUDE.md` machine list through `claude-config`.

## 13. Testing and acceptance

### 13.1 Hermetic (in `npm test`, scratch env)

- **Pairing.** start → approve → one-time pickup. Covered: a wrong code is rejected, lockout after 5 tries, an expired code, a wrong `poll_secret`, the token delivered exactly once, a second pickup gets 404, the rate limit, the pending cap, unpair closes the session with 4401.
- **Token scope.** A kiosk token gets 401 on `/api/notifications`, `/router/mcp`, `/llm/v1/chat/completions`, `/dashboard`. A WS without `hello` within 5 s closes 4401. The token appearing in the URL is ignored.
- **Device store.** The `companion→kiosk` migration is idempotent. Re-pairing keeps the binding. The `last_seen` throttle holds. The shim re-export resolves.
- **Voice turn** with fake STT, LLM and TTS adapters (an injected adapter factory):
  - the transcript flows to the bot prompt with the persona;
  - tools are scoped by `botVoiceScope`, and the memory category is stripped unless `memory_integration`;
  - the think gate never speaks `<think>` text;
  - sentence chunking; barge-in aborts the LLM and TTS within 100 ms (fake clock);
  - a cold escalation target falls back to the fast model after the timeout;
  - the destructive-tool confirmation retry.
- **`chooseVoiceRoute`.** It gives the same decisions as the router on the existing `llm-router` fixtures.
- **`crow_wm` v2.** The capability-filtered description; the server window state; the timer surviving a session reconnect; the fast paths bypassing the LLM; the per-profile iframe/window caps.
- **HA** with a fake HA WebSocket server:
  - tile state subscribe and diff;
  - an allowlisted toggle calls the right service;
  - a non-allowlisted entity or a disallowed service is refused server-side, both for a `tile_action` and for `crow_kiosk_home`;
  - the HA fast path parses "turn off kitchen light";
  - the token is never present in any response or log line (a log capture assertion);
  - a sealed round trip.
- **Today and notifications.** Dinner is hidden when the workspace capability is absent or throws. The tray filter respects `tray_types`. `speak_types` respects sleep, and the doorbell exception holds.
- **Page.** The idle DOM has no video or iframe and no rAF at idle (jsdom-level check). The bird SVG is ≤ 2 KB and has the class hooks. A Ramble bird-svg compatibility test checks identical geometry with and without classes.
- **auth-network.** The `/kiosk` and `/api/kiosk` Funnel and off-tailnet refusal cases.

### 13.2 Live acceptance (real devices)

Each row is evidence-backed: logs, screenshots and sampler output saved under `~/crow-weekend-push/reports/` or the plan's report path.

| # | check | steps |
|---|---|---|
| A1 | Phone pairing (K1) | [KEVIN] open `/kiosk` on the phone, read the code, approve in the dashboard with a bot → the bird appears |
| A2 | Phone latency (K1) | [KEVIN] ask the 20 scripted short questions (a list ships with the plan) → panel Diagnostics shows median < 2 s, p90 < 3 s |
| A3 | Windows (K1) | [KEVIN] "set a timer for 2 minutes called tea", "show me a lasagna recipe", swipe the recipe away, "close the timer" |
| A4 | Pi pairing + wake (K2) | [KEVIN] pair the Pi; say "Hey Crow" 10 times from about 2 m → at least 9 wakes; 2 h with the TV on → at most 1 false wake |
| A5 | Pi Q&A + memory (K2) | [KEVIN] 20 questions on the Pi (latency as A2); the sampler shows ≤ 300 MB idle and after the session; then a 24 h soak |
| A6 | Light toggle (K3) | [KEVIN] tap the light tile → the light changes; say "turn off the kitchen light" → it changes, with no 35B escalation in the server log (needs Q1; otherwise the vacuum dock/start tile stands in) |
| A7 | Dinner (K3) | [KEVIN] add tonight's dinner to the Menu calendar from the phone → it appears on the Today strip within 5 min (if W2 has shipped); otherwise the slot is hidden and nothing errors |
| A8 | Sleep/wake (K3) | set a sleep window 2 min ahead → the backlight goes off; a touch wakes it without pressing a tile; "Hey Crow" while dark wakes it and answers |
| A9 | Notification (K3) | create a high-priority reminder → it appears in the tray and is spoken once; a `peer` message does not appear |
| A10 | Doorbell (K4) | [KEVIN] press the Ring doorbell → the display wakes, the camera window pops in ≤ 3 s, and the bird says "Someone's at the door" |

## 14. Risks

- **R1: Chromium on a 1 GB Pi 3.**
  - Chromium alone can exceed the budget on heavy pages. The kiosk page is small, but the risk is real.
  - Mitigation: zram, `--renderer-process-limit=2`, no idle video, one iframe maximum, and an early K2 measurement **before** K3 builds more UI.
  - Fallback if 300 MB is not reachable: the kiosk page's Pi profile drops iframe windows entirely.
- **R2: The latency budget.** STT on CPU plus a cloud TTS would miss it. The plan gates K1 on the measured numbers and the §9 levers.
- **R3: Escalated turns are slow.** Any request the 4B routes to the 35B (tool intent) is outside the 2 s promise, and minutes long when the 35B is cold. Mitigations: the HA and wm fast paths, the filler phrase, and the cold fallback (§7.2).
- **R4: Wake word quality.**
  - A custom "Hey Crow" model may false-trigger on TV speech.
  - Mitigations: the soak test gate, a detection threshold that can be set per device in the panel, the speaking-suppression rule, and the `hey_jarvis` fallback.
- **R5: Wake model license.**
  - openWakeWord's code is Apache-2.0, but its published pretrained models are non-commercial (CC BY-NC-SA). The training negatives and the Piper voices used for synthetic positives carry their own licenses.
  - The plan must verify the licenses of everything used to train `hey_crow` before committing the model to the public repo. If it cannot, the model is generated locally by a script and never committed.
- **R6: Audio device sharing on the Pi.** `dsnoop` sharing between Chromium and the agent must work with the actual USB mic. A bench check in the bring-up step 4 extends to running both consumers at once.
- **R7: Extracting the voice turn.** The module is extracted from a large glasses file. Mitigation: glasses is not switched in this work, and pinning tests cover the reused behaviors.
- **R8: HA has no lights or thermostat today.** A6 depends on Q1.

## 15. Open questions for Kevin

- **Q1:** Which lights and thermostat should the tiles control? HA on crow has no `light` or `climate` entities today, and no scenes or scripts. Do they need integrating into HA first (what brand or hub), or does acceptance run on the vacuum and TV tiles for now?
- **Q2:** Kiosk TTS default: local **Kokoro** (install the `kokoro-tts` bundle; private and faster) or keep **Edge TTS** (cloud; the current companion voice `en-GB-LibbyNeural`)? This spec recommends Kokoro.
- **Q3:** Which Pi gets the screen: colibri or mockingbird? Both offline. Does that unit already have the 7" screen, mic and speaker attached?
- **Q4:** Default sleep window. This spec assumes 22:30–06:30, with dim after 5 minutes and dark after 30 minutes idle during the day.
