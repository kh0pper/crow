/**
 * Nostr Messaging Layer
 *
 * Handles encrypted messaging between Crow users via Nostr protocol:
 * - NIP-44 encryption (via nostr-tools)
 * - NIP-59 gift wraps for sender anonymity
 * - Default relay management
 * - Message send/receive/subscribe
 * - Local caching in messages table
 */

// Polyfill WebSocket for Node < 22 (nostr-tools requires it)
if (typeof globalThis.WebSocket === "undefined") {
  try {
    const ws = await import("ws");
    globalThis.WebSocket = ws.default || ws.WebSocket;
  } catch {
    // ws not available — Nostr messaging will fail gracefully
  }
}

import {
  finalizeEvent,
  getPublicKey,
} from "nostr-tools/pure";
import { createNotification } from "../shared/notifications.js";
import bus from "../shared/event-bus.js";
import * as nip44 from "nostr-tools/nip44";
import * as nip19 from "nostr-tools/nip19";
import { Relay } from "nostr-tools/relay";
import { safeRelayPublish } from "./safe-relay-publish.js";
import { makeResilientSub } from "./resilient-subscribe.js";

// Heavily-operated public relays, each verified (2026-07-02) to accept an
// anonymous kind-4 publish (a throwaway-key connect+publish probe). Dropped
// from the candidate set: wss://relay.nostr.band (connect timeout — did not
// respond over plain WebSocket either) and wss://offchain.pub (connects, but
// rejects anonymous writes: "Policy violated and pubkey is not in our web of
// trust"). These are always a floor for connectRelays()/getConfiguredRelays()
// — see the merge behavior below — so one flaky relay is never a SPOF.
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

export class NostrManager {
  constructor(identity, db) {
    this.identity = identity;
    this.db = db;
    this.relays = new Map(); // url -> Relay
    this.subscriptions = new Map(); // contactCrowId -> sub
    this.onMessage = null; // callback(contactId, message)
    this._healthTimer = null; // single health loop for all resilient subs
  }

  /**
   * Get the Nostr public key (hex) from the identity.
   */
  get pubkey() {
    return this.identity.secp256k1Pubkey;
  }

  /**
   * Connect to configured relays.
   */
  async connectRelays(customRelays) {
    // Prevent concurrent connection attempts
    if (this._connectingPromise) return this._connectingPromise;

    if (this.relays.size > 0) return [...this.relays.keys()];

    this._connectingPromise = this._doConnectRelays(customRelays);
    try {
      return await this._connectingPromise;
    } finally {
      this._connectingPromise = null;
    }
  }

  async _doConnectRelays(customRelays) {
    const relayUrls = customRelays || (await this.getConfiguredRelays());

    // Connect to relays in parallel with a per-relay timeout
    const results = await Promise.allSettled(
      relayUrls.map(async (url) => {
        const relay = await Promise.race([
          // enablePing is load-bearing for the health loop: a ping timeout closes a
          // silently-dead half-open socket (ws.close → relay.connected = false), which
          // is the ONLY signal ensureHealthy() has to trigger a reconnect/resubscribe.
          // Without it, relay.connected stays true forever and the sub never re-establishes.
          Relay.connect(url, { enablePing: true }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("connection timeout")), 10000)
          ),
        ]);
        return { url, relay };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        this.relays.set(result.value.url, result.value.relay);
      } else {
        const url = relayUrls[results.indexOf(result)];
        console.warn(`[nostr] Failed to connect to ${url}:`, result.reason?.message);
      }
    }

