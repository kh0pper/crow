---
name: studio
description: Use when the operator asks for anything in Crow Studio — writing, editing or mixing parts; adding, renaming or removing tracks, scenes and clips; changing an instrument; setting level, pan, mute or solo; programming a sampler pattern, a step lock or a chain of patterns; rendering a song, scene or clip to hear it and read its loudness; or undoing a Studio edit.
triggers:
  - studio
  - edit the song
  - add a track
  - write a bassline
  - write a drum part
  - make it busier
  - change the instrument
  - soundfont
  - bank
  - general midi
  - which instrument
  - mute the pad
  - render the song
  - undo that
  - mix the tracks
  - add an effect
  - add a compressor
  - add some reverb
  - master the song
  - sampler
  - drum pattern
  - step lock
  - chain the patterns
  - chop the sample
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
- `studio_get_clip` — read a clip before you change it: its notes, or a pattern clip's patterns, steps and motion lanes.
- `studio_samples` — on a sampler track, read the song's samples first: id, name, seconds, origin, the pads that play each one and its slices in order. Ids come from there.
- `studio_library` — on a soundfont track, read the song's banks first: id, name, licence, credit and the tracks that play each one. Ids come from there.
- `studio_mix` — before you touch a chain: the effects in it, the sends and returns, the master's gain and the song's target, and the figures the last render measured.
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
| Missing | An amp insert (a NAM capture with a cabinet) arrives in a later Studio version, and there is no sidechain from another track and no look-ahead on a track insert. Say "Studio cannot yet …" rather than improvising. |

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
| "change the instrument" | `studio_track_set_device`: `params` **replace** the old set, so pass every value you want kept. On a soundfont track the instrument is its preset: `studio_track_set_program` (the bank itself is the operator's, see **Instruments**) |
| "darker / brighter / open the filter / shorten a drum" | `studio_track_set_param` with one real name from `studio_module_types`: `F.freq` or `F.resonance` (Analog generator), `Bass tone`, `Bass length`, `Snare tone`, `Snare length`, `Hihat length` (DrumSynth has no Attack or Release), `Volume` on every generator, `Attack`/`Release` only on Analog generator, Generator and SpectraVoice |
| "write / replace a part" | `studio_clip_write` with the whole note list; it creates the clip when `clip_id` is omitted |
| "fix, nudge or delete a note" | `studio_get_clip`, then `studio_clip_edit_notes` — `remove` by index, then `move`/`add`; indexes are the clip's own order |
| "make that clip 8 bars" | `studio_clip_set_length` (`length_bars`) |
| "make it busier" | `studio_clip_edit_notes` `add` on off-beats (0.5 or 0.25 offsets), shorten existing note lengths with `move`, or add a second clip on another track. Report the event count before and after |
| "make it sparser" | delete notes whose starts fall off the main beats with `remove`, lengthen the survivors with `move`, drop inner velocities 10–20 |
| "louder / quieter" | `studio_track_set_mix` `gain_db` in 1.5–3 dB steps (never above +12), or scale `v` by 10–15 % of its current value (never above 127); for the whole song the master's `gain_db` (`studio_master_set`); re-render and quote both LUFS readings |
| "wider / more stereo" | `studio_track_set_mix` `pan` two parts apart (−0.5 and +0.5); keep bass, kick and lead at 0. There is no width effect |
| "mute / solo / level / pan" | `studio_track_set_mix` |
| "play it" | You cannot start or stop the operator's playback. `studio_render` instead and give the operator the download URL |
| "undo that" / "redo it" | `studio_history`, then `studio_undo` with that entry's `id` as `entry_id`, on the newest entry authored by you (unless the operator names another); `studio_redo` takes the same `entry_id` and puts it back |
| "how loud is it / is it balanced?" | `studio_mix` for the chains and the last render's figures, then `studio_render` with `seconds` plus `scene_id` or `clip_id`; report `lufs`, `true_peak_db` and `short_term_max_lufs` against the song's `target` |
| "add EQ / a compressor / reverb here" | `studio_insert_add` with `owner: "track:<id>"`, a `kind` and `params` from the table in **Mixer**; read the chains first with `studio_mix` |
| "give it some space / a reverb" | `studio_return_add`, an insert on that return (`kind: "reverb"`, `mix` 1), then one `studio_send_set` per source track |
| "master it / hit −14 LUFS" | the master's chain (`studio_insert_add` with `owner: "master"`, a `limiter` last), `studio_master_set` for `gain_db` and `target`, then `studio_render` and report `meets_target` |
| "tempo / key / title" | `studio_song_set_meta` (`bpm` 20–300) |
| "which take is best / keep take 2" | `studio_takes` for the clip (seconds, author, `in_comp`), render the scene once per candidate after `studio_take_keep`, report LUFS and peak, and let the operator's ear choose; restore the previous comp if they prefer it |
| "use the first half of take 1 and the end of take 3" | `studio_clip_set_comp` with two segments that meet exactly (e.g. `0–8` and `8–16` beats); the switch has a 64-sample crossfade |
| "that take is late / early" | `studio_takes` shows `compensated` and `offset_ms`. If `compensated` is false, ask the operator to calibrate the input and read you the milliseconds on the track's latency chip, then `studio_take_set_offset` with `offset_frames = round(ms × rate / 1000)` (the take's own `rate`) and `compensated: true` |
| "record a guitar part" | You cannot record. Say what to do instead: arm the audio track, press Record, launch the scene; each loop pass becomes its own take |

