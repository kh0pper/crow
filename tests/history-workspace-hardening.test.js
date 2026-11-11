/**
 * Version history, Task 6: the parts of the project-file history that need no
 * git — the deny list, the setting that gates the scheduled erase, and the
 * job-runner commit hook.
 *
 * The git-driven tests live in tests/history-workspace.test.js and skip on a host
 * without git; these must pass everywhere, which is why they are here.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CARRIED_ENTRIES } from "../scripts/pi-bots/world-root.mjs";
import { isDeniedEntry, MAX_FILE_BYTES } from "../servers/shared/history/workspace-deny.js";
import { HISTORY_SETTINGS } from "../servers/gateway/dashboard/settings/sections/history.js";
import {
  SYNC_ALLOWLIST,
  isInstanceScope,
  isSyncable,
} from "../servers/gateway/dashboard/settings/sync-allowlist.js";

/* ------------------------------------------------------------ the deny list */

test("a bot's carried entries are denied, except the user's own outputs", () => {
  assert.deepEqual([...CARRIED_ENTRIES].sort(), [".mcp.json", ".pi", "outputs", "sessions"]);
  for (const name of CARRIED_ENTRIES) {
    if (name === "outputs") {
      assert.equal(isDeniedEntry(name, true), false, "outputs are the user's deliverables and are recorded");
      assert.equal(isDeniedEntry(name, false), false);
      continue;
    }
    assert.equal(isDeniedEntry(name, true), true, `${name}/ must be denied`);
  }
  // The two carried FILES are denied as files as well.
  assert.equal(isDeniedEntry(".mcp.json", false), true);
  assert.equal(isDeniedEntry(".pi", false), true);
  // `sessions` is a ROOT folder only: a project's own nested `sessions` is content.
  assert.equal(isDeniedEntry("sessions", true), true);
  assert.equal(isDeniedEntry("sessions", false), false);
  assert.equal(isDeniedEntry("nested/sessions", true), false);
});

test("ssh, cloud, gpg, kube, docker and password-vault secrets are denied", () => {
  for (const rel of [".ssh", ".aws", ".gnupg", ".kube", "home/.ssh", "deep/.AWS"]) {
    assert.equal(isDeniedEntry(rel, true), true, `${rel}/ must be denied`);
  }
  for (const rel of ["credentials.json", "deep/credentials.json", "vault.kdbx", "a/Vault.KDBX", ".docker/config.json", "deep/.docker/config.json"]) {
    assert.equal(isDeniedEntry(rel, false), true, `${rel} must be denied`);
  }
  // Only Docker's one credentials file is a secret, not the folder or its siblings.
  assert.equal(isDeniedEntry(".docker", true), false);
  assert.equal(isDeniedEntry(".docker/other.json", false), false);
  assert.equal(isDeniedEntry("config.json", false), false);
});

test("credentials, keys, bot worlds and build output are denied at any depth", () => {
  const denied = [
    ".env", ".env.local", ".env.example", ".mcp.json", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
    "server.pem", "server.key", "id_rsa", "id_rsa.pub", "id_ed25519", "id_ecdsa", "cert.p12", "cert.pfx",
    "app.db", "app.db-wal", "app.db-shm",
    "deep/.env", "deep/dir/server.pem", "a/b/c/id_rsa",
    ".pi", ".venv", "node_modules", "__pycache__", ".cache", "target", "dist", ".next",
    "deep/node_modules", "deep/target", "deep/dist",
  ];
  for (const rel of denied) {
    const isDir = ["node_modules", ".venv", "__pycache__", ".cache", "target", "dist", ".next"].includes(rel.split("/").pop());
    assert.equal(isDeniedEntry(rel, isDir), true, `${rel} must be denied`);
  }
});

test("matching is case-insensitive, and ordinary content is not denied", () => {
  assert.equal(isDeniedEntry(".ENV", false), true);
  assert.equal(isDeniedEntry("NODE_MODULES", true), true);
  assert.equal(isDeniedEntry("Secrets/X.PEM", false), true);
  assert.equal(isDeniedEntry("App.DB", false), true);

  const allowed = [
    "notes.md", "src/index.js", "README", "docs/.envrc-notes", "environments", "keys.txt",
    "dist.txt", "target.md", "sessions.md", "outputs", "nested/outputs", "LICENSE", ".gitignore",
  ];
  for (const rel of allowed) {
    assert.equal(isDeniedEntry(rel, false), false, `${rel} must be recorded`);
    assert.equal(isDeniedEntry(rel, true), false, `${rel}/ must be recorded`);
  }
  // A folder named like a denied FILE is ordinary content, and vice versa.
  assert.equal(isDeniedEntry("app.db", true), false);
  assert.equal(isDeniedEntry("dist", false), false);
});

test("the size cap is 25 MB", () => {
  assert.equal(MAX_FILE_BYTES, 25 * 1024 * 1024);
});

/* ------------------------------------------------------------ the setting */

