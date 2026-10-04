/**
 * Kiosk crow_wm (spec §8, rulings R3/R4). Same tool name, same single
 * `command` string, same JSON action shape as servers/wm/server.js — but a
 * kiosk-native executor: it implements the display subset and REFUSES every
 * other command without running it (invite/memo/react/relay/search/open … have
 * side effects a shared household display must not trigger). Window state is
 * per device, held here so it survives a page reload and is visible to the model.
 */
export const KIOSK_WINDOW_KINDS = Object.freeze(["timer", "recipe", "content"]);
export const IDLE_CLOSE_MS = 10 * 60 * 1000;
export const MAX_TIMER_S = 24 * 3600;
const MAX_TEXT = 4000;

export function normalizeCaps(raw) {
  const asked = Array.isArray(raw?.windows) ? raw.windows.filter((k) => KIOSK_WINDOW_KINDS.includes(k)) : [];
  const max = Number.isInteger(raw?.max_windows) ? Math.min(4, Math.max(1, raw.max_windows)) : 4;
  return { windows: asked.length ? [...new Set(asked)] : [...KIOSK_WINDOW_KINDS], iframe: false, max_windows: max };
}

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, sixty: 60, ninety: 90 };
const UNIT_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;

export function parseDuration(input) {
  let s = String(input || "").toLowerCase();
  s = s.replace(/\bhalf an hour\b/g, "30 minutes")
    .replace(/\b(?:an?|one)\s+(hour|minute|min|second|sec)\b/g, "1 $1")
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|sixty|ninety)\b/g, (w) => String(WORDS[w]));
  let total = 0, first = -1, last = -1, m;
  UNIT_RE.lastIndex = 0;
  while ((m = UNIT_RE.exec(s))) {
    if (last >= 0 && s.slice(last, m.index).replace(/\band\b|,/g, "").trim() !== "") break;
    if (first < 0) first = m.index;
    const n = parseFloat(m[1]);
    const u = m[2][0];
    total += u === "h" ? n * 3600 : u === "m" ? n * 60 : n;
    last = m.index + m[0].length;
  }
  if (first < 0) return null;
  return { seconds: Math.round(total), before: s.slice(0, first).trim(), after: s.slice(last).trim() };
}

export function contentBlocks(title, body) {
  const blocks = [{ type: "heading", text: String(title).slice(0, 80) }];
  for (const para of String(body).slice(0, MAX_TEXT).split("||").map((p) => p.trim()).filter(Boolean)) {
    const lines = para.split("\n").map((l) => l.trim()).filter(Boolean);
    const items = lines.filter((l) => l.startsWith("- "));
    if (items.length && items.length === lines.length) blocks.push({ type: "list", items: items.map((l) => l.slice(2)) });
    else blocks.push({ type: "text", text: para });
  }
  return blocks;
}

const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const USAGE = "Not available on this display. Use: timer <duration> <name>, stop timer [name], recipe <title> | <ingredients> | <steps>, display <title> | <text>, close, close all, next step.";

