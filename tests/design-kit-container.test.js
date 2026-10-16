// Design kit renderer packaging (spec §3.3): loopback-only publish, engines on an
// internal-only network, hardening, pinned base image and D2 binary, port row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const compose = read("bundles/design-kit/docker-compose.yml");

test("the manifest declares no ports and no webUI: no ufw rule is ever opened (review H3)", () => {
  const m = JSON.parse(read("bundles/design-kit/manifest.json"));
  for (const k of ["ports", "port", "webUI"]) assert.equal(m[k], undefined, k);
  assert.deepEqual(m.docker, { composefile: "docker-compose.yml", pull_timeout_s: 1800 });
});

test("only the door publishes, on 127.0.0.1:8018; the renderer is internal-only", () => {
  const published = compose.match(/^\s*-\s*"[^"]*:\d+:\d+"\s*$/gm) || [];
  assert.deepEqual(published.map((s) => s.trim()), ['- "127.0.0.1:8018:8018"']);
  assert.match(compose, /render-internal:\s*\n\s*internal: true/);
  const render = compose.split(/^  door:/m)[0];
  assert.match(render, /networks: \[render-internal\]/, "render joins ONLY the internal network");
  assert.doesNotMatch(render, /ports:/);
  for (const k of ["read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "mem_limit:", "pids_limit:"]) assert.ok(render.includes(k), `render: ${k}`);
  assert.doesNotMatch(compose, /network_mode:\s*host|privileged:\s*true|docker\.sock/);
  assert.match(compose, /build:\n\s+context: \.\/renderer/, "block-form build context (refreshed on version bumps)");
  const door = compose.split(/^  door:/m)[1].split(/^networks:/m)[0];
  for (const k of ["read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "mem_limit:", "pids_limit:", "cpus:"]) assert.ok(door.includes(k), `door: ${k}`);
});

test("the smoke script never touches the prod names or port, and is caught by the deadman prefix", () => {
  const s = read("scripts/design-kit/smoke-renderer.sh");
  assert.doesNotMatch(s, /crow-design-kit-(?:render|door)\b|127\.0\.0\.1:8018\b/);
  assert.match(s, /-p 127\.0\.0\.1:18018:8018/);
  const names = [...s.matchAll(/--name (\S+)|network create (?:--internal )?(\S+)/g)].map((m) => m[1] || m[2]);
  assert.ok(names.length >= 4);
  for (const n of names) assert.match(n, /^design-kit-smoke-/, n);
  assert.match(s, /trap .*down.* ERR/, "a failed 'up' tears itself down");
  assert.match(s, /"\$0" down >&2\n\s*echo "smoke renderer did not come up"/, "health timeout tears down");
  assert.match(s, /--cpus [\d.]+ [^\n]*door\.mjs/, "door has a CPU limit");
});

test("Chromium runs without its own sandbox only because the container is the sandbox (no SYS_ADMIN)", () => {
  assert.match(read("bundles/design-kit/renderer/engines/mermaid.mjs"), /--no-sandbox: the container is the sandbox[^\n]*\n[^\n]*Never add SYS_ADMIN/);
  assert.doesNotMatch(compose, /SYS_ADMIN|cap_add/);
});

test("base image and D2 are pinned", () => {
  const df = read("bundles/design-kit/renderer/Dockerfile");
  assert.match(df, /^FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}$/m);
  assert.match(df, /^ARG D2_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(df, /sha256sum -c/);
  assert.match(df, /Chromium is not pinned/, "the accepted Chromium drift is stated");
  const sums = read("bundles/design-kit/renderer/d2.sha256").trim().split("\n");
  assert.deepEqual(sums.map((l) => l.replace(/^[0-9a-f]{64} {2}/, "")), ["/tmp/d2-amd64.tar.gz", "/tmp/d2-arm64.tar.gz"]);
  assert.ok(sums.every((l) => /^[0-9a-f]{64} {2}/.test(l)));
  const pkg = JSON.parse(read("bundles/design-kit/renderer/package.json"));
  for (const [n, v] of Object.entries(pkg.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, `${n} pinned exactly`);
  assert.equal(pkg.dependencies["vega-lite"], "6.5.0");
  assert.ok(pkg.dependencies["vega-interpreter"], "the renderer uses the CSP-safe interpreter (review M2)");
  // Ruling 2026-10-15: Mermaid stays on 11.17.2 (12.x bundles elkjs, EPL-2.0), as the page library does.
  assert.equal(pkg.dependencies.mermaid, "11.17.2");
  assert.equal(pkg.dependencies.svgo, "4.1.0");
  const lib = JSON.parse(read("bundles/design-kit/lib/manifest.json"));
  const pinned = (n) => (lib.entries || []).find((e) => e.name === n)?.version;
  for (const n of ["mermaid", "vega", "vega-lite"]) if (pinned(n)) assert.equal(pkg.dependencies[n], pinned(n), `${n} matches the page library`);
});

test("port 8018 is registered in both port docs", () => {
  assert.match(read("docs/developers/port-allocation.md"), /^\| 8018 \| 127\.0\.0\.1 \| design-kit/m);
  assert.match(read("docs/es/developers/port-allocation.md"), /^\| 8018 \| 127\.0\.0\.1 \| design-kit/m);
});

test("Mermaid runs strict with SVG labels and locks every label/style key against directives", async () => {
  const { MERMAID_CONFIG } = await import("../bundles/design-kit/renderer/mermaid-config.mjs");
  assert.equal(MERMAID_CONFIG.securityLevel, "strict");
  assert.equal(MERMAID_CONFIG.htmlLabels, false);
  assert.equal(MERMAID_CONFIG.flowchart.htmlLabels, false);
  assert.ok(Object.isFrozen(MERMAID_CONFIG));
  // Mermaid 11's own defaults, then every key that turns HTML labels or CSS on.
  for (const k of ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges",
    "htmlLabels", "flowchart", "themeCSS", "themeVariables", "fontFamily", "dompurifyConfig"]) assert.ok(MERMAID_CONFIG.secure.includes(k), `secure: ${k}`);
  const engine = read("bundles/design-kit/renderer/engines/mermaid.mjs");
  assert.match(engine, /setRequestInterception\(true\)/);
  assert.match(engine, /reset\(\)/);
});

test("Vega compiles with vega-lite + vega and the interpreter (never vega-embed); D2 never bundles local files", () => {
  const worker = read("bundles/design-kit/renderer/engines/vega-worker.mjs");
  assert.match(worker, /expressionInterpreter/);
  assert.match(worker, /ast: true/);
  assert.match(worker, /JSON\.parse/);
  assert.doesNotMatch(worker, /from "vega-embed"|import\(\s*"vega-embed"/);
  assert.match(read("bundles/design-kit/renderer/engines/d2.mjs"), /--bundle=false/);
});

test("the entrypoint widens the Host allowlist only from RENDER_ALLOWED_HOSTS", () => {
  const main = read("bundles/design-kit/renderer/main.mjs");
  assert.match(main, /process\.env\.RENDER_ALLOWED_HOSTS/);
  assert.match(main, /DEFAULT_ALLOWED_HOSTS/);
});
