/**
 * Per-bot git access, task A3: the commit identity Crow generates for a bot.
 *
 * The load-bearing assertions:
 *   - the address is always noreply+<bot_id>@crow-bot.invalid, whatever the
 *     environment says (the operator's R6 ruling: the domain never names the
 *     instance, its host, its tailnet or its gateway URL);
 *   - identity.js reads no environment and imports neither node:os nor the
 *     gateway's self-address helper — checked by reading its source;
 *   - a hostile display name cannot add a config section or a `sshCommand`
 *     line (and git itself parses the result into exactly two keys).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const dirs = [];
after(() => { for (const d of dirs) rmScratch(d); });

const I = await import("../servers/shared/bot-git/identity.js");
// Task A4 (the key store that writes the spawn files) is built.
const A4 = await import("../servers/shared/bot-git/store.js");

const SRC = readFileSync(new URL("../servers/shared/bot-git/identity.js", import.meta.url), "utf8");

function scratchDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function nameIn(text) {
  const m = /\tname = "(.*) \(Crow bot\)"\n/.exec(text);
  assert.ok(m, "the config has a quoted name line: " + JSON.stringify(text));
  return m[1];
}

let git = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore", env: { PATH: process.env.PATH } });
} catch {
  git = false;
}
const noGit = git ? false : "git is not available on this host";

test("noReplyEmail: the fixed, never-deliverable address", () => {
  assert.equal(I.NOREPLY_DOMAIN, "crow-bot.invalid");
  assert.equal(I.noReplyEmail({ botId: "b1" }), "noreply+b1@crow-bot.invalid");
  assert.equal(I.noReplyEmail({ botId: "bot.1" }), "noreply+bot.1@crow-bot.invalid");
  for (const bad of ["", ".", "..", "a/b", "-x", "a b", null, undefined, 5]) {
    assert.throws(() => I.noReplyEmail({ botId: bad }), /invalid bot id/, String(bad));
  }
});

test("R6: the commit address never carries the instance's host", () => {
  // The host-shaped placeholders a real gateway environment holds.
  withEnv({
    CROW_GATEWAY_URL: "https://crow.example.ts.net:8444",
    CROW_OAUTH_ISSUER_URL: "https://sso.example.test:9443",
  }, () => {
    const forbidden = ["crow.example", "example.ts.net", "ts.net", "sso.example", "9443"];
    const host = hostname().toLowerCase();
    if (host && host.length >= 4 && !"crow-bot.invalid".includes(host)) forbidden.push(host);
    for (const botId of ["b1", "road-runner", "bot.1", "A1"]) {
      const mail = I.noReplyEmail({ botId });
      assert.equal(mail, "noreply+" + botId + "@crow-bot.invalid");
      assert.ok(mail.endsWith("@crow-bot.invalid"));
      assert.equal(mail.split("@")[1], I.NOREPLY_DOMAIN, "the domain is fixed, not resolved");
      for (const bad of forbidden) {
        assert.ok(!mail.toLowerCase().includes(bad), "the address must not contain " + bad);
      }
      const text = I.gitconfigText({ displayName: "Runner", botId });
      assert.ok(text.includes("email = " + mail), "the default email is the no-reply address");
      for (const bad of forbidden) assert.ok(!text.toLowerCase().includes(bad), "the config must not contain " + bad);
    }
  });
});

test("identity.js reads no environment and no host source", () => {
  assert.ok(!/self-dial-address/.test(SRC), "must not import the gateway's self-address helper");
  assert.ok(!/["']node:os["']/.test(SRC), "must not import node:os");
  assert.ok(!/require\(\s*["']os["']\s*\)/.test(SRC));
  assert.ok(!/\bhomedir\s*\(/.test(SRC));
  assert.ok(!/\bhostname\s*\(/.test(SRC));
  assert.ok(!/process\.env/.test(SRC), "the address is decided by the ruling, not by the environment");
  assert.ok(!/CROW_GATEWAY_URL|CROW_OAUTH_ISSUER_URL/.test(SRC));
});

test("gitconfigText: the generated [user] block", () => {
  const text = I.gitconfigText({ displayName: "Ada", botId: "b1" });
  assert.equal(text, '[user]\n\tname = "Ada (Crow bot)"\n\temail = noreply+b1@crow-bot.invalid\n');
  assert.equal(nameIn(text), "Ada");
  // There is no caller-supplied email (security review, PR A): a host-based one
  // throws instead of landing in the config, and the only value accepted is the
  // fixed address itself.
  assert.throws(() => I.gitconfigText({ displayName: "Ada", botId: "b1", email: "ada@example.com" }), /commit address is fixed/);
  assert.equal(I.gitconfigText({ displayName: "Ada", botId: "b1", email: I.noReplyEmail({ botId: "b1" }) }), text);
});

test("gitconfigText: the display name is sanitised, escaped, capped, and never empty", () => {
  // control characters (a newline could start a line) are removed
  assert.equal(nameIn(I.gitconfigText({ displayName: "a\nb\tc\r", botId: "b1" })), "abc");
  // quotes and backslashes are escaped for git's double-quoted value
  assert.equal(nameIn(I.gitconfigText({ displayName: 'a "quoted" \\ name', botId: "b1" })), 'a \\"quoted\\" \\\\ name');
  // empty, whitespace-only and non-string names fall back to the bot id
  for (const empty of ["", "   ", "\n\t", null, undefined, 42]) {
    assert.equal(nameIn(I.gitconfigText({ displayName: empty, botId: "bot.1" })), "bot.1", String(empty));
  }
  // 100 characters at most, and the cap never splits an escape
  const long = nameIn(I.gitconfigText({ displayName: "n".repeat(400), botId: "b1" }));
  assert.equal(long.length, 100);
  const boundary = nameIn(I.gitconfigText({ displayName: "a".repeat(99) + '"x', botId: "b1" }));
  assert.equal(boundary, "a".repeat(99), "a dangling backslash would escape the closing quote");
  assert.ok(!boundary.endsWith("\\"));
  // The cap never splits a UTF-16 surrogate pair: half a character is not text.
  const pairAtCut = nameIn(I.gitconfigText({ displayName: "a".repeat(99) + "😀" + "tail", botId: "b1" }));
  assert.equal(pairAtCut, "a".repeat(99), "the emoji straddling the cut is dropped whole");
  assert.ok(!/[\uD800-\uDBFF]$/.test(pairAtCut), "no lone high surrogate at the end");
  const pairJustInside = nameIn(I.gitconfigText({ displayName: "a".repeat(98) + "😀" + "tail", botId: "b1" }));
  assert.equal(pairJustInside, "a".repeat(98) + "😀", "a pair wholly inside the cap is kept");
  assert.equal(pairJustInside.length, 100);
  assert.equal(nameIn(I.gitconfigText({ displayName: "😀".repeat(60), botId: "b1" })), "😀".repeat(50));
});

test("gitconfigText: the commit address is not a caller's choice", () => {
  const fixed = "noreply+b1@crow-bot.invalid";
  for (const email of [
    "", "ada@example.com", "no-at-sign", "a b@c", "user@host\nx", "user@@host", "noreply+b1@crow-bot.invalid.evil", "<a@b>", 5,
  ]) {
    assert.throws(() => I.gitconfigText({ displayName: "Ada", botId: "b1", email }), /commit address is fixed/, JSON.stringify(email));
  }
  // The fixed address itself is the one accepted value (a caller echoing it back).
  assert.equal(
    I.gitconfigText({ displayName: "Ada", botId: "b1", email: fixed }),
    I.gitconfigText({ displayName: "Ada", botId: "b1" }),
  );
  assert.throws(() => I.gitconfigText({ displayName: "Ada", botId: ".." }), /invalid bot id/);
  assert.throws(() => I.gitconfigText({ displayName: "Ada" }), /invalid bot id/);
});

test("a hostile display name cannot add a section or a sshCommand line", () => {
  const hostile = 'x"\n[core]\n\tsshCommand = evil';
  const text = I.gitconfigText({ displayName: hostile, botId: "b1" });
  const lines = text.split("\n");
  for (const l of lines) {
    const trimmed = l.trimStart();
    if (trimmed.startsWith("[")) assert.equal(trimmed, "[user]", "the only section header");
    assert.ok(!/^sshCommand\s*=/.test(trimmed), "no sshCommand key line: " + JSON.stringify(l));
  }
  assert.equal(lines.filter((l) => l.trimStart().startsWith("[")).length, 1, "exactly one section header");
  // The hostile text survives INSIDE the quoted value, escaped, and nowhere else.
  assert.equal(nameIn(text), 'x\\"[core]sshCommand = evil');
  assert.ok(!/^\[core\]/m.test(text));
});

test("git config reads the generated file as exactly user.name and user.email", { skip: noGit }, () => {
  const dir = scratchDir("bot-git-gitconfig-");
  const cases = [
    ["Ada", "Ada"],
    ['x"\n[core]\n\tsshCommand = evil', 'x"[core]sshCommand = evil'],
    ['a "quoted" \\ name', 'a "quoted" \\ name'],
    ["a".repeat(99) + '"x', "a".repeat(99)],
  ];
  for (const [displayName, wantName] of cases) {
    const file = join(dir, "gitconfig");
    writeFileSync(file, I.gitconfigText({ displayName, botId: "b1" }), { mode: 0o600 });
    const out = execFileSync("git", ["config", "--file", file, "--list"], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", LANG: "C" },
    });
    const entries = out.trimEnd().split("\n");
    assert.deepEqual(entries.map((l) => l.slice(0, l.indexOf("="))).sort(), ["user.email", "user.name"],
      "only the two keys, for name " + JSON.stringify(displayName));
    assert.equal(entries.find((l) => l.startsWith("user.email=")).slice("user.email=".length), "noreply+b1@crow-bot.invalid");
    const value = entries.find((l) => l.startsWith("user.name=")).slice("user.name=".length);
    assert.equal(value, wantName + " (Crow bot)", "git reads back the sanitised name: " + JSON.stringify(displayName));
    assert.ok(!/[\r\n]/.test(value));
  }
});

// Task A4 lands writeSpawnFiles (the key dir writer) in this folder; this check
// drives it with its real signature. The key dir is built by hand (no
// ssh-keygen needed here; the real-binary cases live in bot-git-store.test.js),
// with the exact shape botKeyStatus accepts.
/** A public-key blob shaped the way ssh writes one: <len><type><len><bytes>. */
function syntheticKey(type, fill = 0x5a) {
  const label = Buffer.from(type, "latin1");
  const body = Buffer.alloc(32, fill);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(label.length);
  const blen = Buffer.alloc(4);
  blen.writeUInt32BE(body.length);
  return Buffer.concat([len, label, blen, body]).toString("base64");
}

