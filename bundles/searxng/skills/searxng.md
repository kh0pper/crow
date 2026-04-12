---
name: searxng
description: SearXNG — privacy-respecting metasearch engine aggregating 70+ sources
triggers:
  - "searxng"
  - "private search"
  - "search the web"
  - "buscar privado"
  - "búsqueda privada"
  - "metasearch"
tools:
  - searxng_search
  - searxng_list_engines
  - searxng_status
---

# SearXNG — privacy-respecting metasearch

SearXNG aggregates results from dozens of search engines (Google, Bing,
DuckDuckGo, Wikipedia, GitHub, arXiv, Stack Exchange, and many more)
without tracking or profiling you. It runs entirely on your host.

## First-run

1. Start the bundle from the Extensions panel.
2. The entrypoint seeds `~/.crow/searxng/settings.yml` on first boot and
   generates a random `secret_key` inline. You can edit this file later
   to enable/disable engines, tweak categories, or adjust rate limits —
   changes apply after a bundle restart.
3. Open **http://localhost:8098** to use the web UI, or call the MCP
   tools to query from an AI session.

## Using the MCP tools

- `searxng_search` — run a query, return the top 10 results
  ```
  searxng_search(query: "pgvector vs pgai", engines: "duckduckgo,wikipedia")
  ```
- `searxng_list_engines` — see which engines are active
- `searxng_status` — healthcheck

The search tool returns structured JSON (title, URL, content snippet,
engine, score) so downstream tools can chain on it.

## Enabling more engines

The default `settings.yml` uses SearXNG's bundled engine defaults. To
activate an engine that's disabled by default, open `~/.crow/searxng/
settings.yml` and add:

```yaml
engines:
  - name: github
    disabled: false
  - name: arxiv
    disabled: false
```

See [SearXNG's docs](https://docs.searxng.org/admin/settings/settings_engine.html)
for the full list.

## Trade-off: simplicity over stock-conforming config

The seeded `settings.yml` is intentionally minimal: `use_default_settings:
true` inherits SearXNG's upstream defaults, so we only need to override a
handful of fields (secret_key, instance_name, JSON format support,
bind_address). This works on day one and is easy to diff if upstream
changes. If you want tight control, replace the file wholesale — the
bundle's entrypoint only seeds it when it's missing.

## Bot detection and rate limits

SearXNG's built-in limiter is **off by default** in the seeded config so
MCP tool calls don't fight a bot-detection heuristic. If you expose
SearXNG publicly via Caddy, flip `limiter: true` in settings.yml and
restart. For local-only use, leaving it off is the right call.
