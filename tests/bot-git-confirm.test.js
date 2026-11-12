/**
 * Per-bot git access, PR C tasks C3 + C4: the first-use host confirm
 * (git_host_scan → git_host_confirm, git_host_remove) and the connection test
 * (git_test).
 *
 * No network and no openssh-client: ssh-keyscan and ssh both run through the
 * panel's exec seam (`_setSshExecForTest`), which hands them the same kind of
 * stub the A5 tests use, and the argv each one receives is asserted. The key
 * dirs come from a stub ssh-keygen writing files of the real SHAPE (a
 * PEM-shaped private key and a real ssh-ed25519 blob) in a scratch CROW_HOME, so
 * no key material is committed.
 *
 * The two things these tests care most about are the ones a reviewer would:
 * that nothing is trusted because a scan said so (only the owner's Confirm POST
 * writes confirmed_hosts, and only for a fingerprint the scan returned), and
 * that ssh output reaches the page as TEXT.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";
import { fromLaptop } from "./helpers/off-box.js";

const dir = mkdtempSync(join(tmpdir(), "bot-git-confirm-"));
const HOME = join(dir, "home");
const DATA = join(dir, "data");
mkdirSync(HOME, { recursive: true, mode: 0o700 });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;

const BOT = "helper";
const OTHER = "second";
const CREATED_AT = "2026-11-12 00:00:00";
const OWNER_SESS = "owner-sess-git-confirm";
const SSO_SESS = "sso-sess-git-confirm";
const HOST = "git.example.org";
const KEY_PORT = 2222;

let db = null;
const G = await import("../servers/gateway/dashboard/panels/bot-builder/git-access.js");
const P = await import("../servers/shared/bot-git/paths.js");
const S = await import("../servers/shared/bot-git/store.js");
const H = await import("../servers/shared/bot-git/host-keys.js");
const { translations, fill } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { _setHostBwrapProbeForTest } = await import("../servers/gateway/dashboard/settings/sections/bot-runtime.js");

const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

// ---- stubs ------------------------------------------------------------------
/** A public-key blob shaped the way ssh writes one: <len><type><len><bytes>. */
function syntheticKey(type, fillByte = 0x5a) {
  const label = Buffer.from(type, "latin1");
  const body = Buffer.alloc(32, fillByte);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(label.length);
  const blen = Buffer.alloc(4);
  blen.writeUInt32BE(body.length);
  return Buffer.concat([len, label, blen, body]).toString("base64");
}

// Built at runtime: a tracked file must never spell a private-key header.
const PEM_BEGIN = "-----BEGIN " + "OPENSSH " + "PRIVATE" + " KEY-----";
const PEM_END = "-----END " + "OPENSSH " + "PRIVATE" + " KEY-----";
const KEY_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB";

/** A stand-in with ssh-keygen's contract: writes `<f>` and `<f>.pub`. */
function stubKeygen(_cmd, args) {
  const f = args[args.indexOf("-f") + 1];
  writeFileSync(f, `${PEM_BEGIN}\n${KEY_BODY}\n${KEY_BODY}\n${PEM_END}\n`, { mode: 0o600 });
  writeFileSync(f + ".pub", "ssh-ed25519 " + syntheticKey("ssh-ed25519") + " crow-bot:test\n", { mode: 0o600 });
}

/**
 * One stub for both probes: it records every call, answers `keyscan` with
 * `scan` and `ssh` with `ssh` — either a stdout string or an error object
 * (`{ stdout, stderr, killed }`) that is thrown with that output attached.
 */
function makeStub({ scan = "", ssh = "" } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const spec = cmd === "ssh-keyscan" ? scan : ssh;
    if (spec && typeof spec === "object") {
      const err = Object.assign(new Error(cmd + " failed"), spec);
      throw err;
    }
    return spec;
  };
  return { fn, calls };
}

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const { createDbClient } = await import("../servers/db.js");
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  db = createDbClient();
  for (const [token, scopes] of [[OWNER_SESS, "dashboard"], [SSO_SESS, "dashboard sso src:instance-peer"]]) {
    await db.execute({
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) " +
        "VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), datetime('now'))",
      args: [hashToken(token), scopes],
    });
  }
  const def = JSON.stringify({ engine: "pi", tools: { crow_mcp: [], pi_builtin: [] } });
  for (const [id, name] of [[BOT, "Helper"], [OTHER, "Second"]]) {
    await db.execute({
      sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, created_at) VALUES (?,?,?,1,?)",
      args: [id, name, def, CREATED_AT],
    });
  }
  const { _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js");
  _setSourcesForTest({ error: null, sources: [] });
});

