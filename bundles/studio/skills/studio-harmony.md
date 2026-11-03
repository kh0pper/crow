---
name: studio-harmony
description: Use when a Studio song needs chords, a progression, a key, an inversion or bass line under a melody, a blues or jazz voicing, or a melody harmonised — and when the key or scale of an existing clip has to be read off its notes.
triggers:
  - chords
  - chord progression
  - what key is this
  - harmonize the melody
  - harmonise this melody
  - bass line
  - blues
  - jazz voicing
  - modulation
  - write a melody
  - acordes
  - progresión
  - tonalidad
  - armonizar la melodía
tools:
  - studio
  - crow-memory
---

# Harmony and melody

Chords and melodies in Studio are pitch lists: every idea here is a set of pitch classes you can turn into `{t, d, p, v}` notes, and every rule is a condition you can test on the note list. Style decides which rules apply: classical function, rock loops, blues and jazz are different grammars, and correcting one with another's grammar is an error.

## Conventions

- pc = `p mod 12`, C = 0. A chord written `{0,4,7}` is semitones above its root; add the root's pc to place it.
- 4/4, bar = 4 beats; bar *n* beat 1 is `t = 4(n−1)`. Strong beats are 1 and 3; beat 4 leads to the next bar.
- Intervals: m2 1, M2 2, m3 3, M3 4, P4 5, TT 6, P5 7, m6 8, M6 9, m7 10, M7 11, P8 12.

## Diatonic chords and functions

Major key, semitones above the tonic:

| Numeral | Triad | Seventh |
|---|---|---|
| I | 0,4,7 | 0,4,7,11 |
| ii | 2,5,9 | 2,5,9,0 |
| iii | 4,7,11 | 4,7,11,2 |
| IV | 5,9,0 | 5,9,0,4 |
| V | 7,11,2 | 7,11,2,5 |
| vi | 9,0,4 | 9,0,4,7 |
| vii° | 11,2,5 | 11,2,5,9 |

Minor key: i 0,3,7 · ii° 2,5,8 · III 3,7,10 · iv 5,8,0 · V 7,11,2 (raised 7) · VI 8,0,3 · VII 10,2,5 · vii° 11,2,5.

| Function | Major | Minor |
|---|---|---|
| Tonic (T) | I, vi, sometimes iii | i, VI |
| Predominant (PD) | IV, ii (often ii6), vi leading on | iv, ii°6, VI |
| Dominant (D) | V, V7, vii°, vii°7 | V, V7, vii°7 |

- The classical phrase is T → PD → D → T. D → PD (V–IV–I) is normal in rock; leave it.
- Root motion is strongest down a fifth; down a third and up a second are common, down a second rare.

## Inversions and bass lines

- Triads: root position, 6 (3rd in the bass), 6/4 (5th in the bass). Sevenths: 7, 6/5 (3rd), 4/3 (5th), 4/2 (7th, which normally falls to a 6 chord).
- Inversions exist to make the bass step. In C: I–V6–vi = 48,47,45; I–V4/3–I6 = 48,50,52. Lament in A minor: i–VII–VI–V = 45,43,41,40.
- 6/4 chords in common practice: cadential (I6/4–V), passing (I–V6/4–I6), pedal (I–IV6/4–I). Pop uses slash chords freely; do not apply the restriction.
- Bass: 28–55 (E1–G3), one note at a time, chord tone on beats 1 and 3, and the one track that lives under 55 — while it plays, pads and voicings start at 55 or above.

## Cadences

| Cadence | Test |
|---|---|
| Perfect authentic | V(7) → I, both root position, top voice on pc 0 |
| Imperfect authentic | V → I otherwise, or vii° → I |
| Half | phrase ends on V (Phrygian half in minor: iv6 → V) |
| Plagal | IV → I; a main cadence in gospel and rock, not only an amen |
| Deceptive | V → vi in major, V → VI in minor |

## Secondary dominants and borrowed chords