Refusals are information: a locked track (`locked`) or the clip the operator has open (`focused`) is off-limits. Say which one, and offer an alternative — another track, a new clip, or waiting for them to unlock it. Never reach around it.

## Instruments

A **soundfont track** (`studio_track_add` with `kind: "soundfont"` and a `font_id`) plays one **preset** of one **bank** — a SoundFont (SF2/SF3) file in the song's library. Bank 0–127 is melodic; **bank 128 is the General MIDI drum bank**, where the program names a kit and the note number picks the drum. Read the banks with `studio_library` before you touch an instrument: it gives each one's id, name, licence, credit and the tracks that play it.

| Tool | What it does |
|---|---|
| `studio_library` | The song's library: `{id, kind, name, source, licence, credit, used_by: [{track_id, track_name} | {insert_id, owner, label}]}`, plus `available_catalog` — the banks this Crow could download. `used_by` names a track that plays the entry and an amp insert that plays its capture or cabinet. Read-only |
| `studio_track_add` | `{kind: "soundfont", font_id}` makes a soundfont track playing program 0 of bank 0 of that bank; `font_id` must already be in the library |
| `studio_track_set_program` | The preset: `{track_id, bank, program}`, bank 0–128 and program 0–127. ONE step, and one you may always make |
| `studio_track_set_font` | Which bank a track plays. You may give a bank to a track that has none yet; once a track plays a bank, changing it is refused for you: it is the operator's step |

**A bank is the person's choice.** Only the operator downloads a catalog bank (a track's **Get the default instruments**, or **Get this instrument**) or uploads their own file (**Add your own bank…**), and you have no tool for either. No command of yours can point a track that plays a bank at another one, or remove a track that plays one ("Only the operator changes the instrument a track plays."). `library.remove` works only on an entry nothing plays; for anyone, an entry a track still plays is refused with "… is in use by …; change what that track plays first." Nor may any undo or redo of yours add a library entry or take one away: the file's arrival and its departure are both the operator's steps. What you may change is the preset, and every program change is an ordinary undoable agent step.

A bank the song names but this device does not hold plays **silence**: a render reports it in `missing_library` and the track offers the download. Say which instrument is missing and that the operator has to fetch it, rather than rewriting the part.

### General MIDI programs

The names Studio shows beside a program number, by family. The numbers are the `program` value you pass (0–127); Studio counts one higher when it speaks, so "program 2 (Bright Acoustic Piano)" is `program: 1`.

