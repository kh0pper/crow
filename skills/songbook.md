---
name: songbook
description: Personal chord book — ChordPro charts, transposition, chord diagrams, setlists, and music theory
triggers:
  - chord chart
  - song
  - songbook
  - chords
  - transpose
  - setlist
  - chord diagram
  - music theory
  - chordpro
  - lyrics and chords
tools:
  - crow-blog
  - crow-storage
---

# Songbook Skill

## What It Does

Manages a personal chord book built on Crow's blog. Songs are blog posts tagged "songbook" with ChordPro content. Features: ChordPro parsing, auto-transposition, chord diagrams (guitar + piano), audio attachments, interactive SunVox backing tracks, setlists, and peer sharing.

## ChordPro Quick Reference

```
**Key:** Am
**Tempo:** 120
**Capo:** 2
**Artist:** Bob Dylan

{title: To Ramona}
{key: Am}

{start_of_verse: Verse 1}
[Am]Ra[C]mona, [G]come [Am]closer
[F]Shut [C]softly your [Am]watery eyes
{end_of_verse}

{start_of_chorus}
[F]And it's [C]all [Am]right
{end_of_chorus}

{comment: Bridge — slow down}
```

**Directives:** `{title:}` `{subtitle:}` `{key:}` `{tempo:}` `{time:}` `{capo:}`
**Sections:** `{start_of_verse}`/`{end_of_verse}` (or `{sov}`/`{eov}`), chorus (`soc`/`eoc`), bridge (`sob`/`eob`), tab (`sot`/`eot`)
**Inline:** `[Chord]lyrics`, `{comment: text}` or `{c: text}`

## Workflows

### Import a Song

1. User pastes lyrics/chords in any format
2. Convert to ChordPro format:
   - Add `{title:}` and `{key:}` directives
   - Wrap sections in `{start_of_verse}`/`{end_of_verse}` etc.
   - Place chords in `[brackets]` above their syllables
   - Add bold-key metadata: `**Key:**`, `**Artist:**`, `**Tempo:**`
3. Call `crow_create_song` with the ChordPro content
4. Suggest publishing if the user wants it public

### Transpose a Song

1. User asks to transpose (e.g., "transpose to C" or "down two steps")
2. Call `crow_transpose_song` with `id` and `target_key`
3. Show the transposed chart
4. If user wants to save the transposition, edit the post with the new content

### Build a Setlist

1. Call `crow_create_setlist` with a name
2. Add songs with `crow_add_to_setlist` — specify `key_override` if the performer plays in a different key
3. Reorder with `crow_update_setlist` and a `reorder` JSON array
4. View at `/blog/songbook/setlist/:id`

### Get a Chord Diagram

- Call `crow_get_chord_diagram` with the chord name and optional instrument (guitar/piano)
- The diagram is an SVG that can be viewed inline

### Attach a Recording

1. Upload audio via `crow_upload_file` (S3 storage)
2. Create or edit the song with `audio_key` parameter
3. The audio player appears automatically on the song page

### Attach a SunVox Backing Track (interactive practice player)

Songs can carry a SunVox project (`.sunvox`, `.xm`, or `.mod`) that renders as an
interactive player on the song page — transport, volume, and an **A/B section
loop** for practicing a passage. The track loops endlessly until stopped.

1. Upload the project via `crow_upload_file` (S3 storage) with `reference_type: "blog_post"` — the public `/blog/media/` route only serves files referenced by a blog post, so without it the player gets a 404
2. Create the song with `sunvox_key` parameter (or add `**SunVox:** storage:<key>` to the content of an existing song)
3. The player appears automatically; its engine (~800KB WASM) loads lazily on first Play

Notes:
- Backing tracks play in their **recorded key** — the `?key=` transpose control does NOT transpose them. When a key override is active, the song page shows a "Track stays in <key>" badge.
- Need a backing track that doesn't exist yet? The **sunvox-studio** bundle can compose one (`sunvox_compose` → `sunvox_render`), or convert/render `.xm`/`.mod` files.
- Unlike plain audio, the project file stays interactive: tempo-neutral practice loops instead of a fixed recording.

## Music Theory Assistant

When the user has the `songbook_theory_mode` preference enabled (check via `crow_recall_by_context`), offer:

- **Chord substitution suggestions**: When the user asks about alternatives (e.g., "what can I use instead of Dm?"), suggest diatonic substitutions, tritone subs, and modal interchange options
- **Progression identification**: Identify common progressions (ii-V-I, I-vi-IV-V, etc.) in the song
- **Voicing recommendations**: Suggest different voicings for complex chords based on context
- **Arrangement help**: Suggest intros, outros, transitions, key modulations

Always frame theory as suggestions, not corrections. The user's artistic choices take priority.

To toggle: store a memory with `crow_store_memory` — `category: preference`, `content: "songbook_theory_mode: on"` (or "off").

## Sharing Songs

Songs inherit the blog's sharing model:
- **Private** (default) — personal chord book
- **Peers** — share with bandmates via `crow_share_post`
- **Public** — publish to `/blog/songbook/:slug` with full RSS/podcast integration

Songs tagged both "songbook" and "podcast" appear in the podcast feed with audio.

## Tools Reference

| Tool | Purpose |
|------|---------|
| `crow_create_song` | Create song (auto-tags songbook, validates ChordPro) |
| `crow_transpose_song` | Non-destructive transpose to target key |
| `crow_list_songs` | List songs (search, filter by key) |
| `crow_get_chord_diagram` | SVG chord diagram (guitar/piano) |
| `crow_create_setlist` | Create setlist with optional song IDs |
| `crow_add_to_setlist` | Add song with position/key override/notes |
| `crow_remove_from_setlist` | Remove song from setlist |
| `crow_update_setlist` | Update metadata or reorder songs |
| `crow_list_setlists` / `crow_get_setlist` | Read setlists |
| `crow_delete_setlist` | Delete setlist (confirmation required) |
| `crow_delete_post` | Delete song (it's a blog post — same tool) |
| `crow_publish_post` | Publish song to public songbook |
