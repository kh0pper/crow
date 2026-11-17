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
 *
 * The stored type is UNTRUSTED text — an uploader chooses it (the upload paths
 * accept any single `type/subtype`, and an object store's own content-type
 * flows in as a fallback) — so it is PARSED here, once, and the RAW string is
 * never emitted. A browser splits `Content-Type` on commas and uses the last
 * valid type, so `video/mp4, text/html` would pass an inline video check and
 * then be rendered as a page (confirmed in Chromium). Only a clean, single
 * `type/subtype` essence is ever sent, and an unclean value becomes
 * `application/octet-stream` on the attachment side.
 */

/** The `reference_type` marking a file a blog post may use. */
export const BLOG_POST_REFERENCE_TYPE = "blog_post";

/**
 * The refusal a BOT-BOUND caller gets when it tries to attach a file to a blog
 * post. `/blog/media` serves what a published public post uses, so a bot could
 * otherwise park a `text/html` object on a public post's id and have it served
 * on the dashboard's origin. A fixed string: it names no post and no file.
 * The owner (and an unidentified caller) is unaffected.
 *
 * On the HTTP side (`POST /storage/upload`) this is decided from the caller's
 * own `x-crow-actor-kind` header — the caller says whether it is a bot. That
 * check is ADVISORY: it is defense in depth against a cooperative bot, not a
 * trust boundary, and it is not what keeps a stored object safe. The boundary
 * is the serving rule in this module (what may be inline, and the parsed
 * `Content-Type` above), which decides on the object regardless of who
 * uploaded it.
 */
export const BLOG_POST_OWNER_ONLY_MESSAGE = "Only the owner can attach files to blog posts.";

/**
 * The fixed refusal an upload gets when its `mime_type` is not a single clean
 * `type/subtype`. It never echoes the value: the value is the thing being
 * refused (it may carry a comma-separated list or CR/LF). Same string on every
 * path — the MCP tool, `POST /storage/upload` and the presigned-upload branch —
 * and for the owner and a bot alike.
 */
export const INVALID_MIME_TYPE_MESSAGE =
  "Invalid mime_type: give one clean type/subtype (for example image/png), with no commas or control characters.";

/**
 * A clean MIME ESSENCE: `type/subtype` in the RFC token alphabet (lowercased).
 * A comma-shaped list, a malformed pair or a non-ASCII remainder never matches.
 */
const MIME_ESSENCE_TOKEN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/**
 * A character that may not appear ANYWHERE in a stored MIME string: a comma
 * (a browser reads a `Content-Type` as a list and takes the last valid type,
 * so `video/mp4, text/html` would become a page) or a control character
 * (CR/LF and friends: header splitting, and request-smuggling shapes).
 */
const MIME_FORBIDDEN = /[,\u0000-\u001f\u007f]/;

/**
 * Parse a stored/offered MIME string ONCE into the essence that may be used:
 * the part before the first `;`, trimmed and lowercased, provided the whole
 * string is free of commas and control characters and that essence is a clean
 * `type/subtype` token pair. Parameters are dropped (they are never emitted),
 * and anything unclean — a list, a CR/LF, an empty or malformed pair — is
 * `null`, which every caller treats as "not a type we will trust".
 * @param {string|null|undefined} mimeType
 * @returns {string|null} the clean essence, or null
 */
export function parseMediaType(mimeType) {
  const raw = String(mimeType ?? "");
  if (raw === "" || MIME_FORBIDDEN.test(raw)) return null;
  const essence = raw.split(";")[0].trim().toLowerCase();
  return MIME_ESSENCE_TOKEN.test(essence) ? essence : null;
}

/**
 * True when a value is a clean single `type/subtype` (optional `;params`). The
 * upload paths refuse anything else, so no new row can carry a comma-shaped
 * type; the parse in setMediaResponseHeaders still guards the rows already
 * stored, and the object store's own content-type.
 * An absent/empty value is not clean, so callers skip the check when they have
 * no type at all.
 * @param {string|null|undefined} mimeType
 * @returns {boolean}
 */
export function isCleanMediaType(mimeType) {
  return parseMediaType(mimeType) != null;
}

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
 * Only a CLEAN essence (parseMediaType) can be inline: a value with a comma, a
 * CR/LF or a malformed pair is never inline, whatever its head says.
 * @param {string|null|undefined} mimeType the row's stored MIME type
 * @param {string|null|undefined} s3Key the object's key (only `.sunvox` reads it)
 * @returns {boolean}
 */
export function isInlineMediaType(mimeType, s3Key) {
  const type = parseMediaType(mimeType);
  if (type == null) return false;
  if (INLINE_IMAGE_TYPES.has(type)) return true;
  if (type.startsWith("audio/") || type.startsWith("video/")) return true;
  if (type === "application/octet-stream") return /\.sunvox$/i.test(String(s3Key || ""));
  return false;
}

/**
 * The type a response may use: the storage row's own `mime_type` when it has
 * one (an unclean row type is FINAL — null, never replaced by the object
 * store's), otherwise the object store's `content-type` metadata, parsed by
 * exactly the same rule.
 * @param {{ mimeType?: string|null, objectContentType?: string|null }} opts
 * @returns {string|null}
 */
function resolveMediaType({ mimeType, objectContentType } = {}) {
  if (String(mimeType ?? "") !== "") return parseMediaType(mimeType);
  return parseMediaType(objectContentType);
}

/**
 * Set the response headers both media routes use for an object: nosniff, the
 * route's own cache policy, and — for anything outside the inline allowlist —
 * `Content-Disposition: attachment` plus a sandboxing CSP. No body is written
 * here.
 *
 * `Content-Type` is the parsed ESSENCE and nothing else: the raw stored string
 * is never emitted (see the module note on `video/mp4, text/html`). A clean
 * inline type goes out bare, with no parameters; anything else — an unclean
 * type, a document type, a type we do not know — goes out as the clean essence
 * (or `application/octet-stream` when there is none) as an attachment.
 * @param {{ set: Function }} res an Express response
 * @param {{ mimeType?: string|null, objectContentType?: string|null, s3Key?: string|null, cacheControl?: string|null }} opts
 *   `mimeType` is the storage row's type; `objectContentType` the object
 *   store's `content-type` metadata, used only when the row has none.
 */
export function setMediaResponseHeaders(res, { mimeType, objectContentType, s3Key, cacheControl } = {}) {
  const essence = resolveMediaType({ mimeType, objectContentType });
  res.set("Content-Type", essence || "application/octet-stream");
  res.set("X-Content-Type-Options", "nosniff");
  if (cacheControl) res.set("Cache-Control", cacheControl);
  if (essence == null || !isInlineMediaType(essence, s3Key)) {
    res.set("Content-Disposition", "attachment");
    res.set("Content-Security-Policy", "sandbox");
  }
}