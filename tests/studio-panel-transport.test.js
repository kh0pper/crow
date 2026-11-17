/**
 * Studio panel — the transport bar's pure half.
 *
 * S3 builds the bar as its own inline classic script (panel/transport-bar.js);
 * S4 mounts it in the page and brings the page cases with it. The cases here
 * are the two helpers the page half is built on: the scene readout's label and
 * the reducer that keeps the scene waiting for the next bar, plus the styles
 * and the width-class watch the bar carries on its own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSPORT_CSS,
  TRANSPORT_SCRIPT,
  nextQueued,
  sceneLabel,
} from "../bundles/studio/panel/transport-bar.js";

test("sceneLabel names current and next and falls back to '-'", () => {
  const snap = {
    scenes: [
      { id: "verse", name: "Verse" },
      { id: "chorus", name: "Chorus" },
      { id: "untitled", name: "" },
    ],
  };
  assert.equal(sceneLabel(snap, "verse"), "Now: Verse");
  assert.equal(sceneLabel(snap, "chorus", "next"), "Next: Chorus");
  // A scene with no name falls back to its id rather than reading as a dash.
  assert.equal(sceneLabel(snap, "untitled"), "Now: untitled");
  // Nothing named, a scene this song does not have, and no snapshot at all.
  assert.equal(sceneLabel(snap, null), "-");
  assert.equal(sceneLabel(snap, ""), "-");
  assert.equal(sceneLabel(snap, "gone"), "-");
  assert.equal(sceneLabel(null, "verse"), "-");
  assert.equal(sceneLabel(undefined, undefined), "-");
});

test("queuedScene clears on stop, on a launched report, and a newer launch replaces it", () => {
  assert.equal(nextQueued(null, null), null);
  assert.equal(nextQueued(undefined, { type: "launch", scene_id: "verse" }), "verse");

  const queued = nextQueued("verse", { type: "launch", scene_id: "chorus" });
  assert.equal(queued, "chorus");

  // A launch that names no scene changes nothing.
  assert.equal(nextQueued(queued, { type: "launch" }), "chorus");
  assert.equal(nextQueued(queued, { type: "launch", scene_id: "" }), "chorus");

  assert.equal(nextQueued(queued, { type: "stop" }), null);
  // Any applied launch report clears it, whether or not it names the scene.
  assert.equal(nextQueued(queued, { type: "launched" }), null);
  assert.equal(nextQueued(queued, { type: "launched", scene_id: "chorus" }), null);
});

// ---- the styles ----------------------------------------------------------

test("the toast clears the player bar, the shell's tabs and the bar itself", () => {
  assert.match(
    TRANSPORT_CSS,
    /\.studio \.st-toast \{\s*bottom:\s*calc\(var\(--crow-player-h, 0px\) \+ var\(--shell-tabs-h, 0px\) \+ var\(--st-transport-h, 0px\) \+ 24px\)/,
    "every raised bar under the toast is in its offset",
  );
  assert.match(
    TRANSPORT_CSS,
    /\.studio \.st-transport-bar \{[^}]*bottom:\s*calc\(var\(--crow-player-h, 0px\) \+ var\(--shell-tabs-h, 0px\)\)/,
    "and the bar still ends on the player bar and the tabs",
  );
  assert.equal(TRANSPORT_CSS.includes("\u0060"), false, "no backtick in the styles");
  assert.equal(TRANSPORT_CSS.includes("$" + "{"), false, "no template interpolation in the styles");
});

// ---- the width class -----------------------------------------------------

/** The breakpoints the page lays out for, as the queries answer them. */
function matchesFor(width, media) {
  const min = /min-width:\s*(\d+)px/.exec(String(media));
  if (min) return width >= Number(min[1]);
  const max = /max-width:\s*(\d+)px/.exec(String(media));
  if (max) return width <= Number(max[1]);
  return false;
}

/**
 * One node good enough for the bar: attributes, a class, children and a style.
 * @param {string} tag
 * @returns {object}
 */
function fakeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: "",
    textContent: "",
    attributes: {},
    children: [],
    parentNode: null,
    hidden: false,
    disabled: false,
    style: {
      values: {},
      setProperty(name, value) {
        this.values[name] = String(value);
      },
      getPropertyValue(name) {
        return this.values[name] || "";
      },
      removeProperty(name) {
        delete this.values[name];
      },
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name);
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    insertBefore(child, before) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const at = before ? node.children.indexOf(before) : -1;
      if (at < 0) node.children.push(child);
      else node.children.splice(at, 0, child);
      child.parentNode = node;
      return child;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return node;
}

/** The studio element the bar mounts on, and the output picker it hides. */
function fakePage() {
  const page = fakeNode("div");
  const picker = fakeNode("div");
  picker.setAttribute("data-role", "output-bar");
  page.classList = { contains: (name) => name === "studio" };
  page.querySelector = (selector) => (selector === "[data-role=output-bar]" ? picker : null);
  return { page, picker };
}

/** The bar's script, evaluated against a window of its own. */
function transportFor(windowStub) {
  const documentStub = { createElement: (tag) => fakeNode(tag) };
  return new Function(
    "window",
    "document",
    TRANSPORT_SCRIPT + "\nreturn window.StudioTransport;",
  )(windowStub, documentStub);
}

/**
 * A width, the two media queries the page watches, and the change they fire.
 * @param {number} initial
 * @returns {object}
 */
