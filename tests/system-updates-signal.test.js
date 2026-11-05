/**
 * system-updates-signal.test.js — security audit K6.
 *
 * The `systemUpdates` nest signal: how current the box is now that the
 * installer turned on unattended-upgrades for the system plus the NodeSource,
 * Docker and Caddy origins.
 *
 * Every filesystem read and the one `docker version` call go through
 * _setSystemUpdateReaders, so nothing here depends on the state of the machine
 * running the suite (its own /var/run/reboot-required, its apt files, its
 * daemon). Covered:
 *   - a reboot owed → WARN, with up to ten package names from reboot-required.pkgs;
 *   - the daily run off (missing or "0") → INFO + a link to the guide section;
 *   - a last run older than 3 days while the timer is on → WARN;
 *   - a fresh run → ok;
 *   - no apt, or a container → no card at all;
 *   - Docker failing → info, "Docker version unknown" (never ok, never a warn);
 *   - a check that could not run → info naming it, never ok.
 *
 * The versions are information only: the signal never looks up "latest".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectHealthSignals,
  invalidateHealthCache,
  _setDiskReader,
  _setTailscaleReader,
  _setDockerPortsReader,
  _setFirewallReader,
  _setContainerReader,
  _setArtifactNodeReader,
  _setBundleImageReaders,
  _setSystemUpdateReaders,
  systemUpdatesDocsHref,
  APT_CONF_DIR,
  AUTO_UPGRADES_CONF,
  REBOOT_REQUIRED_PATH,
  REBOOT_PKGS_PATH,
  UNATTENDED_STAMP_PATH,
  UNATTENDED_LOG_PATH,
  UPDATES_STALE_DAYS,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import { translations, fill } from "../servers/gateway/dashboard/shared/i18n.js";
import { docsUrl } from "../servers/gateway/dashboard/shared/components.js";

// Sibling signals are neutralized exactly as tests/bundle-images-signal.test.js
// does: none of them may add a card or an issue this suite did not ask for.
process.env.CROW_PUBLISH_SNAPSHOT = "/tmp/__crow_test_no_publish_snapshot__.json";
process.env.CROW_BACKUP_DIR = "/tmp/__crow_test_nonexistent_backup_dir__";
process.env.CROW_GATEWAY_BIND = "127.0.0.1";
delete process.env.CROW_DASHBOARD_PUBLIC;
delete process.env.CROW_CSRF_STRICT;
delete process.env.CROW_ARTIFACT_ORIGIN_URL;
_setTailscaleReader(() => { throw new Error("no tailscale"); });
_setDiskReader(() => "Avail Size\n500000M 1000000M\n");
_setDockerPortsReader(() => { throw new Error("no docker"); });
_setFirewallReader(() => { throw new Error("no ufw.conf"); });
_setContainerReader(() => false);
_setArtifactNodeReader(async () => null);
_setBundleImageReaders({ installed: () => [] });

const NOW = Date.parse("2026-11-05T12:00:00Z");
const DAY = 86_400_000;
const NODE = process.version.replace(/^v/, "");
const AUTO_CONF = join(APT_CONF_DIR, AUTO_UPGRADES_CONF);

/** Generic stub: every query answers no rows (sibling signals degrade quietly). */
function makeDb() {
  return { execute: async () => ({ rows: [] }) };
}

/** The distro's periodic-switch file, with the unattended-upgrade flag set. */
const autoConf = (flag = "1") =>
  `APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "${flag}";\n`;

/**
 * A fake machine. `files` and `mtimes` are path → content / mtime; `present`
 * lists paths that exist but carry no content (like /var/run/reboot-required).
 */
function fakeRoot({ apt = true, files = {}, present = [], mtimes = {}, dockerVersion } = {}) {
  const existing = new Set([...Object.keys(files), ...present, ...Object.keys(mtimes)]);
  return {
    aptPresent: () => apt,
    exists: (p) => existing.has(p),
    readFile: (p) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return files[p];
    },
    stat: (p) => {
      if (!(p in mtimes)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return mtimes[p];
    },
    dockerVersion: dockerVersion || (() => "27.3.1\n"),
  };
}

async function systemUpdates(root, opts = {}) {
  _setSystemUpdateReaders(root);
  invalidateHealthCache();
  const r = await collectHealthSignals(makeDb(), { now: () => opts.now ?? NOW, lang: opts.lang ?? "en" });
  return {
    result: r,
    detail: r.details.find((d) => d.id === "systemUpdates"),
    issue: r.issues.find((i) => i.id === "systemUpdates"),
  };
}

