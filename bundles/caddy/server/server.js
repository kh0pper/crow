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
  removeSite,
} from "./caddyfile.js";

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

  return server;
}
