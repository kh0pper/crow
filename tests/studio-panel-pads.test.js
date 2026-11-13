/**
 * Studio panel — a sampler track's pads, the step the transport is on, and the
 * lock strip's place beside the steps.
 *
 * The real emitted client script (`CLIENT_SCRIPT`) against a linkedom document
 * built from the page the handler renders, with a real Yjs song, a stubbed
 * socket, a fake AudioContext and a fake engine whose position reports the test
 * pushes. Three things are pinned here:
 *
 *   - the grid's way into a sampler track's pads: the header's Open pads button
 *     makes a pattern in the first scene (Scene 1 when the song has none) or
 *     opens the pattern the track already has, and a sampler track this page
 *     just added opens its pads by itself — a track that arrives from elsewhere
 *     only gets the button;
 *   - the step sequencer says where the transport is, on the cells already
 *     drawn, and clears it when the transport stops;
 *   - lock mode's strip lives with the steps (not in the right column), and the
 *     sentence about locking a step is the visible hint while no lock is on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import studioPanel from "../bundles/studio/panel/studio.js";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";

/** The sampler track, its scene and its pattern clip in the fixture songs. */
const TRACK = "drums";
const SCENE = "verse";
const CLIP = "c-beat";

/** The one sentence about locking a step. */
const HINT = "Hold a step that has a hit to lock it";

// --- the page's server side -------------------------------------------------

/** A database fake: enough of `execute` for the project picker. */
function fakeDb(rows) {
  return {
    async execute() {
      return { rows };
    },
  };
}

/** A response fake with the two properties the handler uses. */
function fakeRes() {
  return {
    headersSent: false,
    html: "",
    send(body) {
      this.html = String(body);
      this.headersSent = true;
    },
    type() {
      return this;
    },
  };
}

