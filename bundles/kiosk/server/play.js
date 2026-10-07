/**
 * Media verbs for the executor (it reaches them through ctx.resolvePlay / ctx.openItem /
 * ctx.mediaVerb): resolve "play <what>" against the sources this instance has, the transport verbs,
 * and now playing.
 *
 * With no model (ctx.strict: a spoken phrase or pattern) a verb acts only when it is sure and when it
 * would change something: "play <words>" plays only what a source is confident of, and a transport
 * phrase that is a no-op in the current state ("resume" while it plays) returns null, so the turn
 * goes to the model like any other sentence. Transport phrases say nothing: the change in the
 * audio is the answer. The model's own calls always get a short, truthful, final line.
 */
import { result, fill, flat, joinNames } from "./executor.js";
import { spokenWords, sameAt } from "./phrases.js";
import { cleanTitle, VOLUME_STEP } from "./media.js";
import { SourceUnavailable } from "./sources/index.js";

/** How long "Which one?" waits for its answer. */
export const CHOICE_TTL_MS = 30_000;
export const SOURCE_TIMEOUT_MS = 1500;
export const MAX_CHOICES = 3;
const SOURCE_TAILS = [
  ["radio", ["on", "the", "radio"]], ["radio", ["on", "radio"]], ["radio", ["en", "la", "radio"]],
  ["music", ["from", "my", "library"]], ["music", ["from", "the", "library"]], ["music", ["in", "my", "library"]], ["music", ["de", "mi", "biblioteca"]],
  ["news", ["on", "the", "news"]], ["news", ["en", "las", "noticias"]],
];
// "play the radio": the request is the source itself.
const RADIO_ONLY = new Set(["radio", "station", "stations", "emisora", "emisoras", "estacion", "the", "a", "some", "la", "una", "el", "mi", "my"]);
const RADIO_NOUNS = new Set(["radio", "station", "stations", "emisora", "emisoras", "estacion"]);
/** "blue on the radio" → { what: "blue", source: "radio" }; "the radio" → { what: "", source: "radio" }. */
export function splitSource(what) {
  const text = flat(what).slice(0, 120);
  const w = spokenWords(text);
  if (!w) return { what: text, source: null };
  for (const [source, tail] of SOURCE_TAILS) if (w.length > tail.length && sameAt(w, w.length - tail.length, tail)) return { what: w.slice(0, -tail.length).join(" "), source };
  if (w.length <= 4 && w.every((x) => RADIO_ONLY.has(x)) && w.some((x) => RADIO_NOUNS.has(x))) return { what: "", source: "radio" };
  return { what: text, source: null };
}

const DOWN_ORDER = ["unauthorized", "unreachable", "timeout"];
const NO_RUNS = [["no"], ["nope"], ["nah"], ["no", "thanks"], ["no", "thank", "you"], ["no", "gracias"], ["no", "no"]];
/** "No.", "No thanks.", "No, gracias.": declines a pending question. */
const declines = (text) => { const w = spokenWords(String(text ?? "").slice(0, 40)) || []; return NO_RUNS.some((r) => r.length === w.length && r.every((x, i) => w[i] === x)); };
const YES_WORDS = new Set(["yes", "yeah", "yep", "yup", "sure", "please", "si", "claro", "correct", "exactly", "ok", "okay"]);

/**
 * registry: createSourceRegistry([...]) — the sources in "auto" order.
 * Remembers, per display, the candidates of a "Which one?" for CHOICE_TTL_MS.
 */