export function parseKioskCommand(command) {
  const raw = String(command || "").trim();
  const c = raw.toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  if (!c) return { op: "error", message: USAGE };
  if (/^close (all|everything)( windows)?$|^clear (the )?screen$/.test(c)) return { op: "close_all" };
  let m = c.match(/^(?:stop|cancel|dismiss|clear|close) (?:the )?timer(?: (?:for |called |named )?(.+))?$/);
  if (m) return { op: "close", kind: "timer", name: m[1] || null };
  m = c.match(/^close(?: (?:the )?(window|recipe|content|it|this|that))?$/);
  if (m) return { op: "close", kind: m[1] === "recipe" || m[1] === "content" ? m[1] : null, name: null };
  if (/^(next|next step)$/.test(c)) return { op: "step", delta: 1 };
  if (/^(previous|previous step|back|go back|last step)$/.test(c)) return { op: "step", delta: -1 };
  if (/^(read|repeat) (the )?step$|^what'?s the step$/.test(c)) return { op: "step", delta: 0 };
  m = raw.match(/^(?:(?:set|start)\s+(?:a\s+|an\s+)?)?timer\s+(?:for\s+)?([\s\S]+)$/i);
  if (m) {
    const d = parseDuration(m[1]);
    if (!d || d.seconds < 1 || d.seconds > MAX_TIMER_S) return { op: "error", message: "Say how long, from 1 second to 24 hours, e.g. timer 10 minutes pasta." };
    const name = cap1((d.after || d.before).replace(/^(called|named|labell?ed|for)\s+/, "").replace(/^["'“”]+|["'“”.]+$/g, "").trim().slice(0, 40)) || "Timer";
    return { op: "open", window: { kind: "timer", name, title: name, seconds: d.seconds } };
  }
  m = raw.match(/^recipe\s+([\s\S]+)$/i);
  if (m) {
    const parts = m[1].split(/\s+\|\s+/);
    const title = (parts[0] || "").trim().slice(0, 80);
    const ingredients = (parts[1] || "").split(/;|\n/).map((x) => x.trim()).filter(Boolean).slice(0, 40);
    const steps = parts.slice(2).join(" | ").split(/\|\||\n/).map((x) => x.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean).slice(0, 40);
    if (!title || !steps.length) return { op: "error", message: "Use: recipe <title> | <ingredient>; <ingredient> | <step> || <step>" };
    return { op: "open", window: { kind: "recipe", title, ingredients, steps, step: 0 } };
  }
  m = raw.match(/^(?:display|show results|show info)\s+([\s\S]+)$/i);
  if (m) {
    const body = m[1];
    const i = body.indexOf(" | ");
    const title = (i > 0 ? body.slice(0, i) : "Info").trim().slice(0, 80);
    return { op: "open", window: { kind: "content", title, blocks: contentBlocks(title, i > 0 ? body.slice(i + 3) : body) } };
  }
  return { op: "error", message: USAGE };
}

function fmtLeft(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

export function createWmStore({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onTimerDone = () => {}, maxWindows = 4 } = {}) {
  const devs = new Map();
  const timers = new Map();
  const dev = (id) => { let d = devs.get(id); if (!d) { d = { windows: [], seq: 0 }; devs.set(id, d); } return d; };
  const copy = (w) => (w ? JSON.parse(JSON.stringify(w)) : null);

  function remove(id, winId) {
    const d = dev(id);
    const i = d.windows.findIndex((w) => w.id === winId);
    if (i < 0) return null;
    const [w] = d.windows.splice(i, 1);
    const h = timers.get(winId);
    if (h) { clearTimer(h); timers.delete(winId); }
    return w;
  }
  function fire(id, winId) {
    timers.delete(winId);
    const w = dev(id).windows.find((x) => x.id === winId);
    if (!w) return;
    w.done = true;
    onTimerDone(id, copy(w));
  }
  return {
    list: (id) => dev(id).windows.map(copy),
    focused: (id) => copy(dev(id).windows.at(-1)),
    open(id, spec) {
      const d = dev(id);
      const t = now();
      const evicted = [];
      while (d.windows.length >= maxWindows) {
        const victim = d.windows.find((w) => w.kind !== "timer") || d.windows[0];
        evicted.push(remove(id, victim.id));
      }
      const { seconds, ...rest } = spec;
      const w = { ...rest, id: `${spec.kind}-${++d.seq}`, opened_at: t, touched_at: t };
      if (spec.kind === "timer") { w.ends_at = t + seconds * 1000; w.done = false; }
      d.windows.push(w);
      if (w.kind === "timer") timers.set(w.id, setTimer(() => fire(id, w.id), Math.max(0, w.ends_at - t)));
      return { window: copy(w), evicted: evicted.filter(Boolean).map(copy) };
    },
    close: (id, winId) => copy(remove(id, winId)),
    closeKind(id, kind, name) {
      const ws = dev(id).windows.filter((w) => !kind || w.kind === kind);
      let w = ws.at(-1) || null;
      if (name) { const n = String(name).toLowerCase(); w = ws.find((x) => (x.name || x.title || "").toLowerCase() === n) || ws.find((x) => (x.title || "").toLowerCase().includes(n)) || null; }
      return w ? copy(remove(id, w.id)) : null;
    },
    closeAll(id) { return [...dev(id).windows].map((w) => copy(remove(id, w.id))); },
    focus(id, winId) {
      const d = dev(id);
      const i = d.windows.findIndex((w) => w.id === winId);
      if (i < 0) return null;
      const [w] = d.windows.splice(i, 1);
      w.touched_at = now();
      d.windows.push(w);
      return copy(w);
    },
    step(id, delta) {
      const r = dev(id).windows.filter((w) => w.kind === "recipe").at(-1);
      if (!r) return null;
      r.step = Math.max(0, Math.min(r.steps.length - 1, r.step + delta));
      r.touched_at = now();
      return copy(r);
    },
    sweepIdle(id) {
      const t = now();
      return dev(id).windows.filter((w) => w.kind !== "timer" && t - w.touched_at >= IDLE_CLOSE_MS).map((w) => copy(remove(id, w.id)));
    },
    describe(id) {
      const ws = dev(id).windows;
      if (!ws.length) return "Open windows: none.";
      return "Open windows: " + ws.map((w) => (w.kind === "timer" ? `timer '${w.name}' ${w.done ? "done" : fmtLeft(w.ends_at - now()) + " left"}`
        : w.kind === "recipe" ? `recipe '${w.title}' step ${w.step + 1} of ${w.steps.length}` : `${w.kind} '${w.title}'`)).join("; ") + ".";
    },
  };
}

const COMMAND_HELP = {
  timer: "- timer <duration> <name> — e.g. timer 10 minutes pasta\n- stop timer [name]",
  recipe: "- recipe <title> | <ingredient>; <ingredient> | <step> || <step>\n- next step / previous step / read step",
  content: "- display <title> | <text> — || starts a paragraph; lines starting '- ' become a list",
};

export function createWmTool({ store, deviceId, caps, emit }) {
  const c = normalizeCaps(caps);
  const lines = c.windows.map((k) => COMMAND_HELP[k]).join("\n");
  const closes = ["close", ...c.windows.filter((k) => k !== "content").map((k) => `close ${k}`), "close all"].join(" / ");
  const definition = {
    name: "crow_wm",
    description: `Show things on this display. Call it only when someone asks to see, time or follow something — never for ordinary questions.\nCommands:\n${lines}\n- ${closes}`,
    inputSchema: { type: "object", properties: { command: { type: "string", description: "One command from the list, e.g. timer 10 minutes pasta" } }, required: ["command"] },
  };
  async function execute(args) {
    const cmd = parseKioskCommand(String(args?.command || ""));
    if (cmd.op === "error") return JSON.stringify({ action: "error", message: cmd.message });
    if (cmd.op === "open") {
      if (!c.windows.includes(cmd.window.kind)) return JSON.stringify({ action: "error", message: `This display can't show a ${cmd.window.kind} window.` });
      const { window, evicted } = store.open(deviceId, cmd.window);
      for (const e of evicted) emit({ type: "wm", action: "close", id: e.id });
      emit({ type: "wm", action: "open", window });
      return JSON.stringify({ ok: true, action: "open", kind: window.kind, title: window.title });
    }
    const fp = applyControl(cmd, store, deviceId);
    if (!fp) return JSON.stringify({ action: "error", message: "Nothing like that is open." });
    for (const e of fp.events) emit(e);
    return JSON.stringify({ ok: true, action: cmd.op, say: fp.say });
  }
  return { definition, execute };
}

function applyControl(cmd, store, deviceId) {
  if (cmd.op === "close_all") {
    const closed = store.closeAll(deviceId);
    return closed.length ? { say: "All clear.", events: [{ type: "wm", action: "close_all" }] } : null;
  }
  if (cmd.op === "close") {
    const w = store.closeKind(deviceId, cmd.kind, cmd.name);
    return w ? { say: w.kind === "timer" ? "Timer stopped." : "Closed.", events: [{ type: "wm", action: "close", id: w.id }] } : null;
  }
  if (cmd.op === "step") {
    const r = store.step(deviceId, cmd.delta);
    return r ? { say: `Step ${r.step + 1}. ${r.steps[r.step]}`, events: [{ type: "wm", action: "update", window: r }] } : null;
  }
  return null;
}

function normalizeUtterance(t) {
  return String(t || "").toLowerCase()
    .replace(/[“”"',.!?;:]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(hey crow|ok crow|okay crow|ok|okay|please)\s+/, "")
    .replace(/\s+(please|thanks|thank you)$/, "")
    .trim();
}

function spokenDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const part = (n, u) => (n ? `${n} ${u}${n === 1 ? "" : "s"}` : "");
  return [part(h, "hour"), part(m, "minute"), part(s, "second")].filter(Boolean).join(" ");
}

/**
 * No-LLM fast paths (spec §8.6): controls only when the target exists, plus
 * "set/start a timer for <duration> [called <name>]" (review M8: "set a timer"
 * matches no TOOL_INTENT_RE word, so without this the 4B must emit a tool call).
 */
export function matchWmFastPath(transcript, store, deviceId, caps) {
  const cmd = parseKioskCommand(normalizeUtterance(transcript));
  if (cmd.op === "open" && cmd.window.kind === "timer" && normalizeCaps(caps).windows.includes("timer")) {
    const { window, evicted } = store.open(deviceId, cmd.window);
    return {
      say: `Timer set${window.name !== "Timer" ? ` for ${window.name}` : ""}: ${spokenDuration(cmd.window.seconds)}.`,
      events: [...evicted.map((e) => ({ type: "wm", action: "close", id: e.id })), { type: "wm", action: "open", window }],
    };
  }
  if (!["close", "close_all", "step"].includes(cmd.op)) return null;
  return applyControl(cmd, store, deviceId);
}

/** Static (byte-stable, prefix-cacheable) kiosk instructions for the system message. */
export function kioskPromptSuffix() {
  return [
    "You are speaking through a shared home display to whoever is in the room. Reply in one to three short spoken sentences of plain prose: no markdown, no lists, no emoji.",
    "Use the crow_wm tool only when someone asks to see, time or follow something (a timer, a recipe, something to read); never for ordinary questions.",
  ].join("\n");
}

/** Live display state for THIS turn's user message (never the system message — review M6). */
export function kioskTurnContext(store, deviceId) {
  return `[Display] ${store.describe(deviceId)}`;
}
