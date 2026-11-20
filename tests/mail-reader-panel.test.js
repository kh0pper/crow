/**
 * Crow Mail's reader panel, its gates and its empty states (plan 2, Task 3), through the REAL
 * dashboard router (csrfMiddleware, the panel dispatch, the shell) over a scratch CROW_DATA_DIR
 * and CROW_HOME:
 *   - CROW_MAIL off: /dashboard/mail is a 404 for everyone and no drawer entry renders;
 *   - on: only the owner's own local password session gets the page; a session without the
 *     password scope, one a paired instance's sign-in minted (SSO) and a peer-signed request get
 *     404, and any method but GET/HEAD is a 404 even for the owner (the panel posts nothing);
 *   - the "More of Crow" grid carries a Mail link only while the flag is on AND the request is
 *     the owner's own session, and no other nav surface links the page;
 *   - no accounts: "Connect your mail"; addresses held elsewhere: "Mail is set up on <instance>"
 *     (escaped) and the link to the settings view; every account held elsewhere: the same pair;
 *   - the page carries no connection detail of any account;
 *   - the stylesheet is scoped under .ml and the root is min-width: 0.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
import { fromLaptop } from "./helpers/off-box.js";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "mail-reader-panel-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
delete process.env.CROW_MAIL;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const DB_FILE = join(dir, "crow.db");
const LOCAL_INSTANCE = "instance-mail-panel";
writeFileSync(join(dir, "instance-id"), LOCAL_INSTANCE);
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;

const PEER = "inst-peer-1";
const NET = serveHeaders("operator@example.com");
let server, base, MODE, mailPanel, store, claims;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES ('garden','Garden','general','active')").run();
  const tok = c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')");
  tok.run(hashToken("owner-sess"), "dashboard");
  tok.run(hashToken("plain-sess"), "");
  tok.run(hashToken("sso-sess"), "dashboard sso src:instance-peer");
  c.close();

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  try { await writeSetting(db, "shell_since", "2026-01-01 00:00:00"); } finally { db.close(); }

  store = await import("../servers/gateway/mail/store/accounts.js");
  claims = await import("../servers/gateway/mail/claims.js");
  mailPanel = (await import("../servers/gateway/dashboard/panels/mail.js")).default;
  const mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  // `x-test-crosshost: 1` stands in for the gateway's cross-host verifier, which marks a request
  // carrying a peer's signature with req.crossHostAuth before the dashboard router.
  app.use((req, res, next) => {
    res.redirectAfterPost = (url) => res.redirect(303, url);
    if (req.headers["x-test-crosshost"] === "1") req.crossHostAuth = { ok: true };
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  delete process.env.CROW_MAIL;
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  const c = new Database(DB_FILE);
  try {
    c.prepare("DELETE FROM mail_messages").run();
    c.prepare("DELETE FROM mail_folders").run();
    c.prepare("DELETE FROM mail_threads").run();
    c.prepare("DELETE FROM mail_image_allow").run();
    c.prepare("DELETE FROM mail_sync_state").run();
    c.prepare("DELETE FROM mail_accounts").run();
    c.prepare("DELETE FROM crow_instances").run();
    c.prepare("DELETE FROM dashboard_settings WHERE key LIKE 'mail_claim_%'").run();
    c.prepare("DELETE FROM dashboard_settings_overrides WHERE key LIKE 'mail_claim_%'").run();
  } finally { c.close(); }
});

const jar = (sess) => `crow_session=${sess}; ${MODE}=new`;
// The CSRF token is SERVER-BOUND (queue item #51 PR-1): HMAC(secret, session id).
const { csrfTokenForSession } = await import("../servers/gateway/dashboard/shared/csrf.js");
async function call(method, path, { sess = "owner-sess", csrf = csrfTokenForSession(sess), crosshost = false } = {}) {
  const headers = { ...NET, cookie: jar(sess) };
  if (csrf) headers["x-crow-csrf"] = csrf;
  if (crosshost) headers["x-test-crosshost"] = "1";
  const r = await fetch(base + path, { method, redirect: "manual", headers });
  return { status: r.status, body: await r.text() };
}
const get = (path, sess = "owner-sess") => call("GET", path, { sess });

async function withDb(fn) {
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  try { return await fn(db); } finally { db.close(); }
}

/** A peer instance the claim rules count as live, and a claim it holds on `address`. */
async function heldElsewhere(address, instanceName) {
  await withDb(async (db) => {
    await db.execute({
      sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, 'crow:mail', 'active')",
      args: [PEER, instanceName],
    });
    await claims.writeClaim(db, address, { localInstanceId: PEER, instanceName, now: 1_000 });
  });
}

const ACCOUNT = {
  label: "Personal",
  address: "alex@example.com",
  username: "alexuser",
  authKind: "password",
  imap: { host: "mail.example.test", port: 993, security: "ssl" },
  smtp: { host: "mail.example.test", port: 465, security: "ssl" },
};

