/**
 * boot/ramble-transport.js — the Ramble wire, gateway side.
 *
 * Lives in CORE (not in the bundle) for one reason: it must reuse the ONE live
 * `NostrManager` the gateway already owns. A second manager would mean a second
 * set of relay sockets and a second identity surface. The bundle's own modules
 * are imported by PATH (`bundleDir`) so core never hard-depends on a bundle that
 * may not be installed.
 *
 * Two halves:
 *
 *   drain — every `intervalMs` (and on `bus.emit("ramble:drain")`, so in-process
 *   authoring publishes immediately) take up to 50 `pending`/`local`/`public`
 *   rows, resolve the row's persona, map to a Nostr event template, sign it with
 *   `finalizeEvent`, and hand it to `nostrManager.publishRendezvousEvent`. A row
 *   only flips to `published` when at least one relay ACCEPTED it — an
 *   all-relays-down moment leaves it pending for the next tick rather than
 *   silently dropping the mark. Owner-deletes of already-published marks ride
 *   along as NIP-09 kind-5 events read from the `ramble_tombstones` table.
 *
 *   subscribe — `NostrManager` has NO generic subscribe API (D6), so this owns
 *   its own `makeResilientSub` handle per relay plus the periodic
 *   `ensureHealthy()` loop that module's contract requires of its caller.
 *   `onEvent` drops our own echoes (x-only pubkey compare), maps the event back
 *   to a row, and inserts it idempotently.
 *
 * `publish_state` values this module writes: `published` (a relay took it) and
 * `failed` (R15 — the row was attempted MAX_PUBLISH_ATTEMPTS times and never
 * got through; it leaves the pending set so one poison pill cannot occupy a
 * drain slot forever). `failed` is terminal here — nothing in this module ever
 * moves a row back to `pending`; an operator or a later task does.
 *
 * A row with no geohash can never be mapped to an event (`markToEvent` throws),
 * so the drain SQL excludes `geohash IS NULL` outright rather than burning
 * twenty attempts on it.
 *
 * Contacts/group marks, gifts and swaps (phase 3) never touch the public
 * relays: they ride the LOCAL `ramble_outbox` (bundle delivery.js) and this
 * module's `drainDeliveries` turns each row into one NIP-44 DM through the
 * manager's `sendControl` — the same door every other Crow control envelope
 * uses. Inbound, `NostrManager.subscribeToContact` emits `ramble:envelope`
 * on the bus for any decrypted `ramble.*` DM; `onEnvelope` below hands it to
 * the bundle's `receiveEnvelope`. A contacts mark row flips to `published`
 * when its LAST outbox row is gone (accepted, or dropped because the
 * recipient vanished or the mark was deleted first).
 *
 * Replica note: a user's OTHER instance that had meanwhile incubated an egg
 * this instance gifted applies the `gifted` update and is left with zero
 * incubating eggs until its next mint — the phase-2 "convergence beats
 * choice" ruling, one more time. And because all of a user's instances share
 * one Nostr identity, EVERY instance receives every contact envelope and
 * applies it (idempotent); a swap reply is queued by each of them and the
 * counterpart ignores the copies.
 *
 * `local.`-prefixed settings keys are excluded from instance sync by
 * `shouldSyncRow`, which is exactly what we want for the per-boot session id
 * and the active area; `ramble_tombstones` is kept off the wire by simply not
 * being in instance-sync's SYNCED_TABLES allowlist.
 *
 * Nothing in here may throw out of a timer callback or out of `onEvent`; a relay
 * outage must never take the gateway down.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { finalizeEvent } from "nostr-tools/pure";
import { makeResilientSub } from "../../sharing/resilient-subscribe.js";
import { deriveBotIdentity } from "../../sharing/identity.js";

const DRAIN_BATCH = 50;
/** Consecutive failed publish attempts after which a row is parked as `failed` (R15). */
const MAX_PUBLISH_ATTEMPTS = 20;
// A tick pages past gate-skipped mark rows so an open audience behind a
// closed one still goes out; bounded so a huge closed backlog cannot make
// one tick unbounded.
const MAX_DELIVERY_PAGES = 4;

