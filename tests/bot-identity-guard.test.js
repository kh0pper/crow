// "Bots can't read Crow's identity file" — the boot check (item-70 channel 3).
//
// <dataDir>/identity.json holds the master seed every instance and bot key is
// derived from, and the file the gateway really reads is the one
// servers/sharing/identity.js resolves — NOT necessarily dirname(CROW_DB). The
// check dry-builds every enabled bot's spawn plan in BOTH tiers (no bwrap run,
// no mount point made, no pi spawned) and FAILS when one of them would leave the
// file readable, or when the host's effective tier cannot hold a file mask at
// all (CROW_PI_SANDBOX=off, no bubblewrap, or bwrap without a PID namespace).
// These tests pin:
//   - the pass on a clean instance (real plan builders, scratch roots);
//   - BOTH anchors and the backup copies, masked by the default tier and dealt
//     with by the contain plan, when the anchors differ;
//   - the FAIL on each tier's regression shape (a launch that masks nothing, a
//     plan without the mask) — the seams stand in for the plan builders only;
//   - the FAIL on each host shape that cannot mask (off / no bwrap / no PID ns),
//     with the stubbed probe, never the host's;
//   - that a host with NO enabled bots is a pass with a "no bots" note and no
//     tier finding at all (nothing can spawn, so nothing must ring the bell);
//   - the exact words, the [containment] line, and the restart hint — appended
//     to a finding a bot's plan produced, never to a host-tier one;
//   - that a bot definition naming crow-sharing changes nothing at all.
//
// The probe is stubbed in every case (DRY_PROBE, or a failing shape): a unit
// test must not depend on the host's bubblewrap. The real-bwrap probes are
// tests/pi-sandbox.test.js's.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BOT_IDENTITY_TEXT, DRY_PROBE, NO_BOTS_NOTE, RESTART_HOSTS_HINT, checkBotIdentityExposure, containPlanReaches,
  containTierMasks, defaultTierMasks, findingsFromPlans, formatBotIdentityLine, readEnabledBotDefs,
  runBotIdentityCheck,
} from "../scripts/pi-bots/bot-identity-guard.mjs";
import { identityCandidates } from "../scripts/pi-bots/identity-candidates.mjs";
import { wrapPiSpawn } from "../scripts/pi-bots/pi_sandbox.mjs";
import { buildContainPlan } from "../scripts/pi-bots/pi_contain.mjs";

const T = realpathSync(mkdtempSync(join(tmpdir(), "crow-bot-identity-")));
after(() => rmSync(T, { recursive: true, force: true }));
const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };

/** A fake seed-shaped identity body: never a real key, only its shape. */
const FAKE_SEED = "a".repeat(64);
const identityBody = () => JSON.stringify({ version: 1, crowId: "crow:test", seed: FAKE_SEED });

const HOME = mk(T, "home", "alex");
const CROW_HOME = mk(HOME, ".crow");
// The SEED dir: what servers/sharing/identity.js resolves (CROW_DATA_DIR).
const DATA = mk(CROW_HOME, "data");
const IDENTITY = join(DATA, "identity.json");
writeFileSync(IDENTITY, identityBody());
writeFileSync(join(DATA, "identity.json.bak"), identityBody());
writeFileSync(join(DATA, "crow.db"), "");
writeFileSync(join(DATA, "notes.txt"), "not a secret");
// The DB anchor: a DIFFERENT directory on the same instance (the host-b layout
// instance-paths.mjs documents: CROW_DB_PATH points at a repo data dir while the
// seed lives only in the instance dir). It carries an identity of its own here,
// so the test proves BOTH anchors are masked, not just the seed's.
const DB_DATA = mk(T, "repo", "data");
const DB_IDENTITY = join(DB_DATA, "identity.json");
writeFileSync(DB_IDENTITY, identityBody());
writeFileSync(join(DB_DATA, "crow.db"), "");
// The repo's backup output dir (scripts/backup.sh writes <stem>-identity-<date>.json).
const BACKUPS = mk(HOME, "backups", "crow");
const BACKUP_COPY = join(BACKUPS, "primary-identity-2026-11-05.json");
writeFileSync(BACKUP_COPY, identityBody());
// A co-hosted instance on the same host: its own home and its own identity.
const OTHER_HOME = mk(HOME, ".crow-r4");
const OTHER_DATA = mk(OTHER_HOME, "data");
const OTHER_IDENTITY = join(OTHER_DATA, "identity.json");
writeFileSync(OTHER_IDENTITY, identityBody());
const APP = mk(T, "crow");

