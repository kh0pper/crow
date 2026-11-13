/**
 * The render routes: the WAV `studio_render` files, and the figures it measured.
 *
 * `GET /api/studio/songs/:id/renders/:name` is what the MCP tool's
 * `download_url` points at, so what matters here is that it is a gateway route
 * and not a storage address: the bytes come from the injected storage adapter,
 * the headers are the audio routes' own (a one-hour private cache, a
 * Content-Length only with the first byte), and no response — body or header —
 * names the bucket, the key or a host, and none is a presigned URL.
 *
 * The name is the whole gate to a key: one safe segment ending in `.wav`, so a
 * nested path, an encoded slash, a `..` or another extension is the same 404 a
 * missing render gets, answered before storage is asked anything.
 *
 * What is real here: `express`, `createStudioWeb`'s router and a real session
 * hub on a scratch crow.db (so `readSongRow` and the hub's own `openSong` are
 * the production reads). What is a fake: object storage (an in-memory map), the
 * project ACL, the dashboard auth the gateway injects, and the `renderInfoOf`
 * injection — the audit-row query lives in the panel loader, so this file pins
 * the route's contract with a fake that answers exactly what that query returns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createClient } from "@libsql/client";
import express, { Router } from "express";
import { WebSocketServer } from "ws";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb } from "../bundles/studio/server/web.js";

/** The project the song lives in. */
const PROJECT = 31;

/** The dashboard's author for a song created through the hub. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** The project's storage prefix, as `project_spaces.storage_prefix` holds it. */
const PREFIX = "projects/31/";

/** One render's file name, the shape the renderer writes. */
const RENDER_NAME = "2026-01-01T00-00-00-Render_test-A.wav";

/** What every storage-backed route answers when storage cannot be reached. */
const STORAGE_UNAVAILABLE = "Crow storage is not available on this instance.";

/** The bytes a fake object holds (a real WAV is not needed: nothing parses it). */
const WAV_BYTES = Buffer.from("RIFF....WAVEfmt test render bytes");

/** @returns {string} the one storage key a render of a song may be streamed from. */
function renderKey(songId, name) {
  return `${PREFIX}studio/${songId}/${name}`;
}

/** A scratch libsql client for one test, closed when the test ends. */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/** A project ACL that allows the project here and swallows the audit rows. */
function fakeAcl() {
  async function assertProjectExists(_db, projectId) {
    const id = Number(projectId);
    if (id !== PROJECT) throw new Error(`Project #${id} not found`);
    return { id };
  }
  return {
    assertProjectExists,
    assertCapability: (db, projectId) => assertProjectExists(db, projectId),
    async appendAudit() {},
  };
}

/**
 * The storage adapter the render route reads through: an in-memory object map,
 * the project's prefix, and the key of every object it was asked for.
 * @param {{objects?: Map<string, Buffer>, failGet?: Error|null,
 *          streamError?: string|null}} [options]
 *   `failGet` makes the bucket call itself fail; `streamError` hands back a
 *   stream that dies before its first byte.
 */
function fakeRenderStorage({ objects = new Map(), failGet = null, streamError = null } = {}) {
  const requested = [];
  return {
    objects,
    requested,
    defaultBucket: () => "crow-files",
    storagePrefixFor: async () => PREFIX,
    async getObject(key, options) {
      requested.push({ key, bucket: options?.bucket });
      if (failGet) throw failGet;
      if (streamError) {
        const stream = new Readable({
          read() {
            this.destroy(new Error(streamError));
          },
        });
        return { stream, stat: { size: 4096 } };
      }
      const bytes = objects.get(key);
      if (!bytes) {
        const error = new Error("The specified key does not exist.");
        error.code = "NotFound";
        throw error;
      }
      return { stream: Readable.from([bytes]), stat: { size: bytes.length } };
    },
  };
}

/**
 * Boot the Studio router on 127.0.0.1:0 with one song, and the render storage
 * the routes stream through.
 *
 * @param {import("node:test").TestContext} t
 * @param {{session?: boolean, storage?: object|null,
 *          renderInfoOf?: Function|null}} [options]
 *   `session: false` installs a dashboard gate that refuses every request the
 *   way an ended session answers; `renderInfoOf` is the audit-row lookup the
 *   panel loader injects (absent means this instance cannot describe a render).
 */
