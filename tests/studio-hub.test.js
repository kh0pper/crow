/**
 * Studio session hub: the per-song serial queue, the agent rules, the ACL
 * gate, de-duplication, undo and redo (including the rules they inherit), and
 * what happens when the store cannot take a step.
 *
 * Every test runs against its own scratch crow.db in a temp directory with a
 * fake project ACL whose behaviour the test controls (member, archived, no
 * write capability), so nothing here can touch a real instance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { getSongRow } from "../bundles/studio/server/store.js";

/** The project every song in these tests belongs to. */
const PROJECT = 21;

/** A GUI command's author, per the plan's attribution rule. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** An MCP command's author, per the plan's attribution rule. */
const AGENT = { kind: "agent", id: "mcp", label: "Agent (MCP)" };

/** @returns {{t: number, d: number, p: number, v: number}} a note. */
function note(t, d, p, v) {
  return { t, d, p, v };
}

/** A scratch libsql client for one test, closed when the test ends. */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/**
 * A project ACL the test drives. It refuses like the real module: AclError
 * with the same messages, so the hub's ACL mapping is exercised for real.
 * @param {{projects?: number[]}} [options]
 */
function fakeAcl({ projects = [PROJECT] } = {}) {
  const known = new Set(projects);
  const archived = new Set();
  const readOnly = new Set();
  const audits = [];

  async function assertProjectExists(db, projectId, { allowArchived = false } = {}) {
    const id = Number(projectId);
    if (!known.has(id)) throw new AclError(`Project #${projectId} not found`, "not_found");
    if (!allowArchived && archived.has(id)) {
      throw new AclError(`Project #${projectId} is archived`, "archived");
    }
    return { id };
  }

  async function assertCapability(db, projectId, contactId, capability) {
    await assertProjectExists(db, projectId);
    if (readOnly.has(Number(projectId))) {
      throw new AclError(
        `viewer role on project #${projectId} lacks capability '${capability}'`,
        "missing_capability",
      );
    }
    return { role: "owner", capabilities: { [capability]: true } };
  }

  async function appendAudit(db, entry) {
    audits.push(entry);
  }

  return { assertProjectExists, assertCapability, appendAudit, audits, archived, readOnly, known };
}

/**
 * A scratch database, a hub on it, and the broadcasts it made.
 * @param {import("node:test").TestContext} t
 * @param {{hub?: object, acl?: object}} [options]
 */
async function setup(t, { hub: hubOptions = {}, acl: aclOptions = {} } = {}) {
  const db = scratchDb(t);
  await initStudioTables(db);
  const acl = fakeAcl(aclOptions);
  const broadcasts = [];
  const hub = createHub({
    db,
    acl,
    onBroadcast: (song_id, payload) => {
      broadcasts.push({ song_id, ...payload });
    },
    ...hubOptions,
  });
  return { db, acl, hub, broadcasts };
}

/**
 * A database client that can be told to refuse its next save.
 *
 * Every step the hub saves goes through one `batch(...)` transaction, which is
 * exactly where a full disk or a locked database shows up. This wrapper makes
 * that call fail on demand while leaving everything else — reads, the table
 * setup — working, so a test can watch what the hub does with a step it could
 * not keep.
 * @param {object} db - the real scratch client
 */
function flakyClient(db) {
  let failures = 0;
  return {
    execute: (statement) => db.execute(statement),
    executeMultiple: (sql) => db.executeMultiple(sql),
    batch: (statements, mode) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("the disk is full"));
      }
      return db.batch(statements, mode);
    },
    /** Refuse this many saves from now on. */
    failNextBatch(times = 1) {
      failures += times;
    },
  };
}

/**
 * The same rig as `setup`, over a client whose saves can be made to fail.
 * @param {import("node:test").TestContext} t
 */
async function setupFlaky(t) {
  const disk = scratchDb(t);
  await initStudioTables(disk);
  const db = flakyClient(disk);
  const acl = fakeAcl();
  const broadcasts = [];
  const hub = createHub({
    db,
    acl,
    onBroadcast: (song_id, payload) => {
      broadcasts.push({ song_id, ...payload });
    },
  });
  return { disk, db, acl, hub, broadcasts };
}

