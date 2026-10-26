/**
 * Every schedules row a bundle writes must be a task named in SCHEDULE_OWNERS. Otherwise the
 * gateway would classify it as a reminder (any plain text is one) and start notifying its key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULE_OWNERS, scheduleKind } from "../servers/shared/schedule-core.js";

const ROOT = new URL("../bundles/", import.meta.url).pathname;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(m?js)$/.test(name) && !/\.test\./.test(name)) yield p;
  }
}

test("every bundle that inserts a schedules row writes an owner task", () => {
  const writers = [];
  for (const f of files(ROOT)) {
    const src = readFileSync(f, "utf8");
    if (!/INSERT INTO schedules\b/.test(src)) continue;
    writers.push(f);
    const owned = Object.keys(SCHEDULE_OWNERS).filter((task) => src.includes(JSON.stringify(task)));
    assert.ok(owned.length > 0, `${f} inserts into schedules but names no SCHEDULE_OWNERS task — add one (servers/shared/schedule-core.js)`);
  }
  assert.ok(writers.length >= 1, "positive control: the News briefing writer is found");
  for (const task of Object.keys(SCHEDULE_OWNERS)) assert.notEqual(scheduleKind(task), "reminder");
});
