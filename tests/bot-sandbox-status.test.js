/**
 * Audit N1b-2 — "Crow says plainly when bots don't get the bubblewrap sandbox".
 *
 * Before this, the only signal for a host where bubblewrap was missing or
 * blocked (Ubuntu 24.04's AppArmor user-namespace restriction) was one
 * console.error in scripts/pi-bots/pi_sandbox.mjs, and pi children then ran
 * unsandboxed. The Bot Runtime settings page and the Crow's Nest health card
 * must now say the same thing, in plain words, with the reason and ONE next
 * step — and must never claim more than the probe saw.
 *
 * Both surfaces are driven through the shared probe seam
 * (shared/bot-sandbox-status.js) / the section's own seam, so no bwrap, no pi
 * and no bot is spawned here, and the file passes on a host with or without
 * bubblewrap.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import section, { _setHostBwrapProbeForTest } from "../servers/gateway/dashboard/settings/sections/bot-runtime.js";
import {
  botSandboxStatus, _setBotSandboxProbeForTest,
  _setUsernsRestrictionPathForTest, _setApparmorDirForTest,
} from "../servers/gateway/dashboard/shared/bot-sandbox-status.js";
import {
  collectHealthSignals, invalidateHealthCache,
  _setDiskReader, _setTailscaleReader, _setFirewallReader,
  _setContainerReader, _setDockerPortsReader, _setBundleImageReaders,
  _setSystemUpdateReaders, _setArtifactNodeReader, _setReservationReader,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import { piSandboxReasonCode, piSandboxMode } from "../scripts/pi-bots/pi_sandbox.mjs";
import { t, fill } from "../servers/gateway/dashboard/shared/i18n.js";

// ─── Probe fixtures: exactly what probePiSandbox() records in each case ──────

const SANDBOXED = Object.freeze({ ok: true, pidns: true, bwrap: "/usr/bin/bwrap", setpriv: null, reason: null, pidnsReason: null });
const NO_BWRAP_NO_SETPRIV = Object.freeze({ ok: false, pidns: false, bwrap: null, setpriv: null, reason: "bubblewrap (bwrap) is not installed", pidnsReason: null });
const NO_BWRAP_SETPRIV = Object.freeze({ ...NO_BWRAP_NO_SETPRIV, setpriv: "/usr/bin/setpriv" });
const USERNS_BLOCKED = Object.freeze({
  ok: false, pidns: false, bwrap: "/usr/bin/bwrap", setpriv: "/usr/bin/setpriv",
  reason: "bwrap cannot create a user namespace here (--unshare-user): bwrap: setting up uid map: Permission denied",
  pidnsReason: "bwrap cannot create a PID namespace with a fresh /proc here (--unshare-pid / --proc): bwrap: No permissions to create new namespace",
});

const savedEnv = {
  CROW_PI_SANDBOX: process.env.CROW_PI_SANDBOX,
  PIBOT_SUPERVISOR: process.env.PIBOT_SUPERVISOR,
  CROW_PUBLISH_SNAPSHOT: process.env.CROW_PUBLISH_SNAPSHOT,
  CROW_BACKUP_DIR: process.env.CROW_BACKUP_DIR,
};

// The AppArmor facts the status reads are seams too: the suite must never depend
// on the machine's real /proc switch or /etc/apparmor.d. Default = the Ubuntu
// case (switch reads 1, no profile installed); each test overrides what it needs.
let scratchDir = null;
let usernsOnPath = null;
let usernsOffPath = null;
let emptyApparmorDir = null;

function apparmorDirWithProfile() {
  const dir = join(scratchDir, "apparmor.d-with-profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bwrap-userns-restrict"),
    "abi <abi/4.0>,\nprofile bwrap /usr/bin/bwrap flags=(attach_disconnected) {\n  allow userns,\n}\n");
  return dir;
}

function apparmorDirWithCommentOnly() {
  const dir = join(scratchDir, "apparmor.d-comments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes"), "# profile bwrap /usr/bin/bwrap {\n");
  return dir;
}

before(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "crow-sandbox-status-"));
  usernsOnPath = join(scratchDir, "apparmor_restrict_unprivileged_userns.on");
  usernsOffPath = join(scratchDir, "apparmor_restrict_unprivileged_userns.off");
  writeFileSync(usernsOnPath, "1\n");
  writeFileSync(usernsOffPath, "0\n");
  emptyApparmorDir = join(scratchDir, "apparmor.d-empty");
  mkdirSync(emptyApparmorDir);

  // Sibling signals in collectHealthSignals() shell out (docker, tailscale, apt,
  // df). Pin them so no card except botSandbox can decide anything here, and so
  // the test is fast and offline.
  process.env.CROW_PUBLISH_SNAPSHOT = "/tmp/__crow_test_no_publish_snapshot__.json";
  process.env.CROW_BACKUP_DIR = "/tmp/__crow_test_no_backup_dir__";
  _setDiskReader(() => "Filesystem 1M-blocks Used Available Use% Mounted on\n/dev/x 100000 1000 99000 1% /\n");
  _setTailscaleReader(() => { throw new Error("no tailscale"); });
  _setFirewallReader(() => { throw new Error("ENOENT"); });
  _setContainerReader(() => false);
  _setDockerPortsReader(() => { throw new Error("no docker"); });
  _setBundleImageReaders({ containers: () => { throw new Error("no docker"); }, created: () => { throw new Error("no docker"); }, installed: () => [] });
  _setSystemUpdateReaders({ aptPresent: () => false });
  _setArtifactNodeReader(async () => null);
  _setReservationReader(() => null);
});

after(() => {
  _setBotSandboxProbeForTest(null);
  _setHostBwrapProbeForTest(null);
  _setUsernsRestrictionPathForTest(null);
  _setApparmorDirForTest(null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.CROW_PI_SANDBOX;
  delete process.env.PIBOT_SUPERVISOR;
  _setHostBwrapProbeForTest(null);
  _setBotSandboxProbeForTest(null);
  _setUsernsRestrictionPathForTest(usernsOnPath);
  _setApparmorDirForTest(emptyApparmorDir);
  invalidateHealthCache();
});

// ─── The classifier (scripts/pi-bots/pi_sandbox.mjs) ────────────────────────

test("piSandboxReasonCode: the probe's two failure reasons map to the two next steps, plus the opt-out", () => {
  assert.equal(piSandboxReasonCode(SANDBOXED, "auto"), null, "sandboxed hosts have no reason to show");
  assert.equal(piSandboxReasonCode(NO_BWRAP_NO_SETPRIV, "auto"), "no-bwrap");
  assert.equal(piSandboxReasonCode(NO_BWRAP_SETPRIV, "auto"), "no-bwrap");
  assert.equal(piSandboxReasonCode(USERNS_BLOCKED, "auto"), "userns-blocked");
  assert.equal(piSandboxReasonCode(SANDBOXED, "off"), "disabled", "CROW_PI_SANDBOX=off is a setting, not a fault");
  // The mode default is the spawner's own reader, not a second copy of the rule.
  assert.equal(piSandboxMode({ CROW_PI_SANDBOX: "off" }), "off");
});

// ─── Bot Runtime settings: the status line ─────────────────────────────────

/** The section's db stub: one enabled pi bot, no feature flags. */
function dbWithBots(rows = [{ bot_id: "helper", display_name: "Helper", enabled: 1, definition: JSON.stringify({ engine: "pi" }) }]) {
  return {
    async execute(q) {
      const sql = typeof q === "string" ? q : (q && q.sql) || "";
      return { rows: /pi_bot_defs/.test(sql) ? rows : [] };
    },
  };
}

