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
import bus from "../shared/event-bus.js";
import { ensureColumn } from "../db.js";
import { normalizePubkey, findContactByPubkey } from "./pubkey-util.js";
import {
  resolveLocalInstanceName,
  resolvePendingRelay,
  handleIncomingBotRelay,
} from "./bot-relay.js";
import { upsertFullContact, isPlaceholderName } from "./contact-promote.js";
import { markDelivered, DELIVERY_RECEIPT_SUBTYPE, HANDSHAKE_COMPLETE_SUBTYPE, buildHandshakeComplete } from "./retry-queue.js";
import { setReceiveWired } from "./receive-health.js";
import { wasProcessed, recordProcessedEvent } from "./processed-events.js";
import { sanitizeDisplayName } from "./display-name.js";

/**
 * Read the local user's own display name (dashboard_settings.profile_display_name),
 * sanitized (design §D5). Returns null when unset, empty, rejected, or on any DB
 * error — the caller then omits the field entirely (no placeholder). Never throws.
 * Reads the GLOBAL scope on purpose (Cluster B design D6): profile identity is
 * user-level; per-instance overrides of profile_* keys are intentionally inert.
 */
async function readLocalDisplayName(db) {
  try {
    if (!db) return null;
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'profile_display_name'",
      args: [],
    });
    return sanitizeDisplayName(rows?.[0]?.value);
  } catch {
    return null;
  }
}

/**
 * L6 receive-path fix — turn a decrypted DM from an unknown sender into a
 * visible **message request** instead of silently dropping it.
 *
 * Called by the `onMessageRequest` branch of `subscribeToIncoming` for every
 * event NOT consumed by a real handler (plaintext, malformed JSON, or a
 * subtype-less crow_social). It:
 *   1. Resolves the sender by secp256k1 pubkey (trailing-64 normalized).
 *      - Existing FULL contact (request_status IS NULL) → return early; the
 *        per-contact `subscribeToContact` already stores that DM (no double-store).
 *      - Existing request contact ('pending'/'accepted') → reuse its id.
 *      - Otherwise → INSERT a minimal request contact
 *        (`crow_id='req:'+<FULL 64-hex>`, empty ed25519, 'pending').
 *   2. Stores the DM as a `received` message (INSERT OR IGNORE, dedup on
 *      nostr_event_id).
 *   3. Notifies ONLY when the request contact row was NEWLY created this call
 *      (deterministic first-contact signal — not a racy post-insert count).
 *
 * Exported for unit testing without live relays. NEVER throws — the receive
 * path must not break delivery. `managers.createNotification` may be injected
 * (tests); otherwise the shared helper is used.
 *
 * @param {object} db
 * @param {object} managers - may carry an optional `createNotification` override
 * @param {{senderPubkey:string, content:string, eventId:string}} evt
 */
