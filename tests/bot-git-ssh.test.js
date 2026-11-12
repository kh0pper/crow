/**
 * Per-bot git access, task A5: the ssh helpers (servers/shared/bot-git/ssh.js).
 *
 * No network: every ssh and ssh-keyscan call goes through an injected
 * execFileImpl stub, and the argv each one receives is asserted exactly. The
 * key material used here is a stub-generated pair in a scratch CROW_HOME —
 * never committed, and the private half is read only to prove the excerpt
 * scrub masks it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "bot-git-ssh-"));
process.env.CROW_HOME = HOME;
const dirs = [HOME];
after(() => { for (const d of dirs) rmScratch(d); });

const Ssh = await import("../servers/shared/bot-git/ssh.js");
const S = await import("../servers/shared/bot-git/store.js");
const P = await import("../servers/shared/bot-git/paths.js");
const H = await import("../servers/shared/bot-git/host-keys.js");

const PATH = process.env.PATH || "/usr/bin:/bin";

/** A public-key blob shaped the way ssh writes one. */
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

/**
 * A stub ssh-keygen: writes a PEM-shaped private key and a real ssh-ed25519
 * public key blob, so this file needs no executable from the host.
 */
function stubKeygen(cmd, args) {
  const keyPath = args[args.indexOf("-f") + 1];
  const comment = args[args.indexOf("-C") + 1];
  const seed = createHash("sha256").update(comment).digest()[0];
  const body = Buffer.alloc(96, seed).toString("base64");
  writeFileSync(keyPath, PEM_BEGIN + "\n" + body.slice(0, 64) + "\n" + body.slice(64) + "\n" + PEM_END + "\n", { mode: 0o600 });
  writeFileSync(keyPath + ".pub", "ssh-ed25519 " + syntheticKey("ssh-ed25519", seed) + " " + comment + "\n", { mode: 0o644 });
  return "";
}

const BOT = "ssh-bot-1";
S.generateBotKey({ botId: BOT, createdAt: "2026-11-12T00:00:00.000Z", execFileImpl: stubKeygen });
// The REAL path of the key dir: ssh and git are child processes, so they are
// handed this, never the anchored /proc/self/fd path.
const KEY_DIR = realpathSync(P.botGitDirReal(BOT));
const KEY_PATH = join(KEY_DIR, "id_ed25519");
const KNOWN_HOSTS = join(KEY_DIR, "known_hosts");

/** The exact option array a bot's ssh runs (ssh.js's fixed list). */
function expectedOptions(keyPath = KEY_PATH, knownHostsPath = KNOWN_HOSTS) {
  return [
    "-F", "/dev/null",
    "-i", keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "UserKnownHostsFile=" + knownHostsPath,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=no",
    "-o", "BatchMode=yes",
    "-o", "ProxyCommand=none",
    "-o", "ProxyJump=none",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "PermitLocalCommand=no",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=10",
  ];
}

/** A stub that records every call and returns `stdout` (or throws it as stderr). */
function makeStub({ stdout = "", stderr = "", fail = false, onCall = null } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (onCall) onCall({ cmd, args, opts, calls });
    if (fail) {
      const err = new Error("ssh exited 1");
      err.stdout = stdout;
      err.stderr = stderr;
      throw err;
    }
    return stdout;
  };
  return { fn, calls };
}

test("sshOptionArgs: the fixed, refused-by-default option list", () => {
  assert.deepEqual(Ssh.sshOptionArgs({ keyPath: KEY_PATH, knownHostsPath: KNOWN_HOSTS }), expectedOptions());
  // Both paths are load-bearing: a missing one is a refusal, not an option-less ssh.
  assert.equal(Ssh.sshOptionArgs({ keyPath: KEY_PATH }), null);
  assert.equal(Ssh.sshOptionArgs({ knownHostsPath: KNOWN_HOSTS }), null);
  assert.equal(Ssh.sshOptionArgs(), null);
  // A path git could only express by quoting (GIT_SSH_COMMAND is a shell string).
  for (const bad of ["/a b/id_ed25519", "/a/$HOME/id", '/a/"q"/id', "/a/id\n", "relative/id", "/a/../b/id", "/a/`x`/id"]) {
    assert.equal(Ssh.sshOptionArgs({ keyPath: bad, knownHostsPath: KNOWN_HOSTS }), null, JSON.stringify(bad));
    assert.equal(Ssh.sshOptionArgs({ keyPath: KEY_PATH, knownHostsPath: bad }), null, JSON.stringify(bad));
  }
});

