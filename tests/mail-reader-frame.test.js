// Crow Mail's reader frame (plan 2, Task 2): one untrusted message body as a standalone document with
// its own strict CSP, an opaque-origin sandbox, and exactly one hash-pinned helper script that reports
// its height. Plus the per-account remote-image allow list route.
//
// Harness: plan 1's Task 19 (tests/mail-api-messages.test.js) — a real init-db'd scratch crow.db copied
// per test (CROW_DATA_DIR, so nothing can touch ~/.crow), an ephemeral express app wired as
// servers/gateway/index.js wires it (the Funnel refusal first, then a session stub, the dashboard's real
// CSRF middleware, then the real mail API router), the real account, folder and message stores, and the
// real owner rule with the request marked as coming from the owner's laptop (tests/helpers/off-box.js).
// The helper script is run for real in linkedom behind a stub `parent.postMessage`.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import vm from "node:vm";
import Database from "better-sqlite3";
import { parseHTML } from "linkedom";
import { markFromLaptop } from "./helpers/off-box.js";

const root = mkdtempSync(join(tmpdir(), "mail-reader-frame-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { default: express, json: expressJson } = await import("express");
const { createDbClient } = await import("../servers/db.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { mailApiRouter, clearMailApiRuntime, MAIL_API_PREFIX } = await import("../servers/gateway/routes/mail-api.js");
const { rejectFunneledMiddleware } = await import("../servers/gateway/funnel.js");
const { MAIL_ERROR_TEXT } = await import("../servers/gateway/mail/errors.js");
const { addImageAllow, createAccount } = await import("../servers/gateway/mail/store/accounts.js");
const { upsertFolders, upsertMessage } = await import("../servers/gateway/mail/store/messages.js");
const {
  FRAME_IFRAME_SANDBOX,
  FRAME_HELPER_CSP_SOURCE,
  FRAME_HELPER_SOURCE,
  dropTrackingPixels,
  frameHeaders,
  renderFrameDocument,
} = await import("../servers/gateway/mail/reader/frame-doc.js");

const OWNER = "owner-local-password-session";
const SSO = "peer-sso-session";
const CSRF = "csrf-token-value";

const FRAMES = `${MAIL_API_PREFIX}/messages`;
const IMAGE_ALLOW = `${MAIL_API_PREFIX}/image-allow`;

const hashToken = (t) => createHash("sha256").update(t).digest("hex");
const NONCE = "Ab3dEf6hIj9kLm2n";

const open = [];
const servers = [];
after(() => {
  clearMailApiRuntime();
  for (const s of servers) s.close();
  for (const c of open) { try { c.close(); } catch { /* closed */ } }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: join(root, "master") },
    stdio: "pipe",
    cwd: REPO,
  });
  const raw = new Database(MASTER);
  const insert = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))");
  insert.run(hashToken(OWNER), "dashboard");
  insert.run(hashToken(SSO), "dashboard sso src:peer-1");
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
});

beforeEach(() => {
  clearMailApiRuntime();
  process.env.CROW_MAIL = "1";
});

/* ------------------------------------------------------------------ helpers */

/** The CSP header split into its own directives, so a test names a directive and not a regex. */
function directives(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const text = part.trim();
    if (!text) continue;
    const at = text.indexOf(" ");
    const name = at < 0 ? text : text.slice(0, at);
    out[name] = at < 0 ? "" : text.slice(at + 1).trim();
  }
  return out;
}

