/* Ramble Moves player -- one step at a time, drawn from a compiled timeline.
 *
 * A classic browser script (no modules, no template literals) so the panel can
 * load it with a plain script tag next to figure.cjs and session.cjs. It draws
 * what the clock says and nothing else: the segment's own pose, the library
 * entry's own title and cue, and the next entry's name when the copy carries
 * that string. Every other word belongs to the page.
 *
 * mount(host, opts) -> { destroy(), state() }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RamblePlayer = api;
})(this, function () {
  "use strict";

  var WORK_TYPES = { hold: true, timed: true, reps: true };
  var TICK_MS = 250;
  var TWEEN_SECONDS = 1.2;

  /* ---------- the page around us ---------- */

  function globalScope() {
    if (typeof window !== "undefined" && window) return window;
    if (typeof globalThis !== "undefined" && globalThis) return globalThis;
    return {};
  }

  function documentOf() {
    var scope = globalScope();
    if (scope.document) return scope.document;
    if (typeof document !== "undefined" && document) return document;
    return null;
  }

  function sessionApi() {
    var scope = globalScope();
    return scope.RambleSession ? scope.RambleSession : null;
  }

  function figureApi() {
    var scope = globalScope();
    return scope.RambleFigure ? scope.RambleFigure : null;
  }

  function defaultSetInterval(fn, ms) {
    var scope = globalScope();
    if (typeof scope.setInterval === "function") return scope.setInterval(fn, ms);
    return null;
  }

  function defaultClearInterval(id) {
    var scope = globalScope();
    if (typeof scope.clearInterval === "function") scope.clearInterval(id);
  }

  /* ---------- small helpers ---------- */

  /* A copy string from the page's copy object, or "" when it carries none. */
  function fill(template, values) {
    if (typeof template !== "string") return "";
    return template.replace(/\{([a-z]+)\}/g, function (whole, key) {
      if (values && Object.prototype.hasOwnProperty.call(values, key)) return String(values[key]);
      return whole;
    });
  }

  /* The library as a plain list, whether the caller handed in an array or an
   * id -> entry map. */
  function entriesOf(library) {
    var out = [];
    if (Array.isArray(library)) return library;
    if (library && typeof library.forEach === "function" && typeof library.get === "function") {
      library.forEach(function (entry) { out.push(entry); });
    }
    return out;
  }

  /* The entries' own titles, by id. A title is library data, never copy. */
  function titlesOf(library) {
    var byId = Object.create(null);
    var entries = entriesOf(library);
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      if (!entry || typeof entry.id !== "string" || entry.id === "") continue;
      if (typeof entry.title === "string" && entry.title !== "") byId[entry.id] = entry.title;
    }
    return byId;
  }

  /* A page that names a layout gets it. Otherwise the host's own width
   * decides, and a host that reports no width at all is the bigger screen. */
  function pickLayout(host, wanted) {
    if (wanted === "phone" || wanted === "kiosk" || wanted === "class") return wanted;
    var width = host && typeof host.clientWidth === "number" ? host.clientWidth : 700;
    return width < 700 ? "phone" : "kiosk";
  }

  function prefersReducedMotion() {
    try {
      var scope = globalScope();
      if (typeof scope.matchMedia !== "function") return false;
      var query = scope.matchMedia("(prefers-reduced-motion: reduce)");
      return Boolean(query && query.matches);
    } catch (err) {
      return false;
    }
  }

  function clearHost(host) {
    if (!host || typeof host.removeChild !== "function") return;
    while (host.firstChild) host.removeChild(host.firstChild);
  }

  function removeNode(node, host) {
    if (!node) return;
    if (node.parentNode && typeof node.parentNode.removeChild === "function") {
      node.parentNode.removeChild(node);
      return;
    }
    if (host && typeof host.removeChild === "function") {
      try {
        host.removeChild(node);
      } catch (err) {
        /* already gone */
      }
    }
  }

  /* ---------- the player ---------- */

  function mount(host, opts) {
    var options = (opts && typeof opts === "object") ? opts : {};
    var doc = documentOf();
    var Session = sessionApi();
    if (!doc || !host || typeof host.appendChild !== "function" || !Session) {
      return {
        destroy: function () {},
        state: function () {
          return { layout: null, started: false, segmentIndex: 0, paused: true, ended: false };
        }
      };
    }

    var copy = (options.copy && typeof options.copy === "object") ? options.copy : {};
    /* Accepted for the steps after this one; this player neither posts, stores,
     * holds a wake lock nor reports yet. */
    var hooks = {
      post: typeof options.post === "function" ? options.post : null,
      storage: options.storage === undefined ? null : options.storage,
      wakeLock: options.wakeLock === undefined ? null : options.wakeLock,
      onEvent: typeof options.onEvent === "function" ? options.onEvent : null
    };
    var Figure = figureApi();
    var reduced = typeof options.reducedMotion === "boolean"
      ? options.reducedMotion
      : prefersReducedMotion();

    var layout = pickLayout(host, options.layout);
    host.setAttribute("data-layout", layout);

    var timeline = Session.compileSession(options.chain, options.library, {
      guidance: options.guidance
    });
    var segments = Array.isArray(timeline.segments) ? timeline.segments : [];
    var titleById = titlesOf(options.library);

    var timeSource = (options.clock && typeof options.clock === "object") ? options.clock : null;
    var nowFn = timeSource && typeof timeSource.now === "function"
      ? function () { return timeSource.now(); }
      : function () { return Date.now(); };
    var setIntervalFn = timeSource && typeof timeSource.setInterval === "function"
      ? function (fn, ms) { return timeSource.setInterval(fn, ms); }
      : defaultSetInterval;
    var clearIntervalFn = timeSource && typeof timeSource.clearInterval === "function"
      ? function (id) { return timeSource.clearInterval(id); }
      : defaultClearInterval;

    var clock = Session.createClock({ timeline: timeline, now: nowFn });

    /* ---------- the elements ---------- */

    clearHost(host);

    var nodes = [];
    var stripNodes = [];
    var stripIndexes = [];
    var els = {};

    function build(tag, role) {
      var node = doc.createElement(tag);
      node.setAttribute("data-role", role);
      return node;
    }

    function append(node) {
      if (!node) return;
      host.appendChild(node);
      nodes.push(node);
    }

    function copyString(key) {
      return typeof copy[key] === "string" ? copy[key] : "";
    }

    function titleOf(entryId) {
      if (typeof entryId !== "string" || entryId === "") return "";
      var title = titleById[entryId];
      return typeof title === "string" ? title : "";
    }

    var safetyText = copyString("safety");
    var startText = copyString("start");

    els.safety = safetyText === "" ? null : build("div", "safety");
    if (els.safety) els.safety.textContent = safetyText;
    els.start = build("button", "start");
    els.start.setAttribute("type", "button");
    if (startText !== "") els.start.textContent = startText;
    els.figure = build("div", "figure");
    els.name = build("div", "name");
    els.cue = build("div", "cue");
    els.clock = build("div", "clock");
    els.next = build("div", "next");
    els.progress = build("div", "progress");
    els.strip = build("div", "strip");

    append(els.safety);
    if (startText !== "") append(els.start);
    append(els.figure);
    append(els.name);
    append(els.cue);
    append(els.clock);
    append(els.next);
    append(els.progress);
    append(els.strip);

    /* ---------- what the clock says ---------- */

    var started = false;
    var intervalId = null;
    var intervalLive = false;
    var unsubscribe = null;

    function segmentAt(index) {
      return segments[index] ? segments[index] : null;
    }

    function isWork(segment) {
      return Boolean(segment) && WORK_TYPES[segment.type] === true;
    }

    function isNamed(segment) {
      return isWork(segment) || (Boolean(segment) && segment.type === "rest");
    }

    /* The first segment after the given index that the predicate accepts, or -1. */
    function findAfter(index, accepts) {
      for (var i = index + 1; i < segments.length; i += 1) {
        if (accepts(segments[i])) return i;
      }
      return -1;
    }

    /* A rest shows the figure it is resting before: the next segment's pose. */
    function poseFor(index) {
      var segment = segmentAt(index);
      if (!segment) return null;
      if (segment.type === "rest") {
        var next = segmentAt(index + 1);
        return next && next.toPose ? next.toPose : null;
      }
      return segment.toPose ? segment.toPose : null;
    }

    function figureHtml(index, segmentElapsed) {
      if (!Figure || typeof Figure.poseSvg !== "function") return "";
      var segment = segmentAt(index);
      if (!segment) return "";
      var toPose = poseFor(index);
      if (!toPose) return "";
      var pose = toPose;
      if (!reduced && isWork(segment)) {
        var span = Math.min(TWEEN_SECONDS, segment.seconds);
        var t = span > 0 ? Math.min(1, segmentElapsed / span) : 1;
        try {
          pose = Figure.interpolate(segment.fromPose, toPose, t);
        } catch (err) {
          pose = toPose;
        }
      }
      try {
        return Figure.poseSvg(pose);
      } catch (err) {
        return "";
      }
    }

    /* The segment whose title a name line shows. A transition, a switch of
     * sides or a chunk-break is quiet and keeps showing the step it moves
     * into; a rest shows the page's own rest word instead. */
    function nameIndexFor(index) {
      var segment = segmentAt(index);
      if (isWork(segment)) return index;
      if (segment && segment.type === "rest") return -1;
      return findAfter(index, isNamed);
    }

    function paintFigure(index, segmentElapsed) {
      els.figure.innerHTML = figureHtml(index, segmentElapsed);
    }

    function paintName(index) {
      var segment = segmentAt(index);
      if (segment && segment.type === "rest") {
        els.name.textContent = copyString("player.rest");
        return;
      }
      var at = nameIndexFor(index);
      els.name.textContent = at < 0 ? "" : titleOf(segments[at].entryId);
    }

    function paintCue(index) {
      var segment = segmentAt(index);
      els.cue.textContent = segment && typeof segment.cue === "string" ? segment.cue : "";
    }

    function paintNext(index) {
      var at = findAfter(index, isNamed);
      if (at < 0) {
        els.next.textContent = "";
        return;
      }
      var upcoming = segments[at];
      if (upcoming.type === "rest") {
        /* A rest has no title of its own: name what follows it. */
        var after = findAfter(at, isWork);
        var name = after < 0 ? "" : titleOf(segments[after].entryId);
        els.next.textContent = name === "" ? "" : fill(copyString("player.rest.next"), { name: name });
        return;
      }
      var title = titleOf(upcoming.entryId);
      els.next.textContent = title === "" ? "" : fill(copyString("player.next"), { name: title });
    }

    function secondsLeft(segment, segmentElapsed) {
      var left = segment.seconds - (typeof segmentElapsed === "number" ? segmentElapsed : 0);
      if (!(left > 0)) left = 0;
      return Math.ceil(left);
    }

    function paintClock(index, segmentElapsed) {
      var segment = segmentAt(index);
      if (!segment) {
        els.clock.textContent = "";
        return;
      }
      if (segment.type === "reps") {
        els.clock.textContent = segment.reps === null || segment.reps === undefined ? "" : String(segment.reps);
        return;
      }
      if (WORK_TYPES[segment.type] === true || segment.type === "rest") {
        els.clock.textContent = String(secondsLeft(segment, segmentElapsed));
        return;
      }
      els.clock.textContent = "";
    }

    function buildStrip() {
      for (var i = 0; i < segments.length; i += 1) {
        if (!isWork(segments[i])) continue;
        var node = doc.createElement("span");
        node.textContent = titleOf(segments[i].entryId);
        els.strip.appendChild(node);
        stripNodes.push(node);
        stripIndexes.push(i);
      }
    }

    function paintStrip(index) {
      for (var i = 0; i < stripNodes.length; i += 1) {
        if (stripIndexes[i] === index) stripNodes[i].setAttribute("data-current", "1");
        else stripNodes[i].removeAttribute("data-current");
      }
    }

    function paint() {
      if (!started) return;
      var snap = clock.state();
      var index = snap.segmentIndex;
      paintFigure(index, snap.segmentElapsed);
      paintName(index);
      paintCue(index);
      paintNext(index);
      paintClock(index, snap.segmentElapsed);
      paintStrip(index);
      els.progress.textContent = "";
    }

    /* ---------- the clock's own beat ---------- */

    function onTick() {
      clock.tick();
      paint();
    }

    function startInterval() {
      if (intervalLive) return;
      intervalLive = true;
      intervalId = setIntervalFn(onTick, TICK_MS);
    }

    function onStart() {
      if (started) return;
      started = true;
      removeNode(els.safety, host);
      removeNode(els.start, host);
      els.safety = null;
      clock.play();
      startInterval();
      paint();
    }

    els.start.addEventListener("click", onStart);
    /* Every clock event (a new segment, play, pause, the end) repaints. Tick
     * itself is never called from here: a tick that is running would only
     * read a zero-length stretch. */
    unsubscribe = clock.on(function () { paint(); });

    buildStrip();

    function state() {
      var snap = clock.state();
      return {
        layout: layout,
        started: started,
        segmentIndex: snap.segmentIndex,
        paused: snap.paused,
        ended: snap.ended
      };
    }

    function destroy() {
      if (intervalLive) {
        clearIntervalFn(intervalId);
        intervalLive = false;
        intervalId = null;
      }
      if (typeof unsubscribe === "function") {
        unsubscribe();
        unsubscribe = null;
      }
      els.start.removeEventListener("click", onStart);
      for (var i = 0; i < nodes.length; i += 1) removeNode(nodes[i], host);
      nodes.length = 0;
      stripNodes.length = 0;
      stripIndexes.length = 0;
    }

    return { destroy: destroy, state: state };
  }

  return { mount: mount };
});