export function createPlayResolver({ registry, timeoutMs = SOURCE_TIMEOUT_MS, now = Date.now }) {
  const asked = new Map();     // deviceId → { at, items: [{ c, s }] }
  const within = (p) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new SourceUnavailable("timeout")), timeoutMs);
    t.unref?.();
    Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
  /** A source's failure: "cannot look right now" is remembered by its code; anything else is a miss. */
  const note = (down, s, err) => { if (err instanceof SourceUnavailable) down.push({ code: err.code, kind: s.kind }); };
  async function playables(s, c, down) {
    try {
      const list = await within(Promise.resolve().then(() => s.queue(c, { limit: 50 })));
      return (Array.isArray(list) ? list : []).filter((p) => p && p.upstream).map((p) => ({ ...p, source: s.kind }));
    } catch (err) { note(down, s, err); return []; }
  }
  const playing = (s, c, list) => ({ outcome: "playing", playables: list, title: cleanTitle(c.title), source: s.kind, candidateId: String(c.id) });
  const live = (id) => { const a = asked.get(id); if (!a) return null; if (now() - a.at >= CHOICE_TTL_MS) { asked.delete(id); return null; } return a; };
  return {
    /** The source kinds that exist right now (crow_play's enumeration). */
    kinds: () => registry.kinds(),
    /**
     * → { outcome: "playing", playables, title, source, candidateId }
     *   | { outcome: "choices", names }                      2 to 4 loose candidates: the first three are offered and remembered
     *   | { outcome: "unavailable", code, source? }          code "none": this instance has nothing to play from;
     *                                                        "unreachable" | "unauthorized" | "timeout": a source could not look
     *   | { outcome: "not_found" }
     * strict: never play a guess (a single loose candidate plays only for the model's call).
     */
    async resolve(what, source = "auto", { strict = false, lang = "en", deviceId = null } = {}) {
      const all = registry.available();
      if (!all.length) return { outcome: "unavailable", code: "none" };
      const has = (kind) => all.some((s) => s.kind === kind);
      const split = splitSource(what);
      // A named source narrows the search; one this instance does not have is just words.
      const want = source && source !== "auto" && has(source) ? source : split.source && has(split.source) ? split.source : null;
      const text = want && want === split.source ? split.what : flat(what).slice(0, 120);
      const order = want ? all.filter((s) => s.kind === want) : all;
      const loose = [], down = [];
      for (const s of order) {
        let found = [];
        try { found = await within(Promise.resolve().then(() => s.search(text, { explicit: !!want, lang }))); } catch (err) { note(down, s, err); continue; }
        found = (Array.isArray(found) ? found : []).filter((c) => c && c.id != null && typeof c.title === "string");
        const sure = found.find((c) => c.confident === true);
        if (sure) { const list = await playables(s, sure, down); if (list.length) { if (deviceId) asked.delete(deviceId); return playing(s, sure, list); } }
        loose.push(...found.filter((c) => c.confident !== true).map((c) => ({ c, s })));
      }
      // A lone loose candidate plays for the model's call; with no model only when it is a same-sound
      // station name and nothing else was found anywhere (F1: "Play KDBF" for the only KTPF).
      // Review M1: a lone candidate the source wants ASKED about ("Did you mean KTPF HD1?") is offered as a one-name
      // choice — with or without a model — and remembered like any "Which one?".
      if (loose.length === 1 && loose[0].c.ask === true) {
        // Re-review R3: answered only by the very next utterance (`once`; see note()).
        if (deviceId) asked.set(deviceId, { at: now(), items: loose.slice(0, 1), once: true, fresh: true });
        return { outcome: "choices", names: [cleanTitle(loose[0].c.title).slice(0, 30)] };
      }
      if (loose.length === 1 && (!strict || loose[0].c.near === true)) { const list = await playables(loose[0].s, loose[0].c, down); if (list.length) { if (deviceId) asked.delete(deviceId); return playing(loose[0].s, loose[0].c, list); } }
      if (loose.length >= 2 && loose.length <= 4) {
        const items = loose.slice(0, MAX_CHOICES);
        if (deviceId) asked.set(deviceId, { at: now(), items });
        return { outcome: "choices", names: items.map((x) => cleanTitle(x.c.title).slice(0, 30)) };
      }
      if (down.length) { const worst = down.slice().sort((a, b) => DOWN_ORDER.indexOf(a.code) - DOWN_ORDER.indexOf(b.code))[0]; return { outcome: "unavailable", code: worst.code, source: worst.kind }; }
      return { outcome: "not_found" };
    },
    /** Was "Which one?" asked on this display a moment ago? */
    pending: (deviceId) => !!live(deviceId),
    /** The names offered then (r7c N1: asked again on a bare "Play."). */
    pendingNames: (deviceId) => (live(deviceId)?.items || []).map((x) => cleanTitle(x.c.title).slice(0, 30)),
    /** The answer to "Which one?": the one offered candidate these words name (each source judges its own). → a "playing" resolution, or null. */
    async choose(deviceId, utterance) {
      const a = live(deviceId);
      if (!a) return null;
      const picks = [];
      // "Did you mean …?" (one name offered): a plain yes takes it.
      const w = spokenWords(String(utterance ?? "").slice(0, 40)) || [];
      if (a.items.length === 1 && w.length && w.length <= 3 && w.every((x) => YES_WORDS.has(x))) picks.push(a.items[0]);
      if (!picks.length) for (const s of new Set(a.items.map((x) => x.s))) {
        let c = null;
        try { c = s.choose(a.items.filter((x) => x.s === s).map((x) => x.c), String(utterance ?? "").slice(0, 120)); } catch { c = null; }
        if (c) picks.push({ c, s });
      }
      if (picks.length !== 1) { if (a.once) asked.delete(deviceId); return null; }   // "Did you mean …?" not taken: it is over
      const list = await playables(picks[0].s, picks[0].c, []);
      if (!list.length) return null;
      asked.delete(deviceId);
      return playing(picks[0].s, picks[0].c, list);
    },
    forget: (deviceId) => { asked.delete(deviceId); },
    /**
     * Every utterance on this display, before anything else reads it (tiers.js). A "Did you mean …?" may be
     * answered by the next utterance only: the one after it finds it gone, even if a model turn ran between.
     */
    note(deviceId) { const a = asked.get(deviceId); if (!a?.once) return; if (a.fresh) a.fresh = false; else asked.delete(deviceId); },
  };
}

