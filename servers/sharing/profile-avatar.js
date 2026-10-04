/**
 * The Ramble bird as the profile picture (spec 2026-09-08 §5, decision D6).
 *
 * Core-side on purpose: the picture is a Crow profile setting and the
 * broadcast needs the ONE live NostrManager. Ramble is reached two ways, both
 * skew-proof: the active bird is read by raw SQL from ramble_pet/ramble_eggs
 * (tables since 0.2.0; any error = no bird), and the drawing engine is the
 * bundle's dependency-free bird-svg.cjs loaded from the INSTALLED copy first
 * (what the gateway runs), then the repo tree — using only `rollGenome` and
 * `drawBird`, exports that have existed since the engine shipped, so an older
 * installed copy still renders (Plan A ruling R1-1: core needs no NEW bundle
 * export). Phase 4: the portrait carries the bird's REAL mood (D2 — a
 * neglected bird looks it to contacts; core keeps its own copy of pet.js's
 * decay-on-read) and its outfit (spec §5.3), drawn with the engine's
 * `applyOutfit` when the loaded engine has it — an older engine draws the
 * plain bird and never overwrites a dressed picture. Triggers: the in-process
 * bus events `ramble:hatched` (the panel routes and the transport already
 * poke it), `ramble:bird-activated` (the activate route) and
 * `ramble:outfit-changed` (the wear route) and `ramble:walked-changed` (the
 * walked-today badge), plus a periodic tick for what has
 * no event (decay crossing a mood threshold, the badge clearing after local
 * midnight (within one tick), an outfit changed on another
 * instance arriving by sync). Triggers are COALESCED (§5.4) into one settled
 * refresh, and the tick and debounced runs are GATED on this instance's own
 * render inputs, so the user's instances never ping-pong the replicated
 * picture. A hatch inside the stdio Ramble MCP process has no bus to this
 * process; the next gateway-side trigger or tick repaints.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import bus from "../shared/event-bus.js";
import { validateAvatar } from "./avatar.js";
import { upsertSetting, deleteLocalSetting } from "../gateway/dashboard/settings/registry.js";
import { broadcastProfile, readBroadcastPending } from "./peer-profile.js";

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));

/** Same order as servers/gateway/boot/feature-mounts.js: installed copy, then the repo. */
export function birdEngineCandidates() {
  const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
  return [
    join(crowHome, "bundles", "ramble", "server", "bird-svg.cjs"),
    join(__dir, "..", "..", "bundles", "ramble", "server", "bird-svg.cjs"),
  ];
}

/* Core's own copy of pet.js's decay-on-read and moodFor — core never imports
 * a bundle module at runtime (an installed copy may be older or absent).
 * tests/profile-avatar-bird.test.js pins these to pet.js's exports. */
const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DECAY_PER_INTERVAL = 10;
const MOODS = new Set(["happy", "tired", "alarmed"]);
export const AVATAR_SETTLE_MS = 20_000;
export const AVATAR_TICK_MS = 30 * 60_000;

/* Deploy day: the gateway can load the bird engine BEFORE bundle repair
 * copies the new installed bird-svg.cjs in (boot order: sharing boot runs
 * the hooks' boot repaint before mcp-mounts' repairInstalledBundleAssets),
 * and require() caches the module — so an engine without applyOutfit or drawWalkBadge is
 * re-probed, at most once a minute, with its require-cache entries dropped.
 * Implemented inside loadBirdEngine's DEFAULT-candidates path only. */
const ENGINE_REPROBE_MS = 60_000;

/* What THIS instance last rendered, per db handle. In memory on purpose: it
 * is a per-process anti-ping-pong memo, not state — a restart's boot repaint
 * is ungated and re-establishes it. */
let _lastInputs = new WeakMap();