function widthQueries(initial) {
  let width = initial;
  const queries = [];
  const windowStub = {
    matchMedia(media) {
      const query = {
        media: String(media),
        matches: matchesFor(width, media),
        listeners: [],
        addEventListener(name, handler) {
          if (name === "change") query.listeners.push(handler);
        },
        removeEventListener(name, handler) {
          if (name !== "change") return;
          const at = query.listeners.indexOf(handler);
          if (at >= 0) query.listeners.splice(at, 1);
        },
      };
      queries.push(query);
      return query;
    },
  };
  return {
    window: windowStub,
    queries,
    sizeClass() {
      if (width < 640) return "phone";
      return width < 1024 ? "tablet" : "laptop";
    },
    setWidth(next) {
      width = next;
      for (const query of queries) {
        const matches = matchesFor(width, query.media);
        if (matches === query.matches) continue;
        query.matches = matches;
        for (const handler of query.listeners.slice()) handler({ matches, media: query.media });
      }
    },
  };
}

test("the output picker follows a width change the bar did not render", () => {
  const view = widthQueries(500);
  const { page, picker } = fakePage();
  const bar = transportFor(view.window).mount(page, {}, { sizeClass: () => view.sizeClass() });
  assert.equal(picker.hidden, true, "a phone keeps the transport controls alone");

  view.setWidth(900);
  assert.equal(picker.hidden, false, "a tablet brings the picker back with no render at all");

  view.setWidth(500);
  assert.equal(picker.hidden, true, "and a phone hides it again");

  bar.destroy();
  for (const query of view.queries) {
    assert.deepEqual(query.listeners, [], "the bar lets go of the media queries it watched");
  }
});

test("a page without matchMedia still mounts, hides the picker on a phone and tears down", () => {
  const { page, picker } = fakePage();
  const bar = transportFor({}).mount(page, {}, { sizeClass: () => "phone" });
  assert.equal(picker.hidden, true);
  assert.doesNotThrow(() => bar.destroy());
});

// ---- counting and recording on the Record and Pause buttons ----------------
//
// A count-in is not a take: it never takes Pause away, and it does show Record
// pressed, because the take it counts for is about to start (R7, R8, R19).

/**
 * A page whose transport controls the bar can read, with one state its hooks
 * report and a test can move.
 * @param {{playing?: boolean, paused?: boolean, recording?: boolean, counting?: boolean}} [state]
 */
function controlPage(state = {}) {
  const values = {
    playing: false,
    paused: false,
    recording: false,
    counting: false,
    ...state,
  };
  const page = fakeNode("div");
  page.classList = { contains: (name) => name === "studio" };
  const controls = {};
  for (const act of ["play", "stop", "pause", "record", "metronome"]) {
    const node = fakeNode("button");
    node.setAttribute("data-act", act);
    controls[act] = node;
    page.appendChild(node);
  }
  const picker = fakeNode("div");
  picker.setAttribute("data-role", "output-bar");
  page.appendChild(picker);
  page.querySelector = (selector) => {
    const act = /^\[data-act=([\w-]+)\]$/.exec(String(selector));
    if (act) return controls[act[1]] || null;
    if (selector === "[data-role=output-bar]") return picker;
    return null;
  };
  const hooks = {
    snapshot: () => null,
    isPlaying: () => values.playing === true,
    isPaused: () => values.paused === true,
    isRecording: () => values.recording === true,
    isCounting: () => values.counting === true,
    position: () => null,
    currentSceneId: () => null,
    queuedSceneId: () => null,
  };
  return { page, controls, values, hooks };
}

test("the Record button reads pressed while counting and while a take runs, and idle otherwise", () => {
  const ui = controlPage();
  const bar = transportFor({}).mount(ui.page, ui.hooks, { sizeClass: () => "laptop" });
  assert.equal(ui.controls.record.getAttribute("aria-pressed"), "false", "a page that records nothing reads idle");

  ui.values.counting = true;
  bar.refresh();
  assert.equal(
    ui.controls.record.getAttribute("aria-pressed"),
    "true",
    "a count-in shows Record pressed: its take is about to start",
  );

  ui.values.counting = false;
  ui.values.recording = true;
  bar.refresh();
  assert.equal(ui.controls.record.getAttribute("aria-pressed"), "true", "and a take does too");

  ui.values.recording = false;
  bar.refresh();
  assert.equal(ui.controls.record.getAttribute("aria-pressed"), "false", "a stopped page reads idle again");
});

test("Pause is left alone while a count-in runs and taken away while a take does", () => {
  const ui = controlPage();
  const bar = transportFor({}).mount(ui.page, ui.hooks, { sizeClass: () => "laptop" });
  assert.equal(ui.controls.pause.disabled, false, "Pause is offered while nothing runs");

  ui.values.counting = true;
  bar.refresh();
  assert.equal(ui.controls.pause.disabled, false, "counting is not recording, so Pause stays offered");

  ui.values.counting = false;
  ui.values.recording = true;
  bar.refresh();
  assert.equal(ui.controls.pause.disabled, true, "a running take is what takes Pause away");

  // A second take after the first: the count-in it starts with gives Pause back.
  ui.values.recording = false;
  ui.values.counting = true;
  bar.refresh();
  assert.equal(ui.controls.pause.disabled, false, "and the next count-in gives it back");

  // A page that tells the bar nothing about a count-in is read as no count-in.
  const plain = controlPage({ recording: true });
  delete plain.hooks.isCounting;
  transportFor({}).mount(plain.page, plain.hooks, { sizeClass: () => "laptop" });
  assert.equal(plain.controls.pause.disabled, true, "a take still takes Pause away");
  assert.equal(plain.controls.record.getAttribute("aria-pressed"), "true", "and still reads pressed");
});