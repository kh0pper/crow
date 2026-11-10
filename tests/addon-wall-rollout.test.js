/**
 * The one-time rollout notice (R8), and the manifests that make a walled add-on
 * reach the right things (R9).
 *
 * A host whose operator has not switched walls on sees nothing new: no bell, no
 * write. On a walled host the first boot's walled note IS the rollout notice; on
 * a host whose kill switch is set the rollout notice is worded for that and takes
 * that boot's one bell. Whichever it was, the marker is `noticeV1` in
 * addon-walls.json, and a send that throws leaves it unset so the next boot tries
 * again.
 *
 * Everything is a scratch dir under os.tmpdir(); no add-on is started and no
 * network is used. The knowledge-base cases drive lan-discovery's own factory
 * seam, so a failing mDNS package is exercised without the package.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

import { ADDON_WALLS_CODE_DEFAULT } from "../scripts/addon-sandbox/host-switch.mjs";
import { addonWallMode } from "../scripts/addon-sandbox/spawn.mjs";
import { ADDONS_HREF, runAddonWallNotices } from "../scripts/addon-sandbox/notice.mjs";
import { NOTICE, WALL_WORDS, labelPhrase, sandboxLine } from "../scripts/addon-sandbox/words.mjs";
import { addonWallsPath, readAddonWalls, setAddonWallsFlag } from "../servers/shared/addon-walls-file.js";
import { composePortsFrom, deriveProfile } from "../scripts/addon-sandbox/profile.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// ─── fixtures ──────────────────────────────────────────────────────────────

/** Walls off on this computer (the release default): no switch is set. */
const OFF = Object.freeze({});
/** The operator's per-host switch, turned off explicitly. */
const OFF_EXPLICIT = Object.freeze({ CROW_ADDON_WALLS_DEFAULT: "off" });
/** Walls on for this computer. */
const WALLED = Object.freeze({ CROW_ADDON_WALLS_DEFAULT: "walled" });
/** The operator's kill switch (here with the per-host default also set). */
const KILLED = Object.freeze({ CROW_ADDON_WALLS: "off", CROW_ADDON_WALLS_DEFAULT: "walled" });

const walledWall = (over = {}) => ({ mode: "walled", tier: "walled", reason: null, source: "walled", profile: null, residuals: [], ...over });
const killSwitchWall = (over = {}) => ({ mode: "unwalled", reason: "walls switched off by the operator (CROW_ADDON_WALLS=off)", source: "kill-switch", profile: null, residuals: [], ...over });
const defaultOffWall = () => ({ mode: "unwalled", reason: "walls are off on this computer", source: "default", profile: null, residuals: [] });

const entry = (id, wall, extra = {}) => ({ id, kind: "addon", name: id, status: "connected", wall, ...extra });
const profileWith = (...parts) => ({ id: "x", labelParts: parts });

const homes = [];
function scratchHome() {
  const dir = mkdtempSync(join(tmpdir(), "crow-wall-rollout-"));
  homes.push(dir);
  return dir;
}
after(() => { for (const dir of homes) rmScratch(dir); });

/** A db stub whose settings table holds nothing (the notice falls back to English). */
const emptyDb = () => ({ execute: async () => ({ rows: [] }) });

function collector() {
  const calls = [];
  const createNotification = async (_db, opts) => { calls.push(opts); return { id: calls.length }; };
  return { calls, createNotification };
}

const boot = (crowHome, env, entries, createNotification, extra = {}) =>
  runAddonWallNotices({ db: emptyDb(), crowHome, env, entries, createNotification, lang: "en", ...extra });

// ─── the rollout notice on a walled host ──────────────────────────────────

