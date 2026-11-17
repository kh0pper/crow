/**
 * Crow Studio — the record view's rules, as one inline classic script.
 *
 * The lanes widget draws a lot of numbers that are easy to get subtly wrong in
 * three places at once: a meter that must never read NaN, a peak that holds and
 * then falls at a stated rate, a live waveform that has to line up with the take
 * it will become, and the two words a lane says about where it listens and what
 * it hears. Those rules live here, once, in dependency-free plain JavaScript:
 *
 *   - `RECORD_VIEW_SCRIPT` is a classic script (an IIFE that assigns one global,
 *     `window.StudioRecordView`). It is emitted into the page before the client
 *     (see `panel/studio.js`), so the lane, the meter, the peak, the waveform and
 *     the labels all read the same rules.
 *   - the named exports below are produced by evaluating THAT SAME string in
 *     Node with `new Function`, so a test drives exactly the bytes the page runs.
 *
 * Like `panel/client.js`, `panel/pad-input.js` and `panel/midi-route.js` this
 * travels as a string and is written as an EXPRESSIONS ONLY classic script: no
 * backtick, no `${`, no double quote and no backslash anywhere in the emitted
 * text. It builds nothing in the DOM.
 *
 * ## What each rule is for
 *
 * - `dbOf(linear)` is one amplitude as a level in dB, floored at −60: digital
 *   silence, a sample that is not a number and anything below the floor all read
 *   as the floor, never as NaN or minus infinity, so a meter draws a bar and not
 *   a hole. `meterFill(db)` is that level as the fill of a meter from nothing at
 *   −60 dB to full at 0 dB.
 * - `PeakHold` is the peak a lane holds: a new higher reading replaces the held
 *   one and restarts the hold, and once the hold is over the held value falls at
 *   20 dB a second, never below what the input is doing right now.
 * - `WaveRing` is the preallocated ring the live waveform is drawn from. It holds
 *   one column per lane column (min and max), keeps the song frame of the first
 *   sample of each column — the CONTEXT frame the engine reported, never a wall
 *   clock — and fills a gap between two posts with digital silence rather than
 *   leaving the previous pass's column under it. A second column that lands in
 *   a lane column this pass already filled is merged into it, so a lane never
 *   loses a peak it was drawn with. `columnX` is the mapping from a
 *   song frame to a lane column: the pass start is column 0, the pass's last
 *   frame is the last column, and a frame outside the pass is column −1.
 * - `chainLabel(snap, trackId, monitorOn)` is what the lane says its chain is:
 *   `amp on` when the track's chain holds an amp that is not bypassed and the
 *   operator hears the chain while the take is recorded dry, `amp off` when the
 *   amp is there and monitoring is off, and nothing at all with no amp.
 * - `sourceLabel(entry, trackIndex)` is where the lane listens: the opened
 *   input's own name, shortened to one line, and the channel count by name
 *   (`input 1 · mono`).
 *
 * Everything here is view state: nothing in this file reads or writes a
 * document, and nothing here is a command.
 *
 * @type {string}
 */
