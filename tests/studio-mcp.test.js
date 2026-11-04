/**
 * Studio MCP tools — the agent surface.
 *
 * These tests drive the real MCP server over an in-memory transport with a fake
 * hub client, a fake renderer, a stub catalogue and the app's real actor
 * helpers. They pin the five things the plan names for this task:
 *
 *   1. the tool list is the registry's own list (no more, no less, and nothing
 *      for a people-only command);
 *   2. an agent call is never attributed to the person, even when the process
 *      env says the caller is the owner;
 *   3. a hub refusal reaches the agent as a tool error in the hub's own words,
 *      with its code;
 *   4. a render passes its arguments through and reports a limit refusal;
 *   5. the timeline's commands are tools like any other, so an agent lays a
 *      song out on the bars through the same registry commands the panel uses,
 *      and an arrangement render starts where the agent asked;
 *   6. the sampler: its commands are tools like any other, an agent writes a
 *      pattern and chains it, `studio_samples` lists the samples with their
 *      slices and their pads, and no step of the agent's can drop the sound a
 *      pad plays or bring a sample into the song.
 *
 * The timeline and sampler tests run against the REAL session hub on a scratch
 * database: a placement, a split, a marker, a section, a step and a pad only
 * mean something once a command has actually gone through the hub and into the
 * song document.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStudioServer } from "../bundles/studio/server/mcp.js";
import { listCommands } from "../bundles/studio/server/commands/registry.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { actorFromEnv, resolveCallActor } from "../servers/research/actor.js";

/** The render url the fake renderer answers with (a placeholder host). */
const RENDER_URL = "https://storage.example/studio/song-1/render.wav";

/** The one project the scratch database's ACL knows about. */
const PROJECT = 21;

/** The author the person's own edits carry, for the songs a test creates. */
const HUMAN = Object.freeze({ kind: "human", id: "local", label: "You" });

/** A stub catalogue: the real one loads the WASM engine, which is a parity test. */
const STUB_CATALOGUE = async () => ({
  modules: {
    "Analog generator": {
      kind: "generator",
      controllers: [{ name: "Volume", min: 0, max: 256, kind: "normal", default: 0 }],
    },
    Echo: { kind: "effect", controllers: [] },
  },
});

/** Two recorded takes, for the takes read and the tools around them. */
const TAKE_A = "6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70";
const TAKE_B = "0c9c3d2a-1b4e-4f6a-8d7c-5e4f3a2b1c0d";

/** Two samples, in the UUID shape the import client generates. */
const SAMPLE_A = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const SAMPLE_B = "9c8b7a6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d";

/** What the hub's sound guard answers an agent with, word for word. */
const SOUNDS_NEED_A_YES = "Changing recorded or imported sounds needs a yes from the operator. (human_only)";

/**
 * A fake hub client: the same seven methods `createHubClient` returns.
 *
 * Every method records the author it was given as well as its arguments, because
 * the real client puts that author on the wire (a read in the `x-studio-author`
 * header) and the gateway is what scopes a Crow bot with it.
 * @param {{command?: Function, songs?: object[], snapshotProject?: number}} [options]
 *   `snapshotProject` adds a project id to the snapshot answer, as the real
 *   agent snapshot route does
 */
function makeHub(options = {}) {
  const calls = {
    listSongs: [],
    createSong: [],
    snapshot: [],
    history: [],
    command: [],
    undo: [],
    redo: [],
  };
  const songs = options.songs ?? [
    { id: "song-1", project_id: 4, title: "Bass and drums", updated_at: "2026-01-01T00:00:00.000Z" },
  ];
  const hub = {
    async listSongs(filter = {}, author = null) {
      calls.listSongs.push({ ...filter, author });
      return songs;
    },
    async createSong(request = {}) {
      calls.createSong.push(request);
      return { ok: true, song_id: "song-2" };
    },
    async snapshot(songId, author = null) {
      calls.snapshot.push({ song_id: songId, author });
      return {
        song_id: songId,
        ...(options.snapshotProject == null ? {} : { project_id: options.snapshotProject }),
        ...(options.readOnly ? { read_only: true } : {}),
        snapshot: {
          meta: { title: "Bass and drums", bpm: 112, key: "A minor" },
          tracks: [],
          scenes: [],
          clips: {},
        },
        state: "",
      };
    },
    async history(songId, historyOptions = {}, author = null) {
      calls.history.push({ song_id: songId, ...historyOptions, author });
      return [{ id: "entry-0", seq: 1, command: "track.add", summary: "Added track \"Bass\"" }];
    },
    async command(songId, request = {}) {
      calls.command.push({ song_id: songId, ...request });
      if (typeof options.command === "function") return options.command(songId, request);
      return {
        ok: true,
        entry: {
          id: "entry-1",
          seq: 2,
          command: request.command,
          summary: "Wrote \"Verse bass\" (8 bars) on Bass, Verse",
          author: request.author,
        },
        snapshot_version: 2,
      };
    },
    async undo(songId, request = {}) {
      calls.undo.push({ song_id: songId, ...request });
      return { ok: true, entry: { id: "u1", command: "history.undo", summary: "Undid a step" }, conflicts: [] };
    },
    async redo(songId, request = {}) {
      calls.redo.push({ song_id: songId, ...request });
      return { ok: true, entry: { id: "r1", command: "history.redo", summary: "Redid a step" }, conflicts: [] };
    },
  };
  return { hub, calls };
}

/** A fake renderer: records the request, refuses anything over 300 s. */
function makeRenderer() {
  const calls = [];
  return {
    calls,
    renderer: {
      async render(request) {
        calls.push(request);
        if (Number(request.seconds) > 300) {
          throw new Error("A render can be at most 300 seconds long.");
        }
        return {
          storage_key: "studio/song-1/render.wav",
          url: RENDER_URL,
          seconds: request.seconds,
          lufs: -14.2,
          true_peak_db: -1.1,
        };
      },
    },
  };
}

