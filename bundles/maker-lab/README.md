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

When the Crow host IS the kiosk (Raspberry Pi + attached display, solo mode), the Blockly page and the Crow Kiosk display page (`/display`, from the Kiosk display bundle) can be tiled side-by-side.

`scripts/launch-kiosk.sh` opens both in Chromium `--app` windows (2/3 left, 1/3 right). Usage:

```bash
# Default: the Crow gateway on localhost:3002, the display page at /display
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

## Voice

**What ships today**: the kiosk browser uses `speechSynthesis` to voice the hint.

The AI Companion (Open-LLM-VTuber + Live2D) that used to sit beside this page was retired
from Crow, and the `tutor-event` patch pipeline that voiced hints through its avatar's TTS
went with it. There is no companion backend to patch and no image to rebuild: a deployment
that wants spoken hints uses the browser's own voice, or the Kiosk display bundle's TTS.

## Phase 3 preview (not yet shipped)

- Electron/Tauri pet-mode overlay — floating mascot on top of the Blockly window

See `PHASE-0-REPORT.md` for the spike report that informed these decisions.
