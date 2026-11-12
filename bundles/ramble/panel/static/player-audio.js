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
 * cuesFor and scriptFor are pure: no DOM, no storage, no speech. The player
 * owns the clock; those two only decide what is said and when.
 *
 * attach(player, opts) is the other half: it takes the player's events, speaks
 * each cue at its own second through the platform's speech synthesiser, plays
 * a small chime, tick and the two toggle buttons, and remembers the two
 * choices on the device. It never waits for speech -- the clock is the
 * player's and every spoken line is fire-and-forget -- and every platform
 * call (speech, tone, storage, DOM) is wrapped, so a device without a voice, a
 * broken synthesiser or no storage at all simply goes quiet instead of
 * throwing.
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

  /* ================= the player's voice, tones and toggles ================= */

  var VOICE_KEY = "ramble.player.voice";
  var SOUND_KEY = "ramble.player.sound";
  var DEFAULT_RATE = 0.9;
  var CHIME_TONE = { freq: 880, seconds: 0.25 };
  var TICK_TONE = { freq: 660, seconds: 0.06 };
  var TONE_GAIN = 0.1;
  var TONE_ATTACK_SECONDS = 0.02;
  var CHIME_LEAD_SECONDS = 0.4;
  var HOLD_TICK_SECONDS = 3;

  /* ---------- the two platform defaults ---------- */

  function scopeOf(win) {
    if (win && (typeof win === "object" || typeof win === "function")) return win;
    if (typeof window !== "undefined" && window) return window;
    return null;
  }

  /* What the player talks through: the platform's synthesiser plus a way to
   * build one utterance. A missing synthesiser or utterance type means null,
   * so a device without speech gets the unavailable note instead. */
  function defaultSpeech(win) {
    try {
      var scope = scopeOf(win);
      if (!scope) return null;
      var synth = scope.speechSynthesis;
      var Utterance = scope.SpeechSynthesisUtterance;
      if (!synth || typeof Utterance !== "function") return null;
      return {
        synth: synth,
        utterance: function (text) {
          return new Utterance(textOf(text));
        }
      };
    } catch (err) {
      return null;
    }
  }

  /* A factory rather than a context: the context is made when the first tone is
   * due, so a page that is never started never holds one. */
  function defaultAudio(win) {
    try {
      var scope = scopeOf(win);
      if (!scope) return null;
      var Ctor = scope.AudioContext || scope.webkitAudioContext;
      if (typeof Ctor !== "function") return null;
      return function () {
        return new Ctor();
      };
    } catch (err) {
      return null;
    }
  }

  /* ---------- the saved choices ---------- */

  function readChoice(storage, key) {
    if (!storage || typeof storage.getItem !== "function") return true;
    try {
      var raw = storage.getItem(key);
      return raw === "0" ? false : true;
    } catch (err) {
      return true;
    }
  }

  function writeChoice(storage, key, on) {
    if (!storage || typeof storage.setItem !== "function") return;
    try {
      storage.setItem(key, on ? "1" : "0");
    } catch (err) {
      /* a device that cannot remember still works for this visit */
    }
  }

  /* ---------- the attachment ---------- */

  function attach(player, opts) {
    var options = isObject(opts) ? opts : {};
    var lines = isObject(options.lines) ? options.lines : {};
    var copy = isObject(options.copy) ? options.copy : {};
    var guidance = options.guidance;
    var host = options.host || null;
    var doc = options.doc || null;
    var storage = isObject(options.storage) ? options.storage : null;
    var rate = numberOr(options.rate, DEFAULT_RATE);
    if (!(rate > 0)) rate = DEFAULT_RATE;

    var speech = options.speech === undefined ? defaultSpeech(null) : options.speech;
    if (!isObject(speech)) speech = null;
    var audio = options.audio === undefined ? defaultAudio(null) : options.audio;
    if (typeof audio !== "function") audio = null;

    var timers = isObject(options.timers) ? options.timers : {};
    var setTimer = typeof timers.setTimeout === "function"
      ? function (fn, ms) { return timers.setTimeout(fn, ms); }
      : (typeof setTimeout === "function" ? function (fn, ms) { return setTimeout(fn, ms); } : null);
    var clearTimer = typeof timers.clearTimeout === "function"
      ? function (id) { timers.clearTimeout(id); }
      : (typeof clearTimeout === "function" ? function (id) { clearTimeout(id); } : null);

    var voiceChoice = readChoice(storage, VOICE_KEY);
    var soundChoice = readChoice(storage, SOUND_KEY);
    var pending = [];
    var destroyed = false;
    var segmentNow = null;
    var nextNow = null;
    var ctxNow = null;
    var context = null;
    var container = null;
    var drawn = [];
    var clicks = [];
    var voiceListener = null;
    var voiceProperty = false;
    var previousOnVoices = null;
    var lastAvailable = null;

    /* ---------- the platform wrappers ---------- */

    /* Voice is there only when the synthesiser can speak and can name at least
     * one voice. A thrown or empty answer is no voice, which is the note the
     * player shows; the voiceschanged watch below turns that into a toggle when
     * the device hands its voices over. */
    function available() {
      if (!speech || !isObject(speech.synth)) return false;
      if (typeof speech.synth.speak !== "function") return false;
      var voices = null;
      try {
        voices = speech.synth.getVoices();
      } catch (err) {
        return false;
      }
      if (!Array.isArray(voices)) return false;
      return voices.length > 0;
    }

    function cancelSpeech() {
      if (!speech || !isObject(speech.synth)) return;
      try {
        if (typeof speech.synth.cancel === "function") speech.synth.cancel();
      } catch (err) {
        /* a synthesiser that will not cancel has nothing to say */
      }
    }

    function sayText(text) {
      return fill(textOf(text), voiceValues());
    }

    function speakText(text) {
      if (!voiceChoice || !available()) return;
      var line = sayText(text);
      if (line === "") return;
      try {
        if (typeof speech.utterance !== "function") return;
        var utterance = speech.utterance(line);
        if (!utterance) return;
        utterance.rate = rate;
        speech.synth.speak(utterance);
      } catch (err) {
        /* speaking is best effort: a silent turn is not a failed session */
      }
    }

    function speakLine(text) {
      var line = tidy(textOf(text));
      if (line === "") return;
      speakText(line);
    }

    /* ---------- the timers ---------- */

    function clearScheduled() {
      for (var i = 0; i < pending.length; i += 1) {
        try {
          if (clearTimer) clearTimer(pending[i]);
        } catch (err) {
          /* a clock that will not clear one still drops the rest */
        }
      }
      pending.length = 0;
    }

    function later(delaySeconds, run) {
      if (!setTimer) return;
      var wait = numberOr(delaySeconds, 0);
      var ms = Math.round((wait > 0 ? wait : 0) * 1000);
      var id = null;
      try {
        id = setTimer(function () {
          try {
            run();
          } catch (err) {
            /* a cue that cannot be spoken is skipped, never thrown */
          }
        }, ms);
      } catch (err) {
        return;
      }
      if (id !== null && id !== undefined) pending.push(id);
    }

    /* ---------- the tones ---------- */

    function ensureContext() {
      if (context) return context;
      if (!audio) return null;
      var made = null;
      try {
        made = audio();
      } catch (err) {
        made = null;
      }
      if (!made || typeof made !== "object") return null;
      context = made;
      try {
        if (typeof context.resume === "function" && context.state === "suspended") context.resume();
      } catch (err) {
        /* a context that will not resume still gets scheduled tones */
      }
      return context;
    }

    function setGain(gain, start, seconds) {
      try {
        var param = gain && gain.gain;
        if (!param) return;
        if (typeof param.setValueAtTime === "function"
          && typeof param.linearRampToValueAtTime === "function") {
          param.setValueAtTime(0, start);
          param.linearRampToValueAtTime(TONE_GAIN, start + TONE_ATTACK_SECONDS);
          param.linearRampToValueAtTime(0, start + seconds);
          return;
        }
        param.value = TONE_GAIN;
      } catch (err) {
        /* an envelope that will not take is not worth a retry */
      }
    }

    /* One short tone at the context's current time plus the delay. Returns
     * whether it was actually scheduled, which is what decides the lead-in. */
    function tone(spec, delaySeconds) {
      if (!soundChoice) return false;
      var live = ensureContext();
      if (!live) return false;
      try {
        if (typeof live.createOscillator !== "function" || typeof live.createGain !== "function") {
          return false;
        }
        var offset = numberOr(live.currentTime, 0);
        var wait = numberOr(delaySeconds, 0);
        var start = offset + (wait > 0 ? wait : 0);
        var osc = live.createOscillator();
        var gain = live.createGain();
        if (!osc || !gain) return false;
        if (osc.frequency) osc.frequency.value = spec.freq;
        setGain(gain, start, spec.seconds);
        if (typeof osc.connect === "function" && typeof gain.connect === "function") {
          osc.connect(gain);
          gain.connect(live.destination);
        } else if (typeof osc.connect === "function") {
          osc.connect(live.destination);
        }
        if (typeof osc.start === "function") osc.start(start);
        if (typeof osc.stop === "function") osc.stop(start + spec.seconds);
        return true;
      } catch (err) {
        return false;
      }
    }

    /* ---------- the labels and the two buttons ---------- */

    function domReady() {
      return Boolean(host && doc
        && typeof doc.createElement === "function"
        && typeof host.appendChild === "function");
    }

    function voiceValues() {
      var settings = isObject(ctxNow) ? ctxNow : {};
      var segment = isObject(segmentNow) ? segmentNow : {};
      var values = {};
      var name = textOf(settings.name);
      if (name !== "") values.name = name;
      var next = textOf(settings.nextName);
      if (next !== "") values.next = next;
      var minutes = numberOr(settings.minutes, null);
      if (minutes !== null) values.minutes = minutes;
      var side = sideWordOf(group(lines, "sides"), segment.side);
      if (side !== "") values.side = side;
      var reps = numberOr(segment.reps, null);
      if (reps !== null) values.n = Math.floor(reps);
      return values;
    }

    function labelOf(key) {
      return sayText(copy[key]);
    }

    function makeNode(tag, role) {
      var node = null;
      try {
        node = doc.createElement(tag);
      } catch (err) {
        return null;
      }
      if (!node) return null;
      try {
        if (typeof node.setAttribute === "function") node.setAttribute("data-role", role);
      } catch (err) {
        /* a node that will not take its role is still usable */
      }
      return node;
    }

    function forgetClicks() {
      for (var i = 0; i < clicks.length; i += 1) {
        var entry = clicks[i];
        try {
          if (entry.node && typeof entry.node.removeEventListener === "function") {
            entry.node.removeEventListener(entry.type, entry.fn);
          }
        } catch (err) {
          /* the node is about to be dropped with its listeners */
        }
      }
      clicks.length = 0;
    }

    function clearDrawn() {
      forgetClicks();
      for (var i = 0; i < drawn.length; i += 1) {
        var node = drawn[i];
        if (!node || !container) continue;
        try {
          if (typeof container.removeChild === "function") container.removeChild(node);
        } catch (err) {
          /* already gone */
        }
      }
      drawn.length = 0;
    }

    function put(node) {
      if (!node || !container) return;
      try {
        container.appendChild(node);
      } catch (err) {
        return;
      }
      drawn.push(node);
    }

    function listen(node, type, fn) {
      try {
        if (typeof node.addEventListener !== "function") return;
        node.addEventListener(type, fn);
        clicks.push({ node: node, type: type, fn: fn });
      } catch (err) {
        /* a control that cannot listen simply does not flip */
      }
    }

    function makeButton(role, text, pressed, on) {
      var node = makeNode("button", role);
      if (!node) return null;
      try {
        if (typeof node.setAttribute === "function") {
          node.setAttribute("type", "button");
          node.setAttribute("aria-pressed", pressed ? "true" : "false");
        }
      } catch (err) {
        /* the word below still shows */
      }
      node.textContent = text;
      listen(node, "click", on);
      return node;
    }

    function makeNote(role, text) {
      var node = makeNode("div", role);
      if (!node) return null;
      node.textContent = text;
      return node;
    }

    function draw() {
      if (!container) return;
      clearDrawn();
      var soundText = labelOf("player.sound");
      if (soundText !== "") {
        put(makeButton("sound-toggle", soundText, soundChoice, onSoundClick));
      }
      if (available()) {
        var voiceText = labelOf("player.voice");
        if (voiceText !== "") {
          put(makeButton("voice-toggle", voiceText, voiceChoice, onVoiceClick));
        }
        return;
      }
      var missingText = labelOf("player.voiceUnavailable");
      if (missingText !== "") put(makeNote("voice-unavailable", missingText));
    }

    function repaint() {
      if (destroyed || !domReady()) return;
      if (!container) {
        var node = makeNode("div", "audio-controls");
        if (!node) return;
        try {
          host.appendChild(node);
        } catch (err) {
          return;
        }
        container = node;
      }
      draw();
    }

    function onSoundClick() {
      setSound(!soundChoice);
    }

    function onVoiceClick() {
      setVoice(!voiceChoice);
    }

    /* ---------- voices that turn up after the page ---------- */

    function onVoicesChanged() {
      if (destroyed) return;
      var now = available();
      if (now === lastAvailable) return;
      lastAvailable = now;
      repaint();
    }

    function watchVoices() {
      var synth = speech && isObject(speech.synth) ? speech.synth : null;
      if (!synth || voiceListener || voiceProperty) return;
      try {
        if (typeof synth.addEventListener === "function") {
          synth.addEventListener("voiceschanged", onVoicesChanged);
          voiceListener = synth;
          return;
        }
      } catch (err) {
        /* no event route; try the property below */
      }
      try {
        previousOnVoices = synth.onvoiceschanged;
        synth.onvoiceschanged = function () {
          try {
            if (typeof previousOnVoices === "function") previousOnVoices.apply(null, arguments);
          } catch (err) {
            /* someone else's handler is their own business */
          }
          onVoicesChanged();
        };
        voiceProperty = true;
      } catch (err) {
        /* a synthesiser with neither route never reports its voices */
      }
    }

    function unwatchVoices() {
      if (voiceListener) {
        try {
          if (typeof voiceListener.removeEventListener === "function") {
            voiceListener.removeEventListener("voiceschanged", onVoicesChanged);
          }
        } catch (err) {
          /* the synthesiser is going away with us */
        }
        voiceListener = null;
      }
      if (voiceProperty) {
        try {
          if (speech && isObject(speech.synth)) speech.synth.onvoiceschanged = previousOnVoices;
        } catch (err) {
          /* leave it as it is */
        }
        voiceProperty = false;
      }
    }

    /* ---------- one segment's cues, its chime and its ticks ---------- */

    function speakAt(delaySeconds, text) {
      if (tidy(textOf(text)) === "") return;
      later(delaySeconds, function () {
        speakText(text);
      });
    }

    function playTicks(segment, from, resuming) {
      var seconds = numberOr(segment.seconds, 0);
      if (!(seconds > 0)) return;
      for (var back = HOLD_TICK_SECONDS; back >= 1; back -= 1) {
        var at = seconds - back;
        if (at < 0) continue;
        if (!(at > from)) continue;
        tone(TICK_TONE, resuming ? at - from : at);
      }
    }

    function playSegment(segment, from, resuming) {
      if (!isObject(segment)) return;
      var elapsed = numberOr(from, 0);
      if (!(elapsed >= 0)) elapsed = 0;
      var cues = [];
      try {
        cues = cuesFor(segment, nextNow, lines, guidance, ctxNow);
      } catch (err) {
        cues = [];
      }
      var chimed = false;
      if (!resuming && isWork(segment)) chimed = tone(CHIME_TONE, 0);
      var lead = chimed ? CHIME_LEAD_SECONDS : 0;
      for (var i = 0; i < cues.length; i += 1) {
        var cue = cues[i];
        var at = numberOr(cue && cue.at, null);
        if (at === null) continue;
        var delay = 0;
        if (resuming) {
          if (!(at > elapsed)) continue;
          delay = at - elapsed;
        } else {
          if (at < 0) continue;
          delay = at === 0 ? lead : at;
        }
        speakAt(delay, cue.text);
      }
      if (segment.type === "hold") playTicks(segment, elapsed, resuming);
    }

    /* ---------- the player's events ---------- */

    function onEvent(ev) {
      if (destroyed) return;
      var event = isObject(ev) ? ev : {};
      var type = textOf(event.type);
      if (type === "segment") {
        clearScheduled();
        cancelSpeech();
        segmentNow = isObject(event.segment) ? event.segment : null;
        nextNow = isObject(event.next) ? event.next : null;
        ctxNow = isObject(event.ctx) ? event.ctx : null;
        playSegment(segmentNow, 0, false);
        return;
      }
      if (type === "pause") {
        clearScheduled();
        cancelSpeech();
        speakLine(lines.paused);
        return;
      }
      if (type === "resume") {
        clearScheduled();
        if (isObject(event.segment)) segmentNow = event.segment;
        if (isObject(event.next)) nextNow = event.next;
        if (isObject(event.ctx)) ctxNow = event.ctx;
        speakLine(lines.resume);
        playSegment(segmentNow, numberOr(event.elapsed, 0), true);
        return;
      }
      if (type === "ended" || type === "left") {
        clearScheduled();
        cancelSpeech();
      }
    }

    /* ---------- the two choices ---------- */

    function setVoice(on) {
      if (destroyed) return;
      voiceChoice = Boolean(on);
      writeChoice(storage, VOICE_KEY, voiceChoice);
      if (!voiceChoice) {
        cancelSpeech();
        clearScheduled();
      }
      repaint();
    }

    function setSound(on) {
      if (destroyed) return;
      soundChoice = Boolean(on);
      writeChoice(storage, SOUND_KEY, soundChoice);
      repaint();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearScheduled();
      cancelSpeech();
      clearDrawn();
      if (container) {
        try {
          if (host && typeof host.removeChild === "function") host.removeChild(container);
        } catch (err) {
          /* already out of the page */
        }
        container = null;
      }
      unwatchVoices();
    }

    /* ---------- start it up ---------- */

    watchVoices();
    lastAvailable = available();
    repaint();

    return {
      onEvent: onEvent,
      setVoice: setVoice,
      setSound: setSound,
      available: available,
      voiceOn: function () { return voiceChoice; },
      soundOn: function () { return soundChoice; },
      destroy: destroy
    };
  }

  return {
    cuesFor: cuesFor,
    scriptFor: scriptFor,
    fill: fill,
    attach: attach,
    defaultSpeech: defaultSpeech,
    defaultAudio: defaultAudio
  };
});
