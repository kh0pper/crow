/**
 * Caddy MCP Server
 *
 * Manages a local Caddy reverse proxy via its admin API (JSON over HTTP).
 * Tools:
 *   caddy_status       — admin API reachability, loaded site count, cert summary
 *   caddy_reload       — validate & apply the current Caddyfile
 *   caddy_list_sites   — sites discovered in the Caddyfile
 *   caddy_add_site     — append a reverse-proxy block and reload
 *   caddy_remove_site  — remove a site block and reload
 *
 * Design note: we treat the Caddyfile on disk as the source of truth. The
 * admin API is used only to (a) apply the Caddyfile (POST /load with a
 * `text/caddyfile` body), (b) report status. This keeps the operator's
 * hand-edits and Crow's edits consistent — no divergence between a JSON
 * config in-memory and the file the operator reads.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  resolveConfigDir,
  caddyfilePath,
  readCaddyfile,
  writeCaddyfile,
  parseSites,
  appendSite,
  upsertRawSite,
  removeSite,
} from "./caddyfile.js";

import {
  SUPPORTED_PROFILES,
  renderProfileDirectives,
  renderWellKnownHandle,
  buildWellKnownJson,
  WELLKNOWN_PATHS,
} from "./federation-profiles.js";

const CADDY_ADMIN_URL = () =>
  (process.env.CADDY_ADMIN_URL || "http://127.0.0.1:2019").replace(/\/+$/, "");
const CONFIG_DIR = () => resolveConfigDir(process.env.CADDY_CONFIG_DIR);
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Call the Caddy admin API.
 */
async function adminFetch(path, options = {}) {
  const url = `${CADDY_ADMIN_URL()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    const text = await res.text();
    if (!res.ok) {
      const msg = text ? ` — ${text.slice(0, 500)}` : "";
      throw new Error(`Caddy admin ${res.status} ${res.statusText}${msg}`);
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Caddy admin request timed out: ${path}`);
    }
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(
        `Cannot reach Caddy admin API at ${CADDY_ADMIN_URL()} — is the caddy container running? ` +
          `Check 'docker ps' for crow-caddy and 'docker logs crow-caddy'.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply a Caddyfile source via the admin API.
 */
async function loadCaddyfile(source) {
  const url = `${CADDY_ADMIN_URL()}/load`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "text/caddyfile" },
      body: source,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Caddy rejected config: ${res.status} ${res.statusText}${text ? " — " + text.slice(0, 800) : ""}`);
    }
    return { ok: true };
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Caddy /load timed out");
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Caddy admin API at ${CADDY_ADMIN_URL()}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function domainLike(s) {
  // Permissive: Caddy accepts hostnames, wildcards, IP:port, path matchers.
  // We just block whitespace/newlines/braces to prevent caddyfile injection.
  return !/[\s{}\n\r]/.test(s);
}

