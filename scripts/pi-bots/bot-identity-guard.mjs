/**
 * "Bots can't read Crow's identity file" — the boot check (item-70 channel 3).
 *
 * `<dataDir>/identity.json` holds the MASTER SEED every instance key and every
 * bot key is derived from (servers/sharing/identity.js). No bot tool needs it,
 * so both sandbox tiers hide it unconditionally: the default tier masks it with
 * a `--dev-bind /dev/null`, and the contain tier masks it as the reserved
 * data-dir entry it is. There is no opt-out — a bot definition naming
 * `crow-sharing` tools used to unmask it, and that path is gone.
 *
 * Which FILES that means is decided in exactly ONE place:
 * `identityCandidates()` (identity-candidates.mjs — this instance's seed dir from
 * identity.js's own resolver AND `dirname(CROW_DB)`, every co-hosted Crow home's
 * data dir, every copy of the seed, and the repo's own backup directories), with
 * the anchors from `identityAnchors()`. This module calls it, and so does the
 * bridge at spawn time, so the boot answer and the spawn masks cannot be built
 * from different anchors.
 *
 * What this check really does:
 *   - it sends the plan builders the REAL inputs they need to answer "would this
 *     file be masked?" — the hidden-file candidate list, the trusted roots, and
 *     the bot's own policy paths — and asks them, without spawning anything;
 *   - it reads the operator's sandbox switch (`piSandboxMode`) and the host's
 *     real `probePiSandbox()`, and FAILS when the effective tier cannot hold a
 *     file mask at all: `CROW_PI_SANDBOX=off`, no bubblewrap (the setpriv
 *     fallback applies no masks), or bwrap without its own PID namespace (host
 *     /proc reaches `/proc/<pid>/root/...`).
 *   - with NO enabled bots it judges nothing: no bot means no spawn, so no
 *     spawn can read the seed. It records one note (NO_BOTS_NOTE, the "no bots"
 *     status) and passes; the boot path therefore raises no bell there, because
 *     a host tier nothing spawns into is not a failure. (An ABSENT bot list —
 *     a caller that did not read them — still checks one representative plan
 *     per data dir, which is what the unit tests use.)
 *
 * It does NOT re-derive a bot's MCP server list or its session/cwd from the
 * def: a plan is built per bot with that bot's own write_paths/read_paths and
 * workspace, and with no MCP servers — an MCP bind can only ADD paths, and the
 * identity mask is independent of them. Earlier wording claimed "the same
 * inputs the bridge gives them", which was not true of those fields; the claim
 * is gone rather than overstated.
 *
 * The words are exact — the boot log line, its test and the docs quote the same
 * sentence: "Bots can't read Crow's identity file".
 *
 * Nothing here creates, writes or spawns anything: no mount point is made, no
 * bwrap runs, no pi starts. A plan that REFUSES the spawn is not a failure (a
 * refused spawn runs nothing at all); it is reported as a note.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { buildContainPlan, ContainRefused } from "./pi_contain.mjs";
import { probePiSandbox, piSandboxMode, wrapPiSpawn } from "./pi_sandbox.mjs";
import { secretFilesFor } from "./hidden_files.mjs";
import { identityAnchors, identityCandidates } from "./identity-candidates.mjs";

/** The exact sentence, with the answer appended by formatBotIdentityLine. */
export const BOT_IDENTITY_TEXT = "Bots can't read Crow's identity file";

/**
 * The one next step a failure needs, appended to the boot line and put in the
 * bell — but only for a finding a BOT'S PLAN produced (findingsFromPlans): a
 * host-tier finding is the operator's switch or the host itself, which this
 * restart does not change. Crow's auto-update restarts the gateway, but a host
 * that supervises bots
 * with its own systemd units (`PIBOT_SUPERVISOR=external`: `pibot-gateways@*`,
 * which load bridge.mjs) keeps running the OLD bridge until an operator restarts
 * them — so the fix is not on the host until the units are. This is the honest,
 * minimal form: the check does not try to enumerate/reach systemd from a boot
 * path (it can be run as any user, in any namespace); the sentence names what to
 * restart. Documented in docs/developers/bot-engine.md.
 */
