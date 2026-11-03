---
name: studio-arranging-and-sound
description: Use when a Studio song needs instruments chosen or placed in a register, chord voicings spaced and doubled, parts thinned to stop mud and masking, a density plan per section, or a SunVox patch built on Analog generator, Generator, DrumSynth or SpectraVoice.
triggers:
  - instrumentation
  - which instrument
  - voice the chords
  - spacing
  - doubling
  - too muddy
  - masking
  - too busy
  - arrangement density
  - sound design
  - synth patch
  - filter cutoff
  - diseño de sonido
  - instrumentos
tools:
  - studio
  - crow-memory
---

# Arranging and sound design

Instrument choice, register, spacing and density decide whether parts are heard as separate lines or one thick blur. In Studio each is a number: a pitch, a semitone distance, notes per bar, a `gain_db`. Make the numbers testable and say what you changed.

There are only four generators, no EQ, no reverb, no LFO and no module routing yet, so tone comes from the instrument's own controllers, the register you write in, and track gain and pan. When a fix needs a filter you lack, use the register instead.

## Ranges (typical; varies by player)

Sounding MIDI pitches, C4 = 60: full range, then practical comfort.

| Instrument | Full | Practical |
|---|---|---|
| Piano | 21–108 | 36–96 |
| Acoustic/electric guitar | 40–88 | 40–79 |
| Electric bass (4-string) | 28–67 | 28–60 |
| Double bass | 28–67 | 28–55 |
| Violin | 55–105 | 55–93 |
| Viola | 48–88 | 48–81 |
| Cello | 36–81 | 36–76 |
| Soprano | 60–81 | 62–79 |
| Alto | 55–74 | 57–72 |
| Tenor | 48–67 | 50–67 |
| Bass voice | 40–60 | 43–58 |
| Flute | 60–96 | 60–93 |
| Oboe | 58–93 | 60–86 |
| Clarinet in B♭ | 50–94 | 50–89 |
| Bassoon | 34–76 | 34–70 |
| Trumpet in B♭ | 52–82 | 55–79 |
| French horn | 35–77 | 41–72 |
| Trombone | 40–77 | 40–70 |
| Tuba | 26–65 | 28–58 |

- Test: every `p` in a part lies inside that instrument's practical column. Report violations by bar and beat, and offer the nearest octave.
- Voice parts: keep the lowest note at or above the practical floor. A tenor line that dips to 45 is a baritone in the wrong part.

## Registers and roles

| Band | Hz | MIDI | Role |
|---|---|---|---|
| Sub | < 60 | < 35 | Felt, not heard; one element, mono |
| Bass | 60–250 | 35–59 | The bass note; bass, low piano, low strings |
| Low mid | 250–500 | 59–71 | Guitar/piano body, low voice; mud collects here |
| Mid | 500–2000 | 71–95 | Most melodic fundamentals; instrument identity |
| Upper mid | 2–5 k | — | Presence, consonants, intelligibility |
| Highs | 5–20 k | — | Air, cymbals, sibilance |

Melodic fundamentals rarely pass C7 (96); above that it is harmonics, so brightness is timbre, not pitch.

Register assignment before notes: one owner of sub/bass, the melody highest, harmony in between. Two parts within about 5 semitones in the same band tend to fuse (rule of thumb).

## Voicing: spacing, doubling, mud

- **Wide low, close high.** Below C3 (48) the lowest two sounding voices stay at least a P5 (7 semitones) apart; thirds, seconds and clusters belong above 51.
- **Low-interval limits** (lowest note of each interval, approximate): m3 ≈ 51, M3 ≈ 46, P4 ≈ 45, P5 ≈ 34–36, octave unlimited. Arranging practice (Adler); sources vary by a few semitones, so audition near the boundary.
- **Doubling:** octaves add weight, not harmony; two timbres in unison make a new colour. In four-voice writing double the root, never the leading tone or the chordal seventh (common practice; loops and power chords are exempt).
- **One bass owner per section.** Test: at every downbeat exactly one track has a sounding note below 48. If two do, move one up 12 or delete its low notes — do not "fix" it with gain.
- **Mud:** 250–500 Hz energy piled up. Test: at most two sustaining parts have fundamentals or second harmonics in that band at the same moment. For a pad that fails, write it at p 72+ rather than high-passing it — there is no EQ.
- **Masking:** two sustained notes 1–2 semitones apart in the same octave hide each other. Move one by 12 (octave) or drop it. Never add a counter-line inside the lead's octave; put it 12 below or 12 above.
- **Vocal space:** while a vocal note sounds, no other part holds a note within 3 semitones of it for a beat or more. Fill the gaps between phrases.

## Density by section

| Section | Active tracks | Notes per bar | Top voice |
|---|---|---|---|
| Intro | 1–3 | 2–8 | mid |
| Verse | 3–5 | 4–12 | low-mid |
| Pre-chorus | 4–6 | 8–16 | rising |
| Chorus | 5–8 | 12–24 | highest in the song |
| Bridge | 3–5, different timbres | any | contrast |
| Outro | 3 → 1 | falling | falling |

