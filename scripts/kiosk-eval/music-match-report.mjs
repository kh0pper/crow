#!/usr/bin/env node
/**
 * Match report for the display's music source (operators; read-only).
 *
 * Lists the library's album titles, artist names and genres (GET requests only), says each one as
 * speech would give it — no accents, no punctuation, lower case — and runs the display's own
 * matcher on it. Prints COUNTS ONLY, as JSON: no name, no address, and never the token.
 *
 *   CROW_MUSIC_BASE=http://127.0.0.1:<port> CROW_MUSIC_STORAGE_ORIGIN=http://<storage host>:<port> \
 *   CROW_MUSIC_ADDONS_FILE=<an mcp-addons.json holding the funkwhale entry> node scripts/kiosk-eval/music-match-report.mjs
 *
 * The token is read from that file inside this process: it is never on a command line or in a
 * shell variable. (CROW_MUSIC_TOKEN still works for tests; do not use it by hand.)
 *
 * Reading the result: albums.unique_resolved should equal albums.unique_total less
 * unique_to_artist (an album titled like its artist plays the artist, which includes it);
 * albums.shared.other should be 0; genres.resolved should equal genres.total; artists.resolved
 * should be at least 98 % of artists.total. albums.no_track_count above 0 means the server did not
 * report track counts, and shared titles could not be told apart.
 *
 * Exit: 0 printed; 1 the library could not be read (the reason is on stderr); 2 a setting is missing.
 */
import { readFileSync } from "node:fs";
import { createMusicSource } from "../../bundles/kiosk/server/sources/funkwhale.js";

const NAMES = { base: "CROW_MUSIC_BASE", token: "CROW_MUSIC_TOKEN", storageOrigin: "CROW_MUSIC_STORAGE_ORIGIN" };
const settings = Object.fromEntries(Object.entries(NAMES).map(([k, name]) => [k, process.env[name] || ""]));
if (process.env.CROW_MUSIC_ADDONS_FILE) {
  try { settings.token = String(JSON.parse(readFileSync(process.env.CROW_MUSIC_ADDONS_FILE, "utf8"))?.funkwhale?.env?.FUNKWHALE_ACCESS_TOKEN || ""); }
  catch { console.error("CROW_MUSIC_ADDONS_FILE could not be read as an add-on file"); process.exit(2); }
}
const source = createMusicSource({ config: () => settings, autoStart: false, timeoutMs: 30_000 });
if (!source.available()) {
  const missing = Object.entries(NAMES).filter(([k]) => !settings[k]).map(([k, name]) => (k === "token" ? "CROW_MUSIC_ADDONS_FILE (or CROW_MUSIC_TOKEN)" : name));
  console.error(missing.length ? `Missing: ${missing.join(", ")}` : `Not usable as given: ${NAMES.base} and ${NAMES.storageOrigin} must be plain http(s) origins.`);
  process.exit(2);
}
try {
  const report = await source.matchReport();
  const { warm, artists_complete, albums, artists, genres, playlists } = source.indexState();
  console.log(JSON.stringify({ index: { warm, artists_complete, albums, artists, genres, playlists }, ...report }, null, 2));
} catch (err) {
  // The adapter's errors name no address and no credential.
  console.error(`The music library could not be read: ${err?.code || "error"}`);
  process.exitCode = 1;
} finally {
  source.stop();
}
