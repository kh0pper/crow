/**
 * Studio panel — a phone tap is a press, and the context it starts runs.
 *
 * Two things this file pins, both from the same page:
 *
 *   - item 23, the press-and-hold: on Android a hold on a Studio button
 *     selected its label and opened the Copy/Share menu instead of moving the
 *     control (the Looper). Every Studio control is therefore unselectable in
 *     the page's own CSS, and the rule that says so is read here out of the
 *     style block the handler renders — including what it must NOT match: a
 *     text input, a textarea, and the ask box with its messages.
 *   - item 20, the first context's latency: the context is created inside the
 *     gesture WITH the interactive hint and resumed at once, a
 *     `visibilitychange` back to visible resumes a context in 'suspended' or
 *     'interrupted' (and does nothing to a running one), the readout under the
 *     transport shows the context's own base/output figures, and every reading
 *     is kept in the log behind `window.__crowStudioLatency`.
 *
 * The client runs for real against a linkedom page built from what the handler
 * renders, the same rig tests/studio-panel-session.test.js uses, with an
 * `AudioContext` class whose created options, state and `resume()` calls can be
 * read and driven by the test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import studioPanel from "../bundles/studio/panel/studio.js";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";

const YJS_URL = pathToFileURL(
  new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
).href;

/** The control classes every Studio page's CSS has to leave unselectable. */
const CONTROL_CLASSES = [
  "st-btn",
  "st-transport-btn",
  "st-mode",
  "st-toggle",
  "st-pad",
  "st-step",
  "st-fx-btn",
  "st-empty",
  "st-cell",
  "st-clip",
];

/** The sampler track and the pattern clip the touch tests open. */
const SAMPLER_TRACK = "drums";
const SAMPLER_CLIP = "c-beat";

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

/**
 * The page's own style block, as text.
 * @param {string} html
 * @returns {string}
 */
function styleText(html) {
  const blocks = [...String(html).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
  assert.ok(blocks.length > 0, "the studio page carries its style block");
  return blocks.join("\n");
}

/**
 * Every rule of a style sheet, as its selector list and its declarations.
 * @param {string} css
 * @returns {Array<{selectors: string[], body: string}>}
 */
function cssRules(css) {
  const rules = [];
  // The sheet has no @media blocks around a control rule; comments are dropped
  // first so a comment's prose is never read as a selector.
  const plain = String(css).replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const match of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean);
    if (selectors.length === 0) continue;
    rules.push({ selectors, body: match[2] });
  }
  return rules;
}

/** Whether a declaration block turns selection off. */
function locksSelection(body) {
  return /(?:^|;|\s)user-select\s*:\s*none/.test(String(body));
}

// --- item 23: a press-and-hold is a press -----------------------------------

test("every Studio control is unselectable, in one rule that names them all", async () => {
  const css = String(styleText(await render({ song: "song-1" })));

  const locking = cssRules(css).filter((rule) => locksSelection(rule.body));
  assert.ok(locking.length > 0, "the page has a rule that turns text selection off");

  const complete = locking.filter(
    (rule) =>
      /(?:^|;|\s)user-select\s*:\s*none/.test(rule.body) &&
      /-webkit-user-select\s*:\s*none/.test(rule.body) &&
      /-webkit-touch-callout\s*:\s*none/.test(rule.body),
  );
  assert.ok(complete.length > 0, "a rule carries all three declarations (Android needs the webkit pair)");

  const rule = complete.find((candidate) =>
    candidate.selectors.some((selector) => /(^|[\s>+~])button$/.test(selector)),
  );
  assert.ok(rule, "one of those rules names button itself, so any control is covered");

  const named = rule.selectors.join(", ");
  for (const control of CONTROL_CLASSES) {
    assert.ok(css.includes("." + control), `${control} is a class the studio sheet styles`);
    assert.ok(named.includes("." + control), `the unselectable rule names .${control}`);
  }
  assert.ok(named.includes("[role=button]"), "and anything that only says it is a button");
  // The grid cells that are not buttons of their own: the roll's notes and the
  // timeline's placement blocks.
  assert.ok(named.includes(".st-roll-svg"), "the piano roll");
  assert.ok(named.includes(".st-note"), "and its note cells");
  assert.ok(named.includes(".st-tl-block"), "the timeline's placement blocks");
});

