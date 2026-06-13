/**
 * W2 security-maintenance signals: logins, exposure, integrations + the
 * dedupe helpers (shouldNotify windowMs, pruneResolved). Stub-db pattern from
 * health-signals.test.js; always invalidate the cache first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHealthSignals,
  invalidateHealthCache,
  shouldNotify,
  pruneResolved,
  _setTailscaleReader,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";

// A stub db whose execute() answers each signal's query from `data`.
function makeDb(data = {}) {
  return {
    async execute({ sql }) {
      if (sql.includes("pi_bot_defs")) return { rows: [{ c: 0 }] };
      if (sql.includes("auto_update")) return { rows: [{ value: "1.0.0" }] };
      // logins
      if (sql.includes("auth_login_failure")) return { rows: [{ n: data.loginFailures ?? 0, ips: data.loginIps ?? 0 }] };
      if (sql.includes("security_lockout_report")) return { rows: [{ n: data.lockouts ?? 0 }] };
      // integrations
      if (sql.includes("data_backends")) return { rows: data.backendErrors ?? [] };
      if (sql.includes("cross_host_calls")) return { rows: data.peerAuthFails ?? [] };
      // crow_instances (peers signal — keep empty unless overridden)
      if (sql.includes("crow_instances")) return { rows: [] };
      if (sql.includes("backup_last_verified")) return { rows: [] };
      return { rows: [] };
    },
  };
}

function find(result, id) { return result.issues.find(i => i.id === id); }
function detail(result, id) { return result.details.find(d => d.id === id); }

// Keep the tailscale reader inert (CLI-absent → null → skip) for all tests
// except the exposure-funnel ones that set it explicitly.
function inertTailscale() { _setTailscaleReader(() => { throw new Error("no tailscale"); }); }

// ─── logins ───────────────────────────────────────────────────────────────────

test("logins: 0 failures → ok, no issue", async () => {
  invalidateHealthCache(); inertTailscale();
  const r = await collectHealthSignals(makeDb({ loginFailures: 0 }));
  assert.equal(detail(r, "logins").state, "ok");
  assert.equal(find(r, "logins"), undefined);
});

test("logins: 6 failures → info (strip only), ok stays true", async () => {
  invalidateHealthCache(); inertTailscale();
  const r = await collectHealthSignals(makeDb({ loginFailures: 6, loginIps: 2 }));
  const issue = find(r, "logins");
  assert.ok(issue);
  assert.equal(issue.severity, "info");
  // logins info alone must not flip ok (no warn from it)
  const loginsWarn = r.issues.find(i => i.id === "logins" && i.severity === "warn");
  assert.equal(loginsWarn, undefined);
});

test("logins: 14 failures → warn with count in the message", async () => {
  invalidateHealthCache(); inertTailscale();
  const r = await collectHealthSignals(makeDb({ loginFailures: 14, loginIps: 3 }));
  const issue = find(r, "logins");
  assert.equal(issue.severity, "warn");
  assert.match(issue.label, /14/);
});

test("logins: any lockout → warn even below the failure threshold", async () => {
  invalidateHealthCache(); inertTailscale();
  const r = await collectHealthSignals(makeDb({ loginFailures: 3, lockouts: 1 }));
  assert.equal(find(r, "logins").severity, "warn");
});

// ─── exposure ───────────────────────────────────────────────────────────────────

function withEnv(key, val, fn) {
  const prev = process.env[key];
  if (val == null) delete process.env[key]; else process.env[key] = val;
  return Promise.resolve(fn()).finally(() => {
    if (prev == null) delete process.env[key]; else process.env[key] = prev;
  });
}

test("exposure: clean env + tailscale CLI absent → ok (no day-1 false warn)", async () => {
  invalidateHealthCache();
  _setTailscaleReader(() => { throw new Error("ENOENT"); });
  const r = await collectHealthSignals(makeDb());
  assert.equal(detail(r, "exposure").state, "ok");
  assert.equal(find(r, "exposure"), undefined);
});

test("exposure: serve-only mounts at / with NO AllowFunnel → ok (C1 regression)", async () => {
  invalidateHealthCache();
  // The exact healthy-private shape captured from crow: Web handlers at "/",
  // no AllowFunnel key. Must NOT warn.
  _setTailscaleReader(() => JSON.stringify({
    Web: { "crow.ts.net:8444": { Handlers: { "/": { Proxy: "http://localhost:3001" } } } },
  }));
  const r = await collectHealthSignals(makeDb());
  assert.equal(detail(r, "exposure").state, "ok", "serve-only / must be private");
});

test("exposure: CROW_DASHBOARD_PUBLIC=true → warn", async () => {
  await withEnv("CROW_DASHBOARD_PUBLIC", "true", async () => {
    invalidateHealthCache(); inertTailscale();
    const r = await collectHealthSignals(makeDb());
    assert.equal(find(r, "exposure").severity, "warn");
  });
});

test("exposure: CROW_CSRF_STRICT=0 → warn, message has no 'CSRF' acronym", async () => {
  await withEnv("CROW_CSRF_STRICT", "0", async () => {
    invalidateHealthCache(); inertTailscale();
    const r = await collectHealthSignals(makeDb());
    const issue = find(r, "exposure");
    assert.equal(issue.severity, "warn");
    assert.doesNotMatch(issue.label, /CSRF/, "user string must not leak the acronym");
  });
});

test("exposure: funnel mapping '/' (AllowFunnel on) → warn", async () => {
  invalidateHealthCache();
  _setTailscaleReader(() => JSON.stringify({
    AllowFunnel: { "crow.ts.net:443": true },
    Web: { "crow.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:3001" } } } },
  }));
  const r = await collectHealthSignals(makeDb());
  assert.equal(find(r, "exposure").severity, "warn", "funneled / is real exposure");
});

test("exposure: funnel mapping only /blog (public-safe) → ok", async () => {
  invalidateHealthCache();
  _setTailscaleReader(() => JSON.stringify({
    AllowFunnel: { "crow.ts.net:443": true },
    Web: { "crow.ts.net:443": { Handlers: { "/blog": { Proxy: "http://localhost:3001" } } } },
  }));
  const r = await collectHealthSignals(makeDb());
  assert.equal(detail(r, "exposure").state, "ok", "funneled /blog is allowed");
});

// ─── integrations ───────────────────────────────────────────────────────────────

test("integrations: empty → ok", async () => {
  invalidateHealthCache(); inertTailscale();
  const r = await collectHealthSignals(makeDb());
  assert.equal(detail(r, "integrations").state, "ok");
});

test("integrations: a data_backend error row → warn", async () => {
  invalidateHealthCache(); inertTailscale();
  const r = await collectHealthSignals(makeDb({ backendErrors: [{ name: "Postgres" }] }));
  const issue = find(r, "integrations");
  assert.equal(issue.severity, "warn");
  assert.match(issue.label, /Postgres/);
});

test("integrations: peer 401 → warn", async () => {
  invalidateHealthCache(); inertTailscale();
  const r = await collectHealthSignals(makeDb({ peerAuthFails: [{ name: "grackle" }] }));
  assert.equal(find(r, "integrations").severity, "warn");
});

// ─── helpers ────────────────────────────────────────────────────────────────────

test("shouldNotify: custom window controls re-notify", () => {
  const map = { x: 1000 };
  assert.equal(shouldNotify(map, "x", 1000 + 5, 10), false, "within window → no");
  assert.equal(shouldNotify(map, "x", 1000 + 20, 10), true, "past window → yes");
  assert.equal(shouldNotify(map, "y", 1000, 10), true, "unseen id → yes");
});

test("pruneResolved: keeps active ids, drops resolved", () => {
  const map = { a: 1, b: 2, c: 3 };
  const out = pruneResolved(map, ["a", "c"]);
  assert.deepEqual(out, { a: 1, c: 3 });
});
