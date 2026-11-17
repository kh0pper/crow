/* Ramble Moves Learn card -- the figure with its anatomy layers, the chips that
 * turn those layers on, the entry's own step list, and the sheet behind
 * "See the anatomy".
 *
 * A classic browser script (no modules, no template literals) so the panel can
 * load it with a plain script tag next to figure.cjs and session.cjs. It draws
 * a pose or an exercise that carries anatomy; every other entry mounts nothing.
 *
 * The timeline is the engine's own shape (session.cjs), one hold segment per
 * entry step, run on RambleSession.createClock with the clock the caller hands
 * in -- the same { now, setInterval } contract the player uses, so a caller can
 * own the time. It loops: the last step is followed by the first.
 *
 * Text is written with textContent only, out of the library entry and the
 * anatomy vocabulary; the one innerHTML write is the figure, which is
 * RambleFigure.poseSvg's own output (the same write moves.js figureInto makes).
 *
 * mount(host, { entry, vocab, library, storage, clock, copy, reducedMotion })
 *   -> { destroy(), select(stepIndex), chips() }   (null when nothing is drawn)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RambleLearnCard = api;
})(this, function () {
  "use strict";

  /* One step is one held pose. */
  var STEP_SECONDS = 5;
  /* Twice a second is enough for a 5 s hold, and cheap. */
  var TICK_MS = 250;
  /* The figure moves from the last pose to this one over the first part of the
   * step; the rest of the step is the pose held still. */
  var TWEEN_SECONDS = 1.2;
  /* The chips belong to the device, not to the entry. */
  var CHIPS_KEY = "ramble.moves.learncard.chips";
  /* The two kinds the card draws. A flow, a walk or a routine has its own page. */
  var FIGURE_KINDS = { pose: true, exercise: true };
  /* In the order they are drawn: colour first, then the pins, the nerves, the
   * names. */
  var CHIPS = [
    { key: "skeleton", label: "Skeleton" },
    { key: "muscles", label: "Muscles" },
    { key: "nerves", label: "Nerves" },
    { key: "labels", label: "Labels" }
  ];
  /* Colour only, until the reader asks for more. */
  var DEFAULT_CHIPS = { skeleton: false, muscles: true, nerves: false, labels: false };
  /* The sheet's sections, in the order it shows them, keyed by the vocabulary's
   * own layer names and headed with the chips' own words. */
  var SECTION_ORDER = [
    { layer: "muscle", heading: "Muscles" },
    { layer: "bone", heading: "Skeleton" },
    { layer: "nerve", heading: "Nerves" }
  ];
  var SEE_ANATOMY = "See the anatomy";
  var BACK = "Back";

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

  function isObject(v) {
    return Boolean(v) && typeof v === "object" && !Array.isArray(v);
  }

  function isStr(v) {
    return typeof v === "string" && v !== "";
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

  /* One library step as { text, cue, say, at }, read the way moves/library.js
   * reads it: a plain string is its own text, cue falls back to text, say to
   * cue. */
  function stepOf(step) {
    var raw = isObject(step) ? step : {};
    var text = typeof step === "string" ? step : (typeof raw.text === "string" ? raw.text : "");
    var cue = typeof raw.cue === "string" ? raw.cue : text;
    var say = typeof raw.say === "string" ? raw.say : cue;
    var at = Number.isInteger(raw.at) && raw.at >= 0 ? raw.at : 0;
    return { text: text, cue: cue, say: say, at: at };
  }

  /* The vocabulary as id -> record, whichever way it was handed in (an array of
   * records, or a Map of them). Anything else is an empty lookup. */
  function vocabIndex(vocab) {
    var byId = new Map();
    function add(record, id) {
      if (!isObject(record)) return;
      var key = isStr(record.id) ? record.id : (isStr(id) ? id : null);
      if (!key || byId.has(key)) return;
      byId.set(key, record);
    }
    if (Array.isArray(vocab)) {
      for (var i = 0; i < vocab.length; i += 1) add(vocab[i], null);
      return byId;
    }
    if (vocab && typeof vocab.forEach === "function" && typeof vocab.get === "function") {
      vocab.forEach(function (record, id) { add(record, id); });
    }
    return byId;
  }

  function recordOf(byId, id) {
    if (!isStr(id) || byId.size === 0) return null;
    var record = byId.get(id);
    return isObject(record) ? record : null;
  }

  function listOf(record, field) {
    var value = record ? record[field] : null;
    if (!Array.isArray(value)) return [];
    var out = [];
    for (var i = 0; i < value.length; i += 1) {
      if (isStr(value[i])) out.push(value[i]);
    }
    return out;
  }

  /* ---------- the card ---------- */

  function mount(host, opts) {
    var options = isObject(opts) ? opts : {};
    var doc = documentOf();
    var Session = sessionApi();
    var Figure = figureApi();
    var entry = isObject(options.entry) ? options.entry : null;
    if (!doc || !host || typeof host.appendChild !== "function" || !Session || !Figure || !entry) return null;
    if (FIGURE_KINDS[entry.kind] !== true) return null;

    /* The entry's one anatomy record. No record, nothing to draw or explain. */
    var record = null;
    var anatomy = Array.isArray(entry.anatomy) ? entry.anatomy : [];
    for (var a = 0; a < anatomy.length; a += 1) {
      if (isObject(anatomy[a])) { record = anatomy[a]; break; }
    }
    if (!record) return null;

    var byId = vocabIndex(options.vocab);

    var copy = isObject(options.copy) ? options.copy : {};
    var backText = isStr(copy.back) ? copy.back : BACK;
    var storage = options.storage === undefined ? null : options.storage;
    var reduced = typeof options.reducedMotion === "boolean"
      ? options.reducedMotion
      : false;

    /* ---------- the steps, and the pose each one holds ---------- */

    var rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
    var steps = [];
    for (var s = 0; s < rawSteps.length; s += 1) steps.push(stepOf(rawSteps[s]));
    /* The clock needs at least one segment to run. */
    if (steps.length === 0) steps.push(stepOf(""));

    /* A pose entry holds its one pose on every step; an exercise step names the
     * key position it holds with its own "at". */
    var poses = [];
    function poseFor(step) {
      if (entry.kind === "pose") return isObject(entry.pose) ? entry.pose : null;
      var list = Array.isArray(entry.poses) ? entry.poses : [];
      var at = step.at;
      if (isObject(list[at])) return list[at];
      return isObject(list[0]) ? list[0] : null;
    }
    for (var p = 0; p < steps.length; p += 1) {
      var pose = poseFor(steps[p]);
      poses.push(pose || (poses.length > 0 ? poses[poses.length - 1] : null));
    }
    /* A first step whose own pose is missing borrows the first one there is. */
    var firstPose = null;
    for (var f = 0; f < poses.length; f += 1) {
      if (poses[f]) { firstPose = poses[f]; break; }
    }
    if (!firstPose) return null;
    for (var g = 0; g < poses.length; g += 1) {
      if (!poses[g]) poses[g] = firstPose;
    }

    /* The record is lit on the step it names; an entry whose steps never name it
     * shows it on every step. */
    var recordAt = Number.isInteger(record.at) && record.at >= 0 ? record.at : 0;
    var named = false;
    for (var n = 0; n < steps.length; n += 1) {
      if (steps[n].at === recordAt) named = true;
    }
    var lit = [];
    for (var l = 0; l < steps.length; l += 1) lit.push(named ? steps[l].at === recordAt : true);

    /* ---------- the timeline, in the engine's segment shape ---------- */

    var segments = [];
    var count = steps.length;
    for (var i = 0; i < count; i += 1) {
      segments.push({
        type: "hold",
        chunkIndex: 0,
        block: "main",
        entryId: isStr(entry.id) ? entry.id : "",
        stepIndex: i,
        seconds: STEP_SECONDS,
        active: true,
        fromPose: poses[(i + count - 1) % count],
        toPose: poses[i],
        reps: null,
        side: null,
        cue: steps[i].cue,
        say: steps[i].say,
        anatomyStep: lit[i] ? record : null,
        tempoSeconds: null,
        still: false
      });
    }
    var planned = STEP_SECONDS * count;
    var timeline = {
      segments: segments,
      chunks: [{ chunkId: isStr(entry.id) ? entry.id : "", index: 0, plannedSeconds: planned }],
      totalSeconds: planned,
      chain: [{ chunkId: isStr(entry.id) ? entry.id : "", extraRounds: 0 }],
      opts: { guidance: "full", stage: undefined, perSideOrder: "left" }
    };

    /* ---------- the clock ---------- */

    var timeSource = isObject(options.clock) ? options.clock : null;
    var nowFn = timeSource && typeof timeSource.now === "function"
      ? function () { return timeSource.now(); }
      : function () { return Date.now(); };
    var setIntervalFn = timeSource && typeof timeSource.setInterval === "function"
      ? function (fn, ms) { return timeSource.setInterval(fn, ms); }
      : defaultSetInterval;
    var clearIntervalFn = timeSource && typeof timeSource.clearInterval === "function"
      ? function (id) { return timeSource.clearInterval(id); }
      : defaultClearInterval;

    var clock = null;
    try {
      clock = Session.createClock({ timeline: timeline, now: nowFn });
    } catch (err) {
      clock = null;
    }
    if (!clock) return null;

    /* ---------- the chips, and where they were left ---------- */

    var state = {
      skeleton: DEFAULT_CHIPS.skeleton,
      muscles: DEFAULT_CHIPS.muscles,
      nerves: DEFAULT_CHIPS.nerves,
      labels: DEFAULT_CHIPS.labels
    };

    function storageGet(key) {
      if (!storage || typeof storage.getItem !== "function") return null;
      try {
        var value = storage.getItem(key);
        return typeof value === "string" ? value : null;
      } catch (err) {
        return null;
      }
    }

    function storageSet(key, value) {
      if (!storage || typeof storage.setItem !== "function") return;
      try {
        storage.setItem(key, value);
      } catch (err) {
        /* a storage that will not take it just forgets it */
      }
    }

    function readChips() {
      var raw = storageGet(CHIPS_KEY);
      if (raw === null || raw === "") return;
      var saved = null;
      try {
        saved = JSON.parse(raw);
      } catch (err) {
        return;
      }
      if (!isObject(saved)) return;
      for (var c = 0; c < CHIPS.length; c += 1) {
        var key = CHIPS[c].key;
        if (typeof saved[key] === "boolean") state[key] = saved[key];
      }
    }

    function saveChips() {
      storageSet(CHIPS_KEY, JSON.stringify({
        skeleton: state.skeleton,
        muscles: state.muscles,
        nerves: state.nerves,
        labels: state.labels
      }));
    }

    readChips();

    /* ---------- the vocabulary, read for the layers ---------- */

    var workingIds = listOf(record, "working");
    var lengtheningIds = listOf(record, "lengthening");

    /* The bands' segments: every segment of every named part that the side view
     * can draw. A part drawn from another angle is skipped, never guessed. */
    function bandSegments(ids) {
      var out = [];
      var seen = Object.create(null);
      for (var b = 0; b < ids.length; b += 1) {
        var part = recordOf(byId, ids[b]);
        if (!part || part.sideView === false) continue;
        var list = listOf(part, "segments");
        for (var k = 0; k < list.length; k += 1) {
          if (seen[list[k]]) continue;
          seen[list[k]] = true;
          out.push(list[k]);
        }
      }
      return out;
    }

    /* Names beside the figure: the main part and the parts that work or
     * lengthen, each at its first segment, in the reader's own words. */
    function labelList() {
      var out = [];
      var seen = Object.create(null);
      function add(id, muscleOnly) {
        if (!isStr(id) || seen[id]) return;
        var part = recordOf(byId, id);
        if (!part || part.sideView === false) return;
        if (muscleOnly && part.layer !== "muscle") return;
        var list = listOf(part, "segments");
        if (list.length === 0) return;
        seen[id] = true;
        out.push({ segment: list[0], text: isStr(part.name) ? part.name : "" });
      }
      if (isStr(record.main)) add(record.main, false);
      for (var w = 0; w < workingIds.length; w += 1) add(workingIds[w], true);
      for (var g2 = 0; g2 < lengtheningIds.length; g2 += 1) add(lengtheningIds[g2], true);
      return out;
    }

    /* What the figure is drawn with for one step: the chips, and the record's
     * own colour, arrows and names when that step lights it. */
    function decorationFor(segment) {
      var opts = { layers: { skeleton: state.skeleton, muscles: state.muscles, nerves: state.nerves } };
      var litRecord = segment ? segment.anatomyStep : null;
      if (!litRecord) return opts;
      var bands = {
        working: bandSegments(listOf(litRecord, "working")),
        lengthening: bandSegments(listOf(litRecord, "lengthening"))
      };
      opts.bands = bands;
      var arrows = Array.isArray(litRecord.arrows) ? litRecord.arrows : [];
      if (arrows.length > 0) opts.arrows = arrows;
      if (state.labels) {
        var labels = labelList();
        if (labels.length > 0) opts.labels = labels;
      }
      return opts;
    }

    /* ---------- the elements ---------- */

    clearHost(host);

    var nodes = [];
    var els = {};

    function build(tag, role) {
      var node = doc.createElement(tag);
      if (role) node.setAttribute("data-role", role);
      return node;
    }

    function append(node) {
      if (!node) return;
      host.appendChild(node);
      nodes.push(node);
    }

    els.card = build("div", "learn-card");
    els.card.className = "rb-learn-card";
    els.figure = build("div", "figure");
    els.figure.className = "rb-learn-figure";
    els.chips = build("div", "chips");
    els.chips.className = "rb-learn-chips";
    els.anatomy = build("button", "anatomy");
    els.anatomy.setAttribute("type", "button");
    els.anatomy.className = "rb-btn rb-btn-ghost";
    els.anatomy.textContent = SEE_ANATOMY;
    els.steps = build("div", "steps");
    els.steps.className = "rb-learn-steps";

    els.card.appendChild(els.figure);
    els.card.appendChild(els.chips);
    els.card.appendChild(els.anatomy);
    els.card.appendChild(els.steps);
    append(els.card);

    var chipNodes = [];
    function onChip(key) {
      return function () {
        state[key] = !state[key];
        saveChips();
        paintChips();
        paintFigure();
      };
    }
    for (var ch = 0; ch < CHIPS.length; ch += 1) {
      var chip = build("button", "chip");
      chip.setAttribute("type", "button");
      chip.setAttribute("data-chip", CHIPS[ch].key);
      chip.className = "rb-chip";
      chip.textContent = CHIPS[ch].label;
      var chipHandler = onChip(CHIPS[ch].key);
      chip.addEventListener("click", chipHandler);
      els.chips.appendChild(chip);
      chipNodes.push({ key: CHIPS[ch].key, node: chip, handler: chipHandler });
    }

    /* One button per step, holding that step's own words. */
    var stepNodes = [];
    function stepClick(index) {
      return function () { select(index); };
    }
    for (var st = 0; st < steps.length; st += 1) {
      var stepBtn = build("button", "step");
      stepBtn.setAttribute("type", "button");
      stepBtn.setAttribute("data-step", String(st));
      stepBtn.className = "rb-learn-step";
      stepBtn.textContent = steps[st].text;
      var stepHandler = stepClick(st);
      stepBtn.addEventListener("click", stepHandler);
      els.steps.appendChild(stepBtn);
      stepNodes.push({ node: stepBtn, handler: stepHandler });
    }

    /* ---------- the sheet ---------- */

    var sheetNode = null;
    var sheetBody = null;
    /* The step index the sheet body was last built for. The sheet says the same
     * thing for the whole of one hold, so a tick inside that step leaves it be. */
    var sheetStep = -1;

    /* The parts one section lists: the main part first in Muscles, then the
     * parts that work and the parts that lengthen. */
    function structuresOf(layer) {
      var out = [];
      var seen = Object.create(null);
      function add(id) {
        if (!isStr(id) || seen[id]) return;
        var part = recordOf(byId, id);
        if (!part || part.layer !== layer) return;
        seen[id] = true;
        out.push(part);
      }
      if (layer === "muscle") add(record.main);
      var ids = layer === "muscle" ? workingIds.concat(lengtheningIds)
        : (layer === "bone" ? listOf(record, "bones") : listOf(record, "nerves"));
      for (var i2 = 0; i2 < ids.length; i2 += 1) add(ids[i2]);
      return out;
    }

    function structureRow(part) {
      var row = build("div", "structure");
      row.className = "rb-learn-structure";
      var name = doc.createElement("strong");
      name.setAttribute("data-role", "structure-name");
      name.textContent = isStr(part.name) ? part.name : "";
      var anatomical = doc.createElement("span");
      anatomical.setAttribute("data-role", "structure-anatomical");
      anatomical.className = "rb-muted rb-fine";
      anatomical.textContent = isStr(part.anatomical) ? part.anatomical : "";
      row.appendChild(name);
      row.appendChild(anatomical);
      return row;
    }

    /* The sheet's own content: the entry's why line, then one section per layer
     * the record names. A layer the record says nothing about has no section. */
    function paintSheetBody() {
      if (!sheetBody) return;
      sheetStep = clock.state().segmentIndex;
      while (sheetBody.firstChild) sheetBody.removeChild(sheetBody.firstChild);
      if (isStr(record.why)) {
        var why = build("p", "why");
        why.className = "rb-learn-why";
        why.textContent = record.why;
        sheetBody.appendChild(why);
      }
      for (var i3 = 0; i3 < SECTION_ORDER.length; i3 += 1) {
        var parts = structuresOf(SECTION_ORDER[i3].layer);
        if (parts.length === 0) continue;
        var section = build("div", "section");
        section.setAttribute("data-section", SECTION_ORDER[i3].layer);
        var head = build("div", "section-title");
        head.className = "rb-eyebrow";
        head.textContent = SECTION_ORDER[i3].heading;
        section.appendChild(head);
        for (var j = 0; j < parts.length; j += 1) section.appendChild(structureRow(parts[j]));
        sheetBody.appendChild(section);
      }
    }

    function buildSheet() {
      sheetNode = build("div", "sheet");
      sheetNode.className = "rb-learn-sheet";
      sheetNode.setAttribute("role", "dialog");
      sheetNode.setAttribute("aria-modal", "true");
      var panel = build("div", "sheet-panel");
      panel.className = "rb-learn-sheet-panel";
      sheetBody = build("div", "sheet-body");
      var close = build("button", "sheet-close");
      close.setAttribute("type", "button");
      close.className = "rb-btn rb-btn-ghost";
      close.textContent = backText;
      close.addEventListener("click", closeSheet);
      panel.appendChild(sheetBody);
      panel.appendChild(close);
      sheetNode.appendChild(panel);
    }

    var sheetOpen = false;

    function openSheet() {
      if (sheetOpen) return;
      sheetOpen = true;
      buildSheet();
      paintSheetBody();
      append(sheetNode);
    }

    function closeSheet() {
      if (!sheetOpen) return;
      sheetOpen = false;
      var node = sheetNode;
      sheetNode = null;
      sheetBody = null;
      for (var i4 = nodes.length - 1; i4 >= 0; i4 -= 1) {
        if (nodes[i4] === node) nodes.splice(i4, 1);
      }
      removeNode(node, host);
    }

    els.anatomy.addEventListener("click", openSheet);

    /* ---------- painting ---------- */

    function poseAt(segment, elapsed) {
      if (!segment) return null;
      if (reduced) return segment.toPose;
      var span = Math.min(TWEEN_SECONDS, segment.seconds);
      var into = typeof elapsed === "number" && isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
      var t = span > 0 ? Math.min(1, into / span) : 1;
      try {
        return Figure.tween(segment.fromPose, segment.toPose, t);
      } catch (err) {
        return segment.toPose;
      }
    }

    function paintFigure() {
      var snap = clock.state();
      var segment = segments[snap.segmentIndex] || segments[0];
      if (!segment) return;
      var pose = poseAt(segment, snap.segmentElapsed);
      if (!pose) return;
      var markup = "";
      try {
        markup = Figure.poseSvg(pose, decorationFor(segment));
      } catch (err) {
        markup = "";
      }
      els.figure.innerHTML = markup;
    }

    function paintChips() {
      for (var i5 = 0; i5 < chipNodes.length; i5 += 1) {
        chipNodes[i5].node.setAttribute("aria-pressed", state[chipNodes[i5].key] ? "true" : "false");
      }
    }

    function paintSteps() {
      var index = clock.state().segmentIndex;
      for (var i6 = 0; i6 < stepNodes.length; i6 += 1) {
        if (i6 === index) stepNodes[i6].node.setAttribute("aria-current", "true");
        else stepNodes[i6].node.removeAttribute("aria-current");
      }
    }

    function paint() {
      paintFigure();
      paintSteps();
      /* Rebuild the sheet's body only when the step it names has changed (or when
       * it has just been opened), never on every clock tick: replacing its nodes
       * under a reader's finger for nothing is what this avoids. */
      if (sheetOpen && sheetStep !== clock.state().segmentIndex) paintSheetBody();
    }

    /* ---------- moving, and the beat ---------- */

    function select(index) {
      if (!Number.isInteger(index)) return;
      try {
        clock.seek(index);
      } catch (err) {
        return;
      }
      if (clock.state().paused) clock.play();
      paint();
    }

    var intervalId = null;
    var intervalLive = false;
    var destroyed = false;

    /* The last step is followed by the first, for as long as the card is up. */
    function onTick() {
      if (destroyed) return;
      clock.tick();
      if (clock.state().ended) {
        try {
          clock.seek(0);
          clock.play();
        } catch (err) {
          /* a clock that will not loop stays where it is */
        }
      }
      paint();
    }

    function startInterval() {
      if (intervalLive) return;
      intervalLive = true;
      intervalId = setIntervalFn(onTick, TICK_MS);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (intervalLive) {
        clearIntervalFn(intervalId);
        intervalLive = false;
        intervalId = null;
      }
      els.anatomy.removeEventListener("click", openSheet);
      for (var i7 = 0; i7 < chipNodes.length; i7 += 1) {
        chipNodes[i7].node.removeEventListener("click", chipNodes[i7].handler);
      }
      for (var i8 = 0; i8 < stepNodes.length; i8 += 1) {
        stepNodes[i8].node.removeEventListener("click", stepNodes[i8].handler);
      }
      sheetOpen = false;
      sheetStep = -1;
      sheetNode = null;
      sheetBody = null;
      nodes.length = 0;
      chipNodes.length = 0;
      stepNodes.length = 0;
      clearHost(host);
    }

    function chips() {
      return {
        skeleton: state.skeleton,
        muscles: state.muscles,
        nerves: state.nerves,
        labels: state.labels
      };
    }

    paintChips();
    paint();
    clock.play();
    startInterval();

    return { destroy: destroy, select: select, chips: chips };
  }

  return {
    STEP_SECONDS: STEP_SECONDS,
    TICK_MS: TICK_MS,
    CHIPS_KEY: CHIPS_KEY,
    mount: mount
  };
});