/** Create a song with one track, one scene and one clip on it. */
async function seedSong(hub, { title = "Session song" } = {}) {
  const created = await hub.createSong({ project_id: PROJECT, title, author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const song_id = created.song_id;

  const tracked = await hub.runCommand({
    song_id,
    cmd_id: "seed-track",
    command: "track.add",
    args: { id: "bass", name: "Bass" },
    author: HUMAN,
  });
  assert.equal(tracked.ok, true, `track.add was refused: ${tracked.error}`);

  const scene = await hub.runCommand({
    song_id,
    cmd_id: "seed-scene",
    command: "scene.add",
    args: { id: "verse", name: "Verse" },
    author: HUMAN,
  });
  assert.equal(scene.ok, true, `scene.add was refused: ${scene.error}`);

  const clip = await hub.runCommand({
    song_id,
    cmd_id: "seed-clip",
    command: "clip.write",
    args: {
      clip_id: "bass-verse",
      track_id: "bass",
      scene_id: "verse",
      name: "Verse bass",
      length_bars: 1,
      notes: [note(0, 1, 36, 100)],
    },
    author: HUMAN,
  });
  assert.equal(clip.ok, true, `clip.write was refused: ${clip.error}`);

  return song_id;
}

/** Assert a result is a refusal with this code, and return it. */
function refuses(result, code) {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.code, code, `expected code "${code}", got "${result.code}": ${result.error}`);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0, "a refusal needs a message");
  return result;
}

/** @returns {Promise<number[]>} the seq of every update row a song still has. */
async function updateSeqs(db, song_id) {
  const { rows } = await db.execute({
    sql: "SELECT seq FROM studio_updates WHERE song_id = ? ORDER BY seq ASC",
    args: [song_id],
  });
  return rows.map((row) => Number(row.seq));
}

test("two commands race; both apply in arrival order and history seq is gapless", async (t) => {
  const { hub, broadcasts } = await setup(t);
  const song_id = await seedSong(hub); // song create is update 1, the three seed steps 2-4

  // Both are handed over before either finishes: the song's queue decides the
  // order, and nothing about the first step depends on when it resolves.
  const first = hub.runCommand({
    song_id,
    cmd_id: "race-a",
    command: "clip.rename",
    args: { clip_id: "bass-verse", name: "A" },
    author: HUMAN,
  });
  const second = hub.runCommand({
    song_id,
    cmd_id: "race-b",
    command: "clip.rename",
    args: { clip_id: "bass-verse", name: "B" },
    author: AGENT,
  });
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.entry.seq, 5);
  assert.equal(b.entry.seq, a.entry.seq + 1);
  assert.equal(b.snapshot_version, b.entry.seq);

  // The later step is the one whose value the document holds.
  const opened = await hub.openSong(song_id);
  assert.equal(opened.snapshot.clips["bass-verse"].name, "B");
  assert.equal(opened.snapshot_version, 6);

  // History is newest first and has no gap in it.
  const entries = await hub.history(song_id, { limit: 50 });
  const seqs = entries.map((entry) => entry.seq);
  assert.deepEqual(seqs, [6, 5, 4, 3, 2]);
  assert.ok(seqs.every((seq, index) => seq === seqs[0] - index), "history seq is gapless");

  // Every applied step was broadcast, in the order it was applied.
  const updates = broadcasts.filter((item) => item.update);
  assert.deepEqual(updates.slice(-2).map((item) => item.entry.id), [a.entry.id, b.entry.id]);
});

