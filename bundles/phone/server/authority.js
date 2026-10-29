import { appImport } from "./app-root.js";

/** Only the owner's own turn may approve calls: the gateway's isLocalPasswordSessionOn
 *  (servers/gateway/dashboard/local-session.js). A peer-instance SSO session
 *  ('dashboard sso'), a session minted by a login from this machine ('dashboard onhost'),
 *  a signed peer call, and any request from this machine itself are all refused.
 *  Takes the request (not the raw session) so the origin rule applies; anything else -> false. */
export async function isLocalDashboardSession(db, req) {
  if (!req || typeof req !== "object") return false;
  try {
    const { isLocalPasswordSessionOn } = await appImport("servers/gateway/dashboard/local-session.js");
    return await isLocalPasswordSessionOn(db, req);
  } catch {
    return false;
  }
}

async function defaultDeps() {
  const t = await appImport("servers/gateway/dashboard/totp.js");
  return { is2faEnabled: t.is2faEnabled, getTotpSecret: t.getTotpSecret, verifyTotp: t.verifyTotp };
}

export async function stepUpOk(code, deps) {
  const d = deps || (await defaultDeps());
  if (!(await d.is2faEnabled())) return true;
  if (!code || !/^\d{6}$/.test(String(code))) return false;
  const secret = await d.getTotpSecret();
  return !!secret && d.verifyTotp(String(code), secret);
}

/** Whether an approval needs a 2FA code right now (drives the card's 2FA field). */
export async function totpRequired(deps) {
  const d = deps || (await defaultDeps());
  return !!(await d.is2faEnabled());
}
