/**
 * Studio shell — the layout model and this device's storage helpers.
 *
 * Every case here drives the named exports of `bundles/studio/panel/shell-layout.js`,
 * which are produced by evaluating the very string the page inlines, so the
 * model a test drives is the bytes the page runs. The cases are the review's
 * own: a stored layout written by an older panel (corrupt JSON, another
 * version, an id no widget has, a duplicate), a widget the panel gained after
 * a layout was saved, a store that throws, a hide and a show, the size and
 * order steps, the two width boundaries, the song's own key before the default,
 * and the operator's template reaching a song once, per song, per device, with
 * every mode and size class materialized before the marker is written.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODES,
  SHELL_LAYOUT_SCRIPT,
  SIZE_CLASSES,
  TEMPLATE_MAX_BYTES,
  WIDGETS,
  WIDGET_ORDER,
  columnSpan,
  defaultLayout,
  hideWidget,
  layoutKey,
  loadLayout,
  moveWidget,
  parseLayout,
  parseTemplate,
  resizeWidget,
  saveLayout,
  seedSong,
  seededKey,
  serializeLayout,
  showWidget,
  sizeClassFor,
  templateFromSong,
  trayOf,
} from "../bundles/studio/panel/shell-layout.js";

/** An in-memory store with the two methods the model asks a store for. */
function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
  };
}

/** The operator's template: two slots of its own, every other slot unset. */
const TEMPLATE = {
  v: 1,
  layouts: {
    "compose.laptop": { v: 1, shown: [{ id: "takes", size: "l" }, { id: "agent", size: "m" }] },
    "record.tablet": { v: 1, shown: [{ id: "midi", size: "m" }, { id: "history", size: "m" }] },
  },
};

/** One row of a shown list, by id. */
function sizeOf(layout, id) {
  const row = layout.shown.find((entry) => entry.id === id);
  return row ? row.size : null;
}

/** A layout's shown ids, in order. */
function idsOf(layout) {
  return layout.shown.map((row) => row.id);
}

test("the emitted script follows the panel's inline rules and exposes one global", () => {
  assert.equal(SHELL_LAYOUT_SCRIPT.includes("\u0060"), false, "no backtick: the panel rule");
  assert.equal(SHELL_LAYOUT_SCRIPT.includes("$" + "{"), false, "no template interpolation");
  assert.equal(SHELL_LAYOUT_SCRIPT.includes('"'), false, "no double quote in the emitted text");
  assert.equal(SHELL_LAYOUT_SCRIPT.includes("\\"), false, "no backslash in the emitted text");
  assert.equal(SHELL_LAYOUT_SCRIPT.includes("</script"), false, "it cannot close its own tag");
  assert.doesNotThrow(() => new Function("window", SHELL_LAYOUT_SCRIPT), "it parses as a classic script");

  const page = new Function("window", SHELL_LAYOUT_SCRIPT + "\nreturn window.StudioShellLayout;")({});
  assert.deepEqual(page.MODES, MODES);
  assert.deepEqual(page.SIZE_CLASSES, SIZE_CLASSES);
  assert.deepEqual(page.WIDGETS, WIDGETS);
  assert.deepEqual(page.WIDGET_ORDER, WIDGET_ORDER);
  assert.equal(page.TEMPLATE_MAX_BYTES, TEMPLATE_MAX_BYTES);
  for (const name of [
    "sizeClassFor",
    "defaultLayout",
    "parseLayout",
    "serializeLayout",
    "trayOf",
    "moveWidget",
    "resizeWidget",
    "hideWidget",
    "showWidget",
    "columnSpan",
    "layoutKey",
    "seededKey",
    "loadLayout",
    "saveLayout",
    "parseTemplate",
    "templateFromSong",
    "seedSong",
  ]) {
    assert.equal(typeof page[name], "function", `the page carries ${name}`);
  }
  assert.deepEqual(page.defaultLayout("perform", "laptop"), defaultLayout("perform", "laptop"));
  assert.equal(page.columnSpan("m", "tablet"), columnSpan("m", "tablet"));
});

