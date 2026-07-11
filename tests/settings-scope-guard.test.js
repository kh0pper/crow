/**
 * Settings-scope coherence D3 — the scope route refuses to promote OR demote
 * an instance-scope key. Pure hardening: the scope-toggle UI renders radios
 * only for isSyncable keys, so no UI path exists — this guards hand-crafted
 * requests that would otherwise create a shadowing override (the exact bug
 * class this PR removes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import settingsScopeRouter from "../servers/gateway/routes/settings-scope.js";

function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), "scope-guard-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  return dir;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use(settingsScopeRouter((req, res, next) => next())); // no-op auth
  const srv = app.listen(0);
  const port = srv.address().port;
  try { await fn(`http://127.0.0.1:${port}`); } finally { srv.close(); }
}

test("scope route: 403 InstanceScoped for instance-scope keys, both directions; others unaffected", async () => {
  const dir = freshEnv();
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  try {
    await withServer(async (base) => {
      for (const scope of ["local", "global"]) {
        const r = await fetch(`${base}/api/settings/scope`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "auto_update_enabled", scope }),
        });
        assert.equal(r.status, 403, `scope=${scope}`);
        const body = await r.json();
        assert.equal(body.code, "InstanceScoped", `scope=${scope}`);
      }
      // blog_* prefix covered too
      const rBlog = await fetch(`${base}/api/settings/scope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "blog_title", scope: "local" }),
      });
      assert.equal(rBlog.status, 403);
      // non-listed key keeps prior behavior: promote → 403 NotSyncable (allowlist), demote of a
      // value-less key → 404 (readSetting null) — both NOT InstanceScoped
      const rPromote = await fetch(`${base}/api/settings/scope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "some_random_key", scope: "global" }),
      });
      assert.equal(rPromote.status, 403);
      assert.equal((await rPromote.json()).code, "NotSyncable");
      // GET still reports for instance keys
      const rGet = await fetch(`${base}/api/settings/scope?key=auto_update_enabled`);
      assert.equal(rGet.status, 200);
    });
  } finally {
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
