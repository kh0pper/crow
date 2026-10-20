/**
 * One set of voice rules for every surface (phone overlay, kiosk, glasses): what each surface's turn
 * options share, built in one place. A surface spreads these first, then its own display-only options.
 * Bundles reach this module through their panel routes' appImport (never a static import).
 */
import { VOICE_DENY_TOOLS, normalizeVoiceSettings } from "../../shared/voice-bot.js";
import { voiceLine } from "./voice-lines.js";

export { VOICE_DENY_TOOLS };

/**
 * → the shared turn options.
 *   surface           "phone" | "kiosk" | "glasses" (turn.js records it as timings.surface)
 *   lang              the surface's language for the spoken lines
 *   voiceDef          the voice bot's definition, when the caller has it: escalation off → noEscalate
 *   cloud             the caller's answer to "is the fast voice model a cloud provider (host "cloud")?".
 *                     A cloud model is capable, so the tool-family gate (there for the small local
 *                     model's latency) is off. The lookup is the caller's.
 *   actionWhen, actionFollowWhen   the surface's action-intent tests (queue item 29)
 */
export function crowVoiceTurnOptions({ surface, lang, voiceDef = null, cloud = false, actionWhen, actionFollowWhen } = {}) {
  const o = {
    surface,
    familiesOnIntent: cloud !== true,
    denyTools: VOICE_DENY_TOOLS,
    actionWhen,
    actionFollowWhen,
    cantDoText: voiceLine("cant_do_say", lang),
    notDoneText: voiceLine("not_done_say", lang),
    notReadyText: voiceLine("not_ready_say", lang),
    memoOnlyText: voiceLine("memo_only_say", lang),
    unsureText: voiceLine("unsure_say", lang),
  };
  if (voiceDef && normalizeVoiceSettings(voiceDef).escalation === "off") o.noEscalate = true;
  return o;
}
