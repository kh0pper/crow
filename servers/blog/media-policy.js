/**
 * How a stored object is served — the one rule both media routes share:
 *
 *   - `GET /blog/media/:key(*)` (servers/gateway/routes/blog-public.js), the
 *     Funnel-public route, which serves a key only while a PUBLISHED PUBLIC
 *     post uses it (as its cover, or linked in its text), and
 *   - `GET /dashboard/media/:key(*)` (servers/gateway/routes/owner-media.js),
 *     the owner's own preview / Files route, behind the dashboard session.
 *
 * Both answer with the SAME type rule, so a stored object is never an inline
 * DOCUMENT on either origin. Inline is only what a browser can draw or play
 * and cannot read as a page:
 *
 *   - a raster image (png, jpeg, gif, webp, avif) — never `image/svg+xml`,
 *     which is a document that runs script;
 *   - any `audio/*` or `video/*`;
 *   - `application/octet-stream` ONLY for a `.sunvox` key: the songbook's
 *     player fetches the project as bytes and loads it into the SunVox WASM
 *     engine, so the type is what the fetch already is (octet-stream), not a
 *     document either origin would render.
 *
 * Everything else — `text/html`, SVG, PDF, XML, JSON, an unknown type — goes
 * out as an ATTACHMENT under `Content-Security-Policy: sandbox`, and every
 * response carries `X-Content-Type-Options: nosniff` whatever its type. That
 * is what stops a `text/html` upload linked from a public post from executing
 * on the dashboard's origin (the stored-XSS finding). `application/pdf` is
 * deliberately on the attachment side: the dashboard origin serves the
 * owner's own session, and a PDF viewer is a script surface we do not need.
 */

/** The `reference_type` marking a file a blog post may use. */
export const BLOG_POST_REFERENCE_TYPE = "blog_post";

/**
 * The refusal a BOT-BOUND caller gets when it tries to attach a file to a blog
 * post. `/blog/media` serves what a published public post uses, so a bot could
 * otherwise park a `text/html` object on a public post's id and have it served
 * on the dashboard's origin. A fixed string: it names no post and no file.
 * The owner (and an unidentified caller) is unaffected.
 */
export const BLOG_POST_OWNER_ONLY_MESSAGE = "Only the owner can attach files to blog posts.";

/** The raster image types a browser draws and cannot execute. Never svg. */
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/**
 * True when an object of this type (and key) may be served INLINE — drawn or
 * played in the page — rather than downloaded. Anything else is an attachment
 * with a sandboxing CSP (see setMediaResponseHeaders).
 * @param {string|null|undefined} mimeType the row's stored MIME type
 * @param {string|null|undefined} s3Key the object's key (only `.sunvox` reads it)
 * @returns {boolean}
 */
export function isInlineMediaType(mimeType, s3Key) {
  const type = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (INLINE_IMAGE_TYPES.has(type)) return true;
  if (type.startsWith("audio/") || type.startsWith("video/")) return true;
  if (type === "application/octet-stream") return /\.sunvox$/i.test(String(s3Key || ""));
  return false;
}

/**
 * Set the response headers both media routes use for an object: the type from
 * the storage row, nosniff, the route's own cache policy, and — for anything
 * outside the inline allowlist — `Content-Disposition: attachment` plus a
 * sandboxing CSP. No body is written here.
 * @param {{ set: Function }} res an Express response
 * @param {{ mimeType?: string|null, s3Key?: string|null, cacheControl?: string|null }} opts
 */
export function setMediaResponseHeaders(res, { mimeType, s3Key, cacheControl } = {}) {
  res.set("Content-Type", mimeType || "application/octet-stream");
  res.set("X-Content-Type-Options", "nosniff");
  if (cacheControl) res.set("Cache-Control", cacheControl);
  if (!isInlineMediaType(mimeType, s3Key)) {
    res.set("Content-Disposition", "attachment");
    res.set("Content-Security-Policy", "sandbox");
  }
}