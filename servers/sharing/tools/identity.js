/**
 * Crow Sharing — Identity Attestation Tools
 *
 * Registers: crow_identity_attest, crow_identity_verify,
 *            crow_identity_revoke, crow_identity_list
 * (tool registration order #25-28)
 *
 * These tools open/close their own no-arg createDbClient() connections —
 * env-based resolution, location-independent — kept verbatim per spec rule 4.
 */

import { z } from "zod";
import { loadOrCreateIdentity } from "../identity.js";
import {
  signAttestation,
  verifyAttestation,
  verifyCrowIdBinding,
  signRevocation,
  SUPPORTED_APPS as ATTESTATION_APPS,
} from "../../shared/identity-attestation.js";
import { createDbClient } from "../../db.js";

export function registerIdentityTools(server, ctx) {
  // Note: ctx is not used — these tools manage their own DB connections.

  // --- F.11: Identity attestation tools ---

  server.tool(
    "crow_identity_attest",
    "Create a signed attestation linking a per-app handle (e.g., @alice@m.example on Mastodon) to this Crow root identity. The signature can be verified by remote parties via /.well-known/crow-identity.json. OFF BY DEFAULT — opt-in per-handle; publication is permanent and can only be retracted via signed revocation (which itself is public).",
    {
      app: z.enum(ATTESTATION_APPS).describe("Federated app the handle belongs to."),
      external_handle: z.string().min(3).max(320).describe("Full handle, e.g. @alice@m.example or !community@lemmy.example or @user:server.org (Matrix)."),
      app_pubkey: z.string().max(1024).optional().describe("Optional: app-side public key (Matrix MXID signing key, Funkwhale actor key, etc.). Omit if the app doesn't expose a stable signing key."),
      confirm: z.literal("yes").describe("Public linkage is effectively permanent; confirm intent."),
    },
    async ({ app, external_handle, app_pubkey }) => {
      try {
        const identity = loadOrCreateIdentity();
        const db = createDbClient();
        try {
          // Check for an existing active attestation; bump version if present
          const existing = await db.execute({
            sql: `SELECT MAX(version) AS v FROM identity_attestations WHERE crow_id = ? AND app = ? AND external_handle = ?`,
            args: [identity.crowId, app, external_handle],
          });
          const prevVersion = existing.rows[0]?.v ? Number(existing.rows[0].v) : 0;
          const version = prevVersion + 1;
          const created_at = Math.floor(Date.now() / 1000);
          const payload = { crow_id: identity.crowId, app, external_handle, app_pubkey, version, created_at };
          const sig = signAttestation(identity, payload);

          const result = await db.execute({
            sql: `INSERT INTO identity_attestations
                    (crow_id, app, external_handle, app_pubkey, sig, version, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            args: [identity.crowId, app, external_handle, app_pubkey || null, sig, version, created_at],
          });
          const id = Number(result.rows[0].id);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                attestation_id: id,
                crow_id: identity.crowId,
                app,
                external_handle,
                version,
                sig,
                publish_url: "/.well-known/crow-identity.json",
                note: "Attestation is now public via the .well-known endpoint. Use crow_identity_revoke to invalidate it (publication of the revocation itself is also public).",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_identity_verify",
    "Verify an attestation for a given (crow_id, app, handle) triple. Fetches the latest non-revoked attestation from the local database and cryptographically verifies the signature. For cross-instance verification, the caller's gateway is expected to fetch /.well-known/crow-identity.json on the target host instead (rate-limited to 60 req/min/IP at that endpoint).",
    {
      crow_id: z.string().min(6).max(64),
      app: z.enum(ATTESTATION_APPS),
      external_handle: z.string().min(3).max(320),
      max_age_seconds: z.number().int().min(0).max(86400 * 30).optional().describe("If set, accept cached records up to this age; otherwise always fetch fresh (local DB read is already fresh — this is semantic only for HTTP callers)."),
    },
    async ({ crow_id, app, external_handle }) => {
      try {
        const db = createDbClient();
        try {
          const row = await db.execute({
            sql: `SELECT id, app_pubkey, sig, version, created_at, revoked_at
                  FROM identity_attestations
                  WHERE crow_id = ? AND app = ? AND external_handle = ? AND revoked_at IS NULL
                  ORDER BY version DESC LIMIT 1`,
            args: [crow_id, app, external_handle],
          });
          if (row.rows.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ valid: false, reason: "no_active_attestation", crow_id, app, external_handle }, null, 2) }] };
          }
          const r = row.rows[0];
          // Re-derive pubkey from local identity iff crow_id matches local
          const localIdentity = loadOrCreateIdentity();
          let rootPubkey = null;
          if (localIdentity.crowId === crow_id) rootPubkey = localIdentity.ed25519Pubkey;
          if (!rootPubkey) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  valid: null,
                  reason: "remote_crow_id_pubkey_unavailable",
                  note: "This tool only verifies attestations that belong to THIS Crow instance. For cross-instance verification, fetch /.well-known/crow-identity.json on the remote host.",
                  crow_id, app, external_handle,
                }, null, 2),
              }],
            };
          }
          const payload = { crow_id, app, external_handle, app_pubkey: r.app_pubkey || undefined, version: Number(r.version), created_at: Number(r.created_at) };
          const ok = verifyAttestation(payload, r.sig, rootPubkey) && verifyCrowIdBinding(crow_id, rootPubkey);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                valid: ok,
                version: Number(r.version),
                created_at: Number(r.created_at),
                fetched_at: Math.floor(Date.now() / 1000),
                attestation_id: Number(r.id),
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_identity_revoke",
    "Sign a revocation for a previously-published attestation. The revocation is added to /.well-known/crow-identity-revocations.json and the original attestation is marked revoked (but retained in the DB for audit). Rotating an app key should automatically chain revoke → attest; expose that via the bundle's own key-rotation flow.",
    {
      attestation_id: z.number().int(),
      reason: z.string().max(500).optional(),
      confirm: z.literal("yes").describe("Revocations themselves are public; confirm intent."),
    },
    async ({ attestation_id, reason }) => {
      try {
        const identity = loadOrCreateIdentity();
        const db = createDbClient();
        try {
          const row = await db.execute({
            sql: "SELECT crow_id, revoked_at FROM identity_attestations WHERE id = ?",
            args: [attestation_id],
          });
          if (row.rows.length === 0) {
            return { content: [{ type: "text", text: "Error: attestation not found." }] };
          }
          if (row.rows[0].crow_id !== identity.crowId) {
            return { content: [{ type: "text", text: "Error: this attestation belongs to a different crow_id — only the owner can revoke." }] };
          }
          if (row.rows[0].revoked_at) {
            return { content: [{ type: "text", text: JSON.stringify({ already_revoked: true, revoked_at: Number(row.rows[0].revoked_at) }, null, 2) }] };
          }

          const revoked_at = Math.floor(Date.now() / 1000);
          const payload = { attestation_id, revoked_at, reason };
          const sig = signRevocation(identity, payload);

          await db.execute({
            sql: "UPDATE identity_attestations SET revoked_at = ? WHERE id = ?",
            args: [revoked_at, attestation_id],
          });
          await db.execute({
            sql: `INSERT INTO identity_attestation_revocations (attestation_id, revoked_at, reason, sig) VALUES (?, ?, ?, ?)`,
            args: [attestation_id, revoked_at, reason || null, sig],
          });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                attestation_id,
                revoked_at,
                sig,
                publish_url: "/.well-known/crow-identity-revocations.json",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_identity_list",
    "List attestations for this Crow instance. Includes both active and revoked entries; filter with include_revoked=false to see only active ones.",
    {
      include_revoked: z.boolean().optional(),
      app: z.enum(ATTESTATION_APPS).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ include_revoked, app, limit }) => {
      try {
        const identity = loadOrCreateIdentity();
        const db = createDbClient();
        try {
          const clauses = ["crow_id = ?"];
          const args = [identity.crowId];
          if (app) { clauses.push("app = ?"); args.push(app); }
          if (include_revoked === false) clauses.push("revoked_at IS NULL");
          args.push(limit ?? 100);
          const rows = await db.execute({
            sql: `SELECT id, app, external_handle, version, created_at, revoked_at
                  FROM identity_attestations
                  WHERE ${clauses.join(" AND ")}
                  ORDER BY created_at DESC
                  LIMIT ?`,
            args,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                crow_id: identity.crowId,
                count: rows.rows.length,
                attestations: rows.rows.map(r => ({
                  id: Number(r.id),
                  app: r.app,
                  external_handle: r.external_handle,
                  version: Number(r.version),
                  created_at: Number(r.created_at),
                  revoked_at: r.revoked_at ? Number(r.revoked_at) : null,
                })),
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );
}
