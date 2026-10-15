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
  classifyFunnelTarget,
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

// Tailscale strips the mount and joins the target's path (ipn/ipnlocal/serve.go
// serveWebHandler: http.StripPrefix(mountPoint) + reverseProxy SetURL), so a
// /blog mount proxied to a bare :3001 hands the gateway "/" — the whole app.
test("exposure: funnel /blog → :3001 with no target path → warn (backend receives /)", async () => {
  await withEnvs({ PORT: "3001", CROW_GATEWAY_PORT: undefined, GATEWAY_FUNNEL_PUBLIC_PREFIXES: undefined }, async () => {
    invalidateHealthCache();
    _setTailscaleReader(() => JSON.stringify({
      AllowFunnel: { "crow.ts.net:443": true },
      Web: { "crow.ts.net:443": { Handlers: { "/blog": { Proxy: "http://localhost:3001" } } } },
    }));
    const r = await collectHealthSignals(makeDb());
    assert.equal(find(r, "exposure")?.severity, "warn", "the backend path is /, not /blog");
  });
});

test("exposure: funnel /blog → :3001/blog (public-safe backend path) → ok", async () => {
  await withEnvs({ PORT: "3001", CROW_GATEWAY_PORT: undefined, GATEWAY_FUNNEL_PUBLIC_PREFIXES: undefined }, async () => {
    invalidateHealthCache();
    _setTailscaleReader(() => JSON.stringify({
      AllowFunnel: { "crow.ts.net:443": true },
      Web: { "crow.ts.net:443": { Handlers: { "/blog": { Proxy: "http://127.0.0.1:3001/blog" } } } },
    }));
    const r = await collectHealthSignals(makeDb());
    assert.equal(detail(r, "exposure").state, "ok", "funneled /blog is allowed");
    assert.equal(find(r, "exposure"), undefined);
  });
});

// ─── exposure: own paths vs another service's (plan 2026-10-15 rev 2) ──────────

function withEnvs(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  });
}

// The live shape: one tailscaled funnels a Crow on :3001 (blog) and a second
// Crow on :3008 (public share pages) on the same :443.
const LIVE_SHAPE = {
  TCP: { "443": { HTTPS: true } },
  AllowFunnel: { "crow.example.ts.net:443": true },
  Web: { "crow.example.ts.net:443": { Handlers: {
    "/blog": { Proxy: "http://127.0.0.1:3001/blog" },
    "/robots.txt": { Proxy: "http://127.0.0.1:3001/robots.txt" },
    "/sitemap.xml": { Proxy: "http://127.0.0.1:3001/sitemap.xml" },
    "/s": { Proxy: "http://127.0.0.1:3008/s" },
    "/s-assets": { Proxy: "http://127.0.0.1:3008/s-assets" },
  } } },
};

async function exposureWith(cfg, env) {
  return withEnvs({ PORT: undefined, CROW_GATEWAY_PORT: undefined, GATEWAY_FUNNEL_PUBLIC_PREFIXES: undefined, ...env }, async () => {
    invalidateHealthCache();
    _setTailscaleReader(() => JSON.stringify(cfg));
    const r = await collectHealthSignals(makeDb());
    const exposure = r.issues.filter((i) => i.id.startsWith("exposure"));
    return { r, warns: exposure.filter((i) => i.severity === "warn"), infos: exposure.filter((i) => i.severity === "info") };
  });
}

test("exposure: live shape seen by the :3001 Crow → no warn, one info line naming the other service's paths", async () => {
  const { r, warns, infos } = await exposureWith(LIVE_SHAPE, {});
  assert.equal(warns.length, 0, JSON.stringify(warns));
  assert.equal(infos.length, 1, JSON.stringify(infos));
  assert.match(infos[0].label, /\/s\b/);
  assert.match(infos[0].label, /\/s-assets/);
  assert.match(infos[0].label, /3008/);
  assert.doesNotMatch(infos[0].label, /\/blog/, "own public paths are not 'another service'");
  assert.equal(detail(r, "exposure").state, "ok");
});

test("exposure: live shape seen by the :3008 Crow WITH its public prefixes → no warn", async () => {
  const { warns } = await exposureWith(LIVE_SHAPE, { PORT: "3008", CROW_GATEWAY_PORT: "3008", GATEWAY_FUNNEL_PUBLIC_PREFIXES: "/s/,/s,/s-assets/" });
  assert.equal(warns.length, 0, JSON.stringify(warns));
});