| Program | Family | Names, program 0 first |
|---|---|---|
| 0–7 | Piano | Acoustic Grand Piano, Bright Acoustic Piano, Electric Grand Piano, Honky-tonk Piano, Electric Piano 1, Electric Piano 2, Harpsichord, Clavinet |
| 8–15 | Chromatic percussion | Celesta, Glockenspiel, Music Box, Vibraphone, Marimba, Xylophone, Tubular Bells, Dulcimer |
| 16–23 | Organ | Drawbar Organ, Percussive Organ, Rock Organ, Church Organ, Reed Organ, Accordion, Harmonica, Tango Accordion |
| 24–31 | Guitar | Acoustic Guitar (nylon), Acoustic Guitar (steel), Electric Guitar (jazz), Electric Guitar (clean), Electric Guitar (muted), Overdriven Guitar, Distortion Guitar, Guitar Harmonics |
| 32–39 | Bass | Acoustic Bass, Electric Bass (finger), Electric Bass (pick), Fretless Bass, Slap Bass 1, Slap Bass 2, Synth Bass 1, Synth Bass 2 |
| 40–47 | Strings | Violin, Viola, Cello, Contrabass, Tremolo Strings, Pizzicato Strings, Orchestral Harp, Timpani |
| 48–55 | Ensemble | String Ensemble 1, String Ensemble 2, SynthStrings 1, SynthStrings 2, Choir Aahs, Voice Oohs, Synth Voice, Orchestra Hit |
| 56–63 | Brass | Trumpet, Trombone, Tuba, Muted Trumpet, French Horn, Brass Section, SynthBrass 1, SynthBrass 2 |
| 64–71 | Reed | Soprano Sax, Alto Sax, Tenor Sax, Baritone Sax, Oboe, English Horn, Bassoon, Clarinet |
| 72–79 | Pipe | Piccolo, Flute, Recorder, Pan Flute, Blown Bottle, Shakuhachi, Whistle, Ocarina |
| 80–87 | Synth lead | Lead 1 (square), Lead 2 (sawtooth), Lead 3 (calliope), Lead 4 (chiff), Lead 5 (charang), Lead 6 (voice), Lead 7 (fifths), Lead 8 (bass + lead) |
| 88–95 | Synth pad | Pad 1 (new age), Pad 2 (warm), Pad 3 (polysynth), Pad 4 (choir), Pad 5 (bowed), Pad 6 (metallic), Pad 7 (halo), Pad 8 (sweep) |
| 96–103 | Synth effects | FX 1 (rain), FX 2 (soundtrack), FX 3 (crystal), FX 4 (atmosphere), FX 5 (brightness), FX 6 (goblins), FX 7 (echoes), FX 8 (sci-fi) |
| 104–111 | Ethnic | Sitar, Banjo, Shamisen, Koto, Kalimba, Bag pipe, Fiddle, Shanai |
| 112–119 | Percussive | Tinkle Bell, Agogo, Steel Drums, Woodblock, Taiko Drum, Melodic Tom, Synth Drum, Reverse Cymbal |
| 120–127 | Sound effects | Guitar Fret Noise, Breath Noise, Seashore, Bird Tweet, Telephone Ring, Helicopter, Applause, Gunshot |

**The drum bank (bank 128)** names a kit by program: 0 Standard, 8 Room, 16 Power, 24 Electronic, 25 TR-808, 32 Jazz, 40 Brush, 48 Orchestra, 56 SFX. There the program picks the kit and the NOTES pick the drums — the GM percussion map runs 35–81, from kick and snare up through toms, cymbals, Latin percussion and triangles. The map, the drum programming and the voicing for each family are in `studio-arranging-and-sound`.

Every bank's presets are its own: the names above are what GM asks for, not a promise that this bank holds that sound. Pick a preset, render, and quote what you heard before you write the part around it.

## Mixer

Every track, every return and the master has its own **chain** of effects, its own level, and — for a track — its own sends into the song's **returns**. The mixer screen draws one strip per track, then the returns, then the master (its gain, the momentary, short-term and integrated LUFS, the true peak, and the song's target). One effect is one undoable step, its parameters are one undoable field each, and the chain runs in the order the strips show: a track's inserts, then its fader and pan, then its sends; a return's inserts, then its fader; then the master's gain and the master's inserts, limiter last.