export async function handleIncomingRequest(db, managers, { senderPubkey, content, eventId } = {}) {
  const notify = (managers && managers.createNotification) || createNotification;
  try {
    if (!db || !senderPubkey) return;

    let contactId;
    let newlyCreated = false;

    const existing = await findContactByPubkey(db, senderPubkey);
    if (existing) {
      // F-BLOCK-1 D4b: a blocked contact — ANY request_status (full, pending,
      // accepted) — is silently dropped on the catch-all path: no store, no
      // notification. This was the S5.4 live store path.
      if (Number(existing.is_blocked) === 1) return;
      // A full contact (request_status NULL) is already handled by the
      // per-contact subscription — do nothing here to avoid a double-store.
      if (existing.request_status === null || existing.request_status === undefined) {
        return;
      }
      // 'pending' or 'accepted' request contact — reuse it.
      contactId = existing.id;
    } else {
      // Minimal request contact. crow_id uses the FULL 64-hex normalized
      // pubkey (NOT a 16-hex prefix) so two senders can never collide on the
      // UNIQUE crow_id and re-drop a DM (reintroducing L6).
      const crowId = "req:" + normalizePubkey(senderPubkey);
      try {
        const result = await db.execute({
          sql: `INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, display_name, request_status, contact_type)
                VALUES (?, ?, '', NULL, 'pending', 'crow')`,
          args: [crowId, senderPubkey],
        });
        contactId = Number(result.lastInsertRowid);
        newlyCreated = true;
      } catch (insErr) {
        // Concurrent insert of the same crow_id (UNIQUE) — re-resolve and
        // reuse rather than dropping the DM.
        const again = await findContactByPubkey(db, senderPubkey);
        if (!again) throw insErr;
        contactId = again.id;
      }
    }

    // Store the DM (dedup on the UNIQUE nostr_event_id).
    // Phase 3 PR-B: deliberately NOT emitted to instance-sync — the req:<pubkey>
    // pending contact doesn't sync (S-REQUESTS), so a peer could never resolve it.
    try {
      await db.execute({
        sql: `INSERT OR IGNORE INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
              VALUES (?, ?, ?, 'received', 0, datetime('now'))`,
        args: [contactId, eventId ?? null, content ?? ""],
      });
    } catch (msgErr) {
      try { console.warn("[sharing] message-request store failed:", msgErr.message); } catch {}
    }

    // First-contact notification only (deterministic: the request row was
    // just created this call).
    if (newlyCreated) {
      try {
        const preview = typeof content === "string" && content.length > 200
          ? content.slice(0, 200) + "..."
          : (content || "Someone wants to message you");
        await notify(db, {
          title: "New message request",
          body: preview,
          type: "peer",
          source: "sharing:message_request",
          action_url: "/dashboard/messages",
        });
      } catch (notifyErr) {
        try { console.warn("[sharing] message-request notify failed:", notifyErr.message); } catch {}
      }
    }
  } catch (err) {
    // Never throw out of the receive path — a throw would kill the subscription.
    try { console.warn("[sharing] handleIncomingRequest failed:", err.message); } catch {}
  }
}

/** Fire-and-forget handshake_complete ack to the acceptor (authenticated
 * senderPubkey). Naming the invite_accepted event id lets the acceptor clear
 * the exact retry row. Best-effort — a lost ack self-heals. */
async function ackHandshake(nostrManager, senderPubkey, event, db) {
  try {
    if (!nostrManager || !event || !event.id) return;
    // F-CONTACT-2 (design §D5): carry the inviter's OWN display name so the
    // acceptor can show a name instead of a raw crowId. Omitted when unset.
    const selfName = await readLocalDisplayName(db);
    await nostrManager.sendControl({ secp256k1_pubkey: senderPubkey }, buildHandshakeComplete([event.id], selfName));
  } catch { /* ack is best-effort */ }
}

/**
 * R4: an authenticated invite_accepted DM completes the handshake. Promotes an
 * existing accepted/pending message-request row for the same secp identity into
 * a FULL contact (or adds a fresh one), via the idempotent upsertFullContact.
 * This is the ONLY promotion trigger — the plaintext message-request path can
 * NEVER elevate a contact. Never throws (receive path).
 *
 * PR3: also emits a handshake_complete ack (naming `event.id`) back to the
 * acceptor — after a successful promote, AND at the "replayed" ledger verdict
 * (I4 self-heal: a lost first ack re-heals when the inviter restarts and
 * re-sees the retried event). NOT on "expired" and NOT on the auth-fail bail.
 * `event` is optional (legacy callers) — no event means no ack, guarded.
 */
