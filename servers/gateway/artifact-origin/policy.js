/**
 * Artifact origin — per-type sandbox and Content-Security-Policy (spec §5.1, §5.2, §5.2a).
 *
 * Every response from the artifact origin (and later the public-link listener)
 * carries a CSP whose `sandbox` directive makes even a top-level load run as
 * an opaque origin (review E13/E14). SEALED types get `sandbox` with no flags
 * at all, so no script runs and a <meta http-equiv=refresh> is refused (E16):
 * diagrams, images, docx, and every scripts-off (D20) version of a scripted
 * type (the "sealed" row). Types whose frame SPEAKS get `sandbox
 * allow-scripts` and never anything else (no allow-same-origin,
 * allow-top-navigation, allow-popups or allow-forms):
 *  - scripted types (their own scripts + the anchor helper);
 *  - D28 (spec v1.7): documents, which are HELPER-ONLY — script-src is
 *    exactly the anchor helper's path-exact URL, no inline, no other file.
 *    A document can therefore follow a <meta http-equiv=refresh>; the
 *    control is the renderer (sanitize-html never emits meta/base/script),
 *    then the viewer's parent frame-src and second-load tripwire.
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
/** D28: frames that run the trusted anchor helper (and so say hello). */
const SPEAKS = new Set([...SCRIPTED, "document"]);
/** The helper's path under a version's token path (served by the origin). */
export const HELPER_PATH = "__crow/anchor-helper.js";

/** Content scripts (D20 applies). Documents are NOT scripted. */
export function isScriptedType(type) { return SCRIPTED.has(type); }
/** The frame runs the anchor helper: hello, proposals, the tripwire and D24. */
export function speaks(type) { return SPEAKS.has(type); }

/**
 * D20 (spec v1.3): a version shaped by non-owner text (tainted) is served
 * SCRIPT-FREE until the owner approves it, whatever its type. The script-free
 * row used is `document`'s (styles, images and fonts from the token path).
 * The navigation tripwire stays as defence in depth for the owner's own
 * scripted versions; it is not the control against a deliberate attacker.
 */
export function effectiveType(type, scriptsOff) { return scriptsOff && SCRIPTED.has(type) ? "sealed" : type; }

/** The iframe `sandbox` attribute value for a type (matches the CSP sandbox). */
export function iframeSandboxFor(type) { return SPEAKS.has(type) ? "allow-scripts" : ""; }

/**
 * THE one decision for a frame (review H2): the served type, the sandbox and
 * whether the frame speaks. The view-mint route, the origin's helper
 * injection and the load-evidence table all read it, so a grant's sandbox
 * and its `scripted` (= speaks) flag can never disagree.
 */
export function frameGrantFor(type, scriptsOff) {
  const eff = effectiveType(type, !!scriptsOff);
  return { effectiveType: eff, sandbox: iframeSandboxFor(eff), speaks: SPEAKS.has(eff) };
}

// Per-type source lists, each relative to the version's token path ("P").
// "P" is replaced by the exact path-scoped source (origin + /v/<token>/).
// "H" is the anchor helper's path-exact URL (D28: a document's ONLY script).
const TABLE = {
  // D20: every scripts-off scripted version. Identical to the pre-D28
  // document row (pinned byte-for-byte by tests/artifact-policy-d28.test.js).
  sealed:   { style: ["P", "'unsafe-inline'"], img: ["P"], font: ["P"] },
  document: { script: ["H"], style: ["P", "'unsafe-inline'"], img: ["P"], font: ["P"] },
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
  const src = (list) => (list || []).map((s) => (s === "P" ? tokenBase : s === "H" ? tokenBase + HELPER_PATH : s)).filter(Boolean);
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
  d.push(type && SPEAKS.has(type) ? "sandbox allow-scripts" : "sandbox");
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
  // media-src: the player bar rides on this page (bar on every Crow page, 2026-10-16) — the dashboard's
  // own media-src, so external podcast/stream items keep playing. Artifact content never sees it: its
  // frame has its own CSP (cspFor, media-src 'none') and sandbox.
  return "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "media-src 'self' https: blob:; connect-src 'self'; frame-src " + (ok ? artifactOrigin + "/v/" : "'none'") + "; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
}
