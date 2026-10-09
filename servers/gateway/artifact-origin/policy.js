/**
 * Artifact origin — per-type sandbox and Content-Security-Policy (spec §5.1, §5.2, §5.2a).
 *
 * Every response from the artifact origin (and later the public-link listener)
 * carries a CSP whose `sandbox` directive makes even a top-level load run as
 * an opaque origin (review E13/E14). Script-free types get `sandbox` with no
 * flags at all, so no script runs and a <meta http-equiv=refresh> is refused
 * (E16). Scripted types get `sandbox allow-scripts` and never anything else:
 * no allow-same-origin, allow-top-navigation, allow-popups or allow-forms.
 *
 * The CSP limits egress, not XSS: 'unsafe-inline' for bot-written pages is
 * acceptable inside an opaque sandbox. 'unsafe-eval' is never granted.
 * connect-src and worker-src are always 'none' (a worker cannot start from an
 * opaque origin anyway; pdf.js runs its worker code on the main thread).
 */

export const ARTIFACT_TYPES = Object.freeze([
  "page", "document", "diagram", "data", "slides", "pdf", "image", "docx", "map",
]);

const SCRIPTED = new Set(["page", "slides", "data", "map", "pdf"]);

export function isScriptedType(type) { return SCRIPTED.has(type); }

/**
 * D20 (spec v1.3): a version shaped by non-owner text (tainted) is served
 * SCRIPT-FREE until the owner approves it, whatever its type. The script-free
 * row used is `document`'s (styles, images and fonts from the token path).
 * The navigation tripwire stays as defence in depth for the owner's own
 * scripted versions; it is not the control against a deliberate attacker.
 */
export function effectiveType(type, scriptsOff) { return scriptsOff && SCRIPTED.has(type) ? "document" : type; }

/** The iframe `sandbox` attribute value for a type (matches the CSP sandbox). */
export function iframeSandboxFor(type) { return SCRIPTED.has(type) ? "allow-scripts" : ""; }

// Per-type source lists, each relative to the version's token path ("P").
// "P" is replaced by the exact path-scoped source (origin + /v/<token>/).
const TABLE = {
  document: { style: ["P", "'unsafe-inline'"], img: ["P"], font: ["P"] },
  diagram:  { style: ["P", "'unsafe-inline'"], img: ["P"], font: ["P"] },
  image:    { img: ["P"] },
  docx:     { img: ["P"] },
  page:     { script: ["P", "'unsafe-inline'"], style: ["P", "'unsafe-inline'"], img: ["P"], font: ["P"] },
  slides:   { script: ["P", "'unsafe-inline'"], style: ["P", "'unsafe-inline'"], img: ["P"], font: ["P"] },
  data:     { script: ["P"], style: ["P", "'unsafe-inline'"], img: ["P"] },
  map:      { script: ["P"], style: ["P", "'unsafe-inline'"], img: ["P"] },
  // §5.2a: the viewer page is a fixed bundle file — no inline script, no eval.
  pdf:      { script: ["P"], style: ["P", "'unsafe-inline'"], img: ["P", "data:", "blob:"], font: ["P", "data:"] },
};

/**
 * The full CSP header value.
 * @param {string|null} type  an ARTIFACT_TYPES member, or null for an error /
 *   unknown response (gets the strictest policy: script-free, nothing allowed).
 * @param {{ tokenBase?: string|null, frameAncestors?: string|null }} o
 *   tokenBase: absolute `https://host[:port]/v/<token>/` for source lists.
 *   frameAncestors: the instance's dashboard origin, or null for 'none'.
 */
export function cspFor(type, { tokenBase = null, frameAncestors = null } = {}) {
  const row = (type && TABLE[type]) || {};
  const src = (list) => (list || []).map((s) => (s === "P" ? tokenBase : s)).filter(Boolean);
  const d = [
    "default-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
  ];
  const add = (name, list) => { const v = src(list); if (v.length) d.push(`${name} ${v.join(" ")}`); };
  if (tokenBase) {
    add("script-src", row.script);
    add("style-src", row.style);
    add("img-src", row.img);
    add("font-src", row.font);
  }
  d.push(`frame-ancestors ${frameAncestors || "'none'"}`);
  d.push(type && SCRIPTED.has(type) ? "sandbox allow-scripts" : "sandbox");
  return d.join("; ");
}

/** Headers every response carries, whatever its status (spec §5.1). */
export function baseHeaders(csp) {
  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store, private",
    "cross-origin-resource-policy": "cross-origin",
    "x-robots-tag": "noindex",
  };
}

/**
 * The trusted viewer page's CSP (the dashboard-origin page that frames
 * artifacts). `frame-src` is ONLY the artifact origin's token path: Chromium
 * checks the PARENT's frame-src on every navigation of a child frame,
 * including ones the child starts itself, BEFORE the request is sent. So a
 * link click or a script navigation inside an artifact cannot reach another
 * site (verified on Chromium; Firefox and Safari unverified, so the viewer's
 * navigation tripwire stays as defence in depth). No 'self', no scheme
 * source. Anything that is not a bare scheme://host[:port] origin gives
 * frame-src 'none' (nothing can be framed).
 *
 * Lives in core so the live isolation test and the bundle's panel page use
 * one definition.
 */
export function viewerCsp(artifactOrigin) {
  const ok = typeof artifactOrigin === "string" && /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(artifactOrigin);
  return "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "connect-src 'self'; frame-src " + (ok ? artifactOrigin + "/v/" : "'none'") + "; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
}
