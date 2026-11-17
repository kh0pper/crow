/**
 * Crow Studio — the scene plan, as one inline classic script.
 *
 * The plan is the arrangement, read as a list of named bar ranges: the song's
 * own sections when it has any, and for the bars outside every section the
 * scene each placement plays. A ruler draws those blocks and a ruler needs them
 * to be one picture — whole bars, in order, never overlapping — and that is
 * exactly what is easy to get subtly wrong in three places at once, so the
 * rules live here, once, in dependency-free plain JavaScript:
 *
 *   - `SCENE_PLAN_SCRIPT` is a classic script (an IIFE that assigns one global,
 *     `window.StudioScenePlan`). It is emitted into the page before the client
 *     (see `panel/studio.js`), so the ruler, the plan widget and the options
 *     row under it all read the same plan.
 *   - the named exports below are produced by evaluating THAT SAME string in
 *     Node with `new Function`, so a case drives the very bytes the page runs.
 *
 * Like `panel/client.js`, `panel/pad-input.js` and `panel/record-view.js` this
 * travels as a string and is written as an EXPRESSIONS ONLY classic script: no
 * backtick, no `${`, no double quote and no backslash anywhere in the emitted
 * text. It builds nothing in the DOM.
 *
 * ## What each rule is for
 *
 * - `planOf(snap)` answers the plan: an array of `{start_bar, end_bar, label,
 *   scene_id, section_id}` blocks with `end_bar` exclusive, sorted by
 *   `start_bar`, whole bars and never overlapping. A song with sections gives
 *   one block per section, labelled by its name and carrying its
 *   `section_id`; the bars outside every section that a placement covers are
 *   gathered by the scene of the clip that placement plays, so a scene placed
 *   twice in a row (or on two tracks over the same bars) is one block. A
 *   placement with no scene, and a placement whose clip is missing, is keyed
 *   by its clip and labelled by the clip's name.
 * - `blockAt(blocks, bar)` is the block covering a bar, `end_bar` exclusive, so
 *   a bar that is one block's `end_bar` and the next block's `start_bar`
 *   belongs to the next block. `nextBlock(blocks, bar)` is the first block that
 *   starts after that bar, which is what follows the plan while recording.
 *
 * Everything here is view logic over a snapshot: nothing in this file reads or
 * writes a document, and nothing here is a command. The snapshot is read, never
 * changed, and a null or nonsense snapshot reads as an empty arrangement.
 *
 * @type {string}
 */
