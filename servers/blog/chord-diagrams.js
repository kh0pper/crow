/**
 * Chord Diagram Generator — Algorithmic voicing + curated overrides, SVG output
 *
 * Generates guitar and piano chord diagrams as inline SVG strings.
 * Primary generation is algorithmic; curated overrides provide better
 * fingerings for common chords.
 */

// Standard tuning MIDI values: E2=40, A2=45, D3=50, G3=55, B3=59, E4=64
const GUITAR_OPEN = [40, 45, 50, 55, 59, 64];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_MAP = { Db: "C#", Eb: "D#", Fb: "E", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B" };

// Chord quality → interval sets (semitones from root)
const QUALITY_INTERVALS = {
  "": [0, 4, 7],                   // major
  m: [0, 3, 7],                    // minor
  "7": [0, 4, 7, 10],             // dominant 7
  maj7: [0, 4, 7, 11],            // major 7
  m7: [0, 3, 7, 10],              // minor 7
  m7b5: [0, 3, 6, 10],            // half-diminished
  dim: [0, 3, 6],                  // diminished
  dim7: [0, 3, 6, 9],             // diminished 7
  aug: [0, 4, 8],                  // augmented
  sus2: [0, 2, 7],                // sus2
  sus4: [0, 5, 7],                // sus4
  "6": [0, 4, 7, 9],             // major 6
  m6: [0, 3, 7, 9],              // minor 6
  "9": [0, 4, 7, 10, 14],        // dominant 9
  m9: [0, 3, 7, 10, 14],         // minor 9
  maj9: [0, 4, 7, 11, 14],       // major 9
  add9: [0, 4, 7, 14],           // add 9
  "7sus4": [0, 5, 7, 10],        // 7sus4
  "7b9": [0, 4, 7, 10, 13],     // 7 flat 9
  "7#9": [0, 4, 7, 10, 15],     // 7 sharp 9
  "11": [0, 4, 7, 10, 14, 17],  // dominant 11
};

// Curated guitar overrides — preferred voicings (fret numbers, -1 = muted)
const GUITAR_OVERRIDES = {
  C:       [[-1, 3, 2, 0, 1, 0]],
  D:       [[-1, -1, 0, 2, 3, 2]],
  E:       [[0, 2, 2, 1, 0, 0]],
  F:       [[1, 1, 2, 3, 3, 1]],
  G:       [[3, 2, 0, 0, 0, 3]],
  A:       [[-1, 0, 2, 2, 2, 0]],
  B:       [[-1, 2, 4, 4, 4, 2]],
  Am:      [[-1, 0, 2, 2, 1, 0]],
  Em:      [[0, 2, 2, 0, 0, 0]],
  Dm:      [[-1, -1, 0, 2, 3, 1]],
  Am7:     [[-1, 0, 2, 0, 1, 0]],
  Em7:     [[0, 2, 0, 0, 0, 0]],
  Dm7:     [[-1, -1, 0, 2, 1, 1]],
  Cmaj7:   [[-1, 3, 2, 0, 0, 0]],
  Fmaj7:   [[-1, -1, 3, 2, 1, 0]],
  Gmaj7:   [[3, 2, 0, 0, 0, 2]],
  A7:      [[-1, 0, 2, 0, 2, 0]],
  E7:      [[0, 2, 0, 1, 0, 0]],
  D7:      [[-1, -1, 0, 2, 1, 2]],
  G7:      [[3, 2, 0, 0, 0, 1]],
  B7:      [[-1, 2, 1, 2, 0, 2]],
  C7:      [[-1, 3, 2, 3, 1, 0]],
  "F#m":   [[2, 4, 4, 2, 2, 2]],
  "F#m7":  [[2, 0, 2, 2, 2, 0]],
  "F#m7b5":[[2, -1, 2, 2, 1, -1]],
  Bdim:    [[-1, 2, 3, 4, 3, -1]],
};

// Curated piano overrides — note indices from middle C
const PIANO_OVERRIDES = {};

/**
 * Parse chord name into root + quality.
 * @param {string} name
 * @returns {{ root: string, quality: string, bass: string|null } | null}
 */
function parseChordName(name) {
  if (!name) return null;
  const m = name.match(/^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/);
  if (!m) return null;
  return { root: m[1], quality: m[2] || "", bass: m[3] || null };
}

/**
 * Get the MIDI note number for a note name.
 */
function noteToMidi(name) {
  const canonical = FLAT_MAP[name] || name;
  const idx = NOTE_NAMES.indexOf(canonical);
  return idx >= 0 ? idx : -1;
}

/**
 * Look up intervals for a quality string.
 */
function getIntervals(quality) {
  // Direct match
  if (QUALITY_INTERVALS[quality] !== undefined) return QUALITY_INTERVALS[quality];
  // Try without leading 'm' issues — strip and retry
  return QUALITY_INTERVALS[""] || [0, 4, 7]; // fallback to major
}

/**
 * Algorithmic guitar voicing generator.
 * Finds a playable voicing within a 4-fret span.
 */
export function generateGuitarVoicing(root, quality) {
  const rootMidi = noteToMidi(root);
  if (rootMidi === -1) return null;

  const intervals = getIntervals(quality);
  const targetNotes = new Set(intervals.map((i) => (rootMidi + i) % 12));

  let bestVoicing = null;
  let bestScore = -Infinity;

  // Try each starting fret position (0 through 9)
  for (let startFret = 0; startFret <= 9; startFret++) {
    const voicing = [];
    let score = 0;
    let valid = true;

    for (let s = 0; s < 6; s++) {
      let found = false;
      // Try frets within 4-fret span from startFret (including open)
      const frets = startFret === 0 ? [0, 1, 2, 3, 4] : Array.from({ length: 5 }, (_, i) => startFret + i);

      for (const fret of frets) {
        const note = (GUITAR_OPEN[s] + fret) % 12;
        if (targetNotes.has(note)) {
          voicing.push(fret);
          found = true;
          // Prefer open strings and lower frets
          score += fret === 0 ? 3 : (10 - fret);
          // Bonus for root on lowest strings
          if (note === rootMidi && s <= 1) score += 5;
          break;
        }
      }

      if (!found) {
        voicing.push(-1);
        // Muting high strings is worse
        if (s >= 3) score -= 3;
      }
    }

    // Must have at least 4 strings played and root note present
    const played = voicing.filter((f) => f >= 0);
    const playedNotes = voicing.map((f, s) => f >= 0 ? (GUITAR_OPEN[s] + f) % 12 : -1);
    const hasRoot = playedNotes.includes(rootMidi);

    if (played.length >= 4 && hasRoot) {
      // Prefer consecutive muted strings from low E
      let leadingMutes = 0;
      for (let i = 0; i < 6; i++) {
        if (voicing[i] === -1) leadingMutes++;
        else break;
      }
      const innerMutes = voicing.filter((f) => f === -1).length - leadingMutes;
      score -= innerMutes * 5;

      if (score > bestScore) {
        bestScore = score;
        bestVoicing = [...voicing];
      }
    }
  }

  return bestVoicing;
}

/**
 * Algorithmic piano voicing generator.
 * Returns array of MIDI-relative note numbers (C=0) for a 2-octave range.
 */
export function generatePianoVoicing(root, quality) {
  const rootMidi = noteToMidi(root);
  if (rootMidi === -1) return null;

  const intervals = getIntervals(quality);
  // Build notes relative to middle C area (MIDI 60)
  return intervals.map((i) => (rootMidi + i) % 12);
}

/**
 * Generate guitar chord SVG.
 * @param {string} chordName
 * @param {number[]} voicing - Array of 6 fret numbers (-1 = muted)
 * @returns {string} SVG markup
 */
export function generateGuitarSvg(chordName, voicing) {
  if (!voicing || voicing.length !== 6) return "";

  const W = 44;
  const H = 58;
  const TOP = 10;
  const BOTTOM = 54;
  const LEFT = 2;
  const RIGHT = 42;
  const stringSpacing = (RIGHT - LEFT) / 5;
  const fretSpacing = (BOTTOM - TOP) / 5;

  // Determine fret window
  const fretted = voicing.filter((f) => f > 0);
  const minFret = fretted.length > 0 ? Math.min(...fretted) : 0;
  const maxFret = fretted.length > 0 ? Math.max(...fretted) : 0;
  const baseFret = maxFret <= 5 ? 1 : minFret;
  const showNut = baseFret === 1;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;

  // Nut or fret number
  if (showNut) {
    svg += `<rect x="${LEFT}" y="${TOP}" width="${RIGHT - LEFT}" height="1.5" fill="white" rx="0.5"/>`;
  } else {
    svg += `<text x="${LEFT - 1}" y="${TOP + fretSpacing / 2 + 2}" fill="rgba(255,255,255,0.4)" font-size="5" font-family="sans-serif" text-anchor="end">${baseFret}</text>`;
    svg += `<rect x="${LEFT}" y="${TOP}" width="${RIGHT - LEFT}" height="0.8" fill="rgba(255,255,255,0.3)"/>`;
  }

  // Fret lines
  for (let f = 1; f <= 5; f++) {
    const y = TOP + f * fretSpacing;
    svg += `<line x1="${LEFT}" y1="${y}" x2="${RIGHT}" y2="${y}" stroke="rgba(255,255,255,0.15)" stroke-width="0.8"/>`;
  }

  // String lines
  for (let s = 0; s < 6; s++) {
    const x = LEFT + s * stringSpacing;
    svg += `<line x1="${x}" y1="${TOP}" x2="${x}" y2="${BOTTOM}" stroke="rgba(255,255,255,0.15)" stroke-width="0.8"/>`;
  }

  // Finger dots, mute/open markers
  for (let s = 0; s < 6; s++) {
    const x = LEFT + s * stringSpacing;
    const fret = voicing[s];

    if (fret === -1) {
      svg += `<text x="${x}" y="${TOP - 2}" fill="rgba(255,255,255,0.3)" font-size="6" font-family="sans-serif" text-anchor="middle">x</text>`;
    } else if (fret === 0) {
      svg += `<circle cx="${x}" cy="${TOP - 3}" r="2" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="0.8"/>`;
    } else {
      const displayFret = fret - baseFret + 1;
      if (displayFret >= 1 && displayFret <= 5) {
        const y = TOP + (displayFret - 0.5) * fretSpacing;
        svg += `<circle cx="${x}" cy="${y}" r="3" fill="#2997ff"/>`;
      }
    }
  }

  svg += `</svg>`;
  return svg;
}

/**
 * Generate piano chord SVG.
 * @param {string} chordName
 * @param {number[]} notes - Array of note indices (0=C, 1=C#, etc.)
 * @returns {string} SVG markup
 */
export function generatePianoSvg(chordName, notes) {
  if (!notes || notes.length === 0) return "";

  const W = 84;
  const H = 48;
  const whiteW = 6;
  const whiteH = 40;
  const blackW = 4;
  const blackH = 24;
  const TOP = 4;

  // 14 white keys (2 octaves C to B)
  const whites = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23];
  const blacks = [1, 3, 6, 8, 10, 13, 15, 18, 20, 22];

  // Map: note index within octave → set
  const activeNotes = new Set(notes.map((n) => n % 12));

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;

  // White keys
  whites.forEach((noteIdx, i) => {
    const x = i * whiteW;
    const active = activeNotes.has(noteIdx % 12);
    svg += `<rect x="${x}" y="${TOP}" width="${whiteW - 0.5}" height="${whiteH}" rx="1" fill="${active ? "#2997ff" : "rgba(255,255,255,0.85)"}" stroke="rgba(0,0,0,0.2)" stroke-width="0.5"/>`;
  });

  // Black keys
  const blackPositions = [1, 2, 4, 5, 6, 8, 9, 11, 12, 13]; // white key index where black key sits to the right
  blacks.forEach((noteIdx, i) => {
    const whiteIdx = blackPositions[i];
    const x = whiteIdx * whiteW - blackW / 2;
    const active = activeNotes.has(noteIdx % 12);
    svg += `<rect x="${x}" y="${TOP}" width="${blackW}" height="${blackH}" rx="0.5" fill="${active ? "#2997ff" : "#1a1a2e"}"/>`;
  });

  svg += `</svg>`;
  return svg;
}

