/**
 * Caddy API Routes — Express router for Crow's Nest Caddy panel
 *
 * Dashboard-only endpoints that proxy to the Caddy admin API and read/write
 * the managed Caddyfile. All endpoints are gated by dashboardAuth.
 */

import { Router } from "express";

import {
  resolveConfigDir,
  caddyfilePath,
  readCaddyfile,
  writeCaddyfile,
  parseSites,
  appendSite,
  removeSite,
} from "../server/caddyfile.js";

const CADDY_ADMIN_URL = () =>
  (process.env.CADDY_ADMIN_URL || "http://127.0.0.1:2019").replace(/\/+$/, "");
const CONFIG_DIR = () => resolveConfigDir(process.env.CADDY_CONFIG_DIR);
const TIMEOUT = 10_000;

async function adminGet(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(`${CADDY_ADMIN_URL()}${path}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

async function loadCaddyfile(source) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(`${CADDY_ADMIN_URL()}/load`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "text/caddyfile" },
      body: source,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 400)}`);
  } finally {
    clearTimeout(t);
  }
}

function domainLike(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 253 && !/[\s{}\n\r]/.test(s);
}

export default function caddyRouter(authMiddleware) {
  const router = Router();

  router.get("/api/caddy/status", authMiddleware, async (_req, res) => {
    try {
      const config = await adminGet("/config/");
      const servers = config?.apps?.http?.servers || {};
      const serverNames = Object.keys(servers);
      let routeCount = 0;
      const listenAddrs = new Set();
      for (const srv of Object.values(servers)) {
        routeCount += (srv.routes || []).length;
        for (const a of srv.listen || []) listenAddrs.add(a);
      }
      const policies = config?.apps?.tls?.automation?.policies || [];
      const emails = new Set();
      for (const p of policies) for (const i of p.issuers || []) if (i.email) emails.add(i.email);

      const source = readCaddyfile(CONFIG_DIR());
      const siteCount = parseSites(source).length;

      res.json({
        admin_api: CADDY_ADMIN_URL(),
        caddyfile_path: caddyfilePath(CONFIG_DIR()),
        sites_in_caddyfile: siteCount,
        http_servers: serverNames,
        routes_loaded: routeCount,
        listen: Array.from(listenAddrs),
        acme_emails: Array.from(emails),
      });
    } catch (err) {
      res.json({ error: `Cannot reach Caddy admin API: ${err.message}` });
    }
  });

  router.get("/api/caddy/sites", authMiddleware, (_req, res) => {
    try {
      const source = readCaddyfile(CONFIG_DIR());
      const sites = parseSites(source).map((s) => {
        const m = s.body.match(/reverse_proxy\s+([^\n]+)/);
        return { address: s.address, upstream: m ? m[1].trim() : null };
      });
      res.json({ sites });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.post("/api/caddy/sites", authMiddleware, async (req, res) => {
    try {
      const { domain, upstream } = req.body || {};
      if (!domainLike(domain)) return res.json({ error: "Invalid domain" });
      if (!domainLike(upstream) || upstream.length > 500) return res.json({ error: "Invalid upstream" });

      const source = readCaddyfile(CONFIG_DIR());
      const existing = parseSites(source);
      if (existing.some((s) => s.address === domain)) return res.json({ error: `Site ${domain} already exists` });

      const next = appendSite(source, domain, upstream, "");
      await loadCaddyfile(next);
      writeCaddyfile(CONFIG_DIR(), next);
      res.json({ ok: true });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.delete("/api/caddy/sites/:domain", authMiddleware, async (req, res) => {
    try {
      const domain = req.params.domain;
      if (!domainLike(domain)) return res.json({ error: "Invalid domain" });

      const source = readCaddyfile(CONFIG_DIR());
      const { source: next, removed } = removeSite(source, domain);
      if (!removed) return res.json({ error: `No site ${domain}` });

      if (next.trim()) {
        await loadCaddyfile(next);
      }
      writeCaddyfile(CONFIG_DIR(), next);
      res.json({ ok: true });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.get("/api/caddy/cert-health", authMiddleware, async (req, res) => {
    try {
      const config = await adminGet("/config/");
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
      if (req.query.domain && domainLike(req.query.domain)) {
        const d = req.query.domain;
        if (!domains.has(d)) return res.json({ results: [], summary: "ok" });
        domains.clear();
        domains.add(d);
      }

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
          const info = await adminGet(`/pki/ca/local/certificates/${encodeURIComponent(host)}`).catch(() => null);
          if (info?.not_after) {
            expiresAt = info.not_after;
            const days = (new Date(expiresAt).getTime() - Date.now()) / 86400_000;
            if (days < 7) { status = "error"; problems.push(`expires in ${days.toFixed(1)} days`); }
            else if (days < 30) { status = "warning"; problems.push(`expires in ${days.toFixed(0)} days`); }
            else { status = "ok"; }
          } else {
            problems.push("no cert loaded");
          }
        } catch (err) {
          problems.push(`lookup failed: ${err.message}`);
        }
        if (isStaging) {
          if (status === "ok") status = "warning";
          problems.push("ACME staging issuer in use");
        }
        results.push({ domain: host, status, issuer: issuerName, expires_at: expiresAt, problems });
      }

      const anyError = results.some((r) => r.status === "error");
      const anyWarn = results.some((r) => r.status === "warning");
      res.json({ summary: anyError ? "error" : anyWarn ? "warning" : "ok", results });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.post("/api/caddy/reload", authMiddleware, async (_req, res) => {
    try {
      const source = readCaddyfile(CONFIG_DIR());
      if (!source.trim()) return res.json({ error: "Caddyfile is empty" });
      await loadCaddyfile(source);
      res.json({ ok: true });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
