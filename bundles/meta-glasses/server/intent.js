/**
 * What a spoken sentence asks for, decided without a model: the camera, memory, or a
 * playback control. Every test here reads the SAME capped text (the first 400 characters,
 * lower case, punctuation to spaces) and compares whole words against fixed phrase lists.
 * There is no pattern built from input and no repetition over input, so no sentence, however
 * long or odd, can make one slow.
 *
 * The capped text and the memory test are the kiosk's own (./voice-shared.js); the camera and
 * playback-control lists below are particular to this endpoint.
 */
import { intentText, INTENT_MAX_CHARS, wantsMemory } from "./voice-shared.js";

/** Re-exported so callers and tests read one module; the definitions are the kiosk's (./voice-shared.js). */
export { intentText, INTENT_MAX_CHARS, wantsMemory };

const anywhere = (t, phrases) => { const padded = ` ${t} `; return phrases.some((p) => padded.includes(` ${p} `)); };
const atEnd = (t, phrases) => phrases.some((p) => t === p || t.endsWith(` ${p}`));

const LOOK_ANYWHERE = [
  "take a photo", "take a picture", "take photo", "snap a photo", "snap a picture", "look at this", "look at that",
  "what am i looking at", "what do you see", "can you see this",
  "toma una foto", "tomar una foto", "saca una foto", "mira esto", "qué ves", "que ves", "qué estoy viendo", "que estoy viendo",
];
const LOOK_AT_END = [
  "what is this", "what s this", "what is that", "what s that", "read this", "read that", "describe this",
  "qué es esto", "que es esto", "lee esto", "describe esto",
];
/** Does the sentence ask for the camera? "What is this" counts only at the end ("what is this song" does not). */
export function wantsLook(transcript) {
  const t = intentText(transcript);
  return !!t && (anywhere(t, LOOK_ANYWHERE) || atEnd(t, LOOK_AT_END));
}

/** Whole-utterance playback controls, and the playback states each one makes sense in. */
const TRANSPORT = [
  { action: "stop", states: ["playing", "paused"], say: "stopped", phrases: ["stop", "stop it", "stop the music", "stop music", "stop playing", "stop playback", "para", "para la música", "para la musica", "detén la música", "deten la musica"] },
  { action: "pause", states: ["playing"], say: "paused", phrases: ["pause", "pause it", "pause the music", "pausa", "pausa la música", "pausa la musica"] },
  { action: "resume", states: ["paused"], say: "resuming", phrases: ["resume", "continue", "unpause", "keep going", "continúa", "continua", "reanuda", "sigue"] },
  { action: "next", states: ["playing"], say: "next_track", phrases: ["next", "skip", "next song", "next track", "skip song", "skip track", "skip this", "siguiente", "siguiente canción", "siguiente cancion", "salta"] },
];
/** → { action, say } when the WHOLE sentence is a control and something is in a state it applies to; else null (the turn goes on). */
export function matchTransport(transcript, playbackState) {
  const t = intentText(transcript);
  if (!t) return null;
  for (const row of TRANSPORT) {
    if (row.phrases.includes(t) && row.states.includes(playbackState)) return { action: row.action, say: row.say };
  }
  return null;
}
