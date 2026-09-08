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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import {
  birdEngineCandidates, loadBirdEngine, readActiveBird, renderBirdAvatar, renderActiveBirdAvatar,
  refreshBirdAvatar, installBirdAvatarHooks, __resetBirdAvatarHooksForTest,
} from "../servers/sharing/profile-avatar.js";
import { validateAvatar, AVATAR_MAX_BYTES } from "../servers/sharing/avatar.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { PROFILE_BROADCAST_PENDING_KEY, readBroadcastPending } from "../servers/sharing/peer-profile.js";

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
    assert.equal(installBirdAvatarHooks(mgrsWith(db, sent), { emitter }), true);
    assert.equal(installBirdAvatarHooks(mgrsWith(db, sent), { emitter }), false, "second install is a no-op");
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
    installBirdAvatarHooks(mgrsWith(db, sent), { emitter });
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
