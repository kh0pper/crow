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
  const re = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["'`]sudo\b|["'`]sudo\s+-[A-Za-z]/;
  for (const root of ROOTS) {
    for (const f of files(join(REPO, root))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (re.test(line)) hits.push(`${f.slice(REPO.length + 1)}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(hits, [], "runtime sudo breaks under NoNewPrivileges=yes");
});