export async function handleInviteAccepted(db, managers, payload, senderPubkey, event) {
  try {
    if (!payload || !payload.crowId || !payload.ed25519Pub || !payload.secp256k1Pub) return;
    // Bind promotion to the AUTHENTICATED signing key: the payload's claimed
    // secp key must equal the event's cryptographically-bound pubkey, else a
    // stranger could forge an invite_accepted to promote/hijack a gated contact.
    if (normalizePubkey(payload.secp256k1Pub) !== normalizePubkey(senderPubkey)) return;

    // F-BLOCK-1 D4d: silence toward a blocked contact. Resolve BEFORE the
    // replay-hygiene and short-code branches below — BOTH of those ack, and
    // the common blocked case ("handshake processed, then blocked") re-sends
    // the same event.id for ~60h, which would keep acking a blocked party.
    // No upsert, no ack, no wiring. Skipping consumeShortInvite is safe: the
    // invite was consumed on the pre-block accept, and an unconsumed row
    // expires at the 72h ledger TTL.
    try {
      const senderContact = await findContactByPubkey(db, senderPubkey);
      if (senderContact && Number(senderContact.is_blocked) === 1) return;
    } catch { /* resolution failure must not break honest handshakes */ }

    // D4 (design §D4): clock-free replay hygiene. R5's retry loop re-publishes
    // the EXACT stored signed event for ~60h, so a stale retry arriving AFTER
    // the user deleted this contact carries the same event.id. Skip the upsert
    // (a deleted contact must not resurrect itself) but STILL ack — the ack
    // stops the peer's 60h retry loop instead of letting it hammer. Mirrors the
    // "replayed" short-code verdict below, which also acks with no contact row.
    if (event?.id && (await wasProcessed(db, event.id))) {
      await ackHandshake(managers?.nostrManager, senderPubkey, event, db);
      return;
    }

    // P2/C2 single-use gate (runs ONLY after the R4 auth check above, so an
    // unauthenticated forged invite_accepted cannot burn the token — "first
    // AUTHENTICATED wins", spec §PR2.4). A short-code acceptance echoes the
    // inviteId; the first authenticated echo consumes it. Fail OPEN on unknown
    // (instance-local ledger; sibling instances legitimately miss it) and on
    // ledger errors (never let the ledger break honest pairing).
    if (payload && typeof payload.inviteId === "string" && payload.inviteId) {
      try {
        const { consumeShortInvite } = await import("./shortcode-ledger.js");
        const verdict = await consumeShortInvite(db, payload.inviteId);
        if (verdict === "replayed") {
          // I4: PR3's handshake_complete ack must still fire for this verdict
          // (idempotent) — the retained 72h ledger TTL keeps the row available.
          console.warn("[sharing] short-code invite replay rejected");
          await ackHandshake(managers?.nostrManager, senderPubkey, event, db); // I4 self-heal
          return;
        }
        if (verdict === "expired") {
          console.warn("[sharing] short-code invite expired");
          return;
        }
      } catch {
        console.warn("[sharing] short-code ledger check failed — proceeding");
      }
    }

    await upsertFullContact(db, managers, {
      crowId: payload.crowId,
      ed25519Pub: payload.ed25519Pub,
      secp256k1Pub: payload.secp256k1Pub,
      // F-CONTACT-2 (design §D5): the acceptor's name is remote-controlled —
      // sanitize before it reaches the DB. A null result → upsert falls back to
      // crowId (byte-identical to the no-name case).
      displayName: sanitizeDisplayName(payload.displayName),
    });
    // D4: record the handled event.id AFTER a successful upsert so a stale
    // ~60h retry of this same event cannot re-create a since-deleted contact.
    if (event?.id) await recordProcessedEvent(db, event.id, "invite_accepted");
    await ackHandshake(managers?.nostrManager, senderPubkey, event, db);
  } catch (err) {
    try { console.warn("[sharing] invite_accepted promotion failed:", err.message); } catch {}
  }
}

/**
 * R5: a delivery receipt from a contact confirms they actually received our
 * DM(s). Flip the matching sent rows relayed→delivered and clear their retry
 * rows — both CONTACT-BOUND (the receipt's authenticated sender pubkey must own
 * those messages), because a Nostr event.id is public on relays and a stranger
 * could otherwise forge a receipt. Independent of the retry queue, so a late
 * (post-expiry) ack still flips the column. Never throws (receive path).
 */
