/**
 * ChordPro Engine — Parser, AST, Transposition, Detection, HTML Rendering
 *
 * Parses ChordPro-formatted text into an AST, transposes chords,
 * and renders chords-over-lyrics HTML.
 */

// Chromatic scale (sharps canonical)
const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Enharmonic mappings: flat → sharp
const FLAT_TO_SHARP = { Db: "C#", Eb: "D#", Fb: "E", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B" };
const SHARP_TO_FLAT = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };

// Keys that prefer flats (circle of fifths)
const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb",
  "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm"]);

// Directive aliases
const META_ALIASES = {
  t: "title", title: "title",
  st: "subtitle", subtitle: "subtitle",
  key: "key", tempo: "tempo", time: "time", capo: "capo",
};

const SECTION_START = {
  start_of_verse: "verse", sov: "verse",
  start_of_chorus: "chorus", soc: "chorus",
  start_of_bridge: "bridge", sob: "bridge",
  start_of_tab: "tab", sot: "tab",
};

const SECTION_END = new Set([
  "end_of_verse", "eov", "end_of_chorus", "eoc",
  "end_of_bridge", "eob", "end_of_tab", "eot",
]);

/**
 * Parse a chord name into components.
 * @param {string} name - e.g. "Am7/G", "F#m7b5", "Cdim7"
 * @returns {{ root: string, quality: string, bass: string|null } | null}
 */
export function parseChord(name) {
  if (!name || !name.trim()) return null;
  const m = name.match(/^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/);
  if (!m) return null;
  return { root: m[1], quality: m[2] || "", bass: m[3] || null };
}

/**
 * Normalize a note name to sharp canonical form.
 */
function toSharpIndex(note) {
  const sharp = FLAT_TO_SHARP[note] || note;
  return SHARPS.indexOf(sharp);
}

/**
 * Transpose a single note by semitones.
 * @param {string} note - Root note (e.g. "A", "Bb", "F#")
 * @param {number} semitones
 * @param {boolean} preferFlats
 * @returns {string}
 */
function transposeNote(note, semitones, preferFlats) {
  const idx = toSharpIndex(note);
  if (idx === -1) return note;
  const newIdx = ((idx + semitones) % 12 + 12) % 12;
  const sharpName = SHARPS[newIdx];
  if (preferFlats && SHARP_TO_FLAT[sharpName]) {
    return SHARP_TO_FLAT[sharpName];
  }
  return sharpName;
}

/**
 * Determine if a key prefers flats.
 */
function keyPrefersFlats(key) {
  if (!key) return false;
  return FLAT_KEYS.has(key);
}

/**
 * Transpose a chord name by semitones.
 * @param {string} name - Full chord name (e.g. "Am7/G")
 * @param {number} semitones - Half steps to transpose
 * @param {boolean} [preferFlats] - Use flats instead of sharps
 * @returns {string}
 */
export function transposeChord(name, semitones, preferFlats = false) {
  const parsed = parseChord(name);
  if (!parsed) return name;
  const newRoot = transposeNote(parsed.root, semitones, preferFlats);
  const newBass = parsed.bass ? transposeNote(parsed.bass, semitones, preferFlats) : null;
  return newRoot + parsed.quality + (newBass ? `/${newBass}` : "");
}

/**
 * Calculate semitone distance from one key to another.
 */
function semitoneDiff(fromKey, toKey) {
  // Strip minor suffix for note comparison
  const fromNote = fromKey.replace(/m$/, "");
  const toNote = toKey.replace(/m$/, "");
  const fromIdx = toSharpIndex(fromNote);
  const toIdx = toSharpIndex(toNote);
  if (fromIdx === -1 || toIdx === -1) return 0;
  return ((toIdx - fromIdx) % 12 + 12) % 12;
}

/**
 * Parse ChordPro text into an AST.
 * @param {string} text - ChordPro-formatted text
 * @returns {{ meta: object, sections: Array }}
 */
