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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { createStudioServer } from "../bundles/studio/server/mcp.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { appendHistory, getSongRow } from "../bundles/studio/server/store.js";

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

/** @returns {Promise<{songs: number, updates: number, history: number}>} what the tables hold. */
async function rowCounts(db) {
  const { rows } = await db.execute({
    sql: `SELECT (SELECT COUNT(*) FROM studio_songs) AS songs,
                 (SELECT COUNT(*) FROM studio_updates) AS updates,
                 (SELECT COUNT(*) FROM studio_history) AS history`,
  });
  const row = rows[0] ?? {};
  return {
    songs: Number(row.songs ?? 0),
    updates: Number(row.updates ?? 0),
    history: Number(row.history ?? 0),
  };
}

/** A take id in the UUID shape the recording client generates. */
const TAKE_A = "6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70";

/** A second take id, for the tests that need two recordings. */
const TAKE_B = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

/**
 * The take object `take.add` accepts, as the gateway's upload finish route
 * builds it after the WAV is in storage.
 * @param {string} id
 * @returns {object}
 */
function makeTake(id) {
  return {
    id,
    storage_key: `studio/song/takes/${id}.wav`,
    rate: 48000,
    channels: 2,
    frames: 48000,
    offset_frames: 0,
    compensated: false,
    bpm: 120,
    recorded_at: "2026-11-02T12:00:00.000Z",
    author_label: "the operator",
    discarded: false,
  };
}

/**
 * Add an audio track and an audio clip to a seeded song, so a take has a clip
 * to belong to.
 * @param {object} hub
 * @param {string} song_id
 * @returns {Promise<{track_id: string, clip_id: string}>}
 */
async function seedAudioClip(hub, song_id) {
  const track = await hub.runCommand({
    song_id,
    cmd_id: "seed-audio-track",
    command: "track.add",
    args: { id: "gtr", name: "Guitar", kind: "audio" },
    author: HUMAN,
  });
  assert.equal(track.ok, true, `track.add was refused: ${track.error}`);

  const clip = await hub.runCommand({
    song_id,
    cmd_id: "seed-audio-clip",
    command: "clip.add_audio",
    args: { clip_id: "gtr-take", track_id: "gtr", scene_id: "verse", length_bars: 2, name: "Guitar take" },
    author: HUMAN,
  });
  assert.equal(clip.ok, true, `clip.add_audio was refused: ${clip.error}`);
  return { track_id: "gtr", clip_id: "gtr-take" };
}

/**
 * Add one take the way Studio itself does: `internal: true`, as the gateway's
 * upload finish route issues it.
 * @param {object} hub
 * @param {string} song_id
 * @param {string} clip_id
 * @param {object} take
 * @returns {Promise<object>} the applied step's result
 */
async function addTake(hub, song_id, clip_id, take) {
  const added = await hub.runCommand({
    song_id,
    cmd_id: `add-take-${take.id}`,
    command: "take.add",
    args: { clip_id, take },
    author: HUMAN,
    internal: true,
  });
  assert.equal(added.ok, true, `take.add was refused: ${added.error}`);
  return added;
}

// --- A sampler track's sounds -------------------------------------------------

/** A sample id in the UUID shape the import client generates. */
const SAMPLE_A = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

/** A second sample id, for the tests that repoint a pad. */
const SAMPLE_B = "9c8b7a6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d";

/** What the agent's sound guard answers with, word for word. */
const SOUNDS_NEED_A_YES = "Changing recorded or imported sounds needs a yes from the operator.";

/**
 * The sample object `sample.add` accepts, as the gateway's upload finish route
 * builds it after the WAV is in storage.
 * @param {string} id
 * @returns {object}
 */
function makeSample(id) {
  return {
    id,
    storage_key: `studio/song/samples/${id}.wav`,
    rate: 48000,
    channels: 2,
    frames: 96000,
    name: "Drum loop",
    origin: "import",
    author_label: "the operator",
  };
}

/**
 * Run one command and assert it applied.
 * @param {object} hub
 * @param {string} song_id
 * @param {string} cmd_id
 * @param {string} command
 * @param {object} args
 * @param {object} [author]
 * @returns {Promise<object>} the applied step's result
 */
async function applies(hub, song_id, cmd_id, command, args, author = HUMAN) {
  const result = await hub.runCommand({ song_id, cmd_id, command, args, author });
  assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
  return result;
}

/**
 * Add one sample the way Studio itself does: `internal: true`, as the gateway's
 * upload finish route issues it.
 * @param {object} hub
 * @param {string} song_id
 * @param {object} sample
 * @returns {Promise<object>} the applied step's result
 */
async function addSample(hub, song_id, sample) {
  const added = await hub.runCommand({
    song_id,
    cmd_id: `add-sample-${sample.id}`,
    command: "sample.add",
    args: { sample },
    author: HUMAN,
    internal: true,
  });
  assert.equal(added.ok, true, `sample.add was refused: ${added.error}`);
  return added;
}

/**
 * A song with one scene, a sampler track whose bank A plays a sample on pad 1,
 * and a pattern clip on that track — the shape every sound rule is about.
 * @param {object} hub
 * @returns {Promise<{song_id: string, track_id: string, bank_id: string,
 *                    clip_id: string, assigned: object}>} `assigned` is the
 *   operator's `pad.assign` step, the one that put the sound on the pad
 */
