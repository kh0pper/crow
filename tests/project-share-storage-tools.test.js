/**
 * Project shares on the storage server (Phase 1): a bot's file tools follow its home project and
 * the projects it holds a share of, every by-id file lookup resolves through the key's own
 * `storage_files` row and answers a row it may not see exactly the way it answers a missing key,
 * presigned URLs last at most 5 minutes for a bot, and the owner / unknown caller behaves as
 * before.
 *
 * No network: the S3 seam (`createStorageServer(dbPath, { s3 })`) is an in-memory fake.
 * Scratch CROW_HOME + data dir, a real crow.db from scripts/init-db.js. Nothing here touches
 * ~/.crow.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "share-storage-"));
const DATA = join(dir, "data");
const HOME = join(dir, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
// The background tools talk to an image service; nothing listens on port 1, so a call that gets
// past the share gate fails at the network and never waits.
process.env.SDXL_SERVICE_URL = "http://127.0.0.1:1";

const REPO = join(import.meta.dirname, "..");
const DB_FILE = join(DATA, "crow.db");

let db = null;
let createStorageServer = null;
let Client = null;
let InMemoryTransport = null;
let S = null;
let OWNER = null;
let UNKNOWN = null;
let createProjectSpace = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient(DB_FILE);
  ({ createStorageServer } = await import("../servers/storage/server.js"));
  ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
  ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));
  S = await import("../servers/shared/project-share-scope.js");
  ({ OWNER, UNKNOWN } = await import("../servers/research/actor.js"));
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

// --- harness ---------------------------------------------------------------------------------

/** An in-memory S3 backend: records every call, never leaves the process. */
function fakeS3(overrides = {}) {
  const calls = { upload: [], presign: [], put: [], delete: [], stats: [] };
  const fake = {
    calls,
    isAvailable: async () => true,
    uploadObject: async (key, data, opts) => { calls.upload.push({ key, size: data.length, opts }); },
    getPresignedUrl: async (key, opts) => {
      calls.presign.push({ key, opts });
      const expiry = opts && opts.expiry != null ? opts.expiry : "default";
      return `https://files.invalid/${key}?expires=${expiry}`;
    },
    getPresignedUploadUrl: async (key, opts) => {
      calls.put.push({ key, opts });
      const expiry = opts && opts.expiry != null ? opts.expiry : "default";
      return `https://files.invalid/put/${key}?expires=${expiry}`;
    },
    deleteObject: async (key, bucket) => { calls.delete.push({ key, bucket }); },
    getBucketStats: async (bucket) => {
      calls.stats.push({ bucket });
      return { fileCount: 4242, totalSizeBytes: 3 * 1024 * 1024 * 1024 };
    },
  };
  for (const [name, fn] of Object.entries(overrides)) fake[name] = fn;
  return fake;
}

/** A storage server wired to an in-process client, with a fake S3 backend. */
async function open({ actor, s3 } = {}) {
  const server = createStorageServer(DB_FILE, { baseActor: actor, s3: s3 || fakeS3() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport)]);
  const client = new Client({ name: "share-storage", version: "0" });
  await client.connect(clientTransport);
  return {
    client,
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { text, isError: !!r.isError };
    },
    async close() {
      try { await client.close(); } catch {}
      try { await server.close(); } catch {}
    },
  };
}

const rows = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const count = async (sql, args = []) => Number((await rows(sql, args))[0].n);

// --- fixtures --------------------------------------------------------------------------------

let projectSeq = 0;
async function mkProject(name) {
  const r = await createProjectSpace(db, { name: name || `Storage share project ${++projectSeq}` });
  return Number(r.id);
}

let botSeq = 0;
async function mkBot({ home = null } = {}) {
  botSeq += 1;
  const botId = `storage-share-bot-${botSeq}`;
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
    args: [botId, `Bot ${botSeq}`, "{}", home],
  });
  return botId;
}

