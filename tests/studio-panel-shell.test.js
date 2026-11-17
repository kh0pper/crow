/**
 * Studio shell — the widget host.
 *
 * The page these cases drive is the one `bundles/studio/panel/studio.js`
 * renders for a song, parsed with linkedom. The shell's own two scripts are
 * evaluated into that window, in the order the page inlines them, and mounted
 * on the page element. No song document and no engine is needed: this task is
 * the page furniture — the top bar, the screen container, the frames, the
 * hidden tray, the empty notes and the width classes.
 *
 * The hooks are the page's side of the contract: the nodes each widget wraps,
 * the storage the layout model reads, the screen the page is showing, the
 * render it wants called when a tray widget comes back, and the mode change it
 * wants told about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import studioPanel from "../bundles/studio/panel/studio.js";
import {
  SHELL_CSS,
  SHELL_SCRIPT,
  dropIndex,
  emptyNote,
  widgetName,
} from "../bundles/studio/panel/shell.js";
import { SHELL_LAYOUT_SCRIPT } from "../bundles/studio/panel/shell-layout.js";
import { TRANSPORT_SCRIPT } from "../bundles/studio/panel/transport-bar.js";

const SONG = "song-shell";
const MODE_KEY = "crow.studio.mode.v1";
const SIDE_KEY = "crow.studio.sideCollapsed.v1";

/** The widgets a mode's default layout shows, in page order. */
const COMPOSE = ["scene-grid", "editor", "pads", "steps", "fx", "history"];
const PERFORM = ["scene-grid", "pads", "fx", "midi", "history"];
const RECORD = ["scene-grid", "takes", "midi", "history"];

/** Every widget the shell knows: one frame each. */
const WIDGET_COUNT = 12;

