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
import { createStudioServer, patternClipRead } from "../bundles/studio/server/mcp.js";
import { createRenderer } from "../bundles/studio/server/render.js";
import { decodeWav } from "../bundles/studio/server/wav.js";
import { listCommands } from "../bundles/studio/server/commands/registry.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { actorFromEnv, resolveCallActor } from "../servers/research/actor.js";
import { tinySf2 } from "./fixtures/tiny-sf2.mjs";

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
async function connect({ hub, renderer, env = {}, actor = null, catalog = null, bundled = null }) {
  const server = createStudioServer({
    hub,
    renderer,
    catalogue: STUB_CATALOGUE,
    env,
    actor,
    ...(catalog ? { catalog } : {}),
    ...(bundled ? { bundled } : {}),
  });
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

test("studio_get_clip shows a pattern clip's steps and motion", async (t) => {
  const { db, hub, songId } = await realSong(t);
  const bankId = await seedKit(hub, songId);
  const client = await connect({ hub: hubClientOf(hub, db), renderer: makeRenderer().renderer });
  try {
    /** Run one tool that must succeed, and hand back the sentence it answered with. */
    const run = async (name, args) => {
      const result = await client.callTool({ name, arguments: { song_id: songId, ...args } });
      assert.notEqual(result.isError, true, `${name} was refused: ${textOf(result)}`);
      return textOf(result);
    };

    // A pattern clip with two patterns: A has two hits, one of them lock-snapped
    // and swept by a cutoff curve; Fill has one hit and no motion.
    await run("studio_clip_add_pattern", {
      clip_id: "beat",
      track_id: "drums",
      scene_id: "verse",
      name: "Drums A",
      length_steps: 16,
    });
    await run("studio_pattern_add", { clip_id: "beat", id: "b", name: "Fill" });
    await run("studio_step_toggle", { clip_id: "beat", pattern_id: "a", at: 0, bank_id: bankId, index: 0, v: 120 });
    await run("studio_step_toggle", { clip_id: "beat", pattern_id: "a", at: 4, bank_id: bankId, index: 2 });
    await run("studio_step_set", {
      clip_id: "beat",
      pattern_id: "a",
      at: 4,
      bank_id: bankId,
      index: 2,
      locks: { cutoff_hz: 900 },
    });
    await run("studio_step_toggle", { clip_id: "beat", pattern_id: "b", at: 8, bank_id: bankId, index: 0 });
    await run("studio_motion_write", {
      clip_id: "beat",
      pattern_id: "a",
      bank_id: bankId,
      index: 2,
      param: "cutoff_hz",
      points: [{ step_frac: 0, value: 300 }, { step_frac: 2.5, value: 1400 }],
    });

    const read = await client.callTool({
      name: "studio_get_clip",
      arguments: { song_id: songId, clip_id: "beat" },
    });
    assert.notEqual(read.isError, true, textOf(read));
    const body = JSON.parse(textOf(read));

    assert.equal(body.kind, "pattern");
    assert.equal(body.name, "Drums A");
    assert.deepEqual(
      body.patterns.map((pattern) => [pattern.id, pattern.name, pattern.order]),
      [["a", "A", 0], ["b", "Fill", 1]],
      "the clip's patterns, in their own order",
    );

    const first = body.patterns[0];
    assert.deepEqual(first.steps.map((step) => step.at), [0, 4], "A's steps, in the order it plays them");
    assert.deepEqual(
      first.steps[0],
      { at: 0, bank_id: bankId, index: 0, v: 120, locks: {} },
      "a step's pad, its velocity and its (empty) locks",
    );
    assert.deepEqual(first.steps[1].locks, { cutoff_hz: 900 }, "the lock stays with the step it belongs to");
    assert.deepEqual(
      first.motion,
      {
        [`${bankId}.2|cutoff_hz`]: {
          count: 2,
          points: [{ step_frac: 0, value: 300 }, { step_frac: 2.5, value: 1400 }],
        },
      },
      "each motion lane with how many points it holds and the points themselves",
    );

    const second = body.patterns[1];
    assert.deepEqual(second.steps.map((step) => step.at), [8], "Fill keeps its own step");
    assert.deepEqual(second.motion, {}, "and holds no motion yet");
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

// ---- the controllers over MCP ----------------------------------------------

test("studio_midi lists mappings with who set them", async (t) => {
  const { db, hub, songId } = await realSong(t);
  const client = await connect({ hub: hubClientOf(hub, db), renderer: makeRenderer().renderer });
  try {
    /** Run one operator step the way the panel or the MIDI page would. */
    const asOperator = async (command, args, cmdId) => {
      const result = await hub.runCommand({
        song_id: songId,
        cmd_id: cmdId,
        command,
        args,
        author: HUMAN,
      });
      assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
      return result;
    };

    // The song the two mappings are made against: two scenes.
    await asOperator("scene.add", { id: "verse", name: "Verse" }, "seed-scene-verse");
    await asOperator("scene.add", { id: "chorus", name: "Chorus" }, "seed-scene-chorus");

    // The operator's own mapping is live at once.
    await asOperator(
      "midi.map",
      {
        id: "m-verse",
        device_name: "FCB1010",
        message: { type: "pc", channel: 1, number: 0 },
        action: { kind: "scene.launch", scene_id: "verse" },
      },
      "operator-map-verse",
    );

    // The agent's mapping is a proposal, made through its own tool.
    const proposed = await client.callTool({
      name: "studio_midi_map",
      arguments: {
        song_id: songId,
        id: "m-chorus",
        device_name: "FCB1010",
        message: { type: "pc", channel: 1, number: 1 },
        action: { kind: "scene.launch", scene_id: "chorus" },
      },
    });
    assert.notEqual(proposed.isError, true, textOf(proposed));
    assert.match(textOf(proposed), /Proposed mapping/, "the answer says it proposed rather than mapped");

    // The read: every mapping, with what it answers, what it does in plain words
    // and as JSON, and who set it.
    const listed = await client.callTool({ name: "studio_midi", arguments: { song_id: songId } });
    assert.notEqual(listed.isError, true, textOf(listed));
    const rows = JSON.parse(textOf(listed));
    assert.deepEqual(rows.map((row) => row.id), ["m-chorus", "m-verse"], "one row per mapping, in a fixed order");

    const mine = rows.find((row) => row.id === "m-verse");
    assert.deepEqual(Object.keys(mine).sort(), [
      "accepted",
      "action",
      "action_text",
      "device_name",
      "id",
      "message",
      "proposed",
      "sends",
      "set_by",
    ]);
    assert.equal(mine.device_name, "FCB1010");
    assert.deepEqual(mine.message, { type: "pc", channel: 1, number: 0 });
    assert.equal(mine.sends, "program change 0 on channel 1");
    assert.deepEqual(mine.action, { kind: "scene.launch", scene_id: "verse" });
    assert.equal(mine.action_text, 'launch scene "Verse"', "the action names the scene, not its id");
    assert.equal(mine.set_by, "operator");
    assert.equal(mine.proposed, false);
    assert.equal(mine.accepted, true, "the operator's mapping is live");

    const theirs = rows.find((row) => row.id === "m-chorus");
    assert.equal(theirs.set_by, "agent", "the bot's row says the bot set it");
    assert.equal(theirs.proposed, true, "and that it is only a proposal");
    assert.equal(theirs.accepted, false, "a proposal routes nothing");
    assert.equal(theirs.action_text, 'launch scene "Chorus"');

    // The agent has no way to accept: midi.accept is people-only, so it is no
    // tool at all, and the tools it does have say what a mapping of its is.
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    assert.equal(names.includes("studio_midi_accept"), false, "an agent cannot say yes for the operator");
    // The same for the operator's yes to a second amp on a chain.
    assert.equal(names.includes("studio_insert_accept"), false, "an agent cannot accept its own amp proposal");
    for (const name of ["studio_midi_map", "studio_midi_remove", "studio_midi_propose_profile"]) {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool, `${name} exists`);
      assert.match(tool.description, /proposal/i, `${name} says a mapping of the agent's is a proposal`);
      assert.match(tool.description, /operator/i, `${name} says the operator is who accepts it`);
    }
    const readTool = tools.find((tool) => tool.name === "studio_midi");
    assert.ok(readTool, "the mapping read is a tool");
    assert.match(readTool.description, /proposal/i, "the read says a proposal routes nothing");

    // The operator's yes makes the bot's proposal live, and the listing says so.
    await asOperator(
      "midi.accept",
      {
        id: "m-chorus",
        expect: {
          device_name: "FCB1010",
          message: { type: "pc", channel: 1, number: 1 },
          action: { kind: "scene.launch", scene_id: "chorus" },
        },
      },
      "operator-accept-chorus",
    );
    const after = JSON.parse(textOf(await client.callTool({ name: "studio_midi", arguments: { song_id: songId } })));
    const accepted = after.find((row) => row.id === "m-chorus");
    assert.equal(accepted.proposed, false, "the accepted mapping is live");
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.set_by, "agent", "and it still says who set it");

    // The agent cannot take the operator's yes back: an accepted mapping is
    // theirs, so a bot's remove is refused in the hub's own sentence.
    const taken = await client.callTool({
      name: "studio_midi_remove",
      arguments: { song_id: songId, id: "m-chorus" },
    });
    assert.equal(taken.isError, true, "removing an accepted mapping must be a tool error");
    assert.match(textOf(taken), /Only the operator changes an accepted MIDI mapping/);
  } finally {
    await client.close();
  }
});

test("a long motion lane is read as a spread of at most 256 points", () => {
  const points = Array.from({ length: 4096 }, (_, at) => ({ step_frac: at / 256, value: at }));
  const snapshot = {
    patterns: { "c/a": { id: "a", clip_id: "c", order: 0, name: "A", motion: { "b.0|cutoff_hz": points } } },
    steps: {},
  };
  const read = patternClipRead(snapshot, { id: "c", kind: "pattern" });
  const lane = read.patterns[0].motion["b.0|cutoff_hz"];
  assert.equal(lane.count, 4096, "the lane says how many points it holds");
  assert.equal(lane.points.length, 256, "and sends a spread of 256");
  assert.equal(lane.sampled, true);
  assert.deepEqual(lane.points[0], points[0], "starting at its first point");
});

// ---- the instrument library over MCP --------------------------------------

/**
 * The project storage prefix a real renderer's database answers with. The
 * scratch studio database has no `project_spaces` table, so the renderer's one
 * SELECT and its one INSERT are answered here and everything else goes through.
 */
const RENDER_PREFIX = "projects/21/";

/** The library ids the instrument tests add to their song. */
const LIB_TINY = "lib-tiny";
const LIB_ALPHA = "lib-alpha";
const LIB_BETA = "lib-beta";
const LIB_UNUSED = "lib-unused";
const LIB_CAPTURE = "lib-capture";

/** The tiny but valid bank the render below plays, and its two presets' tones. */
const TINY_FONT = tinySf2();
const TONE_PROGRAM_0 = 340;
const TONE_PROGRAM_1 = 420;

/**
 * The database a real renderer needs, on top of the scratch studio database: the
 * song project's storage prefix, and the `storage_files` row a render files.
 * @param {object} db the scratch libsql client
 * @param {{prefix?: string}} [options]
 * @returns {object}
 */
function renderDbOf(db, { prefix = RENDER_PREFIX } = {}) {
  return {
    async execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (/^\s*SELECT\s+storage_prefix/i.test(sql)) return { rows: [{ storage_prefix: prefix }] };
      if (/INSERT\s+INTO\s+storage_files/i.test(sql)) return { rows: [] };
      return db.execute(statement);
    },
  };
}

/** A project ACL for the real renderer: it grants `write_files` and keeps the audits. */
function renderAcl() {
  const audits = [];
  return {
    audits,
    async assertLocalCapability() {
      return { role: "owner", capabilities: { write_files: true } };
    },
    async appendAudit(db, entry) {
      audits.push(entry);
    },
  };
}

/**
 * An S3 client for a real renderer: it records the WAVs a render stores, and
 * serves the objects a test puts in `objects` (the song's bank).
 * @returns {object}
 */
function renderStorage() {
  const uploads = [];
  const objects = new Map();
  const gets = [];
  return {
    uploads,
    objects,
    gets,
    async uploadObject(key, data, options) {
      uploads.push({ key, data, options });
    },
    async getPresignedUrl(key) {
      return `https://storage.invalid/${key}?signature=test`;
    },
    async deleteObject() {},
    async getObject(key) {
      gets.push(key);
      const bytes = objects.get(key);
      if (!bytes) {
        const error = new Error(`The specified key does not exist: ${key}`);
        error.code = "NoSuchKey";
        throw error;
      }
      return {
        stat: { size: bytes.length, metaData: {} },
        stream: (async function* streamOnce() {
          yield bytes;
        })(),
      };
    },
  };
}

/**
 * The amplitude of one frequency in a window of samples: a Hann-windowed
 * single-bin DFT, scaled so a pure tone of amplitude A reads back A.
 * @param {Float32Array} samples
 * @param {number} from the first frame of the window
 * @param {number} count the frames in it
 * @param {number} freq Hz
 * @param {number} [rate]
 * @returns {number}
 */
function toneAmplitude(samples, from, count, freq, rate = 48000) {
  let real = 0;
  let imaginary = 0;
  let windowSum = 0;
  for (let frame = 0; frame < count; frame += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * frame) / (count - 1));
    const phase = (2 * Math.PI * freq * frame) / rate;
    const value = samples[from + frame] * window;
    real += value * Math.cos(phase);
    imaginary -= value * Math.sin(phase);
    windowSum += window;
  }
  return (2 * Math.hypot(real, imaginary)) / windowSum;
}

