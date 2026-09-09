/**
 * Ramble MCP server. Milestone 1 (M1) tools — local core, no network/UI:
 *   ramble_leave_mark, ramble_caw, ramble_query_world, ramble_unlock,
 *   ramble_pet_state, ramble_block, ramble_unblock, ramble_egg_state,
 *   ramble_checkin, ramble_chore, ramble_flock, ramble_nests, ramble_claim_nest,
 *   ramble_gift_egg, ramble_propose_swap.
 *
 * Phase 3: contacts/group marks, gifts and swaps are queued into
 * `ramble_outbox` here and SENT by the gateway transport on its next tick
 * (this stdio process has no relay socket and no bus, so there is no
 * immediate poke — up to 15 s). Group audiences are the core contact groups
 * (`group:<group_uid>`); the phase-1 `ramble_groups` table is unused.
 *
 * Identity seam (review round 3, D8): options.identity/seed/_derive are
 * injectable (tests inject all three so no identity files are generated).
 * When absent, resolved lazily on first tool call from
 * servers/sharing/identity.js so the factory itself stays synchronous.
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appImport } from "./app-root.js";
import { resolveDataDir } from "./db.js";
import { resolvePersona } from "./persona.js";
import { createMark, listMarks, unlockMark, blockPersona, unblockPersona } from "./marks.js";
import { encodeGeohash } from "./anchors.js";
import { getGrid } from "./grid.js";
import { petState, doChore } from "./pet.js";
import { heartsBalance } from "./hearts.js";
import { eggState, activeBird, isoWeek, layProgress, nextPromotable } from "./eggs.js";
import { feedAll } from "./feed.js";
import { flockState, listNests, claimNest } from "./flock.js";
import { resolveContact, resolveAudience, enqueueMark, contactsByPubkey, CROW_ID_RE, ID_RE } from "./delivery.js";
import { labelFor } from "./labels.js";
import { giftEgg, proposeSwap } from "./trades.js";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const errorText = (t) => ({ content: [{ type: "text", text: t }], isError: true });

// `private` ("Just me") is a real audience, not network-facing: the
// transport drain only ever selects visibility='public' rows and
// markToEvent() throws RambleNotPublic for anything else, so a private mark
// can never reach a relay. shouldSyncRow('ramble_marks') is deliberately
// left unchanged — private marks DO still replicate to the author's own
// other instances via the instance-sync outbox; that's the point of "just
// me" (me, everywhere), not "just this device".
const VISIBILITY_RE = /^(public|contacts|private|group:.+)$/;

export function createRambleServer(db, options = {}) {
  const server = new McpServer(
    { name: "crow-ramble", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: options.instructions },
  );

  // Identity seam: resolved lazily (once) on first tool call so the factory
  // stays synchronous and tests that inject identity/seed/_derive never
  // touch real identity files. Memoize the IN-FLIGHT PROMISE, not the
  // resolved value: two concurrent first tool calls both read `identityState`
  // before either write lands, so a value-memo lets both calls run the
  // loader (and mint two different sessionIds). Promise-memoizing closes
  // that race — the second caller awaits the first caller's in-flight
  // promise instead of starting its own. Reset to null on rejection so a
  // transient failure (e.g. identity file not yet written) can retry.
  let identityPromise = null;
  function getIdentityState() {
    identityPromise ??= (async () => {
      let { identity, seed, _derive } = options;
      if (!identity || !seed || !_derive) {
        const mod = await appImport("servers/sharing/identity.js");
        if (!identity) identity = mod.loadOrCreateIdentity();
        if (!seed) seed = mod.loadInstanceSeed(resolveDataDir());
        if (!_derive) _derive = mod.deriveBotIdentity;
      }
      // The memoized sessionId is only the FALLBACK for when no gateway has
      // written one — see storedSessionId()/personaFor() below.
      return { identity, seed, _derive, sessionId: randomUUID() };
    })().catch((err) => { identityPromise = null; throw err; });
    return identityPromise;
  }

  // Sync emit seam: options.emit, else lazily built (promise-memoized for
  // the same reason as identity above) to queue via emitOrQueue (the stdio
  // process has no live sync manager).
  let emitPromise = options.emit ? Promise.resolve(options.emit) : null;
  function getEmit() {
    emitPromise ??= appImport("servers/shared/sync-emit.js")
      .then(({ emitOrQueue }) => (table, op, row) => emitOrQueue(null, db, table, op, row).catch(() => {}))
      .catch((err) => { emitPromise = null; throw err; });
    return emitPromise;
  }

  async function getPublicIdentityLevel() {
    return (await getGrid(db)).identityLevel;
  }

  /**
   * R11: the gateway transport mints the per-boot session id and records it at
   * `ramble_settings` key `local.session_id` (a `local.`-prefixed key, so
   * instance sync never carries it). Reading it makes this stdio process and
   * the gateway derive the SAME rotating-caw key instead of two personas.
   * Returns null when there is no gateway (bundle standalone, or tests).
   */
  async function storedSessionId() {
    try {
      const { rows } = await db.execute({
        sql: "SELECT value FROM ramble_settings WHERE key = 'local.session_id'",
        args: [],
      });
      return rows[0]?.value ?? null;
    } catch {
      return null; // table not there yet
    }
  }

  async function personaFor(kind) {
    const { identity, seed, _derive, sessionId } = await getIdentityState();
    const level = await getPublicIdentityLevel();
    // The session id is the ONLY input that changes under this long-lived
    // stdio process: a gateway restart mints a new one. Memoizing it would pin
    // caws to a session key the gateway has already rotated away from, so read
    // it fresh per call — but only where it is actually used (rotating caws).
    // identity/seed/_derive stay memoized.
    let effectiveSessionId = sessionId;
    if (kind === "caw" && level === "rotating") {
      effectiveSessionId = (await storedSessionId()) || sessionId;
    }
    return resolvePersona(identity, seed, { level, kind, sessionId: effectiveSessionId, _derive });
  }

  function checkVisibility(visibility) {
    if (!VISIBILITY_RE.test(visibility)) {
      throw new Error(`invalid visibility: ${visibility}`);
    }
  }

  function register(name, description, shape, handler) {
    server.tool(name, description, shape, handler);
    if (options._exposeHandlers) options._exposeHandlers[name] = handler;
  }

  register(
    "ramble_leave_mark",
    "Leave a proximity mark (a note, photo reference, or other content) at a geographic location for others to discover nearby.",
    {
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      accuracy_m: z.number().min(0).max(100000).optional(),
      text: z.string().max(2000),
      visibility: z.string().max(128).optional(),
      reveal: z.string().max(64).optional(),
      content_kind: z.string().max(64).optional(),
      content_ref: z.string().max(1024).optional(),
      ttl_seconds: z.number().int().min(0).optional(),
    },
    async ({ lat, lon, accuracy_m, text: markText, visibility = "public", reveal, content_kind = "none", content_ref, ttl_seconds }) => {
      try {
        checkVisibility(visibility);
        // Phase 3: an audience that cannot be resolved is refused BEFORE a row exists.
        if (visibility.startsWith("group:")) {
          let a = null;
          try { a = await resolveAudience(db, visibility); } catch { a = null; }
          if (!a || !a.ok) return errorText(`unknown group: ${visibility.slice(6)}`);
        }
        const persona = await personaFor("mark");
        const emit = await getEmit();
        const bird = await activeBird(db);
        const row = await createMark(
          db,
          {
            author: persona.author,
            author_level: persona.author_level,
            kind: "mark",
            anchor: { anchor_kind: "geo", lat, lon, accuracy_m },
            visibility,
            reveal,
            content: { content_text: markText, content_kind, content_ref },
            ttlSeconds: ttl_seconds,
            bird,
          },
          { emit },
        );
        let recipients;
        if (visibility === "contacts" || visibility.startsWith("group:")) {
          try { recipients = (await enqueueMark(db, row, { bird, now: Date.now() })).recipients; }
          catch (err) { console.warn("[ramble] enqueueMark failed:", err?.message ?? err); recipients = 0; }
        }
        // Best-effort: a pet/egg-feed failure must never fail a mark.
        try { await feedAll(db, { type: "mark_left" }, { emit }); } catch { /* cosmetic */ }
        return text(JSON.stringify({
          mark_id: row.mark_id,
          geohash: row.geohash,
          expires_at: row.expires_at,
          author: row.author,
          author_level: row.author_level,
          publish_state: row.publish_state,
          ...(recipients === undefined ? {} : { recipients }),
        }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_caw",
    "Broadcast a short-lived, public presence marker (a 'caw') at your current location. Always public, always open (no unlock needed).",
    {
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      text: z.string().max(2000),
      ttl_seconds: z.number().int().min(0).optional(),
    },
    async ({ lat, lon, text: cawText, ttl_seconds }) => {
      try {
        const persona = await personaFor("caw");
        const emit = await getEmit();
        const row = await createMark(
          db,
          {
            author: persona.author,
            author_level: persona.author_level,
            kind: "caw",
            anchor: { anchor_kind: "geo", lat, lon },
            visibility: "public",
            reveal: "open",
            content: { content_text: cawText, content_kind: "none" },
            ttlSeconds: ttl_seconds,
          },
          { emit },
        );
        return text(JSON.stringify({
          mark_id: row.mark_id,
          geohash: row.geohash,
          expires_at: row.expires_at,
          author: row.author,
          author_level: row.author_level,
          publish_state: row.publish_state,
        }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_query_world",
    "List nearby marks and caws within the geohash cell containing the given location. Each row carries a label (\"your mark\", \"mark by <contact>\", \"mark by <world name> · <key4>\", or \"mark by <key8>\").",
    {
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      visibility: z.string().max(128).optional(),
      precision: z.number().int().min(1).max(12).optional(),
    },
    async ({ lat, lon, visibility = "public", precision }) => {
      try {
        checkVisibility(visibility);
        const envPrecision = Number(process.env.RAMBLE_DEFAULT_GEOHASH_PRECISION);
        const clampedEnvPrecision = Number.isInteger(envPrecision) && envPrecision >= 1 && envPrecision <= 12 ? envPrecision : 5;
        const p = precision ?? clampedEnvPrecision;
        const cell = encodeGeohash(lat, lon, p);
        const rows = await listMarks(db, { visibility, geohashPrefix: cell });
        const byPubkey = await contactsByPubkey(db);
        const marks = rows.map((m) => {
          const c = m.origin === "remote" ? byPubkey.get(String(m.author)) : null;
          return { ...m, label: labelFor(m, { contactName: c ? c.name : null }) };
        });
        return text(JSON.stringify({ cell, marks }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_unlock",
    "Attempt to unlock a locked mark's content by proving proximity to its anchor.",
    {
      mark_id: z.string().max(128),
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    },
    async ({ mark_id, lat, lon }) => {
      try {
        const result = await unlockMark(db, mark_id, { lat, lon });
        if (result.unlocked === true) {
          // Best-effort: a pet/egg-feed failure must never fail an unlock.
          try {
            const emit = await getEmit();
            await feedAll(db, { type: "unlock_mark" }, { emit });
          } catch { /* cosmetic */ }
        }
        return text(JSON.stringify(result));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_pet_state",
    "Get the Ramble companion pet's current state (mood, energy, weekly activity counters, active bird, and egg progress).",
    {},
    async () => {
      try {
        const [state, bird, egg] = await Promise.all([petState(db), activeBird(db), eggState(db, { now: Date.now() })]);
        // Task 2 (spec 2026-09-08 §4.1): no egg is a valid state — a read
        // must not throw for it, so an absent egg is reported as `null`, not
        // dereferenced.
        return text(JSON.stringify({
          ...state, bird, hearts: await heartsBalance(db),
          egg: egg.egg ?? null,
          lay: await layProgress(db),
          shelf_waiting: (await nextPromotable(db))?.egg_id ?? null,
        }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_egg_state",
    "Get the current incubating egg's warmth progress and checklist toward hatching.",
    {},
    async () => {
      try {
        const state = await eggState(db, { now: Date.now() });
        // `lay` matches GET /api/ramble/egg. NOT `shelf_waiting` here — that
        // affordance belongs to ramble_pet_state / GET /api/ramble/pet only.
        return text(JSON.stringify({ ...state, lay: await layProgress(db) }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_checkin",
    "Record today's check-in, crediting warmth toward the incubating egg (once per local day).",
    {},
    async () => {
      try {
        const emit = await getEmit();
        return text(JSON.stringify(await feedAll(db, { type: "checkin" }, { emit })));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_chore",
    "Complete a daily chore (feed, preen, or play) for the companion pet. Each kind completes once per local day.",
    { kind: z.enum(["feed", "preen", "play"]) },
    async ({ kind }) => {
      try {
        const emit = await getEmit();
        return text(JSON.stringify(await doChore(db, kind, { emit })));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_flock",
    "Your flock: hatched birds (the active one marked), the egg shelf and the incubating egg, and how many of the 8 species you have found.",
    {},
    async () => {
      try { return text(JSON.stringify(await flockState(db, { now: Date.now() }))); }
      catch (err) { return errorText(err.message); }
    },
  );

  register(
    "ramble_nests",
    "Nests near a location this week (about a 4 km box), nearest first, with whether you already claimed each. Nests are deterministic: everyone sees the same ones.",
    {
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    },
    async ({ lat, lon }) => {
      try {
        // ±0.02° (~900 cells, ~37 nests expected; no week through 2040 has
        // fewer than 3 at the test point) — a ±0.01° box can be nearly empty.
        const bbox = { south: Math.max(-90, lat - 0.02), west: Math.max(-180, lon - 0.02), north: Math.min(90, lat + 0.02), east: Math.min(180, lon + 0.02) };
        const out = await listNests(db, bbox, { now: Date.now(), from: { lat, lon } });
        return text(JSON.stringify(out ?? { week: isoWeek(Date.now()), nests: [] }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_claim_nest",
    "Claim the nest at your location (or at an explicit 7-character geohash cell you are within 75 m of) for an egg on your shelf. One claim per day; shelf holds 5. Claiming credits no warmth.",
    {
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      cell: z.string().regex(/^[0-9b-hjkmnp-z]{7}$/).optional(),
    },
    async ({ lat, lon, cell }) => {
      try {
        const emit = await getEmit();
        const now = Date.now();
        const result = await claimNest(db, {
          cell: cell ?? encodeGeohash(lat, lon, 7), week: isoWeek(now), here: { lat, lon }, now, emit,
        });
        return text(JSON.stringify(result));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_gift_egg",
    "Gift an unhatched egg from your shelf to a contact (by crow_id). The egg leaves your shelf and arrives on theirs still unhatched — whoever hatches it rolls the bird. Contacts only; sent on the gateway's next tick.",
    { egg_id: z.string().regex(ID_RE), crow_id: z.string().regex(CROW_ID_RE) },
    async ({ egg_id, crow_id }) => {
      try {
        let contact = null;
        try { contact = await resolveContact(db, crow_id); } catch { contact = null; }
        if (!contact) return errorText(`unknown contact: ${crow_id}`);
        const emit = await getEmit();
        const out = await giftEgg(db, { eggId: egg_id, toCrowId: contact.crow_id, now: Date.now(), emit });
        if (!out.ok) return errorText(out.reason);
        return text(JSON.stringify({ gifted: true, egg_id, to: contact.crow_id, queued: true }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_propose_swap",
    "Offer one of your unhatched shelf eggs to a contact in exchange for one of theirs; they pick which egg to give back. The offer lapses after seven days. Accept or decline incoming offers from the Ramble panel.",
    { egg_id: z.string().regex(ID_RE), crow_id: z.string().regex(CROW_ID_RE) },
    async ({ egg_id, crow_id }) => {
      try {
        let contact = null;
        try { contact = await resolveContact(db, crow_id); } catch { contact = null; }
        if (!contact) return errorText(`unknown contact: ${crow_id}`);
        const emit = await getEmit();
        const out = await proposeSwap(db, { eggId: egg_id, toCrowId: contact.crow_id, now: Date.now(), emit });
        if (!out.ok) return errorText(out.reason);
        return text(JSON.stringify({ proposed: true, trade_id: out.trade.trade_id, egg_id, to: contact.crow_id, expires_at: out.trade.expires_at, queued: true }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_block",
    "Block a persona (by its x-only pubkey) from appearing in your world queries and remove its already-stored remote marks.",
    {
      persona: z.string().max(128),
      reason: z.string().max(64).optional(),
    },
    async ({ persona, reason }) => {
      try {
        const emit = await getEmit();
        const row = await blockPersona(db, persona, reason, { emit });
        return text(JSON.stringify(row));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_unblock",
    "Remove a persona from your block list.",
    {
      persona: z.string().max(128),
    },
    async ({ persona }) => {
      try {
        const emit = await getEmit();
        await unblockPersona(db, persona, { emit });
        return text(JSON.stringify({ unblocked: true, persona }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  return server;
}