test("a reboot is owed → warn, listing at most ten package names", async () => {
  const packages = Array.from({ length: 12 }, (_, i) => `pkg-${i + 1}`).join("\n") + "\n";
  const { detail, issue } = await systemUpdates(fakeRoot({
    files: { [AUTO_CONF]: autoConf(), [REBOOT_PKGS_PATH]: packages },
    present: [REBOOT_REQUIRED_PATH],
    mtimes: { [UNATTENDED_STAMP_PATH]: NOW - DAY },
  }));

  assert.equal(detail.state, "warn");
  assert.equal(issue.severity, "warn");
  assert.match(issue.label, /a reboot is needed to finish updates/);
  assert.match(issue.label, /pkg-1\b/);
  assert.match(issue.label, /pkg-10\b/);
  assert.doesNotMatch(issue.label, /pkg-11/, "the package list is capped at ten");
});

test("a reboot is owed with no packages file → the plain sentence", async () => {
  const { detail, issue } = await systemUpdates(fakeRoot({
    files: { [AUTO_CONF]: autoConf() },
    present: [REBOOT_REQUIRED_PATH],
    mtimes: { [UNATTENDED_STAMP_PATH]: NOW - DAY },
  }));
  assert.equal(detail.state, "warn");
  assert.equal(issue.label, "a reboot is needed to finish updates");
});

test("no 20auto-upgrades at all → info: automatic security updates are off, with the guide link", async () => {
  const { detail, issue } = await systemUpdates(fakeRoot());
  assert.equal(issue.severity, "info");
  assert.equal(detail.state, "info", "off is never a warn and never ok");
  assert.match(detail.value, /automatic security updates are off/);
  assert.equal(issue.actionHref, systemUpdatesDocsHref("en"));
  assert.equal(issue.actionHref, docsUrl("guide/auto-update") + "#system-updates");
});

test('20auto-upgrades with Unattended-Upgrade "0" → info, same link', async () => {
  const { detail, issue } = await systemUpdates(fakeRoot({ files: { [AUTO_CONF]: autoConf("0") } }));
  assert.equal(detail.state, "info");
  assert.match(detail.value, /automatic security updates are off/);
  assert.match(issue.label, /Automatic security updates are off/);
  assert.equal(issue.actionHref, systemUpdatesDocsHref("en"));
  assert.equal(issue.actionLabel, translations["signals.systemUpdates.action"].en);
});

test("the Spanish card links to the Spanish guide section", async () => {
  const { detail, issue } = await systemUpdates(fakeRoot(), { lang: "es" });
  assert.equal(detail.label, "Actualizaciones del sistema");
  assert.equal(issue.actionHref, docsUrl("es/guide/auto-update") + "#system-updates");
  assert.equal(systemUpdatesDocsHref("es"), issue.actionHref);
});

test("a run older than the threshold → warn: security updates last ran N days ago", async () => {
  const days = UPDATES_STALE_DAYS + 2;
  const { detail, issue } = await systemUpdates(fakeRoot({
    files: { [AUTO_CONF]: autoConf() },
    mtimes: { [UNATTENDED_STAMP_PATH]: NOW - days * DAY },
  }));
  assert.equal(detail.state, "warn");
  assert.equal(issue.severity, "warn");
  assert.match(detail.value, new RegExp(`last ran ${days} days ago`));
  assert.match(issue.label, new RegExp(`have not run for ${days} days`));
});

test("a fresh run → ok, with the installed versions as information", async () => {
  const { detail, issue } = await systemUpdates(fakeRoot({
    files: { [AUTO_CONF]: autoConf() },
    mtimes: { [UNATTENDED_STAMP_PATH]: NOW - DAY },
  }));
  assert.equal(detail.state, "ok");
  assert.equal(issue, undefined, "an ok card is not an issue");
  assert.match(detail.value, /security updates are current/);
  assert.match(detail.value, new RegExp(`versions: Node ${NODE.replace(/\./g, "\\.")}, Docker 27\\.3\\.1`));
});

test("the log's mtime is the fallback when the stamp is missing", async () => {
  const { detail } = await systemUpdates(fakeRoot({
    files: { [AUTO_CONF]: autoConf() },
    mtimes: { [UNATTENDED_LOG_PATH]: NOW - DAY },
  }));
  assert.equal(detail.state, "ok");
});

