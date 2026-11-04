---
name: studio
description: Use when the operator asks for anything in Crow Studio — writing, editing or mixing parts; adding, renaming or removing tracks, scenes and clips; changing an instrument; setting level, pan, mute or solo; rendering a song, scene or clip to hear it and read its loudness; or undoing a Studio edit.
triggers:
  - studio
  - edit the song
  - add a track
  - write a bassline
  - write a drum part
  - make it busier
  - change the instrument
  - mute the pad
  - render the song
  - undo that
  - mix the tracks
  - hacer una canción
  - añade un bajo
  - sube el volumen
tools:
  - studio
---

# Crow Studio

Crow Studio is one live song: the operator works in the dashboard while you edit the same document over MCP. Every call lands at once, appears tagged as yours, and is one undoable step. You hear nothing — every claim about sound comes from a render's numbers or from the operator's ear.

Powered by SunVox (modular synth & tracker)
Copyright (c) 2008 - 2026, Alexander Zolotov <nightradio@gmail.com>, WarmPlace.ru

## Read first

- `studio_session_summary` — always your first call: tracks with device and lock state, scenes, clips with a note count each. It pages 50 clips at a time; ask for `page: 2`, `3`, … while it says there is more.
- `studio_get_clip` — read a clip's notes before you change it.
- `studio_module_types` — the real controller names, ranges and defaults. A track device must be a generator: Analog generator, DrumSynth, Generator or SpectraVoice.
- Load `studio-preferences` at the start of every session — it reads and stores preferences through `crow-memory` — and store one whenever the operator teaches you one.

## Conventions

| Thing | Rule |
|---|---|
| Time | 4/4 only, 4 beats per bar. `t` and `d` are beats from the clip start, decimals allowed (0.5 = eighth). |
| Pitch | MIDI `p` 0–127, C4 = 60, one semitone per step. Quote names with numbers: "A2 (45)". |
| Velocity | `v` 1–127 per note: roughly 100+ accent, 70–90 body, 45–60 ghost. It drives the instrument, not the fader. |
| Clip length | `length_bars` 1–64; the clip loops over it, so notes must end inside it. |
| Scenes | A column; launching one starts that row on the next bar. One clip per track sounds at a time. |
| Track mix | `gain_db` −60..+12 (0 = unity), `pan` −1..+1, `mute`, `solo`. |
| Limits | 16 tracks, 64 scenes, 64 bars and 4096 notes per clip, plus the render length limit. Refused, never truncated — the message names the limit. |
| Audio tracks | A track is either a SunVox instrument or an audio track (`studio_track_add` with `kind: "audio"`). An audio clip holds **takes** the operator recorded and a **comp**: which take plays over which beats (`from_beat`–`to_beat`, sorted, never overlapping). |
| Takes | Only the operator records. You can read takes (`studio_takes`), keep one (`studio_take_keep`: it alone plays over the whole clip), comp (`studio_clip_set_comp`), restore a discarded one (`studio_take_restore`) and fix its timing (`studio_take_set_offset`). You cannot add or discard a take, and you cannot remove a clip, track or scene that holds takes — ask the operator. |
| Timeline | The arrangement: clips **placed** on bars, one lane per track, plus **markers** and **sections** on the ruler. A placement longer than its clip loops it; `offset_beats` starts it part-way into the clip; audio placements can fade in and out. The operator switches Session / Arrangement; you edit either. |
| Missing | No insert effects, sends, EQ, compressor or master bus yet. Say "Studio cannot yet …" rather than improvising. |

## Request → tools

