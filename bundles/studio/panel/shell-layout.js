/**
 * Crow Studio — the shell's layout model, as one inline classic script.
 *
 * The Studio shell is a grid of widgets: the scene grid, the one editor slot,
 * the sampler's four (pads, steps, chop and effects), the record lanes and the
 * scene plan, the takes lane, the MIDI lane, the history and the agent box.
 * Which of them are on the page, in what order, and at which size is VIEW STATE
 * and lives
 * here — in this browser, for this song, in this mode and size class. It is
 * never a command, never a history entry and never part of the song document,
 * because a layout in the document would sync to every peer and the agent, and
 * would make one person's phone rewrite another's laptop.
 *
 * Like `panel/client.js` and `panel/midi-route.js` this travels as a string
 * (`SHELL_LAYOUT_SCRIPT`) and is written as an EXPRESSIONS ONLY classic script:
 * no backtick, no `${`, no double quote and no backslash anywhere in the
 * emitted text. It assigns one global — `window.StudioShellLayout` — and builds
 * nothing in the DOM, so the page can inline it verbatim.
 *
 * The named exports below are produced by evaluating THAT SAME string in Node
 * with `new Function`, so a test drives exactly the bytes the page runs.
 *
 * ## What a layout is
 *
 * `{"v":1,"shown":[{"id":"scene-grid","size":"l"}]}` — the widgets on the page,
 * in page order, each at one of the sizes its own table allows. Anything the
 * table does not know is dropped on the way in, so a stored layout from an older
 * panel can never put an unknown id on the page, and a widget the panel gained
 * later is simply in the tray until the operator adds it.
 *
 * ## Where it is kept
 *
 * An injected `{getItem, setItem}` store — `window.localStorage` in the page, a
 * plain object in a test — under one key per song, mode and size class, so a
 * phone and a laptop each keep their own arrangement of the same song:
 *
 *   - `crow.studio.layout.v2.<songId>.<mode>.<sizeClass>`
 *   - `crow.studio.layoutSeeded.v2.<songId>` (the template was already handed
 *     to this song on this device)
 *
 * The store is injected rather than read from `window`, so a browser that
 * refuses storage is a case the model answers rather than a crash: reads fall
 * back to the built-in default and writes answer `false`.
 *
 * ## The operator's template
 *
 * An instance-local setting (not a synced one) holds the operator's default
 * layout per mode and size class. It seeds a song the FIRST time that song is
 * opened on this device: `seedSong` materializes every mode and size class
 * (the template's entry where it has one, the built-in default otherwise) and
 * then writes the marker. Every slot is written, so a template entry added
 * later never reaches a song that was already opened here.
 *
 * @type {string}
 */
