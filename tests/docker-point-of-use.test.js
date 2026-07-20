/**
 * Item 4-PR5 — Docker at point of use.
 *
 * A `deploys`-kind bundle (type "bundle" with a docker-compose.yml) needs a
 * reachable Docker daemon; validateInstall must refuse it with an honest 4xx
 * (code "docker_unavailable") BEFORE any compose invocation, and the extensions
 * page renders a passive banner when docker is missing. connects/builtin
 * installs must be unaffected.
 *
 * Seam: the probe execFile's `docker`, resolved via PATH — tests prepend a
 * tmpdir holding a fake `docker` executable (exit 0 / exit 1 / hang), plus
 * _resetDockerProbeForTest() to clear the 60s cache between assertions. No
 * real docker daemon is touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scratch CROW_HOME BEFORE importing bundles.js (see bundles-install-job.test.js:
// module-load path resolution + runInstallJob's unconditional mkdir hazard).
process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-test-home-"));

const { dockerAvailable, _resetDockerProbeForTest } =
  await import("../servers/gateway/dashboard/panels/extensions/data-queries.js");
const bundlesRoutes = await import("../servers/gateway/routes/bundles.js");
const { validateInstall } = bundlesRoutes;
const { buildExtensionsHTML } = await import("../servers/gateway/dashboard/panels/extensions/html.js");
const { loadCollections } = await import("../servers/gateway/dashboard/panels/extensions/collections.js");
const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { extensionsClientJS } = await import("../servers/gateway/dashboard/panels/extensions/client.js");

// ─── PATH-stubbed fake docker ───

const REAL_PATH = process.env.PATH;
const STUB_DIR = mkdtempSync(join(tmpdir(), "crow-docker-stub-"));
const STUB_BIN = join(STUB_DIR, "docker");

/** Point PATH at a fake `docker` that exits `code` (after optional sleep). */
function stubDocker(code, { sleepSecs = 0 } = {}) {
  const body = sleepSecs > 0
    ? `#!/bin/sh\nsleep ${sleepSecs}\nexit ${code}\n`
    : `#!/bin/sh\nexit ${code}\n`;
  writeFileSync(STUB_BIN, body);
  chmodSync(STUB_BIN, 0o755);
  process.env.PATH = `${STUB_DIR}:${REAL_PATH}`;
}

function restorePath() {
  process.env.PATH = REAL_PATH;
  _resetDockerProbeForTest();
}

// ─── The probe ───

test("dockerAvailable(): true when `docker info` exits 0, false when it exits nonzero", async () => {
  try {
    stubDocker(0);
    _resetDockerProbeForTest();
    assert.equal(await dockerAvailable(), true);

    stubDocker(1);
    _resetDockerProbeForTest();
    assert.equal(await dockerAvailable(), false);
  } finally {
    restorePath();
  }
});

test("dockerAvailable(): result is cached (~60s) — a flipped daemon state is not observed until the cache clears", async () => {
  try {
    stubDocker(0);
    _resetDockerProbeForTest();
    assert.equal(await dockerAvailable(), true);

    // Daemon "goes down" — but the cache must still answer true (no re-spawn).
    stubDocker(1);
    assert.equal(await dockerAvailable(), true, "cached result must be served within the TTL");

    _resetDockerProbeForTest();
    assert.equal(await dockerAvailable(), false, "after cache reset the new state is observed");
  } finally {
    restorePath();
  }
});

test("dockerAvailable(): a hung docker daemon resolves false within the probe timeout (never blocks render)", async () => {
  try {
    stubDocker(0, { sleepSecs: 30 });
    _resetDockerProbeForTest();
    const t0 = Date.now();
    const ok = await dockerAvailable();
    const elapsed = Date.now() - t0;
    assert.equal(ok, false, "a hung probe must resolve unavailable");
    assert.ok(elapsed < 10_000, `probe must time out quickly (took ${elapsed}ms)`);
  } finally {
    restorePath();
  }
});

test("routes/bundles.js re-exports the SAME probe the extensions panel uses (one cache, one result)", () => {
  assert.equal(typeof dockerAvailable, "function", "probe must exist (guards against undefined === undefined vacuity)");
  assert.equal(bundlesRoutes.dockerAvailable, dockerAvailable);
});

// ─── The install guard ───