async function boot(t, { session = true, storage = null, renderInfoOf = null } = {}) {
  const db = scratchDb(t);
  await initStudioTables(db);
  const hub = createHub({ db, acl: fakeAcl(), onBroadcast: () => {} });

  const created = await hub.createSong({ project_id: PROJECT, title: "Render song", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const songId = created.song_id;

  const takeStorage = storage === null ? fakeRenderStorage() : storage;
  const web = createStudioWeb({
    hub,
    Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => true,
      sessionFromRequest: () => "good",
      verifySession: async () => ({}),
      csrfTokenAccepted: (_req, presented) => presented === "csrf-ok",
      classifyPeer: () => ({ via: "local" }),
    },
    crowHome: mkdtempSync(join(tmpdir(), "studio-render-home-")),
    bundleDir: null,
    takeStorage,
    songRowOf: null,
    ...(renderInfoOf ? { renderInfoOf } : {}),
  });

  const dashboardAuth = session
    ? (_req, _res, next) => next()
    : (_req, res) => res.status(401).json({ error: "unauthorized" });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(web.router(dashboardAuth));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        try {
          server.closeAllConnections?.();
        } catch {
          // Nothing left to close.
        }
        server.close(() => resolve());
      }),
  );

  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, songId, hub, storage: takeStorage };
}

/**
 * GET one render, keeping the headers and the bytes.
 * @returns {Promise<{status: number, headers: Headers, bytes: Buffer,
 *   text: string, body: object|null}>}
 */
async function fetchRender(base, songId, name, { query = "", headers = {} } = {}) {
  const response = await fetch(
    `${base}/api/studio/songs/${encodeURIComponent(songId)}/renders/${name}${query}`,
    { headers },
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, bytes, text, body: parsed };
}

/** @returns {Promise<{status: number, body: object|null}>} one render-info answer. */
async function fetchRenderInfo(base, songId, name) {
  const response = await fetch(
    `${base}/api/studio/songs/${encodeURIComponent(songId)}/renders/${name}/info`,
  );
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

test("render route streams the WAV with a one-hour private cache", async (t) => {
  const storage = fakeRenderStorage();
  const { base, songId } = await boot(t, { storage });
  const key = renderKey(songId, RENDER_NAME);
  storage.objects.set(key, WAV_BYTES);

  const streamed = await fetchRender(base, songId, RENDER_NAME);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get("content-type"), "audio/wav");
  // A render is not hash-addressed, so it is cached for an hour, not forever.
  assert.equal(streamed.headers.get("cache-control"), "private, max-age=3600");
  assert.equal(streamed.headers.get("content-length"), String(WAV_BYTES.length));
  assert.equal(streamed.headers.get("content-disposition"), null, "playing it is not downloading it");
  assert.deepEqual(streamed.bytes, WAV_BYTES);
  assert.deepEqual(storage.requested, [{ key, bucket: "crow-files" }], "the render's own key was read");

  // Nothing about the store leaves this Crow: no presigned URL, no bucket, no
  // key, no host.
  const headerText = [...streamed.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n");
  for (const haystack of [streamed.text, headerText]) {
    assert.equal(haystack.includes("X-Amz"), false, "no presigned URL");
    assert.equal(haystack.includes("http://"), false, "no storage endpoint");
    assert.equal(haystack.includes(key), false, "no storage key");
    assert.equal(haystack.includes("crow-files"), false, "no bucket");
  }
});

test("?download=1 adds a Content-Disposition attachment", async (t) => {
  const storage = fakeRenderStorage();
  const { base, songId } = await boot(t, { storage });
  storage.objects.set(renderKey(songId, RENDER_NAME), WAV_BYTES);

  const downloaded = await fetchRender(base, songId, RENDER_NAME, { query: "?download=1" });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("content-disposition"), `attachment; filename="${RENDER_NAME}"`);
  assert.equal(downloaded.headers.get("content-type"), "audio/wav");
  assert.deepEqual(downloaded.bytes, WAV_BYTES);
});

test("a name that is not one safe .wav segment is a 404, and storage is never asked", async (t) => {
  const storage = fakeRenderStorage();
  const { base, songId } = await boot(t, { storage });
  storage.objects.set(renderKey(songId, RENDER_NAME), WAV_BYTES);

  // A nested path (an extra segment), an encoded slash (a `..` escaped into
  // one segment), a leading dot, and the wrong extension.
  const refused = [
    `nested/${RENDER_NAME}`,
    "..%2Fsecret.wav",
    ".hidden.wav",
    "render.wave",
    "render",
    "render.WAV",
  ];
  for (const name of refused) {
    const answer = await fetchRender(base, songId, name);
    assert.equal(answer.status, 404, name);
  }

  // A name of the right shape but no object behind it is the same 404, once
  // storage has been asked (and answered "no such key").
  const missing = await fetchRender(base, songId, "nothing-here.wav");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "There is no such render in this song." });

  // Only the well-shaped miss reached storage: the refused names were refused
  // by the route, not fetched and then hidden.
  assert.deepEqual(storage.requested.map((entry) => entry.key), [renderKey(songId, "nothing-here.wav")]);
});

