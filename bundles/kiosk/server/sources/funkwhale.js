/**
 * The household music library as a play source: a Funkwhale server, asked through its own API.
 *
 * THE SOURCE CONTRACT, version 1 — the same for every play source of a display:
 *
 *   source = { kind, contract: 1,
 *     available()                      → boolean      configured, not "reachable"
 *     search(what, { explicit, lang }) → Candidate[]  ranked; [] = not found; may throw SourceUnavailable
 *     queue(candidate, { limit })      → Playable[]   limit defaults to 50
 *     resolve(candidate)               → Playable     first of queue()
 *     choose(candidates, utterance)    → Candidate | null   the "Which one?" follow-up }
 *   Candidate = { id, kind, title, subtitle?, confident, group? }
 *   Playable  = { kind, id, title, subtitle?, duration_sec?, art?, form: "audio", codec?, source,
 *                 upstream: { url, headers?, hop } }        upstream never leaves the server
 *   SourceUnavailable: code "unreachable" | "unauthorized" | "timeout" — never an empty result
 *
 * `what` is the only speech- or model-derived input. It reaches string comparison and URL query
 * encoding, nothing else. A candidate carries ids and names: no address, no credential.
 *
 * How it finds things. Funkwhale's own search does not fold accents or punctuation and cannot
 * tell a genre written "HipHop" from the words "hip hop", so names are matched HERE
 * (music-match.js) against a small index: every album with its artist and track count, every
 * genre tag, every playlist, and — when their slower listing finishes — every artist. The index
 * is built in the background and refreshed every six hours. Until it exists a search asks the
 * server's own lists instead (cold: slower, and blind to accents). Track titles are never
 * indexed: they are searched live.
 *
 * What it asks the server: GET only. Nothing is created, changed or recorded by this module (the
 * server itself counts each stream it serves).
 *
 * Streams. A playable's upstream is the server's listen address for one track plus the bearer and
 * a HOP POLICY for the relay: the first hop may only be the configured origin and the listen
 * path; the server answers with ONE redirect to its file storage, which must be the configured
 * storage origin; the credential belongs to the first hop only (it is only ever written into
 * upstream.headers.Authorization).
 */
import { SourceUnavailable, SOURCE_CONTRACT } from "./index.js";
import { serviceHop } from "../relay.js";
import { buildIndex, readRequest, decide, choose, matchReport, cleanName, fold, compact, GROUP_MAX } from "./music-match.js";

/** The only path a stream is ever requested from. Group 1 is the track's listen id. */
export const LISTEN_PATH = /^\/api\/v1\/listen\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/$/i;
/**
 * Files sent as stored. Decided by the FILE EXTENSION of the upload, never by the MIME type the
 * server reports: most of those are corrupted on a library imported from files, and asking for a
 * copy of an MP3 "as MP3" then makes the server re-encode it.
 */
export const DIRECT_EXTENSIONS = Object.freeze(["mp3", "ogg", "opus", "flac"]);
/** The copies a display may ask the server for. */
export const TRANSCODE_FORMATS = Object.freeze(["mp3", "ogg", "opus"]);
export const QUEUE_DEFAULT = 50;
export const QUEUE_MAX = 500;
export const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const PLAYLISTS_TTL_MS = 5 * 60 * 1000;
/** The server never returns more per page, whatever is asked. */
const PAGE = 50;
const CANDIDATE_ID = /^music:(track|album|artist|genre|playlist|library):([A-Za-z0-9_.~-]{1,64})$/;
const KEY = /^[A-Za-z0-9_.~-]{1,64}$/;
const TRACK_CACHE_MAX = 300;