export function parseChordPro(text) {
  if (!text) return { meta: {}, sections: [] };

  const meta = {};
  const sections = [];
  let currentSection = null;

  // Strip metadata block (bold-key lines at top, e.g. **Key:** Am)
  const lines = text.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip bold-key metadata lines (podcast/songbook meta)
    if (trimmed.match(/^\*\*\w+:\*\*\s*.+/)) continue;

    // Empty line
    if (!trimmed) {
      if (currentSection && currentSection.lines.length > 0) {
        // Add empty line marker for spacing
        currentSection.lines.push({ type: "empty" });
      }
      continue;
    }

    // Directive: {directive} or {directive: value}
    const directiveMatch = trimmed.match(/^\{([^}]+)\}$/);
    if (directiveMatch) {
      const inner = directiveMatch[1].trim();
      const colonIdx = inner.indexOf(":");
      let directive, value;
      if (colonIdx !== -1) {
        directive = inner.slice(0, colonIdx).trim().toLowerCase();
        value = inner.slice(colonIdx + 1).trim();
      } else {
        directive = inner.toLowerCase();
        value = "";
      }

      // Meta directives
      if (META_ALIASES[directive]) {
        meta[META_ALIASES[directive]] = value;
        continue;
      }

      // Section start
      if (SECTION_START[directive]) {
        currentSection = {
          type: SECTION_START[directive],
          label: value || SECTION_START[directive].charAt(0).toUpperCase() + SECTION_START[directive].slice(1),
          lines: [],
        };
        sections.push(currentSection);
        continue;
      }

      // Section end
      if (SECTION_END.has(directive)) {
        currentSection = null;
        continue;
      }

      // Comment directive
      if (directive === "comment" || directive === "c") {
        const commentSection = { type: "comment", label: value, lines: [] };
        if (currentSection) {
          currentSection.lines.push({ type: "comment", text: value });
        } else {
          sections.push(commentSection);
        }
        continue;
      }

      continue;
    }

    // Lyric line with optional [Chord] markers
    if (!currentSection) {
      currentSection = { type: "verse", label: "", lines: [] };
      sections.push(currentSection);
    }

    const segments = parseLyricLine(trimmed);
    currentSection.lines.push({ type: "lyric", segments });
  }

  return { meta, sections };
}

/**
 * Parse a single lyric line into chord/lyric segments.
 * "[Am]Ramona, [C]come [G]closer" → [{ chord: "Am", lyric: "Ramona, " }, ...]
 */
function parseLyricLine(line) {
  const segments = [];
  const regex = /\[([^\]]+)\]/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(line)) !== null) {
    // Text before this chord (attach to previous segment if exists)
    if (match.index > lastIndex && segments.length > 0) {
      segments[segments.length - 1].lyric += line.slice(lastIndex, match.index);
    } else if (match.index > lastIndex) {
      segments.push({ chord: null, lyric: line.slice(lastIndex, match.index) });
    }

    segments.push({ chord: match[1], lyric: "" });
    lastIndex = regex.lastIndex;
  }

  // Remaining text
  if (lastIndex < line.length) {
    if (segments.length > 0) {
      segments[segments.length - 1].lyric += line.slice(lastIndex);
    } else {
      segments.push({ chord: null, lyric: line.slice(lastIndex) });
    }
  }

  // If no chords found, return the whole line as a single segment
  if (segments.length === 0) {
    segments.push({ chord: null, lyric: line });
  }

  return segments;
}

/**
 * Transpose an entire AST to a target key.
 * @param {{ meta: object, sections: Array }} ast
 * @param {string} targetKey - e.g. "C", "Am", "Bb"
 * @returns {{ meta: object, sections: Array }} New AST with transposed chords
 */
export function transposeAst(ast, targetKey) {
  const fromKey = ast.meta.key;
  if (!fromKey || !targetKey) return ast;

  const semitones = semitoneDiff(fromKey, targetKey);
  if (semitones === 0) return ast;

  const flats = keyPrefersFlats(targetKey);

  const newSections = ast.sections.map((section) => ({
    ...section,
    lines: section.lines.map((line) => {
      if (line.type !== "lyric") return line;
      return {
        ...line,
        segments: line.segments.map((seg) => ({
          chord: seg.chord ? transposeChord(seg.chord, semitones, flats) : null,
          lyric: seg.lyric,
        })),
      };
    }),
  }));

  return {
    meta: { ...ast.meta, key: targetKey },
    sections: newSections,
  };
}

/**
 * Detect if content is in ChordPro format.
 * @param {string} content
 * @returns {boolean}
 */