test("the widget table and the modes are the plan's", () => {
  assert.deepEqual(MODES, ["compose", "perform", "record"]);
  assert.deepEqual(SIZE_CLASSES, ["phone", "tablet", "laptop"]);
  assert.deepEqual(WIDGET_ORDER, [
    "scene-grid", "editor", "pads", "steps", "chop", "fx", "keyboard", "mixer-strip",
    "takes", "midi", "history", "agent",
  ]);
  assert.deepEqual(WIDGETS["scene-grid"].sizes, ["m", "l"]);
  assert.deepEqual(WIDGETS.editor.sizes, ["m", "l"]);
  assert.deepEqual(WIDGETS.takes.sizes, ["s", "m", "l"]);
  assert.deepEqual(WIDGETS.midi.sizes, ["s", "m"]);
  assert.deepEqual(WIDGETS.history.sizes, ["s", "m"]);
  assert.deepEqual(WIDGETS.agent.sizes, ["s", "m"]);
  assert.equal(TEMPLATE_MAX_BYTES, 8192);
});

test("WIDGETS holds pads, steps, chop, fx and the keyboard with their sizes", () => {
  assert.deepEqual(WIDGETS.pads.sizes, ["m", "l"], "the pads take half a row or all of it");
  assert.deepEqual(WIDGETS.steps.sizes, ["m", "l"], "so do the steps");
  assert.deepEqual(WIDGETS.chop.sizes, ["m", "l"], "and the chop editor");
  assert.deepEqual(WIDGETS.fx.sizes, ["s", "m"], "the effects row fits a column");
  assert.deepEqual(WIDGETS.keyboard.sizes, ["m", "l"], "the keyboard takes half a row or all of it");
  for (const id of ["pads", "steps", "chop", "fx", "keyboard"]) {
    assert.equal(WIDGET_ORDER.includes(id), true, `${id} is a widget the tray can list`);
  }
  assert.deepEqual(
    WIDGET_ORDER.slice(0, 6),
    ["scene-grid", "editor", "pads", "steps", "chop", "fx"],
    "the four sampler widgets sit beside the editor they belong to",
  );

  const page = new Function("window", SHELL_LAYOUT_SCRIPT + "\nreturn window.StudioShellLayout;")({});
  assert.deepEqual(page.WIDGETS, WIDGETS, "the page's own table is this one");
  assert.deepEqual(page.WIDGET_ORDER, WIDGET_ORDER);
});

test("the keyboard is a widget with sizes, in no default, and in the tray", () => {
  assert.deepEqual(WIDGETS.keyboard.sizes, ["m", "l"], "the keyboard takes half a row or all of it");
  assert.equal(WIDGET_ORDER.includes("keyboard"), true, "the tray can list it");
  for (const mode of MODES) {
    for (const sizeClass of SIZE_CLASSES) {
      const layout = defaultLayout(mode, sizeClass);
      assert.equal(
        layout.shown.some((row) => row.id === "keyboard"),
        false,
        `${mode}.${sizeClass} keeps the keyboard in the tray`,
      );
      assert.equal(trayOf(layout).includes("keyboard"), true, `${mode}.${sizeClass} offers it in the tray`);
    }
  }
  const compose = defaultLayout("compose", "laptop");
  assert.deepEqual(
    trayOf(compose).filter((id) => id === "keyboard"),
    ["keyboard"],
    "compose offers exactly one keyboard, in the tray",
  );
  assert.deepEqual(showWidget(compose, "keyboard").shown.slice(-1), [{ id: "keyboard", size: "m" }], "it comes back at its first size");
});