export async function handleDeliveryReceipt(db, eventIds, senderPubkey) {
  try {
    const ids = (Array.isArray(eventIds) ? eventIds : []).filter((x) => typeof x === "string" && x);
    if (!db || ids.length === 0) return;
    const contact = await findContactByPubkey(db, senderPubkey);
    if (!contact) return; // receipt from a non-contact → ignore
    const placeholders = ids.map(() => "?").join(",");
    await db.execute({
      sql: `UPDATE messages SET delivery_status = 'delivered'
            WHERE direction = 'sent' AND contact_id = ? AND nostr_event_id IN (${placeholders})`,
      args: [contact.id, ...ids],
    });
    await markDelivered(db, ids, contact.id);
    // F-UI-6: nudge any open dashboard conversation to flip ✓→✓✓ live. This is
    // a SEPARATE event from messages:changed — that consumer is badge-only and
    // reads payload.unread (emitting it here would blank the peer's unread
    // badge). Payload carries the LOCAL row ids the UPDATE just touched.
    try {
      const { rows } = await db.execute({
        sql: `SELECT id FROM messages
              WHERE direction = 'sent' AND contact_id = ? AND nostr_event_id IN (${placeholders})`,
        args: [contact.id, ...ids],
      });
      if (rows.length > 0) {
        bus.emit("messages:receipt", { contactId: Number(contact.id), ids: rows.map((r) => Number(r.id)) });
      }
    } catch { /* live-tick nudge is best-effort */ }
  } catch (err) {
    try { console.warn("[sharing] delivery_receipt handling failed:", err.message); } catch {}
  }
}

/**
 * PR3: the acceptor received the inviter's handshake_complete ack — clear the
 * invite_accepted retry row(s), CONTACT-BOUND to the authenticated sender so a
 * forged ack can't purge another contact's retries. Mirrors handleDeliveryReceipt.
 * Never throws (receive path).
 */
export async function handleHandshakeComplete(db, eventIds, senderPubkey, displayName) {
  try {
    const ids = (Array.isArray(eventIds) ? eventIds : []).filter((x) => typeof x === "string" && x);
    if (!db) return;
    const contact = await findContactByPubkey(db, senderPubkey);
    if (!contact) return;
    if (ids.length > 0) await markDelivered(db, ids, contact.id);
    // F-CONTACT-2 (design §D5): apply the inviter's optional display name to the
    // AUTHENTICATED sender's contact — sanitized, and ONLY over a placeholder
    // stored name (never overwrite a name the user typed). The contact is
    // resolved from senderPubkey, never from a payload-claimed identity.
    const name = sanitizeDisplayName(displayName);
    if (name && isPlaceholderName(contact.display_name)) {
      await db.execute({
        sql: "UPDATE contacts SET display_name = ? WHERE id = ?",
        args: [name, contact.id],
      });
    }
  } catch (err) {
    try { console.warn("[sharing] handshake_complete handling failed:", err.message); } catch {}
  }
}

/**
 * Deliver all pending shared_items rows for a connected peer.
 *
 * Exported for unit testing.  The onPeerConnected callback calls it with an
 * outer try/catch (never rejects) because peer-manager invokes that callback
 * fire-and-forget with no .catch — an unhandled rejection would crash the process.
 *
 * Clone rows (mode='clone', share_type='project'):
 *   - Archived/missing project → mark 'failed', warn, continue.
 *   - Member row with revoked_at IS NOT NULL → mark 'failed', warn, continue.
 *   - Member row ABSENT → deliver with role 'viewer' / capabilities null
 *     (member-row write at share time is non-fatal — absent rows are legitimate).
 *   - Otherwise → rebuild bundle fresh, send, mark 'delivered' on success.
 * Plain rows (mode NULL):
 *   - Existing tableMap path, behavior unchanged.
 */