    return [...this.relays.keys()];
  }

  /**
   * Send an encrypted self-message via Nostr (for instance-to-instance relay).
   * All instances share the same Nostr identity, so this sends to own pubkey.
   * App-level routing uses target_instance field in the payload.
   */
  async sendSelfMessage(content) {
    const pseudoContact = { secp256k1_pubkey: this.identity.secp256k1Pubkey };
    return this.sendMessage(pseudoContact, content);
  }

  /**
   * Send an encrypted message to a contact via Nostr.
   */
  async sendMessage(contact, content) {
    if (this.relays.size === 0) {
      await this.connectRelays();
    }

    let recipientPubkey = contact.secp256k1_pubkey || contact.secp256k1Pubkey;

    // Nostr uses 32-byte x-only pubkeys (64 hex chars).
    // Stored keys may be 33-byte compressed (66 hex chars with 02/03 prefix) — strip prefix.
    if (recipientPubkey && recipientPubkey.length === 66) {
      recipientPubkey = recipientPubkey.slice(2);
    }

    // NIP-44 encrypt the message
    const conversationKey = nip44.v2.utils.getConversationKey(
      this.identity.secp256k1Priv,
      recipientPubkey
    );
    const encrypted = nip44.v2.encrypt(content, conversationKey);

    // Create NIP-04 style event (kind 4) with NIP-44 encryption
    const event = finalizeEvent({
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", recipientPubkey]],
      content: encrypted,
    }, this.identity.secp256k1Priv);

    // Publish to all connected relays. safeRelayPublish reconnects-or-skips a
    // dropped relay so a closed-connection send() can't leak an unhandled
    // rejection and crash the process (see safe-relay-publish.js).
    const published = [];
    for (const [url, relay] of this.relays) {
      try {
        if (await safeRelayPublish(relay, event)) published.push(url);
      } catch (err) {
        // Publishing failed to this relay
      }
    }

    // Cache locally. delivery_status reflects the honest publish outcome above
    // ('relayed' when >=1 relay accepted, 'failed' when 0). Best-effort: the
    // event was already published (or not) to relays above, so a local-cache
    // write failure must not throw out of sendMessage and lose that outcome
    // for the caller (see Global Constraints in the R2 plan).
    const contactId = contact.id || contact.contact_id;
    const deliveryStatus = published.length > 0 ? "relayed" : "failed";
    if (contactId && this.db) {
      try {
        await this.db.execute({
          sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, delivery_status, created_at)
                VALUES (?, ?, ?, 'sent', 1, ?, datetime('now'))`,
          args: [contactId, event.id, content, deliveryStatus],
        });
      } catch (err) {
        // Local-cache write failed — the message was still (or wasn't)
        // published above; don't let a DB error mask that outcome.
      }
    }

    return {
      eventId: event.id,
      relays: published,
    };
  }

  /**
   * Send an encrypted DM WITHOUT caching it into the 1:1 `messages` table. Used
   * for control/room envelopes (crow_social) that must not appear as 1:1 chat rows.
   */
  async sendControl(contact, content) {
    if (this.relays.size === 0) await this.connectRelays();
    let recipientPubkey = contact.secp256k1_pubkey || contact.secp256k1Pubkey;
    if (recipientPubkey && recipientPubkey.length === 66) recipientPubkey = recipientPubkey.slice(2);
    const conversationKey = nip44.v2.utils.getConversationKey(this.identity.secp256k1Priv, recipientPubkey);
    const encrypted = nip44.v2.encrypt(content, conversationKey);
    const event = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [["p", recipientPubkey]], content: encrypted }, this.identity.secp256k1Priv);
    const published = [];
    for (const [url, relay] of this.relays) {
      try { if (await safeRelayPublish(relay, event)) published.push(url); } catch { /* relay best-effort */ }
    }
    return { eventId: event.id, relays: published };
  }

  /**
   * Start the single periodic health loop that re-establishes any resilient
   * subscription whose relay has dropped. Idempotent (created once). unref'd so
   * it never keeps the process alive on its own.
   */
  _startHealthLoop() {
    if (this._healthTimer) return;
    const ms = Number(process.env.CROW_NOSTR_HEALTH_MS) || 45000;
    this._healthTimer = setInterval(() => {
      for (const h of this.subscriptions.values()) {
        // ensureHealthy is async — a sync try/catch would NOT catch a rejected
        // promise. Wrap so a stray rejection can never become an unhandledRejection
        // (the whole point of this arc is a gateway that never silently dies).
        if (h && typeof h.ensureHealthy === "function") {
          Promise.resolve(h.ensureHealthy()).catch(() => {});
        }
      }
    }, ms);
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  /**
   * Subscribe to messages from a specific contact.
   */
  async subscribeToContact(contact) {
    await this.connectRelays();

    let contactPubkey = contact.secp256k1_pubkey || contact.secp256k1Pubkey;
    // Strip compressed key prefix for Nostr (32-byte x-only)
    if (contactPubkey && contactPubkey.length === 66) {
      contactPubkey = contactPubkey.slice(2);
    }
    const contactId = contact.id || contact.contact_id;
    const crowId = contact.crow_id || contact.crowId;
    // Own pubkey also needs x-only format
    const ownPubkey = this.pubkey?.length === 66 ? this.pubkey.slice(2) : this.pubkey;

    for (const [url, relay] of this.relays) {
      try {
        const onevent = async (event) => {
          try {
            const conversationKey = nip44.v2.utils.getConversationKey(
              this.identity.secp256k1Priv,
              contactPubkey
            );
            const decrypted = nip44.v2.decrypt(event.content, conversationKey);

            if (decrypted.startsWith("{")) {
              try {
                const parsed = JSON.parse(decrypted);
                if (parsed.type === "invite_accepted" || parsed.type === "crow_social") {
                  return;
                }
              } catch {
                // Not valid JSON, treat as regular message
              }
            }

            if (contactId && this.db) {
              try {
                const result = await this.db.execute({
                  sql: `INSERT OR IGNORE INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
                        VALUES (?, ?, ?, 'received', 0, datetime(?, 'unixepoch'))`,
                  args: [contactId, event.id, decrypted, event.created_at],
                });
                if (result.rowsAffected > 0) {
                  try {
                    await createNotification(this.db, {
                      title: `Message from ${contact.display_name || crowId}`,
                      type: "peer",
                      source: "sharing:message",
                      action_url: "/dashboard/messages",
                    });
                  } catch {}
                  try {
                    const { rows } = await this.db.execute({
                      sql: `SELECT COUNT(*) AS unread FROM messages
                            WHERE contact_id = ? AND is_read = 0 AND direction = 'received'`,
                      args: [contactId],
                    });
                    const unread = Number(rows?.[0]?.unread ?? 0);
                    bus.emit("messages:changed", { contactId, unread });
                  } catch {}
                }
              } catch {
                // Duplicate event, ignore
              }
            }

            if (this.onMessage) {
              this.onMessage(crowId, { eventId: event.id, content: decrypted, timestamp: event.created_at });
            }
          } catch (err) {
            // Decryption failed — not for us or corrupted
          }
        };
        const handle = makeResilientSub(
          relay,
          { kinds: [4], authors: [contactPubkey], "#p": [ownPubkey] },
          onevent,
          {} // no initialSince → contact subs keep their full-history-then-rolling behavior
        );
        // Close any prior resilient handle for this key before replacing it, so a
        // re-subscribe can't orphan a live sub (no longer health-driven, leaked by destroy()).
        const prev = this.subscriptions.get(`${crowId}:${url}`);
        if (prev && typeof prev.close === "function") { try { prev.close(); } catch {} }
        this.subscriptions.set(`${crowId}:${url}`, handle);
      } catch (err) {
        // Subscription failed for this relay
      }
    }
    this._startHealthLoop();
  }

  /**
   * Fetch recent messages from a contact.
   */
  async fetchMessages(contactId, limit = 50) {
    if (!this.db) return [];

    const result = await this.db.execute({
      sql: `SELECT * FROM messages
            WHERE contact_id = ?
            ORDER BY created_at DESC
            LIMIT ?`,
      args: [contactId, limit],
    });

    return result.rows;
  }

  /**
   * Mark messages as read.
   */
  async markRead(contactId) {
    if (!this.db) return;

    await this.db.execute({
      sql: `UPDATE messages SET is_read = 1
            WHERE contact_id = ? AND is_read = 0`,
      args: [contactId],
    });
  }

  /**
   * Get unread message count.
   */
  async getUnreadCount(contactId) {
    if (!this.db) return 0;

    const result = await this.db.execute({
      sql: `SELECT COUNT(*) as count FROM messages
            WHERE contact_id = ? AND is_read = 0 AND direction = 'received'`,
      args: [contactId],
    });

    return Number(result.rows[0]?.count || 0);
  }

  /**
   * Subscribe to all incoming DMs directed at us.
   * Routes message types:
   *   - invite_accepted → onInviteAccepted(payload)
   *   - crow_social (with subtype) → onSocialMessage(subtype, payload, senderPubkey)
   *   - ANYTHING ELSE (plaintext, malformed JSON, subtype-less crow_social,
   *     unknown type) → onMessageRequest(senderPubkey, decrypted, event)
   *
   * L6 fix: previously a decrypted DM that was not a recognized JSON envelope
   * fell through and was silently dropped. Now `handled` tracks whether a real
   * handler was ACTUALLY INVOKED; if not, the DM routes to onMessageRequest so
   * nothing vanishes. Every branch is guarded — onevent must NEVER throw (a
   * throw kills the subscription and breaks all delivery).
   */
  async subscribeToIncoming(onInviteAccepted, onSocialMessage, onMessageRequest) {
    await this.connectRelays();

    if (this.relays.size > 0) {
      console.log(`[nostr] Subscribed to incoming on ${this.relays.size} relay(s)`);
    }
    const ownPubkey = this.pubkey?.length === 66 ? this.pubkey.slice(2) : this.pubkey;
    const seenEventIds = new Set();

    const incomingSince = Math.floor(Date.now() / 1000) - 86400; // Last 24h only
    for (const [url, relay] of this.relays) {
      try {
        const onevent = async (event) => {
          if (seenEventIds.has(event.id)) return;
          seenEventIds.add(event.id);
          try {
            let senderPubkey = event.pubkey;
            const conversationKey = nip44.v2.utils.getConversationKey(
              this.identity.secp256k1Priv,
              senderPubkey
            );
            const decrypted = nip44.v2.decrypt(event.content, conversationKey);

            // `handled` = a real handler was ACTUALLY INVOKED (not merely
            // "the type string matched"). We set it true at the point we
            // decide to invoke — BEFORE the await — so that a handler which
            // itself throws does NOT fall through and get double-processed as
            // a message request. It stays false for genuine JSON.parse
            // failures and unrecognized/subtype-less payloads, which then
            // correctly route to the request path below.
            let handled = false;
            if (decrypted.startsWith("{")) {
              try {
                const payload = JSON.parse(decrypted);
                if (payload.type === "invite_accepted" && onInviteAccepted) {
                  handled = true;
                  await onInviteAccepted(payload);
                } else if (payload.type === "crow_social" && payload.subtype && onSocialMessage) {
                  handled = true;
                  await onSocialMessage(payload.subtype, payload.payload || {}, senderPubkey);
                }
              } catch {
                // Malformed JSON (starts with "{" but JSON.parse threw) OR a
                // handler threw. If a handler was invoked, `handled` is
                // already true → we won't double-fire below.
              }
            }

            // L6: route everything a real handler did NOT consume —
            // plaintext, malformed JSON, a subtype-less crow_social — to the
            // message-request path so no DM is silently dropped. Wrapped in
            // its own try/catch: onevent must NEVER throw.
            if (!handled && onMessageRequest) {
              try {
                await onMessageRequest(senderPubkey, decrypted, event);
              } catch {
                // Request path must never break the subscription.
              }
            }
          } catch (decryptErr) {
            // Decryption failed — event not for us or from unknown sender
          }
        };
        const handle = makeResilientSub(
          relay,
          { kinds: [4], "#p": [ownPubkey] },
          onevent,
          { initialSince: incomingSince }
        );
        // Close any prior resilient handle for this key before replacing it (see subscribeToContact).
        const prevIncoming = this.subscriptions.get(`incoming:${url}`);
        if (prevIncoming && typeof prevIncoming.close === "function") { try { prevIncoming.close(); } catch {} }
        this.subscriptions.set(`incoming:${url}`, handle);
      } catch {
        // Subscription failed for this relay
      }
    }
    this._startHealthLoop();
  }

  /**
   * Get configured relays: DEFAULT_RELAYS merged with any enabled user-added
   * relay_config rows (deduped, case-insensitively, by exact URL). Defaults
   * are ALWAYS a floor — this must never shrink to just the config rows,
   * or an install that ran crow_add_relay once would drop to a single relay
   * (the SPOF this fixes). Never throws: any DB error falls back to
   * DEFAULT_RELAYS so a broken relay_config read can't break connectRelays().
   */
  async getConfiguredRelays() {
    if (!this.db) return DEFAULT_RELAYS;

    let configured = [];
    try {
      const result = await this.db.execute({
        sql: `SELECT relay_url FROM relay_config
              WHERE relay_type = 'nostr' AND enabled = 1`,
        args: [],
      });
      configured = result.rows.map((r) => r.relay_url);
    } catch (err) {
      console.warn("[nostr] getConfiguredRelays: DB read failed, falling back to DEFAULT_RELAYS:", err?.message);
      return DEFAULT_RELAYS;
    }

    const seen = new Set();
    const merged = [];
    for (const url of [...DEFAULT_RELAYS, ...configured]) {
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(url);
    }
    return merged;
  }

  /**
   * URLs of currently-connected relays.
   */
  connectedRelayUrls() {
    return [...this.relays.keys()];
  }

  /**
   * Disconnect from all relays.
   */
  async destroy() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    for (const sub of this.subscriptions.values()) {
      try {
        sub.close();
      } catch {}
    }
    this.subscriptions.clear();

    for (const relay of this.relays.values()) {
      try {
        relay.close();
      } catch {}
    }
    this.relays.clear();
  }
}
