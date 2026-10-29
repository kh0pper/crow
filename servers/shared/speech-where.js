/**
 * Where a speech (STT/TTS) profile runs, in the same words as a chat model:
 * "here", "other_box", "cloud", "unproven".
 *
 * The hosted adapters always count as cloud, whatever endpoint the profile
 * names (a proxy in front of a hosted service still sends the audio there).
 * A self-hosted adapter's endpoint goes through whereItRuns on a synthetic
 * provider row, so the same address rules apply as for chat models; an empty
 * endpoint means the adapter's own loopback default.
 */
import { whereItRuns } from "./model-roles.js";
import { hostnameOf } from "./provider-host.js";

/** Hosted adapters and the endpoint each uses when the profile names none (null: the profile must name one). */
const HOSTED = Object.freeze({
  elevenlabs: "https://api.elevenlabs.io",
  azure: null,
  openai: "https://api.openai.com/v1",
  deepgram: "https://api.deepgram.com",
  groq: "https://api.groq.com/openai/v1",
  edge: "https://speech.platform.bing.com",
});

/** Self-hosted adapters' defaults (they use localhost; written as the loopback literal). */
const SELF_HOST_DEFAULT = Object.freeze({
  piper: "http://127.0.0.1:5000",
  kokoro: "http://127.0.0.1:8880",
  whispercpp: "http://127.0.0.1:9000",
  fasterwhisper: "http://127.0.0.1:8000/v1",
});

const isHosted = (provider) => Object.prototype.hasOwnProperty.call(HOSTED, provider);

function endpointOf(profile) {
  const provider = profile?.provider;
  // Edge ignores the profile's endpoint.
  if (provider === "edge") return HOSTED.edge;
  const own = typeof profile?.baseUrl === "string" ? profile.baseUrl.trim() : "";
  if (own) return own;
  if (isHosted(provider)) return HOSTED[provider];
  return SELF_HOST_DEFAULT[provider] || null;
}

/**
 * @param {{provider?:string, baseUrl?:string}} profile
 * @param {{ownAddrs?:Set<string>, localMarks?:object}} [opts]
 * @returns {"here"|"other_box"|"cloud"|"unproven"|"missing"}
 */
export function speechProfileWhere(profile, { ownAddrs, localMarks } = {}) {
  if (!profile || typeof profile.provider !== "string") return "missing";
  if (isHosted(profile.provider)) return "cloud";
  const baseUrl = endpointOf(profile);
  if (!baseUrl) return "unproven";
  const row = { id: "speech-profile", baseUrl, models: [{ id: "speech" }] };
  return whereItRuns("speech-profile/speech", { providers: [row], localMarks, ...(ownAddrs ? { ownAddrs } : {}) });
}

/** The host a profile's audio goes to (null when it cannot be named). */
export function speechProfileHost(profile) {
  return hostnameOf(endpointOf(profile)) || null;
}

/** "Proven local": here or on another of the user's boxes. */
export function isSpeechWhereLocal(where) {
  return where === "here" || where === "other_box";
}