- Count the elements: five simultaneously competing parts is about the ceiling (Owsinski's heuristic, not a law). Studio allows 16 tracks; density is not track count.
- **Chorus test** (the same four measures as `studio-rhythm-and-form`): win two of four against the verse — active tracks, note events per bar, top-voice pitch, scene LUFS. Starting heuristics: notes +25 %, pitch +3 semitones, LUFS +1.5. Render each scene with `studio_render` (8 bars = 8 × 240/bpm seconds) and quote the numbers.
- **Contrast:** every section changes at least one measurable thing. Verse 2 adds one element over verse 1, not a rewrite.
- Raise energy by adding a layer, raising the register, doubling note values (8ths → 16ths) or opening `F.freq` (once `Filter` is set); lower it by removing drums or bass, narrowing pan, and dropping an octave.

## What the four instruments actually offer

Consult `studio_module_types` before trusting any value here: the catalogue gives names and ranges, not what every selector does.

| Concept | Real control |
|---|---|
| Oscillator shape | Analog `Waveform` 0–16, Generator 0–8 — the numbering is not in the catalogue; audition it |
| Pulse width | `Duty cycle` — Analog 0–1024, Generator 0–1022; halfway is square, extremes are narrow |
| Second oscillator | Analog `Osc2` 0–2000 (default 1000), `Osc2 volume` 0–32768, `Osc2 mode` 0–8 — no ratio and no FM is documented |
| Filter cutoff | Analog only: `Filter` 0–8 (type, default 0), `F.freq` 0–14000 (14000 = open), `F.exponential freq` 0/1 |
| Resonance | Analog `F.resonance` 0–1530; 0 is flat, high values whistle or self-oscillate |
| Amp attack / release | All four: `Attack`, `Release` — Analog 0–256, Generator and SpectraVoice 0–512, plus `Sustain` 0/1 |
| Filter envelope | Analog `F.attack` 0–256, `F.release` 0–256, `F.envelope` 0–2 |
| Noise | Analog `Noise` 0–256 |
| Voices / mono | `Polyphony` — Analog 1–32, Generator 1–16, SpectraVoice 1–32. Set 1 for bass and lead |
| Additive harmonics | SpectraVoice: `Harmonic` 0–15 picks the partial, then `H.freq`, `H.volume` 0–255, `H.width` 0–255, `H.type` 0–18; `Spectrum resolution` 0–5 |
| Drum voices | DrumSynth: `Bass`/`Snare`/`Hihat` × `volume`, `length`; `Bass tone`, `Snare tone`; separate `panning` per voice |

- **No decay knob (the amp envelope is A–S–R here).** Realise a decay by short note `d`, `Sustain` 0 plus a short `Release`, or a low `F.freq`.
- **No LFO, no modulation routing.** Vibrato, tremolo and filter wobble are not available in a clip; approximate movement with repeated notes at different velocities, or leave it out and say why.
- **FM basics** (Chowning 1973): integer modulator ratios give harmonic spectra, non-integer ones bell or metallic tones. `Osc2` is a second oscillator, not a documented modulator: nothing in the catalogue explains its 0–2000 scale, so read no ratio into it — audition a few values either side of 1000 and call the result two oscillators, not FM.
- Generator `Freq.modulation by input` 0–256 needs an audio input; a Studio track has none, so it does nothing useful yet.
- Selector meanings the catalogue does not spell out (`Filter`, `F.envelope`, `Mode`, `H.type`, `Osc2`) are auditioned one value at a time, never guessed.

## Patches

Arguments for `studio_track_set_device`; `params` replaces the whole set. Audition every value: the catalogue names no meaning for `Waveform`, `Filter` or `Osc2`, and no patch below filters until `Filter` is set.

**Sub bass** — Analog generator, mono, no filter:
```
{"type":"Analog generator","params":{"Waveform":0,"Volume":200,"Attack":0,"Release":12,"Polyphony":1}}
```
p 28–40. One owner; note `d` long, gaps short so tails do not overlap.

**Mid bass** — Analog generator, two oscillators, lower cutoff:
```
{"type":"Analog generator","params":{"Waveform":3,"Volume":180,"Attack":0,"Release":20,"Polyphony":1,"Osc2":1010,"Osc2 volume":20000,"F.freq":900,"F.resonance":220}}
```
p 48–60, above the sub, so one track still owns everything below 48. `Osc2` 1010 is a guess for slow beating, not a ratio.

**Pad** — SpectraVoice, slow attack, long release:
```
{"type":"SpectraVoice","params":{"Attack":180,"Release":380,"Polyphony":8,"Sustain":1,"Spectrum resolution":2,"H.volume":200}}
```
Chord tones at p 72+ unless the pad is the only sustaining part in 59–71 (250–500 Hz).

**Pluck** — Analog generator, filter envelope:
```
{"type":"Analog generator","params":{"Waveform":3,"Volume":160,"Attack":0,"Release":30,"Sustain":0,"F.freq":1200,"F.resonance":300,"F.attack":0,"F.release":40,"F.envelope":1}}
```
Any register; `d` 0.25–0.5 beats.

**Lead** — Analog generator, mono, slightly detuned:
```
{"type":"Analog generator","params":{"Waveform":3,"Volume":140,"Attack":4,"Release":40,"Polyphony":1,"Osc2":1003,"Osc2 volume":12000,"F.freq":6000,"F.resonance":300}}
```
p 60–84. Sits 1–3 LU above the next-loudest sustaining part.

**Keys, two-oscillator** — Analog generator, `Osc2` loud:
```
{"type":"Analog generator","params":{"Waveform":0,"Volume":150,"Attack":2,"Release":80,"Sustain":1,"Osc2":2000,"Osc2 volume":14000,"F.freq":6000}}
```
Voicings 48–72; leave the root out when a bass track holds it.

**Drums** — one DrumSynth track holding all three voices, or one per voice as below; the note number picks the voice and the map is unknown, so calibrate once: write a chromatic run of 16ths across the pitches you will use, render it, and ask which number is kick, snare and hat. Put the three numbers in the clip name.

```
{"type":"DrumSynth","params":{"Bass volume":300,"Bass power":256,"Bass tone":40,"Bass length":48,"Snare volume":0,"Hihat volume":0,"Polyphony":2}}
{"type":"DrumSynth","params":{"Snare volume":300,"Snare tone":140,"Snare length":60,"Bass volume":0,"Hihat volume":0,"Snare panning":140}}
{"type":"DrumSynth","params":{"Hihat volume":220,"Hihat length":24,"Bass volume":0,"Snare volume":0,"Hihat panning":176}}
```
Closed hat `Hihat length` 16–32, open 80–128 (never both on one voice at once); `Bass tone` and `Hihat length` are audition-only values.

Tweak one value at a time with `studio_track_set_param`:
```
{"name":"F.freq","value":600}
{"name":"F.resonance","value":400}
{"name":"Release","value":8}
```
Re-render after each and quote the two LUFS readings.

## Release tails

`Release` belongs to the instrument, not the note, so the grid always looks cleaner than the render.

- Effective end of a note ≈ `t + d + r`, where `r` is the tail in beats. SunVox `Release` is unitless (0–256), so measure `r` from a render, never convert it from ms.
- **Overlap test:** on one track, no note may start before the previous one ends (`t₂ < t₁ + d₁`), except on a pad. Overlapping bass notes below 48 beat audibly and smear the harmony.
- Bass `Polyphony` 1 makes overlaps retrigger instead of sum. That is usually the cheapest fix; shortening `Release` to 8–24 is the other.
- Before a chord change, shorten the last note by 0.1–0.25 beats so its tail ends inside the old chord; a pad's tail crossing the change holds the old chord against the new one.
- Pads: audition `Release` 0 / 64 / 128 and keep the smallest value that joins the notes; a smear may be the intended sound.
- A tail cannot be measured from LUFS. Say "the pad's release may cross the change at bar 5, listen there" — never that it does.

## Checks before you call a part done

- Every `p` inside its practical range; name the bars that fail.
- One track owns sub/bass at each downbeat; nothing else sounds below 35.
- No two simultaneous notes both below 48 closer than 5 semitones; the lowest two below 48 at least 7 apart.
- At most two sustaining parts in 250–500 Hz at once; nothing within 5 semitones of the melody in its octave.
- No non-vocal note held ≥ 1 beat within 3 semitones of a sounding vocal note.
- No unintended note overlaps on melodic tracks; release windows checked across each chord change.
- Chorus beats the verse on two of four: active tracks, note events per bar, top-voice pitch, scene LUFS.
- True peak ≤ −1 dBTP on the song render; keep the bass, kick and lead at pan 0.
- Report numbers, not adjectives: "three tracks sit in 250–500 Hz in bar 5", never "muddy".

## Taste defaults

- Fewer parts, each doing one job. Add a register, not a track.
- Octave doubling before a new harmony note.
- Keep the melody's octave free; put the answer in the gap after the phrase.
- One climax per section, in the highest voice.
- Velocity carries the shape: 100+ accents, 70–90 body, 20–45 ghosts.
- Store verdicts with `crow_store_memory`: "no pad under the verse; hats closed until the chorus".

## Sources

Adler, *The Study of Orchestration*, 4th edn, 2016 · Gotham et al., *Open Music Theory* v2 (CC BY-SA 4.0) · Owsinski, *The Mixing Engineer's Handbook*, 5th edn, 2022 · Russ, *Sound Synthesis and Sampling*, 3rd edn, 2009 · Reid, "Synth Secrets", *Sound on Sound*, 1999–2004 · Chowning, "The Synthesis of Complex Audio Spectra by Means of Frequency Modulation", *JAES* 21/7, 1973 · SunVox module catalogue, Alexander Zolotov, read from `studio_module_types`.