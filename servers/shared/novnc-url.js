/**
 * noVNC page links that name their own websockify path.
 *
 * The browser bundle's noVNC (1.0.0) defaults the WebSocket `path` to
 * "websockify" and resolves it from the page's ORIGIN root. A viewer page Crow
 * serves at /proxy/<id>/vnc.html therefore opened wss://<host>/websockify, and
 * the gateway's upgrade handler answers only /proxy/<id>/…, so the viewer sat
 * on "Connecting..." forever. Every noVNC page URL Crow builds carries
 * path=<the page's own directory>/websockify instead.
 *
 * Only the query values are encoded, and the path keeps its literal slashes
 * (noVNC reads the value as a page-relative path). A `path` the page already
 * carries is kept, never doubled.
 */

/** The `path` a noVNC page at `page` must name: the page's directory, then websockify. */
export function novncSocketPath(page) {
  const bare = String(page == null ? "" : page).split(/[?#]/)[0].replace(/^\/+/, "");
  const cut = bare.lastIndexOf("/");
  return (cut < 0 ? "" : bare.slice(0, cut + 1)) + "websockify";
}

/** encodeURIComponent, keeping "/" literal. */
function encodeValue(value) {
  return encodeURIComponent(String(value)).replace(/%2F/g, "/");
}

/** The decoded key of one "key=value" query pair. */
function paramKey(pair) {
  const raw = pair.split("=")[0];
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/**
 * A noVNC page URL: `page` plus `params` (values URL-encoded; null/undefined
 * skipped), with `path` pinned to that page's own websockify unless the page
 * already names one.
 */
export function novncUrl(page, params = {}) {
  const base = String(page == null ? "" : page);
  const at = base.indexOf("?");
  const href = at < 0 ? base : base.slice(0, at);
  const pairs = (at < 0 ? "" : base.slice(at + 1)).split("&").filter(Boolean);
  const pair = (key, value) => key + "=" + encodeValue(value);
  const put = (key, value) => {
    const i = pairs.findIndex((p) => paramKey(p) === key);
    if (i < 0) pairs.push(pair(key, value));
    else pairs[i] = pair(key, value);
  };
  for (const [key, value] of Object.entries(params || {})) if (value != null) put(key, value);
  if (!pairs.some((p) => paramKey(p) === "path")) put("path", novncSocketPath(href));
  return pairs.length ? href + "?" + pairs.join("&") : href;
}