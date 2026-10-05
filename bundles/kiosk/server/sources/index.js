/**
 * Play sources: where "play <something>" is looked up. Every source is an ADAPTER with the same
 * interface — contract version 1 — so the resolver (play.js) treats a list of station presets and a
 * library server alike, and a source can be added without touching the resolver.
 *
 *   source = { kind,                         "radio" | "news" | "music" (tools.js PLAY_SOURCES)
 *              contract: 1,
 *     available() → boolean                  configured on this instance (not "reachable"). Synchronous.
 *     search(what, { explicit, lang }) → Candidate[]
 *                                            ranked; [] means not found. `explicit`: the request named this
 *                                            source ("… on the radio"), so it may be more generous.
 *                                            May throw SourceUnavailable.
 *     queue(candidate, { limit }) → Playable[]   everything the candidate stands for, in play order (limit ≤ 50)
 *     resolve(candidate) → Playable          the first of queue()
 *     choose(candidates, utterance) → Candidate | null
 *                                            after "Which one?": the one of THESE candidates the words name, or null
 *   }
 *   search, queue and resolve may return a promise; available and choose may not.
 *
 *   Candidate = { id, kind, title, subtitle?, confident, group? }
 *       confident: play it without asking (an exact name, or the only thing it could be). A source
 *       decides this itself. Candidates never carry an address.
 *   Playable  = { kind, id, title, subtitle?, duration_sec?, art?, form: "audio", codec?, source,
 *                 upstream: { url, headers?, hop } }
 *       upstream never leaves the server: the page gets a display ticket. `hop` is the relay's policy
 *       for this upstream (relay.js); `headers` may carry Authorization and nothing else.
 *
 *   class SourceUnavailable extends Error { code: "unreachable" | "unauthorized" | "timeout" }
 *       "I know where to look and cannot look right now" — never used for "not found". The resolver
 *       speaks a different line for it than for a miss.
 *
 * `what` is the only speech- or model-derived input a source receives. It may reach string
 * comparison and URL query encoding, and nothing else: never a fetch target, never a path.
 */
export const SOURCE_CONTRACT = 1;
const UNAVAILABLE_CODES = Object.freeze(["unreachable", "unauthorized", "timeout"]);
const METHODS = Object.freeze(["available", "search", "queue", "resolve", "choose"]);

export class SourceUnavailable extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "SourceUnavailable";
    this.code = UNAVAILABLE_CODES.includes(code) ? code : "unreachable";
  }
}

/** Why an object is not a contract-1 source, or null when it is one. */
export function sourceProblem(s) {
  if (!s || typeof s !== "object") return "not an object";
  if (typeof s.kind !== "string" || !s.kind) return "no kind";
  if (s.contract !== SOURCE_CONTRACT) return `contract ${s.contract} (this build speaks ${SOURCE_CONTRACT})`;
  for (const m of METHODS) if (typeof s[m] !== "function") return `no ${m}()`;
  return null;
}

/**
 * The sources this instance has, in "auto" order. A source of another contract version is left out
 * (and reported once through `log`), never half-used.
 */
export function createSourceRegistry(sources, { log = () => {} } = {}) {
  const all = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    const why = sourceProblem(s);
    if (why) log(`[kiosk] play source ${String(s?.kind || "?").slice(0, 20)} left out: ${why}`);
    else all.push(s);
  }
  /** The sources that are configured right now. A source whose available() throws is simply not offered. */
  const available = () => all.filter((s) => { try { return s.available() === true; } catch { return false; } });
  return { all: () => all.slice(), available, kinds: () => [...new Set(available().map((s) => s.kind))] };
}