let _engine; // undefined = not tried yet; null = unavailable
let _engineProbedAt = 0;
export function loadBirdEngine({ candidates, fresh = false, now = Date.now() } = {}) {
  // Fix round 1, Finding 4: a probe called with EXPLICIT candidates (a test
  // deliberately pointing at a nonexistent path) must never write the
  // module-level cache — only a call using the real default candidate list
  // is allowed to warm or poison it. Before this fix, a failing explicit
  // probe left `_engine` null for every later DEFAULT caller (e.g. a bare
  // `renderBirdAvatar(bird)`), so a bird would silently stop rendering until
  // something happened to re-warm the cache.
  const usingDefaults = candidates === undefined;
  if (usingDefaults && _engine !== undefined && !fresh) {
    const stale = _engine && (typeof _engine.applyOutfit !== "function" || typeof _engine.drawWalkBadge !== "function")
      && now - _engineProbedAt >= ENGINE_REPROBE_MS;
    if (!stale) return _engine;
    fresh = true; // fall through to a re-probe
  }
  const list = usingDefaults ? birdEngineCandidates() : candidates;
  let found = null;
  for (const p of list) {
    try {
      if (!existsSync(p)) continue;
      if (fresh) { try { delete require.cache[require.resolve(p)]; } catch {} }
      const mod = require(p);
      if (typeof mod?.rollGenome === "function" && typeof mod?.drawBird === "function") { found = mod; break; }
    } catch { /* try the next candidate */ }
  }
  if (usingDefaults) { _engine = found; _engineProbedAt = now; }
  return found;
}

/** The active, hatched bird, or null (no Ramble tables, no pet, nothing hatched). Never throws. */
export async function readActiveBird(db) {
  try {
    const { rows } = await db.execute({
      sql: `SELECT e.egg_id, e.species, e.seed FROM ramble_pet p
            JOIN ramble_eggs e ON e.egg_id = p.active_egg_id
            WHERE p.owner = 'self' AND e.status = 'hatched' AND e.species IS NOT NULL AND e.seed IS NOT NULL
            LIMIT 1`,
      args: [],
    });
    const r = rows?.[0];
    return r ? { egg_id: r.egg_id, species: String(r.species), seed: Number(r.seed) } : null;
  } catch { return null; }
}

/** D2: the mood pet.js's petState would report on read (decay applied, nothing written). Never throws. */
export function portraitMood(energy, lastFedAt, now = Date.now()) {
  let e = Number(energy);
  if (energy == null || !Number.isFinite(e)) return "happy";
  const fed = Number(lastFedAt);
  if (lastFedAt != null && Number.isFinite(fed) && now - fed >= DECAY_INTERVAL_MS) {
    e = Math.max(0, e - Math.floor((now - fed) / DECAY_INTERVAL_MS) * DECAY_PER_INTERVAL);
  }
  return e >= 60 ? "happy" : e >= 30 ? "tired" : "alarmed";
}

/**
 * eggs.js's localDay, copied: core never imports the bundle (an installed copy
 * may be older or absent). tests/profile-avatar-bird.test.js pins the two.
 */
export function portraitDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The active bird as it should look to contacts: mood + outfit. Never throws. */
export async function readPortrait(db, { now = Date.now() } = {}) {
  const bird = await readActiveBird(db);
  if (!bird) return null;
  let mood = "happy";
  try {
    const { rows } = await db.execute({ sql: "SELECT energy, last_fed_at FROM ramble_pet WHERE owner = 'self'", args: [] });
    if (rows[0]) mood = portraitMood(rows[0].energy, rows[0].last_fed_at, now);
  } catch { /* default bird */ }
  let outfit = null;
  try {
    // Its own query: on an older bundle's table the column is absent, and that
    // must cost the outfit, never the whole portrait.
    const { rows } = await db.execute({ sql: "SELECT outfit_json FROM ramble_eggs WHERE egg_id = ?", args: [bird.egg_id] });
    const raw = rows[0]?.outfit_json;
    if (typeof raw === "string" && raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) outfit = parsed;
    }
  } catch { outfit = null; }
  // Spec 2026-10-04 §8 / R11: contacts get ONE boolean from walking — the
  // `walked` fact the bundle writes — never a count.
  let walked = false;
  try {
    const { rows } = await db.execute({
      sql: "SELECT 1 FROM ramble_wallet WHERE kind = 'walked' AND key = ? LIMIT 1",
      args: [portraitDay(now)],
    });
    walked = rows.length > 0;
  } catch { walked = false; }
  return { ...bird, mood, outfit, walked };
}

/** Pure: the portrait (mood default "happy", outfit default none) as an SVG data URI, validated; null on any engine complaint. */
export function renderBirdAvatar(bird, engine = loadBirdEngine()) {
  if (!bird || !engine) return null;
  try {
    let genome = engine.rollGenome(bird.seed, bird.species);
    // applyOutfit validates against its own slot table; an older installed
    // engine without it simply draws the plain bird.
    if (bird.outfit && typeof engine.applyOutfit === "function") genome = engine.applyOutfit(genome, bird.outfit);
    const mood = MOODS.has(bird.mood) ? bird.mood : "happy";
    // An older installed engine has no badge: it draws the plain bird.
    const badge = bird.walked === true && typeof engine.drawWalkBadge === "function" ? engine.drawWalkBadge() : "";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
      + engine.drawBird(genome, mood) + badge + "</svg>";
    return validateAvatar("data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64"));
  } catch { return null; }
}