/** Publish precision for caw geohashes; env-overridable, clamped to 1..12. */
function defaultPrecision() {
  const n = Number(process.env.RAMBLE_DEFAULT_GEOHASH_PRECISION);
  if (!Number.isFinite(n)) return 5;
  return Math.min(12, Math.max(1, Math.floor(n)));
}

export async function startRambleTransport({
  db,
  nostrManager,
  identity,
  seed,
  bus,
  bundleDir,
  emit = () => {},
  intervalMs = 15000,
  healthMs = 30000,
  precision,
  _derive = deriveBotIdentity,
  shouldPublish,
  autoStart = true,
} = {}) {
  const load = (file) => import(pathToFileURL(join(bundleDir, file)).href);
  const [{ initRambleTables }, { insertRemoteMark, expireMarks }, nostrMap, { resolvePersona, xOnly }, { makePublishGate }, { activeBird }, { feedAll }] = await Promise.all([
    load("init-tables.js"),
    load("marks.js"),
    load("nostr-map.js"),
    load("persona.js"),
    load("grid.js"),
    load("eggs.js"),
    load("feed.js"),
  ]);
  const { MARK_KIND, CAW_KIND, markToEvent, eventToMark } = nostrMap;

  // Phase 3 modules are loaded in their own guarded step: an installed bundle
  // copy that predates 0.4.0 (the refresh happens at boot, but a gateway
  // restarted before it) must degrade to "no contacts delivery", never to
  // "no ramble" — the public drain, the TTL sweep and the tombstones stay up.
  let phase3 = null;
  try {
    const [delivery, trades] = await Promise.all([load("delivery.js"), load("trades.js")]);
    phase3 = { ...delivery, expireTrades: trades.expireTrades, receiveEnvelope: trades.receiveEnvelope };
  } catch (err) {
    console.warn(`[ramble] contacts delivery DISABLED: bundle copy predates 0.4.0 (${err?.message ?? err}) — restart this gateway after the bundle refresh`);
  }

  const prec = precision ?? defaultPrecision();
  // Default gate is the privacy grid (Task 11): a row is publishable only
  // when the master "I'm visible" switch AND its (audience, geo) cell are
  // both on. An explicit `shouldPublish` (tests, or a future caller) wins.
  const gate = shouldPublish ?? makePublishGate(db);

  // --- Startup: tables (D7 — the gateway must not depend on the stdio child) ---
  // Unconditional: `initRambleTables` is idempotent (every statement is
  // IF NOT EXISTS), and a `ramble_marks`-only probe would skip creating a
  // table added to the schema after that first one existed.
  await initRambleTables(db);

  async function getSetting(key) {
    const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key] });
    return rows[0]?.value ?? null;
  }
  async function setSetting(key, value) {
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [key, value],
    });
  }

  // --- Startup: the per-boot session id ---
  // The rotating caw key is derived from this id. The stdio MCP process reads
  // the same setting (bundles/ramble/server/server.js) so both processes sign
  // caws with the SAME key instead of minting two personas per boot (R11).
  const sessionId = randomUUID();
  await setSetting("local.session_id", sessionId);

  // --- Startup: our own personas, for own-echo suppression (C4) ---
  const ownAuthors = new Set();
  for (const opts of [
    { level: "real", kind: "mark" },
    { level: "pseudonym", kind: "mark" },
    { level: "rotating", kind: "mark" },
    { level: "rotating", kind: "caw" },
  ]) {
    try {
      ownAuthors.add(resolvePersona(identity, seed, { ...opts, sessionId, _derive }).author);
    } catch (err) {
      console.warn(`[ramble] could not resolve ${opts.level}/${opts.kind} persona:`, err?.message ?? err);
    }
  }

  async function publicIdentityLevel() {
    return (await getSetting("public_identity_level")) ?? "rotating";
  }

  // ------------------------------------------------------------------ drain

  const retries = new Map(); // mark_id -> consecutive failed publish attempts
  let draining = false;
  // Set by stop(). Every async section re-checks it after an await so a
  // teardown that races an in-flight drain or subscribe wins.
  let stopped = false;

  /**
   * Count one failed attempt for a row and, at MAX_PUBLISH_ATTEMPTS, park it as
   * `failed` so it leaves the pending set (R15). Without this the counter was
   * write-only and a permanently unpublishable row would occupy a drain slot
   * on every tick forever.
   */
  async function noteFailure(mark_id, reason) {
    const attempts = (retries.get(mark_id) ?? 0) + 1;
    // Log the cause once, on the first failure — a row that fails on every
    // tick for twenty ticks must not print twenty identical lines.
    if (attempts === 1) console.warn(`[ramble] publish failed for mark ${mark_id}: ${reason} (will retry)`);
    if (attempts < MAX_PUBLISH_ATTEMPTS) {
      retries.set(mark_id, attempts);
      return;
    }
    retries.delete(mark_id);
    try {
      await db.execute({
        sql: "UPDATE ramble_marks SET publish_state='failed' WHERE mark_id=?",
        args: [mark_id],
      });
      // Once, at the moment of giving up — not on every attempt.
      console.warn(`[ramble] mark ${mark_id} gave up after ${MAX_PUBLISH_ATTEMPTS} publish attempts (publish_state=failed)`);
    } catch (err) {
      console.warn(`[ramble] could not park mark ${mark_id} as failed:`, err?.message ?? err);
    }
  }

  async function drainMarks() {
    let publishedCount = 0;
    let skipped = 0;
    let failed = 0;

    // `geohash IS NULL` rows can never be mapped to an event — exclude them at
    // the source rather than retrying them twenty times (R15).
    const { rows } = await db.execute({
      sql: `SELECT * FROM ramble_marks
            WHERE publish_state = 'pending' AND origin = 'local' AND visibility = 'public'
              AND geohash IS NOT NULL
            ORDER BY id LIMIT ?`,
      args: [DRAIN_BATCH],
    });
    if (rows.length === 0) return { published: 0, skipped: 0, failed: 0 };

    const level = await publicIdentityLevel();
    // Resolved ONCE per drain (not per row): the active bird can't change
    // mid-tick, and every row published this tick should ride the same
    // bird rather than each doing its own db round trip.
    const bird = await activeBird(db);

    for (const row of rows) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (!(await gate(row))) { skipped++; continue; }

        const persona = resolvePersona(identity, seed, {
          level: row.author_level ?? level,
          kind: row.kind,
          sessionId,
          _derive,
        });
        const template = markToEvent(row, { precision: prec, crowId: persona.crowId, bird });
        const event = finalizeEvent(template, persona.secp256k1Priv);
        // eslint-disable-next-line no-await-in-loop
        const accepted = await nostrManager.publishRendezvousEvent(event);

        if (!accepted || accepted.length === 0) {
          // No relay took it. Leave the row pending so the next tick retries
          // rather than marking a mark published that nobody has.
          // eslint-disable-next-line no-await-in-loop
          await noteFailure(row.mark_id, "no relay accepted the event");
          failed++;
          continue;
        }

        // The signed event's pubkey is authoritative for attribution: if the
        // row was written with a different persona than the one that ended up
        // signing, the stored author would be a lie. Rewrite it (safety net).
        if (row.author !== event.pubkey) {
          // eslint-disable-next-line no-await-in-loop
          await db.execute({
            sql: "UPDATE ramble_marks SET publish_state='published', nostr_event_id=?, author=? WHERE mark_id=?",
            args: [event.id, event.pubkey, row.mark_id],
          });
        } else {
          // eslint-disable-next-line no-await-in-loop
          await db.execute({
            sql: "UPDATE ramble_marks SET publish_state='published', nostr_event_id=? WHERE mark_id=?",
            args: [event.id, row.mark_id],
          });
        }
        retries.delete(row.mark_id);
        publishedCount++;
      } catch (err) {
        if (err?.name === "RambleNotPublic") { skipped++; continue; }
        // eslint-disable-next-line no-await-in-loop
        await noteFailure(row.mark_id, err?.message ?? String(err));
        failed++;
      }
    }
    return { published: publishedCount, skipped, failed };
  }

  /**
   * NIP-09 deletes for already-published public marks. Task 12 INSERTs a
   * `ramble_tombstones` row on owner-delete; the row is DELETEd here only once
   * a relay accepted the kind-5 event, so a relay outage retries next tick.
   * A table rather than a JSON list in `ramble_settings` because two writers
   * (the drain and the authoring path) read-modify-writing one blob lose each
   * other's entries (R14). Expiry needs no deletion event — relays honor
   * NIP-40 `expiration`.
   */
  async function drainTombstones() {
    const { rows } = await db.execute({
      sql: "SELECT * FROM ramble_tombstones ORDER BY created_at LIMIT ?",
      args: [DRAIN_BATCH],
    });
    if (rows.length === 0) return;

    const level = await publicIdentityLevel();
    for (const entry of rows) {
      try {
        const persona = resolvePersona(identity, seed, {
          level: entry.author_level ?? level,
          kind: entry.kind ?? "mark",
          sessionId,
          _derive,
        });
        const event = finalizeEvent({
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["e", entry.nostr_event_id]],
          content: "",
        }, persona.secp256k1Priv);
        // eslint-disable-next-line no-await-in-loop
        const accepted = await nostrManager.publishRendezvousEvent(event);
        if (accepted && accepted.length > 0) {
          // eslint-disable-next-line no-await-in-loop
          await db.execute({
            sql: "DELETE FROM ramble_tombstones WHERE nostr_event_id = ?",
            args: [entry.nostr_event_id],
          });
        }
      } catch (err) {
        console.warn(`[ramble] tombstone publish failed for ${entry.nostr_event_id}:`, err?.message ?? err);
      }
    }
  }

  /**
   * Phase 3: the contacts wire. One outbox row = one `sendControl` DM. A MARK
   * row is gated by the privacy grid for its audience (re-read every tick,
   * like public marks) and skipped — left queued — while the cell is off; it
   * is dropped if the mark was deleted meanwhile. Gifts and trades are
   * explicit directed sends and are never gated. A recipient that is no
   * longer a deliverable contact drops the row; a relay refusal counts an
   * attempt and parks the row at MAX_DELIVERY_ATTEMPTS (R15). When a mark's
   * last row leaves the queue the mark flips to `published`.
   */
  let warnedNoSendControl = false;
  async function drainDeliveries() {
    if (!phase3) return 0;
    if (typeof nostrManager.sendControl !== "function") {
      if (!warnedNoSendControl) { warnedNoSendControl = true; console.warn("[ramble] nostrManager has no sendControl; contacts delivery disabled"); }
      return 0;
    }
    // The grid is read once per visibility per tick, not once per row (the
    // gate re-reads ~11 settings rows each call).
    const gateCache = new Map();
    const allowed = async (visibility) => {
      if (!gateCache.has(visibility)) gateCache.set(visibility, await gate({ visibility }));
      return gateCache.get(visibility);
    };
    let delivered = 0;
    const seen = [];
    for (let page = 0; page < MAX_DELIVERY_PAGES; page++) {
      if (stopped) break;
      // Gifts/trades first, marks after (pendingDeliveries orders them —
      // C1), so gated mark rows can never fill the batch and starve a swap
      // reply. `excludeIds` skips past rows already looked at THIS tick so a
      // batch of gate-skipped `contacts` marks cannot also crowd out a
      // `group:` mark row (a different, currently-open audience) behind them.
      // eslint-disable-next-line no-await-in-loop
      const rows = await phase3.pendingDeliveries(db, DRAIN_BATCH, { excludeIds: seen });
      if (rows.length === 0) break;
      let skippedGated = 0;
      for (const d of rows) {
        if (stopped) break;
        seen.push(d.id);
        try {
          if (d.kind === "mark") {
            // eslint-disable-next-line no-await-in-loop
            const { rows: m } = await db.execute({ sql: "SELECT visibility FROM ramble_marks WHERE mark_id = ?", args: [d.ref_id] });
            // eslint-disable-next-line no-await-in-loop
            if (!m[0]) { await phase3.deleteDelivery(db, d.id); await settleMark(d.ref_id); continue; }
            // eslint-disable-next-line no-await-in-loop
            if (!(await allowed(m[0].visibility))) { skippedGated++; continue; }
          }
          // eslint-disable-next-line no-await-in-loop
          const contact = await phase3.resolveContact(db, d.to_crow_id);
          if (!contact) {
            console.warn(`[ramble] dropping ${d.kind} delivery to ${d.to_crow_id}: not a deliverable contact`);
            // eslint-disable-next-line no-await-in-loop
            await phase3.deleteDelivery(db, d.id);
            // eslint-disable-next-line no-await-in-loop
            if (d.kind === "mark") await settleMark(d.ref_id);
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          const out = await nostrManager.sendControl(contact, d.payload_json);
          if (!out || !Array.isArray(out.relays) || out.relays.length === 0) {
            // eslint-disable-next-line no-await-in-loop
            const { parked } = await phase3.noteDeliveryFailure(db, d, phase3.MAX_DELIVERY_ATTEMPTS);
            if (parked) console.warn(`[ramble] ${d.kind} delivery to ${d.to_crow_id} gave up after ${phase3.MAX_DELIVERY_ATTEMPTS} attempts`);
            // eslint-disable-next-line no-await-in-loop
            if (parked && d.kind === "mark") await settleMark(d.ref_id);
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          await phase3.deleteDelivery(db, d.id);
          delivered++;
          // eslint-disable-next-line no-await-in-loop
          if (d.kind === "mark") await settleMark(d.ref_id);
        } catch (err) {
          console.warn(`[ramble] ${d.kind} delivery to ${d.to_crow_id} failed:`, err?.message ?? err);
          // eslint-disable-next-line no-await-in-loop
          const r = await phase3.noteDeliveryFailure(db, d, phase3.MAX_DELIVERY_ATTEMPTS).catch(() => null);
          // eslint-disable-next-line no-await-in-loop
          if (r?.parked && d.kind === "mark") await settleMark(d.ref_id).catch(() => {});
        }
      }
      if (skippedGated === 0 || rows.length < DRAIN_BATCH) break;
    }
    return delivered;
  }

  /** A contacts mark is 'published' once no outbox row for it remains. */
  async function settleMark(markId) {
    if ((await phase3.remainingDeliveries(db, "mark", markId)) > 0) return;
    await db.execute({
      sql: "UPDATE ramble_marks SET publish_state = 'published' WHERE mark_id = ? AND publish_state = 'pending'",
      args: [markId],
    });
  }

  // A drain requested WHILE one is running (a swap reply queued mid-tick)
  // runs again right after, instead of waiting a full interval (S3).
  let redrain = false;
  async function drainOnce() {
    if (stopped) return { published: 0, skipped: 0, failed: 0, expired: 0, delivered: 0 };
    if (draining) { redrain = true; return { published: 0, skipped: 0, failed: 0, expired: 0, delivered: 0 }; }
    draining = true;
    let expired = 0;
    let delivered = 0;
    try {
      // R19: the TTL sweep has no scheduler of its own — it rides this tick.
      // It runs BEFORE the publish pass so an already-expired row is swept
      // rather than put on the wire, and its deletes ride the sync emit hook
      // so peers drop the row too.
      expired = await expireMarks(db, Date.now(), { emit });
      const result = await drainMarks();
      await drainTombstones();
      // Phase 3: lapsed swap offers unlock their eggs on both sides by local
      // clock, then the contacts wire goes out.
      if (phase3) await phase3.expireTrades(db, Date.now(), { emit });
      delivered = await drainDeliveries();
      return { ...result, expired, delivered };
    } catch (err) {
      console.warn("[ramble] drain failed:", err?.message ?? err);
      return { published: 0, skipped: 0, failed: 0, expired, delivered };
    } finally {
      draining = false;
      if (redrain && !stopped) { redrain = false; void drainOnce().catch(() => {}); }
    }
  }

  // -------------------------------------------------------------- subscribe

  let subs = [];
  let filter = null;

  function closeSubs() {
    for (const sub of subs) { try { sub.close(); } catch { /* already gone */ } }
    subs = [];
  }

  /** Never throws; never rejects. Called from a relay callback. */
  async function onEvent(event) {
    try {
      if (!event || typeof event !== "object") return;
      if (ownAuthors.has(event.pubkey)) return; // own echo (C4)
      const row = eventToMark(event);
      if (!row) return;
      const result = await insertRemoteMark(db, row);
      if (result?.inserted) {
        try {
          bus.emit("ramble:nearby", {
            geohash: row.geohash,
            mark_id: result.row?.mark_id ?? row.mark_id,
            kind: row.kind,
          });
        } catch (emitErr) {
          console.warn("[ramble] ramble:nearby subscriber threw:", emitErr?.message ?? emitErr);
        }

        // Meeting a nearby crow credits warmth toward the egg (best-effort:
        // a feed/credit failure must never make an otherwise-successful
        // receipt look like it failed).
        try {
          await feedAll(db, { type: "meet_crow", persona: event.pubkey }, {
            emit,
            onHatch: (egg) => {
              try {
                bus.emit("ramble:hatched", { egg_id: egg.egg_id, species: egg.species, seed: egg.seed });
              } catch (hatchErr) {
                console.warn("[ramble] ramble:hatched subscriber threw:", hatchErr?.message ?? hatchErr);
              }
            },
          });
        } catch (feedErr) {
          console.warn("[ramble] meet_crow feed failed:", feedErr?.message ?? feedErr);
        }
      }
    } catch (err) {
      console.warn("[ramble] incoming event dropped:", err?.message ?? err);
    }
  }

  /**
   * Phase 3 inbound: one decrypted `ramble.*` DM from a contact, as emitted
   * by NostrManager.subscribeToContact. Never throws; never rejects.
   */
  // NostrManager registers one onevent PER RELAY, so one DM can arrive up to
  // relays.size times with the same event id; the copies interleave across
  // awaits and would each run receiveTrade (C5). Bounded dedup by event id.
  const seenEnvelopes = new Set();
  const SEEN_ENVELOPES_MAX = 1000;
  async function onEnvelope(msg) {
    try {
      if (stopped || !msg || typeof msg !== "object" || !msg.payload) return;
      if (!phase3) return;
      if (msg.eventId != null) {
        const key = String(msg.eventId);
        if (seenEnvelopes.has(key)) return;
        seenEnvelopes.add(key);
        if (seenEnvelopes.size > SEEN_ENVELOPES_MAX) seenEnvelopes.delete(seenEnvelopes.values().next().value);
      }
      const result = await phase3.receiveEnvelope(db, msg, { now: Date.now(), emit });
      if (!result) return;
      if (result.kind === "mark" && result.inserted) {
        try {
          bus.emit("ramble:nearby", { geohash: result.geohash, mark_id: result.mark_id, kind: result.markKind });
        } catch (emitErr) {
          console.warn("[ramble] ramble:nearby subscriber threw:", emitErr?.message ?? emitErr);
        }
        try {
          await feedAll(db, { type: "meet_crow", persona: xOnly(String(msg.pubkey)) }, {
            emit,
            onHatch: (egg) => {
              try { bus.emit("ramble:hatched", { egg_id: egg.egg_id, species: egg.species, seed: egg.seed }); }
              catch (hatchErr) { console.warn("[ramble] ramble:hatched subscriber threw:", hatchErr?.message ?? hatchErr); }
            },
          });
        } catch (feedErr) {
          console.warn("[ramble] meet_crow feed failed:", feedErr?.message ?? feedErr);
        }
        return;
      }
      if (result.kind === "egg" && result.inserted) {
        try { bus.emit("ramble:trade", { kind: "gift", trade_id: null, egg_id: result.egg_id, state: "received" }); }
        catch (e) { console.warn("[ramble] ramble:trade subscriber threw:", e?.message ?? e); }
        return;
      }
      if (result.kind === "trade") {
        if (result.changed) {
          try { bus.emit("ramble:trade", { kind: "trade", trade_id: result.trade_id, egg_id: result.egg_id ?? null, state: result.state }); }
          catch (e) { console.warn("[ramble] ramble:trade subscriber threw:", e?.message ?? e); }
        }
        // A reply (completed / declined) was queued: send it now, not next tick.
        if (result.deliveries > 0) void drainOnce().catch(() => {});
      }
    } catch (err) {
      console.warn("[ramble] incoming envelope dropped:", err?.message ?? err);
    }
  }

  async function activeCells() {
    const raw = await getSetting("local.active_area");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string" && c.length > 0) : [];
    } catch {
      return [];
    }
  }

  async function doResubscribe() {
    closeSubs();
    if (stopped) { filter = null; return; }
    const cells = await activeCells();
    if (stopped || cells.length === 0) { filter = null; return; }
    const nextFilter = { kinds: [MARK_KIND, CAW_KIND], "#g": cells };

    try {
      if (nostrManager.relays.size === 0) await nostrManager.connectRelays();
    } catch (err) {
      // A relay outage must not throw out of startup — the health loop retries.
      console.warn("[ramble] relay connect failed:", err?.message ?? err);
    }
    // Build into a local list: stop() may have fired while we awaited the relay
    // dial, and handles adopted after teardown would never be closed.
    const built = [];
    for (const relay of nostrManager.relays.values()) {
      try {
        built.push(makeResilientSub(relay, nextFilter, onEvent));
      } catch (err) {
        console.warn("[ramble] subscribe failed:", err?.message ?? err);
      }
    }
    if (stopped) {
      for (const sub of built) { try { sub.close(); } catch { /* already gone */ } }
      filter = null;
      return;
    }
    subs = built;
    filter = nextFilter;
  }

  // Serialize resubscribes: two overlapping runs would close each other's
  // freshly-made handles. The chain never rejects.
  let chain = Promise.resolve();
  function resubscribe() {
    chain = chain.then(doResubscribe, doResubscribe)
      .catch((err) => { console.warn("[ramble] resubscribe failed:", err?.message ?? err); });
    return chain;
  }

  // Fire-and-forget: the first subscribe may dial relays, and awaiting it here
  // would put a network round-trip in front of the gateway's listen(). The
  // chain is ordered, so a later resubscribe() still runs after this one, and
  // `stopped` makes a stop() that beats it to the punch a no-op.
  void resubscribe();

  // ------------------------------------------------------------------ wiring

  const onDrainRequested = () => { drainOnce().catch(() => {}); };
  const onAreaChanged = () => { resubscribe().catch(() => {}); };
  bus.on("ramble:drain", onDrainRequested);
  bus.on("ramble:area", onAreaChanged);
  bus.on("ramble:envelope", onEnvelope);

  let drainTimer = null;
  let healthTimer = null;
  if (autoStart) {
    drainTimer = setInterval(onDrainRequested, intervalMs);
    drainTimer.unref?.();
    healthTimer = setInterval(() => {
      for (const sub of subs) {
        try {
          Promise.resolve(sub.ensureHealthy()).catch((err) => {
            console.warn("[ramble] sub health check failed:", err?.message ?? err);
          });
        } catch (err) {
          console.warn("[ramble] sub health check threw:", err?.message ?? err);
        }
      }
    }, healthMs);
    healthTimer.unref?.();
  }

  function stop() {
    stopped = true;
    if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    bus.off("ramble:drain", onDrainRequested);
    bus.off("ramble:area", onAreaChanged);
    bus.off("ramble:envelope", onEnvelope);
    closeSubs();
    filter = null;
  }

  return {
    stop,
    drainOnce,
    onEvent,
    onEnvelope,
    currentFilter: () => filter,
    resubscribe,
    sessionId,
    ownAuthors,
  };
}