test("the mixer strip is a widget with sizes, in no default, and in the tray", () => {
  assert.deepEqual(WIDGETS["mixer-strip"].sizes, ["s", "m"], "the strip fits a column or half a row");
  assert.equal(WIDGET_ORDER.includes("mixer-strip"), true, "the tray can list it");
  assert.equal(
    WIDGET_ORDER.indexOf("mixer-strip"),
    WIDGET_ORDER.indexOf("keyboard") + 1,
    "it sits beside the keyboard, after the other widgets of the aim",
  );
  for (const mode of MODES) {
    for (const sizeClass of SIZE_CLASSES) {
      const layout = defaultLayout(mode, sizeClass);
      assert.equal(
        layout.shown.some((row) => row.id === "mixer-strip"),
        false,
        `${mode}.${sizeClass} keeps the mixer strip in the tray`,
      );
      assert.equal(trayOf(layout).includes("mixer-strip"), true, `${mode}.${sizeClass} offers it in the tray`);
      for (const row of layout.shown) {
        assert.equal(WIDGETS[row.id].sizes.includes(row.size), true, `${row.id} at ${row.size} is an allowed size`);
      }
    }
  }
  const compose = defaultLayout("compose", "laptop");
  assert.deepEqual(
    trayOf(compose).filter((id) => id === "mixer-strip"),
    ["mixer-strip"],
    "compose offers exactly one mixer strip, in the tray",
  );
  assert.deepEqual(
    showWidget(compose, "mixer-strip").shown.slice(-1),
    [{ id: "mixer-strip", size: "s" }],
    "it comes back at its first size",
  );
  const resized = resizeWidget(showWidget(compose, "mixer-strip"), "mixer-strip");
  assert.deepEqual(resized.shown.slice(-1), [{ id: "mixer-strip", size: "m" }], "and steps to its second");
  assert.deepEqual(columnSpan("s", "laptop"), 4, "which is a third of a laptop row");
  assert.deepEqual(columnSpan("m", "tablet"), 6, "and half a tablet row");

  const page = new Function("window", SHELL_LAYOUT_SCRIPT + "\nreturn window.StudioShellLayout;")({});
  assert.deepEqual(page.WIDGETS["mixer-strip"], WIDGETS["mixer-strip"], "the page's own table holds it too");
});

test("sizeClassFor puts the boundaries at 640 and 1024", () => {
  assert.equal(sizeClassFor(320), "phone");
  assert.equal(sizeClassFor(639), "phone");
  assert.equal(sizeClassFor(640), "tablet");
  assert.equal(sizeClassFor(1023), "tablet");
  assert.equal(sizeClassFor(1024), "laptop");
  assert.equal(sizeClassFor(2560), "laptop");
});

test("the default layout of each mode is the plan's, with the agent in the tray", () => {
  assert.deepEqual(defaultLayout("compose", "laptop").shown, [
    { id: "scene-grid", size: "l" },
    { id: "editor", size: "m" },
    { id: "pads", size: "m" },
    { id: "steps", size: "l" },
    { id: "fx", size: "s" },
    { id: "history", size: "s" },
  ]);
  assert.deepEqual(defaultLayout("perform", "laptop").shown, [
    { id: "scene-grid", size: "l" },
    { id: "pads", size: "l" },
    { id: "fx", size: "m" },
    { id: "midi", size: "s" },
    { id: "history", size: "s" },
  ]);
  assert.deepEqual(defaultLayout("record", "laptop").shown, [
    { id: "scene-grid", size: "m" },
    { id: "takes", size: "l" },
    { id: "midi", size: "s" },
    { id: "history", size: "s" },
  ]);
  for (const mode of MODES) {
    for (const sizeClass of SIZE_CLASSES) {
      const layout = defaultLayout(mode, sizeClass);
      assert.equal(layout.v, 1);
      assert.equal(trayOf(layout).includes("agent"), true, `${mode}.${sizeClass} leaves the agent in the tray`);
      assert.equal(trayOf(layout).includes("keyboard"), true, `${mode}.${sizeClass} leaves the keyboard in the tray`);
      for (const row of layout.shown) {
        assert.equal(WIDGETS[row.id].sizes.includes(row.size), true, `${row.id} at ${row.size} is an allowed size`);
      }
    }
  }
  assert.deepEqual(defaultLayout("compose", "phone"), defaultLayout("compose", "laptop"), "a phone starts from the same set");
  assert.deepEqual(defaultLayout("nonsense", "laptop"), defaultLayout("compose", "laptop"), "a mode no build knows starts from compose");
});

test("parseLayout refuses what a stored layout may not be", () => {
  const fallback = defaultLayout("compose", "laptop");
  assert.deepEqual(parseLayout(null, fallback), fallback);
  assert.deepEqual(parseLayout("", fallback), fallback);
  assert.deepEqual(parseLayout("{not json at all", fallback), fallback, "corrupt JSON");
  assert.deepEqual(parseLayout(JSON.stringify({ v: 2, shown: [{ id: "takes", size: "s" }] }), fallback), fallback, "wrong version");
  assert.deepEqual(parseLayout(JSON.stringify({ v: 1, shown: [] }), fallback), fallback, "nothing shown");
  assert.deepEqual(parseLayout(JSON.stringify({ v: 1 }), fallback), fallback);
  assert.deepEqual(
    parseLayout(JSON.stringify({ v: 1, shown: [{ id: "mystery", size: "s" }] }), fallback),
    fallback,
    "nothing known left to show",
  );
  assert.deepEqual(parseLayout(JSON.stringify({ v: 1, shown: "takes" }), fallback), fallback);
  assert.deepEqual(parseLayout(JSON.stringify([1, 2]), fallback), fallback);
});

