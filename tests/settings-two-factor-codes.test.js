/**
 * 2FA recovery codes never travel in a URL (settings audit 2026-10-20).
 *
 * Before: Settings → Two-Factor Auth → "Regenerate recovery codes" put the new
 * codes in the 303 Location (`&codes=<json>`), so they landed in browser
 * history, proxy/access logs and Referer headers; the page read them back from
 * `req.query.codes` and rendered them unescaped (a crafted `?codes=` link
 * injected markup). Now the codes are rendered once, in the POST response,
 * served no-store; nothing reads `codes` from a query string.
 *
 * Also covered: the settings enable_2fa action verifies the code BEFORE it
 * saves anything (a wrong code used to replace the live secret), and the
 * public /dashboard/login/2fa/setup routes are gated (session + 2FA not
 * already on) so a visitor can't replace the secret and recovery codes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as OTPAuth from "otpauth";

const REPO_ROOT = join(import.meta.dirname, "..");

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "settings-2fa-codes-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") },
    stdio: "pipe", cwd: REPO_ROOT,
  });
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_DB_PATH = join(dir, "crow.db");
  return dir;
}

function codeFor(secret) {
  return new OTPAuth.TOTP({ issuer: "Crow", label: "Crow's Nest", algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

/** A response double that records every URL and header it is handed. */
function recordingRes() {
  const r = {
    urls: [], headers: {}, sent: null, statusCode: 200,
    redirect(a, b) { r.urls.push(String(b === undefined ? a : b)); },
    redirectAfterPost(u) { r.urls.push(String(u)); },
    set(k, v) { if (typeof k === "object") { for (const [a, b] of Object.entries(k)) r.headers[a.toLowerCase()] = b; } else r.headers[String(k).toLowerCase()] = v; return r; },
    setHeader(k, v) { r.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return r.headers[String(k).toLowerCase()]; },
    status(c) { r.statusCode = c; return r; },
    type() { return r; },
    send(b) { r.sent = b; return r; },
  };
  return r;
}

async function enable2faWithSecret() {
  const totp = await import("../servers/gateway/dashboard/totp.js");
  const { secret } = totp.generateTotpSecret();
  await totp.saveTotpSetup(secret, totp.generateRecoveryCodes());
  await totp.enable2fa();
  return { totp, secret };
}

const CODE_RE = /\b[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}\b/g;

