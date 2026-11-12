/**
 * Per-bot git access, task A4: the key store (servers/shared/bot-git/store.js).
 *
 * Everything runs in one scratch CROW_HOME: the keys here are test material in
 * a temp dir and are never committed.
 *
 * Most cases drive generation through a stub execFileImpl that writes files of
 * the real shape (a PEM-shaped private key and a valid ssh-ed25519 public key
 * blob), so the store's own logic — the write recipe, the status read, the mask
 * hook — is tested on any box. One case runs the real ssh-keygen and checks the
 * file modes and the fingerprint against `ssh-keygen -lf`; it skips ONLY when
 * this host has no ssh-keygen binary at all. A host that has the binary and a
 * keygen that fails is a failure, never a skip.
 *
 * The store's write recipe is exercised at its seams: a predictable temp
 * suffix (_setRandomHexForTest) lets a test plant a file or a symlink exactly
 * where the next atomic write will look, and a failing keygen proves a failed
 * generation leaves nothing behind and echoes no stderr.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "bot-git-store-"));
process.env.CROW_HOME = HOME;
const dirs = [HOME];
after(() => { for (const d of dirs) rmScratch(d); });

const S = await import("../servers/shared/bot-git/store.js");
const P = await import("../servers/shared/bot-git/paths.js");
const H = await import("../servers/shared/bot-git/host-keys.js");
const { collectSecretValueSets } = await import("../servers/shared/secret-values-collect.js");
const { maskSecrets } = await import("../servers/shared/secret-mask.js");

const PATH = process.env.PATH || "/usr/bin:/bin";
/** The installer's openssh-client locations for ssh-keygen (store.js's list). */
const SSH_KEYGEN = ["/usr/bin/ssh-keygen", "/bin/ssh-keygen", "/usr/local/bin/ssh-keygen"].find((p) => existsSync(p)) || null;
const noKeygen = SSH_KEYGEN ? false : "no ssh-keygen at /usr/bin, /bin or /usr/local/bin";
const createdAt = "2026-11-12T00:00:00.000Z";
const mode = (p) => statSync(p).mode & 0o777;
/** The real key dir of a bot that has one (the path every reader uses). */
const keyDir = (id) => P.botGitDirReal(id);
/** The real bot-git/ folder (the anchor is created by the first store call). */
function botGitRoot() {
  const r = dirname(P.botGitDirReal("probe"));
  mkdirSync(r, { recursive: true, mode: 0o700 });
  chmodSync(r, 0o700);
  return r;
}

// ---- the stub keygen: files of the real shape, no ssh-keygen needed --------
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

// Built at runtime: a tracked file must never spell a private-key header.
const PEM_BEGIN = "-----BEGIN " + "OPENSSH " + "PRIVATE" + " KEY-----";
const PEM_END = "-----END " + "OPENSSH " + "PRIVATE" + " KEY-----";

/** The argv every stub call saw, newest last. */
const keygenCalls = [];
/**
 * Stand-in for ssh-keygen with the same contract: writes `<f>` and `<f>.pub`.
 * The public key is a real, parseable ssh-ed25519 blob; the private half is a
 * PEM-shaped block whose body lines are long enough to mask.
 */
function stubKeygen(cmd, args, opts) {
  keygenCalls.push({ cmd, args, opts });
  const keyPath = args[args.indexOf("-f") + 1];
  const comment = args[args.indexOf("-C") + 1];
  const seed = createHash("sha256").update(comment).digest()[0];
  const body = Buffer.alloc(96, seed).toString("base64");
  writeFileSync(keyPath, PEM_BEGIN + "\n" + body.slice(0, 64) + "\n" + body.slice(64) + "\n" + PEM_END + "\n", { mode: 0o600 });
  writeFileSync(keyPath + ".pub", "ssh-ed25519 " + syntheticKey("ssh-ed25519", seed) + " " + comment + "\n", { mode: 0o644 });
  return "";
}

/** generate a bot's key through the stub keygen. */
function generate(id, at = createdAt) {
  return S.generateBotKey({ botId: id, createdAt: at, execFileImpl: stubKeygen });
}

