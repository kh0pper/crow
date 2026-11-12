/**
 * Per-bot git access, PR C tasks C1 + C2: the Safety tab's Git access card and
 * its on / off actions.
 *
 * Everything runs against a scratch crow.db (init-db) and a scratch CROW_HOME,
 * like every other Bot Builder panel test — two bots, one owner session and one
 * peer-SSO session. No key material is committed: the fabricated key dirs come
 * from a stub ssh-keygen that writes files of the real SHAPE (a PEM-shaped
 * private key and a real ssh-ed25519 public blob), and the one case that needs
 * the real ssh-keygen skips when the host has no openssh-client.
 *
 * The host facts the card depends on are driven the way the panel drives them:
 * bot-runtime's probe seam (`_setHostBwrapProbeForTest`) and this module's own
 * openssh seam. The contain tier is driven by its two real sources (this
 * process's CROW_PI_CONTAIN_BOTS and the recorded spawn level).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";
import { fromLaptop } from "./helpers/off-box.js";

const dir = mkdtempSync(join(tmpdir(), "bot-git-ui-"));
const HOME = join(dir, "home");
const DATA = join(dir, "data");
mkdirSync(HOME, { recursive: true, mode: 0o700 });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;

const BOT = "helper";
const OTHER = "second";
const CREATED_AT = "2026-11-12 00:00:00";
const OWNER_SESS = "owner-sess-git";
const SSO_SESS = "sso-sess-git";

let db = null;
const G = await import("../servers/gateway/dashboard/panels/bot-builder/git-access.js");
const P = await import("../servers/shared/bot-git/paths.js");
const S = await import("../servers/shared/bot-git/store.js");
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
// Read once, at module load: a test's skip option is evaluated when the test is
// REGISTERED, so this cannot be computed in a before() hook.
const sshKeygen = S.sshToolsAvailable().ok;

const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { _setHostBwrapProbeForTest } = await import("../servers/gateway/dashboard/settings/sections/bot-runtime.js");
const { _resetContainmentForTest, recordContainment, LEVEL_PARTLY } =
  await import("../scripts/pi-bots/containment-status.mjs");

// ---- the stub keygen: files of the real shape, no ssh-keygen needed --------
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

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const { createDbClient } = await import("../servers/db.js");
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  db = createDbClient();
  // The owner's own local password session, and a peer-SSO session (signed in,
  // never the owner's turn). Same rows the dashboard's own login writes.
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

  // No MCP probe on a page render: the tool sources are pinned.
  const { _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js");
  _setSourcesForTest({ error: null, sources: [] });
});

after(() => {
  G._setSshToolsForTest(null);
  _setHostBwrapProbeForTest(null);
  _resetContainmentForTest();
  try { db && db.close && db.close(); } catch { /* closed */ }
  rmScratch(dir);
});

beforeEach(() => {
  _resetContainmentForTest();
  _setHostBwrapProbeForTest(() => ({ ok: true, pidns: true, bindFd: true }));
  G._setSshToolsForTest(() => ({ ok: true, missing: [] }));
  delete process.env.CROW_PI_CONTAIN_BOTS;
  delete process.env.PIBOT_SUPERVISOR;
  delete process.env.CROW_PI_SANDBOX;
  // A key dir left by a failed case must never decide the next one.
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

/** Generate a key dir through the store with the stub keygen (no ssh-keygen). */
function fabricateKey(botId = BOT, createdAt = CREATED_AT) {
  return S.generateBotKey({ botId, createdAt, execFileImpl: stubKeygen });
}

function removeKeyDir(botId) {
  rmSync(keyDir(botId), { recursive: true, force: true });
}

/** The count of POST forms in a fragment (and their CSRF coverage). */
function forms(html) {
  return html.split("<form ").slice(1);
}

// ===========================================================================
// C1 — the card
// ===========================================================================

test("a voice bot renders no git card at all", async () => {
  assert.equal(await G.renderGitAccessCard(ctxOf({ botId: "crow.voice" })), "");
  assert.equal(await G.renderGitAccessCard(ctxOf({ botId: "" })), "");
});

test("no bubblewrap: the sentence, and no way to turn it on", async () => {
  _setHostBwrapProbeForTest(() => ({ ok: false, reason: "bubblewrap (bwrap) is not installed" }));
  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="no_bwrap"/);
  assert.ok(html.includes(translations["botbuilder.gitNoBwrap"].en), "the plain sentence");
  assert.ok(!html.includes(translations["botbuilder.gitTurnOn"].en), "no turn-on button");
  assert.equal(forms(html).length, 0, "no forms at all");
});

test("the reduced sandbox tier (no PID namespace) is its own refusal", async () => {
  // Review item 2: in the userns tier host /proc is visible, so a same-uid bot
  // could read another bot's key through it. The card must not offer the switch.
  _setHostBwrapProbeForTest(() => ({ ok: true, pidns: false, bindFd: true }));
  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="no_pidns"/);
  assert.ok(html.includes(translations["botbuilder.gitNoPidns"].en));
  assert.ok(!html.includes(translations["botbuilder.gitTurnOn"].en), "no turn-on button");
});

