/**
 * Ramble — panel companion routes (`/api/ramble/*` + `/ramble/static/*`).
 *
 * COPIED ALONE to `$CROW_HOME/panels/ramble-routes.js` at install
 * (servers/gateway/routes/bundles.js), so it must never carry a relative
 * `../server/*` import — every bundle module is resolved through BUNDLE_DIR
 * below and imported by absolute file URL.
 *
 * STRICT_PANEL_MOUNT: this router is mounted at the app root, so EVERY
 * middleware here is path-scoped. An unpathed `router.use(mw)` would run for
 * every request that reaches this router, including traffic destined for
 * panels mounted after it (servers/gateway/index.js:642-670 refuses to mount
 * such a router under STRICT_PANEL_MOUNT=1).
 *
 * Egress: this file NEVER publishes. Authoring writes a `pending` row via
 * `createMark` and pokes `bus.emit("ramble:drain")`; the gateway transport
 * (servers/gateway/boot/ramble-transport.js) is the single egress and decides
 * — against the privacy grid — whether anything reaches a relay at all. A 201
 * from POST /api/ramble/marks therefore means "stored locally and queued",
 * never "published".
 */
import { Router } from "express";
import express from "express";
import { randomUUID } from "node:crypto";
import { join, resolve, normalize, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** A real bundle dir always carries manifest.json (install + refresh copy it). */
function looksLikeBundleDir(p) { return !!p && existsSync(join(p, "manifest.json")); }

const BUNDLE_DIR_CANDIDATES = [
  join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "ramble"),
  process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "ramble") : null,
  resolve(__dirname, ".."),
].filter(Boolean);

const BUNDLE_DIR = BUNDLE_DIR_CANDIDATES.find(looksLikeBundleDir) || BUNDLE_DIR_CANDIDATES[0];

const bundleImport = (rel) => import(pathToFileURL(join(BUNDLE_DIR, rel)).href);

const STATIC_DIR = resolve(join(BUNDLE_DIR, "panel", "static"));

/* ------------------------------------------------------------- validation */

const CELL_RE = /^[0-9b-hjkmnp-z]{1,12}$/;
const PERSONA_RE = /^[0-9a-f]{64}$/;
const MARK_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
// `private` ("Just me") — see the matching comment beside server.js's
// VISIBILITY_RE: it never reaches a relay (transport drain only selects
// visibility='public'), but it does still replicate to the author's own
// other instances via instance-sync, which is the intended behavior.
const VISIBILITY_RE = /^(public|contacts|private|group:.{1,120})$/;
const REVEALS = new Set(["open", "locked"]);
const KINDS = new Set(["mark", "caw"]);
const MAX_CELLS = 32;
const MAX_TTL_SECONDS = 31536000; // one year

/* --------------------------------------------------------------- tile proxy */

/**
 * R17: the dashboard CSP is `img-src 'self' data: blob:`
 * (servers/gateway/index.js:337-341), so a third-party tile host is blocked in
 * the browser. Tiles are therefore proxied same-origin through this router,
 * which also means the viewer's browser never talks to the tile host at all —
 * a privacy improvement, not just a CSP workaround.
 */
const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_UA = "crow-ramble/0.1 (+https://github.com/kh0pper/crow)";
const TILE_TIMEOUT_MS = 8000;
const TILE_CACHE_MAX = 500;
const MAX_TILE_ZOOM = 19;

/**
 * Expand a tile template. Only http(s) templates carrying all three
 * placeholders are accepted — an operator-set `tile_url` must never turn this
 * route into a fetcher for arbitrary schemes.
 */
function tileUpstreamUrl(template, z, x, y) {
  if (typeof template !== "string" || !/^https?:\/\//i.test(template)) {
    throw new Error("tile_url must be an http(s) template");
  }
  for (const token of ["{z}", "{x}", "{y}"]) {
    if (!template.includes(token)) throw new Error(`tile_url is missing ${token}`);
  }
  // `{s}` is OSM's subdomain placeholder. We proxy server-side, so there is no
  // browser-parallelism reason to rotate: pin it to "a".
  return template
    .split("{s}").join("a")
    .split("{z}").join(String(z))
    .split("{x}").join(String(x))
    .split("{y}").join(String(y));
}

