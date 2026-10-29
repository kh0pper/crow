// tests/provider-local-marks-route.test.js — the "This is local" checkbox
// through the REAL dashboard router (dashboardAuth, then csrfMiddleware, then
// the settings panel's action dispatch): a session POST without the CSRF
// token is refused 403 and marks nothing; with it, the mark lands; without a
// session nothing is dispatched (roles phase 2 Task 19).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const dir = mkdtempSync(join(tmpdir(), "local-marks-route-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
const prevPublic = process.env.CROW_DASHBOARD_PUBLIC;

const { createDbClient } = await import("../servers/db.js");
const { ensureCloudConsentSalt } = await import("../servers/shared/cloud-consent.js");
const { readLocalMarks, localMarkTokenFor } = await import("../servers/shared/provider-local-marks.js");
const db = createDbClient();
after(() => {
  if (prevPublic === undefined) delete process.env.CROW_DASHBOARD_PUBLIC; else process.env.CROW_DASHBOARD_PUBLIC = prevPublic;
  try { db.close(); } catch {}
  rmScratch(dir);
});

test("a session POST of llm_provider_mark_local without the CSRF token is 403; with it, the mark lands", async () => {
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled, lamport_ts, instance_id) VALUES (?,?,?,?,?,0,1,?)",
    args: ["other-dns", "http://nas.example.internal:8011/v1", null, "local", JSON.stringify([{ id: "m2" }]), "b".repeat(32)],
  });
  const salt = await ensureCloudConsentSalt(db);
  const token = localMarkTokenFor({ id: "other-dns", baseUrl: "http://nas.example.internal:8011/v1" }, salt);

  const { mintSsoSession } = await import("../servers/gateway/dashboard/auth.js");
  await (await import("./fixtures/sso-source.mjs")).trustedSsoSource("test");
  const { token: session } = await mintSsoSession("test");

  const express = (await import("express")).default;
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(dashboardRouter((req, res, next) => next()));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  process.env.CROW_DASHBOARD_PUBLIC = "true"; // past the network gate; the session and CSRF rails still apply
  try {
    const url = `http://127.0.0.1:${server.address().port}/dashboard/settings?section=llm&tab=providers`;
    const cookie = `crow_session=${session}; crow_csrf=csrf-abc`;
    const send = (fields, headers = { cookie }) => fetch(url, {
      method: "POST", redirect: "manual",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

    const noCsrf = await send({ action: "llm_provider_mark_local", id: "other-dns", local_token: token });
    assert.equal(noCsrf.status, 403);
    const wrong = await send({ action: "llm_provider_mark_local", id: "other-dns", local_token: token, _csrf: "nope" });
    assert.equal(wrong.status, 403);
    assert.deepEqual(await readLocalMarks(db), {}, "nothing marked");

    const anon = await send({ action: "llm_provider_mark_local", id: "other-dns", local_token: token, _csrf: "csrf-abc" }, { cookie: "crow_csrf=csrf-abc" });
    assert.ok(anon.status === 302 || anon.status === 303);
    assert.deepEqual(await readLocalMarks(db), {}, "no session: nothing marked");

    const ok = await send({ action: "llm_provider_mark_local", id: "other-dns", local_token: token, _csrf: "csrf-abc" });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get("location"), /section=llm&tab=providers$/);
    assert.equal((await readLocalMarks(db))["other-dns"]?.host, "nas.example.internal");

    const unmarkNoCsrf = await send({ action: "llm_provider_unmark_local", id: "other-dns" });
    assert.equal(unmarkNoCsrf.status, 403);
    assert.ok((await readLocalMarks(db))["other-dns"], "still marked");
    const unmark = await send({ action: "llm_provider_unmark_local", id: "other-dns", _csrf: "csrf-abc" });
    assert.equal(unmark.status, 303);
    assert.deepEqual(await readLocalMarks(db), {});
  } finally {
    delete process.env.CROW_DASHBOARD_PUBLIC;
    server.close();
  }
});