async function seedSampleSong(hub) {
  const created = await hub.createSong({ project_id: PROJECT, title: "Sample song", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const song_id = created.song_id;

  await applies(hub, song_id, "seed-verse", "scene.add", { id: "verse", name: "Verse" });
  const tracked = await applies(hub, song_id, "seed-kit", "track.add", {
    id: "kit",
    name: "Drums",
    kind: "sampler",
  });
  const opened = await hub.openSong(song_id);
  const bank = Object.values(opened.snapshot.banks).find((item) => item.track_id === "kit");
  assert.ok(bank, "a sampler track arrives with its bank");

  await addSample(hub, song_id, makeSample(SAMPLE_A));
  const assigned = await applies(hub, song_id, "seed-pad", "pad.assign", {
    track_id: "kit",
    bank_id: bank.id,
    index: 0,
    sample_id: SAMPLE_A,
  });
  const clip = await applies(hub, song_id, "seed-pattern", "clip.add_pattern", {
    clip_id: "kit-loop",
    track_id: "kit",
    scene_id: "verse",
    name: "Kit loop",
  });
  return {
    song_id,
    track_id: "kit",
    bank_id: bank.id,
    clip_id: clip.entry.args.clip_id,
    assigned,
    tracked,
  };
}

/**
 * The hub client the MCP server talks to, over the real hub in this test.
 * @param {object} hub
 * @returns {object}
 */
function hubClient(hub) {
  return {
    command: (song_id, request) => hub.runCommand({ song_id, ...request }),
    snapshot: (song_id) => hub.openSong(song_id),
    listSongs: (filter) => hub.listSongs(filter),
  };
}

/**
 * @param {object} hub
 * @returns {Promise<string[]>} every tool an agent would see for this hub
 */
async function mcpToolNames(hub) {
  const server = createStudioServer({
    hub: hubClient(hub),
    renderer: {
      async render() {
        throw new Error("this test does not render");
      },
    },
    catalogue: async () => ({ modules: {} }),
    env: {},
  });
  const client = new Client({ name: "studio-hub-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return listed.tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
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

test("agent cannot undo the removal of a locked track", async (t) => {
  const { hub, db } = await setup(t);
  const song_id = await seedSong(hub);

  assert.equal(
    (await hub.runCommand({
      song_id,
      cmd_id: "locked-remove-1",
      command: "track.lock",
      args: { track_id: "bass" },
      author: HUMAN,
    })).ok,
    true,
  );
  const removed = await hub.runCommand({
    song_id,
    cmd_id: "locked-remove-2",
    command: "track.remove",
    args: { track_id: "bass" },
    author: HUMAN,
  });
  assert.equal(removed.ok, true, `track.remove was refused: ${removed.error}`);
  assert.deepEqual((await hub.openSong(song_id)).snapshot.tracks, []);
  const updatesBefore = await updateSeqs(db, song_id);

  // The track is out of the song, so nothing in the document says it is
  // locked: only the value the undo would write back does.
  const refused = refuses(
    await hub.undo({
      song_id,
      cmd_id: "locked-remove-3",
      entry_id: removed.entry.id,
      author: AGENT,
    }),
    "locked",
  );
  assert.equal(refused.error, 'Track "Bass" is locked by the operator.');
  assert.deepEqual(await updateSeqs(db, song_id), updatesBefore, "a refused undo writes nothing");
  const held = (await hub.openSong(song_id)).snapshot;
  assert.deepEqual(held.tracks, []);
  assert.deepEqual(Object.keys(held.clips), []);

  // The operator's own undo puts the locked track and its clip back.
  const undone = await hub.undo({
    song_id,
    cmd_id: "locked-remove-4",
    entry_id: removed.entry.id,
    author: HUMAN,
  });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);
  const restored = (await hub.openSong(song_id)).snapshot;
  assert.deepEqual(
    restored.tracks.map((track) => [track.name, track.locked]),
    [["Bass", true]],
  );
  assert.deepEqual(Object.keys(restored.clips), ["bass-verse"]);

  // A track the operator never locked still comes back for an agent: only a
  // locked restore is refused.
  const other = await seedSong(hub, { title: "Unlocked song" });
  const gone = await hub.runCommand({
    song_id: other,
    cmd_id: "unlocked-remove-1",
    command: "track.remove",
    args: { track_id: "bass" },
    author: HUMAN,
  });
  assert.equal(gone.ok, true, `track.remove was refused: ${gone.error}`);
  const cameBack = await hub.undo({
    song_id: other,
    cmd_id: "unlocked-remove-2",
    entry_id: gone.entry.id,
    author: AGENT,
  });
  assert.equal(cameBack.ok, true, `an unlocked restore was refused: ${cameBack.error}`);
  assert.equal((await hub.openSong(other)).snapshot.tracks[0].name, "Bass");
});

test("an agent cannot undo or redo motion on a locked track", async (t) => {
  const { hub, db } = await setup(t);
  const { song_id, track_id, bank_id, clip_id } = await seedSampleSong(hub);
  const lane = `${bank_id}.0|cutoff_hz`;

  // The operator records a cutoff curve on the pattern, then locks the track.
  const written = await applies(
    hub,
    song_id,
    "motion-1",
    "motion.write",
    {
      clip_id,
      pattern_id: "a",
      bank_id,
      index: 0,
      param: "cutoff_hz",
      points: [{ step_frac: 0, value: 500 }, { step_frac: 4, value: 900 }],
    },
    HUMAN,
  );
  await applies(hub, song_id, "motion-lock", "track.lock", { track_id }, HUMAN);
  const curve = [{ step_frac: 0, value: 500 }, { step_frac: 4, value: 900 }];
  assert.deepEqual(
    (await hub.openSong(song_id)).snapshot.patterns[`${clip_id}/a`].motion[lane],
    curve,
    "the operator's curve is on the pattern",
  );

  // A motion ref names its lane, and the lane names the clip whose track plays
  // it: an agent's undo of that step is refused exactly as its own write is.
  const before = await updateSeqs(db, song_id);
  const refusedUndo = refuses(
    await hub.undo({ song_id, cmd_id: "motion-undo", entry_id: written.entry.id, author: AGENT }),
    "locked",
  );
  assert.equal(refusedUndo.error, 'Track "Drums" is locked by the operator.');
  assert.deepEqual(await updateSeqs(db, song_id), before, "a refused undo writes nothing");
  assert.deepEqual(
    (await hub.openSong(song_id)).snapshot.patterns[`${clip_id}/a`].motion[lane],
    curve,
    "and the curve is untouched",
  );

  // The other direction: the operator takes their own step back, and the agent's
  // redo of it is refused for the same lock.
  const undone = await hub.undo({
    song_id,
    cmd_id: "motion-undo-operator",
    entry_id: written.entry.id,
    author: HUMAN,
  });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);
  assert.equal(
    (await hub.openSong(song_id)).snapshot.patterns[`${clip_id}/a`].motion[lane] ?? null,
    null,
    "the operator's undo took the lane away",
  );
  const beforeRedo = await updateSeqs(db, song_id);
  refuses(
    await hub.redo({ song_id, cmd_id: "motion-redo", entry_id: undone.entry.id, author: AGENT }),
    "locked",
  );
  assert.deepEqual(await updateSeqs(db, song_id), beforeRedo, "a refused redo writes nothing");
  assert.equal(
    (await hub.openSong(song_id)).snapshot.patterns[`${clip_id}/a`].motion[lane] ?? null,
    null,
    "and the lane stays gone",
  );
});

test("a broken undo chain is refused for agents", async (t) => {
  const { hub, db } = await setup(t);
  const song_id = await seedSong(hub);

  const renamed = await hub.runCommand({
    song_id,
    cmd_id: "broken-1",
    command: "clip.rename",
    args: { clip_id: "bass-verse", name: "Renamed" },
    author: HUMAN,
  });
  assert.equal(renamed.ok, true);
  const undone = await hub.undo({
    song_id,
    cmd_id: "broken-2",
    entry_id: renamed.entry.id,
    author: HUMAN,
  });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);

  // The command the undo came from is gone, so the rules that step carries
  // cannot be known; an agent is refused rather than trusted.
  await db.execute({
    sql: "DELETE FROM studio_history WHERE id = ?",
    args: [renamed.entry.id],
  });
  const updatesBefore = await updateSeqs(db, song_id);
  const refused = refuses(
    await hub.redo({ song_id, cmd_id: "broken-3", entry_id: undone.entry.id, author: AGENT }),
    "human_only",
  );
  assert.match(refused.error, /not in this song's history/);
  assert.deepEqual(await updateSeqs(db, song_id), updatesBefore, "a refused step writes nothing");
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"].name, "Verse bass");

  // Two undo rows that point at each other never reach an ordinary command
  // either: the hop cap ends the walk and the answer is the same.
  const left = await appendHistory(db, {
    song_id,
    seq: 900,
    command: "history.undo",
    author: HUMAN,
    inverse: { before: {}, after: {} },
  });
  const right = await appendHistory(db, {
    song_id,
    seq: 901,
    command: "history.undo",
    author: HUMAN,
    inverse: { before: {}, after: {} },
    undo_of: left,
  });
  await db.execute({
    sql: "UPDATE studio_history SET undo_of = ? WHERE id = ?",
    args: [right, left],
  });
  refuses(
    await hub.redo({ song_id, cmd_id: "broken-4", entry_id: right, author: AGENT }),
    "human_only",
  );

  // The operator still takes the step back himself.
  const redone = await hub.redo({
    song_id,
    cmd_id: "broken-5",
    entry_id: undone.entry.id,
    author: HUMAN,
  });
  assert.equal(redone.ok, true, `the operator's redo was refused: ${redone.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.clips["bass-verse"].name, "Renamed");
});

test("if creating a song fails to save, no song row is left", async (t) => {
  const { disk, db, hub } = await setupFlaky(t);

  db.failNextBatch();
  const refused = refuses(
    await hub.createSong({ project_id: PROJECT, title: "Never saved", author: HUMAN }),
    "storage",
  );
  assert.equal(refused.error, "Studio could not save that change; nothing was changed.");
  assert.deepEqual(await hub.listSongs({ project_ids: [PROJECT] }), [], "no song row was left behind");
  assert.deepEqual(
    await rowCounts(disk),
    { songs: 0, updates: 0, history: 0 },
    "nothing was written at all",
  );

  // The next attempt is a whole song: one row and the first update of its own
  // empty document.
  const created = await hub.createSong({ project_id: PROJECT, title: "Saved this time", author: HUMAN });
  assert.equal(created.ok, true, `the second createSong was refused: ${created.error}`);
  assert.equal(created.snapshot_version, 1);
  assert.deepEqual(await rowCounts(disk), { songs: 1, updates: 1, history: 0 });
  const opened = await hub.openSong(created.song_id);
  assert.equal(opened.snapshot.meta.title, "Saved this time");
  assert.equal(opened.snapshot_version, 1);
});

test("an agent and the human reusing the same cmd_id do not collide", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);

  const agent = await hub.runCommand({
    song_id,
    cmd_id: "shared-cmd-id",
    command: "track.rename",
    args: { track_id: "bass", name: "Agent take" },
    author: AGENT,
  });
  assert.equal(agent.ok, true, `the agent's step was refused: ${agent.error}`);

  // The operator happens to pick the same id for their own step: that is a
  // different author's step, so it runs instead of replaying the agent's.
  const human = await hub.runCommand({
    song_id,
    cmd_id: "shared-cmd-id",
    command: "track.rename",
    args: { track_id: "bass", name: "Operator take" },
    author: HUMAN,
  });
  assert.equal(human.ok, true, `the operator's step was refused: ${human.error}`);
  assert.notEqual(human.entry.id, agent.entry.id);
  assert.equal(human.entry.author.kind, "human");
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].name, "Operator take");

  // Each author still gets their own answer back on a resend.
  assert.deepEqual(
    await hub.runCommand({
      song_id,
      cmd_id: "shared-cmd-id",
      command: "track.rename",
      args: { track_id: "bass", name: "Agent take" },
      author: AGENT,
    }),
    agent,
  );
  assert.deepEqual(
    await hub.runCommand({
      song_id,
      cmd_id: "shared-cmd-id",
      command: "track.rename",
      args: { track_id: "bass", name: "Operator take" },
      author: HUMAN,
    }),
    human,
  );
});

// --- The take rules (1b Task 1, part 2) -------------------------------------
//
// A recording is the one thing in a song that cannot be made again, so exactly
// two doors lead to it: `take.add` is Studio's own step, closed to every caller
// that does not say it comes from Studio, and a step that would drop a
// recorded take needs the operator's yes.

test("take.add is refused by the hub without internal:true", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);
  const { clip_id } = await seedAudioClip(hub, song_id);

  // The WS handler (web.js `handleMessage`, msg.type "command") and the agent
  // HTTP route (`POST ${AGENT}/songs/:id/command`) both call `hub.runCommand`
  // with exactly these fields and no `internal` flag, so this is what both of
  // those doors amount to. (The two routes are driven for real in
  // `tests/studio-routes.test.js`.)
  for (const author of [HUMAN, AGENT]) {
    const refused = refuses(
      await hub.runCommand({
        song_id,
        cmd_id: `take-add-over-wire-${author.kind}`,
        command: "take.add",
        args: { clip_id, take: makeTake(TAKE_A) },
        author,
      }),
      "studio_only",
    );
    assert.equal(refused.error, "This command can only be run by Studio itself.");
  }
  assert.deepEqual(
    (await hub.openSong(song_id)).snapshot.takes,
    {},
    "a refused take wrote nothing at all",
  );

  // MCP has no tool for it, and none for the people-only discard either.
  const names = await mcpToolNames(hub);
  assert.equal(names.includes("studio_take_add"), false, "take.add must not be an MCP tool");
  assert.equal(names.includes("studio_take_discard"), false, "take.discard is people-only");
  assert.equal(names.includes("studio_take_keep"), true, "an agent may keep a take");

  // Studio's own step — the upload finish route — goes through.
  const added = await addTake(hub, song_id, clip_id, makeTake(TAKE_A));
  assert.equal(added.entry.command, "take.add");
  const opened = await hub.openSong(song_id);
  assert.equal(opened.snapshot.takes[TAKE_A].clip_id, clip_id);
  assert.deepEqual(opened.snapshot.clips[clip_id].comp, [
    { take_id: TAKE_A, from_beat: 0, to_beat: 8 },
  ]);
});

