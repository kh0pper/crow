/**
 * The instrument catalog, the verified download, and the two library routes.
 *
 * What is real here: `server/library-store.js` in full (the streaming fetch, the
 * running sha256, the 0600 temporary file and the atomic rename, the GC),
 * `createStudioWeb`'s router, `express` and the real network gate from
 * `servers/gateway/dashboard/auth.js`. What is a fake: the session hub (a song
 * is a project id and a library map), object storage for uploaded files, and
 * the dashboard session and CSRF values.
 *
 * No test fetches the real catalog file. Every download here runs against a
 * local HTTP stub and a catalog override written into a temp directory, so the
 * hash and the size are the test's own — and a refusal can be provoked on
 * purpose (wrong bytes, a body past its size).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import {
  DEFAULT_CATALOG_PATH,
  DOWNLOAD_TIMEOUT_TEXT,
  createLibraryStore,
  downloadCatalogEntry,
  libraryDir,
  libraryGc,
} from "../bundles/studio/server/library-store.js";
import { createStudioWeb, startLibraryGc } from "../bundles/studio/server/web.js";
import { isAllowedNetwork } from "../servers/gateway/dashboard/auth.js";

// A test server is reached over loopback, which the real gate refuses on its
// own; declaring loopback a trusted proxy and naming a private client per
// request exercises the real gate (the same shape the take-route tests use).
process.env.CROW_TRUSTED_PROXIES = "loopback";
delete process.env.CROW_DASHBOARD_PUBLIC;

const BUNDLE_DIR = fileURLToPath(new URL("../bundles/studio/", import.meta.url));

/** The private client every request says it came from. */
const CLIENT = "10.0.0.5";

/** The forwarding header that names `CLIENT` to the trusted loopback proxy. */
const FORWARDED = Object.freeze({ "x-forwarded-for": CLIENT });

/** The song every download in these tests lands in. */
const SONG = "song-1";

/** A second song in the same project. */
const OTHER_SONG = "song-2";

/** The project both songs live in. */
const PROJECT = 7;

/** The project's storage prefix, as `project_spaces.storage_prefix` holds it. */
const PREFIX = "projects/7/";

/** The session cookie the fake dashboard auth accepts. */
const SESSION = "crow_session=good";

/** The CSRF value the fake dashboard auth accepts. */
const CSRF = "csrf-ok";

/** What the library file route says for a file this Crow does not hold. */
const MISSING_INSTRUMENT = "This instrument is not on this Crow yet.";

/** What the download route says when an agent asks. */
const AGENT_REFUSED = "Downloading instruments is for the person at the Studio page; an agent cannot download one.";

/** @returns {string} one buffer's sha256, hex. */
function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A small fake bank: the SF3 magic bytes and a deterministic tail, so the file
 * is recognisable and the hash is the test's own.
 * @returns {Buffer}
 */
function fakeBank() {
  const bytes = Buffer.alloc(3000);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("sfbk", 8, "ascii");
  for (let at = 12; at < bytes.length; at += 1) bytes[at] = (at * 37) % 251;
  return bytes;
}

/**
 * A local HTTP stub serving one file, counting requests. `chunked` sends the
 * body in two pieces with no Content-Length, so the "larger than the catalog
 * says" check is the running count rather than the announced header.
 * `location` answers a 302 to that URL instead of a body; `stall` sends half
 * the body and then never finishes, so a transfer's idle deadline is what ends
 * it.
 * @param {import("node:test").TestContext} t
 * @param {Buffer} bytes
 * @param {{chunked?: boolean, status?: number, location?: string, stall?: boolean}} [options]
 * @returns {Promise<{base: string, requests: string[]}>}
 */
async function stubServer(t, bytes, { chunked = false, status = 200, location = null, stall = false } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(String(req.url));
    if (location) {
      res.writeHead(302, { Location: location });
      res.end();
      return;
    }
    if (status !== 200) {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end("no");
      return;
    }
    if (stall) {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) });
      res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      // ... and never end it: the client's idle deadline has to give up.
      return;
    }
    if (chunked) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      res.end(bytes.subarray(Math.floor(bytes.length / 2)));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        // A stalled response holds its socket open; the stub is still ours to close.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

/**
 * Write a catalog override for one row and return its path.
 * @param {string} crowHome
 * @param {object} row
 * @returns {string}
 */
