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
 *
 * Split-upstream profiles (a second, `backend` upstream):
 *   lemmy                 — lemmy-ui serves the web app only and does not proxy the
 *                           API. As lemmy-ansible's nginx config (0.19 line) does:
 *                           /api, /pictrs, /feeds, /nodeinfo, /version, /.well-known
 *                           and /sitemap.xml; GET/HEAD asking for ActivityPub JSON
 *                           (Accept: application/activity+json or ld+json); and every
 *                           other method (inbox deliveries) go to Lemmy's backend, the
 *                           rest to lemmy-ui.
 *   activitypub-mastodon  — /api/v1/streaming to the streaming server, the rest to web.
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

// The proxy block every ActivityPub upstream gets (headers the apps use to build
// absolute URLs, and a timeout long enough for federation fetches).
const AP_PROXY = (upstream) => [
  `reverse_proxy ${upstream} {`,
  "  header_up Host {host}",
  "  header_up X-Real-IP {remote_host}",
  "  header_up X-Forwarded-For {remote_host}",
  "  header_up X-Forwarded-Proto {scheme}",
  "  transport http {",
  "    read_timeout 300s",
  "  }",
  "}",
];
const STREAM_PROXY = (upstream) => [
  `reverse_proxy ${upstream} {`,
  "  header_up Host {host}",
  "  header_up X-Real-IP {remote_host}",
  "  header_up X-Forwarded-For {remote_host}",
  "  header_up X-Forwarded-Proto {scheme}",
  "}",
];
const indent = (lines) => lines.map((l) => `  ${l}`);
const AP_BODY = ["request_body {", "  max_size 40MB", "}"];

// Profiles whose site splits traffic between two upstreams: { backend default, render }.
// Default backends are container names, never compose service names: on the shared
// crow-federation network a service alias such as `web` can belong to any project.
const SPLIT_PROFILES = {
  lemmy: {
    defaultBackend: "crow-lemmy:8536",
    render: (upstream, backend) => [
      ...AP_BODY,
      // Several paths in one matcher: keep it multi-path, so Caddy keeps these handles in
      // text order (it sorts by path length only single-path matchers).
      "@lemmy_backend {",
      "  path /api /api/* /pictrs /pictrs/* /feeds /feeds/* /nodeinfo /nodeinfo/* /version /.well-known/* /sitemap.xml",
      "}",
      // [+] instead of \+: no backslash for the Caddyfile lexer to interpret.
      "@lemmy_activitypub {",
      "  method GET HEAD",
      "  header_regexp Accept (?i)application/(activity|ld)[+]json",
      "}",
      "@lemmy_write {",
      "  not method GET HEAD",
      "}",
      "handle @lemmy_backend {", ...indent(AP_PROXY(backend)), "}",
      "handle @lemmy_activitypub {", ...indent(AP_PROXY(backend)), "}",
      "handle @lemmy_write {", ...indent(AP_PROXY(backend)), "}",
      "handle {", ...indent(AP_PROXY(upstream)), "}",
    ],
  },
  "activitypub-mastodon": {
    defaultBackend: "crow-mastodon-streaming:4000",
    render: (upstream, backend) => [
      ...AP_BODY,
      "@mastodon_streaming path /api/v1/streaming /api/v1/streaming/*",
      // No read timeout on the long-lived streaming connections (Caddy's defaults fit).
      "handle @mastodon_streaming {", ...indent(STREAM_PROXY(backend)), "}",
      "handle {", ...indent(AP_PROXY(upstream)), "}",
    ],
  },
};

export const SUPPORTED_PROFILES = [...Object.keys(PROFILE_DIRECTIVES), ...Object.keys(SPLIT_PROFILES)];

/** True when the profile routes part of the site to a second (backend) upstream. */
export function profileTakesBackend(profile) {
  return Object.hasOwn(SPLIT_PROFILES, profile);
}

/**
 * Why an upstream is not one the federation tools accept, or null. Fail-closed ALLOWLIST:
 * an upstream is a container name on Caddy's Docker network (crow-federation), as
 * `name[:port]`, optionally with an http:// or https:// scheme:
 *   - the name is ONE DNS label that starts with a letter (letters, digits, `-`, `_`,
 *     `.` not allowed): no IP literal in any form (dotted, decimal, hex, IPv6, IPv4-mapped),
 *     no FQDN that public DNS could point at 127.0.0.1;
 *   - never Caddy itself (`caddy`, `crow-caddy`) or `localhost`: Caddy runs in its own
 *     container, and an install not yet moved to the admin socket still has its admin API
 *     on 0.0.0.0:2019 there, so a proxied request to it could rewrite the whole
 *     configuration (the network check in server.js also drops every other name of that
 *     container, such as its short container ID);
 *   - the port is a decimal 1-65535 without leading zeros, and never 2019 (the old admin port).
 * Nothing it accepts can end a line, open a block, start a comment or quote in a Caddyfile.
 */
export function upstreamProblem(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > 300) return "an upstream must be a container name (name:port)";
  const m = s.match(/^(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/)?([A-Za-z][A-Za-z0-9_-]{0,62})(?::([0-9]+))?$/);
  if (!m) return "an upstream must be the app's container name on Caddy's network, as name:port (one name, starting with a letter; no IP address, no dots, spaces, braces, quotes or #)";
  if (m[2] !== undefined) {
    if (!/^[1-9][0-9]{0,4}$/.test(m[2])) return "an upstream port must be a number 1-65535 without leading zeros";
    const port = Number.parseInt(m[2], 10);
    if (port > 65535) return "an upstream port must be a number 1-65535 without leading zeros";
    if (port === 2019) return "an upstream may not be port 2019 (Caddy's admin API)";
  }
  const host = m[1].toLowerCase();
  if (host === "localhost" || host === "caddy" || host === "crow-caddy") {
    return "an upstream may not be Caddy itself (localhost or the Caddy container): name the app's container instead";
  }
  return null;
}