after(() => {
  G._setSshToolsForTest(null);
  G._setSshExecForTest(null);
  G._setNowForTest(null);
  G._resetGitActionsForTest();
  _setHostBwrapProbeForTest(null);
  try { db && db.close && db.close(); } catch { /* closed */ }
  rmScratch(dir);
});

beforeEach(() => {
  _setHostBwrapProbeForTest(() => ({ ok: true, pidns: true, bindFd: true }));
  G._setSshToolsForTest(() => ({ ok: true, missing: [] }));
  G._setSshExecForTest(null);
  G._resetGitActionsForTest();
  delete process.env.CROW_PI_CONTAIN_BOTS;
  for (const id of [BOT, OTHER]) rmSync(keyDir(id), { recursive: true, force: true });
});

// ---- requests and responses ------------------------------------------------
const ownerReq = (body = {}) => fromLaptop({ dashboardSession: OWNER_SESS, csrfToken: "tok", headers: {}, body });
const ssoReq = (body = {}) => fromLaptop({ dashboardSession: SSO_SESS, csrfToken: "tok", headers: {}, body });

function ctxOf(over = {}) {
  return {
    req: ownerReq(),
    db,
    bot: { bot_id: BOT, display_name: "Helper", enabled: 1 },
    def: {},
    botId: BOT,
    lang: "en",
    q: {},
    hidden: (tab) => `<input type="hidden" name="tab" value="${tab}">`,
    crowHome: HOME,
    ...over,
  };
}

const mkRes = () => {
  const res = { html: null, redirected: null };
  res.send = (s) => { res.html = s; return res; };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  return res;
};

const keyDir = (id) => P.botGitDirReal(id);
const confirmedPath = (id) => join(keyDir(id), "confirmed_hosts");

function fabricateKey(botId = BOT) {
  return S.generateBotKey({ botId, createdAt: CREATED_AT, execFileImpl: stubKeygen });
}

/** The lines of a bot's confirmed_hosts (empty when the file is empty). */
function confirmedLines(botId = BOT) {
  try {
    return readFileSync(confirmedPath(botId), "utf8").split(/\r?\n/).filter((l) => l.trim());
  } catch {
    return [];
  }
}

function forms(html) {
  return html.split("<form ").slice(1);
}

/** POST one git action and return { res, nonce }. */
async function post(body) {
  const res = mkRes();
  await G.handleGitAction(ownerReq(body), res, { db });
  const m = /[?&](?:git_scan|git_test)=([0-9a-f]{32})/.exec(res.redirected || "");
  return { res, nonce: m ? m[1] : null };
}

/** A keyscan answer with `entries` keys for the given host/port. */
function keyscanText(host, port, entries) {
  const name = port === 22 ? host : `[${host}]:${port}`;
  return [
    `# ${name} SSH-2.0-OpenSSH_9.6`,
    ...entries.map(([type, fill]) => `${name} ${type} ${syntheticKey(type, fill)}`),
    "",
  ].join("\n");
}

/** Scan a host and hand back its nonce (the C3 step the tests start from). */
async function scanHost(host = HOST, port = 22, entries = [["ssh-ed25519", 0x41], ["ecdsa-sha2-nistp256", 0x42]]) {
  const stub = makeStub({ scan: keyscanText(host, port, entries) });
  G._setSshExecForTest(stub.fn);
  const { res, nonce } = await post({ action: "git_host_scan", bot_id: BOT, git_host: port === 22 ? host : `${host}:${port}` });
  return { res, nonce, stub, entries };
}

// ===========================================================================
// C3 — first-use host confirm
// ===========================================================================