/** "https://host:port" for a plain http(s) origin with no path, credentials, query or fragment; else null. */
export function originOf(v) {
  if (typeof v !== "string" || v.length > 300) return null;
  let u;
  try { u = new URL(v.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  return u.origin;
}

/**
 * raw: { base, token, storageOrigin, publicOrigin? } as the runtime hands it over.
 *   base           the origin this module calls (in production the loopback one)
 *   token          the API token
 *   storageOrigin  the origin the listen address redirects to
 *   publicOrigin   optional: the origin the library's own tools write into their results (see envelope.js)
 * → the checked settings, or null when any of the first three is missing or malformed.
 */
export function readMusicConfig(raw) {
  const base = originOf(raw?.base), storageOrigin = originOf(raw?.storageOrigin);
  const token = typeof raw?.token === "string" ? raw.token.trim() : "";
  if (!base || !storageOrigin || !token || token.length > 512 || /[\s\u0000-\u001f\u007f]/.test(token)) return null;
  return { base, token, storageOrigin, publicOrigin: originOf(raw?.publicOrigin) };
}

/** The only query a first request may carry: a copy in one of TRANSCODE_FORMATS. */
const COPY_QUERY = /^\?to=(mp3|ogg|opus)$/;
/** The first request's only shape: the listen path, as stored or with ?to=<format>. */
export const listenPathAllowed = (pathname, search) => LISTEN_PATH.test(pathname) && (search === "" || COPY_QUERY.test(search));

/**
 * The relay's policy for one library stream (relay.js serviceHop):
 *   origin   the only origin the first request may go to; the credential is sent there and nowhere else
 *   path     the only path shape the first request may have (listenPathAllowed)
 *   storage  the ONE origin the single redirect may lead to (the server's file storage)
 * Those two origins are operator settings, so they may be private addresses; nothing else may be.
 */
export function libraryHop(cfg) {
  return serviceHop({ origin: cfg.base, path: listenPathAllowed, storage: [cfg.storageOrigin] });
}

/** uuid: a listen id that already matched LISTEN_PATH. to: null (as stored) or one of TRANSCODE_FORMATS. */
export function listenUpstream(cfg, uuid, to = null) {
  return {
    url: `${cfg.base}/api/v1/listen/${uuid}/${to ? `?to=${to}` : ""}`,
    headers: { Authorization: `Bearer ${cfg.token}` },
    hop: libraryHop(cfg),
  };
}

/** A track's listen PATH as the API gives it → its listen id, or null. Anything else is never fetched. */
export function listenUuid(path) {
  const m = typeof path === "string" && path.length < 200 ? LISTEN_PATH.exec(path) : null;
  return m ? m[1].toLowerCase() : null;
}

/**
 * A listen ADDRESS written by one of the library's own tools → { uuid, to }, or null.
 * It must be on the configured origin (the one this module calls, or the public one the tools
 * were given), be exactly the listen path, and carry at most `?to=<format>`. Only the id and the
 * format are taken from it: the address itself is never used.
 */
export function parseListenUrl(url, cfg) {
  if (!cfg || typeof url !== "string" || url.length > 400) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.username || u.password || u.hash) return null;
  if (u.origin !== cfg.base && !(cfg.publicOrigin && u.origin === cfg.publicOrigin)) return null;
  const m = LISTEN_PATH.exec(u.pathname);
  if (!m) return null;
  const keys = [...u.searchParams.keys()];
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== "to")) return null;
  const to = u.searchParams.get("to");
  if (to !== null && !TRANSCODE_FORMATS.includes(to)) return null;
  return { uuid: m[1].toLowerCase(), to };
}

/** Does this track need a copy made? True unless every stored file of it has a direct extension. */
export function needsTranscode(track) {
  const uploads = Array.isArray(track?.uploads) ? track.uploads : [];
  return !(uploads.length > 0 && uploads.every((u) => DIRECT_EXTENSIONS.includes(String(u?.extension || "").toLowerCase())));
}

/**
 * Is the configured storage origin the one this server really sends its files from? Asks for one
 * track, requests its listen address with the credential WITHOUT following the redirect, and
 * compares the redirect's origin with the setting. The redirect's address (it carries a signed
 * query) is never returned or logged. The server counts the request as one download of that track.
 * config: { base, token, storageOrigin } (or a function returning it).
 * → { ok: true } | { ok: false, reason: "not_configured" | "unreachable" | "unauthorized" | "no_track" | "no_redirect" | "other_origin" }
 */
