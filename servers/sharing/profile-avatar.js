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
 * export). Triggers: the in-process bus events `ramble:hatched` (the panel
 * routes and the transport already poke it) and `ramble:bird-activated` (the
 * activate route). A hatch inside the stdio Ramble MCP process has no bus to
 * this process; the next gateway-side hatch/activation/profile save repaints.
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

let _engine; // undefined = not tried yet; null = unavailable
export function loadBirdEngine({ candidates = birdEngineCandidates(), fresh = false } = {}) {
  if (_engine !== undefined && !fresh) return _engine;
  _engine = null;
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const mod = require(p);
      if (typeof mod?.rollGenome === "function" && typeof mod?.drawBird === "function") { _engine = mod; break; }
    } catch { /* try the next candidate */ }
  }
  return _engine;
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

/** Pure: the "happy" portrait as an SVG data URI, validated; null on any engine complaint. */
export function renderBirdAvatar(bird, engine = loadBirdEngine()) {
  if (!bird || !engine) return null;
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
      + engine.drawBird(engine.rollGenome(bird.seed, bird.species), "happy") + "</svg>";
    return validateAvatar("data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64"));
  } catch { return null; }
}

export async function renderActiveBirdAvatar(db) {
  return renderBirdAvatar(await readActiveBird(db));
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
 * bird (Ramble gone, nothing hatched, no engine): the source falls back to
 * `picture`, the last stored image stays. Otherwise: re-render; if the
 * portrait differs from what is stored, store it and broadcast ONCE; if it is
 * the same but the last fan-out was incomplete (pending flag), re-send.
 * Never throws.
 */
export async function refreshBirdAvatar(db, managers) {
  try {
    const { avatar, source } = await readProfilePictureSettings(db);
    if (source !== "bird") return { changed: false, reason: "source-picture" };
    const uri = await renderActiveBirdAvatar(db);
    if (!uri) {
      await upsertSetting(db, "profile_avatar_source", "picture");
      await deleteLocalSetting(db, "profile_avatar_source");
      return { changed: true, reason: "no-bird" };
    }
    if (uri === avatar) {
      // R2-S3: the picture is right, but did the last fan-out reach everyone?
      if (!(await readBroadcastPending(db))) return { changed: false, reason: "same" };
      const sent = await broadcastProfile(db, managers?.nostrManager);
      return { changed: false, reason: "resend", sent };
    }
    await upsertSetting(db, "profile_avatar_url", uri);
    await deleteLocalSetting(db, "profile_avatar_url");
    const sent = await broadcastProfile(db, managers?.nostrManager);
    return { changed: true, reason: "rendered", sent };
  } catch (err) {
    try { console.warn("[sharing] bird avatar refresh failed:", err?.message); } catch {}
    return { changed: false, reason: "error" };
  }
}

let _hooksInstalled = false;
/** Once per process: repaint on a hatch or an activation. Idempotent inside, so a hatch that changed nothing is free. */
export function installBirdAvatarHooks(managers, { emitter = bus } = {}) {
  if (_hooksInstalled) return false;
  _hooksInstalled = true;
  const run = () => { refreshBirdAvatar(managers?.db, managers).catch(() => {}); };
  emitter.on("ramble:hatched", run);
  emitter.on("ramble:bird-activated", run);
  // R1-Q2: the bird may have changed while this gateway was down (or in the
  // stdio MCP process, which has no bus to us) — one idempotent repaint at boot.
  run();
  return true;
}
export function __resetBirdAvatarHooksForTest() { _hooksInstalled = false; }