test("generateBotKey (real ssh-keygen): 0700 dir, 0600 files, and ssh-keygen -lf agrees", { skip: noKeygen }, () => {
  const id = "gen-real";
  // No try/catch: a host WITH ssh-keygen that cannot generate a key is a real
  // failure (that is how the /proc/self/fd keygen bug shipped), so this throws.
  const out = S.generateBotKey({ botId: id, createdAt });
  assert.match(out.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]{20,} crow-bot:gen-real$/);
  assert.match(out.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);

  const dir = keyDir(id);
  assert.equal(mode(dir), 0o700, "the key dir is 0700");
  for (const name of ["id_ed25519", "id_ed25519.pub", "meta.json", "confirmed_hosts"]) {
    assert.equal(mode(join(dir, name)), 0o600, name + " is 0600");
  }
  assert.equal(lstatSync(join(dir, "id_ed25519")).nlink, 1, "the private key is not hard-linked");

  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  assert.deepEqual(Object.keys(meta).sort(), ["bot_id", "created_at", "fingerprint", "generated_at"]);
  assert.equal(meta.bot_id, id);
  assert.equal(meta.created_at, createdAt);
  assert.equal(meta.fingerprint, out.fingerprint);
  assert.match(meta.generated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  assert.equal(readFileSync(join(dir, "confirmed_hosts"), "utf8"), "", "confirmed_hosts starts empty");

  const lf = execFileSync(SSH_KEYGEN, ["-lf", join(dir, "id_ed25519.pub")], { env: { PATH, LANG: "C" } }).toString("utf8");
  assert.ok(lf.includes(out.fingerprint), "ssh-keygen -lf prints the same fingerprint: " + lf.trim());
  // The comment carries the bot id only, never a host name (it ends up on the forge).
  assert.ok(!out.publicKey.includes("."), "no host-shaped word in the key comment: " + out.publicKey);
});

test("generateBotKey: the fixed ssh-keygen argv, and a temp dir renamed into place", () => {
  const before = keygenCalls.length;
  const out = generate("gen-fixed");
  const call = keygenCalls[before];
  assert.equal(call.cmd, "ssh-keygen");
  assert.deepEqual(call.args.slice(0, 7), ["-q", "-t", "ed25519", "-N", "", "-C", "crow-bot:gen-fixed"]);
  assert.equal(call.args[7], "-f");
  assert.match(call.args[8], /\/bot-git\/\.tmp-gen-fixed-[0-9a-f]{16}\/id_ed25519$/);
  assert.equal(call.args.length, 9, "argv is an array, one flag per element");
  assert.equal(call.opts.timeout, 10_000);
  assert.deepEqual(call.opts.env, { PATH, LANG: "C" }, "no inherited environment reaches ssh-keygen");

  assert.match(out.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ crow-bot:gen-fixed$/);
  assert.equal(out.fingerprint, H.fingerprintOf(out.publicKey.split(/\s+/)[1]));
  const dir = keyDir("gen-fixed");
  assert.equal(mode(dir), 0o700);
  for (const name of ["id_ed25519", "id_ed25519.pub", "meta.json", "confirmed_hosts"]) {
    assert.equal(mode(join(dir, name)), 0o600, name + " is 0600");
  }
  assert.deepEqual(readdirSync(botGitRoot()).filter((n) => n.startsWith(".tmp-gen-fixed")), [], "no temp dir left behind");
});

test("generateBotKey hands ssh-keygen a real, child-visible path (never /proc/self/fd)", () => {
  // ssh-keygen is a CHILD process: it has no fd for the anchored secrets dir,
  // so an anchored /proc/self/fd/<fd>/... argument makes it fail with
  // "Saving key ... failed: No such file or directory". Every argv element
  // must be a path the child can open on its own.
  let seen = null;
  const seeingKeygen = (cmd, args, opts) => {
    const keyPath = args[args.indexOf("-f") + 1];
    const st = lstatSync(dirname(keyPath));      // as the child would open it
    seen = { keyPath, args, st };
    return stubKeygen(cmd, args, opts);
  };
  const out = S.generateBotKey({ botId: "childpath1", createdAt, execFileImpl: seeingKeygen });
  assert.ok(seen, "ssh-keygen ran");
  for (const arg of seen.args) {
    assert.ok(!arg.includes("/proc/self/fd"), "no anchored path in the ssh-keygen argv: " + arg);
  }
  assert.equal(seen.keyPath, seen.args[seen.args.length - 1], "-f takes the last argv element");
  assert.ok(seen.st.isDirectory() && !seen.st.isSymbolicLink(), "the child was pointed at a real directory");
  // A real path: the temp dir under the REAL secrets dir, not the anchor.
  assert.ok(seen.keyPath.startsWith(realpathSync(join(HOME, "secrets")) + "/bot-git/.tmp-childpath1-"), seen.keyPath);
  assert.match(seen.keyPath, /\/bot-git\/\.tmp-childpath1-[0-9a-f]{16}\/id_ed25519$/);
  // The generated key landed where the store reads it (through the anchor).
  assert.equal(S.botKeyStatus("childpath1").on, true);
  assert.equal(S.botKeyStatus("childpath1").fingerprint, out.fingerprint);
});

