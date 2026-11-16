/**
 * The photo refs in a meta-glasses note's markdown, and what they become when
 * the note is rendered.
 *
 * A note stores the sentinel — `![caption](photo://<id>)` — and the panel
 * re-mints each ref to a freshly presigned object URL (or, when the object
 * store is unavailable, the on-disk read-only route) at render time, so a note
 * opened days later still shows its photos. This module owns the REPLACEMENT
 * half; the panel's routes.js owns the lookup and the minting.
 *
 * It lives here, not in panel/routes.js, because that file awaits the voice
 * deps and the DB at import time — a pure function cannot be tested through it.
 *
 * A photo can be GONE: its row deleted, its object pruned, its upload failed
 * with no file on disk. The old placeholder for that was an inline SVG
 * `data:image/svg+xml` URL, which the owner markdown renderer refuses on
 * purpose (an svg is a document, the same reason it refuses `data:image/svg+xml`
 * generally) — so a missing photo rendered as NOTHING, and the caption the
 * operator wrote was lost with it. Now a missing photo's IMAGE is replaced by
 * its caption, escaped as markdown text (so it can never become markup, a link
 * or an image of its own), and a bare ref to a missing photo becomes nothing.
 */

/**
 * The image form: `![caption](photo://<id>)`, keeping any trailing `"title"` in
 * `tail`. `[^\]]*` matches the caption the caption backfill writes (brackets are
 * stripped there, so a caption never contains `]`).
 */
const IMAGE_REF = /!\[([^\]]*)\]\(photo:\/\/(\d+)\b([^)]*)\)/g;
/** Any ref left over — operator-typed text, not an image. */
const BARE_REF = /photo:\/\/(\d+)\b/g;

/**
 * ASCII punctuation a caption must not carry unescaped: inline markup (`*`,
 * `` ` ``, `_`, `[`, `]`, `(`, `)`, `!`, `<`, `>`), a table cell (`|`), a
 * strikethrough (`~`), a heading (`#`), an entity (`&`) and the list/heading
 * markers that only matter at the start of a line (`-`, `+`, `.`) — the image
 * may sit alone on its line, so the caption lands at the start of one.
 */
const CAPTION_ESCAPE = /[\\`*_{}[\]()<>#!|~&+\-.]/g;

/**
 * `caption` as plain markdown text: one line, no markup of its own.
 * @param {string} caption
 * @returns {string}
 */
export function escapePhotoCaption(caption) {
  return String(caption ?? "")
    .replace(/\s+/g, " ")
    .trim()
    // `$&` is the whole match — CAPTION_ESCAPE has no capture group, so `$1`
    // would put a literal "$1" in place of every metacharacter.
    .replace(CAPTION_ESCAPE, "\\$&");
}

/**
 * Rewrite every `photo://<id>` in `content` to its resolved target.
 * @param {string} content the note's markdown (sentinels, not yet re-minted)
 * @param {Map<number, string|null>} resolved id → absolute/rooted URL, or
 *   `null` when the photo is gone (or could not be minted)
 * @returns {string}
 */
export function replacePhotoRefs(content, resolved) {
  const target = (idStr) => resolved.get(Number(idStr)) || null;
  return String(content ?? "")
    .replace(IMAGE_REF, (_match, caption, idStr, tail) => {
      const url = target(idStr);
      // Still an image → the same `![caption](url)` the sentinel stood for.
      if (url) return `![${caption}](${url}${tail})`;
      // Missing photo → its caption, as text, where the image was. An empty
      // caption leaves nothing at all, never a broken image.
      return escapePhotoCaption(caption);
    })
    .replace(BARE_REF, (_match, idStr) => target(idStr) || "");
}