/** The text of every `<script>` in a document. */
function scriptTexts(document) {
  return [...String(document).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

/** How many times a pattern occurs in a document. */
function countOf(document, needle) {
  return String(document).split(needle).length - 1;
}

/** The value of the frame's blocked-image meta tag. */
function blockedMeta(document) {
  const match = /<meta name="crow-blocked-images" content="([0-9]+)">/.exec(String(document));
  return match ? Number(match[1]) : null;
}

/**
 * Run the helper script for real: linkedom for the document, a stub `parent.postMessage`, and a fake
 * timer (so a throttled post stays scheduled instead of firing later in the test run).
 */
function runHelper({ hash = "", document = renderFrameDocument("<p>hi</p>", { blockedRemoteImageCount: 2, lang: "en" }), height = 123.4 } = {}) {
  const win = parseHTML(document);
  win.document.body.getBoundingClientRect = () => ({ height });
  const posted = [];
  const listeners = {};
  const timers = [];
  const sandbox = {
    document: win.document,
    location: { hash },
    parent: { postMessage: (message, target) => posted.push({ message, target }) },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Date,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(FRAME_HELPER_SOURCE, sandbox);
  const fire = (type) => {
    for (const fn of listeners[type] || []) fn({ type });
  };
  return { posted, timers, listeners, fire };
}

/* ------------------------------------------------------------------ HTTP */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

let server = null;

/** One request. `token: null` sends no session; `laptop: false` leaves the request looking local. */
function call(method, path, { body, headers = {}, token = OWNER, csrf = CSRF, laptop = true } = {}) {
  const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const h = { ...(payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) };
  if (token) h.cookie = "crow_session=" + token + "; crow_csrf=" + CSRF;
  if (token && csrf) h["x-crow-csrf"] = csrf;
  if (laptop) h["x-test-from"] = "laptop";
  Object.assign(h, headers);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers: h }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(payload === null ? undefined : payload);
  });
}

const get = (path, opts) => call("GET", path, opts);
const post = (path, body, opts) => call("POST", path, { body, ...opts });

const framePath = (id, query = "") => `${FRAMES}/${id}/frame${query}`;

/* ----------------------------------------------------------------- setup */

let n = 0;