export const SHELL_LAYOUT_SCRIPT = [
  "(function () {",
  "  'use strict';",
  "",
  "  // The three things the shell can be doing, and the three widths it lays",
  "  // out for.",
  "  var MODES = ['compose', 'perform', 'record'];",
  "  var SIZE_CLASSES = ['phone', 'tablet', 'laptop'];",
  "",
  "  // Every widget the shell knows, in the order a tray lists them, with the",
  "  // sizes each one may take. The sizes are the plan's: a widget that needs",
  "  // room for a grid or an editor never shrinks to a column.",
  "  var WIDGET_ORDER = ['scene-grid', 'editor', 'pads', 'steps', 'chop', 'fx', 'keyboard', 'mixer-strip', 'rec-lanes', 'scene-plan', 'takes', 'midi', 'history', 'agent'];",
  "  var WIDGETS = {",
  "    'scene-grid': { sizes: ['m', 'l'] },",
  "    'editor': { sizes: ['m', 'l'] },",
  "    'pads': { sizes: ['m', 'l'] },",
  "    'steps': { sizes: ['m', 'l'] },",
  "    'chop': { sizes: ['m', 'l'] },",
  "    'fx': { sizes: ['s', 'm'] },",
  "    'keyboard': { sizes: ['m', 'l'] },",
  "    'mixer-strip': { sizes: ['s', 'm'] },",
  "    'rec-lanes': { sizes: ['m', 'l'] },",
  "    'scene-plan': { sizes: ['s', 'm'] },",
  "    'takes': { sizes: ['s', 'm', 'l'] },",
  "    'midi': { sizes: ['s', 'm'] },",
  "    'history': { sizes: ['s', 'm'] },",
  "    'agent': { sizes: ['s', 'm'] }",
  "  };",
  "",
  "  // A mode's starting layout before this device has saved one. The agent is",
  "  // in the tray in every mode, so a song arrives with a page the operator can",
  "  // read and a tray they can pull from.",
  "  var DEFAULTS = {",
  "    compose: [",
  "      ['scene-grid', 'l'], ['editor', 'm'], ['pads', 'm'], ['steps', 'l'], ['fx', 's'], ['history', 's']",
  "    ],",
  "    perform: [['scene-grid', 'l'], ['pads', 'l'], ['fx', 'm'], ['midi', 's'], ['history', 's']],",
  "    record: [",
  "      ['rec-lanes', 'l'], ['scene-plan', 'm'], ['takes', 'm'], ['pads', 'm'], ['scene-grid', 'm'], ['midi', 's'], ['history', 's']",
  "    ]",
  "  };",
  "",
  "  // A widget's span: of 12 columns on a laptop, of 6 on a tablet. A phone is",
  "  // one widget per row whatever its size says, so the size only decides the",
  "  // order there.",
  "  var LAPTOP_SPANS = { s: 4, m: 6, l: 12 };",
  "  var TABLET_SPANS = { s: 3, m: 6, l: 6 };",
  "",
  "  // This device's keys, and the cap the operator's template is held to (the",
  "  // setting is small on purpose: it is a preference, not a document).",
  "  var LAYOUT_PREFIX = 'crow.studio.layout.v2.';",
  "  var SEEDED_PREFIX = 'crow.studio.layoutSeeded.v2.';",
  "  var TEMPLATE_MAX_BYTES = 8192;",
  "  var VERSION = 1;",
  "",
  "  function hasOwn(object, key) {",
  "    return Object.prototype.hasOwnProperty.call(object, key);",
  "  }",
  "",
  "  function hasWidget(id) {",
  "    return typeof id === 'string' && hasOwn(WIDGETS, id);",
  "  }",
  "",
  "  // The sizes one widget may take, or an empty list for an id no widget has.",
  "  function sizesOf(id) {",
  "    return hasWidget(id) ? WIDGETS[id].sizes : [];",
  "  }",
  "",
  "  // A widget at a size it may take, or at the first size it may take. A",
  "  // stored layout that names a size a later panel dropped still lands.",
  "  function sized(id, size) {",
  "    var sizes = sizesOf(id);",
  "    return sizes.indexOf(size) >= 0 ? size : sizes[0];",
  "  }",
  "",
  "  function copyRow(row) {",
  "    return { id: row.id, size: row.size };",
  "  }",
  "",
  "  function copyLayout(layout) {",
  "    var shown = [];",
  "    var rows = layout && Array.isArray(layout.shown) ? layout.shown : [];",
  "    for (var i = 0; i < rows.length; i += 1) shown.push(copyRow(rows[i]));",
  "    return { v: VERSION, shown: shown };",
  "  }",
  "",
  "  // ---- reading and writing a layout -------------------------------------",
  "",
  "  // A stored (or handed-in) value as a layout, or the fallback when it is not",
  "  // one: broken JSON, a version this build does not know, nothing shown, or",
  "  // nothing left after the unknown and duplicate ids are dropped. Rows are",
  "  // rebuilt, so a caller can never reach into the value it passed.",
  "  function normalizeLayout(value, fallback) {",
  "    var raw = value;",
  "    if (typeof raw === 'string') {",
  "      try {",
  "        raw = JSON.parse(raw);",
  "      } catch (err) {",
  "        return copyLayout(fallback);",
  "      }",
  "    }",
  "    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return copyLayout(fallback);",
  "    if (raw.v !== VERSION) return copyLayout(fallback);",
  "    var rows = Array.isArray(raw.shown) ? raw.shown : [];",
  "    var shown = [];",
  "    for (var i = 0; i < rows.length; i += 1) {",
  "      var row = rows[i];",
  "      if (!row || typeof row !== 'object') continue;",
  "      if (!hasWidget(row.id)) continue;",
  "      var already = false;",
  "      for (var j = 0; j < shown.length; j += 1) {",
  "        if (shown[j].id === row.id) already = true;",
  "      }",
  "      if (already) continue;",
  "      shown.push({ id: row.id, size: sized(row.id, row.size) });",
  "    }",
  "    if (shown.length === 0) return copyLayout(fallback);",
  "    return { v: VERSION, shown: shown };",
  "  }",
  "",
  "  // A value as a layout with the built-in default as its floor: what every",
  "  // helper starts from, so each one returns a fresh layout that shares",
  "  // nothing with its argument.",
  "  function asLayout(value) {",
  "    return normalizeLayout(value, defaultLayout('compose', 'laptop'));",
  "  }",
  "",
  "  function parseLayout(raw, fallback) {",
  "    var floor = fallback || defaultLayout('compose', 'laptop');",
  "    return normalizeLayout(raw, floor);",
  "  }",
  "",
  "  function serializeLayout(layout) {",
  "    var rows = [];",
  "    var shown = layout && Array.isArray(layout.shown) ? layout.shown : [];",
  "    for (var i = 0; i < shown.length; i += 1) {",
  "      rows.push({ id: shown[i].id, size: shown[i].size });",
  "    }",
  "    return JSON.stringify({ v: VERSION, shown: rows });",
  "  }",
  "",
  "  // ---- the built-in defaults --------------------------------------------",
  "",
  "  // A mode's starting layout. Every width starts from the same set (a phone",
  "  // stacks them one per row), and a mode this build does not know starts from",
  "  // compose, so a stale stored mode never leaves the page empty.",
  "  function defaultLayout(mode, sizeClass) {",
  "    var rows = DEFAULTS[hasOwn(DEFAULTS, mode) ? mode : 'compose'];",
  "    var shown = [];",
  "    for (var i = 0; i < rows.length; i += 1) {",
  "      shown.push({ id: rows[i][0], size: rows[i][1] });",
  "    }",
  "    return { v: VERSION, shown: shown };",
  "  }",
  "",
  "  // The width class the page lays out for: phone under 640, tablet under",
  "  // 1024, laptop at and above it.",
  "  function sizeClassFor(width) {",
  "    var px = Number(width);",
  "    if (!isFinite(px)) px = 0;",
  "    if (px < 640) return 'phone';",
  "    if (px < 1024) return 'tablet';",
  "    return 'laptop';",
  "  }",
  "",
  "  // ---- the tray ----------------------------------------------------------",
  "",
  "  function shownAt(layout, id) {",
  "    var shown = layout.shown;",
  "    for (var i = 0; i < shown.length; i += 1) {",
  "      if (shown[i].id === id) return i;",
  "    }",
  "    return -1;",
  "  }",
  "",
  "  // The widgets this layout does not show, in the widget table's order: what",
  "  // the tray offers, including a widget this panel gained after the layout",
  "  // was saved.",
  "  function trayOf(layout) {",
  "    var base = asLayout(layout);",
  "    var tray = [];",
  "    for (var i = 0; i < WIDGET_ORDER.length; i += 1) {",
  "      if (shownAt(base, WIDGET_ORDER[i]) < 0) tray.push(WIDGET_ORDER[i]);",
  "    }",
  "    return tray;",
  "  }",
  "",
  "  // ---- changing a layout ------------------------------------------------",
  "",
  "  // A shown widget moved to a new place, its index clamped into the page.",
  "  function moveWidget(layout, id, toIndex) {",
  "    var base = asLayout(layout);",
  "    var at = shownAt(base, id);",
  "    if (at < 0) return base;",
  "    var row = base.shown.splice(at, 1)[0];",
  "    var target = toIndex === null || toIndex === undefined ? base.shown.length : Math.floor(Number(toIndex));",
  "    if (!isFinite(target)) target = base.shown.length;",
  "    if (target < 0) target = 0;",
  "    if (target > base.shown.length) target = base.shown.length;",
  "    base.shown.splice(target, 0, row);",
  "    return base;",
  "  }",
  "",
  "  // A widget at its next allowed size, wrapping back to the first: s, m, l",
  "  // where all three are allowed, and only the allowed ones anywhere else.",
  "  function resizeWidget(layout, id) {",
  "    var base = asLayout(layout);",
  "    var at = shownAt(base, id);",
  "    if (at < 0) return base;",
  "    var sizes = sizesOf(id);",
  "    var current = sizes.indexOf(base.shown[at].size);",
  "    base.shown[at].size = sizes[(current + 1) % sizes.length];",
  "    return base;",
  "  }",
  "",
  "  // A widget taken off the page: it lands in the tray, in table order.",
  "  function hideWidget(layout, id) {",
  "    var base = asLayout(layout);",
  "    var at = shownAt(base, id);",
  "    if (at >= 0) base.shown.splice(at, 1);",
  "    return base;",
  "  }",
  "",
  "  // A tray widget put back on the page, at the end and at its first size.",
  "  function showWidget(layout, id) {",
  "    var base = asLayout(layout);",
  "    if (!hasWidget(id) || shownAt(base, id) >= 0) return base;",
  "    base.shown.push({ id: id, size: sizesOf(id)[0] });",
  "    return base;",
  "  }",
  "",
  "  // A widget's share of the row: of 12 columns on a laptop, of 6 on a tablet,",
  "  // and the whole row on a phone.",
  "  function columnSpan(size, sizeClass) {",
  "    if (sizeClass === 'phone') return 1;",
  "    var spans = sizeClass === 'tablet' ? TABLET_SPANS : LAPTOP_SPANS;",
  "    if (!hasOwn(spans, size)) return sizeClass === 'tablet' ? 6 : 12;",
  "    return spans[size];",
  "  }",
  "",
  "  // ---- this device's keys ------------------------------------------------",
  "",
  "  function layoutKey(songId, mode, sizeClass) {",
  "    return LAYOUT_PREFIX + String(songId) + '.' + String(mode) + '.' + String(sizeClass);",
  "  }",
  "",
  "  function seededKey(songId) {",
  "    return SEEDED_PREFIX + String(songId);",
  "  }",
  "",
  "  // A brokered read: a store that throws, or was never handed in, reads as",
  "  // absent, and a value that is not there reads as null.",
  "  function readValue(storage, key) {",
  "    if (!storage || typeof storage.getItem !== 'function') return null;",
  "    try {",
  "      var value = storage.getItem(key);",
  "      return value === undefined ? null : value;",
  "    } catch (err) {",
  "      return null;",
  "    }",
  "  }",
  "",
  "  function writeValue(storage, key, value) {",
  "    if (!storage || typeof storage.setItem !== 'function') return false;",
  "    try {",
  "      storage.setItem(key, value);",
  "      return true;",
  "    } catch (err) {",
  "      return false;",
  "    }",
  "  }",
  "",
  "  // The layout this song has on this device, in this mode and size class:",
  "  // the song's own key when it has one, else the built-in default.",
  "  function loadLayout(storage, songId, mode, sizeClass) {",
  "    var fallback = defaultLayout(mode, sizeClass);",
  "    return parseLayout(readValue(storage, layoutKey(songId, mode, sizeClass)), fallback);",
  "  }",
  "",
  "  // The layout this song has on this device, kept. False when this browser",
  "  // would not keep it, which the page reports and then carries on.",
  "  function saveLayout(storage, songId, mode, sizeClass, layout) {",
  "    var next = normalizeLayout(layout, defaultLayout(mode, sizeClass));",
  "    return writeValue(storage, layoutKey(songId, mode, sizeClass), serializeLayout(next));",
  "  }",
  "",
  "  // ---- the operator's template -------------------------------------------",
  "",
  "  // A string's length in UTF-8 bytes, so the cap is a size on the wire and",
  "  // not a count of UTF-16 units.",
  "  function utf8Bytes(text) {",
  "    var total = 0;",
  "    for (var i = 0; i < text.length; i += 1) {",
  "      var code = text.charCodeAt(i);",
  "      if (code < 0x80) total += 1;",
  "      else if (code < 0x800) total += 2;",
  "      else if (code >= 0xd800 && code <= 0xdbff) { total += 4; i += 1; }",
  "      else total += 3;",
  "    }",
  "    return total;",
  "  }",
  "",
  "  // The template setting as a Template, or null for what is not one: broken",
  "  // JSON, the wrong version, over the size cap, or no layouts table. Each",
  "  // entry goes through parseLayout, so a template can only hold layouts the",
  "  // page could have saved itself; an entry the shape refuses becomes that",
  "  // mode and size class's built-in default. A key naming a mode or a size",
  "  // class this build does not know is dropped.",
  "  function parseTemplate(raw) {",
  "    var value = raw;",
  "    if (typeof value === 'string') {",
  "      if (utf8Bytes(value) > TEMPLATE_MAX_BYTES) return null;",
  "      try {",
  "        value = JSON.parse(value);",
  "      } catch (err) {",
  "        return null;",
  "      }",
  "    } else if (value && typeof value === 'object') {",
  "      var text = '';",
  "      try {",
  "        text = JSON.stringify(value);",
  "      } catch (err) {",
  "        return null;",
  "      }",
  "      if (text === '' || utf8Bytes(text) > TEMPLATE_MAX_BYTES) return null;",
  "    } else {",
  "      return null;",
  "    }",
  "    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;",
  "    if (value.v !== VERSION) return null;",
  "    var table = value.layouts;",
  "    if (!table || typeof table !== 'object' || Array.isArray(table)) return null;",
  "    var layouts = {};",
  "    for (var m = 0; m < MODES.length; m += 1) {",
  "      for (var c = 0; c < SIZE_CLASSES.length; c += 1) {",
  "        var key = MODES[m] + '.' + SIZE_CLASSES[c];",
  "        if (!hasOwn(table, key)) continue;",
  "        layouts[key] = normalizeLayout(table[key], defaultLayout(MODES[m], SIZE_CLASSES[c]));",
  "      }",
  "    }",
  "    return { v: VERSION, layouts: layouts };",
  "  }",
  "",
  "  // The template written from one song on this device: every layout that song",
  "  // has stored here, across all modes and size classes. A slot the song has",
  "  // never saved is left out, so seeding falls back to the built-in default for",
  "  // it. A store that throws answers an empty template.",
  "  function templateFromSong(storage, songId) {",
  "    var layouts = {};",
  "    for (var m = 0; m < MODES.length; m += 1) {",
  "      for (var c = 0; c < SIZE_CLASSES.length; c += 1) {",
  "        var mode = MODES[m];",
  "        var sizeClass = SIZE_CLASSES[c];",
  "        var raw = readValue(storage, layoutKey(songId, mode, sizeClass));",
  "        if (raw === null) continue;",
  "        layouts[mode + '.' + sizeClass] = parseLayout(raw, defaultLayout(mode, sizeClass));",
  "      }",
  "    }",
  "    return { v: VERSION, layouts: layouts };",
  "  }",
  "",
  "  // The template handed to a song the FIRST time that song is opened on this",
  "  // device. Called once per boot, at most once per song: the marker gates it.",
  "  //",
  "  //   - the marker is there: nothing happens;",
  "  //   - 'failed' (the fetch failed or timed out): NO marker, so the next boot",
  "  //     tries again;",
  "  //   - null (the fetch succeeded with no template): ONLY the marker, and no",
  "  //     song key is written, so every slot keeps reading the built-in default;",
  "  //   - a template: every mode and size class is MATERIALIZED from it (the",
  "  //     template's entry, else the built-in default), then the marker.",
  "  //",
  "  // Because every slot is written, a template entry added later never reaches a",
  "  // song that was already opened here.",
  "  function seedSong(storage, songId, template) {",
  "    if (template === 'failed') return;",
  "    if (readValue(storage, seededKey(songId)) !== null) return;",
  "    if (template === null || template === undefined) {",
  "      writeValue(storage, seededKey(songId), '1');",
  "      return;",
  "    }",
  "    var parsed = parseTemplate(template);",
  "    if (!parsed) return;",
  "    for (var m = 0; m < MODES.length; m += 1) {",
  "      for (var c = 0; c < SIZE_CLASSES.length; c += 1) {",
  "        var mode = MODES[m];",
  "        var sizeClass = SIZE_CLASSES[c];",
  "        var fallback = defaultLayout(mode, sizeClass);",
  "        var layout = hasOwn(parsed.layouts, mode + '.' + sizeClass)",
  "          ? normalizeLayout(parsed.layouts[mode + '.' + sizeClass], fallback)",
  "          : fallback;",
  "        if (!writeValue(storage, layoutKey(songId, mode, sizeClass), serializeLayout(layout))) return;",
  "      }",
  "    }",
  "    writeValue(storage, seededKey(songId), '1');",
  "  }",
  "",
  "  window.StudioShellLayout = {",
  "    MODES: MODES,",
  "    SIZE_CLASSES: SIZE_CLASSES,",
  "    WIDGETS: WIDGETS,",
  "    WIDGET_ORDER: WIDGET_ORDER,",
  "    TEMPLATE_MAX_BYTES: TEMPLATE_MAX_BYTES,",
  "    sizeClassFor: sizeClassFor,",
  "    defaultLayout: defaultLayout,",
  "    parseLayout: parseLayout,",
  "    serializeLayout: serializeLayout,",
  "    trayOf: trayOf,",
  "    moveWidget: moveWidget,",
  "    resizeWidget: resizeWidget,",
  "    hideWidget: hideWidget,",
  "    showWidget: showWidget,",
  "    columnSpan: columnSpan,",
  "    layoutKey: layoutKey,",
  "    seededKey: seededKey,",
  "    loadLayout: loadLayout,",
  "    saveLayout: saveLayout,",
  "    parseTemplate: parseTemplate,",
  "    templateFromSong: templateFromSong,",
  "    seedSong: seedSong",
  "  };",
  "})();",
].join("\n");

