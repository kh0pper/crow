// The artifact sidecar node's health and serve-config audit (Crow Artifacts,
// step 1). The sidecar is a second tailscaled with its own hostname that
// proxies https://<instance>-artifacts.<tailnet>:443 to the artifact origin.
// An expired or logged-out node quietly breaks every artifact frame, and a
// Funnel flag or an extra mapping would expose more than the origin, so the
// gateway audits it and raises a Nest health signal.
//
// The audit also refuses a sidecar that shares the HOST's network namespace:
// tailscaled's userspace netstack forwards an inbound TCP connection on ANY
// port of the node's tailnet address to 127.0.0.1 in the namespace it runs in,
// so a loopback Serve Proxy target means every loopback port of this computer
// answers the tailnet. That is `host-loopback`, never just `unexpected-mapping`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  sidecarHealth,
  renderServeConfig,
  createSidecarHealthReader,
  expectedSidecarTarget,
  parseOriginTarget,
  isLoopbackHost,
} from "../servers/gateway/artifact-origin/sidecar-health.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const HOST = "crow-artifacts.example.ts.net";
const PORT = 3090;
// The origin as the SIDECAR sees it: a dedicated bridge's gateway IP, i.e. its
// own network namespace's way to the host-run origin (never loopback).
const BRIDGE = "172.30.0.1";
const TARGET = `http://${BRIDGE}:${PORT}`;

const status = (o = {}) => ({ BackendState: "Running", ...o, Self: { DNSName: HOST + ".", Online: true, ...(o.Self || {}) } });
const serve = (proxy = TARGET) => ({
  TCP: { 443: { HTTPS: true } },
  Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } },
});

test("healthy: running, no key expiry (expiry disabled), one 443 mapping to the bridge target, no Funnel", () => {
  const r = sidecarHealth({ statusJson: status(), serveConfig: serve(), target: TARGET, now: NOW });
  assert.deepEqual(r, { ok: true, problems: [], keyExpiry: null });
  // The same target derived from CROW_ARTIFACT_ORIGIN_BIND (a bridge IP).
  const derived = sidecarHealth({ statusJson: status(), serveConfig: serve(), bind: BRIDGE, originPort: PORT, now: NOW });
  assert.deepEqual(derived, { ok: true, problems: [], keyExpiry: null });
  // An expiry far away is healthy too.
  const far = sidecarHealth({ statusJson: status({ Self: { KeyExpiry: new Date(NOW + 90 * DAY).toISOString() } }), serveConfig: serve(), target: TARGET, now: NOW });
  assert.equal(far.ok, true);
  // AllowFunnel present but false is not Funnel.
  const off = sidecarHealth({ statusJson: status(), serveConfig: { ...serve(), AllowFunnel: { [`${HOST}:443`]: false } }, target: TARGET, now: NOW });
  assert.equal(off.ok, true);
});

test("a container instance: the sidecar joins its network and proxies by container name", () => {
  const CN = "http://crow-artifacts-household:3092";
  const r = sidecarHealth({ statusJson: status(), serveConfig: serve(CN), target: CN, now: NOW });
  assert.deepEqual(r, { ok: true, problems: [], keyExpiry: null });
  // An explicit target wins over the bind (the sidecar is in the instance's
  // network, so the gateway's own bind says nothing about what it can reach).
  const both = sidecarHealth({ statusJson: status(), serveConfig: serve(CN), target: CN, bind: BRIDGE, originPort: 3092, now: NOW });
  assert.equal(both.ok, true);
  const v6 = "http://[fd00::1]:3090";
  assert.equal(sidecarHealth({ statusJson: status(), serveConfig: serve(v6), target: v6, now: NOW }).ok, true);
});

test("logged out: any BackendState other than Running", () => {
  for (const s of ["NeedsLogin", "Stopped", "Starting", "NoState", undefined]) {
    const r = sidecarHealth({ statusJson: { ...status(), BackendState: s }, serveConfig: serve(), target: TARGET, now: NOW });
    assert.equal(r.ok, false, String(s));
    assert.ok(r.problems.includes("logged-out"), String(s));
  }
});

