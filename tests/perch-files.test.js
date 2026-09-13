/**
 * PR-B (audit item 18) — read-only cwd browsing for the Files tab.
 *
 * Pure-function tests against a REAL scratch dir tree: the realpath jail, the
 * dir/file listing, the uploadsDir exclusion, and the capped text viewer with
 * its fail-closed type gate. No engine, no route, no HTTP — those are covered
 * in tests/perch-interactive-routes.test.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jailUnderCwd, cwdList, cwdRead, TEXT_EXT_MIME, CWD_READ_CAP } from "../servers/gateway/perch-files.js";

let root;        // the session's cwd
let uploads;     // the session's uploadsDir (a sibling, NOT under cwd in the common case)
let uploadsInside; // an uploadsDir that IS under cwd (the exclusion edge)

before(() => {
  root = mkdtempSync(join(tmpdir(), "perch-files-cwd-"));
  uploads = mkdtempSync(join(tmpdir(), "perch-files-uploads-"));
  writeFileSync(join(uploads, "secret.txt"), "operator upload — never served");

  // a normal subdir tree
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "src", "deep"));
  writeFileSync(join(root, "src", "index.js"), "console.log('hi');\n");
  writeFileSync(join(root, "README.md"), "# hello\n");
  writeFileSync(join(root, "data.json"), JSON.stringify({ a: 1 }));
  writeFileSync(join(root, "notes.txt"), "line one\nline two\n");
  // a dotdir + dotfile (kept, sorted last)
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  // a binary file wearing a text name (NUL bytes) → viewer must refuse
  writeFileSync(join(root, "fake.txt"), Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02]));
  // a real binary (unknown ext) → viewer must refuse
  writeFileSync(join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  // a symlink that ESCAPES the jail (points at the uploads dir's secret)
  symlinkSync(join(uploads, "secret.txt"), join(root, "escape.txt"));
  // a symlink to a dir OUTSIDE the jail
  symlinkSync(uploads, join(root, "escape-dir"));
  // an uploadsDir that lives UNDER cwd (the exclusion edge)
  uploadsInside = join(root, "uploads");
  mkdirSync(uploadsInside);
  writeFileSync(join(uploadsInside, "u.txt"), "inside uploads");
});

after(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
  try { rmSync(uploads, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// jailUnderCwd
// ---------------------------------------------------------------------------

test("jail: empty path resolves to the cwd root", () => {
  const j = jailUnderCwd(root, "", null);
  assert.ok(j);
  assert.equal(j.rel, "");
  assert.equal(j.real, j.rootReal);
});

test("jail: a relative subdir resolves under root", () => {
  const j = jailUnderCwd(root, "src/deep", null);
  assert.ok(j);
  assert.equal(j.rel, "src/deep");
});

test("jail: `..` traversal out of the cwd is refused", () => {
  assert.equal(jailUnderCwd(root, "../", null), null);
  assert.equal(jailUnderCwd(root, "src/../../..", null), null);
  assert.equal(jailUnderCwd(root, "..", null), null);
});

test("jail: an absolute path outside the cwd is refused", () => {
  assert.equal(jailUnderCwd(root, "/etc", null), null);
  assert.equal(jailUnderCwd(root, uploads, null), null);
});

test("jail: a sibling whose name shares the root's prefix is still refused (strictly-under)", () => {
  // root is like /tmp/perch-files-cwd-XXXX; a path /tmp/perch-files-cwd-XXXXevil
  // must NOT pass a naive startsWith. Build it and confirm refusal.
  const evil = root + "evil";
  try {
    mkdirSync(evil);
    assert.equal(jailUnderCwd(root, evil, null), null, "prefix-sibling must not satisfy the jail");
  } finally {
    try { rmSync(evil, { recursive: true, force: true }); } catch {}
  }
});

test("jail: a symlink resolving OUTSIDE the cwd is refused (realpath follows it)", () => {
  assert.equal(jailUnderCwd(root, "escape.txt", null), null);
  assert.equal(jailUnderCwd(root, "escape-dir", null), null);
});

test("jail: a request landing on the excluded uploadsDir is refused", () => {
  // uploads INSIDE cwd: the realpath is under root, so only the uploadsDir
  // exclusion stops it.
  assert.equal(jailUnderCwd(root, "uploads", uploadsInside), null);
  assert.equal(jailUnderCwd(root, "uploads/u.txt", uploadsInside), null);
  // uploads OUTSIDE cwd: refused by the under-root jail regardless.
  assert.equal(jailUnderCwd(root, uploads, uploads), null);
});

test("jail: a missing rootDir yields null (never throws)", () => {
  assert.equal(jailUnderCwd(null, "", null), null);
  assert.equal(jailUnderCwd("/no/such/dir/xyz", "", null), null);
});

// ---------------------------------------------------------------------------
// cwdList
// ---------------------------------------------------------------------------

test("list: the cwd root lists dirs + files, dots last, with sizes", () => {
  const out = cwdList(root, "", { uploadsDir: uploadsInside });
  assert.ok(out);
  assert.equal(out.rel, "");
  assert.equal(out.parent, null, "no parent above the cwd root");
  const dirNames = out.dirs.map((d) => d.name);
  assert.ok(dirNames.includes("src"), "src dir listed");
  assert.ok(dirNames.includes(".git"), "dotdir kept");
  assert.ok(!dirNames.includes("uploads"), "the excluded uploadsDir is never listed");
  // dotdir sorts last
  assert.equal(dirNames[dirNames.length - 1], ".git");
  const fileNames = out.files.map((f) => f.name);
  for (const n of ["README.md", "data.json", "notes.txt", "fake.txt", "blob.bin"]) assert.ok(fileNames.includes(n), n + " listed");
  assert.equal(fileNames[fileNames.length - 1], ".gitignore", "dotfile sorts last");
  const readme = out.files.find((f) => f.name === "README.md");
  assert.ok(typeof readme.size === "number" && readme.size > 0);
  assert.ok(typeof readme.mtime === "number");
  // an escaping symlink-to-file is NOT listed as a regular file
  assert.ok(!fileNames.includes("escape.txt"), "symlink-to-outside is skipped");
});

test("list: a subdir lists its own contents and a real parent", () => {
  const out = cwdList(root, "src", { uploadsDir: uploadsInside });
  assert.ok(out);
  assert.equal(out.rel, "src");
  assert.ok(out.dirs.map((d) => d.name).includes("deep"));
  assert.ok(out.files.map((f) => f.name).includes("index.js"));
  assert.equal(out.parent, jailUnderCwd(root, "", null).rootReal, "parent is the cwd root");
});

test("list: an out-of-jail path returns null", () => {
  assert.equal(cwdList(root, "/etc", {}), null);
  assert.equal(cwdList(root, "../..", {}), null);
});

test("list: the excluded uploadsDir returns null even when under cwd", () => {
  assert.equal(cwdList(root, "uploads", { uploadsDir: uploadsInside }), null);
});

// ---------------------------------------------------------------------------
// cwdRead
// ---------------------------------------------------------------------------

test("read: a text file returns its content + mime", () => {
  const out = cwdRead(root, "notes.txt", {});
  assert.ok(out && !out.error);
  assert.equal(out.name, "notes.txt");
  assert.equal(out.mime, "text/plain");
  assert.equal(out.text, "line one\nline two\n");
  assert.equal(out.truncated, false);
});

test("read: code + json + markdown map to their mimes", () => {
  assert.equal(cwdRead(root, "src/index.js", {}).mime, "text/javascript");
  assert.equal(cwdRead(root, "data.json", {}).mime, "application/json");
  assert.equal(cwdRead(root, "README.md", {}).mime, "text/markdown");
  assert.equal(cwdRead(root, ".gitignore", {}).mime, "text/plain", "known text basename");
});

test("read: an unknown extension is refused as unsupported (fail-closed)", () => {
  const out = cwdRead(root, "blob.bin", {});
  assert.deepEqual(out, { error: "unsupported" });
});

test("read: a binary wearing a .txt name is refused (NUL guard)", () => {
  const out = cwdRead(root, "fake.txt", {});
  assert.deepEqual(out, { error: "unsupported" });
});

test("read: a directory returns null (not viewable)", () => {
  assert.equal(cwdRead(root, "src", {}), null);
});

test("read: an out-of-jail / escaping path returns null", () => {
  assert.equal(cwdRead(root, "/etc/passwd", {}), null);
  assert.equal(cwdRead(root, "escape.txt", {}), null, "symlink escape refused");
  assert.equal(cwdRead(root, "../", {}), null);
});

test("read: the uploadsDir is never read even when under cwd", () => {
  assert.equal(cwdRead(root, "uploads/u.txt", { uploadsDir: uploadsInside }), null);
});

test("read: a file larger than the cap is truncated, not fully read", () => {
  const big = join(root, "big.log");
  writeFileSync(big, "x".repeat(CWD_READ_CAP + 5000));
  try {
    const out = cwdRead(root, "big.log", {});
    assert.ok(out && !out.error);
    assert.equal(out.truncated, true);
    assert.equal(out.text.length, CWD_READ_CAP, "exactly the cap is returned");
    assert.equal(out.size, CWD_READ_CAP + 5000, "the true size is reported");
  } finally {
    try { rmSync(big, { force: true }); } catch {}
  }
});

test("TEXT_EXT_MIME has no image/binary mimes (svg excluded)", () => {
  for (const [ext, mime] of Object.entries(TEXT_EXT_MIME)) {
    assert.ok(!mime.startsWith("image/"), `${ext} must not be an image mime`);
    assert.ok(!/octet-stream|zip|tar|gzip|pdf/.test(mime), `${ext} must not be binary`);
  }
  assert.equal(TEXT_EXT_MIME[".svg"], undefined, "svg is deliberately not viewable as text");
});
