/**
 * Peer-invite shared component (Messages Phase 2 PR1 / C1+C3).
 *
 * The ONE component both the Messages tray and the Contacts "Add a peer"
 * section render. Pure sync renderers (no sharing-client imports — the QW2
 * trap); the async QR/share building happens in panel loaders/handlers.
 */

import { escapeHtml } from "./components.js";
import { t } from "./i18n.js";
import { buildInviteUrl } from "../../../sharing/invite-url.js";

const CODE_RE = /crow:[a-z0-9]{10}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

/** Find the invite code inside crow_generate_invite's text output. */
export function parseInviteCodeFromText(text) {
  if (typeof text !== "string") return null;
  const m = text.match(CODE_RE);
  return m ? m[0] : null;
}

/** Build { code, url, qrDataUrl } from the tool text. QR optional; never throws. */
export async function buildInviteShare(toolText, env = process.env) {
  const code = parseInviteCodeFromText(toolText);
  if (!code) return null;
  const url = buildInviteUrl(code, env);
  let qrDataUrl = null;
  try {
    const QRCode = (await import("qrcode")).default;
    qrDataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
  } catch { /* qr optional */ }
  return { code, url, qrDataUrl };
}

/** Sync HTML share block: link + copy button + QR + raw-code fallback. */
export function renderInviteShare(share, lang) {
  if (!share || !share.url) return "";
  const url = escapeHtml(share.url);
  const qr = share.qrDataUrl
    ? `<div style="margin:.5rem 0"><img src="${escapeHtml(share.qrDataUrl)}" alt="QR" width="220" height="220" style="image-rendering:pixelated;border-radius:8px;background:#fff;padding:6px"></div>`
    : "";
  return `<div class="invite-share">
    <div style="font-size:0.8rem;font-weight:600;margin-bottom:4px">${t("invite.shareLabel", lang)}</div>
    <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0 0 6px">${t("invite.shareHint", lang)}</p>
    <textarea readonly rows="2" onclick="this.select()" style="width:100%;font-size:0.75rem;word-break:break-all;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:6px;padding:8px;color:var(--crow-text)">${url}</textarea>
    <button type="button" style="margin-top:4px;font-size:0.75rem;padding:4px 10px;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-bg-elevated);color:var(--crow-text);cursor:pointer" onclick="var u=this.previousElementSibling.value;(navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(()=>{this.textContent=this.dataset.done},()=>{this.previousElementSibling.select()})" data-done="${escapeHtml(t("invite.copyLink", lang))} ✓">${t("invite.copyLink", lang)}</button>
    ${qr}
    <details style="margin-top:6px"><summary style="cursor:pointer;font-size:0.75rem;color:var(--crow-text-muted)">${t("invite.rawCode", lang)}</summary>
      <pre style="font-size:0.7rem;white-space:pre-wrap;word-break:break-all;background:var(--crow-bg-deep);padding:8px;border-radius:6px;margin:4px 0 0">${escapeHtml(share.code)}</pre>
    </details>
    <p style="font-size:0.7rem;color:var(--crow-text-muted);margin:6px 0 0">${t("invite.verifyLater", lang)}</p>
  </div>`;
}

/** Sync generate + accept form strings both panels embed. */
export function renderPeerInviteForms({ lang, csrf = "", prefillCode = "" }) {
  // data-turbo="false" (F-UI-1): these POSTs answer with a 200 re-render (the
  // invite result must never appear in a URL). Turbo Drive discards non-redirect
  // POST responses, so under Turbo the buttons were dead. Classic form POST
  // renders the response; the csrf hidden input keeps it CSRF-valid.
  const generateForm = `<form method="POST" data-turbo="false">
    <input type="hidden" name="action" value="generate_invite">${csrf}
    <button type="submit" class="btn btn-primary" style="width:100%;font-size:0.8rem;padding:6px">${t("invite.generateBtn", lang)}</button>
  </form>`;
  const acceptForm = `<form method="POST" data-turbo="false">
    <input type="hidden" name="action" value="accept_invite">${csrf}
    <textarea name="invite_code" placeholder="${escapeHtml(t("invite.pastePlaceholder", lang))}" rows="3" required style="width:100%;font-size:0.75rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:6px;padding:8px;color:var(--crow-text)">${escapeHtml(prefillCode)}</textarea>
    <button type="submit" class="btn btn-primary" style="width:100%;font-size:0.8rem;padding:6px;margin-top:4px">${t("invite.acceptBtn", lang)}</button>
  </form>`;
  return { generateForm, acceptForm };
}