/**
 * A library entry as the gateway's upload finish route builds one.
 * @param {string} songId
 * @param {string} id
 * @param {object} [overrides]
 * @returns {object}
 */
function makeLibraryEntry(songId, id, overrides = {}) {
  return {
    id,
    kind: "font",
    name: `Bank ${id}`,
    source: "upload",
    storage_key: `${RENDER_PREFIX}studio/${songId}/library/${id}.sf2`,
    sha256: "a".repeat(64),
    bytes: TINY_FONT.byteLength,
    licence: "MIT",
    credit: "",
    author_label: "the operator",
    ...overrides,
  };
}

/**
 * Add one library entry the way Studio itself does: `internal: true`, as the
 * gateway's download and upload finish routes issue it.
 * @param {object} hub
 * @param {string} songId
 * @param {object} entry
 * @returns {Promise<object>}
 */
async function addLibraryEntry(hub, songId, entry) {
  const added = await hub.runCommand({
    song_id: songId,
    cmd_id: `add-library-${entry.id}`,
    command: "library.add",
    args: { entry },
    author: HUMAN,
    internal: true,
  });
  assert.equal(added.ok, true, `library.add was refused: ${added.error}`);
  return added;
}

/**
 * Run one command through the real hub and assert it applied.
 * @param {object} hub
 * @param {string} songId
 * @param {string} cmdId
 * @param {string} command
 * @param {object} args
 * @returns {Promise<object>}
 */
