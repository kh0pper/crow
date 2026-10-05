/**
 * The turn's display tools with the voice turn's rules. Definitions come from tools.js; every call
 * ends in the one executor. Per tool:
 *   when      OFFERED this turn (the plain transcript is about it, or there is something to act on)
 *   must      the turn has to end with a successful call (the person is asking for it now)
 *   holdText  the transcript asks this tool for something: the model's text is held back until the
 *             round's calls are known, so a claim is never heard before the result
 *   narrow    false on a compound request: the first round then offers every tool, not one
 *   mustRoute "fast": the quick model takes the turn without the router
 *   mustNote / mustDone / missedText: the corrective round's note, what counts, the could-not line
 * Offered is wider than must-run: "do you like music?" offers crow_play and requires nothing.
 */
import { wantsDisplay, newDisplayKind, createWmTool } from "./wm.js";
import { buildToolDefinitions, WM_VERBS, MEDIA_VERBS, MUST_NOTES } from "./tools.js";
import { mentionsOpen, mentionsPlay, mentionsPlayWord, asksOpen, asksPlay, asksCard, showIntent, compound, compoundParts } from "./patterns.js";
import { spokenWords, KIND_NOUNS } from "./phrases.js";
import { executeIntent } from "./executor.js";
import { STRINGS } from "./strings.js";

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
/** The crow_wm verbs this display can act on: window verbs always, playback verbs once a media session exists. */
export const wmVerbs = (ctx) => [...WM_VERBS, ...(ctx.media ? MEDIA_VERBS : [])];

const UPDATE_WORDS = new Set(["add", "remove", "delete", "change", "update", "replace", "rename", "cross", "scratch", "lose", "drop", "erase", "strike", "agrega", "agregale", "anade", "anadele", "quita", "quitale", "cambia", "actualiza", "borra", "tacha"]);
const SMALL_WORDS = new Set(["the", "and", "for", "our", "list", "card", "note", "los", "las", "del", "una", "lista", "nota"]);
/**
 * Does the plain transcript ask to CHANGE the card that is open ("add grapes to the fruits list")?
 * A change word, and either a word of the open card's title or a word for a card. → the card's title, or null.
 */
export function cardUpdate(transcript, store, deviceId) {
  const w = spokenWords(transcript);
  if (!w || !w.some((x) => UPDATE_WORDS.has(x))) return null;
  const card = store.list(deviceId).filter((x) => x.kind === "content").at(-1);
  if (!card) return null;
  const title = (spokenWords(String(card.title ?? "").slice(0, 80)) || []).filter((x) => x.length >= 3 && !SMALL_WORDS.has(x));
  const namesIt = title.some((x) => w.includes(x)) || w.some((x) => KIND_NOUNS[x] === "content" && Object.hasOwn(KIND_NOUNS, x));
  return namesIt ? card.title : null;
}

/**
 * ctx = { store, deviceId, caps (effective: .windows, .max_windows), lang, sources, items, emit,
 * media?, resolvePlay?, openItem?, mediaVerb? } — see executor.js. → the voice turn's extraTools, in
 * a fixed order (play, open, show, wm).
 */
