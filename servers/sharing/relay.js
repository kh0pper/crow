/**
 * Peer Relay — Store-and-Forward (DB-backed)
 *
 * Opt-in relay for cloud-deployed Crow gateways:
 * - Stores encrypted blobs for contacts who are offline
 * - Blobs are E2E encrypted — the relay cannot read them
 * - Ed25519-signed requests for authentication
 * - Storage quotas and TTL (30-day default) prevent abuse
 * - Persistent SQLite storage (survives gateway restarts)
 *
 * Endpoints (mounted by gateway):
 *   POST /relay/store  — Store an encrypted blob for a contact
 *   GET  /relay/fetch  — Retrieve pending blobs
 */

import { verify } from "./identity.js";

const MAX_BLOB_SIZE = 1024 * 1024; // 1MB per blob
const MAX_BLOBS_PER_CONTACT = 100;
const TTL_DAYS = 30;

/**
 * Create Express router handlers for relay endpoints.
 * @param {object} db - libsql database client
 */
export function createRelayHandlers(db) {
  // Schedule periodic cleanup every hour
  if (db) {
    setInterval(() => cleanupExpiredBlobs(db), 60 * 60 * 1000);
  }

  return {
    /**
     * POST /relay/store
     * Body: { recipient, blob, signature, senderPubkey }
     */
    store: async (req, res) => {
      try {
        const { recipient, blob, signature, senderPubkey } = req.body;

        if (!recipient || !blob || !signature || !senderPubkey) {
          return res.status(400).json({ error: "Missing required fields: recipient, blob, signature, senderPubkey" });
        }

        // Validate blob size
        const blobStr = typeof blob === "string" ? blob : JSON.stringify(blob);
        const blobSize = Buffer.byteLength(blobStr);
        if (blobSize > MAX_BLOB_SIZE) {
          return res.status(413).json({ error: `Blob too large (max ${MAX_BLOB_SIZE} bytes)` });
        }

        // Verify signature
        const message = JSON.stringify({ recipient, blob });
        const valid = verify(message, signature, senderPubkey);
        if (!valid) {
          return res.status(401).json({ error: "Invalid signature" });
        }

        // Check quota
        const countResult = await db.execute({
          sql: "SELECT COUNT(*) as cnt FROM relay_blobs WHERE recipient_pubkey = ?",
          args: [recipient],
        });
        const count = countResult.rows[0]?.cnt || 0;
        if (count >= MAX_BLOBS_PER_CONTACT) {
          return res.status(429).json({ error: `Quota exceeded (max ${MAX_BLOBS_PER_CONTACT} pending blobs)` });
        }

        // Store
        const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
        await db.execute({
          sql: `INSERT INTO relay_blobs (recipient_pubkey, blob, sender_pubkey, expires_at)
                VALUES (?, ?, ?, ?)`,
          args: [recipient, blobStr, senderPubkey, expiresAt],
        });

        res.json({ status: "stored", expires: expiresAt });
      } catch (err) {
        console.error("[relay] Store error:", err.message);
        res.status(500).json({ error: "Internal relay error" });
      }
    },

    /**
     * GET /relay/fetch?pubkey=<hex>&signature=<hex>&timestamp=<ms>
     * Signature covers: pubkey + timestamp (prevents replay)
     */
    fetch: async (req, res) => {
      try {
        const { pubkey, signature, timestamp } = req.query;

        if (!pubkey || !signature || !timestamp) {
          return res.status(400).json({ error: "Missing required params: pubkey, signature, timestamp" });
        }

        // Prevent replay attacks (timestamp must be within 5 minutes)
        const ts = parseInt(timestamp, 10);
        if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
          return res.status(401).json({ error: "Timestamp too old" });
        }

        // Verify signature
        const message = `${pubkey}:${timestamp}`;
        const valid = verify(message, signature, pubkey);
        if (!valid) {
          return res.status(401).json({ error: "Invalid signature" });
        }

        // Get pending blobs (not expired)
        const result = await db.execute({
          sql: `SELECT blob, sender_pubkey, created_at FROM relay_blobs
                WHERE recipient_pubkey = ? AND expires_at > datetime('now')
                ORDER BY created_at ASC`,
          args: [pubkey],
        });

        // Delete fetched blobs
        await db.execute({
          sql: "DELETE FROM relay_blobs WHERE recipient_pubkey = ?",
          args: [pubkey],
        });

        const blobs = result.rows.map((b) => ({
          blob: b.blob,
          sender: b.sender_pubkey,
          timestamp: new Date(b.created_at).getTime(),
        }));

        res.json({
          blobs,
          count: blobs.length,
        });
      } catch (err) {
        console.error("[relay] Fetch error:", err.message);
        res.status(500).json({ error: "Internal relay error" });
      }
    },
  };
}

/**
 * Clean up expired blobs from the database.
 */
export async function cleanupExpiredBlobs(db) {
  try {
    const result = await db.execute({
      sql: "DELETE FROM relay_blobs WHERE expires_at <= datetime('now')",
      args: [],
    });
    if (result.rowsAffected > 0) {
      console.log(`[relay] Cleaned up ${result.rowsAffected} expired blob(s)`);
    }
  } catch (err) {
    console.error("[relay] Cleanup error:", err.message);
  }
}