test("a walled host's first boot sends the rollout notice once, listing every add-on and its line", async () => {
  const crowHome = scratchHome();
  const { calls, createNotification } = collector();
  const entries = [
    entry("notes", walledWall({ profile: profileWith({ kind: "internet" }, { kind: "own-folder" }) })),
    entry("studio", walledWall({ profile: profileWith({ kind: "internet" }, { kind: "local-host", label: "Studio", host: "127.0.0.1", port: 8080 }) })),
    entry("paperless", walledWall({ profile: profileWith({ kind: "own-folder" }, { kind: "crow-db" }) })),
  ];

  await boot(crowHome, WALLED, entries, createNotification);

  assert.equal(calls.length, 1, "one bell, not one per add-on");
  assert.equal(calls[0].title, NOTICE.walledTitle.en);
  assert.equal(calls[0].source, "addon-walls");
  assert.equal(calls[0].action_url, ADDONS_HREF);
  assert.match(calls[0].body, /^notes: This add-on can: use the internet; keep files in its own folder$/m);
  assert.match(calls[0].body, /^studio: This add-on can: use the internet; reach Studio on this computer$/m);
  assert.match(calls[0].body, /^paperless: This add-on can: keep files in its own folder; read Crow's stored keys and change its database$/m);

  const doc = readAddonWalls(crowHome);
  assert.equal(doc.walledNoticeV1, true, "the walled marker lives in the walls file");
  assert.equal(doc.noticeV1, true, "and the rollout marker with it");

  await boot(crowHome, WALLED, entries, createNotification);
  assert.equal(calls.length, 1, "never a second time");
});

// ─── walls off for this host: nothing at all ──────────────────────────────

test("default off: no notice, no file written, and every add-on reads unwalled from the default", async () => {
  assert.equal(ADDON_WALLS_CODE_DEFAULT, "off", "the code default stays off in this release");
  const ids = ["notes", "studio", "paperless"];

  for (const env of [OFF, OFF_EXPLICIT]) {
    const crowHome = scratchHome();
    const { calls, createNotification } = collector();
    const entries = ids.map((id) => entry(id, defaultOffWall()));

    await boot(crowHome, env, entries, createNotification);
    await boot(crowHome, env, entries, createNotification);

    assert.deepEqual(calls, [], `${JSON.stringify(env)}: an unswitched host sees no bell`);
    assert.equal(existsSync(addonWallsPath(crowHome)), false, `${JSON.stringify(env)}: and nothing is written`);
    for (const id of ids) {
      const decision = addonWallMode({ id, gatewayEnv: env, crowHome });
      assert.equal(decision.mode, "unwalled", `${JSON.stringify(env)}: ${id} is not walled`);
      assert.equal(decision.source, "default", `${JSON.stringify(env)}: ${id} by this host's default`);
    }
  }
});

// ─── the kill switch: one notice, worded for it ───────────────────────────

test("the kill switch's first boot sends ONE notice worded for it, then the boot notice on later boots", async () => {
  const crowHome = scratchHome();
  const { calls, createNotification } = collector();
  const entries = [
    entry("notes", killSwitchWall({ profile: profileWith({ kind: "internet" }, { kind: "own-folder" }) })),
    entry("studio", killSwitchWall({ profile: profileWith({ kind: "internet" }) })),
  ];

  await boot(crowHome, KILLED, entries, createNotification);

  assert.equal(calls.length, 1, "one bell, not two");
  assert.equal(calls[0].title, NOTICE.rolloutOffTitle.en);
  assert.equal(calls[0].source, "addon-walls");
  assert.equal(calls[0].action_url, ADDONS_HREF);
  assert.match(calls[0].body, /^notes: When walled, this add-on can: use the internet; keep files in its own folder$/m);
  assert.match(calls[0].body, /^studio: When walled, this add-on can: use the internet$/m);
  assert.match(calls[0].body, /^Kill switch \(CROW_ADDON_WALLS=off\): on$/m);
  assert.equal(readAddonWalls(crowHome).noticeV1, true, "the rollout marker is set after the note went out");
  assert.notEqual(readAddonWalls(crowHome).walledNoticeV1, true, "the walled note has not been had here");

  await boot(crowHome, KILLED, entries, createNotification);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].title, NOTICE.bootTitle.en, "later kill-switch boots send the boot notice as before");
  assert.match(calls[1].body, /^notes: not walled \(switched off by the operator\)$/m);
});

test("kill switch first, then two walled boots: the walled notice lands on the first walled boot only", async () => {
  const crowHome = scratchHome();
  const { calls, createNotification } = collector();
  const walled = [entry("notes", walledWall({ profile: profileWith({ kind: "internet" }) }))];
  const killed = [entry("notes", killSwitchWall({ profile: profileWith({ kind: "internet" }) }))];

  await boot(crowHome, KILLED, killed, createNotification);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, NOTICE.rolloutOffTitle.en);

  await boot(crowHome, WALLED, walled, createNotification);
  assert.equal(calls.length, 2, "the host's first walled boot is still its own news");
  assert.equal(calls[1].title, NOTICE.walledTitle.en);
  assert.equal(readAddonWalls(crowHome).walledNoticeV1, true);
  assert.equal(readAddonWalls(crowHome).noticeV1, true, "still set");

  await boot(crowHome, WALLED, walled, createNotification);
  assert.equal(calls.length, 2, "and not again");
  assert.equal(readAddonWalls(crowHome).noticeV1, true);
});

