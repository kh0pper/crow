---
name: studio-mixing
description: Use when the operator asks about balance, levels or panning in Studio; when a song has to be made louder, quieter or evened out; when a render's LUFS or true peak has to be read or explained; or when a mix is being prepared for Spotify, a podcast or a video bed.
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
  - equilibra la mezcla
  - sube el volumen
tools:
  - studio
---

# Studio Mixing

Mixing in today's Studio is level and stereo position: faders, checked by measurement, confirmed by the operator's ear. There is no EQ, compression, reverb or master bus, so this skill is balance and delivery.

## The listening rule

You cannot hear. A render returns `lufs` (integrated), `true_peak_db` and a WAV the operator can play; that is your whole ear.

- Never write "sounds balanced", "warm", "punchy" or "translates". Write "Measured: …" or "Likely to … — can you confirm at bar 12?".
- Ask for locations. Convert: **beats = seconds × bpm ÷ 60**, **bar = ⌊beats ÷ 4⌋ + 1**, **beat = remainder + 1**. 7.5 s at 92 bpm = bar 3, beat 4½.
- `studio_render` requires `seconds`, capped by the operator's render-length limit; bars → seconds is **`240 × bars ÷ bpm`** (8 bars at 92 bpm = 20.9 s).
- One question at a time, tied to a bar range and a number: "the pad is 4 LU above the keys in bars 9–16; is the counter-line lost there?"
- When the ear and the number disagree, believe the ear and quote the number anyway; you may have measured the wrong slice.
- Every fader move is a live, undoable, agent-tagged step: say how many a pass costs, and prefer 3–4 moves to 12.

## What you can and cannot do

| Available | Not yet |
|---|---|
| `gain_db` −60..+12 (0 = unity), `pan` −1..+1, `mute`, `solo` | inserts, sends, EQ, compressor, reverb, delay, sidechain |
| SunVox controllers via `studio_track_set_param` | master fader, bus processing, limiter |
| `studio_render`: WAV url + integrated LUFS + true peak, per song, scene or clip | per-track render, short-term LUFS, LRA, spectrum |
| `studio_history`, `studio_undo`, `studio_redo` | recording, dither, MP3/AAC export, upload |

There is no per-track render. To measure one part, set `solo: true`, render the scene, then `solo: false` — two undoable steps per part. Warn first; offer the full-mix route.

Say "Studio cannot yet …" for the right column, and never describe a limiter, EQ or reverb as if you had applied it.

## Balance first

The job here is static balance → check → narrow fixes → check: effects come after balance in any mix, so nothing is lost by doing it first.

1. `studio_session_summary`: tracks, devices, locks, clips. A track with no clip cannot be balanced — say so first.
2. `studio_render` the song and keep its figures as the baseline.
3. Solo-render each part worth keeping and note its LUFS; group two or three when one is too short to measure.
4. Change **one** `gain_db` per step, 1.5–3 dB, then re-render and quote the new figure beside the old.
5. Stop when the figures sit in ladder order and the operator's ear agrees. If only the ear objects, ask which part is too present and take that one down rather than raising its rival.

Soloed LUFS is a **relative readout, not a prediction of the mix**: soloing removes masking, so two parts that measure equal can still bury each other. Use the numbers to order parts and catch accidents, then ask.

Starting ladder — conventions, not rules:

| Element | Starting relationship |
|---|---|
| Lead / vocal / melody | 1–3 LU above the next-loudest sustaining part, and the loudest melodic line |
| Bass | within 3 LU of the lead; more than 1 LU above it usually means a mistake |
| Kick vs bass | within about 2–3 LU; one owner of the low register per section |
| Pads, ghost layers, doubles | 6–10 LU below the lead |
| Any two parts within 1 LU | not heard as separate layers — split by register or level |

Section balance without a short-term meter: render 4–8 bars of each section and compare those figures as slices. The chorus should beat its verse in two of four: slice LUFS, notes per bar, active tracks, top-voice pitch. Say which two.

## Panning

- **Centre (0):** kick, snare, bass, lead vocal, lead melody, and any track whose notes sit mostly below C3 (48, ≈131 Hz). Low end centred — the one hard rule here.
- **Sides:** doubled guitars or keys hard at −1/+1 as a pair; pads and keys ±0.3–0.6; backing vocals ±0.5; hats ±0.3–0.5; two counter-lines at −0.5/+0.5.
- No pan law or width control exists, but panning shifts a render's loudness and peak slightly: re-measure after a pass.

## Gain staging and headroom

- `0` on `gain_db` is unity: mix by pulling **down**; +12 is the ceiling and boosting is a last resort.
- Velocity is gain staging too: a part at `v` 110–127 is loud before its fader. Check velocities and overlapping notes before raising anything.
- There is no master fader and no limiter. If the render clips or exceeds the ceiling, lower **every** track by the same amount so the balance survives — one undoable step per track; announce the count.
- Headroom: **≤ −1 dBTP** for a file leaving Studio as finished; **≤ −2 dBTP** for loud material bound for a lossy format (codecs raise inter-sample peaks); **−6 to −3 dBTP** for a mix mastered elsewhere (varies by author).
- Long SunVox `Release` smears a pad into the next chord even when the clip looks clean. Shorten it before blaming the mix.