test("key expiry within 14 days (or already past) is reported with the date", () => {
  const soon = new Date(NOW + 13 * DAY).toISOString();
  const r = sidecarHealth({ statusJson: status({ Self: { KeyExpiry: soon } }), serveConfig: serve(), target: TARGET, now: NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ["key-expiring"]);
  assert.equal(r.keyExpiry, soon);
  const past = sidecarHealth({ statusJson: status({ Self: { KeyExpiry: new Date(NOW - DAY).toISOString() } }), serveConfig: serve(), target: TARGET, now: NOW });
  assert.ok(past.problems.includes("key-expiring"));
  // The zero time / unparseable values mean "no expiry known", not a problem.
  for (const v of ["0001-01-01T00:00:00Z", "garbage", null]) {
    const z = sidecarHealth({ statusJson: status({ Self: { KeyExpiry: v } }), serveConfig: serve(), target: TARGET, now: NOW });
    assert.equal(z.ok, true, String(v));
  }
});

test("Funnel on for the artifact node is a problem (public links are not built yet)", () => {
  const r = sidecarHealth({ statusJson: status(), serveConfig: { ...serve(), AllowFunnel: { [`${HOST}:443`]: true } }, target: TARGET, now: NOW });
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes("funnel-on"));
  const other = sidecarHealth({ statusJson: status(), serveConfig: { ...serve(), AllowFunnel: { [`${HOST}:8443`]: true } }, target: TARGET, now: NOW });
  assert.ok(other.problems.includes("funnel-on"), "Funnel on any hostport counts");
});

test("a loopback Serve Proxy is host networking: `host-loopback`, not `unexpected-mapping`", () => {
  for (const proxy of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`, `http://::1:${PORT}`]) {
    const r = sidecarHealth({ statusJson: status(), serveConfig: serve(proxy), target: TARGET, originPort: PORT, now: NOW });
    assert.equal(r.ok, false, proxy);
    assert.deepEqual(r.problems, ["host-loopback"], proxy);
  }
  // Loopback even under another scheme, and in a second handler: the netstack
  // would still forward the node's every port to this computer's loopback.
  const https = sidecarHealth({ statusJson: status(), serveConfig: serve(`https://127.0.0.1:${PORT}`), target: TARGET, now: NOW });
  assert.deepEqual(https.problems, ["host-loopback"]);
  const second = {
    TCP: { 443: { HTTPS: true } },
    Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: TARGET }, "/x": { Proxy: "http://127.0.0.1:3001" } } } },
  };
  assert.deepEqual(sidecarHealth({ statusJson: status(), serveConfig: second, target: TARGET, now: NOW }).problems, ["host-loopback"]);
  // Funnel is still reported alongside it.
  const both = sidecarHealth({ statusJson: status(), serveConfig: { ...serve(`http://127.0.0.1:${PORT}`), AllowFunnel: { [`${HOST}:443`]: true } }, target: TARGET, now: NOW });
  assert.deepEqual(both.problems, ["funnel-on", "host-loopback"]);
});

test("a loopback (or wildcard, or unknown) bind means no reachable target: host-loopback", () => {
  // The default bind is loopback, so nothing but host networking reaches the
  // origin from a sidecar — whatever the live mapping claims.
  const dflt = sidecarHealth({ statusJson: status(), serveConfig: serve(), originPort: PORT, now: NOW });
  assert.deepEqual(dflt.problems, ["host-loopback"]);
  for (const bind of ["127.0.0.1", "::1", "localhost", "0.0.0.0", "::", ""]) {
    const r = sidecarHealth({ statusJson: status(), serveConfig: serve(), bind, originPort: PORT, now: NOW });
    assert.deepEqual(r.problems, ["host-loopback"], bind);
  }
  // An explicit (unparseable) target cannot be judged either: fail closed.
  const bad = sidecarHealth({ statusJson: status(), serveConfig: serve(), target: `http://${BRIDGE}:${PORT}/x`, originPort: PORT, now: NOW });
  assert.deepEqual(bad.problems, ["unexpected-mapping"]);
});

