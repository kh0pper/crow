/**
 * Public-repository hygiene guard (scripts/check-public-hygiene.mjs).
 *
 * The repo is public: process documents live in the private engineering repo,
 * and tracked files never carry credentials, real tailnet hostnames or personal
 * details. The fixtures below are assembled at runtime so this file itself
 * never matches the patterns it tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  checkPath, checkContent, loadAllowlist, parseDenylist, loadDenylist, scanRepo,
} from "../scripts/check-public-hygiene.mjs";

const J = (...p) => p.join("");
const allow = loadAllowlist("tailnet: example\ntailnet: your-tailnet\nsecret: " + J("sk-", "fake-value-for-tests-0001"));

test("the tracked tree is clean (denylist applies locally, skipped in CI)", () => {
  const { list } = loadDenylist();
  const { files, violations } = scanRepo({ denylist: list });
  assert.ok(files > 1000, "scanned the real tracked tree");
  assert.deepEqual(violations.map((v) => `${v.path}:${v.line} ${v.rule}`), []);
});

test("process documents are refused by path", () => {
  for (const p of [
    "docs/superpowers/specs/x.md", "docs/superpowers/plans/y.md",
    "notes/handoffs/2026-10-04.md", "bundles/x/SESSION-HANDOFF.md", "a/b/handoff-sync.md",
    ".claude/plans/p.md", "Docs/Superpowers/specs/x.md", "bundles/x/docs/superpowers/a.md",
    ".superpowers/brainstorm/1/page.html", "bundles/a/.claude/x.md", "notes/hand-off.md", "HANDOFF.txt",
  ]) assert.equal(checkPath(p).length, 1, p);
  for (const p of ["skills/superpowers.md", "docs/guide/sharing.md", "servers/gateway/session-manager.js"]) {
    assert.deepEqual(checkPath(p), [], p);
  }
});

test("a literal piped into sudo -S, and inline sshpass passwords, are refused; env-var pipes are allowed", () => {
  const bad = [
    J("echo 'hunter2' | sud", "o -S systemctl restart x"),
    J('echo "hunter2" | sud', "o -S true"),
    J("echo hunter2 | sud", "o -S -k true"),
    J("printf '%s\\n' 'hunter2' | sud", "o -S true"),
    J("ssh", "pass -p hunter2 ssh host"),
    J("SSH", "PASS=hunter2 ssh", "pass -e ssh host"),
    J("echo hunter2 | sud", "o -kS true"),
    J("echo hunter2 | sud", "o -Sk true"),
    J("echo hunter2 | sud", "o --stdin true"),
    J("echo hunter2 | /usr/bin/sud", "o -S true"),
    J("echo hunter2 | ssh box sud", "o -S true"),
    J("yes hunter2 | sud", "o -S true"),
    J('printf "%s\\n" hunter2 | sud', "o -S true"),
    J("sud", "o -S true <<< 'hunter2'"),
    J("sud", "o -S true <<< hunter2"),
  ];
  for (const line of bad) assert.ok(checkContent("x.sh", line).length >= 1, line);
  for (const line of [
    J('echo "$LAB_SUDO_PASS" | sud', "o -S systemctl start x"),
    J("echo $PW | sud", "o -S true"),
    "sudo -n true",
    J("sud", 'o -S true <<< "$PW"'),
    J("SSH", 'PASS="$PW" ssh', "pass -e ssh host"),
  ]) assert.deepEqual(checkContent("x.sh", line), [], line);
});

test("real-looking tailnet hostnames are refused; placeholders pass", () => {
  const real = J("https://crow.", "otter-", "banana", ".ts.net:8444/");
  assert.equal(checkContent("doc.md", real, { allow }).length, 1);
  assert.equal(checkContent("doc.md", J("host.", "tail9f3a2b", ".ts.net"), { allow }).length, 1);
  assert.equal(checkContent("doc.md", J("https://", "otter-", "banana", ".ts.net/"), { allow }).length, 1, "bare generated tailnet domain");
  assert.equal(checkContent("doc.md", J("tail9f3a2b", ".ts.net"), { allow }).length, 1, "bare tailXXXX domain");
  for (const ok of ["https://crow.example.ts.net:8444", "https://box.your-tailnet.ts.net", "https://Crow.Example.ts.net", "crow.ts.net", "<tailnet-host>"]) {
    assert.deepEqual(checkContent("doc.md", ok, { allow }), [], ok);
  }
});

test("high-entropy secret patterns are refused unless allowlisted", () => {
  const samples = [
    J("ghp_", "A".repeat(36)),
    J("github_pat_", "11ABCDEFG0123456789_abcdefghijklmnop"),
    J("sk-", "ant-api03-", "x".repeat(30)),
    J("tskey-", "auth-", "kAbCdEf1234-ZZZZZZZZZZZ"),
    J("AKIA", "ABCDEFGHIJKLMNOP"),
    J("AIza", "S".repeat(35)),
    J("BSA", "q".repeat(28)),
    J("-----BEGIN OPENSSH ", "PRIVATE KEY-----"),
    J("-----BEGIN ", "PRIVATE KEY-----"),
    J("-----BEGIN PGP ", "PRIVATE KEY BLOCK-----"),
    J("gho_", "C".repeat(36)),
    J("xoxb-", "123456789012-abcdefghij"),
    J("hf_", "a".repeat(34)),
    J("GOCSPX-", "b".repeat(28)),
    J("ya29.", "c".repeat(30)),
    J("sk_", "live_", "d".repeat(24)),
    J("glpat-", "e".repeat(20)),
    J("npm_", "f".repeat(36)),
    J("ASIA", "ABCDEFGHIJKLMNOP"),
    J("nsec1", "q".repeat(58)),
    J("https://discord.com/api/", "webhooks/123456/", "g".repeat(68)),
    J("tskey-", "abcdef1234567"),
  ];
  for (const s of samples) assert.equal(checkContent("f.js", `const k = "${s}";`, { allow }).length, 1, s.slice(0, 8));
  assert.deepEqual(checkContent("f.js", J("sk-", "fake-value-for-tests-0001"), { allow }), []);
});

test("denylist tokens match case-insensitively in content and paths, and are never echoed", () => {
  const deny = parseDenylist("# comment\n\nSecretName\nab\n");
  assert.deepEqual(deny, ["SecretName"], "comments, blanks and <3-char tokens are dropped");
  const v = checkContent("t.js", "hello secretname world", { denylist: deny });
  assert.equal(v.length, 1);
  assert.ok(!JSON.stringify(v).toLowerCase().includes("secretname"), "the token itself is never reported");
  assert.equal(checkPath("fixtures/SECRETNAME-notes.txt", deny).length, 1);
});

test("CI skips the denylist; CROW_PUBLIC_DENYLIST points at an explicit file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-"));
  try {
    const f = join(dir, "deny");
    writeFileSync(f, "tokenone\n");
    assert.deepEqual(loadDenylist({ CI: "true", CROW_PUBLIC_DENYLIST: f }).list, []);
    assert.deepEqual(loadDenylist({ CROW_PUBLIC_DENYLIST: f }).list, ["tokenone"]);
    assert.deepEqual(loadDenylist({ CROW_PUBLIC_DENYLIST: join(dir, "missing") }).list, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--rev scans the committed tree and --messages the commit messages, not the working tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-rev-"));
  try {
    const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.org", ...a], { cwd: dir, stdio: "pipe" }).toString().trim();
    git("init", "-q");
    writeFileSync(join(dir, "a.md"), "clean\n");
    git("add", "a.md"); git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "a.md"), J("leak ghp_", "D".repeat(36), "\n"));
    git("commit", "-q", "-am", "add a note about tokenone");
    writeFileSync(join(dir, "a.md"), "clean again, uncommitted\n");
    assert.deepEqual(scanRepo({ root: dir }).violations, [], "the working tree is clean");
    const r = scanRepo({ root: dir, rev: "HEAD", messages: `${base}..HEAD`, denylist: ["tokenone"] });
    assert.deepEqual(r.violations.map((v) => v.rule), ["secret pattern: github token", "denylisted token #1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scanRepo reads only tracked files and skips binaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-repo-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    mkdirSync(join(dir, "docs/superpowers/specs"), { recursive: true });
    writeFileSync(join(dir, "docs/superpowers/specs/a.md"), "# spec\n");
    writeFileSync(join(dir, "ok.md"), "nothing here\n");
    writeFileSync(join(dir, "bin.dat"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(J("AKIA", "ABCDEFGHIJKLMNOP"))]));
    writeFileSync(join(dir, "untracked.md"), J("ghp_", "B".repeat(36)));
    git("add", "docs", "ok.md", "bin.dat");
    const { files, violations } = scanRepo({ root: dir });
    assert.equal(files, 3);
    assert.deepEqual(violations.map((v) => v.path), ["docs/superpowers/specs/a.md"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