test("botKeyStatus: on, fingerprint and hosts; nothing it returns carries key material", () => {
  const out = generate("status1");
  const status = S.botKeyStatus("status1");
  assert.equal(status.on, true);
  assert.equal(status.fingerprint, out.fingerprint);
  assert.equal(status.publicKey, out.publicKey);
  assert.equal(status.createdAt, createdAt);
  assert.deepEqual(status.hosts, []);
  const dump = JSON.stringify(status);
  assert.ok(!dump.includes("PRIVATE" + " KEY"), "a status never carries a private key label");
  assert.ok(!dump.includes("-----BEGIN"), "a status never carries a key block");
  // Only the public half is ever read for a status.
  const privateText = readFileSync(join(keyDir("status1"), "id_ed25519"), "utf8");
  for (const line of privateText.split(/\r?\n/).filter((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l))) {
    assert.ok(!dump.includes(line), "no private key body line in a status");
  }
});

test("botKeyStatus: off for a missing key dir, a broken dir and an invalid id", () => {
  assert.equal(S.botKeyStatus("no-such-bot-" + Date.now()).on, false);
  assert.deepEqual(S.botKeyStatus(".."), { on: false, reason: "invalid bot id" });
  assert.equal(S.botKeyStatus(null).on, false);

  generate("broken1");
  const dir = keyDir("broken1");
  writeFileSync(join(dir, "meta.json"), "{ not json", { mode: 0o600 });
  chmodSync(join(dir, "meta.json"), 0o600);
  assert.equal(S.botKeyStatus("broken1").on, false, "an unreadable meta.json is off");

  generate("broken2");
  chmodSync(join(keyDir("broken2"), "id_ed25519"), 0o644);
  assert.equal(S.botKeyStatus("broken2").on, false, "a loose private key mode is off");
});

test("the git key body joins the DISPLAY mask set and never the CARD set", () => {
  generate("mask1");
  const privateText = readFileSync(join(keyDir("mask1"), "id_ed25519"), "utf8");
  const body = privateText.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l));
  assert.ok(body.length >= 2, "an OpenSSH-shaped private key has several body lines");
  const joined = body.join("");
  const longLines = body.filter((l) => l.length >= 40);
  assert.ok(longLines.length >= 1, "at least one body line is long enough to mask on its own");

  const sets = collectSecretValueSets({ dbPath: null });
  assert.ok(sets.display.includes(joined), "the joined key body is a display value");
  for (const line of longLines) assert.ok(sets.display.includes(line), "a key body line is a display value");
  assert.equal(sets.card.includes(joined), false, "never a card value (every bot's pi receives that set)");
  for (const line of longLines) assert.equal(sets.card.includes(line), false);

  const masked = maskSecrets("x " + joined + " y", { values: sets.display });
  assert.ok(!masked.includes(joined), "the joined body is masked");
  assert.ok(!masked.includes(joined.slice(0, 48)), "no long fragment of it survives");
  const maskedLine = maskSecrets("ssh said " + longLines[0] + " here", { values: sets.display });
  assert.ok(!maskedLine.includes(longLines[0]), "a body line printed with line breaks is masked too");

  assert.ok(Array.isArray(S.botGitSecretValues()));
  assert.ok(S.botGitSecretValues().includes(joined));
});

test("a key tightened to 0400 is still masked (noGroupOther, like checkKeyDir)", () => {
  // The masking reader used to demand exactly 0600, so a key an owner hardened to
  // 0400 stayed unmasked while still enabling git. Any mode without group/other
  // bits counts now (the same rule checkKeyDir applies).
  const id = "mask0400";
  generate(id);
  const keyPath = join(keyDir(id), "id_ed25519");
  chmodSync(keyPath, 0o400);
  try {
    assert.equal(mode(keyPath), 0o400);
    const body = readFileSync(keyPath, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l));
    const joined = body.join("");
    assert.ok(joined.length >= 6);
    assert.ok(S.botGitSecretValues().includes(joined), "a 0400 key is a key that enables git");
    assert.ok(collectSecretValueSets({ dbPath: null }).display.includes(joined), "and it reaches the display set");
  } finally {
    chmodSync(keyPath, 0o600);
  }
});