test("an older bubblewrap (no --ro-bind-fd) is refused before it can bind a key", async () => {
  _setHostBwrapProbeForTest(() => ({ ok: true, pidns: true, bindFd: false }));
  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="old_bwrap"/);
  assert.ok(html.includes(translations["botbuilder.gitOldBwrap"].en));
  assert.ok(!html.includes(translations["botbuilder.gitTurnOn"].en));
});

test("a host with no openssh-client says so instead of offering a dead key", async () => {
  G._setSshToolsForTest(() => ({ ok: false, missing: ["ssh", "ssh-keygen"] }));
  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="no_tools"/);
  assert.ok(html.includes(translations["botbuilder.gitNoTools"].en));
  assert.ok(!html.includes(translations["botbuilder.gitTurnOn"].en));
});

test("a home folder path git cannot be given disables the card", async () => {
  const saved = process.env.CROW_HOME;
  const spaced = join(dir, "space home");
  mkdirSync(spaced, { recursive: true, mode: 0o700 });
  process.env.CROW_HOME = spaced;
  try {
    const html = await G.renderGitAccessCard(ctxOf());
    assert.match(html, /data-state="bad_path"/);
    assert.ok(html.includes(translations["botbuilder.gitBadPath"].en));
    assert.ok(!html.includes(translations["botbuilder.gitTurnOn"].en));
  } finally {
    process.env.CROW_HOME = saved;
  }
});

test("the contain tier is reported from this process's own selection", async () => {
  process.env.CROW_PI_CONTAIN_BOTS = BOT;
  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="contained"/);
  assert.ok(html.includes(translations["botbuilder.gitContained"].en));
  assert.ok(!html.includes(translations["botbuilder.gitTurnOn"].en), "no turn-on button");
});

test("the contain tier is reported from a recorded spawn level too (env unset)", async () => {
  const BOT_ROW = { botId: BOT, level: LEVEL_PARTLY, open: [] };
  recordContainment(BOT, { level: BOT_ROW.level, open: BOT_ROW.open, tier: "contain" });
  assert.equal(process.env.CROW_PI_CONTAIN_BOTS, undefined, "nothing selected by env");
  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="contained"/);
  assert.ok(html.includes(translations["botbuilder.gitContained"].en));
});

test("a key that exists in a blocked state is called inactive and can still be removed", async () => {
  fabricateKey();
  _setHostBwrapProbeForTest(() => ({ ok: false }));
  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="no_bwrap"/);
  assert.ok(html.includes(translations["botbuilder.gitInactive"].en), "the key is named inactive");
  assert.ok(html.includes(translations["botbuilder.gitTurnOff"].en), "turning it off is still offered");
  assert.ok(!html.includes(translations["botbuilder.gitTurnOn"].en));
  removeKeyDir(BOT);
});

test("off: the lead, the risk, the exact commit identity, and one turn-on form", async () => {
  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="off"/);
  assert.ok(html.includes(translations["botbuilder.gitOffLead"].en));
  assert.ok(html.includes("Helper (Crow bot)"), "the commit name the generated gitconfig carries");
  assert.ok(html.includes("noreply+" + BOT + "@crow-bot.invalid"), "the fixed no-reply address (R6)");
  assert.match(html, /<form method="POST"[^>]*>/);
  assert.ok(html.includes('name="action" value="git_on"'));
  // The risk is stated BEFORE the switch, not only after it: informed consent.
  const risk = html.indexOf(translations["botbuilder.gitR13Warn"].en);
  assert.ok(risk > 0, "the R13 risk is on the card");
  assert.ok(risk < html.indexOf('name="action" value="git_on"'), "and above the turn-on button");
  assert.ok(!html.includes("PRIVATE" + " KEY"), "nothing key-shaped on an off card");
});

