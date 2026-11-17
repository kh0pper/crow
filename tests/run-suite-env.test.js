/**
 * The suite runner scratches every piece of box/GPU state so a run on any box
 * can never read or write a real instance's hold, calendar, host profile or
 * job store. scripts/run-suite.mjs builds its env inline, so this reads the
 * source and pins each assignment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../scripts/run-suite.mjs", import.meta.url), "utf8");

test("run-suite env points every box/gpu state path into the scratch dir", () => {
  const expected = [
    ["CROW_BOX_RESERVATION_PATH", "box-reservation.json"],
    ["CROW_BOX_SCHEDULE_PATH", "box-schedule.json"],
    ["CROW_GPU_HOST_PROFILE_PATH", "gpu-host-profile.json"],
    ["CROW_GPU_JOBS_DB_PATH", "gpu-jobs.db"],
  ];
  for (const [key, file] of expected) {
    const re = new RegExp(`env\\.${key} = join\\(scratch, "${file.replace(/\./g, "\\.")}"\\);`);
    assert.match(src, re, `${key} must be assigned from join(scratch, "${file}")`);
  }
});