test("gitSshCommand: \"ssh \" + the option array, or null for an unusable path", () => {
  const cmd = Ssh.gitSshCommand({ keyPath: KEY_PATH, knownHostsPath: KNOWN_HOSTS });
  assert.equal(cmd, "ssh " + expectedOptions().join(" "));
  assert.ok(cmd.startsWith("ssh -F /dev/null -i " + KEY_PATH + " "));
  assert.ok(cmd.includes(" -o LogLevel=ERROR"));
  assert.ok(cmd.includes(" -o StrictHostKeyChecking=yes"));
  assert.equal(Ssh.gitSshCommand({ keyPath: "/a b/id", knownHostsPath: KNOWN_HOSTS }), null);
});

test("testConnection argv: the fixed array, then -p, -T, -- and git@host", async () => {
  const stub = makeStub({ stdout: "Hi! You've successfully authenticated, but GitHub does not provide shell access.\n" });
  const r = await Ssh.testConnection({ botId: BOT, host: "github.com", port: 22, execFileImpl: stub.fn });
  assert.equal(r.result, "ok");
  assert.match(r.excerpt, /successfully authenticated/i);
  assert.equal(stub.calls.length, 1);
  const { cmd, args, opts } = stub.calls[0];
  assert.equal(cmd, "ssh");
  assert.deepEqual(args, [...expectedOptions(), "-p", "22", "-T", "--", "git@github.com"]);
  // The host is only ever the last element after `--`, never an option value.
  assert.equal(args[args.length - 2], "--");
  assert.equal(args[args.length - 1], "git@github.com");
  assert.equal(args.filter((a) => a === "github.com").length, 0, "the bare host never appears");
  assert.equal(opts.timeout, 20_000);
  assert.deepEqual(opts.env, { PATH, LANG: "C" });
  assert.equal("SSH_AUTH_SOCK" in opts.env, false, "no agent socket reaches ssh");
});

test("both probes are async: no child process blocks the gateway", async () => {
  // execFileSync would hold the event loop for the whole 10/20 s timeout, so
  // both functions must hand back a promise (and never import execFileSync).
  const src = readFileSync(new URL("../servers/shared/bot-git/ssh.js", import.meta.url), "utf8");
  assert.ok(!/execFileSync/.test(src), "ssh.js must not import execFileSync");
  const scan = Ssh.keyscan({ host: "git.example.org", execFileImpl: makeStub({ stdout: "" }).fn });
  assert.ok(scan instanceof Promise, "keyscan is async");
  assert.deepEqual(await scan, []);
  const probe = Ssh.testConnection({ botId: BOT, host: "github.com", execFileImpl: makeStub({ stdout: "successfully authenticated\n" }).fn });
  assert.ok(probe instanceof Promise, "testConnection is async");
  assert.equal((await probe).result, "ok");
});

test("no child process is handed an anchored /proc/self/fd path", async () => {
  // ssh, ssh-keyscan and git are CHILD processes: a /proc/self/fd/<fd>/... path
  // resolves only inside this one, so every argv element and every option
  // string must name a real path instead.
  const stub = makeStub({ stdout: "successfully authenticated\n" });
  const r = await Ssh.testConnection({ botId: BOT, host: "github.com", execFileImpl: stub.fn });
  assert.equal(r.result, "ok");
  assert.ok(stub.calls.length >= 1);
  for (const call of stub.calls) {
    for (const arg of call.args) assert.ok(!arg.includes("/proc/self/fd"), call.cmd + " argv: " + arg);
  }
  const scan = makeStub({ stdout: "" });
  await Ssh.keyscan({ host: "git.example.org", execFileImpl: scan.fn });
  for (const arg of scan.calls[0].args) assert.ok(!arg.includes("/proc/self/fd"), "ssh-keyscan argv: " + arg);
  // The gateway-side Test connection and the bot's GIT_SSH_COMMAND share the
  // option list, so one check covers both.
  const cmd = Ssh.gitSshCommand({ keyPath: KEY_PATH, knownHostsPath: KNOWN_HOSTS });
  assert.ok(cmd && !cmd.includes("/proc/self/fd"), "GIT_SSH_COMMAND: " + cmd);
  assert.ok(cmd.includes(" -i " + KEY_PATH + " "), "the key is named by its real path");
});

test("testConnection refuses what the owner has not confirmed, without calling ssh", async () => {
  const stub = makeStub({ stdout: "should not run" });
  const refused = [
    { host: "git.example.org", port: 22 },
    { host: "github.com", port: 2222 },
    { host: "localhost", port: 22 },
    { host: "-oProxyCommand=touch /tmp/x", port: 22 },
    { host: "github.com", port: 0 },
  ];
  for (const c of refused) {
    const r = await Ssh.testConnection({ botId: BOT, execFileImpl: stub.fn, ...c });
    assert.equal(r.result, "refused", JSON.stringify(c));
    assert.ok(r.excerpt.length > 0);
  }
  assert.equal((await Ssh.testConnection({ botId: "..", host: "github.com", execFileImpl: stub.fn })).result, "refused");
  assert.equal((await Ssh.testConnection({ botId: "no-key-bot", host: "github.com", execFileImpl: stub.fn })).result, "refused");
  assert.equal(stub.calls.length, 0, "no ssh ran");
});