test("on: the R13 risk comes first, then the public key, never the private one", async () => {
  const made = fabricateKey();
  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="on"/);
  const risk = html.indexOf(translations["botbuilder.gitR13Warn"].en);
  const pub = html.indexOf('<pre id="btb-git-pub"');
  assert.ok(risk > 0, "the risk sentence is on the card");
  assert.ok(pub > risk, "and it sits ABOVE the public key");
  assert.ok(html.includes(made.publicKey.replace(/&/g, "&amp;").replace(/</g, "&lt;")), "the public key is shown");
  assert.ok(html.includes(made.fingerprint), "the fingerprint is shown");
  assert.ok(html.includes("github.com"), "the pinned host is always listed");
  assert.ok(html.includes(translations["botbuilder.gitHostPinned"].en), "and marked as pinned");
  // A tracked file must never carry the header literal; the page must never
  // carry the private key either.
  const privateHeader = "PRIVATE" + " KEY";
  assert.ok(!html.includes(privateHeader), "no private-key header on the page");
  assert.ok(!html.includes(KEY_BODY), "no private-key body on the page");
  assert.ok(html.includes(translations["botbuilder.gitTurnOff"].en), "turning it off is offered");
  removeKeyDir(BOT);
});

test("every git form carries the CSRF token (and an action plus the bot id)", async () => {
  fabricateKey();
  // A confirmed host, so the per-host Remove form is rendered too.
  S.addConfirmedHost(BOT, { host: "git.example.com", port: 22, type: "ssh-ed25519", key: syntheticKey("ssh-ed25519") });
  const html = await G.renderGitAccessCard(ctxOf());
  const list = forms(html);
  assert.ok(list.length >= 4, `expected turn-off, add-host, test and remove forms, got ${list.length}`);
  for (const chunk of list) {
    assert.ok(chunk.includes('name="_csrf"'), "a form without the CSRF token");
    assert.ok(chunk.includes('name="action"'), "a form without an action");
    assert.ok(chunk.includes('name="bot_id"'), "a form without the bot id");
  }
  assert.ok(!html.includes(translations["botbuilder.gitTurnOn"].en), "no turn-on button while on");
});

test("a signed-in peer (SSO) sees the state read-only and gets no forms", async () => {
  fabricateKey();
  const html = await G.renderGitAccessCard(ctxOf({ req: ssoReq() }));
  assert.match(html, /data-state="on"/);
  assert.ok(html.includes(translations["botbuilder.gitOwnerOnly"].en), "the owner-only sentence");
  assert.equal(forms(html).length, 0, "no forms for a non-owner session");
  removeKeyDir(BOT);

  const off = await G.renderGitAccessCard(ctxOf({ req: ssoReq() }));
  assert.match(off, /data-state="off"/);
  assert.equal(forms(off).length, 0, "no turn-on form for a non-owner session");
});

test("the card sits OUTSIDE the Safety form (no nested forms)", async () => {
  const { renderSafety } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-safety.js");
  const html = await renderSafety(ctxOf());
  const safetyForm = html.indexOf('id="btb-safety-form"');
  const close = html.indexOf("</form>", safetyForm);
  const card = html.indexOf('data-testid="git-access"');
  assert.ok(safetyForm > 0 && close > safetyForm, "the safety form is there");
  assert.ok(card > close, "the git card renders after the safety form's closing tag");
});

// ===========================================================================
// C2 — the on / off actions
// ===========================================================================

test("git_on: a non-owner request is refused and creates no key", async () => {
  const res = mkRes();
  await G.handleGitAction(ssoReq({ action: "git_on", bot_id: BOT }), res, { db });
  assert.match(res.redirected, /error=git_owner_only/);
  assert.ok(!existsSync(keyDir(BOT)), "no key dir for a peer session");

  const res2 = mkRes();
  await G.handleGitAction(fromLaptop({ body: { action: "git_on", bot_id: BOT } }), res2, { db });
  assert.match(res2.redirected, /error=git_owner_only/);
  assert.ok(!existsSync(keyDir(BOT)));
});

