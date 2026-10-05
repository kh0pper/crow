/**
 * Which tool results may start or steer audio on a glasses session.
 *
 * A tool result is model-adjacent text: a fetch tool or a data query can return whatever a
 * third party wrote. So an audio envelope is obeyed ONLY when it comes from one of the music
 * add-on's own tools, has the expected shape, and names a credential rule the gateway knows.
 * The address inside it is still not trusted: the relay requests it only if it is the
 * configured music server's listen path (servers/gateway/media/pinned-upstream.js).
 */
export const STREAM_TOOLS = Object.freeze(["fw_play", "fw_play_album"]);
export const CONTROL_TOOLS = Object.freeze(["fw_stop_playback", "fw_pause", "fw_resume", "fw_next_track"]);
export const CONTROL_ACTIONS = Object.freeze(["stop", "pause", "resume", "next"]);
export const MAX_ENVELOPE_CHARS = 64 * 1024;
export const MAX_QUEUE = 200;
/** What the model reads when an envelope is not obeyed (never the envelope itself). */
export const NOT_STARTED = "Playback did not start. Tell the user it could not be played, then end your turn.";

const CODECS = new Set(["mp3", "ogg", "opus", "aac", "flac"]);
const PEER_AUTH = /^crow-peer:[A-Za-z0-9_-]{1,128}$/;
const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const authOk = (a) => a === "funkwhale" || (typeof a === "string" && PEER_AUTH.test(a));

function streamItem(e) {
  if (!e || typeof e !== "object" || typeof e.url !== "string" || e.url.length > 2048) return null;
  if (!CODECS.has(e.codec) || !authOk(e.auth)) return null;
  return {
    url: e.url, codec: e.codec, auth: e.auth,
    sample_rate: Number.isFinite(e.sample_rate) ? e.sample_rate : null,
    channels: Number.isFinite(e.channels) ? e.channels : null,
    title: text(e.title, 200), artist: text(e.artist, 200), artworkUrl: text(e.artwork_url ?? e.artworkUrl, 2048),
  };
}

/**
 * → null: not an envelope, pass the result through unchanged.
 * → { kind: "refused", say }: envelope-shaped, but not from a tool that may send one, or malformed.
 * → { kind: "control", action, say }
 * → { kind: "stream", item, queue, say }: item and queue entries are { url, codec, auth, sample_rate, channels, title, artist, artworkUrl }.
 */
export function readEnvelope(toolName, result) {
  if (typeof result !== "string" || result.length > MAX_ENVELOPE_CHARS) return null;
  if (!result.includes('"_audio_stream')) return null;
  let parsed;
  try { parsed = JSON.parse(result); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const hasStream = Object.hasOwn(parsed, "_audio_stream");
  const hasControl = Object.hasOwn(parsed, "_audio_stream_control");
  if (!hasStream && !hasControl) return null;
  const refused = { kind: "refused", say: NOT_STARTED };
  const say = text(parsed.prose, 300);
  if (hasControl) {
    const action = parsed._audio_stream_control?.action;
    if (!CONTROL_TOOLS.includes(toolName) || !CONTROL_ACTIONS.includes(action)) return refused;
    return { kind: "control", action, say: say || "Done." };
  }
  if (!STREAM_TOOLS.includes(toolName)) return refused;
  const env = parsed._audio_stream;
  const item = streamItem({ ...env, title: parsed.title, artist: parsed.artist, artwork_url: parsed.artwork_url });
  if (!item) return refused;
  const queue = [];
  if (env.queue != null) {
    if (!Array.isArray(env.queue) || env.queue.length > MAX_QUEUE) return refused;
    for (const q of env.queue) {
      const qi = streamItem(q);
      if (!qi) return refused;
      queue.push(qi);
    }
  }
  return { kind: "stream", item, queue, say: say || "Playing." };
}
