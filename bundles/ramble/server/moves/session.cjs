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
    chunksOf: chunksOf
  };
});