async function seed(hub, songId, cmdId, command, args) {
  const applied = await hub.runCommand({ song_id: songId, cmd_id: cmdId, command, args, author: HUMAN });
  assert.equal(applied.ok, true, `${command} was refused: ${applied.error}`);
  return applied;
}

test("agent sets a program and hears it in a render", async (t) => {
  const { db, hub, songId } = await realSong(t);

  // The operator's own half of the setup: the bank in the song's library, a
  // soundfont track playing it, and a bar that holds middle C.
  await addLibraryEntry(hub, songId, makeLibraryEntry(songId, LIB_TINY, { credit: "Tiny Font by a person" }));
  await seed(hub, songId, "seed-font-track", "track.add", {
    id: "piano",
    name: "Piano",
    kind: "soundfont",
    font_id: LIB_TINY,
  });
  await seed(hub, songId, "seed-font-scene", "scene.add", { id: "verse", name: "Verse" });
  await seed(hub, songId, "seed-font-clip", "clip.write", {
    clip_id: "hold",
    track_id: "piano",
    scene_id: "verse",
    name: "Hold",
    length_bars: 1,
    notes: [{ t: 0, d: 4, p: 60, v: 100 }],
  });

  const storage = renderStorage();
  storage.objects.set(makeLibraryEntry(songId, LIB_TINY).storage_key, TINY_FONT);
  const acl = renderAcl();
  const renderer = createRenderer({ db: renderDbOf(db), storage, acl, maxSeconds: 300 });
  const client = await connect({ hub: hubClientOf(hub, db), renderer });
  try {
    /** Render the verse once and hand back what the agent was told. */
    const render = async () => {
      const result = await client.callTool({
        name: "studio_render",
        arguments: { song_id: songId, scene_id: "verse", seconds: 1 },
      });
      assert.notEqual(result.isError, true, textOf(result));
      return JSON.parse(textOf(result));
    };

    // Program 0 of the bank is a 340 Hz tone.
    const first = await render();
    assert.ok(first.url, "the first render is stored");
    assert.deepEqual(first.credits, ["Tiny Font by a person"], "the credit line comes back with the render");
    assert.equal(first.missing_library, undefined, "every font was on this device");
    assert.equal(storage.gets.length, 1, "the bank was read once, from the song's own storage key");
    assert.equal(storage.gets[0], makeLibraryEntry(songId, LIB_TINY).storage_key);
    const before = decodeWav(storage.uploads[0].data).channels[0];
    assert.ok(toneAmplitude(before, 4800, 24000, TONE_PROGRAM_0) > 0.01, "program 0's 340 Hz tone sounds");
    assert.ok(toneAmplitude(before, 4800, 24000, TONE_PROGRAM_1) < 0.005, "program 1's tone does not");

    // The agent picks another preset of the SAME bank: one undoable step.
    const picked = await client.callTool({
      name: "studio_track_set_program",
      arguments: { song_id: songId, track_id: "piano", bank: 0, program: 1 },
    });
    assert.notEqual(picked.isError, true, textOf(picked));
    assert.match(textOf(picked), /program 2 \(Bright Acoustic Piano\)/);
    const entries = await hub.history(songId, { limit: 10 });
    const step = entries.find((row) => row.command === "track.set_program");
    assert.ok(step, "the program change is one history step");
    assert.equal(step.author.kind, "agent", "filed as the agent's step");
    assert.equal(step.author.id, "mcp");

    // The next render proves the change reached the engine: the bank was
    // already loaded, so this is the program the render HEARD.
    const second = await render();
    assert.equal(storage.uploads.length, 2, "the second render is its own file");
    const after = decodeWav(storage.uploads[1].data).channels[0];
    assert.ok(toneAmplitude(after, 4800, 24000, TONE_PROGRAM_1) > 0.01, "program 1's 420 Hz tone sounds");
    assert.ok(toneAmplitude(after, 4800, 24000, TONE_PROGRAM_0) < 0.005, "and program 0's is gone");
    assert.notEqual(second.url, first.url, "two renders, two files");

    // Nothing about the bank itself was the agent's to touch: the font is the
    // operator's, so a set_font step is refused in the hub's own sentence.
    await addLibraryEntry(hub, songId, makeLibraryEntry(songId, LIB_BETA, { name: "Other bank" }));
    const swapped = await client.callTool({
      name: "studio_track_set_font",
      arguments: { song_id: songId, track_id: "piano", font_id: LIB_BETA },
    });
    assert.equal(swapped.isError, true, "an agent cannot replace the bank a track plays");
    assert.match(textOf(swapped), /Only the operator changes the instrument a track plays/);
  } finally {
    await client.close();
  }
});

