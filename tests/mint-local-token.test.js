import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "crow-mint-"));
const env = { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") };

function run(args = []) {
  return spawnSync("node", ["scripts/mint-local-token.js", ...args], { cwd: ROOT, env, encoding: "utf-8" });
}

test("mints a 64-hex token on a fresh DB and it validates", async () => {
  const init = spawnSync("node", ["scripts/init-db.js"], { cwd: ROOT, env, encoding: "utf-8" });
  assert.equal(init.status, 0, init.stderr);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const token = (r.stdout.match(/\b[0-9a-f]{64}\b/) || [])[0];
  assert.ok(token, "prints the raw token once");
  // Import-order env caveat: writeSetting/readSetting scope:"local" resolves
  // the local instance id via getOrCreateLocalInstanceId(), which reads
  // CROW_DATA_DIR (not just CROW_DB_PATH) to locate the instance-id file. The
  // mint ran in a child process with both vars set; this in-process dynamic
  // import needs both too, or it resolves a different instance id than the
  // child used and validation false-negatives.
  process.env.CROW_DB_PATH = env.CROW_DB_PATH;
  process.env.CROW_DATA_DIR = env.CROW_DATA_DIR;
  const { createDbClient } = await import("../servers/db.js");
  const { validateLocalToken } = await import("../servers/gateway/local-token.js");
  assert.equal(await validateLocalToken(createDbClient(), token), true);
});

test("refuses a second mint without --rotate; --rotate replaces", () => {
  const again = run();
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /--rotate/);
  const rot = run(["--rotate"]);
  assert.equal(rot.status, 0, rot.stderr);
  assert.match(rot.stdout, /\b[0-9a-f]{64}\b/);
});
