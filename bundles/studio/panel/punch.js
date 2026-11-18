/**
 * Crow Studio — the punch rules, as one inline classic script.
 *
 * A punch is a range of a clip the next take replaces: the take is recorded
 * only inside that range on every loop pass, and when it lands the comp is
 * spliced so the new take covers the range and the rest of the comp stays. Two
 * things are easy to get subtly wrong there — the splice (which the comp drag
 * uses too, so there is one implementation) and the frames a pass's gate opens
 * and closes on (a context frame, moved by the input delay, on every pass).
 *
 *   - `PUNCH_SCRIPT` is a classic script (an IIFE that assigns one global,
 *     `window.StudioPunch`). It is emitted into the page before the client
 *     (see `panel/studio.js`), so the page reads the same rules this file
 *     exports.
 *   - the named exports below are produced by evaluating THAT SAME string in
 *     Node with `new Function`, so a test drives exactly the bytes the page
 *     runs.
 *
 * Like `panel/client.js`, `panel/pad-input.js` and `panel/record-view.js` this
 * travels as a string and is written as an EXPRESSIONS ONLY classic script: no
 * backtick, no `${`, no double quote and no backslash anywhere in the emitted
 * text. It builds nothing in the DOM.
 *
 * What this file holds, and what it does not:
 *
 * - the comp itself stays in the song; the caller passes the comp
 *   (`compOf(clip)`) and the clip's length in beats (`clipLengthBeats(clip)`)
 *   in, and gets the whole new comp back. Sending it is the caller's one
 *   `clip.set_comp`.
 * - the punch range is this device's view state, stored outside the song; the
 *   range only becomes frames here.
 * - nothing here reads or writes a document, and nothing here is a command.
 *
 * @type {string}
 */
