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
  "domain": "notes.example.com",
  "upstream": "localhost:3040"
}
```

Caddy appends a block to `~/.crow/caddy/Caddyfile`, validates it via the
admin API, and reloads. The first HTTPS request to `notes.example.com`
triggers certificate issuance (usually completes in <10 seconds).

### Inspect current status

```
caddy_status
```

Returns the admin API URL, number of site blocks in the Caddyfile, number
of routes Caddy actually loaded, listen addresses, and ACME account emails.

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

## Phase 2 federation note

When federation-capable bundles land (Matrix, Mastodon, etc.), they will
declare `requires.bundles: ["caddy"]`. PR 0's dependency-enforcement will
refuse to install them unless Caddy is present, surfacing a clear prereq
error in the Extensions panel.
