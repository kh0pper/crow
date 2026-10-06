/**
 * The one executor. T0, T1 and all four display tools end here with the same intent, and get the
 * same result back: { ok, outcome, say, final, effect?, reason?, title?, names?, events }.
 *   say    On a FINAL result: one sentence in the display's language, at most SAY_MAX characters
 *          (a recipe step is read in full). On a NON-final result it is addressed to the model, in
 *          English, and is never cut: the whole fix must reach it.
 *   final  true = the turn ends on `say`; false = the model gets the result and one more round.
 *   effect false on a success that changed nothing ("nothing is open", a question back to the
 *          person): the voice turn then always speaks `say`, whatever the model said first.
 *   events wm events for the page (the caller emits them; a tool strips them from what the model reads).
 * ctx.strict (T0/T1): a missing target returns null — the phrase does not fire.
 */
import { parseDuration, contentBlocks, isPlaceholderText, wantsDisplay, MAX_TIMER_S } from "./wm.js";
import { showIntent, followUp, windowIntent } from "./patterns.js";
import { spokenWords, sameAt, KIND_NOUNS } from "./phrases.js";
import { MEDIA_VERBS } from "./tools.js";
import { STRINGS } from "./strings.js";

export const SAY_MAX = 120;
const LONG_MAX = 600;
const MODEL_MAX = 600;
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const clamp = (s) => { const t = flat(s); return t.length <= SAY_MAX ? t : `${t.slice(0, SAY_MAX - 1).trimEnd()}…`; };
const fill = (s, o) => String(s).replace(/\{(\w+)\}/g, (m, k) => (o && o[k] != null ? String(o[k]) : m));
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export { flat, fill, joinNames };

export function result(ok, outcome, say, { final = true, effect, reason, title, names, events = [], long = false } = {}) {
  const text = !final ? flat(say).slice(0, MODEL_MAX) : long ? flat(say).slice(0, LONG_MAX) : clamp(say);
  return { ok, outcome, say: text, final, ...(effect === false ? { effect: false } : {}), ...(reason ? { reason } : {}), ...(title ? { title } : {}), ...(names ? { names } : {}), events };
}

// Model-facing (non-final) messages: what went wrong and the fix, once. English, concrete, no placeholders.
export const INVALID = Object.freeze({
  unsupported_window: "Nothing was shown: this display cannot show that kind of card. Tell the user aloud instead.",
  placeholder: "Nothing was shown: the title or body was a placeholder or empty. Call crow_show again now with the real words. If you do not have the content, tell the user aloud that you could not show it.",
  bad_timer: "Nothing was shown: the body of a timer is how long, from 1 second to 24 hours, like 12 minutes. Call crow_show again with that.",
  bad_steps: "Nothing was shown: steps need at least one step, one per line, after a line with three dashes. Call crow_show again in that form.",
  no_change: "Nothing was changed: nobody asked to change the screen. Answer the user aloud instead; do not call this tool again for this question.",
  no_intent: "Nothing was shown: nobody asked to see anything. Answer the user aloud instead; do not call this tool again for this question.",
  update_title: "Nothing was changed: to change the card that is open, call crow_show again with exactly its title, {title}, and the whole new body.",
});
const PH_TITLE = new Set(["title", "name"]);
const PH_BODY = new Set(["text", "body", "content"]);
const PH_ITEM = new Set(["item", "ingredient", "step"]);
const POINTERS = new Set(["", "it", "that", "this", "window", "eso", "esto", "ventana"]);
const lower = (s) => String(s ?? "").toLowerCase();

function spokenDuration(sec, S) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? S[one] : S[many]}` : "");
  return [part(h, "dur_hour", "dur_hours"), part(m, "dur_minute", "dur_minutes"), part(s, "dur_second", "dur_seconds")].filter(Boolean).join(" ");
}
/** "- milk" / "2. eggs" / "• bread" → the item (no pattern: a few character checks). */
function stripBullet(line) {
  const t = line.trim();
  if (t.startsWith("- ") || t.startsWith("* ") || t.startsWith("• ")) return t.slice(2).trim();
  let i = 0;
  while (i < 3 && i < t.length && t[i] >= "0" && t[i] <= "9") i += 1;
  return i > 0 && (t[i] === "." || t[i] === ")") && t[i + 1] === " " ? t.slice(i + 2).trim() : t;
}
const isDashes = (l) => { const t = l.trim(); if (t.length < 3 || t.length > 40) return false; for (const ch of t) if (ch !== "-") return false; return true; };
const joinNames = (names, S) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${S.list_and} ${names.at(-1)}`);