export async function renderActiveBirdAvatar(db, { now = Date.now() } = {}) {
  return renderBirdAvatar(await readPortrait(db, { now }));
}

async function readProfilePictureSettings(db) {
  const out = { avatar: null, source: "picture" };
  const { rows } = await db.execute({
    sql: "SELECT key, value FROM dashboard_settings WHERE key IN ('profile_avatar_url', 'profile_avatar_source')",
    args: [],
  });
  for (const r of rows || []) {
    if (r.key === "profile_avatar_url") out.avatar = typeof r.value === "string" ? r.value : null;
    else if (r.key === "profile_avatar_source" && r.value === "bird") out.source = "bird";
  }
  return out;
}

/**
 * Bird -> picture refresh. Source `picture`: nothing. Source `bird` with no
 * bird (Ramble gone, nothing hatched, no engine): a no-op — the last stored
 * image stays AND `profile_avatar_source` is left untouched (Fix round 1,
 * Finding 1, CRITICAL: `profile_avatar_source` is a REPLICATED setting, and
 * this refresh runs unconditionally at boot on every instance, including a
 * Ramble-less or not-yet-hatched one — an unconditional write here would
 * revert the user's bird choice fleet-wide on every such boot. The
 * fallback-to-picture write belongs to the user-present save path, which is
 * unaffected by this change). Otherwise: re-render; if the portrait differs
 * from what is stored, store it and broadcast ONCE; if it is the same but
 * the last fan-out was incomplete (pending flag), re-send. Never throws.
 *
 * Phase 4 options (the defaults keep every existing direct-call behaviour):
 * - `resend: false` never re-sends a stuck pending fan-out (neither the
 *   picture-source nor the bird-source branch) — the periodic tick uses it so
 *   a dead contact's pending flag never turns every tick into a fan-out.
 * - `gate: true` returns `inputs-same` when THIS instance's own render inputs
 *   ([species, seed, mood, outfit, walked]) are unchanged since it last rendered,
 *   without comparing to the stored picture — that picture is REPLICATED and
 *   another of the user's instances may legitimately draw it differently
 *   (engine skew, local decay skew); comparing would make them ping-pong.
 * - A bird wearing a non-empty outfit + an engine without `applyOutfit`
 *   returns `engine-too-old`: an instance that cannot draw the outfit never
 *   overwrites a dressed picture with a plain one.
 */
export async function refreshBirdAvatar(db, managers, { gate = false, resend = true, now = Date.now(), engine = loadBirdEngine() } = {}) {
  try {
    const { avatar, source } = await readProfilePictureSettings(db);
    if (source !== "bird") {
      // The picture source has no other consumer of the pending flag besides
      // the profile save handler, so a fan-out left incomplete while the
      // source was picture would otherwise sit unsent until the user next
      // opens My Profile. Self-heal it here too, same as the bird path below.
      if (resend && (await readBroadcastPending(db))) {
        return { changed: false, reason: "resend", sent: await broadcastProfile(db, managers?.nostrManager) };
      }
      return { changed: false, reason: "source-picture" };
    }
    const bird = await readPortrait(db, { now });
    if (!bird || !engine) return { changed: false, reason: "no-bird" };
    // An engine that cannot dress the bird must not replace a dressed
    // picture with a plain one (the user's other, newer instance drew it).
    const dressed = !!bird.outfit && Object.keys(bird.outfit).length > 0;
    if (dressed && typeof engine.applyOutfit !== "function") return { changed: false, reason: "engine-too-old" };
    // Same guard for the walked badge (an old engine must not overwrite a badged picture).
    if (bird.walked === true && typeof engine.drawWalkBadge !== "function") return { changed: false, reason: "engine-too-old" };
    const inputs = JSON.stringify([bird.species, bird.seed, bird.mood, bird.outfit || {}, bird.walked === true]);
    if (gate && _lastInputs.get(db) === inputs) {
      // The stored picture is REPLICATED: another of the user's instances may
      // have drawn it from slightly different inputs. Only a change in our own
      // inputs is a reason to repaint — never "stored differs from mine".
      if (resend && (await readBroadcastPending(db))) {
        return { changed: false, reason: "resend", sent: await broadcastProfile(db, managers?.nostrManager) };
      }
      return { changed: false, reason: "inputs-same" };
    }
    const uri = renderBirdAvatar(bird, engine);
    if (!uri) return { changed: false, reason: "no-bird" };
    if (uri === avatar) {
      _lastInputs.set(db, inputs);
      // R2-S3: the picture is right, but did the last fan-out reach everyone?
      if (!resend || !(await readBroadcastPending(db))) return { changed: false, reason: "same" };
      const sent = await broadcastProfile(db, managers?.nostrManager);
      return { changed: false, reason: "resend", sent };
    }
    await upsertSetting(db, "profile_avatar_url", uri);
    // Memo only AFTER the store succeeded: a busy-db throw above must leave
    // the next gated run free to try again, not freeze a stale picture.
    _lastInputs.set(db, inputs);
    // Fix round 1, Finding 3: a stale local override for this key is
    // cosmetic; losing the broadcast between "picture stored" and "fan-out
    // sent" is not. deleteLocalSetting touches the filesystem (instance id)
    // and can hit a busy database — never let that skip the broadcast below.
    try { await deleteLocalSetting(db, "profile_avatar_url"); } catch (err) {
      try { console.warn("[sharing] bird avatar: deleteLocalSetting(profile_avatar_url) failed (non-fatal):", err?.message); } catch {}
    }
    const sent = await broadcastProfile(db, managers?.nostrManager);
    return { changed: true, reason: "rendered", sent };
  } catch (err) {
    try { console.warn("[sharing] bird avatar refresh failed:", err?.message); } catch {}
    return { changed: false, reason: "error" };
  }
}