test("parseLayout drops unknown and duplicate ids and repairs a disallowed size", () => {
  const fallback = defaultLayout("compose", "laptop");
  const layout = parseLayout(JSON.stringify({
    v: 1,
    shown: [
      { id: "takes", size: "m" },
      { id: "mystery", size: "s" },
      { id: "takes", size: "l" },
      { id: "midi", size: "l" },
      { id: "editor", size: "xl" },
    ],
  }), fallback);
  assert.equal(layout.v, 1);
  assert.deepEqual(layout.shown, [
    { id: "takes", size: "m" },
    { id: "midi", size: "s" },
    { id: "editor", size: "m" },
  ]);
});

test("compose default is scene-grid l, editor m, pads m, steps l, fx s, history s", () => {
  const compose = defaultLayout("compose", "laptop");
  const sizes = {};
  for (const row of compose.shown) sizes[row.id] = row.size;
  assert.deepEqual(sizes, {
    "scene-grid": "l",
    editor: "m",
    pads: "m",
    steps: "l",
    fx: "s",
    history: "s",
  });
  assert.equal(idsOf(compose).includes("chop"), false, "the chop editor starts in the tray");
  assert.equal(idsOf(compose).includes("agent"), false, "and so does the agent");
  assert.deepEqual(defaultLayout("compose", "tablet").shown, compose.shown, "a tablet starts from the same set");
  assert.deepEqual(defaultLayout("compose", "phone").shown, compose.shown);

  const perform = defaultLayout("perform", "laptop");
  const performSizes = {};
  for (const row of perform.shown) performSizes[row.id] = row.size;
  assert.deepEqual(performSizes, {
    "scene-grid": "l",
    pads: "l",
    fx: "m",
    midi: "s",
    history: "s",
  });
});

test("a saved layout from P1 (no new ids) loads and the four new ids are in the tray, not inserted", () => {
  const saved = JSON.stringify({
    v: 1,
    shown: [
      { id: "scene-grid", size: "l" },
      { id: "editor", size: "m" },
      { id: "history", size: "s" },
    ],
  });
  const layout = parseLayout(saved, defaultLayout("compose", "laptop"));
  assert.deepEqual(idsOf(layout), ["scene-grid", "editor", "history"], "the page the operator saved is the page they get");
  const tray = trayOf(layout);
  for (const id of ["pads", "steps", "chop", "fx"]) {
    assert.equal(tray.includes(id), true, `${id} is offered by the tray`);
    assert.equal(idsOf(layout).includes(id), false, `${id} is not put on the page by itself`);
  }
  assert.deepEqual(tray, ["pads", "steps", "chop", "fx", "keyboard", "mixer-strip", "takes", "midi", "agent"], "in table order");
});

test("an unknown id in a saved layout is dropped", () => {
  const layout = parseLayout(JSON.stringify({
    v: 1,
    shown: [
      { id: "pads", size: "l" },
      { id: "sampler-pads", size: "l" },
      { id: "mystery", size: "s" },
      { id: "steps", size: "xl" },
    ],
  }));
  assert.deepEqual(idsOf(layout), ["pads", "steps"], "only the ids the table knows survive");
  assert.deepEqual(layout.shown, [
    { id: "pads", size: "l" },
    { id: "steps", size: "m" },
  ], "and a size the widget may not take becomes its first one");
});

test("parseLayout hands back a layout of its own, never the fallback it was given", () => {
  const fallback = defaultLayout("compose", "laptop");
  const layout = parseLayout(null, fallback);
  layout.shown.push({ id: "midi", size: "s" });
  layout.shown[0].size = "m";
  assert.deepEqual(fallback, defaultLayout("compose", "laptop"));

  const stored = parseLayout(JSON.stringify(defaultLayout("compose", "laptop")), fallback);
  stored.shown[1].size = "l";
  const again = parseLayout(JSON.stringify(defaultLayout("compose", "laptop")), fallback);
  assert.equal(sizeOf(again, "editor"), "m");

  const page = defaultLayout("record", "laptop");
  const changed = moveWidget(page, "takes", 0);
  assert.deepEqual(idsOf(page), ["scene-grid", "takes", "midi", "history"], "the argument is untouched");
  assert.deepEqual(idsOf(changed), ["takes", "scene-grid", "midi", "history"]);
});

