/**
 * image-pin-allowlist — the `scripts/image-pin-allowlist.txt` format.
 *
 * `path image  # reason`, one line per entry; blank lines and full-line
 * comments are skipped. The list names the images this repo BUILDS itself (a
 * `build:` service), which therefore have no released upstream tag to pin.
 *
 * It is read from two places, and they must agree:
 *   - tests/compose-image-pins.test.js — allows those images and fails an entry
 *     that no longer matches a compose file (staleness);
 *   - the install path (servers/gateway/bundle-pull-alert.js) — a bundle whose
 *     compose builds its own image has nothing to download, so a failed
 *     `docker compose pull` for it must not ring the owner's bell.
 *
 * Keeping the parser here is what stops those two readers from drifting apart.
 */

import { sep } from "node:path";

/** `path image  # reason` lines; blank lines and full-line comments are skipped. */
export function parseImagePinAllowlist(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const body = line.replace(/(^|\s)#.*$/, "").trim();
    if (!body) continue;
    const [path, image] = body.split(/\s+/);
    if (!path || !image) continue;
    out.push({ path: path.split(sep).join("/"), image });
  }
  return out;
}

/** Does the list allow `image` for the compose file at repo-relative `path`? */
export function allowlistHas(entries, { path, image }) {
  return (entries || []).some((e) => e.path === path && e.image === image);
}