export const RECORD_VIEW_SCRIPT = [
  "(function () {",
  "  'use strict';",
  "",
  "  // The floor of a level reading, in dB. Digital silence, a value that is not",
  "  // a number, and anything quieter than this all read as the floor, so a",
  "  // meter never draws a NaN and never draws minus infinity.",
  "  var DB_FLOOR = -60;",
  "",
  "  // The top of a meter: 0 dB is full scale, and the fill stops there.",
  "  var DB_TOP = 0;",
  "",
  "  // How fast a held peak falls once its hold is over, in dB per second.",
  "  var PEAK_FALL_DB_PER_SECOND = 20;",
  "",
  "  // The middot a lane label puts between its parts, and the ellipsis a",
  "  // shortened device name ends with, built from their code points: the",
  "  // emitted text may carry no backslash, so a literal has no escape for one.",
  "  var MIDDLE_DOT = String.fromCharCode(183);",
  "  var ELLIPSIS = String.fromCharCode(8230);",
  "",
  "  // How much of a device name a lane shows before it is cut and ended with an",
  "  // ellipsis: a lane is one line, and a browser names an input with its whole",
  "  // driver description.",
  "  var SOURCE_LABEL_MAX = 24;",
  "",
  "  // What a lane calls its input before one has been opened: the input a new",
  "  // arm asks the browser for, numbered from one.",
  "  var SOURCE_FALLBACK_PREFIX = 'input ';",
  "",
  "  // A lane's chain, as the lane says it: an amp the track holds, and whether",
  "  // the operator hears it while the take is recorded dry.",
  "  var CHAIN_ON_TEXT = 'amp on';",
  "  var CHAIN_OFF_TEXT = 'amp off';",
  "  var CHAIN_AMP_KIND = 'amp';",
  "",
  "  // The two channel counts, by name.",
  "  var MONO_TEXT = 'mono';",
  "  var STEREO_TEXT = 'stereo';",
  "",
  "  // A value as a number, or null for no reading at all (a missing argument,",
  "  // NaN, a string that is not a number, an infinity).",
  "  function readingOf(value) {",
  "    var number = typeof value === 'number' ? value : Number(value);",
  "    return isFinite(number) ? number : null;",
  "  }",
  "",
  "  /**",
  "   * One linear amplitude as a level in dB, floored at -60.",
  "   *",
  "   * A negative sample is its own magnitude (a waveform is drawn either side of",
  "   * zero), and a sample above 1 reads above 0 dB rather than being clamped: a",
  "   * reading over full scale is worth seeing. Only the floor is a clamp, so",
  "   * silence and a broken reading both land on the meter's bottom instead of",
  "   * NaN or minus infinity.",
  "   *",
  "   * @param {number} linear - an amplitude, e.g. a peak or an rms",
  "   * @returns {number} dB, never below -60 and never NaN",
  "   */",
  "  function dbOf(linear) {",
  "    var value = readingOf(linear);",
  "    if (value === null) return DB_FLOOR;",
  "    var magnitude = value < 0 ? -value : value;",
  "    if (magnitude === 0) return DB_FLOOR;",
  "    var db = (20 * Math.log(magnitude)) / Math.LN10;",
  "    return db > DB_FLOOR ? db : DB_FLOOR;",
  "  }",
  "",
  "  /**",
  "   * One level as the fill of a meter: 0 at -60 dB and 1 at full scale.",
  "   *",
  "   * A reading under the floor (and any non-number) fills nothing, and one at",
  "   * or above 0 dB fills the whole meter: the answer is always 0..1.",
  "   *",
  "   * @param {number} db",
  "   * @returns {number} 0..1",
  "   */",
  "  function meterFill(db) {",
  "    var value = typeof db === 'number' ? db : Number(db);",
  "    if (value !== value) return 0;",
  "    if (value <= DB_FLOOR) return 0;",
  "    if (value >= DB_TOP) return 1;",
  "    return (value - DB_FLOOR) / (DB_TOP - DB_FLOOR);",
  "  }",
  "",
  "  // A level already in dB as a reading this file holds to: floored like dbOf,",
  "  // and a NaN or an infinity reads as the floor.",
  "  function levelOf(db) {",
  "    var value = typeof db === 'number' ? db : Number(db);",
  "    if (value !== value) return DB_FLOOR;",
  "    if (value === Infinity) return DB_FLOOR;",
  "    return value > DB_FLOOR ? value : DB_FLOOR;",
  "  }",
  "",
  "  /**",
  "   * One track's held peak.",
  "   *",
  "   * The held value is the loudest reading since the last reset, kept for",
  "   * holdMs after it was read and then falling at 20 dB a second — but never",
  "   * below the level the input is at right now, because a peak meter that",
  "   * dropped under the live meter would be lying about what is playing. A new",
  "   * reading at or above the held value replaces it and starts the hold again.",
  "   *",
  "   * @param {number} holdMs - how long the held value stands still, in ms",
  "   */",
  "  function PeakHold(holdMs) {",
  "    var hold = readingOf(holdMs);",
  "    this.holdMs = hold !== null && hold > 0 ? hold : 0;",
  "    this.peak = DB_FLOOR;",
  "    this.db = DB_FLOOR;",
  "    this.at = 0;",
  "    this.started = false;",
  "  }",
  "",
  "  /**",
  "   * Hand the peak one reading, and answer what the lane should draw.",
  "   * @param {number} db - this post's peak, in dB",
  "   * @param {number} nowMs - the page clock, in ms",
  "   * @returns {number} the held peak, in dB",
  "   */",
  "  PeakHold.prototype.update = function update(db, nowMs) {",
  "    var value = levelOf(db);",
  "    var now = readingOf(nowMs);",
  "    if (now === null) now = this.at;",
  "    if (!this.started) {",
  "      this.started = true;",
  "      this.peak = value;",
  "      this.db = value;",
  "      this.at = now;",
  "      return this.db;",
  "    }",
  "    // A clock that went backwards restarts the hold where it stands rather",
  "    // than letting the held value leap down.",
  "    if (now < this.at) this.at = now;",
  "    if (value >= this.peak) {",
  "      this.peak = value;",
  "      this.db = value;",
  "      this.at = now;",
  "      return this.db;",
  "    }",
  "    var elapsed = now - this.at;",
  "    if (elapsed <= this.holdMs) {",
  "      this.db = this.peak;",
  "      return this.db;",
  "    }",
  "    // The fall is measured from the peak that set the hold, not from whatever",
  "    // the last update answered: a lane that is drawn ten times a second must",
  "    // fall at the same rate as one drawn once.",
  "    var fallen = this.peak - (PEAK_FALL_DB_PER_SECOND * (elapsed - this.holdMs)) / 1000;",
  "    if (fallen <= value) {",
  "      // It has caught up with the input: from here the lane shows the live",
  "      // level, and a later reading above it starts a hold of its own.",
  "      this.peak = value;",
  "      this.db = value;",
  "      this.at = now;",
  "      return this.db;",
  "    }",
  "    this.db = levelOf(fallen);",
  "    return this.db;",
  "  };",
  "",
  "  /** Forget the held peak: the lane starts from the floor again. */",
  "  PeakHold.prototype.reset = function reset() {",
  "    this.peak = DB_FLOOR;",
  "    this.db = DB_FLOOR;",
  "    this.at = 0;",
  "    this.started = false;",
  "  };",
  "",
  "  /**",
  "   * The lane column a song frame falls in.",
  "   *",
  "   * A pass is drawn from its own first frame (column 0) to its last frame (the",
  "   * last column), so a column is the frame's distance into the pass scaled onto",
  "   * the lane, rounded down. A frame before the pass start or at or past its end",
  "   * belongs to no column at all: -1.",
  "   *",
  "   * @param {number} songFrame - the frame, on the same clock the pass was armed on",
  "   * @param {number} passStartFrame - the pass's own first frame",
  "   * @param {number} passFrames - how many frames the pass spans",
  "   * @param {number} widthCols - how many columns the lane draws",
  "   * @returns {number} a column index, or -1 for a frame outside the pass",
  "   */",
  "  function columnX(songFrame, passStartFrame, passFrames, widthCols) {",
  "    var frame = readingOf(songFrame);",
  "    var start = readingOf(passStartFrame);",
  "    var frames = readingOf(passFrames);",
  "    var width = readingOf(widthCols);",
  "    if (frame === null || start === null || frames === null || width === null) return -1;",
  "    var columns = Math.floor(width);",
  "    if (columns <= 0 || frames <= 0) return -1;",
  "    var offset = frame - start;",
  "    if (offset < 0 || offset >= frames) return -1;",
  "    var column = Math.floor((offset * columns) / frames);",
  "    if (column < 0) return -1;",
  "    if (column >= columns) return columns - 1;",
  "    return column;",
  "  }",
  "",
  "  /**",
  "   * The live waveform's draw ring: one min and one max per lane column.",
  "   *",
  "   * Everything is sized here, once, and nothing is ever allocated again: the",
  "   * ring is built when the record view appears (a column count fixed from the",
  "   * lane's width) and reset between takes, so a two minute take pushes columns",
  "   * onto the same arrays a two second one does.",
  "   *",
  "   * Two ways to place a column:",
  "   *",
  "   * - With a pass declared (setPass), a column is the lane column the frame",
  "   *   falls in (columnX), which is how the live waveform lines up with where",
  "   *   the take will sit: the page maps a column to song time as the context",
  "   *   frame the engine reported minus the take's offset, and draws each pass",
  "   *   from that pass's own start.",
  "   * - With no pass yet, the ring simply rolls: each column takes the next slot",
  "   *   and wraps, so the newest column is always the right edge of the lane.",
  "   *",
  "   * The frames are the CONTEXT frames of each column's first sample, exactly as",
  "   * the recorder worklet counts them; there is no wall clock anywhere here.",
  "   *",
  "   * @param {number} widthCols - how many columns the lane draws",
  "   */",
  "  function WaveRing(widthCols) {",
  "    var wanted = readingOf(widthCols);",
  "    var width = wanted === null ? 0 : Math.floor(wanted);",
  "    if (width <= 0) width = 1;",
  "    this.width = width;",
  "    this.frames = new Float64Array(width);",
  "    this.mins = new Float32Array(width);",
  "    this.maxs = new Float32Array(width);",
  "    this.filled = new Uint8Array(width);",
  "    this.passStartFrame = 0;",
  "    this.passFrames = 0;",
  "    this.newestFrame = 0;",
  "    this.next = 0;",
  "    this.count = 0;",
  "    this.column = { min: 0, max: 0 };",
  "  }",
  "",
  "  /**",
  "   * Declare the pass the ring draws, and clear it: a new pass is a new picture.",
  "   * A pass of no length leaves the ring rolling.",
  "   * @param {number} passStartFrame",
  "   * @param {number} passFrames",
  "   */",
  "  WaveRing.prototype.setPass = function setPass(passStartFrame, passFrames) {",
  "    var start = readingOf(passStartFrame);",
  "    var frames = readingOf(passFrames);",
  "    this.passStartFrame = start === null ? 0 : start;",
  "    this.passFrames = frames !== null && frames > 0 ? frames : 0;",
  "    this.reset();",
  "  };",
  "",
  "  /** Empty the ring: every column reads as silence, and nothing is reallocated. */",
  "  WaveRing.prototype.reset = function reset() {",
  "    this.frames.fill(-1);",
  "    this.mins.fill(0);",
  "    this.maxs.fill(0);",
  "    this.filled.fill(0);",
  "    this.newestFrame = 0;",
  "    this.next = 0;",
  "    this.count = 0;",
  "  };",
  "",
  "  /**",
  "   * Put one level column in the ring.",
  "   *",
  "   * A pass draws its frames onto fewer lane columns than it has level columns,",
  "   * so one lane column can be handed several: each one is MERGED into the",
  "   * column already there, the smallest minimum and the largest maximum of the",
  "   * stretch, never a replacement, so the lane keeps every peak it was drawn",
  "   * with. A new pass empties the ring (setPass, reset), so a filled slot here is",
  "   * always this pass's own. With no pass declared the ring rolls instead, and",
  "   * the slot it wraps onto holds the oldest column, which a new one replaces.",
  "   *",
  "   * @param {number} songFrame - the context frame of this column's first sample",
  "   * @param {number} min - the column's smallest sample",
  "   * @param {number} max - the column's largest sample",
  "   * @returns {boolean} whether the column landed in a lane column",
  "   */",
  "  WaveRing.prototype.pushColumn = function pushColumn(songFrame, min, max) {",
  "    var frame = readingOf(songFrame);",
  "    if (frame === null) return false;",
  "    var inPass = this.passFrames > 0;",
  "    var slot = 0;",
  "    if (inPass) {",
  "      slot = columnX(frame, this.passStartFrame, this.passFrames, this.width);",
  "      if (slot < 0) return false;",
  "    } else {",
  "      slot = this.next;",
  "      this.next = slot + 1 >= this.width ? 0 : slot + 1;",
  "    }",
  "    var low = readingOf(min);",
  "    var high = readingOf(max);",
  "    if (low === null) low = 0;",
  "    if (high === null) high = 0;",
  "    if (low > high) {",
  "      var swap = low;",
  "      low = high;",
  "      high = swap;",
  "    }",
  "    if (inPass && this.filled[slot] === 1) {",
  "      // The slot already holds this pass's column: widen it, and leave the",
  "      // frame of its first sample alone.",
  "      if (low < this.mins[slot]) this.mins[slot] = low;",
  "      if (high > this.maxs[slot]) this.maxs[slot] = high;",
  "      if (frame > this.newestFrame) this.newestFrame = frame;",
  "      return true;",
  "    }",
  "    this.frames[slot] = frame;",
  "    this.mins[slot] = low;",
  "    this.maxs[slot] = high;",
  "    this.filled[slot] = 1;",
  "    if (this.count < this.width) this.count += 1;",
  "    if (this.count === 1 || frame > this.newestFrame) this.newestFrame = frame;",
  "    return true;",
  "  };",
  "",
  "  /**",
  "   * Fill everything up to one song frame with digital silence.",
  "   *",
  "   * A hidden page, a stalled post or a quiet stretch means the newest column is",
  "   * behind the playhead: the columns in between are silence, and saying so is",
  "   * what keeps the previous pass from showing through under this one.",
  "   * @param {number} songFrame",
  "   */",
  "  WaveRing.prototype.fillTo = function fillTo(songFrame) {",
  "    var frame = readingOf(songFrame);",
  "    if (frame === null) return;",
  "    var at = 0;",
  "    if (this.passFrames > 0) {",
  "      var to = columnX(frame, this.passStartFrame, this.passFrames, this.width);",
  "      if (to < 0) return;",
  "      for (at = 0; at <= to; at += 1) {",
  "        if (this.filled[at]) continue;",
  "        this.frames[at] = this.passStartFrame + (at * this.passFrames) / this.width;",
  "        this.mins[at] = 0;",
  "        this.maxs[at] = 0;",
  "        this.filled[at] = 1;",
  "        if (this.count < this.width) this.count += 1;",
  "      }",
  "      if (frame > this.newestFrame) this.newestFrame = frame;",
  "      return;",
  "    }",
  "    // Rolling: one silent column per call while the ring is behind the frame,",
  "    // so a stretch with no posts reads as silence instead of as the last thing",
  "    // that happened before it.",
  "    if (frame <= this.newestFrame) return;",
  "    at = this.next;",
  "    this.next = at + 1 >= this.width ? 0 : at + 1;",
  "    this.frames[at] = frame;",
  "    this.mins[at] = 0;",
  "    this.maxs[at] = 0;",
  "    this.filled[at] = 1;",
  "    if (this.count < this.width) this.count += 1;",
  "    this.newestFrame = frame;",
  "  };",
  "",
  "  /**",
  "   * One column as the lane draws it.",
  "   *",
  "   * The answer is ONE object, reused for every read: the drawing loop asks for",
  "   * a column, draws it and asks for the next, so a lane never allocates. A",
  "   * slot that holds nothing reads as silence.",
  "   * @param {number} index - 0..width-1",
  "   * @returns {{min: number, max: number}} the reused column object",
  "   */",
  "  WaveRing.prototype.read = function read(index) {",
  "    var at = readingOf(index);",
  "    var column = this.column;",
  "    if (at === null) {",
  "      column.min = 0;",
  "      column.max = 0;",
  "      return column;",
  "    }",
  "    at = Math.floor(at);",
  "    if (at < 0 || at >= this.width || !this.filled[at]) {",
  "      column.min = 0;",
  "      column.max = 0;",
  "      return column;",
  "    }",
  "    column.min = this.mins[at];",
  "    column.max = this.maxs[at];",
  "    return column;",
  "  };",
  "",
  "  /**",
  "   * What a lane says its chain is: an amp, and whether the operator hears it.",
  "   *",
  "   * The entries are the song's own inserts, the way the mixer reads them: each",
  "   * names its owner (track:<id>), its kind, its place in the chain and whether",
  "   * it is bypassed. An amp the operator has not accepted yet is a proposal and",
  "   * plays nothing, so it is not part of the chain and the lane does not name it;",
  "   * a bypassed amp is out of the chain too, and the lane says nothing rather",
  "   * than claiming a sound that is not there. While the take is recorded dry the",
  "   * lane still says amp on, because that is what the operator hears.",
  "   *",
  "   * @param {object} snap - the song snapshot",
  "   * @param {string} trackId - the track whose chain the lane draws",
  "   * @param {boolean} monitorOn - whether monitoring through the chain is on",
  "   * @returns {string} amp on, amp off, or empty for a track with no amp",
  "   */",
  "  function chainLabel(snap, trackId, monitorOn) {",
  "    var inserts = snap && snap.inserts && typeof snap.inserts === 'object' ? snap.inserts : {};",
  "    var id = trackId === undefined || trackId === null ? '' : String(trackId);",
  "    var ref = 'track:' + id;",
  "    var found = false;",
  "    for (var key in inserts) {",
  "      if (!Object.prototype.hasOwnProperty.call(inserts, key)) continue;",
  "      var insert = inserts[key];",
  "      if (!insert || typeof insert !== 'object') continue;",
  "      var owner = insert.owner === undefined || insert.owner === null ? '' : String(insert.owner);",
  "      if (owner !== id && owner !== ref) continue;",
  "      if (String(insert.kind) !== CHAIN_AMP_KIND) continue;",
  "      if (insert.proposed === true) continue;",
  "      if (insert.bypass === true) continue;",
  "      found = true;",
  "      break;",
  "    }",
  "    if (!found) return '';",
  "    return monitorOn ? CHAIN_ON_TEXT : CHAIN_OFF_TEXT;",
  "  }",
  "",
  "  // One line of text: runs of spaces, tabs and newlines become one space, and",
  "  // the two ends lose theirs. A device name arrives with both.",
  "  function oneLine(text) {",
  "    var value = text === undefined || text === null ? '' : String(text);",
  "    var out = '';",
  "    var pending = false;",
  "    var started = false;",
  "    for (var at = 0; at < value.length; at += 1) {",
  "      var code = value.charCodeAt(at);",
  "      var space = code === 32 || code === 9 || code === 10 || code === 13;",
  "      if (space) {",
  "        if (started) pending = true;",
  "        continue;",
  "      }",
  "      if (pending) {",
  "        out += ' ';",
  "        pending = false;",
  "      }",
  "      out += value.charAt(at);",
  "      started = true;",
  "    }",
  "    return out;",
  "  }",
  "",
  "  // A device name as a lane can show it: one line, without the driver",
  "  // description a browser puts in brackets after the name, and cut with an",
  "  // ellipsis when it is still longer than a lane column is wide.",
  "  function shortenedLabel(text) {",
  "    var value = oneLine(text);",
  "    if (!value) return '';",
  "    var bracket = value.indexOf(' (');",
  "    if (bracket > 0) value = oneLine(value.slice(0, bracket));",
  "    if (value.length <= SOURCE_LABEL_MAX) return value;",
  "    var cut = value.slice(0, SOURCE_LABEL_MAX);",
  "    var space = cut.lastIndexOf(' ');",
  "    if (space > 4) cut = cut.slice(0, space);",
  "    return cut + ELLIPSIS;",
  "  }",
  "",
  "  /**",
  "   * Where a lane listens: the input's name, and mono or stereo.",
  "   *",
  "   * The name is the opened input's own label (an arm remembers it), shortened to",
  "   * one line; an arm whose browser gave no label yet is named by the input a new",
  "   * arm asks for, numbered from one. The channel count is the arm's own, by",
  "   * name, because that is what decides whether an amp sums the signal to mono.",
  "   *",
  "   * @param {object} entry - the armed input ({label, channels})",
  "   * @param {number} trackIndex - where the track sits, for a nameless input",
  "   * @returns {string} e.g. input 1 middot mono",
  "   */",
  "  function sourceLabel(entry, trackIndex) {",
  "    var armed = entry && typeof entry === 'object' ? entry : {};",
  "    var label = shortenedLabel(armed.label);",
  "    if (!label) {",
  "      var index = readingOf(trackIndex);",
  "      if (index === null || index < 0) index = 0;",
  "      label = SOURCE_FALLBACK_PREFIX + String(Math.floor(index) + 1);",
  "    }",
  "    var channels = readingOf(armed.channels);",
  "    var countText = channels === 1 ? MONO_TEXT : STEREO_TEXT;",
  "    return label + ' ' + MIDDLE_DOT + ' ' + countText;",
  "  }",
  "",
  "  window.StudioRecordView = {",
  "    DB_FLOOR: DB_FLOOR,",
  "    DB_TOP: DB_TOP,",
  "    PEAK_FALL_DB_PER_SECOND: PEAK_FALL_DB_PER_SECOND,",
  "    SOURCE_LABEL_MAX: SOURCE_LABEL_MAX,",
  "    dbOf: dbOf,",
  "    meterFill: meterFill,",
  "    PeakHold: PeakHold,",
  "    WaveRing: WaveRing,",
  "    columnX: columnX,",
  "    chainLabel: chainLabel,",
  "    sourceLabel: sourceLabel",
  "  };",
  "})();",
].join("\n");