export function isChordPro(content) {
  if (!content) return false;
  // Check for ChordPro directives
  if (/\{(title|t|subtitle|st|key|tempo|capo|start_of_|sov|soc|sob|sot|comment|c)\b/i.test(content)) {
    return true;
  }
  // Check for multiple [Chord]lyric patterns (at least 2)
  const chordMatches = content.match(/\[[A-G][#b]?[^\]]*\]/g);
  return chordMatches !== null && chordMatches.length >= 2;
}

/**
 * Render AST to chords-over-lyrics HTML.
 * @param {{ meta: object, sections: Array }} ast
 * @param {object} [options]
 * @returns {string} HTML string
 */
export function renderChordProHtml(ast, options = {}) {
  const parts = [];

  for (const section of ast.sections) {
    if (section.type === "comment") {
      parts.push(`<div class="song-comment">${escapeHtml(section.label)}</div>`);
      continue;
    }

    if (section.label) {
      parts.push(`<div class="section-heading">${escapeHtml(section.label)}</div>`);
    }

    for (const line of section.lines) {
      if (line.type === "empty") {
        parts.push(`<div class="chart-line lyrics-row">&nbsp;</div>`);
        continue;
      }
      if (line.type === "comment") {
        parts.push(`<div class="song-comment">${escapeHtml(line.text)}</div>`);
        continue;
      }
      if (line.type !== "lyric") continue;

      const hasChords = line.segments.some((s) => s.chord);

      if (hasChords) {
        // Build chord row and lyric row with aligned spacing
        let chordRow = "";
        let lyricRow = "";

        for (const seg of line.segments) {
          const chordText = seg.chord || "";
          const lyricText = seg.lyric || "";
          const pad = Math.max(0, chordText.length - lyricText.length);

          chordRow += chordText + " ".repeat(Math.max(1, lyricText.length - chordText.length + 1));
          lyricRow += lyricText + " ".repeat(pad > 0 ? pad + 1 : 0);
        }

        parts.push(`<div class="chart-line chords-row">${escapeHtml(chordRow.trimEnd())}</div>`);
        if (lyricRow.trim()) {
          parts.push(`<div class="chart-line lyrics-row">${escapeHtml(lyricRow.trimEnd())}</div>`);
        }
      } else {
        // Lyrics only
        const text = line.segments.map((s) => s.lyric).join("");
        parts.push(`<div class="chart-line lyrics-row">${escapeHtml(text)}</div>`);
      }
    }
  }

  return parts.join("\n");
}

/**
 * Extract all unique chord names from an AST.
 * @param {{ meta: object, sections: Array }} ast
 * @returns {string[]}
 */
export function extractChords(ast) {
  const chords = new Set();
  for (const section of ast.sections) {
    for (const line of section.lines) {
      if (line.type !== "lyric") continue;
      for (const seg of line.segments) {
        if (seg.chord) chords.add(seg.chord);
      }
    }
  }
  return [...chords];
}

/**
 * Parse song-specific metadata from post content.
 * Follows the same bold-key pattern as parsePodcastMeta.
 * @param {string} content
 * @returns {{ key: string|null, tempo: string|null, time: string|null, capo: string|null, tuning: string|null, artist: string|null, album: string|null }}
 */
export function parseSongMeta(content) {
  if (!content) return { key: null, tempo: null, time: null, capo: null, tuning: null, artist: null, album: null };

  const keyMatch = content.match(/\*\*Key:\*\*\s*(.+)/i);
  const tempoMatch = content.match(/\*\*Tempo:\*\*\s*(.+)/i);
  const timeMatch = content.match(/\*\*Time:\*\*\s*(.+)/i);
  const capoMatch = content.match(/\*\*Capo:\*\*\s*(.+)/i);
  const tuningMatch = content.match(/\*\*Tuning:\*\*\s*(.+)/i);
  const artistMatch = content.match(/\*\*Artist:\*\*\s*(.+)/i);
  const albumMatch = content.match(/\*\*Album:\*\*\s*(.+)/i);

  return {
    key: keyMatch ? keyMatch[1].trim() : null,
    tempo: tempoMatch ? tempoMatch[1].trim() : null,
    time: timeMatch ? timeMatch[1].trim() : null,
    capo: capoMatch ? capoMatch[1].trim() : null,
    tuning: tuningMatch ? tuningMatch[1].trim() : null,
    artist: artistMatch ? artistMatch[1].trim() : null,
    album: albumMatch ? albumMatch[1].trim() : null,
  };
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
