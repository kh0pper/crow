import { createHash } from "node:crypto";
import { appImport } from "./app-root.js";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

/** Only a LOCAL password-login session may approve calls. Peer-instance SSO
 *  sessions (scopes 'dashboard sso', minted by mintSsoSession) are refused. */
export async function isLocalDashboardSession(db, rawSession) {
  if (!rawSession) return false;
  const r = await db.execute({
    sql: "SELECT scopes FROM oauth_tokens WHERE token = ? AND client_id = 'dashboard' AND expires_at > datetime('now')",
    args: [sha(rawSession)],
  });
  return r.rows[0]?.scopes === "dashboard";
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