test("botGitSecretValues reads the env it is given, not this process's", () => {
  // collectSecretValueSets({ env }) collects for the env it was handed; the key
  // store must be read from that env's secrets dir, not from process.env's.
  const otherHome = mkdtempSync(join(tmpdir(), "bot-git-store-otherhome-"));
  dirs.push(otherHome);
  const secrets = join(otherHome, "secrets");
  const root = join(secrets, "bot-git");
  const dir = join(root, "envbot1");
  for (const d of [secrets, root, dir]) { mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); }
  const joined = "E".repeat(64);
  writeFileSync(join(dir, "id_ed25519"), PEM_BEGIN + "\n" + joined.slice(0, 32) + "\n" + joined.slice(32) + "\n" + PEM_END + "\n", { mode: 0o600 });
  chmodSync(join(dir, "id_ed25519"), 0o600);

  const otherEnv = { ...process.env, CROW_HOME: otherHome };
  assert.ok(S.botGitSecretValues(otherEnv).includes(joined), "the env's key store is read");
  assert.ok(collectSecretValueSets({ env: otherEnv, dbPath: null }).display.includes(joined), "collectSecretValueSets passes its env through");
  // This process's own store (CROW_HOME=HOME) does not hold that key: an
  // implementation reading process.env would find nothing here.
  assert.equal(S.botGitSecretValues().includes(joined), false);
  assert.equal(collectSecretValueSets({ dbPath: null }).display.includes(joined), false);
});

test("the atomic write recipe: a planted temp name fails EEXIST and leaves the target alone", () => {
  generate("tmpname1");
  const dir = keyDir("tmpname1");
  assert.deepEqual(S.writeSpawnFiles({ botId: "tmpname1", displayName: "A bot" }), { ok: true });
  const before = readFileSync(join(dir, "known_hosts"), "utf8");

  S._setRandomHexForTest(() => "0123456789abcdef");
  try {
    writeFileSync(join(dir, ".known_hosts.0123456789abcdef"), "planted\n", { mode: 0o600 });
    assert.deepEqual(S.writeSpawnFiles({ botId: "tmpname1", displayName: "A bot" }), { ok: false, reason: "known_hosts cannot be written" });
    assert.equal(readFileSync(join(dir, "known_hosts"), "utf8"), before, "the target is unchanged");
  } finally {
    S._setRandomHexForTest(null);
  }

  // A symlink planted at the temp name is never written through (O_EXCL|O_NOFOLLOW).
  const outside = join(botGitRoot(), "outside.txt");
  writeFileSync(outside, "untouched\n");
  S._setRandomHexForTest(() => "feedfeedfeedfeed");
  try {
    symlinkSync(outside, join(dir, ".known_hosts.feedfeedfeedfeed"));
    assert.equal(S.writeSpawnFiles({ botId: "tmpname1", displayName: "A bot" }).ok, false);
    assert.equal(readFileSync(outside, "utf8"), "untouched\n", "the symlink target is never written");
    assert.equal(readFileSync(join(dir, "known_hosts"), "utf8"), before);
    assert.equal(existsSync(join(dir, ".known_hosts.feedfeedfeedfeed")), false, "the planted link is removed, not followed");
  } finally {
    S._setRandomHexForTest(null);
  }

  // A planted temp name in the keygen dir fails generation and leaves no key dir.
  generate("tmpgen1");
  const root = botGitRoot();
  S._setRandomHexForTest(() => "abcabcabcabcabca");
  try {
    writeFileSync(join(root, ".tmp-tmpgen2-abcabcabcabcabca"), "in the way\n");
    assert.throws(() => generate("tmpgen2"), /cannot be generated/);
    assert.equal(existsSync(join(root, "tmpgen2")), false);
  } finally {
    S._setRandomHexForTest(null);
  }
});