export const RESTART_HOSTS_HINT = "restart the pibot-gateways@* hosts after updating (they load the bridge)";

/**
 * The note this check records when the instance has NO enabled bots: nothing can
 * spawn, so nothing can read the seed and the host's tier is not judged. It is
 * the "no bots" status — the boot line still says pass, and the bell stays
 * silent, because a tier nothing spawns into is not a failure an operator can
 * act on (a host that runs no bots must not ring for its sandbox).
 */
export const NO_BOTS_NOTE =
  "no bots are enabled, so no spawn can read the file (the host's sandbox tier is not checked here)";

/** The probe a test stubs in: the full bubblewrap tier, without touching bwrap. */
export const DRY_PROBE = Object.freeze({
  ok: true, pidns: true, bindFd: true, bwrap: "/usr/bin/bwrap", setpriv: null, reason: null, pidnsReason: null,
});

/** True when the DEFAULT tier's launch masks `file` (--dev-bind /dev/null <file>). */
export function defaultTierMasks(launch, file) {
  return Array.isArray(launch && launch.maskedFiles) && launch.maskedFiles.includes(file);
}

/** True when the CONTAIN tier's plan masks `file` (--ro-bind /dev/null <file>). */
export function containTierMasks(plan, file) {
  const args = (plan && Array.isArray(plan.args)) ? plan.args : [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ro-bind" && args[i + 1] === "/dev/null" && args[i + 2] === file) return true;
  }
  return false;
}

/**
 * True when the CONTAIN tier's plan BINDS `file` into the sandbox at all (a bind
 * whose destination is the file or a folder above it). The contain tier starts
 * from an empty root, so a file that is not bound does not exist inside — and a
 * co-hosted instance's home and data dir are never bound. Only a bound-but-
 * unmasked file is an exposure there.
 */
export function containPlanReaches(plan, file) {
  const args = (plan && Array.isArray(plan.args)) ? plan.args : [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--bind" && args[i] !== "--ro-bind") continue;
    if (args[i + 1] === "/dev/null") continue; // a mask, not a bind
    const dest = args[i + 2];
    if (typeof dest === "string" && (file === dest || file.startsWith(dest.endsWith("/") ? dest : dest + "/"))) return true;
  }
  return false;
}

/** The write/read paths a bot definition asks for, as the plan sees them. */
function policyPaths(def) {
  const p = (def && def.permission_policy) || {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []);
  return { writePaths: list(p.write_paths), readPaths: list(p.read_paths) };
}

/**
 * The result for an instance with no enabled bots: a pass, one note, nothing
 * checked, and `noBots` so the bell can stay silent without re-deriving it.
 */
function noBotsResult() {
  return {
    ok: true, text: BOT_IDENTITY_TEXT, findings: [], tierFindings: [], notes: [NO_BOTS_NOTE],
    checked: 0, noBots: true,
  };
}

