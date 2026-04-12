/**
 * Federation profiles for Caddy.
 *
 * Each profile encodes the Caddyfile directives a federated app needs beyond
 * a plain `reverse_proxy`: websocket upgrades, large upload bodies, longer
 * proxy timeouts, and optional /.well-known/ handlers for actor/server
 * discovery. Profiles are designed to be idempotent — re-running
 * caddy_add_federation_site with the same domain replaces the block, never
 * duplicates.
 *
 * Profiles:
 *   matrix       — Matrix client-server on HTTPS. Pair with
 *                  caddy_add_matrix_federation_port for :8448 OR
 *                  caddy_set_wellknown with matrix-server delegation.
 *   activitypub  — Mastodon / GoToSocial / Pixelfed / WriteFreely /
 *                  Funkwhale / Lemmy / BookWyrm / Mobilizon. Emits webfinger
 *                  + host-meta + nodeinfo well-known handlers.
 *   peertube    — PeerTube. Large body (8 GiB), long timeouts for uploads.
 *   generic-ws  — Generic HTTP + websocket upgrade. Escape hatch.
 */

/**
 * Directive lines emitted inside a site block for each profile.
 * Each string is one line, leading whitespace stripped; appendSite indents.
 */
const PROFILE_DIRECTIVES = {
  matrix: [
    // Matrix client-server: large body for media, keep-alive for sync long-poll.
    "request_body {",
    "  max_size 50MB",
    "}",
    "reverse_proxy {upstream} {",
    "  transport http {",
    "    versions 1.1 2",
    "    read_timeout 600s",
    "  }",
    "}",
  ],
  activitypub: [
    // ActivityPub servers: 40 MB media ceiling covers Mastodon's default,
    // GoToSocial's default, Pixelfed's typical. Websocket upgrade for
    // Mastodon streaming API and GoToSocial's streaming.
    "request_body {",
    "  max_size 40MB",
    "}",
    "reverse_proxy {upstream} {",
    "  header_up Host {host}",
    "  header_up X-Real-IP {remote_host}",
    "  header_up X-Forwarded-For {remote_host}",
    "  header_up X-Forwarded-Proto {scheme}",
    "  transport http {",
    "    read_timeout 300s",
    "  }",
    "}",
  ],
  peertube: [
    // PeerTube: 8 GiB body for direct uploads, longer timeouts for
    // transcoded streaming responses.
    "request_body {",
    "  max_size 8GB",
    "}",
    "reverse_proxy {upstream} {",
    "  header_up Host {host}",
    "  header_up X-Real-IP {remote_host}",
    "  header_up X-Forwarded-For {remote_host}",
    "  header_up X-Forwarded-Proto {scheme}",
    "  transport http {",
    "    read_timeout 1800s",
    "    write_timeout 1800s",
    "  }",
    "}",
  ],
  "generic-ws": [
    "reverse_proxy {upstream}",
  ],
};

export const SUPPORTED_PROFILES = Object.keys(PROFILE_DIRECTIVES);

/**
 * Render the directives for a profile with the upstream substituted.
 * Returns a multi-line string with no site-block wrapper and no leading
 * indent; the Caddyfile writer indents each line as part of the block body.
 */
export function renderProfileDirectives(profile, upstream) {
  const template = PROFILE_DIRECTIVES[profile];
  if (!template) {
    throw new Error(
      `Unknown federation profile "${profile}". Supported: ${SUPPORTED_PROFILES.join(", ")}`,
    );
  }
  return template.map((line) => line.replace("{upstream}", upstream)).join("\n");
}

/**
 * Canonical JSON payloads for the most common .well-known handlers.
 * Operators may override with their own JSON via caddy_set_wellknown.
 *
 * `matrix-server` — delegates Matrix federation to a different host/port
 *                   (used instead of opening :8448).
 * `matrix-client` — points Matrix clients at the homeserver URL.
 * `nodeinfo`      — NodeInfo 2.0 discovery doc for ActivityPub servers.
 */
export function buildWellKnownJson(kind, opts = {}) {
  switch (kind) {
    case "matrix-server": {
      const target = opts.delegate_to;
      if (!target) {
        throw new Error(`matrix-server requires opts.delegate_to (e.g., "matrix.example.com:443")`);
      }
      return JSON.stringify({ "m.server": target });
    }
    case "matrix-client": {
      const base = opts.homeserver_base_url;
      if (!base) {
        throw new Error(`matrix-client requires opts.homeserver_base_url (e.g., "https://matrix.example.com")`);
      }
      const body = { "m.homeserver": { base_url: base } };
      if (opts.identity_server_base_url) {
        body["m.identity_server"] = { base_url: opts.identity_server_base_url };
      }
      return JSON.stringify(body);
    }
    case "nodeinfo": {
      const href = opts.href;
      if (!href) {
        throw new Error(`nodeinfo requires opts.href (e.g., "https://masto.example.com/nodeinfo/2.0")`);
      }
      return JSON.stringify({
        links: [{ rel: "http://nodeinfo.diaspora.software/ns/schema/2.0", href }],
      });
    }
    default:
      throw new Error(`Unknown well-known kind "${kind}". Known: matrix-server, matrix-client, nodeinfo`);
  }
}

/**
 * Reserved path prefixes under /.well-known/ for each app kind. Used to
 * build the `handle` directives caddy_add_federation_site emits when the
 * caller passes `wellknown: { matrix-server: {...}, nodeinfo: {...} }`.
 */
export const WELLKNOWN_PATHS = {
  "matrix-server": "/.well-known/matrix/server",
  "matrix-client": "/.well-known/matrix/client",
  nodeinfo: "/.well-known/nodeinfo",
  "host-meta": "/.well-known/host-meta",
  webfinger: "/.well-known/webfinger",
};

/**
 * Render a `handle <path>` block that returns a static JSON body.
 * Emitted inside the main site block. Caddy serves it with correct
 * Content-Type and lets the reverse_proxy handle everything else.
 */
export function renderWellKnownHandle(path, jsonBody) {
  // Caddy's respond directive needs the body on a single line or quoted.
  // We escape embedded double quotes, then wrap the body in double quotes.
  const escaped = jsonBody.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    `handle ${path} {`,
    `  header Content-Type application/json`,
    `  respond "${escaped}" 200`,
    `}`,
  ].join("\n");
}