test("focus set then agent command on same clip is refused", async (t) => {
  const { hub, broadcasts } = await setup(t);
  const song_id = await seedSong(hub);

  // The focus is handed over first and the command immediately after, without
  // waiting: the queue is what makes the refusal reliable.
  const focusing = hub.setFocus(song_id, "client-a", "clip:bass-verse", HUMAN);
  const agentWrite = hub.runCommand({
    song_id,
    cmd_id: "focus-1",
    command: "clip.rename",
    args: { clip_id: "bass-verse", name: "Agent name" },
    author: AGENT,
  });
  const [, refused] = await Promise.all([focusing, agentWrite]);

  refuses(refused, "focused");
  assert.match(refused.error, /open right now/);
  assert.match(refused.error, /Verse bass/);
  assert.deepEqual(hub.presence(song_id), [
    { client_id: "client-a", author: HUMAN, focus: "clip:bass-verse" },
  ]);
  assert.ok(broadcasts.some((item) => Array.isArray(item.presence)), "presence was broadcast");
  assert.equal(
    (await hub.openSong(song_id)).snapshot.clips["bass-verse"].name,
    "Verse bass",
    "the refused step wrote nothing",
  );

  // The person holding the focus edits it anyway.
  const humanWrite = await hub.runCommand({
    song_id,
    cmd_id: "focus-2",
    command: "clip.rename",
    args: { clip_id: "bass-verse", name: "My take" },
    author: HUMAN,
  });
  assert.equal(humanWrite.ok, true);

  // Focus is the exact ref: another clip on the same track is still an
  // agent's to write.
  const other = await hub.runCommand({
    song_id,
    cmd_id: "focus-3",
    command: "clip.write",
    args: {
      clip_id: "bass-chorus",
      track_id: "bass",
      scene_id: "verse",
      name: "Chorus bass",
      notes: [note(0, 1, 41, 100)],
    },
    author: AGENT,
  });
  assert.equal(other.ok, true, `a sibling clip should be editable: ${other.error}`);

  // Closing the clip releases the agent.
  await hub.clientGone(song_id, "client-a");
  assert.deepEqual(hub.presence(song_id), []);
  const after = await hub.runCommand({
    song_id,
    cmd_id: "focus-4",
    command: "clip.rename",
    args: { clip_id: "bass-verse", name: "After" },
    author: AGENT,
  });
  assert.equal(after.ok, true);
});

test("agent cannot run track.lock", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);

  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "lock-a",
      command: "track.lock",
      args: { track_id: "bass" },
      author: AGENT,
    }),
    "human_only",
  );
  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "lock-b",
      command: "track.unlock",
      args: { track_id: "bass" },
      author: AGENT,
    }),
    "human_only",
  );

  const locked = await hub.runCommand({
    song_id,
    cmd_id: "lock-c",
    command: "track.lock",
    args: { track_id: "bass" },
    author: HUMAN,
  });
  assert.equal(locked.ok, true);

  const refused = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "lock-d",
      command: "track.rename",
      args: { track_id: "bass", name: "Bass 2" },
      author: AGENT,
    }),
    "locked",
  );
  assert.equal(refused.error, 'Track "Bass" is locked by the operator.');

  // A clip on the locked track is that track for the lock check.
  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "lock-e",
      command: "clip.edit_notes",
      args: { clip_id: "bass-verse", add: [note(1, 1, 38, 100)] },
      author: AGENT,
    }),
    "locked",
  );

  // The person still edits, unlocks, and only then does the agent get through.
  assert.equal(
    (await hub.runCommand({
      song_id,
      cmd_id: "lock-f",
      command: "clip.rename",
      args: { clip_id: "bass-verse", name: "Locked bass" },
      author: HUMAN,
    })).ok,
    true,
  );
  assert.equal(
    (await hub.runCommand({
      song_id,
      cmd_id: "lock-g",
      command: "track.unlock",
      args: { track_id: "bass" },
      author: HUMAN,
    })).ok,
    true,
  );
  assert.equal(
    (await hub.runCommand({
      song_id,
      cmd_id: "lock-h",
      command: "track.rename",
      args: { track_id: "bass", name: "Bass" },
      author: AGENT,
    })).ok,
    true,
  );
});