test("no record of a run at all → info naming the check, never ok", async () => {
  const { detail, issue } = await systemUpdates(fakeRoot({ files: { [AUTO_CONF]: autoConf() } }));
  assert.equal(detail.state, "info");
  assert.match(detail.value, /couldn't check: when updates last ran/);
  assert.match(issue.label, /couldn't run these update checks/);
});

test("a host with no apt (not Debian/Ubuntu) → no card", async () => {
  const { detail, issue, result } = await systemUpdates(fakeRoot({ apt: false }));
  assert.equal(detail, undefined);
  assert.equal(issue, undefined);
  assert.equal(result.details.some((d) => d.id === "systemUpdates"), false);
});

test("a container → no card (these files describe the image, not the host)", async () => {
  _setContainerReader(() => true);
  try {
    const { detail } = await systemUpdates(fakeRoot({
      files: { [AUTO_CONF]: autoConf() },
      mtimes: { [UNATTENDED_STAMP_PATH]: NOW - DAY },
    }));
    assert.equal(detail, undefined);
  } finally {
    _setContainerReader(() => false);
  }
});

test("Docker failing → info with an unknown version, never a warn", async () => {
  const { detail, issue } = await systemUpdates(fakeRoot({
    files: { [AUTO_CONF]: autoConf() },
    mtimes: { [UNATTENDED_STAMP_PATH]: NOW - DAY },
    dockerVersion: () => { throw new Error("docker daemon not running"); },
  }));
  assert.equal(detail.state, "info");
  assert.match(detail.value, /Docker version unknown/);
  assert.match(detail.value, /couldn't check: the Docker version/);
  assert.equal(issue.severity, "info");
});

test("an unreadable 20auto-upgrades → info naming the check, never ok", async () => {
  const root = fakeRoot({ files: { [AUTO_CONF]: autoConf() } });
  root.readFile = (p) => {
    if (p === AUTO_CONF) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return autoConf();
  };
  const { detail, issue } = await systemUpdates(root);
  assert.notEqual(detail.state, "ok");
  assert.equal(detail.state, "info");
  assert.match(detail.value, /whether automatic updates are on/);
  assert.equal(issue.severity, "info");
});

test("an unreadable reboot marker → info, not a warn and not an ok", async () => {
  const root = fakeRoot({
    files: { [AUTO_CONF]: autoConf() },
    mtimes: { [UNATTENDED_STAMP_PATH]: NOW - DAY },
  });
  const exists = root.exists;
  root.exists = (p) => {
    if (p === REBOOT_REQUIRED_PATH) throw new Error("EACCES");
    return exists(p);
  };
  const { detail } = await systemUpdates(root);
  assert.equal(detail.state, "info");
  assert.match(detail.value, /whether a reboot is needed/);
});

// ─── i18n + docs ─────────────────────────────────────────────────────────────

test("every signals.systemUpdates key exists in en and es with matching placeholders", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("signals.systemUpdates."));
  assert.ok(keys.length >= 15, `expected the systemUpdates key family, got ${keys.length}`);
  const placeholders = (s) => (s.match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(",");
  for (const k of keys) {
    for (const lang of ["en", "es"]) {
      assert.equal(typeof translations[k][lang], "string", `${k} missing ${lang}`);
      assert.ok(translations[k][lang].length > 0, `${k} has an empty ${lang}`);
    }
    assert.notEqual(translations[k].es, translations[k].en, `${k} is untranslated (es === en)`);
    assert.equal(placeholders(translations[k].en), placeholders(translations[k].es), `${k} placeholder mismatch`);
  }
  assert.equal(
    fill(translations["signals.systemUpdates.staleRun"].en, { days: 4 }),
    "security updates last ran 4 days ago",
  );
});

test("the guide documents the system updates section in both languages", () => {
  const doc = (p) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
  const en = doc("docs/guide/auto-update.md");
  const es = doc("docs/es/guide/auto-update.md");
  for (const text of [en, es]) {
    assert.match(text, /^## .*\{#system-updates\}$/m, "the anchor the Nest links to must exist");
    assert.ok(text.includes("52crow-unattended-upgrades"), "the file the installer writes is named");
    assert.ok(text.includes("20auto-upgrades"), "the periodic switch is named");
    assert.ok(text.includes("origin=. nodistro,codename=nodistro"), "NodeSource origin");
    assert.ok(text.includes("origin=Docker,archive=${distro_codename}"), "Docker origin");
    assert.ok(text.includes("origin=cloudsmith/caddy/stable,codename=any-version"), "Caddy origin");
    assert.ok(text.includes("--no-auto-updates"), "the installer opt-out is documented");
    assert.ok(text.includes("dpkg-reconfigure unattended-upgrades"), "the distro switch is documented");
    assert.ok(text.includes('APT::Periodic::Unattended-Upgrade "0"'), "the manual switch-off is documented");
    assert.match(text, /Automatic-Reboot/i, "reboots are stated to be manual");
    assert.ok(text.includes("sudo reboot"), "the operator is told how to reboot when it is needed");
  }
  assert.match(en, /restart their own service/, "a Docker/Node update may bounce a service briefly");
  assert.match(es, /reinician su propio servicio/, "the same in Spanish");
});