/**
 * Station presets: an operator list (name, spoken aliases, stream address), edited in the Kiosk
 * panel and kept in a setting of this instance only (it is never synced to paired instances).
 * A source adapter, contract 1 (./index.js). Search is a name lookup, never a network call.
 * The repo ships no preset. A station is a PUBLIC stream (every hop public) unless the operator
 * ticked "home network" for it (spec §13.4): then its own host:port may be a home-network or
 * tailnet address (relay.js localHop), never loopback, link-local, a container bridge or the gateway
 * itself; the addresses its host resolved to when it was saved are recorded (`addrs`), and a play must
 * resolve inside that set ("address changed: test and save it again" otherwise). Only the
 * operator's panel (dashboard session + CSRF) writes stations; the model never supplies an address.
 *
 * Names are compared in ONE canonical form (stationKey), because speech-to-text writes a station
 * like "WXYZ HD2" many ways: "w x y z h d two", "WXYZ HD 2", "wxyz hd too".
 */
import { spokenWords, matchT0 } from "../phrases.js";
import { transportWords } from "../patterns.js";
import { isIP } from "node:net";
import { publicHop, localHop, isPrivateAddress, isLocalStreamAddress, normAddress } from "../relay.js";
import { SOURCE_CONTRACT } from "./index.js";
import { soundKeys, bestDistance, consonants } from "./sound-key.js";