/**
 * The layout model, evaluated from the very string the page inlines.
 *
 * `new Function` with a `window` parameter means the script's one global lands
 * on the object this module keeps, and never on Node's `globalThis`.
 */
const shellApi = new Function(
  "window",
  `${SHELL_LAYOUT_SCRIPT}\nreturn window.StudioShellLayout;`,
)({});

/** The shell's modes, in the tab order. */
export const MODES = shellApi.MODES;

/** The width classes the shell lays out for. */
export const SIZE_CLASSES = shellApi.SIZE_CLASSES;

/** Every widget the shell knows and the sizes each may take. */
export const WIDGETS = shellApi.WIDGETS;

/** The widget table's order, which is also the tray's. */
export const WIDGET_ORDER = shellApi.WIDGET_ORDER;

/** The cap the operator's template setting is held to. */
export const TEMPLATE_MAX_BYTES = shellApi.TEMPLATE_MAX_BYTES;

/**
 * The width class a page width lays out for.
 * @param {number} width - `window.innerWidth`
 * @returns {"phone"|"tablet"|"laptop"}
 */
export function sizeClassFor(width) {
  return shellApi.sizeClassFor(width);
}

/**
 * A mode's starting layout, before this device has saved one.
 * @param {string} mode
 * @param {string} sizeClass
 * @returns {{v: number, shown: Array<{id: string, size: string}>}}
 */
