/**
 * Crow Mail's reader frame: one untrusted message body as a standalone document.
 *
 * A message body is never put in a dashboard page. It is served by its own route, which carries its
 * own Content-Security-Policy, and shown in an opaque-origin `<iframe>` (`sandbox` without
 * `allow-same-origin`). So a script in a hostile mail would have no way to the dashboard's cookies or
 * its private APIs — and there is no such script: plan 1's sanitiser drops `script`, every handler,
 * `style`, `link`, `base` and `meta` before this module sees the body, and the pin tests fail the
 * build if a second script, a handler, a `<link` or a `<base` ever appears in a rendered document.
 *
 * Exactly one script runs in the frame: the helper below, inline and pinned by its CSP `sha256-` hash.
 * It is inline rather than served from a path because a subresource request from an opaque origin
 * carries no session cookie, so a path under the owner-guarded API would answer 403; a hash allows
 * exactly this one script text and nothing else. The per-load nonce cannot be inside pinned text, so
 * the parent puts it in the iframe URL's fragment (`#n=<nonce>`, never sent to a server) and the
 * helper reads `location.hash`. The helper writes nothing to the DOM, makes no request and only
 * reports its own height and the blocked-image count to the parent, which accepts a message only from
 * that iframe's own `contentWindow` with the nonce it generated for this load.
 *
 * The document is rendered from the already-sanitised body (`bodyForDisplay`), not from stored html:
 * this module's second pass is not the first line of defence, it is the one that drops tracking
 * pixels (an image declared 2 px or smaller, which no banner should count as a picture), keeps links
 * absolute (a relative href would open a signed-in dashboard page in a new tab) and counts what it
 * dropped so a pixel is never reported as a blocked image twice.
 */
import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { BLOCKED_IMAGE_ATTRIBUTE, MAX_SANITIZE_HTML_CHARS, SANITIZE_TAG_POLICY } from "../sanitize.js";

/** The iframe `sandbox` value, and the CSP `sandbox` directive: the one definition. */
export const FRAME_IFRAME_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/**
 * The frame's one script. Fixed text, no interpolation: a `sha256-` hash pins the bytes exactly, so
 * anything substituted into it would be a different script and the frame would run nothing.
 *
 * It posts `{t: "crow-mail-frame", nonce, height, blocked}` to `parent` with target `*` — an opaque
 * frame cannot know its parent's origin, and the payload carries no secret — on `load` and from a
 * `ResizeObserver` on the body, at most four times a second. `height` is the body's own rect, not
 * `documentElement.scrollHeight`, which never shrinks again after the parent grows the frame.
 */
export const FRAME_HELPER_SOURCE = `(function () {
  "use strict";
  var m = /^#n=([A-Za-z0-9_-]{16,64})$/.exec(String(location.hash || ""));
  if (!m) { return; }
  var nonce = m[1];
  var meta = document.querySelector('meta[name="crow-blocked-images"]');
  var raw = meta ? String(meta.getAttribute("content") || "") : "";
  var blocked = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : 0;
  var last = 0;
  var timer = 0;
  function measure() {
    var body = document.body;
    if (!body || typeof body.getBoundingClientRect !== "function") { return 0; }
    var h = Math.ceil(body.getBoundingClientRect().height);
    return isFinite(h) && h > 0 ? h : 0;
  }
  function send() {
    timer = 0;
    last = Date.now();
    try {
      parent.postMessage({ t: "crow-mail-frame", nonce: nonce, height: measure(), blocked: blocked }, "*");
    } catch (e) {}
  }
  function ask() {
    if (timer) { return; }
    var wait = 250 - (Date.now() - last);
    if (wait <= 0) { send(); return; }
    timer = setTimeout(send, wait);
  }
  addEventListener("load", ask);
  addEventListener("resize", ask);
  if (typeof ResizeObserver === "function" && document.body) {
    new ResizeObserver(ask).observe(document.body);
  }
  if (document.readyState === "complete") { ask(); }
})();
`;

/** The CSP source for the helper: its exact bytes, hashed once when this module loads. */
export const FRAME_HELPER_CSP_SOURCE = `'sha256-${createHash("sha256").update(FRAME_HELPER_SOURCE, "utf8").digest("base64")}'`;