test("hide then show round-trips a widget into the tray and back at the end", () => {
  const start = defaultLayout("compose", "laptop");
  const hidden = hideWidget(start, "editor");
  assert.deepEqual(idsOf(hidden), ["scene-grid", "pads", "steps", "fx", "history"]);
  assert.deepEqual(trayOf(hidden), ["editor", "chop", "keyboard", "mixer-strip", "takes", "midi", "agent"]);
  assert.deepEqual(idsOf(start), ["scene-grid", "editor", "pads", "steps", "fx", "history"], "the original keeps its editor");

  const back = showWidget(hidden, "editor");
  assert.deepEqual(back.shown, [
    { id: "scene-grid", size: "l" },
    { id: "pads", size: "m" },
    { id: "steps", size: "l" },
    { id: "fx", size: "s" },
    { id: "history", size: "s" },
    { id: "editor", size: "m" },
  ]);
  assert.deepEqual(trayOf(back), ["chop", "keyboard", "mixer-strip", "takes", "midi", "agent"]);

  assert.deepEqual(showWidget(back, "editor").shown, back.shown, "showing a shown widget changes nothing");
  assert.deepEqual(showWidget(back, "mystery").shown, back.shown, "an id no widget has is not shown");
  assert.deepEqual(hideWidget(back, "mystery").shown, back.shown, "and hiding it changes nothing either");
});

test("resizeWidget steps the allowed sizes and wraps", () => {
  let grid = defaultLayout("record", "laptop");
  assert.equal(sizeOf(grid, "scene-grid"), "m");
  grid = resizeWidget(grid, "scene-grid");
  assert.equal(sizeOf(grid, "scene-grid"), "l");
  grid = resizeWidget(grid, "scene-grid");
  assert.equal(sizeOf(grid, "scene-grid"), "m", "m, l, m: two allowed sizes wrap");
  grid = resizeWidget(grid, "scene-grid");
  assert.equal(sizeOf(grid, "scene-grid"), "l");

  let takes = defaultLayout("record", "laptop");
  assert.equal(sizeOf(takes, "takes"), "l");
  const steps = [];
  for (let i = 0; i < 4; i += 1) {
    takes = resizeWidget(takes, "takes");
    steps.push(sizeOf(takes, "takes"));
  }
  assert.deepEqual(steps, ["s", "m", "l", "s"], "takes walks s, m, l and wraps");

  let midi = defaultLayout("record", "laptop");
  assert.equal(sizeOf(midi, "midi"), "s");
  midi = resizeWidget(midi, "midi");
  assert.equal(sizeOf(midi, "midi"), "m");
  midi = resizeWidget(midi, "midi");
  assert.equal(sizeOf(midi, "midi"), "s");

  const hidden = hideWidget(midi, "midi");
  assert.deepEqual(resizeWidget(hidden, "midi").shown, hidden.shown, "a widget in the tray has no size to step");
  assert.deepEqual(resizeWidget(midi, "mystery").shown, midi.shown);
});

test("moveWidget moves a shown widget and clamps the index", () => {
  const start = defaultLayout("perform", "laptop");
  assert.deepEqual(idsOf(moveWidget(start, "history", 0)), ["history", "scene-grid", "pads", "fx", "midi"]);
  assert.deepEqual(idsOf(moveWidget(start, "history", 99)), ["scene-grid", "pads", "fx", "midi", "history"]);
  assert.deepEqual(idsOf(moveWidget(start, "scene-grid", -5)), ["scene-grid", "pads", "fx", "midi", "history"]);
  assert.deepEqual(idsOf(moveWidget(start, "scene-grid", 2)), ["pads", "fx", "scene-grid", "midi", "history"]);
  assert.deepEqual(idsOf(moveWidget(start, "pads", 3)), ["scene-grid", "fx", "midi", "pads", "history"]);
  assert.deepEqual(idsOf(start), ["scene-grid", "pads", "fx", "midi", "history"], "the argument is untouched");

  const trayed = hideWidget(start, "midi");
  assert.deepEqual(idsOf(moveWidget(trayed, "midi", 0)), ["scene-grid", "pads", "fx", "history"], "a tray widget does not move");
});

