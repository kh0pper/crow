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
 * never "published". Phase 3: contacts/group marks, gifts and swaps are
 * queued into `ramble_outbox` here and sent by the transport's
 * `drainDeliveries`; a 200/201 means queued.
 */
import { Router } from "express";
import express from "express";
import { randomUUID } from "node:crypto";
import { join, resolve, normalize, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
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
const SERVER_DIR = resolve(join(BUNDLE_DIR, "server"));

/**
 * The bird genome engine is a CLASSIC script (dual Node/browser: it assigns
 * `window.RambleBird` in a browser and `module.exports` under Node), so it
 * carries the `.cjs` extension — the repo root's package.json is
 * `type: "module"` and a `.js` file there would be parsed as ESM. That means
 * `import()` cannot load it; `createRequire` can. Loaded lazily and cached so
 * a missing/broken engine only fails the two bird routes, never module import.
 */
const requireBundleFile = createRequire(import.meta.url);
let birdEngine = null;
function loadBirdEngine() {
  if (!birdEngine) birdEngine = requireBundleFile(join(SERVER_DIR, "bird-svg.cjs"));
  return birdEngine;
}

/* ------------------------------------------------------------- validation */

const CELL_RE = /^[0-9b-hjkmnp-z]{1,12}$/;
const PERSONA_RE = /^[0-9a-f]{64}$/;
const MARK_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const EGG_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const CROW_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const TRADE_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
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
      const [dbMod, initMod, marksMod, gridMod, personaMod, anchorsMod, appRootMod, petMod, eggsMod, feedMod, flockMod, nestsMod, deliveryMod, tradesMod, aroundMod, zonesMod, cellsMod, walletMod] = await Promise.all([
        bundleImport("server/db.js"),
        bundleImport("server/init-tables.js"),
        bundleImport("server/marks.js"),
        bundleImport("server/grid.js"),
        bundleImport("server/persona.js"),
        bundleImport("server/anchors.js"),
        bundleImport("server/app-root.js"),
        bundleImport("server/pet.js"),
        bundleImport("server/eggs.js"),
        bundleImport("server/feed.js"),
        bundleImport("server/flock.js"),
        bundleImport("server/nests.js"),
        bundleImport("server/delivery.js"),
        bundleImport("server/trades.js"),
        bundleImport("server/around.js"),
        bundleImport("server/zones.js"),
        bundleImport("server/cells.js"),
        bundleImport("server/wallet.js"),
      ]).catch((err) => {
        console.warn(`[ramble routes] bundle modules unavailable: ${err.message}`);
        return [];
      });
      if (!dbMod || !initMod || !marksMod || !gridMod || !personaMod || !anchorsMod || !appRootMod || !petMod ||
          !eggsMod || !feedMod || !flockMod || !nestsMod || !deliveryMod || !tradesMod || !aroundMod || !zonesMod || !cellsMod || !walletMod) {
        res.status(500).json({ error: "ramble bundle modules not available" });
        return false;
      }
      mods = { dbMod, initMod, marksMod, gridMod, personaMod, anchorsMod, petMod, eggsMod, feedMod, flockMod, nestsMod, deliveryMod, tradesMod, aroundMod, zonesMod, cellsMod, walletMod, appImport: appRootMod.appImport };
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

  /**
   * What a listed row looks like to the panel, for BOTH /marks and /around:
   * a locked teaser gains its cell centre (withApproxAnchor) and a remote
   * mark by a contact is named (phase 3); a stranger's stays anonymous.
   */
  async function annotateMarks(marks) {
    const byPubkey = await mods.deliveryMod.contactsByPubkey(db);
    const named = marks.map(withApproxAnchor).map((m) => {
      const c = m.origin === "remote" ? byPubkey.get(String(m.author)) : null;
      // 2026-09-08 §4.5: a contact's pin carries their picture beside their name.
      return c ? { ...m, contact_name: c.name, ...(c.avatar ? { contact_avatar: c.avatar } : {}) } : m;
    });
    // 2026-09-08 §2.1: fog the PUBLIC overlay. Runs AFTER contact naming, so a
    // contact's mark is already marked as theirs and passes through untouched.
    const depth = await mods.zonesMod.frontierDepth(db);
    // Bounded like the other two gates. annotateMarks has no bbox, but the
    // marks themselves give one: their own coordinates. An unbounded read here
    // would undo the point of unlockedCellsNear on every /marks and /around.
    const lats = named.map((m) => Number(m.lat ?? m.approx_lat)).filter(Number.isFinite);
    const lons = named.map((m) => Number(m.lon ?? m.approx_lon)).filter(Number.isFinite);
    const unlocked = lats.length
      ? await mods.cellsMod.unlockedCellsNear(db, {
          south: Math.min(...lats), north: Math.max(...lats),
          west: Math.min(...lons), east: Math.max(...lons),
        }, depth)
      : new Set();
    return mods.zonesMod.gateForZones(named, { unlocked, depth, encode: mods.anchorsMod.encodeGeohash });
  }

  /** bus.emit is synchronous and re-throws subscriber errors — never let one break a request. */
  function poke(event, payload) {
    try { bus.emit(event, payload); } catch (err) {
      console.warn(`[ramble routes] ${event} subscriber threw:`, err?.message ?? err);
    }
  }

  /**
   * The single onHatch hook handed to every feedAll() below. A hatch is a
   * live event for the panel (the /dashboard/streams/ramble-nearby channel
   * turns it into an `event: ramble-hatched` frame), and the payload is the
   * same allow-listed trio the stream re-whitelists — the rest of the egg row
   * is never anyone's business. `poke` swallows a throwing subscriber, so a
   * broken listener can never fail the request that hatched the egg.
   */
  function onHatch(egg) {
    poke("ramble:hatched", {
      egg_id: egg?.egg_id ?? null,
      species: egg?.species ?? null,
      seed: egg?.seed ?? null,
    });
  }

  /**
   * Best-effort activity feed. Everywhere except the check-in route the feed
   * is a side effect of some other action (leaving a mark, unlocking one,
   * arriving somewhere), so a warmth/pet failure must never fail the request
   * it rode in on.
   */
  async function feedActivity(event) {
    try {
      return await mods.feedMod.feedAll(db, event, { now: Date.now(), emit, onHatch });
    } catch (err) {
      console.warn(`[ramble routes] feed ${event?.type} failed:`, err?.message ?? err);
      return null;
    }
  }

  /**
   * The allow-listed hatch trio for a response body, or null. Every route that
   * feeds activity reports it, because the panel client branches on
   * `out.hatched` / `result.hatched` to run the hatch animation without
   * waiting for the next poll. `null` covers both "nothing hatched" and "the
   * best-effort feed was skipped or failed" — the request itself still
   * succeeded, so the client simply has no hatch to show.
   */
  function hatchedPayload(fed) {
    const egg = fed && fed.hatched;
    return egg ? { egg_id: egg.egg_id, species: egg.species, seed: egg.seed } : null;
  }

  async function getSetting(key) {
    const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key] });
    return rows[0]?.value ?? null;
  }

  /** A deliverable contact by crow_id, or null — also null when the core tables are unreadable. */
  async function contactOrNull(crowId) {
    try { return await mods.deliveryMod.resolveContact(db, crowId); }
    catch (err) { console.warn("[ramble routes] contact lookup failed:", err?.message ?? err); return null; }
  }

  async function contactNames() {
    try {
      const { contacts } = await mods.deliveryMod.listAudiences(db);
      return new Map(contacts.map((c) => [c.crow_id, c.display_name || c.crow_id]));
    } catch { return new Map(); }
  }

  function tradeStatus(out) {
    if (out.reason === "not-found") return 404;
    return 409;
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

  /**
   * The bird engine, served to the browser under the static prefix but read
   * from `server/` — it is the SAME file the server draws with, so the panel's
   * eggs and birds can never drift from the ones rendered into a mark's pin.
   *
   * MUST stay above the `/ramble/static/:file` catch-all below: Express
   * matches layers in registration order, and the catch-all only ever looks
   * under panel/static (where no bird-svg.js exists) — it would answer 404.
   * The file is `.cjs` on disk (see loadBirdEngine) and `.js` on the wire,
   * because the browser only cares about the media type.
   */
  router.get("/ramble/static/bird-svg.js", (req, res) => {
    // Same discipline as sendStatic: a resolved-prefix check, even though the
    // path here is a constant, so the invariant survives a future edit.
    const target = resolve(normalize(join(SERVER_DIR, "bird-svg.cjs")));
    if (!target.startsWith(SERVER_DIR + sep)) return res.status(400).type("text/plain").send("Bad path");
    if (!existsSync(target)) return res.status(404).type("text/plain").send("Not found");
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    // `private`, never `public`: this route sits behind dashboardAuth, so a
    // shared cache must never hold the response.
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.sendFile(target);
  });

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
    res.json({ marks: await annotateMarks(marks) });
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
    // Phase 3: a group audience must exist before a row is written for it.
    if (visibility.startsWith("group:")) {
      let a = null;
      try { a = await mods.deliveryMod.resolveAudience(db, visibility); } catch { a = null; }
      if (!a || !a.ok) bad("unknown group");
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
    const bird = await mods.eggsMod.activeBird(db);
    const mark = await mods.marksMod.createMark(db, {
      author: persona.author,
      author_level: persona.author_level,
      kind,
      anchor: { anchor_kind: "geo", lat, lon, accuracy_m },
      visibility,
      reveal,
      content: { content_text: text, content_kind: "none" },
      ttlSeconds,
      // Your currently-active bird rides along on the row, so your own pins
      // wear the same bird everyone else's do. Null until the first hatch.
      bird,
    }, { emit });

    // Phase 3: contacts/group marks ride the outbox as one DM per recipient.
    // The row already exists; a queue failure must not fail the author.
    let recipients = 0;
    if (visibility === "contacts" || visibility.startsWith("group:")) {
      try {
        const q = await mods.deliveryMod.enqueueMark(db, mark, { bird, now: Date.now() });
        recipients = q.ok ? q.recipients : 0;
      } catch (err) {
        console.warn("[ramble routes] enqueueMark failed:", err?.message ?? err);
      }
    }

    // Queued, not published: the transport drain decides against the grid.
    poke("ramble:drain");

    // Awaited BEFORE the response so a client that immediately re-reads
    // /api/ramble/egg sees the credit (and so a hatch has already gone out on
    // the stream). Best-effort: warmth is never worth failing an author on.
    const fed = await feedActivity({ type: "mark_left" });

    res.status(201).json({ mark, hatched: hatchedPayload(fed), recipients });
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
    let fed = null;
    if (result.unlocked === true) {
      // feedAll, not petMod.feed: an unlock warms the egg as well as the pet.
      fed = await feedActivity({ type: "unlock_mark" });
    }
    res.json({ ...result, hatched: hatchedPayload(fed) });
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
    if (b.worldName != null && (typeof b.worldName !== "string" || b.worldName.length > 128)) bad("worldName must be a string of at most 128 characters");
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
    if (b.worldName != null) await mods.gridMod.setWorldName(db, b.worldName, { emit });

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

    // `here` is the user's REAL position from the browser's geolocation, and
    // it is the ONLY thing that can credit a visit. The active area is
    // whatever the viewport happens to cover, so crediting it (as this route
    // used to, on any new geohash) let a pan farm warmth and `places_week`
    // from an armchair. No `here` -> no visit credit, ever.
    let here = null;
    if (b.here != null) {
      if (typeof b.here !== "object" || Array.isArray(b.here)) bad("here must be an object with lat and lon");
      here = { lat: requireLat(b.here.lat), lon: requireLon(b.here.lon) };
      // 2026-09-08 §2.1: an unlock is permanent and undeletable, so a vague fix
      // must not earn one. Optional — an older panel that omits it is trusted,
      // exactly as today.
      if (b.here.accuracy_m != null) {
        if (typeof b.here.accuracy_m !== "number" || !Number.isFinite(b.here.accuracy_m) || b.here.accuracy_m < 0) {
          bad("here.accuracy_m must be a non-negative number");
        }
        here.accuracy_m = b.here.accuracy_m;
      }
    }

    // Written directly, NOT through the grid's emitting writer: `local.`-prefixed
    // keys are per-instance machinery and never replicate (instance-sync filters
    // them anyway — emitting would just be noise).
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES ('local.active_area', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [JSON.stringify(cells)],
    });

    let unlockedNow = null;
    let seedPicked = 0;
    if (here) {
      // Geohash-7 (spec §2.1) — the credit key's period is the ISO week, so
      // the same real place only ever counts once a week no matter how many
      // times the panel posts its position.
      const cell = mods.anchorsMod.encodeGeohash(here.lat, here.lon, 7);
      await feedActivity({ type: "visit_place", cell });
      // 2026-09-08 §2.1: standing in a cell unlocks it, permanently. Reported
      // back only on the FIRST unlock so the panel celebrates once, not on
      // every position post. `emit` is what makes the row replicate.
      const out = await mods.cellsMod.recordUnlock(db, cell, { now: Date.now(), emit, accuracyM: here.accuracy_m });
      // The FOOTPRINT, not just the name: the panel flashes the exact square
      // the user just walked into, which is the whole point of the moment.
      if (out.unlocked) unlockedNow = mods.zonesMod.cellBox(out.cell);
      // 2026-09-08 §2.3: bird seed grows in ground you have ALREADY unlocked,
      // so a first arrival unlocks the cell and the next visit starts paying.
      // Deliberate: standing still after an unlock earns nothing until you
      // move and come back, which is what "routine sustains you" means.
      if (!out.unlocked && out.cell) {
        seedPicked = (await mods.walletMod.recordSeedPickup(db, cell, { now: Date.now(), emit })).amount;
      }
    }

    poke("ramble:area");
    // `seed` rides ONLY on a post that carried a fix. An area post without
    // `here` keeps its historical response shape byte for byte, which is what
    // the existing "writes local.active_area" test asserts with a deepEqual.
    res.json({
      cells,
      ...(unlockedNow ? { unlocked: unlockedNow } : {}),
      ...(seedPicked ? { seed_picked: seedPicked } : {}),
      ...(here ? { seed: await mods.walletMod.seedBalance(db) } : {}),
    });
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
    const now = Date.now();
    // One read for the whole companion strip: mood/energy/chores, the bird
    // that hatched (null until the first one does), and just the egg's
    // progress percent — the panel's full egg card reads /api/ramble/egg.
    const pet = await mods.petMod.petState(db, { now });
    const bird = await mods.eggsMod.activeBird(db);
    const egg = await mods.eggsMod.eggState(db, { now });
    res.json({ ...pet, bird, egg: { percent: egg.egg.percent }, seed: await mods.walletMod.seedBalance(db) });
  }));

  router.post("/api/ramble/pet/chore", handle(async (req, res) => {
    const kind = (req.body || {}).kind;
    // doChore throws a plain Error on an unknown kind, which handle() would
    // turn into a 500 — validate here so a bad kind is the 400 it is.
    if (!mods.petMod.CHORES.includes(kind)) bad(`kind must be one of: ${mods.petMod.CHORES.join(", ")}`);
    res.json(await mods.petMod.doChore(db, kind, { now: Date.now(), emit }));
  }));

  // --- egg ----------------------------------------------------------------
  //
  // `eggState` and `creditWarmth` have NO internal `now` default (the db layer
  // refuses an undefined argument), so every call from here passes one.
  router.get("/api/ramble/egg", handle(async (req, res) => {
    res.json(await mods.eggsMod.eggState(db, { now: Date.now() }));
  }));

  router.post("/api/ramble/egg/checkin", handle(async (req, res) => {
    // Not best-effort, unlike every other feed in this file: the credit IS
    // the request, so a failure has to surface rather than answer "credited".
    const { credited, warmth, hatched } = await mods.feedMod.feedAll(
      db, { type: "checkin" }, { now: Date.now(), emit, onHatch },
    );
    res.json({
      credited,
      warmth,
      hatched: hatched ? { egg_id: hatched.egg_id, species: hatched.species, seed: hatched.seed } : null,
    });
  }));

  // --- bird portraits -------------------------------------------------------
  //
  // Rendered server-side from the same engine the panel loads, so a bird is a
  // plain <img src> the browser can cache — no client-side draw needed to show
  // someone else's bird on a pin.
  router.get("/api/ramble/bird/:species/:seed.svg", handle(async (req, res) => {
    const bird = loadBirdEngine();
    const species = req.params.species;
    // A uint32 and nothing else: /^\d{1,10}$/ first so "1e9", "0x10", " 12"
    // and other Number()-friendly spellings never reach rollGenome.
    if (!/^\d{1,10}$/.test(req.params.seed)) bad("seed must be a uint32");
    const seed = Number(req.params.seed);
    if (!bird.isValidBird({ species, seed })) bad(`invalid bird: ${String(species).slice(0, 24)}/${seed}`);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img">` +
      `${bird.drawBird(bird.rollGenome(seed, species), req.query.mood)}</svg>`;
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    // `private`, never `public`: an authed route's body must not sit in a
    // shared cache. A genome is a pure function of (species, seed), so a day
    // in the browser's own cache is free.
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(svg);
  }));

  // --- nests --------------------------------------------------------------
  //
  // Nests are a pure function of (cell, week) under a public salt; the server
  // computes them for the viewport so the client needs no geohash code. The
  // viewport is a bbox, not a cell list (spec §2.4 says "for the visible
  // cells" — this is the same intent without a client-side geohash encoder).
  router.get("/api/ramble/nests", handle(async (req, res) => {
    const raw = req.query?.bbox;
    if (typeof raw !== "string") bad("bbox=south,west,north,east is required");
    const parts = raw.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || !parts.every(Number.isFinite)) bad("bbox must be four numbers: south,west,north,east");
    const bbox = { south: requireLat(parts[0]), west: requireLon(parts[1]), north: requireLat(parts[2]), east: requireLon(parts[3]) };
    if (bbox.south > bbox.north || bbox.west > bbox.east) bad("bbox must have south <= north and west <= east");
    const out = await mods.flockMod.listNests(db, bbox, { now: Date.now() });
    if (!out) bad("bbox too large — zoom in");
    // Nests are public terrain, so they fog like public marks: whole in
    // unlocked ground, a typed beacon in the frontier, absent in fog. The
    // synthetic `visibility: "public"` is what marks them as gateable — nests
    // have no visibility column of their own.
    const depth = await mods.zonesMod.frontierDepth(db);
    const unlocked = await mods.cellsMod.unlockedCellsNear(db, bbox, depth);
    const gated = mods.zonesMod.gateForZones(
      (out.nests || []).map((n) => ({ ...n, kind: "nest", origin: "remote", visibility: "public" })),
      { unlocked, depth, encode: mods.anchorsMod.encodeGeohash },
    ).map((n) => {
      // gateForZones passes an UNLOCKED row through untouched, so the three
      // synthetic keys we added to make it gateable would ride out to the
      // client and break the route's documented shape. A beacon is rebuilt
      // from scratch and never carries them.
      if (n.beacon) return n;
      const { kind, origin, visibility, ...nest } = n;
      return nest;
    });
    res.json({ ...out, nests: gated });
  }));

  // The map's fog (spec 2026-09-08 §2.1). Same bbox contract as /nests: the
  // server owns all geohash maths so the client needs none. Fog is implicit —
  // a cell in neither list is fogged. The unlocked set is read BBOX-SCOPED, so
  // a user with years of walked ground pays for geography, not for history.
  router.get("/api/ramble/zones", handle(async (req, res) => {
    const raw = req.query?.bbox;
    if (typeof raw !== "string") bad("bbox=south,west,north,east is required");
    const parts = raw.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || !parts.every(Number.isFinite)) bad("bbox must be four numbers: south,west,north,east");
    const bbox = { south: requireLat(parts[0]), west: requireLon(parts[1]), north: requireLat(parts[2]), east: requireLon(parts[3]) };
    if (bbox.south > bbox.north || bbox.west > bbox.east) bad("bbox must have south <= north and west <= east");
    const depth = await mods.zonesMod.frontierDepth(db);
    const unlocked = await mods.cellsMod.unlockedCellsNear(db, bbox, depth);
    const out = mods.zonesMod.classifyBbox(bbox, unlocked, { depth });
    // Only a MALFORMED bbox returns null now. classifyBbox iterates the user's
    // own history rather than the viewport, so there is no size ceiling and no
    // "zoom in" answer — that ceiling is what made fog unreachable at the
    // zooms where you can actually see the edge of your cleared ground.
    if (!out) bad("bbox must be four finite numbers: south,west,north,east");
    // Seed pips: which VISIBLE unlocked cells still have seed waiting. Asked of
    // the already-computed visible list, so the query is bounded by the
    // viewport rather than by everywhere the player has ever walked.
    const seedSet = new Set(
      await mods.walletMod.harvestableCells(db, out.unlocked.map((b) => b.cell), { now: Date.now() }),
    );
    res.json({ ...out, seed: out.unlocked.filter((b) => seedSet.has(b.cell)), depth });
  }));

  router.post("/api/ramble/nests/claim", handle(async (req, res) => {
    const b = req.body || {};
    if (typeof b.cell !== "string" || !mods.nestsMod.CELL7_RE.test(b.cell)) bad("cell must be a 7-character geohash");
    if (typeof b.week !== "string" || !mods.nestsMod.WEEK_RE.test(b.week)) bad("week must look like 2026-W37");
    const here = { lat: requireLat(b.lat), lon: requireLon(b.lon) };
    const result = await mods.flockMod.claimNest(db, { cell: b.cell, week: b.week, here, now: Date.now(), emit });
    if (result.claimed && !result.already) {
      poke("ramble:nest-claimed", { egg_id: result.egg?.egg_id ?? null, cell: b.cell });
    }
    res.json(result);
  }));

  // --- phase 4: everything around a point, for the AR view --------------------
  //
  // Rows as stored (teasers at their cell centre, exactly like /marks) plus a
  // distance each, and this week's nests. A read: it credits nothing —
  // visit_place stays on POST /api/ramble/area with `here`.
  router.get("/api/ramble/around", handle(async (req, res) => {
    const q = req.query || {};
    // Up to 17 decimals: String(double) can print that many, and the client
    // sends toFixed(6) anyway — a full-precision fix must never be a 400.
    if (typeof q.lat !== "string" || !/^-?\d{1,3}(\.\d{1,17})?$/.test(q.lat)) bad("lat must be a decimal number");
    if (typeof q.lon !== "string" || !/^-?\d{1,3}(\.\d{1,17})?$/.test(q.lon)) bad("lon must be a decimal number");
    const lat = requireLat(Number(q.lat));
    const lon = requireLon(Number(q.lon));
    const { AROUND_RADIUS_DEFAULT, AROUND_RADIUS_MIN, AROUND_RADIUS_MAX } = mods.aroundMod;
    let radiusM = AROUND_RADIUS_DEFAULT;
    if (q.radius_m != null) {
      if (typeof q.radius_m !== "string" || !/^\d{1,4}$/.test(q.radius_m)) bad("radius_m must be an integer number of metres");
      radiusM = Number(q.radius_m);
      if (radiusM < AROUND_RADIUS_MIN || radiusM > AROUND_RADIUS_MAX) bad(`radius_m must be between ${AROUND_RADIUS_MIN} and ${AROUND_RADIUS_MAX}`);
    }
    let out;
    try {
      out = await mods.aroundMod.aroundPoint(db, { lat, lon, radiusM, now: Date.now() });
    } catch (err) {
      if (err?.code === "too-wide") bad(err.message);
      throw err;
    }
    // aroundPoint owns the real bbox; this is just a bound for the unlocked
    // read, padded by the frontier depth inside unlockedCellsNear.
    const degLat = radiusM / 111320;
    const degLon = radiusM / (111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
    const bbox = { south: lat - degLat, west: lon - degLon, north: lat + degLat, east: lon + degLon };
    const depth = await mods.zonesMod.frontierDepth(db);
    const unlocked = await mods.cellsMod.unlockedCellsNear(db, bbox, depth);
    const gatedNests = mods.zonesMod.gateForZones(
      (out.nests || []).map((n) => ({ ...n, kind: "nest", origin: "remote", visibility: "public" })),
      { unlocked, depth, encode: mods.anchorsMod.encodeGeohash },
    ).map((n) => {
      if (n.beacon) return n;
      const { kind, origin, visibility, ...nest } = n;
      return nest;
    });
    res.json({ ...out, marks: await annotateMarks(out.marks), nests: gatedNests });
  }));

  // --- flock ----------------------------------------------------------------
  router.get("/api/ramble/flock", handle(async (req, res) => {
    res.json(await mods.flockMod.flockState(db, { now: Date.now() }));
  }));

  router.post("/api/ramble/eggs/:id/incubate", handle(async (req, res) => {
    if (!EGG_ID_RE.test(req.params.id)) bad("invalid egg id");
    const out = await mods.flockMod.incubateEgg(db, req.params.id, { now: Date.now(), emit });
    if (!out.ok) return res.status(out.reason === "not-found" ? 404 : 409).json({ error: out.reason });
    if (out.hatched) onHatch(out.hatched);
    res.json({ egg: out.egg, shelved: out.shelved, already: out.already, hatched: hatchedPayload(out) });
  }));

  router.post("/api/ramble/birds/:id/activate", handle(async (req, res) => {
    if (!EGG_ID_RE.test(req.params.id)) bad("invalid egg id");
    const out = await mods.flockMod.activateBird(db, req.params.id, { emit });
    if (!out.ok) return res.status(out.reason === "not-found" ? 404 : 409).json({ error: out.reason });
    // Spec 2026-09-08 §5: core listens (servers/sharing/profile-avatar.js) and
    // repaints the profile picture when the bird is the avatar source.
    poke("ramble:bird-activated", { egg_id: req.params.id });
    res.json({ bird: out.bird });
  }));

  // --- phase 3: contacts wire -------------------------------------------------
  router.get("/api/ramble/contacts", handle(async (req, res) => {
    try { res.json(await mods.deliveryMod.listAudiences(db)); }
    catch (err) {
      console.warn("[ramble routes] audiences unavailable:", err?.message ?? err);
      res.json({ contacts: [], groups: [] });
    }
  }));

  router.post("/api/ramble/eggs/:id/gift", handle(async (req, res) => {
    if (!EGG_ID_RE.test(req.params.id)) bad("invalid egg id");
    const b = req.body || {};
    if (typeof b.crow_id !== "string" || !CROW_ID_RE.test(b.crow_id)) bad("crow_id is required");
    const contact = await contactOrNull(b.crow_id);
    if (!contact) bad("unknown contact");
    const out = await mods.tradesMod.giftEgg(db, { eggId: req.params.id, toCrowId: contact.crow_id, now: Date.now(), emit });
    if (!out.ok) return res.status(tradeStatus(out)).json({ error: out.reason });
    poke("ramble:drain");
    poke("ramble:trade", { kind: "gift", trade_id: null, egg_id: out.egg.egg_id, state: "gifted" });
    res.json({ egg: out.egg, to: contact.crow_id });
  }));

  router.get("/api/ramble/trades", handle(async (req, res) => {
    const names = await contactNames();
    const trades = (await mods.tradesMod.listTrades(db, { now: Date.now(), limit: 20 }))
      .map((t) => ({ ...t, counterpart_name: names.get(t.counterpart) || t.counterpart }));
    res.json({ trades });
  }));

  router.post("/api/ramble/trades", handle(async (req, res) => {
    const b = req.body || {};
    if (typeof b.egg_id !== "string" || !EGG_ID_RE.test(b.egg_id)) bad("egg_id is required");
    if (typeof b.crow_id !== "string" || !CROW_ID_RE.test(b.crow_id)) bad("crow_id is required");
    const contact = await contactOrNull(b.crow_id);
    if (!contact) bad("unknown contact");
    const out = await mods.tradesMod.proposeSwap(db, { eggId: b.egg_id, toCrowId: contact.crow_id, now: Date.now(), emit });
    if (!out.ok) return res.status(tradeStatus(out)).json({ error: out.reason });
    poke("ramble:drain");
    poke("ramble:trade", { kind: "trade", trade_id: out.trade.trade_id, egg_id: b.egg_id, state: "proposed" });
    res.status(201).json({ trade: out.trade });
  }));

  router.post("/api/ramble/trades/:id/accept", handle(async (req, res) => {
    if (!TRADE_ID_RE.test(req.params.id)) bad("invalid trade id");
    const b = req.body || {};
    if (typeof b.egg_id !== "string" || !EGG_ID_RE.test(b.egg_id)) bad("egg_id is required");
    const out = await mods.tradesMod.acceptSwap(db, { tradeId: req.params.id, eggId: b.egg_id, now: Date.now(), emit });
    if (!out.ok) return res.status(tradeStatus(out)).json({ error: out.reason });
    poke("ramble:drain");
    poke("ramble:trade", { kind: "trade", trade_id: out.trade.trade_id, egg_id: b.egg_id, state: "accepted" });
    res.json({ trade: out.trade });
  }));

  router.post("/api/ramble/trades/:id/decline", handle(async (req, res) => {
    if (!TRADE_ID_RE.test(req.params.id)) bad("invalid trade id");
    const out = await mods.tradesMod.declineSwap(db, { tradeId: req.params.id, now: Date.now(), emit });
    if (!out.ok) return res.status(tradeStatus(out)).json({ error: out.reason });
    poke("ramble:drain");
    poke("ramble:trade", { kind: "trade", trade_id: out.trade.trade_id, egg_id: out.trade.my_egg_id ?? null, state: "declined" });
    res.json({ trade: out.trade });
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
