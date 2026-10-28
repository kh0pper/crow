// Crow shared @bot grammar, moved from the artifacts bundle (P6, spec §10: `@bot` on a resolved
// thread reopens it). The owner's comment names a bot; that ONE thread goes to
// it as a mention round through the Send route's own path (panel/routes.js
// startOwnerRound), so trust, taint and target checks are the Send round's.
//
// Identity rules: the bot comes only from an ENABLED bot definition matched
// here, never from the request body; the voice bot is never matched; and only
// the owner's words (actor.kind "session") can start anything — a bot's or a
// contact's `@x` is just text.

export const MENTION_RE = /(?:^|\s)@([A-Za-z0-9][A-Za-z0-9_-]{0,63})\b/;

/** Every distinct `@` token (same grammar as parseMention), in order of first appearance. */
export function parseMentions(text) {
  if (typeof text !== "string") return [];
  const re = new RegExp(MENTION_RE.source, "g");
  const out = [];
  for (const m of text.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The first `@` token at a word start, or null ("me@x.org" is not one). */
export function parseMention(text) {
  if (typeof text !== "string") return null;
  const m = MENTION_RE.exec(text);
  return m ? m[1] : null;
}

let voiceBotId = null;
async function voiceBot() {
  if (voiceBotId) return voiceBotId;
  try { voiceBotId = (await import("./voice-bot.js")).CROW_VOICE_BOT_ID || "crow.voice"; }
  catch { voiceBotId = "crow.voice"; }   // an older core: the id it has always had
  return voiceBotId;
}

const squash = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

/**
 * An enabled bot whose id is exactly `token`, else whose display name (spaces
 * removed) equals it case-insensitively. Never the voice bot. A missing
 * pi_bot_defs table (no Bot Builder) reads as no bot.
 * @returns {Promise<{botId: string, displayName: string}|null>}
 */
export async function resolveMentionedBot(db, token) {
  if (typeof token !== "string" || !token) return null;
  const voice = await voiceBot();
  let rows;
  try { rows = (await db.execute({ sql: "SELECT bot_id, display_name FROM pi_bot_defs WHERE enabled=1 AND bot_id<>? ORDER BY bot_id", args: [voice] })).rows; }
  catch { return null; }
  const hit = rows.find((r) => String(r.bot_id) === token) || rows.find((r) => squash(r.display_name) === squash(token));
  return hit ? { botId: String(hit.bot_id), displayName: String(hit.display_name) } : null;
}

/**
 * The comment routes' one entry point: null unless the OWNER wrote the
 * comment and it mentions someone; else { token, bot } (bot null: no such
 * enabled bot).
 */
export async function mentionBotFor(db, { actor, text }) {
  if (!actor || actor.kind !== "session") return null;
  const token = parseMention(text);
  if (!token) return null;
  return { token, bot: await resolveMentionedBot(db, token) };
}
