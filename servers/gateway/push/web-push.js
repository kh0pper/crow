/**
 * Web Push — VAPID-based push notification sender
 *
 * Requires VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env vars.
 * Generate keys: npx web-push generate-vapid-keys
 */

import webpush from "web-push";

let configured = false;

/**
 * Initialize VAPID credentials for web push.
 * Called once on gateway startup.
 */
export function initWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const email = process.env.VAPID_EMAIL || "mailto:admin@localhost";

  if (!publicKey || !privateKey) {
    console.log("[web-push] VAPID keys not configured — push notifications disabled");
    return;
  }

  webpush.setVapidDetails(email, publicKey, privateKey);
  configured = true;
  console.log("[web-push] VAPID configured — push notifications enabled");
}

/**
 * Send a push notification to all registered subscriptions.
 *
 * @param {object} db - Database client
 * @param {object} payload
 * @param {string} payload.title - Notification title
 * @param {string} [payload.body] - Notification body text
 * @param {string} [payload.url] - Action URL on click
 */
export async function sendPushToAll(db, { title, body, url }) {
  if (!configured) return;

  let rows;
  try {
    const result = await db.execute("SELECT endpoint, keys_json FROM push_subscriptions");
    rows = result.rows;
  } catch {
    // Table may not exist yet
    return;
  }

  for (const row of rows) {
    const subscription = {
      endpoint: row.endpoint,
      keys: JSON.parse(row.keys_json),
    };
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify({ title, body: body || title, url: url || "/dashboard/nest" })
      );
      // Update last_seen
      await db.execute({
        sql: "UPDATE push_subscriptions SET last_seen = datetime('now') WHERE endpoint = ?",
        args: [row.endpoint],
      });
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Stale subscription — auto-remove
        await db.execute({
          sql: "DELETE FROM push_subscriptions WHERE endpoint = ?",
          args: [row.endpoint],
        });
      }
    }
  }
}

/**
 * Get the VAPID public key for client-side subscription.
 * @returns {string|null}
 */
export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}
