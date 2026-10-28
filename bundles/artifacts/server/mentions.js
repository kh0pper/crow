// The @bot grammar lives in core (servers/shared/bot-mention.js) so Workspace and
// Artifacts share one copy. Reached through appImport like every core module.
import { appImport } from "./app-root.js";

// Top-level await is safe: core and this bundle ship from the same checkout, so the shared parser is always there.
const m = await appImport("servers/shared/bot-mention.js");
export const { parseMention, resolveMentionedBot, mentionBotFor, MENTION_RE } = m;
