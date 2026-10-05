/**
 * Kiosk crow_wm (spec §8, rulings R3/R4). Same tool name, same single
 * `command` string, same JSON action shape as servers/wm/server.js — but a
 * kiosk-native executor: it implements the display subset and REFUSES every
 * other command without running it (invite/memo/react/relay/search/open … have
 * side effects a shared household display must not trigger). Window state is
 * per device, held here so it survives a page reload and is visible to the model.
 */
import { INTENT_MAX_CHARS, intentText } from "./intent-text.js";

export const KIOSK_WINDOW_KINDS = Object.freeze(["timer", "recipe", "content"]);
export const IDLE_CLOSE_MS = 10 * 60 * 1000;
export const MAX_TIMER_S = 24 * 3600;
const MAX_TEXT = 4000;
/** A display command is a title and up to MAX_TEXT of text: anything longer is cut before it is parsed. */
const MAX_COMMAND = MAX_TEXT + 500;

export function normalizeCaps(raw) {
  const asked = Array.isArray(raw?.windows) ? raw.windows.filter((k) => KIOSK_WINDOW_KINDS.includes(k)) : [];
  const max = Number.isInteger(raw?.max_windows) ? Math.min(4, Math.max(1, raw.max_windows)) : 4;
  return { windows: asked.length ? [...new Set(asked)] : [...KIOSK_WINDOW_KINDS], iframe: false, max_windows: max };
}

const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORDS = { ...UNITS, ...TEENS, ...TENS };
const NUM_WORD_RE = new RegExp(`\\b(${Object.keys(WORDS).join("|")})\\b`);
const COMPOUND_RE = new RegExp(`\\b(${Object.keys(TENS).join("|")})[ -](${Object.keys(UNITS).join("|")})\\b`, "g");
const UNIT_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;

/**
 * Returns null (caller falls back to the LLM) when nothing parses OR when
 * anything numeric/fractional is left unparsed ("and a half", an unsupported
 * number word, a second number) rather than silently mis-setting the timer.
 */