| Request | Do this |
|---|---|
| "add a drum / pad / bass track" | `studio_track_add` with `device.type` and `params` from the catalogue, then `studio_clip_write` for its first clip |
| "rename this track / scene / clip" | `studio_track_rename` / `studio_scene_rename` / `studio_clip_rename` |
| "add a section / a bridge" | `studio_scene_add` for its clips, then on the timeline `studio_section_add` (`start_bar`, `end_bar`, `name`) and `studio_arrangement_place` for each track's clip in it |
| "lay the song out / arrange it" | read the scenes, then one `studio_arrangement_place` per track and section in bar order; `studio_marker_add` for cues. Placements on one track never overlap — the refusal names the clash |
| "make the chorus twice as long / cut bar 5 out" | `studio_arrangement_resize` (a longer placement loops its clip), or `studio_arrangement_split` at the bar and `studio_arrangement_remove` one half |
| "fade the guitar in" | `studio_arrangement_set_fades` on the audio placement (`fade_in_beats`, `fade_out_beats`; linear) |
| "how does the whole song sound?" | `studio_render` with `mode: "arrangement"` (and `from_bar` to start later), then report LUFS and peak per section from separate renders |
| "delete that track / scene / clip" | `studio_track_remove`, `studio_scene_remove` (both take their clips too) or `studio_clip_remove` — confirm first when notes would go |
| "change the instrument" | `studio_track_set_device`: `params` **replace** the old set, so pass every value you want kept |
| "darker / brighter / open the filter / shorten a drum" | `studio_track_set_param` with one real name from `studio_module_types`: `F.freq` or `F.resonance` (Analog generator), `Bass tone`, `Bass length`, `Snare tone`, `Snare length`, `Hihat length` (DrumSynth has no Attack or Release), `Volume` on every generator, `Attack`/`Release` only on Analog generator, Generator and SpectraVoice |
| "write / replace a part" | `studio_clip_write` with the whole note list; it creates the clip when `clip_id` is omitted |
| "fix, nudge or delete a note" | `studio_get_clip`, then `studio_clip_edit_notes` — `remove` by index, then `move`/`add`; indexes are the clip's own order |
| "make that clip 8 bars" | `studio_clip_set_length` (`length_bars`) |
| "make it busier" | `studio_clip_edit_notes` `add` on off-beats (0.5 or 0.25 offsets), shorten existing note lengths with `move`, or add a second clip on another track. Report the event count before and after |
| "make it sparser" | delete notes whose starts fall off the main beats with `remove`, lengthen the survivors with `move`, drop inner velocities 10–20 |
| "louder / quieter" | `studio_track_set_mix` `gain_db` in 1.5–3 dB steps (never above +12), or scale `v` by 10–15 % of its current value (never above 127); re-render and quote both LUFS readings |
| "wider / more stereo" | `studio_track_set_mix` `pan` two parts apart (−0.5 and +0.5); keep bass, kick and lead at 0. There is no width effect |
| "mute / solo / level / pan" | `studio_track_set_mix` |
| "play it" | You cannot start or stop the operator's playback. `studio_render` instead and give the operator the download URL |
| "undo that" / "redo it" | `studio_history`, then `studio_undo` with that entry's `id` as `entry_id`, on the newest entry authored by you (unless the operator names another); `studio_redo` takes the same `entry_id` and puts it back |
| "how loud is it / is it balanced?" | `studio_render` with `seconds` plus `scene_id` or `clip_id`; report `lufs` and `true_peak_db` |
| "tempo / key / title" | `studio_song_set_meta` (`bpm` 20–300) |
| "which take is best / keep take 2" | `studio_takes` for the clip (seconds, author, `in_comp`), render the scene once per candidate after `studio_take_keep`, report LUFS and peak, and let the operator's ear choose; restore the previous comp if they prefer it |
| "use the first half of take 1 and the end of take 3" | `studio_clip_set_comp` with two segments that meet exactly (e.g. `0–8` and `8–16` beats); the switch has a 64-sample crossfade |
| "that take is late / early" | `studio_takes` shows `compensated` and `offset_ms`. If `compensated` is false, ask the operator to calibrate the input and read you the milliseconds on the track's latency chip, then `studio_take_set_offset` with `offset_frames = round(ms × rate / 1000)` (the take's own `rate`) and `compensated: true` |
| "record a guitar part" | You cannot record. Say what to do instead: arm the audio track, press Record, launch the scene; each loop pass becomes its own take |