test("regenerate: codes are rendered in the POST response, never put in a URL, served no-store", async () => {
  const dir = freshDb();
  try {
    const { totp } = await enable2faWithSecret();
    const panel = (await import("../servers/gateway/dashboard/panels/settings.js")).default;
    const res = recordingRes();
    let content = null;
    const req = { method: "POST", query: { section: "two-factor" }, body: { action: "regenerate_recovery_codes" }, csrfToken: "tok" };
    const db = (await import("../servers/db.js")).createDbClient();
    try {
      await panel.handler(req, res, { db, lang: "en", layout: ({ content: c }) => { content = c; return c; } });
    } finally { db.close(); }

    assert.deepEqual(res.urls, [], "no redirect: nothing carries the codes in a Location header");
    assert.ok(content, "the section was rendered in the POST response");
    const shown = content.match(CODE_RE) || [];
    assert.equal(shown.length, 8, "all new codes are shown once");
    assert.match(String(res.headers["cache-control"] || ""), /no-store/);
    for (const u of res.urls) for (const c of shown) assert.ok(!u.includes(c));
    // The shown codes are the live ones.
    assert.equal(await totp.verifyRecoveryCode(shown[0]), true);
    assert.equal(await totp.getRecoveryCodeCount(), 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crafted ?codes= link shows no codes and injects nothing", async () => {
  const dir = freshDb();
  try {
    await enable2faWithSecret();
    const section = (await import("../servers/gateway/dashboard/settings/sections/two-factor.js")).default;
    const evil = encodeURIComponent(JSON.stringify(['<img src=x onerror="alert(1)">', "aaaa-bbbb-cccc"]));
    const html = await section.render({ req: { query: { codes: evil } }, res: recordingRes(), db: null, lang: "en" });
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /aaaa-bbbb-cccc/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the regenerate form posts as a full page with a CSRF field (Turbo drops a 200 form response)", async () => {
  const dir = freshDb();
  try {
    await enable2faWithSecret();
    const section = (await import("../servers/gateway/dashboard/settings/sections/two-factor.js")).default;
    const html = await section.render({ req: { query: {}, csrfToken: "tok123" }, res: recordingRes(), db: null, lang: "en" });
    const form = html.slice(html.lastIndexOf("<form", html.indexOf('value="regenerate_recovery_codes"')), html.indexOf("</form>", html.indexOf('value="regenerate_recovery_codes"')));
    assert.match(form, /data-turbo="false"/);
    assert.match(form, /name="_csrf" value="tok123"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two-factor.js never builds a URL with codes and never reads codes from the query", () => {
  const src = readFileSync(join(REPO_ROOT, "servers/gateway/dashboard/settings/sections/two-factor.js"), "utf8");
  assert.doesNotMatch(src, /[?&]codes=/);
  assert.doesNotMatch(src, /query\.codes/);
});

test("enable_2fa with a wrong code while 2FA is on leaves the live secret alone", async () => {
  const dir = freshDb();
  try {
    const { totp, secret } = await enable2faWithSecret();
    const section = (await import("../servers/gateway/dashboard/settings/sections/two-factor.js")).default;
    const other = totp.generateTotpSecret().secret;
    const res = recordingRes();
    await section.handleAction({
      req: { body: { action: "enable_2fa", secret: other, totp_code: "000000", recovery_codes: encodeURIComponent(JSON.stringify(totp.generateRecoveryCodes())) } },
      res, db: null, action: "enable_2fa",
    });
    assert.equal(await totp.getTotpSecret(), secret);
    // Even a CORRECT code for a new secret can't replace it while 2FA is on.
    await section.handleAction({
      req: { body: { action: "enable_2fa", secret: other, totp_code: codeFor(other), recovery_codes: encodeURIComponent(JSON.stringify(totp.generateRecoveryCodes())) } },
      res, db: null, action: "enable_2fa",
    });
    assert.equal(await totp.getTotpSecret(), secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enable_2fa: a wrong code saves nothing; a right code enables; malformed codes are refused without throwing", async () => {
  const dir = freshDb();
  try {
    const totp = await import("../servers/gateway/dashboard/totp.js");
    const section = (await import("../servers/gateway/dashboard/settings/sections/two-factor.js")).default;
    const { secret } = totp.generateTotpSecret();
    const codes = totp.generateRecoveryCodes();
    const body = (over) => ({ action: "enable_2fa", secret, recovery_codes: encodeURIComponent(JSON.stringify(codes)), ...over });

    const r1 = recordingRes();
    await section.handleAction({ req: { body: body({ totp_code: "000000" }) }, res: r1, db: null, action: "enable_2fa" });
    assert.equal(await totp.getTotpSecret(), null, "nothing saved on a wrong code");
    assert.match(r1.urls[0], /error=invalid-code/);

    const r2 = recordingRes();
    await section.handleAction({ req: { body: body({ totp_code: codeFor(secret), recovery_codes: "%%%not-json" }) }, res: r2, db: null, action: "enable_2fa" });
    assert.equal(await totp.is2faEnabled(), false);
    assert.equal(await totp.getTotpSecret(), null);

    const r3 = recordingRes();
    await section.handleAction({ req: { body: body({ totp_code: codeFor(secret), recovery_codes: encodeURIComponent(JSON.stringify(["<b>x</b>"])) }) }, res: r3, db: null, action: "enable_2fa" });
    assert.equal(await totp.is2faEnabled(), false, "codes in the wrong shape are refused");

    const r4 = recordingRes();
    await section.handleAction({ req: { body: body({ totp_code: codeFor(secret) }) }, res: r4, db: null, action: "enable_2fa" });
    assert.equal(await totp.is2faEnabled(), true);
    assert.equal(await totp.getTotpSecret(), secret);
    assert.equal(await totp.verifyRecoveryCode(codes[0]), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the public login setup routes ---------------------------------------

test("login 2FA setup gate: no session → login; 2FA already on → dashboard; signed in without 2FA → allowed", async () => {
  const { twoFactorSetupGate } = await import("../servers/gateway/dashboard/two-factor-setup-gate.js");
  assert.equal(await twoFactorSetupGate({}, { sessionOf: async () => null, enabled: async () => false }), "/dashboard/login");
  assert.equal(await twoFactorSetupGate({}, { sessionOf: async () => "tok", enabled: async () => true }), "/dashboard");
  assert.equal(await twoFactorSetupGate({}, { sessionOf: async () => null, enabled: async () => true }), "/dashboard/login");
  assert.equal(await twoFactorSetupGate({}, { sessionOf: async () => "tok", enabled: async () => false }), null);
});

test("both /dashboard/login/2fa/setup routes run the gate before touching the secret", () => {
  const src = readFileSync(join(REPO_ROOT, "servers/gateway/dashboard/index.js"), "utf8");
  for (const verb of ["get", "post"]) {
    const start = src.indexOf(`router.${verb}("/dashboard/login/2fa/setup"`);
    assert.ok(start > 0, `${verb} route exists`);
    const body = src.slice(start, src.indexOf("\n  });", start));
    const gate = body.indexOf("twoFactorSetupGate(req)");
    assert.ok(gate > 0, `${verb} route calls the gate`);
    for (const sink of ["saveTotpSetup(", "getTotpSecret(", "enable2fa("]) {
      const at = body.indexOf(sink);
      if (at > 0) assert.ok(gate < at, `${verb}: gate runs before ${sink}`);
    }
    assert.match(body, /no-store/, `${verb}: response is no-store`);
  }
});
