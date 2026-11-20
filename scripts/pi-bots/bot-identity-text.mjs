/**
 * The identity check's exact words, in a module of their own.
 *
 * The boot line quotes one sentence ("Bots can't read Crow's identity file"),
 * and the exact wording is load-bearing: the boot log line, its tests and the
 * docs all quote it. It lives here, with no imports at all, because TWO
 * modules print that line and one of them must be able to print it when the
 * other cannot even be loaded:
 *
 *   - bot-identity-guard.mjs (the check, and every verdict it can produce);
 *   - servers/gateway/boot/bot-identity-boot.js (the boot wiring, which has to
 *     print exactly one `[containment]` line per gateway even when the check
 *     module itself fails to import — the case where importing the sentence
 *     FROM the guard would be the one thing that cannot work).
 *
 * Re-exported by the guard, so `import { BOT_IDENTITY_TEXT } from
 * "./bot-identity-guard.mjs"` keeps working exactly as before.
 */

/** The exact sentence, with the answer appended by formatBotIdentityLine. */
export const BOT_IDENTITY_TEXT = "Bots can't read Crow's identity file";

/**
 * The prefix of the one finding a check that could NOT RUN produces. It is
 * deliberately not an exposure: nothing was measured, so nothing may be
 * reported as readable (a bug in the check is not an escaped bot).
 */
export const COULD_NOT_RUN_PREFIX = "the check could not run: ";