async function grant(projectId, botId, level = "read_write") {
  await db.execute({
    sql: "INSERT INTO project_bot_shares (project_id, bot_id, level) VALUES (?,?,?)",
    args: [Number(projectId), botId, level],
  });
}

async function revoke(projectId, botId) {
  await db.execute({
    sql: "UPDATE project_bot_shares SET revoked_at = datetime('now') WHERE project_id = ? AND bot_id = ? AND revoked_at IS NULL",
    args: [Number(projectId), botId],
  });
}

let keySeq = 0;
/** A key no other test uses, so a listing assertion only ever sees this test's rows. */
const uniqueKey = (label) => `sharetest-${++keySeq}-${label}.txt`;

async function seedFile(key, { projectId = null, bucket = "crow-files", size = 1024 } = {}) {
  await db.execute({
    sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, project_id)
          VALUES (?, ?, 'text/plain', ?, ?, ?)`,
    args: [key, key, size, bucket, projectId == null ? null : Number(projectId)],
  });
}

const fileRow = async (key) => (await rows("SELECT * FROM storage_files WHERE s3_key = ?", [key]))[0] ?? null;

async function seedSource(title, projectId) {
  const r = await db.execute({
    sql: "INSERT INTO research_sources (title, source_type, citation_apa, project_id) VALUES (?, 'web_article', ?, ?)",
    args: [title, title, projectId == null ? null : Number(projectId)],
  });
  return Number(r.lastInsertRowid);
}

async function seedNote(title, projectId) {
  const r = await db.execute({
    sql: "INSERT INTO research_notes (title, content, project_id) VALUES (?, ?, ?)",
    args: [title, `${title} body`, projectId == null ? null : Number(projectId)],
  });
  return Number(r.lastInsertRowid);
}

const base64 = (text) => Buffer.from(text).toString("base64");

async function storagePrefix(projectId) {
  return (await rows("SELECT storage_prefix FROM project_spaces WHERE id = ?", [Number(projectId)]))[0].storage_prefix;
}

// --- uploads --------------------------------------------------------------------------------

test("a bot with no share cannot upload into another project, and nothing is stored", async () => {
  const home = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home });
  const s3 = fakeS3();
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  try {
    const before = await count("SELECT COUNT(*) AS n FROM storage_files");
    const r = await s.call("crow_upload_file", {
      file_name: "refused.txt", mime_type: "text/plain", data_base64: base64("nope"), project_id: B,
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /No share grants this bot access to that project/);
    assert.equal(await count("SELECT COUNT(*) AS n FROM storage_files"), before, "no row was recorded");
    assert.equal(s3.calls.upload.length, 0, "nothing was written to storage");
  } finally { await s.close(); }
});

test("a refusal needs no storage backend: the share gate runs before the availability probe", async () => {
  const home = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home });
  let probes = 0;
  const s3 = fakeS3({ isAvailable: async () => { probes += 1; return false; } });
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  try {
    const refused = await s.call("crow_upload_file", {
      file_name: "a.txt", mime_type: "text/plain", data_base64: base64("a"), project_id: B,
    });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /No share grants/);
    assert.equal(probes, 0, "the gate answered before the probe");

    // An unverified bot is refused a by-id file tool the same way.
    const unverified = await open({ actor: { kind: "bot", id: null, unverified: true }, s3 });
    try {
      const r = await unverified.call("crow_get_file_url", { s3_key: uniqueKey("unverified") });
      assert.equal(r.isError, true);
      assert.equal(r.text, `Error: ${S.NOT_FOUND_MESSAGE}`);
    } finally { await unverified.close(); }
    assert.equal(probes, 0, "still no probe");
  } finally { await s.close(); }
});

// --- listing --------------------------------------------------------------------------------

test("list_files takes an optional project_id filter, and the owner's unfiltered listing is unchanged", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const inA = uniqueKey("owner-a");
  const inB = uniqueKey("owner-b");
  const loose = uniqueKey("owner-loose");
  await seedFile(inA, { projectId: A });
  await seedFile(inB, { projectId: B });
  await seedFile(loose);
  const owner = await open({ actor: OWNER });
  try {
    const all = await owner.call("crow_list_files", { limit: 100 });
    assert.equal(all.isError, false, all.text);
    for (const key of [inA, inB, loose]) assert.ok(all.text.includes(key), `the owner sees ${key}`);

    const filtered = await owner.call("crow_list_files", { project_id: B, limit: 100 });
    assert.ok(filtered.text.includes(inB), filtered.text);
    assert.ok(!filtered.text.includes(inA), "another project's file is filtered out");
    assert.ok(!filtered.text.includes(loose), "a project-less file is filtered out");
  } finally { await owner.close(); }
});

test("a bot's listing with no project is its home project only; a shared project is listed by name", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const hidden = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read");
  const homeKey = uniqueKey("bot-home");
  const sharedKey = uniqueKey("bot-shared");
  const hiddenKey = uniqueKey("bot-hidden");
  const looseKey = uniqueKey("bot-loose");
  await seedFile(homeKey, { projectId: A });
  await seedFile(sharedKey, { projectId: B });
  await seedFile(hiddenKey, { projectId: hidden });
  await seedFile(looseKey);
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const mine = await s.call("crow_list_files", { limit: 100 });
    assert.equal(mine.isError, false, mine.text);
    assert.ok(mine.text.includes(homeKey), mine.text);
    assert.ok(!mine.text.includes(sharedKey), "a share of B does not widen an omitted project");
    assert.ok(!mine.text.includes(hiddenKey), "another project's key is never listed");
    assert.ok(!mine.text.includes(looseKey), "project-less files are the owner's");

    const shared = await s.call("crow_list_files", { project_id: B, limit: 100 });
    assert.equal(shared.isError, false, shared.text);
    assert.ok(shared.text.includes(sharedKey), shared.text);
    assert.ok(!shared.text.includes(homeKey), "the shared project's listing is not merged with home");

    const refused = await s.call("crow_list_files", { project_id: hidden });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /No share grants this bot access to that project/);
  } finally { await s.close(); }
});

// --- by-id: get_file_url --------------------------------------------------------------------

test("get_file_url resolves the key's own row: unknown, project-less and unreachable keys read the same", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const hidden = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read");
  const homeKey = uniqueKey("url-home");
  const sharedKey = uniqueKey("url-shared");
  const hiddenKey = uniqueKey("url-hidden");
  const looseKey = uniqueKey("url-loose");
  await seedFile(homeKey, { projectId: A });
  await seedFile(sharedKey, { projectId: B });
  await seedFile(hiddenKey, { projectId: hidden });
  await seedFile(looseKey);
  const s3 = fakeS3();
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  try {
    const missing = await s.call("crow_get_file_url", { s3_key: uniqueKey("url-missing") });
    assert.equal(missing.isError, true);
    assert.equal(missing.text, `Error: ${S.NOT_FOUND_MESSAGE}`);

    for (const key of [hiddenKey, looseKey]) {
      const r = await s.call("crow_get_file_url", { s3_key: key });
      assert.equal(r.isError, true, key);
      assert.equal(r.text, missing.text, `${key} is indistinguishable from a missing key`);
    }
    assert.equal(s3.calls.presign.length, 0, "no URL was minted for a row the bot may not see");

    for (const key of [homeKey, sharedKey]) {
      const r = await s.call("crow_get_file_url", { s3_key: key });
      assert.equal(r.isError, false, `${key}: ${r.text}`);
      assert.ok(r.text.includes(key));
    }

    // A bucket argument that is not the row's bucket is refused like a missing key.
    const wrongBucket = await s.call("crow_get_file_url", { s3_key: sharedKey, bucket: "some-other-bucket" });
    assert.equal(wrongBucket.isError, true);
    assert.equal(wrongBucket.text, missing.text);
  } finally { await s.close(); }
});

test("a bot's presigned expiry is capped at 300 s and the message says 5 minutes; the owner's range is unchanged", async () => {
  const A = await mkProject();
  const bot = await mkBot({ home: A });
  const key = uniqueKey("expiry");
  await seedFile(key, { projectId: A });
  const s3 = fakeS3();
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  const ownerS3 = fakeS3();
  const owner = await open({ actor: OWNER, s3: ownerS3 });
  try {
    const wanted = await s.call("crow_get_file_url", { s3_key: key, expiry: 86400 });
    assert.equal(wanted.isError, false, wanted.text);
    assert.equal(s3.calls.presign.at(-1).opts.expiry, 300, "a day-long request is capped");
    assert.match(wanted.text, /expires in 5 min/);

    const asRequested = await s.call("crow_get_file_url", { s3_key: key, expiry: 120 });
    assert.equal(s3.calls.presign.at(-1).opts.expiry, 120, "a shorter request is honored");

    const mine = await owner.call("crow_get_file_url", { s3_key: uniqueKey("owner-expiry"), expiry: 86400 });
    assert.equal(mine.isError, false, mine.text);
    assert.equal(ownerS3.calls.presign.at(-1).opts.expiry, 86400, "the owner's range is unchanged");
    assert.match(mine.text, /expires in 1440 min/);
  } finally { await s.close(); await owner.close(); }
});

// --- by-id: delete_file ---------------------------------------------------------------------

test("delete_file answers an unreachable key like a missing one, on the preview and on the confirm", async () => {
  const A = await mkProject();
  const hidden = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read");
  const hiddenKey = uniqueKey("del-hidden");
  const looseKey = uniqueKey("del-loose");
  const readOnlyKey = uniqueKey("del-readonly");
  await seedFile(hiddenKey, { projectId: hidden });
  await seedFile(looseKey);
  await seedFile(readOnlyKey, { projectId: B });
  const s3 = fakeS3();
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  try {
    const missing = await s.call("crow_delete_file", { s3_key: uniqueKey("del-missing"), confirm_token: "" });
    assert.equal(missing.isError, true);
    assert.equal(missing.text, `Error: ${S.NOT_FOUND_MESSAGE}`);
    for (const key of [hiddenKey, looseKey, readOnlyKey]) {
      const r = await s.call("crow_delete_file", { s3_key: key, confirm_token: "" });
      assert.equal(r.isError, true, key);
      assert.equal(r.text, missing.text, key);
    }
    assert.equal(s3.calls.delete.length, 0);
    for (const key of [hiddenKey, looseKey, readOnlyKey]) assert.ok(await fileRow(key), `${key} survives`);
  } finally { await s.close(); }
});

test("a file previewed before a revoke cannot be confirmed after it, and the file remains", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read_write");
  const key = uniqueKey("del-two-call");
  await seedFile(key, { projectId: B });
  const s3 = fakeS3();
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  try {
    const preview = await s.call("crow_delete_file", { s3_key: key, confirm_token: "" });
    assert.equal(preview.isError, false, preview.text);
    const token = /confirm_token: "([^"]+)"/.exec(preview.text)[1];
    assert.ok(token);

    await revoke(B, bot);

    const confirmed = await s.call("crow_delete_file", { s3_key: key, confirm_token: token });
    assert.equal(confirmed.isError, true);
    assert.equal(confirmed.text, `Error: ${S.NOT_FOUND_MESSAGE}`);
    assert.ok(await fileRow(key), "the row remains");
    assert.equal(s3.calls.delete.length, 0, "the object was not deleted");
  } finally { await s.close(); }
});

test("the share gate runs even when confirmation gates are skipped", async () => {
  const A = await mkProject();
  const hidden = await mkProject();
  const bot = await mkBot({ home: A });
  const key = uniqueKey("del-skip-gates");
  await seedFile(key, { projectId: hidden });
  const s3 = fakeS3();
  const saved = process.env.CROW_SKIP_CONFIRM_GATES;
  process.env.CROW_SKIP_CONFIRM_GATES = "1";
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  try {
    const r = await s.call("crow_delete_file", { s3_key: key, confirm_token: "" });
    assert.equal(r.isError, true);
    assert.equal(r.text, `Error: ${S.NOT_FOUND_MESSAGE}`);
    assert.equal(s3.calls.delete.length, 0);
    assert.ok(await fileRow(key), "the row remains");
  } finally {
    await s.close();
    if (saved === undefined) delete process.env.CROW_SKIP_CONFIRM_GATES;
    else process.env.CROW_SKIP_CONFIRM_GATES = saved;
  }
});

// --- a read share vs a write share ----------------------------------------------------------

test("a read share refuses upload and delete on that project, and the row survives", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read");
  const key = uniqueKey("read-only-target");
  await seedFile(key, { projectId: B });
  const s3 = fakeS3();
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  try {
    const uploaded = await s.call("crow_upload_file", {
      file_name: "x.txt", mime_type: "text/plain", data_base64: base64("x"), project_id: B,
    });
    assert.equal(uploaded.isError, true);
    assert.match(uploaded.text, /read-only/);
    assert.equal(s3.calls.upload.length, 0);

    const deleted = await s.call("crow_delete_file", { s3_key: key, confirm_token: "" });
    assert.equal(deleted.isError, true);
    assert.equal(deleted.text, `Error: ${S.NOT_FOUND_MESSAGE}`);
    assert.ok(await fileRow(key));
  } finally { await s.close(); }
});

test("a read_write share uploads under the project's storage prefix and audits the bot", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read_write");
  const prefix = await storagePrefix(B);
  const s3 = fakeS3();
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  try {
    const r = await s.call("crow_upload_file", {
      file_name: "report.txt", mime_type: "text/plain", data_base64: base64("hello"), project_id: B,
    });
    assert.equal(r.isError, false, r.text);
    const key = /Key: (\S+)/.exec(r.text)[1];
    assert.ok(key.startsWith(prefix), `${key} sits under ${prefix}`);
    const row = await fileRow(key);
    assert.equal(Number(row.project_id), B);
    assert.equal(Number(row.size_bytes), 5);

    const audits = await rows(
      "SELECT actor_type, actor_id, action FROM project_audit_log WHERE project_id = ? AND action = 'file.upload'",
      [B],
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_type, "bot");
    assert.equal(audits[0].actor_id, bot);

    // The presigning path audits the same way.
    const presign = await s.call("crow_upload_file", { file_name: "big.txt", mime_type: "text/plain", project_id: B });
    assert.equal(presign.isError, false, presign.text);
    const presignAudits = await rows(
      "SELECT actor_type, actor_id FROM project_audit_log WHERE project_id = ? AND action = 'file.upload.presign'",
      [B],
    );
    assert.equal(presignAudits.length, 1);
    assert.equal(presignAudits[0].actor_type, "bot");
    assert.equal(presignAudits[0].actor_id, bot);
  } finally { await s.close(); }
});

test("a bot's write with no project lands in its home project; with no home project it is refused", async () => {
  const home = await mkProject();
  const bot = await mkBot({ home });
  const homeless = await mkBot({});
  const prefix = await storagePrefix(home);
  const s3 = fakeS3();
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  const h = await open({ actor: { kind: "bot", id: homeless }, s3: fakeS3() });
  try {
    const r = await s.call("crow_upload_file", {
      file_name: "home.txt", mime_type: "text/plain", data_base64: base64("home"),
    });
    assert.equal(r.isError, false, r.text);
    const key = /Key: (\S+)/.exec(r.text)[1];
    assert.ok(key.startsWith(prefix));
    assert.equal(Number((await fileRow(key)).project_id), home);

    const before = await count("SELECT COUNT(*) AS n FROM storage_files");
    const refused = await h.call("crow_upload_file", {
      file_name: "nope.txt", mime_type: "text/plain", data_base64: base64("nope"),
    });
    assert.equal(refused.isError, true);
    assert.equal(refused.text, `Error: ${S.NAME_A_PROJECT_MESSAGE}`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM storage_files"), before, "nothing was recorded");
  } finally { await s.close(); await h.close(); }
});

// --- upload URLs ----------------------------------------------------------------------------

test("the URLs crow_upload_file returns are capped at 300 s for a bot, and a bucket override is refused", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read_write");
  const s3 = fakeS3();
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  try {
    const small = await s.call("crow_upload_file", {
      file_name: "small.txt", mime_type: "text/plain", data_base64: base64("s"), project_id: B,
    });
    assert.equal(small.isError, false, small.text);
    assert.equal(s3.calls.presign.at(-1).opts.expiry, 300, "the download URL is capped");
    assert.match(small.text, /Download URL \(5 min\)/);

    const large = await s.call("crow_upload_file", { file_name: "large.txt", mime_type: "text/plain", project_id: B });
    assert.equal(large.isError, false, large.text);
    assert.equal(s3.calls.put.at(-1).opts.expiry, 300, "the upload URL is capped");
    assert.match(large.text, /Expires in 5 minutes/);

    const uploads = s3.calls.upload.length;
    const put = s3.calls.put.length;
    const override = await s.call("crow_upload_file", {
      file_name: "elsewhere.txt", mime_type: "text/plain", data_base64: base64("e"), project_id: B, bucket: "another-bucket",
    });
    assert.equal(override.isError, true);
    assert.match(override.text, /bucket/i);
    assert.equal(s3.calls.upload.length, uploads, "nothing was written");
    assert.equal(s3.calls.put.length, put);

    // An omitted project: the same caps for an upload into the home project.
    const homeless = await s.call("crow_upload_file", { file_name: "h.txt", mime_type: "text/plain" });
    assert.equal(homeless.isError, false, homeless.text);
    assert.equal(s3.calls.put.at(-1).opts.expiry, 300);
  } finally { await s.close(); }
});

test("the owner's upload keeps its 1-hour URLs and may choose a bucket", async () => {
  const A = await mkProject();
  const s3 = fakeS3();
  const owner = await open({ actor: OWNER, s3 });
  try {
    const small = await owner.call("crow_upload_file", {
      file_name: "owner.txt", mime_type: "text/plain", data_base64: base64("o"), project_id: A,
    });
    assert.equal(small.isError, false, small.text);
    assert.equal(s3.calls.presign.at(-1).opts.expiry, undefined, "the client's own default");
    assert.match(small.text, /Download URL \(1hr\)/);

    const large = await owner.call("crow_upload_file", { file_name: "owner-big.txt", mime_type: "text/plain", project_id: A });
    assert.equal(large.isError, false, large.text);
    assert.equal(s3.calls.put.at(-1).opts.expiry, undefined);
    assert.match(large.text, /Expires in 1 hour/);

    const elsewhere = await owner.call("crow_upload_file", {
      file_name: "bucket.txt", mime_type: "text/plain", data_base64: base64("b"), bucket: "another-bucket",
    });
    assert.equal(elsewhere.isError, false, elsewhere.text);
    assert.equal((await fileRow(/Key: (\S+)/.exec(elsewhere.text)[1])).bucket, "another-bucket");
  } finally { await owner.close(); }
});

// --- references ------------------------------------------------------------------------------

test("a bot's reference errors all read as the not-found text; the owner's messages are unchanged", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  const botPrefix = await storagePrefix(A);
  const sourceInB = await seedSource("Reference in another project", B);
  const looseSource = await seedSource("Reference with no project", null);
  const noteInB = await seedNote("Note in another project", B);
  const s = await open({ actor: { kind: "bot", id: bot }, s3: fakeS3() });
  const owner = await open({ actor: OWNER, s3: fakeS3() });
  try {
    const attempts = [
      { reference_type: "research_source", reference_id: sourceInB },
      { reference_type: "research_source", reference_id: looseSource },
      { reference_type: "research_note", reference_id: noteInB },
      { reference_type: "research_source", reference_id: 987654321 },
    ];
    for (const ref of attempts) {
      const r = await s.call("crow_upload_file", {
        file_name: "ref.txt", mime_type: "text/plain", data_base64: base64("r"), ...ref,
      });
      assert.equal(r.isError, true, JSON.stringify(ref));
      assert.equal(r.text, `Error: ${S.NOT_FOUND_MESSAGE}`, JSON.stringify(ref));
      assert.doesNotMatch(r.text, /project #/, "a bot never learns which project a reference lives in");
    }
    const stored = await count("SELECT COUNT(*) AS n FROM storage_files WHERE s3_key LIKE ?", [`${botPrefix}%`]);
    assert.equal(stored, 0, "nothing was uploaded for any refused reference");

    const missing = await owner.call("crow_upload_file", {
      file_name: "ref.txt", mime_type: "text/plain", data_base64: base64("r"),
      project_id: A, reference_type: "research_source", reference_id: 987654321,
    });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Referenced research_source:987654321 does not exist/);

    const mismatch = await owner.call("crow_upload_file", {
      file_name: "ref.txt", mime_type: "text/plain", data_base64: base64("r"),
      project_id: A, reference_type: "research_source", reference_id: sourceInB,
    });
    assert.equal(mismatch.isError, true);
    assert.match(mismatch.text, new RegExp(`belongs to project #${B}, not #${A}`));

    // The owner may still attach a file to a project-less reference: today's behaviour.
    const loose = await owner.call("crow_upload_file", {
      file_name: "ref.txt", mime_type: "text/plain", data_base64: base64("r"),
      project_id: A, reference_type: "research_source", reference_id: looseSource,
    });
    assert.equal(loose.isError, false, loose.text);
  } finally { await s.close(); await owner.close(); }
});