test("archived project: writes refused, snapshot readable", async (t) => {
  const { hub, acl, db } = await setup(t);
  const song_id = await seedSong(hub);
  const before = (await hub.openSong(song_id)).snapshot;

  acl.archived.add(PROJECT);

  const refused = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "arch-1",
      command: "clip.rename",
      args: { clip_id: "bass-verse", name: "Nope" },
      author: HUMAN,
    }),
    "acl",
  );
  assert.match(refused.error, /archived/);

  // Reads still work on an archived project.
  const opened = await hub.openSong(song_id);
  assert.deepEqual(opened.snapshot, before);
  const entries = await hub.history(song_id);
  assert.deepEqual(entries.map((entry) => entry.command), [
    "clip.write",
    "scene.add",
    "track.add",
  ]);

  // A new song is refused too, and nothing was written.
  refuses(await hub.createSong({ project_id: PROJECT, title: "Not now", author: HUMAN }), "acl");
  assert.deepEqual((await hub.listSongs({ project_ids: [PROJECT] })).map((song) => song.id), [song_id]);
  assert.equal((await updateSeqs(db, song_id)).length, 4);
});

test("no write_files capability: refused with code acl and nothing persisted", async (t) => {
  const { hub, acl, db } = await setup(t);
  const song_id = await seedSong(hub);
  const updatesBefore = await updateSeqs(db, song_id);
  const historyBefore = (await hub.history(song_id)).length;

  acl.readOnly.add(PROJECT);

  const refused = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "ro-1",
      command: "clip.rename",
      args: { clip_id: "bass-verse", name: "Nope" },
      author: HUMAN,
    }),
    "acl",
  );
  assert.match(refused.error, /write_files/);

  assert.deepEqual(await updateSeqs(db, song_id), updatesBefore, "no update row was appended");
  assert.equal((await hub.history(song_id)).length, historyBefore, "no history row was appended");
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"].name, "Verse bass");
});

test("reopen after restart reproduces the same snapshot", async (t) => {
  const db = scratchDb(t);
  await initStudioTables(db);
  const acl = fakeAcl();

  const first = createHub({ db, acl });
  const song_id = await seedSong(first); // updates 1-4
  await first.runCommand({
    song_id,
    cmd_id: "restart-1",
    command: "track.set_mix",
    args: { track_id: "bass", gain_db: -4.5, pan: 0.3 },
    author: AGENT,
  });
  await first.runCommand({
    song_id,
    cmd_id: "restart-2",
    command: "song.set_meta",
    args: { bpm: 96 },
    author: HUMAN,
  });
  const expected = (await first.openSong(song_id)).snapshot;

  // A second hub on the same database is what a restarted gateway looks like.
  const second = createHub({ db, acl });
  const reopened = await second.openSong(song_id);
  assert.deepEqual(reopened.snapshot, expected);
  assert.equal(reopened.snapshot_version, 6);

  const next = await second.runCommand({
    song_id,
    cmd_id: "restart-3",
    command: "scene.rename",
    args: { scene_id: "verse", name: "Verse 2" },
    author: HUMAN,
  });
  assert.equal(next.ok, true);
  assert.equal(next.entry.seq, 7, "the new hub continues the song's sequence");
  assert.equal(next.entry.author.kind, "human");
});

test("resent cmd_id returns first result and applies once", async (t) => {
  const { hub, db } = await setup(t);
  const song_id = await seedSong(hub);
  const request = {
    song_id,
    cmd_id: "resent-1",
    command: "track.set_mix",
    args: { track_id: "bass", gain_db: -6 },
    author: AGENT,
  };

  const first = await hub.runCommand(request);
  assert.equal(first.ok, true);
  const updatesAfterFirst = await updateSeqs(db, song_id);
  const historyAfterFirst = await hub.history(song_id);

  const second = await hub.runCommand(request);
  assert.deepEqual(second, first, "the original result comes back unchanged");
  assert.deepEqual(await updateSeqs(db, song_id), updatesAfterFirst, "nothing was applied twice");
  assert.deepEqual(
    (await hub.history(song_id)).map((entry) => entry.id),
    historyAfterFirst.map((entry) => entry.id),
  );
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].gain_db, -6);

  // A fresh cmd_id with the same arguments is a new step, not a replay: the
  // track id is taken by then, so the registry refuses it.
  refuses(await hub.runCommand({ ...request, cmd_id: "resent-2", command: "track.add", args: { id: "bass", name: "Bass" } }), "invalid");
});