test("a host that already had the walled notice gets no second rollout notice", async () => {
  const crowHome = scratchHome();
  setAddonWallsFlag(crowHome, "walledNoticeV1", true);
  assert.equal(readAddonWalls(crowHome).noticeV1, undefined, "no rollout marker yet");
  const { calls, createNotification } = collector();

  await boot(crowHome, WALLED, [entry("notes", walledWall())], createNotification);

  assert.deepEqual(calls, [], "the rollout notice was had on the earlier build");
  assert.equal(readAddonWalls(crowHome).noticeV1, true, "the marker is set quietly");
  assert.equal(readAddonWalls(crowHome).walledNoticeV1, true, "and the old marker is kept");
});

test("a notification layer that throws leaves both flags unset", async () => {
  const crowHome = scratchHome();
  const res = await boot(crowHome, WALLED, [entry("notes", walledWall())], async () => { throw new Error("the bell is on fire"); });

  assert.deepEqual(res, { boot: false, walled: false });
  assert.equal(existsSync(addonWallsPath(crowHome)), false, "nothing is marked as sent, so the next boot retries");
});

test("setAddonWallsFlag takes noticeV1 and still refuses any other new key", () => {
  const crowHome = scratchHome();
  assert.equal(setAddonWallsFlag(crowHome, "noticeV1", true), true);
  assert.equal(readAddonWalls(crowHome).noticeV1, true);

  for (const key of ["noticeV2", "rolloutNotice", "walledNotice", "modes"]) {
    assert.equal(setAddonWallsFlag(crowHome, key, true), false, `${key} is not a flag this file may carry`);
  }
  assert.deepEqual(Object.keys(readAddonWalls(crowHome)), ["noticeV1"], "and nothing else was written");
  assert.equal(setAddonWallsFlag(crowHome, "walledNoticeV1", true), true, "the walled marker still works");
});

// ─── the manifests' sandbox blocks ────────────────────────────────────────

/** The repo copy of one bundle's manifest, through the profile the wall reads. */
function repoProfile(id, addonEntry = {}) {
  const manifest = JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));
  const rel = typeof manifest?.docker?.composefile === "string" && manifest.docker.composefile
    ? manifest.docker.composefile
    : "docker-compose.yml";
  let composeText = "";
  try { composeText = readFileSync(join(REPO, "bundles", id, rel), "utf8"); } catch { composeText = ""; }
  return deriveProfile(manifest, addonEntry, { composePorts: composePortsFrom(composeText, manifest), source: "repo" });
}

test("workspace's new defaults are its own published service on both ports", () => {
  const profile = repoProfile("workspace");
  const byField = new Map(profile.network.hosts.map((h) => [h.from, h]));
  for (const [field, port] of [["WORKSPACE_NC_INTERNAL_URL", 3070], ["WORKSPACE_OO_INTERNAL_URL", 3071]]) {
    const host = byField.get(field);
    assert.ok(host, `${field} is a host of the walled profile`);
    assert.equal(host.host, "127.0.0.1");
    assert.equal(host.port, port);
    assert.equal(host.source, "default-own-service", `${field} names this add-on's own compose publish`);
  }
});

test("browser's profile: its own env file, its door, no internet, and the CDP address is the owner's alone", () => {
  const unset = repoProfile("browser");
  assert.equal(unset.ownEnvFile, true);
  assert.deepEqual(unset.doors, ["browser"]);
  assert.equal(unset.network.internet, false, "the manifest does not claim the internet");
  assert.deepEqual(unset.refused, [{ what: "host:CROW_BROWSER_CDP_URL", reason: "the field CROW_BROWSER_CDP_URL is not set" }]);
  assert.deepEqual(unset.network.hosts, [], "nothing is bound until the owner names an address");

  const owned = repoProfile("browser", { env: { CROW_BROWSER_CDP_URL: "http://127.0.0.1:9333" }, ownerSet: ["CROW_BROWSER_CDP_URL"] });
  assert.deepEqual(owned.network.hosts, [
    { host: "127.0.0.1", port: 9333, scheme: "http", from: "CROW_BROWSER_CDP_URL", source: "owner" },
  ]);
  assert.deepEqual(owned.refused, [], "the owner's address is not a refusal");
});