test("agent take.discard is refused", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);
  const { clip_id } = await seedAudioClip(hub, song_id);
  await addTake(hub, song_id, clip_id, makeTake(TAKE_A));

  const refused = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "discard-agent",
      command: "take.discard",
      args: { clip_id, take_id: TAKE_A },
      author: AGENT,
    }),
    "human_only",
  );
  assert.match(refused.error, /Only a person can run "take\.discard"/);
  assert.equal(
    (await hub.openSong(song_id)).snapshot.takes[TAKE_A].discarded,
    false,
    "the refused discard changed nothing",
  );

  const discarded = await hub.runCommand({
    song_id,
    cmd_id: "discard-human",
    command: "take.discard",
    args: { clip_id, take_id: TAKE_A },
    author: HUMAN,
  });
  assert.equal(discarded.ok, true, `the operator's discard was refused: ${discarded.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.takes[TAKE_A].discarded, true);
});

test("agent clip.remove of a clip with takes is refused", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);
  const { track_id, clip_id } = await seedAudioClip(hub, song_id);
  await addTake(hub, song_id, clip_id, makeTake(TAKE_A));

  // The take goes with its clip, so removing the clip would lose a recording.
  const refused = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "clip-remove-agent",
      command: "clip.remove",
      args: { clip_id },
      author: AGENT,
    }),
    "human_only",
  );
  assert.equal(refused.error, "Removing recorded takes needs a yes from the operator.");
  const opened = await hub.openSong(song_id);
  assert.ok(opened.snapshot.clips[clip_id], "the refused removal wrote nothing");
  assert.ok(opened.snapshot.takes[TAKE_A]);

  // The same guard covers the whole track and the whole scene.
  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "track-remove-agent",
      command: "track.remove",
      args: { track_id },
      author: AGENT,
    }),
    "human_only",
  );
  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "scene-remove-agent",
      command: "scene.remove",
      args: { scene_id: "verse" },
      author: AGENT,
    }),
    "human_only",
  );
  assert.ok((await hub.openSong(song_id)).snapshot.takes[TAKE_A]);

  // The operator's own removal goes through, and the undo brings the clip and
  // its take back in one step.
  const removed = await hub.runCommand({
    song_id,
    cmd_id: "clip-remove-human",
    command: "clip.remove",
    args: { clip_id },
    author: HUMAN,
  });
  assert.equal(removed.ok, true, `the operator's removal was refused: ${removed.error}`);
  assert.deepEqual((await hub.openSong(song_id)).snapshot.takes, {});
  const back = await hub.undo({
    song_id,
    cmd_id: "clip-remove-undo",
    entry_id: removed.entry.id,
    author: HUMAN,
  });
  assert.equal(back.ok, true, `the operator's undo was refused: ${back.error}`);
  assert.ok((await hub.openSong(song_id)).snapshot.takes[TAKE_A]);
});

test("agent clip.remove of a clip with only discarded takes is refused", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);
  const { clip_id } = await seedAudioClip(hub, song_id);
  await addTake(hub, song_id, clip_id, makeTake(TAKE_A));

  const discarded = await hub.runCommand({
    song_id,
    cmd_id: "discard-before-agent-remove",
    command: "take.discard",
    args: { clip_id, take_id: TAKE_A },
    author: HUMAN,
  });
  assert.equal(discarded.ok, true, `the discard was refused: ${discarded.error}`);

  // Discarded is not gone: the recording still exists and `take.restore` brings
  // it back, so removing the clip that holds it still needs the operator.
  const refused = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "clip-remove-discarded-agent",
      command: "clip.remove",
      args: { clip_id },
      author: AGENT,
    }),
    "human_only",
  );
  assert.equal(refused.error, "Removing recorded takes needs a yes from the operator.");
  const opened = await hub.openSong(song_id);
  assert.ok(opened.snapshot.clips[clip_id], "the refused removal wrote nothing");
  assert.equal(opened.snapshot.takes[TAKE_A].discarded, true);
});

test("person clip.remove of a clip with discarded takes works", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);
  const { clip_id } = await seedAudioClip(hub, song_id);
  await addTake(hub, song_id, clip_id, makeTake(TAKE_A));

  const discarded = await hub.runCommand({
    song_id,
    cmd_id: "discard-before-human-remove",
    command: "take.discard",
    args: { clip_id, take_id: TAKE_A },
    author: HUMAN,
  });
  assert.equal(discarded.ok, true, `the discard was refused: ${discarded.error}`);

  const removed = await hub.runCommand({
    song_id,
    cmd_id: "clip-remove-discarded-human",
    command: "clip.remove",
    args: { clip_id },
    author: HUMAN,
  });
  assert.equal(removed.ok, true, `the operator's removal was refused: ${removed.error}`);
  assert.deepEqual((await hub.openSong(song_id)).snapshot.takes, {});

  // One undo brings the clip and its discarded take back together.
  const back = await hub.undo({
    song_id,
    cmd_id: "undo-remove-discarded-human",
    entry_id: removed.entry.id,
    author: HUMAN,
  });
  assert.equal(back.ok, true, `the operator's undo was refused: ${back.error}`);
  const reopened = (await hub.openSong(song_id)).snapshot;
  assert.ok(reopened.clips[clip_id]);
  assert.equal(reopened.takes[TAKE_A].discarded, true);
});

test("agent undo of take.add is refused", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);
  const { clip_id } = await seedAudioClip(hub, song_id);
  const added = await addTake(hub, song_id, clip_id, makeTake(TAKE_A));

  // Undoing the recording would delete the take, which only the operator may
  // decide.
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "undo-take-add-agent", entry_id: added.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(refused.error, "Removing recorded takes needs a yes from the operator.");
  assert.ok(
    (await hub.openSong(song_id)).snapshot.takes[TAKE_A],
    "the refused undo left the take where it was",
  );

  // The operator takes it back; an agent redoing that step puts the take back
  // rather than taking one away, so it is allowed.
  const undone = await hub.undo({
    song_id,
    cmd_id: "undo-take-add-human",
    entry_id: added.entry.id,
    author: HUMAN,
  });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);
  assert.deepEqual((await hub.openSong(song_id)).snapshot.takes, {});

  const redone = await hub.redo({
    song_id,
    cmd_id: "redo-take-add-agent",
    entry_id: undone.entry.id,
    author: AGENT,
  });
  assert.equal(redone.ok, true, `putting a take back should be an agent's step: ${redone.error}`);
  assert.ok((await hub.openSong(song_id)).snapshot.takes[TAKE_A]);
});

