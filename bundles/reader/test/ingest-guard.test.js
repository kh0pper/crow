import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertPathAllowed } from "../server/ingest-guard.js";

test("assertPathAllowed passes a file directly under the allowed root", () => {
  const root = mkdtempSync(join(tmpdir(), "reader-guard-root-"));
  try {
    const file = join(root, "doc.txt");
    writeFileSync(file, "hello");
    const resolved = assertPathAllowed(file, { READER_INGEST_ROOTS: root });
    assert.equal(resolved, realpathSync(file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertPathAllowed rejects a symlink under the root pointing outside it", () => {
  const root = mkdtempSync(join(tmpdir(), "reader-guard-root-"));
  const outside = mkdtempSync(join(tmpdir(), "reader-guard-outside-"));
  try {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "outside content");
    const link = join(root, "link.txt");
    symlinkSync(secret, link);
    assert.throws(
      () => assertPathAllowed(link, { READER_INGEST_ROOTS: root }),
      /outside READER_INGEST_ROOTS allowlist/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("assertPathAllowed throws a not-found error for a missing file", () => {
  const root = mkdtempSync(join(tmpdir(), "reader-guard-root-"));
  try {
    const missing = join(root, "nope.txt");
    assert.throws(
      () => assertPathAllowed(missing, { READER_INGEST_ROOTS: root }),
      /File not found/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