test("any mapping other than the one 443 -> <expected target> proxy is unexpected", () => {
  const cases = {
    "wrong port": serve(`http://${BRIDGE}:${PORT + 1}`),
    "another address": serve(`http://172.30.0.9:${PORT}`),
    "container name instead": serve(`http://crow-artifacts:${PORT}`),
    "https backend": serve(`https://172.30.0.9:${PORT}`),
    "trailing path": serve(`http://172.30.0.9:${PORT}/x`),
    "second handler": { ...serve(), Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: TARGET }, "/x": { Proxy: "http://172.30.0.9:3001" } } } } },
    "path handler": { ...serve(), Web: { [`${HOST}:443`]: { Handlers: { "/": { Path: "/etc" } } } } },
    "text handler": { ...serve(), Web: { [`${HOST}:443`]: { Handlers: { "/": { Text: "hi" } } } } },
    "second web host": { ...serve(), Web: { ...serve().Web, [`${HOST}:8443`]: { Handlers: { "/": { Proxy: TARGET } } } } },
    "web on another port": { TCP: { 8443: { HTTPS: true } }, Web: { [`${HOST}:8443`]: { Handlers: { "/": { Proxy: TARGET } } } } },
    "extra tcp port": { ...serve(), TCP: { 443: { HTTPS: true }, 22: { TCPForward: "172.30.0.9:22" } } },
    "tcp forward on 443": { ...serve(), TCP: { 443: { TCPForward: "172.30.0.9:22" } } },
    "no mapping": { TCP: {}, Web: {} },
    "services block": { ...serve(), Services: { "svc:x": {} } },
    "not an object": "nope",
  };
  for (const [name, cfg] of Object.entries(cases)) {
    const r = sidecarHealth({ statusJson: status(), serveConfig: cfg, target: TARGET, originPort: PORT, now: NOW });
    assert.equal(r.ok, false, name);
    assert.ok(r.problems.includes("unexpected-mapping"), `${name}: ${r.problems}`);
  }
});

test("unreadable status or serve config fails closed (unreachable), never ok", () => {
  for (const [s, c] of [[null, serve()], [status(), null], [undefined, undefined]]) {
    const r = sidecarHealth({ statusJson: s, serveConfig: c, target: TARGET, now: NOW });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes("unreachable"));
  }
  const noPort = sidecarHealth({ statusJson: status(), serveConfig: serve(), target: null, originPort: null, now: NOW });
  assert.equal(noPort.ok, false, "without a known origin port no mapping can be judged correct");
  assert.ok(noPort.problems.includes("unexpected-mapping"));
});

test("expected target: explicit wins, else the bind when it is specific and not loopback, else host-loopback", () => {
  assert.deepEqual(expectedSidecarTarget({ target: TARGET }), { target: TARGET, problem: null });
  assert.deepEqual(expectedSidecarTarget({ target: "http://CROW-artifacts:3090" }), { target: "http://crow-artifacts:3090", problem: null });
  assert.deepEqual(expectedSidecarTarget({ target: "http://[fd00::1]:3090" }), { target: "http://[fd00::1]:3090", problem: null });
  assert.deepEqual(expectedSidecarTarget({ bind: BRIDGE, originPort: 3090 }), { target: TARGET, problem: null });
  assert.deepEqual(expectedSidecarTarget({ bind: BRIDGE, originPort: "3090" }), { target: TARGET, problem: null });
  assert.deepEqual(expectedSidecarTarget({ bind: "fd00::1", originPort: 3090 }), { target: "http://[fd00::1]:3090", problem: null });
  // A target wins even when the bind is loopback (the container-instance case).
  assert.deepEqual(expectedSidecarTarget({ target: TARGET, bind: "127.0.0.1", originPort: 3090 }), { target: TARGET, problem: null });
  for (const bind of [null, undefined, "", "127.0.0.1", "::1", "localhost", "0.0.0.0", "::", "*"]) {
    assert.deepEqual(expectedSidecarTarget({ bind, originPort: 3090 }), { target: null, problem: "host-loopback" }, String(bind));
  }
  assert.deepEqual(expectedSidecarTarget({ target: "https://172.30.0.1:3090", originPort: 3090 }), { target: null, problem: "unexpected-mapping" });
  assert.deepEqual(expectedSidecarTarget({ bind: BRIDGE, originPort: null }), { target: null, problem: "unexpected-mapping" });
});