const renderSettings = (probe, lang = "en") => {
  _setHostBwrapProbeForTest(() => probe);
  return section.render({ db: dbWithBots(), lang });
};

test("settings: a sandboxed host says so, and offers no next step", async () => {
  const html = await renderSettings(SANDBOXED);
  assert.ok(html.includes(t("settings.sandboxStatus.sandboxed", "en")));
  assert.ok(!html.includes("WITHOUT the bubblewrap sandbox"));
  assert.ok(!html.includes(t("settings.sandboxStatus.nextNoBwrap", "en")));
  assert.match(html, /id="crow-sandbox-status"/);
});

test("settings: no bwrap WITH setpriv — reason, the exact exposure, and the install next step", async () => {
  const html = await renderSettings(NO_BWRAP_SETPRIV);
  const sentence = fill(t("settings.sandboxStatus.unsandboxed", "en"), {
    reason: t("settings.sandboxStatus.reasonNoBwrap", "en"),
    exposure: t("settings.sandboxStatus.exposureSetpriv", "en"),
  });
  assert.equal(sentence,
    "Bots run WITHOUT the bubblewrap sandbox: bubblewrap isn't installed. " +
    "They can use this machine's docker (if present), but not sudo.");
  assert.ok(html.includes(sentence), html);
  assert.ok(html.includes(t("settings.sandboxStatus.nextNoBwrap", "en")), "one plain next step");
  assert.ok(html.includes("sudo apt install bubblewrap"));
  assert.ok(!html.includes(t("settings.sandboxStatus.exposurePlain", "en")), "sudo is not claimed to work");
});

