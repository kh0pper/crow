/**
 * Crow Studio — the pad input rules, as one inline classic script.
 *
 * Playing a pad by hand turns two things into numbers: how hard the finger
 * pressed (a velocity) and which pad it was (a chromatic pitch, when the bank
 * plays a scale instead of its own samples). Those rules are small, pure and
 * easy to get subtly wrong in three places at once — the pad grid, the 16
 * velocity mode and the on-screen keyboard — so they live here, once, in
 * dependency-free plain JavaScript:
 *
 *   - `PAD_INPUT_SCRIPT` is a classic script (an IIFE that assigns one global,
 *     `window.StudioPadInput`). It is emitted into the page before the client
 *     (see `panel/studio.js`), so every pad gesture reads the same rules.
 *   - the named exports below are produced by evaluating THAT SAME string in
 *     Node with `new Function`, so a test drives exactly the bytes the page
 *     runs.
 *
 * Like `panel/client.js` and `panel/midi-route.js` this travels as a string and
 * is written as an EXPRESSIONS ONLY classic script: no backtick, no `${`, no
 * double quote and no backslash anywhere in the emitted text. It builds
 * nothing in the DOM.
 *
 * Everything here is this device's own: pad sensitivity is kept in the
 * browser, never in the song, and nothing in this file reads or writes a
 * document.
 *
 * @type {string}
 */