function catalogAt(crowHome, row) {
  const path = join(crowHome, "test-catalog.json");
  writeFileSync(path, JSON.stringify({ version: 1, entries: [row] }), "utf8");
  return path;
}

/** @returns {string} a fresh Crow home for one test. */
function homeFor(t) {
  return mkdtempSync(join(tmpdir(), "studio-library-"));
}

/** @returns {object} the row a test's stub serves, with `overrides` applied. */
function catalogRow(base, bytes, overrides = {}) {
  return {
    id: "test-bank",
    kind: "font",
    name: "Test Bank",
    urls: [`${base}/Test_Bank.sf3`],
    sha256: sha256Of(bytes),
    bytes: bytes.length,
    licence: "MIT",
    credit: "Test Bank by the test suite",
    default: true,
    optional: false,
    ...overrides,
  };
}

/** @returns {object} the fake hub the library routes are exercised against. */
function fakeHub() {
  const commands = [];
  const state = {
    [SONG]: { project_id: PROJECT, library: {} },
    [OTHER_SONG]: { project_id: PROJECT, library: {} },
  };
  return {
    commands,
    state,
    async songRow(songId) {
      const song = state[songId];
      return song ? { id: songId, project_id: song.project_id } : null;
    },
    async listSongs() {
      return Object.entries(state).map(([id, song]) => ({ id, project_id: song.project_id, title: id }));
    },
    async openSong(songId) {
      const song = state[songId];
      if (!song) {
        const error = new Error(`There is no song "${songId}".`);
        error.code = "not_found";
        throw error;
      }
      return { doc: null, snapshot: { meta: { title: songId }, library: song.library }, snapshot_version: 1 };
    },
    async runCommand(request) {
      commands.push(request);
      if (request.command !== "library.add") {
        return { ok: false, code: "invalid", error: "the test hub only takes library.add" };
      }
      const entry = request.args?.entry;
      const song = state[request.song_id];
      if (!song || !entry?.id) return { ok: false, code: "invalid", error: "that entry has no song" };
      if (song.library[entry.id]) {
        return { ok: false, code: "invalid", error: `The library already holds "${entry.id}".` };
      }
      song.library[entry.id] = entry;
      return {
        ok: true,
        entry: { command: request.command, after: { [`library:${entry.id}|*`]: entry } },
        snapshot_version: 2,
      };
    },
  };
}

/** @returns {string|null} one cookie's value out of a Cookie header. */
function cookieOf(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** The dashboard session check, narrowed to these tests but using the real gate. */
function dashboardAuth(req, res, next) {
  if (!isAllowedNetwork(req)) return res.status(403).type("html").send("Access Denied");
  if (cookieOf(req.headers.cookie, "crow_session") !== "good") {
    return res.status(403).type("html").send("Access Denied");
  }
  return next();
}

/**
 * Boot a gateway-shaped server: the real library store over one temp Crow home
 * and one catalog override, the real web router, and the fakes above.
 * @param {import("node:test").TestContext} t
 * @param {{catalog: object, library?: object, otherLibrary?: object,
 *          storage?: object|null, canWrite?: Function|null}} options
 */
async function boot(t, { catalog, library: songLibrary = {}, otherLibrary = {}, storage = null, canWrite = null }) {
  const hub = fakeHub();
  hub.state[SONG].library = songLibrary;
  hub.state[OTHER_SONG].library = otherLibrary;
  const crowHome = homeFor(t);
  const catalogPath = catalogAt(crowHome, catalog);

  const web = createStudioWeb({
    hub,
    Router: express.Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork,
      sessionFromRequest: (req) => cookieOf(req.headers.cookie, "crow_session"),
      verifySession: async (token) => token === "good",
      csrfTokenAccepted: (_req, presented) => presented === CSRF,
      classifyPeer: () => ({ via: "remote" }),
    },
    crowHome,
    bundleDir: BUNDLE_DIR,
    takeStorage: storage,
    songRowOf: (songId) => hub.songRow(songId),
    // The download route's write check: permissive unless a test says a
    // project's member may only read.
    assertCanWrite: canWrite ?? (async () => {}),
    libraryStore: (await import("../bundles/studio/server/library-store.js")).createLibraryStore({
      crowHome,
      catalogPath,
    }),
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(web.router(dashboardAuth));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );

  return { base: `http://127.0.0.1:${server.address().port}`, hub, crowHome, catalogPath };
}

/**
 * One dashboard request, as the Studio page sends it.
 * @returns {Promise<{status: number, body: object|null, bytes: Buffer, headers: Headers}>}
 */
async function call(base, path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie: SESSION,
      "x-crow-csrf": CSRF,
      ...FORWARDED,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, bytes: buffer, headers: response.headers };
}

