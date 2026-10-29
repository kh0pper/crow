/**
 * Health attention: per-target foreign-Funnel issues, the local "This is
 * expected" ack, and the /dashboard/attention alert route. The REAL dashboard
 * router is mounted over a scratch CROW_DATA_DIR (same harness as shell-routes).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "health-ack-"));
process.env.CROW_DATA_DIR = dir;
mkdirSync(join(dir, "home"), { recursive: true });
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-health-ack");
const REPO = new URL("..", import.meta.url).pathname;

let server, base, signals, createDbClient, readSetting, writeSetting;

const FOREIGN = {
  AllowFunnel: { "crow.example.ts.net:443": true },
  Web: { "crow.example.ts.net:443": { Handlers: {
    "/blog": { Proxy: "http://127.0.0.1:3001/blog" },
    "/s": { Proxy: "http://127.0.0.1:3008/s" },
    "/s-assets": { Proxy: "http://127.0.0.1:3008/s-assets" },
    "/hook": { Proxy: "http://127.0.0.1:3009/hook" },
  } } },
};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  const tok = c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)");
  tok.run(hashToken("old-sess"), "2025-06-01 00:00:00");
  tok.run(hashToken("new-sess"), "2026-06-01 00:00:00");
  c.close();
  ({ createDbClient } = await import("../servers/db.js"));
  ({ readSetting, writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js"));
  const db = createDbClient();
  await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();
  signals = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");

  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => { if (server) server.close(); rmSync(dir, { recursive: true, force: true }); });

const NET = serveHeaders("operator@example.com");
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
const OLD = { crow_session: "old-sess", crow_csrf: "tok" };
const NEW = { crow_session: "new-sess", crow_csrf: "tok" };

async function get(path, jar) {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: cookieHeader(jar) } });
  return { status: r.status, location: r.headers.get("location") };
}
async function post(path, form, jar = OLD) {
  const r = await fetch(base + path, {
    method: "POST", redirect: "manual",
    headers: { ...NET, "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar), "x-crow-csrf": jar.crow_csrf },
    body: new URLSearchParams(form).toString(),
  });
  return { status: r.status, location: r.headers.get("location") };
}

async function foreignIssues(cfg = FOREIGN) {
  signals.invalidateHealthCache();
  signals._setTailscaleReader(() => JSON.stringify(cfg));
  const db = createDbClient();
  try {
    const r = await signals.collectHealthSignals(db);
    return r.issues.filter((i) => i.id.startsWith("exposure:foreign"));
  } finally { db.close(); }
}
async function setAcks(value) {
  const db = createDbClient();
  try { await writeSetting(db, "health_ack_exposure_foreign", value, { scope: "local" }); } finally { db.close(); }
}
async function getAcks() {
  const db = createDbClient();
  try { return JSON.parse(await readSetting(db, "health_ack_exposure_foreign")); } finally { db.close(); }
}


const K3008 = () => signals.foreignMappingKey(":3008", ["/s", "/s-assets"]);

test("foreignMappingKey sorts mounts", () => {
  const k = signals.foreignMappingKey(":3008", ["/s-assets", "/s"]);
  assert.equal(signals.foreignMappingKey(":3008", ["/s", "/s-assets"]), k);
  assert.match(k, /^m1:[0-9a-f]{64}$/);
  assert.notEqual(signals.foreignMappingKey(":3008", ["/s"]), k);
  assert.notEqual(signals.foreignMappingKey(":3009", ["/s", "/s-assets"]), k);
  // Fixed length however many mounts: always under the ack route's 1024 cap.
  const many = Array.from({ length: 400 }, (_, i) => "/mount-number-" + i);
  assert.equal(signals.foreignMappingKey(":3008", many).length, k.length);
});

test("two targets give two issues with ack keys", async () => {
  await setAcks("[]");
  const issues = await foreignIssues();
  assert.deepEqual(issues.map((i) => i.id).sort(), ["exposure:foreign::3008", "exposure:foreign::3009"]);
  const a = issues.find((i) => i.id.endsWith(":3008"));
  assert.deepEqual(a.ack, { kind: "exposure-foreign", key: K3008() });
  assert.match(a.label, /\/s-assets/);
  assert.doesNotMatch(a.label, /\/hook/);
});

test("ack hides only its own mapping", async () => {
  await setAcks(JSON.stringify([K3008()]));
  const issues = await foreignIssues();
  assert.deepEqual(issues.map((i) => i.id), ["exposure:foreign::3009"]);
});

test("a changed mapping flags again", async () => {
  await setAcks(JSON.stringify([K3008()]));
  const cfg = structuredClone(FOREIGN);
  cfg.Web["crow.example.ts.net:443"].Handlers["/extra"] = { Proxy: "http://127.0.0.1:3008/extra" };
  const issues = await foreignIssues(cfg);
  assert.ok(issues.find((i) => i.id === "exposure:foreign::3008"));
});

test("bad ack JSON means none acked", async () => {
  for (const bad of ["{not json", '{"a":1}', '"str"']) {
    await setAcks(bad);
    assert.equal((await foreignIssues()).length, 2, bad);
  }
});

test("ack route: stores locally, dedupes, caps at 50, 400 on bad kind", async () => {
  await setAcks("[]");
  const key = ":3008|/s,/s-assets";
  let r = await post("/dashboard/health/ack", { kind: "exposure-foreign", key });
  assert.equal(r.status, 303);
  assert.equal(r.location, "/dashboard/attention");
  await post("/dashboard/health/ack", { kind: "exposure-foreign", key });
  assert.deepEqual(await getAcks(), [key]);
  // stored as a local override, not the global row
  const c = new Database(join(dir, "crow.db"), { readonly: true });
  const local = c.prepare("SELECT COUNT(*) n FROM dashboard_settings_overrides WHERE key='health_ack_exposure_foreign'").get().n;
  const global = c.prepare("SELECT COUNT(*) n FROM dashboard_settings WHERE key='health_ack_exposure_foreign'").get().n;
  c.close();
  assert.equal(local, 1);
  assert.equal(global, 0);
  for (let i = 0; i < 60; i++) await post("/dashboard/health/ack", { kind: "exposure-foreign", key: `:${4000 + i}|/x` });
  const keys = await getAcks();
  assert.equal(keys.length, 50);
  assert.equal(keys.at(-1), ":4059|/x");
  assert.equal((await post("/dashboard/health/ack", { kind: "other", key: "k" })).status, 400);
  assert.equal((await post("/dashboard/health/ack", { kind: "exposure-foreign", key: "" })).status, 400);
  assert.equal((await post("/dashboard/health/ack", { kind: "exposure-foreign" })).status, 400);
});

test("ack route: back is honored only for a same-origin /dashboard path", async () => {
  const ok = await post("/dashboard/health/ack", { kind: "exposure-foreign", key: "k|/a", back: "/dashboard/nest?open=1" });
  assert.equal(ok.location, "/dashboard/nest?open=1");
  for (const back of ["https://evil.example/x", "//evil.example/x", "/elsewhere"]) {
    const r = await post("/dashboard/health/ack", { kind: "exposure-foreign", key: "k|/a", back });
    assert.equal(r.location, "/dashboard/attention", back);
  }
});

test("ack invalidates the cache", async () => {
  await setAcks("[]");
  assert.equal((await foreignIssues()).length, 2);
  // Same cached result is served until the ack route invalidates it.
  await post("/dashboard/health/ack", { kind: "exposure-foreign", key: signals.foreignMappingKey(":3009", ["/hook"]) });
  const db = createDbClient();
  try {
    const r = await signals.collectHealthSignals(db); // no manual invalidate
    assert.deepEqual(r.issues.filter((i) => i.id.startsWith("exposure:foreign")).map((i) => i.id), ["exposure:foreign::3008"]);
  } finally { db.close(); }
});

test("attention redirects by mode", async () => {
  const n = await get("/dashboard/attention", NEW);
  assert.equal(n.status, 303);
  assert.equal(n.location, "/dashboard/perch?sheet=attention");
  const c = await get("/dashboard/attention", OLD);
  assert.equal(c.status, 303);
  assert.equal(c.location, "/dashboard/nest?open=1");
});

test("health and lockout notifications point at /dashboard/attention", async () => {
  // The health monitor: drive the real notify cycle with a stub notify and the
  // real builder post-listen.js passes to createNotification.
  const sent = [];
  const issue = { id: "disk", severity: "warn", label: "Disk is almost full", actionLabel: "Open storage", actionHref: "/x" };
  await signals.runHealthNotifyCycle({
    issues: [issue], lastMap: {}, nowMs: Date.now(),
    notify: (i) => { sent.push(signals.healthNotification(i)); },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action_url, "/dashboard/attention");
  assert.equal(sent[0].source, "health-monitor:disk");
  // The login lockout notification is built inline inside the login handler
  // and cannot be driven from here; its source is still checked by pattern.
  const auth = readFileSync(join(REPO, "servers/gateway/dashboard/auth.js"), "utf8");
  assert.match(auth, /source: "security:lockout"[\s\S]{0,300}action_url: "\/dashboard\/attention"/);
});

