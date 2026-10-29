/**
 * The bot-defs generation: a process-wide counter bumped on every bot-def save (pibots:defs-changed), so a
 * cache keyed on it (turn.js's bot cache, crow-voice.js createVoiceBotLoader) drops a just-saved setting at
 * once. Its own module so turn.js and handoff.js can both read it without importing each other.
 */
let generation = 0;
const watched = new WeakSet();

/** The current generation. */
export function botDefsGeneration() {
  return generation;
}

/** One more save seen. */
export function bumpBotDefsGeneration() {
  generation++;
}

/** Bumps the generation on every `pibots:defs-changed` from `bus`; subscribes once per bus. */
export function watchBotDefs(bus) {
  if (!bus || typeof bus.on !== "function" || watched.has(bus)) return;
  watched.add(bus);
  bus.on("pibots:defs-changed", bumpBotDefsGeneration);
}