/**
 * Get chord diagram for a given chord name and instrument.
 * @param {string} chordName - e.g. "Am7", "F#m7b5"
 * @param {"guitar"|"piano"} [instrument="guitar"]
 * @returns {{ svg: string, voicing: any } | null}
 */
export function getChordDiagram(chordName, instrument = "guitar") {
  const parsed = parseChordName(chordName);
  if (!parsed) return null;

  if (instrument === "guitar") {
    // Check overrides first
    if (GUITAR_OVERRIDES[chordName]) {
      const voicing = GUITAR_OVERRIDES[chordName][0];
      return { svg: generateGuitarSvg(chordName, voicing), voicing };
    }

    // Algorithmic generation
    const voicing = generateGuitarVoicing(parsed.root, parsed.quality);
    if (!voicing) return { svg: "", voicing: null };
    return { svg: generateGuitarSvg(chordName, voicing), voicing };
  }

  if (instrument === "piano") {
    // Check overrides first
    if (PIANO_OVERRIDES[chordName]) {
      const notes = PIANO_OVERRIDES[chordName];
      return { svg: generatePianoSvg(chordName, notes), voicing: notes };
    }

    const notes = generatePianoVoicing(parsed.root, parsed.quality);
    if (!notes) return { svg: "", voicing: null };
    return { svg: generatePianoSvg(chordName, notes), voicing: notes };
  }

  return null;
}
