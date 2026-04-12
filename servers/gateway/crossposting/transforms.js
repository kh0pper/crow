/**
 * F.12.2: Cross-app transform library.
 *
 * One function per (source_app, target_app) pair. Each transform takes
 * the source post's metadata + content and returns a target-app-shaped
 * payload ready for publication.
 *
 * Transforms are PURE FUNCTIONS — no network I/O here. The crow_crosspost
 * dispatcher calls the transform, then hands the result to the target
 * bundle's own publish API. This lets transforms be unit-tested in
 * isolation and keeps the retry/idempotency layer above them.
 *
 * Rules for adding a transform:
 *   1. Pick a (source_app, target_app) pair where BOTH bundles speak the
 *      fediverse (don't transform into a closed platform).
 *   2. Respect the target's limits: Mastodon's 500-char default, GoToSocial's
 *      5000-char cap, etc.
 *   3. Always include an attribution footer ("via <source_url>") so the
 *      source stays authoritative. Delete-propagation is unreliable; the
 *      footer lets viewers navigate to the canonical post.
 *   4. Strip HTML → plaintext (or markdown) for the target unless the
 *      target explicitly supports the same HTML subset.
 */

const TRANSFORMS = {
  /**
   * WriteFreely long-form → Mastodon toot.
   * Summarize: title + excerpt + canonical URL. Assumes the target is
   * Mastodon (500 chars default).
   */
  "writefreely→mastodon": (post) => {
    const body = String(post.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const title = (post.title || "").trim();
    const url = post.url || "";
    const head = title ? `📝 ${title}\n\n` : "";
    const budget = 480 - head.length - url.length - 8;
    const excerpt = body.length > budget ? body.slice(0, Math.max(0, budget - 1)) + "…" : body;
    const text = `${head}${excerpt}\n\n${url}`.trim();
    return {
      status: text,
      visibility: "public",
      language: post.language || undefined,
    };
  },

  /**
   * GoToSocial toot → Mastodon toot. Identity-friendly passthrough since
   * both speak the same API; just adds "via <source_url>" footer so the
   * crosspost is visibly a mirror rather than a fresh status.
   */
  "gotosocial→mastodon": (post) => {
    const body = String(post.status || post.content || "");
    const url = post.url || "";
    const footer = url ? `\n\nvia ${url}` : "";
    const budget = 500 - footer.length;
    const main = body.length > budget ? body.slice(0, budget - 1) + "…" : body;
    return {
      status: main + footer,
      visibility: post.visibility || "public",
      spoiler_text: post.spoiler_text || undefined,
    };
  },

  /**
   * Pixelfed photo-post → Mastodon toot.
   * Mastodon supports media_ids but crossposting images means re-uploading
   * to the target — that's caller's responsibility. This transform emits
   * the text status + leaves media_urls as a list for the caller to
   * rehydrate as local uploads.
   */
  "pixelfed→mastodon": (post) => {
    const caption = (post.content_excerpt || post.content || "").replace(/<[^>]+>/g, " ").trim();
    const url = post.url || "";
    const footer = url ? `\n\n📷 ${url}` : "";
    const budget = 480 - footer.length;
    const text = caption.length > budget ? caption.slice(0, budget - 1) + "…" : caption;
    return {
      status: text + footer,
      visibility: post.visibility || "public",
      sensitive: post.sensitive === true,
      media_urls: (post.media_urls || []).slice(0, 4),
    };
  },

  /**
   * Funkwhale track → Mastodon toot (link post with title + artist).
   */
  "funkwhale→mastodon": (post) => {
    const title = post.title || post.name || "Track";
    const artist = post.artist ? ` — ${post.artist}` : "";
    const album = post.album ? ` (${post.album})` : "";
    const url = post.url || "";
    const text = `🎵 ${title}${artist}${album}\n\n${url}`.slice(0, 500);
    return { status: text, visibility: "public" };
  },

  /**
   * PeerTube video → Mastodon toot (link post with title + duration).
   */
  "peertube→mastodon": (post) => {
    const title = post.name || post.title || "Video";
    const duration = post.duration_seconds
      ? ` (${Math.floor(post.duration_seconds / 60)}:${String(post.duration_seconds % 60).padStart(2, "0")})`
      : "";
    const channel = post.channel ? ` — ${post.channel}` : "";
    const url = post.url || "";
    const text = `🎬 ${title}${duration}${channel}\n\n${url}`.slice(0, 500);
    return { status: text, visibility: "public" };
  },

  /**
   * Blog post (crow-blog native) → GoToSocial.
   */
  "blog→gotosocial": (post) => {
    const title = (post.title || "").trim();
    const url = post.url || "";
    const excerpt = (post.excerpt || "").replace(/<[^>]+>/g, " ").trim();
    const head = title ? `📝 ${title}\n\n` : "";
    const footer = url ? `\n\n${url}` : "";
    const budget = 4900 - head.length - footer.length;
    const body = excerpt.length > budget ? excerpt.slice(0, budget - 1) + "…" : excerpt;
    return { status: head + body + footer, visibility: "public" };
  },
};

export function transform(sourceApp, targetApp, post) {
  const key = `${sourceApp}→${targetApp}`;
  const fn = TRANSFORMS[key];
  if (!fn) {
    throw new Error(`No transform registered for ${sourceApp} → ${targetApp}. Supported pairs: ${Object.keys(TRANSFORMS).join(", ")}`);
  }
  return fn(post);
}

export const SUPPORTED_PAIRS = Object.freeze(Object.keys(TRANSFORMS));