test("git_on: an unknown bot id or a missing row is refused", async () => {
  const res = mkRes();
  await G.handleGitAction(ownerReq({ action: "git_on", bot_id: "../etc" }), res, { db });
  assert.match(res.redirected, /error=unknown_bot/);

  const res2 = mkRes();
  await G.handleGitAction(ownerReq({ action: "git_on", bot_id: "ghost" }), res2, { db });
  assert.match(res2.redirected, /error=unknown_bot/);
});

test("git_on: refused on every host fact the card refuses on", async () => {
  const cases = [
    ["git_no_bwrap", () => _setHostBwrapProbeForTest(() => ({ ok: false }))],
    ["git_no_pidns", () => _setHostBwrapProbeForTest(() => ({ ok: true, pidns: false, bindFd: true }))],
    ["git_old_bwrap", () => _setHostBwrapProbeForTest(() => ({ ok: true, pidns: true, bindFd: false }))],
    ["git_no_tools", () => G._setSshToolsForTest(() => ({ ok: false, missing: ["ssh"] }))],
    ["git_contained", () => { process.env.CROW_PI_CONTAIN_BOTS = BOT; }],
  ];
  for (const [code, setup] of cases) {
    _setHostBwrapProbeForTest(() => ({ ok: true, pidns: true, bindFd: true }));
    G._setSshToolsForTest(() => ({ ok: true, missing: [] }));
    delete process.env.CROW_PI_CONTAIN_BOTS;
    setup();
    const res = mkRes();
    await G.handleGitAction(ownerReq({ action: "git_on", bot_id: BOT }), res, { db });
    assert.match(res.redirected, new RegExp("error=" + code), code);
    assert.ok(!existsSync(keyDir(BOT)), "no key dir while " + code);
  }
});

test("git_on: refused under the single-bot ruling when two pi bots are enabled", async () => {
  const rows = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM pi_bot_defs WHERE enabled=1", args: [] })).rows[0];
  assert.ok(Number(rows.n) >= 2, "the fixture has two enabled bots");
  P._setGitSharedUidPolicyForTest("single-bot");
  try {
    const res = mkRes();
    await G.handleGitAction(ownerReq({ action: "git_on", bot_id: BOT }), res, { db });
    assert.match(res.redirected, /error=git_policy/);
    assert.ok(!existsSync(keyDir(BOT)));

    // The same request under the shipped (accepted) ruling is not refused for
    // the count — it reaches the keygen.
    P._setGitSharedUidPolicyForTest(null);
    const state = await G.gitAccessState({ db, botId: BOT });
    assert.equal(state.state, "off", "the count no longer gates git under the ruling");
  } finally {
    P._setGitSharedUidPolicyForTest(null);
  }
});

test("git_on: creates the key dir with the row's created_at, then refuses a second time", { skip: sshKeygen ? false : "no openssh-client on this host" }, async () => {
  const before = await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [BOT] });
  const res = mkRes();
  await G.handleGitAction(ownerReq({ action: "git_on", bot_id: BOT }), res, { db });
  assert.match(res.redirected, /git=on/, res.redirected);

  const status = S.botKeyStatus(BOT);
  assert.equal(status.on, true, "the key dir exists and is usable");
  const meta = JSON.parse(readFileSync(join(keyDir(BOT), "meta.json"), "utf8"));
  assert.equal(meta.created_at, CREATED_AT, "meta.json carries the bot row's created_at");
  assert.equal(meta.bot_id, BOT);
  assert.match(status.fingerprint, FINGERPRINT_RE);

  const keyBefore = readFileSync(join(keyDir(BOT), "id_ed25519"), "utf8");
  const again = mkRes();
  await G.handleGitAction(ownerReq({ action: "git_on", bot_id: BOT }), again, { db });
  assert.match(again.redirected, /error=git_already_on/);
  assert.equal(readFileSync(join(keyDir(BOT), "id_ed25519"), "utf8"), keyBefore, "the key was not overwritten");

  // Neither action touches the definition.
  const after = await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [BOT] });
  assert.equal(after.rows[0].definition, before.rows[0].definition, "pi_bot_defs is untouched");
  removeKeyDir(BOT);
});

