// The artifact sidecar node's health and serve-config audit (Crow Artifacts,
// step 1). The sidecar is a second tailscaled with its own hostname that
// proxies https://<instance>-artifacts.<tailnet>:443 to the loopback artifact
// origin. An expired or logged-out node quietly breaks every artifact frame,
// and a Funnel flag or an extra mapping would expose more than the origin, so
// the gateway audits it and raises a Nest health signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  sidecarHealth,
  renderServeConfig,
  createSidecarHealthReader,
} from "../servers/gateway/artifact-origin/sidecar-health.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const HOST = "crow-artifacts.example.ts.net";
const PORT = 3090;

const status = (o = {}) => ({ BackendState: "Running", ...o, Self: { DNSName: HOST + ".", Online: true, ...(o.Self || {}) } });
const serve = (proxy = `http://127.0.0.1:${PORT}`) => ({
  TCP: { 443: { HTTPS: true } },
  Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } },
});

test("healthy: running, no key expiry (expiry disabled), one 443 mapping to the origin port, no Funnel", () => {
  const r = sidecarHealth({ statusJson: status(), serveConfig: serve(), originPort: PORT, now: NOW });
  assert.deepEqual(r, { ok: true, problems: [], keyExpiry: null });
  // An expiry far away is healthy too.
  const far = sidecarHealth({ statusJson: status({ Self: { KeyExpiry: new Date(NOW + 90 * DAY).toISOString() } }), serveConfig: serve(), originPort: PORT, now: NOW });
  assert.equal(far.ok, true);
  // AllowFunnel present but false is not Funnel.
  const off = sidecarHealth({ statusJson: status(), serveConfig: { ...serve(), AllowFunnel: { [`${HOST}:443`]: false } }, originPort: PORT, now: NOW });
  assert.equal(off.ok, true);
});

test("logged out: any BackendState other than Running", () => {
  for (const s of ["NeedsLogin", "Stopped", "Starting", "NoState", undefined]) {
    const r = sidecarHealth({ statusJson: { ...status(), BackendState: s }, serveConfig: serve(), originPort: PORT, now: NOW });
    assert.equal(r.ok, false, String(s));
    assert.ok(r.problems.includes("logged-out"), String(s));
  }
});

test("key expiry within 14 days (or already past) is reported with the date", () => {
  const soon = new Date(NOW + 13 * DAY).toISOString();
  const r = sidecarHealth({ statusJson: status({ Self: { KeyExpiry: soon } }), serveConfig: serve(), originPort: PORT, now: NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ["key-expiring"]);
  assert.equal(r.keyExpiry, soon);
  const past = sidecarHealth({ statusJson: status({ Self: { KeyExpiry: new Date(NOW - DAY).toISOString() } }), serveConfig: serve(), originPort: PORT, now: NOW });
  assert.ok(past.problems.includes("key-expiring"));
  // The zero time / unparseable values mean "no expiry known", not a problem.
  for (const v of ["0001-01-01T00:00:00Z", "garbage", null]) {
    const z = sidecarHealth({ statusJson: status({ Self: { KeyExpiry: v } }), serveConfig: serve(), originPort: PORT, now: NOW });
    assert.equal(z.ok, true, String(v));
  }
});

test("Funnel on for the artifact node is a problem (public links are not built yet)", () => {
  const r = sidecarHealth({ statusJson: status(), serveConfig: { ...serve(), AllowFunnel: { [`${HOST}:443`]: true } }, originPort: PORT, now: NOW });
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes("funnel-on"));
  const other = sidecarHealth({ statusJson: status(), serveConfig: { ...serve(), AllowFunnel: { [`${HOST}:8443`]: true } }, originPort: PORT, now: NOW });
  assert.ok(other.problems.includes("funnel-on"), "Funnel on any hostport counts");
});

