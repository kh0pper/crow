/**
 * Task 4: the single path-scoped token factory (pathScopedToken) and its two
 * instances. A family token lives at <crowHome>/secrets/<name>-token (0600),
 * rotates atomically, and is accepted by its own validate() and nothing else.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  pathScopedToken, SERVICES_TOKEN, SATELLITE_TOOLS_TOKEN,
  generateLocalToken, generateBoardToken, validateLocalToken, validateBoardToken,
} from "../servers/gateway/local-token.js";

let dir, db;
const read = (t) => readFileSync(t.path(), "utf8").trim();

before(() => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  dir = mkdtempSync(join(tmpdir(), "path-scoped-token-"));
  const dbPath = join(dir, "crow.db");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: dbPath }, cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  db = createDbClient(dbPath);
});
after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

test("the file lands under secrets/, mode 0600, and its content validates", async () => {
  const tok = await SERVICES_TOKEN.rotate(db);
  assert.match(tok, /^[0-9a-f]{64}$/);
  assert.equal(SERVICES_TOKEN.path(), join(process.env.CROW_HOME, "secrets", "services-token"));
  assert.equal(statSync(SERVICES_TOKEN.path()).mode & 0o777, 0o600);
  assert.equal(read(SERVICES_TOKEN), tok);
  assert.equal(await SERVICES_TOKEN.validate(db, tok), true);
  assert.equal(SATELLITE_TOOLS_TOKEN.path(), join(process.env.CROW_HOME, "secrets", "satellite-tools-token"));
});

test("rotating twice kills the old token and keeps the new one", async () => {
  const a = await SERVICES_TOKEN.rotate(db);
  const b = await SERVICES_TOKEN.rotate(db);
  assert.notEqual(a, b);
  assert.equal(await SERVICES_TOKEN.validate(db, a), false);
  assert.equal(await SERVICES_TOKEN.validate(db, b), true);
  assert.equal(read(SERVICES_TOKEN), b);
  assert.deepEqual(readdirSync(join(process.env.CROW_HOME, "secrets")).filter((f) => f.endsWith(".tmp")), []);
});

test("validate refuses junk, the other family, and the local MCP token", async () => {
  const s = await SERVICES_TOKEN.rotate(db);
  const t = await SATELLITE_TOOLS_TOKEN.rotate(db);
  const local = await generateLocalToken(db);
  for (const bad of [undefined, null, "", 42, {}, t, local, "nope"]) assert.equal(await SERVICES_TOKEN.validate(db, bad), false);
  assert.equal(await SATELLITE_TOOLS_TOKEN.validate(db, s), false);
  assert.equal(await SATELLITE_TOOLS_TOKEN.validate(db, local), false);
  assert.equal(await SATELLITE_TOOLS_TOKEN.validate(db, t), true);
});

test("validate is false before any rotate", async () => {
  const fresh = pathScopedToken({ name: "fresh", hashKey: "fresh_tools_token_hash", createdKey: "fresh_tools_token_created_at" });
  assert.equal(await fresh.validate(db, "a".repeat(64)), false);
});

test("a family token is refused by validateLocalToken and validateBoardToken", async () => {
  const s = await SERVICES_TOKEN.rotate(db);
  const t = await SATELLITE_TOOLS_TOKEN.rotate(db);
  await generateLocalToken(db); await generateBoardToken(db);
  for (const tok of [s, t]) {
    assert.equal(await validateLocalToken(db, tok), false);
    assert.equal(await validateBoardToken(db, tok), false);
  }
});

test("a failed rename throws, drops the temp file, and the old token still validates", async () => {
  const f = pathScopedToken({ name: "dirtarget", hashKey: "dirtarget_token_hash", createdKey: "dirtarget_token_created_at" });
  const old = await f.rotate(db);
  // Make the target path a directory so renameSync(tmp, path) fails.
  rmSync(f.path()); mkdirSync(f.path());
  await assert.rejects(() => f.rotate(db));
  assert.equal(await f.validate(db, old), true, "old hash restored");
  assert.deepEqual(readdirSync(join(process.env.CROW_HOME, "secrets")).filter((x) => x.startsWith("dirtarget-token.") && x.endsWith(".tmp")), []);
});

test("a failed rename with no prior hash leaves no hash behind", async () => {
  const f = pathScopedToken({ name: "firstfail", hashKey: "firstfail_token_hash", createdKey: "firstfail_token_created_at" });
  mkdirSync(f.path(), { recursive: true });
  await assert.rejects(() => f.rotate(db));
  assert.equal(await f.validate(db, "a".repeat(64)), false);
});
