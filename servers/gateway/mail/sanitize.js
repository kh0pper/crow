/**
 * Crow Mail's message sanitiser: the html body of an untrusted message in, a small allow-list of
 * tags and attributes out. The reader renders this, so the policy is deny-by-default: a tag, an
 * attribute or a URL scheme that is not named here does not come out the other side.
 *
 * What survives is what a mail body needs to read as mail: paragraphs, headings, lists, quotes,
 * tables, inline emphasis, and links. `style`, `class`, `id`, `srcset`, `background` and every
 * `on*` handler are gone, and every kept `<a>` carries `target="_blank"` and
 * `rel="noopener noreferrer nofollow"` — the sanitiser sets them, and the sender cannot override
 * them because the transform builds the attribute map from scratch.
 *
 * Remote images are blocked unless the caller allows them. A kept `<img src>` must be an absolute
 * `https:` URL and the caller must have asked for it. Every image the policy removes for being
 * remote — http, https, and a protocol-relative `//host/path` (which resolves to http or https and is
 * therefore remote) — is counted as blocked and comes out with `data-crow-blocked="1"`, the marker
 * plan 2 reads to avoid counting a dropped tracking pixel twice. `data-crow-blocked` is in the `img`
 * attribute allow-list, which is what lets the transform's own attribute survive sanitising; the
 * allow-list would equally let a sender's through, so the transform rebuilds every `<img>` from
 * scratch and a sender-supplied marker is deleted on every image, allowed or not. A `cid:` or
 * `data:` source is a part of the message itself, not a remote fetch: it is removed and not counted
 * (plan 2 owns rendering `cid:` images from the attachment list).
 *
 * `input` is cut at MAX_SANITIZE_HTML_CHARS before sanitising. Stored bodies are already cut at
 * MAX_BODY_CHARS (parse.js), so this is a bound for callers that hand over something else; it also
 * caps the escape amplification of a body that is nothing but `<` (5 MB of it renders as 20 MB of
 * text). The cut can land inside a tag, which the parser discards or escapes as text.
 *
 * Nothing here logs and nothing here throws: a sanitiser failure is an empty body, never the
 * unsanitised input.
 */
import sanitizeHtml from "sanitize-html";

/** The html input is cut to this many characters before it reaches sanitize-html. */
export const MAX_SANITIZE_HTML_CHARS = 2 * 1024 * 1024;

/** The marker attribute a blocked remote image carries out of the sanitiser. */
export const BLOCKED_IMAGE_ATTRIBUTE = "data-crow-blocked";

const LINK_REL = "noopener noreferrer nofollow";
const LINK_TARGET = "_blank";

const ALLOWED_TAGS = [
  "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "i", "img", "li", "ol", "p", "pre", "span", "strong", "sub", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "u", "ul",
];

/**
 * Per-tag attribute allow-list. `target` and `rel` are here because the `a` transform adds them;
 * `data-crow-blocked` is here because the `img` transform adds it. An attribute outside this map is
 * deleted by sanitize-html, so `on*`, `style`, `class`, `id`, `srcset` and `background` never reach
 * the output even as a tag-specific accident.
 */
const ALLOWED_ATTRIBUTES = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "width", "height", BLOCKED_IMAGE_ATTRIBUTE],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
};

/** The schemes a link may keep. Images are narrower: absolute https only, see imageSrcPolicy. */
const ALLOWED_SCHEMES = ["http", "https", "mailto", "tel"];

/**
 * Tags that are not html content: dropped together with everything inside them. sanitize-html's own
 * list is script/style/textarea/option; the rest are active content a reader must never get — an
 * embed, a frame, a form, an SVG or MathML island (both can carry script), a refresher, a base URL,
 * and a noscript block browser parsing rules make easy to abuse. Adding them here is what makes the
 * drop take their content with it, including a nested tag that tries to reopen itself. Leaving
 * `textarea` and `option` out would keep a disallowed tag's raw text; keeping them in is harmless
 * because neither is in the allow-list.
 */