test("an unknown song has no render", async (t) => {
  const storage = fakeRenderStorage();
  const { base, songId } = await boot(t, { storage });
  storage.objects.set(renderKey(songId, RENDER_NAME), WAV_BYTES);

  const unknown = await fetchRender(base, "no-such-song", RENDER_NAME);
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: "There is no such render in this song." });
  assert.deepEqual(storage.requested, [], "storage was never asked about another song's key");
});

test("a missing object is a 404, on either spelling of the store's answer", async (t) => {
  for (const code of ["NotFound", "NoSuchKey"]) {
    const { base, songId } = await boot(t, {
      storage: fakeRenderStorage({
        failGet: Object.assign(new Error("The specified key does not exist."), { code }),
      }),
    });
    const answer = await fetchRender(base, songId, RENDER_NAME);
    assert.equal(answer.status, 404, code);
    assert.deepEqual(answer.body, { error: "There is no such render in this song." }, code);
    assert.equal(answer.headers.get("cache-control"), null, code);
  }
});

test("a storage failure is the fixed 503 sentence, naming nothing", async (t) => {
  // Storage that cannot be reached at all: the driver's own error names an
  // address and a key, so it must never reach the caller.
  const key = renderKey("song-1", RENDER_NAME);
  const unreachable = await boot(t, {
    storage: fakeRenderStorage({ failGet: new Error(`connect ECONNREFUSED while reading ${key} on storage.example`) }),
  });
  const refused = await fetchRender(unreachable.base, unreachable.songId, RENDER_NAME);
  assert.equal(refused.status, 503);
  assert.deepEqual(refused.body, { error: STORAGE_UNAVAILABLE });
  assert.match(refused.headers.get("content-type"), /^application\/json/);
  assert.equal(refused.headers.get("cache-control"), null, "no render is cached when none could be read");
  assert.equal(refused.text.includes("storage.example"), false, "the endpoint stays in the log");
  assert.equal(refused.text.includes(unreachable.storage.requested[0].key), false, "and so does the key");

  // Storage that opened the object and then failed before its first byte: still
  // a clean 503, with no audio headers on it.
  const broken = await boot(t, { storage: fakeRenderStorage({ streamError: "the object store dropped the connection" }) });
  const cut = await fetchRender(broken.base, broken.songId, RENDER_NAME);
  assert.equal(cut.status, 503);
  assert.deepEqual(cut.body, { error: STORAGE_UNAVAILABLE });
  assert.match(cut.headers.get("content-type"), /^application\/json/);
  assert.equal(cut.headers.get("cache-control"), null);
  assert.notEqual(cut.headers.get("content-length"), "4096");
});

test("the render route needs a dashboard session", async (t) => {
  const storage = fakeRenderStorage();
  const { base, songId } = await boot(t, { storage, session: false });
  storage.objects.set(renderKey(songId, RENDER_NAME), WAV_BYTES);

  const refused = await fetchRender(base, songId, RENDER_NAME);
  assert.equal(refused.status, 401);
  assert.deepEqual(storage.requested, [], "nothing behind the gate is read");
});

test("render info answers the six measured figures", async (t) => {
  const figures = {
    seconds: 8,
    lufs: -14.2,
    true_peak_db: -1.1,
    short_term_max_lufs: -13.4,
    target: { lufs: -14, true_peak_db: -1 },
    meets_target: { lufs: true, true_peak: true },
  };
  const asked = [];
  const { base, songId } = await boot(t, {
    renderInfoOf: async ({ projectId, storageKey }) => {
      asked.push({ projectId, storageKey });
      return { ...figures, missing_samples: ["pad-1"] };
    },
  });

  const info = await fetchRenderInfo(base, songId, RENDER_NAME);
  assert.equal(info.status, 200);
  assert.deepEqual(
    info.body,
    figures,
    "the six figures, and nothing else the audit payload carries",
  );
  assert.deepEqual(asked, [{ projectId: PROJECT, storageKey: renderKey(songId, RENDER_NAME) }]);
});

test("render info is a 404 without the lookup, without a row, or for a bad name", async (t) => {
  const none = await boot(t);
  assert.equal((await fetchRenderInfo(none.base, none.songId, RENDER_NAME)).status, 404);

  const noRow = await boot(t, { renderInfoOf: async () => null });
  const missing = await fetchRenderInfo(noRow.base, noRow.songId, RENDER_NAME);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "There is no such render in this song." });

  const badName = await fetchRenderInfo(none.base, none.songId, "render.wave");
  assert.equal(badName.status, 404);

  const unknownSong = await boot(t, { renderInfoOf: async () => ({ seconds: 1 }) });
  assert.equal((await fetchRenderInfo(unknownSong.base, "no-such-song", RENDER_NAME)).status, 404);
});