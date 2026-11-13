---
name: studio-mixing
description: Use when the operator asks about balance, levels or panning in Studio; when a song has to be made louder, quieter or evened out; when an effect, a send, a return or the master chain has to be set; when a guitar has to be built an amp chain from the captures and cabinets in the song; when a render's LUFS or true peak has to be read or explained; or when a mix is being prepared for Spotify, a podcast or a video bed.
triggers:
  - mix the song
  - balance the mix
  - is it balanced
  - make it louder
  - set the levels
  - pan the keys
  - how loud is it
  - true peak
  - get it ready for Spotify
  - podcast music bed
  - master the song
  - add an EQ
  - add a compressor
  - add some reverb
  - add an amp
  - guitar tone
  - set up a send
  - master limiter
  - equilibra la mezcla
  - sube el volumen
tools:
  - studio
---

# Studio Mixing

Mixing in Studio is level, stereo position and the mixer: a chain of effects on any track, a return fed by sends, and a master chain that ends in a limiter — all checked by measurement and confirmed by the operator's ear. Balance comes first, effects second, and the master last: the song carries its own **loudness target**, and a render tells you whether the mix meets it.

## The listening rule

You cannot hear. A render returns `lufs` (integrated), `true_peak_db`, `short_term_max_lufs` and a WAV the operator can play; the engine's meter and the master strip show momentary, short-term and integrated LUFS while the song plays. That is your whole ear.

- Never write "sounds balanced", "warm", "punchy" or "translates". Write "Measured: …" or "Likely to … — can you confirm at bar 12?".
- Ask for locations. Convert: **beats = seconds × bpm ÷ 60**, **bar = ⌊beats ÷ 4⌋ + 1**, **beat = remainder + 1**. 7.5 s at 92 bpm = bar 3, beat 4½.
- `studio_render` requires `seconds`, capped by the operator's render-length limit; bars → seconds is **`240 × bars ÷ bpm`** (8 bars at 92 bpm = 20.9 s).
- One question at a time, tied to a bar range and a number: "the pad is 4 LU above the keys in bars 9–16; is the counter-line lost there?"
- When the ear and the number disagree, believe the ear and quote the number anyway; you may have measured the wrong slice.
- Every fader move is a live, undoable, agent-tagged step: say how many a pass costs, and prefer 3–4 moves to 12.

## What you can and cannot do

| Available | Not yet |
|---|---|
| `gain_db` −60..+12 (0 = unity), `pan` −1..+1, `mute`, `solo` | per-track render, LRA, spectrum, a bounce of one chain |
| inserts on any track, on any return and on the master: `eq`, `filter`, `delay`, `reverb`, `chorus`, `phaser`, `saturation`, `compressor`, `limiter`, `gate`, `deesser`, and an `amp` that plays the capture and cabinet the operator chose | sidechain from another track (ducking); choosing, swapping or removing an amp's capture or cabinet |
| sends to up to 8 returns, and 8 returns of their own | recording by the agent, dither, MP3/AAC export, upload |
| the master's `gain_db`, its target `{lufs, true_peak_db}`, and a master limiter whose look-ahead holds the ceiling | any look-ahead on a track or return insert: those are zero-latency by rule |
| `studio_render`: a gateway download link + integrated LUFS + true peak + highest short-term figure, per song, scene or clip | |
| `studio_mix`: every chain, every send, every return, the master target, and the last render's figures | |
| `studio_history`, `studio_undo`, `studio_redo`; audio tracks play the operator's recorded takes through the same chains | |

There is no per-track render. To measure one part, set `solo: true`, render the scene, then `solo: false` — two undoable steps per part. Warn first; offer the full-mix route.

Say "Studio cannot yet …" for the right column. Everything in the middle of this skill — EQ, compression, reverb, a bus, a limiter — you DO have now, as an insert; do not describe one as if it were still missing.

## Balance first

The job here is static balance → check → narrow fixes → check: effects come after balance in any mix, so nothing is lost by doing it first.

