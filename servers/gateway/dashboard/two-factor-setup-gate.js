/**
 * Gate for the 2FA setup routes under /dashboard/login/2fa/setup.
 *
 * Those routes sit with the public login routes (a managed-hosting first
 * login lands there right after the password step), so they must check for
 * themselves that the caller is signed in and that 2FA is not already on.
 * Without this, any visitor on an allowed network could GET the page, which
 * replaced the live TOTP secret and recovery codes (locking the owner out),
 * or enable 2FA with a secret only the visitor knows.
 *
 * Returns null when the request may proceed, else the path to redirect to.
 */
import { sessionFromRequest } from "./auth.js";
import { is2faEnabled } from "./totp.js";

export async function twoFactorSetupGate(req, { sessionOf = sessionFromRequest, enabled = is2faEnabled } = {}) {
  if (!(await sessionOf(req))) return "/dashboard/login";
  if (await enabled()) return "/dashboard";
  return null;
}
