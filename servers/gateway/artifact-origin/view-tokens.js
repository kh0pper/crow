/**
 * View tokens (spec §5.1): one artifact version, read-only, valid for one
 * frame load with a hard cap (default 30 min, D17). The viewer mints a fresh
 * token for every frame load; a refresh is a frame reload, never a message
 * posted into the frame.
 *
 * In-memory, in the gateway process that also serves the artifact origin. A
 * gateway restart drops every token: open frames keep their loaded document
 * and simply fail lazy subresource loads until reloaded. Only a SHA-256 of the
 * token is held, so a heap dump does not yield live tokens.
 *
 * Each token also carries a per-load nonce (the navigation-tripwire handshake,
 * §5.1) and the dashboard origin that minted it, which becomes the response's
 * `frame-ancestors` (per instance, without configuration — M5).
 */
import { randomBytes, createHash } from "node:crypto";

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const DEFAULT_VIEW_TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_LIVE_TOKENS = 5000;

const h = (t) => createHash("sha256").update(t).digest("hex");

/** dashboardOrigin is interpolated into `frame-ancestors` (and CSP keeps the
 *  FIRST of duplicate directives, before `sandbox`), so only a bare
 *  scheme://host[:port] origin may ever be stored (review R4). */
const DASHBOARD_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

export function createViewTokenStore({ now = () => Date.now(), ttlMs = DEFAULT_VIEW_TOKEN_TTL_MS } = {}) {
  const byHash = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of byHash) if (v.expiresAt <= t) byHash.delete(k);
  }

  return {
    /**
     * @param {{ artifactId: string, versionN: number, type: string, dashboardOrigin: string|null }} g
     * @returns {{ token: string, nonce: string, expiresAt: number }}
     */
    mint({ artifactId, versionN, type, dashboardOrigin = null, scriptsOff = false }) {
      if (!artifactId || !Number.isInteger(versionN) || !type) throw new Error("bad_grant");
      if (dashboardOrigin != null && !(typeof dashboardOrigin === "string" && DASHBOARD_ORIGIN_RE.test(dashboardOrigin))) throw new Error("bad_grant");
      sweep();
      if (byHash.size >= MAX_LIVE_TOKENS) {
        // Oldest first: Map iteration order is insertion order.
        const first = byHash.keys().next().value;
        byHash.delete(first);
      }
      const token = randomBytes(32).toString("base64url");
      const nonce = randomBytes(16).toString("base64url");
      const expiresAt = now() + ttlMs;
      byHash.set(h(token), { artifactId, versionN, type, dashboardOrigin: dashboardOrigin ?? null, nonce, expiresAt, scriptsOff: !!scriptsOff });
      return { token, nonce, expiresAt };
    },
    /** The grant, or null when malformed, unknown, expired or revoked. */
    check(token) {
      if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
      const g = byHash.get(h(token));
      if (!g) return null;
      if (g.expiresAt <= now()) { byHash.delete(h(token)); return null; }
      return { ...g };
    },
    /** Drop every token for an artifact (deleted, unshared, flagged by the tripwire). */
    revokeArtifact(artifactId) {
      for (const [k, v] of byHash) if (v.artifactId === artifactId) byHash.delete(k);
    },
    size() { sweep(); return byHash.size; },
  };
}
