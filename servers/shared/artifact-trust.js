/**
 * The artifact trust rule, in one place (Task 4.5, engineering question 4). The
 * Artifacts bundle's store.js re-exports these, so the bundle and core (Make's
 * previews) answer the same way.
 */

/** A trust flag is CLEAN only when it is an explicit 0 (number, bigint or the string "0");
 *  NULL, missing, corrupt or any other value, including " ", false and "0.0", reads as
 *  untrusted (fail closed; security review: no NULL-as-clean). */
export function flagUntrusted(x) { return !(x === 0 || x === 0n || x === "0"); }

/** Tainted = made from non-owner text (or derived from such a version) and
 *  not yet approved by the owner. A missing version is tainted. */
export function isTainted(v) { return !v || (flagUntrusted(v.untrusted_input) && !v.trust_cleared_at); }