test("git_host_scan: keyscan runs, a nonce is stored, and NOTHING is written yet", async () => {
  fabricateKey();
  const before = confirmedLines();
  const stub = makeStub({ scan: keyscanText(HOST, 22, [["ssh-ed25519", 0x41], ["ecdsa-sha2-nistp256", 0x42]]) });
  G._setSshExecForTest(stub.fn);

  const { res, nonce } = await post({ action: "git_host_scan", bot_id: BOT, git_host: HOST });
  assert.ok(nonce, "the redirect carries a 16-byte hex nonce: " + res.redirected);
  assert.equal(stub.calls.length, 1, "exactly one ssh-keyscan ran");
  assert.equal(stub.calls[0].cmd, "ssh-keyscan");
  // `--` immediately before the host: it can never be read as an option.
  assert.equal(stub.calls[0].args[stub.calls[0].args.length - 2], "--");
  assert.equal(stub.calls[0].args[stub.calls[0].args.length - 1], HOST);
  assert.deepEqual(confirmedLines(), before, "a scan writes no host file at all");

  // The page now shows every key with its fingerprint and one Confirm form each.
  const html = await G.renderGitAccessCard(ctxOf({ q: { git_scan: nonce } }));
  assert.match(html, /data-testid="git-scan"/);
  const fps = (html.match(/data-testid="git-scan-fp"[^>]*>(SHA256:[A-Za-z0-9+/]{43})</g) || [])
    .map((s) => />(SHA256:[A-Za-z0-9+/]{43})</.exec(s)[1]);
  assert.equal(fps.length, 2, "both scanned fingerprints are shown");
  for (const fp of fps) assert.match(fp, FINGERPRINT_RE);
  assert.ok(html.includes(fill(translations["botbuilder.gitScanHost"].en, { host: HOST, port: "22" })),
    "the host and port the scan covered");
  assert.ok(html.includes(translations["botbuilder.gitScanCheck"].en), "the check-it-yourself sentence");
  assert.ok(html.includes(translations["common.cancel"].en), "and a way out (Cancel)");

  const confirmForms = forms(html).filter((f) => f.includes('value="git_host_confirm"'));
  assert.equal(confirmForms.length, 2, "one Confirm form per scanned key");
  for (const f of confirmForms) {
    assert.ok(f.includes('name="_csrf"'), "a Confirm form without the CSRF token");
    assert.ok(f.includes("git_host_confirm"), "a Confirm form without the action");
    assert.ok(f.includes('name="bot_id"'), "a Confirm form without the bot id");
    assert.ok(f.includes('name="nonce" value="' + nonce + '"'), "a Confirm form without the nonce");
    assert.ok(/name="fingerprint" value="SHA256:[A-Za-z0-9+/]{43}"/.test(f), "a Confirm form without its fingerprint");
  }
  assert.deepEqual(confirmedLines(), before, "still nothing trusted after rendering the prompt");
});

test("git_host_scan: a non-default port is scanned and shown as [host]:port", async () => {
  fabricateKey();
  const { nonce } = await scanHost(HOST, KEY_PORT);
  assert.ok(nonce);
  const html = await G.renderGitAccessCard(ctxOf({ q: { git_scan: nonce } }));
  assert.ok(html.includes(fill(translations["botbuilder.gitScanHost"].en, { host: `[${HOST}]:${KEY_PORT}`, port: String(KEY_PORT) })));
});

test("git_host_scan: hosts from the validation table are refused before any keyscan call", async () => {
  fabricateKey();
  const stub = makeStub({ scan: "" });
  G._setSshExecForTest(stub.fn);
  const refused = [
    ["localhost", "git_host_invalid"],
    ["127.0.0.1", "git_host_invalid"],
    ["0x7f.0.0.1", "git_host_invalid"],
    ["::1", "git_host_invalid"],
    ["[::1]:22", "git_host_invalid"],
    ["-oProxyCommand=touch /tmp/x", "git_host_invalid"],
    ["git.example.org:0", "git_host_invalid"],
    ["", "git_host_invalid"],
    ["github.com", "git_host_pinned"],
    ["ssh.github.com", "git_host_pinned"],
  ];
  for (const [host, code] of refused) {
    const { res } = await post({ action: "git_host_scan", bot_id: BOT, git_host: host });
    assert.match(res.redirected, new RegExp("error=" + code), host);
  }
  assert.equal(stub.calls.length, 0, "no ssh-keyscan ran for a refused host");
});