1. `studio_session_summary`: tracks, devices, locks, clips. A track with no clip cannot be balanced — say so first.
2. `studio_mix`: the chains that are already there, the sends and returns, and the song's **target** (`master.target`) — that is the figure you are mixing towards, not one you invent.
3. `studio_render` the song and keep its figures as the baseline, then compare them with the target.
4. Solo-render each part worth keeping and note its LUFS; group two or three when one is too short to measure.
5. Change **one** `gain_db` per step, 1.5–3 dB, then re-render and quote the new figure beside the old.
6. Stop when the figures sit in ladder order and the operator's ear agrees. If only the ear objects, ask which part is too present and take that one down rather than raising its rival.

Soloed LUFS is a **relative readout, not a prediction of the mix**: soloing removes masking, so two parts that measure equal can still bury each other. Use the numbers to order parts and catch accidents, then ask.

Starting ladder — conventions, not rules:

| Element | Starting relationship |
|---|---|
| Lead / vocal / melody | 1–3 LU above the next-loudest sustaining part, and the loudest melodic line |
| Bass | within 3 LU of the lead; more than 1 LU above it usually means a mistake |
| Kick vs bass | within about 2–3 LU; one owner of the low register per section |
| Pads, ghost layers, doubles | 6–10 LU below the lead |
| Any two parts within 1 LU | not heard as separate layers — split by register or level |

Section balance with the short-term meter: press play and watch the master strip's short-term figure through the verse and then the chorus, or render 4–8 bars of each and compare those renders' `short_term_max_lufs` as slices. The chorus should beat its verse in two of four: slice figures, notes per bar, active tracks, top-voice pitch. Say which two.

## Panning

- **Centre (0):** kick, snare, bass, lead vocal, lead melody, and any track whose notes sit mostly below C3 (48, ≈131 Hz). Low end centred — the one hard rule here.
- **Sides:** doubled guitars or keys hard at −1/+1 as a pair; pads and keys ±0.3–0.6; backing vocals ±0.5; hats ±0.3–0.5; two counter-lines at −0.5/+0.5.
- No pan law or width control exists, but panning shifts a render's loudness and peak slightly: re-measure after a pass.

## Gain staging and headroom

- `0` on `gain_db` is unity: mix by pulling **down**; +12 is the ceiling and boosting is a last resort.
- Velocity is gain staging too: a part at `v` 110–127 is loud before its fader. Check velocities and overlapping notes before raising anything.
- The **master** has its own `gain_db` (−24..+12) and, by convention, a limiter as the last insert of its chain (ceiling −0.1..−6 dBTP, default −1). The limiter is the only insert with look-ahead (1.5 ms, shown in the master strip); everything on a track or a return runs at zero latency.
- A limiter is not a fix for a mix that is 10 LU too loud: it will hold the ceiling and flatten the song. Move the master's gain or the tracks first, and let the limiter catch the last 1–3 dB of peaks.
- Headroom: **≤ −1 dBTP** for a file leaving Studio as finished; **≤ −2 dBTP** for loud material bound for a lossy format (codecs raise inter-sample peaks); **−6 to −3 dBTP** for a mix mastered elsewhere (varies by author).
- Long SunVox `Release` smears a pad into the next chord even when the clip looks clean. Shorten it before blaming the mix.

## Reading the numbers

| Figure | What it is | Use it for |
|---|---|---|
| Integrated LUFS (= LKFS) | K-weighted average over the whole render, gated: 400 ms blocks, absolute gate −70 LKFS, relative gate 10 LU under the ungated level | Song targets; comparable short renders |
| Momentary LUFS | 400 ms window — on the engine's master meter, and in the master strip | Catching a level jump inside one section |
| Short-term LUFS | 3 s window (EBU Tech 3341) — on the meter, and a render reports its highest reading as `short_term_max_lufs` | The loudest 3 seconds; comparing sections of one pass |
| True peak (dBTP) | Inter-sample peak estimated by oversampling (BS.1770 Annex 2) | The delivery ceiling |
| PLR | `true_peak_db − lufs`; compute it yourself | Comparing how squashed two versions are |
| Loudness range (LRA) | **not reported by Studio**: neither the render nor the meter measures one | Compare section figures instead, and say that is what you did |

