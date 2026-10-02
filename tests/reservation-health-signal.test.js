/**
 * Persistent "box reserved" health card (acceptance-gap leftover, box
 * reservation scope §3.5): shown while a reservation is held, absent when
 * the box is free, info severity (never pushed — the orchestrator's own
 * refusal notifications already cover the phone).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHealthSignals,
  invalidateHealthCache,
  runHealthNotifyCycle,
  _setReservationReader,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import { readReservation } from "../servers/gateway/box-reservation.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const db = { async execute() { return { rows: [] }; } };
const NOW = Date.UTC(2026, 9, 3, 15, 0, 0);

async function run(reader, lang = "en") {
  _setReservationReader(reader);
  invalidateHealthCache();
  try {
    const r = await collectHealthSignals(db, { now: () => NOW, lang });
    return { detail: r.details.find((d) => d.id === "reservation"), issue: r.issues.find((i) => i.id === "reservation") };
  } finally {
    _setReservationReader(null);
  }
}

test("no reservation → no card", async () => {
  const { detail, issue } = await run(() => null);
  assert.equal(detail, undefined);
  assert.equal(issue, undefined);
});

test("a held reservation shows owner, expiry and reason at info severity, and is never pushed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "resv-"));
  try {
    const path = join(dir, "r.json");
    writeFileSync(path, JSON.stringify({
      owner: "dsv4-window-20261003", reason: "benchmark",
      started_at: new Date(NOW - 60_000).toISOString(),
      expires_at: new Date(NOW + 3_600_000).toISOString(),
    }));
    const { detail, issue } = await run((nowMs) => readReservation({ now: nowMs, path }));
    assert.equal(detail.state, "info");
    assert.equal(issue.severity, "info");
    assert.match(issue.label, /dsv4-window-20261003/);
    assert.match(issue.label, /benchmark/);
    const cycle = await runHealthNotifyCycle({ issues: [issue], lastMap: {}, nowMs: NOW, notify: async () => {} });
    assert.deepEqual(cycle.pushed, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unreadable reservation file is shown as reserved (fail closed), in es too", async () => {
  const { issue } = await run(() => ({ corrupt: true, owner: "unknown", allow: [] }), "es");
  assert.equal(issue.severity, "info");
  assert.match(issue.label, /reservado/);
});