/**
 * The check itself.
 *
 * @param {object} o
 * @param {Array<{botId?:string, def?:object, workspaceDir?:string|null}>} [o.bots]
 *   the ENABLED bots. An explicitly EMPTY list means this instance has no
 *   enabled bot: nothing can spawn, so the check records NO_BOTS_NOTE and passes
 *   without judging the host's tier (which is what keeps a bot-less host from
 *   ringing the bell). Omit it (undefined) — a caller that did not read the bot
 *   list — to check one representative plan per data dir: the mask set a bot's
 *   definition cannot change.
 * @param {string} [o.home] the operator's home (the contain plan's `home`)
 * @param {string} [o.crowHome] this instance's Crow home
 * @param {string} [o.dataDir] this instance's SEED dir (default: identity.js's
 *   own resolver — do NOT pass dirname(CROW_DB) here)
 * @param {string} [o.dbDir] the DB anchor (default: botsDbDir() =
 *   dirname(CROW_DB)); both anchors are scanned, so passing one is an override,
 *   not a separator. The contain tier's plan binds the DB anchor and calls it
 *   its data dir (bridge's containInputs), so this is what the plan is built
 *   with.
 * @param {string[]} [o.otherHomes] co-hosted Crow homes
 * @param {string[]} [o.otherDataDirs] extra data dirs to scan
 * @param {string[]} [o.backupDirs] override the repo's backup dirs
 * @param {string} [o.appRoot] the repo checkout
 * @param {string} [o.nodeBin] the node binary the bots run
 * @param {object} [o.env] defaults to process.env (the sandbox switch + anchors)
 * @param {object} [o.seams] TEST SEAMS ONLY: { buildContainPlan, wrapPiSpawn,
 *   secretFiles, identityCandidates, probe, mode }. The boot path passes none.
 * @returns {{ok:boolean, text:string, findings:string[], tierFindings:string[], notes:string[], checked:number, noBots?:boolean}}
 *   `findings` are the plans (or the host's tier) that would leave an identity
 *   file readable; an empty list is the pass. `tierFindings` is the subset that
 *   no bot's PLAN produced — the host's own tier, and a check that could not run
 *   at all — which is what keeps the stale-bridge restart step off them (see
 *   findingsFromPlans).
 */
