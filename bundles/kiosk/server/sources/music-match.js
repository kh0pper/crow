/**
 * Matching a spoken request against the names in a music library: albums (with their artists),
 * artists, genres, playlists, and track titles the caller found live.
 *
 * PURE: no I/O, no clock, no state. The caller builds an index from plain lists (buildIndex),
 * reads the request (readRequest) and asks for a decision (decide). When the decision depends on
 * something only the server knows — track titles, or which albums carry a track by an artist —
 * decide() answers { need } and the caller runs it again with that data in `live`.
 *
 * Every comparison is made on FOLDED text, folded the same way on both sides: nothing is ever
 * removed from one side only. No regular expression is built from data; every phrase and name is
 * cut to TEXT_MAX characters and WORDS_MAX words before anything reads it.
 *
 * The rules (the private engineering notes hold the reasons and the library counts behind them):
 *   1. A kind cue ("the album …", "… playlist") limits the lookup to that kind. A genre cue
 *      ("some …", "… music") with an exact genre plays the genre; with nothing else it shuffles
 *      the library.
 *   2. The whole phrase is tried first. Only when it has no exact hit is it split at the last
 *      "by" / "de" / "por", and only if the words after it are an artist. "Ladder by Ladder"
 *      stays a title.
 *   3. One exact hit: play it.
 *   4. Exact hits of different kinds: playlist, then artist, then album, then track, then genre.
 *   5. Several exact albums with one title: with an artist clause keep that artist's; if every
 *      one has one or two tracks they are one compilation split by artist — play the union as one
 *      album (FRAGMENTS); if one has at least three times the tracks of the next, play it
 *      (DOMINANT); otherwise ask, with up to four choices named by artist.
 *   6. No exact hit: one contained hit plays; several ask (albums, artists and playlists only).
 *   7. Still nothing: an exact track title plays the track; several follow rule 5's artist
 *      clause, else ask.
 *   8. Nothing: no candidates. (A server that could not be asked is the adapter's error, never this.)
 */

/** Characters of any phrase or name that are read. The same cap on both sides of a comparison. */
export const TEXT_MAX = 200;
/** Words of any phrase or name that are compared. */
export const WORDS_MAX = 24;
export const CHOICES_MAX = 4;
/** Albums one merged compilation may hold. */
export const GROUP_MAX = 100;
const LIST_MAX = { albums: 50_000, artists: 50_000, genres: 5_000, playlists: 1_000, tracks: 200 };
const TITLE_MAX = 80;

// Letters that Unicode does not decompose into a base letter plus a mark.
const LETTERS = Object.freeze({ "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe", "đ": "d", "ð": "d", "ł": "l", "þ": "th", "ı": "i" });
const text = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

