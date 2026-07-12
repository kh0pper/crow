/**
 * Resolve WHO advertised a bot — server-side, from the directory, never from the form
 * (spec `2026-07-12-advertised-contact-prune-design.md` §3 F5).
 *
 * `contacts.advertised_by_instance_id` is the FACT the garbage collector acts on: when
 * that instance stops advertising this bot, the zero-message contact is pruned. So the
 * value must be authoritative and unspoofable. A caller that took it from the POST body
 * would let anyone who can reach the form stamp an arbitrary contact prunable — or stamp
 * a live one with a bogus advertiser and have it pruned on the next render.
 *
 * Unresolvable (peer unreachable, bot in nobody's list, malformed code) ⇒ `null` ⇒ NULL
 * provenance ⇒ the contact is structurally NEVER prunable. That is the fail-safe
 * direction, and it is the ONLY fallback — never a value from the request.
 */

import { getBotDirectory } from "../panels/messages/data-queries.js";
import { parseBotInviteCode } from "../../../sharing/identity.js";

/**
 * @param {object} db async db client ({ execute })
 * @param {string} inviteCode the bot invite code the user clicked "Add" on
 * @returns {Promise<string|null>} the advertising instance's id, or null. Never throws.
 */
export async function resolveAdvertisedByInstanceId(db, inviteCode) {
  try {
    const bot = parseBotInviteCode(String(inviteCode || "").trim());
    // getBotDirectory's `pubkeys` Sets hold trailing-64 lowercase x-only keys
    // (validateBot strips the 02/03 compressed prefix). Match that shape exactly.
    const x = String(bot.secp256k1Pubkey || "").slice(-64).toLowerCase();
    if (x.length !== 64) return null;

    // R3-MAJOR-6: `{ prune: false }` is MANDATORY here, and is passed explicitly even
    // though it is already the default. getBotDirectory garbage-collects stale
    // advertised contacts as a SIDE EFFECT of a read when asked to — so a pruning read
    // on this path would make clicking "Add" durably DELETE other contacts.
    const { perInstance } = await getBotDirectory(db, { prune: false });

    // `ok` (the peer answered with a parseable list) is the right bar — `complete` is a
    // licence to DELETE, not to attribute. A truncated list that still positively
    // contains this bot is proof enough of who advertised it.
    for (const [instanceId, info] of perInstance || []) {
      if (info?.ok && info.pubkeys?.has(x)) return instanceId;
    }
  } catch { /* unresolvable ⇒ NULL provenance ⇒ never prunable */ }
  return null;
}
