/**
 * Does a voice prompt fit its model? ONE estimator, used by the voice turn
 * (servers/gateway/voice/turn.js) and, through the runner's assessBot(), by the
 * Kiosk panel's bind-time check — so the panel can never disagree with the turn.
 *
 * Two rules:
 *  - a REQUEST may be sent only when its estimate + PROMPT_MARGIN_TOKENS +
 *    MIN_COMPLETION_TOKENS fits the context (requestFits);
 *  - a fit LEVEL (the full system prompt, or the one without the bound bot's
 *    skill bodies) is chosen on the system message + tool list alone, and must
 *    leave turnReserveTokens(ctx) free for the question, the answer, tool
 *    results and some history. No per-turn text is in that decision, so the
 *    level — and with it the system message — is stable from turn to turn.
 *
 * An unknown context (null) always fits: the caller keeps its old behaviour.
 */

/** ~3.2 characters per token over the serialized request: a deliberate over-estimate. */
export const CHARS_PER_TOKEN = 3.2;
/** Slack kept between prompt + completion and the context. */
export const PROMPT_MARGIN_TOKENS = 128;
/** The smallest completion worth asking for. */
export const MIN_COMPLETION_TOKENS = 64;
/** The most a fit level has to leave free (an 8,192 context reserves exactly this). */
export const TURN_RESERVE_MAX_TOKENS = 1024;

export function estimatePromptTokens(messages, tools = []) {
  return Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length) / CHARS_PER_TOKEN);
}

/** May this request be sent? */
export function requestFits(estTokens, ctx) {
  return !ctx || estTokens + PROMPT_MARGIN_TOKENS + MIN_COMPLETION_TOKENS <= ctx;
}

/** What a fit level leaves free: an eighth of the context, at most 1,024 tokens, never less than a request needs. */
export function turnReserveTokens(ctx) {
  return Math.max(PROMPT_MARGIN_TOKENS + MIN_COMPLETION_TOKENS, Math.min(TURN_RESERVE_MAX_TOKENS, Math.floor(ctx / 8)));
}

/**
 * The fit ladder. `full` is the complete system message; `lean()` builds the one
 * without the bot's skill bodies (only called when `full` does not fit).
 * → { level: "full" | "no_skills" | "too_large", ctx, reserve, est, est_no_skills, system }
 * `system` is the message to send (the lean one for no_skills and too_large).
 */
export async function choosePromptFit({ ctx, tools = [], full, lean }) {
  const est = estimatePromptTokens([{ role: "system", content: full }], tools);
  if (!ctx) return { level: "full", ctx: null, reserve: 0, est, est_no_skills: null, system: full };
  const reserve = turnReserveTokens(ctx);
  if (est + reserve <= ctx) return { level: "full", ctx, reserve, est, est_no_skills: null, system: full };
  const system = String(await lean());
  const estLean = estimatePromptTokens([{ role: "system", content: system }], tools);
  return { level: estLean + reserve <= ctx ? "no_skills" : "too_large", ctx, reserve, est, est_no_skills: estLean, system };
}

/**
 * Drop the oldest saved exchange — the first user message after the system message and
 * everything up to the next user message — and return how many messages went. Never touches
 * messages[0] or anything from `current` (this turn's user message) on; 0 = nothing left to drop.
 */
export function dropOldestExchange(messages, current) {
  const stop = messages.indexOf(current);
  if (stop <= 1) return 0;
  let end = 2;
  while (end < stop && messages[end].role !== "user") end++;
  messages.splice(1, end - 1);
  return end - 1;
}
