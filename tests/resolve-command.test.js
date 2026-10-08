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
