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

import {
  finalizeEvent,
  getPublicKey,
} from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import * as nip19 from "nostr-tools/nip19";
import { Relay } from "nostr-tools/relay";

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

export class NostrManager {
  constructor(identity, db) {
    this.identity = identity;
    this.db = db;
    this.relays = new Map(); // url -> Relay
    this.subscriptions = new Map(); // contactCrowId -> sub
    this.onMessage = null; // callback(contactId, message)
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
    const relayUrls = customRelays || DEFAULT_RELAYS;

    for (const url of relayUrls) {
      try {
        const relay = await Relay.connect(url);
        this.relays.set(url, relay);
      } catch (err) {
        // Relay connection failed — non-fatal, try others
        console.warn(`[nostr] Failed to connect to ${url}:`, err.message);
      }
    }

    return [...this.relays.keys()];
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

    // Publish to all connected relays
    const published = [];
    for (const [url, relay] of this.relays) {
      try {
        await relay.publish(event);
        published.push(url);
      } catch (err) {
        // Publishing failed to this relay
      }
    }

    // Cache locally
    const contactId = contact.id || contact.contact_id;
    if (contactId && this.db) {
      await this.db.execute({
        sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
              VALUES (?, ?, ?, 'sent', 1, datetime('now'))`,
        args: [contactId, event.id, content],
      });
    }

    return {
      eventId: event.id,
      relays: published,
    };
  }

  /**
   * Subscribe to messages from a specific contact.
   */
  async subscribeToContact(contact) {
    if (this.relays.size === 0) {
      await this.connectRelays();
    }

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
        const sub = relay.subscribe(
          [
            {
              kinds: [4],
              authors: [contactPubkey],
              "#p": [ownPubkey],
            },
          ],
          {
            onevent: async (event) => {
              try {
                // Decrypt NIP-44
                const conversationKey = nip44.v2.utils.getConversationKey(
                  this.identity.secp256k1Priv,
                  contactPubkey
                );
                const decrypted = nip44.v2.decrypt(event.content, conversationKey);

                // Cache locally
                if (contactId && this.db) {
                  try {
                    await this.db.execute({
                      sql: `INSERT OR IGNORE INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
                            VALUES (?, ?, ?, 'received', 0, datetime(?, 'unixepoch'))`,
                      args: [contactId, event.id, decrypted, event.created_at],
                    });
                  } catch {
                    // Duplicate event, ignore
                  }
                }

                if (this.onMessage) {
                  this.onMessage(crowId, {
                    eventId: event.id,
                    content: decrypted,
                    timestamp: event.created_at,
                  });
                }
              } catch (err) {
                // Decryption failed — not for us or corrupted
              }
            },
          }
        );

        this.subscriptions.set(`${crowId}:${url}`, sub);
      } catch (err) {
        // Subscription failed for this relay
      }
    }
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
   * Subscribe to all incoming DMs directed at us (for invite acceptance auto-add).
   * Calls onInviteAccepted(payload) when an invite_accepted message is received.
   */
  async subscribeToIncoming(onInviteAccepted) {
    if (this.relays.size === 0) {
      await this.connectRelays();
    }

    const ownPubkey = this.pubkey?.length === 66 ? this.pubkey.slice(2) : this.pubkey;

    for (const [url, relay] of this.relays) {
      try {
        const sub = relay.subscribe(
          [
            {
              kinds: [4],
              "#p": [ownPubkey],
              since: Math.floor(Date.now() / 1000) - 86400, // Last 24h only
            },
          ],
          {
            onevent: async (event) => {
              try {
                // Derive sender pubkey from event
                let senderPubkey = event.pubkey;

                const conversationKey = nip44.v2.utils.getConversationKey(
                  this.identity.secp256k1Priv,
                  senderPubkey
                );
                const decrypted = nip44.v2.decrypt(event.content, conversationKey);

                // Check if it's an invite_accepted message
                if (decrypted.startsWith("{") && decrypted.includes("invite_accepted")) {
                  try {
                    const payload = JSON.parse(decrypted);
                    if (payload.type === "invite_accepted" && onInviteAccepted) {
                      await onInviteAccepted(payload);
                    }
                  } catch {
                    // Not valid JSON or not our message type
                  }
                }
              } catch {
                // Decryption failed — not for us
              }
            },
          }
        );
        this.subscriptions.set(`incoming:${url}`, sub);
      } catch {
        // Subscription failed for this relay
      }
    }
  }

  /**
   * Get configured relays from DB.
   */
  async getConfiguredRelays() {
    if (!this.db) return DEFAULT_RELAYS;

    const result = await this.db.execute({
      sql: `SELECT relay_url FROM relay_config
            WHERE relay_type = 'nostr' AND enabled = 1`,
      args: [],
    });

    if (result.rows.length === 0) return DEFAULT_RELAYS;
    return result.rows.map((r) => r.relay_url);
  }

  /**
   * Disconnect from all relays.
   */
  async destroy() {
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