| Tool | What it does |
|---|---|
| `studio_mix` | Read the mixer: each track's inserts in order `{id, kind, label, bypass, params}` and its sends, each return with its own chain, the master's `gain_db` and `target`, and the last render's figures. Read this before you change a chain |
| `studio_insert_add` | Add an effect to a chain: `owner` is `"track:<id>"`, `"return:<id>"` or `"master"`, `kind` is one of `eq`, `filter`, `delay`, `reverb`, `chorus`, `phaser`, `saturation`, `compressor`, `limiter`, `gate`, `deesser`; `after` places it, and leaving `after` out appends it to the end |
| `studio_insert_set` | One or more parameters of one insert by name (`{ratio: 4, threshold_db: -18}`); the names and ranges are `EFFECT_PARAMS`'s, and a value outside its range is refused with the range |
| `studio_insert_move` / `studio_insert_bypass` / `studio_insert_remove` | Reorder a chain, switch one effect out without losing its settings, or take it away |
| `studio_return_add` / `studio_return_set` / `studio_return_remove` | The returns: their own name, level, pan, mute and chain. A return a send still feeds cannot be removed |
| `studio_send_set` | `{track_id, return_id, level_db, pre}` — −60..+6 dB, `null` takes the send away, `pre: false` is after the track's fader (what a reverb wants) |
| `studio_master_set` | The master's `gain_db` (−24..+12) and the song's `target` `{lufs, true_peak_db}`: one step sets both |

A chain holds at most 8 effects and a song 8 returns. A **master limiter** is the only insert with look-ahead (1.5 ms, shown in the master strip as the master's delay); every track and return insert is zero-latency, so a limiter there is a clipper. An insert the engine cannot run — a compiled effect this build does not have, or one that produced an invalid sample — is bypassed in the ENGINE and reported once ("… produced an invalid sample; it is bypassed."), and a render names it in `effect_problems`; the song is never edited for it.

**A mix pass is yours to make, and the person's to judge.** Consecutive mixer steps are outlined in your colour as one pass, with **A/B** (hear the song as it was before the pass, without writing anything) and **Undo pass** (take the pass back, newest step first, stopping at the first step the person changed since). A/B and Undo pass are theirs: you cannot run either, so say how many steps a pass costs before you start, and prefer 3–4 to 12. The song's target is the person's too (`master.set` is yours, but a target they picked is not yours to move without asking).

## Sampler

A sampler track (`studio_track_add` with `kind: "sampler"`) plays a **kit**: banks of 16 pads, each pad a sample or one slice of one. A sampler track's clip is a **pattern clip** (`kind: "pattern"`): a loop of `length_steps` positions, each `step_beats` beats long (16 steps of a quarter beat is one bar), a `swing`, a list of **patterns** and a **chain** that loops them. A step fires one pad with a velocity and up to 8 **locks**, which override one of the pad's fields for that step's voice only. Read the sounds with `studio_samples` and the pattern clips with `studio_get_clip` before you write them.

You may write patterns, steps, locks, chains, slices and pad settings, but only the operator brings a sound into the song — importing a file, recording into a pad or resampling — and no step of yours may drop or replace the sound a pad plays.

| Tool | What it does |
|---|---|
| `studio_clip_add_pattern` | Add a pattern clip to a sampler track in a scene; it arrives with its first pattern, A, and 16 step positions unless you ask for another length. One clip per track per scene. |
| `studio_pattern_add` | Add a pattern to a pattern clip (at most 16); name it for what it does ("Fill", "Chorus"). |
| `studio_pattern_rename` | Rename a pattern. |
| `studio_pattern_remove` | Remove a pattern, its steps and its place in the chain in one step; the clip's last pattern stays. |
| `studio_pattern_set_length` | The loop's step positions, 1–64: 16 per bar of 16ths, four pages of 16 on screen. A shorter loop drops the steps past its new end. |
| `studio_pattern_set_steps_beat` | The step length in beats: 0.25 (16ths, the default), 0.125 (32nds, for rolls), 0.5 (8ths). The clip's bar length follows. |
| `studio_pattern_set_swing` | Swing 0–0.75: the second step of every pair — the 2nd, 4th, 6th… on the page — is delayed by `swing × step_beats` beats, so 0.16 on 16ths is the usual boom-bap lilt and 0.5 pushes it to a 1/32. |
| `studio_step_toggle` | Put a step on one position for one pad, or take it off. `v` is its velocity 1–127 (100 when omitted). |
| `studio_step_set` | A step's velocity, or the locks that override the pad's fields for that one voice: `pitch`, `gain_db`, `cutoff_hz`, `resonance`, `attack_ms`, `decay_ms`, `sustain`, `release_ms`, `pan`, `reverse`, `filter_type`. Locks merge into the step's own; at most 8. |
| `studio_step_clear_locks` | Clear every lock on one step. |
| `studio_chain_set` | The pattern ids a clip's chain plays in order, then loops (`["a", "b", "a"]`); empty loops the first pattern. At most 64 entries, all of that clip's patterns. |
| `studio_bank_add` | Add a bank of 16 empty pads to a kit (at most 8 banks per kit). |
| `studio_bank_rename` | Rename a bank. |
| `studio_pad_assign` | Put a sample, or one of its slices (`slice_id`), on a pad. An empty pad is yours to fill; a pad that already plays a sound is the operator's, and repointing it is refused. |
| `studio_pad_set` | One pad's own fields, inside `fields` (`{track_id, bank_id, index, fields: {…}}`): `name`, `mode` (`oneshot` plays to the end, `gate` releases at the step end), `pitch` ±24 semitones, `gain_db`, `pan`, `attack_ms`/`decay_ms`/`sustain`/`release_ms`, `filter {type, cutoff_hz, resonance}`, `choke` group 1–8 (a hit cuts the other voices in its group) and `reverse`. |
| `studio_slice_set` | Replace a sample's slices — `{id?, start_frame, end_frame}` in order, at most 64. A kept slice id keeps its pads playing it; removing a slice a pad plays is refused. |
| `studio_sample_rename` | Rename a sample. |
| *(no tool)* `pad.clear` | Take the sound off a pad and keep its settings. The operator's own step (the panel's **Clear pad**), so you have no tool for it: ask them. It is what a re-chop needs when a pad still plays a slice the new chop drops. |

