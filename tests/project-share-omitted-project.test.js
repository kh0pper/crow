/**
 * Gated reads whose `project_id` is omitted: the HANDLER applies the caller's own scope, so a
 * listing can never come back unfiltered just because the share gate let the call through.
 *
 * Scratch CROW_HOME + data dir, a real crow.db from scripts/init-db.js. Nothing here touches ~/.crow.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "share-omitted-"));
const DATA = join(dir, "data");
const HOME = join(dir, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.CROW_HOME = join(dir, "crow");
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const DB_FILE = join(DATA, "crow.db");

let db = null;
let createDbClient = null;
let S = null;
let OWNER = null;
let createProjectServer = null;
let createProjectSpace = null;
let Client = null;
let InMemoryTransport = null;

let A = null;
let B = null;

const BOT_HOME_A = "omitted-bot-home-a";
const BOT_HOMELESS = "omitted-bot-homeless";

const ALPHA_BACKEND = "Alpha Backend";
const BRAVO_BACKEND = "Bravo Backend";

const text = (r) => (r.content || []).map((c) => c.text).join("\n");

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  ({ createDbClient } = await import("../servers/db.js"));
  db = createDbClient(DB_FILE);
  S = await import("../servers/shared/project-share-scope.js");
  ({ OWNER } = await import("../servers/research/actor.js"));
  ({ createProjectServer } = await import("../servers/research/server.js"));
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));
  Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client;
  ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));

  // Constructing one server readies the columns this file inserts into.
  createProjectServer(DB_FILE, { actor: OWNER }).close();

  A = Number((await createProjectSpace(db, { name: "Omitted Alpha", description: "alpha" })).id);
  B = Number((await createProjectSpace(db, { name: "Omitted Bravo", description: "bravo" })).id);

  const mkBackend = async (projectId, name) => Number((await db.execute({
    sql: `INSERT INTO data_backends (project_id, name, backend_type, connection_ref, status)
          VALUES (?, ?, 'sqlite', ?, 'connected')`,
    args: [projectId, name, JSON.stringify({ path: `/tmp/${name.replace(/\s+/g, "-").toLowerCase()}.db` })],
  })).lastInsertRowid);
  await mkBackend(A, ALPHA_BACKEND);
  await mkBackend(B, BRAVO_BACKEND);

  for (const [botId, home] of [[BOT_HOME_A, A], [BOT_HOMELESS, null]]) {
    await db.execute({
      sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
      args: [botId, botId, "{}", home],
    });
  }
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function clientFor(actor) {
  const server = createProjectServer(DB_FILE, { actor });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "share-omitted-project-test", version: "0" });
  await client.connect(ct);
  return client;
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

const sees = (r, name) => text(r).includes(name);
// A refused call and an empty listing both mean "none of that project's rows", which is the
// contract here: the handler may never hand back an unfiltered listing.
const showsNothing = (r, name) => (r.isError ? true : !sees(r, name));

test("crow_list_backends with no project_id: a bot with no home project sees no backend", async () => {
  const bot = await clientFor({ kind: "bot", id: BOT_HOMELESS });
  const r = await call(bot, "crow_list_backends", {});
  assert.ok(showsNothing(r, ALPHA_BACKEND), text(r));
  assert.ok(showsNothing(r, BRAVO_BACKEND), text(r));
});

test("crow_list_backends with no project_id: a bot sees its home project's backend only", async () => {
  const bot = await clientFor({ kind: "bot", id: BOT_HOME_A });
  const r = await call(bot, "crow_list_backends", {});
  assert.ok(!r.isError, text(r));
  assert.ok(sees(r, ALPHA_BACKEND), text(r));
  assert.ok(!sees(r, BRAVO_BACKEND), text(r));
});

test("crow_list_backends with no project_id: the owner sees every project's backend", async () => {
  const owner = await clientFor(OWNER);
  const r = await call(owner, "crow_list_backends", {});
  assert.ok(!r.isError, text(r));
  assert.ok(sees(r, ALPHA_BACKEND), text(r));
  assert.ok(sees(r, BRAVO_BACKEND), text(r));
});

test("crow_list_backends with no project_id: the operator's voice bot sees every project's backend", async () => {
  const voice = await clientFor(S.operatorVoiceActor());
  const r = await call(voice, "crow_list_backends", {});
  assert.ok(!r.isError, text(r));
  assert.ok(sees(r, ALPHA_BACKEND), text(r));
  assert.ok(sees(r, BRAVO_BACKEND), text(r));

  const owner = await clientFor(OWNER);
  assert.equal(text(r), text(await call(owner, "crow_list_backends", {})), "voice and owner listings match");
});