Refusals are information: a locked track (`locked`) or the clip the operator has open (`focused`) is off-limits. Say which one, and offer an alternative — another track, a new clip, or waiting for them to unlock it. Never reach around it.

## Editing etiquette

- **Read, then edit.** Never write a clip you have not read, and never invent ids: take them from the summary.
- **One request, as few steps as possible.** Each call is a separate undoable step, so a five-call answer to "louder" makes undo useless. Batch notes into one `clip_write`, and do not tidy unrelated things.
- **Say what changed, in music and in numbers**: "bar 2 beat 3, A2 (45) held 2 beats; the bass is now five notes instead of three".
- **Ask when the request is ambiguous.** "Busier" can mean more events, more layers, or more level — ask which, or do the smallest version and name the options.
- **Do not rewrite the operator's part unasked.** Add a new clip or scene beside it instead.
- **Variant work goes in a new scene or clip labelled A/B**, so the original stays untouched until the operator picks.

## Part balance

Renders come per song, scene or clip — there is no per-track render. To compare parts, solo each one in turn:

1. `studio_track_set_mix` `solo: true` on one track.
2. `studio_render` the scene for enough `seconds` (4 bars = 960/bpm seconds).
3. Note its LUFS, then `solo: false`.
4. Render the scene with nothing soloed and compare each part to that figure.

Every solo step is an undoable edit, so say so before you start and offer to skip it. Compare parts in LU (dB), not adjectives, and start from these rules, then trust the operator's ear:

- Lead/melody sits 1–3 LU above the next-loudest sustaining part; if it is not the loudest melodic line, say so.
- Bass within 3 LU of the lead; bass more than 1 LU above the lead usually means one of the two is misplaced.
- Pads and ghost layers 6–10 LU below the lead.
- Two parts within 1 LU of each other are not heard as separate layers; give them different registers or levels.
- Keep true peak at or below −1 dBTP. If a level change pushes it over, lower other tracks instead of raising this one.

## Feedback loop

- You cannot hear. Ask for timestamps ("the third chord drags") and convert: **beats = seconds × bpm ÷ 60**; then bar = ⌊beats ÷ 4⌋ + 1, beat = the remainder + 1. 7.5 s at 92 bpm = 11.5 beats = bar 3, beat 4½. That assumes a constant bpm and a render starting at the scene's first bar — ask which pass when a loop or tempo change is involved.
- Offer A/B scenes or clips, render both, and give the numbers for each. Replace nothing until the operator chooses.
- When the operator's ear and your measurement disagree, believe the ear and say what the measurement was.

## When to load another Studio skill

| Skill | For |
|---|---|
| `studio-counterpoint` | Writing or checking two or more lines against each other |
| `studio-harmony` | Chords, progressions, melody and key |
| `studio-rhythm-and-form` | Grooves, drums, sampler-style patterns, song structure |
| `studio-arranging-and-sound` | Instrument ranges, voicing, SunVox patches |
| `studio-mixing` | Levels, loudness targets, delivery |
| `studio-modern` | Post-tonal and experimental techniques |
| `studio-preferences` | Always: read at the start, store when taught |

A request to *write* a line — "write a bassline", "harmonise this melody" — fires both: load `studio-counterpoint` for intervals and voice leading, `studio-harmony` for chords, key and melody, before the first note.

## Sources

- SunVox, Alexander Zolotov, WarmPlace.ru — module catalogue and controller ranges, read from `studio_module_types`.
- ITU-R BS.1770-4, *Algorithms to measure audio programme loudness and true-peak audio level* (2015) — LUFS and dBTP.
- Ableton Live Reference Manual, "Launching Clips" (2024) — clip loop and next-bar scene launch conventions.