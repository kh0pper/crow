/**
 * secret-patterns.js — THE list of secret shapes, in one place.
 *
 * The same patterns answer two different questions:
 *
 *   - CI / pre-push (scripts/check-public-hygiene.mjs): "does a TRACKED FILE
 *     carry a credential?" — the repository is public, so a committed key is a
 *     leak;
 *   - the history sweep (servers/shared/history/sweep.js): "does a STORED
 *     VERSION carry a credential?" — a memory, a section or a post may hold a key
 *     by accident, and version history would otherwise keep a second copy of it
 *     forever.
 *
 * They lived in the CI script, and the runtime imported that script. That is
 * backwards: a server importing a CI file pulls `node:child_process`, the
 * allowlist file and the whole scan machinery into the gateway's boot path, and
 * it makes the runtime depend on a file that is free to change shape with the CI
 * job. So the list lives here, in the runtime's tree, and both doors import it.
 *
 * EVERY PATTERN IS GLOBAL (`/g`): the sweep rewrites with String#replace (which
 * resets lastIndex itself, so one shared object is safe across rows and runs) and
 * the scanner iterates with matchAll (which clones the regex). Neither mutates
 * the shared object's state, and neither may: a pattern list is read-only data.
 *
 * A NOTE ON SPELLING. These patterns are also scanned BY the hygiene check (this
 * file is a tracked file in a public repository). They are written as narrow
 * character-class forms — `gh[opsur]_`, `[A-Za-z0-9]{36}` — precisely so the
 * source text never reads like a credential the scanner itself would flag. Keep
 * that shape when adding one: a literal example key in this file would fail the
 * very check it feeds.
 *
 * @type {ReadonlyArray<[string, RegExp]>} [human name, pattern]
 */
export const SECRET_PATTERNS = Object.freeze([
  ["github token", /\bgh[opsur]_[A-Za-z0-9]{36}\b/g],
  ["github fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}/g],
  ["sk- api key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["stripe live key", /\b[rs]k_live_[A-Za-z0-9]{24,}/g],
  ["tailscale auth key", /\btskey-[A-Za-z0-9-]{10,}/g],
  ["aws access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["google oauth client secret", /\bGOCSPX-[A-Za-z0-9_-]{28}\b/g],
  ["google oauth access token", /\bya29\.[A-Za-z0-9_-]{20,}/g],
  ["brave search key", /\bBSA[A-Za-z0-9_-]{24,}\b/g],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["hugging face token", /\bhf_[A-Za-z]{34}\b/g],
  ["gitlab token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["nostr secret key", /\bnsec1[02-9ac-hj-np-z]{58}\b/g],
  ["discord webhook", /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{60,}/g],
  ["pem private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g],
  ["pgp private key", /-{5}BEGIN PGP PRIVATE KEY BLOCK-{5}/g],
]);