- Gating means silence cannot drag the integrated figure down, so a 3-bar and a 3-minute render are not comparable. State the span.
- The meter reads the master AFTER its inserts, so the master limiter's own gain reduction shows up in it. The render's figures are measured on the same place: the final output.
- Quote like this: "−14.2 LUFS, −1.8 dBTP, over 8 bars (20.9 s)".

## Delivery targets

Checked 2026-11-03. Platforms change these: carry the date whenever you quote one.

| Context | Integrated figure | Peak ceiling | Status |
|---|---|---|---|
| Spotify (Normal) | no master level requested; −14 LUFS is its playback normalisation, not a delivery target | ≤ −1 dBTP; ≤ −2 dBTP if louder than −14 | Spotify's page, read 2026-11-03 |
| Apple Music | ≈ −16 LUFS | ≈ −1 dBTP advised | Unverified; varies by source |
| YouTube | turned down toward ≈ −14 LUFS, never up | — | Unverified; no published figure |
| Apple Podcasts | −16 LKFS ± 1 | ≤ −1 dBFS true peak | Apple's audio requirements, read 2026-11-03 |
| EBU R 128 (EU broadcast) | −23.0 LUFS; ±0.5 LU in practice, ±1.0 LU only where the target cannot be met (live) | ≤ −1 dBTP | R 128 v4.0 (2020); v5.0 (2023) current |
| ATSC A/85 (US broadcast) | −24 LKFS | −2 dBTP, ±2 dB tolerance — commonly cited | Secondary sources only |
| Netflix long-form | −27 LKFS dialogue-gated ±2 | −2 dBTP | Sound Mix Specs v1.5 (confirm the latest) |
| AES TD1008 (2021) | −16 LUFS music, −17 mixed content, −18 speech | −1 dBTP | Recommendation only; the genre tables are secondary — verify against the PDF |

- **Never reach a target by gain alone.** If the platform's figure needs G dB and `true_peak_db + G` would pass the ceiling, the ceiling binds: either use the master limiter for the last 1–3 dB of peaks and say so, or report both figures and hand the master to a mastering step outside Studio. Never let a gain move push the true peak over the ceiling and call it done.
- Normalisation turns a louder master back down and leaves it less dynamic. Aim at the platform's figure, not above it. **−14 LUFS is a normalisation reference, not a delivery rule**: Spotify asks for no master level and turns louder songs down to about it, so quote it as the reference it is.
- Studio's WAV is 24-bit and unprocessed — no dither, no conversion, no upload. Name the next step.

## The mixer

`studio_mix` is the read; every edit below is one undoable step, and a run of them is a **mix pass** the panel outlines in your colour, which the person may A/B and undo (and only they can). Read the song's target from `studio_mix` (`master.target`) before aiming at anything.

| Tool | What it does |
|---|---|
| `studio_insert_add` | `{owner, kind, params?, after?}` — `owner` is `"track:<id>"`, `"return:<id>"` or `"master"`; `kind` is one of the effects above or `"amp"` (which needs `model_id`, a capture the song holds); without `after` the effect goes to the END of the chain, `after: null` puts it FIRST, and `after: "<insert id>"` puts it just behind that one |
| `studio_insert_set` | One or more parameters of one insert, by name: `{id, params: {ratio: 4, threshold_db: −18}}`. Every name and range is in the table below |
| `studio_insert_bypass` | `{id, bypass: true|false}` — the chain skips it without removing it. Prefer this to removing an effect you are unsure of |
| `studio_insert_move` | `{id, after?}` — same `after` rule as `insert.add` |
| `studio_insert_remove` | `{id}` — the effect and its settings are gone in one step |
| `studio_return_add` / `studio_return_set` / `studio_return_remove` | A return is its own strip, not a track: `{id?, name?}`, then `{id, name?, gain_db?, pan?, mute?}`. A return a send still feeds cannot be removed |
| `studio_send_set` | `{track_id, return_id, level_db, pre?}` — `level_db` −60..+6, `null` takes the send away; `pre: false` (post-fader, the default) is what a reverb wants |
| `studio_master_set` | `{gain_db?, target?: {lufs?, true_peak_db?}}` — the master's gain (−24..+12) and the song's target (LUFS −30..−6, ceiling −6..−0.1 dBTP). ONE step sets both |