/** An image declared this many pixels or smaller on either side is a tracking pixel, not a picture. */
const PIXEL_MAX_SIDE = 2;

/** A length attribute that names pixels: digits with an optional decimal part and `px` suffix. */
const PIXEL_DIMENSION_RE = /^(\d{1,4}(?:\.\d+)?)(?:px)?$/i;

/**
 * A link the frame keeps: absolute http(s) (`https://host/...`, never the scheme alone or a single
 * slash after it), or a `mailto:`/`tel:` with something after the colon.
 */
const ABSOLUTE_LINK_RE = /^(?:https?:\/\/.|mailto:.|tel:.)/i;

/** An image source the frame keeps: the sanitiser only ever lets an absolute https URL through. */
const ABSOLUTE_IMAGE_RE = /^https:\/\/./i;

const LINK_TARGET = "_blank";
const LINK_REL = "noopener noreferrer nofollow";

/** A document language tag; anything else is English. */
const LANG_RE = /^[A-Za-z0-9-]{1,20}$/;

/**
 * The frame's tag and attribute policy is plan 1's sanitiser policy itself (`SANITIZE_TAG_POLICY`),
 * imported rather than repeated: this pass must change nothing the first one decided, apart from the
 * pixel rule and the link rule below. sanitize-html's own defaults would strip `<img>` and a link's
 * `rel`, and the body would arrive as text.
 */

/** The frame's small stylesheet: readable 16 px type that follows the OS scheme. */
const FRAME_STYLE = [
  ":root{color-scheme:light dark}",
  "body{margin:0;padding:4px 2px;font:16px/1.5 system-ui,-apple-system,sans-serif;overflow-wrap:anywhere}",
  "img,table{max-width:100%}",
  "table{border-collapse:collapse}",
  "blockquote{margin:0 0 0 8px;padding-left:8px;border-left:2px solid GrayText}",
  "a{color:LinkText}",
].join("");