/** The base inputs, with the host probe stubbed (DRY_PROBE unless overridden). */
const base = (over = {}) => {
  const { seams, ...rest } = over;
  return {
    home: HOME, crowHome: CROW_HOME,
    dataDir: DATA, dbDir: DB_DATA, backupDirs: [BACKUPS],
    otherHomes: [OTHER_HOME], otherDataDirs: [OTHER_DATA],
    appRoot: APP, nodeBin: process.execPath, env: {},
    ...rest,
    seams: { probe: DRY_PROBE, mode: "auto", ...(seams || {}) },
  };
};

/** A def that still names crow-sharing tools (the old unmask trigger). */
const SHARING_DEF = {
  bot_id: "sharing-bot",
  tools: { pi_builtin: ["read"], crow_mcp: ["crow-sharing/list_invites", "crow-sharing"] },
  permission_policy: { bash: "deny", write_paths: [], read_paths: [] },
};

test("a clean instance PASSES in both tiers — for a bot that names crow-sharing too", () => {
  const r = checkBotIdentityExposure(base({ bots: [{ botId: "sharing-bot", def: SHARING_DEF }, { botId: "plain", def: {} }] }));
  assert.equal(r.ok, true, r.findings.join(" | "));
  assert.deepEqual(r.findings, []);
  assert.equal(r.text, BOT_IDENTITY_TEXT);
  assert.ok(r.checked >= 4, "two tiers per bot were really built (got " + r.checked + ")");

  // The same conclusion, said the way the boot log says it.
  assert.equal(formatBotIdentityLine(r), "[containment] Bots can't read Crow's identity file: pass");
});

test("identityCandidates: BOTH anchors, every co-host, and the backup's identity copy — deduped", () => {
  const c = identityCandidates({ seedDir: DATA, dbDir: DB_DATA, homes: [OTHER_HOME], dataDirs: [OTHER_DATA], backupDirs: [BACKUPS] });
  for (const f of [IDENTITY, DB_IDENTITY, OTHER_IDENTITY, BACKUP_COPY]) {
    assert.ok(c.files.includes(f), "candidate: " + f);
    assert.ok(c.present.includes(f), "present: " + f);
  }
  assert.ok(!c.files.includes(join(DATA, "notes.txt")), "an ordinary data file is not a candidate");
  // The same dir reached twice (a co-host whose data dir is already listed) is one entry.
  const dup = identityCandidates({ seedDir: DATA, dbDir: DATA, dataDirs: [DATA], backupDirs: [BACKUPS] });
  assert.equal(dup.dataDirs.filter((d) => d === DATA).length, 1, "deduped by realpath");
  // A missing backup dir is resolved (so a caller can name it) but is never a
  // trust root, and contributes no candidate.
  const missing = identityCandidates({ seedDir: DATA, dbDir: DB_DATA, backupDirs: [join(T, "no-backups")] });
  assert.deepEqual(missing.roots.filter((d) => d.includes("no-backups")), []);
  assert.equal(missing.present.some((f) => f.includes("no-backups")), false);
  // Both anchors are required: a caller must resolve them (identityAnchors).
  assert.throws(() => identityCandidates({ seedDir: DATA }), /dbDir is required/);
  assert.throws(() => identityCandidates({ dbDir: DB_DATA }), /seedDir is required/);
});

