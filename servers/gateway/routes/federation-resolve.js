/**
 * Federation — instance name resolver (Phase 3 follow-up).
 *
 * GET /dashboard/federation/resolve-instance?name=<query>
 *
 * Takes a human-readable instance name and returns the unique matching
 * instance id. Used by the companion skill (and anything else that needs
 * to talk to a named peer) to avoid silently picking the wrong peer when
 * names collide.
 *
 * Matching strategy (first hit wins):
 *   1. Exact name (case-insensitive) on a trusted row.
 *   2. Short hostname match (case-insensitive, first dotted segment).
 *   3. Instance-id prefix (≥ 8 chars).
 *
 * Returns:
 *   200 { id, name, hostname, gateway_url, host_tag }
 *     when exactly one trusted instance matches.
 *   400 { error: "ambiguous", matches: [{id,name,hostname}, ...] }
 *     when the query matches multiple rows — caller MUST ask the user.
 *   404 { error: "not_found" }
 *     when no row matches. Includes `suggestions` (up to 3 closest names).
 *   400 { error: "missing_name" }
 *     when ?name is absent or empty.
 *
 * Auth: session-auth via dashboardAuth (inherited upstream). Not HMAC-gated;
 * this is a read-only query over data we already serve to session users via
 * the unified dashboard.
 *
 * Scope: only trusted + non-revoked instances are considered. Revoked rows
 * are intentionally excluded — the whole point is disambiguating ACTIVE
 * peer targets, not archaeological ones.
 */

import { Router } from "express";
import { getTrustedInstances } from "../dashboard/panels/nest/data-queries.js";

function shortHostname(h) {
  return String(h || "").split(".")[0].toLowerCase();
}

function toMatchRow(r) {
  return {
    id: r.id,
    name: r.name || null,
    hostname: r.hostname || null,
    gateway_url: r.gateway_url || null,
    host_tag: shortHostname(r.hostname),
  };
}

/**
 * Levenshtein-ish distance capped at 3 — good enough for
 * "did-you-mean" suggestions without pulling in a dependency.
 */
function closeness(a, b) {
  if (!a || !b) return Infinity;
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  let d = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) d++;
    if (d > 3) return Infinity;
  }
  return d;
}

export default function federationResolveRouter({ createDbClient }) {
  const router = Router();

  router.get("/federation/resolve-instance", async (req, res) => {
    const name = String(req.query.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "missing_name" });
    }

    const db = createDbClient();
    try {
      const trusted = await getTrustedInstances(db);
      if (!trusted.length) {
        return res.status(404).json({ error: "not_found", suggestions: [] });
      }

      const lower = name.toLowerCase();

      // 1. Exact name match (case-insensitive)
      let matches = trusted.filter(r => (r.name || "").toLowerCase() === lower);

      // 2. Short hostname match
      if (matches.length === 0) {
        matches = trusted.filter(r => shortHostname(r.hostname) === lower);
      }

      // 3. ID prefix (≥ 8 chars only — avoid ambiguity with short names)
      if (matches.length === 0 && name.length >= 8 && /^[a-fA-F0-9-]+$/.test(name)) {
        matches = trusted.filter(r => (r.id || "").toLowerCase().startsWith(lower));
      }

      if (matches.length === 1) {
        return res.json(toMatchRow(matches[0]));
      }
      if (matches.length > 1) {
        return res.status(400).json({
          error: "ambiguous",
          matches: matches.map(toMatchRow),
        });
      }

      // No match — rank suggestions by fuzzy closeness.
      const ranked = trusted
        .map(r => ({ r, d: Math.min(closeness(name, r.name), closeness(name, shortHostname(r.hostname))) }))
        .filter(x => x.d <= 3)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map(x => toMatchRow(x.r));
      return res.status(404).json({ error: "not_found", suggestions: ranked });
    } catch (err) {
      console.warn("[federation-resolve] failed:", err.message);
      return res.status(500).json({ error: "resolve_failed" });
    } finally {
      db.close();
    }
  });

  return router;
}