async function setup() {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

  const db = createDbClient(crow);
  open.push(db);

  const app = express();
  app.use(rejectFunneledMiddleware());
  app.use(expressJson({ limit: "1mb" }));

  const sessionGate = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).crow_session;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = token;
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(mailApiRouter(sessionGate, { openDb: () => createDbClient(crow) }));
  app.use(dash);

  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push(server);

  const count = async (table, where = "", args = []) => {
    const { rows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} ${where}`, args });
    return Number(rows[0].n);
  };

  return { db, crow, count };
}

/* ----------------------------------------------------------------- seeds */

const ENDPOINT = { host: "mail.example.test", port: 993, security: "ssl" };
const DEFAULT_FOLDERS = [
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
  { path: "Sent", name: "Sent", specialUse: "\\Sent", delimiter: "/" },
];

async function seedAccount(s, { address = "alex@example.com", label = "Personal" } = {}) {
  const account = await createAccount(s.db, {
    label,
    address,
    authKind: "password",
    imap: ENDPOINT,
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  const listed = await upsertFolders(s.db, account.id, DEFAULT_FOLDERS);
  return {
    account,
    folders: listed.folders,
    inbox: listed.folders.find((folder) => folder.path === "INBOX"),
  };
}

async function seedMessage(s, account, folder, over = {}) {
  const date = over.date ?? Date.now();
  const uid = over.uid ?? 1;
  return upsertMessage(s.db, {
    accountId: account.id,
    folderId: folder.id,
    uid,
    messageId: over.messageId === undefined ? `<m-${uid}@mail.example.test>` : over.messageId,
    subject: over.subject ?? "Hello",
    from: over.from ?? { name: "Sam", address: "sam@example.com" },
    to: over.to ?? [{ name: "Alex", address: account.address }],
    cc: over.cc ?? [],
    text: over.text ?? "hello there",
    html: over.html ?? null,
    snippet: over.snippet ?? "hello there",
    attachments: over.attachments ?? [],
    date,
    internalDate: over.internalDate ?? date,
    flags: over.flags ?? [],
    parseError: over.parseError ?? null,
  });
}

/* ------------------------------------------------- option C: the frame policy */

test("option C: the CSP sandbox is exactly the frame's own sandbox value, never allow-same-origin", () => {
  const csp = directives(frameHeaders({ allowImages: false })["Content-Security-Policy"]);
  assert.equal(csp.sandbox, FRAME_IFRAME_SANDBOX);
  const flags = FRAME_IFRAME_SANDBOX.split(/\s+/);
  assert.ok(flags.includes("allow-scripts"), "the one helper runs");
  for (const forbidden of ["allow-same-origin", "allow-top-navigation", "allow-forms", "allow-modals", "allow-downloads"]) {
    assert.equal(FRAME_IFRAME_SANDBOX.includes(forbidden), false, `the sandbox never carries ${forbidden}`);
    assert.equal(csp.sandbox.includes(forbidden), false, `the CSP sandbox never carries ${forbidden}`);
  }
  assert.equal(csp["frame-ancestors"], "'self'");
  assert.equal(csp["base-uri"], "'none'");
  assert.equal(csp["form-action"], "'none'");
});

test("option C: script-src is exactly the one helper's hash, and default-src is 'none' with no exception", () => {
  const csp = directives(frameHeaders({ allowImages: false })["Content-Security-Policy"]);
  assert.equal(csp["script-src"], FRAME_HELPER_CSP_SOURCE);
  assert.equal(csp["script-src"].includes("'unsafe-inline'"), false, "no inline script beyond the pinned one");
  assert.equal(csp["script-src"].includes("'self'"), false, "nothing from this origin");
  assert.doesNotMatch(csp["script-src"], /https?:/, "no host");
  assert.equal(csp["default-src"], "'none'");
  assert.equal(Object.hasOwn(csp, "connect-src"), false, "connect-src falls back to default-src 'none'");
  assert.equal(Object.hasOwn(csp, "worker-src"), false);

  const document = renderFrameDocument("<p>Hello</p>", { blockedRemoteImageCount: 0, lang: "en" });
  const texts = scriptTexts(document);
  assert.equal(countOf(document, "<script"), 1, "the document holds exactly one script");
  assert.equal(texts.length, 1);
  assert.equal(texts[0], FRAME_HELPER_SOURCE, "the pinned text is the text in the document");
  assert.equal(FRAME_HELPER_CSP_SOURCE, `'sha256-${createHash("sha256").update(texts[0]).digest("base64")}'`);
});

test("option C: every hostile construct in a body is gone, and the helper is the only script left", () => {
  const HOSTILE = [
    '<p id="marker-p-id" name="marker-p-name">Hello there</p>',
    '<div id="marker-div">more</div>',
    '<script>window.pwned = "marker-script"</script>',
    '<img src="https://track.example.test/pixel.gif" width="1" height="1">',
    '<img src="https://track.example.test/photo.png" width="60" height="60" onerror="marker-onerror" onload="marker-onload">',
    '<a href="javascript:alert(1)" onclick="marker-onclick" onmouseover="marker-onover">click</a>',
    '<link rel="stylesheet" href="https://evil.example.test/x.css">',
    '<base href="https://evil.example.test/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example.test/">',
    '<style>@import url("https://evil.example.test/x.css"); body{display:none}</style>',
    '<form action="https://evil.example.test/"><input name="q"><button>send</button></form>',
    '<iframe src="https://evil.example.test/"></iframe>',
  ].join("\n");

  const document = renderFrameDocument(HOSTILE, { blockedRemoteImageCount: 0, lang: "en" });
  assert.equal(countOf(document, "<script"), 1, "exactly one script");
  assert.equal(scriptTexts(document)[0], FRAME_HELPER_SOURCE, "and it is the helper");
  assert.doesNotMatch(document, / on[a-z]+=/); // no on-handler attribute
  assert.equal(document.includes("<link"), false);
  assert.equal(document.includes("<base"), false);
  assert.equal(document.includes("<form"), false);
  assert.equal(document.includes("<iframe"), false);
  assert.equal(document.includes("@import"), false);
  assert.equal(document.includes("http-equiv"), false);
  assert.equal(document.includes("javascript:"), false);
  assert.equal(document.includes("marker-script"), false);
  assert.equal(document.includes("marker-onerror"), false);
  assert.equal(document.includes("marker-onclick"), false);
  for (const marker of ["marker-p-id", "marker-p-name", "marker-div", 'name="q"']) {
    assert.equal(document.includes(marker), false, `no ${marker} from mail content`);
  }
  assert.equal(countOf(document, "<style"), 1, "only the template's stylesheet");
  assert.equal(countOf(document, "<meta"), 3, "only the template's three metas");
  assert.equal(document.includes("pixel.gif"), false, "the tracking pixel is dropped");
  assert.equal(countOf(document, "<img"), 1, "only the 60 px image is left");
});

test("option C: the helper makes no request, reads no cookie and writes no markup", () => {
  for (const forbidden of ["fetch", "XMLHttpRequest", "eval", "innerHTML", "cookie", "storage", "WebSocket", "import("]) {
    assert.equal(FRAME_HELPER_SOURCE.includes(forbidden), false, `the helper carries no ${forbidden}`);
  }
  assert.equal(FRAME_HELPER_SOURCE.includes("crow-mail-frame"), true, "and it speaks the frame's own type");
  assert.doesNotMatch(FRAME_HELPER_SOURCE, /<\/script/i, "plain script text: no closing tag of its own");

  const silent = runHelper({ hash: "" });
  silent.fire("load");
  assert.deepEqual(silent.posted, [], "no fragment, nothing posted");

  for (const hash of ["#n=short", "#n=has space in itxxxxxxxxxxxx", "#other=" + NONCE, "#n=" + NONCE + "x".repeat(60)]) {
    const h = runHelper({ hash });
    h.fire("load");
    assert.deepEqual(h.posted, [], `${hash.slice(0, 12)} posts nothing`);
  }
});

test("option C: a valid #n=<nonce> posts the height and the blocked count, at most once per quarter second", () => {
  const h = runHelper({ hash: "#n=" + NONCE });
  if (h.posted.length === 0) h.fire("load");
  assert.equal(h.posted.length, 1, "one post");
  const message = h.posted[0].message;
  assert.equal(message.t, "crow-mail-frame");
  assert.equal(message.nonce, NONCE);
  assert.equal(message.height, 124, "the body's own height, rounded up");
  assert.equal(message.blocked, 2);
  assert.deepEqual(Object.keys(message).sort(), ["blocked", "height", "nonce", "t"], "nothing else travels");
  assert.equal(h.posted[0].target, "*", "an opaque frame cannot name the parent's origin");

  h.fire("load");
  assert.equal(h.posted.length, 1, "the second post is throttled, not sent");
  assert.equal(h.timers.length >= 1, true, "it is scheduled instead");
});

/* --------------------------------------------------------- images and pixels */

test("img-src follows the one rule: 'none' by default, https with images=1 or an allow-listed sender", async () => {
  assert.equal(directives(frameHeaders({ allowImages: false })["Content-Security-Policy"])["img-src"], "'none'");
  assert.equal(directives(frameHeaders({ allowImages: true })["Content-Security-Policy"])["img-src"], "https:");

  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const written = await seedMessage(s, account, inbox, {
    uid: 1,
    html: '<p>Picture</p><img src="https://cdn.example.test/x.png" width="40" height="40">',
  });

  const blocked = await get(framePath(written.id));
  assert.equal(blocked.status, 200, blocked.text);
  assert.equal(blocked.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(blocked.headers["cache-control"], "no-store");
  assert.equal(blocked.headers["x-content-type-options"], "nosniff");
  assert.equal(blocked.headers["referrer-policy"], "no-referrer");
  assert.equal(directives(blocked.headers["content-security-policy"])["img-src"], "'none'");
  assert.equal(blocked.text.includes("src="), false, "a blocked image has no source at all");
  assert.equal((await get(framePath(written.id, "?images=0"))).text.includes("src="), false, "images=0 is not images=1");

  const asked = await get(framePath(written.id, "?images=1"));
  assert.equal(asked.status, 200, asked.text);
  assert.equal(directives(asked.headers["content-security-policy"])["img-src"], "https:");
  assert.equal(asked.text.includes('src="https://cdn.example.test/x.png"'), true);

  const allowed = await post(IMAGE_ALLOW, { accountId: account.id, sender: "Sam@Example.COM" });
  assert.equal(allowed.status, 200, allowed.text);
  const bySender = await get(framePath(written.id));
  assert.equal(directives(bySender.headers["content-security-policy"])["img-src"], "https:", "an allowed sender shows images unasked");
  assert.equal(bySender.text.includes('src="https://cdn.example.test/x.png"'), true);

  const again = await get(framePath(written.id, "?images=1"));
  assert.equal(directives(again.headers["content-security-policy"])["img-src"], "https:");
});

test("S1: images declared 2 px or smaller are dropped even when images are shown", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const written = await seedMessage(s, account, inbox, {
    uid: 1,
    html: [
      '<p>Pixels</p>',
      '<img src="https://cdn.example.test/pixel-1.png" width="1" height="1">',
      '<img src="https://cdn.example.test/pixel-2.png" width="2" height="2">',
      '<img src="https://cdn.example.test/pixel-px.png" width="1px" height="1px">',
      '<img src="https://cdn.example.test/pixel-0.png" width="0" height="0">',
      '<img src="https://cdn.example.test/pixel-width-only.png" width="1">',
      '<img src="https://cdn.example.test/ok-3.png" width="3" height="3">',
      '<img src="https://cdn.example.test/ok-none.png">',
      '<img src="https://cdn.example.test/ok-percent.png" width="100%">',
    ].join(""),
  });

  const asked = await get(framePath(written.id, "?images=1"));
  assert.equal(asked.status, 200, asked.text);
  for (const dropped of ["pixel-1", "pixel-2", "pixel-px", "pixel-0", "pixel-width-only"]) {
    assert.equal(asked.text.includes(dropped), false, `${dropped} is dropped`);
  }
  for (const kept of ["ok-3.png", "ok-none.png", "ok-percent.png"]) {
    assert.equal(asked.text.includes(kept), true, `${kept} stays`);
  }
  assert.equal(countOf(asked.text, "<img"), 3, "only the three real images are left");

  assert.equal((await post(IMAGE_ALLOW, { accountId: account.id, sender: "sam@example.com" })).status, 200);
  const bySender = await get(framePath(written.id));
  for (const dropped of ["pixel-1", "pixel-2", "pixel-px", "pixel-0", "pixel-width-only"]) {
    assert.equal(bySender.text.includes(dropped), false, `${dropped} is dropped for an allowed sender too`);
  }
  assert.equal(countOf(bySender.text, "<img"), 3, "the pixels are dropped, the images stay");
});

test("a dropped pixel counts once: the banner shows the blocked images that are left", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const both = await seedMessage(s, account, inbox, {
    uid: 1,
    html: [
      '<img src="https://track.example.test/pixel.gif" width="1" height="1">',
      '<img src="https://cdn.example.test/photo.png" width="10" height="10">',
    ].join(""),
  });

  // With images blocked, plan 1 counts both as blocked; the pixel is dropped by this pass, so one
  // blocked image remains to be told about.
  const r = await get(framePath(both.id));
  assert.equal(r.status, 200, r.text);
  assert.equal(blockedMeta(r.text), 1);
  assert.equal(countOf(r.text, "<img"), 1, "the pixel is gone, the other image is still blocked");
  assert.equal(r.text.includes("pixel.gif"), false);

  const onlyPixel = await seedMessage(s, account, inbox, {
    uid: 2,
    html: '<p>Hi</p><img src="https://track.example.test/pixel2.gif" width="1" height="1">',
  });
  const quiet = await get(framePath(onlyPixel.id));
  assert.equal(quiet.status, 200, quiet.text);
  assert.equal(blockedMeta(quiet.text), 0, "nothing is left to tell about, so the banner stays hidden");
  assert.equal(countOf(quiet.text, "<img"), 0);
});

test("meta crow-blocked-images never goes below zero", () => {
  const marked = '<img src="https://track.example.test/p.gif" width="1" height="1" data-crow-blocked="1">';
  assert.equal(blockedMeta(renderFrameDocument(marked, { blockedRemoteImageCount: 3, lang: "en" })), 2);
  assert.equal(blockedMeta(renderFrameDocument(marked, { blockedRemoteImageCount: 1, lang: "en" })), 0);
  assert.equal(blockedMeta(renderFrameDocument(marked, { blockedRemoteImageCount: 0, lang: "en" })), 0);
  assert.equal(blockedMeta(renderFrameDocument("", { lang: "en" })), 0, "a missing count is zero");
});

test("S3: a link keeps its href only when it is absolute; a relative link keeps its text", () => {
  const { html, dropped, droppedBlocked } = dropTrackingPixels([
    '<a href="/dashboard/mail?view=message"><span>dashboard-rel</span></a>',
    '<a href="../x">dotdot-rel</a>',
    '<a href="//mail.example.test/x">protocol-rel</a>',
    '<a href="javascript:alert(1)">javascript-scheme</a>',
    '<a href="data:text/html,hi">data-scheme</a>',
    '<a href="http://example.test/a">http-abs</a>',
    '<a href="https://example.test/b">https-abs</a>',
    '<a href="mailto:alex@example.com">mailto-abs</a>',
    '<a href="tel:+10000000000">tel-abs</a>',
  ].join(""));
  for (const relative of ["/dashboard/mail", "../x", "//mail.example.test/x", "javascript:", "data:"]) {
    assert.equal(html.includes(`href="${relative}`), false, `${relative} loses its href`);
  }
  for (const kept of ["dashboard-rel", "dotdot-rel", "protocol-rel", "javascript-scheme", "data-scheme"]) {
    assert.equal(html.includes(kept), true, `${kept} keeps its text`);
  }
  for (const absolute of ["http://example.test/a", "https://example.test/b", "mailto:alex@example.com", "tel:+10000000000"]) {
    assert.equal(html.includes(`href="${absolute}"`), true, `${absolute} stays`);
  }
  assert.equal(dropped, 0, "no image was dropped");
  assert.equal(droppedBlocked, 0);
});

