---
name: studio-rhythm-and-form
description: Use when a Studio song needs a groove, a drum part, a step-sequenced or sampler-style pattern, swing, human timing, ghost notes, fills, or a song structure laid out in scenes — and when an existing beat's grid, feel, phrase lengths or section lengths have to be checked.
triggers:
  - drums
  - drum pattern
  - make a beat
  - groove
  - swing
  - humanise the timing
  - ghost notes
  - fill
  - song structure
  - arrange the sections
  - ritmo
  - batería
  - estructura de la canción
  - humanizar
tools:
  - studio
  - crow-memory
---

# Groove, drums and form

Studio's grid is beats, not audio: a bar is 4 beats, a 16th is 0.25 beat, and swing and human feel are written into the note starts themselves. Here are that arithmetic, ten drum archetypes in General MIDI voices with Studio build routes, and a scene layout for a form you can measure section by section.

## Time in Studio's units

| Unit | Beats | Where |
|---|---|---|
| bar | 4 | 4/4 only, in every song |
| 8th | 0.5 | steps 3, 7, 11, 15 (the "&"s) |
| 16th | 0.25 | 16 steps per bar |
| 32nd | 0.125 | trap and drum & bass rolls |
| triplet 8th | 0.333 | 3 per beat |
| triplet 16th | 0.167 | 6 per beat |

- Step *n* → `t = (n − 1) × 0.25`; steps 1, 5, 9, 13 are `t` 0, 1, 2, 3.
- A clip is `length_bars × 4` beats and it loops, so a note must end inside it (`t + d ≤ length`): the loop cuts anything crossing.
- Milliseconds → beats: `ms × bpm ÷ 60000`, so 10 ms is 0.02 beat at 120 bpm. Four bars last `960 ÷ bpm` seconds.
- There is no time-signature or swing control — 3/4: a 3-bar clip (12 beats) holds four bars; 6/8: triplet 8ths at 0.333, two 6/8 bars per clip bar. Say which you did.

## Swing

Swing delays the second note of each pair of subdivisions; notes on the beat never move.

- Ratio `r` = long ÷ short: straight 1:1, triplet 2:1. A percentage *p* is where the second note sits inside the pair, so `r = p ÷ (100 − p)`.
- Write it: the second note of a pair of span *S* starts at `t = S × p ÷ 100`. 8th pair (`S = 1`): 54 → 0.54, 66.7 → 0.667. 16th pair (`S = 0.5`): 54 → 0.27, 58 → 0.29, 66.7 → 0.333.
- Swing only the even subdivisions: the 2nd and 4th 16th of a beat, or the 2nd 8th. With 8th swing the "&" moves from 0.5 to 0.54–0.667.
- One ratio per bar across every part: a swung hat over straight bass 16ths is a flam, not a feel.
- Amount follows tempo: measured jazz ratios reach about 3.5:1 when slow and approach 1:1 when fast, with 2:1 fitting roughly 200 bpm (varies by source; linear scaling is contested). 16th swing of 54–62 % is the usual house and boom-bap range (varies).
- Report the grid and the ratio: "16ths at 58 %, so the second 16th sits at 0.29".

## Syncopation

- Push a chord or kick ahead by 0.25 or 0.5 beat so it lands before a bar line, or tie a note across beat 3.
- Keep an anchor: an onset on beat 1 of the bar (kick or bass) at least every second bar. Syncopation is only heard against that.
- Check: if no onset in two bars falls on `t mod 4 == 0`, the part has no anchor — name the bar and fix it.

## Humanisation

- `t` cannot be negative, so a "pushed" part is really everything else arriving late: kick at 0, snare +5…+15 ms, hats +2…+8 ms, bass with the kick.
- Stay inside 5–20 ms and never past 25 % of the part's shortest interval: at 120 bpm a 32nd is 62 ms, so cap at 15 ms there.
- Randomise ±3 ms around that systematic offset. A groove needs a direction, not noise.
- Velocity: accents 100–120, body 70–90, ghosts 20–45. Hats change by 2–6, never 20 (100/94/98/92 is an accent pattern), and no voice repeats one velocity three times running.

## Ghost notes

- Snare ghosts at v 20–45, on the 16ths that are not the backbeat (steps 3, 7, 11, 15, not 5 and 13). Two or three per bar.
- Hat ghosts at v 20–45 thicken a funk or boom-bap grid without adding events anyone counts.
- Keep them off the kick's steps. Write the backbeat, render, add ghosts, render again, and report the event count before and after.

## Drum archetypes

