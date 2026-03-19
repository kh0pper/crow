# Songbook

The Songbook is a personal chord book built into Crow's blog. Store chord charts in ChordPro format, transpose to any key, view chord diagrams for guitar and piano, attach recordings, build setlists, and share with bandmates.

## Quick Start

Tell your AI assistant:

> "Add 'Alone Again Naturally' to my songbook in the key of D"

The AI will:
1. Format the song in ChordPro notation
2. Create a songbook entry with the chord chart
3. You can view it at `/blog/songbook/alone-again-naturally`

## ChordPro Format

Songs are stored in [ChordPro](https://www.chordpro.org/) format — the industry standard for chord charts. Chords are placed in square brackets before the syllable they accompany:

```
{title: To Ramona}
{key: Am}

{start_of_verse: Verse 1}
[Am]Ra[C]mona, [G]come [Am]closer
[F]Shut [C]softly your [Am]watery eyes
{end_of_verse}
```

### Metadata

Add song metadata using bold-key headers at the top of the content:

```
**Key:** Am
**Tempo:** 120
**Time:** 3/4
**Capo:** 2
**Artist:** Bob Dylan
**Album:** Another Side of Bob Dylan
**Audio:** storage:songs/ramona.mp3
```

### Supported Directives

| Directive | Short Form | Purpose |
|-----------|-----------|---------|
| `{title: text}` | `{t: text}` | Song title |
| `{subtitle: text}` | `{st: text}` | Artist/subtitle |
| `{key: Am}` | — | Musical key |
| `{tempo: 120}` | — | BPM |
| `{time: 3/4}` | — | Time signature |
| `{capo: 2}` | — | Capo position |
| `{start_of_verse}` | `{sov}` | Begin verse section |
| `{end_of_verse}` | `{eov}` | End verse section |
| `{start_of_chorus}` | `{soc}` | Begin chorus |
| `{end_of_chorus}` | `{eoc}` | End chorus |
| `{start_of_bridge}` | `{sob}` | Begin bridge |
| `{end_of_bridge}` | `{eob}` | End bridge |
| `{start_of_tab}` | `{sot}` | Begin tab section |
| `{end_of_tab}` | `{eot}` | End tab section |
| `{comment: text}` | `{c: text}` | Performance note |

## Transposition

Every song page includes a transpose bar with all 12 keys. Click a key to instantly transpose:

```
/blog/songbook/alone-again-naturally?key=C
```

The transposition engine follows music theory conventions:
- Flat keys (F, Bb, Eb, Ab, Db, Gb) use flat note names
- Sharp keys (G, D, A, E, B, F#) use sharp note names
- Slash chord bass notes transpose with the target key's preference

## Chord Diagrams

Song pages display chord voicing diagrams for every chord in the song. Toggle between guitar and piano:

```
/blog/songbook/my-song?instrument=piano
```

Diagrams are generated algorithmically with curated overrides for common chords. Unrecognized chords display the name without a diagram.

## Audio

Attach recordings to songs by uploading audio to Crow's storage. The song page renders an HTML5 audio player with a download button.

Songs tagged both `songbook` and `podcast` appear in your podcast RSS feed.

## Setlists

Organize songs into ordered setlists with per-song key overrides:

> "Create a setlist called 'Friday Night' with Autumn Leaves in Gm and All The Things You Are in Ab"

Setlists are viewable at `/blog/songbook/setlist/:id` with a print-friendly layout.

## Sharing

Songs use the same visibility model as blog posts:

| Level | How | Use Case |
|-------|-----|----------|
| Private | Default | Personal chord book |
| Peers | `crow_share_post` | Share with bandmates |
| Public | Publish | Public songbook + RSS |

## Music Theory Mode

Enable the theory assistant for chord suggestions and progression analysis:

> "Turn on music theory mode"

The AI will then offer:
- Chord substitution suggestions
- Progression identification (ii-V-I, etc.)
- Voicing recommendations
- Arrangement ideas

## MCP Tools

| Tool | Description |
|------|-------------|
| `crow_create_song` | Create song (validates ChordPro, auto-tags songbook) |
| `crow_transpose_song` | Non-destructive transpose to any key |
| `crow_list_songs` | List songs with search and key filter |
| `crow_get_chord_diagram` | SVG chord diagram for any chord |
| `crow_create_setlist` | Create setlist with song IDs |
| `crow_add_to_setlist` | Add song with key override |
| `crow_remove_from_setlist` | Remove song from setlist |
| `crow_update_setlist` | Update or reorder setlist |
| `crow_list_setlists` | List all setlists |
| `crow_get_setlist` | Get setlist with songs |
| `crow_delete_setlist` | Delete setlist |

Songs are deleted with the standard `crow_delete_post` tool.

## Crow's Nest

The Songbook panel in the Crow's Nest provides a visual interface for managing songs and setlists at `/dashboard/songbook`.