export async function checkStorage(config, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  let cfg = null;
  try { cfg = readMusicConfig(typeof config === "function" ? config() : config); } catch {}
  if (!cfg) return { ok: false, reason: "not_configured" };
  const no = (reason) => ({ ok: false, reason });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const get = (url) => fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" }, redirect: "manual", signal: ctl.signal });
  try {
    const list = await get(`${cfg.base}/api/v1/tracks/?page_size=1`);
    if (list.status === 401 || list.status === 403) return no("unauthorized");
    if (list.status !== 200) return no("unreachable");
    const uuid = listenUuid((await list.json())?.results?.[0]?.listen_url);
    if (!uuid) return no("no_track");
    const r = await get(listenUpstream(cfg, uuid).url);
    try { await r.body?.cancel?.(); } catch {}
    if (r.status === 401 || r.status === 403) return no("unauthorized");
    if (r.status >= 200 && r.status < 300) return no("no_redirect");       // the server sends the file itself
    if (r.status < 300 || r.status >= 400) return no("unreachable");
    const location = r.headers?.get?.("location");
    if (!location) return no("no_redirect");
    let origin = null;
    try { origin = new URL(location, cfg.base).origin; } catch {}
    return origin === cfg.storageOrigin ? { ok: true } : no("other_origin");
  } catch {
    return no("unreachable");
  } finally {
    clearTimeout(timer);
  }
}

const yearOf = (d) => { const y = Number.parseInt(String(d || "").slice(0, 4), 10); return Number.isInteger(y) && y > 0 ? y : null; };
const albumRow = (a) => ({ id: a?.id, title: a?.title, artist: a?.artist?.name, artistId: a?.artist?.id, tracks: a?.tracks_count, year: yearOf(a?.release_date) });
const artistRow = (a) => ({ id: a?.id, name: a?.name });
const byKey = (rows, keyOf) => { const seen = new Map(); for (const r of rows) { const k = keyOf(r); if (k != null && !seen.has(k)) seen.set(k, r); } return [...seen.values()]; };
const distinct = (list, max) => byKey(list.map((s) => String(s || "").trim()).filter(Boolean), (s) => s.toLowerCase()).slice(0, max);

/**
 * config()   → { base, token, storageOrigin, publicOrigin? } | null (read on every use)
 * fetchImpl  fetch
 * clock      () → ms
 * timers     { setTimeout, clearTimeout }
 * autoStart  begin building the index on the first search (default true)
 */