/** The dashboard layout stand-in: the body surrounded by a marker. */
function layoutFor({ title, content }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>MARKER${content}</body></html>`;
}

/** Run the panel handler for one request. */
async function render(query) {
  const res = fakeRes();
  await studioPanel.handler(
    { method: "GET", query, headers: {}, csrfToken: "test-token" },
    res,
    { db: fakeDb([{ id: 3, name: "Kitchen songs" }]), layout: layoutFor },
  );
  assert.equal(res.headersSent, true, "the handler should have sent a page");
  return res.html;
}

/** The command registry, with every command module registered. */
async function commandsApi() {
  const registry = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/sampler.js");
  return registry;
}

// --- the song documents -----------------------------------------------------

/**
 * Build a song with one sampler track (its kit arrives with bank A and its
 * sixteen pads), the scenes asked for, and — when `pattern` is set — one
 * sixteen-step pattern clip in the first scene.
 * @param {{scenes?: string[], track?: string, pattern?: boolean, hits?: number[]}} [options]
 * @returns {Promise<object>} a Y.Doc
 */
async function samplerDoc(options = {}) {
  const { newSongDoc, snapshot } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await commandsApi();

  const doc = newSongDoc({ title: "Test song" });
  const trackId = options.track || TRACK;
  runCommand(doc, "track.add", { id: trackId, name: "Beat box", kind: "sampler" });
  for (const [at, id] of (options.scenes || []).entries()) {
    runCommand(doc, "scene.add", { id, name: "Scene " + String(at + 1) });
  }
  if (options.pattern) {
    runCommand(doc, "clip.add_pattern", {
      clip_id: CLIP,
      track_id: trackId,
      scene_id: (options.scenes || [SCENE])[0],
      name: "Beat",
      length_steps: 16,
    });
    // The hits the lock tests need: steps on for the selected pad.
    const bank = Object.values(snapshot(doc).banks || {})[0];
    for (const hit of options.hits || []) {
      runCommand(doc, "step.toggle", {
        clip_id: CLIP,
        pattern_id: "a",
        at: hit,
        bank_id: bank.id,
        index: 0,
        v: 110,
      });
    }
  }
  return doc;
}

// --- the page's browser side ------------------------------------------------

/** A bare `AudioContext`: enough of it for the engine's master bus. */
function audioContextClass() {
  class FakeAudioContext {
    constructor() {
      this.destination = { id: "destination" };
      this.sampleRate = 48000;
      this.state = "running";
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    resume() {
      return Promise.resolve();
    }
    close() {}
  }
  return FakeAudioContext;
}

/**
 * A stand-in for the engine client (`window.StudioEngine`): the position
 * listener the page registers is kept, so a test can push the reports a real
 * engine sends every 50 ms.
 */
function fakeStudioEngine() {
  const calls = { play: 0, stop: 0, songs: 0 };
  const engine = {
    calls,
    node: { connect() {} },
    positionListener: null,
    play() {
      calls.play += 1;
    },
    stop() {
      calls.stop += 1;
    },
    stopAll() {},
    setSong() {
      calls.songs += 1;
    },
    setMode() {},
    setMetronome() {},
    onPosition(listener) {
      engine.positionListener = listener;
    },
    onLaunch() {},
    onError() {},
  };
  return {
    calls,
    engine,
    create() {
      return Promise.resolve(engine);
    },
  };
}

/** A `localStorage` that keeps what it is given. */
function makeStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
  };
}

// --- the rig ----------------------------------------------------------------

/**
 * Run the real client script against a linkedom page and a stubbed wire.
 *
 * @param {object} [options]
 * @param {object} [options.doc] - the Y.Doc to draw
 * @param {boolean} [options.engine] - show the page a `window.StudioEngine`
 * @returns {Promise<object>} the page, its document, and the stubs to look at
 */
async function bootSong(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");

  const doc = options.doc;
  const pageHtml = await render({ song: "song-1" });
  const { document, window: domWindow } = parseHTML(pageHtml);

  /** Every frame the client sent, across reconnects. */
  const sent = [];
  /** One entry per socket the client opened. */
  const sockets = [];
  /** Timers the page scheduled (a held step's quarter second), run on demand. */
  const timers = [];
  /** The page's window listeners, so a release can be dispatched. */
  const windowListeners = {};

  function makeSocket() {
    const socket = { readyState: 1, handlers: {} };
    socket.addEventListener = (name, handler) => {
      (socket.handlers[name] ||= []).push(handler);
      if (name === "open") Promise.resolve().then(() => handler());
    };
    socket.send = (text) => sent.push(JSON.parse(text));
    socket.close = () => {
      socket.readyState = 3;
    };
    sockets.push(socket);
    return socket;
  }

  const current = () => sockets[sockets.length - 1];

  /** Push one server frame into the page's current socket. */
  const frame = (message) => {
    for (const handler of current().handlers.message || []) handler({ data: JSON.stringify(message) });
  };

  const engineApi = options.engine ? fakeStudioEngine() : null;

  const windowStub = {
    crypto: globalThis.crypto,
    localStorage: makeStorage(),
    AudioContext: audioContextClass(),
    location: { protocol: "http:", host: "127.0.0.1:1", reload() {} },
    atob: globalThis.atob,
    addEventListener(name, handler) {
      (windowListeners[name] ||= []).push(handler);
    },
    removeEventListener(name, handler) {
      const list = windowListeners[name] || [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
  };
  if (engineApi) windowStub.StudioEngine = engineApi;

  const scriptText = CLIENT_SCRIPT.replace(
    "'/dashboard/studio/assets/yjs.mjs'",
    JSON.stringify(
      pathToFileURL(
        new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
      ).href,
    ),
  );
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test replaces the Yjs asset URL with the file on disk");

  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      return String(url).includes("module-types")
        ? {
            generators: ["Analog generator"],
            modules: { "Analog generator": { kind: "generator", controllers: [] } },
          }
        : [];
    },
  });

  const run = new Function(
    "document",
    "window",
    "WebSocket",
    "fetch",
    "navigator",
    "crypto",
    "atob",
    "console",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    scriptText,
  );
  run(
    document,
    windowStub,
    function WebSocketStub() {
      return makeSocket();
    },
    fetchStub,
    {},
    globalThis.crypto,
    globalThis.atob,
    console,
    (fn) => {
      timers.push(fn);
      return timers.length;
    },
    () => {},
    () => 0,
    () => {},
  );

  /** Let the page's own promises (the Yjs import, a frame, the engine) settle. */
  const settle = async (rounds = 10) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  /** One event, with the properties a pointer handler reads. */
  const event = (type, props) => {
    const made = new domWindow.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(props || {})) made[key] = value;
    return made;
  };

  /** The state frame for the song as it is now. */
  const stateFrame = (nextDoc = doc) => ({
    type: "state",
    update: Buffer.from(encodeDocState(nextDoc)).toString("base64"),
    history: [],
    presence: [],
  });

  await settle();
  frame(stateFrame());
  await settle();

  /** Click one element the way a person would. */
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `nothing matches ${selector}`);
    node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    return node;
  };

  const ui = {
    doc,
    document,
    window: windowStub,
    windowListeners,
    engine: engineApi,
    sent,
    sockets,
    timers,
    current,
    frame,
    stateFrame,
    click,
    event,
    settle,
    /** Every command of one id the page sent, in order. */
    commands(id) {
      return sent.filter((message) => message.type === "command" && message.command === id);
    },
    /** Run the timers the page queued (a held step's quarter second). */
    runTimers() {
      for (const fn of timers.splice(0, timers.length)) fn();
    },
    /** Release the pointer anywhere: the page hears it on the window. */
    release(props) {
      for (const handler of [...(windowListeners.pointerup || [])]) {
        handler(event("pointerup", props || {}));
      }
    },
    /** Push one transport position, the way the engine reports them. */
    playhead(bar, beat, sixteenth = 1) {
      assert.ok(ui.engine.engine.positionListener, "the page follows the engine's position");
      ui.engine.engine.positionListener({ bar, beat, sixteenth });
    },
    /** Press a step and hold it past the long-press threshold. */
    holdStep(at) {
      const node = ui.step(at);
      node.dispatchEvent(event("pointerdown", { button: 0, clientX: 0 }));
      ui.runTimers();
      return node;
    },
    /** The sampler host, asserted to be the view on screen. */
    view() {
      const host = document.querySelector("[data-role=sampler]");
      assert.ok(host, "the sampler host is on the page");
      assert.equal(host.hidden, false, "the pad-and-steps view is open");
      return host;
    },
    /** @returns {object} the step button for one position */
    step(at) {
      const node = document.querySelector(`[data-role=sampler] [data-act=step][data-at="${at}"]`);
      assert.ok(node, `step ${at} is drawn`);
      return node;
    },
    /** @returns {object} the box that holds the step strip and the lock strip */
    stepsBox() {
      const node = document.querySelector("[data-role=sampler-steps] .st-steps");
      assert.ok(node, "the steps box is drawn");
      return node;
    },
    /** @returns {object[]} the cells marked as the transport's own */
    nowCells() {
      return [...document.querySelectorAll("[data-role=sampler] .st-step-now")];
    },
    /** Open a pattern clip: the pad-and-steps view is its editor. */
    async openSampler() {
      click(`[data-role=grid] [data-act=open-clip][data-clip-id=${CLIP}]`);
      await ui.settle();
    },
    /** Apply a command the page sent to the song, then push the new state. */
    async apply(command, args) {
      const { runCommand } = await commandsApi();
      runCommand(doc, command, args);
      frame(stateFrame());
      await ui.settle();
    },
  };
  return ui;
}

// --- the grid's way into the pads -------------------------------------------

test("a sampler track's header opens the pads: a pattern in its first scene when it has none", async () => {
  const doc = await samplerDoc({ scenes: [SCENE, "chorus"] });
  const ui = await bootSong({ doc });

  const button = ui.document.querySelector(
    `[data-role=grid] [data-act=open-pads][data-track-id=${TRACK}]`,
  );
  assert.ok(button, "the sampler track's header carries Open pads");
  assert.equal(String(button.textContent), "Open pads", "in those words");
  assert.ok(
    ui.document.querySelector(`[data-role=grid] [data-act=new-pattern][data-track-id=${TRACK}]`),
    "and the cell's + Pattern is untouched",
  );

  ui.click(`[data-role=grid] [data-act=open-pads][data-track-id=${TRACK}]`);
  await ui.settle();

  const sent = ui.commands("clip.add_pattern");
  assert.equal(sent.length, 1, "one clip.add_pattern was sent");
  assert.equal(sent[0].args.track_id, TRACK, "on the sampler track");
  assert.equal(sent[0].args.scene_id, SCENE, "in the song's FIRST scene");
  assert.equal(sent[0].args.length_steps, 16, "sixteen steps long");

  // The song has the pattern now: the view opens on it.
  await ui.apply("clip.add_pattern", sent[0].args);
  const view = ui.view();
  assert.match(String(view.querySelector(".st-sampler-head").textContent), /Beat box/);
  assert.ok(view.querySelector('[data-act=pad][data-pad-index="0"]'), "with its pads drawn");
  assert.ok(ui.document.querySelector('[data-role=sampler] [data-act=step][data-at="0"]'), "and its steps");
});

test("a sampler track that already has a pattern opens it, and sends nothing", async () => {
  const doc = await samplerDoc({ scenes: [SCENE, "chorus"], pattern: true });
  const ui = await bootSong({ doc });

  const before = ui.sent.filter((message) => message.type === "command").length;
  ui.click(`[data-role=grid] [data-act=open-pads][data-track-id=${TRACK}]`);
  await ui.settle();

  assert.equal(
    ui.sent.filter((message) => message.type === "command").length,
    before,
    "nothing was sent: the pattern was already there",
  );
  ui.view();
  assert.ok(
    ui.document.querySelector('[data-role=sampler] [data-act=step][data-at="0"]'),
    "the pattern the track has is the one open",
  );
  const focus = ui.sent.filter((message) => message.type === "focus").pop();
  assert.equal(focus.ref, `clip:${CLIP}`, "and the page says which clip it has open");
});

test("a song with no scene gets Scene 1 before the pattern is made", async () => {
  const doc = await samplerDoc({ scenes: [] });
  const ui = await bootSong({ doc });

  ui.click(`[data-role=grid] [data-act=open-pads][data-track-id=${TRACK}]`);
  await ui.settle();

  const order = ui.sent.filter((message) => message.type === "command").map((message) => message.command);
  assert.deepEqual(
    order.slice(-2),
    ["scene.add", "clip.add_pattern"],
    "the scene is added first, and the pattern after it",
  );

  const scene = ui.commands("scene.add")[0];
  assert.match(String(scene.args.id), /^s-/, "with a fresh scene id");
  assert.equal(scene.args.name, "Scene 1", "named Scene 1");

  const pattern = ui.commands("clip.add_pattern")[0];
  assert.equal(pattern.args.scene_id, scene.args.id, "and the pattern is made in that very scene");
  assert.equal(pattern.args.track_id, TRACK, "on the sampler track");
});

// --- the track this page added ----------------------------------------------

test("a sampler track added here opens its pads; one that arrives from elsewhere does not", async () => {
  const doc = await samplerDoc({ scenes: [SCENE] });
  const ui = await bootSong({ doc });

  ui.click("[data-act=add-sampler-track]");
  await ui.settle();

  const added = ui.commands("track.add");
  assert.equal(added.length, 1, "one track.add was sent");
  assert.equal(added[0].args.kind, "sampler", "for a sampler track");
  assert.equal(
    ui.document.querySelector("[data-role=sampler]").hidden,
    true,
    "nothing opens before the song has the track",
  );

  // The hub's answer: the track is in the song.
  await ui.apply("track.add", added[0].args);

  const patterns = ui.commands("clip.add_pattern");
  assert.equal(patterns.length, 1, "the new track's pads opened: a pattern was made for it");
  assert.equal(patterns[0].args.track_id, added[0].args.id, "on the track this page added");

  await ui.apply("clip.add_pattern", patterns[0].args);
  ui.view();
  assert.ok(
    ui.document.querySelector(`[data-role=grid] [data-act=open-pads][data-track-id="${added[0].args.id}"]`),
    "and the new track has its own Open pads button",
  );

  // The same track arriving from the agent, on a page that did not add it: the
  // button, and nothing else.
  const other = await samplerDoc({ scenes: [SCENE] });
  const second = await bootSong({ doc: other });
  const { runCommand } = await commandsApi();
  runCommand(other, "track.add", { id: "t-agent", name: "Sampler 9", kind: "sampler" });
  second.frame(second.stateFrame(other));
  await second.settle();

  assert.equal(
    second.document.querySelector("[data-role=sampler]").hidden,
    true,
    "a track that arrived from elsewhere opens nothing by itself",
  );
  assert.equal(second.commands("clip.add_pattern").length, 0, "and no pattern was made for it");
  assert.ok(
    second.document.querySelector("[data-role=grid] [data-act=open-pads][data-track-id=t-agent]"),
    "it only has the header's button",
  );
});

// --- the step the transport is on -------------------------------------------

test("the step sequencer marks where the transport is, and clears it on Stop", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true });
  const ui = await bootSong({ doc, engine: true });
  await ui.openSampler();

  ui.click("[data-act=play]");
  await ui.settle();
  assert.equal(ui.engine.calls.play, 1, "the fake engine is playing");

  // Bar 1, beat 2, sixteenth 3 of a 16-step pattern at a sixteenth a step.
  ui.playhead(1, 2, 3);
  const first = ui.nowCells();
  assert.equal(first.length, 1, "exactly one cell is where the transport is");
  assert.equal(first[0].getAttribute("data-at"), "6", "bar 1 beat 2 sixteenth 3 is step 6 (0-based)");
  assert.equal(first[0].getAttribute("data-now"), "true", "and it says so on the cell");

  // The next report moves the mark, and leaves nothing behind.
  ui.playhead(1, 1, 1);
  const second = ui.nowCells();
  assert.equal(second.length, 1, "still exactly one cell");
  assert.equal(second[0].getAttribute("data-at"), "0", "back at the top of the loop: step 0");
  assert.equal(ui.step(6).getAttribute("data-now"), "false", "the cell it left says it is no longer it");
  assert.equal(String(ui.step(6).className).includes("st-step-now"), false, "and carries no mark");

  // A stopped transport marks nothing at all.
  ui.click("[data-act=stop]");
  await ui.settle();
  assert.equal(ui.nowCells().length, 0, "the mark goes with the transport");
  for (const cell of ui.document.querySelectorAll("[data-role=sampler] .st-step")) {
    assert.equal(cell.getAttribute("data-now"), "false", "and every cell says it is not the one");
  }
});

// --- where the lock strip lives ---------------------------------------------

test("the lock strip sits beside the steps, and the steps say how to lock one", async () => {
  const doc = await samplerDoc({ scenes: [SCENE], pattern: true, hits: [2] });
  const ui = await bootSong({ doc });
  await ui.openSampler();

  const box = ui.stepsBox();
  const hint = box.querySelector(".st-step-hint");
  assert.ok(hint, "with no lock on, the steps box carries one line of hint");
  assert.equal(String(hint.textContent), HINT, "which is the sentence about locking a step");
  assert.ok(box.querySelector("[data-role=step-lock]") === null, "and no lock strip is drawn");

  const onStep = ui.step(2);
  assert.equal(onStep.getAttribute("data-step-on"), "true", "step 3 has a hit");
  assert.ok(
    String(onStep.getAttribute("title")).startsWith(HINT),
    "an ON step's title starts with the same sentence",
  );
  assert.equal(
    ui.step(0).getAttribute("title"),
    "Click to put a step here",
    "an empty step still says what a click does there",
  );

  // A quarter of a second on the step that has a hit is a lock, not a toggle.
  ui.holdStep(2);
  ui.release();
  await ui.settle();

  const strips = ui.document.querySelectorAll("[data-role=step-lock]");
  assert.equal(strips.length, 1, "holding the step entered lock mode, once");
  const strip = strips[0];
  assert.match(String(strip.textContent), /Locking step 3/, "the strip names the step being locked");
  assert.equal(
    String(strip.querySelector("[data-act=step-lock-done]").textContent),
    "Done",
    "and keeps its way out",
  );

  // Entering lock mode re-rendered the page: the box captured before the hold is
  // detached now, so every assertion after the render reads the live one.
  const liveBox = ui.stepsBox();

  // It is drawn with the steps, not up in the right column.
  const holder = ui.document.querySelector("[data-role=sampler] .st-step-strip").parentElement;
  assert.ok(holder.contains(strip), "the strip is inside the box that holds the step strip");
  assert.ok(liveBox.contains(strip), "and that box is the live steps box");
  assert.ok(holder === liveBox, "which is the steps box itself");
  const right = ui.document.querySelector(".st-sampler-right");
  assert.ok([...right.children].includes(strip) === false, "and it is not a child of the right column");
  assert.ok(right.contains(liveBox), "the steps box is where it always was, in the right column");

  // With the lock on, the hint gives the place to the strip.
  assert.ok(liveBox.querySelector(".st-step-hint") === null, "the hint gives way to the strip");

  // Done leaves lock mode, and the hint comes back.
  ui.click("[data-act=step-lock-done]");
  await ui.settle();
  assert.ok(ui.document.querySelector("[data-role=step-lock]") === null, "Done leaves lock mode");
  const afterDone = ui.stepsBox();
  assert.equal(
    String(afterDone.querySelector(".st-step-hint").textContent),
    HINT,
    "and the hint is back under the steps",
  );
});