export const SCENE_PLAN_SCRIPT = [
  "(function () {",
  "  'use strict';",
  "",
  "  // What a block is called when the name it would carry is empty.",
  "  var SECTION_LABEL = 'Section';",
  "  var CLIP_LABEL = 'Clip';",
  "",
  "  // The prefix a placement with no scene of its own is keyed by, so a clip",
  "  // without a scene never groups with a scene of that name.",
  "  var CLIP_KEY_PREFIX = 'clip:';",
  "",
  "  // A value as a number, or null for no number at all: a missing value, a",
  "  // blank string, a NaN and an infinity are all no number.",
  "  function numberAt(value) {",
  "    if (value === undefined || value === null || value === '') return null;",
  "    var number = typeof value === 'number' ? value : Number(value);",
  "    return isFinite(number) ? number : null;",
  "  }",
  "",
  "  // Anything that can hold a map entry, or null. An arrangement map may hold",
  "  // whatever a peer sent it.",
  "  function entryOf(value) {",
  "    return value && typeof value === 'object' ? value : null;",
  "  }",
  "",
  "  // One character class for the whitespace a name can arrive padded with.",
  "  function isSpace(code) {",
  "    return code === 32 || code === 9 || code === 10 || code === 13 || code === 160;",
  "  }",
  "",
  "  // A name without the spaces at its two ends, as one string. An empty answer",
  "  // means the name said nothing.",
  "  function textOf(value) {",
  "    if (value === undefined || value === null) return '';",
  "    var text = String(value);",
  "    var from = 0;",
  "    var to = text.length;",
  "    while (from < to && isSpace(text.charCodeAt(from))) from += 1;",
  "    while (to > from && isSpace(text.charCodeAt(to - 1))) to -= 1;",
  "    return text.slice(from, to);",
  "  }",
  "",
  "  // A name, or what a block is called when the name said nothing.",
  "  function labelOf(value, fallback) {",
  "    var text = textOf(value);",
  "    return text ? text : fallback;",
  "  }",
  "",
  "  // The two maps of a snapshot's arrangement this file reads, whatever the",
  "  // snapshot says: a missing arrangement and a missing map both read as empty.",
  "  function arrangementOf(snap) {",
  "    var raw = snap && typeof snap === 'object' ? entryOf(snap.arrangement) : null;",
  "    var found = raw ? raw : {};",
  "    return {",
  "      placements: entryOf(found.placements) ? found.placements : {},",
  "      sections: entryOf(found.sections) ? found.sections : {}",
  "    };",
  "  }",
  "",
  "  // A snapshot's clips, whatever the snapshot says.",
  "  function clipsOf(snap) {",
  "    var found = snap && typeof snap === 'object' ? entryOf(snap.clips) : null;",
  "    return found ? found : {};",
  "  }",
  "",
  "  // The scene a scene id names, or null: snap.scenes is a list of scenes.",
  "  function sceneOf(snap, sceneId) {",
  "    var scenes = snap && typeof snap === 'object' ? snap.scenes : null;",
  "    if (!sceneId || !scenes || typeof scenes.length !== 'number') return null;",
  "    for (var at = 0; at < scenes.length; at += 1) {",
  "      var scene = entryOf(scenes[at]);",
  "      if (!scene) continue;",
  "      if (textOf(scene.id) === sceneId) return scene;",
  "    }",
  "    return null;",
  "  }",
  "",
  "  /**",
  "   * The song's sections as plan blocks, one per section, in bar order.",
  "   *",
  "   * A section covers the bars from its start, rounded down, up to its end,",
  "   * rounded up: a block is whole bars. A section with nothing left of it is",
  "   * not a block, and a section that starts before the one before it ended",
  "   * (data from a peer that overlapped them) has its start moved up to that",
  "   * end, or goes away when nothing is left of it — blocks never overlap.",
  "   *",
  "   * @param {object} sections - the snapshot's section map",
  "   * @returns {Array<object>} the section blocks, in bar order",
  "   */",
  "  function sectionBlocks(sections) {",
  "    var found = [];",
  "    for (var key in sections) {",
  "      if (!Object.prototype.hasOwnProperty.call(sections, key)) continue;",
  "      var section = entryOf(sections[key]);",
  "      if (!section) continue;",
  "      var startAt = numberAt(section.start_bar);",
  "      var endAt = numberAt(section.end_bar);",
  "      if (startAt === null || endAt === null) continue;",
  "      var start = Math.floor(startAt);",
  "      var end = Math.ceil(endAt);",
  "      if (end <= start) continue;",
  "      var id = textOf(section.id);",
  "      found.push({",
  "        start_bar: start,",
  "        end_bar: end,",
  "        label: labelOf(section.name, SECTION_LABEL),",
  "        scene_id: null,",
  "        section_id: id ? id : String(key)",
  "      });",
  "    }",
  "    found.sort(function (a, b) { return a.start_bar - b.start_bar; });",
  "    var out = [];",
  "    var edge = null;",
  "    for (var at = 0; at < found.length; at += 1) {",
  "      var block = found[at];",
  "      if (edge !== null && block.start_bar < edge) block.start_bar = edge;",
  "      if (block.end_bar <= block.start_bar) continue;",
  "      out.push(block);",
  "      edge = block.end_bar;",
  "    }",
  "    return out;",
  "  }",
  "",
  "  /**",
  "   * One placement's own stretch of bars, minus every section block.",
  "   *",
  "   * A placement that straddles a section is the bars before it and the bars",
  "   * after it, so a plan never draws the same bar twice and the section keeps",
  "   * its own name over its own bars.",
  "   *",
  "   * @param {Array<object>} out - the segment list to append to",
  "   * @param {number} start - the placement's first bar",
  "   * @param {number} end - one past its last bar",
  "   * @param {Array<object>} sections - the section blocks, in bar order",
  "   * @param {string} segmentKey - what bars group by",
  "   * @param {string} label - the block's label",
  "   * @param {string|null} sceneId - the scene the block plays, if it plays one",
  "   */",
  "  function addSegments(out, start, end, sections, segmentKey, label, sceneId) {",
  "    var cursor = start;",
  "    for (var at = 0; at < sections.length; at += 1) {",
  "      var section = sections[at];",
  "      if (section.end_bar <= cursor) continue;",
  "      if (section.start_bar >= end) break;",
  "      if (section.start_bar > cursor) {",
  "        out.push({",
  "          start: cursor,",
  "          end: section.start_bar < end ? section.start_bar : end,",
  "          key: segmentKey,",
  "          label: label,",
  "          scene_id: sceneId",
  "        });",
  "      }",
  "      if (section.end_bar > cursor) cursor = section.end_bar;",
  "      if (cursor >= end) return;",
  "    }",
  "    if (cursor < end) {",
  "      out.push({ start: cursor, end: end, key: segmentKey, label: label, scene_id: sceneId });",
  "    }",
  "  }",
  "",
  "  /**",
  "   * The bars outside every section, as blocks gathered by scene.",
  "   *",
  "   * Each placement is keyed by the scene of the clip it plays, or by the clip",
  "   * itself when that scene is empty or the clip is gone. The segments are read",
  "   * in bar order against a cursor, so two placements over the same bars give",
  "   * the earlier one the bars and trim the later one to what is left, often",
  "   * nothing at all. A segment that carries on exactly where the block before",
  "   * it ended, with the same key, extends that block instead of starting",
  "   * another:",
  "   * one scene played twice in a row, or on two tracks over the same bars, is",
  "   * one block.",
  "   *",
  "   * @param {object} snap - the song snapshot",
  "   * @param {Array<object>} sections - the section blocks, in bar order",
  "   * @returns {Array<object>} the placement blocks, in bar order",
  "   */",
  "  function placementBlocks(snap, sections) {",
  "    var arrangement = arrangementOf(snap);",
  "    var clips = clipsOf(snap);",
  "    var segments = [];",
  "    for (var key in arrangement.placements) {",
  "      if (!Object.prototype.hasOwnProperty.call(arrangement.placements, key)) continue;",
  "      var placement = entryOf(arrangement.placements[key]);",
  "      if (!placement) continue;",
  "      var startAt = numberAt(placement.start_bar);",
  "      var bars = numberAt(placement.bars);",
  "      if (startAt === null || bars === null) continue;",
  "      if (bars < 1) continue;",
  "      var start = Math.floor(startAt);",
  "      var end = Math.ceil(startAt + bars);",
  "      if (end <= start) continue;",
  "      var clipId = textOf(placement.clip_id);",
  "      var clip = entryOf(clips[clipId]);",
  "      var sceneId = clip ? textOf(clip.scene_id) : '';",
  "      if (sceneId) {",
  "        var scene = sceneOf(snap, sceneId);",
  "        addSegments(segments, start, end, sections, sceneId, labelOf(scene ? scene.name : '', sceneId), sceneId);",
  "      } else {",
  "        addSegments(segments, start, end, sections, CLIP_KEY_PREFIX + clipId, labelOf(clip ? clip.name : '', CLIP_LABEL), null);",
  "      }",
  "    }",
  "    segments.sort(function (a, b) {",
  "      if (a.start !== b.start) return a.start - b.start;",
  "      if (a.end !== b.end) return a.end - b.end;",
  "      // Two segments over exactly the same bars are decided by their key, so",
  "      // the plan never depends on the order a map was read in.",
  "      if (a.key === b.key) return 0;",
  "      return a.key < b.key ? -1 : 1;",
  "    });",
  "    var out = [];",
  "    var edge = null;",
  "    var lastKey = null;",
  "    for (var at = 0; at < segments.length; at += 1) {",
  "      var segment = segments[at];",
  "      var from = segment.start;",
  "      if (edge !== null && from < edge) from = edge;",
  "      if (from >= segment.end) continue;",
  "      var last = out.length > 0 ? out[out.length - 1] : null;",
  "      if (last && lastKey === segment.key && from === last.end_bar) {",
  "        last.end_bar = segment.end;",
  "      } else {",
  "        out.push({",
  "          start_bar: from,",
  "          end_bar: segment.end,",
  "          label: segment.label,",
  "          scene_id: segment.scene_id,",
  "          section_id: null",
  "        });",
  "        lastKey = segment.key;",
  "      }",
  "      edge = out[out.length - 1].end_bar;",
  "    }",
  "    return out;",
  "  }",
  "",
  "  /**",
  "   * The plan: one block per section, then the placements by scene outside",
  "   * every section, in bar order.",
  "   *",
  "   * @param {object} snap - the song snapshot, read and never changed",
  "   * @returns {Array<object>} the blocks, or [] for no arrangement at all",
  "   */",
  "  function planOf(snap) {",
  "    var sections = sectionBlocks(arrangementOf(snap).sections);",
  "    var blocks = sections.slice(0);",
  "    var filled = placementBlocks(snap, sections);",
  "    for (var at = 0; at < filled.length; at += 1) blocks.push(filled[at]);",
  "    blocks.sort(function (a, b) { return a.start_bar - b.start_bar; });",
  "    return blocks;",
  "  }",
  "",
  "  /**",
  "   * The block a bar falls in: start_bar included, end_bar not.",
  "   *",
  "   * A bar that is one block's end_bar and the next block's start_bar belongs",
  "   * to the next block, and a bar in a gap belongs to nothing.",
  "   *",
  "   * @param {Array<object>} blocks - a plan, in bar order",
  "   * @param {number} bar",
  "   * @returns {object|null} the block, or null when no block covers the bar",
  "   */",
  "  function blockAt(blocks, bar) {",
  "    if (!Array.isArray(blocks)) return null;",
  "    var at = numberAt(bar);",
  "    if (at === null) return null;",
  "    for (var index = 0; index < blocks.length; index += 1) {",
  "      var block = entryOf(blocks[index]);",
  "      if (!block) continue;",
  "      var start = numberAt(block.start_bar);",
  "      var end = numberAt(block.end_bar);",
  "      if (start === null || end === null) continue;",
  "      if (at >= start && at < end) return block;",
  "    }",
  "    return null;",
  "  }",
  "",
  "  /**",
  "   * The first block that starts after a bar: what follows the plan from there.",
  "   *",
  "   * While a bar is inside a block that is the block after it, and while the bar",
  "   * is in a gap it is the next block that starts. A bar at the end of a block,",
  "   * where the next one starts, already belongs to that next block, so this",
  "   * answers the one after that.",
  "   *",
  "   * @param {Array<object>} blocks - a plan, in bar order",
  "   * @param {number} bar",
  "   * @returns {object|null} the block, or null when nothing starts after the bar",
  "   */",
  "  function nextBlock(blocks, bar) {",
  "    if (!Array.isArray(blocks)) return null;",
  "    var at = numberAt(bar);",
  "    if (at === null) return null;",
  "    var found = null;",
  "    var foundStart = 0;",
  "    for (var index = 0; index < blocks.length; index += 1) {",
  "      var block = entryOf(blocks[index]);",
  "      if (!block) continue;",
  "      var start = numberAt(block.start_bar);",
  "      if (start === null) continue;",
  "      if (start <= at) continue;",
  "      if (found === null || start < foundStart) {",
  "        found = block;",
  "        foundStart = start;",
  "      }",
  "    }",
  "    return found;",
  "  }",
  "",
  "  window.StudioScenePlan = {",
  "    SECTION_LABEL: SECTION_LABEL,",
  "    CLIP_LABEL: CLIP_LABEL,",
  "    CLIP_KEY_PREFIX: CLIP_KEY_PREFIX,",
  "    planOf: planOf,",
  "    blockAt: blockAt,",
  "    nextBlock: nextBlock",
  "  };",
  "})();",
].join("\n");