test("S3: a link whose scheme carries nothing real loses its href, and its text stays", () => {
  const { html } = dropTrackingPixels([
    '<a href="https:/dashboard/x">one-slash</a>',
    '<a href="http:foo">scheme-only</a>',
    '<a href="https://example.test/x">https-abs</a>',
    '<a href="mailto:alex@example.com">mailto-abs</a>',
    '<a href="tel:+15550100">tel-abs</a>',
  ].join(""));
  for (const dropped of ["https:/dashboard/x", "http:foo"]) {
    assert.equal(html.includes(`href="${dropped}"`), false, `${dropped} loses its href`);
  }
  for (const kept of ["one-slash", "scheme-only"]) {
    assert.equal(html.includes(kept), true, `${kept} keeps its text`);
  }
  for (const absolute of ["https://example.test/x", "mailto:alex@example.com", "tel:+15550100"]) {
    assert.equal(html.includes(`href="${absolute}"`), true, `${absolute} stays`);
  }
});

test("S1: a pixel may be declared in fractions, and 2.5 px is a picture", () => {
  const { html, dropped } = dropTrackingPixels([
    '<img src="https://cdn.example.test/fraction.png" width="0.5" height="0.5">',
    '<img src="https://cdn.example.test/fraction-width.png" width="0.5">',
    '<img src="https://cdn.example.test/over-two.png" width="2.5">',
  ].join(""));
  assert.equal(html.includes("fraction.png"), false, "a 0.5 px image is a pixel");
  assert.equal(html.includes("fraction-width.png"), false, "a 0.5 px width alone is enough");
  assert.equal(html.includes("over-two.png"), true, "2.5 px is above the pixel line");
  assert.equal(countOf(html, "<img"), 1);
  assert.equal(dropped, 2);
});

