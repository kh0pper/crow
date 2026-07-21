/**
 * Bot Builder — defs-changed bus emit helper (C4 Task 6).
 *
 * Every successful bot-def mutation (create, wizard create, any tab save,
 * enable/disable toggle, delete) must notify bot-runtime.js's Discord
 * reconcile so an edited/added/removed discord gateway config is picked up
 * within one debounce window — without a gateway restart. Pulled out into
 * this tiny leaf module (rather than living in api-handlers.js) so
 * wizard.js and delete-bot.js can both import it too: api-handlers.js
 * already imports both of THOSE modules, so a helper living there would be
 * an import cycle.
 */
import bus from "../../../../shared/event-bus.js";

/** Non-throwing — a broken subscriber must never break the primary DB write. */
export function emitBotDefsChanged(botId) {
  try {
    bus.emit("pibots:defs-changed", { bot_id: botId || null });
  } catch {}
}