export function checkBotIdentityExposure(o = {}) {
  const home = o.home || homedir();
  const crowHome = o.crowHome || null;
  const otherHomes = Array.isArray(o.otherHomes) ? o.otherHomes.filter(Boolean) : [];
  const appRoot = o.appRoot || null;
  const nodeBin = o.nodeBin || process.execPath;
  const env = o.env || process.env;
  const seams = o.seams || {};
  const planOf = seams.buildContainPlan || buildContainPlan;
  const wrapOf = seams.wrapPiSpawn || wrapPiSpawn;
  const secretsOf = seams.secretFiles || secretFilesFor;
  const candidatesOf = seams.identityCandidates || identityCandidates;
  const modeOf = seams.mode || (() => piSandboxMode(env));
  const probeOf = seams.probe || (() => probePiSandbox());

  const findings = [];
  // The host-tier findings (no bot's plan is involved), kept apart so the
  // restart step is only ever appended to a plan finding: restarting the bot
  // hosts cannot change the operator's switch or a host without bwrap.
  const tierFindings = [];
  const addTierFinding = (text) => { tierFindings.push(text); findings.push(text); };
  const notes = [];

  // No ENABLED bots: nothing can spawn, so nothing can read the seed. The tier is
  // not judged and the bell stays silent for it (a host that runs no bots must
  // not ring for a sandbox nothing uses).
  if (Array.isArray(o.bots) && o.bots.length === 0) return noBotsResult();

  // What there is to protect, from the one shared candidate list. The anchors
  // come from the caller: the boot entry resolves them through
  // identityAnchors() (identity.js's resolver + dirname(CROW_DB) + the backup
  // dir rule); a unit test passes scratch dirs.
  const candidates = candidatesOf({
    crowHome,
    seedDir: o.seedDir || o.dataDir,
    dbDir: o.dbDir,
    backupDirs: o.backupDirs,
    homes: otherHomes,
    dataDirs: Array.isArray(o.otherDataDirs) ? o.otherDataDirs : [],
  });
  const wanted = Array.isArray(candidates.present) ? candidates.present : [];
  if (wanted.length === 0) {
    return { ok: true, text: BOT_IDENTITY_TEXT, findings: [], tierFindings: [], notes: ["no identity file exists on this instance"], checked: 0 };
  }

  // The EFFECTIVE tier, from the operator's switch and the host's real probe —
  // the same two functions the bridge spawns with, never a synthetic stand-in.
  const mode = typeof modeOf === "function" ? modeOf() : modeOf;
  const probe = (typeof probeOf === "function" ? probeOf() : probeOf) || {};
  const named = wanted[0] + (wanted.length > 1 ? " (and " + (wanted.length - 1) + " more identity file" + (wanted.length > 2 ? "s" : "") + ")" : "");
  let enforceable = true;
  if (mode === "off") {
    enforceable = false;
    addTierFinding("CROW_PI_SANDBOX=off: bot spawns run in no sandbox, so " + named + " is readable");
  } else if (probe.ok !== true) {
    enforceable = false;
    addTierFinding("bubblewrap is unavailable here (" + (probe.reason || "no bwrap") +
      "), so the setpriv fallback applies no masks and " + named + " is readable");
  } else if (probe.pidns !== true) {
    enforceable = false;
    addTierFinding("bubblewrap runs without its own PID namespace here (" + (probe.pidnsReason || "unavailable") +
      "), so host /proc reaches " + named + " through /proc/<pid>/root");
  }

  // ---- the default tier (bwrap over the whole filesystem, secret files
  // masked) — the same candidate list the bridge builds, then one dry launch
  // per bot. Built only when the tier can mask at all; otherwise the finding
  // above IS the answer and a dry build would only repeat it.
  let hideFiles = [];
  try {
    hideFiles = [
      ...(crowHome ? secretsOf({ crowHome, appRoot: appRoot || undefined, dataDir: null }) : []),
      ...otherHomes.flatMap((h) => secretsOf({ crowHome: h, appRoot: appRoot || undefined, dataDir: null })),
      ...(Array.isArray(candidates.files) ? candidates.files : []),
    ];
  } catch (err) {
    findings.push("the default tier's hidden-file list could not be built: " + (err && err.message ? err.message : String(err)));
  }
  // The roots the launch will accept a candidate under: this instance's Crow
  // home, the co-hosts' homes, the app root and the candidate data/backup dirs
  // — RESOLVED first (realpath), exactly as the bridge resolves its own roots,
  // or a home reached through a symlink would not match a candidate's real path.
  const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };
  const hideFileRoots = [crowHome, ...otherHomes, ...(Array.isArray(candidates.roots) ? candidates.roots : []),
    ...(appRoot ? [appRoot] : [])].filter(Boolean).map(realOrSelf);
  const bots = Array.isArray(o.bots) && o.bots.length ? o.bots : [{}];
  let checked = 0;
  for (const bot of bots) {
    const who = bot && bot.botId ? String(bot.botId) : "a bot";
    const { writePaths, readPaths } = policyPaths(bot && bot.def);
    if (enforceable) {
      let launch = null;
      try {
        // The launch a pidns spawn really gets, with the real (or stubbed) probe
        // and the real candidate list. `mode: "auto"` so an operator's
        // CROW_PI_SANDBOX=contain still has the default tier CHECKED here (both
        // tiers must hold).
        launch = wrapOf(nodeBin, [], {
          mode: "auto", probe, env, sockets: [], runtimeDirs: [], roDirs: [],
          hideDirs: [], hideFiles, hideFileRoots, hidePinDirs: [],
        });
        checked += 1;
        if (launch && launch.wrapper === "bwrap") {
          for (const f of wanted) {
            if (!defaultTierMasks(launch, f)) {
              findings.push(who + ": the default tier would leave " + f + " readable");
            }
          }
        } else {
          findings.push(who + ": the default tier would not sandbox the spawn at all (" + ((launch && launch.reason) || "no bubblewrap") + ")");
        }
      } catch (err) {
        notes.push(who + ": the default-tier dry build refused (" + (err && err.message ? err.message : String(err)) + ") — nothing would run");
      }
    }

    // Contain tier: the plan a contained spawn would get, with this bot's own
    // policy paths (an identity mask must not depend on them). Built even on a
    // host whose bwrap cannot run the tier: the PLAN is pure, so a dropped mask
    // is still caught here instead of only on a bwrap-capable host. Its data dir
    // is the DB anchor, exactly what bridge containInputs passes; a seed dir
    // outside it is not bound, so containPlanReaches() rightly finds it
    // unreachable there.
    try {
      const plan = planOf({
        home, crowHome: crowHome || undefined, dataDir: candidates.dbDir || null,
        appRoot: appRoot || undefined, nodeBin, cliPath: undefined,
        sessionDir: bot && bot.workspaceDir ? bot.workspaceDir : (crowHome || home),
        cwd: bot && bot.workspaceDir ? bot.workspaceDir : (crowHome || home),
        workspaceDir: (bot && bot.workspaceDir) || null,
        writePaths, readPaths, mcpServers: [],
        dataKeep: String(env.CROW_PI_CONTAIN_DATA_KEEP || "").split(",").map((x) => x.trim()).filter(Boolean),
        otherHomes,
      });
      checked += 1;
      for (const f of wanted) {
        // Inside, the empty root means a file that is not bound does not exist:
        // only a bound-but-unmasked one is an exposure (a co-hosted home's
        // data dir is never bound).
        if (containTierMasks(plan, f)) continue;
        if (containPlanReaches(plan, f)) findings.push(who + ": the contain tier would leave " + f + " readable");
      }
    } catch (err) {
      if (err instanceof ContainRefused) {
        notes.push(who + ": the contain-tier dry build refused the spawn (" + err.message + ") — nothing would run");
      } else {
        findings.push(who + ": the contain-tier plan could not be built: " + (err && err.message ? err.message : String(err)));
      }
    }
  }

  return { ok: findings.length === 0, text: BOT_IDENTITY_TEXT, findings, tierFindings, notes, checked };
}

