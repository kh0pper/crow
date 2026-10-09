// Crow Artifacts Task 2.8: the core backup covers the blob store. DB rows
// reference blobs by sha256 key, so a restore needs the dump AND
// <dataDir>/artifacts/ — the dry run must list the rsync of that directory.
// (Env is passed explicitly; note backup.sh sources $CROW_ROOT/.env when
// present, which a repo checkout in active use may carry — CI and test
// worktrees do not.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("backup.sh --dry-run lists the artifacts store rsync next to the DB dump", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-backup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "data");
  mkdirSync(join(dataDir, "artifacts", "sha256"), { recursive: true });
  mkdirSync(join(dir, "backups"), { recursive: true });   // the dry-run prune step stats it
  writeFileSync(join(dataDir, "crow.db"), "not a real db");   // dry run never opens it
  writeFileSync(join(dataDir, "artifacts", "sha256", "obj"), "x");
  const out = execFileSync("bash", [join(ROOT, "scripts/backup.sh"), "--dry-run"], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      CROW_DB_PATH: join(dataDir, "crow.db"),
      CROW_BACKUP_DIR: join(dir, "backups"),
      MINIO_ENDPOINT: "", MINIO_ACCESS_KEY: "", MINIO_SECRET_KEY: "",
      CROW_BACKUP_GIT_REPO: "",
    },
  });
  assert.match(out, /\[dry-run\] Would create: .*crow-[\d-]+\.sql/, "the dump is still listed");
  assert.match(out, new RegExp(`\\[dry-run\\] Would rsync ${escRe(join(dataDir, "artifacts"))}/`), "the artifacts store is listed");
});

test("backup.sh --dry-run without an artifacts store copies nothing extra", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-backup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dir, "backups"), { recursive: true });   // the dry-run prune step stats it
  writeFileSync(join(dataDir, "crow.db"), "not a real db");
  const out = execFileSync("bash", [join(ROOT, "scripts/backup.sh"), "--dry-run"], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      CROW_DB_PATH: join(dataDir, "crow.db"),
      CROW_BACKUP_DIR: join(dir, "backups"),
      MINIO_ENDPOINT: "", MINIO_ACCESS_KEY: "", MINIO_SECRET_KEY: "",
      CROW_BACKUP_GIT_REPO: "",
    },
  });
  assert.doesNotMatch(out, /Would rsync/, "no store, no rsync line");
});