test("git_host_scan: a host that answers with no key says so", async () => {
  fabricateKey();
  const stub = makeStub({ scan: `# ${HOST} SSH-2.0-OpenSSH_9.6\n` });
  G._setSshExecForTest(stub.fn);
  const { res, nonce } = await post({ action: "git_host_scan", bot_id: BOT, git_host: HOST });
  assert.match(res.redirected, /error=git_scan_empty/);
  assert.equal(nonce, null, "nothing to confirm");
  assert.deepEqual(confirmedLines(), [], "nothing on disk");
});

test("git_host_confirm: a wrong fingerprint, an expired nonce and another bot's nonce are all refused", async () => {
  fabricateKey();
  fabricateKey(OTHER);
  const { nonce } = await scanHost();
  assert.ok(nonce);

  // A fingerprint the scan never returned — including one of the right shape.
  const wrong = await post({
    action: "git_host_confirm", bot_id: BOT, nonce, fingerprint: "SHA256:" + "A".repeat(43),
  });
  assert.match(wrong.res.redirected, /error=git_scan_stale/);
  assert.deepEqual(confirmedLines(), [], "a wrong fingerprint writes nothing");

  // Garbage in the fingerprint field is the same refusal, not a crash.
  const garbage = await post({ action: "git_host_confirm", bot_id: BOT, nonce, fingerprint: "<script>" });
  assert.match(garbage.res.redirected, /error=git_scan_stale/);

  // Another bot's nonce, posted from a bot that has its own key.
  const stolen = await post({
    action: "git_host_confirm", bot_id: OTHER, nonce, fingerprint: "SHA256:" + "A".repeat(43),
  });
  assert.match(stolen.res.redirected, /error=git_scan_stale/);
  assert.deepEqual(confirmedLines(OTHER), [], "the other bot's file is untouched");

  // An expired nonce (the TTL is 10 minutes).
  G._setNowForTest(() => Date.now() + 11 * 60 * 1000);
  const expired = await post({
    action: "git_host_confirm", bot_id: BOT, nonce, fingerprint: "SHA256:" + "A".repeat(43),
  });
  assert.match(expired.res.redirected, /error=git_scan_stale/);
  G._setNowForTest(null);
  assert.deepEqual(confirmedLines(), [], "nothing was ever written");
});

test("git_host_confirm: the right fingerprint writes exactly one line, and known_hosts picks it up", async () => {
  fabricateKey();
  const { nonce, entries } = await scanHost();
  const wanted = H.fingerprintOf(syntheticKey(entries[0][0], entries[0][1]));

  const ok = await post({ action: "git_host_confirm", bot_id: BOT, nonce, fingerprint: wanted });
  assert.match(ok.res.redirected, /git=host_added/, ok.res.redirected);
  assert.ok(!ok.res.redirected.includes("error="));

  const lines = confirmedLines();
  assert.equal(lines.length, 1, "exactly one confirmed line: " + JSON.stringify(lines));
  const parsed = H.parseKeyLine(lines[0]);
  assert.ok(parsed, "the line parses under the known_hosts rules");
  assert.equal(parsed.host, HOST);
  assert.equal(parsed.port, 22);
  assert.equal(parsed.type, entries[0][0]);
  assert.equal(H.fingerprintOf(parsed.key), wanted);

  // The nonce is spent: the same POST again is stale, and the page no longer
  // offers the confirm block.
  const again = await post({ action: "git_host_confirm", bot_id: BOT, nonce, fingerprint: wanted });
  assert.match(again.res.redirected, /error=git_scan_stale/);
  const html = await G.renderGitAccessCard(ctxOf({ q: { git_scan: nonce } }));
  assert.ok(!html.includes('data-testid="git-scan"'), "a spent nonce renders no scan block");

  // known_hosts is regenerated at the next spawn: GitHub's pinned lines + ours.
  const written = S.writeSpawnFiles({ botId: BOT, displayName: "Helper" });
  assert.equal(written.ok, true, JSON.stringify(written));
  const known = readFileSync(join(keyDir(BOT), "known_hosts"), "utf8");
  for (const pinned of H.GITHUB_HOST_KEYS) assert.ok(known.includes(pinned), "a pinned GitHub key is missing");
  assert.ok(known.includes(lines[0]), "the confirmed line is in known_hosts");
  assert.equal(known.split(/\r?\n/).filter((l) => l.startsWith(HOST + " ")).length, 1);

  // And the card lists it as a host the bot may reach.
  const card = await G.renderGitAccessCard(ctxOf());
  assert.ok(card.includes(HOST), "the confirmed host is listed");
  assert.ok(card.includes(translations["botbuilder.gitHostConfirmed"].en));
});

