/**
 * How a spoken request is resolved without a model: T0 (a control phrase with a live target),
 * then T1 (an anchored pattern whose slot resolves on this display). Both end in the executor.
 * → { say, events, tier } for the voice turn's fastPaths hook, or null (the model gets the turn).
 * Nothing the server writes into the prompt is ever passed in here: only the plain transcript.
 * Two requests in one sentence are never answered here: the model gets the whole sentence.
 */
import { matchT0 } from "./phrases.js";
import { matchT1, compound } from "./patterns.js";
import { executeIntent } from "./executor.js";

export async function matchSpoken(transcript, ctx) {
  if (compound(transcript)) return null;
  const strict = { ...ctx, strict: true };
  const t0 = matchT0(transcript);
  if (t0) { const r = await executeIntent(t0, strict); if (r) return { say: r.say, events: r.events, tier: "t0", verb: t0.verb }; }
  const t1 = matchT1(transcript, ctx);
  if (t1) { const r = await executeIntent(t1, strict); if (r) return { say: r.say, events: r.events, tier: "t1", verb: t1.verb }; }
  return null;
}