export const STATIONS_SETTING = "kiosk_stations";
export const MAX_STATIONS = 50;
const FILLER = new Set(["radio", "station", "the", "la", "el", "emisora", "estacion", "channel", "fm", "am"]);
const DROP = new Set(["point", "punto", "dot"]);
const NUMBERS = Object.freeze({ zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100",
  cero: "0", uno: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9", diez: "10" });
/**
 * What speech-to-text writes for a digit: "WXYZ too", "HD to", "HD won". A homophone counts as its
 * digit only straight after "hd" or as the LAST word after a name ("going to the store" keeps its "to").
 * Both sides of a comparison go through the same rule, so it cannot make two different names equal
 * that were not already said the same way.
 */
const HOMOPHONES = Object.freeze({ to: "2", too: "2", won: "1", for: "4", ate: "8" });
const isLetter = (w) => w.length === 1 && w >= "a" && w <= "z";
const isDigit = (ch) => ch >= "0" && ch <= "9";

/** The canonical words of a station name, an alias, or what was said. "" when there is nothing usable. */
export function stationKey(text) {
  const raw = spokenWords(String(text ?? ""));          // null for empty or over-long input: capped before anything else reads it
  if (!raw) return "";
  const words = [];
  // 1. Spelled-out letters are one word: "w x y z" → "wxyz", "h d" → "hd". A lone letter stays.
  for (let i = 0; i < raw.length;) {
    let j = i;
    while (j < raw.length && isLetter(raw[j])) j++;
    if (j - i >= 2) { words.push(raw.slice(i, j).join("")); i = j; } else { words.push(raw[i]); i++; }
  }
  // 2. A letters-then-digits word is two words: "hd1" → "hd", "1". ("90" and "live" are left alone.)
  const split = [];
  for (const w of words) {
    let cut = 0;
    while (cut < w.length && !isDigit(w[cut])) cut++;
    let digits = cut > 0 && cut < w.length;
    for (let k = cut; digits && k < w.length; k++) if (!isDigit(w[k])) digits = false;
    if (digits) split.push(w.slice(0, cut), w.slice(cut)); else split.push(w);
  }
  // 3. Number words are digits; a homophone is one after "hd" or at the end. 4. "point" and filler words go.
  const out = [];
  split.forEach((w, i) => {
    const prev = out[out.length - 1];
    const homophone = Object.hasOwn(HOMOPHONES, w) && (prev === "hd" || (i === split.length - 1 && out.length > 0));
    const n = Object.hasOwn(NUMBERS, w) ? NUMBERS[w] : homophone ? HOMOPHONES[w] : null;
    if (n !== null) out.push(n);
    else if (!DROP.has(w) && !FILLER.has(w)) out.push(w);
  });
  return out.join(" ");
}
const compact = (key) => key.split(" ").join("");

const text = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const slug = (s) => (spokenWords(s.slice(0, 80)) || []).join("_").slice(0, 32) || "station";

/** Is this name a control phrase or a playback word on its own? */
const isCommand = (n) => matchT0(n) !== null || transportWords(n) !== null;

/** Operator input → the stored list. Anything invalid is dropped, never repaired into something else. */
export function normalizeStations(raw) {
  const out = [], ids = new Set();
  for (const s of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_STATIONS) break;
    const name = text(s?.name, 60);
    let u = null;
    try { u = new URL(text(s?.url, 500)); } catch { u = null; }
    // http(s), no credentials in the address, a host the relay could ever fetch (so not a private address written out).
    // Review L2: a name or spoken name that is itself a command ("Stop", "Pause", "Louder") could act through T0 if
    // speech-to-text echoes the prompt on near-silence: such a name is refused, such a spoken name dropped.
    if (!name || isCommand(name) || !u || !publicHop(u.href).origin) continue;
    const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
    const local = s?.local === true;
    // A private address written out is a station only with the tick, and only in the home-network/tailnet ranges.
    if (isIP(host) && isPrivateAddress(host) && !(local && isLocalStreamAddress(host))) continue;
    let id = `st_${slug(name)}`;
    for (let n = 2; ids.has(id); n++) id = `st_${slug(name)}_${n}`;
    ids.add(id);
    // The recorded address set: the literal itself, or what the save-time check resolved (runtime.js). Up to 16 addresses.
    const addrs = !local ? [] : isIP(host) ? [normAddress(host)] : (Array.isArray(s.addrs) ? s.addrs : []).map((a) => normAddress(String(a).slice(0, 64))).filter((a) => isIP(a)).slice(0, 16);
    out.push({ id, name, aliases: (Array.isArray(s.aliases) ? s.aliases : []).map((a) => text(a, 40)).filter((a) => a && !isCommand(a)).slice(0, 5), url: u.href, ...(local ? { local: true, addrs } : {}) });
  }
  return out;
}
/** The stored setting (a JSON string, or nothing) → the list. Never throws. */
export function parseStations(value) {
  try { return normalizeStations(JSON.parse(String(value || "[]"))); } catch { return []; }
}
/** A station's upstream and the relay's policy for it: public on every hop, or the local-stream policy when ticked. Never a credential. */
export const stationUpstream = (s) => ({ url: s.url, hop: s.local === true ? localHop(s.url, s.addrs) : publicHop(s.url) });

const SOUND_MEMO = new Map();
/** A station key's sound keys, whole and by word prefix ("ktpf hd 2" → whole: KTPFJT2…, prefixes: KTPF, KTPFJT…). Memoised (bounded). */
function soundsOf(key) {
  let v = SOUND_MEMO.get(key);
  if (v) return v;
  const w = key.split(" ");
  const pre = [];
  for (let n = 1; n < w.length; n += 1) pre.push(...soundKeys(w.slice(0, n).join(" ")));
  v = { whole: soundKeys(key), pre: [...new Set(pre)] };
  if (SOUND_MEMO.size > 2000) SOUND_MEMO.clear();
  SOUND_MEMO.set(key, v);
  return v;
}
/**
 * Stations by sound (F1). → [{ s, near?, ask? }], at most 4 (`ask`: one station, to be asked about — "Did you mean …?"):
 *   one station whose name, alias or a word-start of one SOUNDS the same → [{ s, near: true }];
 *   two to four that sound the same → all of them (the resolver asks "Which one?");
 *   none the same, and the request named the radio ("… on the radio"): one a single sound away (four
 *   consonant sounds or more said) → [{ s, near: false }]; two to four → all of them; anything else → [].
 *   (Without the radio named, a single sound away is not offered: "Play Candy Puff" is not KTPF.)
 * A name with fewer than three consonant sounds is never matched this way (too little to go on).
 */
export function soundSearch(stations, q, { explicit = false } = {}) {
  const qs = soundKeys(q).filter((k) => consonants(k) >= 3);
  if (!qs.length) return [];
  const scored = stations.map((s) => {
    const ks = [s.name, ...s.aliases].map(stationKey).filter(Boolean).map(soundsOf);
    const whole = ks.flatMap((k) => k.whole), pre = ks.flatMap((k) => k.pre);
    return { s, exact: bestDistance(qs, whole, 2), pre: bestDistance(qs, pre, 0) };
  });
  // Review M1: one station that sounds the same plays with no model only when the words look like a call sign;
  // ordinary words that happen to sound like one ("Keep the Faith", "cup of tea") are asked about instead.
  const shaped = callSignShaped(q);
  const pick = (list, same) => (list.length >= 1 && list.length <= 4
    ? list.map((x) => (list.length === 1 ? (same && shaped ? { s: x.s, near: true } : { s: x.s, ask: true }) : { s: x.s })) : []);
  const same = scored.filter((x) => x.exact === 0);
  if (same.length) return pick(same, true);
  const samePre = scored.filter((x) => x.pre === 0);
  if (samePre.length) return pick(samePre, true);
  if (!explicit || Math.max(...qs.map(consonants)) < 4) return [];
  return pick(scored.filter((x) => x.exact === 1), false);
}
/** A letter's name as speech-to-text writes it ("kay pee eff tee"). */
const LETTER_NAMES = new Set(["kay", "cue", "pee", "bee", "dee", "tee", "gee", "jay", "eff", "ef", "el", "em", "en", "ar", "ess", "vee", "ex", "zee", "aitch", "why", "double"]);
/**
 * Does a station key look like a call sign as STT writes one: a word with no vowel ("kdbf", "pf"), a letter's
 * name ("kay"), or one short word ("capefti")? "hd" and digits are left out of the judgement.
 */
export function callSignShaped(key) {
  const w = String(key || "").split(" ").filter((x) => x && x !== "hd" && !/^\d+$/.test(x));
  if (!w.length) return false;
  if (w.some((x) => x.length >= 2 && /^[a-z]+$/.test(x) && !/[aeiouy]/.test(x))) return true;
  if (w.some((x) => LETTER_NAMES.has(x))) return true;
  return w.length === 1 && w[0].length <= 7;
}

/** list(): Station[] — the instance's presets as they are now (the runtime keeps them in memory). */
export function createStationsSource({ list }) {
  const all = () => { try { const l = list(); return Array.isArray(l) ? l : []; } catch { return []; } };
  const cand = (s, confident) => ({ id: s.id, kind: "station", title: s.name, confident });
  const keys = (s) => [s.name, ...s.aliases].map(stationKey).filter(Boolean);
  const exactOf = (stations, q) => { const qc = compact(q); return stations.filter((s) => keys(s).some((k) => compact(k) === qc)); };
  const prefixOf = (stations, q) => stations.filter((s) => keys(s).some((k) => k.startsWith(`${q} `)));
  const playable = (s) => ({ kind: "station", id: s.id, title: s.name, subtitle: "", form: "audio", codec: "", source: "radio", upstream: stationUpstream(s) });
  const find = (c) => { const s = all().find((x) => x.id === c?.id); if (!s) throw new Error("station gone"); return s; };
  return {
    kind: "radio",
    contract: SOURCE_CONTRACT,
    available: () => all().length > 0,
    /**
     * An exact name or alias (the same letters and digits, however they were spaced) is confident.
     * A unique prefix on a word boundary is confident only when the request named the radio: in an
     * "auto" search it is a guess, and another source may have the real thing under that name.
     * explicit with no station name left ("play the radio"): the one station plays, or up to four are offered.
     */
    search(what, { explicit = false } = {}) {
      const stations = all();
      const q = stationKey(what);
      if (!q) return explicit ? (stations.length === 1 ? [cand(stations[0], true)] : stations.slice(0, 4).map((s) => cand(s, false))) : [];
      const exact = exactOf(stations, q);
      if (exact.length === 1) return [cand(exact[0], true)];
      if (exact.length > 1) return exact.slice(0, 4).map((s) => cand(s, false));
      const pre = prefixOf(stations, q);
      if (pre.length === 1) return [cand(pre[0], explicit === true)];
      if (pre.length) return pre.length <= 4 ? pre.map((s) => cand(s, false)) : [];
      // Nothing by its written form: how it SOUNDS (smoke 2026-10-06 F1). Never confident by itself:
      // a lone same-sound hit is `near` (the resolver may play it with no model only when no source has
      // anything else); two stations that sound alike are offered, never guessed between.
      return soundSearch(stations, q, { explicit }).map(({ s, near, ask }) => ({ ...cand(s, false), ...(near ? { near: true } : {}), ...(ask ? { ask: true } : {}) }));
    },
    resolve: (c) => playable(find(c)),
    queue: (c) => [playable(find(c))],
    /** After "Which one?": the words name exactly one of the offered stations — its name or an alias, else the start of one, else the end of one ("HD two" of "WXYZ HD2"). */
    choose(candidates, utterance) {
      const q = stationKey(utterance);
      if (!q) return null;
      const offered = (Array.isArray(candidates) ? candidates : []).slice(0, 8);
      const stations = all().filter((s) => offered.some((c) => c.id === s.id));
      let hit = exactOf(stations, q);
      if (!hit.length) hit = prefixOf(stations, q);
      if (!hit.length) hit = stations.filter((s) => keys(s).some((k) => k.endsWith(` ${q}`)));
      // By sound, among the offered ones only, and only a same-sound hit ("KDBF two" for "KTPF HD2").
      if (!hit.length) hit = soundSearch(stations, q).filter((x) => x.near).map((x) => x.s);
      return hit.length === 1 ? offered.find((c) => c.id === hit[0].id) || null : null;
    },
  };
}

/**
 * The STT prompt bias for a display (F1): the station names and their aliases, as written by the
 * operator, comma separated, each once. The voice turn bounds it (turn.js sttPromptText).
 */
export function stationNamesHint(stations) {
  const seen = new Set(), out = [];
  for (const s of Array.isArray(stations) ? stations : []) for (const n of [s?.name, ...(Array.isArray(s?.aliases) ? s.aliases : [])]) {
    const t = text(n, 60);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out.join(", ");
}

/** The panel's "Test": does this address answer with an audio stream? relay: createRelay() (it reads the response headers only). */
export async function probeStation({ url, local = false }, relay) {
  let u = null;
  try { u = new URL(text(url, 500)); } catch { u = null; }
  if (!u || !publicHop(u.href).origin) return { ok: false, error: "bad_url" };
  // The same check the save makes, before any request: a private address written out needs the tick and an allowed range.
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (isIP(host) && isPrivateAddress(host) && !(local === true && isLocalStreamAddress(host))) return { ok: false, error: "private_address" };
  if (local !== true) return relay.probe(stationUpstream({ url: u.href }));
  // Ticked: the home-network rule on every address the host resolves to (no request yet), then a probe pinned to that set.
  const c = await relay.checkLocal(u.href);
  if (!c.ok) return { ok: false, error: c.error };
  return relay.probe(stationUpstream({ url: u.href, local: true, addrs: c.addrs }));
}
