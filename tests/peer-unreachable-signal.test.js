/**
 * Tailscale-logout alert (audit A14). grackle sat logged out of Tailscale
 * for 5 days with no alert: its last_seen_at stayed fresh (Hyperswarm runs
 * over the public DHT) and the peers signal only looked at status='active'
 * rows, at info severity, which never pushes. The signal now warns (and so
 * pushes, via runHealthNotifyCycle) when a paired peer's gateway URL has
 * failed /health for >= PEER_UNREACHABLE_WARN_MS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHealthSignals,
  invalidateHealthCache,
  runHealthNotifyCycle,
  PEER_UNREACHABLE_WARN_MS,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import { recordPeerProbe, getPeerProbeHealth, _resetPeerProbeHealth } from "../servers/gateway/peer-probe-health.js";

const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);
const sqliteNow = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function db(rows) {
  return {
    async execute({ sql }) {
      if (sql && sql.includes("FROM crow_instances WHERE trusted=1")) return { rows };
      return { rows: [] };
    },
  };
}

async function peers(rows, nowMs) {
  invalidateHealthCache();
  const r = await collectHealthSignals(db(rows), { now: () => nowMs });
  return { detail: r.details.find((d) => d.id === "peers"), issue: r.issues.find((i) => i.id === "peers") };
}

const grackle = (nowMs, status = "offline") => ({
  id: "g1", name: "Primary", status, gateway_url: "https://grackle.example.ts.net:8444",
  last_seen_at: sqliteNow(nowMs), // fresh — Hyperswarm kept it alive
});

test("probe record: failingSince is sticky across failures and cleared by a success", () => {
  _resetPeerProbeHealth();
  recordPeerProbe("g1", false, { nowMs: T0, error: "timeout" });
  recordPeerProbe("g1", false, { nowMs: T0 + 60_000 });
  assert.equal(getPeerProbeHealth().g1.failingSince, T0);
  recordPeerProbe("g1", true, { nowMs: T0 + 120_000 });
  assert.equal(getPeerProbeHealth().g1.failingSince, null);
  assert.equal(getPeerProbeHealth().g1.lastOkAt, T0 + 120_000);
});

test("a peer failing /health past the threshold warns even with a fresh last_seen_at and status 'offline'", async () => {
  _resetPeerProbeHealth();
  recordPeerProbe("g1", false, { nowMs: T0 });
  const now = T0 + PEER_UNREACHABLE_WARN_MS + 60_000;
  const { detail, issue } = await peers([grackle(now)], now);
  assert.equal(detail.state, "warn");
  assert.equal(issue.severity, "warn");
  // issue.label is what the pushed notification's title carries.
  assert.match(issue.label, /Primary/);
  assert.match(issue.label, /Tailscale/);

  // ...and the health monitor pushes it.
  const cycle = await runHealthNotifyCycle({ issues: [issue], lastMap: {}, nowMs: now, notify: async () => {} });
  assert.deepEqual(cycle.pushed, ["peers"]);
});

test("a short blip (under the threshold) does not warn", async () => {
  _resetPeerProbeHealth();
  recordPeerProbe("g1", false, { nowMs: T0 });
  const now = T0 + 10 * 60_000;
  const { detail } = await peers([grackle(now, "active")], now);
  assert.equal(detail.state, "ok");
});

test("a peer with no probe record and a fresh last_seen_at is ok", async () => {
  _resetPeerProbeHealth();
  const { detail } = await peers([grackle(T0, "active")], T0);
  assert.equal(detail.state, "ok");
});

test("an 'offline' peer unseen for >24h is now surfaced (info), not hidden by the old status filter", async () => {
  _resetPeerProbeHealth();
  const row = { ...grackle(T0), gateway_url: null, last_seen_at: sqliteNow(T0 - 3 * 86_400_000) };
  const { detail, issue } = await peers([row], T0);
  assert.equal(detail.state, "info");
  assert.equal(issue.severity, "info");
});

test("es strings render", async () => {
  _resetPeerProbeHealth();
  recordPeerProbe("g1", false, { nowMs: T0 });
  const now = T0 + PEER_UNREACHABLE_WARN_MS;
  invalidateHealthCache();
  const r = await collectHealthSignals(db([grackle(now)]), { now: () => now, lang: "es" });
  const i = r.issues.find((x) => x.id === "peers");
  assert.match(i.label, /inaccesible/);
  assert.match(i.label, /Primary/);
});