test("parseOriginTarget accepts only http://<hostname|IPv4>:<port> (IPv6 brackets optional)", () => {
  assert.deepEqual(parseOriginTarget("http://172.30.0.1:3090"), { host: "172.30.0.1", port: 3090, url: "http://172.30.0.1:3090" });
  assert.equal(parseOriginTarget("http://crow-artifacts:3092")?.url, "http://crow-artifacts:3092");
  assert.equal(parseOriginTarget("http://[fd00::1]:3090")?.url, "http://[fd00::1]:3090");
  assert.equal(parseOriginTarget("http://fd00::1:3090")?.url, "http://[fd00::1]:3090", "IPv6 brackets are optional");
  for (const bad of [
    "http://172.30.0.1:3090/", "http://172.30.0.1:3090/x", "http://user@172.30.0.1:3090", "http://u:p@172.30.0.1:3090",
    "http://172.30.0.1:3090?x=1", "http://172.30.0.1:3090#x", "https://172.30.0.1:3090", "172.30.0.1:3090",
    "http://172.30.0.1", "http://:3090", "http://172.30.0.1:0", "http://172.30.0.1:99999", "http://172.30.0.1:3090 ",
    " http://172.30.0.1:3090", "http://172.30.0.1:3090;rm", "http://[::1:3090", "",
  ]) assert.equal(parseOriginTarget(bad), null, bad);
  for (const bad of [3090, null, undefined, {}, ""]) assert.equal(parseOriginTarget(bad), null, String(bad));
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("172.30.0.1"), false);
  assert.equal(isLoopbackHost("crow-artifacts"), false);
});

test("the shipped serve.json.tmpl, rendered for the main instance, passes the audit (no AllowFunnel, one mapping)", () => {
  const tmpl = readFileSync(new URL("../bundles/artifacts/sidecar/serve.json.tmpl", import.meta.url), "utf8");
  assert.doesNotMatch(tmpl, /AllowFunnel/, "no Funnel key at all before public links (step 6)");
  assert.match(tmpl, /\{\{ORIGIN_TARGET\}\}/, "the template carries the target placeholder");
  assert.doesNotMatch(tmpl, /127\.0\.0\.1|localhost/, "the shipped template never points at loopback");
  const rendered = renderServeConfig(tmpl, { target: TARGET });
  const cfg = JSON.parse(rendered);
  // tailscaled substitutes ${TS_CERT_DOMAIN} itself; the audit sees the live
  // name. Substitute here the way the container would.
  const live = JSON.parse(rendered.replaceAll("${TS_CERT_DOMAIN}", HOST));
  assert.ok(cfg.Web["${TS_CERT_DOMAIN}:443"], "the template keeps tailscaled's own placeholder");
  assert.equal(cfg.Web["${TS_CERT_DOMAIN}:443"].Handlers["/"].Proxy, TARGET);
  const r = sidecarHealth({ statusJson: status(), serveConfig: live, target: TARGET, now: NOW });
  assert.deepEqual(r, { ok: true, problems: [], keyExpiry: null });
  // And the same template rendered for another address fails this target's audit.
  const wrong = JSON.parse(renderServeConfig(tmpl, { target: `http://172.30.0.9:${PORT}` }).replaceAll("${TS_CERT_DOMAIN}", HOST));
  assert.equal(sidecarHealth({ statusJson: status(), serveConfig: wrong, target: TARGET, now: NOW }).ok, false);
  // A loopback rendering is reported as the host-networking shape.
  const loop = JSON.parse(renderServeConfig(tmpl, { target: `http://127.0.0.1:${PORT}` }).replaceAll("${TS_CERT_DOMAIN}", HOST));
  assert.deepEqual(sidecarHealth({ statusJson: status(), serveConfig: loop, target: TARGET, now: NOW }).problems, ["host-loopback"]);
});