## Reading the numbers

| Figure | What it is | Use it for |
|---|---|---|
| Integrated LUFS (= LKFS) | K-weighted average over the whole render, gated: 400 ms blocks, absolute gate −70 LKFS, relative gate 10 LU under the ungated level | Song targets; comparable short renders |
| Short-term LUFS | 3 s window (EBU Tech 3341) — **not reported by Studio** | Approximated by a 3–8 s slice; say so |
| True peak (dBTP) | Inter-sample peak estimated by oversampling (BS.1770 Annex 2) | The delivery ceiling |
| PLR | `true_peak_db − lufs`; compute it yourself | Comparing how squashed two versions are |

- Gating means silence cannot drag the integrated figure down, so a 3-bar and a 3-minute render are not comparable. State the span.
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

- **Never reach a target by gain alone.** If the platform's figure needs G dB and `true_peak_db + G` would pass the ceiling, stop: the ceiling binds and Studio cannot fix it without a limiter. Report both figures and hand the master to a mastering step outside Studio.
- Normalisation turns a louder master back down and leaves it less dynamic. Aim at the platform's figure, not above it.
- Studio's WAV is 24-bit and unprocessed — no dither, no conversion, no upload. Name the next step.

## Effects: what they do, what to do until they exist

All of it is **for when Studio adds effects, or for a mixing step outside Studio**; you cannot apply any of it here.

| Tool | Job | Starting settings |
|---|---|---|
| EQ / high-pass | Rumble out, masking apart, mud fixed | High-pass ≈30–40 Hz bass, 80–120 Hz vocals and guitars; narrow cut 200–500 Hz boxiness; 2–5 kHz presence; 10–16 kHz air; de-ess 5–9 kHz. Narrow cuts, broad boosts, decided in context |
| Compressor | Level evened, peaks held | Levelling 2:1–4:1, 2–6 dB reduction, attack 5–30 ms, release 50–200 ms; bus glue 1.5:1–2:1, attack 10–30 ms, 1–3 dB. Release ≈ 60000 ÷ bpm ms per quarter note |
| Reverb | Depth and cohesion | Send buses, 100 % wet return: room/plate 0.5–1.5 s plus one longer space; pre-delay 10–40 ms; high-pass return 150–500 Hz, low-pass 6–10 kHz |
| Sidechain / ducking | Room for an arriving part | Kick into bass 3–10 dB, release near an 8th or quarter; voice into a bed 6–12 dB |

Substitutes you do have: an octave up instead of a high-pass; shorter notes or `Release` instead of a gate; note-by-note `v` instead of a fader ride; `F.freq`/`F.resonance` darken a tone but remove no boom; an arrangement rest instead of a duck.

## Recipes

**A streaming single.** Balance by the ladder, pan by the conventions, render the song and quote LUFS, true peak and PLR with the span. Streaming takes no master level: report the figure against the platform's playback normalisation (the Spotify row) so the operator knows how far it will be turned down, and if a target needs gain that would breach −1 dBTP (−2 for a loud lossy master), say the ceiling binds and stop. Close with the figures, the normalisation and its date, and the unprocessed 24-bit WAV.

**A podcast or video music bed.** Studio makes the music only; the voiceover export happens outside Studio today.
- Balance the bed to stand alone: no lead melody in a speaking register (roughly 48–72 male, 55–79 female), rests at phrase ends, low end centred.
- Render the bed alone and hand the editor starting points: **roughly 8–12 dB under the voice between lines** (a practitioner heuristic; no standard fixes the ratio), ducked 6–12 dB under speech with attack 10–50 ms and release 200–800 ms, and a broad −2 to −6 dB dip around 1–4 kHz where speech lives. In loudness terms, start 10–15 LU under the voice and adjust after someone listens.
- Programme loudness follows the platform: −16 LKFS Apple Podcasts, −23 LUFS EBU, −24 LKFS ATSC. Never quote one without its date and source.

**An A/B review.** Loudness-match first: a louder version wins by default and teaches nothing. Same span, same start bar, 4–8 bars with pre-roll, labelled "A" and "B", never "before/improved". Ask one question, with concrete options ("pad up an octave / pad out in the verse / pad 3 LU down"). Hand a verdict that would outlive this song to `studio-preferences`.

## Checks

- Song render `true_peak_db` ≤ −1 dBTP, ≤ −2 when loud or bound for a lossy format, −6 to −3 when someone else masters.
- No render at or above 0 dBFS; if one was, every track moved by the same amount.
- Lead is the loudest melodic part, 1–3 LU above the next sustaining part; bass within 3 LU of the lead and not more than 1 LU above; pads and doubles 6–10 LU below.
- No two non-doubled parts within 1 LU of each other.
- Every track whose notes sit mostly below C3 (48) has `pan` 0.
- Paired parts sit at equal, opposite pans, and both have clips.
- Each section quotes its own figure, and the chorus wins on two of the four section measures.
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