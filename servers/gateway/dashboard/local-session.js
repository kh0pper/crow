/**
 * Is this request the owner at THIS machine's own dashboard? A local password-login
 * session only: a signed peer request (crossHostAuth) never is, and neither is a session a
 * peer sign-in minted (mintSsoSession: scopes 'dashboard sso'). The phone bundle's call
 * approvals use this same check (bundles/phone/server/authority.js).
 *
 * Nor is a request that comes from this machine itself (servers/shared/self-origin.js): its
 * own console, the shared browser container on host networking, a local script or a bot with
 * a shell. They can set any header or cookie, and through Tailscale Serve they even carry the
 * owner's tailnet login; only the client address tells them apart. Nor is a session minted by
 * a login from this machine (scopes 'dashboard onhost', dashboard/auth.js), wherever it is
 * replayed from. Both still browse the dashboard as signed in; only the owner's turn is refused.
 */
import { createHash } from "node:crypto";
import { createDbClient } from "../../db.js";
import { isSelfOrigin } from "../../shared/self-origin.js";

// The same hash dashboard/auth.js stores session tokens under.
const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");

/** The same check on a crow.db client the caller already holds (one client per request). */
export async function isLocalPasswordSessionOn(db, req) {
  if (!req?.dashboardSession || req?.crossHostAuth) return false;
  if (isSelfOrigin(req)) return false;
  try {
    const r = await db.execute({
      sql: "SELECT scopes FROM oauth_tokens WHERE token = ? AND client_id = 'dashboard' AND julianday(expires_at) > julianday('now')",
      args: [hashToken(req.dashboardSession)],
    });
    return r.rows[0]?.scopes === "dashboard";
  } catch {
    return false;
  }
}

export async function isLocalPasswordSession(req) {
  // The origin rule runs inside isLocalPasswordSessionOn.
  if (!req?.dashboardSession || req?.crossHostAuth) return false;
  const db = createDbClient();
  try {
    return await isLocalPasswordSessionOn(db, req);
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}
