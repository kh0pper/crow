// The boot-time sweep of per-spawn contain dirs (sweepStaleContainDirs,
// scripts/pi-bots/pi_contain.mjs) also covers the walled add-ons' relay dirs,
// `crow-addon-net-<pid>-...`, under the same rules as the bot dirs: the
// spawner's pid is in the name, and only this uid's dirs whose spawner is gone
// are removed. A name that only looks similar is left alone.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sweepStaleContainDirs } from "../scripts/pi-bots/pi_contain.mjs";

const scratch = mkdtempSync(join(tmpdir(), "addon-sweep-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The pid of a process that has already exited. */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(r.status, 0, "a helper process that exits at once");
  return r.pid;
}

test("the sweep removes dead spawners' add-on relay dirs and leaves every other name alone", () => {
  const dead = deadPid();
  const parent = join(scratch, "parent");
  const names = [
    "crow-addon-net-" + dead + "-kiosk-abc",
    "crow-addon-net-" + process.pid + "-kiosk-abc",
    "crow-addon-netx-" + dead + "-a",
    "crow-addon-net-notapid-a",
    "crow-pi-net-" + dead + "-x",
    "crow-pi-agent-" + dead + "-y",
  ];
  for (const name of names) mkdirSync(join(parent, name), { recursive: true });
  try {
    assert.equal(sweepStaleContainDirs({ parent }), 3);
    assert.deepEqual(readdirSync(parent).sort(), [
      "crow-addon-net-" + process.pid + "-kiosk-abc",
      "crow-addon-net-notapid-a",
      "crow-addon-netx-" + dead + "-a",
    ].sort());
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});