test("writeSpawnFiles: known_hosts is the pinned set plus confirmed hosts, gitconfig is the fixed identity", () => {
  const id = "spawn1";
  generate(id);
  const key = syntheticKey("ssh-ed25519");
  const added = S.addConfirmedHost(id, { host: "git.example.org", port: 2222, type: "ssh-ed25519", key });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.deepEqual(added.hosts, [{ host: "git.example.org", port: 2222, type: "ssh-ed25519", fingerprint: H.fingerprintOf(key) }]);

  assert.deepEqual(S.writeSpawnFiles({ botId: id, displayName: 'Bøt "quoted"' }), { ok: true });
  const dir = keyDir(id);
  const lines = readFileSync(join(dir, "known_hosts"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 4, "3 pinned GitHub lines + 1 confirmed");
  assert.equal(lines.filter((l) => l.startsWith("github.com ")).length, 3);
  assert.ok(lines.includes("[git.example.org]:2222 ssh-ed25519 " + key));
  assert.equal(mode(join(dir, "known_hosts")), 0o600);

  const cfg = readFileSync(join(dir, "gitconfig"), "utf8");
  assert.match(cfg, /^\[user\]$/m);
  assert.ok(cfg.includes('name = "Bøt \\"quoted\\" (Crow bot)"'), cfg);
  assert.ok(cfg.includes("email = noreply+" + id + "@crow-bot.invalid"), cfg);
  assert.equal(mode(join(dir, "gitconfig")), 0o600);
  assert.equal(S.writeSpawnFiles({ botId: "ghost", displayName: "x" }).ok, false);
});

test("add/removeConfirmedHost: dedupe, ports, and every host rule applied", () => {
  const id = "hosts1";
  generate(id);
  const key = syntheticKey("ssh-ed25519");

  assert.equal(S.addConfirmedHost(id, { host: "git.example.org", type: "ssh-ed25519", key }).ok, true);
  assert.equal(S.addConfirmedHost(id, { host: "Git.Example.ORG", port: 22, type: "ssh-ed25519", key }).ok, true, "a repeat confirm");
  let status = S.botKeyStatus(id);
  assert.equal(status.hosts.length, 1, "a repeated confirm does not grow the file");
  assert.equal(status.hosts[0].port, 22);
  assert.equal(status.hosts[0].fingerprint, H.fingerprintOf(key));

  assert.equal(S.addConfirmedHost(id, { host: "git.example.org", port: 2222, type: "ssh-ed25519", key }).ok, true);
  status = S.botKeyStatus(id);
  assert.deepEqual(status.hosts.map((h) => h.port).sort(), [22, 2222]);
  assert.equal(mode(join(keyDir(id), "confirmed_hosts")), 0o600);

  // Every refusal: a pinned host, an unconfirmable host, a command-shaped
  // "host", a key blob that is not the type it claims, and a marker line.
  const refused = [
    { host: "github.com", type: "ssh-ed25519", key },
    { host: "ssh.github.com", type: "ssh-ed25519", key },
    { host: "localhost", type: "ssh-ed25519", key },
    { host: "127.0.0.1", type: "ssh-ed25519", key },
    { host: "-oProxyCommand=touch /tmp/x", type: "ssh-ed25519", key },
    { host: "100.64.20.7", port: 0, type: "ssh-ed25519", key },
    { host: "git.example.org", type: "ssh-ed25519", key: syntheticKey("ssh-rsa") },
    { host: "@cert-authority git.example.org", type: "ssh-ed25519", key },
    { host: "git.example.org", type: "ssh-dss", key: syntheticKey("ssh-dss") },
    { host: "git.example.org", type: "ssh-ed25519", key: "not base64!" },
  ];
  const before = readFileSync(join(keyDir(id), "confirmed_hosts"), "utf8");
  for (const bad of refused) {
    assert.equal(S.addConfirmedHost(id, bad).ok, false, "refused: " + JSON.stringify(bad.host));
  }
  assert.equal(readFileSync(join(keyDir(id), "confirmed_hosts"), "utf8"), before, "a refusal writes nothing");

  const removed = S.removeConfirmedHost(id, "git.example.org", 2222);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.hosts.map((h) => h.port), [22]);
  assert.deepEqual(S.removeConfirmedHost(id, "github.com").ok, false);
  assert.deepEqual(S.removeConfirmedHost("..", "git.example.org").ok, false);
});

