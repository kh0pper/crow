---
name: studio-counterpoint
description: Use when the operator wants a part that has to move against another — a bass under a melody, an inner voice, a descant, a second line, a chorale, canon or fugue — or asks whether two parts move well together, why a pair sounds wrong, or where parallel fifths are hiding.
triggers:
  - counterpoint
  - voice leading
  - bass line under the melody
  - harmonise this melody
  - add an inner voice
  - write a descant
  - second voice
  - parallel fifths
  - chorale
  - fugue
  - canon
  - contrapunto
  - línea de bajo
  - armonizar la melodía
tools:
  - studio
---

# Counterpoint: one line against another

Studio gives you independent lines and no ear — a render returns loudness and peak, and says nothing about intervals. So the interval work is arithmetic on the notes you read with `studio_get_clip`, and the verdict on whether a line sings belongs to the operator. This skill is that arithmetic: classes, checks, the species ladder, chorale and fugal procedure, and where a modern texture wants it relaxed.

## Set up the comparison

- Read both clips. One voice is one monophonic line, normally two clips on two tracks. A clip holding chords has no unambiguous voices — prefer separate tracks, or ask.
- Build the **onset grid**: every distinct note start in either clip, sorted, in beats (4/4, 4 beats per bar).
- **Sounding pitch** at an onset is the note with `t ≤ onset < t + d`. Held notes count; they are not gaps. A note ending exactly on the onset does not sound there.
- Close the loop: clips loop, so compare the last onset before the loop with the first of the next pass.
- `ic = |pA − pB| mod 12`. Compound intervals behave as simple ones: a 12th is a 5th, and P5→P12 is two fifths.
- Metric weight: `t mod 4 == 0` strong, `== 2` moderately strong, odd beats weak. In a half-note species reading the first half is strong, the second weak.

## Interval classes

| `ic` | Interval | Class |
|---|---|---|
| 0 | unison, octave | perfect |
| 7 | fifth | perfect |
| 3, 4 | third | imperfect |
| 8, 9 | sixth | imperfect |
| 1, 2, 10, 11 | second, seventh | dissonant |
| 6 | tritone | dissonant |
| 5 | fourth | dissonant above the lowest voice, consonant between two upper voices |

In two voices every fourth is above the bass, so dissonant; in three or more a fourth between upper voices is consonant, one over the bass (6/4) is not. Jeppesen treats the fourth as hovering between the classes and admits a "consonant fourth" over a held bass (varies by source).

## Motion

| Motion | Test on the signed changes `dA`, `dB` |
|---|---|
| oblique | one of them is 0 |
| similar | same sign, both non-zero, `ic` changes |
| parallel | same sign, same generic interval: `ic(i) == ic(i+1)`, or both `ic` in `{3,4}` or both in `{8,9}` (M3→m3 counts) |
| contrary | opposite, non-zero signs |

## The checks

Run each on every pair of adjacent onsets: `i` is one onset, `i+1` the next.

| # | Check | Condition | Severity |
|---|---|---|---|
| C1 | parallel 5ths / 8ves / unisons | `ic(i) == ic(i+1)` both in `{0,7}`, both voices move, same direction | error, every classical mode |
| C2 | repeated perfect | `ic(i) == ic(i+1)` in `{0,7}` with any motion (contrary and compound included), when at least one voice takes a new note and the pitches differ | error in strict and chorale |
| C3 | direct / hidden 5th or 8ve | similar motion, `ic(i+1)` in `{0,7}`, `ic(i)` different | error in two strict voices; chorale: only bass–soprano with a soprano leap > 2 semitones; warning in three or more with a stepwise upper voice |
| C4 | crossing | `p_upper < p_lower` at an onset | error in chorale, warning in species |
| C5 | overlap | `p_upper(i+1) < p_lower(i)` or `p_lower(i+1) > p_upper(i)` | same as C4 |
| C6 | spacing | pair wider than 19 semitones for more than two onsets; soprano–alto or alto–tenor > 12; tenor–bass > 19 | warning |
| C7 | unexplained dissonance | an onset with `ic` in `{1,2,6,10,11}`, or 5 above the lowest voice, that matches no row of the dissonance table | error |
| C7b | dissonant simultaneous attack | both voices start a note at the same onset and `ic` is dissonant (as in C7) — passing, neighbour and similar types need the other voice already sounding (in a suspension the dissonant voice is held, so it never strikes with the other); only an appoggiatura, in styles that allow it, may strike together | error in strict and chorale, warning in pop |
| C8 | melodic intervals | `|Δ|` in `{6,10,11}` or above 12; also 9, and −8 in strict style | error in a vocal line, warning instrumental |
| C9 | leap recovery | after `|Δ| ≥ 5`, the next move is a step of ≤ 2 semitones the other way; no three leaps running; no two leaps the same way unless they outline a consonance | warning |
| C10 | dissonant outline | the span of a monotone run, or between turning points, `% 12` in `{6,10,11}` | warning |
| C11 | imperfect runs | more than three of the same `ic` in `{3,4,8,9}` in a row | warning (three per the Fux-based texts, four per Jeppesen; faster notes tolerate more) |
| C12 | opening and close | first `ic` in `{0,7}`, last `ic == 0`, penultimate in `{3,9}` reached by contrary step | error in strict mode |
| C13 | tendency tones (tonal) | leading tone in an outer voice rises a step to 1̂ over V→I; chordal 7th falls a step; neither is doubled | error |
| C14 | unison count | first species: unisons only first and last; three or more voices: all voices in unison only first and last | error |

