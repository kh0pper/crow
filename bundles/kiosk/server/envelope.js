/**
 * The music library's own tools on a display. They were written for a wearable's voice loop and
 * answer with a "stream envelope": { _audio_stream: { url, codec, auth: "funkwhale", queue? }, prose },
 * or { _audio_stream_control: { action }, prose }. On a display the stream joins the media
 * session, and the model reads only one sentence.
 *
 * A tool result is text that somebody else wrote. So an envelope is honoured ONLY when all of
 * this holds — there is no other branch that plays anything:
 *   1. the tool that really ran is one of the library's playback tools, by name (ENVELOPE_PLAY_TOOLS,
 *      ENVELOPE_CONTROL_TOOLS). Any other tool's result is left exactly as it is: a web page or a
 *      query result that happens to contain an envelope plays nothing.
 *   2. every item says auth: "funkwhale";
 *   3. every item's address is on the configured library origin — the one the display's adapter
 *      calls, or the public one the tools were given — scheme, host and port all equal;
 *   4. its path is exactly the listen path, with at most ?to=<format>.
 * Even then the address is not used. The track's listen id is taken out of it and the stream is
 * built again by the adapter (funkwhale.js playableFromListenUrl): on the origin the adapter
 * calls, with the adapter's credential and hop policy. Third-party text can never make a display
 * fetch an address of its choosing, and the credential can go nowhere but the library.
 *
 * Known limit (accepted): trust is by the effective tool NAME. Another MCP server that defines a tool
 * called fw_play could make a display play a library track of its choosing — only a listen id on the
 * configured library is ever kept, so the worst case is a song from this library, never an address.
 *
 * Wired through the voice turn's opts.onToolResult. media is the display's media session:
 *   media.play(deviceId, playables, meta), media.pause / resume / stop / next (deviceId), media.active?(deviceId)
 */
import { cleanName } from "./sources/music-match.js";

export const ENVELOPE_PLAY_TOOLS = Object.freeze(["fw_play", "fw_play_album"]);
/** tool → the one transport verb its result may ask for. */
export const ENVELOPE_CONTROL_TOOLS = Object.freeze({ fw_pause: "pause", fw_resume: "resume", fw_stop_playback: "stop", fw_next_track: "next" });
/** Model-facing lines (English, like every tool result). */
export const ENVELOPE_REFUSED = "Nothing is playing: playback could not start on this display. Tell the user plainly that you could not play it.";
export const ENVELOPE_NOTHING_PLAYING = "Nothing is playing on this display.";
const MAX_PARSE = 256 * 1024;
const MAX_ITEMS = 50;
const sentence = (s) => (typeof s === "string" ? s.slice(0, 400).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "");

/**
 * media     the display's media session (see above)
 * deviceId  the display
 * music     the library adapter (its playableFromListenUrl decides what is a library stream)
 * meta      () → what media.play gets beside the playables (e.g. { maxVolume })
 * → onToolResult({ name, tool, result, isError }) for the voice turn: a replacement sentence, or undefined to leave the result alone.
 */
export function createEnvelopeHandler({ media, deviceId, music, meta = () => ({}) }) {
  return async function onToolResult({ name, tool, result, isError } = {}) {
    const ran = typeof tool === "string" && tool ? tool : name;
    const verb = Object.hasOwn(ENVELOPE_CONTROL_TOOLS, ran) ? ENVELOPE_CONTROL_TOOLS[ran] : null;
    if (!verb && !ENVELOPE_PLAY_TOOLS.includes(ran)) return undefined;
    if (isError === true || typeof result !== "string" || result.length > MAX_PARSE || !result.includes('"_audio_stream')) return undefined;
    let parsed;
    try { parsed = JSON.parse(result); } catch { return undefined; }
    if (!parsed || typeof parsed !== "object") return undefined;
    const prose = sentence(parsed.prose);
    if (verb) {
      if (parsed._audio_stream_control?.action !== verb) return undefined;
      // The tool itself always answers "ok"; the display knows whether anything is playing.
      if (typeof media.active === "function" && media.active(deviceId) !== true) return ENVELOPE_NOTHING_PLAYING;
      media[verb](deviceId);
      return prose || "Okay.";
    }
    const env = parsed._audio_stream;
    if (!env || typeof env !== "object") return undefined;
    const items = [{ url: env.url, auth: env.auth, title: parsed.title, artist: parsed.artist }, ...(Array.isArray(env.queue) ? env.queue.slice(0, MAX_ITEMS - 1) : [])];
    const playables = [];
    for (const it of items) {
      const p = it && it.auth === "funkwhale" ? music?.playableFromListenUrl?.(it.url, { title: it.title, artist: it.artist }) : null;
      if (!p) return ENVELOPE_REFUSED;                 // one item that is not a library stream refuses all of it: never a half-trusted queue
      playables.push(p);
    }
    try { media.play(deviceId, playables, { ...meta(), title: cleanName(parsed.album) || playables[0].title }); } catch { return ENVELOPE_REFUSED; }
    return prose || "Playing.";
  };
}