const NON_TEXT_TAGS = [
  "script", "style", "textarea", "option",
  "iframe", "object", "embed", "form", "svg", "math", "link", "meta", "base", "noscript",
];

/** Control characters in a URL value: strippable, never part of a scheme. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** Everything a browser ignores before reading a URL scheme (char codes 32 and below). */
const URL_BLANKS = /[\x00-\x20]+/g;

/** An absolute http(s) URL: a scheme, then `//`, then at least one more character. */
const ABSOLUTE_HTTP = /^https?:\/\/./i;

const IMAGE_WIDTH_HEIGHT = ["alt", "width", "height"];

/**
 * Cut `value` to at most `limit` characters, never through a surrogate pair (a lone half would make
 * the output an invalid string).
 */
function cut(value, limit) {
  if (value.length <= limit) return value;
  let end = limit;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** A URL value with its control characters removed and its ends trimmed. */
function cleanUrl(value) {
  return value.replace(CONTROL_CHARS, "").trim();
}

/**
 * The lower-cased scheme of `url`, or null when it has none — matching what a browser reads, so
 * `java\tscript:` names `javascript` and `//host/path` names nothing at all.
 */
function schemeOf(url) {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(URL_BLANKS, ""));
  return match ? match[1].toLowerCase() : null;
}

/**
 * The href a kept link gets: an absolute http(s) URL or a `mailto:`/`tel:` with something after the
 * colon. Everything else — `javascript:`, `data:`, an unknown scheme, a relative path and a
 * protocol-relative `//host` — answers null and the href is dropped, leaving the link's text.
 */
function safeHref(value) {
  if (typeof value !== "string") return null;
  const url = cleanUrl(value);
  if (url === "") return null;
  const scheme = schemeOf(url);
  if (scheme === null || !ALLOWED_SCHEMES.includes(scheme)) return null;
  const compact = url.replace(URL_BLANKS, "");
  if (scheme === "http" || scheme === "https") return ABSOLUTE_HTTP.test(compact) ? url : null;
  return compact.length > scheme.length + 1 ? url : null;
}

/**
 * What to do with one `<img src>`: `"show"` (an absolute https URL the caller allowed), `"block"`
 * (a remote image the policy refuses — counted and marked) or `"drop"` (no src, a `cid:`/`data:`
 * part, a relative path or something that is not an image address at all — uncounted).
 */
function imageSrcPolicy(value, allowRemoteImages) {
  if (typeof value !== "string") return "drop";
  const url = cleanUrl(value);
  if (url === "") return "drop";
  const compact = url.replace(URL_BLANKS, "");
  // A protocol-relative reference is remote: it fetches from a host, over http or https, and it is
  // never the https URL this policy would show.
  if (/^[/\\]{2}/.test(compact)) return "block";
  const scheme = schemeOf(url);
  if (scheme === "cid" || scheme === "data") return "drop";
  if (scheme === "http") return "block";
  if (scheme === "https") return allowRemoteImages && ABSOLUTE_HTTP.test(compact) ? "show" : "block";
  return "drop";
}