/** @returns {string[]} every file name in one Crow home's library directory. */
function storedNames(crowHome) {
  try {
    return readdirSync(libraryDir(crowHome));
  } catch {
    return [];
  }
}

/**
 * Put one verified file in a Crow home's library, the way a download leaves it.
 * @param {string} crowHome
 * @param {string} sha256
 * @param {Buffer} bytes
 * @param {string} [ext]
 */
function storeFile(crowHome, sha256, bytes, ext = "sf3") {
  mkdirSync(libraryDir(crowHome), { recursive: true });
  writeFileSync(join(libraryDir(crowHome), `${sha256}.${ext}`), bytes);
}

test("the shipped catalog pins MuseScore General with its hash, size, licence and credit", () => {
  const catalog = JSON.parse(readFileSync(DEFAULT_CATALOG_PATH, "utf8"));
  const row = catalog.entries.find((entry) => entry.id === "musescore-general");
  assert.ok(row, "the catalog must carry MuseScore General");
  assert.equal(row.kind, "font");
  assert.equal(row.name, "MuseScore General");
  assert.deepEqual(row.urls, [
    "https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3",
  ]);
  // One url, and no mirror: a second source is only listed once its bytes have
  // been checked against the same pin (see the store's header).
  assert.deepEqual(row.mirrors, []);
  assert.equal(row.sha256, "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3");
  assert.equal(row.bytes, 39900972);
  assert.equal(row.licence, "MIT");
  assert.match(row.credit, /S\. Christian Collins/);
  assert.equal(row.default, true);
  assert.equal(row.optional, false);
  // Every row — this one and anything a later task adds — is complete enough to
  // verify a download before it is kept.
  for (const entry of catalog.entries) {
    assert.match(entry.id, /^[a-z0-9-]+$/, `"${entry.id}" must be a slug`);
    assert.ok(["font", "nam", "ir"].includes(entry.kind), `"${entry.id}" needs a known kind`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `"${entry.id}" needs a sha256`);
    assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, `"${entry.id}" needs a size`);
    assert.ok(entry.licence && entry.credit, `"${entry.id}" needs its licence and credit`);
  }
});

test("a download is verified against its sha256 and kept once", async (t) => {
  const bytes = fakeBank();
  const { base, requests } = await stubServer(t, bytes);
  const crowHome = homeFor(t);
  const catalogPath = catalogAt(crowHome, catalogRow(base, bytes));

  const first = await downloadCatalogEntry("test-bank", { crowHome, catalogPath });
  assert.equal(first.fetched, true, "the first call fetches");
  assert.equal(first.sha256, sha256Of(bytes));
  assert.equal(first.bytes, bytes.length);
  assert.equal(first.path, join(libraryDir(crowHome), `${sha256Of(bytes)}.sf3`));
  assert.deepEqual(readFileSync(first.path), bytes, "the stored file is the verified file");
  assert.equal(statSync(first.path).mode & 0o777, 0o600, "a stored instrument is 0600");
  assert.deepEqual(storedNames(crowHome), [`${sha256Of(bytes)}.sf3`], "and nothing is left beside it");

  // A second call — the same song, or another one — reads the stored copy and
  // does not touch the network.
  const second = await downloadCatalogEntry("test-bank", { crowHome, catalogPath });
  assert.equal(second.fetched, false, "the stored copy is reused");
  assert.equal(second.path, first.path);
  assert.equal(requests.length, 1, "the file was fetched exactly once");
});

test("a mismatched download leaves nothing behind", async (t) => {
  const served = fakeBank();
  const wrong = Buffer.from("RIFFnot-the-bank-at-allsfbk", "ascii");
  const { base } = await stubServer(t, served);
  const crowHome = homeFor(t);
  const catalogPath = catalogAt(crowHome, catalogRow(base, served, { sha256: sha256Of(wrong) }));

  await assert.rejects(() => downloadCatalogEntry("test-bank", { crowHome, catalogPath }), /sha256/);
  assert.deepEqual(storedNames(crowHome), [], "a failed download keeps no file, temporary or final");
});