On C3 the authorities disagree: strict two-voice teaching forbids hidden perfects outright, Jeppesen allows them in fourth and fifth species behind a suspension, chorale practice flags only the outer pair when the soprano leaps. Say which mode you checked in.

## Dissonance: what makes one legal

| Type | Approached by | Left by | Position |
|---|---|---|---|
| passing tone | step | step, same direction | weak beat in second species; beats 2–4 in florid writing; neighbours on both sides consonant |
| neighbour | step | step, opposite, back to the same pitch | beats 2–4 (varies by source: Jeppesen the lower neighbour only) |
| cambiata | step | leap of a 3rd, then a step the other way | unaccented; in species work the one dissonance left by leap |
| suspension | held from the previous weak beat, consonant there | step down 1–2 semitones to a consonance | the strong beat |
| appoggiatura (tonal) | leap | step, usually down | strong beat |
| escape tone (tonal) | step | leap, opposite direction | weak beat |
| retardation (tonal) | held | step up | strong beat |
| anticipation (tonal) | step | held into the next onset | weak beat |

Suspension types: above the cantus 7–6 and 4–3 are the staple, and 9–8 is allowed by the Fux-based texts while Jeppesen excludes it because it resolves to a perfect consonance (contested). Below the cantus 2–3 is the staple, and 4–5 with 7–8 is listed by some while Jeppesen excludes it for the same reason. At most three of one type in a chain, never two 9–8 or two 4–5 in a row.

## Species: the teaching ladder

| Species | Rhythm | Dissonance |
|---|---|---|
| 1st | note against note | none: every onset consonant, imperfect intervals preferred away from the ends |
| 2nd | two notes against one | one passing tone on the weak half; downbeat to downbeat obeys C1–C3 |
| 3rd | four against one | passing, neighbour or cambiata on beats 2–4 by step; downbeats consonant, never a unison |
| 4th | syncopation, tied over the bar | suspensions only: prepared on the weak beat, resolved down by step on the next weak beat |
| 5th | florid mixture | all of the above; eighths only in pairs on weak beats by step; reduce each ornament to its plain figure and check that |

Cadence, the same in every species: the voices end 2̂→1̂ against 7̂→1̂ by contrary step, so the penultimate interval is a 6th expanding into the octave (`ic` 9 → 0) or a 3rd contracting into the unison (`ic` 3 → 0). Raise the leading tone in modes with a whole step below the final, and never in Phrygian.

## Four voices (chorale)

- Ranges in MIDI: soprano 60–79, alto 55–74, tenor 48–67, bass 41–62.
- Spacing: soprano–alto and alto–tenor ≤ 12 semitones, tenor–bass ≤ 19. No crossing, no overlap (C4 and C5 as errors).
- Double the root of a root-position triad; never double the leading tone or a chordal seventh; a seventh chord states each note once.
- V7: 7̂ rises to 1̂, 4̂ falls to 3̂, 2̂ falls to 1̂. For a complete tonic either omit the fifth and double the root, or drop the leading tone to 5̂ in alto or tenor only.
- Unequal fifths: P5→d5 is usually allowed and d5→P5 usually avoided, especially with the bass (varies by source).
- First and last sonority complete or missing its fifth. A major third on the final (Picardy) is a sixteenth-century habit (Jeppesen); in chorale style take the mode's own third unless asked.
- Check parallels between every pair, not only the outer two.

## Eighteenth-century procedure

- Think in chords, not intervals. Take the harmony each onset implies, label the note chord tone or non-chord tone, and C7 becomes "does this non-chord tone match a type in the table".
- Invertible counterpoint: inverting at the octave turns each interval `x` into `9 − x`, so fifths become dissonant fourths (keep fifths out, or only in the free voice) and 4–3 suspensions become 5–6 (prefer 7–6 and 2–3). At the tenth `x → 11 − x`: parallel thirds become octaves, parallel sixths become fifths. At the twelfth `x → 13 − x`: sixths become sevenths, thirds survive. To test, transpose one voice by the interval and re-run C1–C7.
- Imitation: the follower enters on a perfect consonance at a metrically matching point, keeping the rhythm and the opening intervals of the point.
- Canon: `p_follower(t) = p_leader(t − lag) + k`, then run every check on the pair.
- Fugue: subject; answer up a fifth or down a fourth, real (exact) or tonal (adjust the opening so 5̂ is answered by 1̂, not 2̂); a countersubject written so it still works under both; exposition with one entry per voice, each new entry in an outer register; an episode between entries built from a subject motive; stretto when an entry begins before the previous one ends.

## Write a bass under a melody

