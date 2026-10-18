---
name: sunvox-studio
description: AI-operable SunVox music engine — inspect, render and compose tracker music (.sunvox/.xm/.mod) headlessly
triggers:
  - sunvox
  - compose music
  - make a beat
  - render a track
  - chiptune
  - tracker music
  - modular synth
  - componer música
  - haz un beat
  - renderiza una pista
tools:
  - sunvox-studio
  - funkwhale
---

# SunVox Studio

Music as a first-class AI capability: inspect any SunVox/XM/MOD project, render projects to audio headlessly (~130x realtime, no audio device), and compose new tracks from JSON specs. The engine is the MIT-licensed SunVox library (vendored, offline mode).

## When to Activate

- User asks to make/compose music, a beat, a chiptune, a loop, a ringtone, ambient/generative audio
- User shares or names a `.sunvox`, `.xm` or `.mod` file and wants to know about it, hear it, or convert it
- User wants a track rendered to WAV/MP3/OGG, or uploaded to Funkwhale / played on the glasses
- Songbook workflows that need a backing track generated

## Tools

- **`sunvox_module_types`** — the composition reference: every module type (Analog generator, DrumSynth, Sampler, SpectraVoice, Echo, Reverb, Filter, LFO, …) with its controller names, ranges and defaults. **Always consult before composing.** Output exists automatically (module 0, referenced as `"out"`).
- **`sunvox_info`** — cheap structured metadata: name, BPM, TPL, duration, modules, patterns. Use first on any unfamiliar file.
- **`sunvox_render`** — project → `wav`/`mp3`/`ogg` in the work dir (`~/.crow/data/sunvox-studio/`). Returns the path; hand it to `fw_upload_track` (Funkwhale) for library/glasses playback.
- **`sunvox_compose`** — JSON spec → `.sunvox` project (+ optional render in the same call). The main creative tool.

## Compose spec (v1 contract)

```json
{
  "bpm": 90, "tpl": 6,
  "modules": [
    { "id": "kick", "type": "DrumSynth", "params": { "Bass tone": 40 } },
    { "id": "bass", "type": "Analog generator", "params": { "Waveform": 3, "Volume": 160 } },
    { "id": "echo", "type": "Echo", "params": { "Wet": 96, "Feedback": 128 } }
  ],
  "connections": [ ["bass", "echo", "out"] ],
  "patterns": [
    { "name": "main", "tracks": 2, "lines": 32, "x": 0, "y": 0,
      "events": [
        { "track": 0, "line": 0, "note": "C2", "velocity": 110, "module": "kick" },
        { "track": 1, "line": 0, "note": "C3", "velocity": 90, "module": "bass" },
        { "track": 1, "line": 6, "note": "G3", "velocity": 90, "module": "bass" }
      ] }
  ]
}
```

Rules the server enforces (errors enumerate valid options):
- `modules[].id` — unique; `"out"` is reserved (auto Output at module 0); never create an `Output` type.
- `params` keys are controller names from `sunvox_module_types` (case-insensitive).
- `connections` are chains (`[src, …, "out"]`); any module not used as a chain source auto-connects to Output.
- Notes: `"C3"`, `"F#4"`, `"Bb2"` or 1–127 (C0 = 1). Velocity 1–129 (0 = default).
- One line = one tick; `tpl` ticks per beat, `bpm` beats per minute. A 4/4 bar = 16 lines at TPL 4, or `tpl*4` lines generally.
- Successive patterns: next `x` = previous `x` + previous `lines`.
- Events can also set controllers/effects inline: `{ "ctl": N, "ctl_val": V }` or `{ "effect": 0xEE, "effect_param": 0xXXYY }`; `note_off: true` releases.

## Workflow: "make me a X and play it"

1. `sunvox_module_types` (skip if cached this session) → pick instruments.
2. `sunvox_compose` with `render: true, format: "mp3"` → project + audio in one call.
3. `fw_upload_track` with the returned `render_path` (library UUID from `fw_list_library`) → `fw_search`/`fw_play` for the glasses.
4. Iterate on feedback: adjust the spec (params, notes, chains), recompose. Each compose overwrites `<name>.sunvox` in the work dir; renders are timestamped.

## Composition tips

- **Drums**: DrumSynth presets are note-selected — different note numbers trigger different drum voices; keep kicks low (C1–C2). Layer a Compressor on the drum bus for glue.
- **Bass**: Analog generator, Waveform selector ~3 (saw), short Attack, low Sustain; add a Filter with F.freq ~40–120 for movement.
- **Space**: Echo/Reverb as sends — chain `instrument → echo → out` and balance with the effect's Dry/Wet.
- **Structure**: one pattern per section (intro/verse/chorus), arranged along x; keep 16–64 lines each.
- **Tempo**: set `bpm`/`tpl` in the spec (applied as effect 0x09). Defaults are BPM 125 / TPL 6.
- **Verify**: after composing, `sunvox_info` the project (counts, BPM) before/after rendering — catches silent mistakes cheaply.

## Gotchas

- Renders are deterministic offline pulls; a 30s track takes well under a second. Don't add artificial waits.
- `mp3`/`ogg` need ffmpeg on the host; fall back to `wav` with a note if conversion errors.
- The engine is serialised internally (one slot) — concurrent tool calls queue safely, but batch large renders one at a time.
- `.xm`/`.mod` load fine (info/render) but compose always saves `.sunvox`.
- Linux x86_64 only in v1. If `libsunvox not found` appears, the bundle's `vendor/sunvox.so` is missing — reinstall the bundle.
