# Companion Backend Patches (Open-LLM-VTuber Python)

Patches against the upstream Python backend (`github.com/Open-LLM-VTuber/Open-LLM-VTuber`).

Currently in **draft form** — these document the intended changes. Applied automatically once Phase 3's submodule + build pipeline lands (`bundles/companion/scripts/build-pet-linux.sh`).

For Phase 2 MVP, the kiosk flow runs end-to-end via `/kiosk/api/hint` (HTTP) + browser TTS (speechSynthesis). The companion WS integration (`tutor-event` message + persona swap via `switch-config`) is a quality upgrade that depends on these patches.

## Patch slots

| Patch | Status | What it does |
|---|---|---|
| `0001-tutor-event-handler.patch` | draft | Adds `"tutor-event"` to `_message_handlers` in `websocket_handler.py`; the handler validates `session_token` against maker-lab, calls `maker_hint`, and speaks the filtered response via the per-client `ServiceContext.tts_engine`. |
| `0002-per-connection-session-context.patch` | **not needed** (Spike 1) | Backend is already per-connection (`client_contexts: Dict[str, ServiceContext]` with `model_copy(deep=True)` per session). Slot stays empty. |
| `0003-maker-lab-mcp-registration.patch` | draft | Adds `maker-lab` as a fourth MCP server in `generate-config.py`'s generated `mcp_servers.json`. For Phase 2 MVP, tools are already reachable via the existing `crow` router bridge, so this is optional. |

## Persona swap — no patch needed

Spike 2 confirmed the upstream `switch-config` WebSocket message already provides per-connection persona swap via character YAMLs in `/app/characters/`. Maker-lab ships three YAMLs (`maker_lab_kid_tutor.yaml`, `maker_lab_tween_tutor.yaml`, `maker_lab_adult_tutor.yaml`) and drives the swap server-side on `maker_start_session`.

The YAML generator and the server-side `switch-config` origination are Phase 2.1 work (not required for MVP since browser TTS currently carries the hint audio).
