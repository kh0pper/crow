# Crow Songbook Extension — Design Spec

**Date:** 2026-03-19
**Status:** Draft
**Author:** Kevin + Claude

## Problem

Musicians need a personal chord book — a "realbook" or "fakebook" they can build over time, transpose to their keys, attach recordings to, and share with collaborators. Existing solutions (Ultimate Guitar, chord sites) are ad-supported, non-portable, and don't support private sharing or self-publishing.

Crow already has a blog (markdown posts, RSS, podcast support, themes) and P2P sharing (Hyperswarm, Nostr). The songbook extension combines these into a self-hosted music platform: chord charts, transposition, audio publishing, and peer collaboration — all through the existing blog infrastructure.

This is also the **first blog content type extension**, establishing a reusable pattern for future content types (recipes, data visualization, etc.).

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage format | ChordPro | Industry standard, enables programmatic transposition |
| Architecture | Blog-integrated | Songs are blog posts tagged "songbook". Reuses blog CRUD, RSS, sharing, visibility |
| Chord diagrams | Guitar + Piano SVG | Multi-instrument, zero dependencies, renders server-side |
| Audio | Storage server + embedded player | Reuses existing S3/MinIO upload. HTML5 audio with waveform |
| Distribution | Podcast RSS reuse | Songs tagged "podcast,songbook" auto-appear in podcast feed |
| Comments | Descoped to follow-up | Blog comments are a shared feature affecting all post types; needs own spec |
| AI assistant | Full music theory, toggleable | Import/transpose/suggest by default, can disable suggestions via crow memory preference |
| Visual design | Extends existing blog design tokens | Songbook adds scoped CSS variables for chord/audio colors; inherits DM Sans/Fraunces/JetBrains Mono from blog |
| Deployment | Core code (not installable add-on) | Ships with Crow like podcast does. Registry entry is informational for discovery. |

## Architecture

### Content Flow

```
User pastes chords/lyrics
  → AI converts to ChordPro format
  → Stored as blog_posts.content (tagged "songbook")
  → ChordPro parser → AST
  → Transposition engine (if key override)
  → Songbook renderer → HTML (chords-over-lyrics + diagrams + audio player)
  → Served at /blog/songbook/:slug
```

### Sharing Model

| Level | Mechanism | Use Case |
|-------|-----------|----------|
| Private | blog_posts.status = 'draft' | Personal chord book |
| Peers | blog_posts.visibility = 'peers' + crow_share_post | Share sketches with bandmates |
| Public | blog_posts.visibility = 'public' + publish | Blog page + podcast feed + downloads |

### Database Changes

**`songbook_setlists`** — Setlist containers (name, description, visibility)