A chain holds at most 8 effects, a song 8 returns, a track 8 sends. An insert the engine cannot host (a compiled effect this build does not have) or one that produced an invalid sample is bypassed and named in the render's `effect_problems`; it is not fatal, and it is not yours to ignore.

## Effects, and the settings to start from

The parameter names and ranges below are the exact ones the commands accept (`EFFECT_PARAMS`); a value outside its range is refused with the range in the sentence.

| Effect | Job | Parameters (name: range, default) | Starting settings |
|---|---|---|---|
| `eq` | Rumble out, masking apart, mud fixed, air in | `low_freq_hz` 20–500 (100), `low_gain_db` −18..18 (0), `mid_freq_hz` 100–10000 (1000), `mid_gain_db` −18..18 (0), `mid_q` 0.1–10 (0.7), `high_freq_hz` 2000–20000 (8000), `high_gain_db` −18..18 (0) | Bass: `low_gain_db` −4 at `low_freq_hz` 250. Voice: `mid_gain_db` −3 at `mid_freq_hz` 400 with `mid_q` 1.2, `high_gain_db` +2 at `high_freq_hz` 10000. Narrow cuts, broad boosts |
| `filter` | High-pass, low-pass, band-pass | `mode` lp/hp/bp (lp), `cutoff_hz` 20–20000 (1000), `resonance` 0.1–10 (0.7) | Rumble out: `mode` hp, `cutoff_hz` 35 (bass), 90 (voice and guitar), `resonance` 0.7 |
| `compressor` | Level evened, peaks held | `detect` peak/rms (peak), `threshold_db` −60..0 (−18), `ratio` 1–20 (4), `knee_db` 0–12 (6), `attack_ms` 0.1–100 (10), `release_ms` 5–2000 (100), `makeup_db` 0–24 (0), `sidechain_hp_hz` 0–500 (0) | Vocal: `ratio` 4, `threshold_db` −18, `attack_ms` 10, `release_ms` 100, `knee_db` 6, `makeup_db` 3. Bus glue: `ratio` 2, `threshold_db` −16, `attack_ms` 30, `release_ms` 200, `knee_db` 8. Release ≈ 60000 ÷ bpm ms per quarter note |
| `limiter` | Holds the ceiling | `ceiling_db` −6..−0.1 (−1), `release_ms` 1–1000 (50) | Master only, last in the chain: `ceiling_db` −1 (`−2` for a loud lossy master), `release_ms` 50. On a track it is a zero-latency clipper — say so if you use one there |
| `gate` | Silence between phrases | `threshold_db` −80..0 (−40), `hysteresis_db` 0–12 (3), `attack_ms` 0.01–50 (1), `hold_ms` 0–500 (20), `release_ms` 5–2000 (100), `range_db` −80..0 (−80) | Drums: `threshold_db` −40, `hysteresis_db` 4, `attack_ms` 1, `hold_ms` 30, `release_ms` 120 |
| `deesser` | Sibilance only | `freq_hz` 4000–10000 (6500), `threshold_db` −60..0 (−24), `ratio` 1–20 (4) | Voice: `freq_hz` 6500, `threshold_db` −24, `ratio` 4 |
| `reverb` | Depth and cohesion | `size` 0–1 (0.5), `damping` 0–1 (0.5), `predelay_ms` 0–200 (20), `mix` 0–1 (0.25) | On a return, 100 % wet: `mix` 1, `size` 0.6, `damping` 0.5, `predelay_ms` 20. `mix` below 1 belongs on a track insert, not a return |
| `delay` | Slapback and echoes | `time_ms` 1–2000 (375), `feedback` 0–0.95 (0.35), `mix` 0–1 (0.3), `highcut_hz` 1000–20000 (8000) | Dotted-eighth at the song's tempo: `time_ms` = 45000 ÷ bpm, `feedback` 0.3, `mix` 0.25, `highcut_hz` 8000 |
| `chorus` | Width on a doubled part | `rate_hz` 0.05–5 (0.8), `depth` 0–1 (0.5), `mix` 0–1 (0.5) | Keys or a doubled guitar: `rate_hz` 0.8, `depth` 0.5, `mix` 0.4 |
| `phaser` | Sweeping notches | `rate_hz` 0.05–5 (0.5), `depth` 0–1 (0.6), `feedback` 0–0.9 (0.4), `mix` 0–1 (0.5) | `rate_hz` 0.4, `depth` 0.6, `feedback` 0.4, `mix` 0.5 |
| `saturation` | Weight and grit | `drive_db` 0–36 (6), `tone` 0–1 (0.5), `output_db` −24..6 (0), `mix` 0–1 (1) | Bass: `drive_db` 6, `tone` 0.4, `output_db` −2, `mix` 0.6 |