test("columnSpan gives a widget its share of the row", () => {
  assert.equal(columnSpan("s", "laptop"), 4);
  assert.equal(columnSpan("m", "laptop"), 6);
  assert.equal(columnSpan("l", "laptop"), 12);
  assert.equal(columnSpan("s", "tablet"), 3);
  assert.equal(columnSpan("m", "tablet"), 6);
  assert.equal(columnSpan("l", "tablet"), 6);
  for (const size of ["s", "m", "l"]) {
    assert.equal(columnSpan(size, "phone"), 1, "a phone is one widget per row");
  }
});

test("the keys name the song, the mode and the size class", () => {
  assert.equal(layoutKey("song-7", "record", "tablet"), "crow.studio.layout.v2.song-7.record.tablet");
  assert.equal(layoutKey("song-7", "compose", "phone"), "crow.studio.layout.v2.song-7.compose.phone");
  assert.equal(seededKey("song-7"), "crow.studio.layoutSeeded.v2.song-7");
});

test("loadLayout returns the song's own key, else the built-in default", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadLayout(storage, "s1", "perform", "laptop"), defaultLayout("perform", "laptop"));

  const kept = hideWidget(defaultLayout("perform", "laptop"), "midi");
  assert.equal(saveLayout(storage, "s1", "perform", "laptop", kept), true);
  assert.equal(storage.values.has(layoutKey("s1", "perform", "laptop")), true);
  assert.deepEqual(loadLayout(storage, "s1", "perform", "laptop"), kept);

  assert.deepEqual(loadLayout(storage, "s1", "compose", "laptop"), defaultLayout("compose", "laptop"), "another mode keeps its own");
  assert.deepEqual(loadLayout(storage, "s1", "perform", "phone"), defaultLayout("perform", "phone"), "another size class keeps its own");
  assert.deepEqual(loadLayout(storage, "s2", "perform", "laptop"), defaultLayout("perform", "laptop"), "another song keeps its own");

  storage.setItem(layoutKey("s1", "perform", "laptop"), "{oops");
  assert.deepEqual(loadLayout(storage, "s1", "perform", "laptop"), defaultLayout("perform", "laptop"), "a broken value falls back");

  storage.setItem(layoutKey("s1", "perform", "laptop"), JSON.stringify({ v: 1, shown: [{ id: "agent", size: "s" }] }));
  assert.deepEqual(loadLayout(storage, "s1", "perform", "laptop"), { v: 1, shown: [{ id: "agent", size: "s" }] });
  assert.deepEqual(trayOf(loadLayout(storage, "s1", "perform", "laptop")), [
    "scene-grid", "editor", "pads", "steps", "chop", "fx", "keyboard", "mixer-strip", "takes", "midi", "history",
  ]);
});

test("saveLayout keeps only what a layout may hold", () => {
  const storage = memoryStorage();
  const kept = {
    v: 1,
    shown: [
      { id: "agent", size: "l" },
      { id: "mystery", size: "s" },
      { id: "midi", size: "m" },
    ],
  };
  assert.equal(saveLayout(storage, "s1", "record", "tablet", kept), true);
  assert.deepEqual(loadLayout(storage, "s1", "record", "tablet"), {
    v: 1,
    shown: [{ id: "agent", size: "s" }, { id: "midi", size: "m" }],
  });
  const text = storage.values.get(layoutKey("s1", "record", "tablet"));
  assert.equal(text, serializeLayout({ v: 1, shown: [{ id: "agent", size: "s" }, { id: "midi", size: "m" }] }));
  assert.equal(text, JSON.stringify({ v: 1, shown: [{ id: "agent", size: "s" }, { id: "midi", size: "m" }] }));
});