test("agent undo of take.discard is allowed", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);
  const { clip_id } = await seedAudioClip(hub, song_id);
  await addTake(hub, song_id, clip_id, makeTake(TAKE_A));

  const discarded = await hub.runCommand({
    song_id,
    cmd_id: "discard-for-undo",
    command: "take.discard",
    args: { clip_id, take_id: TAKE_A },
    author: HUMAN,
  });
  assert.equal(discarded.ok, true, `the operator's discard was refused: ${discarded.error}`);
  assert.deepEqual((await hub.openSong(song_id)).snapshot.clips[clip_id].comp, []);

  // Taking the discard back puts the take and its comp segments back — exactly
  // what `take.restore`, an ordinary agent edit, does — so an agent may.
  const undone = await hub.undo({
    song_id,
    cmd_id: "undo-discard-agent",
    entry_id: discarded.entry.id,
    author: AGENT,
  });
  assert.equal(undone.ok, true, `an agent's undo of a discard should be allowed: ${undone.error}`);
  const restored = (await hub.openSong(song_id)).snapshot;
  assert.equal(restored.takes[TAKE_A].discarded, false);
  assert.deepEqual(restored.clips[clip_id].comp, [{ take_id: TAKE_A, from_beat: 0, to_beat: 8 }]);

  // Discarding again is still people-only: a redo of the discard is refused,
  // and so is taking back the undo that restored the take.
  refuses(
    await hub.redo({ song_id, cmd_id: "redo-discard-agent", entry_id: undone.entry.id, author: AGENT }),
    "human_only",
  );

  const relDiscard = await hub.redo({
    song_id,
    cmd_id: "redo-discard-human",
    entry_id: undone.entry.id,
    author: HUMAN,
  });
  assert.equal(relDiscard.ok, true, `the operator's redo was refused: ${relDiscard.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.takes[TAKE_A].discarded, true);

  // An agent may put the take back however deep the chain goes, because a
  // restore is a restore.
  const restoredAgain = await hub.undo({
    song_id,
    cmd_id: "undo-redo-agent",
    entry_id: relDiscard.entry.id,
    author: AGENT,
  });
  assert.equal(restoredAgain.ok, true, `an undo that restores a take should be allowed: ${restoredAgain.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.takes[TAKE_A].discarded, false);

  // Taking back that undo discards the take again, which is the people-only
  // command itself, so it is refused.
  const refusedLast = refuses(
    await hub.undo({
      song_id,
      cmd_id: "undo-restore-agent",
      entry_id: restoredAgain.entry.id,
      author: AGENT,
    }),
    "human_only",
  );
  assert.match(refusedLast.error, /people-only/);
  assert.equal(
    (await hub.openSong(song_id)).snapshot.takes[TAKE_A].discarded,
    false,
    "the refused undo left the restore in place",
  );
});

test("agent undo of take.restore is refused", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);
  const { clip_id } = await seedAudioClip(hub, song_id);
  await addTake(hub, song_id, clip_id, makeTake(TAKE_A));

  const discarded = await hub.runCommand({
    song_id,
    cmd_id: "discard-before-restore",
    command: "take.discard",
    args: { clip_id, take_id: TAKE_A },
    author: HUMAN,
  });
  assert.equal(discarded.ok, true, `the operator's discard was refused: ${discarded.error}`);
  const restored = await hub.runCommand({
    song_id,
    cmd_id: "restore-before-undo",
    command: "take.restore",
    args: { clip_id, take_id: TAKE_A },
    author: HUMAN,
  });
  assert.equal(restored.ok, true, `the restore was refused: ${restored.error}`);

  // Taking the restore back would discard a live recording: the people-only
  // `take.discard` reached by the back door of the history.
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "undo-restore-agent", entry_id: restored.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(refused.error, "Removing recorded takes needs a yes from the operator.");
  const opened = await hub.openSong(song_id);
  assert.equal(opened.snapshot.takes[TAKE_A].discarded, false, "the refused undo left the take live");
  // `take.restore` clears the flag and nothing else, so the comp the discard
  // emptied stays empty until somebody comps the take in again.
  assert.deepEqual(opened.snapshot.clips[clip_id].comp, []);

  // The operator's own undo of the restore goes through.
  const undone = await hub.undo({
    song_id,
    cmd_id: "undo-restore-human",
    entry_id: restored.entry.id,
    author: HUMAN,
  });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.takes[TAKE_A].discarded, true);
});