function show(i, ctx, S) {
  const kind = String(i.kind || "");
  const title = flat(i.title).slice(0, 80);
  const body = String(i.body ?? "").slice(0, 4000);
  const bad = (reason, vars) => result(false, "invalid", fill(INVALID[reason], vars), { final: false, reason });
  const win = ctx.caps.windows;
  const need = kind === "timer" ? "timer" : kind === "steps" ? "recipe" : kind === "text" || kind === "list" ? "content" : null;
  if (!need || !win.includes(need)) return bad("unsupported_window");
  if (isPlaceholderText(title, PH_TITLE)) return bad("placeholder");
  // Revision 5: offer and executor agree (showIntent is the predicate crow_show is offered on). A turn with NO
  // display intent — a plain question while a window is open — may only CHANGE what is already open, and
  // only when the words are a follow-up (a change word or a pronoun, never a question): it can never put a
  // new card, recipe or timer up, nor overwrite a card just because the model copied its title.
  const open = ctx.store.list(ctx.deviceId);
  const sameOpen = (k) => open.some((w) => w.kind === k && !w.done && lower(w.title) === lower(title));
  const t = ctx.turn?.transcript;
  let replaceTimer = false;
  if (typeof t === "string" && !showIntent(t, ctx.items)) {
    const follow = followUp(t) || !!ctx.turn.update;
    const target = kind === "timer" ? sameOpen("timer") : kind === "steps" ? sameOpen("recipe") : sameOpen("content");
    if (!follow || !target) {
      const cards = open.filter((w) => w.kind === "content");
      if (follow && (kind === "text" || kind === "list") && (ctx.turn.update || cards.length === 1)) return bad("update_title", { title: ctx.turn.update || cards[0].title });
      return bad("no_intent");
    }
    replaceTimer = kind === "timer";
  }
  let spec, say = null;
  if (kind === "timer") {
    const d = parseDuration(body);
    if (!d || d.seconds < 1 || d.seconds > MAX_TIMER_S) return bad("bad_timer");
    const name = cap1(title.slice(0, 40));
    const plain = ["timer", "temporizador"].includes(name.toLowerCase());
    spec = { kind: "timer", name, title: name, seconds: d.seconds };
    say = plain ? fill(S.say_timer_set_plain, { duration: spokenDuration(d.seconds, S) }) : fill(S.say_timer_set, { name, duration: spokenDuration(d.seconds, S) });
  } else if (kind === "steps") {
    const rows = body.split("\n");
    const cut = rows.findIndex(isDashes);
    const clean = (list) => list.map(stripBullet).filter(Boolean).slice(0, 40);
    const ingredients = cut < 0 ? [] : clean(rows.slice(0, cut));
    const steps = clean(cut < 0 ? rows : rows.slice(cut + 1));
    if (!steps.length) return bad("bad_steps");
    if ([...ingredients, ...steps].some((x) => isPlaceholderText(x, PH_ITEM))) return bad("placeholder");
    spec = { kind: "recipe", title, ingredients, steps, step: 0 };
    say = fill(S.say_steps_shown, { title });
  } else {
    // No echo cards: a text or list card on a turn that never asked to see anything only repeats the
    // spoken answer. One exception: the card being sent has the title of a card that is already open —
    // that is an update of it ("add grapes to the fruits list" has no display word in it).
    // ctx.turn.update (set by the tool on a turn that asks to change the open card) names that card: a call
    // under another title is sent back with the title to use.
    if (isPlaceholderText(body, PH_BODY)) return bad("placeholder");
    let blocks;
    if (kind === "list") {
      let items = body.split("\n").map(stripBullet).filter(Boolean);
      if (items.length === 1 && items[0].includes(",")) items = items[0].split(",").map((x) => x.trim()).filter(Boolean);
      items = items.slice(0, 60);
      if (!items.length || items.some((x) => isPlaceholderText(x, PH_ITEM))) return bad("placeholder");
      blocks = [{ type: "heading", text: title }, { type: "list", items }];
    } else blocks = contentBlocks(title, body.split(/\n[ \t]*\n/).join("||"));
    spec = { kind: "content", title, blocks };
  }
  // put(): the same title replaces that card or recipe; a timer gets its own window, except on a follow-up
  // ("make it twenty minutes instead"), which changes the running timer of that name and never leaves a second one.
  const { window, evicted, updated } = ctx.store.put(ctx.deviceId, spec, { replaceTimer });
  const events = [...evicted.map((e) => ({ type: "wm", action: "close", id: e.id })), { type: "wm", action: "open", window }];
  return result(true, updated ? "updated" : "shown", say ?? fill(updated ? S.say_updated : S.say_shown, { title }), { title: window.title, events });
}

