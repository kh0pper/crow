/**
 * For You's "Listen" section: today's spoken briefing, the newest unplayed podcast episodes, and a
 * way into the Music app. Media Hub's data comes from the INSTALLED bundle's own server/for-you.js
 * (forYouBriefing, forYouEpisodes; media 1.2.3), loaded the way news.js loads it, never from its
 * tables. Each tile fails alone: a failed read leaves that tile out and keeps the others.
 *
 *   loadListen(db, opts) -> {
 *     media: "missing" | "update" | "ok",
 *     briefing: null | { item: { id, title, durationSec, createdAt, audioUrl } | null, next: { at, tz } | null },
 *     podcasts: null | { episodes: [{ id, title, show, sourceId, publishedAt, audioUrl }] },
 *     music: boolean,       // the Music bundle is installed: the "Open your music" tile
 *     radio: null,          // the hook for a radio provider (none in v1; see below)
 *   }
 *
 * Radio: no radio source exists yet. A provider (an internet-radio bundle, or Media Hub's planned
 * radio streams) fills `radio` with { stations: [{ id, name, audioUrl }] } here, and listenHtml
 * renders it as one more tile; until then it stays null and nothing shows.
 *
 * Every audio address that reaches the page passes listenAudioUrl: Media Hub's own briefing audio
 * route (same origin, the session cookie) or an https address. Anything else drops the item.
 */
import { resolveCrowHome } from "../../shared/crow-home.js";
import { installedBundleIds } from "../skills-catalog.js";
import { mediaModule, mediaInstalled } from "./news.js";

const BRIEFING_AUDIO = /^\/api\/media\/briefings\/[1-9]\d{0,11}\/audio$/;

/** The address when it may play on the page: Media Hub's briefing audio route, or https. Else "". */
export function listenAudioUrl(v) {
  const s = String(v ?? "").trim();
  if (BRIEFING_AUDIO.test(s)) return s;
  if (!/^https:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
  } catch { return ""; }
}

const warn = (what) => (err) => { console.warn(`[for-you] ${what} failed: ${err && err.message}`); return null; };

async function briefingTile(mod, db, now) {
  const r = await mod.forYouBriefing(db, { now });
  const b = r && r.briefing;
  const audioUrl = b ? listenAudioUrl(b.audioUrl) : "";
  const item = b && audioUrl ? { id: Number(b.id), title: String(b.title || ""), durationSec: Number(b.durationSec) > 0 ? Number(b.durationSec) : null, createdAt: b.createdAt || null, audioUrl } : null;
  const at = r && r.next ? Date.parse(r.next.at) : NaN;
  return { item, next: !item && Number.isFinite(at) ? { at: new Date(at).toISOString(), tz: r.next.tz || null } : null };
}

async function podcastsTile(mod, db) {
  const r = await mod.forYouEpisodes(db, {});
  if (!r || !(Number(r.shows) > 0)) return null;   // no podcasts followed: no tile
  const episodes = [];
  for (const e of Array.isArray(r.episodes) ? r.episodes : []) {
    const audioUrl = listenAudioUrl(e.audioUrl);
    if (!audioUrl || audioUrl.startsWith("/") || !e.title) continue;   // an episode plays from its https enclosure only
    episodes.push({ id: Number(e.id), title: String(e.title), show: String(e.show || ""), sourceId: Number(e.sourceId), publishedAt: String(e.publishedAt || ""), audioUrl });
  }
  return { episodes };
}

export async function loadListen(db, { crowHome = resolveCrowHome(), now = Date.now() } = {}) {
  const out = { media: "missing", briefing: null, podcasts: null, music: false, radio: null };
  try { out.music = installedBundleIds(crowHome).includes("music"); } catch { out.music = false; }
  if (!mediaInstalled(crowHome)) return out;
  let mod = null;
  try { mod = await mediaModule(crowHome); } catch (err) { warn("Media Hub module load")(err); out.media = "ok"; return out; }
  if (!mod || typeof mod.forYouBriefing !== "function" || typeof mod.forYouEpisodes !== "function") { out.media = "update"; return out; }
  out.media = "ok";
  [out.briefing, out.podcasts] = await Promise.all([
    briefingTile(mod, db, now).catch(warn("briefing")),
    podcastsTile(mod, db).catch(warn("podcasts")),
  ]);
  return out;
}