export function defaultLayout(mode, sizeClass) {
  return shellApi.defaultLayout(mode, sizeClass);
}

/**
 * A stored value as a layout, or the fallback when it is not one.
 * @param {string|null|object} raw
 * @param {object} [fallback]
 * @returns {{v: number, shown: Array<{id: string, size: string}>}}
 */
export function parseLayout(raw, fallback) {
  return shellApi.parseLayout(raw, fallback);
}

/**
 * A layout as the text this device keeps.
 * @param {object} layout
 * @returns {string}
 */
export function serializeLayout(layout) {
  return shellApi.serializeLayout(layout);
}

/**
 * The widgets a layout does not show, in table order.
 * @param {object} layout
 * @returns {string[]}
 */
export function trayOf(layout) {
  return shellApi.trayOf(layout);
}

/**
 * A shown widget moved to a new index (clamped).
 * @param {object} layout
 * @param {string} id
 * @param {number} toIndex
 * @returns {object}
 */
export function moveWidget(layout, id, toIndex) {
  return shellApi.moveWidget(layout, id, toIndex);
}

/**
 * A shown widget stepped to its next allowed size, wrapping.
 * @param {object} layout
 * @param {string} id
 * @returns {object}
 */
export function resizeWidget(layout, id) {
  return shellApi.resizeWidget(layout, id);
}