/* ------------------------------------------------------------------ RF1 */

test("RF1: a hostile message renders without its script, handlers, refresh, base, form or pixel", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const html = [
    '<p>Hello there</p>',
    '<script>window.pwned = "marker-script"</script>',
    '<img src="x.png" onerror="marker-onerror">',
    '<style>@import url("https://evil.example.test/x.css");</style>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example.test/">',
    '<base href="https://evil.example.test/">',
    '<form action="https://evil.example.test/"><input name="q"></form>',
    '<img src="https://track.example.test/pixel.gif" width="1" height="1">',
    '<p id="marker-p-id">more</p>',
  ].join("");
  const written = await seedMessage(s, account, inbox, { uid: 1, html, text: "Hello there" });

  const r = await get(framePath(written.id));
  assert.equal(r.status, 200, r.text);
  assert.equal(countOf(r.text, "<script"), 1, "the helper is the only script");
  assert.equal(scriptTexts(r.text)[0], FRAME_HELPER_SOURCE);
  assert.doesNotMatch(r.text, / on[a-z]+=/);
  assert.equal(r.text.includes("<link"), false);
  assert.equal(r.text.includes("<base"), false);
  assert.equal(r.text.includes("<form"), false);
  assert.equal(r.text.includes("@import"), false);
  assert.equal(r.text.includes("http-equiv"), false);
  assert.equal(r.text.includes("marker-script"), false);
  assert.equal(r.text.includes("marker-onerror"), false);
  assert.equal(r.text.includes("marker-p-id"), false);
  assert.equal(r.text.includes("Hello there"), true, "the words are still there");
  assert.equal(r.text.includes("pixel.gif"), false, "the tracking pixel is gone");
  assert.equal(countOf(r.text, "<img"), 1, "only the handler-carrying image is left");
});