class BadRequest extends Error {
  constructor(message) { super(message); this.name = "BadRequest"; }
}
function bad(message) { throw new BadRequest(message); }

function requireLat(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < -90 || v > 90) bad("lat must be a number between -90 and 90");
  return v;
}
function requireLon(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < -180 || v > 180) bad("lon must be a number between -180 and 180");
  return v;
}
function requireText(v, max, label) {
  if (typeof v !== "string") bad(`${label} must be a string`);
  if (v.length > max) bad(`${label} must be at most ${max} characters`);
  return v;
}
function requireCell(v) {
  if (typeof v !== "string" || !CELL_RE.test(v)) bad(`invalid geohash cell: ${String(v).slice(0, 24)}`);
  return v;
}
function defaultPrecision() {
  const p = Number(process.env.RAMBLE_DEFAULT_GEOHASH_PRECISION);
  return Number.isInteger(p) && p >= 1 && p <= 12 ? p : 5;
}

/* ------------------------------------------------------------ static files */

const CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * Serve one allow-listed file from panel/static. Never express.static: the
 * segments arrive URL-DECODED in req.params, so `..%2f..%2f` reaches us as a
 * real traversal and only the resolved-prefix check below stops it.
 */
function sendStatic(res, relParts) {
  const target = resolve(normalize(join(STATIC_DIR, ...relParts)));
  if (target !== STATIC_DIR && !target.startsWith(STATIC_DIR + sep)) {
    return res.status(400).type("text/plain").send("Bad path");
  }
  const ext = target.slice(target.lastIndexOf("."));
  const type = CONTENT_TYPES[ext];
  if (!type) return res.status(404).type("text/plain").send("Not found");
  if (!existsSync(target)) return res.status(404).type("text/plain").send("Not found");
  res.setHeader("Content-Type", type);
  return res.sendFile(target);
}

/* --------------------------------------------------------------- the router */