/**
 * A widget taken off the page.
 * @param {object} layout
 * @param {string} id
 * @returns {object}
 */
export function hideWidget(layout, id) {
  return shellApi.hideWidget(layout, id);
}

/**
 * A tray widget put back on the page.
 * @param {object} layout
 * @param {string} id
 * @returns {object}
 */
export function showWidget(layout, id) {
  return shellApi.showWidget(layout, id);
}

/**
 * A widget size's share of the row in one size class.
 * @param {"s"|"m"|"l"} size
 * @param {"phone"|"tablet"|"laptop"} sizeClass
 * @returns {number}
 */
export function columnSpan(size, sizeClass) {
  return shellApi.columnSpan(size, sizeClass);
}

/**
 * This device's key for one song's layout in one mode and size class.
 * @param {string} songId
 * @param {string} mode
 * @param {string} sizeClass
 * @returns {string}
 */
export function layoutKey(songId, mode, sizeClass) {
  return shellApi.layoutKey(songId, mode, sizeClass);
}

/**
 * This device's key for the marker that a song has been handed the template.
 * @param {string} songId
 * @returns {string}
 */
export function seededKey(songId) {
  return shellApi.seededKey(songId);
}

/**
 * The layout a song has on this device in one mode and size class.
 * @param {{getItem: Function, setItem: Function}} storage
 * @param {string} songId
 * @param {string} mode
 * @param {string} sizeClass
 * @returns {object}
 */