export const PAD_INPUT_SCRIPT = [
  "(function () {",
  "  'use strict';",
  "",
  "  // The pitches each chromatic scale walks, in semitones from its key root.",
  "  // The first degree is always 0, so the first pad sounds the key the",
  "  // operator chose.",
  "  var SCALES = {",
  "    major: [0, 2, 4, 5, 7, 9, 11],",
  "    minor: [0, 2, 3, 5, 7, 8, 10],",
  "    dorian: [0, 2, 3, 5, 7, 9, 10],",
  "    phrygian: [0, 1, 3, 5, 7, 8, 10],",
  "    pentatonic_major: [0, 2, 4, 7, 9],",
  "    pentatonic_minor: [0, 3, 5, 7, 10]",
  "  };",
  "",
  "  // The scale names in the order a picker offers them.",
  "  var SCALE_NAMES = [",
  "    'major', 'minor', 'dorian', 'phrygian', 'pentatonic_major', 'pentatonic_minor'",
  "  ];",
  "",
  "  // This device's starting pad sensitivity: the identity curve, no",
  "  // threshold, unity gain. Stored per device, never in the song.",
  "  var DEFAULT_SENSE = { curve: 'linear', threshold: 0, gain: 1 };",
  "",
  "  // The curves a sensitivity may name.",
  "  var CURVES = ['linear', 'exp', 'log', 'fixed'];",
  "",
  "  // The velocity a fixed curve plays, and the range every shaped reading",
  "  // lands in. A press that plays at all plays at 1 or more.",
  "  var FIXED_VELOCITY = 100;",
  "  var LOWEST_VELOCITY = 1;",
  "  var HIGHEST_VELOCITY = 127;",
  "",
  "  // A pad bank is sixteen pads: the four by four an SP-404 style bank uses.",
  "  var PAD_COUNT = 16;",
  "",
  "  // What the stored sensitivity fields are held to.",
  "  var LOWEST_THRESHOLD = 0;",
  "  var HIGHEST_THRESHOLD = 126;",
  "  var LOWEST_GAIN = 0.25;",
  "  var HIGHEST_GAIN = 4;",
  "",
  "  // The softest and loudest level a 16 velocity pad plays at, and how far a",
  "  // chromatic pad may move a sample: the caller adds the pad pitch and",
  "  // clamps again.",
  "  var FIRST_LEVEL = 8;",
  "  var LAST_LEVEL = 127;",
  "  var LOWEST_PITCH = -24;",
  "  var HIGHEST_PITCH = 24;",
  "",
  "  // A key root is one of the twelve pitch classes.",
  "  var KEY_ROOTS = 12;",
  "",
  "  function hasOwn(object, key) {",
  "    return Object.prototype.hasOwnProperty.call(object, key);",
  "  }",
  "",
  "  // A reading as a number, or null for no reading at all (a missing",
  "  // argument, NaN, a string that is not a number, an infinity).",
  "  function readingOf(value) {",
  "    var number = typeof value === 'number' ? value : Number(value);",
  "    return isFinite(number) ? number : null;",
  "  }",
  "",
  "  function clamp(value, low, high) {",
  "    if (value < low) return low;",
  "    if (value > high) return high;",
  "    return value;",
  "  }",
  "",
  "  // A whole number inside a range, or the fallback for anything that is not",
  "  // one: an index off the grid reads as the first pad.",
  "  function wholeBetween(value, low, high, fallback) {",
  "    var number = readingOf(value);",
  "    if (number === null) return fallback;",
  "    return clamp(Math.round(number), low, high);",
  "  }",
  "",
  "  // One stored sensitivity as the values this file holds to: a curve a pad",
  "  // knows, a threshold and a gain inside their ranges, and the defaults for",
  "  // anything missing or spoiled. A stored value is never trusted as is, so a",
  "  // hand-edited device store can not make a pad unplayable or deafening.",
  "  function senseOf(sense) {",
  "    var stored = sense && typeof sense === 'object' ? sense : {};",
  "    var curve = typeof stored.curve === 'string' && CURVES.indexOf(stored.curve) >= 0",
  "      ? stored.curve",
  "      : DEFAULT_SENSE.curve;",
  "    var threshold = readingOf(stored.threshold);",
  "    var gain = readingOf(stored.gain);",
  "    return {",
  "      curve: curve,",
  "      threshold: threshold === null",
  "        ? DEFAULT_SENSE.threshold",
  "        : clamp(threshold, LOWEST_THRESHOLD, HIGHEST_THRESHOLD),",
  "      gain: gain === null ? DEFAULT_SENSE.gain : clamp(gain, LOWEST_GAIN, HIGHEST_GAIN)",
  "    };",
  "  }",
  "",
  "  // A shaped reading as the velocity a press plays at: always a whole number",
  "  // from 1 to 127, never a value the caller has to check before playing.",
  "  function playable(value) {",
  "    var rounded = Math.round(value);",
  "    if (!isFinite(rounded)) return LOWEST_VELOCITY;",
  "    return clamp(rounded, LOWEST_VELOCITY, HIGHEST_VELOCITY);",
  "  }",
  "",
  "  /**",
  "   * One pressure reading as the velocity a press plays at.",
  "   *",
  "   * The reading travels through this device curve on its way into 1..127:",
  "   * linear is the reading itself at unity gain, exp bends the middle down",
  "   * and log bends it up, and both curves meet linear at the two ends. The",
  "   * fixed curve ignores the reading and always plays the same velocity,",
  "   * which is what a pad with no pressure sensor is worth. A reading below",
  "   * the threshold is 0: the press is too soft to play at all.",
  "   *",
  "   * @param {number} reading - 1..127, or 0 for nothing",
  "   * @param {{curve: string, threshold: number, gain: number}} sense",
  "   * @returns {number} a velocity from 1..127, or 0 for a press that does not play",
  "   */",
  "  function curveVelocity(reading, sense) {",
  "    var settings = senseOf(sense);",
  "    if (settings.curve === 'fixed') {",
  "      return playable(FIXED_VELOCITY * settings.gain);",
  "    }",
  "    var value = readingOf(reading);",
  "    if (value === null || value < LOWEST_VELOCITY) return 0;",
  "    if (value < settings.threshold) return 0;",
  "    var highest = value > HIGHEST_VELOCITY ? HIGHEST_VELOCITY : value;",
  "    var span = HIGHEST_VELOCITY - LOWEST_VELOCITY;",
  "    var position = (highest - LOWEST_VELOCITY) / span;",
  "    var shaped = position;",
  "    if (settings.curve === 'exp') shaped = position * position;",
  "    else if (settings.curve === 'log') shaped = Math.sqrt(position);",
  "    return playable((LOWEST_VELOCITY + span * shaped) * settings.gain);",
  "  }",
  "",
  "  // One scale as its degrees, or the major scale for a name no pad knows.",
  "  function scaleOf(name) {",
  "    if (typeof name === 'string' && hasOwn(SCALES, name)) return SCALES[name];",
  "    return SCALES.major;",
  "  }",
  "",
  "  /**",
  "   * The semitones one chromatic pad adds to its sample, in one scale and key.",
  "   *",
  "   * The first pad is the key root; the pads walk the scale and then keep",
  "   * going in octaves, so sixteen pads cover two octaves of a seven note scale",
  "   * and three of a five note one. The answer is clamped to two octaves either",
  "   * way; the caller adds the pad pitch and clamps again.",
  "   *",
  "   * @param {number} index - the pad, 0..15",
  "   * @param {string} scale - a name from SCALE_NAMES",
  "   * @param {number} keyRoot - the key, 0..11 semitones",
  "   * @returns {number} semitones, -24..24",
  "   */",
  "  function chromaticPitch(index, scale, keyRoot) {",
  "    var degrees = scaleOf(scale);",
  "    var pad = wholeBetween(index, 0, PAD_COUNT - 1, 0);",
  "    var octave = Math.floor(pad / degrees.length);",
  "    var degree = pad - octave * degrees.length;",
  "    var root = wholeBetween(keyRoot, 0, KEY_ROOTS - 1, 0);",
  "    return clamp(degrees[degree] + 12 * octave + root, LOWEST_PITCH, HIGHEST_PITCH);",
  "  }",
  "",
  "  /**",
  "   * The velocity one pad of the 16 velocity grid plays at: 8 on the first pad",
  "   * and 127 on the last, strictly rising so two pads never share a level.",
  "   *",
  "   * @param {number} index - the pad, 0..15",
  "   * @returns {number} a velocity from 8..127",
  "   */",
  "  function velocityLevel(index) {",
  "    var pad = wholeBetween(index, 0, PAD_COUNT - 1, 0);",
  "    var span = LAST_LEVEL - FIRST_LEVEL;",
  "    return FIRST_LEVEL + Math.floor((pad * span) / (PAD_COUNT - 1));",
  "  }",
  "",
  "  /**",
  "   * One press of one finger, and the question a touch device raises: did it",
  "   * report REAL pressure?",
  "   *",
  "   * A press starts at pointerdown with reset(); every pressure reading that",
  "   * pointer reports goes through observe(). Only two DIFFERENT readings make",
  "   * the answer yes. A device that sends one constant, whatever the finger",
  "   * does (many Android WebViews send 0.5 or 1.0), has no pressure to report,",
  "   * and a pad that trusted it would play at a velocity the finger never",
  "   * asked for; such a press falls back to the fixed touch velocity.",
  "   */",
  "  function PressureProbe() {",
  "    this.first = null;",
  "    this.real = false;",
  "  }",
  "",
  "  /** One reading from this press; anything that is not a number is ignored. */",
  "  PressureProbe.prototype.observe = function observe(pressure) {",
  "    var value = readingOf(pressure);",
  "    if (value === null) return;",
  "    if (this.first === null) {",
  "      this.first = value;",
  "      return;",
  "    }",
  "    if (value !== this.first) this.real = true;",
  "  };",
  "",
  "  /** Whether this press has shown two different readings yet. */",
  "  PressureProbe.prototype.isReal = function isReal() {",
  "    return this.real === true;",
  "  };",
  "",
  "  /** Forget this press: call at pointer up, and again at the next pointer down. */",
  "  PressureProbe.prototype.reset = function reset() {",
  "    this.first = null;",
  "    this.real = false;",
  "  };",
  "",
  "  window.StudioPadInput = {",
  "    SCALES: SCALES,",
  "    SCALE_NAMES: SCALE_NAMES,",
  "    DEFAULT_SENSE: DEFAULT_SENSE,",
  "    PAD_COUNT: PAD_COUNT,",
  "    curveVelocity: curveVelocity,",
  "    chromaticPitch: chromaticPitch,",
  "    velocityLevel: velocityLevel,",
  "    PressureProbe: PressureProbe",
  "  };",
  "})();",
].join("\n");

