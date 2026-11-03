---
name: studio-modern
description: Use when a Studio part should be post-tonal or experimental: tone rows, pitch-class sets, planing, octatonic or Messiaen modes, seeded chance, phasing, additive process, tintinnabuli, clusters, micropolyphony, spectral chords, generative loops — or when the operator asks if a clip is twelve-tone, in a named set, or seed-reproducible.
triggers:
  - twelve-tone
  - tone row
  - serialism
  - pitch-class set
  - atonal
  - octatonic
  - Messiaen mode
  - chance music
  - Cage
  - phasing
  - minimalism
  - tintinnabuli
  - dodecafonía
  - música aleatoria
tools:
  - studio
---

# Post-tonal and experimental techniques

Post-tonal work is checkable arithmetic plus taste you cannot verify. Every procedure here writes `{t, d, p, v}` notes in 4/4 at integer semitones, so all of it is 12-TET. You hear nothing: correctness comes from the checks, the verdict on sound from a render's numbers or the operator's ear.

## Before you start

- Read `studio_session_summary`, then every clip you touch (`studio_get_clip`). One clip per track, loops over whole bars, scenes are blocks.
- No pitch bend, tuning tables, effects or sampler: microtones, prepared sounds and reverb are approximations — say so. `Polyphony` must be at least the simultaneous note count, or notes disappear.
- Seed every random choice, log every draw, name every convention (tie-break, row labelling, offset unit): an unexplained parameter is a claim.

## Pitch-class sets

| Term | Rule |
|---|---|
| pc | `p mod 12`, C = 0; Forte writes 10, 11 as T, E |
| ic | `d = (b − a) mod 12`, `ic = min(d, 12 − d)` |
| IV | six digits, +1 to slot `ic−1` per unordered pair |
| Tn, In | `Tn(x) = (x+n) mod 12`, `In(x) = (n−x) mod 12` |

**Normal form:** dedupe, sort, rotate (wrapped +12), take the smallest last−first span, ties by the first→second-to-last distance. **Prime form:** the tighter of the normal forms of the set and of its inversion, each starting on 0. Rahn and Forte break ties differently for a few classes (varies by source): name yours. Look Forte numbers up; never derive them.

| Set | Forte | Prime form | IV |
|---|---|---|---|
| Viennese trichord | 3-5 | 016 | 100011 |
| major / minor triad | 3-11 | 037 | 001110 |
| all-interval pair | 4-Z15, 4-Z29 | 0146, 0137 | 111111 (Z-relation) |
| hexatonic | 6-20 | 014589 | 303630 |
| whole tone | 6-35 | 02468T | 060603 |
| octatonic | 8-28 | 0134679T | 448444 |

- Cell melody: one class, e.g. [016]; each bar's notes, or every three consecutive notes, a Tn or In of it. Free octaves, fixed rhythm — rhythm is what makes a cell audible.
- Complement: harmonise a melody from set X with chords built from the pcs X omits. Common tones: `Tn` preserves the pcs counted in IV[n] for n ≠ 6, and 2 × IV[6] at n = 6.
- Report the ic 1 and ic 6 share per bar (harsher) against ic 2, 4, 5 (more open).

Listen for a cell that returns as a motive; ask whether the operator can hum it back.

## Twelve-tone

`P0[i] = (row[i] − row[0]) mod 12`, then `P_n[i] = (P0[i]+n) mod 12`, `I_n[i] = (n − P0[i]) mod 12`, `R_n[i] = P_n[11−i]`, `RI_n[i] = I_n[11−i]`. Inverting about the row's first note is `I(x) = (2·row[0] − x) mod 12`.

**Matrix:** top row `P0`, left column `I0[i] = 12 − P0[i]`, cell `(i,j) = (P0[j] + I0[i]) mod 12`; rows are P and R, columns I and RI. Naming of R/RI varies by source — state yours.