test("git_host_remove: drops the confirmed line and says so", async () => {
  fabricateKey();
  const key = syntheticKey("ssh-ed25519", 0x51);
  const added = S.addConfirmedHost(BOT, { host: HOST, port: KEY_PORT, type: "ssh-ed25519", key });
  assert.equal(added.ok, true);
  assert.equal(confirmedLines().length, 1);

  const { res } = await post({
    action: "git_host_remove", bot_id: BOT, git_host: HOST, git_port: String(KEY_PORT),
  });
  assert.match(res.redirected, /git=host_removed/, res.redirected);
  assert.deepEqual(confirmedLines(), [], "the line is gone");
});

// ===========================================================================
// C4 — test connection
// ===========================================================================

test("git_test: an unconfirmed host is refused BEFORE any ssh runs", async () => {
  fabricateKey();
  const stub = makeStub({ ssh: "should never run\n" });
  G._setSshExecForTest(stub.fn);
  for (const host of [HOST, `${HOST}:${KEY_PORT}`, `[${HOST}]:${KEY_PORT}`, "localhost", "127.0.0.1", ""]) {
    const { res } = await post({ action: "git_test", bot_id: BOT, git_test_host: host });
    assert.match(res.redirected, /error=git_test_invalid/, host);
  }
  assert.equal(stub.calls.length, 0, "no ssh ran for an unconfirmed host");
});

test("git_test on github.com: one ssh, then a sentence and the escaped excerpt", async () => {
  fabricateKey();
  const excerpt = "Permission denied (publickey). <script>alert(1)</script>";
  const stub = makeStub({ ssh: { stdout: "git@github.com: ", stderr: excerpt, killed: false } });
  G._setSshExecForTest(stub.fn);

  const { res, nonce } = await post({ action: "git_test", bot_id: BOT, git_test_host: "github.com" });
  assert.ok(nonce, "the redirect carries a test nonce: " + res.redirected);
  assert.equal(stub.calls.length, 1, "exactly one ssh ran");
  assert.equal(stub.calls[0].cmd, "ssh");
  assert.equal(stub.calls[0].args[stub.calls[0].args.length - 1], "git@github.com");
  assert.equal(stub.calls[0].args[stub.calls[0].args.length - 2], "--");

  const html = await G.renderGitAccessCard(ctxOf({ q: { git_test: nonce } }));
  assert.match(html, /data-testid="git-test"/);
  assert.ok(html.includes(translations["botbuilder.gitTestDenied"].en), "the denied sentence");
  assert.ok(html.includes(translations["botbuilder.gitTestExcerpt"].en), "the excerpt is labelled");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the excerpt is escaped");
  assert.ok(!html.includes("<script>alert(1)"), "and never rendered as markup");
  assert.ok(html.includes("Permission denied"), "the readable part survives");

  // The pinned host is recognised in its other spellings too (a hand-made POST).
  for (const host of ["github.com:22", "GitHub.com", "[github.com]:22"]) {
    const again = await post({ action: "git_test", bot_id: BOT, git_test_host: host });
    assert.ok(again.nonce, host + " is accepted: " + again.res.redirected);
  }
  assert.equal(stub.calls.length, 4, "one ssh per accepted spelling");
  assert.equal(stub.calls[1].args[stub.calls[1].args.length - 1], "git@github.com");
});

test("git_test: a confirmed [host]:port is accepted and reaches ssh", async () => {
  fabricateKey();
  const added = S.addConfirmedHost(BOT, { host: HOST, port: KEY_PORT, type: "ssh-ed25519", key: syntheticKey("ssh-ed25519", 0x61) });
  assert.equal(added.ok, true);
  const stub = makeStub({ ssh: "Hi alex! You've successfully authenticated, but GitHub does not provide shell access.\n" });
  G._setSshExecForTest(stub.fn);

  const { res, nonce } = await post({ action: "git_test", bot_id: BOT, git_test_host: `[${HOST}]:${KEY_PORT}` });
  assert.ok(nonce, res.redirected);
  assert.equal(stub.calls.length, 1);
  const args = stub.calls[0].args;
  assert.equal(args[args.length - 1], "git@" + HOST);
  assert.equal(args[args.indexOf("-p") + 1], String(KEY_PORT));

  const html = await G.renderGitAccessCard(ctxOf({ q: { git_test: nonce } }));
  assert.ok(html.includes(translations["botbuilder.gitTestOk"].en), "the connected sentence");
});