test("a store that throws answers the default, a refused save and an empty template", () => {
  const broken = {
    getItem() {
      throw new Error("this browser keeps nothing");
    },
    setItem() {
      throw new Error("this browser keeps nothing");
    },
  };
  assert.deepEqual(loadLayout(broken, "s1", "compose", "phone"), defaultLayout("compose", "phone"));
  assert.equal(saveLayout(broken, "s1", "compose", "phone", defaultLayout("compose", "phone")), false);
  assert.deepEqual(templateFromSong(broken, "s1"), { v: 1, layouts: {} });
  assert.doesNotThrow(() => seedSong(broken, "s1", null));
  assert.doesNotThrow(() => seedSong(broken, "s1", TEMPLATE));

  assert.deepEqual(loadLayout(null, "s1", "compose", "phone"), defaultLayout("compose", "phone"), "a store that was never handed in reads as absent");
  assert.equal(saveLayout(undefined, "s1", "compose", "phone", defaultLayout("compose", "phone")), false);
});

test("seedSong materializes every mode and size class from the template, then the marker, for any song", () => {
  for (const songId of ["song-a", "song-b"]) {
    const storage = memoryStorage();
    seedSong(storage, songId, TEMPLATE);

    assert.deepEqual(loadLayout(storage, songId, "compose", "laptop"), TEMPLATE.layouts["compose.laptop"]);
    assert.deepEqual(loadLayout(storage, songId, "record", "tablet"), TEMPLATE.layouts["record.tablet"]);

    for (const mode of MODES) {
      for (const sizeClass of SIZE_CLASSES) {
        const slot = `${mode}.${sizeClass}`;
        if (slot === "compose.laptop" || slot === "record.tablet") continue;
        assert.deepEqual(
          loadLayout(storage, songId, mode, sizeClass),
          defaultLayout(mode, sizeClass),
          `${slot} comes from the built-in default`,
        );
      }
    }

    assert.equal(storage.values.get(seededKey(songId)), "1");
    assert.equal(storage.values.has(seededKey(songId)), true);
  }
});

test("with no template seedSong writes only the marker", () => {
  const storage = memoryStorage();
  seedSong(storage, "song-a", null);
  assert.equal(storage.values.get(seededKey("song-a")), "1");
  assert.deepEqual([...storage.values.keys()], [seededKey("song-a")], "nothing but the marker");
  assert.deepEqual(loadLayout(storage, "song-a", "record", "laptop"), defaultLayout("record", "laptop"));
});

test("a failed or timed-out fetch writes no marker and a retry seeds", () => {
  const storage = memoryStorage();
  seedSong(storage, "song-a", "failed");
  assert.deepEqual([...storage.values.keys()], [], "the song stays unseeded");

  seedSong(storage, "song-a", TEMPLATE);
  assert.equal(storage.values.get(seededKey("song-a")), "1");
  assert.deepEqual(loadLayout(storage, "song-a", "compose", "laptop"), TEMPLATE.layouts["compose.laptop"]);

  const other = memoryStorage();
  seedSong(other, "song-b", "failed");
  seedSong(other, "song-b", null);
  assert.equal(other.values.get(seededKey("song-b")), "1", "a retry that finds no template marks the song");
  assert.equal(other.values.size, 1);
});

test("a second call changes nothing", () => {
  const storage = memoryStorage();
  seedSong(storage, "song-a", TEMPLATE);
  const afterFirst = new Map(storage.values);

  seedSong(storage, "song-a", TEMPLATE);
  assert.deepEqual([...storage.values], [...afterFirst]);

  const rearranged = moveWidget(showWidget(loadLayout(storage, "song-a", "compose", "laptop"), "midi"), "midi", 0);
  assert.equal(saveLayout(storage, "song-a", "compose", "laptop", rearranged), true);
  const afterEdit = new Map(storage.values);

  seedSong(storage, "song-a", TEMPLATE);
  assert.deepEqual([...storage.values], [...afterEdit], "an opened song keeps the operator's page");
  assert.deepEqual(loadLayout(storage, "song-a", "compose", "laptop"), rearranged);
});

test("a template entry added after seeding does not change a seeded song", () => {
  const storage = memoryStorage();
  seedSong(storage, "song-a", TEMPLATE);

  const later = {
    v: 1,
    layouts: {
      ...TEMPLATE.layouts,
      "perform.laptop": { v: 1, shown: [{ id: "midi", size: "m" }, { id: "agent", size: "s" }] },
    },
  };
  seedSong(storage, "song-a", later);
  assert.deepEqual(
    loadLayout(storage, "song-a", "perform", "laptop"),
    defaultLayout("perform", "laptop"),
    "the slot was materialized at the first boot",
  );

  const firstOpen = memoryStorage();
  seedSong(firstOpen, "song-b", later);
  assert.deepEqual(
    loadLayout(firstOpen, "song-b", "perform", "laptop"),
    later.layouts["perform.laptop"],
    "a song first opened after the entry exists gets it",
  );
});