**Checks:** `sorted(row) == [0..11]`; `P0[i] + I0[i] ≡ 0`; every 12-note statement holds all twelve pcs once. Repetition and tremolo do not advance the row (Schoenberg's allowance), and octaves are free: count pcs, not notes.

**Using it:** one row note per onset, octave free; or verticalise 3–4 consecutive notes as a chord; or split one form into dyads between melody and accompaniment. Give each statement a rhythm other than even quarters and one register landmark, or the form is inaudible.

**Combinatoriality:** with A = row order positions 1–6, B = 7–12, the row is I-combinatorial at `n` when `{(n−x) mod 12 : x ∈ A}` equals B's pcs; P-combinatorial uses `+n`. All-combinatorial hexachords: 6-1, 6-7, 6-8, 6-20, 6-32, 6-35.

## Integral serialism

Durations `D_k = 0.125·k` beats, k = 1..12 (0.125–1.5; a statement totals 9.75 beats, never bar-aligned — pad with a rest or state the offset); velocities `V_k = 16 + 8(k−1)` (16–104). Note i takes `P[i mod 12]`, `D[σ(i)]`, `V[τ(i)]`, with σ, τ order numbers of other row forms.

Serialise at most three parameters: serialising pitch, duration and velocity flattens the surface (Ligeti's objection), so fix one element — a register, a repeated pitch, a rhythmic cell. Messiaen's *Mode de valeurs* is a fixed mode, not a series: say which you mean.

Listen for unpredictable accents and a pointillist surface; ask which register the operator hears as the tune.

## Scales and collections

**Planing (Debussy):** real planing adds `m+0, m+4, m+7, m+11` above every melody note m — chromatic, and it can clash with the bass; diatonic planing moves each voice to the next degree of a fixed collection. Keep planes within two octaves, 10–20 velocity below the line they double.

**Whole tone** `{0,2,4,6,8,10}`, two transpositions: no fifth, no leading tone.

**Octatonic**, three collections: OCT01 `{0,1,3,4,6,7,9,10}`, OCT12 `{1,2,4,5,7,8,10,11}`, OCT23 `{2,3,5,6,8,9,11,0}`. Each holds four major and four minor triads, roots a minor third apart; superimpose triads a tritone apart for the *Petrushka* sound (C and F♯ major both sit in OCT01), or alternate triads a minor third apart.

**Stravinsky blocks:** scenes as blocks, cut at irregular lengths, develop nothing; an ostinato keeps its pcs and displaces onsets by 0.25 or 0.5 beats per phrase.

**Messiaen modes:** cumulative sum of the interval group from a start pc, filled to twelve semitones, deduped.

| Mode | Group | Pcs | Transpositions |
|---|---|---|---|
| 1 | 2 | 6 | 2 |
| 2 | 1-2 | 8 | 3 |
| 3 | 2-1-1 | 9 | 4 |
| 4 | 1-1-3-1 | 8 | 6 |
| 5 | 1-4-1 | 6 | 6 |
| 6 | 2-2-1-1 | 8 | 6 |
| 7 | 1-1-1-2-1 | 10 | 6 |

**Non-retrogradable rhythm:** `d = seq + [centre] + reverse(seq)`; check the `d` list equals its reverse.

**Added values:** insert one extra 0.25 or 0.5, or dot a note (`d × 1.5`); everything after shifts, so keep the clip's total a multiple of 4 beats or say that later bars no longer align with other clips.

**Bartók:** two modes on one tonic (C Lydian `{0,2,4,6,7,9,11}` with C Phrygian `{0,1,3,5,7,8,10}` gives all twelve pcs), melody in one and accompaniment in the other. The axis system is Lendvai's model, not Bartók's stated method (contested). A climax at 0.618 of a span is your design choice; that Bartók planned pieces that way is contested, so never assert it.

Listen for a stable colour that is not a key, and for whether an added value lilts or stumbles — repeat it so the ear learns it.

## Chance and indeterminacy

- One integer seed, one PRNG (e.g. mulberry32), no re-draws; report the seed, the charts and every draw ("event 17: draw 42 → p 74, d 1.75, v 30").
- The charts are the composition: 8–12 pitches, 6–8 durations (0.25–3 beats), 4–6 velocities, silence as an entry; draw one index per parameter per event.
- A uniform 1–64 draw stands in for an I Ching hexagram; Cage's treatment of changing lines is unverified — don't claim it.
- Time brackets: start in [s1, s2], end in [e1, e2], clamped inside the clip, quantised only if asked.
- Open form: fragments as scenes ordered by a seeded permutation; report the order. Lutosławski's aleatory counterpoint is exact parts, unsynchronised — coprime clip lengths make them drift.
- Say it plainly: you designed the field, chance chose inside it. Silence is an entry.

## Minimalism as clip processes

**Modules (Riley):** 8–20 original one-bar modules in a fixed order. No per-player counters, so spell the repeats out in one long clip per player, or one scene per module for the operator to hold; give the counts. Never use published modules.

**Discrete phasing (Reich):** pattern p of L steps (L = 12 sixteenths = 3 beats); clip B plays `rotate(p, k)`, the onset at step i moving to `(i − k) mod L`. k = 0..L gives L+1 states, the last back at unison: one scene per k, 13 scenes for L = 12. Each part repeats the pattern R times, and clips are whole bars: R a multiple of 4, clip 3 × (R/4) bars (R = 4 → 3 bars). A 4- and a 5-bar clip cannot phase — the shorter one just cuts.

**Continuous phasing:** shift B's repetition r by `r·δ` beats, δ = 1/32, so a sixteenth of drift takes 8 repetitions; hold that rotation for 8, then drift again. Offsets are note starts — name the unit and say whether a note crossing the clip end is shortened or dropped.

**Resulting patterns:** double the pcs recurring at the same step positions in a third clip and name the pitch you derived.

**Additive / subtractive (Glass):** cell c of k notes; play `c[0:1]` R times, `c[0:2]` R times, … `c[0:k]` R times, then back down. Report the step lengths and R.

Listen for whether the process is audible (Reich's test) and the rate slow enough to follow; use clear attacks, since pads smear phase.

## Tintinnabuli (Pärt)

1. A mode and its tonic triad: A Aeolian with A C E (pcs 9, 0, 4).
2. M-voice: stepwise from a centre pitch, in phrases of your choosing (phrase k moving k steps away and back), sharing the T-voice's rhythm.
3. T-voice: triad pcs only, by rule against each M note — **superior 1st** lowest triad pitch above M, **inferior 1st** highest below, **2nd position** the next-but-nearest on the side you name (say which; skip M's own pitch), **alternating** sides switched per note.
4. Keep T in 48–84 and 10–20 velocity below M so it rings under, not against.

Check every T pc is in `{9,0,4}` and every T note satisfies the named rule — rerun the rule, don't trust a list. Listen for consonance without cadence.

## Sound mass, clusters, micropolyphony

- Cluster: at one onset every semitone from lo to hi (6–24 notes) in one clip; move lo and hi 1–2 semitones per bar, velocities 25–45. One clip holds the whole cluster, but `Polyphony` must cover it: 24 notes needs Analog or SpectraVoice (max 32), not Generator (16).
- Micropolyphony (Ligeti): N copies of a chromatic line in a 6–12 semitone band, copy i starting `i·0.25` beats later with durations `×(1 + 0.03i)`; the 16-track limit caps N, so widen the band before adding copies.
- Stochastic cloud: per bar a Poisson event count, uniform onsets, pitches from a normal (μ, σ), exponential durations, a narrow velocity band; move λ, μ, σ slowly, seeded.
- Listen for a mass with direction — thickening, thinning, a moving centre — not merely density; measure events per beat, band width and register span.

## Spectral harmony

`f_n = n·f0`, `m = 69 + 12·log2(f/440)`, `base = round(m)`, cents error `= 100·(m − base)`. Errors against 12-TET, in cents: partials 1, 2, 4, 8 → 0; 3, 6 → +2; 5 → −14; 7 → −31; 9 → +4; 11 → −49; 13 → +41. A negative error means the MIDI note is sharp of the true partial.

Voice partials 1, 2, 3, 4, 5, 6, 7, 9, 11, 13 over a fundamental at p 36–48 — ten at once, so `Polyphony` 10+ (SpectraVoice defaults to 8); the top partial must stay ≤ 127, so `n ≤ 2^((127 − p0)/12)`. Drop the worst-error partials for fusion, keep 7 and 11 for beating. Stretched (`f_n = f0·n^s`, s = 1.03), compressed (s < 1) and shifted (`n·f0 + d`) spectra convert the same way; report every error.

**Studio cannot tune these notes:** no pitch bend, no tuning table, so the errors stand. Never call such a chord just intonation — call it approximated, with the errors. Listen for fusion against separation and for roughness rising with inharmonicity.

## Microtonality, today's limit

Studio notes are integers, so 12-TET is all there is: no pitch bend, no tuning files, no per-note tuning. Quarter tones, just ratios, 24- or 31-EDO and Partch's 43-tone scale **cannot be played**. Write the nearest semitone, report the error, and move the Analog generator's `Osc2` (0–2000, default 1000) away from that default to make oscillators beat — audition it. Never call a clip microtonal or justly tuned.

## Generative and ambient systems

- Coprime clip lengths in bars: 3, 5 and 7 bars coincide only after 105 bars = 420 beats — report that as "how long until it repeats". A two-layer bed: 4 and 5 bars → 20 bars.
- Each loop: one or two soft notes (v 40–60) and long silence, all layers in one scene. Incommensurability is impossible on a grid; say you approximated it with coprime integers.
- Other engines, each a logged table plus a draw: a Markov chain over (pitch, duration) tokens at a stated order; a cellular automaton (rule 90 or 30) with a row per bar mapped to scale onsets. Listen for variety that neither loops audibly nor becomes noise.

## With tonal and popular idioms

- One device at a time: a planed chord in a pre-chorus, an octatonic run over a V7 via the collection holding root and third, a whole-tone fill, a mode-2 pad over an ostinato, a tintinnabuli line retargeting its triad per chord, a pad voiced on the bass partials.
- An additive process is a riser: grow a cell over 8–16 bars into the drop. A coprime ambient bed sits 8–12 LU below the lead.
- The tonal parts keep their grammar (`studio-harmony`, `studio-counterpoint`); don't correct a modern device with it, or the reverse.

## Copyright and honesty

- Techniques are free; published music is not. Never put a published row, melody or module set (a score's row, *In C*'s modules, *Piano Phase*'s pattern) into a clip: generate original material by the same procedure and say so.
- Mark what is contested: Bartók's golden section, the axis system, Forte versus Rahn prime forms, R/RI naming, and the repeat count in analyses of *Clapping Music*.
- In the reply: technique and originator in one line, the parameters (Forte class, row forms, seed, LCM, cents), the render's LUFS and true peak, and "checked" kept apart from "my judgement".

## Checks before you send

| Claim | Test |
|---|---|
| Row | each 12-note statement's pcs sorted == 0..11 |
| Set | every pc used lies in the named class or collection |
| Palindrome | the `d` list equals its reverse |
| Phase | each part's onsets are the rotation you claim |
| Tintinnabuli | T pcs in the triad, every note on the named rule |
| Chance | the logged draws reproduce the notes |
| Spectral | every note carries a stated cents error |
| Loudness | true peak ≤ −1 dBTP, numbers quoted |

Taste stays with the operator — audibility, rate of change, timbre, intent. Ask one question about one bar.

## Sources

- Forte, *The Structure of Atonal Music* (1973); Straus, *Introduction to Post-Tonal Theory*, 4th ed. (2016); Rahn, *Basic Atonal Theory* (1980).
- Gotham et al., *Open Music Theory* v2, post-tonal chapters (CC BY-SA 4.0), viva.pressbooks.pub/openmusictheory.
- Schoenberg, *Style and Idea* (1975); Babbitt, "Some Aspects of Twelve-Tone Composition" (1955).
- Messiaen, *The Technique of My Musical Language* (1956); *Mode de valeurs et d'intensités* preface (1949).
- Berger (1963), van den Toorn (1983), Taruskin (1996) on Stravinsky; Bartók, *Essays* (1976); Lendvai (1971); Howat (1983), the critique.
- Cage, *Silence* (1961); Reich, *Writings on Music* (2002); Riley, *In C* directions (1964); Glass (1987); Hillier, *Arvo Pärt* (1997).
- Ligeti, "Metamorphoses of Musical Form" (1960); Xenakis, *Formalized Music* (1992); Grisey (1987).
- Partch, *Genesis of a Music* (1974); Eno, "Generative Music" (1996), inmotionmagazine.com/eno1.html.