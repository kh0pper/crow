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

  /* The library's entries by id, whichever way the library was handed in. The
   * sheet reads one entry's own steps from here. */
  function entriesById(library) {
    var byId = Object.create(null);
    var entries = entriesOf(library);
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      if (!entry || typeof entry.id !== "string" || entry.id === "") continue;
      byId[entry.id] = entry;
    }
    return byId;
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
          return {
            layout: null, started: false, segmentIndex: 0, paused: true,
            ended: false, sheetOpen: false
          };
        }
      };
    }

    var copy = (options.copy && typeof options.copy === "object") ? options.copy : {};
    /* The controls ask the page for a wake lock while the session runs and
     * report each move to a page-supplied listener; posting and storing come
     * later. */
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
    var entryById = entriesById(options.library);

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

    /* Put a node that comes and goes (the sheet) back on screen, without ever
     * listing it twice for destroy(). */
    function attach(node) {
      if (!node) return;
      if (node.parentNode !== host) host.appendChild(node);
      if (nodes.indexOf(node) < 0) nodes.push(node);
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
    var pauseText = copyString("player.pause");
    var keepGoingText = copyString("player.keepGoing");
    var pausedText = copyString("player.paused");
    var backText = copyString("player.back");
    var skipText = copyString("player.skip");
    var setDoneText = copyString("player.setDone");
    var skipRestText = copyString("player.rest.skip");
    var moreText = copyString("player.more");

    /* A control exists only when the page's copy carries its word. */
    function makeButton(role, label) {
      if (label === "") return null;
      var node = build("button", role);
      node.setAttribute("type", "button");
      node.textContent = label;
      return node;
    }

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
    els.transport = build("div", "transport");
    els.back = makeButton("back", backText);
    els.skip = makeButton("skip", skipText);
    els.setDone = makeButton("set-done", setDoneText);
    els.skipRest = makeButton("skip-rest", skipRestText);
    els.more = makeButton("more", moreText);
    els.pause = makeButton("pause", pauseText);
    els.status = pausedText === "" ? null : build("div", "status");
    if (els.status) els.status.textContent = pausedText;
    els.strip = build("div", "strip");
    /* The sheet's own words are the entry's title and its steps (library data)
     * plus the page's Back. It is put on the host when it opens. */
    els.sheet = build("div", "sheet");
    els.sheet.setAttribute("role", "dialog");
    els.sheet.setAttribute("aria-modal", "true");
    els.sheetTitle = build("div", "sheet-title");
    els.sheetSteps = build("div", "sheet-steps");
    els.sheetClose = makeButton("sheet-close", backText);
    els.sheet.appendChild(els.sheetTitle);
    els.sheet.appendChild(els.sheetSteps);
    if (els.sheetClose) els.sheet.appendChild(els.sheetClose);

    append(els.safety);
    if (startText !== "") append(els.start);
    append(els.figure);
    append(els.name);
    append(els.cue);
    append(els.clock);
    append(els.next);
    append(els.progress);
    append(els.transport);
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

    /* ---------- the controls ---------- */

    var lastReportedIndex = 0;
    var sheetOpen = false;
    var stripHandlers = [];

    /* A page listener that throws is its own problem; the session goes on. */
    function report(event) {
      if (!hooks.onEvent) return;
      try {
        hooks.onEvent(event);
      } catch (err) {
        /* swallowed on purpose */
      }
    }

    function segmentTypeNow() {
      var segment = segmentAt(clock.state().segmentIndex);
      return segment ? segment.type : null;
    }

    /* ---------- the wake lock ---------- */

    var wakeWanted = false;
    var wakeHandle = null;

    function releaseWakeHandle(handle) {
      if (!handle || typeof handle.release !== "function") return;
      try {
        handle.release();
      } catch (err) {
        /* its own problem */
      }
    }

    /* A page that offers no wake lock, or refuses one, never hears about it. */
    function takeWakeLock() {
      wakeWanted = true;
      var lock = hooks.wakeLock;
      if (!lock || typeof lock.request !== "function") return;
      var result;
      try {
        result = lock.request();
      } catch (err) {
        return;
      }
      if (!result || typeof result.then !== "function") {
        if (wakeWanted) wakeHandle = result;
        else releaseWakeHandle(result);
        return;
      }
      try {
        result.then(function (handle) {
          if (!wakeWanted) {
            releaseWakeHandle(handle);
            return;
          }
          wakeHandle = handle;
        }, function () {
          return undefined;
        });
      } catch (err) {
        return;
      }
    }

    function dropWakeLock() {
      wakeWanted = false;
      var handle = wakeHandle;
      wakeHandle = null;
      releaseWakeHandle(handle);
    }

    /* ---------- pause and play ---------- */

    function pauseNow() {
      if (!started) return;
      if (clock.state().paused) return;
      clock.pause();
      dropWakeLock();
      report({ type: "pause" });
    }

    function playNow(asking) {
      clock.play();
      takeWakeLock();
      if (asking) report({ type: "resume" });
    }

    function onPauseClick() {
      if (!started) return;
      if (clock.state().paused) playNow(true);
      else pauseNow();
    }

    function onBackClick() {
      clock.back();
    }

    function onSkipClick() {
      clock.skip();
    }

    function onSetDoneClick() {
      clock.skip();
    }

    function onSkipRestClick() {
      clock.skip();
    }

    /* ---------- the sheet ---------- */

    function clearChildren(node) {
      if (!node) return;
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    /* A library step is a string or { text, cue, say, at }; its text is its own
     * data, never copy. */
    function stepTextOf(step) {
      if (typeof step === "string") return step;
      if (step && typeof step.text === "string") return step.text;
      return "";
    }

    function entryAt(index) {
      var segment = segmentAt(index);
      if (!segment || typeof segment.entryId !== "string") return null;
      var entry = entryById[segment.entryId];
      return entry && typeof entry === "object" ? entry : null;
    }

    function openSheet() {
      var entry = entryAt(clock.state().segmentIndex);
      els.sheetTitle.textContent = entry && typeof entry.title === "string" ? entry.title : "";
      clearChildren(els.sheetSteps);
      var steps = entry && Array.isArray(entry.steps) ? entry.steps : [];
      for (var i = 0; i < steps.length; i += 1) {
        var step = build("div", "sheet-step");
        step.textContent = stepTextOf(steps[i]);
        els.sheetSteps.appendChild(step);
      }
      attach(els.sheet);
      sheetOpen = true;
      if (!clock.state().paused) pauseNow();
      paint();
    }

    function onMoreClick() {
      openSheet();
    }

    /* Closing never starts the clock again: the person says when to go on. */
    function onSheetCloseClick() {
      if (!sheetOpen) return;
      sheetOpen = false;
      removeNode(els.sheet, host);
      paint();
    }

    /* The row of controls holds exactly the buttons this segment offers, in
     * one order, so a repaint never reshuffles them. */
    function paintTransport() {
      var snap = clock.state();
      var type = segmentTypeNow();
      var wanted = [];
      if (els.back) wanted.push(els.back);
      if (els.skip) wanted.push(els.skip);
      if (els.setDone && started && type === "reps") wanted.push(els.setDone);
      if (els.skipRest && started && type === "rest") wanted.push(els.skipRest);
      if (els.more) wanted.push(els.more);
      if (els.pause && started) wanted.push(els.pause);
      if (els.status && started && snap.paused) wanted.push(els.status);
      if (els.pause) {
        var label = snap.paused && keepGoingText !== "" ? keepGoingText : pauseText;
        if (els.pause.textContent !== label) els.pause.textContent = label;
        els.pause.setAttribute("aria-pressed", snap.paused ? "true" : "false");
      }
      var current = [];
      for (var c = 0; c < els.transport.children.length; c += 1) {
        current.push(els.transport.children[c]);
      }
      var same = current.length === wanted.length;
      for (var i = 0; same && i < wanted.length; i += 1) {
        if (current[i] !== wanted[i]) same = false;
      }
      if (same) return;
      clearChildren(els.transport);
      for (var j = 0; j < wanted.length; j += 1) els.transport.appendChild(wanted[j]);
    }

    /* One strip child per work segment, carrying its place in the timeline: a
     * tap on one goes there. */
    function stripClick(index) {
      return function () {
        clock.seek(index);
      };
    }

    function buildStrip() {
      for (var i = 0; i < segments.length; i += 1) {
        if (!isWork(segments[i])) continue;
        var node = doc.createElement("button");
        node.setAttribute("type", "button");
        node.setAttribute("data-index", String(i));
        node.textContent = titleOf(segments[i].entryId);
        var handler = stripClick(i);
        node.addEventListener("click", handler);
        stripHandlers.push({ node: node, handler: handler });
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
      paintTransport();
      if (!started) {
        /* Nothing else is on screen yet, but a tap on the strip still marks the
         * step it went to. */
        paintStrip(clock.state().segmentIndex);
        return;
      }
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
      playNow(false);
      startInterval();
      paint();
    }

    /* A tab that goes away while the session runs is a pause, the same one the
     * pause button makes. */
    function onVisibilityChange() {
      var shown = documentOf();
      if (!shown || !shown.hidden) return;
      pauseNow();
    }

    els.start.addEventListener("click", onStart);
    if (els.pause) els.pause.addEventListener("click", onPauseClick);
    if (els.back) els.back.addEventListener("click", onBackClick);
    if (els.skip) els.skip.addEventListener("click", onSkipClick);
    if (els.setDone) els.setDone.addEventListener("click", onSetDoneClick);
    if (els.skipRest) els.skipRest.addEventListener("click", onSkipRestClick);
    if (els.more) els.more.addEventListener("click", onMoreClick);
    if (els.sheetClose) els.sheetClose.addEventListener("click", onSheetCloseClick);
    if (typeof doc.addEventListener === "function") {
      doc.addEventListener("visibilitychange", onVisibilityChange);
    }
    /* Every clock event (a new segment, play, pause, the end) repaints, and a
     * move to another segment is the page's to hear. Tick itself is never
     * called from here: a tick that is running would only read a zero-length
     * stretch. */
    unsubscribe = clock.on(function (event) {
      paint();
      if (!event || event.type !== "segment") return;
      var at = event.state && Number.isInteger(event.state.segmentIndex)
        ? event.state.segmentIndex
        : clock.state().segmentIndex;
      if (at === lastReportedIndex) return;
      lastReportedIndex = at;
      report({ type: "segment", index: at });
    });

    buildStrip();
    paintTransport();

    function state() {
      var snap = clock.state();
      return {
        layout: layout,
        started: started,
        segmentIndex: snap.segmentIndex,
        paused: snap.paused,
        ended: snap.ended,
        sheetOpen: sheetOpen
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
      dropWakeLock();
      els.start.removeEventListener("click", onStart);
      if (els.pause) els.pause.removeEventListener("click", onPauseClick);
      if (els.back) els.back.removeEventListener("click", onBackClick);
      if (els.skip) els.skip.removeEventListener("click", onSkipClick);
      if (els.setDone) els.setDone.removeEventListener("click", onSetDoneClick);
      if (els.skipRest) els.skipRest.removeEventListener("click", onSkipRestClick);
      if (els.more) els.more.removeEventListener("click", onMoreClick);
      if (els.sheetClose) els.sheetClose.removeEventListener("click", onSheetCloseClick);
      for (var s = 0; s < stripHandlers.length; s += 1) {
        stripHandlers[s].node.removeEventListener("click", stripHandlers[s].handler);
      }
      stripHandlers.length = 0;
      if (typeof doc.removeEventListener === "function") {
        doc.removeEventListener("visibilitychange", onVisibilityChange);
      }
      for (var i = 0; i < nodes.length; i += 1) removeNode(nodes[i], host);
      nodes.length = 0;
      stripNodes.length = 0;
      stripIndexes.length = 0;
    }

    return { destroy: destroy, state: state };
  }

  return { mount: mount };
});