test("a download larger than the catalog says is refused and leaves nothing behind", async (t) => {
  const served = fakeBank();
  const { base } = await stubServer(t, served, { chunked: true });
  const crowHome = homeFor(t);
  // The right hash, but the row claims fewer bytes than the server sends.
  const catalogPath = catalogAt(crowHome, catalogRow(base, served, { bytes: served.length - 10 }));

  await assert.rejects(() => downloadCatalogEntry("test-bank", { crowHome, catalogPath }), /larger than the catalog/);
  assert.deepEqual(storedNames(crowHome), [], "nothing is left behind");
});

test("the housekeeping pass removes an unused old file and keeps one a song uses", async (t) => {
  const bytes = fakeBank();
  const sha = sha256Of(bytes);
  const crowHome = homeFor(t);
  const dir = libraryDir(crowHome);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha}.sf3`);
  writeFileSync(path, bytes);

  // 29 days old: kept whatever the songs say.
  const monthLater = () => Date.now() + 31 * 24 * 60 * 60 * 1000;
  const young = await libraryGc({ crowHome, inUse: new Set(), olderThanDays: 30, now: () => Date.now() });
  assert.deepEqual(young.removed, [], "a fresh file is not collected");

  // 31 days old and no song names it: collected.
  const old = await libraryGc({ crowHome, inUse: new Set(), olderThanDays: 30, now: monthLater });
  assert.deepEqual(old.removed, [`${sha}.sf3`]);
  assert.equal(old.freed_bytes, bytes.length);
  assert.deepEqual(storedNames(crowHome), []);

  // The same file, named by a song: kept.
  writeFileSync(path, bytes);
  const inUse = await libraryGc({ crowHome, inUse: new Set([sha]), olderThanDays: 30, now: monthLater });
  assert.deepEqual(inUse.removed, []);
  assert.deepEqual(storedNames(crowHome), [`${sha}.sf3`]);

  // A temporary file an interrupted download left behind is collected after a
  // day, whether or not a song names the hash it was fetching.
  const part = join(dir, `.part-0123456789abcdef-${sha}`);
  writeFileSync(part, bytes);
  const stillYoung = await libraryGc({
    crowHome,
    inUse: new Set([sha]),
    now: () => Date.now() + 60 * 60 * 1000,
  });
  assert.deepEqual(stillYoung.removed, [], "an hour-old temporary file is a download in flight");
  const stale = await libraryGc({
    crowHome,
    inUse: new Set([sha]),
    now: () => Date.now() + 2 * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(stale.removed, [`.part-0123456789abcdef-${sha}`]);
  assert.deepEqual(storedNames(crowHome), [`${sha}.sf3`]);
});

test("a download lands one library entry, and a second ask reuses it", async (t) => {
  const bytes = fakeBank();
  const { base, requests } = await stubServer(t, bytes);
  const row = catalogRow(base, bytes);
  const { base: gateway, hub, crowHome } = await boot(t, { catalog: row });

  const first = await call(gateway, "/api/studio/library/download", {
    method: "POST",
    body: { song_id: SONG, catalog_id: "test-bank" },
  });
  assert.equal(first.status, 200, first.bytes.toString());
  assert.equal(first.body.downloaded, true);

  const entry = hub.state[SONG].library[first.body.entry.id];
  assert.ok(entry, "the song holds the entry");
  assert.match(entry.id, /^lib-[0-9a-f-]{36}$/, "the id is lib- plus a uuid");
  assert.ok(entry.id.length <= 40, "a library id is at most 40 characters");
  assert.equal(entry.kind, "font");
  assert.equal(entry.name, "Test Bank");
  assert.equal(entry.source, "catalog");
  assert.equal(entry.catalog_id, "test-bank");
  assert.equal(entry.sha256, sha256Of(bytes));
  assert.equal(entry.bytes, bytes.length);
  assert.equal(entry.licence, "MIT");
  assert.equal(entry.credit, "Test Bank by the test suite");
  assert.deepEqual(storedNames(crowHome), [`${sha256Of(bytes)}.sf3`]);

  // The command was Studio's own, issued as the person at the page.
  assert.equal(hub.commands.length, 1);
  assert.equal(hub.commands[0].command, "library.add");
  assert.equal(hub.commands[0].internal, true);
  assert.equal(hub.commands[0].author.kind, "human");

  // A second ask — the same song, or a second song wanting the same bank — is
  // answered from the song and the stored copy: no fetch, no second entry.
  const second = await call(gateway, "/api/studio/library/download", {
    method: "POST",
    body: { song_id: SONG, catalog_id: "test-bank" },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.downloaded, false);
  assert.equal(second.body.entry.id, first.body.entry.id);
  assert.equal(Object.keys(hub.state[SONG].library).length, 1);
  assert.equal(requests.length, 1, "the instance fetched the bank once");
});

test("an agent cannot download", async (t) => {
  const bytes = fakeBank();
  const { base, requests } = await stubServer(t, bytes);
  const row = catalogRow(base, bytes);
  const { base: gateway, hub } = await boot(t, { catalog: row });

  const agent = await call(gateway, "/api/studio/library/download", {
    method: "POST",
    body: { song_id: SONG, catalog_id: "test-bank" },
    // The MCP process presents this header; a person's page never does.
    headers: { "x-studio-token": "a".repeat(64) },
  });
  assert.equal(agent.status, 403);
  assert.equal(agent.body.error, AGENT_REFUSED);
  assert.equal(hub.commands.length, 0, "an agent's ask never reaches the song");
  assert.equal(requests.length, 0, "and never reaches the catalog");

  // A caller with no dashboard session is refused earlier still (the gateway's
  // own gate), and a session without the CSRF header is refused too.
  const noSession = await call(gateway, "/api/studio/library/download", {
    method: "POST",
    body: { song_id: SONG, catalog_id: "test-bank" },
    headers: { cookie: "" },
  });
  assert.equal(noSession.status, 403);
  const noCsrf = await call(gateway, "/api/studio/library/download", {
    method: "POST",
    body: { song_id: SONG, catalog_id: "test-bank" },
    headers: { "x-crow-csrf": "wrong" },
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(requests.length, 0);
});

test("the library route refuses another song's file", async (t) => {
  const bytes = fakeBank();
  const sha = sha256Of(bytes);
  const { base } = await stubServer(t, bytes);
  const row = catalogRow(base, bytes);

  // A file this Crow holds, named by the OTHER song's catalog entry.
  const requested = [];
  const storage = {
    defaultBucket: () => "crow-files",
    storagePrefixFor: async () => PREFIX,
    async getObject(key, options) {
      requested.push({ key, bucket: options?.bucket });
      return { stream: Readable.from([bytes]), stat: { size: bytes.length } };
    },
  };
  const otherCatalogEntry = {
    id: "lib-other-catalog",
    kind: "font",
    name: "Test Bank",
    source: "catalog",
    catalog_id: "test-bank",
    sha256: sha,
    bytes: bytes.length,
    licence: "MIT",
    credit: "Test Bank by the test suite",
  };
  const otherUpload = {
    id: "lib-other-upload",
    kind: "font",
    name: "Uploaded Bank",
    source: "upload",
    storage_key: `${PREFIX}studio/${OTHER_SONG}/library/lib-other-upload.sf2`,
    sha256: sha,
    bytes: bytes.length,
    licence: "",
    credit: "",
  };
  const { base: gateway, crowHome } = await boot(t, {
    catalog: row,
    otherLibrary: { [otherCatalogEntry.id]: otherCatalogEntry, [otherUpload.id]: otherUpload },
    storage,
  });
  // The catalog file is stored on this Crow, so a 404 below is the song's rule
  // and not a missing download.
  storeFile(crowHome, sha, bytes);

  // The other song's catalog entry, asked for through this song: not this
  // song's library entry at all.
  const catalog = await call(gateway, `/api/studio/songs/${SONG}/library/${otherCatalogEntry.id}/file`);
  assert.equal(catalog.status, 404);
  assert.equal(catalog.body.error, MISSING_INSTRUMENT);

  // The other song's upload, asked for through this song: same answer.
  const upload = await call(gateway, `/api/studio/songs/${SONG}/library/${otherUpload.id}/file`);
  assert.equal(upload.status, 404);
  assert.equal(upload.body.error, MISSING_INSTRUMENT);

  // An entry in THIS song whose storage key names the other song's directory is
  // not this song's file either, and storage is never asked for it.
  const stolen = {
    id: "lib-stolen",
    kind: "font",
    name: "Other Song's Bank",
    source: "upload",
    storage_key: `${PREFIX}studio/${OTHER_SONG}/library/lib-other-upload.sf2`,
    sha256: sha,
    bytes: bytes.length,
    licence: "",
    credit: "",
  };
  const withStolen = await boot(t, { catalog: row, library: { [stolen.id]: stolen }, storage });
  const stolenAnswer = await call(withStolen.base, `/api/studio/songs/${SONG}/library/${stolen.id}/file`);
  assert.equal(stolenAnswer.status, 404);
  assert.equal(stolenAnswer.body.error, MISSING_INSTRUMENT);
  assert.deepEqual(requested, [], "another song's key never reaches storage");

  // This song's own catalog entry, with its file stored, streams the bytes.
  const own = { ...otherCatalogEntry, id: "lib-own" };
  const ownRow = await boot(t, { catalog: row, library: { [own.id]: own }, storage });
  storeFile(ownRow.crowHome, sha, bytes);
  const streamed = await call(ownRow.base, `/api/studio/songs/${SONG}/library/${own.id}/file`);
  assert.equal(streamed.status, 200);
  assert.deepEqual(streamed.bytes, bytes);
  assert.equal(streamed.headers.get("content-type"), "application/octet-stream");
  assert.match(streamed.headers.get("cache-control"), /immutable/);

  // A catalog entry whose file was never downloaded is the "get this
  // instrument" 404, not an empty 200.
  const emptyHome = await boot(t, { catalog: row, library: { [own.id]: own }, storage });
  const missing = await call(emptyHome.base, `/api/studio/songs/${SONG}/library/${own.id}/file`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, MISSING_INSTRUMENT);
});

test("an uploaded library file streams from its own exact storage key", async (t) => {
  const bytes = fakeBank();
  const sha = sha256Of(bytes);
  const { base } = await stubServer(t, bytes);
  const requested = [];
  const storage = {
    defaultBucket: () => "crow-files",
    storagePrefixFor: async () => PREFIX,
    async getObject(key, options) {
      requested.push({ key, bucket: options?.bucket });
      return { stream: Readable.from([bytes]), stat: { size: bytes.length } };
    },
  };
  const upload = {
    id: "lib-mine",
    kind: "font",
    name: "My Bank",
    source: "upload",
    upload_id: "upload-1",
    storage_key: `${PREFIX}studio/${SONG}/library/lib-mine.sf2`,
    sha256: sha,
    bytes: bytes.length,
    licence: "",
    credit: "",
  };
  const { base: gateway } = await boot(t, { catalog: catalogRow(base, bytes), library: { [upload.id]: upload }, storage });

  const answer = await call(gateway, `/api/studio/songs/${SONG}/library/${upload.id}/file`);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.bytes, bytes);
  assert.deepEqual(requested, [{ key: upload.storage_key, bucket: "crow-files" }]);
});

test("get this instrument fetches a file this Crow lost", async (t) => {
  const bytes = fakeBank();
  const sha = sha256Of(bytes);
  const { base, requests } = await stubServer(t, bytes);
  const lost = {
    id: "lib-lost",
    kind: "font",
    name: "Test Bank",
    source: "catalog",
    catalog_id: "test-bank",
    sha256: sha,
    bytes: bytes.length,
    licence: "MIT",
    credit: "Test Bank by the test suite",
    author_label: "You",
  };
  const { base: gateway, hub, crowHome } = await boot(t, {
    catalog: catalogRow(base, bytes),
    library: { [lost.id]: lost },
  });

  // The song names the file and this Crow does not hold it: the panel's file
  // route asks for a download, and says so with "get this instrument".
  const missing = await call(gateway, `/api/studio/songs/${SONG}/library/${lost.id}/file`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, MISSING_INSTRUMENT);

  const ask = { method: "POST", body: { song_id: SONG, catalog_id: "test-bank" } };
  const again = await call(gateway, "/api/studio/library/download", ask);
  assert.equal(again.status, 200, again.bytes.toString());
  assert.equal(again.body.downloaded, true, "the file was fetched again");
  assert.equal(again.body.entry.id, lost.id, "the song keeps the entry it already has");
  assert.equal(hub.commands.length, 0, "nothing was added to the song a second time");
  assert.equal(requests.length, 1);
  assert.deepEqual(storedNames(crowHome), [`${sha}.sf3`]);

  const served = await call(gateway, `/api/studio/songs/${SONG}/library/${lost.id}/file`);
  assert.equal(served.status, 200);
  assert.deepEqual(served.bytes, bytes);

  // Bytes that no longer hash to the entry's sha256 are the same case: the file
  // is not what its name says, so it is fetched again instead of served.
  writeFileSync(join(libraryDir(crowHome), `${sha}.sf3`), Buffer.from("RIFFgone-sfbk", "ascii"));
  const repaired = await call(gateway, "/api/studio/library/download", ask);
  assert.equal(repaired.status, 200, repaired.bytes.toString());
  assert.equal(repaired.body.downloaded, true);
  assert.equal(repaired.body.entry.id, lost.id);
  assert.equal(hub.commands.length, 0, "still no second library entry");
  assert.equal(requests.length, 2);
  assert.deepEqual(readFileSync(join(libraryDir(crowHome), `${sha}.sf3`)), bytes);
});

test("the library gc keeps every file a song uses and skips a run it cannot fully see", async (t) => {
  const used = fakeBank();
  const usedSha = sha256Of(used);
  const unused = Buffer.from("RIFFunused-bank-sfbk", "ascii");
  const unusedSha = sha256Of(unused);
  const crowHome = homeFor(t);
  storeFile(crowHome, usedSha, used);
  storeFile(crowHome, unusedSha, unused);

  // The store's clock is 31 days ahead, so every file here is older than the
  // GC's 30-day limit and only the song's set can keep one alive.
  const store = createLibraryStore({ crowHome, now: () => Date.now() + 31 * 24 * 60 * 60 * 1000 });
  const hub = {
    async libraryHashes() {
      return new Set([usedSha]);
    },
  };
  const quiet = { log() {}, warn() {} };
  const gc = startLibraryGc({ hub, library: store, log: quiet });

  const first = await gc.ready;
  assert.deepEqual(first.removed, [`${unusedSha}.sf3`], "a file no song names, and old, is collected");
  assert.deepEqual(storedNames(crowHome), [`${usedSha}.sf3`], "the file a song uses is kept");

  // Put the unused file back, aged well past the limit: a pass that ran would
  // collect it. A song whose document cannot be read makes the pass skip whole.
  storeFile(crowHome, unusedSha, unused);
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  utimesSync(join(libraryDir(crowHome), `${unusedSha}.sf3`), old, old);
  hub.libraryHashes = async () => {
    throw new Error(`the song "song-9" could not be read`);
  };

  const skipped = await gc.run();
  assert.equal(skipped, null, "the run is skipped, not half-done");
  assert.deepEqual(
    storedNames(crowHome).sort(),
    [`${usedSha}.sf3`, `${unusedSha}.sf3`].sort(),
    "nothing is deleted when the run could not see every song",
  );
  gc.stop();
});

test("removing and downloading again right away works", async (t) => {
  const bytes = fakeBank();
  const { base } = await stubServer(t, bytes);
  const { base: gateway, hub } = await boot(t, { catalog: catalogRow(base, bytes) });
  const ask = { method: "POST", body: { song_id: SONG, catalog_id: "test-bank" } };

  const first = await call(gateway, "/api/studio/library/download", ask);
  assert.equal(first.status, 200, first.bytes.toString());

  // The operator removes the instrument (the song no longer names it) and asks
  // for it again immediately — inside the hub's de-duplication window.
  for (const id of Object.keys(hub.state[SONG].library)) delete hub.state[SONG].library[id];
  const second = await call(gateway, "/api/studio/library/download", ask);
  assert.equal(second.status, 200, second.bytes.toString());
  assert.equal(hub.commands.length, 2, "the second add is its own step, not a replay");
  assert.notEqual(hub.commands[0].cmd_id, hub.commands[1].cmd_id);
  // The idempotency key carries the new entry's own id.
  assert.equal(
    hub.commands[1].cmd_id,
    `library-download:${SONG}:test-bank:${second.body.entry.id}`,
  );
});

test("a reader cannot start a download", async (t) => {
  const bytes = fakeBank();
  const { base, requests } = await stubServer(t, bytes);
  const denied = Object.assign(
    new Error(`reader role on project #${PROJECT} lacks capability 'write_files'`),
    { name: "AclError", code: "missing_capability" },
  );
  const { base: gateway, hub, crowHome } = await boot(t, {
    catalog: catalogRow(base, bytes),
    canWrite: async (projectId) => {
      if (projectId === PROJECT) throw denied;
    },
  });

  const answer = await call(gateway, "/api/studio/library/download", {
    method: "POST",
    body: { song_id: SONG, catalog_id: "test-bank" },
  });
  assert.equal(answer.status, 403);
  assert.match(answer.body.error, /lacks capability 'write_files'/);
  assert.equal(requests.length, 0, "a refused caller fetches nothing");
  assert.equal(hub.commands.length, 0, "and nothing reaches the song");
  assert.deepEqual(storedNames(crowHome), []);
});