A pad whose sample you do not name plays the whole sample; `slice_id` narrows it to one slice. Pitches are resampling: `pitch` +12 plays an octave up in half the time, so a repitched hit changes length with its pitch.

## Motion

A **motion lane** is one pad field drawn as a curve across one pattern: points of `{step_frac, value}`, where `step_frac` is a position in steps (0 is the pattern's first step) and `value` is inside that field's own range. A pattern holds at most 32 lanes, one pad field each, and a lane at most 4096 points.

| Tool | What it does |
|---|---|
| `studio_motion_write` | Set one lane: `{clip_id, pattern_id, bank_id, index, param, points}`. Its points replace the lane; an empty list takes it away. `param` is `pitch`, `gain_db`, `pan`, `attack_ms`, `decay_ms`, `sustain`, `release_ms`, `cutoff_hz` or `resonance`. |
| `studio_motion_clear` | Clear every lane of one pad in one pattern: `{clip_id, pattern_id, bank_id, index}`; add `param` to clear just that field. |

A step lock beats motion: the value a step locks is what that step's voice plays, whatever the curve says at its position.

## MIDI controllers

A song can be played from the floor: a pedal launches a scene, a pad plays a pad, a knob sweeps a filter. Each **mapping** belongs to the song — one message (a note, a control change or a program change on one named controller) routed to one live action — so the same pedals do the same thing on any device.

**You propose; the operator accepts; an accepted mapping is theirs.** A `studio_midi_map` you run always creates a NEW proposal: it routes nothing, and it never edits a mapping that exists. The operator accepts a proposal on the MIDI page, and accepting is a people-only command (`midi.accept`), so you have no tool for it. From then on the row is live and theirs: no step of yours — command, undo or redo — can change or remove it, and `studio_midi_remove` takes away only a proposal.

| Tool | What it does |
|---|---|
| `studio_midi` | Read every mapping: the controller and message, what it does (in plain words and as JSON), who set it, and whether it is still a proposal. Read this before you propose anything. |
| `studio_midi_map` | Propose one message → one action, from the allow-list below. Nothing that edits the song can be mapped, and one message has one live action. |
| `studio_midi_propose_profile` | Propose a whole device's rows at once: `fcb1010` or `mpk_mini`. Every row is a proposal. |
| `studio_midi_remove` | Remove a proposal (an accepted mapping is the operator's own). |

**The allow-listed actions** — one row each; a mapping runs nothing else:

| Kind | What the control does |
|---|---|
| `scene.launch {scene_id}` | Launch a scene on the next bar |
| `clip.launch {clip_id}` | Launch one clip |
| `transport.play` / `transport.stop` | Start or stop the transport |
| `record.toggle` | Start or stop recording |
| `stop_all` | Stop everything |
| `pad.play {track_id, bank_id, index}` | Play a sampler pad, at the note's velocity |
| `pad.param {track_id, param, min, max}` | Sweep one pad field on the selected pad, from `min` to `max` |
| `track.macro {track_id, index}` | Turn one of that track's eight macro knobs |
| `macro.set {index}` | Turn macro knob n on the selected track |
| `mix.gain {track_id}` | Ride a track's level |
| `fx.hold {name}` | Hold a performance effect: `filter_sweep`, `lofi`, `stutter`, `tape_stop`, `reverb_throw` |
| `looper.cycle` | Advance the looper: record, play, overdub, play |
| `looper.to_pad {track_id, bank_id, index}` | Capture what the looper holds into that pad |
| `keys.play` | Play the selected instrument from the keys (one row claims its channel's notes; a pad mapping on a note wins over it) |

**The keys are not played yet.** `keys.play` stays on the allow-list for when they are, so no device profile proposes one.

**The two device profiles** are factory defaults — check the operator's unit, because every unit can be reprogrammed:

- **FCB1010** (foot controller, over a USB-MIDI cable): pedals 1–10 send program changes 0–9 on channel 1; expression pedal A sends CC 27 and B sends CC 7.
- **MPK Mini** (pad keyboard): the eight pads send notes 36–43 on channel 10, the eight knobs send CC 70–77 on channel 1, and the keys send notes on channel 1.

**Profile or single mapping?** `studio_midi_propose_profile` when the operator asks to set a whole controller up — "set up my pedalboard", "make the MPK play the kit". It lays the controller out in one step: FCB1010 is one pedal per scene in song order (pass `scene_order` to choose which scenes, at most ten) plus the expression pedals on the first tracks' levels; MPK Mini is the pads on the first sampler track's first bank and the knobs on the selected track's macro knobs. `studio_midi_map` is for one thing: "make pedal 10 start and stop the looper", or a row of the profile that needs another action. Either way, say what you proposed and that the operator has to accept it.

## Performance effects and the looper

Five performance effects — filter sweep, lo-fi, stutter, tape stop, reverb throw — and a looper sit on the master bus, held and released rather than switched: a pedal holds one for as long as it is down, and the page's own buttons work the same way. They are the operator's hands. They are live state, never a history step, they never enter the song, and nothing you can call holds one: you have no tool that presses them, and an `fx.hold` mapping runs only on the operator's own page.

The looper records the master in whole bars, and `looper.to_pad` (or the page's **Loop → pad**) turns what it holds into a pad's sample. A looper that has recorded nothing answers with no bars. An agent render is always DRY: the performance effects and the looper are not in it, so what you measure is the song, not the performance.

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
| `studio-arranging-and-sound` | Instrument ranges, voicing, General MIDI programs and drum notes, SunVox patches |
| `studio-mixing` | Levels, loudness targets, delivery |
| `studio-modern` | Post-tonal and experimental techniques |
| `studio-preferences` | Always: read at the start, store when taught |

A request to *write* a line — "write a bassline", "harmonise this melody" — fires both: load `studio-counterpoint` for intervals and voice leading, `studio-harmony` for chords, key and melody, before the first note.

## Sources

- SunVox, Alexander Zolotov, WarmPlace.ru — module catalogue and controller ranges, read from `studio_module_types`.
- ITU-R BS.1770-4, *Algorithms to measure audio programme loudness and true-peak audio level* (2015) — LUFS and dBTP.
- Ableton Live Reference Manual, "Launching Clips" (2024) — clip loop and next-bar scene launch conventions.