test("undo where every key conflicts returns code conflict and persists nothing", async (t) => {
  const { hub, db } = await setup(t);
  const song_id = await seedSong(hub);

  const older = await hub.runCommand({
    song_id,
    cmd_id: "conflict-1",
    command: "clip.edit_notes",
    args: { clip_id: "bass-verse", add: [note(1, 1, 38, 100)] },
    author: AGENT,
  });
  const newer = await hub.runCommand({
    song_id,
    cmd_id: "conflict-2",
    command: "clip.edit_notes",
    args: { clip_id: "bass-verse", add: [note(2, 1, 43, 100)] },
    author: AGENT,
  });
  assert.equal(older.ok, true);
  assert.equal(newer.ok, true);
  const newestNotes = newer.entry.inverse.after["clip:bass-verse|notes"];

  const updatesBefore = await updateSeqs(db, song_id);
  const historyBefore = (await hub.history(song_id)).length;

  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "conflict-3", entry_id: older.entry.id, author: HUMAN }),
    "conflict",
  );
  assert.equal(refused.error, "Nothing to undo: every change in that step was edited again since.");
  assert.equal(refused.conflicts.length, 1);
  assert.equal(refused.conflicts[0].ref, "clip:bass-verse");
  assert.equal(refused.conflicts[0].field, "notes");

  assert.deepEqual(await updateSeqs(db, song_id), updatesBefore, "no update row was appended");
  assert.equal((await hub.history(song_id)).length, historyBefore, "no history row was appended");
  assert.deepEqual((await hub.openSong(song_id)).snapshot.clips["bass-verse"].notes, newestNotes);
});

test("undo restores a step and refuses to undo it twice", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);

  const step = await hub.runCommand({
    song_id,
    cmd_id: "undo-1",
    command: "clip.rename",
    args: { clip_id: "bass-verse", name: "Renamed" },
    author: AGENT,
  });
  assert.equal(step.ok, true);

  const undone = await hub.undo({ song_id, cmd_id: "undo-2", entry_id: step.entry.id, author: HUMAN });
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.conflicts, []);
  assert.equal(undone.entry.command, "history.undo");
  assert.equal(undone.entry.undo_of, step.entry.id);
  assert.equal(undone.entry.seq, step.entry.seq + 1);
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"].name, "Verse bass");

  const again = refuses(
    await hub.undo({ song_id, cmd_id: "undo-3", entry_id: step.entry.id, author: HUMAN }),
    "conflict",
  );
  assert.match(again.error, /already undone/);

  const redone = await hub.redo({ song_id, cmd_id: "undo-4", entry_id: undone.entry.id, author: HUMAN });
  assert.equal(redone.ok, true, `redo was refused: ${redone.error}`);
  assert.equal(redone.entry.command, "history.redo");
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"].name, "Renamed");
});

test("snapshot compaction: after 200 updates reopen still equals and old update rows are gone", async (t) => {
  // The interval is 5 updates here so the test stays quick; it is the same code
  // path as the 200-update interval the hub runs in production.
  const { db, acl, hub } = await setup(t, { hub: { snapshotEvery: 5 } });
  const song_id = await seedSong(hub); // updates 1-4

  for (let step = 0; step < 8; step += 1) {
    const result = await hub.runCommand({
      song_id,
      cmd_id: `compact-${step}`,
      command: "track.set_mix",
      args: { track_id: "bass", gain_db: -(step + 1) },
      author: HUMAN,
    });
    assert.equal(result.ok, true, `step ${step} was refused: ${result.error}`);
  }

  // Updates 5 and 10 each wrote a snapshot and dropped the older rows. The row
  // at the snapshot's own seq stays: the store derives the next seq from the
  // highest row still in the log, and every reader ignores anything at or
  // below `snapshot_seq`.
  assert.deepEqual(await updateSeqs(db, song_id), [10, 11, 12]);
  const row = await getSongRow(db, song_id);
  assert.equal(row.snapshot_seq, 10);
  assert.ok(row.snapshot && row.snapshot.length > 0, "a snapshot was stored");

  const live = (await hub.openSong(song_id)).snapshot;
  assert.equal(live.tracks[0].gain_db, -8);

  const restarted = createHub({ db, acl, snapshotEvery: 5 });
  const reopened = await restarted.openSong(song_id);
  assert.equal(reopened.snapshot_version, 12);
  assert.deepEqual(reopened.snapshot, live);
});

