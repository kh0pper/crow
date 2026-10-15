/**
 * A tiny HTML allowlist for owner-supplied blurbs (the blog collections
 * config's `featured.blurbHtml`): <em>, <strong> and <a href> with an absolute
 * http(s) URL. Everything else — other tags, attributes, event handlers,
 * javascript:/data: URLs, protocol-relative and relative hrefs — is removed.
 * Kept links get rel="noopener noreferrer".
 */
import sanitizeHtml from "sanitize-html";

const ABSOLUTE_HTTP = /^https?:\/\//i;

const OPTIONS = {
  allowedTags: ["em", "strong", "a"],
  allowedAttributes: { a: ["href", "rel"] },
  allowedSchemes: ["http", "https"],
  allowedSchemesByTag: {},
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  transformTags: {
    a: (tagName, attribs) => {
      const href = typeof attribs.href === "string" ? attribs.href.trim() : "";
      if (!ABSOLUTE_HTTP.test(href)) return { tagName, attribs: {} };
      return { tagName, attribs: { href, rel: "noopener noreferrer" } };
    },
  },
};

export function sanitizeLimitedHtml(html) {
  if (typeof html !== "string" || html === "") return "";
  return sanitizeHtml(html, OPTIONS);
}