test("testConnection on a confirmed host: regenerates known_hosts, then connects", async () => {
  const id = "ssh-host-2";
  S.generateBotKey({ botId: id, createdAt: "2026-11-12T00:00:00.000Z", execFileImpl: stubKeygen });
  const key = syntheticKey("ssh-ed25519", 0x31);
  assert.equal(S.addConfirmedHost(id, { host: "git.example.org", port: 2222, type: "ssh-ed25519", key }).ok, true);
  const dir = realpathSync(P.botGitDirReal(id));
  const knownHostsPath = join(dir, "known_hosts");
  let sawLine = false;
  const stub = makeStub({
    stdout: "successfully authenticated\n",
    onCall: () => {
      sawLine = readFileSync(knownHostsPath, "utf8").includes("[git.example.org]:2222 ssh-ed25519 " + key);
    },
  });
  const r = await Ssh.testConnection({ botId: id, host: "Git.Example.org", port: 2222, execFileImpl: stub.fn });
  assert.equal(r.result, "ok");
  assert.equal(sawLine, true, "known_hosts was regenerated before ssh ran");
  const args = stub.calls[0].args;
  assert.deepEqual(args, [...expectedOptions(join(dir, "id_ed25519"), knownHostsPath), "-p", "2222", "-T", "--", "git@git.example.org"]);
});

test("testConnection classification: banners, host key failures, timeouts, everything else", async () => {
  const cases = [
    ["ok", { stdout: "Hi alex! You've successfully authenticated, but GitHub does not provide shell access.\n" }],
    ["denied", { stdout: "git@github.com: ", stderr: "Permission denied (publickey).\n", fail: true }],
    ["hostkey", { stdout: "", stderr: "Host key verification failed.\n", fail: true }],
    ["hostkey", { stdout: "", stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n", fail: true }],
    ["failed", { stdout: "", stderr: "ssh: connect to host git.example.org port 2222: Connection refused\n", fail: true }],
    ["timeout", { stdout: "", stderr: "", fail: true, timeout: true }],
  ];
  for (const [want, spec] of cases) {
    const stub = makeStub(spec);
    if (spec.timeout) {
      stub.fn = () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT", signal: "SIGTERM", killed: true }); };
    }
    const r = await Ssh.testConnection({ botId: BOT, host: "github.com", execFileImpl: stub.fn });
    assert.equal(r.result, want, JSON.stringify(spec));
  }
});

test("the excerpt is scrubbed: ANSI, control characters, the key path and key headers", async () => {
  const header = "-----BEGIN " + "OPENSSH " + "PRIVATE" + " KEY-----";
  const footer = "-----END " + "OPENSSH " + "PRIVATE" + " KEY-----";
  const out = "\u001b[31mPermission denied\u001b[0m " + KEY_PATH + "\n" +
    "\u0007bell\u0000nul\n" + header + "\nAAAA\n" + footer + "\n" + "x".repeat(2000);
  const stub = makeStub({ stdout: out, stderr: "", fail: true });
  const r = await Ssh.testConnection({ botId: BOT, host: "github.com", execFileImpl: stub.fn });
  assert.equal(r.result, "denied");
  assert.ok(!r.excerpt.includes("\u001b"), "no ANSI escape");
  assert.ok(!r.excerpt.includes("\u0007"), "no bell");
  assert.ok(!r.excerpt.includes("\u0000"), "no NUL");
  assert.ok(!r.excerpt.includes(KEY_PATH), "the key dir path is replaced");
  assert.ok(r.excerpt.includes("<key dir>"), "and the placeholder is there");
  assert.ok(!r.excerpt.includes(header), "a key header line is dropped");
  assert.ok(!r.excerpt.includes("PRIVATE" + " KEY"), "no key label survives");
  assert.ok(r.excerpt.length <= 400, "the excerpt is capped: " + r.excerpt.length);
});

test("the excerpt never carries the bot's own key body (joined or line by line)", async () => {
  const privateText = readFileSync(KEY_PATH, "utf8");
  const body = privateText.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l));
  assert.ok(body.length >= 2);
  const joined = body.join("");
  const oneLine = body.find((l) => l.length >= 40);
  assert.ok(oneLine);
  const stub = makeStub({ stdout: "thinking about " + joined + "\nand " + oneLine + "\n", stderr: "", fail: true });
  const r = await Ssh.testConnection({ botId: BOT, host: "github.com", execFileImpl: stub.fn });
  assert.ok(!r.excerpt.includes(joined), "the joined key body is masked");
  assert.ok(!r.excerpt.includes(joined.slice(0, 48)));
  assert.ok(!r.excerpt.includes(oneLine), "a key body line is masked");
  assert.equal(r.result, "failed");
});

