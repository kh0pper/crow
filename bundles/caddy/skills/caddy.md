---
name: caddy
description: Caddy reverse proxy — automatic HTTPS for Crow bundles via Let's Encrypt
triggers:
  - "reverse proxy"
  - "caddy"
  - "https cert"
  - "letsencrypt"
  - "acme"
  - "expose bundle"
  - "public domain"
tools:
  - caddy_status
  - caddy_reload
  - caddy_list_sites
  - caddy_add_site
  - caddy_remove_site
  - caddy_add_federation_site
  - caddy_set_wellknown
  - caddy_add_matrix_federation_port
  - caddy_cert_health
---

# Caddy — reverse proxy with automatic HTTPS

Caddy runs in front of any bundle that needs a public domain and a real TLS
certificate. It owns ports **80** and **443** on all interfaces, answers
HTTP-01 / TLS-ALPN-01 challenges, and renews certificates automatically.

Once Caddy is installed, any future Crow bundle that wants to be reachable
at `https://example.com/...` just declares `requires.bundles: ["caddy"]` and
registers a site block via `caddy_add_site`.

## Prerequisites for real certificates

Before asking Caddy to terminate TLS for a domain, verify **all** of the
following:

1. **DNS**: the domain's `A` (and/or `AAAA`) record points to this host's
   public IP. Verify with `dig +short example.com`.
2. **Firewall / router**: ports 80 and 443 are open inbound. If Crow runs
   behind a home router, configure port-forwarding. ISPs occasionally block
   :80 — if HTTP-01 fails, consider DNS-01 challenge (not yet wired up in
   this bundle; edit the Caddyfile directly).
3. **No other web server**: nothing else on this host is listening on :80 or
   :443. Check with `sudo ss -tulnp | grep -E ':80 |:443 '`.
4. **ACME email**: `CADDY_EMAIL` is set in `.env` so Let's Encrypt can reach
   you for expiry notices.

Caddy will request a **real** Let's Encrypt certificate the first time a
domain is requested. It caches state in `~/.crow/caddy/data/` (mode 0700).

## Common tasks

### Route a Crow bundle under a public domain

```
caddy_add_site {
  "domain": "music.example.com",
  "upstream": "crow-funkwhale:80"
}
```

Caddy appends a block to `~/.crow/caddy/Caddyfile`, validates it via the
admin API, and reloads. The first HTTPS request to `notes.example.com`
triggers certificate issuance (usually completes in <10 seconds).

### Inspect current status

```
caddy_status
```

Returns the admin API address (`unix:<path>`: the socket
`~/.crow/caddy/run/admin.sock`), number of site blocks in the Caddyfile, number
of routes Caddy actually loaded, listen addresses, and ACME account emails.
An `admin_warning` means the Caddyfile's `admin` line is not Crow's socket line
(for example the old `admin 0.0.0.0:2019`, which every container on
`crow-federation` can reach): recreate the caddy container, whose entrypoint
moves the old line to the socket.

### The admin API

Caddy's admin API can rewrite its whole configuration, so it listens only on a
unix socket in the config folder (`run/`, mode 0700, owned by the user Crow
runs as); there is no admin port. Crow's tools find it from `CADDY_CONFIG_DIR`.
`CADDY_ADMIN_URL` is only for an unusual setup (`unix:/path/to.sock`, or an
http(s) URL). Docker Desktop on macOS or Windows (not WSL) cannot share a unix
socket through a bind mount; there, set your own `admin` line, publish its port
on 127.0.0.1 in a `docker-compose.override.yml` next to the bundle's compose
file (a bundle update replaces `docker-compose.yml` itself), and set
`CADDY_ADMIN_URL` to it.

### Remove a site

```
caddy_remove_site { "domain": "notes.example.com", "confirm": "yes" }
```

Destructive — the block is deleted from the Caddyfile and Caddy stops
serving it. Existing issued certificates remain in the ACME cache for
reuse if the site is re-added later.

### Manual edits

`~/.crow/caddy/Caddyfile` is yours to edit. Crow reads and writes this
file; it does **not** rebuild it from a template on restart. Advanced
directives (matchers, headers, rate limits, wildcards, DNS-01) go directly
in the file — then run `caddy_reload`.

## Federation helpers

Federated app bundles (Matrix-Dendrite, Mastodon, GoToSocial, Pixelfed,
PeerTube, Funkwhale, Lemmy, WriteFreely) use a richer set of directives
than a plain `reverse_proxy` — websocket upgrades, large request bodies,
longer timeouts, and standardized `/.well-known/` handlers. Four helper
tools cover this without requiring hand-edited Caddyfiles.

### Shared docker network