/**
 * The record view's rules, evaluated from the very string the page inlines.
 *
 * `new Function` with a `window` parameter means the script's one global lands
 * on the object this module keeps, and never on Node's `globalThis`.
 */
const recordViewApi = new Function(
  "window",
  `${RECORD_VIEW_SCRIPT}\nreturn window.StudioRecordView;`,
)({});

/** The floor of a level reading: silence reads as this, never as NaN. */
export const DB_FLOOR = recordViewApi.DB_FLOOR;

/** The top of a meter: full scale. */
export const DB_TOP = recordViewApi.DB_TOP;

/** How fast a held peak falls once its hold is over, in dB per second. */
export const PEAK_FALL_DB_PER_SECOND = recordViewApi.PEAK_FALL_DB_PER_SECOND;

/** How much of a device name a lane shows before it is cut. */
export const SOURCE_LABEL_MAX = recordViewApi.SOURCE_LABEL_MAX;

/**
 * One linear amplitude as a level in dB, floored at -60 and never NaN.
 * @param {number} linear
 * @returns {number}
 */
export function dbOf(linear) {
  return recordViewApi.dbOf(linear);
}

/**
 * One level as the fill of a meter: 0 at -60 dB, 1 at full scale.
 * @param {number} db
 * @returns {number} 0..1
 */
