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
// Any call whose first argument is the string "sudo" (aliases like `efs(` too),
// or a command string that starts with `sudo -x`.
const SUDO = /\b[\w$.]+\(\s*["'`]sudo["'`\s]|["'`]sudo\s+-[A-Za-z]/;
// Known runtime sites, each best-effort inside try/catch: under
// NoNewPrivileges=yes they fail into the logged "open manually" note on the
// install job. A new site is a real finding: do not add it here without a reason.
const KNOWN = [
  // direct-mode bundle install/uninstall: ufw rule for the tailnet range, Tailscale Serve
  { file: "servers/gateway/routes/bundles.js", re: /efs\("sudo", \["-n", "(ufw|tailscale)"/, count: 4 },
];
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
  const seen = new Map();
  for (const root of ROOTS) {
    for (const f of files(join(REPO, root))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        // A comment that names `sudo -S` (e.g. a doc block) spawns nothing.
        if (COMMENT.test(line)) return;
        if (!SUDO.test(line)) return;
        const rel = f.slice(REPO.length + 1);
        const known = KNOWN.find((k) => k.file === rel && k.re.test(line));
        if (known) seen.set(known, (seen.get(known) || 0) + 1);
        else hits.push(`${rel}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(hits, [], "runtime sudo breaks under NoNewPrivileges=yes");
  for (const k of KNOWN) assert.equal(seen.get(k) || 0, k.count, `known sudo sites in ${k.file} changed: update KNOWN with a reason`);
});

test("the sudo guard still catches a spawn, and skips only comment lines", () => {
  const flagged = (line) => !COMMENT.test(line) && SUDO.test(line);
  assert.equal(flagged('  spawn("sudo", ["-n", "true"]);'), true);
  assert.equal(flagged('  const cmd = "sudo -S tee";'), true);
  assert.equal(flagged('  efs("sudo", ["-n", "ufw"]);'), true, "an aliased execFileSync is caught");
  assert.equal(flagged('  const groups = ["docker", "sudo", "wheel"];'), false, "a group name is not a spawn");
  assert.equal(flagged(' *   - text piped into `sudo -S` has no pattern'), false);
  assert.equal(flagged('  // never "sudo -n" here'), false);
});