// --- stats -----------------------------------------------------------------------------------

test("storage_stats for a bot counts its home project's rows, never the bucket-wide numbers", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read_write");
  await seedFile(uniqueKey("stats-home-1"), { projectId: A, size: 1024 * 1024 });
  await seedFile(uniqueKey("stats-home-2"), { projectId: A, size: 1024 * 1024 });
  await seedFile(uniqueKey("stats-shared"), { projectId: B, size: 1024 * 1024 });
  await seedFile(uniqueKey("stats-loose"), { size: 1024 * 1024 });
  const s3 = fakeS3();
  const s = await open({ actor: { kind: "bot", id: bot }, s3 });
  const ownerS3 = fakeS3();
  const owner = await open({ actor: OWNER, s3: ownerS3 });
  try {
    const mine = await s.call("crow_storage_stats", {});
    assert.equal(mine.isError, false, mine.text);
    assert.match(mine.text, /Files: 2/);
    assert.match(mine.text, /Used: 2\.0MB/);
    assert.doesNotMatch(mine.text, /4242/, "the bucket-wide file count is not the bot's");
    assert.doesNotMatch(mine.text, /3072\.0MB/, "the bucket-wide size is not the bot's");

    const theirs = await owner.call("crow_storage_stats", {});
    assert.equal(theirs.isError, false, theirs.text);
    assert.match(theirs.text, /Files in bucket: 4242/);
    assert.match(theirs.text, /Used: 3072\.0MB/);
  } finally { await s.close(); await owner.close(); }
});