export function createMusicSource({ config, fetchImpl = fetch, clock = Date.now, timers = { setTimeout, clearTimeout }, timeoutMs = 4000, refreshMs = REFRESH_MS, autoStart = true } = {}) {
  const cfg = () => { try { return readMusicConfig(typeof config === "function" ? config() : null); } catch { return null; } };
  const gone = (code) => new SourceUnavailable(code, `music ${code}`);
  const inflight = new Set();
  let stopped = false, started = false, generation = 0, timer = null;
  let lists = { albums: [], artists: [], genres: [], playlists: [] };
  const state = { ix: buildIndex(), warm: false, artistsComplete: false, builtAt: 0, playlistsAt: -Infinity, building: null, error: null };
  const trackCache = new Map();

  /** One GET. → the parsed body, or null for "no such thing" (404 and other refusals of the request itself). */
  async function call(c, path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const ctl = new AbortController();
    let timedOut = false;
    const t = timers.setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    t?.unref?.();
    inflight.add(ctl);
    try {
      // The bearer is a header, never part of the address. A redirect is never followed with it.
      const r = await fetchImpl(`${c.base}/api/v1/${path}${qs ? `?${qs}` : ""}`, { method: "GET", headers: { Authorization: `Bearer ${c.token}`, Accept: "application/json" }, redirect: "manual", signal: ctl.signal });
      if (r.status === 401 || r.status === 403) throw gone("unauthorized");
      if (r.status === 404) return null;
      if (r.status >= 500 || (r.status >= 300 && r.status < 400)) throw gone("unreachable");
      if (r.status < 200 || r.status >= 300) return null;
      return await r.json();      // a body that is not JSON is not the library answering
    } catch (err) {
      if (err instanceof SourceUnavailable) throw err;
      throw gone(timedOut ? "timeout" : "unreachable");
    } finally {
      timers.clearTimeout(t);
      inflight.delete(ctl);
    }
  }
  /**
   * A list, page by page, up to `limit` rows. `next` only says that another page exists: its
   * address is never fetched (the server writes it with its public name), the page number is.
   */
  async function pages(c, path, params = {}, { limit = Infinity, maxPages = 2000, live = () => true } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages && out.length < limit && live(); page += 1) {
      const body = await call(c, path, { ...params, page_size: String(PAGE), ...(page > 1 ? { page: String(page) } : {}) });
      const rows = Array.isArray(body?.results) ? body.results : [];
      out.push(...rows);
      if (!body?.next || !rows.length) break;
    }
    return out.slice(0, limit);
  }
  const first = async (c, path, params) => { const body = await call(c, path, { ...params, page_size: String(PAGE) }); return Array.isArray(body?.results) ? body.results : []; };
  const listPlaylists = async (c) => (await pages(c, "playlists/", {}, { maxPages: 4 })).map((p) => ({ id: p?.id, name: p?.name }));

  // ── the name index ─────────────────────────────────────────────────────────────────────────────
  function schedule(ms) {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (stopped || !started) return;
    timer = timers.setTimeout(() => { timer = null; build().catch(() => {}); }, ms);
    timer?.unref?.();
  }
  /** Genres and albums first (seconds): the index is usable. Artists after (the slow listing). → true when all of it landed. */
  function build() {
    if (state.building) return state.building;
    const c = cfg();
    if (!c) return Promise.resolve(false);
    const gen = ++generation;
    const live = () => gen === generation && !stopped;
    state.building = (async () => {
      try {
        const genres = byKey(await pages(c, "tags/", {}, { live }), (g) => g?.name).map((g) => ({ name: g?.name }));
        const albums = byKey(await pages(c, "albums/", {}, { live }), (a) => a?.id).map(albumRow);
        const playlists = await listPlaylists(c);
        if (!live()) return false;
        // Usable from here. Artists from the previous build stay until the new listing lands.
        lists = { genres, albums, playlists, artists: lists.artists };
        state.ix = buildIndex(lists);
        state.warm = true;
        state.builtAt = state.playlistsAt = clock();
        const artists = byKey(await pages(c, "artists/", {}, { live }), (a) => a?.id).map(artistRow);
        if (!live()) return false;
        lists = { ...lists, artists };
        state.ix = buildIndex(lists);
        state.artistsComplete = true;
        state.error = null;
        return true;
      } catch (err) {
        if (live()) state.error = err?.code || "unreachable";
        return false;
      } finally {
        if (gen === generation) { state.building = null; schedule(state.error ? RETRY_MS : refreshMs); }
      }
    })();
    return state.building;
  }
  function start() {
    if (!cfg()) return;      // not configured yet: the next search tries again
    stopped = false;
    started = true;
    build().catch(() => {});
  }
  /** Ends the background work: no timer is left, requests in flight are aborted. */
  function stop() {
    stopped = true;
    started = false;
    generation += 1;
    state.building = null;
    if (timer) timers.clearTimeout(timer);
    timer = null;
    for (const ctl of inflight) ctl.abort();
  }

  // ── search ─────────────────────────────────────────────────────────────────────────────────────
  const remember = (t) => {
    const id = String(t?.id ?? "");
    if (!KEY.test(id)) return;
    trackCache.delete(id);
    trackCache.set(id, t);
    if (trackCache.size > TRACK_CACHE_MAX) trackCache.delete(trackCache.keys().next().value);
  };
  /** Track titles are not indexed: each query is one live search (titles, and the server also matches artist names). */
  async function liveTracks(c, queries) {
    const found = byKey((await Promise.all(queries.map((q) => first(c, "tracks/", { q })))).flat(), (t) => t?.id);
    found.forEach(remember);
    return found.map((t) => ({ id: t?.id, title: t?.title, artist: t?.artist?.name }));
  }
  /** The albums that carry a track by one of these artists (an album's own artist may be someone else). */
  async function albumsWithArtist(c, artistIds) {
    const out = new Set();
    for (const rows of await Promise.all(artistIds.filter((id) => KEY.test(String(id))).map((id) => pages(c, "tracks/", { artist: String(id) }, { limit: 4 * PAGE })))) {
      for (const t of rows) if (t?.album?.id != null) out.add(String(t.album.id));
    }
    return out;
  }
  const liveArtists = async (c, req) => byKey((await Promise.all(distinct([req.raw, req.core.join(" "), req.split?.artist.join(" ")], 3).map((q) => first(c, "artists/", { q })))).flat(), (a) => a?.id).map(artistRow);
  /** No index yet: the server's own lists for this phrase, and an exact genre lookup (a list search can leave the exact tag pages away). */
  async function coldIndex(c, req) {
    const phrase = req.words.join(" "), core = req.core.join(" ");
    const albumQs = distinct([req.raw, phrase, core, req.split?.head.join(" ")], 3);
    const tagNames = distinct([compact(core), compact(phrase), compact(req.split?.head.join(" ") || "")], 3).filter((n) => /^[a-z0-9]{1,64}$/.test(n));
    const [albums, artists, tags, exactTags, playlists] = await Promise.all([
      Promise.all(albumQs.map((q) => first(c, "albums/", { q }))),
      liveArtists(c, req),
      first(c, "tags/", { q: core || phrase }),
      Promise.all(tagNames.map((n) => call(c, `tags/${n}/`))),
      listPlaylists(c),
    ]);
    return buildIndex({ albums: byKey(albums.flat(), (a) => a?.id).map(albumRow), artists, playlists,
      genres: byKey([...exactTags.filter(Boolean), ...tags], (g) => g?.name).map((g) => ({ name: g?.name })) });
  }
  /** Playlists are few and change by hand: listed again when the last look is five minutes old. */
  async function freshPlaylists(c) {
    if (clock() - state.playlistsAt < PLAYLISTS_TTL_MS) return;
    const playlists = await listPlaylists(c);
    state.playlistsAt = clock();
    if (JSON.stringify(playlists) === JSON.stringify(lists.playlists)) return;
    lists = { ...lists, playlists };
    state.ix = buildIndex(lists);
  }
  async function answer(c, req, ix, opts) {
    const live = {};
    for (let i = 0; i < 4; i += 1) {
      const d = decide(req, ix, live, opts);
      if (d.need === "tracks") live.tracks = await liveTracks(c, d.queries);
      else if (d.need === "artistAlbums") live.artistAlbums = await albumsWithArtist(c, d.artists);
      else return d.candidates || [];
    }
    return [];
  }
  async function search(what, { explicit = false, lang = "en" } = {}) {
    const c = cfg();
    if (!c) return [];
    if (autoStart && !started && !stopped) start();
    const req = readRequest(what);
    const opts = { lang: lang === "es" ? "es" : "en", explicit: explicit === true };
    if (!req.words.length || (req.genreCue && !req.core.length)) return answer(c, req, state.ix, opts);   // nothing to look up
    if (!state.warm) return answer(c, req, await coldIndex(c, req), opts);
    await freshPlaylists(c);
    const found = await answer(c, req, state.ix, opts);
    if (found.length || state.artistsComplete) return found;
    // The artist listing has not finished: an artist with no album of their own is asked for live.
    const extra = await liveArtists(c, req);
    return extra.length ? answer(c, req, buildIndex({ ...lists, artists: [...lists.artists, ...extra] }), opts) : found;
  }

  // ── queues ─────────────────────────────────────────────────────────────────────────────────────
  function playable(c, t) {
    const uuid = listenUuid(t?.listen_url);
    const id = String(t?.id ?? "");
    if (!uuid || !KEY.test(id) || t.is_playable === false) return null;
    const transcode = needsTranscode(t);
    const duration = Number(t.uploads?.[0]?.duration);
    return {
      kind: "track", id: `music:track:${id}`, title: cleanName(t.title) || "?",
      subtitle: [cleanName(t.artist?.name), cleanName(t.album?.title)].filter(Boolean).join(" — "),
      ...(duration > 0 ? { duration_sec: Math.round(duration) } : {}),
      form: "audio", codec: transcode ? "mp3" : String(t.uploads[0].extension).toLowerCase(), source: "music",
      upstream: listenUpstream(c, uuid, transcode ? "mp3" : null),
    };
  }
  const idsOf = (cand, key) => { const g = Array.isArray(cand?.group) ? cand.group.map(String).filter((x) => KEY.test(x)).slice(0, GROUP_MAX) : []; return g.length ? g : [key]; };
  const albumTracks = (c, id, limit) => pages(c, "tracks/", { album: id, ordering: "disc_number,position" }, { limit });
  /** Random order is the server's; a second page repeats rows, so they are told apart by id. */
  const shuffled = async (c, params, limit) => byKey(await pages(c, "tracks/", { ...params, ordering: "random" }, { limit, maxPages: Math.ceil(limit / PAGE) }), (t) => t?.id);
  /** A compilation the importer split into one "album" per artist: its parts, as one album again. */
  async function mergedAlbum(c, ids, limit) {
    const parts = [];
    for (let i = 0; i < ids.length; i += 6) parts.push(...await Promise.all(ids.slice(i, i + 6).map((id) => albumTracks(c, id, limit))));
    const rows = parts.flatMap((rows, part) => rows.map((t) => ({ t, part })));
    rows.sort((a, b) => ((a.t.disc_number || 1) - (b.t.disc_number || 1)) || ((a.t.position || 0) - (b.t.position || 0)) || (a.part - b.part));
    // The same recording imported twice is played once.
    return byKey(rows.map((r) => r.t), (t) => `${fold(t?.title)}|${fold(t?.artist?.name)}`);
  }
  async function tracksFor(c, cand, limit) {
    const m = CANDIDATE_ID.exec(String(cand?.id || ""));
    if (!m) return [];
    const [, kind, key] = m;
    if (kind === "album") { const ids = idsOf(cand, key); return ids.length > 1 ? mergedAlbum(c, ids, limit) : albumTracks(c, ids[0], limit); }
    // By artist id WITHOUT a playable filter: an album artist who is never a track's artist still has tracks.
    if (kind === "artist") { const lists = await Promise.all(idsOf(cand, key).map((id) => shuffled(c, { artist: id }, limit))); return byKey(lists.flat(), (t) => t?.id); }
    if (kind === "genre") {
      // The EXACT tag name: from the index, else the candidate's own title when it is that genre.
      const name = state.ix.genre.get(key)?.[0]?.name || (compact(cand.title) === key ? cleanName(cand.title) : null);
      return name ? shuffled(c, { tag: name }, limit) : [];
    }
    if (kind === "library") return shuffled(c, {}, limit);
    if (kind === "playlist") return (await pages(c, `playlists/${key}/tracks/`, {}, { limit })).map((e) => e?.track);
    const t = trackCache.get(key) || await call(c, `tracks/${key}/`);
    return t ? [t] : [];
  }
  async function queue(candidate, { limit = QUEUE_DEFAULT } = {}) {
    const c = cfg();
    if (!c) return [];
    const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), QUEUE_MAX) : QUEUE_DEFAULT;
    return (await tracksFor(c, candidate, n)).map((t) => playable(c, t)).filter(Boolean).slice(0, n);
  }

  return {
    kind: "music",
    contract: SOURCE_CONTRACT,
    available: () => cfg() !== null,
    search,
    queue,
    async resolve(candidate) {
      const [one] = await queue(candidate, { limit: 1 });
      if (!one) throw new Error("nothing playable");
      return one;
    },
    choose: (candidates, utterance) => choose(candidates, utterance),
    start,
    stop,
    /** Build the index now. → true when albums, genres, playlists and artists all landed. */
    refresh: () => build(),
    indexState: () => ({ warm: state.warm, artists_complete: state.artistsComplete, building: state.building !== null, error: state.error, built_at: state.builtAt,
      albums: state.ix.albums.length, artists: state.ix.artists.length, genres: state.ix.genres.length, playlists: state.ix.playlists.length }),
    /**
     * For operators, read-only: every album title, artist name and genre in the index, said as
     * speech would give it, run through the matcher. COUNTS ONLY. Builds the index first when needed.
     */
    async matchReport() {
      if (!cfg()) throw gone("unreachable");
      if (!(state.warm && state.artistsComplete) && !(await build())) throw gone(state.error || "unreachable");
      return matchReport(state.ix);
    },
    /**
     * A listen address from one of the library's own tools → a playable built HERE from its id
     * (see parseListenUrl), or null. meta: { title, artist } as the tool reported them.
     */
    playableFromListenUrl(url, meta = {}) {
      const c = cfg();
      const hit = c ? parseListenUrl(url, c) : null;
      if (!hit) return null;
      return { kind: "track", id: `music:track:${hit.uuid}`, title: cleanName(meta.title) || "Music", subtitle: cleanName(meta.artist), form: "audio", codec: hit.to || "", source: "music",
        upstream: listenUpstream(c, hit.uuid, hit.to) };
    },
  };
}
