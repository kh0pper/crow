// tests/cloud-consent-route.test.js — the "Let bots use this provider" switch
// through the REAL dashboard router (dashboardAuth, then csrfMiddleware, then
// the settings panel's action dispatch): a session POST without the CSRF
// token is refused 403 and records nothing; with it, the grant lands.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const dir = mkdtempSync(join(tmpdir(), "cloud-consent-route-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
const prevPublic = process.env.CROW_DASHBOARD_PUBLIC;

const { createDbClient } = await import("../servers/db.js");
const { readCloudConsent, ensureCloudConsentSalt, consentTokenFor } = await import("../servers/shared/cloud-consent.js");
const db = createDbClient();
after(() => {
  if (prevPublic === undefined) delete process.env.CROW_DASHBOARD_PUBLIC; else process.env.CROW_DASHBOARD_PUBLIC = prevPublic;
  try { db.close(); } catch {}
  rmScratch(dir);
});

test("a session POST of llm_provider_bots_allow without the CSRF token is 403; with it, the grant lands", async () => {
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled, lamport_ts, instance_id, provider_type) VALUES (?,?,?,?,?,0,1,?,?)",
    args: ["cloud-p", "https://api.example.com/v1", "fixture-cloud-key-p", "cloud", JSON.stringify([{ id: "c1" }]), "b".repeat(32), "openai"],
  });
  const salt = await ensureCloudConsentSalt(db);
  const { rows } = await db.execute("SELECT * FROM providers WHERE id = 'cloud-p'");
  const token = consentTokenFor({ baseUrl: rows[0].base_url, apiKey: rows[0].api_key }, salt);

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
    const send = (fields) => fetch(url, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

    const noCsrf = await send({ action: "llm_provider_bots_allow", id: "cloud-p", consent_token: token });
    assert.equal(noCsrf.status, 403);
    const wrong = await send({ action: "llm_provider_bots_allow", id: "cloud-p", consent_token: token, _csrf: "nope" });
    assert.equal(wrong.status, 403);
    assert.deepEqual(await readCloudConsent(db), {}, "nothing recorded");

    const ok = await send({ action: "llm_provider_bots_allow", id: "cloud-p", consent_token: token, _csrf: "csrf-abc" });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get("location"), /section=llm&tab=providers$/);
    assert.ok((await readCloudConsent(db))["cloud-p"], "the grant landed");

    // No session at all: sent to the login page, never dispatched.
    const anon = await fetch(url, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "llm_provider_bots_deny", id: "cloud-p" }).toString(),
    });
    assert.ok(anon.status === 302 || anon.status === 303);
    assert.ok((await readCloudConsent(db))["cloud-p"], "deny without a session did nothing");
  } finally {
    delete process.env.CROW_DASHBOARD_PUBLIC;
    server.close();
  }
});