test("generateBotKey refuses a second key, and removeBotKey returns the fingerprint it read first", () => {
  const id = "remove1";
  const out = generate(id);
  assert.throws(() => generate(id), /already exists/);

  const dir = keyDir(id);
  const r = S.removeBotKey(id);
  assert.deepEqual(Object.keys(r).sort(), ["fingerprint", "removed"]);
  assert.equal(r.removed, true);
  assert.equal(r.fingerprint, out.fingerprint);
  assert.equal(existsSync(dir), false);
  assert.equal(S.botKeyStatus(id).on, false);

  assert.deepEqual(S.removeBotKey(id), { removed: false, fingerprint: null });
  assert.deepEqual(S.removeBotKey(".."), { removed: false, fingerprint: null });
});

test("generateBotKey replaces a key dir made for ANOTHER bot row, and only that one (C5 create guard)", () => {
  const id = "stale-guard";
  const rowAt = "2026-01-01 00:00:00";
  const recreatedAt = "2026-02-02 00:00:00";
  generate(id, rowAt);

  // Same row timestamp: this IS the bot's key — never replaced, the owner's
  // deploy key on the forge is the old public half.
  assert.throws(() => generate(id, rowAt), /already exists/);
  assert.equal(S.botKeyStatus(id).on, true);
  assert.equal(JSON.parse(readFileSync(join(keyDir(id), "meta.json"), "utf8")).created_at, rowAt);

  // A recreated bot with the same recycled id: the leftover dir carries another
  // row's created_at, so no spawn would use it (the spawn side refuses the
  // mismatch on its own) — it is housekeeping, and it is replaced. The old
  // public fingerprint comes back, so the owner can be told which deploy key on
  // the forge is now dead.
  const oldFp = S.botKeyStatus(id).fingerprint;
  const made = generate(id, recreatedAt);
  assert.equal(made.replacedFingerprint, oldFp, "the replaced dir's own fingerprint is reported");
  const meta = JSON.parse(readFileSync(join(keyDir(id), "meta.json"), "utf8"));
  assert.equal(meta.created_at, recreatedAt, "the stale dir was replaced with one for THIS row");
  assert.equal(meta.bot_id, id);
  assert.equal(S.botKeyStatus(id).on, true);

  // A caller with no row timestamp has nothing to compare, so freshness cannot
  // be established and the plain refusal stays (fail closed).
  assert.throws(() => generate(id, null), /already exists/);
  assert.throws(() => generate(id, ""), /already exists/);

  // A fresh key never reports a replaced fingerprint.
  const plain = generate("fresh-fp");
  assert.equal(plain.replacedFingerprint, null);
  S.removeBotKey("fresh-fp");            // leave no extra key dir for the sweep tests

  // A key dir with no usable meta.json belongs to no row at all, so it is stale
  // for a caller that does know its row.
  rmSync(join(keyDir(id), "meta.json"));
  generate(id, "2026-03-03 00:00:00");
  assert.equal(JSON.parse(readFileSync(join(keyDir(id), "meta.json"), "utf8")).created_at, "2026-03-03 00:00:00");
});

test("a failing keygen leaves no key dir and no temp dir, and echoes no stderr", () => {
  const id = "failbot1";
  const root = botGitRoot();
  const exploding = () => {
    throw Object.assign(new Error("Command failed: ssh-keygen -q"), { code: "ENOENT", stderr: "SECRET-STDERR-LINE" });
  };
  assert.throws(() => S.generateBotKey({ botId: id, createdAt, execFileImpl: exploding }), (err) => {
    assert.match(err.message, /ssh-keygen failed/);
    assert.ok(!err.message.includes("SECRET-STDERR-LINE"), "ssh-keygen stderr is never echoed");
    assert.ok(!err.message.includes("Command failed"), "the raw command error is not echoed");
    return true;
  });
  assert.equal(existsSync(join(root, id)), false, "no key dir");
  assert.deepEqual(readdirSync(root).filter((n) => n.startsWith(".tmp-" + id)), [], "no temp dir left behind");

  // A keygen that writes nothing at all is the same refusal.
  assert.throws(() => S.generateBotKey({ botId: "failbot2", createdAt, execFileImpl: () => "" }), /did not write/);
  assert.equal(existsSync(join(root, "failbot2")), false);
});