test("agent redo of an undo of take.restore is refused", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedSong(hub);
  const { clip_id } = await seedAudioClip(hub, song_id);
  await addTake(hub, song_id, clip_id, makeTake(TAKE_A));

  const discarded = await hub.runCommand({
    song_id,
    cmd_id: "discard-for-restore-redo",
    command: "take.discard",
    args: { clip_id, take_id: TAKE_A },
    author: HUMAN,
  });
  assert.equal(discarded.ok, true, `the operator's discard was refused: ${discarded.error}`);
  const restored = await hub.runCommand({
    song_id,
    cmd_id: "restore-for-redo",
    command: "take.restore",
    args: { clip_id, take_id: TAKE_A },
    author: HUMAN,
  });
  assert.equal(restored.ok, true, `the restore was refused: ${restored.error}`);

  // The operator takes the restore back, which is the undo an agent may not
  // redo: a history step never moves a take's discarded flag for an agent,
  // whichever way it would go.
  const undone = await hub.undo({
    song_id,
    cmd_id: "undo-restore-for-redo",
    entry_id: restored.entry.id,
    author: HUMAN,
  });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.takes[TAKE_A].discarded, true);

  const refused = refuses(
    await hub.redo({ song_id, cmd_id: "redo-undo-restore-agent", entry_id: undone.entry.id, author: AGENT }),
    "human_only",
  );
  assert.match(refused.error, /changes whether a take is discarded/);
  assert.equal(
    (await hub.openSong(song_id)).snapshot.takes[TAKE_A].discarded,
    true,
    "the refused redo changed nothing",
  );

  // The operator may redo it; the take is live again.
  const redone = await hub.redo({
    song_id,
    cmd_id: "redo-undo-restore-human",
    entry_id: undone.entry.id,
    author: HUMAN,
  });
  assert.equal(redone.ok, true, `the operator's redo was refused: ${redone.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.takes[TAKE_A].discarded, false);
});

// --- Who can change a sound --------------------------------------------------

/** @returns {string} the container key of one pad. */
function padPath(track_id, bank_id, index) {
  return `${track_id}/${bank_id}/${index}`;
}

test("agent cannot narrow a whole-sample pad to a slice", async (t) => {
  const { hub } = await setup(t);
  const { song_id, track_id, bank_id } = await seedSampleSong(hub);
  // A slice of the sample the pad plays whole.
  await applies(hub, song_id, "slice-tiny", "slice.set", {
    sample_id: SAMPLE_A,
    slices: [{ id: "tiny", start_frame: 0, end_frame: 1 }],
  });
  const narrowed = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-narrow",
      command: "pad.assign",
      args: { track_id, bank_id, index: 0, sample_id: SAMPLE_A, slice_id: "tiny" },
      author: AGENT,
    }),
    "human_only",
  );
  assert.equal(narrowed.error, SOUNDS_NEED_A_YES);
  const pad = (await hub.openSong(song_id)).snapshot.pads[padPath(track_id, bank_id, 0)];
  assert.equal(pad.slice_id ?? null, null, "the pad still plays the whole sample");
});

test("an agent can put a shared sample on an unlocked track while a locked track plays it", async (t) => {
  const { hub } = await setup(t);
  const { song_id } = await seedSampleSong(hub);
  await applies(hub, song_id, "kit2", "track.add", { id: "kit2", name: "Kit two", kind: "sampler" });
  await applies(hub, song_id, "lock-kit", "track.lock", { track_id: "kit" });
  const bank2 = Object.values((await hub.openSong(song_id)).snapshot.banks).find((b) => b.track_id === "kit2");
  await applies(
    hub,
    song_id,
    "agent-share",
    "pad.assign",
    { track_id: "kit2", bank_id: bank2.id, index: 0, sample_id: SAMPLE_A },
    AGENT,
  );
  assert.equal((await hub.openSong(song_id)).snapshot.pads[padPath("kit2", bank2.id, 0)].sample_id, SAMPLE_A);
});

test("agent cannot drop a pad's sample", async (t) => {
  const { hub } = await setup(t);
  const { song_id, track_id, bank_id, assigned } = await seedSampleSong(hub);
  await addSample(hub, song_id, makeSample(SAMPLE_B));
  const pad = padPath(track_id, bank_id, 0);

  // Repointing a pad that plays a sample takes that sound away.
  const repointed = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-repoint-pad",
      command: "pad.assign",
      args: { track_id, bank_id, index: 0, sample_id: SAMPLE_B },
      author: AGENT,
    }),
    "human_only",
  );
  assert.equal(repointed.error, SOUNDS_NEED_A_YES);
  assert.equal((await hub.openSong(song_id)).snapshot.pads[pad].sample_id, SAMPLE_A);

  // An empty pad may be filled: only a sound that is already there can be lost.
  const filled = await applies(
    hub,
    song_id,
    "agent-fill-empty-pad",
    "pad.assign",
    { track_id, bank_id, index: 1, sample_id: SAMPLE_B },
    AGENT,
  );
  assert.equal((await hub.openSong(song_id)).snapshot.pads[padPath(track_id, bank_id, 1)].sample_id, SAMPLE_B);

  // Taking that back would drop a sound, whoever put it there.
  const undoneOwn = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-fill", entry_id: filled.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(undoneOwn.error, SOUNDS_NEED_A_YES);

  // Nor may it take the operator's own assignment back.
  const undoneOperator = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-assign", entry_id: assigned.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(undoneOperator.error, SOUNDS_NEED_A_YES);
  const opened = await hub.openSong(song_id);
  assert.equal(opened.snapshot.pads[pad].sample_id, SAMPLE_A, "the refused undos left both pads alone");
  assert.equal(opened.snapshot.pads[padPath(track_id, bank_id, 1)].sample_id, SAMPLE_B);

  // Everything about the pad that is not its sound stays an agent's to edit.
  const softer = await applies(
    hub,
    song_id,
    "agent-pad-gain",
    "pad.set",
    { track_id, bank_id, index: 0, fields: { gain_db: -6, pitch: 3 } },
    AGENT,
  );
  assert.equal(softer.entry.command, "pad.set");
  assert.equal((await hub.openSong(song_id)).snapshot.pads[pad].gain_db, -6);
});

test("pad.clear is the operator's own and keeps the pad's settings", async (t) => {
  const { hub } = await setup(t);
  const { song_id, track_id, bank_id } = await seedSampleSong(hub);
  const pad = padPath(track_id, bank_id, 0);

  // The pad's own settings, which clearing it must leave alone.
  await applies(hub, song_id, "operator-pad-settings", "pad.set", {
    track_id,
    bank_id,
    index: 0,
    fields: { name: "Snare", gain_db: -4, mode: "gate", choke: 2 },
  });

  // An agent may not empty a pad: taking a sound away is the operator's yes.
  const refused = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-clear-pad",
      command: "pad.clear",
      args: { track_id, bank_id, index: 0 },
      author: AGENT,
    }),
    "human_only",
  );
  assert.match(refused.error, /Only a person can run "pad.clear"/);
  assert.equal(
    (await hub.openSong(song_id)).snapshot.pads[pad].sample_id,
    SAMPLE_A,
    "the refused clear wrote nothing",
  );

  // The operator's own clear goes through: the sound guard that stops an agent
  // is not in the operator's way.
  const cleared = await applies(hub, song_id, "operator-clear-pad", "pad.clear", {
    track_id,
    bank_id,
    index: 0,
  });
  const after = (await hub.openSong(song_id)).snapshot.pads[pad];
  assert.equal(after.sample_id, null);
  assert.equal(after.slice_id, null);
  assert.equal(after.name, "Snare");
  assert.equal(after.gain_db, -4);
  assert.equal(after.mode, "gate");
  assert.equal(after.choke, 2);

  // One undo step, and the sound is back on the pad.
  const undone = await hub.undo({
    song_id,
    cmd_id: "operator-undo-clear",
    entry_id: cleared.entry.id,
    author: HUMAN,
  });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);
  const back = (await hub.openSong(song_id)).snapshot.pads[pad];
  assert.equal(back.sample_id, SAMPLE_A);
  assert.equal(back.name, "Snare");
});

test("agent cannot remove a sampler track with samples, replace its device, or undo a bank.add that holds samples", async (t) => {
  const { hub, db } = await setup(t);
  const { song_id, track_id, bank_id, tracked } = await seedSampleSong(hub);

  // Removing the track would take the bank and the sound on its pad with it.
  const removed = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-track-remove",
      command: "track.remove",
      args: { track_id },
      author: AGENT,
    }),
    "human_only",
  );
  assert.equal(removed.error, SOUNDS_NEED_A_YES);
  const kept = await hub.openSong(song_id);
  assert.ok(kept.snapshot.tracks.find((track) => track.id === track_id), "the refused removal wrote nothing");
  assert.equal(kept.snapshot.pads[padPath(track_id, bank_id, 0)].sample_id, SAMPLE_A);

  // A sampler track's device is its kit's engine: a module swap is refused for
  // everyone, and no step writes it.
  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-swap-device",
      command: "track.set_device",
      args: { track_id, type: "SpectraVoice" },
      author: AGENT,
    }),
    "invalid",
  );
  assert.deepEqual(
    (await hub.openSong(song_id)).snapshot.tracks.find((track) => track.id === track_id).device,
    { engine: "sampler" },
    "the device is still the kit's",
  );

  // The other door onto a device is the history, and no command can record a
  // swap onto a kit: this step is written straight into the table, the way a
  // step from an older build might be, and the hub still refuses the step an
  // agent would take back from it.
  const swap = await appendHistory(db, {
    song_id,
    seq: 500,
    command: "track.set_device",
    author: HUMAN,
    touched: [`track:${track_id}`],
    inverse: {
      before: {
        [`track:${track_id}|device`]: { engine: "sunvox", type: "Analog generator", params: {} },
      },
      after: { [`track:${track_id}|device`]: { engine: "sampler" } },
    },
  });
  const swapped = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-device", entry_id: swap, author: AGENT }),
    "human_only",
  );
  assert.equal(swapped.error, SOUNDS_NEED_A_YES);
  assert.deepEqual(
    (await hub.openSong(song_id)).snapshot.tracks.find((track) => track.id === track_id).device,
    { engine: "sampler" },
    "the refused step left the kit's engine alone",
  );

  // A bank an operator added, and whose pad plays a sample, cannot be taken back
  // by an agent: its pads go with it.
  const banker = await applies(hub, song_id, "operator-bank-b", "bank.add", { track_id, name: "B" }, HUMAN);
  const second = Object.values((await hub.openSong(song_id)).snapshot.banks).find(
    (bank) => bank.track_id === track_id && bank.name === "B",
  );
  assert.ok(second, "the operator's bank is there");
  await applies(
    hub,
    song_id,
    "operator-pad-on-b",
    "pad.assign",
    { track_id, bank_id: second.id, index: 0, sample_id: SAMPLE_A },
    HUMAN,
  );

  const undoneBank = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-bank-add", entry_id: banker.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(undoneBank.error, SOUNDS_NEED_A_YES);
  const after = await hub.openSong(song_id);
  assert.ok(after.snapshot.banks[`${track_id}/${second.id}`], "the refused undo left the bank in the kit");
  assert.equal(after.snapshot.pads[padPath(track_id, second.id, 0)].sample_id, SAMPLE_A);

  // The same rule closes the history door for the whole track: undoing an
  // operator's addition of a kit that now holds a sound is not an agent's step.
  refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-track-add", entry_id: tracked.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(
    (await hub.openSong(song_id)).snapshot.pads[padPath(track_id, bank_id, 0)].sample_id,
    SAMPLE_A,
    "the refused undo left the sound on its pad",
  );
});

test("an agent re-chop of a sample used by a locked track is refused", async (t) => {
  const { hub } = await setup(t);
  const { song_id, track_id } = await seedSampleSong(hub);
  await applies(hub, song_id, "operator-lock", "track.lock", { track_id }, HUMAN);

  // The sample is on a pad of the locked track, so the chop is a write to it.
  const chopped = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-chop-locked",
      command: "slice.set",
      args: { sample_id: SAMPLE_A, slices: [{ id: "one", start_frame: 0, end_frame: 24000 }] },
      author: AGENT,
    }),
    "locked",
  );
  assert.match(chopped.error, /locked by the operator/);
  assert.deepEqual((await hub.openSong(song_id)).snapshot.slices, {}, "the refused chop wrote nothing");

  // A rename writes the same sample, and so touches the same track.
  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-rename-locked",
      command: "sample.rename",
      args: { sample_id: SAMPLE_A, name: "Break" },
      author: AGENT,
    }),
    "locked",
  );
  assert.equal((await hub.openSong(song_id)).snapshot.samples[SAMPLE_A].name, "Drum loop");

  // The lock is the operator's to lift, and then the same chop is an agent's.
  await applies(hub, song_id, "operator-unlock", "track.unlock", { track_id }, HUMAN);
  await applies(
    hub,
    song_id,
    "agent-chop-unlocked",
    "slice.set",
    { sample_id: SAMPLE_A, slices: [{ id: "one", start_frame: 0, end_frame: 24000 }] },
    AGENT,
  );
  assert.equal(
    (await hub.openSong(song_id)).snapshot.slices[`${SAMPLE_A}/one`].end_frame,
    24000,
  );
});

test("agent undo of sample.add is refused", async (t) => {
  const { hub } = await setup(t);
  const created = await hub.createSong({ project_id: PROJECT, title: "Samples", author: HUMAN });
  const song_id = created.song_id;
  const added = await addSample(hub, song_id, makeSample(SAMPLE_A));

  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-sample-add", entry_id: added.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(refused.error, SOUNDS_NEED_A_YES);
  assert.ok((await hub.openSong(song_id)).snapshot.samples[SAMPLE_A], "the refused undo left the sample");

  // The operator takes it back, and the operator is the one who puts it back:
  // a sample is refused in both directions, unlike a take.
  const undone = await hub.undo({
    song_id,
    cmd_id: "operator-undo-sample-add",
    entry_id: added.entry.id,
    author: HUMAN,
  });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);
  assert.deepEqual((await hub.openSong(song_id)).snapshot.samples, {});

  const redoRefused = refuses(
    await hub.redo({ song_id, cmd_id: "agent-redo-sample-add", entry_id: undone.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(redoRefused.error, SOUNDS_NEED_A_YES);
  assert.deepEqual((await hub.openSong(song_id)).snapshot.samples, {}, "the refused redo wrote nothing");

  const redone = await hub.redo({
    song_id,
    cmd_id: "operator-redo-sample-add",
    entry_id: undone.entry.id,
    author: HUMAN,
  });
  assert.equal(redone.ok, true, `the operator's redo was refused: ${redone.error}`);
  assert.ok((await hub.openSong(song_id)).snapshot.samples[SAMPLE_A]);
});

