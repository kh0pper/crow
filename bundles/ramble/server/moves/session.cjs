/* Ramble Moves session compiler — dependency-free, dual Node/browser. No ESM syntax.
 *
 * A "chunk" is one card the picker offers: a flow, a routine, a walk or a
 * landmark. A session is a chain of chunks. compileSession turns the chain into
 * one ordered timeline: the first chunk's warm-up, each chunk's main block
 * times its rounds, a short break between chunks, and the last chunk's
 * cool-down. Each segment names the chunk it belongs to and whether it counts
 * as active time, which is what the clock, the figure, the step-text highlight,
 * the voice and the Done / Health counts all read.
 *
 * Segment copy is never written here: a segment speaks the library entry's own
 * step text (cue and say) or says nothing at all. A rest, transition,
 * switch-sides or chunk-break segment says nothing.
 *
 * Two library helpers are re-implemented below (stepOf and "is this a card")
 * because library.js is an ESM module and this file has to load in a plain
 * script tag next to figure.cjs.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RambleSession = api;
})(this, function () {
  var SESSION_MAX_SECONDS = 3600;
  var REST_HINT_SECONDS = 1800;
  var TRANSITION_SECONDS = 2;
  var SWITCH_SECONDS = 3;
  var CHUNK_BREAK_SECONDS = 5;
  var DEFAULT_FLOW_ROUNDS = 2;
  var MIN_STAGE_SECONDS = 600;

  var GUIDANCES = ["full", "names", "first", "memory"];
  var CHUNK_KINDS = ["flow", "routine", "landmark", "walk"];
  /* The shortest chunk the picker offers, as a card (library.js's rule). */
  var CHUNK_MIN_MINUTES = 10;
  /* The segment types that count as active time. */
  var COUNTED_TYPES = { hold: true, reps: true, timed: true, rest: true };
  var DEFAULT_BLOCK = "main";

  class SessionError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "SessionError";
      this.code = code;
    }
  }

  function isObject(v) {
    return Boolean(v) && typeof v === "object" && !Array.isArray(v);
  }
  function isStr(v) {
    return typeof v === "string" && v !== "";
  }
  function isPositiveInt(v) {
    return Number.isInteger(v) && v >= 1;
  }
  function isSeconds(v) {
    return typeof v === "number" && isFinite(v) && v > 0;
  }

  /* Normalize one library step to { text, cue, say, at } the way library.js
   * does: a plain string is its own text, cue falls back to text and say to
   * cue. */
  function stepOf(step) {
    var raw = isObject(step) ? step : {};
    var text = typeof step === "string" ? step : (typeof raw.text === "string" ? raw.text : "");
    var cue = typeof raw.cue === "string" ? raw.cue : text;
    var say = typeof raw.say === "string" ? raw.say : cue;
    var at = Number.isInteger(raw.at) && raw.at >= 0 ? raw.at : 0;
    return { text: text, cue: cue, say: say, at: at };
  }

  /* The per-step anatomy record, when the entry carries one. */
  function anatomyAt(entry, stepIndex) {
    if (!isObject(entry) || !Array.isArray(entry.anatomy)) return null;
    var value = entry.anatomy[stepIndex];
    return value === undefined ? null : value;
  }

  /* A library handed in as an array or as an id -> entry Map, read as an id ->
   * entry Map either way. */
  function toLibrary(library) {
    var byId = new Map();
    if (library instanceof Map) {
      library.forEach(function (entry, id) {
        if (!isObject(entry)) return;
        var key = isStr(id) ? id : (isStr(entry.id) ? entry.id : null);
        if (key) byId.set(key, entry);
      });
      return byId;
    }
    if (Array.isArray(library)) {
      for (var i = 0; i < library.length; i += 1) {
        var entry = library[i];
        if (isObject(entry) && isStr(entry.id)) byId.set(entry.id, entry);
      }
    }
    return byId;
  }

  /* The picker's rule: a flow, routine, landmark or walk long enough to stand
   * up for, and never a shared block (an opener or a closer). */
  function isChunkEntry(entry) {
    if (!isObject(entry)) return false;
    if (CHUNK_KINDS.indexOf(entry.kind) < 0) return false;
    if (entry.block !== undefined) return false;
    return Number.isFinite(entry.minutes) && entry.minutes >= CHUNK_MIN_MINUTES;
  }

  function normalizeChain(chain) {
    if (!Array.isArray(chain) || chain.length === 0) {
      throw new SessionError("bad_chain", "a session needs a non-empty array of chunks");
    }
    var out = [];
    for (var i = 0; i < chain.length; i += 1) {
      var item = chain[i];
      if (!isObject(item) || !isStr(item.chunkId)) {
        throw new SessionError("bad_chain", "chain[" + i + "] must be { chunkId, extraRounds }");
      }
      out.push({
        chunkId: item.chunkId,
        extraRounds: isPositiveInt(item.extraRounds) ? item.extraRounds : 0
      });
    }
    return out;
  }

  function normalizeOpts(opts) {
    var raw = isObject(opts) ? opts : {};
    return {
      guidance: GUIDANCES.indexOf(raw.guidance) >= 0 ? raw.guidance : "full",
      stage: Number.isInteger(raw.stage) && raw.stage >= 0 ? raw.stage : undefined,
      perSideOrder: raw.perSideOrder === "right" ? "right" : "left"
    };
  }

  function resolveChunk(item, byId) {
    var entry = byId.get(item.chunkId);
    if (!entry) throw new SessionError("unknown_chunk", "no entry named " + item.chunkId);
    if (!isChunkEntry(entry)) {
      throw new SessionError("not_a_chunk", item.chunkId + " is not something the picker offers as a card");
    }
    return entry;
  }

  /* The stage a caller asked for, or null when there is none to apply. */
  function stageOf(entry, opts) {
    if (!Array.isArray(entry.stages)) return null;
    var index = opts.stage;
    if (!Number.isInteger(index) || index < 0 || index >= entry.stages.length) return null;
    return isObject(entry.stages[index]) ? entry.stages[index] : null;
  }

  /* One step's worth of work, before it is split into sides and segments. */
  function makeItem(fields) {
    return {
      block: fields.block,
      type: fields.type,
      entryId: fields.entryId,
      entry: fields.entry,
      stepIndex: fields.stepIndex,
      seconds: fields.seconds,
      reps: fields.reps,
      perSide: fields.perSide,
      ownStart: fields.ownStart,
      startPose: fields.startPose,
      endPose: fields.endPose,
      restSeconds: fields.restSeconds
    };
  }

  /* A routine step that names a pose, an exercise or a walk. */
  function stepItem(target, step, block, repsOverride) {
    var poses = Array.isArray(target.poses) ? target.poses : [];
    var startPose = isObject(poses[0]) ? poses[0] : null;
    var endPose = isObject(poses[1]) ? poses[1] : null;
    var type = "hold";
    var reps = null;
    var ownStart = false;
    if (target.kind === "pose") {
      var pose = isObject(target.pose) ? target.pose : null;
      startPose = pose;
      endPose = pose;
    } else if (target.kind === "exercise") {
      /* An exercise carries its own two key positions. */
      ownStart = true;
      if (target.reps !== undefined) {
        type = "reps";
        reps = isPositiveInt(repsOverride) ? repsOverride
          : (isPositiveInt(target.reps) ? target.reps : null);
      } else {
        type = "timed";
      }
    } else {
      /* A walk has no pose of its own. */
      type = "timed";
      startPose = null;
      endPose = null;
    }
    return makeItem({
      block: block,
      type: type,
      entryId: target.id,
      entry: target,
      stepIndex: 0,
      seconds: isSeconds(step.seconds) ? step.seconds : 0,
      reps: reps,
      perSide: target.perSide === true,
      ownStart: ownStart,
      startPose: startPose,
      endPose: endPose,
      restSeconds: isSeconds(step.restSeconds) ? step.restSeconds : 0
    });
  }

  /* One held pose inside a flow (or a block flow). */
  function poseItem(target, seconds, block) {
    var pose = isObject(target.pose) ? target.pose : null;
    return makeItem({
      block: block,
      type: "hold",
      entryId: target.id,
      entry: target,
      stepIndex: 0,
      seconds: seconds,
      reps: null,
      perSide: target.perSide === true,
      ownStart: false,
      startPose: pose,
      endPose: pose,
      restSeconds: 0
    });
  }

  /* A walk or a landmark: one stretch of moving time, no pose to hold. */
  function timedItem(entry) {
    return makeItem({
      block: DEFAULT_BLOCK,
      type: "timed",
      entryId: entry.id,
      entry: entry,
      stepIndex: 0,
      seconds: isSeconds(entry.minutes) ? entry.minutes * 60 : 0,
      reps: null,
      perSide: false,
      ownStart: false,
      startPose: null,
      endPose: null,
      restSeconds: 0
    });
  }

  /* Every step of one routine block, resolved against the library. An id the
   * library does not know fails here, in every block, emitted or not. */
  function resolveSteps(list, blockName, byId) {
    var out = [];
    var steps = Array.isArray(list) ? list : [];
    for (var i = 0; i < steps.length; i += 1) {
      var step = steps[i];
      if (!isObject(step) || !isStr(step.id)) {
        throw new SessionError("unknown_step", blockName + "[" + i + "] must be { id, seconds }");
      }
      var target = byId.get(step.id);
      if (!target) {
        throw new SessionError("unknown_step", blockName + "[" + i + "] names an unknown id: " + step.id);
      }
      out.push({ step: step, target: target });
    }
    return out;
  }

  /* The chunk's planned time read off its items: every hold, rep, timed stretch
   * and rest. Transitions and breaks are never part of it. */
  function plannedOfItems(items) {
    var total = 0;
    for (var i = 0; i < items.length; i += 1) {
      total += items[i].seconds + items[i].restSeconds;
    }
    return total;
  }

  /* A chunk's rounds after a stage and the "one more round" extra, never so few
   * that the chunk drops under its own floor. */
  function roundsWithFloor(build, rounds, floor) {
    var items = build(rounds);
    var guard = 0;
    while (plannedOfItems(items) < floor && guard < 1000) {
      rounds += 1;
      items = build(rounds);
      guard += 1;
    }
    return { items: items, rounds: rounds };
  }

  function routineItems(entry, extraRounds, opts, byId, isFirst, isLast) {
    var blocks = isObject(entry.blocks) ? entry.blocks : {};
    var warmup = resolveSteps(blocks.warmup, "warmup", byId);
    var main = resolveSteps(blocks.main, "main", byId);
    var cooldown = resolveSteps(blocks.cooldown, "cooldown", byId);
    var baseRounds = isPositiveInt(entry.rounds) ? entry.rounds : 1;
    var stage = stageOf(entry, opts);
    var stageReps = stage && isPositiveInt(stage.reps) ? stage.reps : null;

    function push(list, resolved, block, reps) {
      for (var i = 0; i < resolved.length; i += 1) {
        list.push(stepItem(resolved[i].target, resolved[i].step, block, reps));
      }
    }
    /* The first chunk of a chain brings the warm-up block, the last one the
     * cool-down; everything between is main only. */
    function build(rounds, reps) {
      var items = [];
      if (isFirst) push(items, warmup, "warmup", null);
      for (var r = 0; r < rounds; r += 1) push(items, main, "main", reps);
      if (isLast) push(items, cooldown, "cooldown", null);
      return items;
    }

    var plain = build(baseRounds + extraRounds, null);
    if (!stage) return plain;
    var floor = Math.min(MIN_STAGE_SECONDS, plannedOfItems(plain));
    var rounds = isPositiveInt(stage.rounds) ? stage.rounds + extraRounds : baseRounds + extraRounds;
    return roundsWithFloor(function (r) { return build(r, stageReps); }, rounds, floor).items;
  }

  function flowItems(entry, extraRounds, opts, byId, isFirst, isLast) {
    var flow = Array.isArray(entry.flow) ? entry.flow : [];
    var holds = [];
    for (var h = 0; h < flow.length; h += 1) {
      var item = flow[h];
      var target = isObject(item) && isStr(item.id) ? byId.get(item.id) : null;
      if (!target) {
        throw new SessionError("unknown_step", "flow[" + h + "] names an unknown id");
      }
      holds.push({ target: target, seconds: isSeconds(item.holdSeconds) ? item.holdSeconds : 0 });
    }
    var baseRounds = isPositiveInt(entry.rounds) ? entry.rounds : DEFAULT_FLOW_ROUNDS;
    var stage = stageOf(entry, opts);

    /* The opening chunk of a chain eases in: its first round holds half the
     * time. The closing hold of the last chunk closes the session. */
    function build(rounds) {
      var items = [];
      for (var round = 0; round < rounds; round += 1) {
        for (var i = 0; i < holds.length; i += 1) {
          var seconds = holds[i].seconds;
          var block = DEFAULT_BLOCK;
          if (isFirst && rounds >= 2 && round === 0) {
            seconds = Math.ceil(seconds / 2);
            block = "warmup";
          }
          if (isLast && round === rounds - 1 && i === holds.length - 1) block = "cooldown";
          items.push(poseItem(holds[i].target, seconds, block));
        }
      }
      return items;
    }

    var plain = build(baseRounds + extraRounds);
    if (!stage) return plain;
    var floor = Math.min(MIN_STAGE_SECONDS, plannedOfItems(plain));
    var rounds = isPositiveInt(stage.rounds) ? stage.rounds + extraRounds : baseRounds + extraRounds;
    return roundsWithFloor(build, rounds, floor).items;
  }

  function itemsFor(entry, extraRounds, opts, byId, isFirst, isLast) {
    if (entry.kind === "routine") return routineItems(entry, extraRounds, opts, byId, isFirst, isLast);
    if (entry.kind === "flow") return flowItems(entry, extraRounds, opts, byId, isFirst, isLast);
    return [timedItem(entry)];
  }

  /* Every segment carries the full shape, in one place, so a reader (and the
   * clock) can rely on the keys being there. */
  function makeSegment(fields) {
    return {
      type: fields.type,
      chunkIndex: fields.chunkIndex,
      block: fields.block,
      entryId: fields.entryId,
      stepIndex: fields.stepIndex,
      seconds: fields.seconds,
      active: fields.active,
      fromPose: fields.fromPose,
      toPose: fields.toPose,
      reps: fields.reps,
      side: fields.side,
      cue: fields.cue,
      say: fields.say,
      anatomyStep: fields.anatomyStep
    };
  }

  function workSegment(item, side, seconds, fromPose, step, anatomyStep, chunkIndex) {
    return makeSegment({
      type: item.type,
      chunkIndex: chunkIndex,
      block: item.block,
      entryId: item.entryId,
      stepIndex: item.stepIndex,
      seconds: seconds,
      active: true,
      fromPose: fromPose,
      toPose: item.endPose,
      reps: item.reps,
      side: side,
      cue: step.cue,
      say: step.say,
      anatomyStep: anatomyStep
    });
  }

  function quietSegment(fields) {
    return makeSegment({
      type: fields.type,
      chunkIndex: fields.chunkIndex,
      block: fields.block,
      entryId: null,
      stepIndex: null,
      seconds: fields.seconds,
      active: false,
      fromPose: fields.fromPose,
      toPose: fields.toPose,
      reps: null,
      side: null,
      cue: "",
      say: "",
      anatomyStep: null
    });
  }

  /* One chunk's items become segments: a move into each step, the work itself
   * (per side when the entry asks), and its rest. */
  function emitItems(items, chunkIndex, opts, segments, state) {
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var step = Array.isArray(item.entry.steps) ? stepOf(item.entry.steps[item.stepIndex]) : stepOf("");
      var anatomyStep = anatomyAt(item.entry, item.stepIndex);
      var fromPose = item.ownStart ? item.startPose : state.prevPose;
      /* The very first step of a chunk gets no transition: nothing to move
       * from at the top of the chain, a chunk-break after a break. */
      if (i > 0) {
        segments.push(quietSegment({
          type: "transition",
          chunkIndex: chunkIndex,
          block: item.block,
          seconds: TRANSITION_SECONDS,
          fromPose: state.prevPose,
          toPose: item.startPose
        }));
      }
      if (item.perSide) {
        var firstSide = opts.perSideOrder === "right" ? "right" : "left";
        var secondSide = firstSide === "left" ? "right" : "left";
        var firstSeconds = Math.ceil(item.seconds / 2);
        segments.push(workSegment(item, firstSide, firstSeconds, fromPose, step, anatomyStep, chunkIndex));
        state.prevPose = item.endPose;
        segments.push(quietSegment({
          type: "switch-sides",
          chunkIndex: chunkIndex,
          block: item.block,
          seconds: SWITCH_SECONDS,
          fromPose: state.prevPose,
          toPose: item.endPose
        }));
        segments.push(workSegment(item, secondSide, item.seconds - firstSeconds, state.prevPose, step, anatomyStep, chunkIndex));
      } else {
        segments.push(workSegment(item, null, item.seconds, fromPose, step, anatomyStep, chunkIndex));
      }
      state.prevPose = item.endPose;
      state.lastBlock = item.block;
      if (item.restSeconds > 0) {
        segments.push(quietSegment({
          type: "rest",
          chunkIndex: chunkIndex,
          block: item.block,
          seconds: item.restSeconds,
          fromPose: state.prevPose,
          toPose: null
        }));
      }
    }
  }

  /* What the session counts per chunk: its holds, reps, timed stretches and
   * rests, never its moves or breaks. */
  function chunksOf(chain, segments) {
    var list = Array.isArray(chain) ? chain : [];
    var sums = [];
    for (var i = 0; i < list.length; i += 1) sums.push(0);
    var all = Array.isArray(segments) ? segments : [];
    for (var s = 0; s < all.length; s += 1) {
      var segment = all[s];
      if (!isObject(segment) || !COUNTED_TYPES[segment.type]) continue;
      var index = segment.chunkIndex;
      if (!Number.isInteger(index) || index < 0 || index >= sums.length) continue;
      sums[index] += isFinite(segment.seconds) ? segment.seconds : 0;
    }
    return list.map(function (item, index) {
      return {
        chunkId: isObject(item) ? item.chunkId : null,
        index: index,
        plannedSeconds: sums[index]
      };
    });
  }

  /* Under "memory" guidance only the first and the last segment speak. */
  function applyMemory(segments) {
    var last = segments.length - 1;
    for (var i = 0; i < segments.length; i += 1) {
      if (i === 0 || i === last) continue;
      segments[i].say = "";
    }
  }

  function compileSession(chain, library, opts) {
    var normalizedChain = normalizeChain(chain);
    var normalizedOpts = normalizeOpts(opts);
    var byId = toLibrary(library);
    var entries = normalizedChain.map(function (item) { return resolveChunk(item, byId); });

    var segments = [];
    var state = { prevPose: null, lastBlock: DEFAULT_BLOCK };
    for (var i = 0; i < entries.length; i += 1) {
      if (i > 0) {
        segments.push(quietSegment({
          type: "chunk-break",
          chunkIndex: i - 1,
          block: state.lastBlock,
          seconds: CHUNK_BREAK_SECONDS,
          fromPose: state.prevPose,
          toPose: null
        }));
      }
      var items = itemsFor(
        entries[i], normalizedChain[i].extraRounds, normalizedOpts, byId,
        i === 0, i === entries.length - 1
      );
      emitItems(items, i, normalizedOpts, segments, state);
    }

    if (normalizedOpts.guidance === "memory") applyMemory(segments);

    var totalSeconds = 0;
    for (var s = 0; s < segments.length; s += 1) totalSeconds += segments[s].seconds;

    return {
      segments: segments,
      chunks: chunksOf(normalizedChain, segments),
      totalSeconds: totalSeconds,
      chain: normalizedChain,
      opts: normalizedOpts
    };
  }

  /* One chunk on its own. */
  function compileTimeline(chunk, library, opts) {
    return compileSession([{ chunkId: chunk, extraRounds: 0 }], library, opts);
  }

  /* ---------- the clock ---------- */

  /* A float boundary is reached when this close to it: 0.1 + 0.2 seconds of
   * elapsed time must not leave a 0.0000001 s segment behind. */
  var CLOCK_EPSILON = 1e-9;
  /* Stops a timeline of zero-second segments from spinning forever. */
  var CLOCK_GUARD = 100000;

  function chunksLengthOf(timeline) {
    return isObject(timeline) && Array.isArray(timeline.chunks) ? timeline.chunks.length : 0;
  }

  function requireTimeline(timeline, what) {
    if (!isObject(timeline) || !Array.isArray(timeline.segments) || timeline.segments.length === 0) {
      throw new SessionError("bad_timeline", what + " needs a timeline with at least one segment");
    }
    return timeline;
  }

  function totalOfSegments(segments) {
    var total = 0;
    for (var i = 0; i < segments.length; i += 1) {
      total += isSeconds(segments[i].seconds) ? segments[i].seconds : 0;
    }
    return total;
  }

  /* One clock for the whole session: the figure, the step text, the voice, the
   * sounds and the counts all read this. Time is injected, so the module never
   * reads a real clock and a caller decides what a second is. */
  function createClock(spec) {
    var settings = isObject(spec) ? spec : {};
    var timeline = requireTimeline(settings.timeline, "createClock");
    var now = typeof settings.now === "function" ? settings.now : function () { return 0; };

    var segmentIndex = 0;
    var segmentElapsed = 0;
    var elapsed = 0;
    var paused = true;
    var ended = false;
    var activeSeconds = [];
    var listeners = [];
    var lastRead = now();

    for (var c = 0; c < chunksLengthOf(timeline); c += 1) activeSeconds.push(0);

    function state() {
      return {
        segmentIndex: segmentIndex,
        segmentElapsed: segmentElapsed,
        elapsed: elapsed,
        paused: paused,
        ended: ended,
        activeSeconds: activeSeconds.slice()
      };
    }

    /* A listener that throws is its own problem: the others still hear the
     * event and the clock keeps its own time. */
    function emit(type, cause) {
      var snapshot = listeners.slice();
      for (var i = 0; i < snapshot.length; i += 1) {
        try {
          snapshot[i]({
            type: type,
            segmentIndex: segmentIndex,
            cause: cause === undefined ? null : cause,
            state: state()
          });
        } catch (err) {
          continue;
        }
      }
    }

    function addActive(chunkIndex, seconds) {
      if (!(seconds > 0)) return;
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= activeSeconds.length) return;
      activeSeconds[chunkIndex] += seconds;
    }

    /* Spend a stretch of running time: every boundary it covers becomes a
     * "segment" event, and the last segment's end is the session's end. It
     * returns the seconds it really spent, so a stretch that runs past the end
     * of the timeline leaves the remainder unspent. */
    function advance(seconds) {
      var remaining = seconds;
      var consumed = 0;
      var guard = 0;
      while (!ended && guard < CLOCK_GUARD) {
        guard += 1;
        var segment = timeline.segments[segmentIndex];
        var left = segment.seconds - segmentElapsed;
        if (!(left > 0)) left = 0;
        var step = remaining < left ? remaining : left;
        addActive(segment.chunkIndex, segment.active ? step : 0);
        segmentElapsed += step;
        remaining -= step;
        consumed += step;
        if (segmentElapsed + CLOCK_EPSILON >= segment.seconds) {
          if (segmentIndex >= timeline.segments.length - 1) {
            segmentIndex = timeline.segments.length - 1;
            segmentElapsed = segment.seconds;
            ended = true;
            paused = true;
            emit("end", null);
            return consumed;
          }
          segmentIndex += 1;
          segmentElapsed = 0;
          emit("segment", "tick");
          if (!(remaining > 0)) return consumed;
          continue;
        }
        return consumed;
      }
      return consumed;
    }

    /* Read the injected clock. Time only moves the session while it is both
     * playing and unfinished; the read itself always happens, so a paused
     * stretch never lands in `elapsed` later. */
    function tick() {
      var read = now();
      var deltaMs = read - lastRead;
      lastRead = read;
      if (!paused && !ended && deltaMs > 0) {
        elapsed += advance(deltaMs / 1000);
      }
      return state();
    }

    function play() {
      /* A second play() while running still owes the session the time since
       * the last read; only then does a fresh read start the next stretch. */
      if (!paused && !ended) tick();
      lastRead = now();
      if (ended) return state();
      if (paused) {
        paused = false;
        emit("play", null);
      }
      return state();
    }

    function pause() {
      tick();
      if (!paused && !ended) {
        paused = true;
        emit("pause", null);
      }
      return state();
    }

    function seek(index) {
      if (!Number.isInteger(index)) {
        throw new SessionError("bad_index", "seek needs a whole segment index");
      }
      tick();
      var clamped = index < 0 ? 0 : index;
      if (clamped > timeline.segments.length - 1) clamped = timeline.segments.length - 1;
      segmentIndex = clamped;
      segmentElapsed = 0;
      ended = false;
      emit("segment", "seek");
      return state();
    }

    function skip() {
      tick();
      if (ended) return state();
      if (segmentIndex >= timeline.segments.length - 1) {
        segmentIndex = timeline.segments.length - 1;
        segmentElapsed = timeline.segments[segmentIndex].seconds;
        ended = true;
        paused = true;
        emit("end", null);
        return state();
      }
      /* The rest of the skipped segment is never added to `activeSeconds`. */
      segmentIndex += 1;
      segmentElapsed = 0;
      emit("segment", "skip");
      return state();
    }

    function back() {
      tick();
      var target = segmentIndex > 0 ? -1 : 0;
      for (var i = segmentIndex - 1; i >= 0; i -= 1) {
        if (timeline.segments[i].type !== "transition") {
          target = i;
          break;
        }
      }
      if (target < 0) target = 0;
      if (target !== segmentIndex) {
        ended = false;
        segmentIndex = target;
        segmentElapsed = 0;
        emit("segment", "back");
        return state();
      }
      /* Already at the head of the session: start it over, never moving
       * `elapsed` or `activeSeconds` backwards. */
      ended = false;
      segmentElapsed = 0;
      return state();
    }

    /* A recompiled timeline swapped in under a running session: the position
     * and the counts are the player's, the segments are the new ones. */
    function setTimeline(next) {
      requireTimeline(next, "setTimeline");
      /* The stretch run so far belongs to the old timeline; account for it
       * before the segments are swapped. */
      if (!paused && !ended) tick();
      var wasEnded = ended;
      var oldLength = timeline.segments.length;
      timeline = next;
      lastRead = now();
      /* A count already earned is never dropped: the array only ever grows, by
       * zeros, to reach the new chunk count. */
      var wanted = chunksLengthOf(next);
      while (activeSeconds.length < wanted) activeSeconds.push(0);
      if (segmentIndex > next.segments.length - 1) {
        segmentIndex = next.segments.length - 1;
        segmentElapsed = 0;
      }
      if (wasEnded && next.segments.length > oldLength) {
        segmentIndex = oldLength;
        segmentElapsed = 0;
        ended = false;
      }
      return state();
    }

    function on(listener) {
      if (typeof listener !== "function") return function () {};
      listeners.push(listener);
      var live = true;
      return function () {
        if (!live) return;
        live = false;
        var at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    }

    return {
      play: play,
      pause: pause,
      tick: tick,
      seek: seek,
      back: back,
      skip: skip,
      setTimeline: setTimeline,
      state: state,
      on: on
    };
  }

  /* ---------- adding to a running session ---------- */

  /* Every key of a segment but `block`: an addition turns the last hold of a
   * flow from its closing block back into a plain one, and that hold was
   * already played as it was then. */
  function withoutBlock(segment) {
    var copy = {};
    for (var key in segment) {
      if (key !== "block") copy[key] = segment[key];
    }
    return JSON.stringify(copy);
  }

  /* The first index where the recompiled segments part company with the ones
   * already played, or the old length when the old ones are a prefix.
   * Segments are compared without their `block`, so a segment whose only change
   * is the block it belongs to counts as unchanged and is never played twice. */
  function firstChangedIndex(freshSegments, oldSegments) {
    var common = Math.min(freshSegments.length, oldSegments.length);
    for (var i = 0; i < common; i += 1) {
      if (withoutBlock(freshSegments[i]) !== withoutBlock(oldSegments[i])) return i;
    }
    return oldSegments.length;
  }

  /* Append a chunk or one round of the last chunk. What was already played is
   * kept as it was played; only the part ahead of the player is recompiled, so
   * setTimeline on the result moves no count. */
  function extend(timeline, state, library, addition, opts) {
    var base = requireTimeline(timeline, "extend");
    var add = isObject(addition) ? addition : {};
    var chain = normalizeChain(base.chain).map(function (item) {
      return { chunkId: item.chunkId, extraRounds: item.extraRounds };
    });
    if (isStr(add.addChunk)) {
      chain.push({ chunkId: add.addChunk, extraRounds: 0 });
    } else if (add.addRound === true) {
      var tail = resolveChunk(chain[chain.length - 1], toLibrary(library));
      if (tail.kind === "walk" || tail.kind === "landmark") {
        throw new SessionError("no_rounds", tail.id + " is one stretch of time, not rounds to add");
      }
      chain[chain.length - 1].extraRounds += 1;
    }

    var fresh = compileSession(chain, library, opts === undefined || opts === null ? base.opts : opts);
    var oldSegments = base.segments;
    var changedAt = firstChangedIndex(fresh.segments, oldSegments);
    var at = isObject(state) && Number.isInteger(state.segmentIndex) ? state.segmentIndex : 0;
    var segments;
    if (at < changedAt) {
      segments = fresh.segments;
    } else {
      segments = oldSegments.slice(0, at + 1).concat(fresh.segments.slice(changedAt));
    }

    return {
      segments: segments,
      chunks: chunksOf(chain, segments),
      totalSeconds: totalOfSegments(segments),
      chain: fresh.chain,
      opts: fresh.opts
    };
  }

  /* Half of a chunk's planned time is enough for it to count as done. */
  function isChunkDone(plannedSeconds, activeSeconds) {
    if (!isSeconds(plannedSeconds)) return false;
    var active = typeof activeSeconds === "number" && isFinite(activeSeconds) ? activeSeconds : 0;
    return active >= plannedSeconds / 2;
  }

  function roundsBaseOf(entry) {
    if (isPositiveInt(entry.rounds)) return entry.rounds;
    return entry.kind === "flow" ? DEFAULT_FLOW_ROUNDS : 1;
  }

  function sharesArea(one, two) {
    var a = Array.isArray(one.areas) ? one.areas : [];
    var b = Array.isArray(two.areas) ? two.areas : [];
    for (var i = 0; i < a.length; i += 1) {
      if (b.indexOf(a[i]) >= 0) return true;
    }
    return false;
  }

  /* May this addition be offered at all? The reasons are the picker's own
   * words, never a sentence. */
  function canExtend(timeline, state, library, addition, opts) {
    var base = requireTimeline(timeline, "canExtend");
    var add = isObject(addition) ? addition : {};
    var byId = toLibrary(library);
    var chain = normalizeChain(base.chain);
    var lastItem = chain[chain.length - 1];

    /* A walk and a landmark are one stretch of moving time: no rounds to add. */
    if (!isStr(add.addChunk) && add.addRound === true) {
      var lastEntry = resolveChunk(lastItem, byId);
      if (lastEntry.kind === "walk" || lastEntry.kind === "landmark") {
        return { ok: false, reason: "max_rounds" };
      }
      var rounds = roundsBaseOf(lastEntry);
      var limit = isPositiveInt(lastEntry.maxRounds) ? lastEntry.maxRounds : Math.max(2, rounds + 1);
      if (rounds + lastItem.extraRounds + 1 > limit) return { ok: false, reason: "max_rounds" };
    }

    if (isStr(add.addChunk)) {
      var newEntry = resolveChunk({ chunkId: add.addChunk, extraRounds: 0 }, byId);
      var tailEntry = resolveChunk(lastItem, byId);
      if (newEntry.level === 3 && tailEntry.level === 3 && sharesArea(newEntry, tailEntry)) {
        return { ok: false, reason: "hard_same_area" };
      }
    }

    var extended = extend(base, state, library, add, opts);
    var planned = 0;
    for (var i = 0; i < extended.chunks.length; i += 1) planned += extended.chunks[i].plannedSeconds;
    if (planned > SESSION_MAX_SECONDS) return { ok: false, reason: "max_session" };

    return { ok: true, reason: null };
  }

  return {
    SessionError: SessionError,
    SESSION_MAX_SECONDS: SESSION_MAX_SECONDS,
    REST_HINT_SECONDS: REST_HINT_SECONDS,
    TRANSITION_SECONDS: TRANSITION_SECONDS,
    SWITCH_SECONDS: SWITCH_SECONDS,
    CHUNK_BREAK_SECONDS: CHUNK_BREAK_SECONDS,
    DEFAULT_FLOW_ROUNDS: DEFAULT_FLOW_ROUNDS,
    MIN_STAGE_SECONDS: MIN_STAGE_SECONDS,
    compileSession: compileSession,
    compileTimeline: compileTimeline,
    chunksOf: chunksOf,
    createClock: createClock,
    extend: extend,
    isChunkDone: isChunkDone,
    canExtend: canExtend
  };
});