const wordsOf = (s) => spokenWords(String(s ?? "").slice(0, 80)) || [];
const sameWords = (a, b) => a.length === b.length && sameAt(a, 0, b);
function hasRun(w, p) {
  for (let i = 0; i + p.length <= w.length; i += 1) if (sameAt(w, i, p)) return true;
  return false;
}
/** The window a spoken name means: its whole name or title, else whole words of it. Never part of a word ("door" is not "Indoor plants"). */
function findByWords(ctx, kind, name) {
  const q = wordsOf(name);
  if (!q.length) return null;
  const ws = ctx.store.list(ctx.deviceId).filter((w) => !kind || w.kind === kind);
  const whole = ws.filter((w) => sameWords(wordsOf(w.name), q) || sameWords(wordsOf(w.title), q));
  if (whole.length) return whole.at(-1);
  return ws.filter((w) => hasRun(wordsOf(w.title), q) || hasRun(wordsOf(w.name), q)).at(-1) || null;
}

function close(i, ctx, S) {
  let name = flat(i.name).toLowerCase().slice(0, 40);
  for (const a of ["the ", "el ", "la "]) if (name.startsWith(a)) { name = name.slice(a.length); break; }
  let w;
  if (POINTERS.has(name)) w = ctx.store.closeKind(ctx.deviceId, null, null);
  else if (Object.hasOwn(KIND_NOUNS, name)) w = ctx.store.closeKind(ctx.deviceId, KIND_NOUNS[name], null);
  else {
    // "rice timer" (the kind noun last) or "lista de frutas" (the kind noun first): the noun narrows, the rest is the name.
    const parts = name.split(" ");
    const last = Object.hasOwn(KIND_NOUNS, parts.at(-1)) ? KIND_NOUNS[parts.at(-1)] : null;
    const first = Object.hasOwn(KIND_NOUNS, parts[0]) ? KIND_NOUNS[parts[0]] : null;
    const kind = last || first || null;
    const title = last ? parts.slice(0, -1).join(" ") : first ? parts.slice(parts[1] === "de" ? 2 : 1).join(" ") : name;
    const hit = title ? findByWords(ctx, kind, title) : null;
    if (hit) w = ctx.store.close(ctx.deviceId, hit.id);
    // A spoken phrase with no model (strict) stops at whole words. The model's own call may still name part of a title, as in 0.1.8.
    else w = ctx.strict ? null : ctx.store.closeKind(ctx.deviceId, kind, title || null);
  }
  if (!w) return ctx.strict ? null : result(true, "nothing_open", POINTERS.has(name) ? S.say_nothing_open : S.say_nothing_like_that, { effect: false });
  return result(true, "done", w.kind === "timer" ? S.say_timer_stopped : S.say_closed, { events: [{ type: "wm", action: "close", id: w.id }] });
}

function step(delta, ctx, S) {
  const r = ctx.store.step(ctx.deviceId, delta);
  if (!r) return ctx.strict ? null : result(true, "nothing_open", S.say_nothing_open, { effect: false });
  return result(true, "done", fill(S.say_step, { n: r.step + 1, text: r.steps[r.step] }), { long: true, events: [{ type: "wm", action: "update", window: r }] });
}