16 steps per bar; "odd" = steps 1, 3, 5, 7, 9, 11, 13, 15 (straight 8ths).

| Style | bpm | Kick | Snare / clap | Hats | Feel |
|---|---|---|---|---|---|
| Rock | 100–140 | 1, 9 (add 8 or 11) | 38 on 5, 13 | 42 on odd | crash 49 on section starts |
| Pop | 90–130 | 1, 9 | 38 + 39 on 5, 13 | 42 on odd, 16ths in the chorus | dance-pop variant: kick 1, 5, 9, 13 |
| Funk | 90–120 | 1, 4, 7, 11 | 5, 13 + ghosts 3, 10, 15 | 42 on 16ths, accents on odd | accent step 1; ghosts carry it |
| Boom bap | 80–100 | 1, 8, 11 | 5, 13, snare 5–20 ms late | 8ths or 16ths at 58–60 % | sampled, dusty, swung |
| Trap | 130–170 (felt 65–85) | 1, 7, 11 | clap 9 only | 16ths, 32nd and triplet rolls | half-time; sub doubles the kick |
| House | 118–130 | 1, 5, 9, 13 | 39 on 5, 13 | 46 on 3, 7, 11, 15 | 16th swing 54–58 %, 8/16/32-bar phrases |
| Techno | 120–140 | 1, 5, 9, 13 | 9 or 13, sparse | 16ths | motion matters more than the pattern |
| Drum & bass | 160–180 | 1, 11 | 5, 13 | 8ths + ghost 16ths | two-step, ghost snares between |
| Reggae | 60–90 | 9 (one-drop) | 37 with the kick on 9 | 8ths, swung | skank on 3, 7, 11, 15; steppers kick all four |
| Folk | 60–140 | 1, 9 | 5, 13 | 54 on 5, 13 | often no kit: cajón low 1, 9, slap 5, 13 |

Those numbers are General MIDI percussion: 35/36 kick, 37 side stick, 38 snare, 39 clap, 42 closed hat, 44 pedal, 46 open hat, toms 41/43/45/47/48/50, 49/57 crash, 51 ride, 54 tambourine.

## Building drums in Studio

Read `studio_module_types` first: the real controller names and ranges, and a wrong name is refused.

**One DrumSynth track.** Bass, snare and hi-hat voices, each with volume, tone, length and panning controllers; polyphony 4 by default, so hits overlap.
- The pitch that fires each voice is DrumSynth's own map, not General MIDI. Establish the three pitches once — one bar of one pitch per 16th, rendered, named by the operator's ear — and keep that map for the song.
- Three voices only: toms, claps, rides and crashes need another track. There are no choke groups, so an open hat rings through closed ones; keep hats at `d` 0.1–0.2 beat or leave the open hat out.

**One track per voice.** `studio_track_add` per voice: Analog generator for kick, snare and hat (its `Noise` 0–256 with `F.freq`, once `Filter` is set, does the noisy voices; `Release` keeps hits short), Generator for tonal clicks. Every hit of a voice sits on one pitch you choose.
- Costs a track (16 per song) and one clip per voice per scene.
- Buys `gain_db`, `pan`, `mute`, `solo` and a solo render per voice — the only way to balance or measure one drum alone.
- Velocity is the only per-hit level inside a track, and it drives the instrument, not the fader.

Either way: hits 0.1–0.25 beat, nothing crossing the loop point, and a report naming each voice's pitch and track.

## Sampler and groovebox practice

- A clip is a pattern. One bar is 16 steps; two to four bars when the last bar carries a fill.
- Pattern variations are scenes: A, A with one element changed, B, fill. Name them by section ("V1 drums A") and give the operator the launch order.
- Motion must be written, not automated: a longer clip (8 or 16 bars) whose later steps climb, or thin out, is the only movement inside a clip. `studio_track_set_param` changes a track for the whole song, not one scene; say so.
- Studio cannot yet import, chop, slice, time-stretch or repitch a sample, hold choke groups, fire conditional or probability trigs, lock parameters per step, record knob motion or chain patterns into a song. Retrigs are just repeated 32nds, and `studio_render` is the only bounce.

## Forms in scenes

Every section needs its own scene, with its own copies of the clips, so an edit to the first chorus never reaches the second. Prefix names with their order — "01 Intro", "02 Verse 1" — so the grid reads in order. On the timeline, the same clip placed twice is one clip: an edit to it changes both places, so give a section its own copy when it has to differ. Mark each section with `studio_section_add` so the operator sees the form on the ruler.