export async function deliverPendingShares({ db, peerManager, contact, identityCrowId, buildProjectCloneBundle }) {
  const crowId = contact.crow_id;
  const pending = await db.execute({
    sql: `SELECT * FROM shared_items WHERE contact_id = ? AND direction = 'sent' AND delivery_status = 'pending'`,
    args: [contact.id],
  });

  let delivered = 0;
  for (const share of pending.rows) {
    try {
      // --- Clone re-delivery path ---
      if (share.mode === "clone" && share.share_type === "project") {
        // Explicit archived check: buildProjectCloneBundle doesn't filter archived rows.
        const psRow = (await db.execute({
          sql: "SELECT archived_at FROM project_spaces WHERE id = ?",
          args: [share.item_id],
        })).rows[0];
        if (!psRow || psRow.archived_at !== null && psRow.archived_at !== undefined && psRow.archived_at) {
          await db.execute({
            sql: "UPDATE shared_items SET delivery_status = 'failed' WHERE id = ?",
            args: [share.id],
          });
          console.warn(`[sharing] queued clone #${share.id}: project #${share.item_id} is archived/missing — marked failed`);
          continue;
        }

        // Member row lookup WITHOUT the revoked filter.
        const memberRow = (await db.execute({
          sql: `SELECT role, capabilities, revoked_at FROM project_members
                WHERE project_id = ? AND contact_id = ? AND mode = 'clone'
                ORDER BY id DESC LIMIT 1`,
          args: [share.item_id, share.contact_id],
        })).rows[0];

        if (memberRow && memberRow.revoked_at != null) {
          // Revoked: mark failed and skip — crow_revoke_access normally DELETEs the
          // shared_items row (sharing-admin.js:72-76), so this branch is defensive.
          await db.execute({
            sql: "UPDATE shared_items SET delivery_status = 'failed' WHERE id = ?",
            args: [share.id],
          });
          console.warn(`[sharing] queued clone #${share.id}: project #${share.item_id} access revoked — marked failed`);
          continue;
        }

        // Use member row values if present; fall back to viewer/null if absent.
        const role = memberRow?.role ?? "viewer";
        const capabilities = memberRow?.capabilities ?? null;

        // Rebuild the bundle fresh (snapshot-at-delivery semantics).
        const bundle = await buildProjectCloneBundle(share.item_id);

        peerManager.send(crowId, {
          type: "share",
          share_type: "project",
          mode: "clone",
          payload: bundle,
          role,
          capabilities,
          sender: identityCrowId,
          timestamp: new Date().toISOString(),
        });

        await db.execute({
          sql: "UPDATE shared_items SET delivery_status = 'delivered' WHERE id = ?",
          args: [share.id],
        });
        delivered++;
        continue;
      }

      // --- Plain row path (mode NULL) — behavior unchanged ---
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
      if (itemDataRows.length === 0) continue;

      peerManager.send(crowId, {
        type: "share",
        share_type: share.share_type,
        payload: itemDataRows[0],
        permissions: share.permissions,
        sender: identityCrowId,
        timestamp: new Date().toISOString(),
      });

      await db.execute({
        sql: "UPDATE shared_items SET delivery_status = 'delivered' WHERE id = ?",
        args: [share.id],
      });
      delivered++;
    } catch (err) {
      // Delivery failed — row stays 'pending', retried next connection
      console.warn(`[sharing] pending share #${share.id} (${share.share_type}) delivery error: ${err.message}`);
    }
  }

  if (pending.rows.length > 0) {
    console.log(`[sharing] Delivered ${delivered}/${pending.rows.length} pending share(s) to ${crowId}`);
  }
}

/**
 * R8 (never run deaf): wire the Nostr receive path — per-contact subscriptions
 * plus the broad incoming subscription — INDEPENDENT of Hyperswarm. DMs are
 * Nostr kind:4 and need no DHT; before this split the whole block lived inside
 * peerManager.start().then(), so a single DHT failure at boot silently killed
 * all message receipt until restart (L11).
 *
 * Per-contact subscribe failures warn-and-continue (as before). A
 * subscribeToIncoming failure PROPAGATES — that is the wiring failure
 * startNostrReceive retries. Re-running is safe: NostrManager closes and
 * replaces any prior handle per subscription key.
 */