test("RF1: links carry target=_blank and rel noopener, so a message cannot navigate the reader", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const written = await seedMessage(s, account, inbox, {
    uid: 1,
    html: '<p>See <a href="https://example.test/report">the report</a>.</p>',
  });

  const r = await get(framePath(written.id));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.text.includes('target="_blank"'), true);
  assert.match(r.text, /rel="noopener[^"]*"/);
});

/* -------------------------------------------------------------- the routes */

test("the flag: the frame and the allow list are 404 with no data while CROW_MAIL is unset", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const written = await seedMessage(s, account, inbox, { uid: 1, subject: "Private subject line" });
  await addImageAllow(s.db, account.id, "sam@example.com");

  delete process.env.CROW_MAIL;
  try {
    for (const [what, r] of [
      ["GET /messages/:id/frame", await get(framePath(written.id))],
      ["GET /image-allow", await get(`${IMAGE_ALLOW}?account=${account.id}`)],
    ]) {
      assert.equal(r.status, 404, `${what}: ${r.text}`);
      assert.deepEqual(r.json, { error: "not_found", message: "Not found." }, what);
      assert.equal(r.text.includes("sam@example.com"), false, `${what} carries no allow list`);
      assert.equal(r.text.includes("Private subject line"), false, `${what} carries no mail`);
    }
  } finally {
    process.env.CROW_MAIL = "1";
  }
});