test("any mapping other than the one 443 -> http://127.0.0.1:<origin port> proxy is unexpected", () => {
  const cases = {
    "wrong port": serve(`http://127.0.0.1:${PORT + 1}`),
    "not loopback": serve(`http://192.0.2.5:${PORT}`),
    "localhost name": serve(`http://localhost:${PORT}`),
    "https backend": serve(`https://127.0.0.1:${PORT}`),
    "trailing path": serve(`http://127.0.0.1:${PORT}/x`),
    "second handler": { ...serve(), Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` }, "/x": { Proxy: "http://127.0.0.1:3001" } } } } },
    "path handler": { ...serve(), Web: { [`${HOST}:443`]: { Handlers: { "/": { Path: "/etc" } } } } },
    "text handler": { ...serve(), Web: { [`${HOST}:443`]: { Handlers: { "/": { Text: "hi" } } } } },
    "second web host": { ...serve(), Web: { ...serve().Web, [`${HOST}:8443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` } } } } },
    "web on another port": { TCP: { 8443: { HTTPS: true } }, Web: { [`${HOST}:8443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` } } } } },
    "extra tcp port": { ...serve(), TCP: { 443: { HTTPS: true }, 22: { TCPForward: "127.0.0.1:22" } } },
    "tcp forward on 443": { ...serve(), TCP: { 443: { TCPForward: "127.0.0.1:22" } } },
    "no mapping": { TCP: {}, Web: {} },
    "services block": { ...serve(), Services: { "svc:x": {} } },
    "not an object": "nope",
  };
  for (const [name, cfg] of Object.entries(cases)) {
    const r = sidecarHealth({ statusJson: status(), serveConfig: cfg, originPort: PORT, now: NOW });
    assert.equal(r.ok, false, name);
    assert.ok(r.problems.includes("unexpected-mapping"), `${name}: ${r.problems}`);
  }
});

test("unreadable status or serve config fails closed (unreachable), never ok", () => {
  for (const [s, c] of [[null, serve()], [status(), null], [undefined, undefined]]) {
    const r = sidecarHealth({ statusJson: s, serveConfig: c, originPort: PORT, now: NOW });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes("unreachable"));
  }
  const noPort = sidecarHealth({ statusJson: status(), serveConfig: serve(), originPort: null, now: NOW });
  assert.equal(noPort.ok, false, "without a known origin port no mapping can be judged correct");
  assert.ok(noPort.problems.includes("unexpected-mapping"));
});

test("the shipped serve.json.tmpl, rendered for the main instance, passes the audit (no AllowFunnel, one mapping)", () => {
  const tmpl = readFileSync(new URL("../bundles/artifacts/sidecar/serve.json.tmpl", import.meta.url), "utf8");
  assert.doesNotMatch(tmpl, /AllowFunnel/, "no Funnel key at all before public links (step 6)");
  const rendered = renderServeConfig(tmpl, { originPort: 3090 });
  const cfg = JSON.parse(rendered);
  // tailscaled substitutes ${TS_CERT_DOMAIN} itself; the audit sees the live
  // name. Substitute here the way the container would.
  const live = JSON.parse(rendered.replaceAll("${TS_CERT_DOMAIN}", HOST));
  assert.ok(cfg.Web["${TS_CERT_DOMAIN}:443"], "the template keeps tailscaled's own placeholder");
  const r = sidecarHealth({ statusJson: status(), serveConfig: live, originPort: 3090, now: NOW });
  assert.deepEqual(r, { ok: true, problems: [], keyExpiry: null });
  // And the same template rendered for another port fails the main port's audit.
  const wrong = JSON.parse(renderServeConfig(tmpl, { originPort: 3091 }).replaceAll("${TS_CERT_DOMAIN}", HOST));
  assert.equal(sidecarHealth({ statusJson: status(), serveConfig: wrong, originPort: 3090, now: NOW }).ok, false);
  assert.throws(() => renderServeConfig(tmpl, { originPort: "3090; x" }), /port/);
  assert.throws(() => renderServeConfig(tmpl, { originPort: 0 }), /port/);
});

test("Nest health signal: own-host mode without a sidecar socket warns 'unmonitored' (review L5)", async () => {
  const hs = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");
  hs._setTailscaleReader(() => "{}");
  hs._setDiskReader(() => "Avail Size\n500000M 1000000M\n");
  const savedUrl = process.env.CROW_ARTIFACT_ORIGIN_URL;
  const savedSocket = process.env.CROW_ARTIFACT_SIDECAR_SOCKET;
  try {
    hs._setArtifactNodeReader(async () => null);
    process.env.CROW_ARTIFACT_ORIGIN_URL = "https://art.example";
    delete process.env.CROW_ARTIFACT_SIDECAR_SOCKET;
    for (const lang of ["en", "es"]) {
      hs.invalidateHealthCache();
      const r = await hs.collectHealthSignals(null, { now: () => NOW, lang });
      const i = r.issues.find((x) => x.id === "artifact-node:unmonitored");
      assert.ok(i, `${lang}: unmonitored warn issue exists`);
      assert.equal(i.severity, "warn", "warn → pushed by the health monitor");
      assert.ok(i.label && !/signals\.artifactNode/.test(i.label), `${lang}: translated label`);
      assert.equal(r.details.find((d) => d.id === "artifact-node"), undefined, "issue only, no card");
      assert.equal(r.ok, false);
    }
    // With the socket configured the unmonitored warn goes away (the real
    // reader would then audit the node itself).
    process.env.CROW_ARTIFACT_SIDECAR_SOCKET = "/run/crow-artifacts/tailscaled.sock";
    hs.invalidateHealthCache();
    const r2 = await hs.collectHealthSignals(null, { now: () => NOW });
    assert.equal(r2.issues.find((x) => x.id === "artifact-node:unmonitored"), undefined);
  } finally {
    if (savedUrl === undefined) delete process.env.CROW_ARTIFACT_ORIGIN_URL; else process.env.CROW_ARTIFACT_ORIGIN_URL = savedUrl;
    if (savedSocket === undefined) delete process.env.CROW_ARTIFACT_SIDECAR_SOCKET; else process.env.CROW_ARTIFACT_SIDECAR_SOCKET = savedSocket;
    hs._setArtifactNodeReader(null);
    hs._setDiskReader(null);
    hs.invalidateHealthCache();
  }
});

test("reader: off without a sidecar socket; runs the CLI with --socket and no sudo; caches for 5 minutes; a failing CLI is unreachable", async () => {
  let t = NOW;
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes("serve")) return JSON.stringify(serve());
    if (args.includes("status")) return JSON.stringify(status());
    throw new Error("unexpected");
  };
  assert.equal(await createSidecarHealthReader({ env: {}, exec, now: () => t })(), null, "not configured: no signal");
  assert.equal(await createSidecarHealthReader({ env: { CROW_ARTIFACT_SIDECAR_SOCKET: "/run/x.sock" }, exec, now: () => t })(), null, "no origin port: no signal");

  const env = { CROW_ARTIFACT_SIDECAR_SOCKET: "/run/crow-artifacts/tailscaled.sock", CROW_ARTIFACT_ORIGIN_PORT: "3090" };
  const read = createSidecarHealthReader({ env, exec, now: () => t });
  const a = await read();
  assert.equal(a.ok, true);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c[0], "tailscale");
    assert.deepEqual(c.slice(1, 3), ["--socket", "/run/crow-artifacts/tailscaled.sock"]);
    assert.ok(!c.includes("sudo"));
  }
  assert.ok(calls.some((c) => c.slice(3).join(" ") === "status --json"));
  assert.ok(calls.some((c) => c.slice(3).join(" ") === "serve status -json"));
  t += 4 * 60 * 1000;
  await read();
  assert.equal(calls.length, 2, "cached within 5 minutes");
  t += 2 * 60 * 1000;
  await read();
  assert.equal(calls.length, 4, "re-read after 5 minutes");

  const failing = createSidecarHealthReader({ env, exec: async () => { throw new Error("ENOENT"); }, now: () => t });
  const f = await failing();
  assert.equal(f.ok, false);
  assert.deepEqual(f.problems, ["unreachable"]);
  const junk = createSidecarHealthReader({ env, exec: async () => "not json", now: () => t });
  assert.deepEqual((await junk()).problems, ["unreachable"]);
});

test("Nest health signal: no card when not configured; ok card when healthy; one warn issue per distinct problem", async () => {
  const hs = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");
  // No host I/O from the other signals: stub the tailscale and disk readers.
  hs._setTailscaleReader(() => "{}");
  hs._setDiskReader(() => "Avail Size\n500000M 1000000M\n");
  try {
    hs._setArtifactNodeReader(async () => null);
    hs.invalidateHealthCache();
    let r = await hs.collectHealthSignals(null, { now: () => NOW });
    assert.equal(r.details.find((d) => d.id === "artifact-node"), undefined);

    hs._setArtifactNodeReader(async () => ({ ok: true, problems: [], keyExpiry: null }));
    hs.invalidateHealthCache();
    r = await hs.collectHealthSignals(null, { now: () => NOW });
    assert.equal(r.details.find((d) => d.id === "artifact-node")?.state, "ok");
    assert.equal(r.issues.filter((i) => i.id.startsWith("artifact-node")).length, 0);

    const exp = new Date(NOW + 3 * DAY).toISOString();
    hs._setArtifactNodeReader(async () => ({ ok: false, problems: ["logged-out", "key-expiring", "funnel-on", "unexpected-mapping"], keyExpiry: exp }));
    for (const lang of ["en", "es"]) {
      hs.invalidateHealthCache();
      r = await hs.collectHealthSignals(null, { now: () => NOW, lang });
      assert.equal(r.details.find((d) => d.id === "artifact-node")?.state, "warn");
      const issues = r.issues.filter((i) => i.id.startsWith("artifact-node:"));
      assert.deepEqual(issues.map((i) => i.id).sort(), ["artifact-node:funnel-on", "artifact-node:key-expiring", "artifact-node:logged-out", "artifact-node:unexpected-mapping"]);
      for (const i of issues) {
        assert.equal(i.severity, "warn", "warn issues are pushed as notifications by the health monitor");
        assert.ok(i.label && !/signals\.artifactNode/.test(i.label), `${lang}: translated label for ${i.id}`);
      }
      const k = issues.find((i) => i.id === "artifact-node:key-expiring");
      assert.match(k.label, /2026-10-11/, "the expiry date is shown");
      assert.equal(r.ok, false);
    }

    // An unknown problem must fail CLOSED as unreachable (review R4/M13):
    // never an empty issue list that would read as ok.
    hs._setArtifactNodeReader(async () => ({ ok: false, problems: ["weird"], keyExpiry: null }));
    hs.invalidateHealthCache();
    r = await hs.collectHealthSignals(null, { now: () => NOW });
    const weird = r.issues.filter((i) => i.id.startsWith("artifact-node:"));
    assert.deepEqual(weird.map((i) => i.id), ["artifact-node:unreachable"]);
    assert.equal(weird[0].severity, "warn");
    assert.equal(r.ok, false);
  } finally {
    hs._setArtifactNodeReader(null);
    // (the tailscale reader seam has no restore; this file runs in its own process)
    hs._setDiskReader(null);
    hs.invalidateHealthCache();
  }
});
