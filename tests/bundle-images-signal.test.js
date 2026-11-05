/**
 * bundle-images-signal.test.js — security audit N1c-7.
 *
 * The `bundleImages` nest signal: how old the images the INSTALLED bundles run
 * are. Informational only, so the assertions here are about the line it draws
 * and above all about it never warning:
 *   - an image older than 90 days → ONE info line per bundle, naming the bundle
 *     and the age, linking to that bundle's page;
 *   - nothing that old → ok, "bundle images are recent";
 *   - Docker failing (or a ragged `image inspect` answer) → "unknown", info,
 *     NEVER ok;
 *   - no `docker` binary at all (ENOENT) → no card: a host with only MCP-style
 *     bundles never needs Docker, and a permanent "unknown" would be noise.
 *
 * The two exec calls are stubbed through _setBundleImageReaders, so nothing here
 * depends on the Docker state of the machine running the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  collectHealthSignals,
  invalidateHealthCache,
  _setDiskReader,
  _setTailscaleReader,
  _setDockerPortsReader,
  _setFirewallReader,
  _setContainerReader,
  _setBundleImageReaders,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import { BUNDLE_IMAGE_STALE_DAYS } from "../servers/gateway/dashboard/panels/nest/bundle-images.js";
import { resolveCrowHome } from "../servers/shared/crow-home.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

// Test isolation: sibling signals are neutralized exactly as
// tests/published-ports-signal.test.js does, so nothing else can add an issue.
process.env.CROW_PUBLISH_SNAPSHOT = "/tmp/__crow_test_no_publish_snapshot__.json";
process.env.CROW_BACKUP_DIR = "/tmp/__crow_test_nonexistent_backup_dir__";
process.env.CROW_GATEWAY_BIND = "127.0.0.1";
delete process.env.CROW_DASHBOARD_PUBLIC;
delete process.env.CROW_CSRF_STRICT;
_setTailscaleReader(() => { throw new Error("no tailscale"); });
_setDiskReader(() => "Avail Size\n500000M 1000000M\n");
_setDockerPortsReader(() => { throw new Error("no docker"); });
_setFirewallReader(() => { throw new Error("no ufw.conf"); });
_setContainerReader(() => false);

const NOW = Date.parse("2026-11-05T12:00:00Z");
const DAY = 86_400_000;

/** Generic stub: every query answers no rows (sibling signals degrade quietly). */
function makeDb() {
  return { execute: async () => ({ rows: [] }) };
}

/** A `docker ps` row for a container of the installed bundle `id`. */
const psRow = (id, image) => `${join(resolveCrowHome(), "bundles", id)}\t${image}`;

/** `docker image inspect --format '{{.Created}}'` output for images at the given ages. */
const createdLines = (ages) => ages.map((days) => new Date(NOW - days * DAY).toISOString()).join("\n");

async function bundleImages(db, opts = {}) {
  const { installed = [], containers = () => "", created = () => "" } = opts;
  _setBundleImageReaders({ installed: () => installed, containers, created });
  invalidateHealthCache();
  const r = await collectHealthSignals(db, { now: () => NOW });
  return {
    result: r,
    detail: r.details.find((d) => d.id === "bundleImages"),
    issues: r.issues.filter((i) => i.id === "bundleImages" || i.id.startsWith("bundleImages:")),
  };
}

test("an image older than the threshold gives ONE info line per bundle, naming it and linking to its page", async () => {
  const { result, detail, issues } = await bundleImages(makeDb(), {
    installed: ["immich", "navidrome"],
    containers: () => [psRow("immich", "ghcr.io/immich-app/immich-server:v1.100.0"), psRow("navidrome", "deluan/navidrome:0.64.2")].join("\n"),
    // immich 200 days old, navidrome 5 days old.
    created: () => createdLines([200, 5]),
  });

  assert.equal(detail.state, "info");
  assert.equal(result.ok, true, "an aged image is never a failure");

  const immich = issues.find((i) => i.id === "bundleImages:immich");
  assert.ok(immich, "one issue for the aged bundle");
  assert.equal(immich.severity, "info");
  assert.match(immich.label, /immich: image is 200 days old/);
  assert.equal(immich.actionHref, "/dashboard/extensions?q=immich");
  assert.equal(issues.some((i) => i.id === "bundleImages:navidrome"), false, "a recent bundle gets no line");
  assert.equal(issues.some((i) => i.severity === "warn"), false, "never a warn");
});

