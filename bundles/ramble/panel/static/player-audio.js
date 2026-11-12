/* Ramble player voice script -- dependency-free, dual Node/browser. No ESM.
 *
 * cuesFor turns one session segment into the lines the player speaks while it
 * runs: an array of { at, text }, where at is seconds after the segment
 * starts. scriptFor is the same list of plain strings.
 *
 * Every spoken line comes from the voice lines object (the shape of
 * server/moves/voice.en.json); this file never writes its own words. A line
 * that is missing, empty or not a string is simply not spoken, so a partial or
 * empty lines object is safe and nothing throws.
 *
 * Pure by design: no DOM, no storage, no speech. The player owns the clock and
 * the speaking; this file only decides what is said and when.
 *
 * Guidance levels: "full" (the default) speaks the lead-in, the step's own
 * line, mid-hold lines, rep counts and the close; "names" speaks lead-ins
 * only; "first" speaks just the session's first lead-in; "memory" is silent.
 *
 * NO TEMPLATE LITERALS anywhere in this file -- panel scripts are handled by
 * tooling that treats backticks as its own delimiter, so string concatenation
 * is the house style here too.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RamblePlayerAudio = api;
})(this, function () {
  "use strict";

  var WORK_TYPES = { hold: true, timed: true, reps: true };
  var FULL = "full";
  var NAMES = "names";
  var FIRST = "first";
  var MEMORY = "memory";
  var DEFAULT_REP_UP_TO = 10;
  var DEFAULT_THEN_EVERY = 2;
  var MID_HOLD_MIN_SECONDS = 20;

  /* ---------- small helpers ---------- */

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function textOf(value) {
    return typeof value === "string" ? value : "";
  }

  /* A number from a number or a numeric string; anything else is the
   * fallback (a missing field must not read as zero). */
  function numberOr(value, fallback) {
    if (typeof value === "number") return isFinite(value) ? value : fallback;
    if (typeof value === "string" && value !== "") {
      var parsed = Number(value);
      return isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
  }

  /* One named group of lines (leadIn, close, rest, reps, sides). */
  function group(source, key) {
    if (!isObject(source)) return null;
    var value = source[key];
    return isObject(value) ? value : null;
  }

  /* One named list of lines (midHold, reps.numbers). */
  function list(source, key) {
    if (!isObject(source)) return [];
    var value = source[key];
    return Array.isArray(value) ? value : [];
  }

  function tidy(text) {
    return text
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/^\s+/, "")
      .replace(/\s+$/, "");
  }

  /* Fill {placeholders} from values. A placeholder with no usable value is
   * dropped, and the surrounding space with it, so a half-known line cannot
   * be spoken with a hole in it. */
  function fill(text, values) {
    var src = isObject(values) ? values : {};
    var source = textOf(text);
    if (source === "") return "";
    var out = source.replace(/\{(\w+)\}/g, function (whole, key) {
      if (!Object.prototype.hasOwnProperty.call(src, key)) return "";
      var value = src[key];
      if (typeof value === "number" && isFinite(value)) return String(value);
      if (typeof value === "string" && value !== "") return value;
      return "";
    });
    return tidy(out);
  }

  function guidanceOf(guidance) {
    if (guidance === MEMORY || guidance === NAMES || guidance === FIRST) return guidance;
    return FULL;
  }

  function isWork(segment) {
    return isObject(segment) && WORK_TYPES[segment.type] === true;
  }

  function settingsOf(ctx) {
    return isObject(ctx) ? ctx : {};
  }

  /* One cue, from a line already looked up (and filled where the line has
   * placeholders). An empty line is not spoken at all. */
  function pushCue(cues, at, text) {
    var line = tidy(textOf(text));
    if (line === "") return;
    if (!isFinite(at)) return;
    cues.push({ at: at, text: line });
  }

  function byAt(a, b) {
    return a.at - b.at;
  }

  /* ---------- lead-in (every level except memory) ---------- */

  function sideWordOf(sides, side) {
    if (!isObject(sides) || typeof side !== "string" || side === "") return "";
    return textOf(sides[side]);
  }

  function leadInLine(segment, lines, settings, name) {
    var lead = group(lines, "leadIn");
    if (!lead) return "";
    if (settings.isFirstWork) return fill(lead.first, { name: name });
    if (settings.isLastWork) return fill(lead.last, { name: name });
    if (typeof segment.side === "string" && segment.side !== "") {
      var side = sideWordOf(group(lines, "sides"), segment.side);
      if (side === "") return "";
      return fill(lead.nextSide, { name: name, side: side });
    }
    return fill(lead.next, { name: name });
  }

  function addLeadIn(cues, segment, lines, settings, level) {
    if (settings.entryStart !== true) return;
    if (level === FIRST && !settings.isFirstWork) return;
    var name = textOf(settings.name);
    if (name === "") return;
    pushCue(cues, 0, leadInLine(segment, lines, settings, name));
  }

  /* ---------- full guidance: the work itself ---------- */

  function addSay(cues, segment) {
    pushCue(cues, 0, segment.say);
  }

  function midHoldIndex(seed, length) {
    var value = Math.floor(numberOr(seed, 0));
    if (!isFinite(value)) value = 0;
    return ((value % length) + length) % length;
  }

  function addMidHold(cues, segment, lines, settings) {
    if (segment.type !== "hold") return;
    var seconds = numberOr(segment.seconds, 0);
    if (seconds < MID_HOLD_MIN_SECONDS) return;
    var spoken = list(lines, "midHold");
    if (spoken.length === 0) return;
    var index = midHoldIndex(settings.seed, spoken.length);
    pushCue(cues, seconds / 2, spoken[index]);
  }

  function addReps(cues, segment, lines) {
    if (segment.type !== "reps") return;
    var reps = Math.floor(numberOr(segment.reps, 0));
    if (reps < 1) return;
    var seconds = numberOr(segment.seconds, 0);
    if (seconds <= 0) return;
    var rules = group(lines, "reps");
    var upTo = numberOr(rules && rules.everyRepUpTo, DEFAULT_REP_UP_TO);
    var every = Math.floor(numberOr(rules && rules.thenEvery, DEFAULT_THEN_EVERY));
    if (every < 1) every = 1;
    var numbers = list(rules, "numbers");
    var lastRep = rules ? rules.lastRep : "";
    for (var i = 1; i <= reps; i += 1) {
      if (reps > upTo && i !== reps && i % every !== 0) continue;
      var line = i === reps ? lastRep : numbers[i - 1];
      pushCue(cues, seconds * (i - 0.5) / reps, line);
    }
  }

  function closeKey(segment) {
    if (segment.type === "hold") {
      return typeof segment.side === "string" && segment.side !== "" ? "side" : "hold";
    }
    if (segment.type === "timed") return "timed";
    if (segment.type === "reps") return "reps";
    return "";
  }

  function addClose(cues, segment, lines) {
    var key = closeKey(segment);
    if (key === "") return;
    var seconds = numberOr(segment.seconds, 0);
    if (seconds <= 0) return;
    var close = group(lines, "close");
    if (!close) return;
    pushCue(cues, seconds, close[key]);
  }

  /* ---------- full guidance: the quiet segments ---------- */

  function addSwitchSides(cues, lines) {
    var line = isObject(lines) ? lines.switchSides : null;
    pushCue(cues, 0, line);
  }

  function addRest(cues, next, lines, settings) {
    if (!isWork(next)) return;
    var nextName = textOf(settings.nextName);
    if (nextName === "") return;
    var rest = group(lines, "rest");
    if (!rest) return;
    pushCue(cues, 0, fill(rest.withNext, { next: nextName }));
  }

  /* ---------- the two entry points ---------- */

  function cuesFor(segment, next, lines, guidance, ctx) {
    var cues = [];
    var level = guidanceOf(guidance);
    if (level === MEMORY || !isObject(segment)) return cues;
    var settings = settingsOf(ctx);

    if (isWork(segment)) addLeadIn(cues, segment, lines, settings, level);
    if (level !== FULL) return cues;

    if (isWork(segment)) {
      addSay(cues, segment);
      addMidHold(cues, segment, lines, settings);
      addReps(cues, segment, lines);
      addClose(cues, segment, lines);
    } else if (segment.type === "switch-sides") {
      addSwitchSides(cues, lines);
    } else if (segment.type === "rest") {
      addRest(cues, next, lines, settings);
    }

    return cues.sort(byAt);
  }

  function scriptFor(segment, next, lines, guidance, ctx) {
    return cuesFor(segment, next, lines, guidance, ctx).map(function (cue) {
      return cue.text;
    });
  }

  return {
    cuesFor: cuesFor,
    scriptFor: scriptFor,
    fill: fill
  };
});