- V(7)/X: `{0,4,7}` or `{0,4,7,10}` built 7 semitones above X's root. In C, V7/V = D F♯ A C = 62,66,69,72 → G.
- vii°7/X: `{0,3,6,9}` 11 semitones above X's root. In C, vii°7/V = 66,69,72,75.
- The new accidental is a leading tone: resolve it up 1 semitone, and let the chord run 2–4 beats before X.
- Borrowed from the parallel minor in a major key: iv 5,8,0 · ♭VI 8,0,3 · ♭III 3,7,10 · ♭VII 10,2,5 · Neapolitan ♭II6 = 1,5,8, with pc 5 (4̂) in the bass. iv and ♭VI are commonest; ♭VI–♭VII–I is a cadence.
- Picardy third: major I as the last chord of a minor piece.

## Modulation

- Closely related keys differ by one accidental at most: relative, dominant, subdominant and their relatives; anything else wants a chromatic pivot or a direct cut.
- Pivot: one chord both keys own (C → G: Am is vi in C, ii in G), then the new dominant, then its tonic.
- Direct: start the new key at a section boundary — in Studio a new scene or clip. Changing key mid-clip means transposing every part in the scene; say so before doing it.
- `studio_song_set_meta` stores the key as a label. It transposes nothing; that arithmetic is yours.

## Pop, rock and modal progressions

| Progression | In C / Am | Semitones |
|---|---|---|
| I–V–vi–IV | C G Am F | 0,7,9,5 |
| vi–IV–I–V | Am F C G | 9,5,0,7 |
| I–vi–IV–V | C Am F G | 0,9,5,7 |
| I–IV–V | C F G | 0,5,7 |
| i–♭VI–♭III–♭VII | Am F C G | 0,8,3,10 |
| I–V/7–vi–I/5–IV | C G/B Am C/G F | bass 48,47,45,43,41 |
| i–♭VII–♭VI–V | Am G F E | 0,10,8,7 |
| I–♭VII–IV–I (mixolydian) | C B♭ F C | 0,10,5,0 |
| i–♭VI–♭VII–i (aeolian) | Am F G Am | 0,8,10,0 |
| i–IV (dorian) | Am D | 0,5 |

- ♭VII and ♭VI are major triads on pcs 10 and 8: `{10,2,5}`, `{8,0,3}`.
- Power chords: root + 7 (+12), no third.
- A minor-pentatonic melody over major chords (♭3, ♭7 against a major tonic) is standard rock; do not flag the clash.
- Change harmony at section boundaries, not inside a phrase, unless a turn is asked for.

## Loops versus functional motion

- A 2–4 chord loop has no cadence: home comes from the bass note on bar 1 of the cycle, melody emphasis and groove, not from T–PD–D.
- Interest comes from arrangement, register and melody. Offer a new chord only as contrast: a pre-chorus lift to IV or ii, a bridge to ♭VI.
- Do not add a V–I the loop never had, and do not call a one-chord vamp a broken progression.

## The blues

| Bar | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Basic | I7 | I7 | I7 | I7 | IV7 | IV7 | I7 | I7 | V7 | IV7 | I7 | I7 |
| Quick change | I7 | IV7 | I7 | I7 | IV7 | IV7 | I7 | I7 | V7 | IV7 | I7 | V7 |

- All three chords are dominant sevenths (`{0,4,7,10}`); the ♭7 is colour, not dominant function.
- An older form has V7 in bar 10. Jazz blues: VI7 in 8, ii7–V7 in 9–10, I–VI–ii–V in 11–12. Minor blues: i7 ×4, iv7 ×2, i7 ×2, ♭VI7, V7, i7, i7.
- Scales: blues `{0,3,5,6,7,10}` · major blues `{0,2,3,4,7,9}` · minor pentatonic `{0,3,5,7,10}` · major pentatonic `{0,2,4,7,9}`.
- Blue notes sit between ♭3 and 3. MIDI pitches do not bend: write a grace note 1 semitone below, 0.1–0.25 beats, quieter; call it an approximation.
- Swung eighths at 2:1 place the second eighth at `t + 2/3`, not `t + 0.5`. Say which pairs you swung.

## Jazz essentials

| Symbol | Semitones from root |
|---|---|
| maj7 | 0,4,7,11 |
| 7 | 0,4,7,10 |
| m7 | 0,3,7,10 |
| m7♭5 | 0,3,6,10 |
| dim7 | 0,3,6,9 |
| m(maj7) | 0,3,7,11 |
| 6 / m6 | 0,4,7,9 / 0,3,7,9 |
| 7sus4 | 0,5,7,10 |

