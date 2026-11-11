/**
 * runHistorySweep closes exactly the handles it opened itself: the tasks.db handle
 * it opened for the card pass (and not a `tasksDb` the caller passed in), and the
 * crow.db handle it opened when none was passed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDbClient } from "../servers/db.js";
import { run as runTasksBase } from "../scripts/migrations/0000-tasks-base.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "hist-sweep-handles-"));
process.env.CROW_HOME = join(dir, "home");
process.env.CROW_DATA_DIR = dir;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
delete process.env.CROW_DB_PATH;
after(() => rmSync(dir, { recursive: true, force: true }));

execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DB_PATH: "" },
  cwd: REPO,
  stdio: "pipe",
});
runTasksBase({ tasksDbPath: join(dir, "tasks.db"), log: () => {} });
writeFileSync(join(dir, ".keep"), "");

const { runHistorySweep } = await import("../servers/gateway/boot/post-listen.js");

/** A real client whose close() is counted. */
function counted(path, log) {
  const client = createDbClient(path);
  const close = client.close.bind(client);
  client.close = () => {
    log.push(path);
    close();
  };
  return client;
}

test("a sweep that opened its own handles closes each exactly once", async () => {
  const closed = [];
  const result = await runHistorySweep({ dbFactory: (path) => counted(path ?? join(dir, "crow.db"), closed) });
  assert.ok(result, "the sweep ran");
  assert.equal(closed.filter((p) => p === join(dir, "tasks.db")).length, 1, "the tasks.db handle it opened is closed once");
  assert.equal(closed.filter((p) => p === join(dir, "crow.db")).length, 1, "and so is the crow.db handle");
});

test("a sweep handed both handles closes neither", async () => {
  const closed = [];
  const db = counted(join(dir, "crow.db"), closed);
  const tdb = counted(join(dir, "tasks.db"), closed);
  try {
    assert.ok(await runHistorySweep({ db, tasksDb: tdb }));
    assert.deepEqual(closed, [], "the caller's handles stay open");
  } finally {
    db.close();
    tdb.close();
  }
});