export const PUNCH_SCRIPT = [
  "(function () {",
  "  'use strict';",
  "",
  "  // Two comps are compared with this tolerance: a beat that differs by less",
  "  // than this is the same beat, so a drag that changed nothing sends nothing.",
  "  var COMP_EPSILON = 1e-9;",
  "",
  "  // A value as a number, or null for no reading at all (a missing argument,",
  "  // NaN, a string that is not a number, an infinity).",
  "  function readingOf(value) {",
  "    var number = typeof value === 'number' ? value : Number(value);",
  "    return isFinite(number) ? number : null;",
  "  }",
  "",
  "  // A value held inside a range.",
  "  function clamp(value, low, high) {",
  "    return Math.max(low, Math.min(value, high));",
  "  }",
  "",
  "  // A value as a whole number, or null when it is not one: a beat a punch",
  "  // range names is always whole.",
  "  function wholeOf(value) {",
  "    var number = readingOf(value);",
  "    if (number === null) return null;",
  "    return number === Math.round(number) ? number : null;",
  "  }",
  "",
  "  /**",
  "   * The whole new comp after one take replaces a range of it.",
  "   *",
  "   * The range is the new take's, in clip beats; everything the comp already",
  "   * says outside it stays, a segment the range cuts is trimmed to its outer",
  "   * pieces, the result is sorted, pieces of one take that touch are merged, and",
  "   * nothing leaves the clip. A range that covers the whole clip leaves one",
  "   * segment, and an empty comp gives one segment over the range.",
  "   *",
  "   * The range is clamped into the clip and a reversed pair is swapped, so a",
  "   * drag or a punch that runs past either end still answers a comp the song",
  "   * accepts.",
  "   *",
  "   * @param {Array<{take_id: string, from_beat: number, to_beat: number}>} comp",
  "   *   the comp as the song holds it (empty for a clip with no comp yet)",
  "   * @param {string} takeId - the take that now plays over the range",
  "   * @param {number} from - the range's first beat, in clip beats",
  "   * @param {number} to - the range's end beat, in clip beats",
  "   * @param {number} lengthBeats - the clip's length, in beats",
  "   * @returns {Array<{take_id: string, from_beat: number, to_beat: number}>}",
  "   *   the whole new comp, in beat order",
  "   */",
  "  function spliceComp(comp, takeId, from, to, lengthBeats) {",
  "    var length = readingOf(lengthBeats);",
  "    if (length === null || length < 0) length = 0;",
  "    var low = clamp(Math.min(Number(from), Number(to)), 0, length);",
  "    var high = clamp(Math.max(Number(from), Number(to)), 0, length);",
  "    var pieces = [];",
  "    var segments = Array.isArray(comp) ? comp : [];",
  "    for (var i = 0; i < segments.length; i += 1) {",
  "      var segment = segments[i] || {};",
  "      var start = Number(segment.from_beat);",
  "      var end = Number(segment.to_beat);",
  "      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;",
  "      if (end <= low || start >= high) {",
  "        pieces.push({ take_id: String(segment.take_id), from_beat: start, to_beat: end });",
  "        continue;",
  "      }",
  "      if (start < low) pieces.push({ take_id: String(segment.take_id), from_beat: start, to_beat: low });",
  "      if (end > high) pieces.push({ take_id: String(segment.take_id), from_beat: high, to_beat: end });",
  "    }",
  "    if (high > low) pieces.push({ take_id: String(takeId), from_beat: low, to_beat: high });",
  "    pieces.sort(function (a, b) { return a.from_beat - b.from_beat; });",
  "    var merged = [];",
  "    for (i = 0; i < pieces.length; i += 1) {",
  "      var piece = pieces[i];",
  "      var previous = merged[merged.length - 1];",
  "      if (previous && previous.take_id === piece.take_id && Math.abs(previous.to_beat - piece.from_beat) < COMP_EPSILON) {",
  "        previous.to_beat = piece.to_beat;",
  "        continue;",
  "      }",
  "      merged.push({ take_id: piece.take_id, from_beat: piece.from_beat, to_beat: piece.to_beat });",
  "    }",
  "    return merged.filter(function (segment) { return segment.to_beat > segment.from_beat; });",
  "  }",
  "",
  "  /**",
  "   * Whether two comps say the same thing.",
  "   *",
  "   * Same segments, in the same order, naming the same takes, with begins and",
  "   * ends within the tolerance: a comp drag that changed nothing sends no",
  "   * command, and neither does a landed punch that the comp already says.",
  "   *",
  "   * @param {Array<{take_id: string, from_beat: number, to_beat: number}>} before",
  "   * @param {Array<{take_id: string, from_beat: number, to_beat: number}>} after",
  "   * @returns {boolean}",
  "   */",
  "  function sameComp(before, after) {",
  "    var left = Array.isArray(before) ? before : [];",
  "    var right = Array.isArray(after) ? after : [];",
  "    if (left.length !== right.length) return false;",
  "    for (var i = 0; i < left.length; i += 1) {",
  "      var a = left[i] || {};",
  "      var b = right[i] || {};",
  "      if (String(a.take_id) !== String(b.take_id)) return false;",
  "      if (Math.abs(Number(a.from_beat) - Number(b.from_beat)) > COMP_EPSILON) return false;",
  "      if (Math.abs(Number(a.to_beat) - Number(b.to_beat)) > COMP_EPSILON) return false;",
  "    }",
  "    return true;",
  "  }",
  "",
  "  /**",
  "   * Whether a punch range fits the clip: whole beats, from zero, ending after",
  "   * it begins and no further than the clip goes.",
  "   *",
  "   * A range that does not fit is never sent: nothing arms, and the lane says",
  "   * the range is outside the clip.",
  "   *",
  "   * @param {number} from - the range's first beat, in clip beats",
  "   * @param {number} to - the range's end beat, in clip beats",
  "   * @param {number} lengthBeats - the clip's length, in beats",
  "   * @returns {boolean}",
  "   */",
  "  function validRange(from, to, lengthBeats) {",
  "    var start = wholeOf(from);",
  "    var end = wholeOf(to);",
  "    var length = readingOf(lengthBeats);",
  "    if (start === null || end === null || length === null) return false;",
  "    return start >= 0 && start < end && end <= length;",
  "  }",
  "",
  "  /**",
  "   * The context frames one pass's gate is open for.",
  "   *",
  "   * The range is the same on every pass, so only the pass moves it: the pass",
  "   * starts whole loops after the anchor, a beat is its own frames from there,",
  "   * and the input arrives offsetFrames after it was played — the same delay the",
  "   * take's own frame offset carries. Each end is rounded once, after the anchor",
  "   * and the delay, which are whole frames already.",
  "   *",
  "   * @param {object} options",
  "   * @param {number} options.anchorFrame - the take's first context frame",
  "   * @param {number} options.fpb - frames per beat at the take's tempo",
  "   * @param {number} options.loopBeats - the pass's length, in beats",
  "   * @param {number} options.passIndex - which pass, from zero",
  "   * @param {number} options.from - the range's first beat, in clip beats",
  "   * @param {number} options.to - the range's end beat, in clip beats",
  "   * @param {number} options.offsetFrames - the input's delay, in frames",
  "   * @returns {[number, number]} the gate's on frame and its off frame",
  "   */",
  "  function passGateRanges(options) {",
  "    var source = options && typeof options === 'object' ? options : {};",
  "    var anchor = readingOf(source.anchorFrame);",
  "    var fpb = readingOf(source.fpb);",
  "    var loopBeats = readingOf(source.loopBeats);",
  "    var pass = readingOf(source.passIndex);",
  "    var offset = readingOf(source.offsetFrames);",
  "    var fromBeat = readingOf(source.from);",
  "    var toBeat = readingOf(source.to);",
  "    if (anchor === null) anchor = 0;",
  "    if (fpb === null) fpb = 0;",
  "    if (loopBeats === null) loopBeats = 0;",
  "    if (pass === null) pass = 0;",
  "    if (offset === null) offset = 0;",
  "    if (fromBeat === null) fromBeat = 0;",
  "    if (toBeat === null) toBeat = fromBeat;",
  "    var base = anchor + pass * loopBeats * fpb + offset;",
  "    return [",
  "      Math.round(base + fromBeat * fpb),",
  "      Math.round(base + toBeat * fpb)",
  "    ];",
  "  }",
  "",
  "  window.StudioPunch = {",
  "    COMP_EPSILON: COMP_EPSILON,",
  "    spliceComp: spliceComp,",
  "    sameComp: sameComp,",
  "    validRange: validRange,",
  "    passGateRanges: passGateRanges",
  "  };",
  "})();",
].join("\n");