test("both anchors and the backup copy are masked when they differ: the default tier masks all of them", () => {
  const c = identityCandidates({ seedDir: DATA, dbDir: DB_DATA, homes: [OTHER_HOME], dataDirs: [OTHER_DATA], backupDirs: [BACKUPS] });
  const launch = wrapPiSpawn(process.execPath, [], {
    mode: "auto", probe: DRY_PROBE, env: {}, sockets: [], runtimeDirs: [], roDirs: [], hideDirs: [], hidePinDirs: [],
    hideFiles: c.files,
    hideFileRoots: [CROW_HOME, OTHER_HOME, APP, ...c.roots],
  });
  assert.equal(launch.wrapper, "bwrap");
  for (const f of [IDENTITY, DB_IDENTITY, OTHER_IDENTITY, BACKUP_COPY]) {
    assert.equal(defaultTierMasks(launch, f), true, "masked by the default tier: " + f);
  }
});

test("when the anchors differ the contain plan masks the DB anchor's seed and the other seed is simply not bound", () => {
  // The contain tier's data dir IS the DB anchor (bridge containInputs); a seed
  // dir outside it is never bound into the empty root, so it does not exist
  // inside. Both facts are checked, not assumed.
  const plan = buildContainPlan({
    home: HOME, crowHome: CROW_HOME, dataDir: DB_DATA, appRoot: APP, nodeBin: process.execPath,
    sessionDir: CROW_HOME, cwd: CROW_HOME, writePaths: [], readPaths: [], mcpServers: [],
    otherHomes: [OTHER_HOME], systemDirs: ["/usr", "/etc"],
  });
  assert.equal(containTierMasks(plan, DB_IDENTITY), true, "the bound data dir's identity is masked");
  assert.equal(containPlanReaches(plan, IDENTITY), false, "the seed dir outside the data dir is not bound at all");
  assert.equal(containPlanReaches(plan, OTHER_IDENTITY), false, "a co-hosted home is never bound");
});

test("a backup-only identity still counts as an identity: the check does not pass with nothing to protect", () => {
  const emptySeed = mk(T, "fresh-instance");
  const emptyDb = mk(T, "fresh-db");
  const r = checkBotIdentityExposure(base({ dataDir: emptySeed, dbDir: emptyDb, backupDirs: [BACKUPS], otherHomes: [], otherDataDirs: [] }));
  // The backup copy exists, so there IS something to protect: it must be masked
  // (a pass with no finding), not skipped as "no identity file".
  assert.equal(r.ok, true, r.findings.join(" | "));
  assert.ok(r.checked >= 2, "plans were really built");
  assert.ok(!r.notes.includes("no identity file exists on this instance"));
});

