/**
 * Messages Panel — Data Queries
 *
 * DB queries for the unified conversation list, peer messages, and status polling.
 */

import { getPeerAdvertisedBots } from "../../advertised-bots-cache.js";
import { getTrustedInstances } from "../nest/data-queries.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";

/**
 * Get a unified conversation list merging AI chats and peer contacts.
 * Sorted by last activity descending.
 */
export async function getUnifiedConversationList(db) {
  const items = [];
  let totalUnread = 0;

  // AI conversations
  try {
    const { rows: aiRows } = await db.execute(`
      SELECT c.id, c.title, c.provider, c.model, c.updated_at, c.created_at,
             (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) as msg_count
      FROM chat_conversations c
      ORDER BY c.updated_at DESC
      LIMIT 100
    `);

    for (const row of aiRows) {
      items.push({
        type: "ai",
        id: row.id,
        displayName: row.title || "Untitled Chat",
        provider: row.provider,
        model: row.model,
        lastActivity: row.updated_at || row.created_at,
        msgCount: row.msg_count,
        unread: 0,
      });
    }
  } catch {}

  // Peer contacts with message activity
  try {
    const { rows: peerRows } = await db.execute(`
      SELECT c.id as contact_id, c.crow_id, c.display_name, c.last_seen, c.is_blocked, c.is_bot, c.verified,
             MAX(m.created_at) as last_msg_at,
             SUM(CASE WHEN m.is_read = 0 AND m.direction = 'received' THEN 1 ELSE 0 END) as unread
      FROM contacts c
      LEFT JOIN messages m ON m.contact_id = c.id
      WHERE c.is_blocked = 0 AND (c.origin IS NULL OR c.origin != 'local-bot')
        AND (c.request_status IS NULL OR c.request_status = 'accepted')
      GROUP BY c.id
      ORDER BY last_msg_at DESC NULLS LAST, c.created_at DESC
    `);

    for (const row of peerRows) {
      const unread = Number(row.unread) || 0;
      totalUnread += unread;
      items.push({
        type: "peer",
        id: row.contact_id,
        crowId: row.crow_id,
        displayName: row.display_name || (row.crow_id ? row.crow_id.substring(0, 16) + "..." : "Unknown"),
        lastActivity: row.last_msg_at || row.last_seen || null,
        lastSeen: row.last_seen,
        isBot: !!Number(row.is_bot),
        verified: !!Number(row.verified),
        unread,
      });
    }
  } catch {}


  // Rooms (multi-party). A contact_group with a room_uid is a room.
  try {
    const { rows: roomRows } = await db.execute(`
      SELECT g.id AS group_id, g.name, g.room_uid, g.mode,
             MAX(rm.created_at) AS last_msg_at,
             SUM(CASE WHEN rm.is_read = 0 AND rm.direction = 'received' THEN 1 ELSE 0 END) AS unread,
             (SELECT COUNT(*) FROM contact_group_members gm WHERE gm.group_id = g.id) AS member_count
      FROM contact_groups g
      LEFT JOIN room_messages rm ON rm.group_id = g.id
      WHERE g.room_uid IS NOT NULL
      GROUP BY g.id
      ORDER BY last_msg_at DESC NULLS LAST, g.id DESC
    `);
    for (const row of roomRows) {
      const unread = Number(row.unread) || 0;
      totalUnread += unread;
      items.push({
        type: "room",
        id: "room-" + row.group_id,
        groupId: Number(row.group_id),
        roomUid: row.room_uid,
        displayName: row.name || "Room",
        mode: row.mode || "addressed",
        memberCount: Number(row.member_count) || 0,
        lastActivity: row.last_msg_at || null,
        unread,
      });
    }
  } catch {}

  // Sort all items by last activity
  items.sort((a, b) => {
    const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return bTime - aTime;
  });

  return { items, totalUnread };
}

/**
 * Get pending message requests (unknown-sender DMs, L6). Each is a minimal
 * `contacts` row tagged `request_status='pending'` with its stored messages.
 * Returns the newest-first list the "Requests (N)" inbox renders, each with a
 * short display, the latest message as a preview, the message count, and the
 * contact/created timestamps. 'accepted' and full (NULL) contacts are excluded.
 * Never throws.
 */
