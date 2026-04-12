# Maker Lab

Scaffolded AI learning companion paired with FOSS maker surfaces (Blockly first). Hint-ladder pedagogy, per-learner memory, age-banded personas, classroom-capable.

## Quick start

After installing the bundle via the Extensions panel:

1. **Create a learner** — Maker Lab panel → `+ Add learner`. Name + age + consent checkbox. Age drives persona (≤9 kid-tutor, 10–13 tween-tutor, 14+ adult-tutor).
2. **Start a session** — Click Start session on a learner's card. Panel returns a short redemption code + QR + full URL.
3. **Open the kiosk** — On any LAN device: scan the QR or visit `/kiosk/r/<code>`. Code is one-shot, 10-min TTL.
4. **Session ends** — Admin clicks End on the panel (5s graceful flush) or Force End (immediate).

## Modes

- **Solo** — one implicit learner, no QR handoff. Loopback-only by default. Toggle LAN exposure in Settings to allow other devices (first visit requires a Crow's Nest sign-in).
- **Family** — per-learner Start session.
- **Classroom** — multi-select learners + Bulk Start → printable QR sheet. Revoke the whole batch with one action.
- **Guest** — "Try it without saving" in any mode. Ephemeral, no memory, no artifact save, 30-min cap.

## Tutor hint pipeline

Every `maker_hint` call runs through:

1. **State machine check** — if session is `ending` / `revoked`, returns a canned wrap-up hint.
2. **Rate limit** — 6/min per session.
3. **LLM call** — any OpenAI-compatible endpoint (`MAKER_LAB_LLM_ENDPOINT`, default `http://localhost:11434/v1` = Ollama).
4. **Output filter** — Flesch-Kincaid grade cap (kid-tutor only), kid-safe blocklist, per-persona word budget.
5. **Canned fallback** — filtered-out or LLM failure returns a lesson canned hint, never a raw error.

See `DATA-HANDLING.md` for exactly what data is stored, COPPA/GDPR-K posture, and export/delete paths.

## Same-host kiosk (Pi-style deployment)

When the Crow host IS the kiosk (Raspberry Pi + attached display, solo mode), the Blockly page and the AI Companion's web UI should appear tiled side-by-side.

`scripts/launch-kiosk.sh` opens both in Chromium `--app` windows (2/3 left, 1/3 right). Usage:

```bash
# Default: localhost:3002 (gateway) + localhost:12393 (companion)
./scripts/launch-kiosk.sh

# Custom host
CROW_HOST=pi5.local ./scripts/launch-kiosk.sh
```

This is the web-tiled fallback. Phase 3 adds an Electron/Tauri pet-mode overlay that floats the mascot on top of the Blockly window without a separate browser tab.

## Lesson authoring

Lessons live at:

- `curriculum/age-5-9/*.json` — bundled (10 lessons: sequences, loops, events, conditions, capstone)
- `~/.crow/bundles/maker-lab/curriculum/custom/*.json` — your additions

Authors can add lessons via the admin panel (Lessons → Import) without touching code. Schema: `curriculum/SCHEMA.md`.

Each lesson declares:

- `toolbox` — what Blockly blocks are available (per-category)
- `success_check.required_blocks` — block types the workspace must contain before "I'm done!" is accepted
- `canned_hints` — fallback hints when the LLM is unavailable or filtered

## Companion integration

**Phase 2 MVP** (what ships today): kiosk browser uses `speechSynthesis` to voice the hint. No companion modifications required.

**Phase 2 upgrade path** (requires companion rebuild): apply the `tutor-event` patch so the AI Companion's per-client TTS voices the hint through the mascot. Two pieces:

1. `bundles/companion/scripts/patch-tutor-event.py` — idempotent patcher, wired into the companion's `entrypoint.sh`. Modifies `/app/src/open_llm_vtuber/websocket_handler.py` at container startup.
2. `bundles/maker-lab/panel/routes.js` — serves `POST /maker-lab/api/hint-internal` (loopback-only) for the patched handler to call.

To apply:

```bash
# Rebuild the companion image to pick up the patch script.
cd bundles/companion && docker compose build && docker compose up -d

# The patcher runs at container startup. Logs show:
#   Applying Maker Lab tutor-event patch...
#   [maker-lab patch] tutor-event handler installed
# (or "already present; skipping" on subsequent starts)
```

The kiosk's Blockly page sends a `tutor-event` WebSocket message to the companion, the companion calls `/maker-lab/api/hint-internal` with the session token, and the filtered reply plays through the mascot's TTS.

Until the companion is rebuilt, the kiosk continues using `speechSynthesis`.

## Phase 3 preview (not yet shipped)

- Electron/Tauri pet-mode overlay — floating Live2D mascot on top of the Blockly window
- Cubism SDK install-time fetch (see `bundles/companion/CUBISM-LICENSE.md`)
- Submodule + patch pipeline for the companion backend + renderer

See `PHASE-0-REPORT.md` for the spike report that informed these decisions.
