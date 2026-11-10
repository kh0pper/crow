/**
 * The add-on wall status line and the Nest card (PR D, review item 13).
 *
 * Both surfaces are driven through the shared module
 * (dashboard/shared/addon-wall-status.js) with its probe seam, so no bwrap runs
 * and no add-on is started. The sentences asserted here are the exact words the
 * status page shows: a summary sentence, one word per add-on, the residual line.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  addonWallStatus, addonWallWord, renderAddonWallStatus,
  _setAddonWallProbeForTest, _setAddonWallEntriesForTest,
} from "../servers/gateway/dashboard/shared/addon-wall-status.js";
import {
  collectHealthSignals, invalidateHealthCache,
  _setDiskReader, _setTailscaleReader, _setFirewallReader,
  _setContainerReader, _setDockerPortsReader, _setBundleImageReaders,
  _setSystemUpdateReaders, _setArtifactNodeReader, _setReservationReader,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import { NOTICE, RESIDUAL_LINE, SUMMARY, WALL_WORDS } from "../scripts/addon-sandbox/words.mjs";

// ─── fixtures ──────────────────────────────────────────────────────────────

/** Walls off on this computer (the release default). */
const OFF = Object.freeze({});
/** Walls on for this computer. */
const WALLED = Object.freeze({ CROW_ADDON_WALLS_DEFAULT: "walled" });
/** The operator's kill switch. */
const KILLED = Object.freeze({ CROW_ADDON_WALLS: "off", CROW_ADDON_WALLS_DEFAULT: "walled" });

/** bwrap can make the namespaces a wall needs. */
const SANDBOXED = Object.freeze({ ok: true, pidns: true, bwrap: "/usr/bin/bwrap", setpriv: null, reason: null, pidnsReason: null });
/** bubblewrap is not installed at all. */
const NO_BWRAP = Object.freeze({ ok: false, pidns: false, bwrap: null, setpriv: null, reason: "bubblewrap (bwrap) is not installed", pidnsReason: null });

const walledWall = (over = {}) => ({ mode: "walled", tier: "walled", reason: null, source: "walled", profile: null, residuals: [], ...over });
const entry = (id, wall, extra = {}) => ({ id, kind: "addon", name: id, status: "connected", wall, ...extra });

const savedEnv = {
  CROW_ADDON_WALLS: process.env.CROW_ADDON_WALLS,
  CROW_ADDON_WALLS_DEFAULT: process.env.CROW_ADDON_WALLS_DEFAULT,
};