export async function getMessageRequests(db) {
  try {
    const { rows } = await db.execute(`
      SELECT c.id, c.crow_id, c.display_name, c.created_at,
             COUNT(m.id) AS msg_count,
             MAX(m.created_at) AS last_msg_at,
             (SELECT content FROM messages WHERE contact_id = c.id ORDER BY id DESC LIMIT 1) AS preview
      FROM contacts c
      LEFT JOIN messages m ON m.contact_id = c.id
      WHERE c.request_status = 'pending'
      GROUP BY c.id
      ORDER BY last_msg_at DESC NULLS LAST, c.created_at DESC
    `);
    return rows.map((r) => {
      const crowId = String(r.crow_id || "");
      // `req:<64-hex pubkey>` → a compact `req:<first 10>…`; other ids → prefix.
      let shortId;
      if (crowId.startsWith("req:")) {
        shortId = "req:" + crowId.slice(4, 14) + "…";
      } else {
        shortId = crowId.length > 16 ? crowId.substring(0, 16) + "…" : crowId;
      }
      return {
        id: Number(r.id),
        crowId,
        displayName: r.display_name || shortId,
        shortId,
        preview: r.preview || "",
        msgCount: Number(r.msg_count) || 0,
        createdAt: r.created_at,
        lastMsgAt: r.last_msg_at,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Get peer messages for a specific contact. One query owner for the live
 * route AND the panel (F-UI-6: the route's private copy dropped
 * delivery_status, so receipts vanished on reload).
 *  - afterId > 0: ascending rows with id > afterId (poll/live incremental).
 *  - else: latest window (descending LIMIT/OFFSET), returned oldest-first.
 */
export async function getPeerMessages(db, contactId, { limit = 50, offset = 0, afterId = 0 } = {}) {
  const cols = `m.id, m.content, m.direction, m.is_read, m.created_at,
                m.thread_id, m.nostr_event_id, m.attachments, m.delivery_status,
                c.display_name, c.crow_id, c.last_seen`;
  let rows;
  if (afterId > 0) {
    ({ rows } = await db.execute({
      sql: `SELECT ${cols} FROM messages m
            LEFT JOIN contacts c ON m.contact_id = c.id
            WHERE m.contact_id = ? AND m.id > ?
            ORDER BY m.id ASC
            LIMIT ?`,
      args: [contactId, afterId, limit],
    }));
  } else {
    ({ rows } = await db.execute({
      sql: `SELECT ${cols} FROM messages m
            LEFT JOIN contacts c ON m.contact_id = c.id
            WHERE m.contact_id = ?
            ORDER BY m.id DESC
            LIMIT ? OFFSET ?`,
      args: [contactId, limit, offset],
    }));
    rows = rows.reverse();
  }
  return rows.map((m) => ({
    ...m,
    attachments: m.attachments ? JSON.parse(m.attachments) : null,
  }));
}

/**
 * Lightweight status for polling — unread counts and last activity.
 */
export async function getMessageStatus(db) {
  const { rows: peerRows } = await db.execute(`
    SELECT m.contact_id as contactId,
           SUM(CASE WHEN m.is_read = 0 AND m.direction = 'received' THEN 1 ELSE 0 END) as unread,
           MAX(m.created_at) as lastActivity
    FROM messages m
    GROUP BY m.contact_id
  `);

  const { rows: aiRows } = await db.execute(`
    SELECT id as convId, updated_at as lastActivity
    FROM chat_conversations
    ORDER BY updated_at DESC LIMIT 50
  `);

  return {
    peers: peerRows.map((r) => ({ contactId: r.contactId, unread: Number(r.unread) || 0, lastActivity: r.lastActivity })),
    ai: aiRows.map((r) => ({ convId: r.convId, lastActivity: r.lastActivity })),
  };
}

/**
 * Cross-instance bot directory: all advertised bots across trusted peers,
 * grouped by instance, each marked added/contactId via a pubkey match against
 * contacts (includes blocked — a blocked bot is still "known"). Shows ALL bots
 * (added ones are badged, not hidden). Never throws.
 *
 * `prune` DEFAULTS TO FALSE — garbage collection is opt-in, and only the Messages
 * and Contacts RENDER opts in. This is a real bug fix: the prune used to run as a
 * side effect of every call, so the "Add this bot" path — which reads this directory
 * to resolve *which instance advertised* the bot — would durably DELETE other
 * contacts as a side effect of a click (spec §3 F4 / R3-MAJOR-6). A new caller must
 * ask for GC; it can never inherit it.
 *
 * Returns `{ groups, total, notAddedCount, perInstance }` where
 *   perInstance: Map<instanceId, { ok:boolean, complete:boolean, pubkeys:Set<string> }>
 * carries an entry for EVERY trusted peer queried this cycle — including ones that
 * came back unavailable (`ok:false`), because the prune must distinguish "queried but
 * unavailable" from "never queried". `pubkeys` are trailing-64 lowercase x-only keys.
 */
export async function getBotDirectory(db, { prune = false } = {}) {
  const known = new Map(); // trailing-64 lowercased x-only pubkey -> contact id
  try {
    const { rows } = await db.execute("SELECT id, secp256k1_pubkey FROM contacts WHERE secp256k1_pubkey IS NOT NULL AND request_status IS NULL");
    for (const r of rows) {
      const h = String(r.secp256k1_pubkey || "");
      if (h.length >= 64) known.set(h.slice(-64).toLowerCase(), Number(r.id));
    }
  } catch {}

  let localId = null;
  try { localId = getOrCreateLocalInstanceId(); } catch {}
  let insts = [];
  try { insts = await getTrustedInstances(db); } catch {}
  const peerIds = insts.map((i) => i.id).filter((id) => id && id !== localId);

  const settled = await Promise.allSettled(peerIds.map((id) => getPeerAdvertisedBots(db, id)));
  const seen = new Set();
  const perInstance = new Map();
  const groupsByInst = new Map();
  let total = 0, notAddedCount = 0;
  // Index-match against peerIds: a REJECTED settled entry carries no instanceId, and
  // an absent entry would read to the prune as "never queried" (⇒ fail-safe, but wrong).
  for (let i = 0; i < settled.length; i++) {
    const instanceId = peerIds[i];
    const s = settled[i];
    const v = s.status === "fulfilled" ? s.value : null;
    const ok = !!(v && v.status === "ok" && Array.isArray(v.bots));
    // `complete` is a POSITIVE assertion from both sides. An old peer sends no key ⇒
    // falsy ⇒ this instance is never a licence to delete.
    const complete = ok && v.complete === true;
    const pubkeys = new Set();
    if (ok) for (const b of v.bots) pubkeys.add(b.messaging_pubkey);
    perInstance.set(instanceId, { ok, complete, pubkeys });

    if (!ok) continue;
    for (const b of v.bots) {
      if (seen.has(b.messaging_pubkey)) continue;
      seen.add(b.messaging_pubkey);
      const contactId = known.get(b.messaging_pubkey) ?? null;
      const added = contactId != null;
      total += 1;
      if (!added) notAddedCount += 1;
      const g = groupsByInst.get(b.instance_id) || { instanceId: b.instance_id, instanceLabel: b.instance_label || null, bots: [] };
      g.bots.push({
        botId: b.bot_id,
        displayName: b.display_name,
        description: b.description || null,
        instanceId: b.instance_id,
        instanceLabel: b.instance_label || null,
        messagingPubkey: b.messaging_pubkey,
        inviteCode: b.invite_code,
        added,
        contactId,
      });
      groupsByInst.set(b.instance_id, g);
    }
  }

  if (prune && perInstance.size > 0) {
    try {
      const { getManagersOrNull } = await import("../../../../sharing/managers.js");
      await pruneStaleAdvertisedContacts(db, perInstance, localId, getManagersOrNull());
    } catch {}
  }
  return { groups: Array.from(groupsByInst.values()), total, notAddedCount, perInstance };
}

/**
 * Garbage-collect advertised contacts whose advertiser no longer advertises them.
 *
 * TRIGGER: `contacts.advertised_by_instance_id IS NOT NULL` — the FACT of who
 * advertised the bot, not `origin` (a judgment: view-relative, classified after the
 * row is already on the wire, and no longer trustworthy). NULL provenance — a manual
 * or pasted-invite contact — is structurally never prunable.
 *
 * Prune row R iff ALL FIVE hold:
 *   1. R's advertiser is NOT this instance — the host NEVER prunes its own bot;
 *   2. that advertiser is in `perInstance` (a trusted peer queried this cycle);
 *   3. it answered `ok === true` AND `complete === true` (both: an errored, timed-out,
 *      or silently-truncated list is never a licence to delete);
 *   4. R's x-only pubkey is absent from that advertiser's set AND from every other
 *      ok+complete peer's set (the directory dedups on first-seen pubkey, so a bot
 *      advertised by two instances would otherwise be pruned while still live);
 *   5. R has zero messages (the SQL HAVING) — the prune NEVER destroys history.
 *
 * CONVERGENCE WITHOUT A BROADCAST: the delete is local and emits nothing — it writes
 * only a local tombstone. Every instance paired with advertiser X evaluates this same
 * rule against its own view of X and prunes independently ⇒ "gone on both sides" with
 * no delete on the wire and no host authority. An instance NOT paired with X fails
 * rule 2 and keeps its copy (fail-safe); its later `update` emits are dropped by the
 * pruner's tombstone, so the pruner stays clean either way. Never throws (it runs
 * inside a render).
 *
 * ⚠️ SCOPE OF THAT CLAIM — it holds for a COMPLETE pairing graph, which is what this
 * fleet has. Rule 4's "live elsewhere" clause scans THIS instance's own peer set, so two
 * instances paired with DIFFERENT advertiser sets can legitimately disagree: if A is
 * paired with both X and Y (both advertising bot Z) but C is paired with X only, then
 * when X un-advertises Z, C prunes it and A keeps it (Y still advertises it). That is a
 * divergent steady state — but a FAIL-SAFE one: nobody deletes a bot that some peer they
 * can see still advertises, no history is destroyed (rule 5), and C's tombstone quietly
 * drops A's later `update`s rather than fighting them. Do not read this function as
 * promising convergence under an arbitrary topology; it promises that nobody GCs a
 * contact its own advertiser still vouches for.
 *
 * @param {object} db async db client
 * @param {Map<string, {ok:boolean, complete:boolean, pubkeys:Set<string>}>} perInstance
 * @param {string|null} localInstanceId
 * @param {object|null} managers passed down (never resolved here) — null/partial is fine
 */
export async function pruneStaleAdvertisedContacts(db, perInstance, localInstanceId, managers) {
  try {
    if (!perInstance || perInstance.size === 0) return;
    // Rule 1 is unprovable without our own id: `advertiser === localInstanceId` can
    // never match when localInstanceId is falsy, which would silently DISABLE host
    // protection (getOrCreateLocalInstanceId is guarded at the call site and yields
    // null if it throws). No id ⇒ no prune.
    if (!localInstanceId) {
      console.warn("[prune] local instance id unavailable — cannot prove rule 1 (host never prunes its own bot). Skipping the prune.");
      return;
    }
    // crow_id + lamport_ts are LOAD-BEARING here: the tombstone is keyed on crow_id and
    // written at the row's OWN lamport. writeTombstone no-ops on a falsy crowId and
    // swallows errors, so selecting neither would ship the headline fix as a silent no-op.
    const { rows } = await db.execute(`
      SELECT c.id, c.crow_id, c.lamport_ts, c.secp256k1_pubkey, c.advertised_by_instance_id
      FROM contacts c
      LEFT JOIN messages m ON m.contact_id = c.id
      WHERE c.advertised_by_instance_id IS NOT NULL
      GROUP BY c.id
      HAVING COUNT(m.id) = 0`);

    for (const r of rows) {
      // 1. the host never prunes its own bot.
      const advertiser = r.advertised_by_instance_id;
      if (!advertiser || advertiser === localInstanceId) continue;
      // 2. a trusted peer queried this cycle.
      const entry = perInstance.get(advertiser);
      if (!entry) continue;
      // 3. it answered, and asserted a whole list.
      if (!entry.ok || !entry.complete) continue;
      // 4. absent from its advertiser's set AND from every other ok+complete peer's.
      const h = String(r.secp256k1_pubkey || "");
      const pk = h.length >= 64 ? h.slice(-64).toLowerCase() : "";
      if (!pk) continue; // unidentifiable key ⇒ undecidable ⇒ keep
      if (entry.pubkeys.has(pk)) continue;
      let liveElsewhere = false;
      for (const [instId, e] of perInstance) {
        if (instId === advertiser) continue;
        if (e.ok && e.complete && e.pubkeys.has(pk)) { liveElsewhere = true; break; }
      }
      if (liveElsewhere) continue;
      // 5. zero messages — enforced by the HAVING clause above.

      if (!r.crow_id) {
        console.warn(`[prune] contact ${r.id} has no crow_id — cannot tombstone it, so a delete would be resurrectable. Skipping.`);
        continue;
      }
      const { pruneAdvertisedContact } = await import("../../../../sharing/contact-prune.js");
      await pruneAdvertisedContact(db, managers, {
        id: Number(r.id),
        crow_id: String(r.crow_id),
        lamport_ts: Number(r.lamport_ts) || 0,
      });
    }
  } catch {}
}