/**
 * The findings a BOT'S PLAN produced — everything but the host-side ones. Only
 * these can be the stale-bridge failure RESTART_HOSTS_HINT answers: a tier
 * finding (`CROW_PI_SANDBOX=off`, no bubblewrap, no PID namespace) is the
 * operator's switch or the host itself, and a check that could not run is a bug
 * in the check — neither is fixed by restarting a bot host.
 *
 * @param {object} result the check's result
 * @returns {string[]}
 */
export function findingsFromPlans(result) {
  const r = result || {};
  const tier = new Set((Array.isArray(r.tierFindings) ? r.tierFindings : []).filter(Boolean));
  return (Array.isArray(r.findings) ? r.findings : []).filter((f) => f && !tier.has(f));
}

/**
 * The one boot line (the `[containment]` prefix is what an operator greps for;
 * the sentence after it is the invariant, and the answer is pass or FAIL).
 * Fixed shape: `[containment] Bots can't read Crow's identity file: pass` — or
 * `...: FAIL (<finding>; <finding>)`, never a path's content. A FAIL carries the
 * one next step (RESTART_HOSTS_HINT) after the findings — but ONLY when one of
 * them came from a bot's plan: on a host whose bot hosts are separate systemd
 * units, an auto-update alone leaves them on the old bridge, while a host-tier
 * finding (`CROW_PI_SANDBOX=off`, no bwrap, no PID namespace) is not fixed by
 * restarting them (see findingsFromPlans).
 */
export function formatBotIdentityLine(result) {
  const r = result || {};
  if (r.ok) return "[containment] " + BOT_IDENTITY_TEXT + ": pass";
  const found = (Array.isArray(r.findings) ? r.findings : []).filter(Boolean);
  const why = found.length ? found : (Array.isArray(r.notes) ? r.notes : []).filter(Boolean);
  const hint = findingsFromPlans(r).length ? "; " + RESTART_HOSTS_HINT : "";
  return "[containment] " + BOT_IDENTITY_TEXT + ": FAIL" + (why.length ? " (" + why.join("; ") + ")" : "") + hint;
}

/**
 * The enabled bot definitions from the instance DB (crow.db `pi_bot_defs`), in
 * the shape checkBotIdentityExposure wants. A row whose definition does not
 * parse is skipped: it cannot be spawned at all.
 *
 * @param {{execute: Function}} db
 * @returns {Promise<Array<{botId: string, def: object}>>}
 */