// ──────────────────────────────────────────────
// Short-code pairing (Messages Phase 2 PR2 / C2)
// ──────────────────────────────────────────────

// THREE groups (4+4+4 = 12 chars) — the code is 12 chars (K7Q4-M2X9-3FHT). A
// two-group (8-char) pattern would truncate the match and make the
// acceptor's normalizeShortCode reject it, breaking the happy path
// (round-2 security review CRITICAL — do not regress to two groups).
const SHORT_CODE_RE = /\b[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}\b/;

/**
 * Find the 12-char short code inside crow_generate_short_invite's text
 * output and compute a display-only expiry (10 min from render time — the
 * server enforces the real expiry regardless of this display value).
 */
export function parseShortCodeResult(text) {
  if (typeof text !== "string") return null;
  const m = text.match(SHORT_CODE_RE);
  if (!m) return null;
  return { formattedCode: m[0], expiresAt: Date.now() + 10 * 60 * 1000 };
}

/**
 * Sync HTML share block: the code BIG (monospace, letter-spaced), a
 * server-rendered expiry time (no live countdown — kept dependency-free per
 * M5), the speak-don't-post hint, and the safety-number backstop pointer.
 */
export function renderShortCodeShare(share, lang) {
  if (!share || !share.formattedCode) return "";
  const code = escapeHtml(share.formattedCode);
  let timeStr = "";
  if (share.expiresAt) {
    try {
      timeStr = new Date(share.expiresAt).toLocaleTimeString(lang === "es" ? "es-ES" : "en-US", { hour: "2-digit", minute: "2-digit" });
    } catch { /* display-only — never throws */ }
  }
  return `<div class="short-code-share">
    <div style="font-size:1.6rem;font-weight:700;letter-spacing:0.15em;font-family:monospace;text-align:center;margin:8px 0;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:12px 6px">${code}</div>
    <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0 0 4px">${t("invite.shortCodeExpiry", lang)}${timeStr ? ` (${escapeHtml(timeStr)})` : ""}</p>
    <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0 0 6px">${t("invite.shortCodeHint", lang)}</p>
    <p style="font-size:0.7rem;color:var(--crow-text-muted);margin:6px 0 0">${t("invite.verifyLater", lang)}</p>
  </div>`;
}

/** Sync generate + accept form strings for the short-code alternative. */
export function renderShortCodeForms({ lang, csrf = "" }) {
  const generateForm = `<form method="POST" data-turbo="false">
    <input type="hidden" name="action" value="generate_short_invite">${csrf}
    <button type="submit" class="btn btn-primary" style="width:100%;font-size:0.8rem;padding:6px">${t("invite.shortCodeGenerateBtn", lang)}</button>
  </form>`;
  const acceptForm = `<form method="POST" data-turbo="false">
    <input type="hidden" name="action" value="accept_short_invite">${csrf}
    <input type="text" name="short_code" maxlength="20" required placeholder="${escapeHtml(t("invite.shortCodeAcceptPlaceholder", lang))}" style="width:100%;font-size:0.85rem;letter-spacing:0.05em;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:6px;padding:8px;color:var(--crow-text)">
    <button type="submit" class="btn btn-primary" style="width:100%;font-size:0.8rem;padding:6px;margin-top:4px">${t("invite.shortCodeAcceptBtn", lang)}</button>
  </form>`;
  return { generateForm, acceptForm };
}