test("renderServeConfig rejects a port, a path, userinfo, a query, another scheme and junk", () => {
  const tmpl = readFileSync(new URL("../bundles/artifacts/sidecar/serve.json.tmpl", import.meta.url), "utf8");
  for (const bad of [
    `http://${BRIDGE}:${PORT}/x`, `http://${BRIDGE}:${PORT}/`, `http://user@${BRIDGE}:${PORT}`,
    `http://${BRIDGE}:${PORT}?x=1`, `http://${BRIDGE}:${PORT}#x`, `https://${BRIDGE}:${PORT}`,
    `${BRIDGE}:${PORT}`, `http://${BRIDGE}`, "http://:3090", `http://${BRIDGE}:0`,
    `http://${BRIDGE}:3090 `, ` http://${BRIDGE}:3090`, `http://${BRIDGE}:3090;rm`, 3090,
  ]) assert.throws(() => renderServeConfig(tmpl, { target: bad }), /target/, String(bad));
  assert.throws(() => renderServeConfig(tmpl, {}), /target/);
  // No backward compatibility for the old port argument: the Proxy must be a target.
  assert.throws(() => renderServeConfig(tmpl, { originPort: PORT }), /target/);
  // Accepted forms (IPv6 brackets optional).
  for (const [given, url] of [
    [TARGET, TARGET],
    ["http://crow-artifacts:3092", "http://crow-artifacts:3092"],
    ["http://[fd00::1]:3090", "http://[fd00::1]:3090"],
    ["http://fd00::1:3090", "http://[fd00::1]:3090"],
  ]) {
    const out = JSON.parse(renderServeConfig(tmpl, { target: given }));
    assert.equal(out.Web["${TS_CERT_DOMAIN}:443"].Handlers["/"].Proxy, url, given);
  }
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

  const env = {
    CROW_ARTIFACT_SIDECAR_SOCKET: "/run/crow-artifacts/tailscaled.sock",
    CROW_ARTIFACT_ORIGIN_PORT: "3090",
    CROW_ARTIFACT_ORIGIN_BIND: BRIDGE,
  };
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

  // CROW_ARTIFACT_SIDECAR_TARGET alone is enough to know the expected mapping.
  const byTarget = createSidecarHealthReader({ env: { ...env, CROW_ARTIFACT_ORIGIN_BIND: undefined, CROW_ARTIFACT_SIDECAR_TARGET: TARGET }, exec, now: () => t });
  assert.equal((await byTarget()).ok, true);
  // A default (loopback) bind is the host-networking shape, reported as such.
  const byLoopback = createSidecarHealthReader({ env: { CROW_ARTIFACT_SIDECAR_SOCKET: env.CROW_ARTIFACT_SIDECAR_SOCKET, CROW_ARTIFACT_ORIGIN_PORT: "3090" }, exec, now: () => t });
  const loop = await byLoopback();
  assert.equal(loop.ok, false);
  assert.deepEqual(loop.problems, ["host-loopback"]);

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
    hs._setArtifactNodeReader(async () => ({ ok: false, problems: ["logged-out", "key-expiring", "funnel-on", "host-loopback", "unexpected-mapping"], keyExpiry: exp }));
    for (const lang of ["en", "es"]) {
      hs.invalidateHealthCache();
      r = await hs.collectHealthSignals(null, { now: () => NOW, lang });
      assert.equal(r.details.find((d) => d.id === "artifact-node")?.state, "warn");
      const issues = r.issues.filter((i) => i.id.startsWith("artifact-node:"));
      assert.deepEqual(issues.map((i) => i.id).sort(), ["artifact-node:funnel-on", "artifact-node:host-loopback", "artifact-node:key-expiring", "artifact-node:logged-out", "artifact-node:unexpected-mapping"]);
      for (const i of issues) {
        assert.equal(i.severity, "warn", "warn issues are pushed as notifications by the health monitor");
        assert.ok(i.label && !/signals\.artifactNode/.test(i.label), `${lang}: translated label for ${i.id}`);
      }
      const k = issues.find((i) => i.id === "artifact-node:key-expiring");
      assert.match(k.label, /2026-10-11/, "the expiry date is shown");
      // host-loopback has a human message in both languages, not a raw code.
      const hl = issues.find((i) => i.id === "artifact-node:host-loopback");
      assert.match(hl.label, lang === "es" ? /servicios privados de este equipo/ : /private services/);
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