```sql
CREATE TABLE IF NOT EXISTS songbook_setlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  visibility TEXT DEFAULT 'private',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**`songbook_setlist_items`** — Songs in setlists with ordering and per-song key overrides

```sql
CREATE TABLE IF NOT EXISTS songbook_setlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setlist_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  key_override TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (setlist_id) REFERENCES songbook_setlists(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_setlist_items_unique
  ON songbook_setlist_items(setlist_id, post_id);
```

No new columns on `blog_posts`. Songs identified by tag "songbook". ChordPro content in existing `content` column.

### Song Metadata Convention

Song metadata is stored in the content body using the same bold-key pattern as podcasts (`parsePodcastMeta` in `servers/blog/podcast-rss.js`). The songbook parser reuses this same function — it does **not** create a second parser. Songbook-specific fields that `parsePodcastMeta` ignores are extracted by a thin wrapper:

```
**Audio:** https://storage.example.com/songs/ramona.mp3
**Duration:** 3:45
**Key:** Am
**Tempo:** 120
**Time:** 4/4
**Capo:** 2
**Tuning:** Standard
**Artist:** Bob Dylan
**Album:** Another Side of Bob Dylan

{title: To Ramona}
{subtitle: Bob Dylan}

[Am]Ra[C]mona, [G]come [Am]closer...
```

Fields shared with podcast (`Audio`, `Duration`): parsed by `parsePodcastMeta`.
Fields songbook-only (`Key`, `Tempo`, `Time`, `Capo`, `Tuning`, `Artist`, `Album`): parsed by `parseSongMeta()` which follows the same regex pattern.

When a post is tagged both "songbook" and "podcast", both parsers read from the same content — no conflict. `parsePodcastMeta` extracts audio/duration/episode, `parseSongMeta` extracts key/tempo/capo.

### Reserved Slug

The slug `songbook` is reserved for the songbook index route. The `generateSlug()` function in `servers/blog/renderer.js` must prevent creating posts with this slug (append a suffix if generated).

## ChordPro Parser (`servers/blog/chordpro.js`)

### Supported Directives

**Metadata:** `{title}`, `{subtitle}`, `{key}`, `{tempo}`, `{time}`, `{capo}` (with short forms: `{t:}`, `{st:}`)

**Sections:** `{start_of_verse}`/`{end_of_verse}`, `{start_of_chorus}`/`{end_of_chorus}`, `{start_of_bridge}`/`{end_of_bridge}`, `{start_of_tab}`/`{end_of_tab}` (with short forms: `{sov}`/`{eov}`, `{soc}`/`{eoc}`, `{sob}`/`{eob}`, `{sot}`/`{eot}`)

**Inline:** `{comment: text}` / `{c: text}`, `[Chord]lyric` notation

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

### Transposition Engine

- Note array: `C, C#, D, D#, E, F, F#, G, G#, A, A#, B`
- Enharmonic mapping: `Db↔C#, Eb↔D#, Gb↔F#, Ab↔G#, Bb↔A#`
- Sharp/flat preference follows circle of fifths: flat keys (F, Bb, Eb, Ab, Db, Gb) use flats; sharp keys (G, D, A, E, B, F#) use sharps
- Parse chord: `Am7/G → { root: "A", quality: "m7", bass: "G" }` — transpose root and bass independently, both following the target key's sharp/flat preference
- Exported: `transposeChord(name, semitones, preferFlats)`, `transposeAst(ast, targetKey)`

### Detection

`isChordPro(content)` — returns true if content contains ChordPro directives or multiple `[Chord]lyric` patterns. Used by the renderer to route through ChordPro vs standard markdown.

## Chord Diagrams (`servers/blog/chord-diagrams.js`)

### Approach: Algorithmic-First with Curated Overrides

The primary chord diagram generation is **algorithmic** — given a root note and quality (major, minor, 7, m7, maj7, dim, aug, sus2, sus4, m7b5, 7b9, etc.), compute a standard voicing. A hand-authored library of ~20-30 curated overrides provides better fingerings for chords where the algorithm would produce awkward voicings (e.g., F barre vs simplified F, common jazz voicings).

```js
// Curated overrides (preferred voicings)
const GUITAR_OVERRIDES = {
  "C":      [[-1, 3, 2, 0, 1, 0]],
  "F":      [[1, 1, 2, 3, 3, 1]],   // barre form
  "F#m7b5": [[2, -1, 2, 2, 1, -1]],
  // ~20-30 total
};

// Algorithmic generation for everything else
function generateGuitarVoicing(root, quality) { ... }
function generatePianoVoicing(root, quality) { ... }
```

### SVG Generation

- **Guitar:** 5-fret window, 6 strings, circles for fingers, X/O for muted/open, barre notation, fret number when not at nut
- **Piano:** 2-octave keyboard segment, highlighted keys
- Colors: use existing blog design tokens where possible, add scoped `--songbook-chord-color: #2997ff` and `--songbook-audio-color: #30d158`
- No external dependencies — pure SVG string generation

### Fallback

Unrecognized chords display the chord name without a diagram rather than erroring.

## MCP Tools (10 new, added to `servers/blog/server.js`)

`crow_create_song` delegates to the same internal insert logic as `crow_create_post` (slug generation via `generateSlug()`, excerpt via `generateExcerpt()`, author fallback from blog settings). It does **not** reimplement post creation — it wraps the shared codepath and adds "songbook" to tags + ChordPro validation.

Songs are deleted via the existing `crow_delete_post` tool (no separate `crow_delete_song` needed).

| Tool | Params | Description |
|------|--------|-------------|
| `crow_create_song` | title, content, key?, artist?, tags?, audio_key?, visibility? | Create song post (auto-tags "songbook", validates ChordPro, delegates to shared post insert) |
| `crow_transpose_song` | id, target_key | Returns transposed ChordPro (non-destructive read) |
| `crow_list_songs` | search?, key?, limit? | List songbook posts |
| `crow_get_chord_diagram` | chord, instrument? | Returns SVG diagram |
| `crow_create_setlist` | name, description?, song_ids?, visibility? | Create setlist |
| `crow_add_to_setlist` | setlist_id, post_id, position?, key_override?, notes? | Add a song to a setlist |
| `crow_remove_from_setlist` | setlist_id, post_id | Remove a song from a setlist |
| `crow_update_setlist` | id, name?, description?, visibility?, reorder? (JSON array of {post_id, position, key_override?}) | Update setlist metadata or reorder songs |
| `crow_list_setlists` | limit? | List setlists |
| `crow_get_setlist` | id | Get setlist with songs |
| `crow_delete_setlist` | id, confirm | Delete setlist (requires confirmation token, following `crow_delete_post` pattern) |

## Routes (`servers/gateway/routes/songbook.js`)

| Route | Description |
|-------|-------------|
| `GET /blog/songbook` | Index page — all published songbook posts, filterable by tag |
| `GET /blog/songbook/:slug` | Song page — ChordPro rendered with diagrams, transpose UI, audio player |
| `GET /blog/songbook/:slug?key=G` | Transposed view |
| `GET /blog/songbook/:slug?instrument=piano` | Piano diagrams |
| `GET /blog/songbook/setlist/:id` | Setlist view — ordered songs with key overrides, print-friendly |

Mounted in gateway before the `/blog/:slug` catch-all.

## Nest Dashboard Panel (`servers/gateway/dashboard/panels/songbook.js`)

**Song list view (default):**
- Stat cards: Total songs, Published, Setlists
- Song table with key, artist, status, actions
- "Add Song" form with ChordPro textarea and live preview

**Setlist manager (`?view=setlists`):**
- List setlists with song counts
- Create/edit form with song ordering and per-song key overrides

## Visual Design

Extends existing blog design tokens from `servers/gateway/dashboard/shared/design-tokens.js`. Songbook-specific colors are scoped CSS variables applied only within songbook routes/panel:

| Element | Value | Source |
|---------|-------|--------|
| Background | Inherited from blog theme | `design-tokens.js` |
| Text | Inherited from blog theme | `design-tokens.js` |
| Heading font | Fraunces (inherited) | `design-tokens.js` |
| Body font | DM Sans (inherited) | `design-tokens.js` |
| Chord font | JetBrains Mono | `design-tokens.js` (already used for code) |
| Chord color | `--songbook-chord-color: #2997ff` | New scoped variable |
| Audio/playback | `--songbook-audio-color: #30d158` | New scoped variable |
| Cards | Frosted glass (`backdrop-filter: blur(20px)`) | Songbook-specific enhancement |
| Buttons | Pill shape (`border-radius: 100px`), segmented controls | Songbook-specific enhancement |

### Mobile Responsive

Chord charts must work on phone screens (common use case — phone on music stand). Key responsive behaviors:
- Chord-over-lyric lines wrap gracefully with chords staying aligned
- Transpose control collapses to dropdown on narrow screens
- Chord diagrams scroll horizontally when too many for viewport
- Font sizes scale down for narrow viewports

### Print CSS (`@media print`)
- White background, black text
- Remove nav, transpose controls, audio player
- Bold chord names, optimized font size
- Page breaks between songs in setlists

## Skill File (`skills/songbook.md`)

Triggers: chord chart, song, songbook, chords, transpose, setlist, chord diagram, music theory

Content:
- ChordPro format quick reference
- Import workflow (paste → AI converts to ChordPro)
- Transposition workflow
- Setlist building workflow
- Music theory assistant (toggleable via crow memory preference `songbook_theory_mode`):
  - Chord substitution suggestions
  - Progression identification (ii-V-I, etc.)
  - Voicing recommendations
  - Arrangement help

## Add-on Registry

The songbook ships as core code (like the podcast system), not as an installable/removable add-on. The registry entry is informational — it enables discovery in the Extensions panel but does not trigger install/uninstall lifecycle.

```json
{
  "id": "songbook",
  "name": "Songbook",
  "type": "skill",
  "version": "1.0.0",
  "category": "media",
  "tags": ["music", "chords", "guitar", "piano", "songbook", "chordpro"],
  "icon": "music",
  "notes": "Core extension. Songs are blog posts tagged 'songbook' with ChordPro content."
}
```

## Blog Comments — Descoped

Blog comments (peer-only via Nostr) are descoped to a separate follow-up spec. Comments are a shared blog feature affecting all post types and require:
- Nostr event listener integration with the gateway
- Moderation model (auto-approve rules, manual approval)
- Comment rendering on public pages
- Comment notification flow

The `blog_comments` table schema (above) is included in this build for forward-compatibility, but tools, routes, and UI will be implemented in the comments spec.

## Build Sequence

1. **ChordPro engine** — parser, AST, transpose, detection (`chordpro.js`)
2. **Chord diagrams** — algorithmic generator + curated overrides, SVG generators (`chord-diagrams.js`)
3. **Database** — setlists tables + blog_comments table stub (`init-db.js`)
4. **MCP tools** — 10 songbook tools in blog server (`server.js`)
5. **Songbook renderer** — HTML output with diagrams, transpose UI, audio player (`songbook-renderer.js`)
6. **Public routes** — songbook pages + setlist view (`routes/songbook.js`)
7. **Dashboard panel** — song management + setlist builder (`panels/songbook.js`)
8. **AI skill** — `skills/songbook.md` + superpowers trigger
9. **Registry + docs** — add-on entry, CLAUDE.md, VitePress docs

## Files to Create

| File | Purpose |
|------|---------|
| `servers/blog/chordpro.js` | ChordPro parser + transpose engine |
| `servers/blog/chord-diagrams.js` | SVG chord diagram generator + voicing library |
| `servers/blog/songbook-renderer.js` | Songbook HTML rendering (wraps parser + diagrams + audio + transpose UI) |
| `servers/gateway/routes/songbook.js` | Public songbook routes |
| `servers/gateway/dashboard/panels/songbook.js` | Nest panel |
| `skills/songbook.md` | AI skill file |

## Files to Modify

| File | Change |
|------|--------|
| `servers/blog/server.js` | Add 10 songbook MCP tools (delegating to shared post insert logic) |
| `servers/blog/renderer.js` | Add "songbook" to reserved slugs in `generateSlug()` |
| `scripts/init-db.js` | Add songbook_setlists, songbook_setlist_items, blog_comments tables |
| `servers/gateway/index.js` | Mount songbook router before `/blog/:slug` catch-all |
| `servers/gateway/dashboard/index.js` | Register songbook panel |
| `servers/gateway/tool-manifests.js` | Add songbook tools to blog category |
| `registry/add-ons.json` | Add songbook add-on entry |
| `skills/superpowers.md` | Add songbook trigger row |
| `CLAUDE.md` | Add songbook to Skills Reference |

## Verification

1. **Parser test:** Parse sample ChordPro text, verify AST structure, verify round-trip (parse → render → visually correct)
2. **Transpose test:** Transpose "Alone Again Naturally" from D to C — verify all chords shift correctly (Dmaj7→Cmaj7, F#m7→Em7, etc.)
3. **MCP tools:** Start blog server (`node servers/blog/index.js`), call `crow_create_song` with ChordPro content, verify post created with "songbook" tag
4. **Routes:** Start gateway (`npm run gateway`), visit `/blog/songbook` — verify index page renders. Visit a song page — verify chord chart, diagrams, transpose control
5. **Transpose via URL:** Visit `/blog/songbook/alone-again-naturally?key=C` — verify all chords transposed
6. **Audio player:** Upload audio via storage, create song with audio_key, verify embedded player on song page
7. **Setlist:** Create setlist via MCP tool, visit `/blog/songbook/setlist/:id`, verify ordered songs with key overrides
8. **Print:** Use browser Print (Ctrl+P) on song page — verify clean output without chrome
9. **Mobile:** Open song page on phone-width viewport, verify chord chart readability and responsive controls
10. **Skill:** Start a Claude session, say "add To Ramona to my songbook" — verify skill activates and creates the song