/** Cut to a bound, never through a surrogate pair. */
function cut(value, limit) {
  if (value.length <= limit) return value;
  let end = limit;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** The pixel length an attribute declares, or null when it declares none. */
function declaredPixels(value) {
  if (typeof value !== "string") return null;
  const match = PIXEL_DIMENSION_RE.exec(value.trim());
  return match ? Number.parseFloat(match[1]) : null;
}

/** Whether an `<img>` is declared small enough on either side to be a tracking pixel. */
function isTrackingPixel(attribs) {
  for (const name of ["width", "height"]) {
    const side = declaredPixels(attribs[name]);
    if (side !== null && side <= PIXEL_MAX_SIDE) return true;
  }
  return false;
}

/**
 * The options for the second pass. The counters are updated by the transforms and the filter below,
 * and the allow-lists are plan 1's so this pass can only ever remove.
 */
function secondPassOptions(counts) {
  return {
    allowedTags: [...SANITIZE_TAG_POLICY.allowedTags],
    allowedAttributes: {
      a: [...SANITIZE_TAG_POLICY.allowedAttributes.a],
      img: [...SANITIZE_TAG_POLICY.allowedAttributes.img],
      td: [...SANITIZE_TAG_POLICY.allowedAttributes.td],
      th: [...SANITIZE_TAG_POLICY.allowedAttributes.th],
    },
    allowedSchemes: [...SANITIZE_TAG_POLICY.allowedSchemes],
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: [...SANITIZE_TAG_POLICY.nonTextTags],
    parseStyleAttributes: false,
    transformTags: {
      // A link keeps a href only when it is absolute. A relative one — `/dashboard/...`, `../x`, or a
      // protocol-relative `//mail.example.test/x` — would resolve against this instance and open a
      // signed-in page in the new tab the link asks for, so it becomes its own text.
      a: (tagName, attribs) => {
        const out = {};
        const href = typeof attribs.href === "string" ? attribs.href.trim() : "";
        if (ABSOLUTE_LINK_RE.test(href)) out.href = href;
        if (typeof attribs.title === "string" && attribs.title.trim() !== "") out.title = attribs.title;
        out.target = LINK_TARGET;
        out.rel = LINK_REL;
        return { tagName, attribs: out };
      },
      // Rebuilt from scratch, so an image is exactly what the sanitiser showed, and only an absolute
      // https source is ever copied into the document.
      img: (tagName, attribs) => {
        const out = {};
        const src = typeof attribs.src === "string" ? attribs.src.trim() : "";
        if (ABSOLUTE_IMAGE_RE.test(src)) out.src = src;
        for (const name of ["alt", "width", "height"]) {
          if (typeof attribs[name] === "string") out[name] = attribs[name];
        }
        if (attribs[BLOCKED_IMAGE_ATTRIBUTE] != null) out[BLOCKED_IMAGE_ATTRIBUTE] = "1";
        return { tagName, attribs: out };
      },
    },
    // The pixel rule: an image declared 2 px or smaller is dropped, and counted — separately when it
    // is one plan 1 already blocked, so the frame's banner does not count it twice.
    exclusiveFilter: (frame) => {
      if (frame.tag !== "img" || !isTrackingPixel(frame.attribs)) return false;
      counts.dropped += 1;
      if (frame.attribs[BLOCKED_IMAGE_ATTRIBUTE] != null) counts.droppedBlocked += 1;
      return true;
    },
  };
}

/**
 * The second pass over an already-sanitised body: drop tracking pixels and any link that is not
 * absolute.
 *
 * @param {*} html the body `bodyForDisplay` returned
 * @returns {{html: string, dropped: number, droppedBlocked: number}} the safe html, how many images
 *   were dropped for being pixels, and how many of those plan 1 had already counted as blocked
 */
export function dropTrackingPixels(html) {
  const input = typeof html === "string" ? html : "";
  if (input === "") return { html: "", dropped: 0, droppedBlocked: 0 };
  const counts = { dropped: 0, droppedBlocked: 0 };
  try {
    const safe = sanitizeHtml(cut(input, MAX_SANITIZE_HTML_CHARS), secondPassOptions(counts));
    return { html: safe, dropped: counts.dropped, droppedBlocked: counts.droppedBlocked };
  } catch {
    // A pass that fails vouches for nothing, so the body is empty rather than passed through.
    return { html: "", dropped: 0, droppedBlocked: 0 };
  }
}

/** The banner's number: the blocked images left once the dropped pixels are not counted twice. */
function blockedForBanner(blockedRemoteImageCount, droppedBlocked) {
  const blocked = Number(blockedRemoteImageCount);
  if (!Number.isFinite(blocked)) return 0;
  return Math.max(0, Math.trunc(blocked) - Math.max(0, Math.trunc(droppedBlocked)));
}

/**
 * The whole frame document: the body, one small stylesheet, the blocked-image count the helper
 * reports and the helper itself. Nothing else — no link, no base, no second script and no meta the
 * template does not emit.
 *
 * @param {string} bodyHtml an already-sanitised body (`bodyForDisplay`)
 * @param {{blockedRemoteImageCount?: number, lang?: string}} [options]
 * @returns {string} the document
 */
export function renderFrameDocument(bodyHtml, { blockedRemoteImageCount = 0, lang = "en" } = {}) {
  const body = dropTrackingPixels(bodyHtml);
  const blocked = blockedForBanner(blockedRemoteImageCount, body.droppedBlocked);
  const language = typeof lang === "string" && LANG_RE.test(lang) ? lang : "en";
  return [
    "<!doctype html>",
    `<html lang="${language}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="crow-blocked-images" content="${blocked}">`,
    `<style>${FRAME_STYLE}</style>`,
    "</head>",
    "<body>",
    body.html,
    `<script>${FRAME_HELPER_SOURCE}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * The headers the frame response carries. The route sets them in its handler, after the gateway's
 * global middleware, so this CSP replaces the dashboard page's rather than adding to it.
 *
 * `frame-ancestors 'self'` is the dashboard's own origin: a dashboard that is itself embedded by
 * another origin (a peer companion, say) will not show the reader's frame, which is acceptable
 * because the reader is owner-only.
 *
 * @param {{allowImages?: boolean}} [options] `allowImages` is this load's show-images decision
 * @returns {Record<string, string>} the headers
 */
export function frameHeaders({ allowImages = false } = {}) {
  const csp = [
    "default-src 'none'",
    `script-src ${FRAME_HELPER_CSP_SOURCE}`,
    `img-src ${allowImages === true ? "https:" : "'none'"}`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    `sandbox ${FRAME_IFRAME_SANDBOX}`,
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

export default renderFrameDocument;