test("each applied step is audited as local for a person and bot for an agent", async (t) => {
  const { hub, acl } = await setup(t);
  const song_id = await seedSong(hub);

  await hub.runCommand({
    song_id,
    cmd_id: "audit-1",
    command: "clip.rename",
    args: { clip_id: "bass-verse", name: "Agent take" },
    author: AGENT,
  });

  const human = acl.audits.find(
    (entry) => entry.action === "studio.command" && entry.payload?.command === "clip.write",
  );
  assert.equal(human.project_id, PROJECT);
  assert.equal(human.actor_type, "local");
  assert.equal(human.actor_id, "local");
  assert.equal(human.target, `song:${song_id}`);

  const agent = acl.audits.find(
    (entry) => entry.action === "studio.command" && entry.payload?.command === "clip.rename",
  );
  assert.equal(agent.actor_type, "bot");
  assert.equal(agent.actor_id, "mcp");

  assert.ok(
    acl.audits.some((entry) => entry.action === "studio.song.create"),
    "creating a song is on the project's timeline",
  );
});

test("a refused command is not broadcast", async (t) => {
  const { hub, broadcasts } = await setup(t);
  const song_id = await seedSong(hub);
  const seen = broadcasts.length;

  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "quiet-1",
      command: "clip.write",
      args: {
        clip_id: "too-many",
        track_id: "bass",
        scene_id: "verse",
        name: "Too many notes",
        notes: Array.from({ length: 4097 }, (_, index) => note(index / 4, 0.25, 36, 100)),
      },
      author: AGENT,
    }),
    "limit",
  );

  assert.equal(broadcasts.length, seen, "nothing was broadcast for a refused step");
  assert.deepEqual(
    Object.keys((await hub.openSong(song_id)).snapshot.clips).sort(),
    ["bass-verse"],
  );
});