9 = +14, 11 = +17, 13 = +21 above the root (pcs +2, +5, +9).

- Tensions: on maj7 use ♯11 (+6), not the natural 11; on a dominant use 9, ♭9, ♯9, ♯11, 13, ♭13 and no natural 11; m7 takes 9 and 11, and 13 only in a dorian context.
- ii–V–I major: Dm7 G7 Cmaj7. Minor: Dm7♭5 G7♭9 Cm6 or Cm7 (Cm(maj7) is rarer).
- Guide tones (3rd and 7th) carry the changes in two voices. In C: Dm7 `53,60` → G7 `53,59` → Cmaj7 `52,59`: one line holds, the other falls a semitone.
- Shell: root + 3rd or 7th, Cmaj7 = 48,59. Rootless A (3–5–7–9): Dm9 = 53,57,60,64. Rootless B (7–9–3–5): Dm9 = 60,64,65,69. G13 as 7–9–3–13 = 53,57,59,64. Alternate A and B through a ii–V–I.
- Drop-2: close Cmaj7 60,64,67,71, drop the second voice from the top an octave → 55,60,64,71. Standard for guitar and horn sections.
- Keep these voicings in 48–72, and 55–72 whenever a bass track plays; lower turns muddy. If the bass holds the root, leave it out of the keys.
- Tritone substitution: replace X7 with the dominant seventh 6 semitones above — G7 → D♭7 = 49,53,56,59. They share the 3rd and 7th (B, F) and give the bass 50,49,48 (D–D♭–C).
- Reharmonisation, most useful first: ii before any dominant; secondary dominants; tritone substitution; a diminished passing chord (Cmaj7 C♯°7 Dm7); a chromatic ii–V a semitone above the target; modal interchange (iv7–♭VII7 backdoor); a pedal; parallel voicings.

## Melody

- Contour: mostly steps; leaps of 5–7 semitones are fine if the next note moves a step the other way. One climax per phrase; the song's highest note belongs in the chorus or bridge.
- Ranges (sounding MIDI, approximate): male lead core 45–64, female lead core 55–72; an untrained audience is comfortable within 12–16 semitones. Choral (varies by source; the same set as `studio-counterpoint`): soprano 60–79, alto 55–74, tenor 48–67, bass 41–62.
- Motif development: repeat, sequence at a new degree, invert, retrograde, augment or diminish (×2, ÷2 in `d`), fragment, extend, or new pitches on the same rhythm. Rhythm is what listeners remember.
- Phrases: 4 or 8 bars from 2-bar subphrases. Period = antecedent on a half cadence (an imperfect authentic one will do) + consequent on an authentic cadence; sentence = 2 + 2 + 4 bars. Odd lengths are a device, not a mistake.
- Tension: non-chord tone on a strong beat, leap, high register, long note on degree 2, 4, 6 or 7, syncopation, faster harmonic rhythm. Release: step to 0, 4 or 3 on a strong beat.
- Chord tones on strong beats: a melody note at `t mod 4` = 0 or 2, or lasting 1 beat or more, is a chord tone or a named tension of the chord sounding then. Passing and neighbour tones go on weak beats, last under 1 beat, move by step.

## Read the key and scale of a clip

1. `studio_get_clip`. Per note: pc, weight `d × v`, doubled when `t mod 4` is 0, tripled for the lowest pc on a downbeat.
2. Sum weights per pc and score each candidate tonic against them (semitones from that tonic): major 0,2,4,5,7,9,11 · natural minor 0,2,3,5,7,8,10 · harmonic minor 0,2,3,5,7,8,11 · mixolydian 0,2,4,5,7,9,10 · dorian 0,2,3,5,7,9,10 · lydian 0,2,4,6,7,9,11 · minor pentatonic 0,3,5,7,10 · blues 0,3,5,6,7,10.
3. Report the fit as a percentage of weighted duration inside the set. On a tie, or a gap under 5 points, break it with tonic evidence: the last note, the longest note, the bass pc on a downbeat. Prefer the smaller set (minor pentatonic, blues) only when it explains the notes as well. Below 85 %, say the clip is chromatic or modulates and do not force a key.
4. Call the clip ambiguous, naming both readings, only when the tonic evidence ties too. The last and longest notes are usually 1, 3 or 5 of the tonic; a clip using all twelve pcs evenly has no key.
5. The song's `key` field is a label a person typed; when it contradicts the notes, say so and offer to correct it.