test("one connection test per bot at a time: an overlapping call answers busy", async () => {
  // The first call's ssh is held OPEN (a callback-style impl, execFile's own
  // shape), so the second call starts while the first is still awaiting. That is
  // the case the guard has to cover: an id added only after the await (or a
  // re-entrant call inside a synchronous execFileSync) is not enough.
  let releaseFirst = null;
  let firstRan = false;
  const child = { pid: 4242, on() {}, once() {}, kill() {} };
  const first = Ssh.testConnection({
    botId: BOT,
    host: "github.com",
    execFileImpl: (cmd, args, opts, cb) => {
      firstRan = true;
      releaseFirst = cb;
      return child;
    },
  });
  assert.equal(typeof first.then, "function", "testConnection returns a promise");
  assert.equal(firstRan, true, "the first call reached ssh before anything was awaited");

  let secondRan = false;
  const second = await Ssh.testConnection({
    botId: BOT,
    host: "github.com",
    execFileImpl: () => { secondRan = true; return ""; },
  });
  assert.equal(second.result, "busy");
  assert.ok(second.excerpt.length > 0);
  assert.equal(secondRan, false, "the overlapping call never reached ssh");

  assert.equal(typeof releaseFirst, "function");
  releaseFirst(null, "successfully authenticated\n", "");
  assert.equal((await first).result, "ok");

  // The lock is released: the next call runs normally.
  const again = makeStub({ stdout: "successfully authenticated\n" });
  assert.equal((await Ssh.testConnection({ botId: BOT, host: "github.com", execFileImpl: again.fn })).result, "ok");
});

test("keyscan: the exact argv, `--` immediately before the host, parsed keys back", async () => {
  const ed = syntheticKey("ssh-ed25519", 0x41);
  const ec = syntheticKey("ecdsa-sha2-nistp256", 0x42);
  const stdout = [
    "# git.example.org:2222 SSH-2.0-OpenSSH_9.6",
    "[git.example.org]:2222 ssh-ed25519 " + ed,
    "[git.example.org]:2222 ecdsa-sha2-nistp256 " + ec,
    "other.example.org ssh-ed25519 " + syntheticKey("ssh-ed25519", 0x43),
    "",
  ].join("\n");
  const stub = makeStub({ stdout });
  const got = await Ssh.keyscan({ host: "git.example.org", port: 2222, execFileImpl: stub.fn });
  assert.deepEqual(got, [
    { type: "ssh-ed25519", key: ed, fingerprint: H.fingerprintOf(ed) },
    { type: "ecdsa-sha2-nistp256", key: ec, fingerprint: H.fingerprintOf(ec) },
  ]);
  const { cmd, args, opts } = stub.calls[0];
  assert.equal(cmd, "ssh-keyscan");
  assert.deepEqual(args, ["-T", "5", "-t", "ed25519,ecdsa,rsa", "-p", "2222", "--", "git.example.org"]);
  assert.equal(args[args.indexOf("--") + 1], "git.example.org");
  assert.equal(args[args.length - 2], "--", "`--` is immediately before the host");
  assert.equal(opts.timeout, 10_000);
  assert.deepEqual(opts.env, { PATH, LANG: "C" });

  // Default port and a host given with a port in it.
  const plain = makeStub({ stdout: "" });
  assert.deepEqual(await Ssh.keyscan({ host: "Git.Example.org", execFileImpl: plain.fn }), []);
  assert.equal(plain.calls[0].args[5], "22");
  assert.equal(plain.calls[0].args[7], "git.example.org");
});

test("keyscan refuses a host it must not scan, without running ssh-keyscan", async () => {
  const stub = makeStub({ stdout: "" });
  for (const c of [
    { host: "github.com" },
    { host: "ssh.github.com" },
    { host: "localhost" },
    { host: "127.0.0.1" },
    { host: "-oProxyCommand=touch /tmp/x" },
    { host: "git.example.org", port: 0 },
    { host: "git.example.org:2222" },
    { host: "" },
    { host: null },
  ]) {
    assert.equal(await Ssh.keyscan({ ...c, execFileImpl: stub.fn }), null, JSON.stringify(c));
  }
  assert.equal(stub.calls.length, 0, "nothing ran");
});