/**
 * Fix-it detector: an add-on that could not run inside its wall.
 *
 * The gateway raises this event with the id it refused, one line saying why,
 * and the ref of an in-memory failure record. Nothing here reads a path or a
 * stored value: the reason arrives already built (scripts/addon-sandbox/
 * failures.mjs) and the card carries the ref only, which is what the remedy
 * needs to find the add-on the owner is answering about.
 *
 * One card per add-on (dedupKey `addon-wall:<id>`), and the count on it says
 * how many times the failure repeated.
 */

export const SOURCE = "addon-wall";
export const EVENT = "addon-wall-failed";
export const TITLE = "An add-on could not run inside its wall";
/** The fallback reason when an event carries none. */
export const DEFAULT_REASON = "could not run inside its wall";

/** An add-on id is one lowercase slug. */
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** A record ref is 16 random bytes, hex. */
const REF_RE = /^[0-9a-f]{32}$/;

/** The card's body line for `id` and `reason`. */
export function whyText(id, reason) {
  return `${id} ${reason}. It stays off until you choose.`;
}

export default {
  source: SOURCE,
  events: [EVENT],
  async onEvent(eventName, payload, store) {
    if (eventName !== EVENT) return null;
    const id = payload?.id;
    const ref = payload?.ref;
    // A payload that is not one of ours names no add-on and cannot be answered.
    if (typeof id !== "string" || !ADDON_ID_RE.test(id)) return null;
    if (typeof ref !== "string" || !REF_RE.test(ref)) return null;
    const reason = typeof payload.reason === "string" && payload.reason ? payload.reason : DEFAULT_REASON;

    await store.upsertItem({
      source: SOURCE,
      dedupKey: `${SOURCE}:${id}`,
      title: TITLE,
      why: whyText(id, reason),
      severity: "warn",
      remedies: [
        // The id lives in the failure record this ref names, never in the args.
        { actionId: "addon-unwall", kind: "instant", label: "Run without the wall", args: { ref } },
        { actionId: "addon-keep-off", kind: "instant", label: "Keep it off", args: {} },
      ],
      context: { addonId: id },
    });
    return { id };
  },
};