let _hooksInstalled = false;
let _settleTimer = null;
let _tickTimer = null;
/**
 * Once per process. §5.4: outfits and mood both feed the picture, and every
 * change re-broadcasts to every contact — so triggers are COALESCED: each
 * (re)arms one settle timer and only its firing runs a refresh, so trying on
 * four hats sends one picture. Runs stay serialized (the promise chain, fix
 * round 1 Finding 2). Debounced runs are GATED on this instance's own inputs
 * (no ping-pong between the user's instances over the replicated picture).
 * The tick covers what has no event — decay crossing a mood threshold, an
 * outfit changed on another instance arriving by sync — and never re-sends a
 * stuck pending fan-out; only a real bus event retries that.
 */
export function installBirdAvatarHooks(managers, { emitter = bus, settleMs = AVATAR_SETTLE_MS, tickMs = AVATAR_TICK_MS } = {}) {
  if (_hooksInstalled) return false;
  _hooksInstalled = true;
  // Fix round 1, Finding 2: two triggers landing in the same tick (two
  // transports each emitting a hatch, an activation racing the boot
  // repaint) must not both read the pre-write picture and both broadcast —
  // and must not let one run's success clear the pending flag while
  // another's fan-out is still failing. A promise chain serializes: the
  // second refreshBirdAvatar call does not start until the first's full
  // read-render-write-broadcast has finished, so it re-reads the
  // already-updated picture and takes the no-op/resend branch instead.
  let inflight = Promise.resolve();
  const run = (opts) => { inflight = inflight.then(() => refreshBirdAvatar(managers?.db, managers, opts)).catch(() => {}); };
  // True only if at least one bus EVENT (not just the tick) armed the
  // current settle window — the tick alone never re-sends a pending fan-out.
  let wantResend = false;
  const schedule = (fromEvent) => {
    if (fromEvent) wantResend = true;
    if (_settleTimer) clearTimeout(_settleTimer);
    _settleTimer = setTimeout(() => {
      _settleTimer = null;
      const resend = wantResend;
      wantResend = false;
      run({ gate: true, resend });
    }, Math.max(0, Number(settleMs) || 0));
    _settleTimer.unref?.();
  };
  const onEvent = () => schedule(true);
  emitter.on("ramble:hatched", onEvent);
  emitter.on("ramble:bird-activated", onEvent);
  emitter.on("ramble:outfit-changed", onEvent);
  emitter.on("ramble:walked-changed", onEvent);
  if (Number(tickMs) > 0) {
    _tickTimer = setInterval(() => schedule(false), Number(tickMs));
    _tickTimer.unref?.();
  }
  // R1-Q2: the bird may have changed while this gateway was down (or in the
  // stdio MCP process, which has no bus to us) — one idempotent repaint at
  // boot, not debounced and not gated.
  run({});
  return true;
}
export function __resetBirdAvatarHooksForTest() {
  _hooksInstalled = false; _engine = undefined; _lastInputs = new WeakMap();
  if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}