test("the scheduled workspace erase is a local, never-synced history setting", () => {
  assert.equal(HISTORY_SETTINGS.workspaceAutoErase, "history.workspace_auto_erase");
  for (const key of Object.values(HISTORY_SETTINGS)) {
    assert.equal(isInstanceScope(key), true, `${key} is per install`);
    assert.equal(isSyncable(key), false, `${key} must never sync`);
  }
  assert.equal(Object.keys(SYNC_ALLOWLIST).includes("history.workspace_auto_erase"), false);
  assert.equal(isInstanceScope("history.workspace_auto_erase"), true);
  assert.equal(isSyncable("history.workspace_auto_erase"), false);
  assert.equal(isSyncable("history.trash_days"), false);
});

/* ----------------------------------------------------- the job-runner hook */

const dir = mkdtempSync(join(tmpdir(), "hist-ws-jobhook-"));
process.env.CROW_DB_PATH = join(dir, "crow.db");

let runner;
before(async () => {
  // A minimal database file: this hook never touches it (the commit and the
  // project row are injected), but the module resolves its path on load.
  const init = new Database(process.env.CROW_DB_PATH);
  init.exec("CREATE TABLE bot_jobs (job_id INTEGER PRIMARY KEY, bot_id TEXT);");
  init.close();
  runner = await import("../scripts/pi-bots/job_runner.mjs");
});
after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** The bridge a bot's job sees, with one project behind it. */
function fakeBridge({ projectId = 5, uuid = "0123456789abcdef", displayName = "Hank" } = {}) {
  const space = { id: projectId, uuid, workspace_dir: `/tmp/not-used-${projectId}` };
  return {
    loadBot: () => ({ bot_id: "hank", display_name: displayName, project_id: projectId }),
    loadProjectSpace: (id) => (Number(id) === Number(projectId) ? space : null),
  };
}

test("a job's start and end commits carry the right attribution", async () => {
  const bridge = fakeBridge();
  const seen = [];
  const commit = async (project, ctx, message, opts) => {
    seen.push({ project, ctx, message, opts });
    return "a".repeat(40);
  };

  const startSha = await runner.commitJobWorkspace({ job_id: 11, bot_id: "hank" }, "start", { bridge, commit });
  assert.equal(startSha, "a".repeat(40));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].ctx, { authorKind: "unattributed", authorId: "outside-crow" }, "an outside edit belongs to nobody");
  assert.equal(seen[0].message, "Update");
  assert.equal(seen[0].project.id, 5);
  assert.equal(seen[0].project.uuid, "0123456789abcdef", "the portable id is passed through");
  assert.equal(seen[0].opts.lockWaitMs, 30_000, "a job tries the lock, it never parks on it");

  await runner.commitJobWorkspace({ job_id: 12, bot_id: "hank", card_id: 7 }, "end", { bridge, commit });
  assert.deepEqual(seen[1].ctx, { authorKind: "bot", authorId: "hank", jobId: "card:7" });
  assert.match(seen[1].message, /Hank finished a job/);

  await runner.commitJobWorkspace({ job_id: 13, bot_id: "hank" }, "end", { bridge, commit });
  assert.equal(seen[2].ctx.jobId, "turn:job-13", "a turn without a card still groups its versions");

  // The live check re-reads the project row: a purged or replaced project fails.
  assert.equal(await seen[0].opts.isLive({ id: 5, uuid: "0123456789abcdef" }), true);
  assert.equal(await seen[0].opts.isLive({ id: 5, uuid: "ffffffffffffffff" }), false);
  assert.equal(await seen[0].opts.isLive({ id: 6, uuid: "0123456789abcdef" }), false);
});

test("a busy lock is recorded as a skip and never fails the job", async () => {
  const logs = [];
  const commit = async (_project, _ctx, _message, opts) => {
    opts.onNote("busy");
    return null;
  };
  const sha = await runner.commitJobWorkspace(
    { job_id: 21, bot_id: "hank", card_id: 3 },
    "end",
    { bridge: fakeBridge(), commit, log: (line) => logs.push(line) },
  );
  assert.equal(sha, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /busy/);
  assert.match(logs[0], /non-fatal|skipped/, "the skip is a note, not a failure");
});

test("a failing commit does not fail the job", async () => {
  const logs = [];
  const commit = async () => { throw new Error("the disk is on fire"); };
  const sha = await runner.commitJobWorkspace(
    { job_id: 22, bot_id: "hank" },
    "end",
    { bridge: fakeBridge(), commit, log: (line) => logs.push(line) },
  );
  assert.equal(sha, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /on fire/);
});

test("a bot with no project records nothing at all", async () => {
  let called = false;
  const commit = async () => { called = true; return "b".repeat(40); };
  const bridge = { loadBot: () => ({ bot_id: "hank", project_id: null }), loadProjectSpace: () => null };
  assert.equal(await runner.commitJobWorkspace({ job_id: 23, bot_id: "hank" }, "end", { bridge, commit }), null);
  assert.equal(called, false);
  assert.equal(await runner.commitJobWorkspace({ job_id: 24, bot_id: "hank" }, "sideways", { bridge, commit }), null);
  assert.equal(called, false);
});