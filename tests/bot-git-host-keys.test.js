/**
 * Per-bot git access, task A2: the pinned GitHub host keys and every rule that
 * decides what may reach a bot's generated known_hosts.
 *
 * The pin test is the point of the file: the three key lines are pasted from
 * https://api.github.com/meta (fetched 2026-11-12), and their SHA256
 * fingerprints are recomputed here from the pasted material and compared with
 * the fingerprints GitHub publishes. A pasted key that does not hash to the
 * pinned fingerprint fails the suite.
 *
 * No real key material is committed: ed25519/ecdsa test keys are built from a
 * random blob with the SSH type prefix (and, when ssh-keygen exists, generated
 * in a scratch dir), so the only "keys" in the repo are the public host keys
 * above.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";
import * as H from "../servers/shared/bot-git/host-keys.js";

const dirs = [];
after(() => { for (const d of dirs) rmScratch(d); });

/** A public-key blob of the shape ssh writes: <len><type><len><bytes>. */
function syntheticKey(type, fill = 0x5a) {
  const label = Buffer.from(type, "latin1");
  const body = Buffer.alloc(32, fill);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(label.length);
  const blen = Buffer.alloc(4);
  blen.writeUInt32BE(body.length);
  return Buffer.concat([len, label, blen, body]).toString("base64");
}

// A real ssh-keygen key, when this host has the binary. The test below skips
// ONLY when no ssh-keygen exists at the installer's locations: a host that has
// it and a keygen that fails is a failure, never a skip (a /proc/self/fd path
// handed to the child, for one, fails exactly that way).
const SSH_KEYGEN = ["/usr/bin/ssh-keygen", "/bin/ssh-keygen", "/usr/local/bin/ssh-keygen"].find((p) => existsSync(p)) || null;
let realPublicLine = null;
let realPublicFile = null;
if (SSH_KEYGEN) {
  const dir = mkdtempSync(join(tmpdir(), "bot-git-hostkeys-"));
  dirs.push(dir);
  execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-C", "crow-bot:test", "-f", join(dir, "id_ed25519")],
    { timeout: 10_000, stdio: "ignore", env: { PATH: process.env.PATH, LANG: "C" } });
  realPublicFile = join(dir, "id_ed25519.pub");
  realPublicLine = readFileSync(realPublicFile, "utf8").trim();
}
const noSshKeygen = SSH_KEYGEN ? false : "no ssh-keygen at /usr/bin, /bin or /usr/local/bin";

test("the pinned GitHub keys hash to the pinned fingerprints", () => {
  assert.equal(H.GITHUB_HOST, "github.com");
  assert.equal(H.GITHUB_HOST_KEYS.length, 3, "three published host keys");
  const types = [];
  for (const pinned of H.GITHUB_HOST_KEYS) {
    const parsed = H.parseKeyLine(H.GITHUB_HOST + " " + pinned);
    assert.ok(parsed, "a pinned line parses: " + pinned.slice(0, 24) + "…");
    assert.equal(parsed.host, H.GITHUB_HOST);
    assert.equal(parsed.port, 22, "v1 pins port 22 only");
    types.push(parsed.type);
    assert.equal(H.fingerprintOf(parsed.key), H.GITHUB_FINGERPRINTS[parsed.type],
      "pinned key material does not hash to the published " + parsed.type + " fingerprint");
  }
  assert.deepEqual([...types].sort(), ["ecdsa-sha2-nistp256", "ssh-ed25519", "ssh-rsa"]);
  assert.deepEqual(Object.keys(H.GITHUB_FINGERPRINTS).sort(), [...types].sort(),
    "one pinned fingerprint per pinned key, and no extra type");
  for (const type of types) assert.ok(H.ALLOWED_KEY_TYPES.includes(type), type + " is an allowed type");
});