test("settings: no bwrap WITHOUT setpriv — says the bot keeps sudo", async () => {
  const html = await renderSettings(NO_BWRAP_NO_SETPRIV);
  assert.ok(html.includes(t("settings.sandboxStatus.exposurePlain", "en")));
  assert.ok(!html.includes(t("settings.sandboxStatus.exposureSetpriv", "en")));
  assert.ok(html.includes("bubblewrap isn't installed"));
});

test("settings: a blocked user namespace points at Ubuntu's own AppArmor profile, never at a sysctl", async () => {
  const html = await renderSettings(USERNS_BLOCKED);
  assert.ok(html.includes(t("settings.sandboxStatus.reasonUserns", "en")));
  assert.match(html, /re-run the Crow installer, which installs Ubuntu's own AppArmor profile for bubblewrap/);
  assert.doesNotMatch(html, /sysctl/, "the advice never suggests turning the restriction off");
});

test("settings: the status line is translated (es) and keeps the two exposure cases distinct", async () => {
  const html = await renderSettings(USERNS_BLOCKED, "es");
  assert.ok(html.includes(t("settings.sandboxStatus.reasonUserns", "es")));
  assert.ok(html.includes(t("settings.sandboxStatus.nextUserns", "es")));
  assert.notEqual(t("settings.sandboxStatus.nextUserns", "es"), t("settings.sandboxStatus.nextUserns", "en"));
});

test("botSandboxStatus: CROW_PI_SANDBOX=off is shown as a setting with its own next step", () => {
  process.env.CROW_PI_SANDBOX = "off";
  try {
    const s = botSandboxStatus({ probe: SANDBOXED, mode: "off" });
    assert.equal(s.sandboxed, false);
    assert.equal(s.code, "disabled");
    assert.ok(s.sentence.includes(t("settings.sandboxStatus.reasonDisabled", "en")));
    assert.equal(s.nextStep, t("settings.sandboxStatus.nextDisabled", "en"));
  } finally {
    delete process.env.CROW_PI_SANDBOX;
  }
});

test("botSandboxStatus: mode off reports the PLAIN exposure even when a setpriv probe is passed", () => {
  // off means pi_sandbox.mjs spawns pi unwrapped, so sudo works whatever the
  // probe found: reusing the setpriv wording here would be a false claim.
  const s = botSandboxStatus({ probe: USERNS_BLOCKED, mode: "off" });
  assert.equal(s.code, "disabled");
  assert.ok(s.setpriv, "the probe really did find setpriv");
  assert.equal(s.exposure, t("settings.sandboxStatus.exposurePlain", "en"));
  assert.ok(!s.sentence.includes(t("settings.sandboxStatus.exposureSetpriv", "en")), s.sentence);
  assert.ok(s.sentence.includes(t("settings.sandboxStatus.exposurePlain", "en")), s.sentence);
});

test("botSandboxStatus: userns blocked WITHOUT the Ubuntu switch shows the probe's own error, not Ubuntu advice", () => {
  _setUsernsRestrictionPathForTest(usernsOffPath);
  const s = botSandboxStatus({ probe: USERNS_BLOCKED });
  assert.equal(s.code, "userns-blocked");
  assert.ok(s.sentence.includes("bwrap: setting up uid map: Permission denied"),
    "the reason is what the probe actually printed: " + s.sentence);
  assert.equal(s.nextStep, t("settings.sandboxStatus.nextUsernsGeneric", "en"));
  assert.doesNotMatch(s.sentence, /Ubuntu/, "no Ubuntu advice when the AppArmor restriction is not on");
  assert.doesNotMatch(s.nextStep, /Ubuntu/);
  assert.match(s.nextStep, /a container, Debian's unprivileged_userns_clone=0, or a service restriction/);
});

test("botSandboxStatus: restriction ON with the profile installed never sends the operator back to the installer", () => {
  _setUsernsRestrictionPathForTest(usernsOnPath);
  _setApparmorDirForTest(apparmorDirWithProfile());
  const s = botSandboxStatus({ probe: USERNS_BLOCKED });
  assert.equal(s.code, "userns-blocked");
  assert.equal(s.reason, t("settings.sandboxStatus.reasonUsernsProfile", "en"));
  assert.equal(s.nextStep, t("settings.sandboxStatus.nextUsernsProfile", "en"));
  assert.doesNotMatch(s.sentence + " " + s.nextStep, /re-run the Crow installer/,
    "the profile IS installed: re-running the installer would loop");
  assert.match(s.nextStep, /profile is installed/);

  // A comment mentioning the profile path is not an installed profile.
  _setApparmorDirForTest(apparmorDirWithCommentOnly());
  const c = botSandboxStatus({ probe: USERNS_BLOCKED });
  assert.equal(c.nextStep, t("settings.sandboxStatus.nextUserns", "en"),
    "only a real profile line counts as installed");
});

test("botSandboxStatus: PIBOT_SUPERVISOR=external is unobserved, never sandboxed", () => {
  process.env.PIBOT_SUPERVISOR = "external";
  try {
    const s = botSandboxStatus({ probe: SANDBOXED });
    assert.equal(s.sandboxed, false, "this process did not start the bot, so it claims nothing");
    assert.equal(s.observed, false);
    assert.equal(s.code, "unobserved");
    assert.equal(s.sentence, t("settings.sandboxStatus.unobserved", "en"));
    assert.equal(s.nextStep, t("settings.sandboxStatus.nextUnobserved", "en"));
  } finally {
    delete process.env.PIBOT_SUPERVISOR;
  }
});

test("settings + health: an external supervisor shows the unobserved wording and an INFO card, never ok", async () => {
  process.env.PIBOT_SUPERVISOR = "external";
  try {
    const html = await renderSettings(SANDBOXED);
    assert.ok(html.includes(t("settings.sandboxStatus.unobserved", "en")), html);
    assert.ok(!html.includes(t("settings.sandboxStatus.sandboxed", "en")), "never sandboxed");

    const { detail, issue } = await card(SANDBOXED);
    assert.ok(detail, "the card is present");
    assert.equal(detail.state, "info", "info, not ok");
    assert.equal(detail.value, t("signals.botSandbox.unobserved", "en"));
    assert.ok(issue, "the strip entry exists");
    assert.equal(issue.severity, "info", "strip-only: the health monitor pushes warn only");
  } finally {
    delete process.env.PIBOT_SUPERVISOR;
  }
});

// ─── The Nest health card ──────────────────────────────────────────────────

/** A db that says the bot runtime runs here, with N enabled pi bots. */
function dbWithRuntime({ bots = 1, runtime = true } = {}) {
  return {
    async execute(q) {
      const sql = typeof q === "string" ? q : (q && q.sql) || "";
      const args = (q && q.args) || [];
      if (/pi_bot_defs/.test(sql)) return { rows: [{ c: bots }] };
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      if (/dashboard_settings/.test(sql)) {
        if (args[0] === "feature_flags") return { rows: [{ value: JSON.stringify({ bot_runtime: runtime }) }] };
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

async function card(probe, dbOpts = {}) {
  _setBotSandboxProbeForTest(() => probe);
  invalidateHealthCache();
  const res = await collectHealthSignals(dbWithRuntime(dbOpts));
  return {
    detail: res.details.find((d) => d.id === "botSandbox") || null,
    issue: res.issues.find((i) => i.id === "botSandbox") || null,
    res,
  };
}

test("health: bots run WITHOUT the sandbox → a WARN card with the reason and the next step", async () => {
  const { detail, issue } = await card(NO_BWRAP_SETPRIV);
  assert.ok(detail, "the card is present");
  assert.equal(detail.state, "warn");
  assert.equal(detail.label, t("signals.botSandbox.label", "en"));
  assert.ok(issue, "and it is an issue, so the health monitor can push it");
  assert.equal(issue.severity, "warn");
  assert.ok(issue.label.includes("Bots run WITHOUT the bubblewrap sandbox: bubblewrap isn't installed."), issue.label);
  assert.ok(issue.label.includes("but not sudo"), "the exposure matches the console line's setpriv case");
  assert.ok(issue.label.includes("Next step: " + t("settings.sandboxStatus.nextNoBwrap", "en")), issue.label);
  assert.equal(issue.actionHref, "/dashboard/settings?section=bot-runtime");
});

test("health: no setpriv either → the same card says sudo works", async () => {
  const { issue } = await card(NO_BWRAP_NO_SETPRIV);
  assert.ok(issue.label.includes(t("settings.sandboxStatus.exposurePlain", "en")), issue.label);
  assert.ok(!issue.label.includes("but not sudo"));
});

test("health: a blocked user namespace is a WARN naming the installer's AppArmor rule", async () => {
  const { detail, issue } = await card(USERNS_BLOCKED);
  assert.equal(detail.state, "warn");
  assert.ok(issue.label.includes(t("settings.sandboxStatus.reasonUserns", "en")), issue.label);
  assert.ok(issue.label.includes(t("settings.sandboxStatus.nextUserns", "en")), issue.label);
});

test("health: a sandboxed host is ok, not a warn", async () => {
  const { detail, issue } = await card(SANDBOXED);
  assert.ok(detail);
  assert.equal(detail.state, "ok");
  assert.equal(issue, null, "an ok card is never pushed");
});

test("health: no card when the bot runtime is off, or when no bot is enabled", async () => {
  const off = await card(NO_BWRAP_SETPRIV, { runtime: false });
  assert.equal(off.detail, null, "the runtime is not in use here");
  const noBots = await card(NO_BWRAP_SETPRIV, { bots: 0 });
  assert.equal(noBots.detail, null, "nothing spawns, nothing to warn about");
});

test("health: no card when the sandbox was switched off on purpose (CROW_PI_SANDBOX=off)", async () => {
  process.env.CROW_PI_SANDBOX = "off";
  try {
    const { detail } = await card(SANDBOXED);
    assert.equal(detail, null, "a setting the operator chose is not a health problem");
  } finally {
    delete process.env.CROW_PI_SANDBOX;
  }
});

test("health: Spanish renders the translated reason and next step", async () => {
  _setBotSandboxProbeForTest(() => USERNS_BLOCKED);
  invalidateHealthCache();
  const res = await collectHealthSignals(dbWithRuntime(), { lang: "es" });
  const issue = res.issues.find((i) => i.id === "botSandbox");
  assert.ok(issue, "the card exists in es");
  assert.ok(issue.label.includes(t("settings.sandboxStatus.reasonUserns", "es")), issue.label);
  assert.ok(issue.label.includes(t("settings.sandboxStatus.nextUserns", "es")), issue.label);
});