Installing Caddy creates the external docker network `crow-federation`
(via `scripts/post-install.sh`). Every federated bundle joins this same
network, so Caddy reaches upstreams by their container name on it (e.g.,
`crow-dendrite:8008`, `crow-gotosocial:8080`) rather than by host-published
port. Every upstream-taking tool checks that the name is a container on
`crow-federation` (start the extension first). No app
port is published to the host by default — federated apps are only
reachable through Caddy's 443.

### `caddy_add_federation_site`

One-shot configuration for a federated app. Idempotent — re-running with
the same domain replaces the existing block.

```
caddy_add_federation_site {
  "domain": "gts.example.com",
  "upstream": "crow-gotosocial:8080",
  "profile": "activitypub",
  "wellknown": {
    "nodeinfo": { "href": "https://gts.example.com/nodeinfo/2.0" }
  }
}
```

Profiles:

- `matrix` — 50 MB body (media), HTTP/1.1 + HTTP/2, 600s read timeout for
  federation backfill and long-polling sync.
- `activitypub` — 40 MB body, forwarded headers (Host, X-Real-IP,
  X-Forwarded-For, X-Forwarded-Proto), 300s read timeout. Works for
  GoToSocial, Pixelfed, Funkwhale, WriteFreely, BookWyrm, Mobilizon (one
  upstream). Mastodon and Lemmy need their own profile (below).
- `activitypub-mastodon` — the `activitypub` settings, plus
  `/api/v1/streaming` sent to `backend_upstream` (default
  `crow-mastodon-streaming:4000`); `upstream` is the web container
  (`crow-mastodon-web:3000`).
- `lemmy` — the `activitypub` settings, with the split Lemmy needs:
  lemmy-ui serves the web app only, so `/api`, `/pictrs`, `/feeds`,
  `/nodeinfo`, `/version`, `/.well-known`, `/sitemap.xml`, ActivityPub
  reads (GET/HEAD with `Accept: application/activity+json` or
  `application/ld+json`) and every other method go to `backend_upstream` (default
  `crow-lemmy:8536`); everything else goes to `upstream`
  (`crow-lemmy-ui:1234`).
- `peertube` — 8 GB body (direct video uploads), 1800s read/write
  timeouts.
- `generic-ws` — plain `reverse_proxy`, escape hatch.

`backend_upstream` is accepted only by the two split profiles. An upstream is
the app's container name on Caddy's network, as `name:port` (optionally
`http://`/`https://`): one name starting with a letter, never an IP address,
`localhost`, the Caddy container or port 2019 (Caddy's admin API).

### `caddy_set_wellknown`

Publish a `/.well-known/<path>` JSON handler on a domain that does NOT
otherwise reverse-proxy the federated app. The common case: delegating
Matrix federation via `.well-known/matrix/server` on the apex domain
when Matrix itself lives on a subdomain.

```
caddy_set_wellknown {
  "domain": "example.com",
  "kind": "matrix-server",
  "opts": { "delegate_to": "matrix.example.com:443" }
}
```

Kinds: `matrix-server`, `matrix-client`, `nodeinfo`, `host-meta`,
`webfinger`. Use `body_json` to override the canned payload entirely.

### `caddy_add_matrix_federation_port`

Matrix federation needs EITHER `.well-known/matrix/server` delegation OR
port 8448 reachable from peer servers. This tool takes the `:8448` path,
adding a second site block that requests its own Let's Encrypt cert for
the same SNI.

```
caddy_add_matrix_federation_port {
  "domain": "matrix.example.com",
  "upstream_8448": "crow-dendrite:8448"
}
```

Refuses to run if you already set `.well-known/matrix/server` for the
same domain — pick one. Opening 8448 requires a router/firewall port
forward; delegation avoids that at the cost of an apex HTTPS handler.

### `caddy_cert_health`

Surfaces TLS renewal problems that would otherwise stay silent until a
cert actually expires.

```
caddy_cert_health              # all domains
caddy_cert_health { "domain": "matrix.example.com" }
```

Returns per-domain `status: "ok" | "warning" | "error"`:

- **ok** — cert present, non-staging issuer, expires >30 days out.
- **warning** — expires 7–30 days, OR ACME staging issuer in use.
- **error** — expires <7 days, OR no cert loaded, OR lookup failed.

Check this before sending federated traffic through a new site — a
staging cert in use means browsers (and peer servers) will reject TLS.

## Phase 2 federation enforcement

Federation-capable bundles declare `requires.bundles: ["caddy"]`. PR 0's
dependency-enforcement refuses to install them unless Caddy is present,
surfacing a clear prereq error in the Extensions panel. Conversely, the
Caddy uninstall flow refuses to proceed while any federated bundle is
still installed — the `crow-federation` network would disappear out from
under them.
