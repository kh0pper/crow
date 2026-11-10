/**
 * `rootArgs` (scripts/pi-bots/pi_contain.mjs) is the sandbox root assembly pulled
 * out of `buildContainPlan`. This file pins that extraction: `oldRootArgs` below is
 * a frozen copy of the inline code exactly as it stood inside `buildContainPlan`
 * before rootArgs existed, and the exported function must produce the same argv on
 * this host.
 *
 * THE FROZEN COPY MUST NEVER BE EDITED. It is not a second implementation to keep
 * in step — it is the old behavior written down, so any change to rootArgs (an extra
 * bind, a dropped --tmpfs, a reordered mask) shows up here as a diff instead of
 * quietly reaching every contained spawn. If the root assembly is meant to change,
 * change rootArgs and update this file's expectation deliberately, in the same commit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rootArgs } from "../scripts/pi-bots/pi_contain.mjs";

// --- frozen: the root assembly as it was inside buildContainPlan --------------
function oldRootArgs(o, exists, home) {
  const args = ["--tmpfs", "/"];
  for (const d of o.systemDirs || ["/usr", "/etc", "/opt"]) if (exists(d)) args.push("--ro-bind", d, d);
  for (const [link, target] of [["/bin", "usr/bin"], ["/sbin", "usr/sbin"], ["/lib", "usr/lib"], ["/lib64", "usr/lib64"], ["/lib32", "usr/lib32"]]) {
    let isLink = false;
    try { isLink = lstatSync(link).isSymbolicLink(); } catch {}
    if (isLink) args.push("--symlink", target, link);
    else if (exists(link) && !o.systemDirs) args.push("--ro-bind", link, link);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--tmpfs", "/run");
  if (exists("/run/systemd/resolve")) args.push("--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve");
  if (exists("/etc/crow")) args.push("--tmpfs", "/etc/crow");
  args.push("--tmpfs", home);
  return args;
}
// --- end frozen ---------------------------------------------------------------

/** This host's fs, and a stand-in with no /opt and no resolved stub. */
const realExists = existsSync;
const withoutOptionalDirs = (path) => (path === "/run/systemd/resolve" || path === "/opt" ? false : existsSync(path));

const EXISTS_CASES = [
  ["existsSync", realExists],
  ["no /run/systemd/resolve and no /opt", withoutOptionalDirs],
];

const SYSTEM_DIR_CASES = [
  ["systemDirs undefined", undefined],
  ["systemDirs [/usr, /etc]", ["/usr", "/etc"]],
  ["systemDirs [/usr, /etc, /opt]", ["/usr", "/etc", "/opt"]],
];

test("rootArgs matches the inline root assembly it was extracted from", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-contain-home-"));
  for (const [existsLabel, exists] of EXISTS_CASES) {
    for (const [dirsLabel, systemDirs] of SYSTEM_DIR_CASES) {
      assert.deepEqual(
        rootArgs({ systemDirs, exists, home }),
        oldRootArgs({ systemDirs }, exists, home),
        `${dirsLabel}, ${existsLabel}`,
      );
    }
  }
});

test("rootArgs starts from an empty root and ends with the home tmpfs", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-contain-home-"));
  const args = rootArgs({ exists: realExists, home });
  assert.deepEqual(args.slice(0, 2), ["--tmpfs", "/"]);
  assert.deepEqual(args.slice(-2), ["--tmpfs", home]);
  assert.ok(args.includes("/proc") && args.includes("/dev"), "a fresh procfs and /dev of the sandbox's own");
});