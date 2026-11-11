/**
 * writeTokenFile (servers/gateway/local-token.js): a rewrite must land in place
 * on the same inode (a running bot's mask is bound to it), and must never be
 * talked into following a link, opening a FIFO, or writing through a second
 * name for the old inode. Fake tokens, scratch dirs under os.tmpdir().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync,
  linkSync, statSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTokenFile } from "../servers/gateway/local-token.js";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "crow-token-write-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const modeOf = (p) => statSync(p).mode & 0o777;

test("a symlink swapped in at the path is not followed: the target is untouched, the path becomes our own 0600 file", (t) => {
  const dir = scratch(t);
  const target = join(dir, "elsewhere");
  writeFileSync(target, "keep me\n", { mode: 0o644 });
  const targetMode = modeOf(target);
  const path = join(dir, "board-token");
  symlinkSync(target, path);
  writeTokenFile(path, TOKEN_A);
  assert.equal(readFileSync(target, "utf8"), "keep me\n", "the link's target keeps its content");
  assert.equal(modeOf(target), targetMode, "and its mode");
  assert.equal(lstatSync(path).isSymbolicLink(), false, "the path is a regular file now");
  assert.equal(statSync(path).isFile(), true);
  assert.equal(readFileSync(path, "utf8"), TOKEN_A);
  assert.equal(modeOf(path), 0o600);
});

test("a FIFO at the path neither hangs nor is written to: it is replaced by our own 0600 file", (t) => {
  const dir = scratch(t);
  const path = join(dir, "phone-token");
  execFileSync("mkfifo", [path]);
  const started = Date.now();
  writeTokenFile(path, TOKEN_A);
  assert.ok(Date.now() - started < 5000, "the call returned without waiting for a reader");
  assert.equal(statSync(path).isFile(), true, "the FIFO was replaced");
  assert.equal(readFileSync(path, "utf8"), TOKEN_A);
  assert.equal(modeOf(path), 0o600);
});

test("rewriting an existing token file keeps its inode, so a running bot's mask stays on it", (t) => {
  const dir = scratch(t);
  const path = join(dir, "artifacts-token");
  mkdirSync(dir, { recursive: true });
  writeTokenFile(path, TOKEN_A);
  const before = statSync(path).ino;
  writeTokenFile(path, TOKEN_B);
  assert.equal(statSync(path).ino, before, "same inode");
  assert.equal(readFileSync(path, "utf8"), TOKEN_B, "the second token");
  assert.equal(modeOf(path), 0o600);
});

test("a hard-linked token file (nlink 2) is replaced: the other name keeps the old content", (t) => {
  const dir = scratch(t);
  const path = join(dir, "models-token");
  const other = join(dir, "copied-name");
  writeFileSync(path, TOKEN_A, { mode: 0o600 });
  linkSync(path, other);
  assert.equal(statSync(path).nlink, 2);
  writeTokenFile(path, TOKEN_B);
  assert.equal(readFileSync(other, "utf8"), TOKEN_A, "the other name keeps the old token");
  assert.equal(readFileSync(path, "utf8"), TOKEN_B, "the path holds the new one");
  assert.equal(statSync(path).nlink, 1);
  assert.notEqual(statSync(path).ino, statSync(other).ino, "a new inode");
  assert.equal(modeOf(path), 0o600);
});