test("git_test: every classified result has its own sentence (timeout included)", async () => {
  fabricateKey();
  const cases = [
    ["timeout", { stdout: "", stderr: "", killed: true }, "botbuilder.gitTestTimeout"],
    ["hostkey", { stdout: "", stderr: "Host key verification failed.\n", killed: false }, "botbuilder.gitTestHostkey"],
    ["failed", { stdout: "", stderr: "ssh: connect to host github.com port 22: Connection refused\n", killed: false }, "botbuilder.gitTestFailed"],
  ];
  for (const [, spec, key] of cases) {
    G._resetGitActionsForTest();
    const stub = makeStub({ ssh: spec });
    G._setSshExecForTest(stub.fn);
    const { nonce } = await post({ action: "git_test", bot_id: BOT, git_test_host: "github.com" });
    assert.ok(nonce);
    const html = await G.renderGitAccessCard(ctxOf({ q: { git_test: nonce } }));
    assert.ok(html.includes(translations[key].en), key);
  }
});

test("git_test: a result nonce is owner-only, expires, and belongs to one bot", async () => {
  fabricateKey();
  const { nonce } = (() => {
    const stub = makeStub({ ssh: "successfully authenticated\n" });
    G._setSshExecForTest(stub.fn);
    return post({ action: "git_test", bot_id: BOT, git_test_host: "github.com" });
  })();

  // A peer session (SSO) sees the card read-only and no result block.
  const peer = await G.renderGitAccessCard(ctxOf({ req: ssoReq(), q: { git_test: nonce } }));
  assert.ok(!peer.includes('data-testid="git-test"'), "no test result for a non-owner session");

  // Another bot's page does not show it either.
  const other = await G.renderGitAccessCard(ctxOf({ botId: OTHER, q: { git_test: nonce } }));
  assert.ok(!other.includes('data-testid="git-test"'));

  // And it expires after 5 minutes.
  G._setNowForTest(() => Date.now() + 6 * 60 * 1000);
  const stale = await G.renderGitAccessCard(ctxOf({ q: { git_test: nonce } }));
  assert.ok(!stale.includes('data-testid="git-test"'), "an expired result is not shown");
  G._setNowForTest(null);
});

// ===========================================================================
// the gates every one of these actions shares
// ===========================================================================

test("every C3 / C4 action is owner-only", async () => {
  fabricateKey();
  const stub = makeStub({ scan: "", ssh: "" });
  G._setSshExecForTest(stub.fn);
  for (const action of ["git_host_scan", "git_host_confirm", "git_host_remove", "git_test"]) {
    const res = mkRes();
    await G.handleGitAction(ssoReq({ action, bot_id: BOT }), res, { db });
    assert.match(res.redirected, /error=git_owner_only/, action);
  }
  assert.equal(stub.calls.length, 0);
});

test("with git access off, the host and test actions say to turn it on first", async () => {
  const stub = makeStub({ scan: keyscanText(HOST, 22, [["ssh-ed25519", 0x71]]), ssh: "successfully authenticated\n" });
  G._setSshExecForTest(stub.fn);
  assert.equal(S.botKeyStatus(BOT).on, false);
  for (const body of [
    { action: "git_host_scan", git_host: HOST },
    { action: "git_host_confirm", nonce: "a".repeat(32), fingerprint: "SHA256:" + "A".repeat(43) },
    { action: "git_host_remove", git_host: HOST },
    { action: "git_test", git_test_host: "github.com" },
  ]) {
    const { res } = await post({ bot_id: BOT, ...body });
    assert.match(res.redirected, /error=git_not_on/, body.action);
  }
  assert.equal(stub.calls.length, 0, "nothing ran for a bot with no key");
  assert.ok(!existsSync(confirmedPath(BOT)), "no host file was created");
});