test("agent can edit steps, locks, patterns and chains", async (t) => {
  const { hub } = await setup(t);
  const { song_id, track_id, bank_id, clip_id } = await seedSampleSong(hub);
  const where = { clip_id, pattern_id: "a", at: 0, bank_id, index: 0 };

  await applies(hub, song_id, "agent-step-on", "step.toggle", { ...where, v: 110 }, AGENT);
  await applies(hub, song_id, "agent-step-lock", "step.set", { ...where, locks: { cutoff_hz: 2500 } }, AGENT);
  await applies(hub, song_id, "agent-step-clear", "step.clear_locks", where, AGENT);
  await applies(hub, song_id, "agent-step-velocity", "step.set", { ...where, v: 64 }, AGENT);

  const second = (
    await applies(hub, song_id, "agent-pattern-add", "pattern.add", { clip_id, name: "Fill" }, AGENT)
  ).entry.args.id;
  await applies(
    hub,
    song_id,
    "agent-pattern-rename",
    "pattern.rename",
    { clip_id, pattern_id: second, name: "Fill bar" },
    AGENT,
  );
  await applies(hub, song_id, "agent-pattern-length", "pattern.set_length", { clip_id, length_steps: 32 }, AGENT);
  await applies(hub, song_id, "agent-pattern-steps", "pattern.set_steps_beat", { clip_id, step_beats: 0.5 }, AGENT);
  await applies(hub, song_id, "agent-pattern-swing", "pattern.set_swing", { clip_id, swing: 0.5 }, AGENT);
  await applies(hub, song_id, "agent-chain", "chain.set", { clip_id, chain: ["a", second] }, AGENT);

  // The track is unlocked, so the sound itself is still an agent's to rename and
  // to chop: only losing one needs the operator.
  await applies(
    hub,
    song_id,
    "agent-sample-rename",
    "sample.rename",
    { sample_id: SAMPLE_A, name: "Break" },
    AGENT,
  );
  await applies(
    hub,
    song_id,
    "agent-sample-chop",
    "slice.set",
    { sample_id: SAMPLE_A, slices: [{ id: "one", start_frame: 0, end_frame: 24000 }] },
    AGENT,
  );

  const snap = (await hub.openSong(song_id)).snapshot;
  assert.equal(snap.clips[clip_id].swing, 0.5);
  assert.equal(snap.clips[clip_id].length_steps, 32);
  assert.deepEqual(snap.clips[clip_id].chain, ["a", second]);
  assert.equal(snap.patterns[`${clip_id}/${second}`].name, "Fill bar");
  assert.equal(snap.steps[`${clip_id}/a/0/${bank_id}.0`].v, 64);
  assert.deepEqual(snap.steps[`${clip_id}/a/0/${bank_id}.0`].locks, {});
  assert.equal(snap.samples[SAMPLE_A].name, "Break");
  assert.equal(snap.pads[padPath(track_id, bank_id, 0)].sample_id, SAMPLE_A, "the pad still plays it");
});