test("a stalled download is abandoned, and a download that never finishes answers 504", async (t) => {
  const bytes = fakeBank();
  const stalled = await stubServer(t, bytes, { stall: true });
  const serving = await stubServer(t, bytes);
  const crowHome = homeFor(t);
  // Two urls: the first stalls, the second serves the same bytes.
  const catalogPath = catalogAt(
    crowHome,
    catalogRow(serving.base, bytes, {
      urls: [`${stalled.base}/Test_Bank.sf3`, `${serving.base}/Test_Bank.sf3`],
    }),
  );

  const stored = await downloadCatalogEntry("test-bank", {
    crowHome,
    catalogPath,
    idleMs: 120,
    deadlineMs: 5000,
  });
  assert.equal(stored.fetched, true);
  assert.equal(stalled.requests.length, 1, "the stalled url was tried");
  assert.equal(serving.requests.length, 1, "and the next one finished the download");
  assert.deepEqual(readFileSync(stored.path), bytes, "no partial file survived the stall");
  assert.deepEqual(storedNames(crowHome), [`${sha256Of(bytes)}.sf3`]);

  // Only a stalling url: the transfer runs out of time and says so, in 504.
  const only = homeFor(t);
  const onlyCatalog = catalogAt(only, catalogRow(stalled.base, bytes));
  const before = stalled.requests.length;
  await assert.rejects(
    () => downloadCatalogEntry("test-bank", { crowHome: only, catalogPath: onlyCatalog, idleMs: 120, deadlineMs: 5000 }),
    (err) => err.status === 504 && err.message === DOWNLOAD_TIMEOUT_TEXT,
  );
  assert.ok(stalled.requests.length > before, "the row's only url was tried");
  assert.deepEqual(storedNames(only), [], "a timed-out download keeps nothing, temporary or final");
});