export function meterFill(db) {
  return recordViewApi.meterFill(db);
}

/**
 * The song frame a lane column starts at, as a lane column index.
 * @param {number} songFrame
 * @param {number} passStartFrame
 * @param {number} passFrames
 * @param {number} widthCols
 * @returns {number} the column, or -1 for a frame outside the pass
 */
export function columnX(songFrame, passStartFrame, passFrames, widthCols) {
  return recordViewApi.columnX(songFrame, passStartFrame, passFrames, widthCols);
}

/**
 * What a lane says its chain is.
 * @param {object} snap
 * @param {string} trackId
 * @param {boolean} monitorOn
 * @returns {string} `amp on`, `amp off`, or empty
 */
export function chainLabel(snap, trackId, monitorOn) {
  return recordViewApi.chainLabel(snap, trackId, monitorOn);
}

/**
 * Where a lane listens: the input's name and the channel count by name.
 * @param {object} entry - the armed input
 * @param {number} trackIndex
 * @returns {string} e.g. `input 1 · mono`
 */
export function sourceLabel(entry, trackIndex) {
  return recordViewApi.sourceLabel(entry, trackIndex);
}

/** One track's held peak. */
export const PeakHold = recordViewApi.PeakHold;

/** The live waveform's draw ring. */
export const WaveRing = recordViewApi.WaveRing;