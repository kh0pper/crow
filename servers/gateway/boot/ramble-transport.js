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
 * Phase-1 wire is public-only (D1): `contacts`/`group:` marks stay `pending`
 * forever here — they are still valid local (and instance-synced) rows.
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
  intervalMs = 15000,
  healthMs = 30000,
  precision,
  _derive = deriveBotIdentity,
  shouldPublish,
  autoStart = true,
} = {}) {
  const load = (file) => import(pathToFileURL(join(bundleDir, file)).href);
  const [{ initRambleTables }, { insertRemoteMark }, nostrMap, { resolvePersona }] = await Promise.all([
    load("init-tables.js"),
    load("marks.js"),
    load("nostr-map.js"),
    load("persona.js"),
  ]);
  const { MARK_KIND, CAW_KIND, markToEvent, eventToMark } = nostrMap;

  const prec = precision ?? defaultPrecision();
  // Task 11 swaps in the privacy-grid gate (emitAllowed); until then every
  // public row is publishable.
  const gate = shouldPublish ?? (async () => true);

  // --- Startup: tables (D7 — the gateway must not depend on the stdio child) ---
  const existing = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='ramble_marks' LIMIT 1",
    args: [],
  });
  if (existing.rows.length === 0) await initRambleTables(db);

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
        const template = markToEvent(row, { precision: prec, crowId: persona.crowId });
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

  async function drainOnce() {
    if (stopped || draining) return { published: 0, skipped: 0, failed: 0 };
    draining = true;
    try {
      const result = await drainMarks();
      await drainTombstones();
      return result;
    } catch (err) {
      console.warn("[ramble] drain failed:", err?.message ?? err);
      return { published: 0, skipped: 0, failed: 0 };
    } finally {
      draining = false;
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
      }
    } catch (err) {
      console.warn("[ramble] incoming event dropped:", err?.message ?? err);
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
    closeSubs();
    filter = null;
  }

  return {
    stop,
    drainOnce,
    onEvent,
    currentFilter: () => filter,
    resubscribe,
    sessionId,
    ownAuthors,
  };
}