export function parseDuration(input) {
  let s = String(input || "").toLowerCase();
  s = s.replace(/\bhalf an hour\b/g, "30 minutes")
    .replace(/\b(?:an?|one)\s+(hour|minute|min|second|sec)\b/g, "1 $1")
    .replace(COMPOUND_RE, (_, t, u) => String(TENS[t] + UNITS[u]))
    .replace(new RegExp(NUM_WORD_RE.source, "g"), (w) => String(WORDS[w]));
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
  const before = s.slice(0, first).trim(), after = s.slice(last).trim();
  if (/\d|\b(half|quarter)\b/.test(before + " " + after) || NUM_WORD_RE.test(before + " " + after)) return null;
  return { seconds: Math.round(total), before, after };
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
// Every message the model reads is written with concrete examples, never angle-bracket
// placeholders: the 4B copied "<title> | <text> — || starts a paragraph…" onto a card (live test 2026-10-04).
const USAGE = "Not available on this display. It understands, for example: timer 10 minutes pasta; stop timer pasta; recipe Pancakes | flour; eggs | Mix the batter || Cook two minutes a side; display Shopping list | milk, eggs, bread; next step; close; close all. Otherwise answer aloud.";
// One example per kind of window: the tool description, and every error that names "the form to use".
const FORM = {
  timer: "timer 10 minutes pasta",
  recipe: "recipe Pancakes | flour; milk; eggs | Mix the batter || Cook two minutes a side",
  content: "display Shopping list | milk, eggs, bread",
};
/** Machine codes on every tool result (the turn logs name:code per call — never the command or its text). */
export const WM_CODES = Object.freeze(["ok", "unknown_command", "placeholder", "bad_timer", "bad_recipe", "no_intent", "nothing_open", "unsupported_window"]);
const err = (code, message) => ({ op: "error", code, message });
const FIRST_WORD_FORM = {
  content: ["display", "show", "list", "add", "update", "note", "notes", "content", "card", "write", "text", "info", "open", "create", "put"],
  timer: ["timer", "set", "start", "countdown", "alarm", "remind", "reminder", "stopwatch"],
  recipe: ["recipe", "cook", "ingredient", "ingredients", "steps"],
};
/** Which kind of window a command the parser did not accept was reaching for (null = no idea). */
function guessForm(raw) {
  const c = String(raw || "").toLowerCase().trim();
  const first = c.split(/[\s|:,]+/)[0];
  for (const [kind, words] of Object.entries(FIRST_WORD_FORM)) if (words.includes(first)) return kind;
  if (/\||:/.test(c)) return "content";
  if (/\b(timer|countdown|alarm|minutes?|seconds?|hours?)\b/.test(c)) return "timer";
  return null;
}
const unknownError = (raw) => {
  const kind = guessForm(raw);
  return err("unknown_command", kind ? `Nothing was shown: this display does not know that command. Call crow_wm again now with a command in exactly this form, with your own real words in place of the example's: ${FORM[kind]}` : USAGE);
};
const placeholderError = (kind) => err("placeholder", `Nothing was shown: the command had placeholder or empty text instead of real content. Call crow_wm again now with the real words${kind ? `, in this form: ${FORM[kind]}` : ""}. If you do not have the content, tell the user aloud that you could not show it.`);
const NO_INTENT_MSG = "Nothing was shown: nobody asked to see anything. Answer the user aloud instead; do not call this tool again for this question.";

/**
 * Does the PLAIN transcript (never the turn-context prefix) ask for the display — to show
 * something, a timer, a recipe, a step, or to close a window? Conservative word lists, en + es.
 * The display tool is offered to the model only on such turns (or while a window is open), and
 * a content card is refused on any other turn: a plain question gets a spoken answer in one
 * model round, not a card repeating it.
 */
const DISPLAY_INTENT = [
  /\bshow (me|us|it|that|this|them|the|my|our)\b/,
  /\bdisplay\b/,
  /\bput\b.{0,40}?\b(up|on (the |my |your )?(screen|display))\b/,
  /\bon (the |my |your )?(screen|display)\b/,
  /\b(pull|bring) up\b/,
  /\b(timers?|countdown|count down|alarms?)\b/,
  /\brecipes?\b/,
  /\b(next|previous|last|first|this|that) step\b|\b(read|repeat) (the |that )?step\b|\bstep (again|\d+)\b/,
  /^(please |can you |could you )?(close|dismiss|hide)\b/,
  /\bclear (the )?(screen|display)\b/,
  // Spanish (a leading \b cannot sit before an accented letter, so those use a space/start anchor).
  /\bmu[eé]stra(me|nos|lo|la)?\b|\bmostrar\b|\bens[eé][ñn]a(me|nos)\b/,
  /\ben (la |mi |tu )?pantalla\b/,
  /\b(temporizador(es)?|cron[oó]metro|cuenta atr[aá]s|cuenta regresiva|alarmas?)\b/,
  /\brecetas?\b/,
  /(^| )(siguiente|anterior|pr[oó]ximo|[uú]ltimo|primer|este|ese) paso\b|\b(lee|leer|repite|repetir) (el |ese )?paso\b/,
  /^(por favor )?(cierra|cerrar|quita|oculta)\b/,
  /\b(borra|limpia) (la )?pantalla\b/,
];
export function wantsDisplay(transcript) {
  const t = intentText(transcript);
  return !!t && DISPLAY_INTENT.some((re) => re.test(t));
}

/**
 * Does the plain transcript ask for NEW content on the screen — show / display / put up
 * something, a new timer, a recipe? Narrower than wantsDisplay: the close and step family
 * and questions about what is already there are vetoed. On such a turn the voice turn
 * requires a successful display call (live re-test 2026-10-04: "I've displayed a list of
 * three fruits" with nothing on the screen). → "timer" | "recipe" | "content" | null.
 */
const NEW_DISPLAY = {
  timer: [
    /\b(set|start|create|make|begin|need|want|give me)\b.{0,30}\b(timer|countdown|count down|alarm)\b/,
    /\b(timer|countdown|alarm) (for|of)\b/,
    /\b(pon|ponme|poner|crea|inicia|empieza|programa)\b.{0,30}\b(temporizador|cron[oó]metro|cuenta atr[aá]s|cuenta regresiva|alarma)\b/,
  ],
  recipe: [/\brecipes? (for|to make|of)\b/, /\brecetas? (de|para)\b/],
  content: [
    /\bshow (me|us|it|that|this|them|the|my|our)\b/,
    /\bdisplay (a|an|the|my|our|me|us|some|this|that|it)\b/,
    /\bput\b.{0,40}?\b(up|on (the |my |your )?(screen|display))\b/,
    /\b(pull|bring) up\b/,
    /\bmu[eé]stra(me|nos|lo|la)?\b|\bmostrar\b|\bens[eé][ñn]a(me|nos)\b/,
    /\ben (la |mi |tu )?pantalla\b/,
  ],
};
const NOT_NEW = [
  /\b(next|previous|last|first|this|that) step\b|\b(read|repeat) (the |that )?step\b|\bstep (again|\d+)\b/,
  /^(please |can you |could you )?(close|dismiss|hide|stop|cancel|clear|pause|remove|delete)\b/,
  /\bhow (long|much|do|can|to|would|should)\b|\b(left|remaining|still running)\b/,
  /\b(stop|cancel|pause|silence|turn off|switch off)\b.{0,20}\b(timer|countdown|alarm)\b/,
  /\bwhat( s| is)? (on|in) (the |my )?(screen|display)\b/,
  /(^| )(siguiente|anterior|pr[oó]ximo|[uú]ltimo|primer|este|ese) paso\b|\b(lee|leer|repite|repetir) (el |ese )?paso\b/,
  /^(por favor )?(cierra|cerrar|quita|oculta|para|det[eé]n|cancela|borra|limpia)\b/,
  /\bcu[aá]nto (queda|falta|tiempo)\b|\bqu[eé] hay\b|\bc[oó]mo\b/,
  /\b(parar|para|detener|cancelar|cancela|apagar|apaga)\b.{0,20}\b(temporizador|cron[oó]metro|alarma)\b/,
];
export function newDisplayKind(transcript) {
  const t = intentText(transcript);
  if (!t || NOT_NEW.some((re) => re.test(t))) return null;
  for (const [kind, list] of Object.entries(NEW_DISPLAY)) if (list.some((re) => re.test(t))) return kind;
  return null;
}
export const wantsNewDisplay = (transcript) => newDisplayKind(transcript) !== null;

/**
 * Text that must never reach the screen: empty, a syntax placeholder (<title>, a bare
 * "title"/"text"…), or an echo of the tool's own syntax help.
 */
// <title>, <text>, <step> …: one or two words tight inside the brackets ("a < b and c > d" is real text).
const PLACEHOLDER_TOKEN = /<[a-z_]{2,16}(?: [a-z_]{2,16})?>/i;
// Bare placeholder words, per field: a card may be TITLED "Ingredients" or "Steps", but not "Title".
const PH = {
  title: new Set(["title"]), text: new Set(["text", "body", "content"]),
  ingredient: new Set(["ingredient", "ingredients"]), step: new Set(["step", "steps"]), timer: new Set(["name"]),
};
const PLACEHOLDER_WORDS = new Set(Object.values(PH).flatMap((s) => [...s]));
const SYNTAX_ECHO = /starts a paragraph|lines starting|become a list|a bar separates|double bar separates|\btitle \| (text|ingredients)\b/i;
export function isPlaceholderText(s, words = PLACEHOLDER_WORDS) {
  const t = String(s ?? "").trim();
  if (!t || PLACEHOLDER_TOKEN.test(t) || SYNTAX_ECHO.test(t)) return true;
  if (t.length > 40) return false;   // a bare placeholder word is short; nothing below reads long text
  return words.has(t.toLowerCase().replace(/^[\s"'“”()[\]-]+|[\s"'“”()[\].:;—–-]+$/g, ""));
}

/** Split at single bars only: a double bar is a step or paragraph break and stays in its part. */
function splitSingleBars(s) {
  const out = [];
  let from = 0;
  for (let i = s.indexOf("|"); i >= 0; i = s.indexOf("|", i + 1)) {
    if (s[i + 1] === "|") { i++; continue; }
    out.push(s.slice(from, i));
    from = i + 1;
  }
  out.push(s.slice(from));
  return out;
}

export function parseKioskCommand(command) {
  const raw = String(command || "").slice(0, MAX_COMMAND).trim();
  let end = raw.length;
  while (end > 0 && ".!?".includes(raw[end - 1])) end--;
  const c = raw.slice(0, end).toLowerCase().replace(/\s+/g, " ");
  if (!c) return err("unknown_command", USAGE);
  if (PLACEHOLDER_TOKEN.test(raw)) return placeholderError(guessForm(raw));
  if (/^close (all|everything)( windows)?$|^clear (the )?screen$/.test(c)) return { op: "close_all" };
  let m = c.match(/^(?:stop|cancel|dismiss|clear|close) (?:the )?timer(?: (?:for |called |named )?(.+))?$/);
  if (m) return { op: "close", kind: "timer", name: m[1] || null };
  m = c.match(/^close(?: (?:the )?(window|recipe|content|it|this|that))?$/);
  if (m) return { op: "close", kind: m[1] === "recipe" || m[1] === "content" ? m[1] : null, name: null };
  if (/^(next|next step)$/.test(c)) return { op: "step", delta: 1 };
  if (/^(previous|previous step|back|go back|last step)$/.test(c)) return { op: "step", delta: -1 };
  if (/^(read|repeat) (the )?step$|^what(?:'s|s| s) the step$/.test(c)) return { op: "step", delta: 0 };
  m = raw.match(/^(?:(?:set|start)\s+(?:a\s+|an\s+)?)?timer\s+(?:for\s+)?([\s\S]+)$/i);
  if (m) {
    const d = parseDuration(m[1]);
    if (!d || d.seconds < 1 || d.seconds > MAX_TIMER_S) return err("bad_timer", `Nothing was shown: say how long, from 1 second to 24 hours, in this form: ${FORM.timer}`);
    const rest = d.after || d.before;
    if (/^[,;]|^(and|then|but|so)\b/.test(rest)) return err("bad_timer", `Nothing was shown: say how long, then an optional name, in this form: ${FORM.timer}`);
    const name = cap1(rest.replace(/^(called|named|labell?ed|for)\s+/, "").replace(/^["'“”]+|["'“”.]+$/g, "").trim().slice(0, 40)) || "Timer";
    if (isPlaceholderText(name, PH.timer)) return placeholderError("timer");
    return { op: "open", window: { kind: "timer", name, title: name, seconds: d.seconds } };
  }
  m = raw.match(/^recipe\s+([\s\S]+)$/i);
  if (m) {
    const parts = splitSingleBars(m[1]);
    const title = (parts[0] || "").trim().slice(0, 80);
    const ingredients = (parts[1] || "").split(/;|\n/).map((x) => x.trim()).filter(Boolean).slice(0, 40);
    const steps = parts.slice(2).join(" | ").split(/\|\||\n/).map((x) => x.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean).slice(0, 40);
    if (!title || !steps.length) return err("bad_recipe", `Nothing was shown: a recipe needs a name, its ingredients and at least one step, in this form: ${FORM.recipe}`);
    if (isPlaceholderText(title, PH.title) || ingredients.some((x) => isPlaceholderText(x, PH.ingredient)) || steps.some((x) => isPlaceholderText(x, PH.step))) return placeholderError("recipe");
    return { op: "open", window: { kind: "recipe", title, ingredients, steps, step: 0 } };
  }
  m = raw.match(/^(?:display|show results|show info)\s+([\s\S]+)$/i);
  if (m) {
    // "Title | text": the first single bar (a double bar is a paragraph break, never the title bar).
    const [head, ...rest] = splitSingleBars(m[1]);
    const title = ((rest.length ? head : "").trim() || "Info").slice(0, 80);
    const text = (rest.length ? rest.join("|") : head).trim();
    if (isPlaceholderText(title, PH.title) || isPlaceholderText(text, PH.text)) return placeholderError("content");
    return { op: "open", window: { kind: "content", title, blocks: contentBlocks(title, text) } };
  }
  return unknownError(raw);
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
    const h = timers.get(`${id}:${winId}`);
    if (h) { clearTimer(h); timers.delete(`${id}:${winId}`); }
    return w;
  }
  function fire(id, winId) {
    timers.delete(`${id}:${winId}`);
    const w = dev(id).windows.find((x) => x.id === winId);
    if (!w) return;
    w.done = true;
    try { onTimerDone(id, copy(w)); } catch (err) { console.error("[kiosk wm] onTimerDone failed:", err?.message || err); }
  }
  return {
    list: (id) => dev(id).windows.map(copy),
    focused: (id) => copy(dev(id).windows.at(-1)),
    open(id, spec) {
      const d = dev(id);
      const t = now();
      const evicted = [];
      // One content card per display: a new one replaces the last (live test 2026-10-04: cards piled
      // up as chips). Timers and recipes keep their own windows.
      if (spec.kind === "content") for (const w of d.windows.filter((x) => x.kind === "content")) evicted.push(remove(id, w.id));
      while (d.windows.length >= maxWindows) {
        const victim = d.windows.find((w) => w.kind !== "timer") || d.windows[0];
        evicted.push(remove(id, victim.id));
      }
      const { seconds, ...rest } = spec;
      const w = { ...rest, id: `${spec.kind}-${++d.seq}`, opened_at: t, touched_at: t };
      if (spec.kind === "timer") { w.ends_at = t + seconds * 1000; w.done = false; }
      d.windows.push(w);
      if (w.kind === "timer") timers.set(`${id}:${w.id}`, setTimer(() => fire(id, w.id), Math.max(0, w.ends_at - t)));
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

// Concrete examples only (see USAGE). Kept short: this is in every prompt that offers the tool.
const COMMAND_HELP = {
  timer: `- ${FORM.timer}\n- stop timer pasta`,
  recipe: `- ${FORM.recipe}\n- next step / previous step / read step`,
  content: `- ${FORM.content}`,
};
const MUST_NOTE = "[Display] Nothing has been put on the screen in this turn yet. Call crow_wm now with the real content, under a title of its own. If you cannot, tell the user plainly that you could not show it; never say that it is on the screen.";

export function createWmTool({ store, deviceId, caps, emit }) {
  const c = normalizeCaps(caps);
  const lines = c.windows.map((k) => COMMAND_HELP[k]).join("\n");
  const closes = ["close", ...c.windows.filter((k) => k !== "content").map((k) => `close ${k}`), "close all"].join(" / ");
  const definition = {
    name: "crow_wm",
    description: `Show things on this display. Call it only when someone asks to see, time or follow something — never for ordinary questions, and never to repeat what you say aloud.\nCommands, by example (use the real words):\n${lines}\n- ${closes}\nA bar separates the title from the rest; a double bar separates steps or paragraphs; lines starting with a dash become a list.`,
    inputSchema: { type: "object", properties: { command: { type: "string", description: "One command like the examples, e.g. timer 10 minutes pasta" } }, required: ["command"] },
  };
  /**
   * Offered to the model this turn? Display intent in the plain transcript, or a window is open
   * (follow-ups: "add two minutes", "what's next"). A FINISHED timer does not count: it stays on
   * screen until dismissed, and would otherwise put the tool back on every plain question.
   */
  const when = (transcript) => wantsDisplay(transcript) || store.list(deviceId).some((w) => !(w.kind === "timer" && w.done));
  /**
   * Must this turn end with a successful call? Only a request for NEW content this display can
   * show (never "a window happens to be open"). The voice turn then requires the call, runs one
   * corrective round with mustNote if it did not happen, and otherwise says so truthfully.
   */
  const must = (transcript) => {
    const kind = newDisplayKind(transcript);
    return !!kind && (c.windows.includes(kind) || (kind === "recipe" && c.windows.includes("content")));
  };
  const fail = (code, message) => JSON.stringify({ action: "error", code, message });
  /** turn = { transcript } when called from a voice turn (the echo-card guard); absent elsewhere. */
  async function execute(args, turn) {
    const cmd = parseKioskCommand(String(args?.command || ""));
    if (cmd.op === "error") return fail(cmd.code, cmd.message);
    // No echo cards: a content card on a turn that never asked to see anything only repeats the spoken answer.
    if (cmd.op === "open" && cmd.window.kind === "content" && typeof turn?.transcript === "string" && !wantsDisplay(turn.transcript)) return fail("no_intent", NO_INTENT_MSG);
    if (cmd.op === "open") {
      if (!c.windows.includes(cmd.window.kind)) return fail("unsupported_window", `This display can't show a ${cmd.window.kind} window.`);
      const { window, evicted } = store.open(deviceId, cmd.window);
      for (const e of evicted) emit({ type: "wm", action: "close", id: e.id });
      emit({ type: "wm", action: "open", window });
      return JSON.stringify({ ok: true, code: "ok", action: "open", kind: window.kind, title: window.title });
    }
    const fp = applyControl(cmd, store, deviceId);
    if (!fp) return fail("nothing_open", "Nothing like that is open.");
    for (const e of fp.events) emit(e);
    return JSON.stringify({ ok: true, code: "ok", action: cmd.op, say: fp.say });
  }
  /** Which result satisfies a must turn: something newly put on the screen (a close or a step does not). */
  const mustDone = (result) => result?.ok === true && result.action === "open";
  return { definition, execute, when, must, mustNote: MUST_NOTE, mustDone };
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
  if (typeof transcript !== "string" || transcript.length > INTENT_MAX_CHARS) return null;   // a control phrase is short
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
    "A message may begin with lines in square brackets — [Now] is this display's local date and time, [Display] its open windows. Use them to answer; never read them out.",
  ].join("\n");
}

/** Live display state for THIS turn's user message (never the system message — review M6). The runtime puts clock.js's [Now] line before it. */
export function kioskTurnContext(store, deviceId) {
  return `[Display] ${store.describe(deviceId)}`;
}