async function withFlag(fn) {
  process.env.CROW_MAIL = "1";
  try { return await fn(); } finally { delete process.env.CROW_MAIL; }
}

/** The panel's own <style> block: the one that carries a .ml rule. */
function mailStyle(body) {
  for (const m of body.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    if (/\.ml\s*\{/.test(m[1])) return m[1];
  }
  return "";
}

test("flag unset: /dashboard/mail is 404 and no drawer link renders", async () => {
  assert.equal(process.env.CROW_MAIL, undefined);
  const r = await get("/dashboard/mail");
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /data-ml/);
  assert.doesNotMatch(r.body, /Connect your mail/);
  const home = await get("/dashboard/project/garden");
  assert.equal(home.status, 200);
  assert.doesNotMatch(home.body, /href="\/dashboard\/mail"/);
});

test("flag on, owner session: 200 with the page title", async () => {
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.match(r.body, /<body class="shell/);
    assert.match(r.body, /<div class="ml" data-ml>/);
    assert.match(r.body, /<h1 class="ml-title">Mail<\/h1>/);
  });
});

test("the page is the owner's own local password session alone, GET only", async () => {
  await withFlag(async () => {
    for (const sess of ["plain-sess", "sso-sess"]) {
      const r = await get("/dashboard/mail", sess);
      assert.equal(r.status, 404, sess);
      assert.equal(r.body, "Not found", sess);
      assert.doesNotMatch(r.body, /data-ml/, sess);
    }
    // The owner's session, but not the owner's turn: a peer-signed request from this machine.
    const peer = await call("GET", "/dashboard/mail", { crosshost: true });
    assert.equal(peer.status, 404);
    assert.equal(peer.body, "Not found");
    // The panel posts nothing: every state-changing method is a 404, CSRF token and all.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await call(method, "/dashboard/mail");
      assert.equal(r.status, 404, method);
      assert.equal(r.body, "Not found", method);
    }
    // And HEAD is the read the panel allows.
    const head = await call("HEAD", "/dashboard/mail");
    assert.equal(head.status, 200);
  });
});

test("the More grid and nothing else shows a Mail link, only while the flag is on and the session is the owner's", async () => {
  await withFlag(async () => {
    const owner = await get("/dashboard/project/garden");
    assert.equal(owner.status, 200);
    const tags = owner.body.match(/<a [^>]*href="\/dashboard\/mail"[^>]*>/g) || [];
    assert.ok(tags.length >= 1, `the drawer's More grid carries it: ${tags.length}`);
    for (const tag of tags) {
      assert.match(tag, /class="shell-more-item"/, tag);
      assert.doesNotMatch(tag, /nav-item/, tag);
    }
    assert.match(owner.body, /class="shell-more-item">Mail</);
    for (const sess of ["plain-sess", "sso-sess"]) {
      const r = await get("/dashboard/project/garden", sess);
      assert.equal(r.status, 200, sess);
      assert.doesNotMatch(r.body, /href="\/dashboard\/mail"/, sess);
    }
  });
  const off = await get("/dashboard/project/garden");
  assert.equal(off.status, 200);
  assert.doesNotMatch(off.body, /href="\/dashboard\/mail"/);
});

test("no accounts: the Connect card and no list", async () => {
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.match(r.body, /<a [^>]*href="\/dashboard\/mail\?view=settings"[^>]*>Connect your mail<\/a>/);
    assert.doesNotMatch(r.body, /Mail is set up on/);
    assert.doesNotMatch(r.body, /<ul/);
    assert.doesNotMatch(r.body, /ml-row/);
  });
});

test("elsewhere only: the instance's name (escaped) and the link to settings, no Connect card", async () => {
  await heldElsewhere("sam@example.com", "R&D <script>alert(1)</script>");
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.match(r.body, /<p class="ml-note">Mail is set up on R&amp;D &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
    assert.doesNotMatch(r.body, /<script>alert/, "the name is text, never markup");
    assert.doesNotMatch(r.body, /Connect your mail/);
    assert.match(r.body, /<a [^>]*href="\/dashboard\/mail\?view=settings"[^>]*>Connect a different account here<\/a>/);
  });
});

test("all accounts claimed_elsewhere: the same sentence naming the holder", async () => {
  await withDb((db) => store.createAccount(db, ACCOUNT));
  await withDb((db) => db.execute({ sql: "UPDATE mail_accounts SET status = 'claimed_elsewhere'", args: [] }));
  await heldElsewhere(ACCOUNT.address, "Studio");
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.match(r.body, /<p class="ml-note">Mail is set up on Studio<\/p>/);
    assert.doesNotMatch(r.body, /Connect your mail/);
    assert.match(r.body, /<a [^>]*href="\/dashboard\/mail\?view=settings"[^>]*>Connect a different account here<\/a>/);
  });
});

