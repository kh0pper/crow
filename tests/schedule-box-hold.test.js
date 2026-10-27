/** Schedule panel PR 3: the box hold source wraps readReservation (none / active / corrupt). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoxHold, RELEASE_COMMAND } from "../servers/gateway/schedule-sources/box-hold.js";

const dir = mkdtempSync(join(tmpdir(), "crow-hold-"));
const path = join(dir, "hold.json");
const NOW = Date.parse("2026-10-26T20:00:00Z");

test("none: no file, or an expired record", () => {
  assert.deepEqual(readBoxHold({ now: NOW, path }), { state: "none" });
  writeFileSync(path, JSON.stringify({ owner: "alex", reason: "x", started_at: "2026-10-26T10:00:00Z", expires_at: "2026-10-26T11:00:00Z" }));
  assert.deepEqual(readBoxHold({ now: NOW, path }), { state: "none" });
});

test("active: owner, reason, start and end", () => {
  writeFileSync(path, JSON.stringify({ owner: "window-run", reason: "benchmark window", started_at: "2026-10-26T19:30:00Z", expires_at: "2026-10-26T21:30:00Z" }));
  assert.deepEqual(readBoxHold({ now: NOW + 1, path }), {
    state: "active", owner: "window-run", reason: "benchmark window",
    started: Date.parse("2026-10-26T19:30:00Z"), ends: Date.parse("2026-10-26T21:30:00Z"),
  });
});

test("corrupt: an unparseable file, or one with no expiry", () => {
  writeFileSync(path, "{not json");
  assert.deepEqual(readBoxHold({ now: NOW + 2, path }), { state: "corrupt" });
  writeFileSync(path, JSON.stringify({ owner: "alex" }));
  assert.deepEqual(readBoxHold({ now: NOW + 3, path }), { state: "corrupt" });
  assert.equal(RELEASE_COMMAND, "node scripts/ops/box-reserve.mjs release");
  rmSync(dir, { recursive: true, force: true });
});