| Form | Scene order | Bars per section |
|---|---|---|
| Verse–chorus | Intro, V1, PC (pre-chorus), C, V2, PC, C, Bridge, C, Outro | 8 or 16 |
| AABA (32-bar) | A, A, B, A | 8 each |
| Strophic (AAA) | V1, V2, V3 | the same every time |
| 12-bar blues | one scene per chorus, or one 12-bar clip | 12 |
| Through-composed | one scene per cue, no repeats | whatever the cue needs |
| Electronic | Intro, Build, Drop, Breakdown, Build, Drop 2, Outro | 16–32, builds 8–16 |

- Club forms work in 8-bar phrases inside 16- and 32-bar sections, and the 16–32 bars of drums-only intro and outro are what a DJ mixes on.
- Keep a list of which scenes share content and edit them together, or the second chorus drifts from the first.

## Energy and density

Measure each section; never guess. All four figures come from the clips and one render:

| Metric | How |
|---|---|
| Active tracks | tracks holding notes in that scene |
| Notes per bar | notes ÷ clip bars |
| Top-voice pitch | mean of the highest sounding `p` per beat |
| Loudness | `studio_render` with `scene_id`: LUFS and true peak |

- The chorus must beat its verse on at least two of the four. Otherwise it is not bigger, whatever the intention was.
- Every section changes one element from the one before: a layer, a register, a hat rate, a level.
- Keep one element running through every section (a hat, a bass note), so the changes are heard as changes.
- Five main elements at once is a working ceiling: foundation, pad, rhythm, lead, fills (a heuristic).
- A breakdown drops the drums and 2–6 LU with them (a heuristic); the drop brings both back.

## Transitions and fills

- Put the fill in the last bar of the outgoing clip, steps 13–16: extra snare 16ths, a tom run, or the hat doubling from 0.25 to 0.125 in the last beat.
- Rests are transitions too: an empty last beat in every track is stronger than any fill.
- Land the new downbeat with a crash (49 or 57, v 100–120) and a kick on step 1.
- Builds are note-made: there are no risers, so use rising pitch, doubling subdivisions (0.5 → 0.25 → 0.125) and added layers, reversed to break down. A build spanning a scene change needs its own scene.

## Checks

Test these on the note lists and renders before calling a groove finished:

- Every note ends inside its clip: `t + d ≤ length_bars × 4`.
- Section lengths are multiples of 4 bars (8 for club); 12-bar blues, odd-bar folk and 3/4 sections are the named exceptions, and you say so.
- Clips in one scene share a bar length, or lengths whose least common multiple fits the section; otherwise they realign late and the fill lands wrong.
- Every fill sits in a section's last bar.
- Step 1 of bar 1 carries a kick, a bass note, or a rest you can name.
- One ratio and one grid across all parts; no straight 8ths against swung 16ths.
- Velocities vary between neighbours, ghosts stay 20–45, and nothing sits at 127 by accident.
- Offsets stay under 25 % of the shortest interval, and no note starts before `t` 0.
- Each section has its own render and LUFS, and the chorus figure is at least the verse figure.

## Taste defaults

- Kick and bass share the downbeat; that is what makes a groove readable.
- Double the hat rate between verse and chorus before adding a new part.
- One fill per section, in its last bar. A bar of fills in every section reads as a nervous tic.
- Prefer 2-bar patterns inside 4-bar phrases, and 8-bar sections for anything sung.
- A part with a rest in it is easier to add to than a full one.
- Ask which tradition is meant when a request could be funk or boom bap, rock or pop-punk: one step and 10 ms separate them.
- Save what the operator decides — swing amount, hat density, whether they want trap rolls — with `crow_store_memory`, and `crow_search_memories` before the next session's first beat.

Chords and keys: `studio-harmony`. Levels and loudness targets: `studio-mixing`.

## Sources

General MIDI 1 percussion map (MIDI Association) · SunVox module catalogue (Zolotov, WarmPlace.ru), read through `studio_module_types` · Gotham et al., *Open Music Theory* v2, viva.pressbooks.pub/openmusictheory (CC BY-SA 4.0) · London, *Hearing in Time*, 2012 · Butler, *Unlocking the Groove*, 2006 · Snoman, *The Dance Music Manual*, 2019 · Friberg & Sundström, "Swing Ratios and Ensemble Timing in Jazz Performance," *Music Perception* 19/3, 2002 · Honing & de Haas, "Swing Once More," *Music Perception* 25/5, 2008 · Covach, "Form in Rock Music," 2005 · Owsinski, *The Mixing Engineer's Handbook*, 2022.