test("studio_library lists licences and credits", async (t) => {
  const { db, hub, songId } = await realSong(t);

  // Four library entries: one CC-BY with a credit on two tracks, one plain and
  // in use, one nothing plays, and a capture an amp insert plays. None of them
  // is a file path.
  await addLibraryEntry(
    hub,
    songId,
    makeLibraryEntry(songId, LIB_ALPHA, {
      name: "Alpha bank",
      licence: "CC-BY-4.0",
      credit: "Alpha bank by a person",
    }),
  );
  await addLibraryEntry(hub, songId, makeLibraryEntry(songId, LIB_BETA, { name: "Beta bank" }));
  await addLibraryEntry(hub, songId, makeLibraryEntry(songId, LIB_UNUSED, { name: "Unused bank" }));
  await addLibraryEntry(
    hub,
    songId,
    makeLibraryEntry(songId, LIB_CAPTURE, {
      kind: "nam",
      name: "Amp capture",
      storage_key: `${RENDER_PREFIX}studio/${songId}/library/${LIB_CAPTURE}.nam`,
      licence: "",
    }),
  );
  await seed(hub, songId, "lib-track-piano", "track.add", {
    id: "piano",
    name: "Piano",
    kind: "soundfont",
    font_id: LIB_ALPHA,
  });
  await seed(hub, songId, "lib-track-bass", "track.add", {
    id: "bass",
    name: "Bass",
    kind: "soundfont",
    font_id: LIB_BETA,
  });
  // The capture is in use by an amp on a guitar track: an agent reading the
  // library must see that, not an entry merely sitting in the song.
  await seed(hub, songId, "lib-track-guitar", "track.add", { id: "guitar", name: "Guitar", kind: "audio" });
  await seed(hub, songId, "lib-amp", "insert.add", {
    id: "amp-1",
    owner: "track:guitar",
    kind: "amp",
    params: { model_id: LIB_CAPTURE },
  });

  // A stub catalog: what this Crow could download, without depending on the
  // checked-in catalog file's contents.
  const catalog = async () => ({
    entries: [
      {
        id: "musescore-general",
        kind: "font",
        name: "MuseScore General",
        licence: "MIT",
        credit: "MuseScore General by the MuseScore team",
        default: true,
      },
    ],
  });

  const client = await connect({ hub: hubClientOf(hub, db), renderer: makeRenderer().renderer, catalog });
  try {
    const tools = (await client.listTools()).tools;
    const tool = tools.find((entry) => entry.name === "studio_library");
    assert.ok(tool, "studio_library is a read tool the agent has");
    assert.match(tool.description, /read-only/i);
    assert.match(tool.description, /operator downloads or uploads/i, "the description says a download is the person's action");
    assert.match(tool.description, /studio_track_set_program/, "and which tools change an instrument");

    const result = await client.callTool({ name: "studio_library", arguments: { song_id: songId } });
    assert.notEqual(result.isError, true, textOf(result));
    const body = JSON.parse(textOf(result));

    assert.deepEqual(
      body.entries.map((row) => row.id),
      [LIB_ALPHA, LIB_CAPTURE, LIB_BETA, LIB_UNUSED],
      "every entry, in a fixed order",
    );
    assert.deepEqual(body.entries[0], {
      id: LIB_ALPHA,
      kind: "font",
      name: "Alpha bank",
      source: "upload",
      licence: "CC-BY-4.0",
      credit: "Alpha bank by a person",
      used_by: [{ track_id: "piano", track_name: "Piano" }],
    });
    assert.deepEqual(
      body.entries[1].used_by,
      [{ insert_id: "amp-1", owner: "track:guitar", label: "amp" }],
      "an amp that plays the capture is named too",
    );
    assert.deepEqual(body.entries[2].used_by, [{ track_id: "bass", track_name: "Bass" }]);
    assert.equal(body.entries[2].credit, "");
    assert.deepEqual(body.entries[3].used_by, [], "an entry nothing plays says so");

    assert.deepEqual(body.available_catalog, [
      { catalog_id: "musescore-general", name: "MuseScore General", licence: "MIT", default: true },
    ]);

    // Nothing in the answer is a place on this device: no storage key, no path.
    const text = textOf(result);
    assert.ok(!text.includes("storage_key"), "the answer carries no storage key");
    assert.ok(!/\/library\//.test(text), "and no file path");

    // A catalog this Crow cannot read still lists the song's own banks, and
    // offers no download rather than failing the read.
    const missingCatalog = await connect({
      hub: hubClientOf(hub, db),
      renderer: makeRenderer().renderer,
      catalog: async () => {
        throw new Error("no catalog here");
      },
    });
    try {
      const without = await missingCatalog.callTool({ name: "studio_library", arguments: { song_id: songId } });
      assert.notEqual(without.isError, true, textOf(without));
      const answer = JSON.parse(textOf(without));
      assert.equal(answer.entries.length, 4, "the song's own banks are still listed");
      assert.deepEqual(answer.available_catalog, [], "and there is nothing to download");
    } finally {
      await missingCatalog.close();
    }
  } finally {
    await client.close();
  }
});

// ---- the mixer over MCP ----------------------------------------------------

test("studio_mix lists chains, sends, returns, the master target and the last render's loudness", async (t) => {
  const { db, hub, songId } = await realSong(t);

  // Two tracks, a chain on one of them whose order is not the order it was
  // built in, a return fed by a send, and the master.
  await seed(hub, songId, "mix-track-bass", "track.add", { id: "bass", name: "Bass" });
  await seed(hub, songId, "mix-track-pad", "track.add", { id: "pad", name: "Pad" });
  await seed(hub, songId, "mix-eq", "insert.add", {
    id: "eq-bass",
    owner: "track:bass",
    kind: "eq",
    params: { low_freq_hz: 120, low_gain_db: 3 },
  });
  await seed(hub, songId, "mix-comp", "insert.add", {
    id: "comp-bass",
    owner: "track:bass",
    kind: "compressor",
    params: { ratio: 2.5, threshold_db: -24 },
  });
  // `after: null` puts the gate at the FRONT of the chain, so the order the read
  // reports is the order the engine runs, not the order the steps were made in.
  await seed(hub, songId, "mix-gate", "insert.add", { id: "gate-bass", owner: "track:bass", kind: "gate", after: null });
  await seed(hub, songId, "mix-return", "return.add", { id: "verb", name: "Reverb" });
  await seed(hub, songId, "mix-return-insert", "insert.add", {
    id: "verb-reverb",
    owner: "return:verb",
    kind: "reverb",
    params: { mix: 0.3, size: 0.7 },
  });
  await seed(hub, songId, "mix-send", "send.set", { track_id: "bass", return_id: "verb", level_db: -9 });
  await seed(hub, songId, "mix-send-pre", "send.set", {
    track_id: "pad",
    return_id: "verb",
    level_db: -12,
    pre: true,
  });
  await seed(hub, songId, "mix-master", "master.set", { gain_db: -2, target: { lufs: -16, true_peak_db: -2 } });
  await seed(hub, songId, "mix-limiter", "insert.add", {
    id: "lim",
    owner: "master",
    kind: "limiter",
    params: { ceiling_db: -2 },
  });

  // What the last render of this song measured (the renderer's own memory, in
  // production: the figures a render just returned).
  const figures = {
    integrated_lufs: -15.4,
    true_peak_db: -2.1,
    short_term_max_lufs: -14.8,
    target: { lufs: -16, true_peak_db: -2 },
    meets_target: { lufs: true, true_peak: true },
    seconds: 8,
    storage_key: "projects/21/studio/song/render.wav",
  };
  const asked = [];
  const renderer = {
    async render() {
      throw new Error("a mix read renders nothing");
    },
    lastRender(songIdAsked) {
      asked.push(songIdAsked);
      return figures;
    },
  };

  const client = await connect({ hub: hubClientOf(hub, db), renderer });
  try {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "studio_mix");
    assert.ok(tool, "studio_mix is a read tool the agent has");
    assert.match(tool.description, /read-only/i);
    for (const command of [
      "studio_insert_add",
      "studio_insert_set",
      "studio_insert_move",
      "studio_insert_bypass",
      "studio_insert_remove",
      "studio_send_set",
      "studio_return_add",
      "studio_return_set",
      "studio_return_remove",
      "studio_master_set",
    ]) {
      assert.ok(tool.description.includes(command), `the description points at ${command}`);
    }
    assert.equal(
      tool.description.includes("studio_insert_accept"),
      false,
      "there is no tool for the operator's yes to a second amp, so none is offered",
    );
    // The one tool an agent proposes a second amp with says what a proposal is,
    // and that the yes is not its own.
    const addTool = (await client.listTools()).tools.find((entry) => entry.name === "studio_insert_add");
    assert.ok(addTool, "studio_insert_add is a tool");
    assert.match(addTool.description, /proposal/i, "it says a second amp is a proposal");
    assert.match(addTool.description, /no tool for accepting/i, "and that accepting is not its to do");
    assert.match(tool.description, /undo/i, "it says each step is undoable");
    assert.match(tool.description, /A\/B/i, "and that A/B is the person's");

    const result = await client.callTool({ name: "studio_mix", arguments: { song_id: songId } });
    assert.notEqual(result.isError, true, textOf(result));
    const body = JSON.parse(textOf(result));

    // The tracks, in the song's order, each with its own chain and sends.
    assert.deepEqual(
      body.tracks.map((strip) => strip.track_id),
      ["bass", "pad"],
      "one strip per track, in the song's order",
    );
    const bass = body.tracks[0];
    assert.equal(bass.track, "Bass", "the strip is named the way the panel names it");
    assert.deepEqual(
      bass.inserts.map((insert) => [insert.id, insert.kind, insert.label, insert.bypass]),
      [
        ["gate-bass", "gate", "gate", false],
        ["eq-bass", "eq", "equalizer", false],
        ["comp-bass", "compressor", "compressor", false],
      ],
      "the chain in the order the engine runs it",
    );
    assert.equal(bass.inserts[1].params.low_gain_db, 3, "the settings it will hear, by name");
    assert.equal(bass.inserts[1].params.mid_gain_db, 0, "every parameter, defaults included");
    assert.equal(bass.inserts[2].params.ratio, 2.5);
    assert.equal(bass.inserts[2].params.threshold_db, -24);
    assert.deepEqual(bass.sends, [{ track_id: "bass", return_id: "verb", level_db: -9, pre: false }]);
    assert.deepEqual(body.tracks[1].inserts, [], "a track with no effects says so");
    assert.deepEqual(body.tracks[1].sends, [
      { track_id: "pad", return_id: "verb", level_db: -12, pre: true },
    ]);

    // The returns, which are not tracks: their own level, pan and chain.
    assert.equal(body.returns.length, 1);
    const verb = body.returns[0];
    assert.equal(verb.id, "verb");
    assert.equal(verb.name, "Reverb");
    assert.equal(verb.gain_db, 0);
    assert.equal(verb.pan, 0);
    assert.equal(verb.mute, false);
    assert.deepEqual(verb.inserts.map((insert) => insert.id), ["verb-reverb"]);
    assert.equal(verb.inserts[0].params.mix, 0.3);

    // The master: its gain, its target and its chain (the limiter last).
    assert.equal(body.master.gain_db, -2);
    assert.deepEqual(body.master.target, { lufs: -16, true_peak_db: -2 });
    assert.deepEqual(body.master.inserts.map((insert) => insert.id), ["lim"]);

    // And the last render's figures, read from the renderer.
    assert.deepEqual(asked, [songId], "the mixer asks the renderer about this song");
    assert.deepEqual(body.last_render, {
      integrated_lufs: -15.4,
      true_peak_db: -2.1,
      short_term_max_lufs: -14.8,
      target: { lufs: -16, true_peak_db: -2 },
      meets_target: { lufs: true, true_peak: true },
      seconds: 8,
    });

    // A renderer that remembers nothing (a fresh process) answers null rather
    // than inventing figures.
    const forgetful = await connect({ hub: hubClientOf(hub, db), renderer: makeRenderer().renderer });
    try {
      const again = JSON.parse(
        textOf(await forgetful.callTool({ name: "studio_mix", arguments: { song_id: songId } })),
      );
      assert.equal(again.last_render, null, "a renderer with no memory says so");
      assert.equal(again.tracks.length, 2, "the chains are still listed");
    } finally {
      await forgetful.close();
    }
  } finally {
    await client.close();
  }
});