test("a peer SSO session and a request from this machine get 403 with no body at all", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const written = await seedMessage(s, account, inbox, { uid: 1, subject: "Private subject line", html: "<p>Private body</p>" });

  for (const [label, opts] of [
    ["a peer's SSO session", { token: SSO }],
    ["a request from this machine", { token: OWNER, laptop: false }],
  ]) {
    for (const r of [
      await get(framePath(written.id), opts),
      await get(`${IMAGE_ALLOW}?account=${account.id}`, opts),
      await get(framePath(written.id, "?images=1"), opts),
    ]) {
      assert.equal(r.status, 403, `${label}: ${r.status} ${r.text}`);
      assert.deepEqual(r.json, { error: "owner_only", message: "Only the owner can see this." }, label);
      assert.equal(r.text.includes("Private body"), false, `${label}: no body`);
      assert.equal(r.text.includes("Private subject line"), false, `${label}: no subject`);
      assert.equal(r.text.includes(account.address), false, `${label}: no address`);
    }
  }
});

test("RF6: a Funnel-flagged request never reaches the frame or the allow list", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const written = await seedMessage(s, account, inbox, { uid: 1, html: "<p>Private body</p>" });

  for (const path of [framePath(written.id), `${IMAGE_ALLOW}?account=${account.id}`]) {
    const r = await get(path, { headers: { "tailscale-funnel-request": "1" } });
    assert.equal(r.status, 403, `${path}: ${r.status} ${r.text}`);
    assert.match(r.text, /Funnel/i);
    assert.equal(r.text.includes("Private body"), false, "no mail left through Funnel");
    assert.equal(r.text.includes(account.address), false, "no address either");
  }
});