test("sweepOrphanKeys: removes unowned key dirs and stale temps only", () => {
  generate("sweep-a");
  generate("sweep-b");
  const root = botGitRoot();
  writeFileSync(join(root, "stray.txt"), "not a key dir");
  mkdirSync(join(root, "-bad"), { mode: 0o700 });
  const stale = join(root, ".tmp-sweep-old");
  mkdirSync(stale, { mode: 0o700 });
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  const fresh = join(root, ".tmp-sweep-new");
  mkdirSync(fresh, { mode: 0o700 });

  // Every key dir in this scratch home is owned by a live bot except sweep-b.
  const live = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "sweep-b" && e.name !== "-bad" && !e.name.startsWith(".tmp-"))
    .map((e) => e.name);
  assert.ok(live.includes("sweep-a"));
  assert.deepEqual(S.sweepOrphanKeys(live), ["sweep-b"]);
  assert.equal(existsSync(join(root, "sweep-a")), true);
  assert.equal(existsSync(join(root, "sweep-b")), false);
  assert.equal(existsSync(join(root, "stray.txt")), true, "a stray file is not a key dir");
  assert.equal(existsSync(join(root, "-bad")), true, "an invalid id is left alone");
  assert.equal(existsSync(stale), false, "a stale temp dir is removed");
  assert.equal(existsSync(fresh), true, "a fresh temp dir is not");

  assert.deepEqual(S.sweepOrphanKeys(null), [], "not an array: nothing is removed");
  assert.deepEqual(S.sweepOrphanKeys(undefined), []);
  assert.equal(existsSync(join(root, "sweep-a")), true);
});

test("runBotGitOrphanSweep (boot): a DB error or a bad row shape removes nothing; a real list sweeps", async () => {
  const { runBotGitOrphanSweep } = await import("../servers/gateway/boot/post-listen.js");
  generate("boot-kept");
  const keptDir = keyDir("boot-kept");
  assert.equal(existsSync(keptDir), true);

  // The bot list could not be read: an empty read must never mean "no bots
  // exist", which would delete every key dir on the box.
  const boom = () => ({ execute: () => { throw new Error("db is down"); } });
  assert.equal(await runBotGitOrphanSweep(boom), 0);
  assert.equal(existsSync(keptDir), true, "a failed read removes nothing");
  assert.equal(await runBotGitOrphanSweep(() => { throw new Error("no db handle"); }), 0);
  assert.equal(existsSync(keptDir), true, "a factory that throws removes nothing");
  assert.equal(await runBotGitOrphanSweep(() => ({ execute: async () => ({ rows: "nope" }), close() {} })), 0);
  assert.equal(existsSync(keptDir), true, "a shape we do not understand removes nothing");

  // A successful read sweeps: everything this scratch home lists as live stays,
  // and the one id the DB does not know is removed.
  const root = botGitRoot();
  const live = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".tmp-") && e.name !== "boot-kept" && P.isValidGitBotId(e.name))
    .map((e) => e.name);
  const removed = await runBotGitOrphanSweep(() => ({
    execute: async () => ({ rows: live.map((bot_id) => ({ bot_id })) }),
    close() {},
  }));
  assert.equal(removed, 1);
  assert.equal(existsSync(keptDir), false, "an orphan key dir is removed once the bot list is known");
  const otherDirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".tmp-") && P.isValidGitBotId(e.name))
    .map((e) => e.name);
  assert.deepEqual(otherDirs.sort(), [...live].sort(), "a live bot's key dir is never touched");

  // An instance that never turned git on has no key store: nothing is swept,
  // and the sweep does not create the secrets dir (or its anchor) just to look.
  const emptyHome = mkdtempSync(join(tmpdir(), "bot-git-empty-"));
  dirs.push(emptyHome);
  const prevHome = process.env.CROW_HOME;
  process.env.CROW_HOME = emptyHome;
  try {
    assert.equal(await runBotGitOrphanSweep(() => ({ execute: async () => ({ rows: [] }), close() {} })), 0);
    assert.equal(existsSync(join(emptyHome, "secrets")), false, "no secrets dir is created by the sweep");
  } finally {
    process.env.CROW_HOME = prevHome;
  }
});

test("runBotGitOrphanSweep (boot): a successful read that lists ZERO bots removes nothing", async () => {
  const { runBotGitOrphanSweep } = await import("../servers/gateway/boot/post-listen.js");
  generate("boot-zero");
  const kept = keyDir("boot-zero");
  assert.equal(existsSync(kept), true);

  // A fresh or re-initialised crow.db, or a dev gateway pointed at another
  // CROW_DB_PATH, answers zero rows while the key store on disk belongs to the
  // real one: an empty list must never be read as "no bots exist".
  assert.equal(await runBotGitOrphanSweep(() => ({ execute: async () => ({ rows: [] }), close() {} })), 0);
  assert.equal(existsSync(kept), true, "an empty bot list removes nothing");
  rmSync(kept, { recursive: true, force: true });
});

