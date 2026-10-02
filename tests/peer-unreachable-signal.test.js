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
  return {
    detail: r.details.find((d) => d.id === "peers"),
    issue: r.issues.find((i) => i.id === "peers" || i.id.startsWith("peers:")),
    issues: r.issues.filter((i) => i.id === "peers" || i.id.startsWith("peers:")),
  };
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
  assert.equal(issue.id, "peers:g1", "per-peer issue id");
  const cycle = await runHealthNotifyCycle({ issues: [issue], lastMap: {}, nowMs: now, notify: async () => {} });
  assert.deepEqual(cycle.pushed, ["peers:g1"]);
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
  const i = r.issues.find((x) => x.id === "peers:g1");
  assert.match(i.label, /inaccesible/);
  assert.match(i.label, /Primary/);
});

test("each unreachable peer has its own issue id, so a second outage inside the first's 24 h window still pushes", async () => {
  _resetPeerProbeHealth();
  recordPeerProbe("g1", false, { nowMs: T0 });
  const t1 = T0 + PEER_UNREACHABLE_WARN_MS;
  const first = await peers([grackle(t1)], t1);
  let cycle = await runHealthNotifyCycle({ issues: first.issues, lastMap: {}, nowMs: t1, notify: async () => {} });
  assert.deepEqual(cycle.pushed, ["peers:g1"]);

  recordPeerProbe("r2", false, { nowMs: t1 });
  const t2 = t1 + PEER_UNREACHABLE_WARN_MS; // well inside 24 h of the first push
  const raven = { ...grackle(t2), id: "r2", name: "raven" };
  const second = await peers([grackle(t2), raven], t2);
  assert.equal(second.detail.state, "warn");
  assert.equal(second.issues.length, 2);
  cycle = await runHealthNotifyCycle({ issues: second.issues, lastMap: cycle.lastMap, nowMs: t2, notify: async () => {} });
  assert.deepEqual(cycle.pushed, ["peers:r2"], "the new peer pushes; the already-notified one is deduped");
});
