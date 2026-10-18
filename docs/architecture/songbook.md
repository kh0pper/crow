# Songbook Architecture

The songbook is the first blog content type extension, establishing a reusable pattern for future content types (recipes, data visualization, etc.).

## Design Principle

Songs are **blog posts tagged "songbook"** — not a separate entity. This means songs inherit blog features (CRUD, RSS, sharing, visibility, FTS search, export) without duplicating infrastructure.

## Module Map

```
servers/blog/chordpro.js         — ChordPro parser + transpose engine
servers/blog/chord-diagrams.js   — SVG chord diagram generator
servers/blog/songbook-renderer.js — Song page HTML rendering (+ SunVox player widget)
servers/gateway/routes/songbook.js — Public routes (+ /blog/songbook/lib/* engine assets)
servers/gateway/dashboard/panels/songbook.js — Nest panel
skills/songbook.md               — AI skill file
bundles/songbook/web/sunvox/     — Pinned libsunvox JS+WASM player engine (MIT, 2.1.4d)
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

Songs with a `**SunVox:** storage:<key>` meta line additionally get the interactive player:

```
Song page loads (no engine yet — lazy)
  → first Play press → loads /blog/songbook/lib/{sunvox.js,sunvox_lib_loader.js,sunvox.wasm}
  → fetch track bytes via /blog/media/<key> → sv_load_from_memory (WASM, in-browser)
  → transport + A/B loop via sv_play/sv_pause/sv_rewind/sv_get_current_line
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

`**SunVox:** storage:<key>` (parsed by `parseSongMeta().sunvox`) attaches an interactive backing track; `crow_create_song` accepts `sunvox_key` and prepends the line. Only storage-backed keys are supported — the blog CSP's `connect-src 'self'` blocks cross-origin fetches.

## SunVox Player (`renderSunvoxPlayer`)

- **Engine**: libsunvox 2.1.4d JS+WASM (~800KB, MIT) pinned by sha256 in `bundles/songbook/manifest.json` notes; served from `/blog/songbook/lib/*` (whitelisted filenames only), loaded lazily on first Play.
- **CSP**: song pages under `/blog/songbook` get a path-scoped `'wasm-unsafe-eval'` addition to `script-src` in the gateway security-headers middleware — WebAssembly compilation only, never `eval()`/`new Function()`. No other surface gains the directive.
- **Practice model**: autostop off (loops endlessly), A/B loop via `sv_rewind` on an 80ms timer, line position from `sv_get_current_line`.
- **Transposition interplay**: the player does NOT transpose; when `?key=` overrides the chart key, the renderer adds a "Track stays in \<originalKey\>" badge. Per-module `sv_set_module_relnote` transposition is a possible v2.
- **Funnel**: `/blog` is already a public-safe funnel prefix, so the lib route needs no funnel change.

## Routes

Mounted in the gateway **before** the blog's `/:slug` catch-all:

| Route | Description |
|-------|-------------|
| `GET /blog/songbook` | Index page |
| `GET /blog/songbook/lib/:file` | SunVox engine assets (exact-filename whitelist: sunvox.js, sunvox_lib_loader.js, sunvox.wasm; installed-bundle-first resolution) |
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
