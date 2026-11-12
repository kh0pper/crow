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
  /* Where a report that could not be made waits, and how often the beat retries
   * it: every tenth tick, and never sooner than ten seconds after the last
   * try. */
  var QUEUE_KEY = "ramble.player.queue";
  var RETRY_TICKS = 10;
  var RETRY_MS = 10000;
  /* The most counted time a stored report is trusted for in one chunk: six
   * hours, more than any session the player can hold. */
  var MAX_STORED_SECONDS = 21600;

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

  /* The local day a moment falls on, as YYYY-MM-DD. */
  function localDay(ms) {
    var when = new Date(typeof ms === "number" && isFinite(ms) ? ms : Date.now());
    function pad(value) {
      return value < 10 ? "0" + value : String(value);
    }
    return when.getFullYear() + "-" + pad(when.getMonth() + 1) + "-" + pad(when.getDate());
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
            ended: false, sheetOpen: false, finished: false
          };
        }
      };
    }

    var copy = (options.copy && typeof options.copy === "object") ? options.copy : {};
    /* The page supplies the wake lock, the listener that hears each move, the
     * start that hands a chunk its card, the posting that decides Done and the
     * storage a resume record lives in. */
    var hooks = {
      start: typeof options.start === "function" ? options.start : null,
      post: typeof options.post === "function" ? options.post : null,
      storage: options.storage === undefined ? null : options.storage,
      wakeLock: options.wakeLock === undefined ? null : options.wakeLock,
      onEvent: typeof options.onEvent === "function" ? options.onEvent : null
    };
    /* What the page's day offers beyond this session: its next card and the
     * chunk that matches the area just worked. Either may be absent. */
    var offers = (options.offers && typeof options.offers === "object") ? options.offers : {};
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

    /* A record an earlier visit left behind, read before anything is built so
     * its line can sit with the page's own: the counts it holds are added to
     * what this visit earns, and the first Start picks up at its segment. */
    var resumeRecord = readResumeRecord();
    var base = resumeRecord ? resumeRecord.activeSeconds : [];
    var pendingSeek = resumeRecord ? resumeRecord.segmentIndex : null;

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
    var finishText = copyString("player.finishHere");
    var resumeLineText = copyString("today.card.resume");
    var doneCardText = copyString("today.card.isDone");
    var resumeCardText = copyString("today.card.resume");
    var notYetText = copyString("player.end.notYet");
    var endTitleText = copyString("player.end.title");
    var summaryText = copyString("player.end.summary");
    var oneMoreRoundText = copyString("player.end.oneMoreRound");
    var addTenText = copyString("player.end.addTen");
    var addTenNextText = copyString("player.end.addTen.nextCard");
    var thatsItText = copyString("player.end.thatsIt");
    var waterText = copyString("player.waterAndRest");
    var capText = copyString("player.sessionCap");

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
    els.resumeLine = resumeRecord && resumeLineText !== "" ? build("div", "resume-line") : null;
    if (els.resumeLine) els.resumeLine.textContent = resumeLineText;
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
    els.finish = makeButton("finish", finishText);
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
    /* The lines a visit leaves behind, and the end screen itself. Both are put
     * on the host only when there is something to show. */
    els.result = build("div", "result");
    els.end = build("div", "end");

    append(els.safety);
    if (startText !== "") append(els.start);
    if (els.resumeLine) append(els.resumeLine);
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
    /* Once a visit is over the transport stays away: the terminal flag says
     * the controls belong to no running session any more. */
    var finished = false;
    var endShown = false;
    var terminal = false;
    var addOptionsShown = false;

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
    /* The chunk the clock is in now; a move out of it is a report. */
    var chunkSeen = 0;
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

    /* ---------- chunk counts, posting and the resume record ---------- */

    function chunkCount() {
      return Array.isArray(timeline.chunks) ? timeline.chunks.length : 0;
    }

    function chunkIdOf(index) {
      var chunk = Array.isArray(timeline.chunks) ? timeline.chunks[index] : null;
      return chunk && typeof chunk.chunkId === "string" ? chunk.chunkId : "";
    }

    function plannedOf(index) {
      var chunk = Array.isArray(timeline.chunks) ? timeline.chunks[index] : null;
      return chunk && typeof chunk.plannedSeconds === "number" ? chunk.plannedSeconds : 0;
    }

    /* What an earlier visit already earned for one chunk. */
    function baseAt(index) {
      var value = base[index];
      return typeof value === "number" && isFinite(value) && value > 0 ? value : 0;
    }

    /* One chunk's active seconds now: whatever was restored plus what the clock
     * has counted since the mount. The clock counts a step's own time only, so
     * a rest, a pause and a skipped step add nothing here. */
    function activeAt(index, snap) {
      var counted = snap && Array.isArray(snap.activeSeconds) ? snap.activeSeconds[index] : 0;
      var seen = typeof counted === "number" && isFinite(counted) && counted > 0 ? counted : 0;
      return baseAt(index) + seen;
    }

    function activeList(snap) {
      var list = [];
      for (var i = 0; i < chunkCount(); i += 1) list.push(activeAt(i, snap));
      return list;
    }

    function totalActive(snap) {
      var list = activeList(snap);
      var total = 0;
      for (var i = 0; i < list.length; i += 1) total += list[i];
      return total;
    }

    function resumeKey() {
      var ids = [];
      for (var i = 0; i < chunkCount(); i += 1) ids.push(chunkIdOf(i));
      return "ramble.player.resume." + ids.join("|");
    }

    /* A page that offers no storage, or a storage that throws, is a page with
     * none: the session runs and nothing is remembered. */
    function storageGet(key) {
      var store = hooks.storage;
      if (!store || typeof store.getItem !== "function") return null;
      try {
        var value = store.getItem(key);
        return typeof value === "string" ? value : null;
      } catch (err) {
        return null;
      }
    }

    function storageSet(key, value) {
      var store = hooks.storage;
      if (!store || typeof store.setItem !== "function") return;
      try {
        store.setItem(key, value);
      } catch (err) {
        return;
      }
    }

    function storageDrop(key) {
      var store = hooks.storage;
      if (!store || typeof store.removeItem !== "function") return;
      try {
        store.removeItem(key);
      } catch (err) {
        return;
      }
    }

    /* ---------- the card a chunk posts against ---------- */

    /* One card per chunk of the chain, as the page's start answered it. */
    var cardKeys = [];
    var startWaiting = [];
    /* What each card has been told, by card key: the highest count
     * acknowledged, the highest already on its way, and the Done the page
     * answered. A visit starts with none of it, so no card of an earlier visit
     * speaks for one of this visit's. */
    var floors = new Map();
    /* The report a card of this visit is still waiting on, by card key. Only a
     * promise ever goes in here: sendOne reads it with .then. */
    var inFlight = new Map();
    /* The queued items on their way, by card key, so a queued send never stands
     * in for a promise and a card already being carried is not carried twice. */
    var queuedInFlight = new Map();
    /* This visit's own name in the queue, so two visits' keyless items are
     * never the same item. */
    var visitId = String(nowFn());
    /* Reports that could not be made: storage when the page has any, this
     * visit's memory when it has none. */
    var queue = readQueue();
    var ticks = 0;
    var lastRetryTick = 0;
    var lastRetryAt = nowFn();
    var destroyed = false;
    /* The chain being run: what the page handed in, or the longer one an
     * addition made. A start carries it, because the server plans a chunk's
     * time from the session that chunk belongs to. */
    var currentChain = Array.isArray(options.chain) ? options.chain : [];

    /* An item's place in the queue: the card it was stored for, or the chunk
     * it belongs to together with the visit that saw it, so two visits'
     * keyless items are never one item. */
    function queueIdOf(item) {
      var cardKey = item && typeof item.cardKey === "string" ? item.cardKey : "";
      if (cardKey !== "") return cardKey;
      var index = item && Number.isInteger(item.chunkIndex) ? item.chunkIndex : -1;
      var visit = item && typeof item.visit === "string" ? item.visit : "";
      return "#" + index + "@" + visit;
    }

    /* The key a chunk's report and its floor live under: the card the page's
     * start answered with, or the chunk's own name while it has none. */
    function floorKeyOf(index) {
      var key = cardKeys[index];
      return typeof key === "string" && key !== "" ? key : "#" + index;
    }

    /* The item a chunk of this visit stands for in the queue. */
    function queueRef(index, key) {
      return {
        cardKey: typeof key === "string" && key !== "" ? key : undefined,
        chunkIndex: index,
        visit: visitId
      };
    }

    /* The slot a chunk's start names: the page's own slot for the first chunk,
     * an extra for every chunk after it and for everything an addition adds. */
    function slotFor(index) {
      if (index === 0 && typeof options.cardSlot === "string" && options.cardSlot !== "") {
        return options.cardSlot;
      }
      return "extra";
    }

    /* A stored count outside what a chunk can hold is brought back inside it;
     * one that is no number at all is no count to send. */
    function clampSeconds(value) {
      if (typeof value !== "number" || !isFinite(value)) return null;
      if (value < 0) return 0;
      if (value > MAX_STORED_SECONDS) return MAX_STORED_SECONDS;
      return value;
    }

    /* The queue as storage kept it. Anything whose shape is not one this player
     * wrote is dropped, and a count outside what a chunk can hold is brought
     * back inside it. */
    function readQueue() {
      var raw = storageGet(QUEUE_KEY);
      if (raw === null || raw === "") return [];
      var data;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        return [];
      }
      if (!Array.isArray(data)) return [];
      var out = [];
      for (var i = 0; i < data.length; i += 1) {
        var item = data[i];
        if (!item || typeof item !== "object") continue;
        if (!Number.isInteger(item.chunkIndex) || item.chunkIndex < 0) continue;
        var seconds = clampSeconds(item.activeSeconds);
        if (seconds === null) continue;
        var one = {
          chunkIndex: item.chunkIndex,
          entryId: typeof item.entryId === "string" ? item.entryId : "",
          activeSeconds: seconds,
          visit: typeof item.visit === "string" ? item.visit : ""
        };
        if (typeof item.cardKey === "string" && item.cardKey !== "") one.cardKey = item.cardKey;
        out.push(one);
      }
      return out;
    }

    function saveQueue() {
      if (queue.length === 0) {
        storageDrop(QUEUE_KEY);
        return;
      }
      var plain = [];
      for (var i = 0; i < queue.length; i += 1) {
        var item = queue[i];
        var one = {
          chunkIndex: item.chunkIndex,
          entryId: item.entryId,
          activeSeconds: item.activeSeconds,
          visit: typeof item.visit === "string" ? item.visit : ""
        };
        if (typeof item.cardKey === "string" && item.cardKey !== "") one.cardKey = item.cardKey;
        plain.push(one);
      }
      storageSet(QUEUE_KEY, JSON.stringify(plain));
    }

    /* One item per card, and one per keyless chunk of a visit: the larger count
     * wins, because a report never goes backwards. */
    function enqueue(item) {
      var fresh = {
        cardKey: typeof item.cardKey === "string" && item.cardKey !== "" ? item.cardKey : undefined,
        chunkIndex: item.chunkIndex,
        entryId: item.entryId,
        activeSeconds: item.activeSeconds,
        visit: typeof item.visit === "string" && item.visit !== "" ? item.visit : visitId
      };
      var id = queueIdOf(fresh);
      var kept = [];
      var merged = fresh;
      for (var i = 0; i < queue.length; i += 1) {
        var one = queue[i];
        if (!one) continue;
        if (queueIdOf(one) === id) {
          if (one.activeSeconds > merged.activeSeconds) merged = one;
          continue;
        }
        kept.push(one);
      }
      kept.push(merged);
      queue = kept;
      saveQueue();
    }

    /* The item has been carried, or refused for good: it leaves the queue. */
    function dropQueued(item) {
      var id = queueIdOf(item);
      var kept = [];
      for (var i = 0; i < queue.length; i += 1) {
        var one = queue[i];
        if (!one) continue;
        if (queueIdOf(one) === id) continue;
        kept.push(one);
      }
      if (kept.length === queue.length) return;
      queue = kept;
      saveQueue();
    }

    /* A card's record for this visit, made when it is first read. */
    function floorOf(key) {
      var one = floors.get(key);
      if (!one) {
        one = { ack: null, sent: null, done: null };
        floors.set(key, one);
      }
      return one;
    }

    /* A count never goes backwards: what an earlier report said about a card,
     * or is saying now, is the floor for every later one. */
    function lastTold(key) {
      var one = floors.get(key);
      if (!one) return null;
      var sent = one.sent;
      var ack = one.ack;
      if (typeof sent === "number" && typeof ack === "number") return sent > ack ? sent : ack;
      if (typeof sent === "number") return sent;
      return typeof ack === "number" ? ack : null;
    }

    function raiseTo(key, seconds) {
      var told = lastTold(key);
      if (typeof told === "number" && seconds < told) return told;
      return seconds;
    }

    function acked(key, seconds) {
      var told = lastTold(key);
      return typeof told === "number" && told >= seconds;
    }

    function acknowledge(key, seconds) {
      var one = floorOf(key);
      if (typeof one.ack !== "number" || seconds > one.ack) one.ack = seconds;
      one.sent = null;
    }

    /* A count on its way to the page, so the same report is never sent twice
     * while the first one is still out. */
    function toldSent(key, seconds) {
      floorOf(key).sent = seconds;
    }

    /* A report that never landed says nothing about the card, so the count it
     * carried is not treated as told. */
    function forgetSent(key) {
      var one = floors.get(key);
      if (one) one.sent = null;
    }

    function rememberDone(key, done) {
      floorOf(key).done = done;
    }

    /* The card a chunk reports against. The page's start answers it once per
     * chunk; a start that refuses or says nothing is asked again at the next
     * report for that chunk, never twice at once. */
    function beginStart(index) {
      if (!hooks.start) return null;
      if (startWaiting[index]) return startWaiting[index];
      var body = {
        cardKey: slotFor(index),
        entryId: chunkIdOf(index),
        chain: currentChain
      };
      var answer;
      try {
        answer = hooks.start(body);
      } catch (err) {
        answer = null;
      }
      var waiting = Promise.resolve(answer).then(function (value) {
        startWaiting[index] = null;
        if (value && typeof value.cardKey === "string" && value.cardKey !== "") {
          cardKeys[index] = value.cardKey;
        }
        var key = cardKeys[index];
        return typeof key === "string" && key !== "" ? key : null;
      }, function () {
        startWaiting[index] = null;
        return null;
      });
      startWaiting[index] = waiting;
      return waiting;
    }

    /* The start a report for this chunk is still waiting for, or null when the
     * card is already in hand (or the page has no start to ask). */
    function startFor(index) {
      if (!hooks.start) return null;
      var key = cardKeys[index];
      if (typeof key === "string" && key !== "") return null;
      return beginStart(index);
    }

    /* The result a report's answer carries, whether the page answered with it
     * or wrapped it in a progress field. */
    function progressOf(answer) {
      if (answer && typeof answer === "object" && answer.progress
          && typeof answer.progress === "object") {
        return answer.progress;
      }
      return answer;
    }

    /* One queued item is on its way at a time: the post decides what happens
     * to it, so a retry never talks over one already sent. */
    function sendQueued(item) {
      if (destroyed || !item || !hooks.post) return;
      var key = typeof item.cardKey === "string" && item.cardKey !== "" ? item.cardKey : "";
      if (key === "") {
        sendKeylessQueued(item);
        return;
      }
      sendQueuedAgainst(item, key);
    }

    /* An item stored with no card belongs to a chunk of the visit being run:
     * the start that failed for it is asked once more, and the report waits for
     * the card it answers. A start that still answers nothing leaves the item
     * where it was. An item of another visit had no card opened for it and
     * nothing can be posted for it, so it leaves the queue; one of this visit
     * waits until this visit's own Start, because a keyless item of a visit
     * only exists once that visit has started. */
    function sendKeylessQueued(item) {
      var itemVisit = typeof item.visit === "string" ? item.visit : "";
      if (itemVisit !== visitId) {
        dropQueued(item);
        return;
      }
      if (!hooks.start || !started) return;
      var index = item.chunkIndex;
      if (chunkIdOf(index) !== item.entryId) return;
      var known = cardKeys[index];
      if (typeof known === "string" && known !== "") {
        sendQueuedAgainst(item, known);
        return;
      }
      var waiting = startFor(index);
      if (!waiting) return;
      Promise.resolve(waiting).then(function () {
        if (destroyed) return;
        var answered = cardKeys[index];
        if (typeof answered !== "string" || answered === "") return;
        sendQueuedAgainst(item, answered);
      }, function () {
        return undefined;
      });
    }

    /* The post itself, against the card the item was stored with and no other:
     * its own count, raised to what that card already knows, and the item gone
     * once the page has it. A 400-499 answer that is neither a timeout nor a
     * throttle is the report being refused, so the item goes rather than wait
     * for ever. */
    function sendQueuedAgainst(item, key) {
      if (queuedInFlight.get(key)) return;
      var carried = raiseTo(key, item.activeSeconds);
      if (acked(key, carried)) {
        dropQueued(item);
        return;
      }
      var answer;
      try {
        queuedInFlight.set(key, true);
        answer = hooks.post({
          cardKey: key,
          chunkIndex: item.chunkIndex,
          entryId: item.entryId,
          activeSeconds: carried
        });
      } catch (err) {
        queuedInFlight.delete(key);
        return;
      }
      if (!answer || typeof answer.then !== "function") {
        queuedInFlight.delete(key);
        dropQueued(item);
        return;
      }
      Promise.resolve(answer).then(function () {
        queuedInFlight.delete(key);
        dropQueued(item);
      }, function (err) {
        queuedInFlight.delete(key);
        if (refusedReport(err)) dropQueued(item);
      });
    }

    /* A page that answers 400-499 itself has refused the report: a timeout and
     * a throttle are worth another try, nothing else in that range is. */
    function refusedReport(err) {
      if (!err || typeof err !== "object") return false;
      var status = err.status;
      if (typeof status !== "number" || !isFinite(status)) return false;
      if (status < 400 || status > 499) return false;
      return status !== 408 && status !== 429;
    }

    /* The queue is retried whole: at mount, on the beat, and before every fresh
     * report. */
    function retryQueue() {
      if (destroyed || !hooks.post || queue.length === 0) return;
      var items = queue.slice();
      for (var i = 0; i < items.length; i += 1) sendQueued(items[i]);
    }

    /* The beat retries the queue on every tenth tick, and never sooner than ten
     * seconds of the page's clock after the last try. */
    function retryDue() {
      if (queue.length === 0) return;
      var sinceTicks = ticks - lastRetryTick;
      var sinceMs = nowFn() - lastRetryAt;
      if (sinceTicks < RETRY_TICKS && sinceMs < RETRY_MS) return;
      lastRetryTick = ticks;
      lastRetryAt = nowFn();
      retryQueue();
    }

    /* The chunk a step belongs to (a chunk-break belongs to the chunk it
     * follows). */
    function chunkOfSegment(index) {
      var segment = segmentAt(index);
      if (!segment || !Number.isInteger(segment.chunkIndex) || segment.chunkIndex < 0) return chunkSeen;
      return segment.chunkIndex;
    }

    /* The clock has left a chunk: what it counted there is reported now, once. */
    function leaveChunk(index) {
      var active = activeAt(index, clock.state());
      if (!(active > 0)) return;
      postOne(index, active);
    }

    /* The resume record, when it is one this player wrote today. Anything else
     * is no record at all: a record from another day is taken out of storage,
     * because picking up yesterday's visit would count its time twice. */
    function readResumeRecord() {
      var raw = storageGet(resumeKey());
      if (raw === null || raw === "") return null;
      var data;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        return null;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      if (data.day !== localDay(nowFn())) {
        storageDrop(resumeKey());
        return null;
      }
      if (!Number.isInteger(data.segmentIndex) || data.segmentIndex < 0) return null;
      if (!Array.isArray(data.activeSeconds)) return null;
      var counts = [];
      for (var i = 0; i < data.activeSeconds.length; i += 1) {
        var value = clampSeconds(data.activeSeconds[i]);
        if (value === null) return null;
        counts.push(value);
      }
      var keys = [];
      var rawKeys = Array.isArray(data.cardKeys) ? data.cardKeys : [];
      for (var k = 0; k < rawKeys.length; k += 1) {
        var one = rawKeys[k];
        keys.push(typeof one === "string" && one !== "" ? one : null);
      }
      var at = data.segmentIndex;
      if (at > segments.length - 1) at = segments.length - 1;
      return { segmentIndex: at, activeSeconds: counts, cardKeys: keys };
    }

    /* A record says which local day it belongs to and which card each chunk was
     * reported against, so a visit picking it up neither pays twice nor starts
     * the same chunk again. */
    function saveResume() {
      var snap = clock.state();
      var keys = [];
      for (var i = 0; i < chunkCount(); i += 1) {
        var key = cardKeys[i];
        keys.push(typeof key === "string" && key !== "" ? key : null);
      }
      storageSet(resumeKey(), JSON.stringify({
        day: localDay(nowFn()),
        segmentIndex: snap.segmentIndex,
        activeSeconds: activeList(snap),
        cardKeys: keys
      }));
    }

    function dropResume() {
      storageDrop(resumeKey());
    }

    /* Half a chunk's planned time is the done line, the rule the rest of Ramble
     * reads; a page with no posting to ask leaves it deciding. */
    function locallyDone(index, active) {
      try {
        return Session.isChunkDone(plannedOf(index), active) === true;
      } catch (err) {
        return false;
      }
    }

    function doneFrom(answer, fallback) {
      if (!answer || typeof answer !== "object") return fallback;
      if (typeof answer.done === "boolean") return answer.done;
      return fallback;
    }

    /* One chunk's report to the page: that chunk's own card, its own seconds,
     * never a session total. A page with no posting, a report that throws and a
     * report that rejects all leave the local rule deciding, a page whose
     * posting answers at once is answered at once, and a report that needs the
     * page's start first waits for it. */
    function postOne(index, active) {
      var fallback = locallyDone(index, active);
      function settled(done) {
        return { index: index, activeSeconds: active, done: done };
      }
      if (!hooks.post) return settled(fallback);
      retryQueue();
      var waiting = startFor(index);
      if (waiting) {
        return waiting.then(function () {
          return sendOne(index, active, fallback, settled);
        }, function () {
          return settled(fallback);
        });
      }
      return sendOne(index, active, fallback, settled);
    }

    function sendOne(index, active, fallback, settled) {
      var entryId = chunkIdOf(index);
      var key = cardKeys[index];
      key = typeof key === "string" && key !== "" ? key : undefined;
      if (key === undefined && hooks.start) {
        /* No card to report against yet: the attempt waits its turn. */
        enqueue({
          cardKey: undefined,
          chunkIndex: index,
          entryId: entryId,
          activeSeconds: active
        });
        return settled(fallback);
      }
      var ackKey = floorKeyOf(index);
      var carried = raiseTo(ackKey, active);
      if (acked(ackKey, carried)) {
        /* Nothing new to say about this card. A report already out is waited
         * for, so the page's own answer still decides Done. */
        var flying = inFlight.get(ackKey);
        if (flying) {
          return flying.then(function (value) {
            return settled(doneFrom(progressOf(value), fallback));
          });
        }
        var held = floors.get(ackKey);
        var known = held ? held.done : null;
        return settled(typeof known === "boolean" ? known : fallback);
      }
      var answer;
      try {
        toldSent(ackKey, carried);
        answer = hooks.post({
          cardKey: key,
          chunkIndex: index,
          entryId: entryId,
          activeSeconds: carried
        });
      } catch (err) {
        forgetSent(ackKey);
        enqueue({ cardKey: key, chunkIndex: index, entryId: entryId, activeSeconds: carried });
        return settled(fallback);
      }
      if (!answer || typeof answer.then !== "function") {
        return acceptOne(index, key, carried, answer, fallback, settled);
      }
      var pending = Promise.resolve(answer).then(function (value) {
        if (inFlight.get(ackKey) === pending) inFlight.delete(ackKey);
        acceptOne(index, key, carried, value, fallback, settled);
        return value;
      }, function () {
        if (inFlight.get(ackKey) === pending) inFlight.delete(ackKey);
        forgetSent(ackKey);
        enqueue({ cardKey: key, chunkIndex: index, entryId: entryId, activeSeconds: carried });
        return null;
      });
      inFlight.set(ackKey, pending);
      return pending.then(function (value) {
        return settled(doneFrom(progressOf(value), fallback));
      });
    }

    function acceptOne(index, key, carried, answer, fallback, settled) {
      var ackKey = floorKeyOf(index);
      acknowledge(ackKey, carried);
      var done = doneFrom(progressOf(answer), fallback);
      rememberDone(ackKey, done);
      dropQueued(queueRef(index, key));
      return settled(done);
    }

    /* Hand the finished reports to the caller: at once when every page answer
     * was already in hand, otherwise once the last one lands. */
    function settleJobs(jobs, onDone) {
      var finish = typeof onDone === "function" ? onDone : function () {};
      var waiting = false;
      var all = [];
      for (var i = 0; i < jobs.length; i += 1) {
        var job = jobs[i];
        var pending = Boolean(job) && typeof job.then === "function";
        if (pending) waiting = true;
        all.push(pending ? job : Promise.resolve(job));
      }
      if (!waiting) {
        finish(jobs);
        return;
      }
      Promise.all(all).then(function (values) { finish(values); }, function () {
        finish(jobs);
      });
    }

    /* Every chunk the clock counted time for, in chain order. A chunk with no
     * active time is never posted. */
    function postCounted(onDone) {
      var snap = clock.state();
      var jobs = [];
      for (var i = 0; i < chunkCount(); i += 1) {
        var active = activeAt(i, snap);
        if (!(active > 0)) continue;
        jobs.push(postOne(i, active));
      }
      settleJobs(jobs, onDone);
    }

    function anyDone(list) {
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].done === true) return true;
      }
      return false;
    }

    /* Every chunk of the chain counted as done, so there is nothing left to
     * pick up. */
    function everyChunkDone(list) {
      if (chunkCount() === 0) return false;
      for (var index = 0; index < chunkCount(); index += 1) {
        var found = false;
        for (var i = 0; i < list.length; i += 1) {
          if (list[i] && list[i].index === index && list[i].done === true) found = true;
        }
        if (!found) return false;
      }
      return true;
    }

    function showResults(list) {
      clearChildren(els.result);
      for (var i = 0; i < list.length; i += 1) {
        var line = build("div", "chunk-result");
        line.setAttribute("data-chunk", String(list[i].index));
        line.textContent = list[i].done === true ? doneCardText : resumeCardText;
        els.result.appendChild(line);
      }
      if (!anyDone(list) && notYetText !== "") {
        var note = build("div", "note");
        note.textContent = notYetText;
        els.result.appendChild(note);
      }
      attach(els.result);
    }

    /* ---------- leaving, and the end screen ---------- */

    function restHintSeconds() {
      var hint = Session ? Session.REST_HINT_SECONDS : null;
      return typeof hint === "number" && isFinite(hint) ? hint : 1800;
    }

    function hideTransport() {
      clearChildren(els.transport);
      removeNode(els.transport, host);
    }

    /* The clock stops where it is and the wake lock goes back the way a pause
     * hands it back. */
    function leaveRunning() {
      try {
        if (!clock.state().paused) clock.pause();
      } catch (err) {
        return;
      }
      dropWakeLock();
    }

    function onFinishClick() {
      if (!started || finished || endShown) return;
      finished = true;
      terminal = true;
      leaveRunning();
      hideTransport();
      postCounted(function (list) {
        if (destroyed) return;
        showResults(list);
        if (everyChunkDone(list)) dropResume();
        else saveResume();
        report({ type: "left" });
      });
    }

    function canAdd(addition) {
      try {
        var answer = Session.canExtend(timeline, clock.state(), options.library, addition);
        return Boolean(answer && answer.ok === true);
      } catch (err) {
        return false;
      }
    }

    /* Today's card label: the slot's own word from the page's copy, inside the
     * copy's own sentence. No word, no label. */
    function cardLabel(slot) {
      if (typeof slot !== "string" || slot === "") return "";
      var word = copy["settings.slot." + slot];
      if (typeof word !== "string" || word === "") return "";
      return fill(addTenNextText, { slot: word });
    }

    function lastChunkId() {
      var count = chunkCount();
      return count > 0 ? chunkIdOf(count - 1) : "";
    }

    /* The additions the end screen offers, in the order it shows them: today's
     * next card, the chunk that shares the area just worked, and the chunk
     * again. An addition the session will not take is left out, and so is one
     * whose library title is missing. */
    function chunkAdditions() {
      var list = [];
      var card = offers.nextCard && typeof offers.nextCard === "object" ? offers.nextCard : null;
      if (card && typeof card.chunkId === "string" && card.chunkId !== "") {
        var cardText = cardLabel(card.slot);
        if (cardText !== "" && canAdd({ addChunk: card.chunkId })) {
          list.push({ chunkId: card.chunkId, label: cardText });
        }
      }
      var area = offers.areaChunk && typeof offers.areaChunk === "object" ? offers.areaChunk : null;
      if (area && typeof area.chunkId === "string" && area.chunkId !== "") {
        var areaTitle = titleOf(area.chunkId);
        if (areaTitle !== "" && canAdd({ addChunk: area.chunkId })) {
          list.push({ chunkId: area.chunkId, label: areaTitle });
        }
      }
      var again = lastChunkId();
      if (again !== "") {
        var againTitle = titleOf(again);
        if (againTitle !== "" && canAdd({ addChunk: again })) {
          list.push({ chunkId: again, label: againTitle });
        }
      }
      return list;
    }

    /* One summary line per chunk the visit spent active time on, with that
     * chunk's own library title. */
    function summaryRows(snap) {
      var rows = [];
      if (summaryText === "") return rows;
      for (var i = 0; i < chunkCount(); i += 1) {
        var active = activeAt(i, snap);
        if (!(active > 0)) continue;
        var name = titleOf(chunkIdOf(i));
        if (name === "") continue;
        var row = build("div", "summary");
        row.textContent = fill(summaryText, { minutes: Math.round(active / 60), name: name });
        rows.push(row);
      }
      return rows;
    }

    /* The session goes on from an addition: the new timeline under the same
     * clock, the end screen away, the clock playing again. */
    function onAddition(next) {
      if (!next || !Array.isArray(next.segments) || next.segments.length === 0) return;
      timeline = next;
      segments = next.segments;
      /* A chunk an addition brought in is started as an extra, and its start
       * carries the chain it now belongs to. */
      if (Array.isArray(next.chain)) currentChain = next.chain;
      try {
        clock.setTimeline(timeline);
      } catch (err) {
        return;
      }
      hideEnd();
      rebuildStrip();
      paint();
      playNow(false);
    }

    function onOneMoreRoundClick() {
      var next;
      try {
        next = Session.extend(timeline, clock.state(), options.library, { addRound: true });
      } catch (err) {
        return;
      }
      onAddition(next);
    }

    function onAddOptionClick(chunkId) {
      return function () {
        var next;
        try {
          next = Session.extend(timeline, clock.state(), options.library, { addChunk: chunkId });
        } catch (err) {
          return;
        }
        onAddition(next);
      };
    }

    function onAddTenClick() {
      if (addOptionsShown) return;
      var additions = chunkAdditions();
      if (additions.length === 0) return;
      addOptionsShown = true;
      var panel = build("div", "add-options");
      for (var i = 0; i < additions.length; i += 1) {
        var button = makeButton("add-option", additions[i].label);
        if (!button) continue;
        button.addEventListener("click", onAddOptionClick(additions[i].chunkId));
        panel.appendChild(button);
      }
      els.addOptions = panel;
      els.end.appendChild(panel);
      attach(els.end);
    }

    function hideEnd() {
      endShown = false;
      terminal = false;
      addOptionsShown = false;
      clearChildren(els.end);
      clearChildren(els.result);
      removeNode(els.end, host);
      removeNode(els.result, host);
    }

    function onThatsItClick() {
      if (finished) return;
      finished = true;
      endShown = false;
      addOptionsShown = false;
      terminal = true;
      hideTransport();
      postCounted();
      clearChildren(els.end);
      removeNode(els.end, host);
      dropResume();
      report({ type: "left" });
    }

    /* None of the end screen's choices is picked for the person: no button is
     * pressed, nothing takes the focus, nothing counts down and nothing
     * happens by itself. */
    function showEnd(snap) {
      clearChildren(els.end);
      var title = build("div", "end-title");
      title.textContent = endTitleText;
      els.end.appendChild(title);

      var rows = summaryRows(snap);
      for (var i = 0; i < rows.length; i += 1) els.end.appendChild(rows[i]);

      var rounds = canAdd({ addRound: true });
      var additions = chunkAdditions();
      var atCap = !rounds && additions.length === 0;

      if (rounds && !atCap) {
        var oneMore = makeButton("one-more-round", oneMoreRoundText);
        if (oneMore) {
          oneMore.addEventListener("click", onOneMoreRoundClick);
          els.end.appendChild(oneMore);
        }
      }
      if (additions.length > 0 && !atCap) {
        var addTen = makeButton("add-ten", addTenText);
        if (addTen) {
          addTen.addEventListener("click", onAddTenClick);
          els.end.appendChild(addTen);
        }
      }
      var thatsIt = makeButton("thats-it", thatsItText);
      if (thatsIt) {
        thatsIt.addEventListener("click", onThatsItClick);
        els.end.appendChild(thatsIt);
      }
      if (atCap && capText !== "") {
        var capNote = build("div", "cap-note");
        capNote.textContent = capText;
        els.end.appendChild(capNote);
      }
      if (waterText !== "" && totalActive(snap) >= restHintSeconds()) {
        var waterNote = build("div", "water-note");
        waterNote.textContent = waterText;
        els.end.appendChild(waterNote);
      }
      attach(els.end);
    }

    function onClockEnd() {
      if (finished || endShown) return;
      endShown = true;
      terminal = true;
      dropWakeLock();
      hideTransport();
      postCounted(function (list) {
        if (destroyed) return;
        showEnd(clock.state());
        showResults(list);
        report({ type: "ended" });
      });
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

    /* A page that offers no wake lock, or refuses one, never hears about it. A
     * lock already held goes back before another is asked for, so a second play
     * never leaves one behind. */
    function takeWakeLock() {
      /* A session that has ended owns no lock: nothing is asked for after it. */
      if (terminal) return;
      wakeWanted = true;
      var held = wakeHandle;
      wakeHandle = null;
      releaseWakeHandle(held);
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
          /* A lock that landed while another is held: the older one goes back
           * before the new one is kept, so no handle is left behind. */
          var older = wakeHandle;
          wakeHandle = null;
          releaseWakeHandle(older);
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
      if (terminal) {
        clearChildren(els.transport);
        removeNode(els.transport, host);
        return;
      }
      if (els.transport.parentNode !== host) attach(els.transport);
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
      if (els.finish && started) wanted.push(els.finish);
      if (els.pause) {
        var label = snap.paused && keepGoingText !== "" ? keepGoingText : pauseText;
        if (els.pause.textContent !== label) els.pause.textContent = label;
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

    /* The strip is built from the timeline in hand, so an addition that adds
     * steps to the session rebuilds it. */
    function rebuildStrip() {
      for (var s = 0; s < stripHandlers.length; s += 1) {
        stripHandlers[s].node.removeEventListener("click", stripHandlers[s].handler);
      }
      stripHandlers.length = 0;
      stripNodes.length = 0;
      stripIndexes.length = 0;
      clearChildren(els.strip);
      buildStrip();
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
      ticks += 1;
      retryDue();
    }

    function startInterval() {
      if (intervalLive) return;
      intervalLive = true;
      intervalId = setIntervalFn(onTick, TICK_MS);
    }

    /* The cards a record from earlier today was reported against are its own:
     * the visit picks them up instead of asking the page for them again, which
     * would pay for the same chunk twice. */
    function adoptResumeKeys() {
      if (!resumeRecord || !Array.isArray(resumeRecord.cardKeys)) return;
      for (var i = 0; i < chunkCount(); i += 1) {
        var key = resumeRecord.cardKeys[i];
        if (typeof key !== "string" || key === "") continue;
        var known = cardKeys[i];
        if (typeof known === "string" && known !== "") continue;
        cardKeys[i] = key;
      }
    }

    function onStart() {
      if (started) return;
      started = true;
      adoptResumeKeys();
      removeNode(els.safety, host);
      removeNode(els.start, host);
      els.safety = null;
      if (els.resumeLine) {
        removeNode(els.resumeLine, host);
        els.resumeLine = null;
      }
      /* A visit picking up a record starts at the segment it left off on; the
       * seek comes before the play, so no time is counted on the way there. */
      if (pendingSeek !== null) {
        try {
          clock.seek(pendingSeek);
        } catch (err) {
          /* a bad index is no reason to stay stopped */
        }
        pendingSeek = null;
      }
      playNow(false);
      startInterval();
      paint();
      /* The first chunk's card is asked for now; every later chunk asks when
       * its own report needs one. A refusal costs nothing here: the next
       * report asks again. */
      startFor(0);
    }

    /* A tab that goes away while the session runs is a pause, the same one the
     * pause button makes. */
    function onVisibilityChange() {
      var shown = documentOf();
      if (!shown || !shown.hidden) return;
      pauseNow();
    }

    els.start.addEventListener("click", onStart);
    if (els.finish) els.finish.addEventListener("click", onFinishClick);
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
      if (!event) return;
      if (event.type === "end") {
        onClockEnd();
        return;
      }
      if (event.type !== "segment") return;
      var at = event.state && Number.isInteger(event.state.segmentIndex)
        ? event.state.segmentIndex
        : clock.state().segmentIndex;
      /* A step in another chunk means the clock has left one behind, whether it
       * walked there, skipped, went back or was tapped there: that chunk's own
       * count is reported now. */
      var chunkAt = chunkOfSegment(at);
      if (chunkAt !== chunkSeen) {
        var left = chunkSeen;
        chunkSeen = chunkAt;
        leaveChunk(left);
      }
      if (at === lastReportedIndex) return;
      lastReportedIndex = at;
      report({ type: "segment", index: at });
    });

    rebuildStrip();
    paintTransport();
    /* What an earlier visit could not report is tried again straight away. */
    retryQueue();

    function state() {
      var snap = clock.state();
      return {
        layout: layout,
        started: started,
        segmentIndex: snap.segmentIndex,
        paused: snap.paused,
        ended: snap.ended,
        sheetOpen: sheetOpen,
        finished: finished
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
      /* The clock stops where it is first, so the stretch since the last tick
       * is counted before it is reported. */
      if (started && !clock.state().paused) {
        try {
          clock.pause();
        } catch (err) {
          /* nothing left to stop */
        }
      }
      /* Whatever the clock counted and no report has carried yet goes now,
       * before the page takes the player away. */
      postCounted();
      destroyed = true;
      dropWakeLock();
      els.start.removeEventListener("click", onStart);
      if (els.finish) els.finish.removeEventListener("click", onFinishClick);
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