/**
 * The plan's rules, evaluated from the very string the page inlines.
 *
 * `new Function` with a `window` parameter means the script's one global lands
 * on the object this module keeps, and never on Node's `globalThis`.
 */
const scenePlanApi = new Function(
  "window",
  `${SCENE_PLAN_SCRIPT}\nreturn window.StudioScenePlan;`,
)({});

/** What a section block is called when the section has no name. */
export const SECTION_LABEL = scenePlanApi.SECTION_LABEL;

/** What a placement block is called when the clip has no name. */
export const CLIP_LABEL = scenePlanApi.CLIP_LABEL;

/** The prefix a placement with no scene is keyed by. */
export const CLIP_KEY_PREFIX = scenePlanApi.CLIP_KEY_PREFIX;

/**
 * The plan: sections first, then the bars outside them by scene.
 * @param {object} snap - the song snapshot
 * @returns {Array<{start_bar: number, end_bar: number, label: string, scene_id: string|null, section_id: string|null}>}
 */
export function planOf(snap) {
  return scenePlanApi.planOf(snap);
}

/**
 * The block a bar falls in, end_bar exclusive.
 * @param {Array<object>} blocks
 * @param {number} bar
 * @returns {object|null}
 */
export function blockAt(blocks, bar) {
  return scenePlanApi.blockAt(blocks, bar);
}

/**
 * The first block that starts after a bar.
 * @param {Array<object>} blocks
 * @param {number} bar
 * @returns {object|null}
 */
export function nextBlock(blocks, bar) {
  return scenePlanApi.nextBlock(blocks, bar);
}