/** The container name of an upstream upstreamProblem accepts (lower-cased). */
export function upstreamHost(s) {
  return String(s).replace(/^https?:\/\//i, "").split(":")[0].toLowerCase();
}

/** The backend a split profile uses when backend_upstream is omitted. */
export function defaultBackend(profile) {
  return Object.hasOwn(SPLIT_PROFILES, profile) ? SPLIT_PROFILES[profile].defaultBackend : undefined;
}

/** True when upstreamProblem finds nothing. */
export function upstreamLike(s) {
  return upstreamProblem(s) === null;
}

/**
 * Render the directives for a profile with the upstream substituted.
 * Returns a multi-line string with no site-block wrapper and no leading
 * indent; the Caddyfile writer indents each line as part of the block body.
 * `backend` is the second upstream of a split profile (its default is used when
 * omitted); passing one to a single-upstream profile is an error, never ignored.
 */
export function renderProfileDirectives(profile, upstream, { backend } = {}) {
  const split = Object.hasOwn(SPLIT_PROFILES, profile) ? SPLIT_PROFILES[profile] : null;
  const template = Object.hasOwn(PROFILE_DIRECTIVES, profile) ? PROFILE_DIRECTIVES[profile] : null;
  if (!split && !template) {
    throw new Error(
      `Unknown federation profile "${profile}". Supported: ${SUPPORTED_PROFILES.join(", ")}`,
    );
  }
  const up = upstreamProblem(upstream);
  if (up) throw new Error(`upstream: ${up} (got ${JSON.stringify(String(upstream).slice(0, 80))})`);
  if (!split) {
    if (backend !== undefined && backend !== null && backend !== "") {
      throw new Error(`Profile "${profile}" has one upstream; backend_upstream is only for: ${Object.keys(SPLIT_PROFILES).join(", ")}`);
    }
    return template.map((line) => line.replace("{upstream}", upstream)).join("\n");
  }
  const be = backend === undefined || backend === null || backend === "" ? split.defaultBackend : backend;
  const bp = upstreamProblem(be);
  if (bp) throw new Error(`backend upstream: ${bp} (got ${JSON.stringify(String(be).slice(0, 80))})`);
  return split.render(upstream, be).join("\n");
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
 * JSON text that Caddy passes through untouched inside `respond "..."` (queue item 26f).
 *
 * Caddy expands `{$NAME}` in the raw Caddyfile at parse time and `{env.*}`, `{file.*}`,
 * `{http.*}` ... in a respond body at request time (an unknown `{key}` is skipped and the
 * scan resumes inside it, so nesting doesn't help). A user value such as
 * `{file./srv/caddy/caddy/...}` would otherwise publish a secret on a public path.
 *
 * The value is re-serialised, then inside every string literal `{`, `}`, `"` and `\` are
 * written as {, }, " and \ (the same JSON value). What is left:
 *  - braces only as JSON structure, each `{` followed by `"` or `}`: no placeholder key
 *    can start with `"`, and `{$` or a `{host}`-style shorthand cannot occur;
 *  - every `"` structural and never preceded by a backslash, so `\"` closes nothing early;
 *  - every backslash a JSON escape followed by a letter (u, n, t, ...), which Caddy's
 *    lexer keeps as is inside quotes (it unescapes only `\"`).
 * Throws on invalid JSON.
 */
export function caddySafeJson(jsonText) {
  const value = JSON.parse(jsonText);
  // 1e400 parses to Infinity and would re-serialise as null: refuse rather than change it.
  // (Integers past 2^53 lose precision in any JS JSON round-trip; well-known docs have none.)
  const finite = (v) => (typeof v === "number" ? Number.isFinite(v) : v && typeof v === "object" ? Object.values(v).every(finite) : true);
  if (!finite(value)) throw new Error("well-known JSON has a number too large to represent");
  const text = JSON.stringify(value);
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === '"') out += "\\u0022";
      else if (next === "\\") out += "\\u005c";
      else out += ch + next; // \n, \t, \b, \f, \r, \/, \uXXXX (the hex follows as plain chars)
      i++;
      continue;
    }
    if (ch === '"') { inString = false; out += ch; continue; }
    if (ch === "{") { out += "\\u007b"; continue; }
    if (ch === "}") { out += "\\u007d"; continue; }
    out += ch;
  }
  return out;
}

/**
 * Render a `handle <path>` block that returns a static JSON body.
 * Emitted inside the main site block. Caddy serves it with correct
 * Content-Type and lets the reverse_proxy handle everything else.
 */
export function renderWellKnownHandle(path, jsonBody) {
  // Inside a quoted Caddyfile token only `"` needs escaping (the lexer keeps every
  // other backslash literally); caddySafeJson leaves no backslash before a quote.
  const escaped = caddySafeJson(jsonBody).replace(/"/g, '\\"');
  return [
    `handle ${path} {`,
    `  header Content-Type application/json`,
    `  respond "${escaped}" 200`,
    `}`,
  ].join("\n");
}