test("FAIL when the default tier masks nothing: the finding names the bot and the file", () => {
  const r = checkBotIdentityExposure(base({
    bots: [{ botId: "sharing-bot", def: SHARING_DEF }],
    seams: { wrapPiSpawn: () => ({ cmd: "node", args: [], env: {}, tier: "pidns", wrapper: "bwrap", masked: [], maskedFiles: [] }) },
  }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /sharing-bot: the default tier would leave .*identity\.json readable/.test(f)), r.findings.join(" | "));
  const line = formatBotIdentityLine(r);
  assert.match(line, /^\[containment\] Bots can't read Crow's identity file: FAIL \(/);
  assert.ok(!line.includes(FAKE_SEED), "the line never carries a value");
});

test("FAIL when the contain plan lost the mask (the data dir is bound, the file is not masked)", () => {
  const r = checkBotIdentityExposure(base({
    bots: [{ botId: "plain", def: {} }],
    // A plan that binds the instance data dir and nothing else: exactly the
    // shape a dropped identity mask would leave.
    seams: { buildContainPlan: () => ({ args: ["--tmpfs", "/", "--bind", DB_DATA, DB_DATA], env: {}, refused: [] }) },
  }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /plain: the contain tier would leave .*identity\.json readable/.test(f)), r.findings.join(" | "));
});

test("CROW_PI_SANDBOX=off FAILS with the reason (no sandbox runs at all)", () => {
  const r = checkBotIdentityExposure(base({
    bots: [{ botId: "plain", def: {} }],
    env: { CROW_PI_SANDBOX: "off" },
    // No mode seam: this case is about the operator's env switch, read by
    // piSandboxMode(), exactly as the bridge reads it.
    seams: { mode: undefined },
  }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /CROW_PI_SANDBOX=off/.test(f)), r.findings.join(" | "));
  assert.deepEqual(r.tierFindings, r.findings, "the whole failure is the host's tier");
  assert.deepEqual(findingsFromPlans(r), [], "no bot plan contributed to it");
  assert.ok(!formatBotIdentityLine(r).includes(": pass"));
  assert.ok(!formatBotIdentityLine(r).includes(RESTART_HOSTS_HINT),
    "restarting the bot hosts does not change CROW_PI_SANDBOX=off, so the line does not ask for it");
});

test("no bubblewrap FAILS: the setpriv fallback applies no masks", () => {
  const r = checkBotIdentityExposure(base({
    bots: [{ botId: "plain", def: {} }],
    seams: { probe: { ok: false, pidns: false, bindFd: false, bwrap: null, setpriv: "/usr/bin/setpriv", reason: "bubblewrap (bwrap) is not installed" } },
  }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /bubblewrap is unavailable here .*setpriv fallback applies no masks/.test(f)), r.findings.join(" | "));
});

test("bwrap WITHOUT its own PID namespace FAILS: host /proc reaches the file", () => {
  const r = checkBotIdentityExposure(base({
    bots: [{ botId: "plain", def: {} }],
    seams: { probe: { ...DRY_PROBE, pidns: false, pidnsReason: "bwrap cannot create a PID namespace with a fresh /proc here" } },
  }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /without its own PID namespace .*\/proc\/<pid>\/root/.test(f)), r.findings.join(" | "));
});

test("a FAILING line names the restart step for separate bot hosts (item-70)", () => {
  const line = formatBotIdentityLine({ ok: false, findings: ["plain: the default tier would leave /x/identity.json readable"], notes: [] });
  assert.ok(line.endsWith("; " + RESTART_HOSTS_HINT), line);
  assert.match(RESTART_HOSTS_HINT, /pibot-gateways@\*/);
  // A pass never carries it.
  assert.equal(formatBotIdentityLine({ ok: true }).includes("pibot-gateways"), false);
  // Nor does a HOST-TIER finding: the switch or the host is not what a bot
  // host's restart changes.
  const tier = "CROW_PI_SANDBOX=off: bot spawns run in no sandbox, so /x/identity.json is readable";
  const tierLine = formatBotIdentityLine({ ok: false, findings: [tier], tierFindings: [tier], notes: [] });
  assert.ok(!tierLine.includes("pibot-gateways"), tierLine);
  assert.ok(tierLine.includes(tier), "the finding itself is still named");
  // A mix: one plan finding is enough for the hint.
  const mixed = formatBotIdentityLine({ ok: false, findings: [tier, "plain: the contain tier would leave /x readable"], tierFindings: [tier], notes: [] });
  assert.ok(mixed.endsWith(RESTART_HOSTS_HINT), mixed);
});

test("findingsFromPlans: everything but the host-tier findings, order kept", () => {
  const tier = "bubblewrap is unavailable here (no bwrap), so …";
  const plan = "plain: the default tier would leave /x/identity.json readable";
  assert.deepEqual(findingsFromPlans({ findings: [tier, plan], tierFindings: [tier] }), [plan]);
  assert.deepEqual(findingsFromPlans({ findings: [tier], tierFindings: [tier] }), []);
  // A result from an older shape (no tierFindings) is all plan findings.
  assert.deepEqual(findingsFromPlans({ findings: [plan] }), [plan]);
  assert.deepEqual(findingsFromPlans(null), []);
});

test("a check that could not run names itself and asks for no bot-host restart", async () => {
  const db = { async execute() { return { rows: [{ bot_id: "plain", definition: "{}", enabled: 1 }] }; } };
  const r = await runBotIdentityCheck({
    db, home: HOME, crowHome: CROW_HOME, seedDir: DATA, dbDir: DB_DATA, backupDirs: [BACKUPS],
    otherHomes: [], otherDataDirs: [], appRoot: APP, env: {},
    seams: { probe: DRY_PROBE, mode: "auto", identityCandidates: () => { throw new Error("boom"); } },
  });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /the check could not run: boom/.test(f)), r.findings.join(" | "));
  assert.deepEqual(findingsFromPlans(r), [], "an internal failure is not a bot plan's finding");
  const line = formatBotIdentityLine(r);
  assert.ok(line.includes("the check could not run: boom"), line);
  assert.ok(!line.includes("pibot-gateways"), "no restart step for a bug in the check: " + line);
});