export default function rambleRouter(dashboardAuth, options = {}) {
  const router = Router();

  // Test-only seam: an injected `emit` makes the sync contract observable
  // without a core schema in the scratch db. Production passes nothing and gets
  // the real emitOrQueue hook built in ensureLoaded().
  const injectedEmit = typeof options.emit === "function" ? options.emit : null;

  /** Fallback session id for rotating caws when no gateway has written one. */
  const processSessionId = randomUUID();

  /** Tiny insertion-ordered LRU for proxied tiles: key "z/x/y" -> {type, body}. */
  const tileCache = new Map();

  let mods = null;
  let db = null;
  let emit = null;
  let bus = null;

  async function ensureLoaded(res) {
    if (!mods) {
      const [dbMod, initMod, marksMod, gridMod, personaMod, anchorsMod, appRootMod, petMod] = await Promise.all([
        bundleImport("server/db.js"),
        bundleImport("server/init-tables.js"),
        bundleImport("server/marks.js"),
        bundleImport("server/grid.js"),
        bundleImport("server/persona.js"),
        bundleImport("server/anchors.js"),
        bundleImport("server/app-root.js"),
        bundleImport("server/pet.js"),
      ]).catch((err) => {
        console.warn(`[ramble routes] bundle modules unavailable: ${err.message}`);
        return [];
      });
      if (!dbMod || !initMod || !marksMod || !gridMod || !personaMod || !anchorsMod || !appRootMod || !petMod) {
        res.status(500).json({ error: "ramble bundle modules not available" });
        return false;
      }
      mods = { dbMod, initMod, marksMod, gridMod, personaMod, anchorsMod, petMod, appImport: appRootMod.appImport };
    }
    if (!db) {
      db = mods.dbMod.createDbClient();
      await mods.initMod.initRambleTables(db);
    }
    if (!emit && injectedEmit) emit = injectedEmit;
    if (!emit) {
      // Same emit hook shape as everywhere else in the bundle. In the gateway
      // process the manager is live and emitOrQueue passes through; elsewhere
      // it durably queues. Never allowed to fail a request.
      try {
        const [{ emitOrQueue }, { getInstanceSyncManager }] = await Promise.all([
          mods.appImport("servers/shared/sync-emit.js"),
          mods.appImport("servers/sharing/managers.js"),
        ]);
        emit = (table, op, row) => emitOrQueue(getInstanceSyncManager(), db, table, op, row).catch(() => {});
      } catch (err) {
        console.warn(`[ramble routes] sync emit unavailable: ${err.message}`);
        emit = () => {};
      }
    }
    if (!bus) {
      try { bus = (await mods.appImport("servers/shared/event-bus.js")).default; }
      catch { bus = { emit() {} }; }
    }
    return true;
  }

  /**
   * R18: a locked teaser carries no lat/lon (reveal.js strips them), only its
   * coarse geohash — so the map would have nothing to pin. Give it the cell
   * CENTRE plus an honest error radius (the cell's half-diagonal in metres).
   * This adds no precision the teaser did not already publish: the cell is
   * already on the row, and on the wire.
   */
  function withApproxAnchor(mark) {
    if (typeof mark.lat === "number" && typeof mark.lon === "number") return mark;
    if (!mark.geohash) return mark;
    try {
      const { lat, lon, latErr, lonErr } = mods.anchorsMod.decodeGeohash(mark.geohash);
      return {
        ...mark,
        approx_lat: lat,
        approx_lon: lon,
        approx_m: mods.anchorsMod.haversineMeters({ lat, lon }, { lat: lat + latErr, lon: lon + lonErr }),
      };
    } catch {
      return mark; // an unparseable geohash simply stays unpinnable
    }
  }

  /** bus.emit is synchronous and re-throws subscriber errors — never let one break a request. */
  function poke(event, payload) {
    try { bus.emit(event, payload); } catch (err) {
      console.warn(`[ramble routes] ${event} subscriber threw:`, err?.message ?? err);
    }
  }

  async function getSetting(key) {
    const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key] });
    return rows[0]?.value ?? null;
  }

  /**
   * The authoring persona (Task 7 seam, same call the MCP server makes).
   * `getManagersOrNull()` is null outside a booted gateway, so fall back to
   * the on-disk identity rather than refusing to author.
   */
  async function personaFor(kind) {
    const [managersMod, identityMod] = await Promise.all([
      mods.appImport("servers/sharing/managers.js"),
      mods.appImport("servers/sharing/identity.js"),
    ]);
    const identity = managersMod.getManagersOrNull()?.identity || identityMod.loadOrCreateIdentity();
    const seed = identityMod.loadInstanceSeed(mods.dbMod.resolveDataDir());
    const level = (await mods.gridMod.getGrid(db)).identityLevel;
    let sessionId = processSessionId;
    if (kind === "caw" && level === "rotating") {
      // R11: the transport mints the per-boot id, so both processes sign a
      // rotating caw with the SAME key. Read fresh — a gateway restart rotates it.
      sessionId = (await getSetting("local.session_id")) || processSessionId;
    }
    return mods.personaMod.resolvePersona(identity, seed, {
      level, kind, sessionId, _derive: identityMod.deriveBotIdentity,
    });
  }

  /** Wrap a handler: ensureLoaded + BadRequest -> 400 + anything else -> 500 (message only). */
  function handle(fn) {
    return async (req, res) => {
      try {
        if (!(await ensureLoaded(res))) return;
        await fn(req, res);
      } catch (err) {
        if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
        console.warn("[ramble routes] request failed:", err?.stack ?? err);
        res.status(500).json({ error: err?.message ?? "internal error" });
      }
    };
  }

  // --- path-scoped middleware (STRICT_PANEL_MOUNT) ---------------------------
  if (typeof dashboardAuth === "function") {
    router.use("/api/ramble", dashboardAuth);
    router.use("/ramble/static", dashboardAuth);
    router.use("/ramble/tiles", dashboardAuth);
  }
  router.use("/api/ramble", express.json({ limit: "1mb" }));

  // --- map tiles (same-origin proxy, R17) -----------------------------------
  router.get("/ramble/tiles/:z/:x/:y.png", handle(async (req, res) => {
    if (!/^\d{1,2}$/.test(req.params.z)) bad("z must be an integer");
    const z = Number(req.params.z);
    if (z < 0 || z > MAX_TILE_ZOOM) bad(`z must be between 0 and ${MAX_TILE_ZOOM}`);
    const span = 2 ** z;
    if (!/^\d{1,10}$/.test(req.params.x) || !/^\d{1,10}$/.test(req.params.y)) bad("x and y must be integers");
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (x < 0 || x >= span || y < 0 || y >= span) bad(`x and y must be between 0 and ${span - 1} at z=${z}`);

    // A malformed operator-set template is a server misconfiguration (500),
    // not a bad request — let it propagate to handle()'s 500 branch. Resolved
    // BEFORE the cache lookup so the resolved URL can BE the cache key: a
    // changed `tile_url` must never be answered with the old host's tiles.
    const upstream = tileUpstreamUrl((await getSetting("tile_url")) || DEFAULT_TILE_URL, z, x, y);

    const cached = tileCache.get(upstream);
    if (cached) {
      res.setHeader("Content-Type", cached.type);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(cached.body);
    }

    let response;
    try {
      response = await fetch(upstream, {
        headers: { "User-Agent": TILE_UA },
        signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[ramble routes] tile ${z}/${x}/${y} fetch failed:`, err?.message ?? err);
      return res.status(502).end();
    }
    if (!response.ok) return res.status(502).end();

    // A tile host that answers with HTML (a rate-limit or block page, a captive
    // portal) must not be cached or echoed into an <img> — only images pass.
    const type = response.headers.get("content-type") || "image/png";
    if (!/^image\//i.test(type)) return res.status(502).end();

    const body = Buffer.from(await response.arrayBuffer());
    tileCache.set(upstream, { type, body });
    while (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);

    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(body);
  }));

  // --- static assets --------------------------------------------------------
  router.get("/ramble/static/leaflet/images/:file", (req, res) => sendStatic(res, ["leaflet", "images", req.params.file]));
  router.get("/ramble/static/leaflet/:file", (req, res) => sendStatic(res, ["leaflet", req.params.file]));
  router.get("/ramble/static/:file", (req, res) => sendStatic(res, [req.params.file]));

  // --- marks ----------------------------------------------------------------
  router.get("/api/ramble/marks", handle(async (req, res) => {
    const q = req.query || {};
    let cells;
    if (q.cells != null) {
      if (typeof q.cells !== "string") bad("cells must be a comma-separated string");
      cells = q.cells.split(",").map((c) => c.trim()).filter(Boolean).map(requireCell);
      if (cells.length > MAX_CELLS) bad(`at most ${MAX_CELLS} cells`);
      if (cells.length === 0) cells = undefined;
    }
    let visibility;
    if (q.visibility != null) {
      visibility = requireText(q.visibility, 128, "visibility");
      if (!VISIBILITY_RE.test(visibility)) bad(`invalid visibility: ${visibility}`);
    }
    const marks = await mods.marksMod.listMarks(db, { visibility, cells });
    res.json({ marks: marks.map(withApproxAnchor) });
  }));

  router.post("/api/ramble/marks", handle(async (req, res) => {
    const b = req.body || {};
    const kind = b.kind ?? "mark";
    if (!KINDS.has(kind)) bad(`kind must be one of: ${[...KINDS].join(", ")}`);
    const lat = requireLat(b.lat);
    const lon = requireLon(b.lon);
    const text = requireText(b.text ?? "", 2000, "text");
    let accuracy_m = null;
    if (b.accuracy_m != null) {
      if (typeof b.accuracy_m !== "number" || !Number.isFinite(b.accuracy_m) ||
          b.accuracy_m < 0 || b.accuracy_m > 100000) bad("accuracy_m must be a number between 0 and 100000");
      accuracy_m = b.accuracy_m;
    }
    // A caw is presence: always public, always open (same rule as the MCP tool).
    let visibility = kind === "caw" ? "public" : (b.visibility ?? "public");
    if (typeof visibility !== "string" || visibility.length > 128 || !VISIBILITY_RE.test(visibility)) {
      bad(`invalid visibility: ${String(visibility).slice(0, 32)}`);
    }
    let reveal = kind === "caw" ? "open" : b.reveal;
    if (reveal != null && !REVEALS.has(reveal)) bad(`reveal must be one of: ${[...REVEALS].join(", ")}`);
    let ttlSeconds;
    if (b.ttl_seconds != null) {
      if (!Number.isInteger(b.ttl_seconds) || b.ttl_seconds < 0 || b.ttl_seconds > MAX_TTL_SECONDS) {
        bad(`ttl_seconds must be an integer between 0 and ${MAX_TTL_SECONDS}`);
      }
      ttlSeconds = b.ttl_seconds;
    }

    const persona = await personaFor(kind);
    const mark = await mods.marksMod.createMark(db, {
      author: persona.author,
      author_level: persona.author_level,
      kind,
      anchor: { anchor_kind: "geo", lat, lon, accuracy_m },
      visibility,
      reveal,
      content: { content_text: text, content_kind: "none" },
      ttlSeconds,
    }, { emit });

    // Queued, not published: the transport drain decides against the grid.
    poke("ramble:drain");
    res.status(201).json({ mark });
  }));

  router.delete("/api/ramble/marks/:mark_id", handle(async (req, res) => {
    const markId = req.params.mark_id;
    if (!MARK_ID_RE.test(markId)) bad("invalid mark_id");
    const row = await mods.marksMod.getMark(db, markId);
    // Only your own marks are deletable — remote rows are someone else's.
    if (!row || row.origin !== "local") return res.status(404).json({ error: "not found" });

    if (row.publish_state === "published" && row.visibility === "public" && row.nostr_event_id) {
      // R14: a TABLE, not a settings blob — the drain and this path would
      // otherwise read-modify-write one JSON list and lose each other's rows.
      await db.execute({
        sql: `INSERT INTO ramble_tombstones (nostr_event_id, mark_id, kind, author_level, created_at)
              VALUES (?, ?, ?, ?, ?) ON CONFLICT(nostr_event_id) DO NOTHING`,
        args: [row.nostr_event_id, row.mark_id, row.kind, row.author_level ?? null, Date.now()],
      });
    }
    await db.execute({ sql: "DELETE FROM ramble_marks WHERE mark_id = ?", args: [markId] });
    await emit("ramble_marks", "delete", row);
    poke("ramble:drain");
    res.status(204).end();
  }));

  router.post("/api/ramble/unlock", handle(async (req, res) => {
    const b = req.body || {};
    const markId = typeof b.mark_id === "string" ? b.mark_id : "";
    if (!MARK_ID_RE.test(markId)) bad("invalid mark_id");
    const result = await mods.marksMod.unlockMark(db, markId, { lat: requireLat(b.lat), lon: requireLon(b.lon) });
    if (result.missing) return res.status(404).json({ error: "not found" });
    if (result.unlocked === true) {
      // Best-effort: a pet-feed failure must never fail an unlock response.
      try { await mods.petMod.feed(db, { type: "unlock_mark" }); } catch { /* cosmetic */ }
    }
    res.json(result);
  }));

  // --- privacy grid ---------------------------------------------------------
  router.get("/api/ramble/grid", handle(async (req, res) => {
    res.json(await mods.gridMod.getGrid(db));
  }));

  router.post("/api/ramble/grid", handle(async (req, res) => {
    const b = req.body || {};
    const { AUDIENCES, CHANNELS, IDENTITY_LEVELS } = mods.gridMod;

    if (b.master != null && typeof b.master !== "boolean") bad("master must be a boolean");
    if (b.identityLevel != null && !IDENTITY_LEVELS.includes(b.identityLevel)) {
      bad(`identityLevel must be one of: ${IDENTITY_LEVELS.join(", ")}`);
    }
    if (b.cells != null) {
      if (typeof b.cells !== "object" || Array.isArray(b.cells)) bad("cells must be an object");
      for (const [audience, channels] of Object.entries(b.cells)) {
        if (!AUDIENCES.includes(audience)) bad(`unknown audience: ${audience}`);
        if (typeof channels !== "object" || channels == null || Array.isArray(channels)) bad(`cells.${audience} must be an object`);
        for (const [channel, on] of Object.entries(channels)) {
          if (!CHANNELS.includes(channel)) bad(`unknown channel: ${channel}`);
          if (typeof on !== "boolean") bad(`cells.${audience}.${channel} must be a boolean`);
        }
      }
    }

    // Validated in full above, so a partial application can't happen here.
    if (b.master != null) await mods.gridMod.setMaster(db, b.master, { emit });
    for (const [audience, channels] of Object.entries(b.cells || {})) {
      for (const [channel, on] of Object.entries(channels)) {
        // eslint-disable-next-line no-await-in-loop
        await mods.gridMod.setCell(db, audience, channel, on, { emit });
      }
    }
    if (b.identityLevel != null) await mods.gridMod.setIdentityLevel(db, b.identityLevel, { emit });

    res.json(await mods.gridMod.getGrid(db));
  }));

  // --- active area (the subscriber's only input, D6) ------------------------
  router.post("/api/ramble/area", handle(async (req, res) => {
    const b = req.body || {};
    let cells;
    if (Array.isArray(b.cells)) {
      if (b.cells.length === 0 || b.cells.length > MAX_CELLS) bad(`cells must hold 1..${MAX_CELLS} entries`);
      cells = b.cells.map(requireCell);
    } else {
      cells = [mods.anchorsMod.encodeGeohash(requireLat(b.lat), requireLon(b.lon), defaultPrecision())];
    }

    // Feed the pet a visit_place when the resolved area is a NEW geohash —
    // "the user opens the map at a new geohash" (spec §11) — read the
    // previous value BEFORE overwriting it so the comparison is meaningful.
    const previousRaw = await getSetting("local.active_area");
    let previousCells = [];
    if (previousRaw) {
      try { previousCells = JSON.parse(previousRaw); } catch { previousCells = []; }
    }
    const isNewArea = JSON.stringify([...cells].sort()) !== JSON.stringify([...previousCells].sort());

    // Written directly, NOT through the grid's emitting writer: `local.`-prefixed
    // keys are per-instance machinery and never replicate (instance-sync filters
    // them anyway — emitting would just be noise).
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES ('local.active_area', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [JSON.stringify(cells)],
    });

    if (isNewArea) {
      // Best-effort: a pet-feed failure must never fail an area update.
      try { await mods.petMod.feed(db, { type: "visit_place" }); } catch { /* cosmetic */ }
    }

    poke("ramble:area");
    res.json({ cells });
  }));

  // --- blocks ---------------------------------------------------------------
  router.post("/api/ramble/block", handle(async (req, res) => {
    const b = req.body || {};
    if (typeof b.persona !== "string" || !PERSONA_RE.test(b.persona)) {
      bad("persona must be a 64-character hex x-only pubkey");
    }
    let reason = null;
    if (b.reason != null) reason = requireText(b.reason, 64, "reason");
    res.json(await mods.marksMod.blockPersona(db, b.persona, reason, { emit }));
  }));

  // --- pet --------------------------------------------------------------
  router.get("/api/ramble/pet", handle(async (req, res) => {
    res.json(await mods.petMod.petState(db));
  }));

  // Body-parser failures (malformed JSON) surface here. Path-scoped, so it is
  // not an unpathed layer; last so it also catches route-thrown errors.
  // eslint-disable-next-line no-unused-vars
  router.use("/api/ramble", (err, req, res, next) => {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 400;
    res.status(status).json({ error: "invalid request body" });
  });

  return router;
}