/**
 * F8 (smoke 2026-10-06): when playback starts, a display with a screen opens its now-playing window by itself.
 * Rules, in order (the front only on an empty screen):
 *   - only a display that draws the window (caps.kinds has "nowplaying") and reports a screen (caps.screen.w > 0);
 *     an audio-first display keeps the chip only;
 *   - one window, reused: if it is open it is left where it is (never a second one, never pulled to the front);
 *   - it never pushes another window out: with the display's windows full, it does not open (the chip is there);
 *   - it comes to the FRONT only when nothing else is open; otherwise it opens just BEHIND the window in front
 *     (a recipe being cooked from, a card, a timer stay where they are; its tab is in the rail, the chip brings it forward).
 * → wm events for the page ([] when nothing changes).
 */
export function autoNowPlaying({ store, deviceId, caps, title }) {
  if (!Array.isArray(caps?.kinds) || !caps.kinds.includes("nowplaying") || !(Number(caps?.screen?.w) > 0)) return [];
  const open = store.list(deviceId);
  if (open.some((w) => w.kind === "nowplaying")) return [];
  if (open.length >= Math.max(1, Number(caps.max_windows) || 4)) return [];
  const behind = open.length > 0;
  const { window, evicted } = store.put(deviceId, { kind: "nowplaying", title }, { behind });
  return [...evicted.map((e) => ({ type: "wm", action: "close", id: e.id })), { type: "wm", action: "open", window, ...(behind ? { behind: true } : {}) }];
}
/** The chip was tapped (F8): bring the now-playing window to the front, opening it if needed. → wm events, or null when this display cannot draw it. */
export function showNowPlaying({ store, deviceId, caps, title }) {
  if (!Array.isArray(caps?.kinds) || !caps.kinds.includes("nowplaying")) return null;
  const w = store.list(deviceId).find((x) => x.kind === "nowplaying");
  if (w) { store.focus(deviceId, w.id); return [{ type: "wm", action: "focus", id: w.id }]; }
  const { window, evicted } = store.put(deviceId, { kind: "nowplaying", title });
  return [...evicted.map((e) => ({ type: "wm", action: "close", id: e.id })), { type: "wm", action: "open", window }];
}