export async function wireNostrReceive(managers) {
  // The handler ladder references ALL of these free names (review round 1
  // critical): handleInviteAccepted uses syncManager/peerManager (boot.js:385),
  // handleIncomingBotRelay + handleInboundRoomEnvelope use identity
  // (boot.js:477,497), handleIncomingRequest takes the whole `managers`
  // (boot.js:505). Destructuring too few silently breaks invite promotion —
  // the ReferenceError is swallowed by subscribeToIncoming's handled=true
  // try/catch (nostr.js:508-521).
  const { db, identity, peerManager, syncManager, nostrManager } = managers;

  try {
    const contacts = await db.execute({
      sql: "SELECT id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, request_status FROM contacts WHERE is_blocked = 0",
      args: [],
    });
    for (const c of contacts.rows) {
      try {
        // 'pending' requests stay unsubscribed — the broad incoming
        // subscription below still receives them (L6 request path).
        if (c.request_status === "pending") continue;
        await nostrManager.subscribeToContact({
          id: c.id,
          crow_id: c.crow_id,
          secp256k1_pubkey: c.secp256k1_pubkey,
          display_name: c.display_name,
        });
      } catch (err) {
        console.warn(`[sharing] Nostr subscribe failed for ${c.crow_id}:`, err.message);
      }
    }
  } catch (err) {
    console.warn("[sharing] Failed to load contacts for Nostr subscribe:", err.message);
  }

  // Broad incoming subscription (invites, social envelopes, message requests).
  // Ordered after the per-contact loop so relay connections are reused.
  await nostrManager.subscribeToIncoming(async (payload, senderPubkey, event) => {
    await handleInviteAccepted(db, { syncManager, peerManager, nostrManager }, payload, senderPubkey, event);
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
      await handleGroupMessageNotify(db, payload, managers);
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
    } else if (subtype === DELIVERY_RECEIPT_SUBTYPE) {
      await handleDeliveryReceipt(db, payload.event_ids, senderPubkey);
    } else if (subtype === HANDSHAKE_COMPLETE_SUBTYPE) {
      await handleHandshakeComplete(db, payload.event_ids, senderPubkey, payload.displayName);
    } else if (subtype === "room_message" || subtype === "room_join") {
      const { handleInboundRoomEnvelope } = await import("./room-inbound.js");
      await handleInboundRoomEnvelope({ db, nostrManager, identity, subtype, payload, senderPubkey, log: (m) => console.log("[rooms]", m) });
    }
  }, async (senderPubkey, content, event) => {
    // L6: any decrypted DM NOT consumed by a real handler (plaintext,
    // malformed JSON, or a subtype-less crow_social) becomes a visible
    // message request instead of being silently dropped. handleIncomingRequest
    // never throws, but double-guard so onevent stays throw-proof.
    try {
      await handleIncomingRequest(db, managers, {
        senderPubkey,
        content,
        eventId: event?.id,
      });
    } catch (err) {
      try { console.warn("[sharing] onMessageRequest wiring failed:", err.message); } catch {}
    }
  });
  console.log("[sharing] Subscribed to incoming Nostr messages");
}

/**
 * F-BLOCK-1 D4c — the `group_message` fan-out notify+store logic, extracted
 * from the inline `onSocialMessage` dispatcher below so it's unit-testable
 * without live relays. Behavior is byte-identical to before EXCEPT the sender
 * resolve now happens BEFORE the notification: a blocked group member's
 * fan-out (which includes us) must neither notify nor store — send-side
 * filters only cover members WE blocked when WE fan out. An UNKNOWN
 * (non-contact) sender still notifies exactly as before — the guard is
 * `found && is_blocked===1`, never `!found`.
 *
 * `managers.createNotification` may be injected (tests); otherwise the
 * shared helper is used, matching `handleIncomingRequest`'s convention.
 *
 * @param {object} db
 * @param {{group_name?:string, sender_name?:string, message?:string, sender_crow_id?:string}} payload
 * @param {{createNotification?: Function}} [managers]
 */
