/**
 * Notifications from the media bundle (bundles/media/server/notify.js). The bundle runs from an
 * INSTALLED COPY outside the repo, so the test copies the server directory to a temporary
 * "instance home" and runs it there in a separate process: the shared helper must be reached
 * through the app root, not through a path relative to the bundle.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshMediaDb, REPO } from "./helpers/media-fixtures.js";
import { notify, enablePushInThisProcess } from "../bundles/media/server/notify.js";

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const run = promisify(execFile);

test("from an installed copy, a notification is created through the app root", { timeout: 60_000 }, async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const home = mkdtempSync(join(tmpdir(), "crow-media-home-")); cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const installed = join(home, "bundles", "media", "server");
  cpSync(join(REPO, "bundles", "media", "server"), installed, { recursive: true });
  assert.equal(existsSync(join(home, "servers", "shared", "notifications.js")), false, "a path relative to the installed copy leads nowhere");
  const script = `
    const { pathToFileURL } = await import("node:url");
    const { createDbClient } = await import(pathToFileURL(process.argv[1] + "/servers/db.js").href);
    const { notify } = await import(pathToFileURL(process.argv[2] + "/notify.js").href);
    const db = createDbClient(process.argv[3]);
    const r = await notify(db, { title: "Your morning briefing is ready", body: "8 stories · 6 min", action_url: "/dashboard/media?play=briefing:7", source: "media:briefing" });
    db.close();
    process.stdout.write(JSON.stringify(r));`;
  const env = { ...process.env, CROW_APP_ROOT: REPO };
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script, REPO, installed, f.dbPath], { cwd: home, env, timeout: 30_000 });
  assert.ok(JSON.parse(stdout).id > 0, stdout);
  const row = (await f.db.execute("SELECT type, source, title, body, priority, action_url FROM notifications")).rows[0];
  assert.deepEqual({ ...row }, { type: "media", source: "media:briefing", title: "Your morning briefing is ready", body: "8 stories · 6 min", priority: "normal", action_url: "/dashboard/media?play=briefing:7" });

  // With no reachable app root the call reports nothing sent and does not throw.
  const lost = await run(process.execPath, ["--input-type=module", "-e", script.replace('process.argv[1] + "/servers/db.js"', `${JSON.stringify(REPO)} + "/servers/db.js"`), REPO, installed, f.dbPath],
    { cwd: home, env: { ...process.env, CROW_APP_ROOT: join(home, "nowhere"), HOME: join(home, "nohome") }, timeout: 30_000 });
  assert.equal(lost.stdout, "null");
  assert.match(lost.stderr, /\[media\] notification not sent/);
  assert.equal((await f.db.execute("SELECT COUNT(*) AS n FROM notifications")).rows[0].n, 1);
});

test("the operator's notification preferences apply: with the media type off, nothing is created", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  assert.ok((await notify(f.db, { title: "one" })).id > 0);
  await f.db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('notification_prefs', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [JSON.stringify({ types_enabled: ["reminder", "system"] })] });
  assert.equal(await notify(f.db, { title: "two" }), null);
  assert.equal((await f.db.execute("SELECT COUNT(*) AS n FROM notifications")).rows[0].n, 1);
  const hush = console.error; console.error = () => {};
  try { assert.equal(await notify({ execute: async () => { throw new Error("db gone"); } }, { title: "three" }), null, "a failure is swallowed"); } finally { console.error = hush; }
  const log = console.log; console.log = () => {};
  try { assert.equal(await enablePushInThisProcess(), true, "setting up push without keys is a no-op, not an error"); } finally { console.log = log; }
});
