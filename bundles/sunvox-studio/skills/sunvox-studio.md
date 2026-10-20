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
- **`sunvox_info`** — cheap structured metadata: format (sunvox/xm/mod), name, project version, BPM, TPL and effective tempo, duration, modules (with x/y and colour), patterns (with their x/y on the timeline). Use first on any unfamiliar file.
- **`sunvox_render`** — project → `wav`/`mp3`/`ogg`. Saved to Crow storage when it is available (returns `storage_key` and a 1-hour `storage_url`) and in the work dir (`path`). Options: `sample_rate` (44100 or 48000), `notify: true` (a Crow notification when done), `funkwhale_library` (UUID or name: uploads the mp3/ogg to Funkwhale so `fw_play` can play it on the glasses).
- **`sunvox_compose`** — JSON spec → `.sunvox` project (+ optional render in the same call, with the same render options). The main creative tool.

Storage options on both: `save_to_storage` (default: save when storage is available; `true` = fail without it; `false` = local file only) and `reference_type: "blog_post"`, which makes the stored files **public** at `/blog/media/<key>`. Use `blog_post` only for files meant for a song page or another published post: the file is public as soon as it is saved, even before any post uses it.

Reading by `storage_key` works for SunVox Studio's own files (`sunvox-studio/...` keys) and blog media (files uploaded with `reference_type: "blog_post"`). Other stored files (project files, attachments, private uploads) are refused; copy such a file into the work dir and pass `path`.

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
- One line = one tick-row; **duration formula: seconds/line = TPL × 2.5 / BPM** (tracker standard). A 32-line pattern at BPM 85 / TPL 8 ≈ 7.5s. Higher TPL = slower + finer rhythmic resolution.
- **Arrangement** (the timeline): `"arrangement": [{ "pattern": "intro" }, { "pattern": "verse" }, { "pattern": "verse" }, { "pattern": "chorus", "x": 64 }]`. Entries play in order; a missing `x` starts right after the previous entry, a missing `y` is 0; placing a pattern twice repeats it (a clone that shares its notes). With an arrangement, every pattern needs a unique `id` and must be placed at least once. Without one, each pattern sits at its own `x`/`y` (next `x` = previous `x` + previous `lines`).
- `params` values must lie inside each controller's min..max from `sunvox_module_types` (out of range is an error, not a silent clamp).
- The compose `name` is also the song name. Composing again with a name that already exists is refused unless `overwrite: true`.
- Events can also set controllers/effects inline: `{ "ctl": N, "ctl_val": V }` or `{ "effect": 0xEE, "effect_param": 0xXXYY }`; `note_off: true` releases.

## Workflow: "make me a X and play it"

1. `sunvox_module_types` (skip if cached this session) → pick instruments.
2. `sunvox_compose` with `render: true, format: "mp3", funkwhale_library: "<library>"` → project + audio + Funkwhale upload in one call (library names from `fw_list_library`).
3. Play it: `fw_play` with the returned `funkwhale.funkwhale_track_id` (if the import was still running, `fw_search` for the song name, type tracks, then `fw_play`).
4. Iterate on feedback: adjust the spec (params, notes, chains), recompose with `overwrite: true` (or a new name). Renders are timestamped.

Without Funkwhale: the render's `storage_key` is in Crow storage (Files), and `fw_upload_track` can take the returned `path` later.

## Workflow: a song page backing track

1. `sunvox_compose` with `reference_type: "blog_post"` (add `render: true, format: "mp3"` for a plain audio copy too).
2. `crow_create_song` with `sunvox_key: <project_storage_key>` (and `audio_key: <render_storage_key>` for the audio copy). The song page gets the interactive SunVox player.

## Composition tips

- **Drums**: DrumSynth presets are note-selected — different note numbers trigger different drum voices; keep kicks low (C1–C2). Layer a Compressor on the drum bus for glue.
- **Bass**: Analog generator, Waveform selector ~3 (saw), short Attack, low Sustain; add a Filter with F.freq ~40–120 for movement.
- **Space**: Echo/Reverb as sends — chain `instrument → echo → out` and balance with the effect's Dry/Wet.
- **Structure**: one pattern per section (intro/verse/chorus), arranged along x; keep 16–64 lines each.
- **Tempo**: set `bpm`/`tpl` in the spec (applied as effects 0x1F and 0x0F on line 0 of the first pattern; give either or both). Defaults are BPM 125 / TPL 6.
- **Verify**: after composing, `sunvox_info` the project (counts, BPM) before/after rendering — catches silent mistakes cheaply.

## Gotchas

- Renders are deterministic offline pulls; a 30s track takes well under a second. Don't add artificial waits.
- `mp3`/`ogg` need ffmpeg on the host; fall back to `wav` with a note if conversion errors. Funkwhale takes only mp3/ogg.
- Storage uses the same limits as `crow_upload_file`: files above `MAX_UPLOAD_SIZE` (100 MB by default; a 20-minute WAV is about 210 MB) or past the storage quota are kept locally only; render to mp3 for long tracks.
- The engine is serialised internally (one slot) — concurrent tool calls queue safely, but batch large renders one at a time.
- `.xm`/`.mod` load fine (info/render) but compose always saves `.sunvox`.
- **Limits**: renders stop at 20 minutes (`SUNVOX_MAX_RENDER_SECONDS`, at most 60); a spec may have up to 128 modules, 256 patterns, 32 tracks and 4096 lines per pattern (about 2 million track-lines in all), and 65,536 events; source files up to 64 MB. `params` values are numbers (selectors take an index; see the min/max in `sunvox_module_types`).
- **Files**: a `path` must sit inside the work dir (`sunvox-studio/` in this instance's data dir, e.g. `~/.crow/data/sunvox-studio/`; compose and render write there); other folders need `SUNVOX_READ_DIRS` (the operator names narrow music folders there, never `/`, `..` or a home directory). Otherwise pass a `storage_key`.
- Linux x86_64 only in v1. If `libsunvox not found` appears, the bundle's `vendor/sunvox.so` is missing — reinstall the bundle.