Sends and returns: a reverb return at `gain_db` 0 with `pan` 0, and sends between −18 and −9 dB post-fader; a delay return at −6 dB send with `pre: true` only when you want the echo to survive the fader move. Two returns (a short room and a long plate) go further than one.

Substitutes that still work when an effect is the wrong tool: an octave up instead of a high-pass; shorter notes or `Release` instead of a gate; note-by-note `v` instead of a fader ride; an arrangement rest instead of a duck (there is no sidechain from another track yet).

## Recipes

**A vocal chain.** One track, in this order: `eq` (`mid_gain_db` −3 at `mid_freq_hz` 400, `high_gain_db` 2 at 10000) → `deesser` (`freq_hz` 6500, `threshold_db` −24, `ratio` 4) → `compressor` (`ratio` 4, `threshold_db` −18, `attack_ms` 10, `release_ms` 100, `knee_db` 6, `makeup_db` 3) → `eq` again if a presence lift is still wanted (`high_gain_db` 2.5 at `high_freq_hz` 5000). A reverb return at `mix` 1, `size` 0.5, `predelay_ms` 25, fed by a send at `level_db` −15, post-fader. Six steps, and say so before you start.

**A drum bus.** One `compressor` (`ratio` 2, `threshold_db` −16, `attack_ms` 30, `release_ms` 200, `knee_db` 8, `makeup_db` 4) and, if the kit is thin, a `saturation` before it (`drive_db` 6, `tone` 0.5, `output_db` −2, `mix` 0.5). Keep the kick's low end out of the reverb: the send comes after the compressor and at −18 dB.

**A bass.** `filter` (`mode` hp, `cutoff_hz` 35, `resonance` 0.7) → `saturation` (`drive_db` 6, `tone` 0.4, `output_db` −2, `mix` 0.6) → `compressor` (`ratio` 3, `threshold_db` −20, `attack_ms` 15, `release_ms` 120, `makeup_db` 3). No reverb on the bass unless the song is a ballad; if it is, send at −24 dB.

**A reverb return + sends.** `studio_return_add {id: "room", name: "Room"}` → `studio_insert_add {owner: "return:room", kind: "reverb", params: {mix: 1, size: 0.4, damping: 0.6, predelay_ms: 15}}` → `studio_return_add {id: "plate", name: "Plate"}` and a reverb on `return:plate` with `size` 0.8, `damping` 0.4, `predelay_ms` 30 → then one `studio_send_set` per source: drums −20 dB to Room, voice −15 dB to Plate, keys −18 dB to Room. Keep the return's `gain_db` at 0 and ride the sends: that is what makes one reverb sit under everything. Pass your own `id` when you add a return or an effect you will address later; otherwise read the ids back from `studio_mix`.

