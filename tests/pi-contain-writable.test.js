// Contain tier, end to end: what a contained process may WRITE.
//
// Two blockers from the contain-tier inventory (2026-11-19), both verified with
// a REAL bubblewrap run when the host has one (the test skips cleanly when it
// does not):
//   B1 — an MCP block's env names the instance's DBs (<data>/crow.db), and the
//        read-only bind of that file used to land on top of the writable data
//        dir, so a contained bot found crow.db read-only. A sqlite write through
//        the real plan must now succeed.
//   B4 — a masked data folder (another project's workspace) used to be a
//        WRITABLE scratch tmpfs: a write "succeeded" and vanished with the
//        spawn. The mask is now an empty READ-ONLY mount, so the same write
//        FAILS loudly.
//
// And the security-review blocker (2026-11-20): the data dir ROOT is writable, so
// masking only what exists at spawn let a bot CREATE `<data>/<installed id>/.venv`
// — code that add-on's own uv later runs OUTSIDE the sandbox. Every reserved name
// and every installed bundle id is now masked whether or not it exists, so the
// creation fails too. The root-read-only alternative was evaluated and rejected:
// SQLite creates `<db>-journal` in the data dir in DELETE mode and unlinks-and-
// recreates `-wal`/`-shm` in WAL mode, so a read-only root breaks the DBs.
// Only paths inside this test's own scratch tree are ever read or written.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContainPlan, ensureContainMountPoints, ensureContainOwnWorldRoot } from "../scripts/pi-bots/pi_contain.mjs";
import { probePiSandbox } from "../scripts/pi-bots/pi_sandbox.mjs";

const PROBE = probePiSandbox({ force: true });
const skip = PROBE.ok && PROBE.pidns !== false
  ? false
  : "bubblewrap with a PID namespace is unavailable here: " + (PROBE.reason || PROBE.pidnsReason || "no bwrap");

const T = realpathSync(mkdtempSync(join(tmpdir(), "crow-contain-writable-")));
after(() => rmSync(T, { recursive: true, force: true }));

const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };

// A scratch instance: a home, a Crow home with a data dir, the bot's own
// project workspace and another project's.
const H = mk(T, "home", "alice");
const crowHome = mk(H, ".crow");
const data = mk(crowHome, "data");
const mine = mk(data, "projects", "mine", "workspace");
const theirs = mk(data, "projects", "theirs");
const session = mk(T, "session");
const app = mk(T, "app");
const cache = mk(crowHome, "bot-cache");
writeFileSync(join(data, "crow.db"), "");
writeFileSync(join(data, "identity.json"), "{}");
writeFileSync(join(theirs, "their-notes.txt"), "theirs");
// An add-on that IS installed and has no data folder yet: its `<data>/<id>` must not be
// creatable by the bot (a `.venv` planted there is code the add-on's uv would run).
const ABSENT_ADDON = "absent-addon";
writeFileSync(join(crowHome, "installed.json"), JSON.stringify([ABSENT_ADDON]));

/**
 * The plan a contained spawn of this scratch bot would get: the Crow stdio
 * server block names the DB in its env exactly as `crowServerCatalog` does.
 * node is this process's own binary, so the sandbox holds a real runtime.
 */
function plan(over = {}) {
  return buildContainPlan({
    home: H, uid: process.getuid(), nodeBin: process.execPath,
    appRoot: app, piAgentDir: mk(H, ".pi", "agent"), shadowAgentDir: mk(T, "shadow"),
    crowHome, dataDir: data, botCacheDir: cache,
    sessionDir: session, cwd: session, workspaceDir: mine,
    writePaths: [], readPaths: [],
    mcpServers: [{ command: "node", args: [join(app, "servers", "memory", "index.js")], cwd: app,
      env: { CROW_DB_PATH: join(data, "crow.db"), CROW_DB: join(data, "crow.db") } }],
    systemDirs: ["/usr", "/etc"],
    ...over,
  });
}