/**
 * The punch rules, evaluated from the very string the page inlines.
 *
 * `new Function` with a `window` parameter means the script's one global lands
 * on the object this module keeps, and never on Node's `globalThis`.
 */
const punchApi = new Function(
  "window",
  `${PUNCH_SCRIPT}\nreturn window.StudioPunch;`,
)({});

/** The tolerance two comps are compared with, in beats. */
export const COMP_EPSILON = punchApi.COMP_EPSILON;

/**
 * The whole new comp after one take replaces a range of it.
 * @param {Array<{take_id: string, from_beat: number, to_beat: number}>} comp
 * @param {string} takeId
 * @param {number} from - in clip beats
 * @param {number} to - in clip beats
 * @param {number} lengthBeats
 * @returns {Array<{take_id: string, from_beat: number, to_beat: number}>}
 */
export function spliceComp(comp, takeId, from, to, lengthBeats) {
  return punchApi.spliceComp(comp, takeId, from, to, lengthBeats);
}

/**
 * Whether two comps say the same thing, with a 1e-9 tolerance on every beat.
 * @param {Array<{take_id: string, from_beat: number, to_beat: number}>} before
 * @param {Array<{take_id: string, from_beat: number, to_beat: number}>} after
 * @returns {boolean}
 */
export function sameComp(before, after) {
  return punchApi.sameComp(before, after);
}

/**
 * Whether a punch range fits the clip: whole beats, from zero, end after start.
 * @param {number} from - in clip beats
 * @param {number} to - in clip beats
 * @param {number} lengthBeats
 * @returns {boolean}
 */
export function validRange(from, to, lengthBeats) {
  return punchApi.validRange(from, to, lengthBeats);
}

/**
 * The context frames one pass's gate is open for: `[onFrame, offFrame]`.
 * @param {{anchorFrame: number, fpb: number, loopBeats: number,
 *   passIndex: number, from: number, to: number, offsetFrames: number}} options
 * @returns {[number, number]}
 */
export function passGateRanges(options) {
  return punchApi.passGateRanges(options);
}