export async function handleGroupMessageNotify(db, payload, managers = {}) {
  const notify = (managers && managers.createNotification) || createNotification;
  const { group_name, sender_name, message: msgText } = payload || {};
  if (!msgText) return;
  let senderRow = null;
  try {
    const senderContact = await db.execute({
      sql: "SELECT id, is_blocked FROM contacts WHERE crow_id = ?",
      args: [payload.sender_crow_id || ""],
    });
    senderRow = senderContact.rows[0] || null;
  } catch { /* lookup failure degrades to today's behavior */ }
  if (senderRow && Number(senderRow.is_blocked) === 1) return;
  try {
    await notify(db, {
      title: `[${group_name || "Group"}] ${sender_name || "Someone"}`,
      body: msgText.length > 200 ? msgText.slice(0, 200) + "..." : msgText,
      type: "peer",
      source: "sharing:group_message",
      priority: "high",
    });
  } catch (err) {
    console.warn("[sharing] Failed to create group message notification:", err.message);
  }
  // Also store as a regular message with group context.
  // Phase 3 PR-B: deliberately NOT emitted to instance-sync — synthetic
  // grp_<ts> event id (not a real Nostr event); rooms have their own sync path.
  try {
    if (senderRow) {
      await db.execute({
        sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
              VALUES (?, ?, ?, 'received', 0, datetime('now'))`,
        args: [senderRow.id, `grp_${Date.now()}`, `[${group_name}] ${msgText}`],
      });
    }
  } catch {}
}

/**
 * Run wireNostrReceive with health reporting + bounded-backoff retry.
 * Never rejects. The retry timer is unref'd so it can never hold the
 * process open.
 */
export function startNostrReceive(managers, opts = {}) {
  const baseMs = opts.baseMs ?? 15_000;
  const maxMs = opts.maxMs ?? 300_000;
  const schedule = opts.schedule ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t.unref) t.unref();
    return t;
  });
  let attempt = 0;
  const run = async () => {
    try {
      await wireNostrReceive(managers);
      setReceiveWired(true);
    } catch (err) {
      setReceiveWired(false, err);
      const delay = Math.min(baseMs * 2 ** attempt, maxMs);
      attempt += 1;
      console.warn(`[sharing] Nostr receive wiring failed (retry in ${Math.round(delay / 1000)}s):`, err?.message);
      schedule(run, delay);
    }
  };
  return run();
}

export async function initSharingRuntime(managers, helpers) {
  const { db, identity, peerManager, syncManager, instanceSyncManager, nostrManager } = managers;
  const { applyProjectCloneBundle, buildProjectCloneBundle } = helpers;

  // W4-2 B: runtime guard — a host that pulls code before running init-db will
  // have shared_items without the mode column; ensureColumn is idempotent and
  // safe to run every startup (mirrors migrations.js:152 precedent for op column).
  try {
    await ensureColumn(db, "shared_items", "mode", "TEXT");
  } catch (err) {
    console.warn("[sharing] ensureColumn shared_items.mode:", err.message);
  }

  // R8: the Nostr receive path must never depend on Hyperswarm coming up.
  // Fire-and-forget (never rejects); failures are health-visible + retried.
  startNostrReceive(managers);

  // Start peer manager and join DHT topics for existing contacts
  peerManager.start().then(async () => {
    try {
      const contacts = await db.execute({
        sql: "SELECT id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, request_status FROM contacts WHERE is_blocked = 0",
        args: [],
      });
      for (const c of contacts.rows) {
        try {
          // Nostr subscriptions are handled by wireNostrReceive (R8). Only
          // FULL contacts (request_status NULL) join DHT topics / sync —
          // partial rows lack a usable ed25519 key.
          if (c.request_status === "pending" || c.request_status === "accepted") continue;
          await syncManager.initContact(c.id, null);
          await peerManager.joinContact({
            crowId: c.crow_id,
            ed25519Pubkey: c.ed25519_pubkey,
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
      const keyBuf = instanceSyncManager.validateIncomingFeedKey(remoteInstanceId, feedKeyHex);
      if (!keyBuf) return; // malformed or self-echoed — skip persist AND init
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
        await instanceSyncManager.initInstance(remoteInstanceId, keyBuf);
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

    // Deliver any pending shares — outer try/catch: peer-manager invokes this
    // callback fire-and-forget (no .catch); an unhandled rejection crashes the process.
    try {
      await deliverPendingShares({
        db,
        peerManager,
        contact: c,
        identityCrowId: identity.crowId,
        buildProjectCloneBundle,
      });
    } catch (err) {
      console.warn(`[sharing] deliverPendingShares for ${crowId}: ${err.message}`);
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
          // S4: cap peer-controlled title at 1000 chars — title is FTS5-indexed
          // (research_sources_fts trigger in init-db.js) and is peer-supplied.
          const rawTitle = payload.payload.title || "Shared source";
          const cappedTitle = typeof rawTitle === "string" && rawTitle.length > 1000
            ? rawTitle.slice(0, 1000)
            : rawTitle;
          const result = await db.execute({
            sql: `INSERT INTO research_sources (project_id, title, url, source_type, citation, notes)
                  VALUES (NULL, ?, ?, ?, ?, ?)`,
            args: [
              cappedTitle,
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
}