test("NO enabled bots: a note, a pass and no tier finding — on a host that could not mask at all", () => {
  // The false alarm this pins: no bwrap / no pidns / CROW_PI_SANDBOX=off used to
  // FAIL (and ring a high-priority bell) on a host that runs no bot at all.
  for (const over of [
    { env: { CROW_PI_SANDBOX: "off" }, seams: { mode: undefined } },
    { seams: { probe: { ok: false, pidns: false, bindFd: false, bwrap: null, setpriv: null, reason: "not installed" } } },
    { seams: { probe: { ...DRY_PROBE, pidns: false, pidnsReason: "no pidns here" } } },
  ]) {
    const r = checkBotIdentityExposure(base({ bots: [], ...over }));
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.deepEqual(r.findings, [], "the host's tier is not judged when nothing spawns");
    assert.deepEqual(r.tierFindings, []);
    assert.equal(r.noBots, true);
    assert.equal(r.checked, 0, "no plan was built either");
    assert.deepEqual(r.notes, [NO_BOTS_NOTE]);
    assert.match(NO_BOTS_NOTE, /no bots/);
    assert.equal(formatBotIdentityLine(r), "[containment] Bots can't read Crow's identity file: pass");
  }
  // An ABSENT list is not an empty one: a caller that did not read the bots still
  // gets the representative plan (the unit tests' shape above rely on it).
  const absent = checkBotIdentityExposure(base({ env: { CROW_PI_SANDBOX: "off" }, seams: { mode: undefined } }));
  assert.equal(absent.ok, false);
  assert.equal(absent.noBots, undefined);
});

test("runBotIdentityCheck: no enabled bots is a pass with the no-bots note, whatever the host's tier", async () => {
  const db = { async execute() { return { rows: [] }; } };
  let askedAnchors = 0;
  const r = await runBotIdentityCheck({
    db, env: { CROW_PI_SANDBOX: "off" },
    identityAnchors: async () => { askedAnchors += 1; return { seedDir: DATA, dbDir: DB_DATA, backupDirs: [BACKUPS] }; },
    seams: { probe: { ok: false, pidns: false, reason: "not installed" } },
  });
  assert.equal(r.ok, true, r.findings.join(" | "));
  assert.equal(r.noBots, true);
  assert.deepEqual(r.notes, [NO_BOTS_NOTE]);
  assert.deepEqual(r.findings, []);
  assert.equal(askedAnchors, 0, "nothing to protect means no anchor resolution (and no co-host scan) either");
  assert.equal(formatBotIdentityLine(r), "[containment] Bots can't read Crow's identity file: pass");
});

