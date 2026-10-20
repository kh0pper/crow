/**
 * Create the reserved Crow voice bot with the gateway's real dependencies
 * (the quick voice model key, the settings reader, the device list, the
 * tool-effect and voice-category maps). One builder for both callers, so
 * the boot-time ensure (boot/post-listen.js) and a voice turn's ensure
 * (voice/turn.js defaultVoiceDeps) can never drift apart.
 *
 * Throws what ensureVoiceBot throws (fast_model_required, a DB error); the
 * callers decide what a failure means. On a create it tells the Bot Builder
 * and every voice runner that the bot defs changed.
 */
export async function ensureCrowVoiceBot(db, { log = (m) => console.log(m) } = {}) {
  const { ensureVoiceBot, CROW_VOICE_BOT_ID } = await import("../../shared/voice-bot.js");
  const { VOICE_ROUTE_KEYS } = await import("../routes/llm-router.js");
  const { readSetting } = await import("../dashboard/settings/registry.js");
  const { listDevices } = await import("../../shared/device-store.js");
  const { toolEffect } = await import("./action-claims.js");
  const { voiceCategoryFor } = await import("../../../scripts/pi-bots/ext_registry.mjs");
  const res = await ensureVoiceBot(db, { fastKey: VOICE_ROUTE_KEYS.fast, readSetting, listDevices, toolEffect, voiceCategoryFor, log });
  if (res.created) {
    const { emitBotDefsChanged } = await import("../dashboard/panels/bot-builder/defs-changed.js");
    emitBotDefsChanged(CROW_VOICE_BOT_ID);
  }
  return res;
}