1. Read the melody: onsets, pitches, metric weights, and the harmony each bar implies.
2. Choose the progression before any bass note — one chord per bar or per half bar, the loop's last chord leading back into bar 1.
3. Choose the rhythm as the complement: melody in quarters means bass in halves or whole notes. Attack where the melody sustains, sustain where it moves.
4. Place roots, with at most one non-root figure (passing or neighbour) on a weak beat.
5. Write fewer notes than you want. Four notes in two bars is a line; one per beat is a doubling.
6. Run C1–C14 on the pair, loop seam included, and fix by moving the new line — never the operator's melody.
7. Render, report the integrated LUFS and true peak, and ask for the ear's verdict.

### Worked example (key G major)

The verse melody reads back as G4 B4 D5 C5 B4 A4 G4 on beats 0–6 with the last note held to 8; if the clip's onsets differ, redo the table. Harmony: bar 1 is I (G), bar 2 is vi (Em). The bass keeps to halves and holds, so the melody's C and A fall as passing tones.

```json
{"tool": "studio_clip_write", "arguments": {
  "song_id": "s1", "track_id": "bass", "scene_id": "verse",
  "name": "Bass verse", "length_bars": 2,
  "notes": [
    {"t": 0, "d": 2, "p": 43, "v": 88},
    {"t": 2, "d": 1, "p": 47, "v": 76},
    {"t": 3, "d": 2, "p": 43, "v": 80},
    {"t": 5, "d": 3, "p": 40, "v": 84}
  ]}}
```

| Onset | Bass | Melody | `ic` | Verdict |
|---|---|---|---|---|
| 0 | G2 43 | G4 67 | 0 | opening octave, reached obliquely |
| 1 | 43 held | B4 71 | 4 | consonant |
| 2 | B2 47 | D5 74 | 3 | consonant, a chordal skip inside I (G2–B2–G2 leaps a third) |
| 3 | G2 43 | C5 72 | 5 | dissonant: passing tone, D5→C5→B4 |
| 4 | 43 held | B4 71 | 4 | consonant resolution |
| 5 | E2 40 | A4 69 | 5 | dissonant: passing tone, B4→A4→G4 |
| 6 | 40 held | G4 67 | 3 | consonant |
| loop | → 43 | G4 held | 3 → 0 | oblique into the octave |

C1–C3: no two onsets share a perfect `ic`, and no similar motion lands on one. C6: the pair spans up to 29 semitones, past the species limit of 19 — a bass track sits below the keys, so that limit belongs to species work; raise the line to G3 B3 E3 if strict two-voice spacing is wanted. C8–C9: the new line moves by thirds only, never larger than 4 semitones, so nothing needs recovery, and the melody's climax D5 is unique and not its last note.

## Relaxing the rules by style

| Style | Keep | Relax |
|---|---|---|
| pop / rock | report C7 as information — a rock melody may leave non-chord tones unresolved; warn on bass–lead octave parallels across several notes | a root-plus-fifth power-chord track is one timbral line: do not flag its internal fifths, and chord planing in parallel is idiomatic — parallel fifths in rock are practice, not a codified rule |
| folk | independence of melody and bass | drones and pedal basses, modal cadences, octave doubling |
| jazz | guide tones: chords a fifth apart swap the third and seventh, chords a second apart move them in parallel; flag an upper voice leaping more than a third when a step or a common tone was available | the bass leaps freely, the fifth is omitted, extensions stay high |

## Before you send

- C1–C3 pass at every adjacent onset, the loop seam included.
- Every dissonant onset is named by type, with its beat and its resolution.
- Opening, close and cadence match C12; tendency tones match C13 in tonal work.
- The new line fits the instrument's range and does not cross the melody.
- One call per change, no locked track, no clip the operator has open.
- The render numbers are quoted, and you have said which checks you ran and in which mode.

## Leave to the ear

- Whether a line sings, and whether its climax is earned; deliberate repetition and deliberate parallel motion.
- Register and timbre: whether two doubled lines read as one voice in the mix.
- Whether the bass is too busy or too thin for this song.
- Style fit — Palestrina, Bach, chorale, pop or jazz rules: say which you assumed.

## Sources

- Gotham, Gullings, Hamm, Hughes, Jarvis, Lavengood, Peterson, *Open Music Theory* v2 (2023), CC BY-SA 4.0 — viva.pressbooks.pub/openmusictheory (species chapters, 16th-century style, SATB, fugal exposition, jazz voicings, pop texture).
- Shaffer, Hughes, Moseley, *Open Music Theory* v1, CC BY-SA 4.0 — openmusictheory.github.io.
- Knud Jeppesen, *Counterpoint: The Polyphonic Vocal Style of the Sixteenth Century*, trans. Glen Haydon (1939).
- J. J. Fux, *Gradus ad Parnassum* (1725); English *The Study of Counterpoint*, trans. Alfred Mann (1965) — its rules reached this skill through the two Open Music Theory texts, not read directly.
- San Francisco Conservatory of Music theory supplement, "Procedures of Four-Part Writing" (no licence stated; paraphrased only).
- David Temperley, "The Melodic-Harmonic Divorce in Rock", *Popular Music* 26/2 (2007); Allan Moore, *Song Means* (2012) and Nicole Biamonte, both via *Open Music Theory*.