test("a redirect to another host is refused", async (t) => {
  const bytes = fakeBank();
  const elsewhere = await stubServer(t, bytes);

  // A redirect to another host (and not https): refused, and that host is never
  // asked for anything.
  const crossHost = await stubServer(t, bytes, { location: `${elsewhere.base}/Test_Bank.sf3` });
  const crowHome = homeFor(t);
  await assert.rejects(
    () => downloadCatalogEntry("test-bank", { crowHome, catalogPath: catalogAt(crowHome, catalogRow(crossHost.base, bytes)) }),
    (err) => err.status === 502 && /redirected/.test(err.message),
  );
  assert.equal(elsewhere.requests.length, 0, "the other host was never fetched");
  assert.deepEqual(storedNames(crowHome), []);

  // An https redirect is still refused when the host is not one the catalog row
  // names, so the scheme alone is not what decides.
  const httpsAway = await stubServer(t, bytes, { location: "https://elsewhere.invalid/Test_Bank.sf3" });
  const second = homeFor(t);
  await assert.rejects(
    () => downloadCatalogEntry("test-bank", { crowHome: second, catalogPath: catalogAt(second, catalogRow(httpsAway.base, bytes)) }),
    (err) => err.status === 502 && /redirected/.test(err.message),
  );
  assert.deepEqual(storedNames(second), []);
});