test("runBotGitOrphanSweep (boot): a list whose only row is the voice bot removes nothing", async () => {
  const { runBotGitOrphanSweep } = await import("../servers/gateway/boot/post-listen.js");
  const { CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js");
  generate("boot-voice-kept");
  const kept = keyDir("boot-voice-kept");
  assert.equal(existsSync(kept), true);

  // ensureVoiceBot seeds crow.voice into a fresh DB at boot, BEFORE this sweep
  // runs, so a DB with nothing else in it answers exactly one row. The voice bot
  // never holds a key, so that row must not be read as "one live bot exists" with
  // every real key dir an orphan.
  const onlyVoice = () => ({ execute: async () => ({ rows: [{ bot_id: CROW_VOICE_BOT_ID }] }), close() {} });
  assert.equal(await runBotGitOrphanSweep(onlyVoice), 0, "nothing is removed and nothing is reported");
  assert.equal(existsSync(kept), true, "a real bot's key dir survives the voice bot's row");
  rmSync(kept, { recursive: true, force: true });
});

test("a symlink at bot-git/<id> is refused by every function and nothing outside is touched", () => {
  const id = "linkbot1";
  const root = botGitRoot();
  const outside = mkdtempSync(join(tmpdir(), "bot-git-store-outside-"));
  dirs.push(outside);
  // A file a reader that followed the link would take for a victim's key.
  const leakLine = "Q".repeat(64);
  writeFileSync(join(outside, "id_ed25519"), PEM_BEGIN + "\n" + leakLine + "\n" + PEM_END + "\n", { mode: 0o600 });
  chmodSync(join(outside, "id_ed25519"), 0o600);
  const link = join(root, id);
  symlinkSync(outside, link);

  assert.equal(S.botKeyStatus(id).on, false);
  assert.deepEqual(S.removeBotKey(id), { removed: false, fingerprint: null });
  assert.equal(S.addConfirmedHost(id, { host: "git.example.org", type: "ssh-ed25519", key: syntheticKey("ssh-ed25519") }).ok, false);
  assert.equal(S.removeConfirmedHost(id, "git.example.org").ok, false);
  assert.equal(S.writeKnownHosts(id).ok, false);
  assert.equal(S.writeSpawnFiles({ botId: id, displayName: "x" }).ok, false);
  assert.throws(() => generate(id), /already exists/);
  assert.ok(!S.sweepOrphanKeys(["sweep-a"]).includes(id), "a symlink is not a key dir to remove");
  assert.ok(!S.botGitSecretValues().some((v) => v.includes(leakLine)), "a symlinked key dir is never read for masking");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is still there");
  assert.ok(readFileSync(join(outside, "id_ed25519"), "utf8").includes(leakLine), "the target is untouched");
});

test("sshToolsAvailable reports each tool and its missing list", () => {
  const r = S.sshToolsAvailable();
  assert.deepEqual(Object.keys(r).sort(), ["missing", "ok"]);
  assert.ok(Array.isArray(r.missing));
  assert.equal(r.ok, r.missing.length === 0);
  assert.equal(new Set(r.missing).size, r.missing.length, "no duplicate entries");
  for (const name of r.missing) assert.ok(["ssh", "ssh-keygen", "ssh-keyscan"].includes(name), name);
});

test("every entry point refuses an invalid bot id", () => {
  const bad = ["..", "a/b", "", null, 7];
  for (const id of bad) {
    assert.throws(() => S.generateBotKey({ botId: id, createdAt, execFileImpl: stubKeygen }), /invalid bot id/, String(id));
    assert.equal(S.botKeyStatus(id).on, false, String(id));
    assert.deepEqual(S.removeBotKey(id), { removed: false, fingerprint: null }, String(id));
    assert.equal(S.addConfirmedHost(id, { host: "git.example.org", type: "ssh-ed25519", key: syntheticKey("ssh-ed25519") }).ok, false, String(id));
    assert.equal(S.removeConfirmedHost(id, "git.example.org").ok, false, String(id));
    assert.equal(S.writeSpawnFiles({ botId: id, displayName: "x" }).ok, false, String(id));
    assert.equal(S.writeKnownHosts(id).ok, false, String(id));
  }
});