import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "crow-install.sh");
const src = () => readFileSync(SCRIPT, "utf-8");

/** Source the installer's helper layer (CROW_INSTALL_SOURCE_ONLY=1) and run a
 *  snippet against it. stdin is /dev/null → HAS_TTY=false (headless path). */
function runWithHelpers(snippet, env = {}) {
  return spawnSync("bash", ["-c", `set -euo pipefail; CROW_INSTALL_SOURCE_ONLY=1 source "${SCRIPT}"; ${snippet}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

test("bash -n: installer parses", () => {
  execFileSync("bash", ["-n", SCRIPT]);
});

test("shellcheck passes when available (skips otherwise)", (t) => {
  const which = spawnSync("shellcheck", ["--version"], { stdio: "ignore" });
  if (which.error) return t.skip("shellcheck not installed");
  // SC2154/SC1090/SC1091: sourced-file + installer-pattern noise; everything else must pass
  const r = spawnSync("shellcheck", ["-e", "SC1090,SC1091", SCRIPT], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stdout);
});

test("F-5: headless ask_yn resolves to its default (Y and N)", () => {
  const y = runWithHelpers(`if ask_yn "Continue?" Y; then echo YES; else echo NO; fi`);
  assert.equal(y.status, 0, y.stderr);
  assert.match(y.stdout, /YES/);
  const n = runWithHelpers(`if ask_yn "Rename?" N; then echo YES; else echo NO; fi`);
  assert.equal(n.status, 0, n.stderr);
  assert.match(n.stdout, /NO/);
});

test("F-5: CROW_INSTALL_YES=1 forces defaults without a tty", () => {
  const r = runWithHelpers(`if ask_yn "Continue?" Y; then echo YES; fi; if ask_yn "Rename?" N; then echo BAD; else echo SKIPPED; fi`, { CROW_INSTALL_YES: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /YES/);
  assert.match(r.stdout, /SKIPPED/);
});

test("F-5: ask_line returns empty headlessly instead of failing under set -e", () => {
  const r = runWithHelpers(`v="$(ask_line "name: ")"; echo "got:[\${v}]"`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /got:\[\]/);
});

test("F-5: no raw read -p prompts remain (all prompts go through ask_yn/ask_line)", () => {
  assert.doesNotMatch(src(), /read -p/);
});