// --- the operator's voice bot and an unidentified caller ------------------------------------

for (const [label, actorOf] of [
  ["the operator's voice bot", () => S.operatorVoiceActor()],
  ["an unidentified caller", () => UNKNOWN],
]) {
  test(`${label} keeps the owner's storage behaviour`, async () => {
    const A = await mkProject();
    const B = await mkProject();
    const hidden = await mkProject();
    const prefix = await storagePrefix(B);
    const hiddenKey = uniqueKey("owner-like-hidden");
    const looseKey = uniqueKey("owner-like-loose");
    await seedFile(hiddenKey, { projectId: hidden });
    await seedFile(looseKey);
    const s3 = fakeS3();
    const s = await open({ actor: actorOf(), s3 });
    try {
      // Project-less and other projects' keys are reachable, and a bucket override is honored.
      for (const key of [hiddenKey, looseKey]) {
        const r = await s.call("crow_get_file_url", { s3_key: key, expiry: 86400 });
        assert.equal(r.isError, false, `${key}: ${r.text}`);
        assert.equal(s3.calls.presign.at(-1).opts.expiry, 86400, "no cap");
        assert.match(r.text, /expires in 1440 min/);
      }
      const otherBucket = await s.call("crow_get_file_url", { s3_key: hiddenKey, bucket: "another-bucket" });
      assert.equal(otherBucket.isError, false, otherBucket.text);

      const list = await s.call("crow_list_files", { limit: 100 });
      for (const key of [hiddenKey, looseKey]) assert.ok(list.text.includes(key), `${key} is listed`);

      const uploaded = await s.call("crow_upload_file", {
        file_name: "like-owner.txt", mime_type: "text/plain", data_base64: base64("o"), project_id: B,
      });
      assert.equal(uploaded.isError, false, uploaded.text);
      const key = /Key: (\S+)/.exec(uploaded.text)[1];
      assert.ok(key.startsWith(prefix), "an upload into a named project keeps its prefix");
      assert.equal(s3.calls.presign.at(-1).opts.expiry, undefined);

      const loosed = await s.call("crow_upload_file", {
        file_name: "loose.txt", mime_type: "text/plain", data_base64: base64("l"),
      });
      assert.equal(loosed.isError, false, loosed.text);
      assert.equal((await fileRow(/Key: (\S+)/.exec(loosed.text)[1])).project_id, null,
        "no project stays project-less");

      const deleted = await s.call("crow_delete_file", { s3_key: hiddenKey, confirm_token: "" });
      assert.equal(deleted.isError, false, deleted.text);
      const token = /confirm_token: "([^"]+)"/.exec(deleted.text)[1];
      const confirmed = await s.call("crow_delete_file", { s3_key: hiddenKey, confirm_token: token });
      assert.equal(confirmed.isError, false, confirmed.text);
      assert.equal(s3.calls.delete.at(-1).key, hiddenKey);

      const stats = await s.call("crow_storage_stats", {});
      assert.match(stats.text, /Files in bucket: 4242/);
    } finally { await s.close(); }
  });
}

// --- the background tools stay neutral, but not for an unverified bot -------------------------

test("the background tools refuse an unverified bot and let a normal bot through", async () => {
  const A = await mkProject();
  const bot = await mkBot({ home: A });
  const calls = [
    ["crow_generate_background", { prompt: "a quiet library" }],
    ["crow_list_backgrounds", {}],
    ["crow_set_background", { name: "one.png" }],
  ];
  const unverified = await open({ actor: { kind: "bot", id: null, unverified: true } });
  const normal = await open({ actor: { kind: "bot", id: bot } });
  try {
    for (const [tool, args] of calls) {
      const refused = await unverified.call(tool, args);
      assert.equal(refused.isError, true, tool);
      assert.match(refused.text, /That tool is for the operator only/, tool);

      const allowed = await normal.call(tool, args);
      assert.doesNotMatch(allowed.text, /That tool is for the operator only/, tool);
    }
  } finally { await unverified.close(); await normal.close(); }
});