before(() => {
  // The sibling signals shell out (docker, tailscale, apt, df). Pin them so this
  // file is fast and offline and nothing but addonWalls can decide anything.
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
  _setAddonWallProbeForTest(null);
  _setAddonWallEntriesForTest(null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

beforeEach(() => {
  delete process.env.CROW_ADDON_WALLS;
  delete process.env.CROW_ADDON_WALLS_DEFAULT;
  _setAddonWallProbeForTest(null);
  _setAddonWallEntriesForTest(null);
  invalidateHealthCache();
});

// ─── the per-add-on word ───────────────────────────────────────────────────

test("one entry, one word: the wall record and the operator's switches decide it", () => {
  assert.equal(addonWallWord(entry("a", walledWall()), { env: WALLED }), "walled");
  assert.equal(addonWallWord(entry("a", walledWall(), { kind: "backend" }), { env: WALLED }), "backend");
  assert.equal(addonWallWord(entry("a", { mode: "refused", source: "refused" }), { env: WALLED }), "failed");
  assert.equal(addonWallWord(entry("a", walledWall(), { status: "error" }), { env: WALLED }), "failed",
    "a walled add-on that is not connected did not run inside its wall");
  assert.equal(addonWallWord(entry("a", { mode: "unwalled", source: "kill-switch" }), { env: KILLED }), "killSwitch");
  assert.equal(addonWallWord(entry("a", { mode: "unwalled", source: "default" }), { env: OFF }), "hostOff");
  assert.equal(addonWallWord(entry("a", { mode: "unwalled", source: "owner" }), { env: WALLED }), "owner");
  assert.equal(addonWallWord(entry("a", { mode: "unwalled", source: "no-bwrap" }), { env: WALLED }), "noBwrap");
});

test("shares Crow's database wins over a storage residual, and both over a plain wall", () => {
  const storage = [{ kind: "storage", label: "can use all of Crow's storage" }];
  assert.equal(addonWallWord(entry("a", walledWall({ residuals: storage })), { env: WALLED }), "storage");
  assert.equal(
    addonWallWord(entry("a", walledWall({ residuals: storage, profile: { crowDb: true } })), { env: WALLED }),
    "crowDb",
  );
});

// ─── the summary sentence ──────────────────────────────────────────────────

test("no usable bubblewrap: the spec's exact words, and a warn only where walls were expected", () => {
  const off = addonWallStatus({ probe: NO_BWRAP, env: OFF, entries: [entry("a", { mode: "unwalled", source: "no-bwrap" })], lang: "en" });
  assert.equal(off.code, "no-bwrap");
  assert.equal(off.sentence, "Add-ons: not walled off on this computer; docker reachable");
  assert.equal(off.severity, "info", "walls are off here anyway: information, not a fault");

  const expected = addonWallStatus({ probe: NO_BWRAP, env: WALLED, entries: [entry("a", { mode: "unwalled", source: "no-bwrap" })], lang: "en" });
  assert.equal(expected.sentence, "Add-ons: not walled off on this computer; docker reachable");
  assert.equal(expected.severity, "warn", "this host expected walls and cannot have them");
});

test("the kill switch has its own line and is a warn", () => {
  const status = addonWallStatus({ probe: SANDBOXED, env: KILLED, entries: [entry("a", { mode: "unwalled", source: "kill-switch" })], lang: "en" });
  assert.equal(status.code, "kill-switch");
  assert.equal(status.sentence, "Add-ons: walls switched off by the operator (CROW_ADDON_WALLS=off)");
  assert.equal(status.severity, "warn");
});

test("the per-host default switched off is information only", () => {
  const status = addonWallStatus({ probe: SANDBOXED, env: OFF, entries: [entry("a", { mode: "unwalled", source: "default" })], lang: "en" });
  assert.equal(status.code, "host-off");
  assert.equal(status.sentence, "Add-ons: not walled (switched off for this computer)");
  assert.equal(status.severity, "info");
});

test("nothing running here is its own line", () => {
  const status = addonWallStatus({ probe: SANDBOXED, env: WALLED, entries: [], lang: "en" });
  assert.equal(status.code, "none");
  assert.equal(status.sentence, "Add-ons: none running here");
  assert.equal(status.severity, "ok");
});

test("a mix counts each non-walled word in a fixed order", () => {
  const entries = [
    entry("plain", walledWall()),
    entry("shared", walledWall({ profile: { crowDb: true } })),
    entry("mine", { mode: "unwalled", reason: "your choice", source: "owner" }),
    entry("broken", { mode: "refused", source: "refused" }),
  ];
  const status = addonWallStatus({ probe: SANDBOXED, env: WALLED, entries, lang: "en" });
  assert.equal(status.code, "mixed");
  assert.equal(
    status.sentence,
    "Add-ons: 1 of 4 walled off; 1 not walled: shares Crow's database; 1 not walled (your choice); 1 off: it could not run inside its wall",
  );
  assert.equal(status.severity, "warn", "a failed entry is a warn");
  assert.deepEqual(status.entries.map((e) => e.wordKey), ["walled", "crowDb", "owner", "failed"]);
});

test("a mix without a failure is information, never a warn", () => {
  const entries = [entry("plain", walledWall()), entry("mine", { mode: "unwalled", source: "owner" })];
  const status = addonWallStatus({ probe: SANDBOXED, env: WALLED, entries, lang: "en" });
  assert.equal(status.sentence, "Add-ons: 1 of 2 walled off; 1 not walled (your choice)");
  assert.equal(status.severity, "info");
});

test("a storage residual means the add-on is not walled off, whatever else is true", () => {
  const status = addonWallStatus({
    probe: SANDBOXED,
    env: WALLED,
    entries: [entry("storage-user", walledWall({ residuals: [{ kind: "storage", label: "can use all of Crow's storage" }] }))],
    lang: "en",
  });
  assert.equal(status.entries[0].word, "not walled: can use all of Crow's storage");
  assert.equal(status.severity, "info", "a known residual is not a failure");
  assert.equal(status.code, "mixed");
});

test("everything walled reads 'Add-ons: walled off' and is ok", () => {
  const status = addonWallStatus({ probe: SANDBOXED, env: WALLED, entries: [entry("a", walledWall()), entry("b", walledWall())], lang: "en" });
  assert.equal(status.code, "walled");
  assert.equal(status.sentence, "Add-ons: walled off");
  assert.equal(status.severity, "ok");
});

test("the residual line is the shared one, in the asked-for language", () => {
  assert.equal(addonWallStatus({ probe: SANDBOXED, env: WALLED, entries: [], lang: "en" }).residualLine, RESIDUAL_LINE.en);
  assert.equal(addonWallStatus({ probe: SANDBOXED, env: WALLED, entries: [], lang: "es" }).residualLine, RESIDUAL_LINE.es);
  assert.equal(addonWallStatus({ probe: SANDBOXED, env: KILLED, entries: [], lang: "es" }).sentence, SUMMARY.killSwitch.es);
});

test("an unknown language falls back to English", () => {
  const status = addonWallStatus({ probe: SANDBOXED, env: WALLED, entries: [entry("a", { mode: "unwalled", source: "owner" })], lang: "fr" });
  assert.equal(status.sentence, "Add-ons: 0 of 1 walled off; 1 not walled (your choice)");
  assert.equal(status.entries[0].word, WALL_WORDS.owner.en);
});

// ─── the Nest card ─────────────────────────────────────────────────────────

const emptyDb = () => ({ execute: async () => ({ rows: [] }) });

async function card({ env, entries, probe = SANDBOXED } = {}) {
  for (const [k, v] of Object.entries(env || {})) process.env[k] = v;
  _setAddonWallProbeForTest(() => probe);
  _setAddonWallEntriesForTest(() => entries || []);
  invalidateHealthCache();
  const res = await collectHealthSignals(emptyDb(), { lang: "en" });
  return {
    detail: res.details.find((d) => d.id === "addonWalls") || null,
    issue: res.issues.find((i) => i.id === "addonWalls") || null,
    res,
  };
}

test("no card when nothing runs here and the kill switch is not set", async () => {
  const off = await card({ env: OFF, entries: [] });
  assert.equal(off.detail, null);
  const hostWalled = await card({ env: WALLED, entries: [] });
  assert.equal(hostWalled.detail, null, "a host with no add-ons has nothing to say");
});

test("the kill switch is a WARN card that links to the Extensions page", async () => {
  const { detail, issue } = await card({ env: KILLED, entries: [entry("a", { mode: "unwalled", source: "kill-switch" })] });
  assert.ok(detail);
  assert.equal(detail.state, "warn");
  assert.equal(detail.label, NOTICE.label.en);
  assert.equal(detail.value, SUMMARY.killSwitch.en);
  assert.ok(issue, "a warn is pushed");
  assert.equal(issue.severity, "warn");
  assert.equal(issue.actionHref, "/dashboard/extensions");
});

test("everything walled is an ok card and never an issue", async () => {
  const { detail, issue } = await card({ env: WALLED, entries: [entry("a", walledWall())] });
  assert.ok(detail);
  assert.equal(detail.state, "ok");
  assert.equal(detail.value, SUMMARY.allWalled.en);
  assert.equal(issue, null);
});

test("a host whose default is off is info and stays strip-only", async () => {
  const { detail, issue } = await card({ env: OFF, entries: [entry("a", { mode: "unwalled", source: "default" })] });
  assert.ok(detail);
  assert.equal(detail.state, "info");
  assert.equal(issue.severity, "info", "the health monitor pushes warn only");
});

test("a failed add-on is a warn card", async () => {
  const { detail, issue } = await card({ env: WALLED, entries: [entry("a", { mode: "refused", source: "refused" })] });
  assert.equal(detail.state, "warn");
  assert.equal(issue.severity, "warn");
  assert.match(issue.label, /0 of 1 walled off; 1 off: it could not run inside its wall/);
});

test("the card's words are escaped and translated on request", async () => {
  _setAddonWallProbeForTest(() => SANDBOXED);
  _setAddonWallEntriesForTest(() => [entry("a", { mode: "unwalled", source: "kill-switch" })]);
  process.env.CROW_ADDON_WALLS = "off";
  invalidateHealthCache();
  const res = await collectHealthSignals(emptyDb(), { lang: "es" });
  const detail = res.details.find((d) => d.id === "addonWalls");
  assert.equal(detail.label, NOTICE.label.es);
  assert.equal(detail.value, SUMMARY.killSwitch.es);
});