/**
 * The pad input rules, evaluated from the very string the page inlines.
 *
 * `new Function` with a `window` parameter means the script's one global lands
 * on the object this module keeps, and never on Node's `globalThis`.
 */
const padInputApi = new Function(
  "window",
  `${PAD_INPUT_SCRIPT}\nreturn window.StudioPadInput;`,
)({});

/** Every chromatic scale and its degrees, in semitones from the key root. */
export const SCALES = padInputApi.SCALES;

/** The scale names, in the order a picker offers them. */
export const SCALE_NAMES = padInputApi.SCALE_NAMES;

/** This device's starting pad sensitivity. */
export const DEFAULT_SENSE = padInputApi.DEFAULT_SENSE;

/** The pads in a bank. */
export const PAD_COUNT = padInputApi.PAD_COUNT;

/**
 * One pressure reading as the velocity a press plays at.
 * @param {number} reading - 1..127, or 0 for nothing
 * @param {{curve: "linear"|"exp"|"log"|"fixed", threshold: number, gain: number}} sense
 * @returns {number} a velocity from 1..127, or 0 for a press that does not play
 */
export function curveVelocity(reading, sense) {
  return padInputApi.curveVelocity(reading, sense);
}

/**
 * The semitones one chromatic pad adds to its sample.
 * @param {number} index - the pad, 0..15
 * @param {string} scale - a name from SCALE_NAMES
 * @param {number} keyRoot - the key, 0..11 semitones
 * @returns {number} semitones, -24..24
 */
export function chromaticPitch(index, scale, keyRoot) {
  return padInputApi.chromaticPitch(index, scale, keyRoot);
}

/**
 * The velocity one pad of the 16 velocity grid plays at.
 * @param {number} index - the pad, 0..15
 * @returns {number} a velocity from 8..127
 */
export function velocityLevel(index) {
  return padInputApi.velocityLevel(index);
}

/** One press, and whether the device reported real pressure within it. */
export const PressureProbe = padInputApi.PressureProbe;