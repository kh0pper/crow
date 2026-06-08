import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { resolveSafeMarkdownPath } from "../servers/gateway/routes/fileview.js";

// Allowlist root used by most cases. Put the sandbox UNDER the user's home so
// it is inside the real default root too, but pass it explicitly for clarity.
const root = mkdtempSync(join(homedir(), ".fileview-test-"));
const outside = mkdtempSync(join(tmpdir(), "fileview-outside-"));

const okMd = join(root, "doc.md");
const txt = join(root, "notes.txt");
const outsideMd = join(outside, "secret.md");
const escapeLink = join(root, "escape.md"); // symlink -> outsideMd

writeFileSync(okMd, "# hi\n");
writeFileSync(txt, "nope\n");
writeFileSync(outsideMd, "# outside\n");
symlinkSync(outsideMd, escapeLink);

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("accepts a real .md file under the allow root", () => {
  assert.equal(resolveSafeMarkdownPath(okMd, root), realpathSync(okMd));
});

test("rejects a non-.md file", () => {
  assert.equal(resolveSafeMarkdownPath(txt, root), null);
});

test("rejects a real .md file OUTSIDE the allow root", () => {
  assert.equal(resolveSafeMarkdownPath(outsideMd, root), null);
});

test("rejects a symlink that escapes the root (resolves outside)", () => {
  // The link itself is under root and ends in .md, but realpath lands outside.
  assert.equal(resolveSafeMarkdownPath(escapeLink, root), null);
});

test("rejects a traversal path that climbs out of the root", () => {
  assert.equal(resolveSafeMarkdownPath(join(root, "..", "..", "etc", "hosts.md"), root), null);
});

test("rejects a nonexistent path", () => {
  assert.equal(resolveSafeMarkdownPath(join(root, "missing.md"), root), null);
});

test("rejects empty / non-string input", () => {
  assert.equal(resolveSafeMarkdownPath("", root), null);
  assert.equal(resolveSafeMarkdownPath(undefined, root), null);
  assert.equal(resolveSafeMarkdownPath(null, root), null);
});

test("default root is /home/kh0pp (a repo .md resolves)", () => {
  // Uses the real default allowRoot; the F3 plan lives under /home/kh0pp/crow.
  const planMd = "/home/kh0pp/crow/docs/superpowers/plans/2026-06-08-f3-bot-builder-to-core.md";
  const r = resolveSafeMarkdownPath(planMd);
  assert.equal(r, realpathSync(planMd));
});