/** Run one probe script inside the sandbox the plan describes. */
function inSandbox(p, script, env = {}) {
  return spawnSync(PROBE.bwrap, [...p.args, "--", process.execPath, "-e", script], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...p.env, ...env },
    encoding: "utf8", timeout: 60000,
  });
}

test("the fixture plan is the shape the two probes assume (checked on every host, with or without bwrap)", () => {
  const p = plan();
  const roDest = (f) => p.args.some((a, i) => a === "--ro-bind" && p.args[i + 2] === f);
  const remountOf = (f) => p.args.some((a, i) => a === "--remount-ro" && p.args[i + 1] === f);
  assert.equal(roDest(join(data, "crow.db")), false, "B1: the DB named in an MCP block's env is not re-bound read-only");
  assert.ok(p.args.some((a, i) => a === "--bind" && p.args[i + 2] === data), "the data dir itself is writable");
  assert.ok(remountOf(theirs), "B4: another project's folder is masked read-only");
  assert.equal(remountOf(mine), false, "the bot's own workspace is not masked");
  // Creation is closed for every trusted name, present or not: an installed add-on's data
  // folder and each reserved name that did not exist at spawn get an empty read-only mount.
  // The mount point is a PRECONDITION of the spawn — bwrap mounts over a path, and a plan
  // that only *believed* a directory was there ran with the name reachable — so the plan
  // names it and the spawner makes it before exec, here and in pi_sandbox.mjs.
  for (const name of [ABSENT_ADDON, "history", "previews", "deleted-projects", "legacy"]) {
    const dir = join(data, name);
    assert.ok(p.mountPoints.includes(dir), name + " is a named mount point");
    assert.equal(existsSync(dir), false, name + " is not created by building the plan");
  }
  const made = ensureContainMountPoints(p.mountPoints);
  for (const name of [ABSENT_ADDON, "history", "previews", "deleted-projects", "legacy"]) {
    const dir = join(data, name);
    assert.ok(p.args.some((a, i) => a === "--tmpfs" && p.args[i + 1] === dir), name + " is masked");
    assert.ok(remountOf(dir), name + " is remounted read-only");
    assert.ok(made.includes(dir), name + " was made by the spawner");
    const st = statSync(dir);
    assert.ok(st.isDirectory() && (st.mode & 0o777) === 0o700, name + " mount point is an empty 0700 dir");
    assert.equal(st.uid, process.getuid(), name + " mount point belongs to this uid");
  }
  assert.equal(existsSync(join(data, "instance-id")), false, "a missing instance-id file is never created here");
});

const PROBE_SCRIPT = `
const fs = require("node:fs");
const out = {};
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.env.CROW_TEST_DB);
  db.exec("CREATE TABLE probe (x INTEGER)");
  db.prepare("INSERT INTO probe VALUES (42)").run();
  db.close();
  out.db = "ok";
} catch (e) { out.db = e.code || String(e.message || e); }
const w = (p) => { try { fs.writeFileSync(p, "x"); return "ok"; } catch (e) { return e.code || String(e.message || e); } };
// A PLAIN (non-recursive) mkdir, deliberately, for every masked path probed here. Their
// parents exist — the parent IS the read-only mount — so the kernel answers EROFS for the
// child, which is the loud failure this test is about. Node's RECURSIVE mkdir instead
// posts its own ENOENT when the mkdir it tries inside a read-only parent fails, which would
// read as "the mask is missing" in this report rather than "the write was refused".
const mk = (p) => { try { fs.mkdirSync(p); return "ok"; } catch (e) { return e.code || String(e.message || e); } };
out.otherProject = w(process.env.CROW_TEST_OTHER);
out.ownWorkspace = w(process.env.CROW_TEST_MINE);
out.dataRoot = w(process.env.CROW_TEST_DATA);
out.maskedFile = w(process.env.CROW_TEST_IDENTITY);
// The security-review probe: an installed add-on whose data folder did not exist at
// spawn, and a reserved name that did not exist either. Both are masked read-only empty
// mounts, so neither the folder itself (EEXIST is a real answer there: the mount point
// exists, it is just not writable) NOR a .venv inside it can be created.
out.addonEntry = mk(process.env.CROW_TEST_ADDON);
out.addonVenv = mk(process.env.CROW_TEST_ADDON_VENV);
out.addonFile = w(process.env.CROW_TEST_ADDON_FILE);
out.reservedEntry = mk(process.env.CROW_TEST_RESERVED_DIR);
out.reservedCreate = mk(process.env.CROW_TEST_RESERVED);
// The documented residual: a top-level name that is neither reserved nor installed at
// spawn time. Nothing on the host trusts it (a bundle's folder is only bound for an id
// both installer records know), and the NEXT spawn masks it as a present entry.
out.newTop = mk(process.env.CROW_TEST_NEW_TOP);
out.newTopChild = w(process.env.CROW_TEST_NEW_TOP_FILE);
console.log(JSON.stringify(out));
`;

