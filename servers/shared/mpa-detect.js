/**
 * Shared MPA-host detection — the single source of truth for the rule that was
 * previously copied verbatim into multiple readers (bot-runtime-flag.js's panel
 * reader and runtime-gate.mjs's sync runner gate). Those copies had to stay
 * character-for-character identical or the dashboard banner and the actual
 * runtime gate would disagree; this module removes that hazard.
 *
 * Pure (env + regex, no DB, no side effects) so it imports cleanly into both
 * the async ESM dashboard readers and the sync .mjs bot runner.
 *
 * The MPA gateway runs with CROW_HOME / CROW_DATA_DIR under ~/.crow-mpa.
 * General installs use ~/.crow and won't match.
 */

/** Auto-detect the MPA host from its data-dir convention (~/.crow-mpa). */
export function isMpaHost() {
  const probe = `${process.env.CROW_HOME || ""}|${process.env.CROW_DATA_DIR || ""}`;
  return /\.crow-mpa(\/|\b|$)/.test(probe);
}