test("an unknown message id is the fixed JSON 404, never a document", async () => {
  const s = await setup();
  await seedAccount(s);
  for (const bad of ["999999", "not-an-id", "0", "-1"]) {
    const r = await get(framePath(bad));
    assert.equal(r.status, 404, bad);
    assert.deepEqual(r.json, { error: "not_found", message: "Not found." }, bad);
  }
});

test("a plain-text message is escaped with its line breaks kept", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  const written = await seedMessage(s, account, inbox, {
    uid: 1,
    text: 'hello <b>there</b> & "quoted"\nsecond line',
    html: null,
  });

  const r = await get(framePath(written.id));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.text.includes("&lt;b&gt;there&lt;/b&gt;"), true, "the markup is text");
  assert.match(r.text, /<br\s*\/?>/, "the line break is kept");
  assert.equal(r.text.includes("<b>there</b>"), false);
});

test("a row with a parse_error and no body renders an empty framed document", async () => {
  const s = await setup();
  const { account, inbox } = await seedAccount(s);
  let uid = 0;
  for (const parseError of ["too_large", "unparseable"]) {
    uid += 1;
    const written = await seedMessage(s, account, inbox, {
      uid, subject: "Empty", text: "", html: null, snippet: "", parseError,
    });

    const r = await get(framePath(written.id));
    assert.equal(r.status, 200, r.text);
    for (const [code, sentence] of Object.entries(MAIL_ERROR_TEXT)) {
      assert.equal(r.text.includes(sentence), false, `${parseError}: no ${code} sentence`);
    }
    assert.equal(r.text.includes('"error"'), false, "not an error answer");
    assert.equal(countOf(r.text, "<script"), 1, "still a framed document, with its one helper");
    assert.equal(scriptTexts(r.text)[0], FRAME_HELPER_SOURCE);
    assert.match(r.text, /<body>\s*<script>/, "the body is empty");
    assert.equal(blockedMeta(r.text), 0);
  }
});

test("GET /image-allow lists that account's senders, lower-cased and sorted", async () => {
  const s = await setup();
  const alex = await seedAccount(s, { address: "alex@example.com", label: "Personal" });
  const sam = await seedAccount(s, { address: "sam@example.com", label: "Work" });
  await addImageAllow(s.db, alex.account.id, "Sam@Example.com");
  await addImageAllow(s.db, alex.account.id, "kim@example.com");
  await addImageAllow(s.db, sam.account.id, "lee@example.com");

  const r = await get(`${IMAGE_ALLOW}?account=${alex.account.id}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { senders: ["kim@example.com", "sam@example.com"] });
  assert.equal(r.headers["cache-control"], "no-store");

  const other = await get(`${IMAGE_ALLOW}?account=${sam.account.id}`);
  assert.deepEqual(other.json, { senders: ["lee@example.com"] });

  const empty = await setup();
  const third = await seedAccount(empty, { address: "kim@example.com", label: "Empty" });
  assert.deepEqual((await get(`${IMAGE_ALLOW}?account=${third.account.id}`)).json, { senders: [] });

  for (const path of [`${IMAGE_ALLOW}`, `${IMAGE_ALLOW}?account=`]) {
    const missing = await get(path);
    assert.equal(missing.status, 400, missing.text);
    assert.equal(missing.json.error, "bad_input");
  }
  const unknown = await get(`${IMAGE_ALLOW}?account=ma-0123456789abcdef`);
  assert.equal(unknown.status, 404, unknown.text);
  assert.deepEqual(unknown.json, { error: "not_found", message: "Not found." });
});