## Harmonise a melody: procedure

1. `studio_session_summary`, then `studio_get_clip` on the melody and the scene's other clips. Harmonise what is there, not what the description says.
2. Key and scale by the procedure above; if ambiguous, prefer the reading that fits the final note.
3. Split into phrases: a phrase ends at a rest of 1 beat or more, or a note of 2+ beats. Note its last pc and degree.
4. Pick the style from the operator's genre — functional, loop, modal, blues, jazz. It selects which sections above apply.
5. Harmonic rhythm: one chord per bar by default, two if the melody moves in eighths, never under 2 beats, constant within a section.
6. Place cadences first: the last phrase ends on I (or i), the one before on V or IV, half cadences where the melody pauses on 2 or 5. Fill backwards, keeping each root a step or a fifth from the next.
7. Bass: root on beat 1, a chord tone or step on beat 3, 28–55, leaps under 8 semitones. If the bass has to jump, a 6 or 6/4 chord is usually the fix.
8. Pad: 3–4 notes in 48–72 (55–72 while a bass track plays), each voice moving 0–2 semitones from the previous chord, common tones kept, a 3rd or 7th on top.
9. `studio_clip_write` one part per call — bass, then pad, then any rhythm chords. Velocity 70–90, downbeats 8–12 higher.
10. `studio_render` the scene, report LUFS and true peak, run the checks, fix what fails, then report.

## Checks and taste

Test these on the note lists before calling a part finished:

- **Strong beats:** every melody note on beat 1 or 3 is a chord tone, or a non-chord tone you have named as an intended tension; name exceptions by bar and beat.
- **Held notes:** a note 1 beat or longer crossing a chord change is a common tone or resolves by step.
- **Bass:** the lowest sounding pc at each downbeat is a chord tone; the bass is the only track under 55 — while it plays, thin any pad or voicing in that register to root + 5th, and if pad and melody both fill 55–72 move the pad up an octave.
- **Leading tone and seventh:** the leading tone rises 1 semitone, chordal 7ths fall 1 semitone. Skip in loops and modal rock.
- **Parallels:** no parallel P5 or P8 (7 or 12 semitones) between two voices across consecutive chords in a chorale or string texture; in rock and synth stacks they are idiomatic practice, not a codified rule.
- **Range and spacing:** melody inside its voice range, bass 28–55, and no m3 or M3 whose upper note falls below 45 — a heuristic.
- **Never** say a progression "sounds", "resolves" or "feels" like anything. Give the pc sets and the measurement, then ask one question about one bar.

Taste defaults — follow unless told otherwise, and change one at a time:

- One chord per bar; the chorus gets the highest melody note and the simplest harmony.
- Verse melody 55–67, chorus 3–7 semitones higher.
- Stepwise bass and shared tones beat root-position leaps.
- `crow_search_memories` for this operator's stated likes and rejections; save verdicts with `crow_store_memory` — "prefers ♭VII in the verse; no key change before the last chorus".

Studio cannot yet transpose a song, store a chord chart, bend a pitch or play anything but 4/4: write pitches out and say what you did.

## Sources

Gotham et al., *Open Music Theory* v2 (CC BY-SA 4.0) · Mount, *Fundamentals, Function, and Form* (CC BY-NC) · Kostka, Payne & Almén, *Tonal Harmony*, 2018 · Everett, *The Foundations of Rock*, 2009 · Temperley, "The Melodic-Harmonic 'Divorce' in Rock," 2007 · Biamonte, *Music Theory Spectrum* 32/2, 2010 · Tagg, *Everyday Tonality II*, 2014 · Levine, *The Jazz Theory Book*, 1995 · Mulholland & Hojnacki, *The Berklee Book of Jazz Harmony*, 2013 · Huron, *Sweet Anticipation*, 2006.