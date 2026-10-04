/**
 * K5 live-endpoint tokens (spec §5.7, §7.4).
 * - verifyEditorJwt: the ONLYOFFICE docservice SESSION token the plugin sees as Asc.plugin.info.jwt (S9: HS256 with
 *   the shared secret, 30-day lifetime, documentId == document.key, editorConfig.user.id ∈ info.users). A valid
 *   signature is NOT enough: routes-live.js also binds every request to a live session (current key + user ∈ users).
 * - mint/checkApplyToken: a short-lived per-change token proving the ack comes from the claim that won; signed with a
 *   per-boot random secret (a gateway restart mid-apply → the ack fails → lease expiry → unknown_after_claim, safe).
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { WsError } from "../result.js";

const BOOT_SECRET = randomBytes(32);
export const APPLY_GRACE_MS = 120000;
const sig = (secret, data) => createHmac("sha256", secret).update(data).digest("base64url");
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const unauthorized = (m) => new WsError("unauthorized", m);
const part = (s) => { try { const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };

/** → {key, userId, userName, canEdit} | throws WsError("unauthorized"). HS256 only; exp required and checked. */
export function verifyEditorJwt(token, secret, nowMs = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !secret) throw unauthorized("editor session token required");
  const head = part(parts[0]);
  if (!head || head.alg !== "HS256" || !eq(parts[2], sig(secret, `${parts[0]}.${parts[1]}`))) throw unauthorized("bad editor session token");
  const p = part(parts[1]);
  if (!p) throw unauthorized("bad editor session token");
  if (typeof p.exp !== "number" || p.exp * 1000 < nowMs) throw unauthorized("editor session token expired");
  const key = p.document?.key;
  if (typeof key !== "string" && typeof key !== "number") throw unauthorized("token has no document");
  // S9: no claim distinguishes edit from view tokens; these markers are honoured if present, and the plugin itself
  // never claims in view mode (isViewMode). An ack is never proof anyway (verified against the saved file).
  const ec = p.editorConfig && typeof p.editorConfig === "object" ? p.editorConfig : {};
  return {
    key: String(key), userId: String(ec.user?.id ?? ""), userName: String(ec.user?.name ?? "").slice(0, 100),
    canEdit: !(ec.ds_view === true || ec.mode === "view" || p.document?.permissions?.edit === false),
  };
}

export function mintApplyToken(changeId, key, leaseUntil) { return `${leaseUntil}.${sig(BOOT_SECRET, `${changeId}.${key}.${leaseUntil}`)}`; }
/** The token's lease must be the row's lease (this claim, not an earlier one) and not past lease + 120 s. */
export function checkApplyToken(token, changeId, key, leaseUntil, nowMs = Date.now()) {
  const [lease, s] = String(token || "").split(".");
  return /^\d{1,16}$/.test(lease || "") && Number(lease) === Number(leaseUntil) && nowMs <= Number(lease) + APPLY_GRACE_MS && eq(s || "", sig(BOOT_SECRET, `${changeId}.${key}.${lease}`));
}