test("MUTATION (install guard): deploys bundle with docker unavailable → 4xx docker_unavailable BEFORE any compose invocation", async () => {
  // uptime-kuma is type "bundle" with a docker-compose.yml. Deleting the gate
  // in validateInstall makes this return ok:true and turns this test red.
  try {
    stubDocker(1);
    _resetDockerProbeForTest();
    const r = await validateInstall("uptime-kuma", { forceInstall: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 412, "docker gate must be an honest 4xx");
    assert.equal(r.code, "docker_unavailable");
    assert.equal(r.extra?.code, "docker_unavailable", "the code must reach the JSON error body (route spreads extra)");
    assert.match(r.error, /[Dd]ocker/, "error must name Docker");
    assert.match(r.error, /crow-install\.sh|[Ii]nstall Docker/, "error must say what to do");
  } finally {
    restorePath();
  }
});

test("deploys bundle passes the docker gate when the daemon answers", async () => {
  try {
    stubDocker(0);
    _resetDockerProbeForTest();
    const r = await validateInstall("uptime-kuma", { forceInstall: true });
    assert.equal(r.ok, true, `expected ok, got ${r.code}: ${r.error}`);
    assert.equal(r.manifest.id, "uptime-kuma");
  } finally {
    restorePath();
  }
});

test("connects/builtin installs are unaffected by a missing docker daemon (kodi: mcp-server, no compose file)", async () => {
  try {
    stubDocker(1);
    _resetDockerProbeForTest();
    const r = await validateInstall("kodi", { forceInstall: true });
    assert.equal(r.ok, true, `expected ok, got ${r.code}: ${r.error}`);
  } finally {
    restorePath();
  }
});

// ─── The banner ───

const AVAILABLE = [
  { id: "jellyfin", name: "Jellyfin", description: "Media server", type: "bundle", category: "media", version: "1.0.0", author: "Crow", featured: true, tags: ["media"] },
];

function render(overrides = {}) {
  return buildExtensionsHTML({
    installed: {},
    available: AVAILABLE,
    collections: loadCollections(),
    registrySource: "local",
    communityStores: [],
    bundleStatus: {},
    lang: "en",
    ...overrides,
  });
}

test("MUTATION (banner conditional): banner renders when dockerOk is false, and ONLY then", () => {
  const off = render({ dockerOk: false });
  assert.match(off.viewsHtml, /ext-docker-banner/, "banner missing when docker is unavailable");

  const on = render({ dockerOk: true });
  assert.doesNotMatch(on.viewsHtml, /ext-docker-banner/, "banner must not render when docker is available");

  const dflt = render(); // param defaulted — existing pure render callers keep passing
  assert.doesNotMatch(dflt.viewsHtml, /ext-docker-banner/, "default must be no banner");
});

test("banner renders in Spanish too (i18n threading)", () => {
  const es = render({ dockerOk: false, lang: "es" });
  assert.match(es.viewsHtml, /ext-docker-banner/);
  assert.match(es.viewsHtml, new RegExp(translations["extensions.dockerUnavailable"].es.slice(0, 20)));
});

test("i18n: docker-unavailable banner/guidance keys exist in EN and ES", () => {
  for (const key of ["extensions.dockerUnavailable", "extensions.dockerUnavailableDesc"]) {
    assert.ok(translations[key], `missing i18n key ${key}`);
    assert.ok(translations[key].en?.length > 0, `${key} missing en`);
    assert.ok(translations[key].es?.length > 0, `${key} missing es`);
    assert.match(translations[key].en, /Docker/, `${key}.en must name Docker`);
    assert.match(translations[key].es, /Docker/, `${key}.es must name Docker`);
  }
});

// ─── C1/C3 Task 10: banner names the fresh-install re-login cause ───

test("Task 10: dockerUnavailableDesc names the fresh-install re-login cause (moved from the installer's Step 3 warn), with a real (non-identical) ES translation", () => {
  const desc = translations["extensions.dockerUnavailableDesc"];
  assert.match(desc.en, /log out.*back in/i, "en must tell the user to log out/back in for the Docker group to take effect");
  assert.match(desc.es, /cierra la sesión.*vuelve a iniciarla/i, "es must carry the same re-login guidance");
  assert.notEqual(desc.en, desc.es, "es must be a real translation, not an EN copy");
  // The existing re-run-the-installer sentence must still be present and still second.
  const enSentences = desc.en.split(". ");
  assert.match(enSentences[1], /re-run the install script/, "re-run-the-installer guidance must stay the second sentence");
});

// ─── The client error surface (verification pin — B3) ───

test("client install-error surface renders the server's error message (res.data.error), so the 4xx guidance reaches the user", () => {
  const js = extensionsClientJS("en");
  assert.match(js, /statusDiv\.textContent = res\.data\.error \|\|/, "install modal must show server error bodies verbatim");
});