export function loadLayout(storage, songId, mode, sizeClass) {
  return shellApi.loadLayout(storage, songId, mode, sizeClass);
}

/**
 * Keep a layout for this song on this device. False when the store refuses.
 * @param {{getItem: Function, setItem: Function}} storage
 * @param {string} songId
 * @param {string} mode
 * @param {string} sizeClass
 * @param {object} layout
 * @returns {boolean}
 */
export function saveLayout(storage, songId, mode, sizeClass, layout) {
  return shellApi.saveLayout(storage, songId, mode, sizeClass, layout);
}

/**
 * The operator's template setting as a Template, or null for what is not one.
 * @param {string|object|null} raw
 * @returns {{v: number, layouts: object}|null}
 */
export function parseTemplate(raw) {
  return shellApi.parseTemplate(raw);
}

/**
 * The template written from one song's stored layouts on this device.
 * @param {{getItem: Function, setItem: Function}} storage
 * @param {string} songId
 * @returns {{v: number, layouts: object}}
 */
export function templateFromSong(storage, songId) {
  return shellApi.templateFromSong(storage, songId);
}

/**
 * Hand the operator's template to a song the first time it is opened here.
 * @param {{getItem: Function, setItem: Function}} storage
 * @param {string} songId
 * @param {{v: number, layouts: object}|null|"failed"} template
 * @returns {void}
 */
export function seedSong(storage, songId, template) {
  return shellApi.seedSong(storage, songId, template);
}