test("agent mixes a song to its target with a master limiter and the render says so", async (t) => {
  const { db, hub, songId } = await realSong(t);

  // The operator's half: a bank in the song's library and a track playing it,
  // holding one long note so a short render has something to measure.
  await addLibraryEntry(hub, songId, makeLibraryEntry(songId, LIB_TINY));
  await seed(hub, songId, "mix-font-track", "track.add", {
    id: "piano",
    name: "Piano",
    kind: "soundfont",
    font_id: LIB_TINY,
  });
  await seed(hub, songId, "mix-font-scene", "scene.add", { id: "verse", name: "Verse" });
  await seed(hub, songId, "mix-font-clip", "clip.write", {
    clip_id: "hold",
    track_id: "piano",
    scene_id: "verse",
    name: "Hold",
    length_bars: 1,
    notes: [{ t: 0, d: 4, p: 60, v: 100 }],
  });

  const storage = renderStorage();
  storage.objects.set(makeLibraryEntry(songId, LIB_TINY).storage_key, TINY_FONT);
  const renderer = createRenderer({ db: renderDbOf(db), storage, acl: renderAcl(), maxSeconds: 300 });
  const client = await connect({ hub: hubClientOf(hub, db), renderer });
  try {
    /** Run one tool that must succeed, and hand back the sentence it answered with. */
    const run = async (name, args) => {
      const result = await client.callTool({ name, arguments: { song_id: songId, ...args } });
      assert.notEqual(result.isError, true, `${name} was refused: ${textOf(result)}`);
      return textOf(result);
    };

    /** Render the verse once and hand back what the agent was told. */
    const render = async () => {
      const result = await client.callTool({
        name: "studio_render",
        arguments: { song_id: songId, scene_id: "verse", seconds: 2 },
      });
      assert.notEqual(result.isError, true, textOf(result));
      return JSON.parse(textOf(result));
    };

    // The agent's mix pass, one undoable step at a time: a compressor on the
    // track, a reverb return with a send into it, a limiter on the master, and
    // the master's target.
    assert.match(
      await run("studio_insert_add", {
        id: "comp",
        owner: "track:piano",
        kind: "compressor",
        params: { threshold_db: -24, ratio: 4, attack_ms: 10, release_ms: 100 },
      }),
      /Added a compressor to Piano/,
    );
    assert.match(await run("studio_return_add", { id: "verb", name: "Reverb" }), /Added the return "Reverb"/);
    assert.match(
      await run("studio_insert_add", {
        id: "verb-reverb",
        owner: "return:verb",
        kind: "reverb",
        params: { mix: 0.2, size: 0.6 },
      }),
      /Added a reverb to Reverb/,
    );
    assert.match(
      await run("studio_send_set", { track_id: "piano", return_id: "verb", level_db: -12 }),
      /Sent Piano to Reverb at -12 dB/,
    );
    assert.match(
      await run("studio_insert_add", {
        id: "lim",
        owner: "master",
        kind: "limiter",
        params: { ceiling_db: -1, release_ms: 50 },
      }),
      /Added a limiter to the master/,
    );
    assert.match(await run("studio_master_set", { target: { true_peak_db: -1 } }), /target to -14 LUFS at -1 dBTP/);

    // The first render tells the agent where the mix sits, against the song's
    // target: the figures the mixer screen shows, through one WAV.
    const first = await render();
    assert.deepEqual(first.target, { lufs: -14, true_peak_db: -1 }, "the song's target comes back with the render");
    assert.equal(first.effect_problems, undefined, "every chain ran: no insert had to be skipped");
    assert.ok(Number.isFinite(first.lufs), `the render measured a loudness, got ${first.lufs}`);
    assert.ok(Number.isFinite(first.short_term_max_lufs), "and the meter's short-term figure");

    // The mix sits where it sits; the agent moves the master onto the streaming
    // reference the panel offers, and mixes to that target.
    const gainDb = Math.round((-14 - first.lufs) * 10) / 10;
    assert.ok(gainDb >= -24 && gainDb <= 12, `the master can reach -14 LUFS from ${first.lufs}: ${gainDb} dB`);
    await run("studio_master_set", { gain_db: gainDb, target: { lufs: -14, true_peak_db: -1 } });

    const mixed = await render();
    assert.deepEqual(mixed.target, { lufs: -14, true_peak_db: -1 });
    assert.equal(mixed.meets_target.lufs, true, `a -14 LUFS target, measured ${mixed.lufs}`);
    assert.ok(Math.abs(mixed.lufs - mixed.target.lufs) <= 1, `within 1 LU of the target: ${mixed.lufs}`);
    assert.equal(mixed.meets_target.true_peak, true, `a -1 dBTP ceiling, measured ${mixed.true_peak_db}`);
    assert.ok(mixed.true_peak_db <= mixed.target.true_peak_db, "the limiter holds the ceiling");

    // The mixer read answers with the chain that made those figures, and with
    // the render that measured them — the same numbers, one tool call.
    const mix = JSON.parse(textOf(await client.callTool({ name: "studio_mix", arguments: { song_id: songId } })));
    assert.equal(mix.master.target.lufs, -14);
    assert.equal(mix.master.target.true_peak_db, -1);
    assert.equal(mix.master.gain_db, gainDb);
    assert.deepEqual(mix.master.inserts.map((insert) => insert.kind), ["limiter"]);
    assert.deepEqual(mix.tracks[0].inserts.map((insert) => insert.kind), ["compressor"]);
    assert.deepEqual(mix.tracks[0].sends, [{ track_id: "piano", return_id: "verb", level_db: -12, pre: false }]);
    assert.deepEqual(mix.returns.map((item) => item.name), ["Reverb"]);
    assert.equal(mix.last_render.integrated_lufs, mixed.lufs, "the mixer reports the render just made");
    assert.equal(mix.last_render.short_term_max_lufs, mixed.short_term_max_lufs);
    assert.deepEqual(mix.last_render.meets_target, mixed.meets_target);

    // Every step of that pass is the agent's own, in the shared history, so the
    // person can A/B the pass and undo it one step at a time.
    const entries = await hub.history(songId, { limit: 20 });
    for (const command of ["insert.add", "return.add", "send.set", "master.set"]) {
      const entry = entries.find((row) => row.command === command);
      assert.ok(entry, `${command} should be in the shared history`);
      assert.equal(entry.author.kind, "agent", `${command} is the agent's step, never the person's`);
      assert.equal(entry.author.id, "mcp");
    }
  } finally {
    await client.close();
  }
});

