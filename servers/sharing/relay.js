/**
 * Peer Relay — Store-and-Forward
 *
 * Opt-in relay for cloud-deployed Crow gateways:
 * - Stores encrypted blobs for contacts who are offline
 * - Blobs are E2E encrypted — the relay cannot read them
 * - Ed25519-signed requests for authentication
 * - Storage quotas and TTL (30-day default) prevent abuse
 *
 * Endpoints (mounted by gateway):
 *   POST /relay/store  — Store an encrypted blob for a contact
 *   GET  /relay/fetch  — Retrieve pending blobs
 */

import { verify } from "./identity.js";

const MAX_BLOB_SIZE = 1024 * 1024; // 1MB per blob
const MAX_BLOBS_PER_CONTACT = 100;
const TTL_DAYS = 30;

// In-memory relay store (production would use DB)
const relayStore = new Map(); // recipientPubkey -> [{ blob, sender, timestamp, expires }]

/**
 * Create Express router handlers for relay endpoints.
 */
export function createRelayHandlers() {
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
        const blobSize = Buffer.byteLength(JSON.stringify(blob));
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
        const existing = relayStore.get(recipient) || [];
        if (existing.length >= MAX_BLOBS_PER_CONTACT) {
          return res.status(429).json({ error: `Quota exceeded (max ${MAX_BLOBS_PER_CONTACT} pending blobs)` });
        }

        // Store
        const entry = {
          blob,
          sender: senderPubkey,
          timestamp: Date.now(),
          expires: Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000,
        };

        if (!relayStore.has(recipient)) {
          relayStore.set(recipient, []);
        }
        relayStore.get(recipient).push(entry);

        res.json({ status: "stored", expires: new Date(entry.expires).toISOString() });
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

        // Get and clear pending blobs
        const blobs = relayStore.get(pubkey) || [];

        // Filter expired
        const now = Date.now();
        const valid_blobs = blobs.filter((b) => b.expires > now);

        // Clear fetched blobs
        relayStore.delete(pubkey);

        res.json({
          blobs: valid_blobs.map((b) => ({
            blob: b.blob,
            sender: b.sender,
            timestamp: b.timestamp,
          })),
          count: valid_blobs.length,
        });
      } catch (err) {
        console.error("[relay] Fetch error:", err.message);
        res.status(500).json({ error: "Internal relay error" });
      }
    },
  };
}

/**
 * Periodic cleanup of expired blobs.
 */
export function cleanupExpiredBlobs() {
  const now = Date.now();
  for (const [key, blobs] of relayStore) {
    const valid = blobs.filter((b) => b.expires > now);
    if (valid.length === 0) {
      relayStore.delete(key);
    } else {
      relayStore.set(key, valid);
    }
  }
}