test("a plan that REFUSES the spawn is a note, not a failure (nothing would run)", async () => {
  const r = checkBotIdentityExposure(base({
    bots: [{ botId: "bypass-bot", def: { permission_policy: { write_paths: ["/"] } } }],
  }));
  assert.equal(r.ok, true, r.findings.join(" | "));
  assert.ok(r.notes.some((n) => /bypass-bot: the contain-tier dry build refused the spawn/.test(n)), r.notes.join(" | "));

  // And a seam that throws this module's own ContainRefused says the same.
  const { ContainRefused } = await import("../scripts/pi-bots/pi_contain.mjs");
  const refused = checkBotIdentityExposure(base({
    bots: [{ botId: "plain", def: {} }],
    seams: { buildContainPlan: () => { throw new ContainRefused("contain refused: test"); } },
  }));
  assert.equal(refused.ok, true);
  assert.ok(refused.notes.some((n) => /plain: the contain-tier dry build refused the spawn/.test(n)));
});

test("no identity file on the instance: nothing to protect, still a pass with a note", () => {
  const emptySeed = mk(T, "empty-instance", "data");
  const emptyDb = mk(T, "empty-db");
  const noBackups = mk(T, "empty-backups");
  writeFileSync(join(emptySeed, "crow.db"), "");
  const r = checkBotIdentityExposure(base({
    bots: [{ botId: "plain", def: {} }], dataDir: emptySeed, dbDir: emptyDb,
    otherHomes: [], otherDataDirs: [], backupDirs: [noBackups],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes, ["no identity file exists on this instance"]);
  assert.equal(r.checked, 0);
});

test("readEnabledBotDefs: definition JSON parsed, an unparseable row skipped, no db no bots", async () => {
  const db = {
    async execute() {
      return { rows: [
        { bot_id: "a", definition: JSON.stringify({ tools: {} }), enabled: 1 },
        { bot_id: "b", definition: "{not json", enabled: 1 },
        { bot_id: null, definition: "{}", enabled: 1 },
      ] };
    },
  };
  const bots = await readEnabledBotDefs(db);
  assert.deepEqual(bots.map((b) => b.botId), ["a"]);
  assert.deepEqual(await readEnabledBotDefs(null), []);
  assert.deepEqual(await readEnabledBotDefs({ execute: async () => { throw new Error("no table"); } }), []);
});

test("runBotIdentityCheck: the boot entry point passes on a clean instance (stub db, real plans)", async () => {
  const db = {
    async execute() {
      return { rows: [{ bot_id: "sharing-bot", definition: JSON.stringify(SHARING_DEF), enabled: 1 }] };
    },
  };
  const r = await runBotIdentityCheck({
    db, crowHome: CROW_HOME, seedDir: DATA, dbDir: DB_DATA, backupDirs: [BACKUPS],
    otherHomes: [OTHER_HOME], otherDataDirs: [OTHER_DATA],
    home: HOME, appRoot: APP, env: {},
    seams: { probe: DRY_PROBE, mode: "auto" },
  });
  assert.equal(r.ok, true, r.findings.join(" | "));
  assert.equal(formatBotIdentityLine(r), "[containment] Bots can't read Crow's identity file: pass");
});

test("runBotIdentityCheck: the anchors come from identityAnchors() when the caller passes none", async () => {
  const db = { async execute() { return { rows: [{ bot_id: "plain", definition: "{}", enabled: 1 }] }; } };
  let asked = 0;
  const r = await runBotIdentityCheck({
    db, crowHome: CROW_HOME, otherHomes: [OTHER_HOME], otherDataDirs: [OTHER_DATA],
    home: HOME, appRoot: APP, env: {},
    identityAnchors: async () => { asked += 1; return { seedDir: DATA, dbDir: DB_DATA, backupDirs: [BACKUPS] }; },
    seams: { probe: DRY_PROBE, mode: "auto" },
  });
  assert.equal(asked, 1, "the boot path really resolved them through identityAnchors()");
  assert.equal(r.ok, true, r.findings.join(" | "));
  assert.ok(r.checked >= 1, "a plan was built from those anchors");
});