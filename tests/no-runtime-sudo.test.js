// Queue item 19, step 1: a hardened instance unit sets NoNewPrivileges=yes,
// which makes sudo (and every setuid binary) fail for the gateway and all its
// children. Guard: no runtime code path in the gateway, shared servers or the
// bot engine spawns sudo. Installers and operator scripts are out of scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const ROOTS = ["servers", "scripts/pi-bots"];
const SUDO = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["'`]sudo\b|["'`]sudo\s+-[A-Za-z]/;
const COMMENT = /^\s*(\*|\/\/|\/\*)/;
const SKIP = /(^|\/)(node_modules|install[^/]*\.(sh|mjs|js))$/;

function* files(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (SKIP.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p);
    else if (/\.(m?js|cjs)$/.test(e)) yield p;
  }
}

test("no gateway / bot-engine runtime code spawns sudo", () => {
  const hits = [];
  for (const root of ROOTS) {
    for (const f of files(join(REPO, root))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        // A comment that names `sudo -S` (e.g. a doc block) spawns nothing.
        if (COMMENT.test(line)) return;
        if (SUDO.test(line)) hits.push(`${f.slice(REPO.length + 1)}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(hits, [], "runtime sudo breaks under NoNewPrivileges=yes");
});

test("the sudo guard still catches a spawn, and skips only comment lines", () => {
  const flagged = (line) => !COMMENT.test(line) && SUDO.test(line);
  assert.equal(flagged('  spawn("sudo", ["-n", "true"]);'), true);
  assert.equal(flagged('  const cmd = "sudo -S tee";'), true);
  assert.equal(flagged(' *   - text piped into `sudo -S` has no pattern'), false);
  assert.equal(flagged('  // never "sudo -n" here'), false);
});