// ── spoken forms: how speech-to-text writes a name and how the library stores it meet ──
const UNITS = Object.freeze({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 });
const TEENS = Object.freeze({ ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 });
const TENS = Object.freeze({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const ORD_WORDS = Object.freeze({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20 });
/** One spelling for the short forms that names use either way. */
const SHORT = Object.freeze({ saint: "st", doctor: "dr", volume: "vol", mister: "mr", versus: "vs", mount: "mt" });
const isNum = (x) => Object.hasOwn(UNITS, x) || Object.hasOwn(TEENS, x) || Object.hasOwn(TENS, x) || Object.hasOwn(ORD_WORDS, x) || x === "hundred" || x === "thousand" || x === "million";
/**
 * A run of number words → digits. "nineteen ninety nine" → 1999 (a year read in pairs), "twenty
 * twenty" → 2020, "two thousand and five" → 2005, "twenty first" → 21, "seven" → 7. Bounded: the
 * caller hands at most WORDS_MAX words.
 */
function numberRun(run) {
  if (run.some((x) => x === "hundred" || x === "thousand" || x === "million")) {
    let total = 0, part = 0;
    for (const x of run) {
      if (x === "and") continue;
      if (x === "hundred") part = (part || 1) * 100;
      else if (x === "million") { total = (total + (part || 1)) * 1_000_000; part = 0; }
      else if (x === "thousand") { total += (part || 1) * 1000; part = 0; }
      else part += UNITS[x] ?? TEENS[x] ?? TENS[x] ?? ORD_WORDS[x] ?? 0;
    }
    return String(total + part);
  }
  // Pairs: a tens word takes a following unit or ordinal ("ninety nine", "twenty first"); "oh" or
  // "zero" before a unit is one two-digit pair ("nineteen oh five" → 19 05).
  const groups = [];
  for (let i = 0; i < run.length; i += 1) {
    const x = run[i], y = run[i + 1];
    const unitNext = y !== undefined && y !== "zero" && y !== "oh" && (Object.hasOwn(UNITS, y) || (Object.hasOwn(ORD_WORDS, y) && ORD_WORDS[y] < 10));
    if (Object.hasOwn(TENS, x) && unitNext) { groups.push(TENS[x] + (UNITS[y] ?? ORD_WORDS[y])); i += 1; }
    else if ((x === "oh" || x === "zero") && unitNext && groups.length) { groups.push(`0${UNITS[y] ?? ORD_WORDS[y]}`); i += 1; }
    else groups.push(UNITS[x] ?? TEENS[x] ?? TENS[x] ?? ORD_WORDS[x]);
  }
  // Two or more groups whose first is ten or more read as a year or a code: "19" "99" → 1999.
  return groups.map((g, i) => (typeof g === "string" ? g : i > 0 && groups[0] >= 10 && g < 10 ? `0${g}` : String(g))).join("");
}
/**
 * r7 (re-smoke R6-12): a run of three or more single letters is a name spelled out ("d n q", "a n r"): its letters are kept
 * as they are (an "n" in it is not "and", an "r b" in it is not the genre) — "r n b" alone is still R&B.
 */
function spelledRuns(words) {
  const keep = new Array(words.length).fill(false);
  for (let i = 0; i < words.length;) {
    let j = i;
    while (j < words.length && /^[a-z]$/.test(words[j])) j += 1;
    if (j - i >= 3 && !(j - i === 3 && words[i] === "r" && words[i + 1] === "n" && words[i + 2] === "b")) for (let k = i; k < j; k += 1) keep[k] = true;
    i = j > i ? j : i + 1;
  }
  return keep;
}
function canon(words) {
  const out = [];
  const spelled = spelledRuns(words);
  for (let i = 0; i < words.length; i += 1) {
    const x = words[i];
    if (spelled[i]) { out.push(x); continue; }
    if (x === "rb") { out.push("rnb"); continue; }
    // "r and b", "r n b", "r b" → rnb; "rock n roll" → rock and roll.
    if (x === "r" && (words[i + 1] === "and" || words[i + 1] === "n") && words[i + 2] === "b") { out.push("rnb"); i += 2; continue; }
    if (x === "r" && words[i + 1] === "b") { out.push("rnb"); i += 1; continue; }
    if (x === "n" && out.length && i + 1 < words.length) { out.push("and"); continue; }
    if (Object.hasOwn(SHORT, x)) { out.push(SHORT[x]); continue; }
    const ord = /^(\d{1,4})(st|nd|rd|th)$/.exec(x);
    if (ord) { out.push(ord[1]); continue; }
    if (isNum(x) && x !== "hundred" && x !== "thousand" && x !== "million") {
      let j = i;
      // An ordinal ends a run ("the first one" is 1 then 1, never 11).
      // "oh" is a digit only inside a run, before a unit ("nineteen oh five"); "Oh Darling" keeps its word.
      const ohDigit = (k) => words[k] === "oh" && k > i && Object.hasOwn(UNITS, words[k + 1] ?? "");
      while (j < words.length && !(j > i && Object.hasOwn(ORD_WORDS, words[j - 1])) && (isNum(words[j]) || ohDigit(j) || (words[j] === "and" && j + 1 < words.length && isNum(words[j + 1]) && words.slice(i, j).some((y) => y === "hundred" || y === "thousand" || y === "million")))) j += 1;
      out.push(numberRun(words.slice(i, j)));
      i = j - 1;
      continue;
    }
    out.push(x);
  }
  return out;
}

/**
 * Decompose, drop the marks, lower case, "&" → "and", apostrophes removed ("don't" and "dont"
 * meet), everything else that is not a letter or a digit → one space; then the spoken forms meet
 * the written ones (numbers as digits, ordinals, saint/st, doctor/dr, volume/vol, r and b).
 * Applied to BOTH sides of every comparison.
 */
export function fold(s) {
  // r7: a thousands separator joins its digits ("10,000" is 10000, as "ten thousand" folds).
  const f = text(s).slice(0, TEXT_MAX).replace(/(\d),(?=\d{3}(?!\d))/g, "$1").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[øßæœđðłþı]/g, (ch) => LETTERS[ch]).replace(/&/g, " and ").replace(/['’‘`´ʼ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return f ? canon(f.split(" ")).join(" ") : "";
}
/** fold() with the spaces removed: how genres are compared ("hip hop" is the tag HipHop). */
export const compact = (s) => fold(s).split(" ").join("");
/** The folded words of a phrase or a name. */
export function wordsOf(s) {
  const f = fold(s);
  return f ? f.split(" ").slice(0, WORDS_MAX) : [];
}
/** A name for a person to read or hear: no control characters, one line, at most 80 characters. */
export function cleanName(s) {
  return text(s).slice(0, TEXT_MAX * 2).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
}

const ARTICLES = new Set(["the", "a", "an", "el", "la", "los", "las"]);
/** Without a leading article (one word always stays). */
const dropArticle = (w) => (w.length > 1 && ARTICLES.has(w[0]) ? w.slice(1) : w);
const sameWords = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** Tier E on word lists: equal, also with a leading article dropped from either side. */
function exactWords(a, b) {
  if (!a.length || !b.length) return false;
  return sameWords(a, b) || sameWords(dropArticle(a), b) || sameWords(a, dropArticle(b)) || sameWords(dropArticle(a), dropArticle(b));
}
/** Tier P on word lists: every word of the phrase is a whole word of the name, and the name has at most three more. */
function containedWords(phrase, name) {
  const extra = name.length - phrase.length;
  if (!phrase.length || extra < 0 || extra > 3) return false;
  const left = name.slice();
  for (const x of phrase) {
    const i = left.indexOf(x);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

// ── the index ────────────────────────────────────────────────────────────────────────────────────
const ID = /^[A-Za-z0-9_.~-]{1,64}$/;
const idOf = (v) => { const s = text(v); return ID.test(s) ? s : null; };
const count = (v) => (Number.isInteger(v) && v > 0 ? Math.min(v, 100_000) : 0);

/**
 * lists: { albums: [{ id, title, artist, artistId, tracks, year }], artists: [{ id, name }],
 *          genres: [{ name }], playlists: [{ id, name }] } — plain data from the library.
 * Album artists count as artists, so an artist listing that has not finished loses nothing that
 * has an album. → an index for decide(), choose() and matchReport().
 */
export function buildIndex({ albums = [], artists = [], genres = [], playlists = [] } = {}) {
  const ix = { albums: [], artists: [], genres: [], playlists: [], exact: new Map(), genre: new Map(), joined: new Map() };
  const put = (map, key, e) => { const l = map.get(key); if (l) l.push(e); else map.set(key, [e]); };
  const add = (list, e) => {
    list.push(e);
    put(ix.exact, e.f, e);
    const fa = dropArticle(e.w).join(" ");
    if (fa !== e.f) put(ix.exact, fa, e);
    // Spaces aside ("ac dq", "a c d q" and "AC/DQ" meet). Looked up for four letters or more, or for a name
    // SPELLED letter by letter ("x q z" for XQZ: F7, revision 6), so every name of two or more is kept.
    const j = e.w.join("");
    if (j.length >= 2) put(ix.joined, j, e);
  };
  const named = (kind, id, name) => {
    const w = wordsOf(name);
    return id && w.length ? { kind, id, name: cleanName(name), w, f: w.join(" ") } : null;
  };
  const seenArtist = new Set();
  const addArtist = (id, name) => {
    const e = named("artist", idOf(id), name);
    if (!e || seenArtist.has(e.id)) return;
    seenArtist.add(e.id);
    add(ix.artists, e);
  };
  for (const a of (Array.isArray(albums) ? albums : []).slice(0, LIST_MAX.albums)) {
    const e = named("album", idOf(a?.id), a?.title);
    if (!e) continue;
    e.artist = cleanName(a.artist);
    e.aw = wordsOf(a.artist);
    e.artistId = idOf(a.artistId);
    e.tracks = count(a.tracks);
    e.year = Number.isInteger(a.year) ? a.year : null;
    add(ix.albums, e);
    if (e.artistId) addArtist(e.artistId, a.artist);
  }
  for (const a of (Array.isArray(artists) ? artists : []).slice(0, LIST_MAX.artists)) addArtist(a?.id, a?.name);
  for (const p of (Array.isArray(playlists) ? playlists : []).slice(0, LIST_MAX.playlists)) { const e = named("playlist", idOf(p?.id), p?.name); if (e) add(ix.playlists, e); }
  for (const g of (Array.isArray(genres) ? genres : []).slice(0, LIST_MAX.genres)) {
    const w = wordsOf(g?.name);
    const key = w.join("");
    // A genre's id is its compact name: the exact tag name stays in `name`.
    if (!key || key.length > 64) continue;
    const e = { kind: "genre", id: key, name: cleanName(g.name), w, f: w.join(" ") };
    ix.genres.push(e);
    put(ix.genre, key, e);
  }
  return ix;
}

const ALL = Object.freeze(["playlist", "artist", "album", "genre"]);
const listOf = (ix, kind) => (kind === "album" ? ix.albums : kind === "artist" ? ix.artists : kind === "playlist" ? ix.playlists : kind === "genre" ? ix.genres : []);

/** Tier E in the index. Genres by compact form, everything else by folded name. */
function exact(ix, w, kinds) {
  if (!w.length) return [];
  const out = new Set();
  const bare = dropArticle(w);
  for (const key of new Set([w.join(" "), bare.join(" ")])) for (const e of ix.exact.get(key) || []) if (kinds.includes(e.kind)) out.add(e);
  const spelled = w.length >= 2 && w.every((x) => x.length === 1);
  if (!out.size && (w.join("").length >= 4 || spelled)) for (const e of ix.joined?.get(w.join("")) || []) if (kinds.includes(e.kind)) out.add(e);
  if (kinds.includes("genre")) for (const key of new Set([w.join(""), bare.join("")])) for (const e of ix.genre.get(key) || []) out.add(e);
  return [...out];
}
/** Tier P in the index. A phrase made only of articles contains nothing worth offering. */
function contained(ix, w, kinds) {
  if (!w.length || w.every((x) => ARTICLES.has(x))) return [];
  const out = [];
  for (const kind of kinds) for (const e of listOf(ix, kind)) if (containedWords(w, e.w)) out.push(e);
  return out;
}

// ── reading the request ──────────────────────────────────────────────────────────────────────────
const KIND_CUES = Object.freeze({ album: "album", record: "album", disco: "album", song: "track", track: "track", cancion: "track",
  artist: "artist", band: "artist", artista: "artist", playlist: "playlist", lista: "playlist" });
const isKindCue = (x) => Object.hasOwn(KIND_CUES, x);
const CUE_LEADS = new Set(["the", "a", "an", "my", "our", "el", "la", "los", "las", "mi", "un", "una"]);
const OWN_LEADS = new Set(["my", "our", "mi"]);
const CLAUSE = new Set(["by", "de", "por"]);
/** A head that names nothing ("something by …", "música de …"): the artist is the request. */
const HEAD_FILLERS = new Set(["something", "anything", "songs", "stuff", "everything", "canciones", "todo"]);

/**
 * Cue words, removed only for the lookup they trigger (the whole phrase is always compared too).
 * → { core, kind, genreCue }.
 */
function stripCues(w) {
  let a = 0, b = w.length, genreCue = false, kind = null;
  // Genre cues: some …, any …, algo de …, música (de) …, … music.
  for (;;) {
    if (a < b && (w[a] === "some" || w[a] === "any")) { a += 1; genreCue = true; continue; }
    if (a < b && (w[a] === "algo" || w[a] === "musica") && (a + 1 === b || w[a + 1] === "de")) { a += a + 1 === b ? 1 : 2; genreCue = true; continue; }
    if (a < b && (w[a] === "music" || w[a] === "musica")) { a += 1; genreCue = true; continue; }
    if (b > a && (w[b - 1] === "music" || w[b - 1] === "musica")) { b -= 1; genreCue = true; continue; }
    break;
  }
  if (genreCue) return { core: w.slice(a, b), kind: null, genreCue: true };
  // Kind cues: "(the) album …" or "… album".
  const lead = b - a > 1 && CUE_LEADS.has(w[a]) && isKindCue(w[a + 1]) ? 1 : 0;
  if (isKindCue(w[a + lead])) { kind = KIND_CUES[w[a + lead]]; a += lead + 1; }
  else if (b - a > 1 && isKindCue(w[b - 1])) {
    kind = KIND_CUES[w[b - 1]];
    b -= 1;
    if (b - a > 1 && OWN_LEADS.has(w[a])) a += 1;      // "my dinner playlist"
  }
  return { core: w.slice(a, b), kind, genreCue: false };
}

/**
 * what: the words after "play", as heard. → { raw, words, core, kind, genreCue, split }.
 * split = { head, kind, artist } when the phrase has a "by" / "de" / "por" with words after it:
 * the LAST one. Whether it is used is decide()'s rule 2.
 */
export function readRequest(what) {
  const raw = typeof what === "string" ? what.slice(0, TEXT_MAX).replace(/\s+/g, " ").trim() : "";
  const words = wordsOf(raw);
  const { core, kind, genreCue } = stripCues(words);
  let split = null;
  let at = -1;
  for (let i = words.length - 2; i >= 0; i -= 1) if (CLAUSE.has(words[i])) { at = i; break; }
  if (at >= 0) {
    const h = stripCues(words.slice(0, at));
    const head = h.core.every((x) => HEAD_FILLERS.has(x)) ? [] : h.core;
    split = { head, kind: h.kind, artist: words.slice(at + 1) };
  }
  return { raw, words, core, kind, genreCue, split };
}

/** The live track searches a request may need: as spoken and, when different, as folded; then the cue-less and head forms. At most four. */
export function trackQueries(req) {
  const out = [];
  const add = (q) => { const s = String(q || "").trim(); if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s); };
  add(req.raw);
  add(req.words.join(" "));
  if (req.kind || req.genreCue) add(req.core.join(" "));
  if (req.split) add(req.split.head.join(" "));
  return out.slice(0, 4);
}

// ── candidates ───────────────────────────────────────────────────────────────────────────────────
const albumCand = (e, confident) => ({ id: `music:album:${e.id}`, kind: "album", title: e.name, subtitle: e.artist || "", confident });
const mergedCand = (group) => {
  const ids = group.map((e) => e.id).slice(0, GROUP_MAX);
  return { id: `music:album:${ids[0]}`, kind: "album", title: group[0].name, subtitle: "", confident: true, group: ids };
};
/** Artists whose names fold to the same words are one artist to a listener: their tracks are played together. */
const artistCand = (list, confident) => ({ id: `music:artist:${list[0].id}`, kind: "artist", title: list[0].name, subtitle: "", confident,
  ...(list.length > 1 ? { group: list.map((e) => e.id).slice(0, CHOICES_MAX) } : {}) });
const playlistCand = (e, confident) => ({ id: `music:playlist:${e.id}`, kind: "playlist", title: e.name, subtitle: "", confident });
const genreCand = (e, confident) => ({ id: `music:genre:${e.id}`, kind: "genre", title: e.name, subtitle: "", confident });
const trackCand = (t, confident) => ({ id: `music:track:${t.id}`, kind: "track", title: t.name, subtitle: t.artist || "", confident });
/** "Play some music": the whole library, shuffled. */
export const libraryCandidate = (lang) => ({ id: "music:library:all", kind: "library", title: lang === "es" ? "música" : "music", subtitle: "", confident: true });
const candOf = (e, confident) => (e.kind === "album" ? albumCand(e, confident) : e.kind === "artist" ? artistCand([e], confident) : e.kind === "playlist" ? playlistCand(e, confident) : genreCand(e, confident));

const NONE = Object.freeze({ candidates: [] });
const play = (c) => ({ candidates: [c] });
const ask = (list) => ({ candidates: list.slice(0, CHOICES_MAX) });
const byId = (a, b) => (a.id.length - b.id.length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const bySize = (a, b) => (b.tracks - a.tracks) || byId(a, b);
/** One entry per artist: the largest. Two albums of one title by one artist cannot be told apart by voice. */
function onePerArtist(list, keyOf) {
  const seen = new Set(), out = [];
  for (const e of list) { const k = keyOf(e); if (seen.has(k)) continue; seen.add(k); out.push(e); }
  return out;
}

/** Rule 5: albums that share one title. */
function settleAlbums(group) {
  if (group.length === 1) return play(albumCand(group[0], true));
  const sorted = [...group].sort(bySize);
  // FRAGMENTS: every album has one or two tracks — one compilation, split by artist at import.
  if (sorted.every((a) => a.tracks === 1 || a.tracks === 2)) return play(mergedCand([...group].sort(byId)));
  // DOMINANT: one album has at least three times the tracks of the next.
  if (sorted[0].tracks > 0 && sorted[0].tracks >= 3 * sorted[1].tracks) return play(albumCand(sorted[0], true));
  const choices = onePerArtist(sorted, (a) => a.aw.join(" "));
  if (choices.length === 1) return play(albumCand(choices[0], true));
  return ask(choices.map((a) => albumCand(a, false)));
}

/** Rules 3 and 4 for exact hits from the index (a track of the same title is the caller's check). */
function settleExact(hits) {
  const of = (kind) => hits.filter((e) => e.kind === kind);
  const playlists = of("playlist");
  if (playlists.length) return play(playlistCand(playlists.sort(byId)[0], true));
  const artists = of("artist");
  if (artists.length) return play(artistCand(artists.sort(byId), true));
  const albums = of("album");
  if (albums.length) return settleAlbums(albums);
  const genres = of("genre");
  return genres.length ? play(genreCand(genres.sort(byId)[0], true)) : NONE;
}

/** Rule 6: contained hits. → a decision, or null when there is nothing to offer. */
function settleContained(hits) {
  if (!hits.length) return null;
  if (hits.length === 1) return play(candOf(hits[0], true));
  if (hits.every((e) => e.kind === "album" && e.f === hits[0].f)) return settleAlbums(hits);      // one shared title: rule 5
  if (hits.every((e) => e.kind === "artist" && e.f === hits[0].f)) return play(artistCand(hits.sort(byId), true));
  const order = (e) => ALL.indexOf(e.kind);
  const offer = hits.filter((e) => e.kind !== "genre")
    .sort((a, b) => (a.w.length - b.w.length) || (order(a) - order(b)) || ((b.tracks || 0) - (a.tracks || 0)) || byId(a, b));
  const named = onePerArtist(offer, (e) => `${e.kind}|${e.f}`);
  if (!named.length) return null;
  if (named.length === 1) return play(candOf(named[0], true));
  return ask(named.map((e) => candOf(e, false)));
}

/** Live tracks as the adapter hands them over: [{ id, title, artist, albumId }]. → the ones whose title is the phrase. */
function exactTracks(tracks, w) {
  if (!Array.isArray(tracks) || !w.length) return [];
  const out = [];
  for (const t of tracks.slice(0, LIST_MAX.tracks)) {
    const id = idOf(t?.id);
    const tw = wordsOf(t?.title);
    if (id && exactWords(w, tw)) out.push({ id, name: cleanName(t.title), artist: cleanName(t.artist), aw: wordsOf(t.artist) });
  }
  return out;
}
/** Rule 7: tracks of one title. */
function settleTracks(list) {
  const choices = onePerArtist(list, (t) => t.aw.join(" "));
  if (choices.length === 1) return play(trackCand(choices[0], true));
  return ask(choices.map((t) => trackCand(t, false)));
}
const artistIs = (nameWords, clause) => exactWords(clause, nameWords) || containedWords(clause, nameWords);

/**
 * req: readRequest(); ix: buildIndex(); live: what only the server knows —
 *   live.tracks        [{ id, title, artist }] from the track searches in { need: "tracks", queries }
 *   live.artistAlbums  Set of album ids that carry a track by one of { need: "artistAlbums", artists }
 * → { candidates } — one confident candidate (play it), two to four that are not (ask), or none —
 *   or { need, … } when the answer depends on data that was not supplied.
 */
export function decide(req, ix, live = {}, { lang = "en", explicit = false } = {}) {
  const W = req?.words || [];
  const needTracks = () => ({ need: "tracks", queries: trackQueries(req) });
  if (!W.length) return explicit ? play(libraryCandidate(lang)) : NONE;
  // Rule 1: a genre cue.
  if (req.genreCue) {
    if (!req.core.length) return play(libraryCandidate(lang));
    const g = exact(ix, req.core, ["genre"]);
    if (g.length) return play(genreCand(g.sort(byId)[0], true));
  }
  /** Exact hits for one reading of the phrase. A genre alone waits for a track of that title (rule 4). */
  const exactly = (w, kinds) => {
    if (kinds.includes("track")) {
      if (!live.tracks) return needTracks();
      const t = exactTracks(live.tracks, w);
      return t.length ? settleTracks(t) : null;
    }
    const hits = exact(ix, w, kinds);
    if (!hits.length) return null;
    if (hits.every((e) => e.kind === "genre") && kinds.length > 1) {
      if (!live.tracks) return needTracks();
      const t = exactTracks(live.tracks, w);
      if (t.length) return settleTracks(t);
    }
    return settleExact(hits);
  };
  // Rule 2: the whole phrase first, in every kind.
  const cued = (req.kind !== null || req.genreCue) && req.core.length > 0 && !sameWords(req.core, W);
  const cueKinds = req.kind ? [req.kind] : ALL;
  let d = exactly(W, ALL);
  if (d) return d;
  if (req.kind === "track") { d = exactly(W, ["track"]); if (d) return d; }
  // …then the reading its cue asks for: the phrase without the cue, in that kind only.
  if (cued) { d = exactly(req.core, cueKinds); if (d) return d; }
  // …then the artist clause, when the words after it are an artist.
  const sp = req.split;
  if (sp) {
    let artists = exact(ix, sp.artist, ["artist"]);
    if (!artists.length) artists = contained(ix, sp.artist, ["artist"]);
    if (artists.length) {
      // The whole phrase may still be a track title with "by" in it.
      if (!live.tracks) return needTracks();
      const whole = exactTracks(live.tracks, W);
      if (whole.length) return settleTracks(whole);
      if (!sp.head.length) {
        const same = artists.every((e) => e.f === artists[0].f);
        d = same ? play(artistCand(artists.sort(byId), true)) : settleContained(artists);
        if (d) return d;
      } else {
        const kinds = sp.kind ? [sp.kind] : ["album", "track"];
        if (kinds.includes("album")) {
          const titled = exact(ix, sp.head, ["album"]);
          if (titled.length) {
            let kept = titled.filter((a) => artistIs(a.aw, sp.artist));
            if (!kept.length) {
              // …or any TRACK artist: only the server knows who plays on an album.
              if (!live.artistAlbums) return { need: "artistAlbums", artists: artists.sort(byId).slice(0, 3).map((e) => e.id) };
              kept = titled.filter((a) => live.artistAlbums.has(a.id));
            }
            if (kept.length) return settleAlbums(kept);
          }
          d = settleContained(contained(ix, sp.head, ["album"]).filter((a) => artistIs(a.aw, sp.artist)));
          if (d) return d;
        }
        if (kinds.includes("track")) {
          const t = exactTracks(live.tracks, sp.head).filter((x) => artistIs(x.aw, sp.artist));
          if (t.length) return settleTracks(t);
        }
      }
    }
  }
  // Rule 6: contained hits — the cue's reading, then the whole phrase.
  if (cued && req.kind !== "track") { d = settleContained(contained(ix, req.core, cueKinds)); if (d) return d; }
  d = settleContained(contained(ix, W, ALL));
  if (d) return d;
  // Rule 7: a track title.
  if (!live.tracks) return needTracks();
  const t = exactTracks(live.tracks, W);
  if (t.length) return settleTracks(t);
  if (cued) { const c = exactTracks(live.tracks, req.core); if (c.length) return settleTracks(c); }
  return NONE;
}

// ── "Which one?" ─────────────────────────────────────────────────────────────────────────────────
const ASK_LEADS = new Set(["play", "put", "on", "pon", "ponme", "toca", "reproduce", "um", "uh", "ok", "okay", "please", "i", "want", "id", "like", "quiero", "dame"]);
const ASK_TAILS = new Set(["please", "thanks", "gracias", "favor", "por"]);
const ORDINALS = Object.freeze({ first: 0, "1st": 0, one: 0, 1: 0, primero: 0, primera: 0, primer: 0, uno: 0, una: 0,
  second: 1, "2nd": 1, two: 1, 2: 1, segundo: 1, segunda: 1, dos: 1, third: 2, "3rd": 2, three: 2, 3: 2, tercero: 2, tercera: 2, tercer: 2, tres: 2,
  fourth: 3, "4th": 3, four: 3, 4: 3, cuarto: 3, cuarta: 3, cuatro: 3, last: -1, ultimo: -1, ultima: -1 });
// "one" folds to "1" (spoken forms): both spellings lead.
const BY_LEADS = [["the", "one", "by"], ["the", "one", "from"], ["the", "1", "by"], ["the", "1", "from"], ["the", "version", "by"], ["one", "by"], ["1", "by"], ["by"], ["from"], ["el", "de"], ["la", "de"], ["el", "que", "es", "de"], ["la", "que", "es", "de"], ["de"], ["por"]];
const startsWithRun = (w, p) => w.length > p.length && p.every((x, i) => w[i] === x);

/**
 * The answer to "Which one?": "the one by <artist>", a bare artist name, a bare title, "the first
 * one", "la segunda". → that candidate, now confident, or null when the words do not pick exactly one.
 */
export function choose(candidates, utterance) {
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, 8).filter((c) => c && typeof c.id === "string" && typeof c.title === "string");
  if (!list.length) return null;
  let w = wordsOf(typeof utterance === "string" ? utterance : "");
  let a = 0, b = w.length;
  while (b - a > 1 && ASK_LEADS.has(w[a])) a += 1;
  while (b - a > 1 && ASK_TAILS.has(w[b - 1])) b -= 1;
  w = w.slice(a, b);
  if (!w.length) return null;
  const pick = (c) => (c ? { ...c, confident: true } : null);
  const only = (hits) => (hits.length === 1 ? hits[0] : null);
  const titleW = (c) => wordsOf(c.title), artistW = (c) => wordsOf(c.subtitle);
  const byArtist = (q) => only(list.filter((c) => exactWords(q, artistW(c)))) || only(list.filter((c) => containedWords(q, artistW(c))));
  const byTitle = (q) => only(list.filter((c) => exactWords(q, titleW(c)))) || only(list.filter((c) => containedWords(q, titleW(c))));
  // "the one by …", "el de …": only the artist is meant.
  const lead = BY_LEADS.find((p) => startsWithRun(w, p));
  if (lead) { const hit = byArtist(w.slice(lead.length)); if (hit) return pick(hit); }
  // A name: a title, an artist, or "<title> by <artist>".
  const named = byTitle(w) || byArtist(w);
  if (named) return pick(named);
  for (let i = w.length - 2; i > 0; i -= 1) {
    if (!CLAUSE.has(w[i])) continue;
    const hit = only(list.filter((c) => exactWords(w.slice(0, i), titleW(c)) && artistIs(artistW(c), w.slice(i + 1))));
    if (hit) return pick(hit);
    break;
  }
  // "the first one", "number two", "la segunda", "the last one".
  let o = w;
  if (o.length > 1 && (CUE_LEADS.has(o[0]) || o[0] === "number" || o[0] === "numero" || o[0] === "option" || o[0] === "opcion")) o = o.slice(1);
  if (o.length === 2 && (o[1] === "one" || o[1] === "1" || o[1] === "uno" || o[1] === "una")) o = o.slice(0, 1);
  if (o.length === 1 && Object.hasOwn(ORDINALS, o[0])) {
    const n = ORDINALS[o[0]];
    return pick(n < 0 ? list.at(-1) : list[n]);
  }
  return null;
}

/**
 * The line for a set of choices. Albums or tracks of ONE title are told apart by artist
 * (strings key say_music_choices_by: {title}, {names}); anything else by name (say_choices: {names}).
 */
export function describeChoices(candidates) {
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, CHOICES_MAX);
  const first = list[0];
  const oneTitle = list.length > 1 && (first.kind === "album" || first.kind === "track")
    && list.every((c) => c.kind === first.kind && fold(c.title) === fold(first.title) && fold(c.subtitle));
  return oneTitle ? { say: "say_music_choices_by", vars: { title: first.title, names: list.map((c) => c.subtitle) } }
    : { say: "say_choices", vars: { names: list.map((c) => c.title) } };
}

// ── the operator's match report ──────────────────────────────────────────────────────────────────
/** "HipHop" as a person says it: "hip hop". Split where a lower-case letter meets a capital. */
function spokenGenre(name) {
  const s = text(name).slice(0, TEXT_MAX);
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i], prev = s[i - 1] || "";
    if (i > 0 && ch !== ch.toLowerCase() && prev !== prev.toUpperCase()) out += " ";
    out += ch;
  }
  return fold(out);
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS_W = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
// Every ordinal word up to twentieth, from the same table the matcher reads (F7: "12th" is "twelfth", not "twelveth").
const ORD_W = ["", ...Object.keys(ORD_WORDS).sort((a, b) => ORD_WORDS[a] - ORD_WORDS[b])];
const two = (n) => (n < 20 ? ONES[n] : `${TENS_W[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`);
/** A number as a person reads it: years in pairs ("nineteen ninety nine"), 2000-2009 as "two thousand five", else plainly. */
function sayNumber(n) {
  // r7: past 9999 in thousands and millions ("10,000" is "ten thousand").
  if (n >= 1_000_000) return `${sayNumber(Math.floor(n / 1_000_000))} million${n % 1_000_000 ? ` ${sayNumber(n % 1_000_000)}` : ""}`;
  if (n >= 10_000) return `${sayNumber(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${sayNumber(n % 1000)}` : ""}`;
  if (n < 100) return two(n);
  if (n >= 1100 && n < 2000 || n >= 2010 && n < 2100) return `${two(Math.floor(n / 100))} ${n % 100 === 0 ? "hundred" : n % 100 < 10 ? `oh ${ONES[n % 100]}` : two(n % 100)}`;
  if (n >= 2000 && n < 2010) return `two thousand${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
  // "1000" is "one thousand", "1050" "one thousand fifty", "3000" "three thousand" (F7: never digit by digit).
  if (n >= 1000 && (n < 1100 || n % 1000 === 0)) return `${ONES[Math.floor(n / 1000)]} thousand${n % 1000 ? ` ${n % 1000 < 100 ? two(n % 1000) : sayNumber(n % 1000)}` : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${two(n % 100)}` : ""}`;
  return String(n).split("").map((d) => ONES[Number(d)]).join(" ");
}
/**
 * A name as speech-to-text may write it when someone says it: numbers and ordinals as words, the
 * short forms spelled out, an all-capitals word of two to five letters spelled as letters. "" when
 * that is no different from the name.
 */
export function sayAloud(name) {
  const said = text(name).slice(0, TEXT_MAX)
    .replace(/\bSt\.?(?=\s)/g, "saint").replace(/\bDr\.?(?=\s)/g, "doctor").replace(/\bVol\.?(?=\s)/gi, "volume").replace(/\bMr\.?(?=\s)/g, "mister")
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, (m, d) => { const n = Number(d); return n >= 1 && n <= 20 ? ORD_W[n] : n % 10 ? `${TENS_W[Math.floor(n / 10)]} ${ORD_W[n % 10]}` : m; })
    // r7: a number with a thousands separator is one number; leading zeros are read digit by digit ("007").
    .replace(/\b\d{1,3},\d{3}(?:,\d{3})?\b/g, (d) => sayNumber(Number(d.replace(/,/g, ""))))
    .replace(/\b0\d{1,3}\b/g, (d) => d.split("").map((c) => ONES[Number(c)]).join(" "))
    .replace(/\b\d{1,4}\b/g, (d) => sayNumber(Number(d)))
    .replace(/\b[A-Z]{2,5}\b/g, (w) => w.toLowerCase().split("").join(" "))
    .replace(/\b([A-Z]{1,3})\/([A-Z]{1,3})\b/g, (m, a, b) => `${a} ${b}`.toLowerCase().split("").filter((c) => c !== " ").join(" "));
  return fold(said) === fold(name) && said.toLowerCase() === text(name).toLowerCase() ? "" : said;
}

/** Which kinds of change sayAloud() makes to a name: letters, ordinal, number, short. */
export function spokenChanges(name) {
  const t = text(name).slice(0, TEXT_MAX), out = [];
  if (/\b[A-Z]{2,5}\b/.test(t) || /\b[A-Z]{1,3}\/[A-Z]{1,3}\b/.test(t)) out.push("letters");
  if (/\b\d{1,2}(st|nd|rd|th)\b/i.test(t)) out.push("ordinal");
  if (/\b\d{1,4}\b/.test(t)) out.push("number");
  if (/\b(St|Dr|Vol|Mr)\.?\s/i.test(t)) out.push("short");
  return out.length ? out : ["other"];
}

/**
 * Every album title, artist name and genre, said as speech would give it (folded: no accents, no
 * punctuation, lower case), run through decide() with no live data. COUNTS ONLY: no name leaves here.
 */
export function matchReport(ix) {
  const live = { tracks: [], artistAlbums: new Set() };
  const run = (spoken) => decide(readRequest(spoken), ix, live).candidates || [];
  const albums = { total: ix.albums.length, unique_total: 0, unique_resolved: 0, unique_to_artist: 0, unique_to_playlist: 0, unique_asked: 0, unique_missed: 0,
    unique_resolved_with_cue: 0, shared: { titles: 0, albums: 0, fragments: 0, dominant: 0, same_artist: 0, ask: 0, other: 0 }, no_track_count: ix.albums.filter((a) => !a.tracks).length };
  const titles = new Map();
  for (const a of ix.albums) { const k = dropArticle(a.w).join(" "); const l = titles.get(k); if (l) l.push(a); else titles.set(k, [a]); }
  for (const group of titles.values()) {
    const c = run(group[0].f);
    const one = c.length === 1 && c[0].confident ? c[0] : null;
    if (group.length === 1) {
      albums.unique_total += 1;
      const own = `music:album:${group[0].id}`;
      if (one?.id === own && !one.group) albums.unique_resolved += 1;
      else if (one?.kind === "artist") albums.unique_to_artist += 1;
      else if (one?.kind === "playlist") albums.unique_to_playlist += 1;
      else if (c.length > 1) albums.unique_asked += 1;
      else albums.unique_missed += 1;
      const cue = run(`album ${group[0].f}`);
      if (cue.length === 1 && cue[0].id === own) albums.unique_resolved_with_cue += 1;
      continue;
    }
    albums.shared.titles += 1;
    albums.shared.albums += group.length;
    const ids = new Set(group.map((a) => `music:album:${a.id}`));
    if (one?.group && one.kind === "album") albums.shared.fragments += 1;
    // One album of the group plays: the dominant one, or the larger of two by the same artist.
    else if (one && ids.has(one.id)) albums.shared[group.every((a) => sameWords(a.aw, group[0].aw)) ? "same_artist" : "dominant"] += 1;
    else if (c.length > 1 && c.every((x) => ids.has(x.id))) albums.shared.ask += 1;
    else albums.shared.other += 1;
  }
  const artists = { total: ix.artists.length, resolved: 0, to_playlist: 0, asked: 0, missed: 0, same_name: 0 };
  for (const a of ix.artists) {
    const c = run(a.f);
    const one = c.length === 1 && c[0].confident && c[0].kind === "artist" ? c[0] : null;
    if (one && (one.id === `music:artist:${a.id}` || one.group?.includes(a.id))) { artists.resolved += 1; if (one.group) artists.same_name += 1; }
    else if (c.length === 1 && c[0].kind === "playlist") artists.to_playlist += 1;
    else if (c.length > 1) artists.asked += 1;
    else artists.missed += 1;
  }
  const genres = { total: ix.genres.length, resolved: 0, resolved_without_cue: 0 };
  for (const g of ix.genres) {
    const forms = [...new Set([g.f, spokenGenre(g.name)])].filter(Boolean);
    const hit = (c) => c.length === 1 && c[0].id === `music:genre:${g.id}`;
    if (forms.every((f) => hit(run(`some ${f}`)))) genres.resolved += 1;
    if (forms.every((f) => hit(run(f)))) genres.resolved_without_cue += 1;
  }
  // How the names are HEARD: each name that speech would write differently, said that way. Revision 6 (F7): a
  // spoken form counts as resolved when it lands where the WRITTEN name lands (an album titled like its artist
  // plays the artist, by design, both ways), so the two rates compare like for like; `missed_by` counts the
  // misses by the kind of change speech made (a name can count under several). Counts only.
  const sure = (c) => (c.length === 1 && c[0].confident ? c[0].id : null);
  const spoken = { albums: { variants: 0, resolved: 0, missed_by: {} }, artists: { variants: 0, resolved: 0, missed_by: {} } };
  const miss = (box, name) => { for (const k of spokenChanges(name)) box.missed_by[k] = (box.missed_by[k] || 0) + 1; };
  for (const group of titles.values()) {
    if (group.length !== 1) continue;
    const said = sayAloud(group[0].name);
    if (!said) continue;
    spoken.albums.variants += 1;
    const want = sure(run(group[0].f));
    if (want && sure(run(said)) === want) spoken.albums.resolved += 1; else miss(spoken.albums, group[0].name);
  }
  for (const a of ix.artists) {
    const said = sayAloud(a.name);
    if (!said) continue;
    spoken.artists.variants += 1;
    const c = run(said);
    if (c.length === 1 && c[0].kind === "artist" && (c[0].id === `music:artist:${a.id}` || c[0].group?.includes(a.id))) spoken.artists.resolved += 1;
    else miss(spoken.artists, a.name);
  }
  return { albums, artists, genres, spoken };
}