test("B1/B4 in a real sandbox: crow.db is writable, a masked project folder is NOT", { skip, timeout: 60000 }, async () => {
  const p = plan();
  // What pi_sandbox.mjs's contain branch does before it hands bwrap the argv: the empty
  // mount points of the absent-entry masks are made first (0700, never through a symlink),
  // and a mount point that cannot be made refuses the spawn.
  ensureContainMountPoints(p.mountPoints);
  const r = inSandbox(p, PROBE_SCRIPT, {
    CROW_TEST_DB: join(data, "crow.db"),
    CROW_TEST_OTHER: join(theirs, "planted.txt"),
    CROW_TEST_MINE: join(mine, "kept.txt"),
    CROW_TEST_DATA: join(data, "spawn-probe.txt"),
    CROW_TEST_IDENTITY: join(data, "identity.json"),
    CROW_TEST_ADDON: join(data, ABSENT_ADDON),
    CROW_TEST_ADDON_VENV: join(data, ABSENT_ADDON, ".venv"),
    CROW_TEST_ADDON_FILE: join(data, ABSENT_ADDON, "evil.txt"),
    CROW_TEST_RESERVED_DIR: join(data, "history"),
    CROW_TEST_RESERVED: join(data, "history", "planted"),
    CROW_TEST_NEW_TOP: join(data, "totally-new"),
    CROW_TEST_NEW_TOP_FILE: join(data, "totally-new", "planted.txt"),
  });
  assert.equal(r.status, 0, "bwrap ran the probe: " + (r.stderr || "") + (r.stdout || ""));
  const out = JSON.parse(String(r.stdout).trim().split("\n").pop());

  // B1: the bot's own MCP server opens the DB read-write.
  assert.equal(out.db, "ok", "crow.db is writable inside (the read-only env bind no longer wins)");
  // The write really landed on the host DB (not a private copy).
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(data, "crow.db"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT x FROM probe").get().x, 42, "the row is in the host database");
  } finally { db.close(); }

  // B4: a write into ANOTHER project's folder fails loudly (read-only mask),
  // and nothing was created there.
  assert.equal(out.otherProject, "EROFS");
  assert.throws(() => statSync(join(theirs, "planted.txt")), /ENOENT/);
  // A masked FILE (identity.json) refuses the write too.
  assert.notEqual(out.maskedFile, "ok");
  // The bot's own workspace and the data dir root stay writable.
  assert.equal(out.ownWorkspace, "ok");
  assert.equal(out.dataRoot, "ok");
  assert.equal(statSync(join(mine, "kept.txt")).isFile(), true);

  // Security review: no entry a host process later trusts can be created either — an
  // installed add-on's data folder (where its uv venv would live) and a reserved name are
  // empty read-only mounts, so neither the entry itself nor anything inside it can be made
  // (a plain mkdir of the masked name reports EEXIST, or EROFS when the kernel answers for
  // the read-only mount first; a plain mkdir of a child INSIDE it reports EROFS, because its
  // parent exists — the probe never uses a recursive mkdir on a masked path, since Node
  // surfaces that read-only refusal as an ENOENT), and nothing appears on the host.
  for (const [k, v] of [["addonEntry", out.addonEntry], ["reservedEntry", out.reservedEntry]]) {
    assert.ok(v === "EEXIST" || v === "EROFS", k + " must not be creatable (got " + JSON.stringify(v) + ")" +
      " — a missing mount point here means the trusted name is reachable");
  }
  assert.equal(out.addonVenv, "EROFS", "a .venv cannot be made in an add-on's data folder");
  assert.equal(out.addonFile, "EROFS", "nor any file in it");
  assert.equal(out.reservedCreate, "EROFS", "nothing can be made inside a reserved data-dir name");
  assert.equal(existsSync(join(data, ABSENT_ADDON, ".venv")), false);
  assert.equal(existsSync(join(data, ABSENT_ADDON, "evil.txt")), false);
  assert.equal(existsSync(join(data, "history", "planted")), false);
  // The mount point the spawner made is still there, empty and 0700 (the bot wrote nothing).
  const addonDir = statSync(join(data, ABSENT_ADDON));
  assert.ok(addonDir.isDirectory() && (addonDir.mode & 0o777) === 0o700);

  // The documented residual (contain-tier review): a top-level name that is neither reserved
  // nor an id installed AT SPAWN is creatable — nothing on the host trusts a name Crow did
  // not install — and the next spawn masks it as a present entry.
  assert.equal(out.newTop, "ok", "an unknown top-level name is creatable inside (documented residual)");
  assert.equal(out.newTopChild, "ok");
  assert.equal(statSync(join(data, "totally-new", "planted.txt")).isFile(), true, "it is the host dir: no trust attaches to the name");
  const next = plan();
  assert.ok(next.args.some((a, i) => a === "--tmpfs" && next.args[i + 1] === join(data, "totally-new")),
    "the next spawn masks it (a present entry now)");
});

