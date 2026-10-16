/**
 * The exact request bodies Bot Builder's "Use for voice…" dialog sends
 * (servers/gateway/dashboard/panels/bot-builder/voice-use.js), shared by the
 * dialog test (tests/bot-builder-voice-use.test.js) and the same-path proof
 * against the Kiosk routes (tests/kiosk-routes.test.js): the dialog must
 * keep writing exactly what the Kiosk panel's own saves write.
 */
export const DASH_VOICE_PATH = "/api/kiosk/admin/dashboard-voice";
export const displayPath = (id) => "/api/kiosk/admin/displays/" + encodeURIComponent(id);
/** Phone & dashboard → this bot (the Kiosk panel's picker posts the same {bot_id}). */
export const dashBody = (botId) => ({ bot_id: botId });
/** Phone & dashboard → back to Automatic. */
export const dashAutoBody = () => ({ bot_id: "" });
/** A display → this bot: ONLY the assistant (the panel's Save posts the same when only the assistant changed). */
export const displayBody = (botId) => ({ bound_bot_id: botId });