export function createDisplayTools(ctx) {
  const S = STRINGS[ctx.lang === "es" ? "es" : "en"];
  const win = ctx.caps.windows;
  const items = ctx.items || [];
  const defs = buildToolDefinitions({ windows: win, sources: ctx.sources || [], items, verbs: wmVerbs(ctx) });
  const legacy = createWmTool({ store: ctx.store, deviceId: ctx.deviceId, caps: { windows: win, max_windows: ctx.caps.max_windows }, emit: ctx.emit });
  const enumOf = (name, arg) => defs.find((d) => d.name === name)?.inputSchema.properties[arg].enum || [];
  /** A window is open (follow-ups). A finished timer does not count: it stays until dismissed. */
  const openWindow = () => ctx.store.list(ctx.deviceId).some((w) => !(w.kind === "timer" && w.done));
  const mediaOn = () => ctx.media?.active?.(ctx.deviceId) === true;
  const updates = (t) => cardUpdate(t, ctx.store, ctx.deviceId);
  // A must-run test reads each request of a compound sentence on its own: "close the timer and then show
  // me a list" has to end with the list, though the sentence starts with a close.
  const anyPart = (t, test) => compoundParts(t).some(test);
  const newCard = (t) => anyPart(t, (p) => { const k = newDisplayKind(p) || asksCard(p, items); return !!k && (win.includes(k) || (k === "recipe" && win.includes("content"))); });
  const single = (t) => !compound(t);
  // A compound request is held to the end of the turn and ends on the server's lines for what was done (the
  // results are non-final, so the model also gets each one; its own closing sentence is never heard).
  const toEnd = (when) => (t) => compound(t) && when(t) === true;
  const run = async (intent, turn) => {
    const { events, ...res } = await executeIntent(intent, { ...ctx, turn, strict: false });
    for (const ev of events) ctx.emit(ev);
    // Two requests in one sentence: every result goes back to the model and it finishes the sentence
    // itself, as in 0.1.8. A final result would end the turn after the first of the two.
    if (res.final === true && compound(turn?.transcript)) res.final = false;
    return JSON.stringify(res);
  };
  const playWhen = (t) => mentionsPlay(t) || asksPlay(t);
  const openWhen = (t) => mentionsOpen(t, items);
  // Offered on showIntent (the executor's own test, so offered ⇒ executable) or a change to the open card.
  const showWhen = (t) => showIntent(t, items) || updates(t) !== null;
  // Text is HELD only on the narrower pre-revision-4 tests: a wider offer never delays the spoken answer.
  const showHold = (t) => wantsDisplay(t) || updates(t) !== null || asksCard(t, items) !== null;
  const playHold = (t) => mentionsPlayWord(t) || asksPlay(t);
  const rules = {
    crow_play: {
      when: playWhen, holdText: playHold, holdToEnd: toEnd(playWhen), must: (t) => anyPart(t, asksPlay), narrow: single, mustRoute: "fast", mustNote: MUST_NOTES.crow_play, missedText: S.play_missed_say,
      mustDone: (r) => r?.ok === true && ["playing", "audio_instead", "handed_off"].includes(r.outcome),
      // An argument outside its enumeration is never passed on as given.
      execute: (a, turn) => run({ verb: "play", what: str(a?.what, 120), source: enumOf("crow_play", "source").includes(a?.source) ? a.source : "auto" }, turn),
    },
    crow_open: {
      when: openWhen, holdText: openWhen, holdToEnd: toEnd(openWhen), must: (t) => anyPart(t, (p) => asksOpen(p, items)), narrow: single, mustRoute: "fast", mustNote: MUST_NOTES.crow_open, missedText: S.open_missed_say,
      mustDone: (r) => r?.ok === true && ["opened", "focused", "handed_off"].includes(r.outcome),
      execute: (a, turn) => run({ verb: "open", app: enumOf("crow_open", "app").includes(a?.app) ? a.app : "launcher" }, turn),
    },
    crow_show: {
      // Not "a window happens to be open": on a plain question with a card up, only crow_wm is offered.
      // Revision 4: with a window open crow_show is always offered (a follow-up like "and garlic bread on
      // there too" or "make it twenty minutes instead" has no display word). Required only by `must`.
      when: (t) => showWhen(t) || openWindow(), holdText: showHold, holdToEnd: toEnd(showWhen), narrow: single,
      // A request for NEW content this display can show, or a change to the card that is open.
      must: (t) => newCard(t) || updates(t) !== null,
      mustNote: MUST_NOTES.crow_show,
      mustDone: (r) => r?.ok === true && (r.outcome === "shown" || r.outcome === "updated"),
      execute: (a, turn) => run({ verb: "show", kind: str(a?.kind, 16), title: str(a?.title, 200), body: str(a?.body, 4000) }, { ...turn, update: typeof turn?.transcript === "string" ? updates(turn.transcript) : null }),
    },
    crow_wm: {
      when: (t) => wantsDisplay(t) || openWindow() || mediaOn(),
      holdText: wantsDisplay,
      holdToEnd: toEnd(wantsDisplay),
      execute: (a, turn) => {
        // The K1 form — one `command` string — is still accepted (not advertised) and parsed by the K1 grammar,
        // except on a turn that has to end with a card: there a card put up through it would not count, and the
        // display would say it could not show what is on the screen.
        if (typeof a?.command === "string" && !a?.do) {
          if (typeof turn?.transcript === "string" && rules.crow_show.must(turn.transcript)) return JSON.stringify({ ok: false, outcome: "invalid", reason: "use_crow_show", say: "Nothing was shown: put a card on the screen with crow_show, not with this tool. Call crow_show now with kind, title and body.", final: false });
          return legacy.execute(a, turn);
        }
        if (!enumOf("crow_wm", "do").includes(a?.do)) return JSON.stringify({ ok: false, outcome: "invalid", reason: "bad_argument", say: "Nothing was done: do must be one of the listed values.", final: false });
        return run({ verb: a.do, name: str(a?.name, 40) }, turn);
      },
    },
  };
  return defs.map((definition) => ({ definition, ...rules[definition.name] }));
}