/** media: the media store; resolver: createPlayResolver(); maxVolume(ctx) → this display's cap. */
export function createMediaVerbs({ media, resolver, maxVolume = () => 100 }) {
  const quiet = (ctx, S) => result(true, "done", ctx.strict ? "" : S.say_done);
  /** A verb that changes nothing in this state: with no model it does not fire; for the model it is a success that says so. */
  const noop = (ctx, say) => (ctx.strict ? null : result(true, "done", say, { effect: false }));
  const nothing = (ctx, S) => (ctx.strict ? null : result(true, "nothing_playing", S.say_nothing_playing, { effect: false }));

  function start(r, ctx, S) {
    const id = ctx.deviceId, max = maxVolume(ctx);
    const line = result(true, "playing", fill(S.say_playing, { title: r.title }), { title: r.title });
    if (media.isCurrent(id, { source: r.source, candidateId: r.candidateId })) {
      // Asked for what is already on: nothing restarts. If it was paused or silent, it is brought back.
      const cur = media.current(id);
      let changed = false;
      // r7 G10: "already playing" must be true where it is heard: the play is sent to the page again (it may be silent).
      if (cur.state === "paused") { media.resume(id); changed = true; } else media.resume(id);
      if (cur.muted) { media.mute(id, false); changed = true; }
      if (cur.volume === 0) { media.volume(id, { delta: VOLUME_STEP }, max); changed = true; }
      return changed ? line : result(true, "playing", fill(S.say_already_playing, { title: r.title }), { title: r.title, effect: false });
    }
    if (!media.play(id, r.playables, { maxVolume: max, origin: { source: r.source, candidateId: r.candidateId } })) return ctx.strict ? null : result(false, "not_found", fill(S.say_play_not_found, { what: r.title.slice(0, 60) }));
    return line;
  }
  async function resolvePlay(i, ctx, S) {
    const id = ctx.deviceId;
    const what = flat(i.what).slice(0, 120);
    // "Which one?" was just asked: these words may be its answer (a bare name with no model, or the model's call with that name).
    if (resolver.pending(id)) {
      // Re-review R3: "No." clears the question and is answered at once.
      if (declines(what)) { resolver.forget(id); return result(true, "done", S.say_okay, { effect: false }); }
      const picked = await resolver.choose(id, what); if (picked) return start(picked, ctx, S);
    }
    if (i.choice === true) return null;                                    // a bare sentence that named none of them: the model gets it
    if (!what) return ctx.strict ? null : result(false, "not_found", S.say_play_what, { effect: false });
    const r = await resolver.resolve(what, i.source || "auto", { strict: ctx.strict === true, lang: ctx.lang, deviceId: id });
    if (r.outcome === "playing") return start(r, ctx, S);
    if (r.outcome === "choices") return result(true, "choices", fill(r.names.length === 1 ? S.say_did_you_mean : S.say_choices, { names: joinNames(r.names, S) }), { names: r.names, effect: false });
    // A source that could not look is a real answer, with or without a model: the model can do no better with it.
    if (r.outcome === "unavailable" && r.code !== "none") return result(false, "unavailable", fill(S[`say_play_${r.code}`] || S.say_play_unreachable, { source: S[`source_${r.source}`] || S.source_music }), { reason: r.code });
    if (ctx.strict) return null;                                           // no model, not sure: the model gets the turn
    return r.outcome === "unavailable" ? result(false, "unavailable", S.say_play_unavailable) : result(false, "not_found", fill(S.say_play_not_found, { what: what.slice(0, 60) }));
  }
  /** The now-playing window, when this display draws that kind. */
  function nowPlayingWindow(ctx, S) {
    if (!Array.isArray(ctx.caps?.kinds) || !ctx.caps.kinds.includes("nowplaying")) return { had: false, events: [], shown: false };
    const had = ctx.store.list(ctx.deviceId).some((w) => w.kind === "nowplaying");
    const { window, evicted } = ctx.store.put(ctx.deviceId, { kind: "nowplaying", title: S.now_playing_title });
    return { had, shown: true, events: [...evicted.map((e) => ({ type: "wm", action: "close", id: e.id })), { type: "wm", action: "open", window }] };
  }
  function openItem(i, ctx, S) {
    if (i.app !== "now_playing") return ctx.strict ? null : result(false, "unavailable", S.say_open_unavailable);
    if (!media.active(ctx.deviceId)) return ctx.strict ? null : result(false, "unavailable", S.say_nothing_playing);
    const w = nowPlayingWindow(ctx, S);
    if (!w.shown) return ctx.strict ? null : result(false, "unavailable", S.say_open_unavailable);
    return result(true, w.had ? "focused" : "opened", fill(S.say_now_playing, { title: media.current(ctx.deviceId).title }), { events: w.events });
  }
  function mediaVerb(i, ctx, S) {
    const id = ctx.deviceId;
    const cur = media.current(id);
    if (!cur) return nothing(ctx, S);
    const max = maxVolume(ctx);
    switch (i.verb) {
      // r7 G9: in the state already, the state is sent to the page again (it may disagree). With no model only the bare
      // word is answered here (quietly) — "Play." once went to the model, which started the news; longer forms
      // ("keep going", "pause the music") stay conversation in that state, as before.
      case "pause": if (cur.state === "paused" && ctx.strict && i.bare !== true) return null; return media.pause(id) === "already" && !ctx.strict ? noop(ctx, S.say_media_paused_already) : quiet(ctx, S);
      case "resume": if (cur.state !== "paused" && ctx.strict && i.bare !== true) return null; return media.resume(id) === "already" && !ctx.strict ? noop(ctx, S.say_media_playing_already) : quiet(ctx, S);
      case "stop": media.stop(id); return quiet(ctx, S);
      // The end of the queue is said aloud even with no model: silence would read as "not heard".
      case "next": case "next_track": return media.next(id) === "end" ? result(true, "done", S.say_no_next, { effect: false }) : quiet(ctx, S);
      case "previous": case "previous_track": return media.previous(id) === "end" ? result(true, "done", S.say_no_previous, { effect: false }) : quiet(ctx, S);
      case "volume_up": if (!cur.muted && cur.volume >= Math.min(100, max)) return result(true, "done", S.say_volume_max, { effect: false }); media.volume(id, { delta: VOLUME_STEP }, max); return quiet(ctx, S);
      case "volume_down": media.volume(id, { delta: -VOLUME_STEP }, max); return quiet(ctx, S);
      case "volume": { const v = Number(i.value); if (!Number.isFinite(v)) return noop(ctx, S.say_done); media.volume(id, { set: v }, max); return quiet(ctx, S); }
      case "mute": if (cur.muted) return noop(ctx, S.say_media_muted_already); media.mute(id, true); return quiet(ctx, S);
      case "unmute": if (!cur.muted) return noop(ctx, S.say_media_unmuted_already); media.mute(id, false); return quiet(ctx, S);
      // The answer IS the sentence: it is always spoken (effect false), whatever the model said first.
      case "now_playing": { const w = nowPlayingWindow(ctx, S); return result(true, "done", fill(S.say_now_playing, { title: cur.title }), { events: w.events, effect: false }); }
      default: return nothing(ctx, S);
    }
  }
  /**
   * the rev 7c operator ruling (N1): while a choice is pending, a bare "Play." is its answer — one suggested station
   * ("Did you mean …?") is a yes and plays at once; several are asked again by name.
   */
  async function answerPending(ctx, S) {
    const id = ctx.deviceId;
    const names = resolver.pendingNames(id);
    if (names.length === 1) { const picked = await resolver.choose(id, "yes"); if (picked) return start(picked, ctx, S); return null; }
    if (names.length > 1) return result(true, "choices", fill(S.say_choices, { names: joinNames(names, S) }), { names, effect: false });
    return null;
  }
  return { resolvePlay, openItem, mediaVerb, answerPending, pendingChoices: (deviceId) => resolver.pending(deviceId), noteUtterance: (deviceId) => resolver.note?.(deviceId) };
}