test("agent cannot restore a removed clip onto a locked track via undo", async (t) => {
  const { hub, db } = await setup(t);
  const song_id = await seedSong(hub);

  const removed = await hub.runCommand({
    song_id,
    cmd_id: "undo-lock-1",
    command: "clip.remove",
    args: { clip_id: "bass-verse" },
    author: HUMAN,
  });
  assert.equal(removed.ok, true, `clip.remove was refused: ${removed.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"], undefined);

  assert.equal(
    (await hub.runCommand({
      song_id,
      cmd_id: "undo-lock-2",
      command: "track.lock",
      args: { track_id: "bass" },
      author: HUMAN,
    })).ok,
    true,
  );
  const updatesBefore = await updateSeqs(db, song_id);

  // The clip is not in the song any more, so its ref names no track. The track
  // the undo would put it back on is only in the value the undo writes.
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "undo-lock-3", entry_id: removed.entry.id, author: AGENT }),
    "locked",
  );
  assert.equal(refused.error, 'Track "Bass" is locked by the operator.');
  assert.deepEqual(await updateSeqs(db, song_id), updatesBefore, "a refused undo writes nothing");
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"], undefined);

  // The operator can still take their own step back.
  const undone = await hub.undo({
    song_id,
    cmd_id: "undo-lock-4",
    entry_id: removed.entry.id,
    author: HUMAN,
  });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"].name, "Verse bass");
});

test("agent redo of an undone clip.write onto a locked track is refused", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);
  const written = (await hub.history(song_id, { limit: 50 })).find(
    (entry) => entry.command === "clip.write",
  );

  const undone = await hub.undo({
    song_id,
    cmd_id: "redo-lock-1",
    entry_id: written.id,
    author: HUMAN,
  });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"], undefined);

  assert.equal(
    (await hub.runCommand({
      song_id,
      cmd_id: "redo-lock-2",
      command: "track.lock",
      args: { track_id: "bass" },
      author: HUMAN,
    })).ok,
    true,
  );

  refuses(
    await hub.redo({ song_id, cmd_id: "redo-lock-3", entry_id: undone.entry.id, author: AGENT }),
    "locked",
  );
  assert.equal(
    (await hub.openSong(song_id)).snapshot.clips["bass-verse"],
    undefined,
    "the refused redo restored nothing",
  );

  const redone = await hub.redo({
    song_id,
    cmd_id: "redo-lock-4",
    entry_id: undone.entry.id,
    author: HUMAN,
  });
  assert.equal(redone.ok, true, `the operator's redo was refused: ${redone.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"].name, "Verse bass");
});

test("agent cannot undo the operator's unlock", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);

  await hub.runCommand({
    song_id,
    cmd_id: "unlock-1",
    command: "track.lock",
    args: { track_id: "bass" },
    author: HUMAN,
  });
  const unlocked = await hub.runCommand({
    song_id,
    cmd_id: "unlock-2",
    command: "track.unlock",
    args: { track_id: "bass" },
    author: HUMAN,
  });
  assert.equal(unlocked.ok, true);

  // Undoing the unlock would lock the track, which is the one thing an agent
  // may not do.
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "unlock-3", entry_id: unlocked.entry.id, author: AGENT }),
    "human_only",
  );
  assert.match(refused.error, /track\.unlock/);
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].locked, false);

  // The operator's own undo of the unlock stands, and taking *that* back is
  // refused for the same reason: the chain ends at the people-only command.
  const relocked = await hub.undo({
    song_id,
    cmd_id: "unlock-4",
    entry_id: unlocked.entry.id,
    author: HUMAN,
  });
  assert.equal(relocked.ok, true, `the operator's undo was refused: ${relocked.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].locked, true);

  const refusedRedo = refuses(
    await hub.redo({ song_id, cmd_id: "unlock-5", entry_id: relocked.entry.id, author: AGENT }),
    "human_only",
  );
  assert.match(refusedRedo.error, /track\.unlock/);
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].locked, true);
});

test("if saving fails, nothing changes in memory or on disk", async (t) => {
  const { disk, db, acl, hub } = await setupFlaky(t);
  const song_id = await seedSong(hub);
  const before = (await hub.openSong(song_id)).snapshot;
  const updatesBefore = await updateSeqs(disk, song_id);
  const historyBefore = (await hub.history(song_id)).length;

  // The live document takes the edit; the store then refuses to keep it.
  db.failNextBatch();
  const refused = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "save-1",
      command: "clip.rename",
      args: { clip_id: "bass-verse", name: "Never saved" },
      author: HUMAN,
    }),
    "storage",
  );
  assert.equal(refused.error, "Studio could not save that change; nothing was changed.");

  assert.deepEqual(await updateSeqs(disk, song_id), updatesBefore, "no update row was appended");
  assert.equal((await hub.history(song_id)).length, historyBefore, "no history row was appended");
  assert.deepEqual(
    (await hub.openSong(song_id)).snapshot,
    before,
    "the cached document was dropped and the song rebuilt from the database",
  );

  const restarted = createHub({ db: disk, acl });
  assert.deepEqual((await restarted.openSong(song_id)).snapshot, before);
});

test("a failed save does not poison later commands", async (t) => {
  const { disk, db, acl, hub } = await setupFlaky(t);
  const song_id = await seedSong(hub); // updates 1-4

  db.failNextBatch();
  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "poison-1",
      command: "track.rename",
      args: { track_id: "bass", name: "Lost" },
      author: HUMAN,
    }),
    "storage",
  );

  // The failed step is gone from the song, so the next command sees the track
  // as it was and the sequence continues where the log really is.
  const later = await hub.runCommand({
    song_id,
    cmd_id: "poison-2",
    command: "track.rename",
    args: { track_id: "bass", name: "Kept" },
    author: HUMAN,
  });
  assert.equal(later.ok, true, `the later command was refused: ${later.error}`);
  assert.equal(later.entry.seq, 5);

  const reopened = createHub({ db: disk, acl });
  const opened = await reopened.openSong(song_id);
  assert.equal(opened.snapshot.tracks[0].name, "Kept");
  assert.equal(opened.snapshot_version, 5);
  assert.deepEqual(await updateSeqs(disk, song_id), [1, 2, 3, 4, 5]);
});

test("an undo reusing a command's cmd_id is not swallowed", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);

  const renamed = await hub.runCommand({
    song_id,
    cmd_id: "shared-id",
    command: "clip.rename",
    args: { clip_id: "bass-verse", name: "Agent name" },
    author: AGENT,
  });
  assert.equal(renamed.ok, true);

  // The same id on a different kind of step asks for something else, so the
  // undo runs instead of replaying the command's answer.
  const undone = await hub.undo({
    song_id,
    cmd_id: "shared-id",
    entry_id: renamed.entry.id,
    author: AGENT,
  });
  assert.equal(undone.ok, true, `the undo was refused: ${undone.error}`);
  assert.equal(undone.entry.command, "history.undo");
  assert.notEqual(undone.entry.id, renamed.entry.id);
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"].name, "Verse bass");

  // A resend of that undo still replays.
  const again = await hub.undo({
    song_id,
    cmd_id: "shared-id",
    entry_id: renamed.entry.id,
    author: AGENT,
  });
  assert.deepEqual(again, undone);

  // The same id for a different change is refused, not answered with the
  // earlier change's result.
  const reused = await hub.runCommand({
    song_id,
    cmd_id: "shared-id",
    command: "clip.rename",
    args: { clip_id: "bass-verse", name: "Another" },
    author: AGENT,
  });
  refuses(reused, "invalid");
  assert.equal(reused.error, "That command id was already used for a different change.");
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"].name, "Verse bass");
});

test("blocked undo returns the plain-English reason", async (t) => {
  const { hub, db } = await setup(t);
  const song_id = await seedSong(hub);
  const added = (await hub.history(song_id, { limit: 50 })).find(
    (entry) => entry.command === "track.add",
  );
  const updatesBefore = await updateSeqs(db, song_id);

  // The track cannot come out while the clip written on it is still there: the
  // undo would leave a clip without its track.
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "blocked-1", entry_id: added.id, author: HUMAN }),
    "conflict",
  );
  assert.equal(refused.blocked.length, 1);
  assert.match(refused.blocked[0], /without its track/);
  assert.equal(refused.error, refused.blocked.join(" "));
  assert.deepEqual(refused.conflicts, []);
  assert.deepEqual(await updateSeqs(db, song_id), updatesBefore, "a blocked undo writes nothing");
});

test("focus for an unknown song creates nothing", async (t) => {
  const { hub, broadcasts } = await setup(t);

  const focused = await hub.setFocus("no-such-song", "client-a", "clip:x", HUMAN);
  assert.equal(focused.ok, true);
  assert.deepEqual(focused.presence, []);
  assert.deepEqual(hub.presence("no-such-song"), []);

  const gone = await hub.clientGone("no-such-song", "client-a");
  assert.equal(gone.ok, true);
  assert.deepEqual(gone.presence, []);
  assert.deepEqual(
    broadcasts.filter((item) => item.song_id === "no-such-song"),
    [],
    "nothing was broadcast for a song that is not there",
  );

  // A real song still takes a focus afterwards.
  const song_id = await seedSong(hub);
  const real = await hub.setFocus(song_id, "client-a", "clip:bass-verse", HUMAN);
  assert.deepEqual(real.presence, [
    { client_id: "client-a", author: HUMAN, focus: "clip:bass-verse" },
  ]);
});