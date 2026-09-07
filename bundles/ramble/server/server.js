/**
 * Ramble MCP server. Milestone 1 (M1) tools — local core, no network/UI:
 *   ramble_leave_mark, ramble_caw, ramble_query_world, ramble_unlock,
 *   ramble_pet_state, ramble_block, ramble_unblock.
 *
 * Groups are NOT in phase 1 (review round 3, D8) — ramble_group_create/
 * ramble_group_join move to phase 1b with the contacts/group delivery path.
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

const text = (t) => ({ content: [{ type: "text", text: t }] });
const errorText = (t) => ({ content: [{ type: "text", text: t }], isError: true });

const VISIBILITY_RE = /^(public|contacts|group:.+)$/;

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
        const persona = await personaFor("mark");
        const emit = await getEmit();
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
    "List nearby marks and caws within the geohash cell containing the given location.",
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
        const marks = await listMarks(db, { visibility, geohashPrefix: cell });
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
        return text(JSON.stringify(result));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_pet_state",
    "Get the Ramble companion pet's current state (mood, energy, weekly activity counters). Task 14 replaces this stub with full pet.js logic.",
    {},
    async () => {
      try {
        let result = await db.execute({ sql: "SELECT * FROM ramble_pet WHERE owner = 'self'", args: [] });
        if (result.rows.length === 0) {
          await db.execute({ sql: "INSERT INTO ramble_pet (owner) VALUES ('self')", args: [] });
          result = await db.execute({ sql: "SELECT * FROM ramble_pet WHERE owner = 'self'", args: [] });
        }
        const row = result.rows[0];
        return text(JSON.stringify({
          mood: row.mood,
          energy: row.energy,
          places_week: row.places_week,
          unlocks_week: row.unlocks_week,
          crows_week: row.crows_week,
        }));
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