test("a leftover key dir from an earlier bot with the same id: the card says off, and git_on replaces it (C5)", { skip: sshKeygen ? false : "no openssh-client on this host" }, async () => {
  // The dir is usable on disk but its meta.json names ANOTHER row, so the spawn
  // side refuses it. The card must not claim git is on, and turning git on must
  // replace the stale dir instead of refusing forever.
  fabricateKey(BOT, "2025-01-01 00:00:00");
  const stale = await G.gitAccessState({ db, botId: BOT });
  assert.equal(stale.state, "off", "a key made for another row is not this bot's key");
  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="off"/);
  assert.ok(html.includes('name="action" value="git_on"'), "a way to replace it");

  const res = mkRes();
  await G.handleGitAction(ownerReq({ action: "git_on", bot_id: BOT }), res, { db });
  assert.match(res.redirected, /git=on/, res.redirected);
  const meta = JSON.parse(readFileSync(join(keyDir(BOT), "meta.json"), "utf8"));
  assert.equal(meta.created_at, CREATED_AT, "the stale dir was replaced with one for THIS row");
  assert.equal((await G.gitAccessState({ db, botId: BOT })).state, "on");
  removeKeyDir(BOT);
});

test("a DAMAGED key dir (no .pub) is named as damaged and can still be turned off", async () => {
  fabricateKey();
  rmSync(join(keyDir(BOT), "id_ed25519.pub"));
  assert.equal(S.botKeyStatus(BOT).on, false, "a dir without its public half is not a usable key");
  assert.equal((await G.gitAccessState({ db, botId: BOT })).state, "off", "the card cannot claim git is on");

  const html = await G.renderGitAccessCard(ctxOf());
  assert.match(html, /data-state="off"/);
  assert.ok(html.includes(translations["botbuilder.gitKeyDamaged"].en), "the damage is said out loud");
  assert.ok(html.includes(translations["botbuilder.gitTurnOff"].en), "Turn off is offered for a damaged folder");
  assert.ok(forms(html).some((f) => f.includes('name="action" value="git_off"')), "and it is a real form");

  const res = mkRes();
  await G.handleGitAction(ownerReq({ action: "git_off", bot_id: BOT }), res, { db });
  assert.match(res.redirected, /git=off/);
  assert.ok(!res.redirected.includes("fp="), "a damaged dir has no readable public key to name");
  assert.ok(!res.redirected.includes("error="), res.redirected);
  assert.equal(existsSync(keyDir(BOT)), false, "the damaged folder is gone");
});

test("git_off on a DAMAGED dir whose removal FAILS is an error, never a plain off", {
  // Staged by a mode root ignores: as root the removal would succeed and the
  // failure this case is about could not happen.
  skip: typeof process.getuid === "function" && process.getuid() === 0
    ? "root can remove a 0500 dir, so the failure cannot be staged"
    : false,
}, async () => {
  // Byte-for-byte the datastore's own report: a damaged dir is status.on ===
  // false, so a check that only looked at the state could not tell a FAILED
  // removal from "there was nothing to remove" and redirected git=off while the
  // folder — and the private key in it — was still on disk.
  fabricateKey();
  rmSync(join(keyDir(BOT), "id_ed25519.pub"));
  assert.equal(S.botKeyStatus(BOT).on, false, "damaged: not a usable key, so the card says off");
  assert.equal(S.botKeyDirPresent(BOT), true, "but the folder is still there, so Turn off is offered");

  const keyPath = join(keyDir(BOT), "id_ed25519");
  const keyBefore = readFileSync(keyPath, "utf8");
  chmodSync(keyDir(BOT), 0o500);            // the children can no longer be unlinked
  try {
    const res = mkRes();
    await G.handleGitAction(ownerReq({ action: "git_off", bot_id: BOT }), res, { db });
    assert.match(res.redirected, /error=git_off_failed/, res.redirected);
    assert.ok(!/[?&]git=off/.test(res.redirected), "a failed removal is never reported as off");
    assert.equal(existsSync(keyPath), true, "the private key is still on disk");
    assert.equal(readFileSync(keyPath, "utf8"), keyBefore, "and it is untouched");
  } finally {
    chmodSync(keyDir(BOT), 0o700);
  }
  removeKeyDir(BOT);
});

