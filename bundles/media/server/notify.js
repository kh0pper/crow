/**
 * Notifications from the media bundle, through the app root.
 *
 * The bundle runs from an installed copy (a bundles directory under the instance home), where a
 * path relative to this file never reaches the gateway's code. The shared notification helper is
 * therefore resolved from the app root, the same way the bundle reaches the database client.
 * A failure is logged and swallowed: a briefing must never fail because a notice could not be sent.
 */
import { appImport } from "./app-root.js";

let shared = null;

/** opts: { title, body?, action_url?, source?, priority? }. → { id } | null (filtered by preferences, or failed) */
export async function notify(db, opts) {
  try {
    shared ||= await appImport("servers/shared/notifications.js");
    return await shared.createNotification(db, { type: "media", priority: "normal", ...opts });
  } catch (err) {
    console.error(`[media] notification not sent ("${opts?.title}"): ${err.message}`);
    return null;
  }
}

/**
 * Web push is set up once per process by the gateway. The stdio server is its own process, so it
 * sets it up for itself (the keys come from the environment it inherits). Without keys this is a no-op.
 */
export async function enablePushInThisProcess() {
  try { (await appImport("servers/gateway/push/web-push.js")).initWebPush(); return true; } catch { return false; }
}