// ---- the amp over MCP (plan 1d, Task 15) ------------------------------------

/** The starter sounds this bundle ships, as the MCP reader reports them. */
const STARTER_SHA = "2d2d744516dc0197737a2c5001010429692d4cb20d72b08264781de626fcf4ca";

const STARTER_LIST = [
  {
    id: "starter-a2",
    kind: "nam",
    name: "Starter capture (NAM example model)",
    licence: "MIT",
    credit: "NAM example A2 model by Steven Atkinson (NeuralAmpModelerCore), MIT",
  },
  {
    id: "cabinet-ampmix",
    kind: "ir",
    name: "Cabinet 1 (AmpMix)",
    licence: "CC-BY-3.0",
    credit: '"Impulse Responses" by David Fau Casquel (archive.org/details/ImpulseResponses), CC BY 3.0',
  },
];

test("studio_library lists the starter sounds a person can add", async (t) => {
  const { db, hub, songId } = await realSong(t);
  // The operator has already added one starter capture to the song (the
  // gateway's starter route issued this, as Studio's own step).
  await addLibraryEntry(hub, songId, {
    id: "starter-a2",
    kind: "nam",
    name: "Starter capture (NAM example model)",
    source: "bundled",
    sha256: STARTER_SHA,
    bytes: 665758,
    licence: "MIT",
    credit: "NAM example A2 model by Steven Atkinson (NeuralAmpModelerCore), MIT",
    author_label: "You",
  });

  const client = await connect({
    hub: hubClientOf(hub, db),
    renderer: makeRenderer().renderer,
    bundled: async () => ({ entries: STARTER_LIST }),
  });
  try {
    const result = await client.callTool({ name: "studio_library", arguments: { song_id: songId } });
    assert.notEqual(result.isError, true, textOf(result));
    const body = JSON.parse(textOf(result));
    assert.deepEqual(body.available_bundled, [
      {
        bundled_id: "starter-a2",
        kind: "nam",
        name: "Starter capture (NAM example model)",
        licence: "MIT",
        credit: "NAM example A2 model by Steven Atkinson (NeuralAmpModelerCore), MIT",
        in_song: true,
      },
      {
        bundled_id: "cabinet-ampmix",
        kind: "ir",
        name: "Cabinet 1 (AmpMix)",
        licence: "CC-BY-3.0",
        credit: '"Impulse Responses" by David Fau Casquel (archive.org/details/ImpulseResponses), CC BY 3.0',
        in_song: false,
      },
    ]);
    // The read names no file: not a path, not a size, not a hash.
    const text = textOf(result);
    assert.ok(!text.includes("starter-a2.nam"), "the starter's file name stays on the server");
    // A reader with nothing to offer still reads: the starter offer is empty, the
    // song's own entries are still there.
    const noStarters = await connect({
      hub: hubClientOf(hub, db),
      renderer: makeRenderer().renderer,
      bundled: async () => ({ entries: [] }),
    });
    try {
      const read = JSON.parse(textOf(await noStarters.callTool({ name: "studio_library", arguments: { song_id: songId } })));
      assert.deepEqual(read.available_bundled, []);
      assert.equal(read.entries.length, 1, "the song's own library is still listed");
    } finally {
      await noStarters.close();
    }
  } finally {
    await client.close();
  }
});