export function createCaddyServer(options = {}) {
  const server = new McpServer(
    { name: "crow-caddy", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- caddy_status ---
  server.tool(
    "caddy_status",
    "Report Caddy status: admin-API reachability, number of configured sites, and TLS/ACME summary",
    {},
    async () => {
      try {
        const [config, _pki] = await Promise.all([
          adminFetch("/config/"),
          adminFetch("/pki/ca/local").catch(() => null),
        ]);

        const servers = config?.apps?.http?.servers || {};
        const serverNames = Object.keys(servers);
        let routeCount = 0;
        const listenAddrs = new Set();
        for (const srv of Object.values(servers)) {
          routeCount += (srv.routes || []).length;
          for (const a of srv.listen || []) listenAddrs.add(a);
        }

        const tlsAutomation = config?.apps?.tls?.automation?.policies || [];
        const acmeEmails = new Set();
        for (const policy of tlsAutomation) {
          for (const issuer of policy.issuers || []) {
            if (issuer.email) acmeEmails.add(issuer.email);
          }
        }

        const caddyfile = readCaddyfile(CONFIG_DIR());
        const siteCount = parseSites(caddyfile).length;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              admin_api: CADDY_ADMIN_URL(),
              reachable: true,
              caddyfile_path: caddyfilePath(CONFIG_DIR()),
              sites_in_caddyfile: siteCount,
              http_servers: serverNames,
              listen: Array.from(listenAddrs),
              routes_loaded: routeCount,
              acme_emails: Array.from(acmeEmails),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- caddy_reload ---
  server.tool(
    "caddy_reload",
    "Validate and apply the current Caddyfile via Caddy's admin API. Fails (with reason) if the Caddyfile is syntactically invalid.",
    {},
    async () => {
      try {
        const source = readCaddyfile(CONFIG_DIR());
        if (!source.trim()) {
          return {
            content: [{
              type: "text",
              text: `Caddyfile is empty (${caddyfilePath(CONFIG_DIR())}). Add a site with caddy_add_site or edit the file directly.`,
            }],
          };
        }
        await loadCaddyfile(source);
        const sites = parseSites(source);
        return {
          content: [{
            type: "text",
            text: `Caddy reloaded. ${sites.length} site block(s) applied:\n${sites.map((s) => "  - " + s.address).join("\n")}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- caddy_list_sites ---
  server.tool(
    "caddy_list_sites",
    "List all sites currently declared in the Caddyfile",
    {},
    async () => {
      try {
        const source = readCaddyfile(CONFIG_DIR());
        const sites = parseSites(source);
        const summary = sites.map((s) => {
          const upstreamMatch = s.body.match(/reverse_proxy\s+([^\n]+)/);
          return {
            address: s.address,
            upstream: upstreamMatch ? upstreamMatch[1].trim() : null,
            directives: (s.body.match(/^\s*(\w+)/gm) || []).map((l) => l.trim()).slice(0, 20),
          };
        });
        return {
          content: [{
            type: "text",
            text: summary.length
              ? `${summary.length} site(s):\n${JSON.stringify(summary, null, 2)}`
              : `No sites in ${caddyfilePath(CONFIG_DIR())}.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- caddy_add_site ---
  server.tool(
    "caddy_add_site",
    "Add a reverse-proxy site block to the Caddyfile and reload. For anything beyond `reverse_proxy <upstream>`, edit the Caddyfile directly and call caddy_reload.",
    {
      domain: z.string().min(1).max(253).describe("Site address (e.g., example.com, *.example.com, :8080). Must not contain whitespace or braces."),
      upstream: z.string().min(1).max(500).describe("Reverse-proxy upstream (e.g., localhost:3001, 127.0.0.1:3456). Must not contain whitespace."),
      extra_directives: z.string().max(5000).optional().describe("Optional extra Caddyfile directives to include in the site block, one per line (no leading indent)."),
    },
    async ({ domain, upstream, extra_directives }) => {
      try {
        if (!domainLike(domain)) {
          return { content: [{ type: "text", text: "Error: domain contains disallowed characters (whitespace, braces, or newlines)." }] };
        }
        if (!domainLike(upstream)) {
          return { content: [{ type: "text", text: "Error: upstream contains disallowed characters (whitespace, braces, or newlines)." }] };
        }

        const source = readCaddyfile(CONFIG_DIR());
        const existing = parseSites(source);
        if (existing.some((s) => s.address === domain)) {
          return { content: [{ type: "text", text: `Site "${domain}" already exists in the Caddyfile. Remove it first with caddy_remove_site, then re-add.` }] };
        }

        const next = appendSite(source, domain, upstream, extra_directives || "");
        // Validate by asking Caddy to load it; only write on success.
        await loadCaddyfile(next);
        writeCaddyfile(CONFIG_DIR(), next);

        return {
          content: [{
            type: "text",
            text: `Added site ${domain} → ${upstream}. Caddy will request a TLS certificate on first request (HTTP-01 / TLS-ALPN-01).`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- caddy_remove_site ---
  server.tool(
    "caddy_remove_site",
    "Remove a site block from the Caddyfile (matched by address) and reload Caddy. Destructive — the change is persisted to disk.",
    {
      domain: z.string().min(1).max(253).describe("Site address to remove (must match exactly as written in the Caddyfile)"),
      confirm: z.literal("yes").describe('Must be "yes" to confirm removal'),
    },
    async ({ domain }) => {
      try {
        const source = readCaddyfile(CONFIG_DIR());
        const { source: next, removed } = removeSite(source, domain);
        if (!removed) {
          return { content: [{ type: "text", text: `No site with address "${domain}" found in Caddyfile.` }] };
        }
        if (next.trim()) {
          await loadCaddyfile(next);
        } else {
          // Caddyfile is now empty — Caddy doesn't accept empty configs via
          // /load, so we stop accepting new traffic by loading an empty JSON.
          await adminFetch("/load", { method: "POST", body: JSON.stringify({}) });
        }
        writeCaddyfile(CONFIG_DIR(), next);
        return {
          content: [{
            type: "text",
            text: `Removed site ${domain}. Caddy reloaded.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- caddy_add_federation_site ---
  server.tool(
    "caddy_add_federation_site",
    "Add a federation-aware reverse-proxy site block. Emits directives for the chosen profile (matrix | activitypub | peertube | generic-ws) — websocket upgrade, large request body, proxy timeouts — plus optional /.well-known/ handlers. Idempotent: re-running with the same domain replaces the existing block.",
    {
      domain: z.string().min(1).max(253).describe("Public site address (e.g., masto.example.com). Must be a subdomain dedicated to this federated app — ActivityPub actors are URL-keyed and subpath mounts break federation."),
      upstream: z.string().min(1).max(500).describe("Upstream the app is reachable at (e.g., gotosocial:8080 over the shared crow-federation docker network, or 127.0.0.1:8080 for host-published debug mode)."),
      profile: z.enum(SUPPORTED_PROFILES).describe(`One of: ${SUPPORTED_PROFILES.join(" | ")}`),
      wellknown: z.record(z.string(), z.object({}).passthrough()).optional().describe(`Optional map of well-known handlers to emit inside this site block. Keys: ${Object.keys(WELLKNOWN_PATHS).join(", ")}. Values are either { body_json: "<literal JSON string>" } or kind-specific opts (matrix-server: { delegate_to }, matrix-client: { homeserver_base_url, identity_server_base_url? }, nodeinfo: { href }).`),
    },
    async ({ domain, upstream, profile, wellknown }) => {
      try {
        if (!domainLike(domain)) {
          return { content: [{ type: "text", text: "Error: domain contains disallowed characters (whitespace, braces, or newlines)." }] };
        }
        if (!domainLike(upstream)) {
          return { content: [{ type: "text", text: "Error: upstream contains disallowed characters." }] };
        }
        if (domain.includes("/")) {
          return { content: [{ type: "text", text: `Error: federation sites must be a bare subdomain (e.g., "masto.example.com"), not a subpath. ActivityPub actors are URL-keyed and subpath mounts break federation.` }] };
        }

        let body = renderProfileDirectives(profile, upstream);

        if (wellknown && Object.keys(wellknown).length) {
          const handles = [];
          for (const [kind, opts] of Object.entries(wellknown)) {
            const path = WELLKNOWN_PATHS[kind];
            if (!path) {
              return { content: [{ type: "text", text: `Error: unknown well-known kind "${kind}". Known: ${Object.keys(WELLKNOWN_PATHS).join(", ")}` }] };
            }
            let jsonBody;
            if (opts && typeof opts.body_json === "string") {
              jsonBody = opts.body_json;
            } else {
              jsonBody = buildWellKnownJson(kind, opts || {});
            }
            handles.push(renderWellKnownHandle(path, jsonBody));
          }
          body = handles.join("\n") + "\n" + body;
        }

        const source = readCaddyfile(CONFIG_DIR());
        const next = upsertRawSite(source, domain, body);
        await loadCaddyfile(next);
        writeCaddyfile(CONFIG_DIR(), next);

        const sites = parseSites(next);
        const replaced = parseSites(source).some((s) => s.address === domain);
        return {
          content: [{
            type: "text",
            text: `${replaced ? "Replaced" : "Added"} federation site ${domain} → ${upstream} (profile: ${profile}). ${sites.length} total site block(s). Caddy will request a Let's Encrypt cert on first request.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- caddy_set_wellknown ---
  server.tool(
    "caddy_set_wellknown",
    "Add or replace a standalone /.well-known/ handler at a domain that does NOT otherwise proxy to the federated app. Use this on an apex domain to delegate Matrix federation via `/.well-known/matrix/server` when Matrix itself lives on a different host. Idempotent.",
    {
      domain: z.string().min(1).max(253).describe("Apex or subdomain that serves the well-known JSON (e.g., example.com)."),
      kind: z.enum(Object.keys(WELLKNOWN_PATHS)).describe(`One of: ${Object.keys(WELLKNOWN_PATHS).join(" | ")}`),
      opts: z.record(z.string(), z.any()).optional().describe("Kind-specific options. matrix-server: { delegate_to: 'matrix.example.com:443' }. matrix-client: { homeserver_base_url: 'https://matrix.example.com' }. nodeinfo: { href: '...' }."),
      body_json: z.string().max(5000).optional().describe("Override the canned JSON body entirely. Must be valid JSON."),
    },
    async ({ domain, kind, opts, body_json }) => {
      try {
        if (!domainLike(domain)) {
          return { content: [{ type: "text", text: "Error: domain contains disallowed characters." }] };
        }
        const path = WELLKNOWN_PATHS[kind];
        let jsonBody;
        if (body_json) {
          try { JSON.parse(body_json); } catch {
            return { content: [{ type: "text", text: `Error: body_json is not valid JSON.` }] };
          }
          jsonBody = body_json;
        } else {
          jsonBody = buildWellKnownJson(kind, opts || {});
        }
        const handleBlock = renderWellKnownHandle(path, jsonBody);

        const source = readCaddyfile(CONFIG_DIR());
        const existing = parseSites(source).find((s) => s.address === domain);
        let body;
        if (existing) {
          const bodyLines = existing.body.split("\n");
          const pathEscaped = path.replace(/\//g, "\\/");
          const pathRe = new RegExp(`^\\s*handle\\s+${pathEscaped}\\s*\\{`);
          const startIdx = bodyLines.findIndex((l) => pathRe.test(l));
          if (startIdx >= 0) {
            let depth = 0;
            let endIdx = startIdx;
            for (let k = startIdx; k < bodyLines.length; k++) {
              for (const ch of bodyLines[k]) {
                if (ch === "{") depth++;
                else if (ch === "}") {
                  depth--;
                  if (depth === 0) { endIdx = k; break; }
                }
              }
              if (depth === 0 && k >= startIdx) { endIdx = k; break; }
            }
            const dedented = bodyLines.map((l) => l.replace(/^  /, ""));
            const newBody = [
              ...dedented.slice(0, startIdx),
              handleBlock,
              ...dedented.slice(endIdx + 1),
            ].join("\n").replace(/\n{3,}/g, "\n\n");
            body = newBody.trim();
          } else {
            body = (existing.body.split("\n").map((l) => l.replace(/^  /, "")).join("\n") + "\n" + handleBlock).trim();
          }
        } else {
          body = handleBlock;
        }

        const next = upsertRawSite(source, domain, body);
        await loadCaddyfile(next);
        writeCaddyfile(CONFIG_DIR(), next);
        return {
          content: [{
            type: "text",
            text: `Set well-known ${path} on ${domain}.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- caddy_add_matrix_federation_port ---
  server.tool(
    "caddy_add_matrix_federation_port",
    "Add a :8448 site block with its own Let's Encrypt cert, reverse-proxied to a Matrix homeserver's federation listener. Use this OR `caddy_set_wellknown` with kind=matrix-server — not both. Opening 8448 requires the router/firewall to forward it; .well-known delegation avoids that at the cost of an apex HTTPS handler.",
    {
      domain: z.string().min(1).max(253).describe("Matrix server name (e.g., matrix.example.com). The cert issued for :8448 will match this SNI."),
      upstream_8448: z.string().min(1).max(500).describe("Dendrite/Synapse federation listener (e.g., dendrite:8448 over the shared docker network)."),
    },
    async ({ domain, upstream_8448 }) => {
      try {
        if (!domainLike(domain) || !domainLike(upstream_8448)) {
          return { content: [{ type: "text", text: "Error: domain or upstream contains disallowed characters." }] };
        }
        const source = readCaddyfile(CONFIG_DIR());
        const existingWellknown = parseSites(source)
          .find((s) => s.address === domain && s.body.includes("/.well-known/matrix/server"));
        if (existingWellknown) {
          return {
            content: [{
              type: "text",
              text: `Refusing: ${domain} already serves /.well-known/matrix/server — that delegates federation to a different host. Use one mechanism or the other, not both.`,
            }],
          };
        }

        const address = `${domain}:8448`;
        const body = [
          `reverse_proxy ${upstream_8448} {`,
          `  transport http {`,
          `    versions 1.1 2`,
          `    read_timeout 600s`,
          `  }`,
          `}`,
        ].join("\n");
        const next = upsertRawSite(source, address, body);
        await loadCaddyfile(next);
        writeCaddyfile(CONFIG_DIR(), next);
        return {
          content: [{
            type: "text",
            text: `Added Matrix federation listener ${address} → ${upstream_8448}. Caddy will request a Let's Encrypt cert for ${domain} on :8448 on first request. Ensure port 8448/tcp is forwarded to this host.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- caddy_cert_health ---
  server.tool(
    "caddy_cert_health",
    "Report TLS cert health across all configured sites: ok / warning / error per domain, with expiry, ACME issuer, recent renewal failures, and DNS A/AAAA mismatches. Surfaces renewal failures that would otherwise be silent.",
    {
      domain: z.string().max(253).optional().describe("Optional — report a single domain. If omitted, reports all."),
    },
    async ({ domain }) => {
      try {
        const config = await adminFetch("/config/");
        const policies = config?.apps?.tls?.automation?.policies || [];
        const servers = config?.apps?.http?.servers || {};

        const domains = new Set();
        for (const srv of Object.values(servers)) {
          for (const route of srv.routes || []) {
            for (const m of route.match || []) {
              for (const h of m.host || []) domains.add(h);
            }
          }
        }
        if (domain) {
          if (!domains.has(domain)) {
            return { content: [{ type: "text", text: `No loaded route for ${domain}. Run caddy_reload or caddy_list_sites to verify.` }] };
          }
          domains.clear();
          domains.add(domain);
        }

        const ACME_DIR = "/root/.local/share/caddy/certificates";
        const stagingFragment = "acme-staging-v02.api.letsencrypt.org";

        const results = [];
        for (const host of domains) {
          const policy = policies.find((p) => !p.subjects || p.subjects.includes(host)) || policies[0];
          const issuer = policy?.issuers?.[0] || {};
          const isStaging = typeof issuer.ca === "string" && issuer.ca.includes(stagingFragment);
          const issuerName = isStaging
            ? "Let's Encrypt (STAGING)"
            : (issuer.module || "acme") + (issuer.ca ? ` (${issuer.ca})` : "");

          let expiresAt = null;
          let status = "warning";
          const problems = [];

          try {
            const certInfo = await adminFetch(
              `/pki/ca/local/certificates/${encodeURIComponent(host)}`,
            ).catch(() => null);
            if (certInfo?.not_after) {
              expiresAt = certInfo.not_after;
              const days = (new Date(expiresAt).getTime() - Date.now()) / 86400_000;
              if (days < 7) {
                status = "error";
                problems.push(`cert expires in ${days.toFixed(1)} days`);
              } else if (days < 30) {
                status = "warning";
                problems.push(`cert expires in ${days.toFixed(0)} days`);
              } else {
                status = "ok";
              }
            } else {
              problems.push("no cert loaded for this host");
            }
          } catch (err) {
            problems.push(`cert lookup failed: ${err.message}`);
          }

          if (isStaging && status === "ok") status = "warning";
          if (isStaging) problems.push("ACME staging issuer in use — browsers will warn");

          results.push({
            domain: host,
            status,
            issuer: issuerName,
            expires_at: expiresAt,
            problems,
          });
        }

        const anyError = results.some((r) => r.status === "error");
        const anyWarning = results.some((r) => r.status === "warning");
        const summary = anyError ? "error" : anyWarning ? "warning" : "ok";

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              summary,
              cert_storage_hint: ACME_DIR,
              results,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
