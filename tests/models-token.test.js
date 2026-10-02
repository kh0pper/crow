// tests/models-token.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { generateModelsToken, validateModelsToken, ensureModelsToken, modelsTokenPath, validateLocalToken } from "../servers/gateway/local-token.js";

const home = mkdtempSync(join(tmpdir(), "models-token-"));
const dataDir = join(home, "data");
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dataDir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
const prev = process.env.CROW_HOME;
process.env.CROW_HOME = home;
const db = createDbClient(join(dataDir, "crow.db"));
after(() => { if (prev === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prev; try { db.close(); } catch {} rmSync(home, { recursive: true, force: true }); });

test("ensureModelsToken mints once, 0600, and the file validates", async () => {
  assert.deepEqual(await ensureModelsToken(db), { minted: true });
  assert.deepEqual(await ensureModelsToken(db), { minted: false });
  assert.equal(modelsTokenPath(), join(home, "models-token"));
  assert.equal(statSync(modelsTokenPath()).mode & 0o777, 0o600);
  const raw = readFileSync(modelsTokenPath(), "utf8").trim();
  assert.equal(await validateModelsToken(db, raw), true);
  assert.equal(await validateModelsToken(db, raw + "x"), false);
  assert.equal(await validateLocalToken(db, raw), false, "the models token is not the full local token");
});

test("generateModelsToken rotates", async () => {
  const a = readFileSync(modelsTokenPath(), "utf8").trim();
  const b = await generateModelsToken(db);
  assert.notEqual(a, b);
  assert.equal(await validateModelsToken(db, a), false);
  assert.equal(await validateModelsToken(db, b), true);
});

test("boot wiring: the models token is minted in its own block, before the phone-bundle branch", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "boot", "mcp-mounts.js"), "utf8");
  const call = src.indexOf("ensureModelsToken(");
  const phone = src.indexOf("const phoneServerDir");
  assert.ok(call > 0, "ensureModelsToken is called at boot");
  assert.ok(phone < 0 || call < phone, "the call sits before (outside) the phone-bundle branch");
  const block = src.slice(src.lastIndexOf("try {", src.lastIndexOf("try {", call) - 1), call);
  assert.match(block, /createDbClient\(\)/, "with its own DB client, not phoneDb");
});
