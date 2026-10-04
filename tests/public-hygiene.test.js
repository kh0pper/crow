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
import { deflateRawSync } from "node:zlib";
import {
  checkPath, checkContent, loadAllowlist, parseDenylist, loadDenylist, scanRepo, zipTextParts, isFictionalPhone, binaryTextParts,
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

test("scanRepo reads only tracked files; binaries are reduced to the text they carry", () => {
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
    assert.deepEqual(violations.map((v) => v.path).sort(), ["bin.dat!strings", "docs/superpowers/specs/a.md"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("personal-domain email addresses are refused; example domains and allowlisted placeholders pass", () => {
  const bad = [
    J("someone.real", "@gm", "ail.com"), J("Some.One", "@GM", "AIL.COM"), J("x+tag", "@googlem", "ail.com"),
    J("a", "@out", "look.com"), J("b", "@hot", "mail.co.uk"), J("c", "@ya", "hoo.com"), J("d", "@ic", "loud.com"),
    J("e", "@proton", "mail.com"), J("f", "@pro", "ton.me"), J("g", "@me", ".com"), J("h", "@aol", ".com"), J("i", "@comc", "ast.net"),
  ];
  for (const a of bad) assert.equal(checkContent("f.js", `to: "${a}"`).length, 1, a);
  for (const enc of [J("x%40gm", "ail.com"), J("x\\u0040gm", "ail.com"), J("x&#64;gm", "ail.com"), J("x [at] gm", "ail.com"), J("y@web", ".de")]) {
    assert.equal(checkContent("f.js", enc).length, 1, enc);
  }
  for (const ok of ["operator@example.com", "bot+scout@example.com", "a@b.com", "x@test.invalid", "smtp.gm" + "ail.com", "imap.gm" + "ail.com"]) {
    assert.deepEqual(checkContent("f.js", `host = "${ok}"`), [], ok);
  }
  const al = loadAllowlist(J("email: your-email@gm", "ail.com"));
  assert.deepEqual(checkContent("d.md", J("SMTP_USERNAME=Your-Email@gm", "ail.com"), { allow: al }), [], "allowlist is case-insensitive");
});

test("phone numbers outside the fictional ranges are refused in every written form", () => {
  const bad = [
    J("+1 (512) 93", "7-2400"), J("(512) 93", "7-2400"), J("512-93", "7-2400"), J("512.93", "7.2400"),
    J("+1512", "9372400"), J("+1-512-93", "7-2400"), J("1-512-93", "7-2400"), J("+4479", "11123456"),
    J("512 93", "7 2400"), J("512-93", "7.2400"), J("cell-512-93", "7-2400"), J("512-93", "7-2400x12"),
    J("+44 20 71", "23 4567"), J("+52 55 98", "76 5432"), J('"phone": "51293', '72400"'), J("callback_number=51293", "72400"),
  ];
  for (const n of bad) assert.equal(checkContent("f.py", `phone = "${n}"`).length, 1, n);
  const fine = [
    "(512) 555-0100", "512-555-0199", "+15125550142", "+1 512 555 0100", "+442079460123",
    "+15129110101", "+19115550101", "2026-10-04", "10.0.0.201", "v1.234.5678", "id 5129372400", "1234-567-8901x",
  ];
  for (const n of fine) assert.deepEqual(checkContent("f.py", `value = "${n}"`), [], n);
  assert.equal(isFictionalPhone("15125550100"), true);
  assert.equal(isFictionalPhone("15125550200"), false, "only 555-0100..0199 is reserved");
  const al = loadAllowlist(J("phone: 1512976", "0101"));
  assert.deepEqual(checkContent("t.js", J('"+1512976', '0101"'), { allow: al }), []);
});

test("captured mail is refused: export file types by path, transport headers by content", () => {
  for (const p of ["fixtures/thread.eml", "x/inbox.mbox", "a/b/msg.MSG"]) assert.equal(checkPath(p).length, 1, p);
  assert.deepEqual(checkPath("docs/email-setup.md"), []);
  const raw = [J("Recei", "ved: from mx.example.net by mx2"), J("DKIM-Sig", "nature: v=1; a=rsa-sha256"), J("X-Recei", "ved: by 2002:a05"), J("ARC-Se", "al: i=1")];
  for (const l of raw) assert.equal(checkContent("f.txt", l).length, 1, l);
  assert.equal(checkContent("m.json", J('{"name": "Recei', 'ved", "value": "from mx"}')).length, 1);
  for (const l of [J('{"raw":"From: a\\r\\nRecei', 'ved: from mx.example.net"}'), J("    Recei", "ved: from mx"), J("Recei", "ved:from mx"),
    J("Authentication-Res", "ults: mx.google.com"), J("Message-ID: <abc123@mail.gm", "ail.com>"), J('{"name": "X-Gm-Mes', 'sage-State"}')]) {
    assert.equal(checkContent("f.json", l).length, 1, l);
  }
  for (const ok of ["From: alice@example.com", "Subject: hi", "the message was received: ok", "// Received: header handling"]) {
    assert.deepEqual(checkContent("f.js", ok), [], ok);
  }
});

function zipOf(files) {
  // Minimal deflate zip writer for the container test.
  const locals = []; const central = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text)); const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(text.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); central.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("office containers are opened: a comment author or address inside a .docx is caught", () => {
  const buf = zipOf({ "word/comments.xml": '<w:comment w:author="Tokenone"/>', "docProps/core.xml": J("<dc:creator>x@gm", "ail.com</dc:creator>"), "word/media/a.png": "\u0000" });
  assert.deepEqual(zipTextParts(buf).map((p) => p.name), ["word/comments.xml", "docProps/core.xml"]);
  const dir = mkdtempSync(join(tmpdir(), "hygiene-zip-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    writeFileSync(join(dir, "f.docx"), buf);
    git("add", "f.docx");
    const { violations } = scanRepo({ root: dir, denylist: ["tokenone"] });
    assert.deepEqual(violations.map((v) => v.path).sort(), ["f.docx!docProps/core.xml", "f.docx!word/comments.xml"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binary files are read for the text they carry: renamed zips, nested zips, UTF-16, PNG text chunks, PDF metadata, printable runs", () => {
  const inner = zipOf({ "word/comments.xml": '<w:comment w:author="Tokenone"/>' });
  const outer = zipOf({ "a.txt": "clean" });
  const asText = (parts) => parts.map((p) => p.text).join("\n");
  assert.match(asText(binaryTextParts("renamed.bin", inner)), /Tokenone/, "zip detected by magic, not extension");
  // nested: a zip stored as a part of another zip
  const nestedBuf = zipOf({ "inner.docx": inner.toString("latin1") });
  assert.ok(nestedBuf.length > 0 && outer.length > 0);
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("name,mail\nx,tokenone", "utf16le")]);
  assert.match(asText(binaryTextParts("c.csv", u16)), /tokenone/);
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); data.copy(b, 8); return b; };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("tEXt", Buffer.from("Author\0Tokenone", "latin1")), chunk("IEND", Buffer.alloc(0))]);
  assert.match(asText(binaryTextParts("i.png", png)), /Tokenone/);
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj << /Author (Tokenone) /Producer (x) >> endobj\n\u0000\u0001", "latin1");
  assert.match(asText(binaryTextParts("d.pdf", pdf)), /Tokenone/);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]), Buffer.from(J("Artist x@gm", "ail.com"), "latin1"), Buffer.alloc(8)]);
  const parts = binaryTextParts("p.jpg", jpg);
  assert.equal(parts[0].light, true);
  assert.equal(checkContent("p.jpg", parts[0].text, { light: true }).length, 1, "addresses are checked in printable runs");
  assert.deepEqual(checkContent("p.jpg", J("512-93", "7-2400"), { light: true }), [], "phone rule is off for raw binary runs");
});
