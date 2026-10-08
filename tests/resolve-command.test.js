/**
 * Add-on launch commands (servers/shared/resolve-command.js).
 *
 * A bot shell runs as the operator's uid, so a launcher in any directory that
 * uid owns (~/.local/bin, ~/.nvm, the bundle dir) can be swapped by a bot.
 * Bare names resolve only in fixed root-owned system dirs (never PATH, never
 * a user dir); absolute user-owned paths need an operator pin
 * (command_sha256) that is re-hashed at every call; `node` is the gateway's
 * own binary; everything else is refused with a reason — never a fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAddonCommand, TRUSTED_DIRS } from "../servers/shared/resolve-command.js";

function userBin() {
  const home = mkdtempSync(join(tmpdir(), "resolve-cmd-"));
  const local = join(home, ".local", "bin");
  mkdirSync(local, { recursive: true });
  const uvx = join(local, "uvx");
  writeFileSync(uvx, "#!/bin/sh\necho uvx\n"); chmodSync(uvx, 0o755);
  return { home, local, uvx };
}
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("trusted dirs are the fixed system list; PATH is never consulted", () => {
  assert.deepEqual([...TRUSTED_DIRS], ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"]);
  const { local } = userBin();
  // even with the user dir first on PATH, a bare name never resolves there
  const r = resolveAddonCommand("uvx", { trustedDirs: ["/usr/bin"] });
  assert.equal(r.missing, true);
  assert.match(r.reason, /command_sha256/);
  void local;
});

test("a bare name resolves in a root-owned system dir (every component root-owned)", () => {
  const r = resolveAddonCommand("sh");
  assert.equal(r.missing, false);
  assert.equal(r.command, realpathSync("/bin/sh"), "the real path of the hit");
});

test("a bare name found in a NON-root dir of the trusted list is refused, never skipped past", () => {
  const { local } = userBin();
  const r = resolveAddonCommand("uvx", { trustedDirs: [local, "/usr/bin"] });
  assert.equal(r.missing, true);
  assert.match(r.reason, /not owned by root/);
});

test("node is the gateway's own binary", () => {
  assert.deepEqual(resolveAddonCommand("node", { execPath: "/opt/node/bin/node" }), { command: "/opt/node/bin/node", resolved: true, missing: false });
});

test("an absolute user-owned launcher needs the operator pin, re-hashed every call", () => {
  const { uvx } = userBin();
  const unpinned = resolveAddonCommand(uvx);
  assert.equal(unpinned.missing, true);
  assert.match(unpinned.reason, /command_sha256/);
  const pin = sha("#!/bin/sh\necho uvx\n");
  assert.equal(resolveAddonCommand(uvx, { sha256: pin }).missing, false);
  writeFileSync(uvx, "#!/bin/sh\necho pwned\n");              // a bot rewrites it in place
  const swapped = resolveAddonCommand(uvx, { sha256: pin });
  assert.equal(swapped.missing, true);
  assert.match(swapped.reason, /does not match/);
});

test("symlinks are resolved: a root-owned-looking link to a user file is refused", () => {
  const { home, uvx } = userBin();
  const link = join(home, "link-uvx");
  symlinkSync(uvx, link);
  assert.equal(resolveAddonCommand(link).missing, true);
});

test("relative paths and '..' are refused; absolute root-owned paths pass unchanged", () => {
  assert.equal(resolveAddonCommand("./run.sh").missing, true);
  assert.equal(resolveAddonCommand("/usr/bin/../bin/sh").missing, true);
  const r = resolveAddonCommand("/bin/sh");
  assert.equal(r.missing, false);
  assert.equal(r.command, realpathSync("/bin/sh"));
});

test("empty / non-string commands are unchanged and not reported", () => {
  assert.deepEqual(resolveAddonCommand(undefined), { command: undefined, resolved: false, missing: false });
  assert.deepEqual(resolveAddonCommand(""), { command: "", resolved: false, missing: false });
});

// --- TOCTOU (scan 2026-10-08): the verified REAL path is what gets executed,
// and the pin rides along so the process that spawns re-verifies it.
test("toctou: a pinned launcher reached through a symlink resolves to its real path; swapping the link later changes nothing", async () => {
  const { home, uvx } = userBin();
  const { unlinkSync } = await import("node:fs");
  const link = join(home, "uvx-link");
  symlinkSync(uvx, link);
  const pin = sha("#!/bin/sh\necho uvx\n");
  const r = resolveAddonCommand(link, { sha256: pin });
  assert.equal(r.missing, false);
  assert.equal(r.command, uvx, "the real path, not the link");
  const evil = join(home, "evil");
  writeFileSync(evil, "#!/bin/sh\necho pwned\n"); chmodSync(evil, 0o755);
  unlinkSync(link); symlinkSync(evil, link);              // swap after the config was built
  assert.equal(r.command, uvx, "the built config still points at the verified file");
  assert.match(resolveAddonCommand(link, { sha256: pin }).reason || "", /does not match/);
});

test("toctou: a root-owned bare hit resolves to its real path (no symlink in what is executed)", () => {
  const r = resolveAddonCommand("sh");
  assert.equal(r.command, realpathSync(r.command));
});

// --- rev g: a pinned uv/uvx still fetches whatever --from names; a floating
// git ref would run code nobody pinned.
test("checkLauncherArgs: uv/uvx --from git+… must name a commit SHA", async () => {
  const { checkLauncherArgs } = await import("../servers/shared/resolve-command.js");
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  assert.match(checkLauncherArgs("/h/.local/bin/uvx", ["--from", "git+https://github.com/x/y", "y"]) || "", /commit/);
  assert.match(checkLauncherArgs("/h/.local/bin/uvx", ["--from", "git+https://github.com/x/y@main", "y"]) || "", /commit/);
  assert.match(checkLauncherArgs("/usr/bin/uv", ["tool", "run", "--from=git+https://github.com/x/y@v1.2", "y"]) || "", /commit/);
  assert.equal(checkLauncherArgs("/h/.local/bin/uvx", ["--from", `git+https://github.com/x/y@${SHA}`, "y"]), null);
  assert.equal(checkLauncherArgs("/h/.local/bin/uv", ["run", "--quiet", "kb-mcp"]), null, "a local project run has no ref to pin");
  assert.equal(checkLauncherArgs("/usr/bin/node", ["git+https://x"]), null, "only uv/uvx are judged");
});

// --- R2 (re-check 2026-10-08): shipped bundles must keep working ---
test("R2: npm/npx next to the gateway's own Node are trusted exactly like node", async () => {
  const { dirname } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const npx = join(dirname(process.execPath), "npx");
  const r = resolveAddonCommand("npx");
  if (existsSync(npx)) {
    assert.equal(r.missing, false, r.reason);
    assert.equal(r.command, realpathSync(npx));
  }
  // a fake node dir: npx there is trusted only because node there is the gateway's
  const d = mkdtempSync(join(tmpdir(), "nodedir-"));
  writeFileSync(join(d, "node"), "#!/bin/sh\n"); chmodSync(join(d, "node"), 0o755);
  writeFileSync(join(d, "npm"), "#!/bin/sh\n"); chmodSync(join(d, "npm"), 0o755);
  assert.equal(resolveAddonCommand("npm", { execPath: join(d, "node") }).command, join(d, "npm"));
  assert.equal(resolveAddonCommand("npx", { execPath: join(d, "node") }).missing, true, "no npx there");
});

test("R2: a relative launcher resolves inside the add-on's own folder (pinned), never outside it", async () => {
  const { home } = userBin();
  const bdir = join(home, "bundles", "rookery");
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, "run.sh"), "#!/bin/bash\necho rookery\n"); chmodSync(join(bdir, "run.sh"), 0o755);
  const pin = sha("#!/bin/bash\necho rookery\n");
  assert.match(resolveAddonCommand("./run.sh", { cwd: bdir }).reason || "", /command_sha256/, "unpinned → refused with the re-pin hint");
  const ok = resolveAddonCommand("./run.sh", { cwd: bdir, sha256: pin });
  assert.equal(ok.missing, false, ok.reason);
  assert.equal(ok.command, realpathSync(join(bdir, "run.sh")));
  assert.equal(resolveAddonCommand("run.sh", { cwd: bdir, sha256: pin }).missing, true, "a bare name is never looked up in the bundle");
  writeFileSync(join(home, "outside.sh"), "#!/bin/bash\n"); chmodSync(join(home, "outside.sh"), 0o755);
  assert.equal(resolveAddonCommand("../../outside.sh", { cwd: bdir, sha256: sha("#!/bin/bash\n") }).missing, true, "no escape via ..");
  symlinkSync(join(home, "outside.sh"), join(bdir, "link.sh"));
  const esc = resolveAddonCommand("./link.sh", { cwd: bdir, sha256: sha("#!/bin/bash\n") });
  assert.equal(esc.missing, true, "no escape via a symlink");
  assert.match(esc.reason, /outside/);
  assert.equal(resolveAddonCommand("./run.sh", { sha256: pin }).missing, true, "no folder given → refused");
});

test("R2: launcherPin pins a relative bundle launcher and an absolute user launcher; not node/npm/npx/system ones", async () => {
  const { launcherPin } = await import("../servers/shared/resolve-command.js");
  const { home, uvx } = userBin();
  const bdir = join(home, "bundles", "b");
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, "run.sh"), "#!/bin/bash\n"); chmodSync(join(bdir, "run.sh"), 0o755);
  assert.equal(launcherPin("./run.sh", bdir), sha("#!/bin/bash\n"));
  assert.equal(launcherPin(uvx, bdir), sha("#!/bin/sh\necho uvx\n"));
  assert.equal(launcherPin("node", bdir), null);
  assert.equal(launcherPin("npx", bdir), null);
  assert.equal(launcherPin("/bin/sh", bdir), null, "root-owned needs no pin");
  assert.equal(launcherPin("uvx", bdir), null, "a bare name cannot be pinned (give an absolute path)");
});
