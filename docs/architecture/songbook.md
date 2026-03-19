# Songbook Architecture

The songbook is the first blog content type extension, establishing a reusable pattern for future content types (recipes, data visualization, etc.).

## Design Principle

Songs are **blog posts tagged "songbook"** — not a separate entity. This means songs inherit blog features (CRUD, RSS, sharing, visibility, FTS search, export) without duplicating infrastructure.

## Module Map

```
servers/blog/chordpro.js         — ChordPro parser + transpose engine
servers/blog/chord-diagrams.js   — SVG chord diagram generator
servers/blog/songbook-renderer.js — Song page HTML rendering
servers/gateway/routes/songbook.js — Public routes
servers/gateway/dashboard/panels/songbook.js — Nest panel
skills/songbook.md               — AI skill file
```

## Content Flow

```
User pastes chords/lyrics
  → AI converts to ChordPro format
  → Stored as blog_posts.content (tagged "songbook")
  → ChordPro parser → AST
  → Transposition engine (if key override via ?key= param)
  → Songbook renderer → HTML (chords-over-lyrics + diagrams + audio)
  → Served at /blog/songbook/:slug
```

## ChordPro Engine (`chordpro.js`)

### AST Structure

```js
{
  meta: { title, subtitle, key, tempo, time, capo },
  sections: [{
    type: "verse" | "chorus" | "bridge" | "tab" | "comment",
    label: "Verse 1",
    lines: [{
      type: "lyric",
      segments: [
        { chord: "Am", lyric: "Ramona, " },
        { chord: "C", lyric: "come " },
        { chord: null, lyric: "closer" }
      ]
    }]
  }]
}
```

### Transposition

- Chromatic scale with sharp canonical form
- Enharmonic mapping follows circle of fifths (flat keys use flats, sharp keys use sharps)
- Slash chord bass notes transpose independently
- `transposeAst(ast, targetKey)` returns a new AST (non-destructive)

### Exports

| Function | Purpose |
|----------|---------|
| `parseChordPro(text)` | Text → AST |
| `renderChordProHtml(ast)` | AST → HTML (chords-over-lyrics) |
| `transposeChord(name, semitones, preferFlats)` | Transpose single chord |
| `transposeAst(ast, targetKey)` | Transpose entire AST |
| `isChordPro(content)` | Detection (directives or 2+ chord patterns) |
| `extractChords(ast)` | Get unique chord names |
| `parseSongMeta(content)` | Bold-key metadata extraction |
| `parseChord(name)` | Parse into root/quality/bass |

## Chord Diagrams (`chord-diagrams.js`)

**Algorithmic-first** with curated overrides (~20 guitar, extensible):

1. Parse chord name → root + quality
2. Look up interval set (major, m7, dim7, sus4, etc.)
3. Check curated overrides for exact match
4. Fall back to algorithmic voicing generation
5. Render as SVG string

Guitar: 5-fret window, 6 strings, finger dots, mute/open markers, barre notation.
Piano: 2-octave keyboard, highlighted active notes.

## Database

Two new tables, no changes to `blog_posts`:

- **`songbook_setlists`** — name, description, visibility, timestamps
- **`songbook_setlist_items`** — setlist_id FK, post_id FK, position, key_override, notes (unique on setlist_id + post_id)

Songs are identified by the "songbook" tag in `blog_posts.tags`.

## Metadata Convention

Song metadata uses the same **bold-key** pattern as podcasts:

```
**Key:** Am
**Tempo:** 120
**Artist:** Bob Dylan
```

`parseSongMeta()` follows the same regex pattern as `parsePodcastMeta()`. When a post is tagged both "songbook" and "podcast", both parsers read the same content without conflict.

## Routes

Mounted in the gateway **before** the blog's `/:slug` catch-all:

| Route | Description |
|-------|-------------|
| `GET /blog/songbook` | Index page |
| `GET /blog/songbook/:slug` | Song page |
| `GET /blog/songbook/:slug?key=G` | Transposed view |
| `GET /blog/songbook/:slug?instrument=piano` | Piano diagrams |
| `GET /blog/songbook/setlist/:id` | Setlist view |

## MCP Tools

10 tools added to the blog server (`servers/blog/server.js`):

- `crow_create_song` — delegates to the same post insert logic
- `crow_transpose_song` — non-destructive read
- `crow_list_songs` — filtered by "songbook" tag
- `crow_get_chord_diagram` — SVG output
- 6 setlist CRUD tools following existing patterns

## Extension Pattern

This establishes the pattern for future blog content types:

1. **Content stored in `blog_posts`** — use tags to identify the type
2. **Type-specific parser** — transforms content from stored format to structured data
3. **Type-specific renderer** — generates HTML from structured data
4. **Dedicated routes** — mounted before the blog catch-all
5. **MCP tools** — added to the blog server, delegate to shared post logic
6. **Dashboard panel** — registered alongside the blog panel
7. **Skill file** — routes user intent to the right tools