test("the threshold is 90 days, and it is a floor on the OLDEST image of the bundle", async () => {
  assert.equal(BUNDLE_IMAGE_STALE_DAYS, 90);
  const { issues } = await bundleImages(makeDb(), {
    installed: ["romm"],
    containers: () => [psRow("romm", "rommapp/romm:5.4.1"), psRow("romm", "mariadb:13.0.2")].join("\n"),
    // The app image is fresh, the database sidecar is 400 days old.
    created: () => createdLines([2, 400]),
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0].label, /romm: image is 400 days old/);
});

test("nothing old → ok, 'bundle images are recent'", async () => {
  const { detail, issues, result } = await bundleImages(makeDb(), {
    installed: ["shiori"],
    containers: () => psRow("shiori", "ghcr.io/go-shiori/shiori:v1.8.0"),
    created: () => createdLines([12]),
  });
  assert.equal(detail.state, "ok");
  assert.equal(detail.value, t("signals.bundleImages.ok", "en"));
  assert.deepEqual(issues, []);
  assert.equal(result.ok, true);
});

test("docker unavailable → 'unknown' at info, never ok", async () => {
  // Docker is there but unusable (a hung daemon, permissions): worth saying.
  const hung = Object.assign(new Error("docker: timed out"), { code: "ETIMEDOUT" });
  const { detail, issues, result } = await bundleImages(makeDb(), {
    installed: ["jellyfin"],
    containers: () => { throw hung; },
  });
  assert.equal(detail.state, "info");
  assert.equal(detail.value, t("signals.bundleImages.unknown", "en"));
  const issue = issues.find((i) => i.id === "bundleImages");
  assert.ok(issue, "unknown is surfaced, not silently dropped");
  assert.equal(issue.severity, "info");
  assert.equal(result.ok, true);
});

test("no docker binary at all (ENOENT) → no card, not 'unknown'", async () => {
  const missing = () => { throw Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }); };
  const { detail, issues } = await bundleImages(makeDb(), { installed: ["linkding"], containers: missing });
  assert.equal(detail, undefined, "an MCP-only host gets no permanent card");
  assert.deepEqual(issues, []);

  // The binary can also vanish between the two calls.
  const second = await bundleImages(makeDb(), {
    installed: ["linkding"],
    containers: () => psRow("linkding", "sissbruecker/linkding:1.47.0"),
    created: missing,
  });
  assert.equal(second.detail, undefined);
  assert.deepEqual(second.issues, []);
});

test("a timed-out / ragged image inspect answer → 'unknown', never ok", async () => {
  const { detail } = await bundleImages(makeDb(), {
    installed: ["kavita"],
    containers: () => psRow("kavita", "jvmilazz0/kavita:0.9.1"),
    // Nothing came back for the image that was asked about.
    created: () => "",
  });
  assert.equal(detail.state, "info");
  assert.equal(detail.value, t("signals.bundleImages.unknown", "en"));
});

test("containers that are not an installed bundle's are ignored", async () => {
  const { detail, issues } = await bundleImages(makeDb(), {
    installed: ["linkding"],
    containers: () => [
      `${join(resolveCrowHome(), "bundles", "some-other-thing")}\tghcr.io/example/old:1`,
      "/home/someone/checkout/docker\tnginx:1",
    ].join("\n"),
    created: () => createdLines([900, 900]),
  });
  assert.equal(detail.state, "ok");
  assert.deepEqual(issues, []);
});

test("no installed bundles → no card at all", async () => {
  const { detail, issues } = await bundleImages(makeDb(), { installed: [] });
  assert.equal(detail, undefined);
  assert.deepEqual(issues, []);
});

test("en and es strings exist for every new key", () => {
  for (const key of [
    "signals.bundleImages.label",
    "signals.bundleImages.ok",
    "signals.bundleImages.unknown",
    "signals.bundleImages.unknownWhy",
    "signals.bundleImages.reasonDocker",
    "signals.bundleImages.reasonInspect",
    "signals.bundleImages.old",
    "signals.bundleImages.count",
    "signals.bundleImages.action",
  ]) {
    for (const lang of ["en", "es"]) assert.notEqual(t(key, lang), key, `missing i18n for ${key} (${lang})`);
  }
});