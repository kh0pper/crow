/**
 * Every HANDOFF_* constant of the voice hand-off, in one place. Its one import is tool-families.js, which
 * imports nothing, so any voice module can read it without an import cycle. Times are milliseconds.
 *
 * VOICE_MODE_WINDOW_MS is not here: it belongs to voice-memory.js and is imported from there.
 */
import { normalizeIntentLists } from "./tool-families.js";

/** How long a spoken proposal waits for its yes (the pending store, and a `proposed` row's expires_at). */
export const HANDOFF_PROPOSAL_TTL_MS = 120_000;
/** How long a kiosk proposal sent to the phone stays confirmable (an `awaiting_phone` row's expires_at). */
export const HANDOFF_PHONE_TTL_MS = 30 * 60_000;

/** A bot's one-line capability summary in the crow_handoff tool description. */
export const HANDOFF_SUMMARY_MAX_CHARS = 160;
/** At most this many bots are offered as hand-off targets. */
export const HANDOFF_MAX_CANDIDATES = 8;

/** The task line stored on a hand-off row, and the verbatim speech (`asked`) beside it. */
export const HANDOFF_TASK_MAX_CHARS = 300;
export const HANDOFF_ASKED_MAX_CHARS = 1000;

/** How long a yes waits for the detached spawn before it says "starting up" instead of "on it". */
export const HANDOFF_START_BUDGET_MS = 3000;
/** A hand-off row still `starting` this long after its yes (decided_at), and not in flight, is recovered. */
export const HANDOFF_STARTING_STUCK_MS = 10 * 60_000;
/** A stop row left `starting` (a crash inside decideStop) this long after its decision is failed. */
export const HANDOFF_STOP_STUCK_MS = 5 * 60_000;
/** A `waiting-user` session with no result and no question this long is reconciled to `quiet`. */
export const HANDOFF_QUIET_AFTER_MS = 30 * 60_000;
/** Declined and expired rows keep the verbatim speech (`asked`) this long; the task line stays. */
export const HANDOFF_ASKED_RETAIN_MS = 7 * 24 * 3600_000;

export const HANDOFF_KINDS = Object.freeze(["handoff", "stop"]);
/** No CHECK in the table: the store validates against this list. `partial` is deliberately absent (only a
 * final report ends a hand-off), and `quiet` (a session paused with no result) is open, not ended. */
export const HANDOFF_STATUSES = Object.freeze([
  "proposed", "awaiting_phone", "starting", "started", "queued",
  "declined", "expired", "failed", "done", "stopped", "quiet",
]);
/** The statuses that count as an open hand-off (openForDevice, openPersonal). */
export const HANDOFF_OPEN = Object.freeze(["starting", "started", "queued", "quiet"]);
/** The languages a row's async lines are spoken in. */
export const HANDOFF_LANGS = Object.freeze(["en", "es"]);

/**
 * The words that name a NEW target for a hand-off ("give it to writer", "mejor a writer", "instead"): a
 * yes carrying one is a correction, not a plain yes (pending.js), and a request carrying one asks for a bot.
 * HANDOFF_TARGET_WORDS is the raw en/es list; HANDOFF_TARGET_PHRASES is it as listMatches reads it.
 */
export const HANDOFF_TARGET_WORDS = Object.freeze({
  en: Object.freeze(["give it to", "send it to", "pass it to", "hand it to", "instead", "rather"]),
  es: Object.freeze(["en vez", "en lugar", "mejor a", "daselo a", "pasaselo a"]),
});
export const HANDOFF_TARGET_PHRASES = Object.freeze(normalizeIntentLists(HANDOFF_TARGET_WORDS).map((p) => Object.freeze(p)));