/** A key dir as generateBotKey leaves it, built without running ssh-keygen. */
function makeKeyDir(home, botId) {
  const secrets = join(home, "secrets");
  const root = join(secrets, "bot-git");
  const dir = join(root, botId);
  for (const d of [secrets, root, dir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
  const keyName = join(dir, "id_ed25519");
  // Built at runtime: a tracked file must never spell a private-key header.
  const begin = "-----BEGIN " + "OPENSSH " + "PRIVATE" + " KEY-----";
  const end = "-----END " + "OPENSSH " + "PRIVATE" + " KEY-----";
  writeFileSync(keyName, begin + "\n" + "Q".repeat(64) + "\n" + end + "\n");
  chmodSync(keyName, 0o600);
  const pub = join(dir, "id_ed25519.pub");
  writeFileSync(pub, "ssh-ed25519 " + syntheticKey("ssh-ed25519") + " crow-bot:" + botId + "\n");
  chmodSync(pub, 0o600);
  const meta = join(dir, "meta.json");
  writeFileSync(meta, JSON.stringify({ bot_id: botId, created_at: null, fingerprint: "SHA256:x", generated_at: "2026-11-12T00:00:00.000Z" }) + "\n");
  chmodSync(meta, 0o600);
  const confirmed = join(dir, "confirmed_hosts");
  writeFileSync(confirmed, "");
  chmodSync(confirmed, 0o600);
  return dir;
}

test("the gitconfig writeSpawnFiles writes carries the same host-free email", () => {
  const home = scratchDir("bot-git-spawnfiles-");
  const botId = "b1";
  const dir = makeKeyDir(home, botId);
  const result = withEnv({ CROW_HOME: home }, () => A4.writeSpawnFiles({ botId, displayName: "Runner" }));
  assert.deepEqual(result, { ok: true });
  const config = readFileSync(join(dir, "gitconfig"), "utf8");
  assert.ok(config.includes("[user]"), "a gitconfig was produced: " + JSON.stringify(config));
  assert.ok(config.includes("email = " + I.noReplyEmail({ botId })), "the generated config has the bot's no-reply address");
  assert.ok(!/crow\.example|ts\.net|sso\.example/i.test(config), "no instance host in the generated config");
  // A caller-supplied email is not a parameter any more: it cannot reach the file.
  const again = withEnv({ CROW_HOME: home }, () => A4.writeSpawnFiles({ botId, displayName: "Runner", email: "runner@example.com" }));
  assert.deepEqual(again, { ok: true });
  const supplied = readFileSync(join(dir, "gitconfig"), "utf8");
  assert.ok(supplied.includes("email = " + I.noReplyEmail({ botId })), "the fixed address is still the one written");
  assert.ok(!supplied.includes("runner@example.com"), "a caller's address never lands in the config");
  // The same call also writes known_hosts (the pinned set), so one spawn call
  // leaves both generated files behind.
  const knownHosts = readFileSync(join(dir, "known_hosts"), "utf8");
  assert.ok(knownHosts.includes("github.com "), "known_hosts was written too");
});