/** The stand-in dashboard layout: a bare document around the panel content. */
function minimalLayout({ title, content }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body>${content}</body></html>`;
}

/** A database fake for the song page: no project list is read. */
function panelDb() {
  return {
    async execute() {
      return { rows: [] };
    },
  };
}

/** An in-memory localStorage, so a test can read what the page kept. */
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
    removeItem(key) {
      values.delete(String(key));
    },
  };
}

/** A store that refuses every read and every write. */
function throwingStorage() {
  return {
    getItem() {
      throw new Error("this browser keeps nothing");
    },
    setItem() {
      throw new Error("this browser keeps nothing");
    },
  };
}

/** The width media queries the shell listens to. */
function matchesFor(width, media) {
  const min = /min-width:\s*(\d+)px/.exec(String(media));
  if (min) return width >= Number(min[1]);
  const max = /max-width:\s*(\d+)px/.exec(String(media));
  if (max) return width <= Number(max[1]);
  return false;
}

/**
 * A window width with the two media queries the shell watches: changing the
 * width updates `innerWidth` and fires the change listeners that flipped.
 */
function widthHarness(domWindow, initial) {
  let width = initial;
  const queries = [];
  domWindow.innerWidth = width;
  domWindow.matchMedia = (media) => {
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
      addListener(handler) {
        query.listeners.push(handler);
      },
      removeListener(handler) {
        const at = query.listeners.indexOf(handler);
        if (at >= 0) query.listeners.splice(at, 1);
      },
    };
    queries.push(query);
    return query;
  };
  return {
    queries,
    width() {
      return width;
    },
    setWidth(next) {
      width = next;
      domWindow.innerWidth = width;
      for (const query of queries) {
        const matches = matchesFor(width, query.media);
        if (matches === query.matches) continue;
        query.matches = matches;
        for (const handler of query.listeners.slice()) handler({ matches, media: query.media });
      }
    },
  };
}

/** The nodes the shell is expected to move, captured before it mounts. */
function snapshotHosts(document) {
  const q = (selector) => document.querySelector(selector);
  return {
    back: q(".st-back"),
    title: q("[data-role=title]"),
    modes: q(".st-modes"),
    presence: q("[data-role=presence]"),
    gridWrap: q("[data-role=grid-wrap]"),
    hint: q("[data-role=hint]"),
    editor: q("[data-role=editor]"),
    pads: q("[data-role=sampler-pads]"),
    steps: q("[data-role=sampler-steps]"),
    chop: q("[data-role=sampler-chop]"),
    fx: q("[data-role=sampler-fx]"),
    recordings: q("[data-role=recordings]"),
    midi: q("[data-role=midi]"),
    history: q("[data-role=history]"),
    timeline: q("[data-role=timeline]"),
    mixer: q("[data-role=mixer]"),
    sideHead: q(".st-side-head"),
    sideNote: q(".st-side-note"),
    aside: q(".st-side"),
    askLabel: q(".st-ask-label"),
    askBox: q(".st-ask"),
    askInput: q("#st-ask"),
  };
}

/** The hosts the page hands the shell, all but the agent (which it makes). */
function standardHosts(document) {
  return {
    "scene-grid": [
      document.querySelector("[data-role=grid-wrap]"),
      document.querySelector("[data-role=hint]"),
    ],
    editor: [document.querySelector("[data-role=editor]")],
    pads: [document.querySelector("[data-role=sampler-pads]")],
    steps: [document.querySelector("[data-role=sampler-steps]")],
    chop: [document.querySelector("[data-role=sampler-chop]")],
    fx: [document.querySelector("[data-role=sampler-fx]")],
    takes: document.querySelector("[data-role=recordings]"),
    midi: document.querySelector("[data-role=midi]"),
    history: document.querySelector("[data-role=history]"),
  };
}

/**
 * Render the song page, evaluate the shell into its window, mount it and hand
 * back the page, the controller and the pieces a case looks at.
 */
async function bootShell(options = {}) {
  const { parseHTML } = await import("linkedom");
  const res = {
    html: "",
    send(body) {
      this.html = String(body);
    },
  };
  await studioPanel.handler({ query: { song: SONG }, headers: {} }, res, {
    db: panelDb(),
    layout: minimalLayout,
  });
  assert.ok(res.html.includes(`data-studio-song="${SONG}"`), "the handler rendered the song page");

  const { document, window: domWindow } = parseHTML(res.html);
  const storage = options.storage || memoryStorage();
  const media = widthHarness(domWindow, options.width === undefined ? 1280 : options.width);

  const view = { screen: options.screen || "session" };
  const modes = [];
  const control = { current: null };
  let renders = 0;
  const hooks = {
    hosts: options.hosts === undefined ? standardHosts(document) : options.hosts,
    songId: SONG,
    storage,
    fetch: options.fetch,
    csrf: options.csrf,
    screen: () => view.screen,
    render: () => {
      renders += 1;
      if (control.current) control.current.refresh();
    },
    onMode: (mode) => modes.push(mode),
  };

  const run = new Function("window", "document", `${SHELL_LAYOUT_SCRIPT}\n${SHELL_SCRIPT}`);
  run(domWindow, document);

  const page = document.querySelector(".studio");
  const refs = snapshotHosts(document);
  const shell = domWindow.StudioShell.mount(page, hooks);
  control.current = shell;

  return {
    document,
    domWindow,
    page,
    shell,
    hooks,
    refs,
    // The boot helper's render hook reads this, so a re-mount can point it at
    // the controller that is live.
    control,
    storage,
    media,
    view,
    layout: domWindow.StudioShellLayout,
    modes,
    renderCount: () => renders,
  };
}

/** One frame by widget id. */
function frame(page, id) {
  return page.querySelector(`[data-widget=${id}]`);
}

/** The body of one frame. */
function body(page, id) {
  return frame(page, id).querySelector(".st-widget-body");
}

/** The widgets shown in the widget area, in page order. */
function shownWidgets(page) {
  const area = page.querySelector("[data-role=studio-widgets]");
  return Array.from(area.children)
    .filter((node) => node.getAttribute && node.getAttribute("data-widget"))
    .map((node) => node.getAttribute("data-widget"));
}

/** The widget ids waiting in the tray, in page order. */
function trayWidgets(page) {
  const area = page.querySelector("[data-role=widget-tray]");
  return Array.from(area.children)
    .filter((node) => node.getAttribute && node.getAttribute("data-widget"))
    .map((node) => node.getAttribute("data-widget"));
}

/** The size a shown frame carries. */
function sizeOf(page, id) {
  return frame(page, id).getAttribute("data-size");
}

/** The empty note of one frame. */
function noteOf(page, id) {
  return frame(page, id).querySelector(".st-widget-note");
}

/** The agent frame's unread dot. */
function unreadDot(page) {
  return frame(page, "agent").querySelector("[data-role=unread]");
}

/** A click a person could make. */
function click(domWindow, node) {
  assert.ok(node, "the control exists");
  node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
}

/** Let linkedom's MutationObserver callbacks run. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The transport bar's hooks: nothing is playing on this page. */
function transportHooks() {
  return {
    snapshot: () => null,
    isPlaying: () => false,
    isPaused: () => false,
    isRecording: () => false,
    currentSceneId: () => null,
    queuedSceneId: () => null,
  };
}

/** Mount the transport bar the same way the page will, for the re-boot case. */
function mountTransport(domWindow, document) {
  new Function("window", "document", TRANSPORT_SCRIPT)(domWindow, document);
  return domWindow.StudioTransport.mount(
    document.querySelector(".studio"),
    transportHooks(),
    { sizeClass: "laptop" },
  );
}

/** The Layout entry with one data-act. */
function layoutEntry(page, act) {
  return page.querySelector(`[data-role=layout-entries] [data-act=${act}]`);
}

/** The top bar's side panels toggle. */
function sideToggle(page) {
  return page.querySelector("[data-role=studio-top] [data-act=side-toggle]");
}

/** Turn edit mode on. */
function startEditing(b) {
  const toggle = layoutEntry(b.page, "layout-edit");
  assert.ok(toggle, "the Edit layout entry exists");
  click(b.domWindow, toggle);
  assert.equal(toggle.textContent, "Done", "the entry becomes Done while editing");
  return toggle;
}

/** One of a frame's own edit controls. */
function frameAct(b, id, act) {
  return frame(b.page, id).querySelector(`[data-act=${act}]`);
}

/** A pointer event carrying the fields the shell reads. */
function pointer(domWindow, type, fields) {
  const event = new domWindow.Event(type, { bubbles: true });
  for (const [name, value] of Object.entries(fields)) event[name] = value;
  return event;
}

/** The phone tab strip. */
function tabsStrip(page) {
  return page.querySelector("[data-role=studio-tabs]");
}

/** The strip's tabs, in page order. */
function tabNodes(page) {
  const strip = tabsStrip(page);
  return strip ? Array.from(strip.querySelectorAll("[role=tab]")) : [];
}

/** The labels of the strip's tabs. */
function tabLabels(page) {
  return tabNodes(page).map((node) => node.textContent);
}

/** The tab the strip says is selected. */
function activeTab(page) {
  return tabNodes(page).find((node) => node.getAttribute("aria-selected") === "true") || null;
}

/** The ids of the frames on the page that are showing right now. */
function visibleFrames(page) {
  const area = page.querySelector("[data-role=studio-widgets]");
  return Array.from(area.children)
    .filter((node) => node.getAttribute && node.getAttribute("data-widget"))
    .filter((node) => !node.hasAttribute("hidden"))
    .map((node) => node.getAttribute("data-widget"));
}

/** One swipe: a press, a drag along the way, and the release. */
function swipe(domWindow, node, from, to) {
  node.dispatchEvent(pointer(domWindow, "pointerdown", {
    pointerType: "touch", button: 0, pointerId: 7, clientX: from.x, clientY: from.y,
  }));
  node.dispatchEvent(pointer(domWindow, "pointermove", { clientX: to.x, clientY: to.y }));
  node.dispatchEvent(pointer(domWindow, "pointerup", { clientX: to.x, clientY: to.y }));
}

/** One song's stored layout key. */
function layoutKey(songId, mode, sizeClass) {
  return `crow.studio.layout.v2.${songId}.${mode}.${sizeClass}`;
}

/** The widget ids a song's stored layout shows, in order, or null. */
function storedIds(storage, songId, mode, sizeClass) {
  const raw = storage.getItem(layoutKey(songId, mode, sizeClass));
  if (raw === null) return null;
  return JSON.parse(raw).shown.map((row) => row.id);
}

/** Give a frame a rectangle, since linkedom lays nothing out. */
function stubRect(node, rect) {
  node.getBoundingClientRect = () => ({ top: 0, left: 0, height: 0, width: 0, ...rect });
}

/** The three frames of the compose layout, stacked, for a drop position. */
function stubComposeRects(b) {
  stubRect(frame(b.page, "scene-grid"), { top: 0, left: 0, width: 600, height: 100 });
  stubRect(frame(b.page, "editor"), { top: 110, left: 0, width: 300, height: 100 });
  stubRect(frame(b.page, "history"), { top: 220, left: 0, width: 300, height: 100 });
}

/** Let a stubbed fetch's promise settle. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("the emitted shell script follows the panel's inline rules and names the widgets", () => {
  assert.equal(SHELL_SCRIPT.includes("\u0060"), false, "no backtick in the emitted text");
  assert.equal(SHELL_SCRIPT.includes("$" + "{"), false, "no template interpolation in the emitted text");
  assert.equal(SHELL_SCRIPT.includes('"'), false, "no double quote in the emitted text");
  assert.equal(SHELL_SCRIPT.includes("\\"), false, "no backslash in the emitted text");
  assert.equal(SHELL_SCRIPT.includes("</script"), false, "it cannot close its own tag");
  assert.equal(SHELL_CSS.includes("\u0060"), false, "no backtick in the styles");
  assert.equal(SHELL_CSS.includes("$" + "{"), false, "no template interpolation in the styles");
  assert.doesNotThrow(() => new Function(SHELL_SCRIPT), "the emitted text parses as a classic script");

  assert.equal(widgetName("scene-grid"), "Scene grid");
  assert.equal(widgetName("editor"), "Editor");
  assert.equal(widgetName("pads"), "Pads");
  assert.equal(widgetName("steps"), "Steps");
  assert.equal(widgetName("chop"), "Chop");
  assert.equal(widgetName("fx"), "Effects");
  assert.equal(widgetName("keyboard"), "Keyboard");
  assert.equal(widgetName("mixer-strip"), "Mixer strip");
  assert.equal(widgetName("takes"), "Takes");
  assert.equal(widgetName("midi"), "MIDI");
  assert.equal(widgetName("history"), "History");
  assert.equal(widgetName("agent"), "Agent");
  assert.equal(emptyNote("editor"), "Open a note clip on a track to edit it.");
  assert.equal(emptyNote("pads"), "Open a pattern clip on a sampler track to play its pads.");
  assert.equal(emptyNote("steps"), "Open a pattern clip on a sampler track to sequence its pads.");
  assert.equal(emptyNote("chop"), "Open a pattern clip and pick a pad to chop its sound.");
  assert.equal(emptyNote("fx"), "Open a pattern clip on a sampler track for the effects and the looper.");
  assert.equal(emptyNote("keyboard"), "Pick a note track to play it");
  assert.equal(emptyNote("mixer-strip"), "Pick a track to see its strip");
  assert.equal(emptyNote("takes"), "Arm a track to record.");
  assert.equal(emptyNote("scene-grid"), "");
  assert.match(SHELL_CSS, /\.st-widget-tab\s*\{[^}]*min-height:\s*46px/, "a tab is a 46 px target");
  assert.match(SHELL_CSS, /\.st-widget\[hidden\]\s*\{\s*display:\s*none/, "a hidden frame is gone");
  assert.match(
    SHELL_CSS,
    /\.st-top \.st-side-toggle \{[^}]*min-height:\s*44px/,
    "the side panels toggle is a 44 px target",
  );
  assert.match(
    SHELL_CSS,
    /\.st-top \.st-side-toggle \{[^}]*-webkit-touch-callout:\s*none/,
    "and a press on it is never a callout",
  );
  assert.match(
    SHELL_CSS,
    /\.studio \{\s*overflow: hidden; overflow: clip;\s*\}/,
    "the page clips what runs past it without becoming a scroll container",
  );
  assert.ok(
    SHELL_CSS.indexOf("overflow: clip") < SHELL_CSS.indexOf(".studio .st-top {"),
    "and that rule lands before the sticky top bar it lets stick",
  );
  assert.match(
    SHELL_CSS,
    /\.studio \.st-top \{[^}]*position:\s*sticky/,
    "the top bar sticks to the top of the page",
  );
  assert.match(
    SHELL_CSS,
    /\.studio \.st-widget-head \{[^}]*touch-action:\s*pan-y/,
    "a swipe that starts on a frame header reaches the tab handler",
  );
  assert.match(
    SHELL_CSS,
    /\.studio \.st-chrome\[hidden\] \{\s*display:\s*none/,
    "the emptied header the page rendered is taken out of the page",
  );
});

test("the top bar carries the page's own controls and the new mode switch and layout menu", async () => {
  const b = await bootShell();
  const top = b.page.querySelector("[data-role=studio-top]");
  assert.ok(top, "one top bar");
  assert.equal(b.page.querySelectorAll("[data-role=studio-top]").length, 1);
  assert.equal(b.refs.back.parentNode, top);
  assert.equal(b.refs.title.parentNode, top);
  assert.equal(b.refs.modes.parentNode, top);
  assert.equal(b.refs.presence.parentNode, top);
  assert.match(b.refs.back.textContent, /Songs/, "the existing back link is the Songs control");
  assert.equal(b.page.querySelector("[data-role=songs]"), null, "there is no separate songs host on the song page");

  const modeSwitch = top.querySelector("[data-role=mode-switch]");
  const labels = Array.from(modeSwitch.querySelectorAll("button")).map((node) => node.textContent);
  assert.deepEqual(labels, ["Compose", "Perform", "Record"]);
  assert.equal(modeSwitch.querySelector("[data-mode=compose]").getAttribute("aria-pressed"), "true");
  assert.equal(modeSwitch.querySelector("[data-mode=perform]").getAttribute("aria-pressed"), "false");

  click(b.domWindow, modeSwitch.querySelector("[data-mode=perform]"));
  assert.deepEqual(b.modes, ["perform"], "the page is told about the change");
  assert.equal(b.storage.getItem(MODE_KEY), "perform", "the mode is this device's");
  assert.equal(modeSwitch.querySelector("[data-mode=perform]").getAttribute("aria-pressed"), "true");
  assert.equal(modeSwitch.querySelector("[data-mode=compose]").getAttribute("aria-pressed"), "false");
  assert.deepEqual(shownWidgets(b.page), PERFORM);
  const layoutButton = top.querySelector("[data-act=layout-menu]");
  const popover = top.querySelector("[data-role=layout-popover]");
  assert.ok(layoutButton, "the Layout button exists");
  assert.ok(popover, "the popover exists");
  assert.ok(popover.querySelector("[data-role=layout-entries]"), "S2b has an entries container");
  assert.ok(popover.querySelector("[data-role=layout-midi]"), "S4 has a MIDI container");
  assert.equal(popover.hasAttribute("hidden"), true, "the popover starts closed");
  click(b.domWindow, layoutButton);
  assert.equal(popover.hasAttribute("hidden"), false, "the button opens it");
  assert.equal(layoutButton.getAttribute("aria-expanded"), "true");
  click(b.domWindow, layoutButton);
  assert.equal(popover.hasAttribute("hidden"), true, "and closes it again");
  assert.equal(layoutButton.getAttribute("aria-expanded"), "false");
});

test("compose mounts its six widgets; perform and record follow the defaults", async () => {
  const b = await bootShell();
  assert.deepEqual(shownWidgets(b.page), COMPOSE);
  assert.equal(sizeOf(b.page, "scene-grid"), "l");
  assert.equal(sizeOf(b.page, "editor"), "m");
  assert.equal(sizeOf(b.page, "pads"), "m");
  assert.equal(sizeOf(b.page, "steps"), "l");
  assert.equal(sizeOf(b.page, "fx"), "s");
  assert.equal(sizeOf(b.page, "history"), "s");
  assert.equal(frame(b.page, "agent").parentNode, b.page.querySelector("[data-role=widget-tray]"));

  b.shell.setMode("perform");
  assert.deepEqual(shownWidgets(b.page), PERFORM);
  assert.equal(sizeOf(b.page, "pads"), "l");
  assert.equal(sizeOf(b.page, "fx"), "m");
  assert.equal(sizeOf(b.page, "midi"), "s");
  assert.equal(frame(b.page, "agent").parentNode, b.page.querySelector("[data-role=widget-tray]"));

  b.shell.setMode("record");
  assert.deepEqual(shownWidgets(b.page), RECORD);
  assert.equal(sizeOf(b.page, "takes"), "l");
  assert.equal(frame(b.page, "agent").parentNode, b.page.querySelector("[data-role=widget-tray]"));
  assert.deepEqual(trayWidgets(b.page), ["editor", "pads", "steps", "chop", "fx", "keyboard", "mixer-strip", "agent"]);
});

test("the page's hosts and header controls are moved, never cloned", async () => {
  const b = await bootShell();
  const { document, page, refs } = b;
  const top = page.querySelector("[data-role=studio-top]");
  const screen = page.querySelector("[data-role=studio-screen]");

  for (const [selector, node] of [
    [".st-back", refs.back],
    ["[data-role=title]", refs.title],
    [".st-modes", refs.modes],
    ["[data-role=presence]", refs.presence],
    ["[data-role=grid-wrap]", refs.gridWrap],
    ["[data-role=hint]", refs.hint],
    ["[data-role=editor]", refs.editor],
    ["[data-role=sampler-pads]", refs.pads],
    ["[data-role=sampler-steps]", refs.steps],
    ["[data-role=sampler-chop]", refs.chop],
    ["[data-role=sampler-fx]", refs.fx],
    ["[data-role=recordings]", refs.recordings],
    ["[data-role=midi]", refs.midi],
    ["[data-role=history]", refs.history],
    ["[data-role=timeline]", refs.timeline],
    ["[data-role=mixer]", refs.mixer],
    [".st-side-head", refs.sideHead],
    [".st-side-note", refs.sideNote],
    [".st-ask-label", refs.askLabel],
    [".st-ask", refs.askBox],
    ["#st-ask", refs.askInput],
  ]) {
    assert.equal(document.querySelector(selector), node, `${selector} is the same node`);
  }

  assert.equal(refs.timeline.parentNode, screen);
  assert.equal(refs.mixer.parentNode, screen);
  assert.equal(refs.gridWrap.parentNode, body(page, "scene-grid"));
  assert.equal(refs.hint.parentNode, body(page, "scene-grid"));
  assert.equal(refs.editor.parentNode, body(page, "editor"));
  assert.equal(refs.pads.parentNode, body(page, "pads"), "our pads are a widget of their own");
  assert.equal(refs.steps.parentNode, body(page, "steps"));
  assert.equal(refs.chop.parentNode, body(page, "chop"));
  assert.equal(refs.fx.parentNode, body(page, "fx"));
  assert.equal(refs.recordings.parentNode, body(page, "takes"));
  assert.equal(refs.midi.parentNode, body(page, "midi"));
  assert.equal(refs.history.parentNode, body(page, "history"));
  assert.equal(
    document.querySelector("[data-role=mixer-strip]").parentNode,
    body(page, "mixer-strip"),
    "the aimed track's strip is a widget of its own, apart from the full Mixer",
  );
  assert.notEqual(
    document.querySelector("[data-role=mixer-strip]"),
    refs.mixer,
    "and its host is not the Mixer's host",
  );

  const agentBody = body(page, "agent");
  const ask = page.querySelector("[data-role=ask]");
  assert.equal(ask.parentNode, agentBody);
  assert.equal(refs.askBox.parentNode, ask, "the ask box is a DIRECT child of the wrapper");
  assert.equal(refs.askLabel.parentNode, ask);
  assert.equal(refs.askInput.parentNode, refs.askBox, "#st-ask keeps its parent");
  assert.equal(refs.sideHead.parentNode, frame(page, "history").querySelector(".st-widget-head"));
  assert.equal(refs.sideNote.parentNode, frame(page, "history").querySelector(".st-widget-head"));
  assert.equal(refs.aside.hasAttribute("hidden"), true, "the emptied aside is hidden");
  assert.equal(top.querySelector("[data-role=studio-top]"), null);
});

test("a hidden host shows its empty note and unhiding removes it", async () => {
  const b = await bootShell();
  b.shell.setMode("record");

  const takesNote = noteOf(b.page, "takes");
  assert.ok(takesNote, "the takes frame carries a note");
  assert.equal(takesNote.textContent, "Arm a track to record.");
  assert.equal(takesNote.hasAttribute("hidden"), false, "the hidden takes host shows the note: " + body(b.page, "takes").outerHTML);

  b.refs.recordings.removeAttribute("hidden");
  await tick();
  assert.equal(takesNote.hasAttribute("hidden"), true, "the note goes when the host is shown");

  b.refs.recordings.setAttribute("hidden", "");
  await tick();
  assert.equal(takesNote.hasAttribute("hidden"), false, "and comes back when it is hidden again");

  b.shell.setMode("compose");
  const editorNote = noteOf(b.page, "editor");
  assert.equal(editorNote.textContent, "Open a note clip on a track to edit it.");
  assert.equal(editorNote.hasAttribute("hidden"), false, "the editor host is hidden");

  b.refs.editor.removeAttribute("hidden");
  await tick();
  assert.equal(editorNote.hasAttribute("hidden"), true, "a visible host is enough");

  b.refs.editor.setAttribute("hidden", "");
  await tick();
  assert.equal(editorNote.hasAttribute("hidden"), false, "both hidden again");

  const padsNote = noteOf(b.page, "pads");
  assert.equal(padsNote.textContent, "Open a pattern clip on a sampler track to play its pads.");
  assert.equal(padsNote.hasAttribute("hidden"), false, "the pads of a closed clipless page say what opens them");

  b.refs.pads.removeAttribute("hidden");
  await tick();
  assert.equal(padsNote.hasAttribute("hidden"), true, "and the note goes when the pads host is drawn");
});

test("a widget's note names the clip kind that opens it", async () => {
  const b = await bootShell();
  b.shell.setMode("compose");

  // The editor is the NOTE clip's widget: a pattern clip opens the pads and the
  // steps instead, so its frame never points the operator back at the grid.
  const editorNote = String(noteOf(b.page, "editor").textContent);
  assert.equal(editorNote, "Open a note clip on a track to edit it.");
  assert.equal(/grid/i.test(editorNote), false, "the editor's note never names the grid");

  // The other two notes still name the pattern clip, so a page with nothing open
  // says which clip opens which widget rather than one sentence for both.
  assert.match(String(noteOf(b.page, "pads").textContent), /pattern clip/);
  assert.match(String(noteOf(b.page, "steps").textContent), /pattern clip/);

  // A hidden editor host is what shows the note, and a drawn one takes it away.
  assert.equal(noteOf(b.page, "editor").hasAttribute("hidden"), false);
  b.refs.editor.removeAttribute("hidden");
  await tick();
  assert.equal(noteOf(b.page, "editor").hasAttribute("hidden"), true);
  assert.equal(String(noteOf(b.page, "editor").textContent), editorNote, "the same sentence waits under a drawn editor");
});

test("each sampler widget has a frame of its own with its host inside it", async () => {
  const b = await bootShell();
  for (const id of ["pads", "steps", "chop", "fx"]) {
    assert.equal(b.page.querySelectorAll(`[data-widget=${id}]`).length, 1, `one ${id} frame`);
    const host = b.refs[id === "fx" ? "fx" : id];
    assert.equal(host.parentNode, frame(b.page, id).querySelector(".st-widget-body"), `${id} host is in its own frame`);
    assert.ok(noteOf(b.page, id), `the ${id} frame carries its own note`);
  }
  assert.equal(frame(b.page, "editor").querySelector("[data-role=sampler-pads]"), null, "the editor frame holds no pad host");
  assert.equal(noteOf(b.page, "editor").hasAttribute("hidden"), false);
});

test("a widget in the tray is still in the page and shows its body without a song change", async () => {
  const b = await bootShell();
  const tray = b.page.querySelector("[data-role=widget-tray]");
  assert.equal(frame(b.page, "agent").parentNode, tray);
  assert.equal(b.page.querySelector("#st-ask"), b.refs.askInput, "the tray body is still found");

  const layout = b.layout.showWidget(
    b.layout.loadLayout(b.storage, SONG, "compose", "laptop"),
    "agent",
  );
  assert.equal(b.layout.saveLayout(b.storage, SONG, "compose", "laptop", layout), true);
  const before = b.renderCount();
  b.shell.refresh();

  assert.deepEqual(shownWidgets(b.page), [...COMPOSE, "agent"]);
  assert.equal(frame(b.page, "agent").parentNode, b.page.querySelector("[data-role=studio-widgets]"));
  assert.equal(b.page.querySelector("#st-ask"), b.refs.askInput);
  assert.equal(b.renderCount(), before + 1, "showing a tray widget asks the page to draw its body");
});

test("a widget whose size moved asks the page to draw its body again", async () => {
  const b = await bootShell();
  assert.equal(sizeOf(b.page, "steps"), "l", "compose opens with the steps at size l");

  const layout = b.layout.resizeWidget(
    b.layout.loadLayout(b.storage, SONG, "compose", "laptop"),
    "steps",
  );
  assert.equal(b.layout.saveLayout(b.storage, SONG, "compose", "laptop", layout), true);
  const before = b.renderCount();
  b.shell.refresh();

  // How much room a widget has is what its body draws for (the steps hold eight
  // positions at size m and sixteen at size l), so the page is asked to draw it
  // again rather than left showing the contents of the old size.
  assert.equal(sizeOf(b.page, "steps"), "m", "the layout's new size is applied to the frame");
  assert.equal(b.renderCount(), before + 1, "and the page is asked to draw the widget again");

  // A refresh that finds the layout it already applied asks for nothing.
  const settled = b.renderCount();
  b.shell.refresh();
  assert.equal(b.renderCount(), settled, "a refresh that moves nothing asks for no draw");
});

test("an agent frame in the tray grows an unread dot while it is hidden", async () => {
  const b = await bootShell();
  const ask = b.page.querySelector("[data-role=ask]");
  const dot = unreadDot(b.page);
  assert.equal(dot.hasAttribute("hidden"), true, "nothing unread yet");

  const log = b.document.createElement("div");
  log.setAttribute("data-role", "ask-log");
  ask.appendChild(log);
  await tick();
  assert.equal(dot.hasAttribute("hidden"), false, "a reply written while the agent is in the tray is unread");

  const layout = b.layout.showWidget(
    b.layout.loadLayout(b.storage, SONG, "compose", "laptop"),
    "agent",
  );
  b.layout.saveLayout(b.storage, SONG, "compose", "laptop", layout);
  b.shell.refresh();
  assert.equal(dot.hasAttribute("hidden"), true, "showing the agent clears it");
});

test("refresh with an unchanged layout writes nothing and leaves the focused input where it is", async () => {
  const b = await bootShell();
  const { document, domWindow } = b;

  const input = b.refs.askInput;
  input.focus();
  document.activeElement = input;
  const parent = input.parentNode;

  const counts = { insertBefore: 0, appendChild: 0, setAttribute: 0, removeAttribute: 0 };
  const restore = [];
  const nodes = [document.documentElement, ...document.querySelectorAll("*")];
  for (const node of nodes) {
    for (const name of Object.keys(counts)) {
      const original = node[name];
      if (typeof original !== "function") continue;
      node[name] = function (...args) {
        counts[name] += 1;
        return original.apply(this, args);
      };
      restore.push(() => {
        node[name] = original;
      });
    }
  }

  try {
    b.shell.refresh();
  } finally {
    for (const undo of restore.reverse()) undo();
  }

  assert.deepEqual(counts, { insertBefore: 0, appendChild: 0, setAttribute: 0, removeAttribute: 0 });
  assert.equal(document.activeElement, input);
  assert.equal(input.parentNode, parent);
  assert.equal(b.document.querySelector("#st-ask"), input);
  assert.equal(domWindow.innerWidth, 1280);
});

test("crossing the 640 breakpoint loads the phone layout without detaching a host", async () => {
  const b = await bootShell({ width: 1280 });
  const grid = b.refs.gridWrap;
  assert.deepEqual(shownWidgets(b.page), COMPOSE);

  b.layout.saveLayout(b.storage, SONG, "compose", "phone", {
    v: 1,
    shown: [
      { id: "takes", size: "l" },
      { id: "agent", size: "s" },
    ],
  });

  b.media.setWidth(500);
  assert.equal(b.domWindow.innerWidth, 500);
  assert.deepEqual(shownWidgets(b.page), ["takes", "agent"], "the phone key is the one loaded");
  assert.equal(b.document.querySelector("[data-role=grid-wrap]"), grid, "the host is the same node");
  assert.equal(grid.parentNode, body(b.page, "scene-grid"), "it is still in its own frame");
  assert.equal(b.page.contains(grid), true, "a tray frame keeps its body in the document");

  b.media.setWidth(1280);
  assert.deepEqual(shownWidgets(b.page), COMPOSE);
  assert.equal(b.document.querySelector("[data-role=grid-wrap]"), grid);
});

test("a grid drag shows the timeline screen and a drop leaves it showing", async () => {
  const b = await bootShell();
  const widgets = b.page.querySelector("[data-role=studio-widgets]");
  const screen = b.page.querySelector("[data-role=studio-screen]");
  assert.equal(screen.getAttribute("data-screen"), "session");
  assert.equal(widgets.hasAttribute("hidden"), false);

  b.view.screen = "arrangement";
  b.refs.timeline.removeAttribute("hidden");
  b.shell.refresh();
  assert.equal(widgets.hasAttribute("hidden"), true, "the widget area gives the timeline the page");
  assert.equal(screen.getAttribute("data-screen"), "arrangement");
  assert.equal(b.refs.timeline.hasAttribute("hidden"), false);

  b.hooks.render();
  assert.equal(widgets.hasAttribute("hidden"), true, "a drop leaves the timeline showing");
  assert.equal(b.refs.timeline.hasAttribute("hidden"), false);

  b.view.screen = "session";
  b.hooks.render();
  assert.equal(widgets.hasAttribute("hidden"), false, "back on the grid the widgets return");
  assert.equal(screen.getAttribute("data-screen"), "session");
});

test("boot, teardown and boot leaves one set of frames and one transport bar", async () => {
  const b = await bootShell();
  const { document, domWindow, page } = b;

  const same = domWindow.StudioShell.mount(page, b.hooks);
  assert.equal(same, b.shell, "mount is idempotent while mounted");
  assert.equal(document.querySelectorAll("[data-widget]").length, WIDGET_COUNT);

  const firstTransport = mountTransport(domWindow, document);
  assert.equal(document.querySelectorAll(".st-transport-bar").length, 1);

  firstTransport.destroy();
  b.shell.destroy();
  assert.equal(document.querySelectorAll("[data-widget]").length, 0, "the shell takes its frames with it");
  assert.equal(document.querySelector("[data-role=studio-top]"), null);
  assert.equal(document.querySelector("[data-role=grid-wrap]"), b.refs.gridWrap, "the hosts are back on the page");
  assert.equal(document.querySelector("[data-role=timeline]").parentNode, document.querySelector(".st-main"));

  const second = domWindow.StudioShell.mount(page, b.hooks);
  b.control.current = second;
  const secondTransport = mountTransport(domWindow, document);

  assert.equal(document.querySelectorAll("[data-widget]").length, WIDGET_COUNT);
  assert.equal(document.querySelectorAll("[data-role=studio-top]").length, 1);
  assert.equal(document.querySelectorAll("[data-role=studio-widgets]").length, 1);
  assert.equal(document.querySelectorAll("[data-role=studio-screen]").length, 1);
  assert.equal(document.querySelectorAll("[data-role=widget-tray]").length, 1);
  assert.equal(document.querySelectorAll(".st-transport-bar").length, 1);
  assert.equal(document.querySelector("[data-role=grid-wrap]"), b.refs.gridWrap);

  secondTransport.destroy();
  second.destroy();
});

test("a throwing storage still renders the default layout", async () => {
  const b = await bootShell({ storage: throwingStorage() });
  assert.deepEqual(shownWidgets(b.page), COMPOSE, "compose is the floor");
  assert.equal(
    b.page.querySelector("[data-role=mode-switch] [data-mode=compose]").getAttribute("aria-pressed"),
    "true",
  );

  assert.doesNotThrow(() => b.shell.setMode("record"));
  assert.deepEqual(shownWidgets(b.page), RECORD);
  assert.deepEqual(b.modes, ["record"]);
  assert.equal(
    b.page.querySelector("[data-role=mode-switch] [data-mode=record]").getAttribute("aria-pressed"),
    "true",
  );
});

test("Edit layout gives every frame Remove, Size and a drag handle and the tray Add", async () => {
  const b = await bootShell();
  assert.equal(layoutEntry(b.page, "layout-edit").textContent, "Edit layout");
  assert.equal(
    b.page.querySelector("[data-role=studio-widgets] [data-act=widget-remove]"),
    null,
    "nothing to remove before the layout is being edited",
  );
  assert.equal(b.page.querySelector("[data-role=widget-tray]").hasAttribute("hidden"), true);

  startEditing(b);
  assert.equal(b.page.querySelector("[data-role=widget-tray]").hasAttribute("hidden"), false, "the tray is shown");

  for (const id of COMPOSE) {
    assert.ok(frameAct(b, id, "widget-remove"), `${id} can leave the page`);
    assert.ok(frameAct(b, id, "widget-size"), `${id} can change size`);
    assert.ok(frame(b.page, id).querySelector("[data-role=widget-drag]"), `${id} can be moved`);
  }
  for (const id of ["chop", "keyboard", "mixer-strip", "takes", "midi", "agent"]) {
    assert.ok(frameAct(b, id, "widget-add"), `${id} can come back from the tray`);
  }

  click(b.domWindow, layoutEntry(b.page, "layout-edit"));
  assert.equal(layoutEntry(b.page, "layout-edit").textContent, "Edit layout", "Done leaves edit mode");
  assert.equal(
    frame(b.page, "scene-grid").querySelector(".st-widget-edit").hasAttribute("hidden"),
    true,
    "the controls leave with edit mode",
  );
  assert.equal(b.page.querySelector("[data-role=widget-tray]").hasAttribute("hidden"), true);
});

test("Remove moves a widget to the tray and writes only this song, mode and class key", async () => {
  const b = await bootShell();
  const otherSongKey = layoutKey("another-song", "compose", "laptop");
  const otherSongValue = JSON.stringify({ v: 1, shown: [{ id: "takes", size: "m" }] });
  b.storage.setItem(otherSongKey, otherSongValue);

  startEditing(b);
  click(b.domWindow, frameAct(b, "history", "widget-remove"));

  assert.deepEqual(shownWidgets(b.page), ["scene-grid", "editor", "pads", "steps", "fx"]);
  assert.deepEqual(trayWidgets(b.page), ["chop", "keyboard", "mixer-strip", "takes", "midi", "history", "agent"]);
  assert.deepEqual(storedIds(b.storage, SONG, "compose", "laptop"), ["scene-grid", "editor", "pads", "steps", "fx"]);
  assert.equal(b.storage.getItem(otherSongKey), otherSongValue, "another song is untouched");
  assert.equal(b.storage.getItem(layoutKey(SONG, "perform", "laptop")), null, "another mode is untouched");
  assert.equal(b.storage.getItem(layoutKey(SONG, "compose", "phone")), null, "another size class is untouched");
  assert.equal(b.storage.getItem(layoutKey(SONG, "compose", "tablet")), null);
  assert.ok(frameAct(b, "history", "widget-add"), "the tray frame offers Add");

  click(b.domWindow, frameAct(b, "history", "widget-add"));
  assert.deepEqual(shownWidgets(b.page), COMPOSE, "Add puts it back at the end");
  assert.deepEqual(storedIds(b.storage, SONG, "compose", "laptop"), COMPOSE);

  click(b.domWindow, frameAct(b, "editor", "widget-size"));
  assert.equal(sizeOf(b.page, "editor"), "l", "Size steps from m to l");
  assert.deepEqual(
    JSON.parse(b.storage.getItem(layoutKey(SONG, "compose", "laptop"))).shown,
    [
      { id: "scene-grid", size: "l" },
      { id: "editor", size: "l" },
      { id: "pads", size: "m" },
      { id: "steps", size: "l" },
      { id: "fx", size: "s" },
      { id: "history", size: "s" },
    ],
  );
});

test("another song's layout is unaffected", async () => {
  const b = await bootShell();
  const otherKey = layoutKey("another-song", "compose", "laptop");
  const otherValue = JSON.stringify({ v: 1, shown: [{ id: "takes", size: "m" }] });
  b.storage.setItem(otherKey, otherValue);

  startEditing(b);
  click(b.domWindow, frameAct(b, "scene-grid", "widget-remove"));
  click(b.domWindow, frameAct(b, "takes", "widget-add"));
  click(b.domWindow, frameAct(b, "takes", "widget-size"));

  assert.equal(b.storage.getItem(otherKey), otherValue);
  assert.deepEqual(storedIds(b.storage, SONG, "compose", "laptop"), ["editor", "pads", "steps", "fx", "history", "takes"]);
});

test("Reset restores the built-in default and deletes the song key", async () => {
  const b = await bootShell();
  startEditing(b);
  click(b.domWindow, frameAct(b, "history", "widget-remove"));
  click(b.domWindow, frameAct(b, "takes", "widget-add"));
  assert.deepEqual(shownWidgets(b.page), ["scene-grid", "editor", "pads", "steps", "fx", "takes"]);
  assert.ok(b.storage.getItem(layoutKey(SONG, "compose", "laptop")), "the edit was stored");

  click(b.domWindow, layoutEntry(b.page, "layout-reset"));

  assert.deepEqual(shownWidgets(b.page), COMPOSE, "the built-in default");
  assert.equal(sizeOf(b.page, "scene-grid"), "l");
  assert.equal(sizeOf(b.page, "editor"), "m");
  assert.equal(sizeOf(b.page, "pads"), "m");
  assert.equal(sizeOf(b.page, "steps"), "l");
  assert.equal(sizeOf(b.page, "fx"), "s");
  assert.equal(sizeOf(b.page, "history"), "s");
  assert.equal(b.storage.getItem(layoutKey(SONG, "compose", "laptop")), null, "the song key is gone");
});

test("Save as my default sends the PUT with every stored slot of this song; Clear sends the DELETE", async () => {
  const calls = [];
  const b = await bootShell({
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true });
    },
    csrf: () => "token-1",
  });
  const compose = b.layout.defaultLayout("compose", "laptop");
  const record = b.layout.defaultLayout("record", "phone");
  b.layout.saveLayout(b.storage, SONG, "compose", "laptop", compose);
  b.layout.saveLayout(b.storage, SONG, "record", "phone", record);
  b.storage.setItem(
    layoutKey("another-song", "compose", "laptop"),
    JSON.stringify({ v: 1, shown: [{ id: "takes", size: "l" }] }),
  );

  click(b.domWindow, layoutEntry(b.page, "layout-save-default"));
  await flush();

  assert.equal(calls.length, 1, "one request");
  assert.equal(calls[0].url, "/api/studio/layout-template");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.headers["x-crow-csrf"], "token-1", "the panel's CSRF header");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.template.v, 1);
  assert.deepEqual(Object.keys(body.template.layouts).sort(), ["compose.laptop", "record.phone"]);
  assert.deepEqual(body.template.layouts["compose.laptop"].shown, compose.shown);
  assert.deepEqual(body.template.layouts["record.phone"].shown, record.shown);
  assert.equal(
    b.page.querySelector("[data-role=layout-note]").textContent,
    "Saved as your default.",
  );

  click(b.domWindow, layoutEntry(b.page, "layout-clear-default"));
  await flush();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "/api/studio/layout-template");
  assert.equal(calls[1].init.method, "DELETE");
  assert.equal(calls[1].init.headers["x-crow-csrf"], "token-1");
  assert.equal(calls[1].init.body, undefined);
  assert.equal(b.page.querySelector("[data-role=layout-note]").textContent, "Your default is cleared.");
});

test("a failed PUT shows a note and keeps the layout", async () => {
  const b = await bootShell({
    fetch: () => Promise.resolve({ ok: false, status: 503 }),
    csrf: () => "token-2",
  });
  startEditing(b);
  click(b.domWindow, frameAct(b, "history", "widget-remove"));
  const before = shownWidgets(b.page);
  const note = b.page.querySelector("[data-role=layout-note]");
  assert.equal(note.hasAttribute("hidden"), true, "nothing to say yet");

  click(b.domWindow, layoutEntry(b.page, "layout-save-default"));
  await flush();

  assert.equal(note.hasAttribute("hidden"), false, "the refusal is shown");
  assert.match(note.textContent, /not saved/);
  assert.deepEqual(shownWidgets(b.page), before, "the song's layout is unchanged");
  assert.deepEqual(storedIds(b.storage, SONG, "compose", "laptop"), before);
});

test("the drop index comes from the frames' rectangles", () => {
  const rects = [
    { top: 0, left: 0, height: 100, width: 600 },
    { top: 110, left: 0, height: 100, width: 300 },
    { top: 220, left: 0, height: 100, width: 300 },
  ];
  assert.equal(dropIndex(rects, { x: 10, y: 10 }), 0, "the near half of the first frame");
  assert.equal(dropIndex(rects, { x: 590, y: 90 }), 1, "the far half of the first frame");
  assert.equal(dropIndex(rects, { x: 10, y: 120 }), 1, "the near half of the middle frame");
  assert.equal(dropIndex(rects, { x: 290, y: 300 }), 3, "the far end of the last frame");
  assert.equal(dropIndex(rects, { x: 10, y: -80 }), 0, "above the first is before the first");
  assert.equal(dropIndex(rects, { left: 290, top: 300 }), 3, "a left/top point works too");
  assert.equal(dropIndex([], { x: 0, y: 0 }), -1, "nothing to drop on");
});

test("reorder by drag changes the saved order", async () => {
  const b = await bootShell();
  startEditing(b);
  stubComposeRects(b);

  const handle = frame(b.page, "editor").querySelector("[data-role=widget-drag]");
  assert.ok(handle, "the frame carries a drag handle");
  handle.dispatchEvent(pointer(b.domWindow, "pointerdown", {
    pointerType: "mouse", button: 0, pointerId: 1, clientX: 10, clientY: 120,
  }));
  handle.dispatchEvent(pointer(b.domWindow, "pointermove", { clientX: 10, clientY: 20 }));
  handle.dispatchEvent(pointer(b.domWindow, "pointerup", { clientX: 10, clientY: 20 }));

  assert.deepEqual(shownWidgets(b.page), ["editor", "scene-grid", "pads", "steps", "fx", "history"]);
  assert.deepEqual(storedIds(b.storage, SONG, "compose", "laptop"), ["editor", "scene-grid", "pads", "steps", "fx", "history"]);
  assert.deepEqual(storedIds(b.storage, "another-song", "compose", "laptop"), null);
});

test("a touch under 400 ms does not start a drag", async (t) => {
  const b = await bootShell();
  startEditing(b);
  stubComposeRects(b);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const handle = frame(b.page, "editor").querySelector("[data-role=widget-drag]");
    handle.dispatchEvent(pointer(b.domWindow, "pointerdown", {
      pointerType: "touch", button: 0, pointerId: 2, clientX: 10, clientY: 120,
    }));
    t.mock.timers.tick(399);
    handle.dispatchEvent(pointer(b.domWindow, "pointermove", { clientX: 10, clientY: 20 }));
    handle.dispatchEvent(pointer(b.domWindow, "pointerup", { clientX: 10, clientY: 20 }));
    t.mock.timers.tick(1000);
  } finally {
    t.mock.timers.reset();
  }

  assert.deepEqual(shownWidgets(b.page), COMPOSE);
  assert.equal(
    b.storage.getItem(layoutKey(SONG, "compose", "laptop")),
    null,
    "a press that ends before the long press writes nothing",
  );
});

test("no layout change adds an undo step (the history list is unchanged)", async () => {
  const b = await bootShell();
  const history = b.page.querySelector("[data-role=history]");
  const step = b.document.createElement("div");
  step.className = "st-entry";
  step.textContent = "One step";
  history.appendChild(step);
  const before = history.innerHTML;

  startEditing(b);
  click(b.domWindow, frameAct(b, "history", "widget-remove"));
  click(b.domWindow, frameAct(b, "takes", "widget-add"));
  click(b.domWindow, frameAct(b, "scene-grid", "widget-size"));
  click(b.domWindow, layoutEntry(b.page, "layout-reset"));
  click(b.domWindow, layoutEntry(b.page, "layout-edit"));

  assert.equal(history.innerHTML, before, "layout is view state, never a history entry");
  assert.equal(history.textContent, "One step");
});

test("a throwing storage lets Edit layout work in memory", async () => {
  const b = await bootShell({ storage: throwingStorage() });
  startEditing(b);

  click(b.domWindow, frameAct(b, "history", "widget-remove"));
  assert.deepEqual(shownWidgets(b.page), ["scene-grid", "editor", "pads", "steps", "fx"]);

  click(b.domWindow, frameAct(b, "editor", "widget-size"));
  assert.equal(sizeOf(b.page, "editor"), "l", "the size steps in memory");

  click(b.domWindow, frameAct(b, "takes", "widget-add"));
  assert.deepEqual(shownWidgets(b.page), ["scene-grid", "editor", "pads", "steps", "fx", "takes"]);

  click(b.domWindow, layoutEntry(b.page, "layout-reset"));
  assert.deepEqual(shownWidgets(b.page), COMPOSE, "reset returns the default");

  assert.doesNotThrow(() => b.shell.setMode("record"));
  assert.deepEqual(shownWidgets(b.page), RECORD);
});

test("phone shows one widget and a tab strip", async () => {
  const b = await bootShell({ width: 500 });

  const strip = tabsStrip(b.page);
  assert.ok(strip, "the phone page carries a tab strip");
  assert.equal(strip.getAttribute("role"), "tablist");
  assert.equal(strip.hasAttribute("hidden"), false, "the strip is shown at phone width");
  assert.deepEqual(
    tabLabels(b.page),
    ["Scene grid", "Editor", "Pads", "Steps", "Effects", "History"],
    "one tab per shown widget, by name",
  );
  assert.deepEqual(
    tabNodes(b.page).map((node) => node.getAttribute("role")),
    ["tab", "tab", "tab", "tab", "tab", "tab"],
  );
  assert.deepEqual(
    tabNodes(b.page).map((node) => node.getAttribute("aria-selected")),
    ["true", "false", "false", "false", "false", "false"],
    "the first shown widget is the active tab",
  );
  assert.deepEqual(visibleFrames(b.page), ["scene-grid"], "only the active widget is on the page");

  click(b.domWindow, tabNodes(b.page)[5]);
  assert.equal(activeTab(b.page).textContent, "History");
  assert.deepEqual(visibleFrames(b.page), ["history"]);
  assert.equal(
    b.storage.getItem(layoutKey(SONG, "compose", "phone")),
    null,
    "the active tab is view state and is never stored with a layout",
  );

  // The tab stays valid when the layout moves under it.
  b.shell.setMode("record");
  assert.deepEqual(tabLabels(b.page), ["Scene grid", "Takes", "MIDI", "History"], "the tabs follow the mode");
  assert.deepEqual(visibleFrames(b.page), ["history"], "a tab the new layout still shows stays the active one");
  assert.equal(activeTab(b.page).textContent, "History");

  startEditing(b);
  assert.deepEqual(
    visibleFrames(b.page),
    ["scene-grid", "takes", "midi", "history"],
    "editing the layout shows every frame instead of one",
  );
  assert.equal(strip.hasAttribute("hidden"), true, "the tabs step aside while the layout is edited");

  click(b.domWindow, frameAct(b, "history", "widget-remove"));
  click(b.domWindow, layoutEntry(b.page, "layout-edit"));
  assert.deepEqual(visibleFrames(b.page), ["scene-grid"], "the active widget left, so the first shown one takes over");
  assert.equal(activeTab(b.page).textContent, "Scene grid");

  b.media.setWidth(1280);
  assert.equal(strip.hasAttribute("hidden"), true, "a laptop has no tab strip");
  assert.deepEqual(
    visibleFrames(b.page),
    RECORD,
    "a laptop shows every frame of its own layout",
  );
});

test("a left swipe on the tab strip selects the next tab", async () => {
  const b = await bootShell({ width: 500 });
  const strip = tabsStrip(b.page);

  swipe(b.domWindow, tabNodes(b.page)[0], { x: 300, y: 24 }, { x: 200, y: 30 });
  assert.equal(activeTab(b.page).textContent, "Editor", "a left swipe is the next widget");
  assert.deepEqual(visibleFrames(b.page), ["editor"]);

  // A frame header is a swipe start as well.
  swipe(
    b.domWindow,
    frame(b.page, "editor").querySelector(".st-widget-head"),
    { x: 300, y: 40 },
    { x: 190, y: 44 },
  );
  assert.equal(activeTab(b.page).textContent, "Pads", "a left swipe on a header is the next widget too");
  assert.deepEqual(visibleFrames(b.page), ["pads"]);

  swipe(b.domWindow, strip, { x: 200, y: 24 }, { x: 320, y: 20 });
  assert.equal(activeTab(b.page).textContent, "Editor", "a right swipe is the previous widget");
  assert.deepEqual(visibleFrames(b.page), ["editor"]);

  swipe(b.domWindow, strip, { x: 300, y: 20 }, { x: 220, y: 120 });
  assert.equal(activeTab(b.page).textContent, "Editor", "a mostly vertical drag leaves the tab alone");

  swipe(b.domWindow, strip, { x: 300, y: 20 }, { x: 280, y: 20 });
  assert.equal(activeTab(b.page).textContent, "Editor", "a short drag leaves the tab alone");

  assert.equal(b.storage.getItem(layoutKey(SONG, "compose", "phone")), null, "a swipe writes no layout");
});

test("a horizontal drag starting in the grid scrolls it and does not change tab", async () => {
  const b = await bootShell({ width: 500 });
  const grid = b.refs.gridWrap;
  grid.setAttribute("data-scroll", "");
  grid.style.setProperty("overflow-x", "auto");

  swipe(b.domWindow, grid, { x: 300, y: 120 }, { x: 200, y: 124 });
  assert.equal(activeTab(b.page).textContent, "Scene grid", "a drag in the grid belongs to the grid");
  assert.deepEqual(visibleFrames(b.page), ["scene-grid"]);

  // A scrolling box is the page's wherever it sits, a frame header included.
  const head = frame(b.page, "scene-grid").querySelector(".st-widget-head");
  const scroller = b.document.createElement("div");
  scroller.setAttribute("data-scroll", "");
  head.appendChild(scroller);
  swipe(b.domWindow, scroller, { x: 300, y: 20 }, { x: 200, y: 24 });
  assert.equal(activeTab(b.page).textContent, "Scene grid");

  const overflowing = b.document.createElement("div");
  overflowing.style.setProperty("overflow-x", "scroll");
  head.appendChild(overflowing);
  swipe(b.domWindow, overflowing, { x: 300, y: 20 }, { x: 200, y: 24 });
  assert.equal(activeTab(b.page).textContent, "Scene grid");
  assert.deepEqual(visibleFrames(b.page), ["scene-grid"]);
});

test("a horizontal drag starting on a step or a pad does not change tab", async () => {
  const b = await bootShell({ width: 500 });
  // A frame's own controls can live in its header, so the rule is checked there.
  const head = frame(b.page, "scene-grid").querySelector(".st-widget-head");

  const step = b.document.createElement("button");
  step.setAttribute("type", "button");
  step.setAttribute("data-act", "step");
  step.textContent = "Step";
  head.appendChild(step);

  const pad = b.document.createElement("input");
  pad.setAttribute("type", "range");
  pad.setAttribute("data-pad-field", "cutoff_hz");
  head.appendChild(pad);

  const field = b.document.createElement("input");
  field.setAttribute("type", "text");
  head.appendChild(field);

  swipe(b.domWindow, step, { x: 300, y: 20 }, { x: 200, y: 22 });
  assert.equal(activeTab(b.page).textContent, "Scene grid", "a step keeps its press");

  swipe(b.domWindow, pad, { x: 200, y: 20 }, { x: 320, y: 22 });
  assert.equal(activeTab(b.page).textContent, "Scene grid", "a pad knob keeps its drag");

  swipe(b.domWindow, field, { x: 300, y: 20 }, { x: 200, y: 22 });
  assert.equal(activeTab(b.page).textContent, "Scene grid", "a field keeps its press");
  assert.deepEqual(visibleFrames(b.page), ["scene-grid"]);
});

// ---- the side panels toggle ----------------------------------------------

test("the toggle hides history and agent, persists, restores", async () => {
  const storage = memoryStorage();
  const first = await bootShell({ storage });

  // Put both side panels on the page, so the button has the two of them to
  // hide: compose's default leaves the agent in the tray.
  const withAgent = first.layout.showWidget(
    first.layout.loadLayout(storage, SONG, "compose", "laptop"),
    "agent",
  );
  assert.equal(first.layout.saveLayout(storage, SONG, "compose", "laptop", withAgent), true);
  first.shell.refresh();
  assert.deepEqual(
    visibleFrames(first.page),
    [...COMPOSE, "agent"],
    "both side panels start on the page",
  );

  const toggle = sideToggle(first.page);
  assert.ok(toggle, "the top bar carries one side panels toggle");
  assert.equal(toggle.textContent, "Hide side panels");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");

  // A step in the history list, so hiding the panels can be checked against it.
  const historyList = first.page.querySelector("[data-role=history]");
  const step = first.document.createElement("div");
  step.className = "st-entry";
  step.textContent = "One step";
  historyList.appendChild(step);
  const historyBefore = historyList.innerHTML;

  click(first.domWindow, toggle);

  assert.equal(toggle.textContent, "Show side panels", "one button hides both and says what comes next");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(storage.getItem(SIDE_KEY), "1", "the choice is this browser's");
  assert.deepEqual(
    visibleFrames(first.page),
    ["scene-grid", "editor", "pads", "steps", "fx"],
    "history and agent are gone together",
  );
  assert.equal(historyList.innerHTML, historyBefore, "hiding a panel is view state, never a history entry");

  // The frames are still in the document, only display:none, so the grid has no
  // hole where they were and nothing the page wrote into them is lost.
  assert.equal(shownWidgets(first.page).length, COMPOSE.length + 1, "the layout itself is untouched");
  assert.equal(frame(first.page, "history").parentNode, first.page.querySelector("[data-role=studio-widgets]"));
  assert.equal(frame(first.page, "agent").parentNode, first.page.querySelector("[data-role=studio-widgets]"));
  assert.equal(frame(first.page, "history").hasAttribute("hidden"), true);
  assert.equal(frame(first.page, "agent").hasAttribute("hidden"), true);
  assert.equal(first.page.querySelector("#st-ask"), first.refs.askInput, "the agent's box is still on the page");
  assert.equal(first.refs.aside.hasAttribute("hidden"), true, "the emptied aside stays out of the page");
  assert.deepEqual(
    storedIds(storage, SONG, "compose", "laptop"),
    [...COMPOSE, "agent"],
    "hiding a panel writes no layout",
  );

  // A phone has no tab for a hidden panel, and still shows one widget.
  first.media.setWidth(500);
  assert.deepEqual(tabLabels(first.page), ["Scene grid", "Editor", "Pads", "Steps", "Effects"]);
  assert.deepEqual(visibleFrames(first.page), ["scene-grid"]);
  first.media.setWidth(1280);
  first.shell.destroy();

  // A reload comes back with the panels hidden.
  const second = await bootShell({ storage });
  assert.equal(sideToggle(second.page).textContent, "Show side panels", "the choice outlives the page");
  assert.equal(sideToggle(second.page).getAttribute("aria-pressed"), "true");
  assert.deepEqual(visibleFrames(second.page), ["scene-grid", "editor", "pads", "steps", "fx"], "and the two side panels are still hidden");

  click(second.domWindow, sideToggle(second.page));
  assert.equal(storage.getItem(SIDE_KEY), "0", "showing them again is kept too");
  assert.deepEqual(visibleFrames(second.page), [...COMPOSE, "agent"]);
  assert.equal(second.page.querySelector("#st-ask"), second.refs.askInput);

  second.shell.destroy();
});

test("the side panels toggle still works when the browser keeps nothing", async () => {
  const b = await bootShell({ storage: throwingStorage() });
  const toggle = sideToggle(b.page);
  assert.deepEqual(visibleFrames(b.page), COMPOSE);

  click(b.domWindow, toggle);
  assert.equal(toggle.textContent, "Show side panels");
  assert.deepEqual(visibleFrames(b.page), ["scene-grid", "editor", "pads", "steps", "fx"], "history steps aside anyway");

  click(b.domWindow, toggle);
  assert.equal(toggle.textContent, "Hide side panels");
  assert.deepEqual(visibleFrames(b.page), COMPOSE);

  // Edit layout shows every frame again, so a hidden panel can still be moved.
  click(b.domWindow, toggle);
  startEditing(b);
  assert.deepEqual(visibleFrames(b.page), COMPOSE, "editing shows the side panels");
  click(b.domWindow, layoutEntry(b.page, "layout-edit"));
  assert.deepEqual(visibleFrames(b.page), ["scene-grid", "editor", "pads", "steps", "fx"], "and Done hides them again");

  b.shell.destroy();
});

// ---- the unread mark has somewhere to show -------------------------------

/** The Layout menu's own row for the agent widget. */
function agentRow(page) {
  return page.querySelector("[data-role=layout-entries] [data-act=layout-agent]");
}

/** The unread dot inside that row. */
function agentRowDot(page) {
  return agentRow(page).querySelector("[data-role=unread-menu]");
}

/** A reply written into the agent's log while nobody is looking at it. */
function writeReply(b, text) {
  const ask = b.page.querySelector("[data-role=ask]");
  const row = b.document.createElement("div");
  row.className = "st-ask-reply";
  row.textContent = text;
  ask.appendChild(row);
}

test("the agent's Layout row brings it onto the page, and carries the unread dot a hidden panel cannot", async () => {
  const b = await bootShell();
  const row = agentRow(b.page);
  assert.ok(row, "the Layout menu carries one row for the agent");
  assert.equal(row.textContent, "Agent");
  assert.equal(row.getAttribute("aria-pressed"), "false", "the agent starts in the tray");
  assert.equal(agentRowDot(b.page).hasAttribute("hidden"), true, "nothing unread yet");

  click(b.domWindow, b.page.querySelector("[data-act=layout-menu]"));
  click(b.domWindow, row);
  assert.deepEqual(shownWidgets(b.page), [...COMPOSE, "agent"], "the row shows the agent");
  assert.equal(row.getAttribute("aria-pressed"), "true");

  // Hide the side panels: the frame goes, and with it the only place the mark
  // had to show. The reply must still be marked where the operator can see it.
  click(b.domWindow, sideToggle(b.page));
  assert.equal(frame(b.page, "agent").hasAttribute("hidden"), true);
  assert.equal(b.document.querySelector("#st-ask"), b.refs.askInput, "the box is still on the page");

  writeReply(b, "A two-track sketch at 120.");
  await tick();

  assert.equal(agentRowDot(b.page).hasAttribute("hidden"), false, "the mark is on the control still on the page");
  assert.equal(frame(b.page, "agent").hasAttribute("hidden"), true, "and the frame it belongs to is still away");

  click(b.domWindow, sideToggle(b.page));
  assert.equal(frame(b.page, "agent").hasAttribute("hidden"), false, "the panels are back");
  assert.equal(agentRowDot(b.page).hasAttribute("hidden"), true, "the agent is on the page, so the row carries no mark");
  assert.equal(unreadDot(b.page).hasAttribute("hidden"), true, "and opening the page clears it");
  assert.equal(
    b.page.querySelector("[data-role=ask]").textContent.includes("two-track sketch"),
    true,
    "the reply the mark was about is in the log",
  );

  b.shell.destroy();
});

test("the Layout button wears the agent's unread mark while the agent is in the tray", async () => {
  const b = await bootShell();
  const button = b.page.querySelector("[data-act=layout-menu]");
  const layoutButtonDot = () => button.querySelector("[data-role=unread-layout]");

  assert.ok(layoutButtonDot(), "the Layout button carries a mark of its own");
  assert.equal(layoutButtonDot().tagName.toLowerCase(), "span", "a dot, not a control");
  assert.equal(button.children.length, 1, "it is the button's only child, so no control was added beside it");
  assert.equal(layoutButtonDot().hasAttribute("hidden"), true, "nothing unread yet");

  writeReply(b, "A two-track sketch at 120.");
  await tick();

  assert.equal(layoutButtonDot().hasAttribute("hidden"), false, "the agent is in the tray, so the button says a reply is waiting");
  assert.equal(button.getAttribute("aria-expanded"), "false", "and the mark is on the menu's shut button");
  assert.equal(agentRowDot(b.page).hasAttribute("hidden"), false, "beside the mark on the menu's own row");

  // Bringing the agent onto the page, through the row that owns it, leaves the
  // button without a mark: the frame says it in its own header now.
  click(b.domWindow, button);
  click(b.domWindow, agentRow(b.page));
  assert.equal(
    frame(b.page, "agent").hasAttribute("hidden"),
    false,
    "the agent is on the page",
  );
  assert.equal(layoutButtonDot().hasAttribute("hidden"), true, "so the Layout button carries no mark");
  assert.equal(agentRowDot(b.page).hasAttribute("hidden"), true, "and neither does the row");

  b.shell.destroy();
});

test("a reply behind another phone tab marks the agent's own tab", async () => {
  const b = await bootShell({ width: 500 });
  b.layout.saveLayout(b.storage, SONG, "compose", "phone", {
    v: 1,
    shown: [{ id: "scene-grid", size: "l" }, { id: "agent", size: "s" }],
  });
  b.shell.refresh();

  const agentTab = () => tabNodes(b.page).find((node) => node.getAttribute("data-widget-tab") === "agent");
  const agentTabDot = () => agentTab().querySelector("[data-role=unread-tab]");
  assert.deepEqual(tabLabels(b.page), ["Scene grid", "Agent"], "the agent has a tab of its own");
  assert.equal(activeTab(b.page).textContent, "Scene grid", "the grid is the tab in front");
  assert.equal(agentTabDot().hasAttribute("hidden"), true, "nothing unread yet");

  writeReply(b, "A two-track sketch at 120.");
  await tick();

  assert.equal(agentTabDot().hasAttribute("hidden"), false, "the agent's tab says a reply is waiting");
  assert.equal(frame(b.page, "agent").hasAttribute("hidden"), true, "and the frame is behind that tab");

  click(b.domWindow, agentTab());
  assert.equal(activeTab(b.page).textContent, "Agent", "opening the tab is how the reply is read");
  assert.equal(agentTabDot().hasAttribute("hidden"), true, "and the mark goes with it");
  assert.equal(unreadDot(b.page).hasAttribute("hidden"), true);

  b.shell.destroy();
});

// ---- the page's own header, and its listeners ----------------------------

test("the header the shell emptied takes no room, and destroy puts the row back", async () => {
  const b = await bootShell();
  const chrome = b.page.querySelector(".st-chrome");
  assert.ok(chrome, "the handler renders a header around the four controls");
  assert.equal(chrome.hasAttribute("hidden"), true, "the emptied row is out of the page");
  assert.equal(chrome.children.length, 0, "nothing is left in it either");

  b.shell.destroy();

  assert.equal(chrome.hasAttribute("hidden"), false, "the row the page drew is back");
  for (const node of [b.refs.back, b.refs.title, b.refs.modes, b.refs.presence]) {
    assert.equal(node.parentNode, chrome, "every control the shell moved is back where the page put it");
  }
});

test("rebuilding a frame's edit controls leaves the listener count flat", async () => {
  const b = await bootShell();
  startEditing(b);
  const before = b.shell.listenerCount();
  assert.ok(before > 0, "the shell records the listeners it adds");

  for (let i = 0; i < 5; i += 1) {
    click(b.domWindow, frameAct(b, "editor", "widget-size"));
  }

  assert.equal(b.shell.listenerCount(), before, "five rebuilds of the editor's controls added no record");
  assert.deepEqual(shownWidgets(b.page), COMPOSE, "and the frames are where they were");
  assert.ok(frameAct(b, "editor", "widget-size"), "the editor still carries its own Size control");

  b.shell.destroy();
});