/**
 * Build the server and a client talking to it over an in-memory transport.
 * @returns {Promise<Client>}
 */
async function connect({ hub, renderer, env = {}, actor = null }) {
  const server = createStudioServer({ hub, renderer, catalogue: STUB_CATALOGUE, env, actor });
  const client = new Client({ name: "studio-mcp-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** @returns {string} every text block of a tool result, joined. */
function textOf(result) {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * A scratch libsql client for one test, closed when the test ends.
 * @param {import("node:test").TestContext} t
 */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/**
 * A project ACL that knows one project and grants every capability in it.
 * The hub only needs these three calls; the renderer is a stub here, so the
 * capability question is never asked of it.
 */
function fakeAcl() {
  return {
    async assertProjectExists(db, projectId) {
      const id = Number(projectId);
      if (id !== PROJECT) throw new Error(`Project #${projectId} not found`);
      return { id };
    },
    async assertCapability(db, projectId, contactId, capability) {
      await this.assertProjectExists(db, projectId);
      return { role: "owner", capabilities: { [capability]: true } };
    },
    async appendAudit() {},
  };
}

/**
 * The real session hub, behind the client shape the MCP server takes.
 *
 * The gateway's agent client answers the same seven calls over HTTP, scoping
 * each one by the caller's author; here the author is passed straight to
 * `hub.runCommand()`, so a test can see what the agent's step really wrote.
 *
 * @param {object} hub - the hub `createHub()` returned
 * @param {object} db - the scratch database, for the song's project
 * @returns {object} the hub client `createStudioServer()` wants
 */
function hubClientOf(hub, db) {
  return {
    async listSongs(filter = {}, author = null) {
      const projectId = Number(filter.project_id);
      return hub.listSongs(Number.isInteger(projectId) ? { project_ids: [projectId] } : {});
    },
    async createSong(request = {}) {
      return hub.createSong(request);
    },
    async snapshot(songId, author = null) {
      const opened = await hub.openSong(songId);
      const { rows } = await db.execute({
        sql: "SELECT project_id FROM studio_songs WHERE id = ?",
        args: [songId],
      });
      return {
        song_id: songId,
        project_id: rows[0] ? Number(rows[0].project_id) : null,
        snapshot: opened.snapshot,
        snapshot_version: opened.snapshot_version,
        state: "",
      };
    },
    async history(songId, options = {}, author = null) {
      return hub.history(songId, options);
    },
    async command(songId, request = {}) {
      return hub.runCommand({ song_id: songId, ...request });
    },
    async undo(songId, request = {}) {
      return hub.undo({ song_id: songId, ...request });
    },
    async redo(songId, request = {}) {
      return hub.redo({ song_id: songId, ...request });
    },
  };
}

/**
 * A real hub on a scratch database, with one empty song created in it.
 * @param {import("node:test").TestContext} t
 * @returns {Promise<{db: object, hub: object, songId: string}>}
 */
async function realSong(t) {
  const db = scratchDb(t);
  await initStudioTables(db);
  const hub = createHub({ db, acl: fakeAcl() });
  const created = await hub.createSong({ project_id: PROJECT, title: "Timeline song", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  return { db, hub, songId: created.song_id };
}

test("every public non-humanOnly command has exactly one tool and the rest have none", async () => {
  const { hub } = makeHub();
  const client = await connect({ hub, renderer: makeRenderer().renderer });
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const command of listCommands()) {
      const expected = `studio_${command.id.replace(/\./g, "_")}`;
      const count = names.filter((name) => name === expected).length;
      if (command.humanOnly || command.internal) {
        assert.equal(count, 0, `${expected} should not exist: ${command.id} is people-only or Studio's own`);
      } else {
        assert.equal(count, 1, `${expected} should be exposed exactly once for ${command.id}`);
      }
    }
    assert.ok(names.includes("studio_clip_write"), "the clip writer should be a tool");
    assert.ok(!names.includes("studio_track_lock"), "a people-only command must not be a tool");
    assert.ok(!names.includes("studio_take_add"), "a take is Studio's own step, so it must not be a tool");
  } finally {
    await client.close();
  }
});

test("an agent has no pad.clear", async () => {
  const { hub } = makeHub();
  const client = await connect({ hub, renderer: makeRenderer().renderer });
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    // Clearing a pad is the operator's own act (the panel's Clear pad), so the
    // agent's surface has no tool for it — while the command itself is there.
    assert.ok(!names.includes("studio_pad_clear"), "a people-only command must not be a tool");
    const clear = listCommands().find((command) => command.id === "pad.clear");
    assert.ok(clear, "the registry holds pad.clear");
    assert.equal(clear.humanOnly, true, "and it is people-only");
  } finally {
    await client.close();
  }
});

test("tool call forwards author kind agent even when env says owner", async () => {
  const { hub, calls } = makeHub();
  const client = await connect({
    hub,
    renderer: makeRenderer().renderer,
    env: { CROW_ACTOR_KIND: "owner" },
    actor: { actorFromEnv, resolveCallActor },
  });
  try {
    const result = await client.callTool({
      name: "studio_song_set_meta",
      arguments: { song_id: "song-1", bpm: 100 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(calls.command.length, 1);
    assert.equal(calls.command[0].command, "song.set_meta");
    assert.equal(calls.command[0].song_id, "song-1");
    assert.deepEqual(calls.command[0].args, { bpm: 100 });
    assert.deepEqual(calls.command[0].author, { kind: "agent", id: "mcp", label: "Agent (MCP)" });
    assert.match(textOf(result), /Wrote "Verse bass"/);
    assert.match(calls.command[0].cmd_id, /^[0-9a-f-]{36}$/, "every call carries a fresh cmd_id");
  } finally {
    await client.close();
  }

  // A bot keeps its own identity, still as an agent.
  const botCall = makeHub();
  const botClient = await connect({
    hub: botCall.hub,
    renderer: makeRenderer().renderer,
    env: { CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "bassbot" },
    actor: { actorFromEnv, resolveCallActor },
  });
  try {
    await botClient.callTool({ name: "studio_song_set_meta", arguments: { song_id: "song-1", bpm: 100 } });
    assert.deepEqual(botCall.calls.command[0].author, {
      kind: "agent",
      id: "bot:bassbot",
      label: "Bot bassbot",
    });
  } finally {
    await botClient.close();
  }
});

test("refusal code locked is returned as tool error text naming the track", async () => {
  const { hub } = makeHub({
    command: async () => ({
      ok: false,
      code: "locked",
      error: 'Track "Bass" is locked by the operator.',
    }),
  });
  const client = await connect({ hub, renderer: makeRenderer().renderer });
  try {
    const result = await client.callTool({
      name: "studio_clip_write",
      arguments: {
        song_id: "song-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "Verse bass",
        notes: [{ t: 0, d: 1, p: 40, v: 100 }],
      },
    });
    assert.equal(result.isError, true, "a refusal must be a tool error");
    const text = textOf(result);
    assert.match(text, /Track "Bass" is locked/);
    assert.match(text, /\(locked\)$/);
  } finally {
    await client.close();
  }
});

test("studio_render passes seconds through and surfaces limit errors", async () => {
  const { hub } = makeHub();
  const { renderer, calls } = makeRenderer();
  const client = await connect({ hub, renderer });
  try {
    const result = await client.callTool({
      name: "studio_render",
      arguments: { song_id: "song-1", seconds: 4 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const body = JSON.parse(textOf(result));
    assert.equal(body.url, RENDER_URL);
    assert.equal(body.seconds, 4);
    assert.equal(body.lufs, -14.2);
    assert.equal(body.true_peak_db, -1.1);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].song_id, "song-1");
    assert.equal(calls[0].project_id, 4, "the render is filed under the song's project");
    assert.equal(calls[0].seconds, 4);
    assert.equal(calls[0].scene_id, null);
    assert.equal(calls[0].clip_id, null);
    assert.deepEqual(calls[0].author, { kind: "agent", id: "mcp", label: "Agent (MCP)" });

    const tooLong = await client.callTool({
      name: "studio_render",
      arguments: { song_id: "song-1", seconds: 400 },
    });
    assert.equal(tooLong.isError, true);
    assert.match(textOf(tooLong), /300 seconds/);
  } finally {
    await client.close();
  }
});

test("render uses the project from the hub, not from the arguments", async () => {
  // The snapshot route names the song's project, so that is what the render is
  // filed under — a project id in the arguments is ignored.
  const direct = makeHub({
    snapshotProject: 4,
    songs: [{ id: "song-1", project_id: 7, title: "Bass and drums", updated_at: "2026-01-01T00:00:00.000Z" }],
  });
  const first = makeRenderer();
  const directClient = await connect({ hub: direct.hub, renderer: first.renderer });
  try {
    const result = await directClient.callTool({
      name: "studio_render",
      arguments: { song_id: "song-1", seconds: 2, project_id: 999 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].project_id, 4, "the project comes from the hub's snapshot answer");
    assert.equal(direct.calls.listSongs.length, 0, "the snapshot was enough");
  } finally {
    await directClient.close();
  }

  // Without a project on the snapshot the listing decides — still the hub's
  // answer, and still not the arguments.
  const fallback = makeHub({
    songs: [{ id: "song-1", project_id: 7, title: "Bass and drums", updated_at: "2026-01-01T00:00:00.000Z" }],
  });
  const second = makeRenderer();
  const fallbackClient = await connect({ hub: fallback.hub, renderer: second.renderer });
  try {
    const result = await fallbackClient.callTool({
      name: "studio_render",
      arguments: { song_id: "song-1", seconds: 2, project_id: 999 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].project_id, 7, "the project comes from the hub's song listing");
  } finally {
    await fallbackClient.close();
  }
});

test("reads carry the caller's author so the gateway can scope them", async () => {
  const { hub, calls } = makeHub();
  const client = await connect({
    hub,
    renderer: makeRenderer().renderer,
    env: { CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "bassbot" },
    actor: { actorFromEnv, resolveCallActor },
  });
  try {
    const expected = { kind: "agent", id: "bot:bassbot", label: "Bot bassbot" };
    await client.callTool({ name: "studio_list_songs", arguments: {} });
    await client.callTool({ name: "studio_session_summary", arguments: { song_id: "song-1" } });
    await client.callTool({ name: "studio_history", arguments: { song_id: "song-1" } });
    assert.deepEqual(calls.listSongs[0].author, expected, "the listing names the bot");
    assert.deepEqual(calls.snapshot[0].author, expected, "the snapshot names the bot");
    assert.deepEqual(calls.history[0].author, expected, "the history names the bot");
  } finally {
    await client.close();
  }
});

test("an internal refusal reaches the agent as one fixed sentence, logged in full", async () => {
  const { hub } = makeHub();
  hub.listSongs = async () => ({ ok: false, code: "internal", error: "SQLITE secret path" });
  const client = await connect({ hub, renderer: makeRenderer().renderer });

  const logged = [];
  const realWarn = console.warn;
  console.warn = (...args) => {
    logged.push(args);
  };
  try {
    const result = await client.callTool({ name: "studio_list_songs", arguments: {} });
    assert.equal(result.isError, true, "an internal failure is a tool error");
    assert.equal(textOf(result), "Studio hit an internal error.");
    assert.equal(textOf(result).includes("SQLITE"), false, "the detail never reaches the agent");
    assert.ok(logged.some((args) => args[0] === "[studio]"), "the detail is logged instead");
  } finally {
    console.warn = realWarn;
    await client.close();
  }
});
test("MCP client sees the studio-only message, not \"internal error\"", async () => {
  const refusal = { ok: false, code: "studio_only", error: "This command can only be run by Studio itself." };
  const { hub } = makeHub({ command: async () => refusal });
  const client = await connect({ hub, renderer: makeRenderer().renderer });
  try {
    const result = await client.callTool({
      name: "studio_clip_write",
      arguments: {
        song_id: "song-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "Verse bass",
        notes: [{ t: 0, d: 1, p: 40, v: 100 }],
      },
    });
    assert.equal(result.isError, true, "a refusal must be a tool error");
    const text = textOf(result);
    // The sentence is the agent's own answer: it says what the command is for,
    // so it reaches the caller unchanged with only its code after it.
    assert.equal(text, "This command can only be run by Studio itself. (studio_only)");
    assert.equal(text.includes("internal error"), false, "a studio-only refusal is not a server bug");
  } finally {
    await client.close();
  }
});

test("a read-only caller (Crow's voice) cannot file a render", async () => {
  const voice = makeHub({ snapshotProject: 4, readOnly: true });
  const rendered = makeRenderer();
  const client = await connect({ hub: voice.hub, renderer: rendered.renderer });
  try {
    const result = await client.callTool({ name: "studio_render", arguments: { song_id: "song-1", seconds: 2 } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /read_only/);
    assert.equal(rendered.calls.length, 0, "nothing was rendered or stored");
  } finally {
    await client.close();
  }
});

test("a call carrying a forwarded non-bot actor (a peer) is not the operator", async () => {
  const seen = makeHub({ snapshotProject: 4 });
  const actor = {
    actorFromEnv: () => ({ kind: "unknown" }),
    resolveCallActor: () => ({ kind: "unknown" }),
  };
  const client = await connect({ hub: seen.hub, renderer: makeRenderer().renderer, actor });
  try {
    await client.callTool({ name: "studio_list_songs", arguments: {}, _meta: { "crow/actor": { kind: "peer", instance: "x" } } });
    assert.equal(seen.calls.listSongs.at(-1).author.id, "other", "a peer gets the fail-closed author");
    await client.callTool({ name: "studio_list_songs", arguments: {} });
    assert.equal(seen.calls.listSongs.at(-1).author.id, "mcp", "no forwarded actor is the operator's session");
  } finally {
    await client.close();
  }
});

test("agent can keep and comp but not add or discard takes", async () => {
  const { hub, calls } = makeHub();
  // A song with two recorded takes, one on each of two clips, the newer one
  // discarded. Both clips' comps are read for `in_comp`.
  hub.snapshot = async (songId, author = null) => {
    calls.snapshot.push({ song_id: songId, author });
    return {
      song_id: songId,
      project_id: 4,
      snapshot: {
        meta: { title: "Takes", bpm: 112, key: "A minor" },
        tracks: [{ id: "audio-1", name: "Guitar", device: { engine: "audio" }, mute: false, solo: false, locked: false }],
        scenes: [{ id: "scene-1", name: "A" }],
        clips: {
          "clip-1": {
            id: "clip-1",
            track_id: "audio-1",
            scene_id: "scene-1",
            name: "Guitar",
            length_bars: 1,
            kind: "audio",
            notes: [],
            comp: [{ take_id: TAKE_A, from_beat: 0, to_beat: 4 }],
          },
          "clip-2": {
            id: "clip-2",
            track_id: "audio-1",
            scene_id: "scene-1",
            name: "Voice",
            length_bars: 1,
            kind: "audio",
            notes: [],
            comp: [],
          },
        },
        takes: {
          [TAKE_A]: {
            id: TAKE_A,
            clip_id: "clip-1",
            storage_key: `projects/4/studio/song-1/takes/${TAKE_A}.wav`,
            rate: 48000,
            channels: 2,
            frames: 96000,
            offset_frames: 1200,
            compensated: true,
            bpm: 112,
            recorded_at: "2026-11-02T10:00:00.000Z",
            author_label: "the operator",
            discarded: false,
          },
          [TAKE_B]: {
            id: TAKE_B,
            clip_id: "clip-2",
            storage_key: `projects/4/studio/song-1/takes/${TAKE_B}.wav`,
            rate: 48000,
            channels: 1,
            frames: 48000,
            offset_frames: 0,
            compensated: false,
            bpm: 112,
            recorded_at: "2026-11-03T10:00:00.000Z",
            author_label: "the operator",
            discarded: true,
          },
        },
      },
      state: "",
    };
  };

  const client = await connect({ hub, renderer: makeRenderer().renderer });
  const expectedAuthor = { kind: "agent", id: "mcp", label: "Agent (MCP)" };
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("studio_take_keep"), "an agent may keep a take");
    assert.ok(names.includes("studio_clip_set_comp"), "an agent may comp takes");
    assert.ok(names.includes("studio_takes"), "an agent may list takes");
    assert.equal(names.includes("studio_take_add"), false, "adding a take is Studio's own step");
    assert.equal(names.includes("studio_take_discard"), false, "discarding a take needs the operator");

    const listed = await client.callTool({ name: "studio_takes", arguments: { song_id: "song-1" } });
    assert.notEqual(listed.isError, true, textOf(listed));
    assert.deepEqual(calls.snapshot.at(-1).author, expectedAuthor, "the read is scoped by the caller's author");

    const rows = JSON.parse(textOf(listed));
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.id),
      [TAKE_B, TAKE_A],
      "the newest recording comes first",
    );

    const kept = rows.find((row) => row.id === TAKE_A);
    assert.deepEqual(Object.keys(kept).sort(), [
      "author_label",
      "bpm",
      "channels",
      "clip_id",
      "compensated",
      "discarded",
      "id",
      "in_comp",
      "offset_ms",
      "rate",
      "recorded_at",
      "seconds",
    ]);
    assert.equal(kept.clip_id, "clip-1");
    assert.equal(kept.seconds, 2, "96000 frames at 48 kHz is 2 s");
    assert.equal(kept.channels, 2);
    assert.equal(kept.rate, 48000);
    assert.equal(kept.bpm, 112);
    assert.equal(kept.compensated, true);
    assert.equal(kept.offset_ms, 25, "1200 frames at 48 kHz is 25 ms");
    assert.equal(kept.author_label, "the operator");
    assert.equal(kept.recorded_at, "2026-11-02T10:00:00.000Z");
    assert.equal(kept.discarded, false);
    assert.equal(kept.in_comp, true, "clip-1's comp plays it");

    const discarded = rows.find((row) => row.id === TAKE_B);
    assert.equal(discarded.discarded, true);
    assert.equal(discarded.compensated, false);
    assert.equal(discarded.offset_ms, 0);
    assert.equal(discarded.in_comp, false, "nothing plays it");

    const oneClip = await client.callTool({ name: "studio_takes", arguments: { song_id: "song-1", clip_id: "clip-2" } });
    assert.notEqual(oneClip.isError, true, textOf(oneClip));
    assert.deepEqual(
      JSON.parse(textOf(oneClip)).map((row) => row.id),
      [TAKE_B],
      "clip_id narrows the listing",
    );
  } finally {
    await client.close();
  }
});

// ---- the timeline over MCP -------------------------------------------------

test("agent places clips, splits one and adds sections", async (t) => {
  const { db, hub, songId } = await realSong(t);
  const client = await connect({ hub: hubClientOf(hub, db), renderer: makeRenderer().renderer });
  try {
    /** Run one tool that must succeed, and hand back the sentence it answered with. */
    const run = async (name, args) => {
      const result = await client.callTool({ name, arguments: { song_id: songId, ...args } });
      assert.notEqual(result.isError, true, `${name} was refused: ${textOf(result)}`);
      return textOf(result);
    };

    // A song with two clips in one scene, built through the same tools.
    await run("studio_track_add", { id: "guitar", name: "Guitar" });
    await run("studio_scene_add", { id: "verse", name: "Verse" });
    for (const [clipId, name] of [["riff-a", "Riff A"], ["riff-b", "Riff B"]]) {
      const summary = await run("studio_clip_write", {
        clip_id: clipId,
        track_id: "guitar",
        scene_id: "verse",
        name,
        length_bars: 2,
        notes: [{ t: 0, d: 1, p: 40, v: 100 }],
      });
      assert.match(summary, new RegExp(`Wrote "${name}"`), "the tool answers with the step's own summary");
    }

    // Two clips on the timeline, the first of them split in half, then the map
    // of the song: a section over bars 0-4 and a marker where the second clip
    // starts.
    assert.match(
      await run("studio_arrangement_place", { id: "p-a", track_id: "guitar", clip_id: "riff-a", start_bar: 0 }),
      /Placed clip "Riff A" at bar 0/,
    );
    assert.match(
      await run("studio_arrangement_place", { id: "p-b", track_id: "guitar", clip_id: "riff-b", start_bar: 4 }),
      /Placed clip "Riff B" at bar 4/,
    );
    assert.match(
      await run("studio_arrangement_split", { id: "p-a", at_bar: 1, new_id: "p-a2" }),
      /Split the placement/,
    );
    assert.match(
      await run("studio_section_add", { id: "s-verse", start_bar: 0, end_bar: 4, name: "Verse" }),
      /Added section "Verse"/,
    );
    assert.match(
      await run("studio_marker_add", { id: "m-chorus", bar: 4, name: "Chorus" }),
      /Added marker "Chorus" at bar 4/,
    );

    const opened = await hub.openSong(songId);
    const arrangement = opened.snapshot.arrangement;
    assert.deepEqual(
      Object.keys(arrangement.placements).sort(),
      ["p-a", "p-a2", "p-b"],
      "the split left two halves of the first clip beside the second one",
    );
    assert.equal(arrangement.placements["p-a"].clip_id, "riff-a");
    assert.equal(arrangement.placements["p-a"].start_bar, 0);
    assert.equal(arrangement.placements["p-a"].bars, 1, "the first half stops at the split");
    assert.equal(arrangement.placements["p-a"].offset_beats, 0);
    assert.equal(arrangement.placements["p-a2"].clip_id, "riff-a");
    assert.equal(arrangement.placements["p-a2"].start_bar, 1, "the second half starts at the split");
    assert.equal(arrangement.placements["p-a2"].bars, 1);
    assert.equal(arrangement.placements["p-a2"].offset_beats, 4, "it continues where the first half stopped");
    assert.equal(arrangement.placements["p-b"].clip_id, "riff-b");
    assert.equal(arrangement.placements["p-b"].start_bar, 4);
    assert.equal(arrangement.placements["p-b"].bars, 2, "a placement is as long as its clip by default");

    assert.deepEqual(Object.keys(arrangement.markers), ["m-chorus"]);
    assert.equal(arrangement.markers["m-chorus"].bar, 4);
    assert.equal(arrangement.markers["m-chorus"].name, "Chorus");
    assert.deepEqual(Object.keys(arrangement.sections), ["s-verse"]);
    assert.equal(arrangement.sections["s-verse"].start_bar, 0);
    assert.equal(arrangement.sections["s-verse"].end_bar, 4);
    assert.equal(arrangement.sections["s-verse"].name, "Verse");

    // Every one of those is a history step of its own, filed under the agent.
    const entries = await hub.history(songId, { limit: 50 });
    for (const command of ["arrangement.place", "arrangement.split", "section.add", "marker.add"]) {
      const entry = entries.find((row) => row.command === command);
      assert.ok(entry, `${command} should be in the shared history`);
      assert.equal(entry.author.kind, "agent", `${command} is the agent's step, never the person's`);
      assert.equal(entry.author.id, "mcp");
    }
  } finally {
    await client.close();
  }
});

test("agent renders the arrangement from bar 9", async (t) => {
  const { db, hub, songId } = await realSong(t);
  const { renderer, calls } = makeRenderer();
  const client = await connect({ hub: hubClientOf(hub, db), renderer });
  try {
    // from_bar is 0-based, so bar 9 is 8.
    const result = await client.callTool({
      name: "studio_render",
      arguments: { song_id: songId, seconds: 8, mode: "arrangement", from_bar: 8 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(JSON.parse(textOf(result)).url, RENDER_URL);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, "arrangement", "the renderer is asked for the timeline, not a scene");
    assert.equal(calls[0].from_bar, 8, "the render starts on the ninth bar");
    assert.equal(calls[0].scene_id, null, "an arrangement render launches no scene");
    assert.equal(calls[0].clip_id, null);
    assert.equal(calls[0].seconds, 8);
    assert.equal(calls[0].project_id, PROJECT, "the render is filed under the song's project");

    // The schema is the tool's own gate: a view the engine does not have is
    // refused before any renderer, hub or storage is touched.
    const badMode = await client.callTool({
      name: "studio_render",
      arguments: { song_id: songId, seconds: 2, mode: "timeline" },
    });
    assert.equal(badMode.isError, true, "an unknown mode is not a render");
    assert.match(textOf(badMode), /Invalid arguments/i);
    assert.match(textOf(badMode), /mode/);

    // Bar 999 is past the last bar an arrangement can have, so it too is
    // refused by the schema rather than rendered as some other bar.
    const badBar = await client.callTool({
      name: "studio_render",
      arguments: { song_id: songId, seconds: 2, mode: "arrangement", from_bar: 999 },
    });
    assert.equal(badBar.isError, true, "a bar the arrangement cannot have is refused");
    assert.match(textOf(badBar), /from_bar/);

    assert.equal(calls.length, 1, "neither refused call reached the renderer");
  } finally {
    await client.close();
  }
});

// ---- the sampler over MCP --------------------------------------------------

/**
 * A sampler track and a scene in a real song, and the id of the kit's bank.
 *
 * The kit arrives with the track (one bank, "A", of sixteen empty pads), so a
 * test that needs a bank id reads it out of the song the same way the panel
 * does — from the snapshot — rather than inventing one.
 *
 * @param {object} hub
 * @param {string} songId
 * @returns {Promise<string>} the bank id
 */
async function seedKit(hub, songId) {
  const track = await hub.runCommand({
    song_id: songId,
    cmd_id: "seed-sampler-track",
    command: "track.add",
    args: { id: "drums", name: "Drums", kind: "sampler" },
    author: HUMAN,
  });
  assert.equal(track.ok, true, `track.add was refused: ${track.error}`);
  const scene = await hub.runCommand({
    song_id: songId,
    cmd_id: "seed-sampler-scene",
    command: "scene.add",
    args: { id: "verse", name: "Verse" },
    author: HUMAN,
  });
  assert.equal(scene.ok, true, `scene.add was refused: ${scene.error}`);
  const opened = await hub.openSong(songId);
  const bank = Object.values(opened.snapshot.banks).find((item) => item.track_id === "drums");
  assert.ok(bank, "a sampler track arrives with its bank");
  return bank.id;
}

/**
 * Add one sample the way Studio itself does: `internal: true`, as the gateway's
 * upload finish route issues it.
 * @param {object} hub
 * @param {string} songId
 * @param {object} sample
 * @returns {Promise<object>} the applied step's result
 */
async function addSample(hub, songId, sample) {
  const added = await hub.runCommand({
    song_id: songId,
    cmd_id: `add-sample-${sample.id}`,
    command: "sample.add",
    args: { sample },
    author: HUMAN,
    internal: true,
  });
  assert.equal(added.ok, true, `sample.add was refused: ${added.error}`);
  return added;
}

/** The sample object `sample.add` accepts, as the upload finish route builds it. */
function makeSample(overrides = {}) {
  const id = overrides.id ?? SAMPLE_A;
  return {
    id,
    storage_key: `studio/song-1/samples/${id}.wav`,
    rate: 48000,
    channels: 2,
    frames: 96000,
    name: "Drum loop",
    origin: "import",
    author_label: "the operator",
    ...overrides,
  };
}

test("agent writes a pattern and chains it", async (t) => {
  const { db, hub, songId } = await realSong(t);
  const client = await connect({ hub: hubClientOf(hub, db), renderer: makeRenderer().renderer });
  try {
    /** Run one tool that must succeed, and hand back the sentence it answered with. */
    const run = async (name, args) => {
      const result = await client.callTool({ name, arguments: { song_id: songId, ...args } });
      assert.notEqual(result.isError, true, `${name} was refused: ${textOf(result)}`);
      return textOf(result);
    };

    const bankId = await seedKit(hub, songId);
    assert.match(
      await run("studio_clip_add_pattern", {
        clip_id: "beat",
        track_id: "drums",
        scene_id: "verse",
        name: "Drums A",
        length_steps: 16,
      }),
      /Added pattern clip "Drums A" \(16 steps\)/,
      "a pattern clip arrives with its first pattern, A",
    );
    assert.match(
      await run("studio_pattern_add", { clip_id: "beat", id: "b", name: "Fill" }),
      /Added pattern "Fill" to clip "Drums A"/,
    );

    // Four hits of the kick lane in pattern A, the fourth of them snapped with a
    // filter lock, and a chain that plays A, B, A and loops.
    for (const at of [0, 4, 8, 12]) {
      assert.match(
        await run("studio_step_toggle", {
          clip_id: "beat",
          pattern_id: "a",
          at,
          bank_id: bankId,
          index: 0,
          v: at === 0 ? 120 : 100,
        }),
        /Put a step on pattern "A" at step/,
      );
    }
    assert.match(
      await run("studio_step_set", {
        clip_id: "beat",
        pattern_id: "a",
        at: 12,
        bank_id: bankId,
        index: 0,
        locks: { cutoff_hz: 900 },
      }),
      /Set a cutoff_hz lock on step 13 of pattern "A"/,
    );
    assert.match(
      await run("studio_chain_set", { clip_id: "beat", chain: ["a", "b", "a"] }),
      /Set the chain of clip "Drums A" to A → Fill → A/,
    );

    // The snapshot — the document the operator and the engine both see — holds
    // all of it, and every one of those steps is filed under the agent.
    const opened = await hub.openSong(songId);
    const snap = opened.snapshot;
    const steps = Object.values(snap.steps).filter((step) => step.pattern_id === "a");
    assert.deepEqual(
      steps.map((step) => step.at).sort((a, b) => a - b),
      [0, 4, 8, 12],
      "the four steps are on the 16ths the agent put them on",
    );
    assert.equal(steps.find((step) => step.at === 0).v, 120, "the first hit keeps its accent");
    assert.deepEqual(
      snap.steps[`beat/a/12/${bankId}.0`].locks,
      { cutoff_hz: 900 },
      "the lock belongs to that one step",
    );
    assert.deepEqual(snap.clips.beat.chain, ["a", "b", "a"]);
    assert.equal(snap.clips.beat.kind, "pattern");
    assert.deepEqual(
      Object.values(snap.patterns).map((pattern) => pattern.name).sort(),
      ["A", "Fill"],
      "the clip holds the pattern it was born with and the one the agent added",
    );

    const entries = await hub.history(songId, { limit: 50 });
    for (const command of ["clip.add_pattern", "pattern.add", "step.toggle", "step.set", "chain.set"]) {
      const entry = entries.find((row) => row.command === command);
      assert.ok(entry, `${command} should be in the shared history`);
      assert.equal(entry.author.kind, "agent", `${command} is the agent's step, never the person's`);
      assert.equal(entry.author.id, "mcp");
    }
  } finally {
    await client.close();
  }
});

test("agent cannot drop a pad's sample or add a sample", async (t) => {
  const { db, hub, songId } = await realSong(t);
  const bankId = await seedKit(hub, songId);

  // The operator's own work: two sounds in the song, one on pad 1.
  await addSample(hub, songId, makeSample({ id: SAMPLE_A, name: "Drum loop" }));
  await addSample(hub, songId, makeSample({ id: SAMPLE_B, name: "Kick", rate: 44100, channels: 1, frames: 44100 }));
  const assigned = await hub.runCommand({
    song_id: songId,
    cmd_id: "operator-pad-assign",
    command: "pad.assign",
    args: { track_id: "drums", bank_id: bankId, index: 0, sample_id: SAMPLE_A },
    author: HUMAN,
  });
  assert.equal(assigned.ok, true, `pad.assign was refused: ${assigned.error}`);

  const client = await connect({ hub: hubClientOf(hub, db), renderer: makeRenderer().renderer });
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("studio_pad_assign"), "an agent may put a sample on an empty pad");
    assert.ok(names.includes("studio_slice_set"), "an agent may chop a sample");
    assert.equal(
      names.includes("studio_sample_add"),
      false,
      "a sample comes in through the gateway's upload route, so there is no tool that adds one",
    );
    assert.equal(
      names.includes("studio_pad_assign_if_empty"),
      false,
      "the empty-only twin is Studio's own, so it is no tool either",
    );

    // Repointing the pad at another sound is the sound the operator put there
    // going away: refused, in the hub's own sentence.
    const repointed = await client.callTool({
      name: "studio_pad_assign",
      arguments: { song_id: songId, track_id: "drums", bank_id: bankId, index: 0, sample_id: SAMPLE_B },
    });
    assert.equal(repointed.isError, true, "replacing a pad's sound must be a tool error");
    assert.equal(textOf(repointed), SOUNDS_NEED_A_YES);

    // Neither may it take the operator's assignment back: clearing the pad is
    // the same sound going away.
    const cleared = await client.callTool({
      name: "studio_undo",
      arguments: { song_id: songId, entry_id: assigned.entry.id },
    });
    assert.equal(cleared.isError, true, "undoing the operator's assignment must be a tool error");
    assert.equal(textOf(cleared), SOUNDS_NEED_A_YES);

    // An empty pad may be filled — and that fill may not be taken back either,
    // because taking it back drops the sound it put there.
    const filled = await client.callTool({
      name: "studio_pad_assign",
      arguments: { song_id: songId, track_id: "drums", bank_id: bankId, index: 1, sample_id: SAMPLE_B },
    });
    assert.notEqual(filled.isError, true, textOf(filled));
    const entries = await hub.history(songId, { limit: 5 });
    const fill = entries.find((row) => row.command === "pad.assign" && row.author.kind === "agent");
    assert.ok(fill, "the agent's fill is a step of its own in the history");
    const dropped = await client.callTool({
      name: "studio_undo",
      arguments: { song_id: songId, entry_id: fill.id },
    });
    assert.equal(dropped.isError, true, "undoing its own fill must be a tool error");
    assert.equal(textOf(dropped), SOUNDS_NEED_A_YES);

    // All three refusals wrote nothing: both pads still play what they played.
    const opened = await hub.openSong(songId);
    assert.equal(opened.snapshot.pads[`drums/${bankId}/0`].sample_id, SAMPLE_A);
    assert.equal(opened.snapshot.pads[`drums/${bankId}/1`].sample_id, SAMPLE_B);
    assert.deepEqual(Object.keys(opened.snapshot.samples).sort(), [SAMPLE_A, SAMPLE_B]);
  } finally {
    await client.close();
  }
});

test("studio_samples lists samples with their slices and pads", async (t) => {
  const { db, hub, songId } = await realSong(t);
  const bankId = await seedKit(hub, songId);
  const client = await connect({ hub: hubClientOf(hub, db), renderer: makeRenderer().renderer });
  try {
    await addSample(hub, songId, makeSample({ id: SAMPLE_A, name: "Drum loop" }));
    await addSample(
      hub,
      songId,
      makeSample({ id: SAMPLE_B, name: "Kick", rate: 44100, channels: 1, frames: 48000, origin: "record" }),
    );

    /** Run one operator step the way the panel or the upload route would. */
    const asOperator = async (command, args) => {
      const result = await hub.runCommand({
        song_id: songId,
        cmd_id: `seed-${command}-${JSON.stringify(args).length}`,
        command,
        args,
        author: HUMAN,
      });
      assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
      return result;
    };

    // Two slices of the loop, one of them on pad 4; the whole loop on pad 1.
    await asOperator("slice.set", {
      sample_id: SAMPLE_A,
      slices: [
        { id: "fill", start_frame: 24000, end_frame: 48000 },
        { id: "verse", start_frame: 0, end_frame: 24000 },
      ],
    });
    await asOperator("pad.assign", { track_id: "drums", bank_id: bankId, index: 0, sample_id: SAMPLE_A });
    await asOperator("pad.assign", {
      track_id: "drums",
      bank_id: bankId,
      index: 3,
      sample_id: SAMPLE_A,
      slice_id: "fill",
    });

    const listed = await client.callTool({ name: "studio_samples", arguments: { song_id: songId } });
    assert.notEqual(listed.isError, true, textOf(listed));
    const rows = JSON.parse(textOf(listed));
    assert.deepEqual(rows.map((row) => row.id), [SAMPLE_A, SAMPLE_B], "one row per sample, in the song's order");

    const loop = rows[0];
    assert.deepEqual(Object.keys(loop).sort(), [
      "author_label",
      "channels",
      "id",
      "name",
      "origin",
      "pads",
      "rate",
      "seconds",
      "slices",
    ]);
    assert.equal(loop.name, "Drum loop");
    assert.equal(loop.seconds, 2, "96000 frames at 48 kHz is 2 s");
    assert.equal(loop.channels, 2);
    assert.equal(loop.rate, 48000);
    assert.equal(loop.origin, "import");
    assert.equal(loop.author_label, "the operator");

    // The slices in order, each with frames and seconds.
    assert.deepEqual(
      loop.slices.map((slice) => slice.id),
      ["verse", "fill"],
      "slices are listed in the order they play",
    );
    assert.deepEqual(loop.slices[0], {
      id: "verse",
      start_frame: 0,
      end_frame: 24000,
      start_seconds: 0,
      end_seconds: 0.5,
    });
    assert.deepEqual(loop.slices[1], {
      id: "fill",
      start_frame: 24000,
      end_frame: 48000,
      start_seconds: 0.5,
      end_seconds: 1,
    });

    // Which pads play it: the one with the whole sample and the one with a slice.
    assert.equal(loop.pads.length, 2);
    const [whole, sliced] = loop.pads;
    assert.deepEqual(Object.keys(whole).sort(), ["bank", "bank_id", "index", "pad", "slice_id", "track", "track_id"]);
    assert.equal(whole.track_id, "drums");
    assert.equal(whole.track, "Drums");
    assert.equal(whole.bank_id, bankId);
    assert.equal(whole.bank, "A");
    assert.equal(whole.index, 0);
    assert.equal(whole.pad, 1, "pads are numbered the way the operator counts them");
    assert.equal(whole.slice_id, null, "the whole sample, not a slice of it");
    assert.equal(sliced.pad, 4);
    assert.equal(sliced.slice_id, "fill");

    // The second sample was recorded, plays nothing, and has no slices.
    const kick = rows[1];
    assert.equal(kick.name, "Kick");
    assert.equal(kick.origin, "record");
    assert.equal(kick.rate, 44100);
    assert.equal(kick.channels, 1);
    assert.equal(kick.seconds, 1.09, "48000 frames at 44.1 kHz is 1.09 s");
    assert.deepEqual(kick.slices, []);
    assert.deepEqual(kick.pads, []);

    // sample_id narrows the answer to one sound.
    const one = await client.callTool({
      name: "studio_samples",
      arguments: { song_id: songId, sample_id: SAMPLE_B },
    });
    assert.notEqual(one.isError, true, textOf(one));
    assert.deepEqual(JSON.parse(textOf(one)).map((row) => row.id), [SAMPLE_B]);
  } finally {
    await client.close();
  }
});
