/**
 * Spec 2026-09-08 §5: with profile_avatar_source = bird, the active Ramble
 * bird's portrait (bird-svg.cjs, "happy", 200x200 viewBox) is the profile
 * picture as an SVG data URI, refreshed on the bus events a hatch and an
 * activation emit, broadcast once when it changed, and the source falls back
 * to `picture` when there is no bird. Core reads the Ramble tables by raw
 * SQL and loads ONLY the engine exports that have existed since 0.2.0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createClient } from "@libsql/client";

import {
  birdEngineCandidates, loadBirdEngine, readActiveBird, renderBirdAvatar, renderActiveBirdAvatar,
  refreshBirdAvatar, installBirdAvatarHooks, __resetBirdAvatarHooksForTest,
  portraitMood, readPortrait, portraitDay, AVATAR_SETTLE_MS, AVATAR_TICK_MS,
} from "../servers/sharing/profile-avatar.js";
import { validateAvatar, AVATAR_MAX_BYTES } from "../servers/sharing/avatar.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { PROFILE_BROADCAST_PENDING_KEY, readBroadcastPending } from "../servers/sharing/peer-profile.js";
import { applyRambleEgg } from "../servers/sharing/instance-sync.js";
import { localDay } from "../bundles/ramble/server/eggs.js";
import { moodFor, DECAY_INTERVAL_MS, DECAY_PER_INTERVAL } from "../bundles/ramble/server/pet.js";

const REPO_ENGINE = join(import.meta.dirname, "..", "bundles", "ramble", "server", "bird-svg.cjs");

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "bird-avatar-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir; // deleteLocalSetting resolves the local instance id from here
  setSettingsSyncManager(null);
  return {
    db, dir,
    cleanup() {
      try { db.close(); } catch {}
      setSettingsSyncManager(null);
      if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const setting = async (db, key) => (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value ?? null;
const putSetting = (db, key, value) => db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [key, value] });
async function plantBird(db, { eggId = "b1", species = "crow", seed = 123456 } = {}) {
  await initRambleTables(db);
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES (?, 'hatched', 100, ?, ?, 1, 2) ON CONFLICT(egg_id) DO UPDATE SET species = excluded.species, seed = excluded.seed", args: [eggId, species, seed] });
  await db.execute({ sql: "INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', ?) ON CONFLICT(owner) DO UPDATE SET active_egg_id = excluded.active_egg_id", args: [eggId] });
}
const mgrsWith = (db, sent) => ({ db, nostrManager: { sendControl: async (c, content) => { sent.push({ c, content }); return { eventId: "e", relays: ["r"] }; } } });
const seedContact = (db) => db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:pal', 'Pal', ?, ?)", args: ["d".repeat(64), "02" + "a".repeat(64)] });
const settle = async (db, key, want) => { for (let i = 0; i < 50 && (await setting(db, key)) !== want; i++) await new Promise((r) => setTimeout(r, 20)); };

test("renderBirdAvatar: a deterministic SVG data URI under the cap; species/seed sensitive; junk is null", () => {
  const a = renderBirdAvatar({ species: "crow", seed: 123456 });
  assert.ok(a.startsWith("data:image/svg+xml;base64,"));
  assert.equal(validateAvatar(a), a, "passes the avatar validator");
  assert.ok(a.length < AVATAR_MAX_BYTES / 4, `a bird is small (${a.length} chars)`);
  const svg = Buffer.from(a.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'));
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(svg.includes("<ellipse"), "the engine's body");
  assert.equal(renderBirdAvatar({ species: "crow", seed: 123456 }), a, "deterministic");
  assert.notEqual(renderBirdAvatar({ species: "crow", seed: 123457 }), a);
  assert.notEqual(renderBirdAvatar({ species: "raven", seed: 123456 }), a);
  assert.equal(renderBirdAvatar({ species: "dodo", seed: 1 }), null, "an unknown species never throws");
  assert.equal(renderBirdAvatar({ species: "crow", seed: -1 }), null);
  assert.equal(renderBirdAvatar(null), null);
  assert.equal(renderBirdAvatar({ species: "crow", seed: 1 }, null), null, "no engine, no picture");
});

test("loadBirdEngine: installed copy first, then the repo; only rollGenome + drawBird are required; nothing found = null", () => {
  const cands = birdEngineCandidates();
  assert.equal(cands.length, 2);
  assert.ok(cands[0].includes(join("bundles", "ramble", "server", "bird-svg.cjs")));
  assert.equal(cands[1], REPO_ENGINE);
  const engine = loadBirdEngine({ candidates: ["/nonexistent/bird-svg.cjs", REPO_ENGINE], fresh: true });
  assert.equal(typeof engine?.rollGenome, "function");
  assert.equal(typeof engine?.drawBird, "function");
  assert.equal(loadBirdEngine({ candidates: ["/nonexistent/a.cjs", "/nonexistent/b.cjs"], fresh: true }), null);
  assert.ok(loadBirdEngine({ fresh: true }), "the default candidates resolve in the repo");
});

test("readActiveBird: null with no Ramble tables, no pet, an unhatched active egg; the bird otherwise", async () => {
  const bare = createClient({ url: "file::memory:" });
  assert.equal(await readActiveBird(bare), null, "no tables = no bird, no throw");
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  assert.equal(await readActiveBird(db), null, "no pet row");
  await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('e1', 'incubating', 1, 1)");
  await db.execute("INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', 'e1')");
  assert.equal(await readActiveBird(db), null, "an unhatched active egg is not a bird");
  await plantBird(db, { eggId: "b1", species: "magpie", seed: 4242 });
  assert.deepEqual(await readActiveBird(db), { egg_id: "b1", species: "magpie", seed: 4242 });
  assert.equal(await renderActiveBirdAvatar(db), renderBirdAvatar({ species: "magpie", seed: 4242 }));
});

test("refreshBirdAvatar: no-op for source picture; falls back to picture with no bird; renders, stores and broadcasts once for a bird; idempotent", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    const sent = [];
    const managers = mgrsWith(db, sent);
    assert.deepEqual(await refreshBirdAvatar(db, managers), { changed: false, reason: "source-picture" });

    await putSetting(db, "profile_avatar_source", "bird");
    await putSetting(db, "profile_avatar_url", "data:image/png;base64," + "A".repeat(16));
    assert.deepEqual(await refreshBirdAvatar(db, managers), { changed: false, reason: "no-bird" });
    assert.equal(await setting(db, "profile_avatar_source"), "bird", "a background refresh never reverts the user's REPLICATED choice (fix round 1, Finding 1, CRITICAL)");
    assert.equal(await setting(db, "profile_avatar_url"), "data:image/png;base64," + "A".repeat(16), "the last stored image stays");
    assert.equal(sent.length, 0, "nothing to say");

    await plantBird(db, { eggId: "b1", species: "crow", seed: 7 });
    await putSetting(db, "profile_avatar_source", "bird");
    let r = await refreshBirdAvatar(db, managers);
    assert.equal(r.changed, true);
    assert.equal(r.reason, "rendered");
    assert.deepEqual(r.sent, { sent: 1, failed: 0, skipped: 0 });
    const uri = renderBirdAvatar({ species: "crow", seed: 7 });
    assert.equal(await setting(db, "profile_avatar_url"), uri);
    assert.equal(JSON.parse(sent[0].content).payload.avatar, uri, "the broadcast carries the bird");

    r = await refreshBirdAvatar(db, managers);
    assert.deepEqual(r, { changed: false, reason: "same" });
    assert.equal(sent.length, 1, "no second broadcast for the same bird");

    await plantBird(db, { eggId: "b2", species: "raven", seed: 9 });
    r = await refreshBirdAvatar(db, managers);
    assert.equal(r.reason, "rendered");
    assert.equal(await setting(db, "profile_avatar_url"), renderBirdAvatar({ species: "raven", seed: 9 }), "a new active bird repaints");
    assert.equal(sent.length, 2);

    assert.equal((await refreshBirdAvatar({ execute: async () => { throw new Error("boom"); } }, managers)).changed, false, "never throws");
  } finally { cleanup(); }
});

test("refreshBirdAvatar: source picture with a pending fan-out re-sends and clears the flag; with nothing pending it stays a true no-op (fix round, item 3)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    const sent = [];
    const managers = mgrsWith(db, sent);

    // Nothing has armed the flag on a fresh db — source-picture stays a pure no-op.
    assert.equal(await readBroadcastPending(db), false, "fresh db: nothing pending");
    assert.deepEqual(await refreshBirdAvatar(db, managers), { changed: false, reason: "source-picture" });
    assert.equal(sent.length, 0, "no resend when nothing was pending");

    // Arm the flag the same way a save made offline would: a picture-source
    // profile is not currently reflected, but the pending flag has no other
    // consumer besides the profile save handler, so plant it directly.
    await putSetting(db, PROFILE_BROADCAST_PENDING_KEY, "1");
    assert.equal(await readBroadcastPending(db), true);

    const r = await refreshBirdAvatar(db, managers);
    assert.deepEqual(r, { changed: false, reason: "resend", sent: { sent: 1, failed: 0, skipped: 0 } }, "the picture source self-heals a stranded fan-out too");
    assert.equal(sent.length, 1);
    assert.equal(await readBroadcastPending(db), false, "the resend cleared the flag");

    // A second refresh with nothing pending is quiet again.
    const r2 = await refreshBirdAvatar(db, managers);
    assert.deepEqual(r2, { changed: false, reason: "source-picture" });
    assert.equal(sent.length, 1, "no extra resend once the flag is clear");
  } finally { cleanup(); }
});

test("refreshBirdAvatar: no bird emits NO settings sync op for profile_avatar_source (fix round 1, Finding 1, CRITICAL — a REPLICATED setting must not flip on a per-instance boot repaint)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await putSetting(db, "profile_avatar_source", "bird");
    // The same recording seam profile-sync-allowlist.test.js / profile-heal.test.js
    // use to pin "did this write replicate": a manager whose emitChange
    // records every dashboard_settings sync op this refresh causes.
    const emitted = [];
    setSettingsSyncManager({ feedsDisabled: false, emitChange: async (t, op, row) => { emitted.push({ t, op, row }); } });
    let r;
    try {
      r = await refreshBirdAvatar(db, mgrsWith(db, []));
    } finally {
      setSettingsSyncManager(null);
    }
    assert.deepEqual(r, { changed: false, reason: "no-bird" });
    assert.ok(
      !emitted.some((e) => e.row?.key === "profile_avatar_source"),
      "no sync op for profile_avatar_source: a background repaint on a Ramble-less/not-yet-hatched instance must never write, let alone replicate, this key"
    );
  } finally { cleanup(); }
});

test("refreshBirdAvatar: a fan-out that failed (relays down) is re-sent by the next refresh even though the picture is unchanged (R2-S3)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 21 });
    await putSetting(db, "profile_avatar_source", "bird");
    const down = { db, nostrManager: { sendControl: async () => { throw new Error("relay down"); } } };
    let r = await refreshBirdAvatar(db, down);
    assert.equal(r.reason, "rendered");
    assert.deepEqual(r.sent, { sent: 0, failed: 1, skipped: 0 });
    const sent = [];
    r = await refreshBirdAvatar(db, mgrsWith(db, sent));
    assert.equal(r.reason, "resend", "same picture, but the peers never got it");
    assert.deepEqual(r.sent, { sent: 1, failed: 0, skipped: 0 });
    assert.equal(sent.length, 1);
    r = await refreshBirdAvatar(db, mgrsWith(db, sent));
    assert.deepEqual(r, { changed: false, reason: "same" }, "delivered once, quiet afterwards");
    assert.equal(sent.length, 1);
  } finally { cleanup(); }
});

test("installBirdAvatarHooks: a hatch or an activation on the bus refreshes; installs once", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db); // the sent.length assertions need a recipient (R2-C1)
    await plantBird(db, { eggId: "b1", species: "penguin", seed: 11 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const emitter = new EventEmitter();
    assert.equal(installBirdAvatarHooks(mgrsWith(db, sent), { emitter, settleMs: 0, tickMs: 0 }), true);
    assert.equal(installBirdAvatarHooks(mgrsWith(db, sent), { emitter, settleMs: 0, tickMs: 0 }), false, "second install is a no-op");
    const first = renderBirdAvatar({ species: "penguin", seed: 11 });
    await settle(db, "profile_avatar_url", first);
    assert.equal(await setting(db, "profile_avatar_url"), first, "installing repaints once (a bird that changed while we were down)");
    assert.equal(sent.length, 1);
    await plantBird(db, { eggId: "b2", species: "grackle", seed: 12 });
    emitter.emit("ramble:hatched", { egg_id: "b2", species: "grackle", seed: 12 });
    const second = renderBirdAvatar({ species: "grackle", seed: 12 });
    await settle(db, "profile_avatar_url", second);
    assert.equal(await setting(db, "profile_avatar_url"), second, "a hatch repaints");
    await plantBird(db, { eggId: "b3", species: "magpie", seed: 13 });
    emitter.emit("ramble:bird-activated", { egg_id: "b3" });
    const third = renderBirdAvatar({ species: "magpie", seed: 13 });
    await settle(db, "profile_avatar_url", third);
    assert.equal(await setting(db, "profile_avatar_url"), third, "an activation repaints");
    assert.equal(sent.length, 3, "one broadcast per real change");
    assert.equal(emitter.listenerCount("ramble:hatched"), 1);
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("installBirdAvatarHooks: two triggers landing in the same tick serialize — exactly one broadcast, no lost pending flag (fix round 1, Finding 2)", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 77 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const emitter = new EventEmitter();
    installBirdAvatarHooks(mgrsWith(db, sent), { emitter, settleMs: 0, tickMs: 0 });
    const first = renderBirdAvatar({ species: "crow", seed: 77 });
    await settle(db, "profile_avatar_url", first);
    assert.equal(sent.length, 1, "the install-time repaint");

    await plantBird(db, { eggId: "b2", species: "magpie", seed: 78 });
    // Two triggers fired back-to-back, synchronously, in the same tick —
    // this is exactly the "two transports both emit the hatch" / "an
    // activation racing the boot repaint" shape the finding calls out.
    emitter.emit("ramble:hatched", { egg_id: "b2", species: "magpie", seed: 78 });
    emitter.emit("ramble:bird-activated", { egg_id: "b2" });
    const second = renderBirdAvatar({ species: "magpie", seed: 78 });
    await settle(db, "profile_avatar_url", second);
    // Give the second, chained (and now redundant) refresh time to finish
    // draining before asserting the broadcast count.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await setting(db, "profile_avatar_url"), second);
    assert.equal(sent.length, 2, "exactly one NEW broadcast for the two overlapping triggers, not two");
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("portraitMood is exactly pet.js's decay-on-read + moodFor (core keeps its own copy for skew; this pins them together)", () => {
  assert.equal(DECAY_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.equal(DECAY_PER_INTERVAL, 10);
  const T = 1_760_000_000_000;
  for (const energy of [0, 29, 30, 59, 60, 61, 100, 250]) for (const k of [0, 1, 2, 3, 7]) {
    const expected = moodFor(Math.max(0, energy - k * DECAY_PER_INTERVAL));
    assert.equal(portraitMood(energy, T, T + k * DECAY_INTERVAL_MS + 1), expected, `${energy}/${k}`);
  }
  assert.equal(portraitMood(10, null, T), "alarmed", "never fed = no decay, mood from energy");
  assert.equal(portraitMood("junk", null, T), "happy", "junk energy reads as the default bird, never throws");
});

test("readPortrait: mood from the pet row with decay, outfit from the bird row; tolerates a missing outfit column", async () => {
  const db = createClient({ url: "file::memory:" });
  await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
  const T = 1_760_000_000_000;
  await db.execute({ sql: "UPDATE ramble_pet SET energy = 65, last_fed_at = ? WHERE owner = 'self'", args: [T] });
  assert.equal((await readPortrait(db, { now: T })).mood, "happy");
  assert.equal((await readPortrait(db, { now: T + DECAY_INTERVAL_MS })).mood, "tired", "one decay step crosses 60");
  await db.execute(`UPDATE ramble_eggs SET outfit_json = '{"scarf":"knit"}' WHERE egg_id = 'b1'`);
  assert.deepEqual((await readPortrait(db, { now: T })).outfit, { scarf: "knit" });
  await db.execute(`UPDATE ramble_eggs SET outfit_json = '{broken' WHERE egg_id = 'b1'`);
  assert.equal((await readPortrait(db, { now: T })).outfit, null, "corrupt = no outfit, no throw");
  await db.execute("ALTER TABLE ramble_eggs DROP COLUMN outfit_json");
  const p = await readPortrait(db, { now: T });
  assert.equal(p.species, "crow");
  assert.equal(p.outfit, null, "an older bundle's table still gives a portrait");
});

test("renderBirdAvatar honours mood and outfit; the defaults are byte-identical to the old portrait", () => {
  const plain = renderBirdAvatar({ species: "crow", seed: 2 });
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, mood: "happy", outfit: null }), plain);
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, mood: "nonsense" }), plain, "unknown mood = happy");
  assert.notEqual(renderBirdAvatar({ species: "crow", seed: 2, mood: "alarmed" }), plain, "D2: a neglected bird looks it");
  assert.notEqual(renderBirdAvatar({ species: "crow", seed: 2, outfit: { glasses: "round" } }), plain);
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, outfit: { glasses: "monocle" } }), plain, "unknown value ignored");
  const full = loadBirdEngine();
  const oldEngine = { rollGenome: full.rollGenome, drawBird: full.drawBird };
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, outfit: { glasses: "round" } }, oldEngine), plain, "an engine without applyOutfit draws the plain bird, never throws");
});

test("gate: an unchanged OWN input set never repaints, even when the replicated stored picture differs (no instance ping-pong)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const m = mgrsWith(db, sent);
    assert.equal((await refreshBirdAvatar(db, m, { gate: true })).reason, "rendered", "first gated run has no memo, so it renders");
    assert.equal(sent.length, 1);
    // Another of the user's instances (older engine, different local decay)
    // wrote a different picture and it synced in.
    await putSetting(db, "profile_avatar_url", renderBirdAvatar({ species: "crow", seed: 2, mood: "tired" }));
    assert.deepEqual(await refreshBirdAvatar(db, m, { gate: true }), { changed: false, reason: "inputs-same" });
    assert.equal(sent.length, 1, "no counter-broadcast");
    // A real change of THIS instance's inputs does repaint.
    await db.execute({ sql: "UPDATE ramble_pet SET energy = 61, last_fed_at = ? WHERE owner = 'self'", args: [Date.now() - 4 * DECAY_INTERVAL_MS - 1000] });
    assert.equal((await refreshBirdAvatar(db, m, { gate: true })).reason, "rendered");
    assert.equal(sent.length, 2);
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("cross-instance: an outfit applied by a sync peer repaints the portrait once", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 11 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const m = mgrsWith(db, sent);
    let r = await refreshBirdAvatar(db, m, { gate: true });
    assert.equal(r.reason, "rendered");
    assert.equal(sent.length, 1);
    const row = (await db.execute("SELECT * FROM ramble_eggs WHERE egg_id = 'b1'")).rows[0];
    const wire = {};
    for (const k of Object.keys(row)) if (k !== "lamport_ts" && k !== "lamport_origin" && isNaN(Number(k))) wire[k] = row[k];
    wire.outfit_json = '{"glasses":"round"}';
    await applyRambleEgg(db, "update", wire, 9999999999, "peer");
    r = await refreshBirdAvatar(db, m, { gate: true });
    assert.equal(r.reason, "rendered");
    assert.equal(await setting(db, "profile_avatar_url"), renderBirdAvatar({ species: "crow", seed: 11, outfit: { glasses: "round" } }));
    assert.equal(sent.length, 2, "exactly one more broadcast");
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("an engine that cannot draw a worn outfit never overwrites the dressed picture", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await db.execute(`UPDATE ramble_eggs SET outfit_json = '{"hat":"beanie"}' WHERE egg_id = 'b1'`);
    await putSetting(db, "profile_avatar_source", "bird");
    const dressed = renderBirdAvatar({ species: "crow", seed: 2, outfit: { hat: "beanie" } });
    await putSetting(db, "profile_avatar_url", dressed);
    const full = loadBirdEngine();
    const sent = [];
    const r = await refreshBirdAvatar(db, mgrsWith(db, sent), { engine: { rollGenome: full.rollGenome, drawBird: full.drawBird } });
    assert.deepEqual(r, { changed: false, reason: "engine-too-old" });
    assert.equal(await setting(db, "profile_avatar_url"), dressed);
    assert.equal(sent.length, 0);
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("resend:false never re-sends a stuck pending fan-out (bird and picture sources)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    const sent = [];
    const m = mgrsWith(db, sent);
    await putSetting(db, PROFILE_BROADCAST_PENDING_KEY, "1");
    assert.deepEqual(await refreshBirdAvatar(db, m, { resend: false }), { changed: false, reason: "source-picture" });
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    await putSetting(db, "profile_avatar_url", renderBirdAvatar({ species: "crow", seed: 2 }));
    await putSetting(db, PROFILE_BROADCAST_PENDING_KEY, "1");
    assert.deepEqual(await refreshBirdAvatar(db, m, { resend: false }), { changed: false, reason: "same" });
    assert.equal(sent.length, 0, "a dead contact's pending flag does not turn the tick into a fan-out");
    assert.equal(await readBroadcastPending(db), true, "still pending for an event-driven refresh to retry");
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("§5.4 coalescing: four try-ons inside the settle window = ONE broadcast of the final outfit", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const emitter = new EventEmitter();
    installBirdAvatarHooks(mgrsWith(db, sent), { emitter, settleMs: 400, tickMs: 0 });
    await settle(db, "profile_avatar_url", renderBirdAvatar({ species: "crow", seed: 2 }));
    assert.equal(sent.length, 1, "boot repaint");
    // No sleeps between try-ons: four writes + four triggers well inside 400 ms.
    for (const hat of ["bow", "leaf", "beanie", "leaf"]) {
      await db.execute({ sql: "UPDATE ramble_eggs SET outfit_json = ? WHERE egg_id = 'b1'", args: [JSON.stringify({ hat })] });
      emitter.emit("ramble:outfit-changed", { egg_id: "b1" });
    }
    assert.equal(sent.length, 1, "nothing sent while still trying things on");
    const final = renderBirdAvatar({ species: "crow", seed: 2, outfit: { hat: "leaf" } });
    await settle(db, "profile_avatar_url", final);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(sent.length, 2, "exactly one broadcast for the settled outfit");
    assert.equal(JSON.parse(sent[1].content).payload.avatar, final);
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

// Regression guard: with the inputs memo, the second run is also deduped by
// the gate, so this does not ISOLATE the promise chain — it pins the
// observable contract (one broadcast) for the boot/event overlap.
test("the boot repaint and an immediate trigger overlap: ONE broadcast", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "raven", seed: 5 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const emitter = new EventEmitter();
    installBirdAvatarHooks(mgrsWith(db, sent), { emitter, settleMs: 0, tickMs: 0 });
    emitter.emit("ramble:bird-activated", { egg_id: "b1" }); // same tick as the boot run
    await settle(db, "profile_avatar_url", renderBirdAvatar({ species: "raven", seed: 5 }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.length, 1);
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("the tick: a decay-driven mood change reaches the picture with no event; idle ticks send nothing", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    installBirdAvatarHooks(mgrsWith(db, sent), { emitter: new EventEmitter(), settleMs: 0, tickMs: 60 });
    await settle(db, "profile_avatar_url", renderBirdAvatar({ species: "crow", seed: 2 }));
    await new Promise((r) => setTimeout(r, 250)); // several ticks, nothing changed
    assert.equal(sent.length, 1, "idle ticks broadcast nothing");
    // Fed a day ago from 61: four decay steps -> 21 -> alarmed.
    await db.execute({ sql: "UPDATE ramble_pet SET energy = 61, last_fed_at = ? WHERE owner = 'self'", args: [Date.now() - 4 * DECAY_INTERVAL_MS - 1000] });
    const sad = renderBirdAvatar({ species: "crow", seed: 2, mood: "alarmed" });
    await settle(db, "profile_avatar_url", sad);
    assert.equal(await setting(db, "profile_avatar_url"), sad);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(sent.length, 2, "one broadcast for the crossing, then quiet");
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("the tick never re-sends a pending fan-out; a bus event does", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const emitter = new EventEmitter();
    installBirdAvatarHooks(mgrsWith(db, sent), { emitter, settleMs: 0, tickMs: 40 });
    await settle(db, "profile_avatar_url", renderBirdAvatar({ species: "crow", seed: 2 }));
    // The boot run's broadcastProfile still writes pending 1 -> send -> 0 after
    // the URL lands; wait for it to finish before planting our own flag.
    for (let i = 0; i < 50 && (sent.length < 1 || await readBroadcastPending(db)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);
    assert.equal(await readBroadcastPending(db), false);
    const base = sent.length;
    await putSetting(db, PROFILE_BROADCAST_PENDING_KEY, "1");
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(sent.length, base, "ticks leave a stuck pending flag alone");
    emitter.emit("ramble:outfit-changed", { egg_id: "b1" });
    for (let i = 0; i < 50 && sent.length === base; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, base + 1, "a real event retries the pending fan-out (existing R2-S3 behaviour)");
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("a failed store does not freeze the picture: the next gated run renders again", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    let failOnce = true;
    const flaky = new Proxy(db, { get(t, k) {
      if (k === "execute") return async (q) => {
        const sql = typeof q === "string" ? q : q?.sql;
        if (failOnce && /dashboard_settings/.test(sql || "") && /^\s*(INSERT|UPDATE)/i.test(sql || "")) { failOnce = false; throw new Error("SQLITE_BUSY"); }
        return t.execute(q);
      };
      const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
    } });
    const sent = [];
    assert.equal((await refreshBirdAvatar(flaky, mgrsWith(flaky, sent), { gate: true })).reason, "error");
    assert.equal((await refreshBirdAvatar(flaky, mgrsWith(flaky, sent), { gate: true })).reason, "rendered", "not inputs-same");
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("deploy day: a cached engine without applyOutfit is re-probed (default path), at most once a minute", async () => {
  __resetBirdAvatarHooksForTest();
  const dir = mkdtempSync(join(tmpdir(), "bird-engine-"));
  const prev = process.env.CROW_HOME;
  try {
    process.env.CROW_HOME = dir;
    const target = join(dir, "bundles", "ramble", "server", "bird-svg.cjs");
    mkdirSync(dirname(target), { recursive: true });
    // An "0.12" engine: the real one with applyOutfit removed.
    writeFileSync(target, `const real = require(${JSON.stringify(REPO_ENGINE)}); module.exports = { rollGenome: real.rollGenome, drawBird: real.drawBird };`);
    const T = 1_760_000_000_000;
    const old = loadBirdEngine({ now: T });
    assert.equal(typeof old.applyOutfit, "undefined");
    writeFileSync(target, readFileSync(REPO_ENGINE, "utf8")); // bundle repair copies 0.13 in
    assert.equal(loadBirdEngine({ now: T + 1000 }), old, "within the minute: still cached");
    const fresh = loadBirdEngine({ now: T + 61_000 });
    assert.equal(typeof fresh.applyOutfit, "function", "re-probed and picked up the new copy");
    assert.equal(loadBirdEngine({ now: T + 200_000 }), fresh, "a capable engine is never re-probed");
  } finally {
    if (prev === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prev;
    __resetBirdAvatarHooksForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaults: a short settle and a half-hourly tick", () => {
  assert.equal(AVATAR_SETTLE_MS, 20_000);
  assert.equal(AVATAR_TICK_MS, 30 * 60_000);
});

const putWallet = (db, kind, key, delta = 1) => db.execute({
  sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING",
  args: [kind, key, delta, Date.now()],
});

test("portraitDay is exactly eggs.js's localDay (core keeps its own copy; this pins them)", () => {
  for (const t of [0, 1_760_000_000_000, 1_760_000_000_000 + 13 * 3_600_000, Date.UTC(2026, 11, 31, 23, 59), Date.UTC(2027, 2, 14, 7, 30)]) {
    assert.equal(portraitDay(t), localDay(t), String(t));
  }
});

test("readPortrait: walked comes ONLY from today's walked fact — a boolean, never a count", async () => {
  const db = createClient({ url: "file::memory:" });
  await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
  const now = Date.now();
  assert.equal((await readPortrait(db, { now })).walked, false);
  await putWallet(db, "walked", portraitDay(now - 86_400_000));
  assert.equal((await readPortrait(db, { now })).walked, false, "yesterday's walk is not today's badge");
  await putWallet(db, "steps", portraitDay(now) + ":eeeeeeee-0000-0000-0000-000000000000", 7777);
  let p = await readPortrait(db, { now });
  assert.equal(p.walked, false, "a step count alone never reaches the portrait");
  assert.ok(!JSON.stringify(p).includes("7777"));
  await putWallet(db, "walked", portraitDay(now));
  p = await readPortrait(db, { now });
  assert.equal(p.walked, true);
  assert.deepEqual(Object.keys(p).sort(), ["egg_id", "mood", "outfit", "seed", "species", "walked"]);
});

test("renderBirdAvatar: the badge only when walked, only with an engine that can draw it", () => {
  const full = loadBirdEngine();
  const plain = renderBirdAvatar({ species: "crow", seed: 2 });
  const walked = renderBirdAvatar({ species: "crow", seed: 2, walked: true });
  assert.notEqual(walked, plain);
  assert.ok(Buffer.from(walked.split(",")[1], "base64").toString("utf8").includes(full.drawWalkBadge()));
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, walked: "yes" }), plain, "strictly boolean");
  const oldEngine = { rollGenome: full.rollGenome, drawBird: full.drawBird, applyOutfit: full.applyOutfit };
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, walked: true }, oldEngine), plain, "the pure renderer never throws on an old engine");
});

test("an engine that cannot draw the walked badge never overwrites a badged picture; walked=false still paints", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const badged = renderBirdAvatar({ species: "crow", seed: 2, walked: true });
    await putSetting(db, "profile_avatar_url", badged);
    const full = loadBirdEngine();
    const old = { rollGenome: full.rollGenome, drawBird: full.drawBird, applyOutfit: full.applyOutfit };
    const sent = [];
    // not walked today: an old engine paints normally
    let r = await refreshBirdAvatar(db, mgrsWith(db, sent), { engine: old });
    assert.equal(r.reason, "rendered");
    assert.equal(await setting(db, "profile_avatar_url"), renderBirdAvatar({ species: "crow", seed: 2 }));
    // walked today: the old engine skips, leaving the badged picture alone
    await putSetting(db, "profile_avatar_url", badged);
    await putWallet(db, "walked", portraitDay(Date.now()));
    const before = sent.length;
    r = await refreshBirdAvatar(db, mgrsWith(db, sent), { engine: old });
    assert.deepEqual(r, { changed: false, reason: "engine-too-old" });
    assert.equal(await setting(db, "profile_avatar_url"), badged);
    assert.equal(sent.length, before);
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("gate: a walked flip repaints once; an unchanged day does not", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const m = mgrsWith(db, sent);
    assert.equal((await refreshBirdAvatar(db, m, { gate: true })).reason, "rendered");
    await putWallet(db, "walked", portraitDay(Date.now()));
    assert.equal((await refreshBirdAvatar(db, m, { gate: true })).reason, "rendered");
    assert.equal(await setting(db, "profile_avatar_url"), renderBirdAvatar({ species: "crow", seed: 2, walked: true }));
    assert.deepEqual(await refreshBirdAvatar(db, m, { gate: true }), { changed: false, reason: "inputs-same" });
    assert.equal(sent.length, 2);
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("deploy day: a cached 0.13 engine (applyOutfit, no badge) is re-probed and picks up drawWalkBadge", async () => {
  __resetBirdAvatarHooksForTest();
  const dir = mkdtempSync(join(tmpdir(), "bird-engine-"));
  const prev = process.env.CROW_HOME;
  try {
    process.env.CROW_HOME = dir;
    const target = join(dir, "bundles", "ramble", "server", "bird-svg.cjs");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "const real = require(" + JSON.stringify(REPO_ENGINE) + "); module.exports = { rollGenome: real.rollGenome, drawBird: real.drawBird, applyOutfit: real.applyOutfit };");
    const T = 1_760_000_000_000;
    const old = loadBirdEngine({ now: T });
    assert.equal(typeof old.drawWalkBadge, "undefined");
    writeFileSync(target, readFileSync(REPO_ENGINE, "utf8")); // bundle repair copies 0.14 in
    assert.equal(loadBirdEngine({ now: T + 1000 }), old, "within the minute: still cached");
    const fresh = loadBirdEngine({ now: T + 61_000 });
    assert.equal(typeof fresh.drawWalkBadge, "function", "re-probed after one restart, no second restart needed");
    assert.equal(loadBirdEngine({ now: T + 200_000 }), fresh);
  } finally {
    if (prev === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prev;
    __resetBirdAvatarHooksForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installBirdAvatarHooks: ramble:walked-changed is a coalesced trigger like an outfit change", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const emitter = new EventEmitter();
    installBirdAvatarHooks(mgrsWith(db, sent), { emitter, settleMs: 200, tickMs: 0 });
    await settle(db, "profile_avatar_url", renderBirdAvatar({ species: "crow", seed: 2 }));
    assert.equal(sent.length, 1, "boot repaint");
    await putWallet(db, "walked", portraitDay(Date.now()));
    emitter.emit("ramble:walked-changed", { day: portraitDay(Date.now()) });
    emitter.emit("ramble:walked-changed", { day: portraitDay(Date.now()) });
    const badged = renderBirdAvatar({ species: "crow", seed: 2, walked: true });
    await settle(db, "profile_avatar_url", badged);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sent.length, 2, "one broadcast for the badge");
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});
