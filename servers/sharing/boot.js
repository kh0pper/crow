/**
 * Crow Sharing — One-Time Runtime Wiring
 *
 * initSharingRuntime(managers, helpers) runs once per process at the first
 * createSharingServer call.  It starts Hyperswarm, joins DHT topics, wires
 * the Nostr subscriptions, and sets up all peer callbacks.
 *
 * The initialized-guard (managers.initialized = true) is set SYNCHRONOUSLY
 * at entry — before the async peerManager.start() chain — matching the
 * original server.js behaviour at :439.  The guard is checked and flipped
 * at the call site in createSharingServer (not inside this function) so that
 * the module boundary is clean and the guard stays in the orchestrator.
 */

import { createNotification } from "../shared/notifications.js";
import { ensureColumn } from "../db.js";
import {
  resolveLocalInstanceName,
  resolvePendingRelay,
  handleIncomingBotRelay,
} from "./bot-relay.js";

export async function initSharingRuntime(managers, helpers) {
  const { db, identity, peerManager, syncManager, instanceSyncManager, nostrManager } = managers;
  const { applyProjectCloneBundle } = helpers;

  // W4-2 B: runtime guard — a host that pulls code before running init-db will
  // have shared_items without the mode column; ensureColumn is idempotent and
  // safe to run every startup (mirrors migrations.js:152 precedent for op column).
  try {
    await ensureColumn(db, "shared_items", "mode", "TEXT");
  } catch (err) {
    console.warn("[sharing] ensureColumn shared_items.mode:", err.message);
  }

  // Start peer manager and join DHT topics for existing contacts
  peerManager.start().then(async () => {
    try {
      const contacts = await db.execute({
        sql: "SELECT id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey FROM contacts WHERE is_blocked = 0",
        args: [],
      });
      for (const c of contacts.rows) {
        try {
          await syncManager.initContact(c.id, null);
          await peerManager.joinContact({
            crowId: c.crow_id,
            ed25519Pubkey: c.ed25519_pubkey,
          });
          // Subscribe to Nostr messages from this contact
          await nostrManager.subscribeToContact({
            id: c.id,
            crow_id: c.crow_id,
            secp256k1_pubkey: c.secp256k1_pubkey,
            display_name: c.display_name,
          });
        } catch (err) {
          console.warn(`[sharing] Failed to join topic for ${c.crow_id}:`, err.message);
        }
      }
      if (contacts.rows.length > 0) {
        console.log(`[sharing] Joined DHT topics for ${contacts.rows.length} contact(s)`);
      }
    } catch (err) {
      console.warn("[sharing] Failed to load contacts on startup:", err.message);
    }

    // Subscribe to all incoming DMs (invites, social messages)
    // Done here so relay connections from subscribeToContact are reused
    try {
      await nostrManager.subscribeToIncoming(async (payload) => {
        if (!payload.crowId || !payload.ed25519Pub || !payload.secp256k1Pub) return;

        const existing = await db.execute({
          sql: "SELECT id FROM contacts WHERE crow_id = ?",
          args: [payload.crowId],
        });
        if (existing.rows.length > 0) return;

        const result = await db.execute({
          sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey)
                VALUES (?, ?, ?, ?)`,
          args: [payload.crowId, payload.displayName || payload.crowId, payload.ed25519Pub, payload.secp256k1Pub],
        });

        const contactId = Number(result.lastInsertRowid);
        await syncManager.initContact(contactId, null);
        await peerManager.joinContact({ crowId: payload.crowId, ed25519Pubkey: payload.ed25519Pub });
        await nostrManager.subscribeToContact({
          id: contactId, crowId: payload.crowId, secp256k1_pubkey: payload.secp256k1Pub,
        });
        console.log(`[sharing] Auto-added contact from invite acceptance: ${payload.displayName || payload.crowId}`);
      }, async (subtype, payload, senderPubkey) => {
        console.log(`[sharing] Received crow_social message: ${subtype}`);
        if (subtype === "room_invite") {
          const { room_code, join_url, host_name, host_crow_id } = payload;
          if (!room_code || !join_url) return;
          try {
            await createNotification(db, {
              title: `${host_name || "Someone"} is calling`,
              body: `Tap to join the call`,
              type: "peer",
              source: "sharing:room_invite",
              priority: "high",
              action_url: join_url,
            });
          } catch (err) {
            console.warn("[sharing] Failed to create room invite notification:", err.message);
          }
        } else if (subtype === "room_closed") {
          const { host_name } = payload;
          try {
            await createNotification(db, {
              title: `${host_name || "Host"} closed the room`,
              type: "peer",
              source: "sharing:room_closed",
            });
          } catch {}
        } else if (subtype === "voice_memo") {
          const { text, sender_name } = payload;
          if (!text) return;
          try {
            await createNotification(db, {
              title: `Voice memo from ${sender_name || "Someone"}`,
              body: text.length > 200 ? text.slice(0, 200) + "..." : text,
              type: "peer",
              source: "sharing:voice_memo",
              priority: "high",
            });
          } catch (err) {
            console.warn("[sharing] Failed to create voice memo notification:", err.message);
          }
        } else if (subtype === "reaction") {
          const { emoji, sender_name } = payload;
          if (!emoji) return;
          try {
            await createNotification(db, {
              title: `${sender_name || "Someone"} reacted ${emoji}`,
              type: "peer",
              source: "sharing:reaction",
            });
          } catch {}
        } else if (subtype === "group_message") {
          const { group_name, sender_name, message: msgText } = payload;
          if (!msgText) return;
          try {
            await createNotification(db, {
              title: `[${group_name || "Group"}] ${sender_name || "Someone"}`,
              body: msgText.length > 200 ? msgText.slice(0, 200) + "..." : msgText,
              type: "peer",
              source: "sharing:group_message",
              priority: "high",
            });
          } catch (err) {
            console.warn("[sharing] Failed to create group message notification:", err.message);
          }
          // Also store as a regular message with group context
          try {
            // Find the sender contact
            const senderContact = await db.execute({
              sql: "SELECT id FROM contacts WHERE crow_id = ?",
              args: [payload.sender_crow_id || ""],
            });
            if (senderContact.rows.length > 0) {
              await db.execute({
                sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
                      VALUES (?, ?, ?, 'received', 0, datetime('now'))`,
                args: [senderContact.rows[0].id, `grp_${Date.now()}`, `[${group_name}] ${msgText}`],
              });
            }
          } catch {}
        } else if (subtype === "bot_relay") {
          const localName = await resolveLocalInstanceName(db);
          if (payload.target_instance !== localName) return; // Not for us
          // Validate sender is a known instance
          const senderCheck = await db.execute({
            sql: "SELECT id FROM crow_instances WHERE name = ? AND status = 'active'",
            args: [payload.sender_instance],
          });
          if (senderCheck.rows.length === 0) {
            console.warn(`[sharing] Bot relay from unknown instance: ${payload.sender_instance}`);
            return;
          }
          handleIncomingBotRelay(payload, db, identity, nostrManager);
        } else if (subtype === "bot_relay_result") {
          const localName = await resolveLocalInstanceName(db);
          if (payload.target_instance !== localName) return; // Not for us
          const pending = resolvePendingRelay(payload.relay_id);
          try {
            await createNotification(db, {
              title: `${payload.responder_instance}: ${payload.status === "success" ? "Done" : "Error"}`,
              body: payload.result || "No details",
              type: "system",
              source: "sharing:bot_relay_result",
              priority: "high",
            });
          } catch (err) {
            console.warn("[sharing] Failed to create relay result notification:", err.message);
          }
        }
      });
      console.log("[sharing] Subscribed to incoming Nostr messages");
    } catch (err) {
      console.warn("[sharing] Failed to subscribe to incoming messages:", err.message);
    }

    // Join instance sync topic for cross-instance discovery
    try {
      await peerManager.joinInstanceSync();

      // Initialize feeds for known instances. Include 'offline' peers so a
      // late-arriving Hyperswarm connection can replicate into a feed that's
      // already open, rather than racing a first-open against the connection.
      // Revoked/paused peers are deliberately excluded.
      const { rows: instances } = await db.execute({
        sql: "SELECT id, sync_url FROM crow_instances WHERE status IN ('active','offline') AND id != ?",
        args: [instanceSyncManager.localInstanceId],
      });
      for (const inst of instances) {
        try {
          // Feed key from sync_url (hex-encoded) or null for first contact
          const feedKey = inst.sync_url ? Buffer.from(inst.sync_url, "hex") : null;
          await instanceSyncManager.initInstance(inst.id, feedKey);
        } catch (err) {
          console.warn(`[sharing] Failed to init sync feed for instance ${inst.id}:`, err.message);
        }
      }
      if (instances.length > 0) {
        console.log(`[sharing] Initialized sync feeds for ${instances.length} instance(s)`);
      }
    } catch (err) {
      console.warn("[sharing] Instance sync setup:", err.message);
    }
  }).catch((err) => {
    console.warn("[sharing] PeerManager start failed:", err.message);
  });

  // Wire instance-to-instance connections for Hypercore replication
  peerManager.onInstanceConnected = async (crowId, conn) => {
    console.log(`[sharing] Instance peer connected: ${crowId}`);

    // Find which instance this connection belongs to. Accept status='active'
    // or 'offline' — a live Hyperswarm connection IS the signal the peer is
    // up, so treating an offline-but-connected peer as unreachable would
    // create a chicken-and-egg where sync never initializes and status never
    // flips to active. Revoked/paused peers stay excluded.
    try {
      const { rows } = await db.execute({
        sql: "SELECT id FROM crow_instances WHERE crow_id = ? AND status IN ('active','offline') AND id != ?",
        args: [crowId, instanceSyncManager.localInstanceId],
      });

      for (const inst of rows) {
        // Initialize feed (idempotent — opens outgoing feed, and incoming feed
        // too if we already know the peer's feed key from the challenge-response
        // handshake or from a prior exchange persisted to crow_instances.sync_url).
        const existingKey = inst.sync_url ? Buffer.from(inst.sync_url, "hex") : null;
        await instanceSyncManager.initInstance(inst.id, existingKey);

        // Replicate over this connection. Our outgoing feed key was already
        // piggybacked on the challenge-response JSON message (see peer-manager.js
        // case "challenge" + getFeedKeyForCrow wiring below).
        await instanceSyncManager.replicate(inst.id, conn);
      }

      // Update last_seen on all matching instances
      await db.execute({
        sql: "UPDATE crow_instances SET last_seen_at = datetime('now'), status = 'active' WHERE crow_id = ? AND id != ?",
        args: [crowId, instanceSyncManager.localInstanceId],
      });
    } catch (err) {
      console.warn(`[sharing] Instance connection handling failed for ${crowId}:`, err.message);
    }
  };

  // Advertise our own local instance_id to peer-manager so it can include
  // the id on the challenge/challenge-response JSON (disambiguates peers
  // when all instances of one user share one crow_id).
  peerManager.localInstanceId = instanceSyncManager.localInstanceId;

  // peer-manager asks us for OUR outgoing feed key to a specific peer
  // instance (remoteInstanceId is the peer's local id, which matches the
  // `id` column in our crow_instances table for that peer's row).
  peerManager.getFeedKeyForInstance = async (remoteInstanceId) => {
    try {
      // Only return a key if we actually have a paired row for this instance.
      const { rows } = await db.execute({
        sql: "SELECT id FROM crow_instances WHERE id = ? AND status IN ('active','offline') AND id != ? LIMIT 1",
        args: [remoteInstanceId, instanceSyncManager.localInstanceId],
      });
      if (rows.length === 0) return null;
      // Ensure our outbound feed to this peer exists before asking for the key.
      await instanceSyncManager.initInstance(remoteInstanceId, null);
      const key = instanceSyncManager.getOutFeedKey(remoteInstanceId);
      return key ? key.toString("hex") : null;
    } catch (err) {
      console.warn(`[sharing] getFeedKeyForInstance for ${remoteInstanceId}:`, err.message);
      return null;
    }
  };

  // Persist a peer-advertised feed key so we can open their incoming feed.
  // Called when the peer piggybacks (instance_id, feed_key_hex) on the
  // challenge-response JSON message (see peer-manager.js).
  peerManager.onInstanceKeyReceived = async (remoteInstanceId, feedKeyHex) => {
    try {
      const { rows } = await db.execute({
        sql: "SELECT sync_url FROM crow_instances WHERE id = ? AND status IN ('active','offline') AND id != ?",
        args: [remoteInstanceId, instanceSyncManager.localInstanceId],
      });
      if (rows.length === 0) return; // Not paired with this instance_id — drop
      if (rows[0].sync_url === feedKeyHex) return; // unchanged — skip
      await db.execute({
        sql: "UPDATE crow_instances SET sync_url = ?, updated_at = datetime('now') WHERE id = ?",
        args: [feedKeyHex, remoteInstanceId],
      });
      console.log(`[sharing] Stored feed key for instance ${remoteInstanceId.slice(0, 12)}…`);
      // Open the incoming feed now that we have the key. initInstance is
      // idempotent — re-calling with a non-null feedKey adds the inFeed
      // without disturbing the already-open outFeed.
      try {
        await instanceSyncManager.initInstance(remoteInstanceId, Buffer.from(feedKeyHex, "hex"));
      } catch (err) {
        console.warn(`[sharing] Failed to open inbound feed after key exchange: ${err.message}`);
      }
    } catch (err) {
      console.warn(`[sharing] onInstanceKeyReceived for ${remoteInstanceId}:`, err.message);
    }
  };

  // Wire peer connections — update last_seen and deliver pending shares
  peerManager.onPeerConnected = async (crowId, conn) => {
    const contact = await db.execute({
      sql: "SELECT * FROM contacts WHERE crow_id = ? AND is_blocked = 0",
      args: [crowId],
    });
    if (contact.rows.length === 0) return;

    const c = contact.rows[0];
    console.log(`[sharing] Peer connected: ${crowId}`);

    // Update last_seen
    await db.execute({
      sql: "UPDATE contacts SET last_seen = datetime('now') WHERE id = ?",
      args: [c.id],
    });

    // Deliver any pending shares
    const pending = await db.execute({
      sql: `SELECT si.*, '${c.crow_id}' as crow_id FROM shared_items si
            WHERE si.contact_id = ? AND si.direction = 'sent' AND si.delivery_status = 'pending'`,
      args: [c.id],
    });

    for (const share of pending.rows) {
      try {
        // W4-2: queued clone shares go out without mode:"clone" (receiver no-ops them) — known bug, fix scheduled in W4-2
        const tableMap = {
          memory: { table: "memories", query: null },
          project: {
            table: "project_spaces",
            query: `SELECT id, uuid, name, description, type, status, tags, created_at, updated_at
                    FROM project_spaces WHERE id = ? AND archived_at IS NULL`,
          },
          source: { table: "research_sources", query: null },
          note: { table: "research_notes", query: null },
          kb_article: { table: "kb_articles", query: null },
        };
        const mapEntry = tableMap[share.share_type];
        if (!mapEntry) continue;

        let itemDataRows;
        if (mapEntry.query) {
          const r = await db.execute({ sql: mapEntry.query, args: [share.item_id] });
          itemDataRows = r.rows;
        } else {
          const r = await db.execute({
            sql: `SELECT * FROM ${mapEntry.table} WHERE id = ?`,
            args: [share.item_id],
          });
          itemDataRows = r.rows;
        }
        const itemData = { rows: itemDataRows };
        if (itemData.rows.length === 0) continue;

        peerManager.send(crowId, {
          type: "share",
          share_type: share.share_type,
          payload: itemData.rows[0],
          permissions: share.permissions,
          sender: identity.crowId,
          timestamp: new Date().toISOString(),
        });

        await db.execute({
          sql: "UPDATE shared_items SET delivery_status = 'delivered' WHERE id = ?",
          args: [share.id],
        });
      } catch (err) {
        // Delivery failed — will retry next connection
      }
    }

    if (pending.rows.length > 0) {
      console.log(`[sharing] Delivered ${pending.rows.length} pending share(s) to ${crowId}`);
    }
  };

  // Handle data from connected peers (shares, revokes, etc.)
  peerManager.onPeerData = async (crowId, payload) => {
    if (!payload?.type) return;

    const contact = await db.execute({
      sql: "SELECT * FROM contacts WHERE crow_id = ? AND is_blocked = 0",
      args: [crowId],
    });
    if (contact.rows.length === 0) return;
    const c = contact.rows[0];

    if (payload.type === "share" && payload.share_type && payload.payload) {
      // Incoming share — import the data and record it
      try {
        let importedItemId = 0;

        if (payload.share_type === "memory") {
          const result = await db.execute({
            sql: `INSERT INTO memories (content, category, importance, context, source, tags)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [
              payload.payload.content || "",
              payload.payload.category || "general",
              payload.payload.importance || 5,
              payload.payload.context || "",
              payload.payload.source || "",
              payload.payload.tags || "",
            ],
          });
          importedItemId = Number(result.lastInsertRowid);
        } else if (payload.share_type === "source") {
          const result = await db.execute({
            sql: `INSERT INTO research_sources (project_id, title, url, source_type, citation, notes)
                  VALUES (NULL, ?, ?, ?, ?, ?)`,
            args: [
              payload.payload.title || "Shared source",
              payload.payload.url || "",
              payload.payload.source_type || "other",
              payload.payload.citation || "",
              payload.payload.notes || "",
            ],
          });
          importedItemId = Number(result.lastInsertRowid);
        } else if (payload.share_type === "note") {
          const result = await db.execute({
            sql: `INSERT INTO research_notes (project_id, content)
                  VALUES (NULL, ?)`,
            args: [payload.payload.content || ""],
          });
          importedItemId = Number(result.lastInsertRowid);
        } else if (payload.share_type === "project" && payload.mode === "clone" && payload.payload) {
          // M4: clone-bundle ingestion. Creates a new project_spaces row
          // with `-clone-N` slug + carries sources/notes/audit. Owner is
          // the local user (the operator who received it). Returns the
          // new project_id and a summary for the inbox row.
          try {
            const summary = await applyProjectCloneBundle(payload.payload, c.id);
            importedItemId = summary.project_id;
            console.log(
              `[sharing] Received project clone from ${crowId} → new project_spaces #${summary.project_id} (slug: ${summary.slug}, ` +
              `${summary.sources_imported} sources, ${summary.notes_imported} notes, ${summary.audit_imported} audit, ` +
              `${summary.backends_in_manifest} backend manifests, ${summary.files_in_manifest} file manifests)`
            );
          } catch (cloneErr) {
            console.warn(`[sharing] Failed to import project clone from ${crowId}: ${cloneErr.message}`);
          }
        } else if (payload.share_type === "kb_article") {
          try {
            const p = payload.payload;
            const { randomUUID } = await import("node:crypto");
            // Find or create a collection for received articles
            let colId = null;
            const existing = await db.execute({ sql: "SELECT id FROM kb_collections LIMIT 1", args: [] });
            if (existing.rows.length > 0) {
              colId = existing.rows[0].id;
            } else {
              // Create a default collection for shared articles
              const newCol = await db.execute({
                sql: `INSERT INTO kb_collections (slug, name, description, visibility) VALUES ('shared', 'Shared Articles', 'Articles received from contacts', 'private')`,
                args: [],
              });
              colId = Number(newCol.lastInsertRowid);
            }
            const result = await db.execute({
              sql: `INSERT INTO kb_articles (collection_id, pair_id, language, slug, title, content, excerpt, author, tags, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
              args: [
                colId,
                p.pair_id || randomUUID(),
                p.language || "en",
                p.slug || p.title?.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 200) || "shared-article",
                p.title || "Shared article",
                p.content || "",
                p.excerpt || null,
                p.author || null,
                p.tags || null,
              ],
            });
            importedItemId = Number(result.lastInsertRowid);
          } catch (kbErr) {
            // kb_articles table may not exist if knowledge-base bundle is not installed
            console.warn(`[sharing] Cannot import kb_article — knowledge-base bundle may not be installed: ${kbErr.message}`);
          }
        }

        await db.execute({
          sql: `INSERT INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status)
                VALUES (?, ?, ?, ?, 'received', 'delivered')`,
          args: [c.id, payload.share_type, importedItemId, payload.permissions || "read"],
        });

        console.log(`[sharing] Received ${payload.share_type} from ${crowId} → imported as #${importedItemId}`);

        try {
          await createNotification(db, {
            title: `Received ${payload.share_type} from ${c.display_name || crowId}`,
            type: "peer",
            source: "sharing:share",
            action_url: "/dashboard/messages",
          });
        } catch {}
      } catch (err) {
        console.warn(`[sharing] Failed to import share from ${crowId}:`, err.message);
      }
    } else if (payload.type === "revoke" && payload.share_type) {
      // Handle revocation
      console.log(`[sharing] Received revoke for ${payload.share_type} from ${crowId}`);
    }
  };

  // Hypercore feed entries (legacy — shares now go via onPeerData)
  syncManager.onEntry = async (contactId, entry) => {
    console.log(`[sharing] Received Hypercore entry for contact ${contactId}:`, entry.type);
  };

  // subscribeToIncoming is now set up inside peerManager.start().then()
  // so relay connections from subscribeToContact are reused
}
