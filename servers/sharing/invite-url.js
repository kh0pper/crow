/**
 * Invite URL helpers (Messages Phase 2 PR1 / C1).
 *
 * The share link points at a PUBLIC STATIC page (docs site — never a gateway)
 * with the invite code in the URL FRAGMENT, so no server ever receives or
 * logs the code. Pure module: no sharing-client imports, safe anywhere.
 */

export const DEFAULT_INVITE_PAGE_URL = "https://maestro.press/software/crow/invite/";

/** Resolve the invite-page base URL (env override for self-hosters). */
export function invitePageBase(env = process.env) {
  const raw = (env && typeof env.CROW_INVITE_PAGE_URL === "string") ? env.CROW_INVITE_PAGE_URL.trim() : "";
  if (!raw) return DEFAULT_INVITE_PAGE_URL;
  // A configured base must not itself carry a fragment.
  const hash = raw.indexOf("#");
  return hash === -1 ? raw : raw.slice(0, hash);
}

/** Build the shareable invite URL: base + '#' + encoded code. */
export function buildInviteUrl(code, env = process.env) {
  return `${invitePageBase(env)}#${encodeURIComponent(String(code))}`;
}

/**
 * Forgiving code extraction: users paste either a raw invite code OR a full
 * invite URL. If the input contains '#', take what follows the LAST '#'
 * (decoded); otherwise return the trimmed input. Never throws.
 */
export function extractInviteCode(input) {
  if (typeof input !== "string") return "";
  const s = input.trim();
  const hash = s.lastIndexOf("#");
  if (hash === -1) return s;
  const frag = s.slice(hash + 1).trim();
  if (!frag) return "";
  try {
    return decodeURIComponent(frag);
  } catch {
    return frag; // malformed percent-encoding — hand back the raw fragment
  }
}