test("exposure: live shape seen by the :3008 Crow WITHOUT its public prefixes → warn", async () => {
  const { warns } = await exposureWith(LIVE_SHAPE, { PORT: "3008", CROW_GATEWAY_PORT: "3008" });
  assert.equal(warns.length, 1);
});

test("exposure: CROW_GATEWAY_PORT alone selects the gateway's own port", async () => {
  const { warns } = await exposureWith(LIVE_SHAPE, { CROW_GATEWAY_PORT: "3008" });
  assert.equal(warns.length, 1, "the :3008 Crow without its env still owns /s");
});

test("exposure: funnel / or /dashboard proxied to this gateway → warn (regression guard)", async () => {
  for (const [mount, proxy] of [["/", "http://127.0.0.1:3001"], ["/dashboard", "http://localhost:3001/dashboard"]]) {
    const { warns } = await exposureWith({
      AllowFunnel: { "crow.example.ts.net:443": true },
      Web: { "crow.example.ts.net:443": { Handlers: { [mount]: { Proxy: proxy } } } },
    }, {});
    assert.equal(warns.length, 1, mount);
  }
});

test("exposure: a Funnel proxy to another port is info, never warn", async () => {
  const { warns, infos } = await exposureWith({
    AllowFunnel: { "crow.example.ts.net:443": true },
    Web: { "crow.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } },
  }, {});
  assert.equal(warns.length, 0);
  assert.equal(infos.length, 1);
  assert.match(infos[0].label, /9000/);
});

test("exposure: a TCP forwarder on a Funnel-enabled port → warn (bypasses the header middleware)", async () => {
  const { warns } = await exposureWith({
    TCP: { "443": { TCPForward: "127.0.0.1:9000" } },
    AllowFunnel: { "crow.example.ts.net:443": true },
  }, {});
  assert.equal(warns.length, 1);
});

test("exposure: a TCP forwarder on a port WITHOUT Funnel → no warn", async () => {
  const { warns } = await exposureWith({
    TCP: { "8443": { TCPForward: "127.0.0.1:9000" } },
    AllowFunnel: { "crow.example.ts.net:443": true },
  }, {});
  assert.equal(warns.length, 0);
});

test("exposure: Path and Text handlers on Funnel → warn", async () => {
  for (const h of [{ Path: "/srv/www" }, { Text: "hello" }]) {
    const { warns } = await exposureWith({
      AllowFunnel: { "crow.example.ts.net:443": true },
      Web: { "crow.example.ts.net:443": { Handlers: { "/blog": h } } },
    }, {});
    assert.equal(warns.length, 1, JSON.stringify(h));
  }
});

test("exposure: an unparseable proxy target counts as this gateway's → warn", async () => {
  for (const proxy of ["http://[not-a-host", "unix:/run/some.sock"]) {
    const { warns } = await exposureWith({
      AllowFunnel: { "crow.example.ts.net:443": true },
      Web: { "crow.example.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } },
    }, {});
    assert.equal(warns.length, 1, proxy);
  }
});

test("classifyFunnelTarget: [::1], 0.0.0.0, https+insecure, bare port and host:port count as own", () => {
  for (const t of ["http://[::1]:3001", "http://0.0.0.0:3001", "https+insecure://localhost:3001", "3001", "localhost:3001", "https://127.0.0.1:3001"]) {
    assert.equal(classifyFunnelTarget(t, { port: 3001 }).own, true, t);
  }
});

test("classifyFunnelTarget: the tailnet/LAN address of this host counts as own; another port does not", () => {
  const ownHosts = new Set(["100.64.20.5", "10.0.0.5", "crowhost"]);
  assert.equal(classifyFunnelTarget("http://100.64.20.5:3001/blog", { port: 3001, ownHosts }).own, true);
  assert.equal(classifyFunnelTarget("http://crowhost:3001", { port: 3001, ownHosts }).own, true);
  assert.equal(classifyFunnelTarget("http://10.0.0.5:3008/s", { port: 3001, ownHosts }).own, false);
});

test("classifyFunnelTarget: the backend path is the target's path, or / when it has none", () => {
  assert.equal(classifyFunnelTarget("http://127.0.0.1:3001", { port: 3001 }).backendPath, "/");
  assert.equal(classifyFunnelTarget("http://127.0.0.1:3001/blog", { port: 3001 }).backendPath, "/blog");
  assert.equal(classifyFunnelTarget("3001", { port: 3001 }).backendPath, "/");
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