test("no unselectable rule swallows text: not *, not an input, not the ask box", async () => {
  const css = String(styleText(await render({ song: "song-1" })));
  assert.ok(css.includes(".st-ask input"), "the ask box is styled by a selector of its own");

  const locking = cssRules(css).filter((rule) => locksSelection(rule.body));
  assert.ok(locking.length > 0);

  for (const rule of locking) {
    for (const selector of rule.selectors) {
      const bare = selector.replace(/^\.studio\s+/, "");
      assert.notEqual(bare, "*", "nothing is unselectable document-wide");
      assert.equal(/^(input|textarea)(\b|\[|:|$)/.test(bare), false, `${selector} would lock a text field`);
      assert.equal(bare.includes("[contenteditable]"), false, `${selector} would lock an editable region`);
      assert.equal(bare.includes("st-ask"), false, `${selector} would make the ask box unselectable`);
    }
  }
});

// --- a field inside a control still selects its text --------------------------

test("a field inside an unselectable control keeps its selection", async () => {
  const css = String(styleText(await render({ song: "song-1" })));
  const rules = cssRules(css);

  // The rule that turns selection back on: all three declarations, and it
  // names a plain input so it is not some other field's own setting.
  const selectsText = (body) =>
    /(?:^|;|\s)user-select\s*:\s*text/.test(String(body)) &&
    /-webkit-user-select\s*:\s*text/.test(String(body)) &&
    /-webkit-touch-callout\s*:\s*default/.test(String(body));
  const index = rules.findIndex(
    (candidate) => selectsText(candidate.body) && candidate.selectors.includes(".studio input"),
  );
  assert.notEqual(index, -1, "a rule gives fields their selection back");

  // It has to come AFTER the hold-is-a-press rule: same weight, later wins.
  const lockingIndex = rules.findIndex(
    (candidate) => locksSelection(candidate.body) && candidate.selectors.includes(".studio button"),
  );
  assert.notEqual(lockingIndex, -1, "the unselectable rule is on the sheet");
  assert.ok(index > lockingIndex, "the fields' rule comes after the one that turns selection off");

  const rule = rules[index];
  const fields = ["input", "textarea", "[contenteditable]"];
  for (const field of fields) {
    assert.ok(rule.selectors.includes(`.studio ${field}`), `a bare ${field} selects its text`);
  }
  // And the same three inside every container the unselectable rule names, so a
  // velocity, a clip's name or a block's label is still a field.
  for (const container of [".st-cell", ".st-clip", ".st-tl-block", "[role=button]", "button"]) {
    for (const field of fields) {
      const selector = `.studio ${container} ${field}`;
      assert.ok(rule.selectors.includes(selector), `${selector} selects its text`);
    }
  }
});

// --- item 20: the first context runs, and says how late it is ---------------

/**
 * The page's AudioContext stand-in: what the client asked for, the state the
 * test drives, and how often it was resumed.
 * @param {{baseLatency?: number, outputLatency?: number, state?: string}} [options]
 * @returns {Function} the class, with `created` and `instances` on it
 */
function audioContextClass(options = {}) {
  const created = [];
  const instances = [];
  class FakeAudioContext {
    constructor(asked) {
      created.push(asked);
      instances.push(this);
      this.options = asked;
      this.destination = { id: "destination" };
      this.sampleRate = 48000;
      this.state = options.state || "suspended";
      this.resumes = 0;
      this.listeners = {};
      if ("baseLatency" in options) this.baseLatency = options.baseLatency;
      if ("outputLatency" in options) this.outputLatency = options.outputLatency;
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    resume() {
      this.resumes += 1;
      this.state = "running";
      this.emit("statechange");
      return Promise.resolve();
    }
    close() {
      this.state = "closed";
    }
    addEventListener(name, handler) {
      (this.listeners[name] ||= []).push(handler);
    }
    emit(name) {
      for (const handler of this.listeners[name] || []) handler();
    }
  }
  FakeAudioContext.created = created;
  FakeAudioContext.instances = instances;
  return FakeAudioContext;
}

/**
 * The engine client stand-in: enough for a Play to start the transport, and a
 * record of every pad it was asked to play and to let go.
 */
function fakeStudioEngine() {
  const engine = {
    live: [],
    releases: [],
    create() {
      return Promise.resolve({
        node: { connect() {} },
        play() {},
        stop() {},
        stopAll() {},
        dispose() {},
        setSong() {},
        setMode() {},
        setMetronome() {},
        onPosition() {},
        onLaunch() {},
        onError() {},
        onSampleNeeded() {
          return () => {};
        },
        livePad(trackId, bankId, index) {
          engine.live.push({ track_id: String(trackId), bank_id: String(bankId), index: Number(index) });
        },
        liveRelease(trackId, bankId, index) {
          engine.releases.push({ track_id: String(trackId), bank_id: String(bankId), index: Number(index) });
        },
        loadSample() {
          return Promise.resolve();
        },
        unloadSample() {},
        nextBarFrame() {
          return Promise.resolve({ frame: 0, bar: 1 });
        },
      });
    },
  };
  return engine;
}

/**
 * Run the real client against the page the handler renders, with a linkedom
 * document, a stubbed socket and the fake AudioContext above.
 *
 * `sampler` builds a song with a sampler track and a pattern clip instead of a
 * note clip, so the pad-and-steps view can be opened; `innerWidth` is the width
 * the page lays out for (a laptop's 1280 unless a test asks for a phone's).
 *
 * @param {{Ctx?: Function, visibility?: string, sampler?: boolean, innerWidth?: number}} [options]
 * @returns {Promise<object>}
 */
async function bootClient(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { newSongDoc, encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");

  const doc = newSongDoc({ title: "Test song" });
  runCommand(doc, "scene.add", { id: "verse", name: "Verse" });
  if (options.sampler === true) {
    // A sampler track's clip is a pattern: opening it is what fills the four
    // sampler hosts, and its lane of steps is what a phone pages eight at a time.
    await import("../bundles/studio/server/commands/sampler.js");
    runCommand(doc, "track.add", { id: SAMPLER_TRACK, name: "Beat box", kind: "sampler" });
    runCommand(doc, "clip.add_pattern", {
      clip_id: SAMPLER_CLIP,
      track_id: SAMPLER_TRACK,
      scene_id: "verse",
      name: "Beat",
      length_steps: 16,
    });
  } else {
    runCommand(doc, "track.add", { id: "bass", name: "Bass" });
    runCommand(doc, "clip.write", {
      clip_id: "c1",
      track_id: "bass",
      scene_id: "verse",
      name: "Bass line",
      length_bars: 1,
      notes: [{ t: 0, d: 1, p: 60, v: 100 }],
    });
  }

  const Ctx = options.Ctx || audioContextClass({ baseLatency: 0.01, outputLatency: 0.002 });

  const pageHtml = await render({ song: "song-1" });
  const { document, window: domWindow } = parseHTML(pageHtml);

  // A phone's page reports its visibility, and the test drives it.
  let visibility = options.visibility || "visible";
  const visibilityProperty = { configurable: true, get: () => visibility };
  try {
    Object.defineProperty(document, "visibilityState", visibilityProperty);
  } catch (err) {
    Object.defineProperty(Object.getPrototypeOf(document), "visibilityState", visibilityProperty);
  }

  /** Every frame the client sent, across reconnects. */
  const sent = [];
  const sockets = [];
  const timers = [];

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

  const frame = (message) => {
    for (const handler of current().handlers.message || []) handler({ data: JSON.stringify(message) });
  };

  const engineStub = fakeStudioEngine();
  /** The page's window listeners, so a test can dispatch what a phone sends. */
  const windowListeners = {};

  const windowStub = {
    crypto: globalThis.crypto,
    // The width class the page lays out for: a phone under 640 px, a laptop at
    // 1280 unless a test asks for another width.
    innerWidth: Number(options.innerWidth) || 1280,
    AudioContext: Ctx,
    StudioEngine: engineStub,
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

  const scriptText = CLIENT_SCRIPT.replace(
    "'/dashboard/studio/assets/yjs.mjs'",
    JSON.stringify(YJS_URL),
  );
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test replaces the Yjs asset URL with the file on disk");

  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      return String(url).includes("module-types")
        ? { generators: ["Analog generator"], modules: { "Analog generator": { kind: "generator", controllers: [] } } }
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

  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

  /** One DOM event the way a browser sends it: bubbling and cancelable. */
  const event = (type, props) => {
    const made = new domWindow.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(props || {})) made[key] = value;
    return made;
  };

  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `nothing matches ${selector}`);
    node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    return node;
  };

  /** Say the page was hidden, or that it came back. */
  const setVisibility = (state) => {
    visibility = state;
    document.dispatchEvent(new domWindow.Event("visibilitychange"));
  };

  await settle();
  frame({
    type: "state",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
    history: [],
    presence: [],
  });
  await settle();

  return {
    document,
    window: windowStub,
    windowListeners,
    Ctx,
    engine: engineStub,
    sent,
    sockets,
    current,
    frame,
    click,
    event,
    settle,
    setVisibility,
    /** Send one event to the window, as a phone's pointer would. */
    fire(type, props) {
      for (const handler of [...(windowListeners[type] || [])]) handler(event(type, props || {}));
    },
    /** Open the fixture's pattern clip: the pad-and-steps view is its editor. */
    async openSampler() {
      click(`[data-act=open-clip][data-clip-id=${SAMPLER_CLIP}]`);
      await settle();
    },
    /** One sampler host by its role. */
    host(role) {
      return document.querySelector(`[data-role=${role}]`);
    },
    /** @returns {object[]} the step buttons drawn right now */
    steps() {
      const host = document.querySelector("[data-role=sampler-steps]");
      assert.ok(host, "the steps host is on the page");
      return [...host.querySelectorAll("[data-act=step]")];
    },
    /** @returns {object[]} the steps lane's page buttons, as drawn right now */
    pageButtons() {
      const host = document.querySelector("[data-role=sampler-steps]");
      assert.ok(host, "the steps host is on the page");
      return [...host.querySelectorAll("[data-act=step-page]")];
    },
    /** @returns {object} one pad's button */
    pad(index) {
      const node = document.querySelector(
        `[data-role=sampler-pads] [data-act=pad][data-pad-index="${index}"]`,
      );
      assert.ok(node, `pad ${index} is drawn`);
      return node;
    },
  };
}

test("the first Play creates the context with the interactive hint and resumes it at once", async () => {
  const ui = await bootClient({ Ctx: audioContextClass({ baseLatency: 0.01, outputLatency: 0.002 }) });
  const Ctx = ui.Ctx;
  assert.equal(Ctx.instances.length, 0, "no context before a gesture: browsers refuse one");

  ui.click("[data-act=play]");
  await ui.settle();

  assert.equal(Ctx.instances.length, 1, "the first Play made one context");
  const ctx = Ctx.instances[0];
  assert.equal(ctx.options.latencyHint, "interactive", "with the interactive hint Studio always asks for");
  assert.equal(ctx.resumes, 1, "and it was resumed inside the gesture, not after the engine loaded");
  assert.equal(ctx.state, "running", "so the first context is running before the engine plays a note");
});

test("a visibility return resumes a suspended context, and an interrupted one", async () => {
  const ui = await bootClient({ Ctx: audioContextClass({ baseLatency: 0.005, outputLatency: 0.001 }) });
  const Ctx = ui.Ctx;
  ui.click("[data-act=play]");
  await ui.settle();
  const ctx = Ctx.instances[0];
  assert.ok(ctx, "the Play made a context");
  assert.equal(ctx.resumes, 1, "resumed as it was made");

  // Backgrounded: the platform suspends it, and that alone resumes nothing.
  ctx.state = "suspended";
  ui.setVisibility("hidden");
  assert.equal(ctx.resumes, 1, "going hidden touches nothing");

  ctx.state = "suspended";
  ui.setVisibility("visible");
  assert.equal(ctx.resumes, 2, "a suspended context is resumed when the page comes back");

  // Safari and Android WebViews use 'interrupted' for the same situation.
  ctx.state = "interrupted";
  ui.setVisibility("visible");
  assert.equal(ctx.resumes, 3, "an interrupted context is resumed too");

  // A context that is already running is left alone.
  ctx.state = "running";
  ui.setVisibility("visible");
  assert.equal(ctx.resumes, 3, "a running context is not resumed again");
});

test("the readout names the base and output latency the context reports", async () => {
  const ui = await bootClient({ Ctx: audioContextClass({ baseLatency: 0.01, outputLatency: 0.002 }) });
  ui.click("[data-act=play]");
  await ui.settle();

  const readout = ui.document.querySelector("[data-role=output-latency]");
  assert.ok(readout, "the transport carries a latency readout");
  assert.equal(readout.hidden, false, "with figures to show, it is shown");
  assert.equal(
    String(readout.textContent),
    "Output latency: 12 ms (base 10 ms, output 2 ms)",
    "the sentence is built from the context's own two numbers",
  );
});

test("the readout hides when the context reports neither figure", async () => {
  const ui = await bootClient({ Ctx: audioContextClass({}) });
  ui.click("[data-act=play]");
  await ui.settle();

  const readout = ui.document.querySelector("[data-role=output-latency]");
  assert.equal(readout.hidden, true, "nothing to say, so it says nothing");
  assert.equal(String(readout.textContent), "", "and stays empty");
});

test("the latency log keeps a reading from every visibility return", async () => {
  const ui = await bootClient({ Ctx: audioContextClass({ baseLatency: 0.02, outputLatency: 0.004 }) });
  ui.click("[data-act=play]");
  await ui.settle();

  const log = ui.window.__crowStudioLatency;
  assert.ok(Array.isArray(log), "the log is reachable as window.__crowStudioLatency");
  const before = log.length;
  assert.ok(before > 0, "creating the context logged its first reading");
  assert.ok(log[0].base_ms > 0 || log[0].output_ms > 0, "a reading carries the figures");

  ui.setVisibility("visible");
  assert.equal(log.length, before + 1, "coming back to the page logs another reading");
  const latest = log[log.length - 1];
  assert.equal(typeof latest.state, "string", "with the context's state");
  assert.equal(typeof latest.at, "string", "and the moment it was taken");
});

// --- A4: touch targets and the step lane's page size ------------------------

/** The rule (if any) that gives `selector` a 44 px floor in both directions. */
function touchTargetRule(rules, selector) {
  return rules.find(
    (rule) =>
      rule.selectors.includes(selector) &&
      /(?:^|;|\s)min-width\s*:\s*44px/.test(rule.body) &&
      /(?:^|;|\s)min-height\s*:\s*44px/.test(rule.body),
  ) || null;
}

test("a pad, a step, a bank tab and an effect button are 44 px targets", async () => {
  const css = String(styleText(await render({ song: "song-1" })));
  const rules = cssRules(css);

  // The four controls a finger plays on the pad-and-steps view. Each one keeps
  // its own minimum in both directions, however big the grid makes it.
  const controls = [
    ".studio .st-pad",
    ".studio .st-step",
    ".studio .st-bank-tabs .st-toggle",
    ".studio .st-fx-btn",
  ];
  for (const selector of controls) {
    assert.ok(touchTargetRule(rules, selector), `${selector} carries a 44 px floor in width and height`);
  }

  // One rule names all four: the floor is a single decision, so a control added
  // to one of those rows cannot quietly come without it.
  const shared = rules.find((rule) => controls.every((selector) => rule.selectors.includes(selector)));
  assert.ok(shared, "one rule gives all four the 44 px floor");
  assert.match(shared.body, /min-width: 44px/);
  assert.match(shared.body, /min-height: 44px/);

  // And the lane's own grid is wide enough for those targets: a column is never
  // narrower than the button it holds, so the row scrolls instead of squeezing.
  const strips = rules.filter((rule) => rule.selectors.includes(".studio .st-step-strip"));
  assert.ok(
    strips.some((rule) => /repeat\(16, minmax\(44px, 1fr\)\)/.test(rule.body)),
    "a wide lane is sixteen columns of at least 44 px",
  );
  assert.ok(
    strips.some((rule) => /repeat\(8, minmax\(44px, 1fr\)\)/.test(rule.body)),
    "a phone's lane is eight columns of at least 44 px",
  );
});

test("pads, steps and effects never select their label or call out a menu", async () => {
  const rules = cssRules(String(styleText(await render({ song: "song-1" }))));

  for (const selector of [".studio .st-pad", ".studio .st-step", ".studio .st-fx-btn", ".studio .st-toggle"]) {
    const locking = rules.filter((rule) => rule.selectors.includes(selector) && locksSelection(rule.body));
    assert.ok(locking.length > 0, `${selector} is named by a rule that turns selection off`);
    const complete = locking.some(
      (rule) =>
        /-webkit-user-select\s*:\s*none/.test(rule.body) &&
        /-webkit-touch-callout\s*:\s*none/.test(rule.body),
    );
    assert.ok(complete, `${selector} carries -webkit-user-select and -webkit-touch-callout none`);
  }
});

test("a phone pages the step lane eight at a time, and a laptop keeps sixteen", async () => {
  // A phone: eight positions a page, and a pager to reach the rest.
  const phone = await bootClient({ sampler: true, innerWidth: 390 });
  await phone.openSampler();
  assert.deepEqual(
    phone.steps().map((node) => node.getAttribute("data-at")),
    ["0", "1", "2", "3", "4", "5", "6", "7"],
    "the first page is the first eight positions",
  );
  const pager = phone.pageButtons();
  assert.equal(pager.length, 2, "a sixteen-position pattern is two pages on a phone");
  assert.deepEqual(
    pager.map((node) => String(node.textContent)),
    ["1-8", "9-16"],
    "named for the positions they hold",
  );
  assert.equal(pager[0].getAttribute("aria-pressed"), "true", "the first page is the one shown");

  // The second page is positions 9-16, numbered 1-8 within its own page.
  pager[1].dispatchEvent(phone.event("click", {}));
  await phone.settle();
  assert.deepEqual(
    phone.steps().map((node) => node.getAttribute("data-at")),
    ["8", "9", "10", "11", "12", "13", "14", "15"],
    "the second page starts at position 9",
  );
  assert.equal(String(phone.steps()[0].textContent), "1", "and counts from one inside it");
  assert.equal(phone.pageButtons()[1].getAttribute("aria-pressed"), "true", "the pager says which page is shown");

  // A laptop: the sixteen positions it always had, and no pager for one page.
  const laptop = await bootClient({ sampler: true, innerWidth: 1280 });
  await laptop.openSampler();
  assert.equal(laptop.steps().length, 16, "a laptop draws all sixteen positions");
  assert.equal(laptop.steps()[0].getAttribute("data-at"), "0");
  assert.equal(laptop.steps()[15].getAttribute("data-at"), "15");
  assert.equal(laptop.pageButtons().length, 0, "sixteen positions are one page, so there is nothing to turn");
});

test("a long press on a pad is the press it started, not the browser's menu", async () => {
  const ui = await bootClient({ sampler: true });
  await ui.openSampler();

  const onPad = ui.event("contextmenu", {});
  ui.pad(0).dispatchEvent(onPad);
  assert.equal(onPad.defaultPrevented, true, "the menu is cancelled on a pad");

  // The label that names the kit keeps its own long press: only the controls a
  // finger plays cancel the menu.
  const title = ui.host("sampler-pads").querySelector(".st-sampler-title");
  assert.ok(title, "the pads host carries the kit's title");
  const onTitle = ui.event("contextmenu", {});
  title.dispatchEvent(onTitle);
  assert.equal(onTitle.defaultPrevented, false, "text elsewhere in the page is left alone");
});

test("a cancelled pad press lets the pad go exactly once", async () => {
  const ui = await bootClient({ sampler: true });
  await ui.openSampler();
  const pad = ui.pad(0);
  const bankId = pad.getAttribute("data-bank-id");
  assert.ok(bankId, "the pad names its bank");

  pad.dispatchEvent(ui.event("pointerdown", { button: 0 }));
  await ui.settle();
  assert.deepEqual(
    ui.engine.live,
    [{ track_id: SAMPLER_TRACK, bank_id: bankId, index: 0 }],
    "the press played the pad",
  );

  // A pointer the browser took away (a scroll, a call, a drag off the page) is
  // a release: the pad's voice is let go once, and only once.
  ui.fire("pointercancel", {});
  await ui.settle();
  assert.deepEqual(
    ui.engine.releases,
    [{ track_id: SAMPLER_TRACK, bank_id: bankId, index: 0 }],
    "the cancelled press sends one liveRelease",
  );

  // The release and cancel a cancelled pointer is followed by send nothing more.
  ui.fire("pointercancel", {});
  ui.fire("pointerup", {});
  await ui.settle();
  assert.equal(ui.engine.releases.length, 1, "a pad already let go is not released again");
});