test("the page HTML contains no host, port, username or address of any account", async () => {
  await withDb((db) => store.createAccount(db, ACCOUNT));
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /mail\.example\.test/);
    assert.doesNotMatch(r.body, /alexuser/);
    assert.doesNotMatch(r.body, /alex@example\.com/);
    assert.doesNotMatch(r.body, /\b993\b|\b465\b/);
  });
});

test("the stylesheet is scoped under .ml, with min-width: 0 on the root and no sideways scroll", async () => {
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    const css = mailStyle(r.body);
    assert.ok(css, "the panel emits its own stylesheet");
    assert.match(css, /\.ml \{[^}]*min-width: 0/);
    assert.doesNotMatch(css, /overflow-x/);
    for (const chunk of css.split("}")) {
      const rule = chunk.trim();
      if (!rule || !rule.includes("{")) continue;
      const selector = rule.slice(0, rule.indexOf("{")).trim();
      for (const part of selector.split(",")) {
        assert.ok(part.trim().startsWith(".ml"), `out of scope: ${part.trim()}`);
      }
    }
    // Every tap target the empty states offer is 44 px.
    assert.match(css, /\.ml-btn \{[^}]*min-height: 44px/);
  });
});

/* ----------------------------------------------------------------- the gear */

const GEAR_TAG = /<a class="ml-btn ml-gear" href="\/dashboard\/mail\?view=settings" aria-label="Settings">/;

function gears(body) {
  return body.match(/class="ml-btn ml-gear"/g) || [];
}

test("every view carries exactly one settings gear, the empty states and settings included", async () => {
  await withFlag(async () => {
    const empty = await get("/dashboard/mail");
    assert.equal(empty.status, 200);
    assert.equal(gears(empty.body).length, 1, "one gear on the connect page");
    assert.match(empty.body, GEAR_TAG);
    assert.match(empty.body, /<svg class="ml-gear-icon"[^>]*aria-hidden="true"/);

    await heldElsewhere("sam@example.com", "Studio");
    const held = await get("/dashboard/mail");
    assert.equal(held.status, 200);
    assert.equal(gears(held.body).length, 1, "one gear where the mail is held elsewhere");

    const settings = await get("/dashboard/mail?view=settings");
    assert.equal(settings.status, 200);
    assert.equal(gears(settings.body).length, 1, "one gear on the account page");

    // A link that resolves to nothing still gets the page header, and its one gear.
    const account = await withDb((db) => store.createAccount(db, ACCOUNT));
    const gone = await get(`/dashboard/mail?view=message&a=${account.id}&mid=${encodeURIComponent("<never@mail.example.test>")}`);
    assert.equal(gone.status, 404);
    assert.equal(gears(gone.body).length, 1, "one gear on the not-here page");
  });
});

test("the inbox's gear sits right after the Refresh control, and the gear is a 44px square", async () => {
  await withDb((db) => store.createAccount(db, ACCOUNT));
  await withFlag(async () => {
    const r = await get("/dashboard/mail");
    assert.equal(r.status, 200);
    assert.equal(gears(r.body).length, 1, "one gear on the inbox");
    assert.match(
      r.body,
      /data-ml-refresh[^>]*>Refresh<\/button><a class="ml-btn ml-gear" href="\/dashboard\/mail\?view=settings" aria-label="Settings">/,
      "the gear follows the refresh control",
    );
    const css = mailStyle(r.body);
    const rule = /\.ml-gear \{([^}]*)\}/.exec(css);
    assert.ok(rule, "the gear has its own rule");
    assert.match(rule[1], /min-width: 44px/);
    assert.match(rule[1], /min-height: 44px/);
    assert.match(rule[1], /align-items: center/);
    assert.match(rule[1], /justify-content: center/);
  });
});

test("the panel's manifest is the hidden /dashboard/mail page and its handler takes the flag as a seam", async () => {
  assert.equal(mailPanel.id, "mail");
  assert.equal(mailPanel.route, "/dashboard/mail");
  assert.equal(mailPanel.hidden, true);
  assert.equal(mailPanel.category, "ai");
  assert.equal(mailPanel.navOrder, 15.8);
  // The flag seam: a handler called with enabled() false is a 404 and draws nothing.
  await withDb(async (db) => {
    let status = 0;
    const res = {
      status(n) { status = n; return this; },
      type() { return this; },
      send() { return this; },
    };
    const out = await mailPanel.handler(
      fromLaptop({ method: "GET", query: {}, dashboardSession: "owner-sess" }),
      res,
      { db, lang: "en", layout: () => "page", enabled: () => false },
    );
    assert.equal(out, null);
    assert.equal(status, 404);
  });
});