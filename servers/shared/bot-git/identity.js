/**
 * Per-bot git access: the commit identity a bot's git uses, and the
 * `gitconfig` Crow generates for it.
 *
 *   [user]
 *       name = "<display name> (Crow bot)"
 *       email = noreply+<bot_id>@crow-bot.invalid
 *
 * The address is ALWAYS `noreply+<bot_id>@crow-bot.invalid` (operator ruling
 * R6, 2026-11-12): `crow-bot.invalid` is an RFC 2606 reserved TLD that can
 * never be delivered, so a commit pushed to a forge cannot leak where it came
 * from or reach a real mailbox. No instance host name, gateway URL, tailnet
 * name or machine name is ever part of it — which is also why this module
 * reads no environment and imports neither node:os nor the gateway's
 * self-address helper.
 *
 * The display name is bot-definition text, so it is sanitised before it lands
 * in a config file: control characters (newlines included) are removed, then
 * `\` and `"` are escaped for the quoted value, then it is capped. Escaping
 * happens before the cap and a cap never leaves a dangling escape or half a
 * UTF-16 surrogate pair, so a name can neither add a `[section]` nor a
 * `sshCommand` line, and the file stays valid UTF-8.
 */
import { isValidGitBotId } from "./paths.js";

/** The never-deliverable domain every bot commit address uses (RFC 2606). */
export const NOREPLY_DOMAIN = "crow-bot.invalid";

/** Longest display-name fragment Crow writes into the generated config. */
const MAX_NAME_CHARS = 100;

/**
 * The bot's commit address. Takes no host input of any kind, by ruling: the
 * domain is the same on every instance.
 */
export function noReplyEmail({ botId } = {}) {
  if (!isValidGitBotId(botId)) throw new Error("git identity: invalid bot id");
  return "noreply+" + botId + "@" + NOREPLY_DOMAIN;
}

function namePart(displayName, botId) {
  const raw = typeof displayName === "string" ? displayName : "";
  // Control characters first: a newline or a tab could start a new line.
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  // Then escape for the double-quoted value git expects.
  let escaped = stripped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (escaped.length > MAX_NAME_CHARS) {
    escaped = escaped.slice(0, MAX_NAME_CHARS);
    // Never split a UTF-16 surrogate pair: a cut between the high and the low
    // half would leave a lone surrogate, which is not text (and cannot be
    // encoded to UTF-8 without becoming a replacement character).
    const last = escaped.charCodeAt(escaped.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) escaped = escaped.slice(0, -1);
    // Never end on half an escape: `\"` cut in two would escape our own
    // closing quote.
    while (escaped.endsWith("\\")) escaped = escaped.slice(0, -1);
  }
  escaped = escaped.trim();
  return escaped || botId;
}

/**
 * The generated `gitconfig` text. The commit address is ALWAYS
 * `noReplyEmail({ botId })`: there is no caller-supplied email, and a supplied
 * `email` that is not exactly that address throws instead of landing in a bot's
 * config (operator ruling R6: the domain names no instance, host or tailnet).
 */
export function gitconfigText({ displayName, botId, ...rest } = {}) {
  if (!isValidGitBotId(botId)) throw new Error("git identity: invalid bot id");
  const mail = noReplyEmail({ botId });
  if (rest.email !== undefined && rest.email !== null && rest.email !== mail) {
    throw new Error("git identity: the commit address is fixed at " + mail);
  }
  return "[user]\n\tname = \"" + namePart(displayName, botId) + " (Crow bot)\"\n\temail = " + mail + "\n";
}