/** intent: { verb, kind?, title?, body?, name?, app?, what?, source?, names? }. Never throws for bad input. */
/** Verbs that change the windows (crow_wm). */
/** The model's `next` is not here: it is the playback verb and never touches a window (see case "next"). */
const WINDOW_VERBS = new Set(["close", "close_all", "next_step", "previous_step"]);
export async function executeIntent(intent, ctx) {
  const S = STRINGS[ctx.lang === "es" ? "es" : "en"];
  // Revision 6: screen-guard parity with show(). On a model turn whose words are not about the windows (a plain
  // question while something is open), a call that would close windows or step a recipe changes nothing.
  const t = ctx.turn?.transcript;
  if (!ctx.strict && typeof t === "string" && WINDOW_VERBS.has(intent?.verb) && ctx.store.list(ctx.deviceId).length && !windowIntent(t)) {
    return result(false, "invalid", INVALID.no_change, { final: false, reason: "no_intent" });
  }
  switch (intent?.verb) {
    case "show": return show(intent, ctx, S);
    case "close": return close(intent, ctx, S);
    case "close_all": {
      // "Close everything" clears the display: the windows, and what is playing.
      const closed = ctx.store.closeAll(ctx.deviceId);
      const stopped = ctx.media?.active?.(ctx.deviceId) === true && ctx.media.stop?.(ctx.deviceId) === "stopped";
      if (!closed.length && !stopped) return ctx.strict ? null : result(true, "nothing_open", S.say_nothing_open, { effect: false });
      return result(true, "done", S.say_all_clear, { events: closed.length ? [{ type: "wm", action: "close_all" }] : [] });
    }
    case "next_step": return step(1, ctx, S);
    case "next": {
      // The model's `next` is the playback verb it chose (next_step is its own verb): it never steps a recipe.
      if (!ctx.strict) return playback(intent, ctx, S);
      // The bare WORD, spoken with no model: the recipe if it is the window in front, else what is playing, else a recipe anywhere.
      if (ctx.store.focused(ctx.deviceId)?.kind === "recipe") return step(1, ctx, S);
      if (ctx.media?.active?.(ctx.deviceId) === true && typeof ctx.mediaVerb === "function") return ctx.mediaVerb(intent, ctx, S);
      return step(1, ctx, S);
    }
    case "stop": {
      // A ringing timer takes "stop" before the music does.
      const ringing = ctx.store.list(ctx.deviceId).filter((w) => w.kind === "timer" && w.done).at(-1);
      if (ringing) { ctx.store.close(ctx.deviceId, ringing.id); return result(true, "done", S.say_timer_stopped, { events: [{ type: "wm", action: "close", id: ringing.id }] }); }
      // The bare word with nothing playing is answered at once, never left to the model.
      if (ctx.strict && intent.bare === true && ctx.media?.active?.(ctx.deviceId) !== true) return result(true, "nothing_playing", S.say_nothing_playing, { effect: false });
      return playback(intent, ctx, S);
    }
    // Spoken forms that have no entry of their own in the model's verb list.
    case "next_track": case "previous_track": case "volume": case "now_playing": return playback(intent, ctx, S);
    case "previous_step": return step(-1, ctx, S);
    case "read_step": return step(0, ctx, S);
    case "choices": { const names = (intent.names || []).map((n) => flat(n).slice(0, 30)).filter(Boolean).slice(0, 3); return result(true, "choices", fill(S.say_choices, { names: joinNames(names, S) }), { names, effect: false }); }
    // The launcher (and with it "not in this list") has nothing to show until the launcher is built.
    case "open": return typeof ctx.openItem === "function" ? ctx.openItem(intent, ctx, S) : (ctx.strict ? null : result(false, "unavailable", S.say_open_unavailable));
    case "play": return typeof ctx.resolvePlay === "function" ? ctx.resolvePlay(intent, ctx, S) : (ctx.strict ? null : result(false, "unavailable", S.say_play_unavailable));
    default:
      if (MEDIA_VERBS.includes(intent?.verb)) return playback(intent, ctx, S);
      return ctx.strict ? null : result(false, "unavailable", S.say_open_unavailable, { reason: "unknown_verb" });
  }
}
/** Playback verbs belong to the media session (ctx.mediaVerb). Without one, nothing is playing. */
function playback(intent, ctx, S) {
  return typeof ctx.mediaVerb === "function" ? ctx.mediaVerb(intent, ctx, S) : (ctx.strict ? null : result(true, "nothing_playing", S.say_nothing_playing, { effect: false }));
}
