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
 *
 * D24 load evidence (spec v1.6): for each token the origin records whether it
 * served the token's document, injected the anchor helper into it, and served
 * the helper. The record lives on the grant, in this map, and only the origin
 * listener writes it (markServed). The viewer asks for it by `tokenId` — the
 * SHA-256 this map is keyed on, which is not a credential: it cannot be turned
 * back into the token and the origin never accepts it.
 */
import { randomBytes, createHash } from "node:crypto";
import { isScriptedType, effectiveType } from "./policy.js";

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const TOKEN_ID_RE = /^[0-9a-f]{64}$/;
export const DEFAULT_VIEW_TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_LIVE_TOKENS = 5000;

const isScriptedGrant = (g) => isScriptedType(effectiveType(g.type, g.scriptsOff));
const h = (t) => createHash("sha256").update(t).digest("hex");

/** dashboardOrigin is interpolated into `frame-ancestors` (and CSP keeps the
 *  FIRST of duplicate directives, before `sandbox`), so only a bare
 *  scheme://host[:port] origin may ever be stored (review R4). */
const DASHBOARD_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const EVIDENCE = ["docServed", "helperInjected", "helperServed"];

/**
 * D24: what a scripted frame that never said hello means, from the origin's
 * own record. Content can only ADD evidence (request the helper again), never
 * remove it, so every arm content can reach leads to a flag:
 *  - helperServed: the document's first bytes were parsed (the helper is a
 *    parser-blocking script before any bot byte) and it stayed silent → flag;
 *  - document served without the helper (not HTML) → flag, as before D24;
 *  - document served, helper never requested → its bytes never parsed (the
 *    connection died mid-response) → retry;
 *  - document never served, or no record (restart, expiry, revoke) → retry.
 */
export function loadDecision(ev) {
  if (!ev) return { decision: "retry", reason: "unknown" };
  if (ev.helperServed) return { decision: "flag", reason: "parsed-no-hello" };
  if (!ev.scripted) return { decision: "retry", reason: "not-scripted" };
  if (ev.docServed && !ev.helperInjected) return { decision: "flag", reason: "no-helper" };
  if (ev.docServed) return { decision: "retry", reason: "not-parsed" };
  return { decision: "retry", reason: "not-served" };
}

export function createViewTokenStore({ now = () => Date.now(), ttlMs = DEFAULT_VIEW_TOKEN_TTL_MS } = {}) {
  const byHash = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of byHash) if (v.expiresAt <= t) byHash.delete(k);
  }

  return {
    /**
     * @param {{ artifactId: string, versionN: number, type: string, dashboardOrigin: string|null }} g
     * @returns {{ token: string, tokenId: string, nonce: string, expiresAt: number }}
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
      const tokenId = h(token);
      const ev = { docServed: false, helperInjected: false, helperServed: false };
      byHash.set(tokenId, { artifactId, versionN, type, dashboardOrigin: dashboardOrigin ?? null, nonce, expiresAt, scriptsOff: !!scriptsOff, ev });
      return { token, tokenId, nonce, expiresAt };
    },
    /** The grant, or null when malformed, unknown, expired or revoked. */
    check(token) {
      if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
      const g = byHash.get(h(token));
      if (!g) return null;
      if (g.expiresAt <= now()) { byHash.delete(h(token)); return null; }
      const { ev, ...grant } = g;
      return grant;
    },
    /** The origin listener's D24 record: mark one evidence field on a live token. */
    markServed(token, field) {
      if (!EVIDENCE.includes(field) || typeof token !== "string" || !TOKEN_RE.test(token)) return;
      const g = byHash.get(h(token));
      if (g && g.expiresAt > now()) g.ev[field] = true;
    },
    /** D24 evidence for a tokenId (a copy), or null when unknown, expired or revoked. */
    evidence(tokenId) {
      if (typeof tokenId !== "string" || !TOKEN_ID_RE.test(tokenId)) return null;
      const g = byHash.get(tokenId);
      if (!g || g.expiresAt <= now()) return null;
      return { artifactId: g.artifactId, versionN: g.versionN, scripted: isScriptedGrant(g), ...g.ev };
    },
    /** Drop ONE token (a D24 retry replaces its frame's token). */
    revokeToken(tokenId) {
      if (typeof tokenId !== "string" || !TOKEN_ID_RE.test(tokenId)) return false;
      return byHash.delete(tokenId);
    },
    /** Drop every token for an artifact (deleted, unshared, flagged by the tripwire). */
    revokeArtifact(artifactId) {
      for (const [k, v] of byHash) if (v.artifactId === artifactId) byHash.delete(k);
    },
    size() { sweep(); return byHash.size; },
  };
}
