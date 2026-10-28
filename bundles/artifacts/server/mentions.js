// The @bot grammar lives in core (servers/shared/bot-mention.js) so Workspace and
// Artifacts share one copy. Reached through appImport like every core module.
import { appImport } from "./app-root.js";

const m = await appImport("servers/shared/bot-mention.js");
export const { parseMention, resolveMentionedBot, mentionBotFor, MENTION_RE } = m;