export async function readEnabledBotDefs(db) {
  const out = [];
  if (!db || typeof db.execute !== "function") return out;
  let rows = [];
  try {
    const r = await db.execute({ sql: "SELECT bot_id, definition, enabled FROM pi_bot_defs WHERE enabled = 1", args: [] });
    rows = (r && Array.isArray(r.rows)) ? r.rows : [];
  } catch {
    return out;
  }
  for (const row of rows) {
    if (!row || typeof row.bot_id !== "string" || !row.bot_id) continue;
    let def = null;
    try { def = JSON.parse(row.definition); } catch { def = null; }
    if (def && typeof def === "object") out.push({ botId: row.bot_id, def });
  }
  return out;
}

/**
 * The boot entry point: read this instance's bots and run the check with this
 * instance's own roots. Never throws — a check that cannot run says so in its
 * findings rather than breaking boot.
 *
 * The anchors are resolved HERE, through identityAnchors() — identity.js's own
 * seed resolver and dirname(CROW_DB) (botsDbDir), the two anchors the bridge
 * also uses, plus the backup dir rule. A caller can pass any of them (a unit
 * test passes scratch dirs); whatever it leaves out is resolved here, so no
 * caller has to know an anchor and the two sides cannot drift.
 *
 * @param {{db?: object, env?: object, home?: string, crowHome?: string, dataDir?: string, seedDir?: string, dbDir?: string, appRoot?: string, nodeBin?: string, otherHomes?: string[], otherDataDirs?: string[], backupDirs?: string[], identityAnchors?: Function, seams?: object}} o
 * @returns {Promise<{ok:boolean, text:string, findings:string[], tierFindings:string[], notes:string[], checked:number, noBots?:boolean}>}
 */
export async function runBotIdentityCheck(o = {}) {
  try {
    const bots = await readEnabledBotDefs(o.db);
    // No enabled bots: no spawn is possible, so nothing is judged and no anchor
    // is resolved (a co-host scan that fails must not turn into a bell on a host
    // that runs no bots).
    if (bots.length === 0) return noBotsResult();
    // The two anchors, from the authorities (identity.js's resolver, the pi-bots
    // DB path) and the backup dir rule. A caller may pass any of them (tests
    // pass scratch dirs); whatever is missing is resolved here, once.
    const given = { seedDir: o.seedDir || o.dataDir, dbDir: o.dbDir, backupDirs: o.backupDirs };
    let anchors = given;
    if (!given.seedDir || !given.dbDir || !Array.isArray(given.backupDirs)) {
      const resolved = await (o.identityAnchors || identityAnchors)({ env: o.env || process.env });
      anchors = {
        seedDir: given.seedDir || resolved.seedDir,
        dbDir: given.dbDir || resolved.dbDir,
        backupDirs: Array.isArray(given.backupDirs) ? given.backupDirs : resolved.backupDirs,
      };
    }
    let otherHomes = Array.isArray(o.otherHomes) ? o.otherHomes : null;
    let otherDataDirs = Array.isArray(o.otherDataDirs) ? o.otherDataDirs : undefined;
    if (!otherHomes) {
      // The same co-host scan the spawn uses (servers/shared/secret-values.js).
      try {
        const { checkedInstanceSecretsDirs } = await import("../../servers/shared/secret-values.js");
        const dirs = checkedInstanceSecretsDirs();
        otherHomes = dirs.map((d) => (d.endsWith("/secrets") ? dirname(d) : d));
      } catch {
        // A home that cannot be checked is not silently ignored: the spawn
        // itself refuses in that case, and so does this check's note.
        return {
          ok: false, text: BOT_IDENTITY_TEXT, findings: [], checked: 0,
          notes: ["the other Crow homes on this host could not be checked, so no bot spawn is trusted either"],
        };
      }
    }
    return checkBotIdentityExposure({ ...o, ...anchors, bots, otherHomes, otherDataDirs });
  } catch (err) {
    // Not a bot's plan either: an internal failure names itself and asks for no
    // restart step (findingsFromPlans keeps it out of the hint).
    const failed = "the check could not run: " + (err && err.message ? err.message : String(err));
    return {
      ok: false, text: BOT_IDENTITY_TEXT, notes: [], checked: 0,
      findings: [failed], tierFindings: [failed],
    };
  }
}