test("templateFromSong takes the song's own stored slots and none of another song's", () => {
  const storage = memoryStorage();
  const compose = hideWidget(defaultLayout("compose", "laptop"), "history");
  saveLayout(storage, "song-a", "compose", "laptop", compose);
  const record = defaultLayout("record", "tablet");
  saveLayout(storage, "song-a", "record", "tablet", record);

  saveLayout(storage, "song-b", "perform", "phone", showWidget(defaultLayout("perform", "phone"), "agent"));
  saveLayout(storage, "song-b", "compose", "laptop", defaultLayout("compose", "laptop"));

  const template = templateFromSong(storage, "song-a");
  assert.equal(template.v, 1);
  assert.deepEqual(Object.keys(template.layouts).sort(), ["compose.laptop", "record.tablet"]);
  assert.deepEqual(template.layouts["compose.laptop"], compose);
  assert.deepEqual(template.layouts["record.tablet"], record);
  assert.deepEqual(Object.keys(templateFromSong(storage, "song-b").layouts).sort(), ["compose.laptop", "perform.phone"]);
  assert.deepEqual(templateFromSong(storage, "song-c"), { v: 1, layouts: {} });
  assert.deepEqual(parseTemplate(JSON.stringify(template)), template, "a template written from a song reads back");

  const seeded = memoryStorage();
  seedSong(seeded, "song-d", parseTemplate(JSON.stringify(template)));
  assert.deepEqual(loadLayout(seeded, "song-d", "compose", "laptop"), compose);
  assert.deepEqual(loadLayout(seeded, "song-d", "perform", "laptop"), defaultLayout("perform", "laptop"));
});

test("parseTemplate holds the version, the layouts table and the size cap", () => {
  assert.equal(parseTemplate(null), null);
  assert.equal(parseTemplate(undefined), null);
  assert.equal(parseTemplate(""), null);
  assert.equal(parseTemplate("{broken"), null);
  assert.equal(parseTemplate(42), null);
  assert.equal(parseTemplate("[]"), null);
  assert.equal(parseTemplate(JSON.stringify({ v: 2, layouts: {} })), null, "wrong version");
  assert.equal(parseTemplate(JSON.stringify({ v: 1 })), null, "no layouts table");
  assert.equal(parseTemplate(JSON.stringify({ v: 1, layouts: [] })), null, "a layouts list");
  assert.deepEqual(parseTemplate(JSON.stringify({ v: 1, layouts: {} })), { v: 1, layouts: {} });

  const overCap = JSON.stringify({ v: 1, layouts: {}, pad: "x".repeat(TEMPLATE_MAX_BYTES) });
  assert.equal(overCap.length > TEMPLATE_MAX_BYTES, true);
  assert.equal(parseTemplate(overCap), null, "over the cap");
  assert.equal(parseTemplate({ v: 1, layouts: {}, pad: "x".repeat(TEMPLATE_MAX_BYTES) }), null, "the same cap for an object");

  const repaired = parseTemplate(JSON.stringify({
    v: 1,
    layouts: {
      "perform.laptop": { v: 1, shown: [{ id: "nope", size: "s" }] },
      "mixer.laptop": { v: 1, shown: [{ id: "takes", size: "l" }] },
      "perform.big": { v: 1, shown: [{ id: "takes", size: "l" }] },
      "perform.phone": { v: 9, shown: [{ id: "takes", size: "l" }] },
      "perform.tablet": { v: 1, shown: [{ id: "takes", size: "xl" }, { id: "takes", size: "m" }] },
    },
  }));
  assert.deepEqual(Object.keys(repaired.layouts), ["perform.phone", "perform.tablet", "perform.laptop"], "a mode or class no build has is dropped");
  assert.deepEqual(repaired.layouts["perform.phone"], defaultLayout("perform", "phone"), "a wrong version becomes the default");
  assert.deepEqual(repaired.layouts["perform.tablet"], { v: 1, shown: [{ id: "takes", size: "s" }] }, "each entry goes through parseLayout");
  assert.deepEqual(repaired.layouts["perform.laptop"], defaultLayout("perform", "laptop"), "so does an entry with nothing left to show");
});