test("fingerprintOf is OpenSSH's SHA256 spelling (padding stripped)", () => {
  const key = syntheticKey("ssh-ed25519");
  const fp = H.fingerprintOf(key);
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(fp, H.fingerprintOf(key), "same input, same fingerprint");
  assert.notEqual(fp, H.fingerprintOf(syntheticKey("ssh-ed25519", 0x11)));
  assert.match(H.fingerprintOf(""), /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("parseKeyLine refuses every shape that could widen the trusted set", () => {
  const ed = syntheticKey("ssh-ed25519");
  const refused = [
    "",
    "# a comment line",
    "",
    "|1|abcdefghij=|klmnopqrst= ssh-ed25519 " + ed,
    "@cert-authority example.org ssh-ed25519 " + ed,
    "@revoked example.org ssh-ed25519 " + ed,
    "*.example.org ssh-ed25519 " + ed,
    "git?.example.org ssh-ed25519 " + ed,
    "!bad.example.org ssh-ed25519 " + ed,
    "a.example.org,b.example.org ssh-ed25519 " + ed,
    "example.org ssh-dss " + syntheticKey("ssh-dss"),
    "example.org sk-ssh-ed25519@openssh.com " + syntheticKey("sk-ssh-ed25519@openssh.com"),
    "example.org ssh-ed25519 " + syntheticKey("ssh-rsa"),
    "example.org ssh-ed25519 not*base64",
    "example.org ssh-ed25519 " + ed + " trailing-comment",
    "example.org ssh-ed25519",
    "example.org",
    "[example.org]:0 ssh-ed25519 " + ed,
    "[example.org] ssh-ed25519 " + ed,
    "[::1]:22 ssh-ed25519 " + ed,
    "a b ssh-ed25519 " + ed,
    null,
    42,
  ];
  for (const raw of refused) assert.equal(H.parseKeyLine(raw), null, JSON.stringify(raw));
});

test("parseKeyLine round-trips a plain and a port line", () => {
  const ed = syntheticKey("ssh-ed25519");
  assert.deepEqual(H.parseKeyLine("Git.Example.org ssh-ed25519 " + ed),
    { host: "git.example.org", port: 22, type: "ssh-ed25519", key: ed }, "host is lower-cased");
  const ec = syntheticKey("ecdsa-sha2-nistp256", 0x33);
  assert.deepEqual(H.parseKeyLine("[git.example.org]:2222   ecdsa-sha2-nistp256\t" + ec),
    { host: "git.example.org", port: 2222, type: "ecdsa-sha2-nistp256", key: ec });
  const ip = syntheticKey("ssh-rsa", 0x44);
  assert.deepEqual(H.parseKeyLine("100.64.20.7 ssh-rsa " + ip),
    { host: "100.64.20.7", port: 22, type: "ssh-rsa", key: ip });
});

test("parseKeyLine accepts a real ssh-keygen public key", { skip: noSshKeygen }, () => {
  // A .pub line is `type key comment`; the comment is not part of a known_hosts line.
  const [type, key] = realPublicLine.split(/\s+/);
  const parsed = H.parseKeyLine("git.example.org " + type + " " + key);
  assert.ok(parsed, "a real key line parses");
  assert.equal(parsed.type, "ssh-ed25519");
  // ssh-keygen -lf prints the same SHA256 fingerprint for the .pub file.
  const out = execFileSync(SSH_KEYGEN, ["-lf", realPublicFile], { env: { PATH: process.env.PATH, LANG: "C" } }).toString("utf8");
  assert.ok(out.includes(H.fingerprintOf(parsed.key)), "fingerprintOf matches ssh-keygen -lf: " + out.trim());
});

test("normalizeHost: a confirmable host and port, or null", () => {
  const cases = [
    ["git.example.org", { host: "git.example.org", port: 22 }],
    ["git.example.org:2222", { host: "git.example.org", port: 2222 }],
    ["100.64.20.7:2222", { host: "100.64.20.7", port: 2222 }],
    ["100.64.20.7", { host: "100.64.20.7", port: 22 }],
    ["  Git.Example.ORG  ", { host: "git.example.org", port: 22 }],
    ["git.example.org:65535", { host: "git.example.org", port: 65535 }],
    ["-oProxyCommand=x", null],
    ["localhost", null],
    ["api.localhost", null],
    ["127.0.0.1", null],
    ["127.9.9.9:2222", null],
    ["0.0.0.0", null],
    ["::1", null],
    ["[::1]:22", null],
    ["github.com", null],
    ["ssh.github.com", null],
    ["a b", null],
    ["x:0", null],
    ["x:65536", null],
    ["x:0222", null],
    ["", null],
    ["git.example.org.", null],
    ["1.2.3", null],
    ["http://git.example.org", null],
    ["git.example.org:", null],
    [null, null],
    [42, null],
  ];
  for (const [input, want] of cases) assert.deepEqual(H.normalizeHost(input), want, JSON.stringify(input));
});

test("knownHostsName spells the host field the way known_hosts does", () => {
  assert.equal(H.knownHostsName({ host: "git.example.org", port: 22 }), "git.example.org");
  assert.equal(H.knownHostsName({ host: "git.example.org" }), "git.example.org");
  assert.equal(H.knownHostsName({ host: "git.example.org", port: 2222 }), "[git.example.org]:2222");
  assert.equal(H.knownHostsName({ host: "100.64.20.7", port: 2222 }), "[100.64.20.7]:2222");
  assert.equal(H.knownHostsName({ host: "Git.Example.org", port: 22 }), "git.example.org");
});

test("buildKnownHosts: pinned lines, then confirmed lines rebuilt from their parts", () => {
  const pinnedOnly = H.buildKnownHosts();
  assert.ok(pinnedOnly.endsWith("\n"), "trailing newline");
  const pinnedLines = pinnedOnly.trimEnd().split("\n");
  assert.equal(pinnedLines.length, 3);
  for (const l of pinnedLines) {
    const parsed = H.parseKeyLine(l);
    assert.ok(parsed);
    assert.equal(parsed.host, "github.com");
  }

  const ed = syntheticKey("ssh-ed25519");
  const built = H.buildKnownHosts([
    "git.example.org ssh-ed25519 " + ed,
    "[git.example.org]:2222 ssh-ed25519 " + ed,
    // a repeated confirm collapses
    "git.example.org ssh-ed25519 " + ed,
  ]);
  const lines = built.trimEnd().split("\n");
  assert.equal(lines.length, 5, "3 pinned + 2 distinct confirmed");
  assert.equal(lines.filter((l) => l.startsWith("github.com ")).length, 3, "the pinned lines are all there");
  assert.ok(lines.includes("git.example.org ssh-ed25519 " + ed));
  assert.ok(lines.includes("[git.example.org]:2222 ssh-ed25519 " + ed));
  for (const l of lines) assert.equal(l.split(" ").length, 3, "never four fields: " + l);
});

test("buildKnownHosts drops comments, extra fields and unconfirmable hosts", () => {
  const ed = syntheticKey("ssh-ed25519");
  const built = H.buildKnownHosts([
    "git.example.org ssh-ed25519 " + ed + " my laptop",
    "git.example.org ssh-ed25519 " + ed + "#comment",
    "# nothing here",
    "@cert-authority *.example.org ssh-ed25519 " + ed,
    "localhost ssh-ed25519 " + ed,
    "127.0.0.1 ssh-ed25519 " + ed,
    "not-a-key",
  ]);
  assert.equal(built.trimEnd().split("\n").length, 3, "only the pinned lines survive");
  assert.ok(!built.includes("my laptop"));
  assert.ok(!built.includes("#comment"));
  assert.ok(!built.includes("cert-authority"));
});

test("buildKnownHosts never lets a confirmed line stand in for a pinned host", () => {
  const attacker = syntheticKey("ssh-ed25519", 0x07);
  const built = H.buildKnownHosts([
    "github.com ssh-ed25519 " + attacker,
    "ssh.github.com ssh-ed25519 " + attacker,
    "[github.com]:2222 ssh-ed25519 " + attacker,
  ]);
  assert.ok(!built.includes(attacker), "a confirmed github.com line is dropped, never merged");
  assert.equal(built.trimEnd().split("\n").filter((l) => l.startsWith("github.com ")).length, 3);
  assert.equal(built.trimEnd().split("\n").length, 3);
});

test("parseKeyscan: only this host's lines, parsed, deduplicated, fingerprinted", () => {
  const a = syntheticKey("ssh-ed25519", 0x21);
  const b = syntheticKey("ecdsa-sha2-nistp256", 0x22);
  const stdout = [
    "# git.example.org:2222 SSH-2.0-OpenSSH_9.6",
    "[git.example.org]:2222 ssh-ed25519 " + a,
    "[git.example.org]:2222 ssh-ed25519 " + a,
    "[git.example.org]:2222 ecdsa-sha2-nistp256 " + b,
    "git.example.org ssh-ed25519 " + syntheticKey("ssh-ed25519", 0x23),
    "other.example.org ssh-ed25519 " + syntheticKey("ssh-ed25519", 0x24),
    "@revoked [git.example.org]:2222 ssh-ed25519 " + syntheticKey("ssh-ed25519", 0x25),
    "[git.example.org]:2222 ssh-dss " + syntheticKey("ssh-dss"),
    "",
  ].join("\n");
  const got = H.parseKeyscan(stdout, { host: "git.example.org", port: 2222 });
  assert.deepEqual(got, [
    { type: "ssh-ed25519", key: a, fingerprint: H.fingerprintOf(a) },
    { type: "ecdsa-sha2-nistp256", key: b, fingerprint: H.fingerprintOf(b) },
  ]);
  assert.deepEqual(H.parseKeyscan(stdout.split("\n").filter((l) => !l.startsWith("[")).join("\n"), { host: "git.example.org", port: 2222 }), []);
  assert.deepEqual(H.parseKeyscan(null, { host: "git.example.org", port: 22 }), []);
});