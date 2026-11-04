/**
 * Studio MCP tools — the agent surface.
 *
 * These tests drive the real MCP server over an in-memory transport with a fake
 * hub client, a fake renderer, a stub catalogue and the app's real actor
 * helpers. They pin the four things the plan names for this task:
 *
 *   1. the tool list is the registry's own list (no more, no less, and nothing
 *      for a people-only command);
 *   2. an agent call is never attributed to the person, even when the process
 *      env says the caller is the owner;
 *   3. a hub refusal reaches the agent as a tool error in the hub's own words,
 *      with its code;
 *   4. a render passes its arguments through and reports a limit refusal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStudioServer } from "../bundles/studio/server/mcp.js";
import { listCommands } from "../bundles/studio/server/commands/registry.js";
import { actorFromEnv, resolveCallActor } from "../servers/research/actor.js";

/** The render url the fake renderer answers with (a placeholder host). */
const RENDER_URL = "https://storage.example/studio/song-1/render.wav";

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
