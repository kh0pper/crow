/**
 * Is this request the owner at THIS machine's own dashboard? A local password-login
 * session only: a signed peer request (crossHostAuth) never is, and neither is a session a
 * peer sign-in minted (mintSsoSession: scopes 'dashboard sso'). The phone bundle's call
 * approvals draw the same line (bundles/phone/server/authority.js).
 */
import { createHash } from "node:crypto";
import { createDbClient } from "../../db.js";

// The same hash dashboard/auth.js stores session tokens under.
const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");

export async function isLocalPasswordSession(req) {
  if (!req?.dashboardSession || req?.crossHostAuth) return false;
  const db = createDbClient();
  try {
    const r = await db.execute({
      sql: "SELECT scopes FROM oauth_tokens WHERE token = ? AND client_id = 'dashboard' AND julianday(expires_at) > julianday('now')",
      args: [hashToken(req.dashboardSession)],
    });
    return r.rows[0]?.scopes === "dashboard";
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}