// The travel-agent finding (2026-11-19): the bot's OWN pre-project world root
// (<crowHome>/pi-bots/<id>) never existed, so the plan dropped it and the write into the
// sandbox's tmpfs $HOME "succeeded" and vanished. The spawner now creates it (0700, this uid)
// before the plan when it is missing and inside pi-bots, and the write must land on the HOST.
test("the bot's own world root that never existed is created (0700) and a write there lands on the host", { skip, timeout: 60000 }, () => {
  const ownRoot = join(crowHome, "pi-bots", "travel-agent");
  assert.equal(existsSync(ownRoot), false, "the fixture starts with no own root: the travel-agent case");
  const made = ensureContainOwnWorldRoot(ownRoot, { crowHome });
  assert.equal(made, ownRoot);
  const st = statSync(ownRoot);
  assert.ok(st.isDirectory() && (st.mode & 0o777) === 0o700, "the root is a 0700 dir");
  assert.equal(st.uid, process.getuid());
  const p = plan({ botStateDir: ownRoot, writePaths: [ownRoot, join(ownRoot, "proposed-skills")] });
  assert.ok(p.args.some((a, i) => a === "--bind" && p.args[i + 2] === ownRoot), "the root is bound read-write");
  assert.deepEqual(p.droppedWrites, [], "a missing child UNDER the bound root is not called dropped");
  ensureContainMountPoints(p.mountPoints);
  const r = inSandbox(p, `
const fs = require("node:fs");
const out = {};
try {
  fs.mkdirSync(process.env.CROW_TEST_OWN + "/proposed-skills");
  fs.writeFileSync(process.env.CROW_TEST_OWN + "/contain-smoke.txt", "smoke");
  out.write = "ok";
} catch (e) { out.write = e.code || String(e.message || e); }
console.log(JSON.stringify(out));
`, { CROW_TEST_OWN: ownRoot });
  assert.equal(r.status, 0, "bwrap ran the probe: " + (r.stderr || "") + (r.stdout || ""));
  const out = JSON.parse(String(r.stdout).trim().split("\n").pop());
  assert.equal(out.write, "ok");
  assert.equal(readFileSync(join(ownRoot, "contain-smoke.txt"), "utf8"), "smoke",
    "the write landed on the HOST, not in the sandbox's throwaway tmpfs");
  assert.equal(statSync(join(ownRoot, "proposed-skills")).isDirectory(), true, "the folder it made is on the host too");
});