/** The options for one call. The counters live in `counts`, which the transforms below update. */
function optionsFor(counts, allowRemoteImages) {
  return {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: {
      a: [...ALLOWED_ATTRIBUTES.a],
      img: [...ALLOWED_ATTRIBUTES.img],
      td: [...ALLOWED_ATTRIBUTES.td],
      th: [...ALLOWED_ATTRIBUTES.th],
    },
    allowedSchemes: [...ALLOWED_SCHEMES],
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: [...NON_TEXT_TAGS],
    // No `style` attribute can survive, so the CSS is never parsed: skipping that keeps a large body
    // cheap to sanitise.
    parseStyleAttributes: false,
    transformTags: {
      a: (tagName, attribs) => {
        const out = {};
        const href = safeHref(attribs.href);
        if (href !== null) out.href = href;
        if (typeof attribs.title === "string" && attribs.title.trim() !== "") out.title = attribs.title;
        out.target = LINK_TARGET;
        out.rel = LINK_REL;
        return { tagName, attribs: out };
      },
      img: (tagName, attribs) => {
        // Built from scratch, so every attribute the sender wrote — including a `data-crow-blocked`
        // it planted to look like a blocked image — is forgotten. Only this function marks images.
        const policy = imageSrcPolicy(attribs.src, allowRemoteImages);
        const out = {};
        if (policy === "show") out.src = cleanUrl(attribs.src);
        for (const name of IMAGE_WIDTH_HEIGHT) {
          if (typeof attribs[name] === "string") out[name] = attribs[name];
        }
        if (policy === "block") {
          counts.remoteImageCount += 1;
          counts.blockedRemoteImageCount += 1;
          out[BLOCKED_IMAGE_ATTRIBUTE] = "1";
        } else if (policy === "show") {
          counts.remoteImageCount += 1;
        }
        return { tagName, attribs: out };
      },
    },
  };
}

/**
 * Sanitise one message html body.
 *
 * @param {*} html the stored html, untrusted
 * @param {{allowRemoteImages?: boolean}} [opts] `allowRemoteImages` shows absolute https images
 * @returns {{html: string, remoteImageCount: number, blockedRemoteImageCount: number}} the safe
 *   html, how many remote images the body had, and how many of those were blocked
 */
export function sanitizeMessageHtml(html, opts) {
  const input = typeof html === "string" ? html : "";
  const allowRemoteImages = opts != null && typeof opts === "object" && opts.allowRemoteImages === true;
  const counts = { remoteImageCount: 0, blockedRemoteImageCount: 0 };
  if (input === "") return { html: "", ...counts };

  const source = cut(input, MAX_SANITIZE_HTML_CHARS);
  let safe;
  try {
    safe = sanitizeHtml(source, optionsFor(counts, allowRemoteImages));
  } catch {
    // A sanitiser that fails vouches for nothing, so the body is empty rather than passed through.
    return { html: "", remoteImageCount: 0, blockedRemoteImageCount: 0 };
  }
  return {
    html: safe,
    remoteImageCount: counts.remoteImageCount,
    blockedRemoteImageCount: counts.blockedRemoteImageCount,
  };
}

/**
 * A plain-text body as safe html: escaped, with each line break kept as `<br>`. Nothing is
 * linkified — a URL in a message stays text.
 */
export function textToSafeHtml(text) {
  if (typeof text !== "string" || text === "") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/** The first of `values` that is a string with something other than whitespace in it, else null. */
function firstBody(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * The body a reader displays, from a stored message row: the html when the message had one, the
 * plain text otherwise, and nothing when it had neither. The store's row (`getMessage`) carries
 * `bodyHtml`/`bodyText`; the column names `body_html`/`body_text` are accepted too, so a raw row
 * works.
 *
 * @param {object|null} row a message row
 * @param {{allowRemoteImages?: boolean}} [opts] passed to sanitizeMessageHtml
 * @returns {{html: string, remoteImageCount: number, blockedRemoteImageCount: number,
 *   source: "html"|"text"|"none"}}
 */
export function bodyForDisplay(row, opts) {
  const source = row != null && typeof row === "object" ? row : {};
  const html = firstBody([source.bodyHtml, source.body_html]);
  if (html !== null) {
    return { ...sanitizeMessageHtml(html, opts), source: "html" };
  }
  const text = firstBody([source.bodyText, source.body_text]);
  if (text !== null) {
    return { html: textToSafeHtml(text), remoteImageCount: 0, blockedRemoteImageCount: 0, source: "text" };
  }
  return { html: "", remoteImageCount: 0, blockedRemoteImageCount: 0, source: "none" };
}