test("git_on over a stale key dir surfaces the OLD fingerprint for the forge", { skip: sshKeygen ? false : "no openssh-client on this host" }, async () => {
  const stale = fabricateKey(BOT, "2025-01-01 00:00:00");
  const res = mkRes();
  await G.handleGitAction(ownerReq({ action: "git_on", bot_id: BOT }), res, { db });
  assert.match(res.redirected, /git=on/, res.redirected);
  const m = /[?&]fp=([^&]+)/.exec(res.redirected);
  assert.ok(m, "the redirect carries the old fingerprint: " + res.redirected);
  assert.equal(decodeURIComponent(m[1]), stale.fingerprint, "the fingerprint of the key that was replaced");

  const after = S.botKeyStatus(BOT);
  assert.equal(after.on, true, "a fresh key is in place");
  assert.notEqual(after.fingerprint, stale.fingerprint, "and it is not the old one");

  const notice = await G.renderGitAccessCard(ctxOf({ q: { git: "on", fp: decodeURIComponent(m[1]) } }));
  assert.ok(notice.includes(translations["botbuilder.gitOnNotice"].en), "git is on");
  assert.ok(notice.includes(translations["botbuilder.gitReplacedNotice"].en.replace("{fp}", stale.fingerprint)),
    "and the dead deploy key is named");
  removeKeyDir(BOT);
});

test("git_off: removes the key dir and names the fingerprint to take off the forge", async () => {
  const made = fabricateKey();
  const before = await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [BOT] });
  assert.ok(existsSync(keyDir(BOT)));

  const res = mkRes();
  await G.handleGitAction(ownerReq({ action: "git_off", bot_id: BOT }), res, { db });
  assert.match(res.redirected, /git=off/);
  const m = /[?&]fp=([^&]+)/.exec(res.redirected);
  assert.ok(m, "the redirect carries the fingerprint: " + res.redirected);
  assert.equal(decodeURIComponent(m[1]), made.fingerprint);
  assert.match(decodeURIComponent(m[1]), FINGERPRINT_RE);
  assert.ok(!existsSync(keyDir(BOT)), "the key dir is gone");
  assert.equal(S.botKeyStatus(BOT).on, false);

  const after = await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [BOT] });
  assert.equal(after.rows[0].definition, before.rows[0].definition, "pi_bot_defs is untouched");
});

test("git_off on a bot with no key is a plain off, not an error", async () => {
  const res = mkRes();
  await G.handleGitAction(ownerReq({ action: "git_off", bot_id: BOT }), res, { db });
  assert.match(res.redirected, /git=off/);
  assert.ok(!res.redirected.includes("error="));
  assert.ok(!res.redirected.includes("fp="), "nothing to report a fingerprint for");
});

test("an unhandled git_ action is refused, never silently ignored", async () => {
  const res = mkRes();
  await G.handleGitAction(ownerReq({ action: "git_bogus", bot_id: BOT, git_host: "example.com" }), res, { db });
  assert.match(res.redirected, /error=git_unsupported/);
});

test("the POST dispatcher routes git_* to the git actions (owner-only, PRG)", async () => {
  const { handleBotBuilderPost } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js");
  const res = mkRes();
  await handleBotBuilderPost(ssoReq({ action: "git_off", bot_id: BOT }), res, { db });
  assert.match(res.redirected, /error=git_owner_only/, "a peer session cannot reach a git action");

  const res2 = mkRes();
  await handleBotBuilderPost(ownerReq({ action: "git_off", bot_id: BOT }), res2, { db });
  assert.match(res2.redirected, /\/dashboard\/bot-builder\?bot=helper&tab=safety&git=off/);

  // The voice bot is refused before the git gate even looks at the action.
  const res3 = mkRes();
  await handleBotBuilderPost(ownerReq({ action: "git_on", bot_id: "crow.voice" }), res3, { db });
  assert.match(res3.redirected, /error=voice_bot_readonly/);
});

test("the off notice shows the fingerprint only when it is the right shape", async () => {
  const fp = "SHA256:" + "A".repeat(43);
  const good = await G.renderGitAccessCard(ctxOf({ q: { git: "off", fp } }));
  assert.ok(good.includes(translations["botbuilder.gitOffNotice"].en.replace("{fp}", fp)),
    "the sentence names the deploy key to remove");

  const bad = await G.renderGitAccessCard(ctxOf({ q: { git: "off", fp: "<script>alert(1)</script>" } }));
  assert.ok(bad.includes(translations["botbuilder.gitOffNoticeNoFp"].en), "the generic notice instead");
  assert.ok(!bad.includes("alert(1)"), "and the query value never reaches the page");
  assert.ok(!bad.includes("SHA256:"), "no fingerprint is printed from a value that is not one");

  const on = await G.renderGitAccessCard(ctxOf({ q: { git: "on" } }));
  assert.ok(on.includes(translations["botbuilder.gitOnNotice"].en));
});