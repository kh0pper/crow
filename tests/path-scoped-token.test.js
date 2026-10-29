/**
 * Task 4: the single path-scoped token factory (pathScopedToken) and its two
 * instances. A family token lives at <crowHome>/secrets/<name>-token (0600),
 * rotates atomically, and is accepted by its own validate() and nothing else.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, readdirSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { readSetting } from "../servers/gateway/dashboard/settings/registry.js";
import { rotateFamilyTokensAtBoot } from "../servers/gateway/boot/mcp-mounts.js";
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

test("M7: a failed rename throws, drops the temp file, and fails closed: the old token stops validating", async () => {
  const f = pathScopedToken({ name: "dirtarget", hashKey: "dirtarget_token_hash", createdKey: "dirtarget_token_created_at" });
  const old = await f.rotate(db);
  // Make the target path a directory so renameSync(tmp, path) fails.
  rmSync(f.path()); mkdirSync(f.path());
  await assert.rejects(() => f.rotate(db));
  assert.equal(await f.validate(db, old), false, "the previous boot's token no longer opens the family (rotated every boot, fail closed)");
  assert.equal(await readSetting(db, "dirtarget_token_hash"), null, "no hash stored");
  assert.deepEqual(readdirSync(join(process.env.CROW_HOME, "secrets")).filter((x) => x.startsWith("dirtarget-token.") && x.endsWith(".tmp")), []);
});

test("a failed rename with no prior hash leaves no hash behind", async () => {
  const f = pathScopedToken({ name: "firstfail", hashKey: "firstfail_token_hash", createdKey: "firstfail_token_created_at" });
  mkdirSync(f.path(), { recursive: true });
  await assert.rejects(() => f.rotate(db));
  assert.equal(await f.validate(db, "a".repeat(64)), false);
});

test("M7: a failed temp-file write also fails closed (the old token stops validating)", async () => {
  const f = pathScopedToken({ name: "rofail", hashKey: "rofail_token_hash", createdKey: "rofail_token_created_at", home: join(dir, "rohome") });
  const old = await f.rotate(db);
  // secrets/ replaced by a plain file: the temp file cannot be created under it.
  const secrets = join(dir, "rohome", "secrets");
  rmSync(secrets, { recursive: true, force: true });
  writeFileSync(secrets, "x");
  await assert.rejects(() => f.rotate(db));
  assert.equal(await f.validate(db, old), false);
  assert.equal(await readSetting(db, "rofail_token_hash"), null);
});

test("M8: rotate tightens an existing secrets/ directory to 0700 (the shared ensureSecretsDir)", async () => {
  const home = join(dir, "loosehome");
  mkdirSync(join(home, "secrets"), { recursive: true });
  chmodSync(join(home, "secrets"), 0o755);
  const f = pathScopedToken({ name: "loose", hashKey: "loose_token_hash", createdKey: "loose_token_created_at", home });
  await f.rotate(db);
  assert.equal(statSync(join(home, "secrets")).mode & 0o777, 0o700);
});

test("M7: the boot step logs a failed family rotation as that family disabled, and keeps booting", async () => {
  const lines = { log: [], warn: [] };
  const log = { log: (m) => lines.log.push(m), warn: (m) => lines.warn.push(m) };
  let closed = 0;
  const good = pathScopedToken({ name: "bootgood", hashKey: "bootgood_token_hash", createdKey: "bootgood_token_created_at", home: join(dir, "boothome") });
  const bad = { rotate: async () => { throw new Error("disk full"); } };
  await rotateFamilyTokensAtBoot({
    createDb: () => new Proxy(db, { get: (tg, k) => (k === "close" ? () => { closed++; } : (typeof tg[k] === "function" ? tg[k].bind(tg) : tg[k])) }),
    tokens: [[bad, "bad-tools"], [good, "good-tools"]], log,
  });
  assert.equal(closed, 2, "each rotation's DB client is closed");
  assert.deepEqual(lines.warn, ["[gateway] bad-tools token rotation failed: disk full; the bad-tools mount refuses every request until the next boot"]);
  assert.deepEqual(lines.log, ["[gateway] good-tools token rotated"]);
});