test("media and knowledge-base may use the internet and reach nothing else", () => {
  for (const id of ["media", "knowledge-base"]) {
    const profile = repoProfile(id);
    assert.equal(profile.network.internet, true, id);
    assert.deepEqual(profile.network.hosts, [], id);
  }
});

test("frigate binds a path only when the owner chose it", () => {
  const defaults = repoProfile("frigate");
  assert.deepEqual(defaults.files.write, [], "a default path is not a choice, so nothing is bound");
  assert.ok(defaults.refused.some((r) => r.what === "file:FRIGATE_CONFIG_PATH"), "and the default is named as refused");

  const owned = repoProfile("frigate", { env: { FRIGATE_CONFIG_PATH: "/home/alex/frigate/config" }, ownerSet: ["FRIGATE_CONFIG_PATH"] });
  assert.deepEqual(owned.files.write, [
    { from: "FRIGATE_CONFIG_PATH", path: "/home/alex/frigate/config", source: "owner" },
  ]);
});

// ─── knowledge-base's discovery with mDNS gone ────────────────────────────

test("knowledge-base starts with mDNS failing and says so", async () => {
  const lan = await import("../bundles/knowledge-base/server/lan-discovery.js");
  const refused = () => { throw new Error("no multicast inside a wall"); };

  const discovery = new lan.LanDiscovery(3001, { mdnsFactory: refused });
  assert.doesNotThrow(() => discovery.start());
  const status = lan.lanDiscoveryStatus();
  assert.equal(status.ok, false);
  assert.match(status.reason, /no multicast inside a wall/);
  assert.equal(discovery.mdnsInstance, null);

  assert.doesNotThrow(() => discovery.advertise({ slug: "guides", name: "Guides" }));
  assert.doesNotThrow(() => discovery.advertise({ slug: "housing", name: "Housing" }));
  assert.doesNotThrow(() => discovery._respondAll());
  assert.doesNotThrow(() => discovery._respondOne("guides"));
  assert.doesNotThrow(() => discovery.unadvertise("guides"));
  assert.doesNotThrow(() => discovery.stop());

  const db = { execute: async () => ({ rows: [{ slug: "guides", name: "Guides" }] }) };
  const started = await lan.startLanDiscovery(db, 3001, { mdnsFactory: refused });
  assert.ok(started, "the KB still comes up, with discovery off");
  assert.equal(lan.lanDiscoveryStatus().ok, false);
  assert.equal(lan.getLanDiscovery(), started);
  assert.doesNotThrow(() => started.advertise({ slug: "housing", name: "Housing" }));
});

// ─── the words ────────────────────────────────────────────────────────────

test("no add-on word says 'contained', and the rollout title is its own", () => {
  assert.equal(NOTICE.rolloutOffTitle.en, "Add-on walls are switched off on this computer");
  assert.match(NOTICE.rolloutOffTitle.es, /complementos/);
  assert.notEqual(NOTICE.rolloutOffTitle.es, NOTICE.rolloutOffTitle.en);

  const texts = [];
  for (const group of [WALL_WORDS, NOTICE]) {
    for (const value of Object.values(group)) texts.push(value.en, value.es);
  }
  for (const part of [
    { kind: "internet" }, { kind: "local-host", label: "X" }, { kind: "network-host", host: "h", port: 1 },
    { kind: "door", id: "d" }, { kind: "own-folder" }, { kind: "oauth-dir" }, { kind: "crow-db" },
    { kind: "pending-host" }, { kind: "storage" },
  ]) texts.push(...labelPhrase(part));
  for (const lang of ["en", "es"]) {
    for (const walled of [true, false]) {
      texts.push(sandboxLine(profileWith({ kind: "internet" }, { kind: "own-folder" }), lang, { walled }));
    }
  }
  for (const text of texts) assert.doesNotMatch(String(text), /contained|contenid/i, text);

  // The knowledge-base panel's own line, which is fixed text and not a word here.
  const panel = readFileSync(join(REPO, "bundles/knowledge-base/panel/knowledge-base.js"), "utf8");
  assert.ok(panel.includes("LAN discovery is off while this add-on is walled"), "the English line is in the panel");
  assert.ok(panel.includes("El descubrimiento en la red local está desactivado mientras este complemento está aislado"), "and its Spanish");
  assert.doesNotMatch(panel, /contained|contenid/i, "the panel never says 'contained'");
});