**A master chain.** Last insert first in your head: `eq` with a gentle tilt (`low_gain_db` −1.5 at `low_freq_hz` 120, `high_gain_db` 1 at `high_freq_hz` 9000), then — only if the mix needs it — a `compressor` (`ratio` 2, `threshold_db` −14, `attack_ms` 30, `release_ms` 300, `knee_db` 6), then the `limiter` (`ceiling_db` −1, `release_ms` 50) as the **last** insert of the master chain. Then `studio_master_set {target: {lufs: −14, true_peak_db: −1}}` if the song's target is the streaming reference, and render: `meets_target.lufs` and `.true_peak` say whether the chain did its job.

**A guitar chain (an amp).** An `amp` insert is the one insert whose sound is a FILE the operator chose: a NAM capture, played through a cabinet impulse response. Its settings are four things — `model_id` (the capture, a library entry of kind `nam`), `ir_id` (the cabinet, a library entry of kind `ir`, or `null` for no cabinet), and the three numbers in `AMP_PARAMS`: `input_db` −24..+24 (0), `output_db` −24..+12 (0), `ir_mix` 0–1 (1).

The order that works: `gate` → `amp` → `eq` → send to a delay and a reverb return.

1. `studio_mix` and `studio_library` first: the amp's `capture` and `cabinet` (with their names and credits) are in the mix read, and `studio_library`'s `available_bundled` says which starter sounds the song already holds (`in_song: true`).
2. Add the amp with a capture the song already holds: `studio_insert_add {owner: "track:<guitar>", kind: "amp", params: {model_id: "<capture id>", ir_id: "<cabinet id>"}}`. An amp with a capture the library does not hold is refused by name.
3. Gain staging is inside the amp: drive it with `input_db` (more input = more of the capture's distortion character), set the level it hands the chain with `output_db`, and use `ir_mix` under 1 only when you want the cabinet to fade towards no cabinet at all (a bright DI edge). Never do gain staging on the track fader and the amp at once: pick one owner.
4. After the amp: `eq` for what the cabinet makes too sharp (`high_gain_db` −3 at `high_freq_hz` 4000) or too dull, then the tracks' usual `delay`/`reverb` sends — a guitar wants −18 to −12 dB into a room, −24 into a plate.
5. A fuzzier part: `saturation` before the amp (`drive_db` 4–8) rather than after it, and a `compressor` after the amp (`ratio` 2–3, `attack_ms` 20) to hold sustained chords.

What you may change on an amp: `input_db`, `output_db`, `ir_mix`, its place in the chain, and whether it is bypassed. What you may NOT change, and no tool of yours will: the capture (`model_id`), the cabinet (`ir_id`), or the amp's existence — swapping or removing one is refused with "Only the operator changes the capture or cabinet an amp plays." / "Only the operator removes an amp." That rule exists because a capture is a sound the operator chose and cannot be re-derived; removing and re-adding the insert would be the same choice one step at a time. If a different sound is wanted, say so and ask them to pick it in the amp editor.

Captures and cabinets are people-only all the way through: the starter sounds in the bundle, and the operator's own `.nam` and IR files, are added by the person at the Studio page (there is no tool for it), a `.nam` must be an A2 model (older formats are refused with a re-export sentence), and a cabinet is at most one second long. A capture or cabinet the song does not hold plays silence and is named in the render's `missing_library`; do not guess why a guitar is quiet — read it.

**A streaming single.** Read `studio_mix` for the song's `master.target` (the −14 LUFS streaming reference unless the operator chose another). Balance by the ladder, pan by the conventions, build the vocal/drum/bass chains above, then render and quote `lufs`, `true_peak_db`, `short_term_max_lufs` and PLR with the span. If `meets_target.lufs` is false, move the master's `gain_db` by the difference (one step), never a track at a time. If the loudness lands but the ceiling binds, the limiter is the tool: lower its `ceiling_db` no further than the platform's row allows, and say what it cost. **−14 LUFS is a normalisation reference, not a delivery rule** — report the figure against Spotify's playback normalisation so the operator knows how far it will be turned down. Close with the figures, the normalisation and its date, and the unprocessed 24-bit WAV.

**A podcast or video music bed.** Studio makes the music only; the voiceover export happens outside Studio today.
- Balance the bed to stand alone: no lead melody in a speaking register (roughly 48–72 male, 55–79 female), rests at phrase ends, low end centred.
- Render the bed alone and hand the editor starting points: **roughly 8–12 dB under the voice between lines** (a practitioner heuristic; no standard fixes the ratio), a bed `compressor` with a slow release on the music bus, and a broad −2 to −6 dB dip around 1–4 kHz with `eq` (`mid_gain_db` −4 at `mid_freq_hz` 2500, `mid_q` 0.7) where speech lives. There is no ducking from the voice track yet: say that, and set `master.target.lufs` −16 for speech.
- Programme loudness follows the platform: −16 LKFS Apple Podcasts, −23 LUFS EBU, −24 LKFS ATSC. Never quote one without its date and source.

**An A/B review.** Loudness-match first: a louder version wins by default and teaches nothing. Same span, same start bar, 4–8 bars with pre-roll, labelled "A" and "B", never "before/improved". Your own mix pass can be A/B'd by the person on the mixer screen; do not A/B it for them. Ask one question, with concrete options ("pad up an octave / pad out in the verse / pad 3 LU down"). Hand a verdict that would outlive this song to `studio-preferences`.

## Checks

- Song render `true_peak_db` ≤ −1 dBTP, ≤ −2 when loud or bound for a lossy format, −6 to −3 when someone else masters.
- `meets_target.true_peak` is true, or the reason it is not was said out loud; `meets_target.lufs` is true whenever the target is the one the song carries.
- No render at or above 0 dBFS; if one was, say which step caused it and take it back.
- Lead is the loudest melodic part, 1–3 LU above the next sustaining part; bass within 3 LU of the lead and not more than 1 LU above; pads and doubles 6–10 LU below.
- No two non-doubled parts within 1 LU of each other.
- Every track whose notes sit mostly below C3 (48) has `pan` 0.
- Paired parts sit at equal, opposite pans, and both have clips.
- Each section quotes its own figure (`short_term_max_lufs` per section render), and the chorus wins on two of the four section measures.
- Every effect you added is in `studio_mix` in the order you meant it to run, and every send names the return you meant.
- On every amp you touched, the `capture` and `cabinet` in `studio_mix` are still the ones the operator chose, and the amp is still there.
- No `effect_problems` went unmentioned: an insert this build cannot host, or one the engine bypassed, is said out loud with the sentence the render gave.
- Every loudness claim carries the figure, the span, the target's source date, and the PLR when two versions are compared.
- No claim about sound, texture or balance that did not come from a number or the operator.
- If the target was out of reach without breaking the ceiling, that was said out loud.

## Sources

- ITU-R BS.1770-5, *Algorithms to measure audio programme loudness and true-peak audio level*, 2023.
- EBU R 128 v4.0 (2020) / v5.0 (2023), with Tech 3341 and Tech 3342.
- ATSC A/85:2013, *Techniques for Establishing and Maintaining Audio Loudness for Digital Television*.
- AES TD1008, *Recommendations for Loudness of Internet Audio Streaming and On-Demand Distribution*, 2021.
- Spotify for Artists, "Loudness normalization", read 2026-11-03.
- Apple Podcasts for Creators, "Audio requirements", read 2026-11-03.
- Netflix Partner Help Center, "Sound Mix Specifications v1.5".
- Katz, *Mastering Audio*, 3rd edn, 2015; Owsinski, *The Mixing Engineer's Handbook*, 5th edn, 2022; Senior, *Mixing Secrets for the Small Studio*, 2nd edn, 2018.