test("agent builds a guitar chain but cannot swap or remove the capture you chose", async (t) => {
  const { db, hub, songId } = await realSong(t);

  // The operator's own half: two captures and a cabinet in the song's library,
  // and an audio track for them to run on. A library entry is theirs alone.
  const captureA = {
    ...makeLibraryEntry(songId, "lib-cap-a", {
      kind: "nam",
      name: "My capture A",
      storage_key: `${RENDER_PREFIX}studio/${songId}/library/lib-cap-a.nam`,
      sha256: "a".repeat(64),
      credit: "Capture A by the operator",
    }),
    bytes: 4096,
  };
  const captureB = {
    ...captureA,
    id: "lib-cap-b",
    name: "My capture B",
    storage_key: `${RENDER_PREFIX}studio/${songId}/library/lib-cap-b.nam`,
    sha256: "b".repeat(64),
  };
  const cabinet = {
    ...makeLibraryEntry(songId, "lib-cab", {
      kind: "ir",
      name: "My cabinet",
      storage_key: `${RENDER_PREFIX}studio/${songId}/library/lib-cab.wav`,
      sha256: "c".repeat(64),
      credit: "Cabinet by the operator",
    }),
    bytes: 8192,
  };
  await addLibraryEntry(hub, songId, captureA);
  await addLibraryEntry(hub, songId, captureB);
  await addLibraryEntry(hub, songId, cabinet);
  await seed(hub, songId, "amp-track", "track.add", { id: "guitar", name: "Guitar", kind: "audio" });

  const client = await connect({ hub: hubClientOf(hub, db), renderer: makeRenderer().renderer });
  try {
    /** Run one tool that must succeed, and hand back its sentence. */
    const run = async (name, args) => {
      const result = await client.callTool({ name, arguments: { song_id: songId, ...args } });
      assert.notEqual(result.isError, true, `${name} was refused: ${textOf(result)}`);
      return textOf(result);
    };

    // The agent's chain: an amp on the capture and cabinet the song already
    // holds, a gate before it and an equalizer after it, then a reverb return
    // the amp is sent to. Every step is the agent's own and undoable.
    assert.match(
      await run("studio_insert_add", {
        id: "amp",
        owner: "track:guitar",
        kind: "amp",
        params: { model_id: "lib-cap-a", ir_id: "lib-cab", input_db: 3, output_db: -2, ir_mix: 0.8 },
      }),
      /Added an amp to Guitar/,
    );
    await run("studio_insert_add", { id: "gate", owner: "track:guitar", kind: "gate", after: null });
    await run("studio_insert_add", { id: "eq", owner: "track:guitar", kind: "eq" });
    await run("studio_return_add", { id: "verb", name: "Reverb" });
    await run("studio_send_set", { track_id: "guitar", return_id: "verb", level_db: -18 });

    // The amp's own three numbers are the agent's: it mixes them, one insert.set
    // each, and the capture and cabinet stay exactly as the operator chose them.
    assert.match(
      await run("studio_insert_set", { id: "amp", params: { input_db: 6, ir_mix: 0.5 } }),
      /input_db, ir_mix on Guitar/,
    );

    // The mixer read names both sounds and their credits.
    const mix = JSON.parse(textOf(await client.callTool({ name: "studio_mix", arguments: { song_id: songId } })));
    const amp = mix.tracks[0].inserts.find((insert) => insert.kind === "amp");
    assert.ok(amp, "the amp is in the guitar's chain");
    assert.deepEqual(amp.capture, { id: "lib-cap-a", name: "My capture A", credit: "Capture A by the operator" });
    assert.deepEqual(amp.cabinet, { id: "lib-cab", name: "My cabinet", credit: "Cabinet by the operator" });
    assert.equal(amp.params.input_db, 6, "the settings the engine will use");
    assert.equal(amp.params.ir_mix, 0.5);
    // An effect has neither key: a reader can tell an amp from an effect.
    const eq = mix.tracks[0].inserts.find((insert) => insert.kind === "eq");
    assert.equal("capture" in eq, false);
    assert.equal("cabinet" in eq, false);

    // Swapping the capture, swapping the cabinet, and removing the amp are the
    // operator's, and each is refused in the hub's own sentence.
    for (const params of [{ model_id: "lib-cap-b" }, { ir_id: null }]) {
      const swapped = await client.callTool({ name: "studio_insert_set", arguments: { song_id: songId, id: "amp", params } });
      assert.equal(swapped.isError, true, `${JSON.stringify(params)} must need a yes`);
      assert.match(textOf(swapped), /Only the operator changes the capture or cabinet an amp plays/);
    }
    const removed = await client.callTool({ name: "studio_insert_remove", arguments: { song_id: songId, id: "amp" } });
    assert.equal(removed.isError, true);
    assert.match(textOf(removed), /Only the operator removes an amp/);

    // What the agent may do instead: bypass the amp. It stays in the chain with
    // the operator's capture on it.
    assert.match(await run("studio_insert_bypass", { id: "amp", bypass: true }), /bypasse/i);
    const after = JSON.parse(textOf(await client.callTool({ name: "studio_mix", arguments: { song_id: songId } })));
    const held = after.tracks[0].inserts.find((insert) => insert.kind === "amp");
    assert.equal(held.bypass, true);
    assert.equal(held.capture.id, "lib-cap-a", "still the operator's capture");
    assert.equal(held.params.ir_id, "lib-cab", "still the operator's cabinet");
  } finally {
    await client.close();
  }
});