test("a human can drop a pad's sample and undo it", async (t) => {
  const { hub } = await setup(t);
  const { song_id, track_id, bank_id, assigned } = await seedSampleSong(hub);
  const pad = padPath(track_id, bank_id, 0);

  // The operator drops the pad's sound by taking the assignment back...
  const dropped = await hub.undo({
    song_id,
    cmd_id: "operator-drop-sample",
    entry_id: assigned.entry.id,
    author: HUMAN,
  });
  assert.equal(dropped.ok, true, `the operator's undo was refused: ${dropped.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.pads[pad].sample_id, null);

  // ... and puts it back by undoing that, with nobody asked for a yes.
  const back = await hub.redo({
    song_id,
    cmd_id: "operator-restore-sample",
    entry_id: dropped.entry.id,
    author: HUMAN,
  });
  assert.equal(back.ok, true, `the operator's redo was refused: ${back.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.pads[pad].sample_id, SAMPLE_A);

  // A person repoints the pad, re-chops the sample it no longer plays, and takes
  // a sampler track with a sound on it away and back.
  await addSample(hub, song_id, makeSample(SAMPLE_B));
  await applies(
    hub,
    song_id,
    "operator-repoint-pad",
    "pad.assign",
    { track_id, bank_id, index: 0, sample_id: SAMPLE_B },
    HUMAN,
  );
  await applies(
    hub,
    song_id,
    "operator-rechop",
    "slice.set",
    { sample_id: SAMPLE_A, slices: [{ id: "one", start_frame: 0, end_frame: 24000 }] },
    HUMAN,
  );
  const removed = await applies(hub, song_id, "operator-track-remove", "track.remove", { track_id }, HUMAN);
  assert.equal((await hub.openSong(song_id)).snapshot.tracks.length, 0);

  const restored = await hub.undo({
    song_id,
    cmd_id: "operator-undo-remove",
    entry_id: removed.entry.id,
    author: HUMAN,
  });
  assert.equal(restored.ok, true, `the operator's undo was refused: ${restored.error}`);
  const reopened = (await hub.openSong(song_id)).snapshot;
  assert.equal(reopened.tracks.length, 1);
  assert.equal(reopened.pads[pad].sample_id, SAMPLE_B, "the pad came back with its sound");
  assert.ok(reopened.samples[SAMPLE_A], "a sample belongs to the song, not to the track");
});

// --- A soundfont track's instrument -------------------------------------------

/** What the agent's font guard answers with, word for word. */
const FONT_NEEDS_A_YES = "Only the operator changes the instrument a track plays.";

/** What the agent's library guard answers with, word for word. */
const LIBRARY_NEEDS_A_YES = "Only the operator adds or removes an instrument in the library.";

/** A font's sha256, as the gateway's library route measures it. */
const FONT_HASH = "a1b2c3d4".repeat(8);

/**
 * The library entry `library.add` accepts, as the gateway's library routes build
 * it once the file is stored and hashed.
 * @param {string} id
 * @param {object} [overrides]
 * @returns {object}
 */
function makeFont(id, overrides = {}) {
  return {
    id,
    kind: "font",
    name: `Font ${id}`,
    source: "catalog",
    catalog_id: `catalog-${id}`,
    storage_key: `studio/library/${id}.sf3`,
    sha256: FONT_HASH,
    bytes: 1024,
    licence: "MIT",
    credit: "MuseScore_General by S. Christian Collins and the MuseScore team",
    author_label: "the operator",
    ...overrides,
  };
}

/**
 * Add one font the way Studio itself does: `internal: true`, as the gateway's
 * library routes issue it.
 * @param {object} hub
 * @param {string} song_id
 * @param {object} font
 * @returns {Promise<object>} the applied step's result
 */
async function addFont(hub, song_id, font) {
  const added = await hub.runCommand({
    song_id,
    cmd_id: `add-font-${font.id}`,
    command: "library.add",
    args: { entry: font },
    author: HUMAN,
    internal: true,
  });
  assert.equal(added.ok, true, `library.add was refused: ${added.error}`);
  return added;
}

/**
 * A song with two fonts in its library and one soundfont track playing the
 * first of them — the shape every instrument rule is about.
 * @param {object} hub
 * @returns {Promise<{song_id: string, tracked: object}>}
 */
async function seedFontSong(hub) {
  const created = await hub.createSong({ project_id: PROJECT, title: "Fonts", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const song_id = created.song_id;
  await addFont(hub, song_id, makeFont("font-a"));
  await addFont(hub, song_id, makeFont("font-b"));
  const tracked = await applies(hub, song_id, "seed-keys", "track.add", {
    id: "keys",
    name: "Keys",
    kind: "soundfont",
    font_id: "font-a",
  });
  return { song_id, tracked };
}

test("an agent may change a program but not remove or replace a font", async (t) => {
  const { hub } = await setup(t);
  const { song_id } = await seedFontSong(hub);

  // Choosing what a track plays out of its font is an ordinary agent edit.
  const played = await applies(
    hub,
    song_id,
    "agent-program",
    "track.set_program",
    { track_id: "keys", bank: 0, program: 40 },
    AGENT,
  );
  assert.equal(played.entry.command, "track.set_program");
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].device.program, 40);

  // Even taking that back is the agent's own step: a program is a setting of
  // the instrument, not the instrument.
  const undone = await hub.undo({
    song_id,
    cmd_id: "agent-undo-program",
    entry_id: played.entry.id,
    author: AGENT,
  });
  assert.equal(undone.ok, true, `the agent's undo of its own program change was refused: ${undone.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].device.program, 0);

  // The font it plays is not: another bank is another sound.
  const replaced = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-set-font",
      command: "track.set_font",
      args: { track_id: "keys", font_id: "font-b" },
      author: AGENT,
    }),
    "human_only",
  );
  assert.equal(replaced.error, FONT_NEEDS_A_YES);
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].device.font_id, "font-a");

  // Nor is the entry itself: a font a track still plays cannot be taken out of
  // the library, whoever asks.
  const removed = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-remove-font",
      command: "library.remove",
      args: { library_id: "font-a" },
      author: AGENT,
    }),
    "conflict",
  );
  assert.match(removed.error, /in use by track "Keys"/);
  assert.ok((await hub.openSong(song_id)).snapshot.library["font-a"], "the refused removal wrote nothing");

  // The operator chooses the other font, and the history door onto that choice
  // is closed for an agent as well: taking the step back would put the sound
  // this session replaced back, which is the same decision.
  const chosen = await applies(
    hub,
    song_id,
    "operator-set-font",
    "track.set_font",
    { track_id: "keys", font_id: "font-b" },
    HUMAN,
  );
  const undoneChoice = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-font", entry_id: chosen.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(undoneChoice.error, FONT_NEEDS_A_YES);
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].device.font_id, "font-b");

  // The font nothing plays any more is an agent's to tidy away...
  await applies(
    hub,
    song_id,
    "agent-remove-unused-font",
    "library.remove",
    { library_id: "font-a" },
    AGENT,
  );
  assert.equal((await hub.openSong(song_id)).snapshot.library["font-a"], undefined);

  // ... while the one the track plays stays out of reach, and the program is
  // still the agent's to set.
  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-remove-used-font",
      command: "library.remove",
      args: { library_id: "font-b" },
      author: AGENT,
    }),
    "conflict",
  );
  await applies(
    hub,
    song_id,
    "agent-drums",
    "track.set_program",
    { track_id: "keys", bank: 128, program: 0 },
    AGENT,
  );
  const device = (await hub.openSong(song_id)).snapshot.tracks[0].device;
  assert.equal(device.bank, 128);
  assert.equal(device.program, 0);
  assert.equal(device.font_id, "font-b");
});

test("an agent cannot remove a track that plays a font", async (t) => {
  const { hub } = await setup(t);
  const { song_id, tracked } = await seedFontSong(hub);

  // A track that plays a font holds an instrument the way a sampler track holds
  // the sounds on its pads: removing the track would take the font out of the
  // song, so the step is the operator's.
  const removed = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-remove-font-track",
      command: "track.remove",
      args: { track_id: "keys" },
      author: AGENT,
    }),
    "human_only",
  );
  assert.equal(removed.error, FONT_NEEDS_A_YES);
  const kept = await hub.openSong(song_id);
  assert.equal(kept.snapshot.tracks.length, 1, "the refused removal wrote nothing");
  assert.equal(kept.snapshot.tracks[0].device.font_id, "font-a");
  assert.ok(kept.snapshot.library["font-a"], "the font it plays is still in the library");

  // The history door onto the same loss is closed: undoing the operator's
  // `track.add` would take the track and its instrument away in one step.
  const undone = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-font-track", entry_id: tracked.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(undone.error, FONT_NEEDS_A_YES);
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].device.font_id, "font-a");
});

test("an agent cannot replace a font by removing and re-adding the track", async (t) => {
  const { hub } = await setup(t);
  const { song_id } = await seedFontSong(hub);

  // The two-step way round the font rule would be: take the track away, then put
  // a track of the same id back on another font. The first step is refused on
  // what it would lose...
  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-remove-then-readd-1",
      command: "track.remove",
      args: { track_id: "keys" },
      author: AGENT,
    }),
    "human_only",
  );

  // ... and the second cannot land on an id the song still holds, so the font
  // the track plays is the one it played all along.
  const readded = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-remove-then-readd-2",
      command: "track.add",
      args: { id: "keys", name: "Keys", kind: "soundfont", font_id: "font-b" },
      author: AGENT,
    }),
    "invalid",
  );
  assert.match(readded.error, /already exists/);
  const snap = (await hub.openSong(song_id)).snapshot;
  assert.equal(snap.tracks.length, 1);
  assert.equal(snap.tracks[0].device.font_id, "font-a");
});

test("an agent cannot redo the operator's removal of a font track", async (t) => {
  const { hub } = await setup(t);
  const { song_id } = await seedFontSong(hub);

  // The operator takes the track away, which is theirs to do.
  const removed = await applies(
    hub,
    song_id,
    "operator-remove-font-track",
    "track.remove",
    { track_id: "keys" },
    HUMAN,
  );
  assert.equal((await hub.openSong(song_id)).snapshot.tracks.length, 0);

  // An agent may put it back: a restore takes nothing away.
  const restored = await hub.undo({
    song_id,
    cmd_id: "agent-undo-font-track-removal",
    entry_id: removed.entry.id,
    author: AGENT,
  });
  assert.equal(restored.ok, true, `the agent's undo of the removal was refused: ${restored.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.tracks[0].device.font_id, "font-a");

  // Taking that undo back is removing the font track again, so it is not an
  // agent's step — decided on the writes, not on the command it moves.
  const redone = refuses(
    await hub.redo({ song_id, cmd_id: "agent-redo-font-track-removal", entry_id: restored.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(redone.error, FONT_NEEDS_A_YES);
  const after = await hub.openSong(song_id);
  assert.equal(after.snapshot.tracks.length, 1, "the refused redo wrote nothing");
  assert.equal(after.snapshot.tracks[0].device.font_id, "font-a");
});

test("an agent cannot undo the operator's library removal", async (t) => {
  const { hub } = await setup(t);
  const { song_id } = await seedFontSong(hub);

  // The unused font is the operator's to tidy away...
  const dropped = await applies(
    hub,
    song_id,
    "operator-remove-unused-font",
    "library.remove",
    { library_id: "font-b" },
    HUMAN,
  );
  assert.equal((await hub.openSong(song_id)).snapshot.library["font-b"], undefined);

  // ... and the step that puts it back is the same decision the other way round:
  // a library file neither arrives nor leaves on an agent's say-so, whatever
  // command the step moves (this one moves `library.remove`, not `library.add`).
  const undone = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-unused-font", entry_id: dropped.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(undone.error, LIBRARY_NEEDS_A_YES);
  const kept = await hub.openSong(song_id);
  assert.equal(kept.snapshot.library["font-b"], undefined, "the refused undo put nothing back");
  assert.ok(kept.snapshot.library["font-a"], "the font the track plays is untouched");

  // The operator's own undo still works.
  const back = await hub.undo({
    song_id,
    cmd_id: "operator-undo-unused-font",
    entry_id: dropped.entry.id,
    author: HUMAN,
  });
  assert.equal(back.ok, true, `the operator's undo was refused: ${back.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.library["font-b"].sha256, FONT_HASH);
});

test("set_font is not refused by a lock on another track using the same font", async (t) => {
  const { hub } = await setup(t);
  const { song_id } = await seedFontSong(hub);
  await applies(hub, song_id, "seed-pads", "track.add", {
    id: "pads",
    name: "Pads",
    kind: "soundfont",
    font_id: "font-a",
  });
  await applies(hub, song_id, "operator-lock-pads", "track.lock", { track_id: "pads" }, HUMAN);

  // Both tracks play font-a, but a font change is one field of THIS track's
  // device: a font is shared and a track's instrument is its own, so the lock on
  // the other track has nothing to say about this write — the font's entry is not
  // touched by it.
  await applies(
    hub,
    song_id,
    "agent-keep-font",
    "track.set_font",
    { track_id: "keys", font_id: "font-a" },
    AGENT,
  );

  // The other font is still the operator's choice, and the answer is the font
  // rule's — not the lock the second track carries.
  const moved = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-set-font-on-unlocked",
      command: "track.set_font",
      args: { track_id: "keys", font_id: "font-b" },
      author: AGENT,
    }),
    "human_only",
  );
  assert.equal(moved.error, FONT_NEEDS_A_YES);

  // The operator may choose it, locked neighbour and all.
  await applies(
    hub,
    song_id,
    "operator-set-font-on-unlocked",
    "track.set_font",
    { track_id: "keys", font_id: "font-b" },
    HUMAN,
  );
  const snap = (await hub.openSong(song_id)).snapshot;
  assert.equal(snap.tracks.find((track) => track.id === "keys").device.font_id, "font-b");
  assert.equal(snap.tracks.find((track) => track.id === "pads").device.font_id, "font-a");

  // The locked track's own instrument is still the operator's...
  refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-set-font-on-locked",
      command: "track.set_font",
      args: { track_id: "pads", font_id: "font-b" },
      author: AGENT,
    }),
    "locked",
  );

  // ... and the font it plays is still in use, because `library.remove` keeps
  // the library-to-tracks mapping both the lock check and its own rule need: an
  // agent meets the lock, and the operator meets the "in use" refusal.
  const lockedRemove = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-remove-pads-font",
      command: "library.remove",
      args: { library_id: "font-a" },
      author: AGENT,
    }),
    "locked",
  );
  assert.match(lockedRemove.error, /Track "Pads" is locked by the operator/);
  const inUse = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "operator-remove-pads-font",
      command: "library.remove",
      args: { library_id: "font-a" },
      author: HUMAN,
    }),
    "conflict",
  );
  assert.match(inUse.error, /in use by track "Pads"/);
});

test("undo of library.add is people-only", async (t) => {
  const { hub } = await setup(t);
  const created = await hub.createSong({ project_id: PROJECT, title: "Library", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const song_id = created.song_id;

  // Nobody outside Studio adds a library file, and an agent cannot pretend to
  // be Studio: the route's own word (`internal`) is what the hub reads.
  const pretend = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-add-font",
      command: "library.add",
      args: { entry: makeFont("font-a") },
      author: AGENT,
    }),
    "studio_only",
  );
  assert.match(pretend.error, /only be run by Studio itself/);

  const added = await addFont(hub, song_id, makeFont("font-a"));
  assert.ok((await hub.openSong(song_id)).snapshot.library["font-a"]);

  // A library file is a download or an upload: its step is the operator's to
  // take back, in both directions, even while nothing plays it.
  const undone = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-font-add", entry_id: added.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(undone.error, LIBRARY_NEEDS_A_YES);
  assert.ok((await hub.openSong(song_id)).snapshot.library["font-a"], "the refused undo left the entry");

  const back = await hub.undo({
    song_id,
    cmd_id: "operator-undo-font-add",
    entry_id: added.entry.id,
    author: HUMAN,
  });
  assert.equal(back.ok, true, `the operator's undo was refused: ${back.error}`);
  assert.deepEqual((await hub.openSong(song_id)).snapshot.library, {});

  // Putting one into the song is refused the same way, and the operator does it.
  const redone = refuses(
    await hub.redo({ song_id, cmd_id: "agent-redo-font-add", entry_id: back.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(redone.error, LIBRARY_NEEDS_A_YES);
  assert.deepEqual((await hub.openSong(song_id)).snapshot.library, {});

  const again = await hub.redo({
    song_id,
    cmd_id: "operator-redo-font-add",
    entry_id: back.entry.id,
    author: HUMAN,
  });
  assert.equal(again.ok, true, `the operator's redo was refused: ${again.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.library["font-a"].sha256, FONT_HASH);

  // A font a track plays is protected twice over, and both answers are the
  // library's: the entry is the instrument, not a file nobody is using.
  await applies(hub, song_id, "seed-keys", "track.add", {
    id: "keys",
    name: "Keys",
    kind: "soundfont",
    font_id: "font-a",
  });
  const inUse = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-used-font", entry_id: again.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(inUse.error, LIBRARY_NEEDS_A_YES);
  const kept = await hub.openSong(song_id);
  assert.ok(kept.snapshot.library["font-a"], "the refused undo left the font in the library");
  assert.equal(kept.snapshot.tracks[0].device.font_id, "font-a");
});

// --- MIDI mappings ------------------------------------------------------------

/** What the agent's MIDI guard answers with, word for word. */
const MIDI_NEEDS_A_YES = "Only the operator changes an accepted MIDI mapping.";

/** @returns {{type: string, channel: number, number: number}} a MIDI message. */
function midiMessage(type, channel, number) {
  return { type, channel, number };
}

test("agent undo cannot change an accepted mapping", async (t) => {
  const { hub } = await setup(t);
  const created = await hub.createSong({ project_id: PROJECT, title: "Pedals", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const song_id = created.song_id;
  await applies(hub, song_id, "seed-verse", "scene.add", { id: "verse", name: "Verse" });
  const pedal = midiMessage("pc", 1, 0);

  // An agent's `midi.map` is a proposal, never a live mapping.
  const proposed = await applies(
    hub,
    song_id,
    "agent-map",
    "midi.map",
    { device_name: "FCB1010", message: pedal, action: { kind: "scene.launch", scene_id: "verse" } },
    AGENT,
  );
  const mappingId = proposed.entry.args.id;
  let mappings = (await hub.openSong(song_id)).snapshot.midi_maps;
  assert.equal(mappings[mappingId].proposed, true);
  assert.equal(mappings[mappingId].accepted_action, null);

  // An agent cannot accept it, and cannot edit a proposal it already made: a
  // second `midi.map` under that id is refused rather than re-purposed.
  const refuseAccept = refuses(
    await hub.runCommand({ song_id, cmd_id: "agent-accept", command: "midi.accept", args: { id: mappingId, expect: { device_name: "FCB1010", message: pedal, action: { kind: "scene.launch", scene_id: "verse" } } }, author: AGENT }),
    "human_only",
  );
  assert.match(refuseAccept.error, /midi\.accept/);
  const refuseEdit = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-remap",
      command: "midi.map",
      args: { id: mappingId, device_name: "FCB1010", message: pedal, action: { kind: "stop_all" } },
      author: AGENT,
    }),
    "human_only",
  );
  assert.match(refuseEdit.error, /An agent proposes a new mapping/);

  // The operator's yes makes it live.
  const accepted = await applies(hub, song_id, "operator-accept", "midi.accept", { id: mappingId, expect: { device_name: "FCB1010", message: pedal, action: { kind: "scene.launch", scene_id: "verse" } } }, HUMAN);
  mappings = (await hub.openSong(song_id)).snapshot.midi_maps;
  assert.equal(mappings[mappingId].proposed, false);
  assert.deepEqual(mappings[mappingId].accepted_action, { kind: "scene.launch", scene_id: "verse" });

  // The agent's undo of its own proposal now would delete a live mapping, so it
  // is refused on what it would write, not on the shape of its keys.
  const refuseProposalUndo = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-proposal", entry_id: proposed.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(refuseProposalUndo.error, MIDI_NEEDS_A_YES);

  // Taking the operator's accept back is a step of a people-only command, so an
  // agent never gets that far.
  refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-accept", entry_id: accepted.entry.id, author: AGENT }),
    "human_only",
  );

  // The operator edits the live mapping's action; the agent's undo and redo of
  // that edit are both refused, because both would change a live mapping.
  const edited = await applies(
    hub,
    song_id,
    "operator-edit",
    "midi.map",
    { id: mappingId, device_name: "FCB1010", message: pedal, action: { kind: "transport.play" } },
    HUMAN,
  );
  const refuseEditUndo = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-edit", entry_id: edited.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(refuseEditUndo.error, MIDI_NEEDS_A_YES);

  // Nothing the agent tried changed the song: the mapping is still live, and its
  // action is the operator's last word.
  mappings = (await hub.openSong(song_id)).snapshot.midi_maps;
  assert.equal(mappings[mappingId].proposed, false);
  assert.deepEqual(mappings[mappingId].action, { kind: "transport.play" });
  assert.deepEqual(mappings[mappingId].accepted_action, { kind: "transport.play" });

  // The operator takes the edit back...
  const undone = await hub.undo({ song_id, cmd_id: "operator-undo-edit", entry_id: edited.entry.id, author: HUMAN });
  assert.equal(undone.ok, true, `the operator's undo was refused: ${undone.error}`);
  mappings = (await hub.openSong(song_id)).snapshot.midi_maps;
  assert.deepEqual(mappings[mappingId].action, { kind: "scene.launch", scene_id: "verse" });

  // ...and the agent's redo of that undo would put an accepted action back, so
  // it is refused too.
  const refuseRedo = refuses(
    await hub.redo({ song_id, cmd_id: "agent-redo-edit", entry_id: undone.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(refuseRedo.error, MIDI_NEEDS_A_YES);
  assert.deepEqual(
    (await hub.openSong(song_id)).snapshot.midi_maps[mappingId].action,
    { kind: "scene.launch", scene_id: "verse" },
    "the refused redo wrote nothing",
  );

  // The operator can take the accept back again, which removes nothing the
  // agent could not have proposed itself.
  const unaccepted = await hub.undo({ song_id, cmd_id: "operator-undo-accept", entry_id: accepted.entry.id, author: HUMAN });
  assert.equal(unaccepted.ok, true, `the operator's undo was refused: ${unaccepted.error}`);
  assert.equal((await hub.openSong(song_id)).snapshot.midi_maps[mappingId].proposed, true);
});
